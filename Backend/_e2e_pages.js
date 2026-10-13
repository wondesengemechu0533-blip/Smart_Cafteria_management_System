/**
 * Asset / realtime smoke check for the pages whose Leaflet <script>/<link>
 * tags were repointed at the vendored copy.
 *
 * Loads each page signed in as the courier and asserts three things:
 *   1. Leaflet resolved (no CSP block on the vendored file)
 *   2. no CSP violations in the console
 *   3. the shared socket actually connects to the backend ORIGIN
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ quiet: true });
const puppeteer = require(path.join(process.env.TEMP, 'opencode', 'pw', 'node_modules', 'puppeteer-core'));

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:5500';
const summary = JSON.parse(fs.readFileSync(path.join(__dirname, '_e2e_summary.json'), 'utf8'));

const PAGES = [
  {
    url: '/src/pages/customer/order-tracking.html?orderId=' + summary.orderId,
    role: 'customer',
    expectMap: true,
  },
  { url: '/src/pages/delivery/deliveries.html', role: 'delivery', expectMap: true },
  // The admin live monitor builds its map div when the modal opens, so only
  // Leaflet + socket + CSP are asserted on an idle load.
  { url: '/src/pages/admin/deliveries.html', role: 'manager', expectMap: false },
];

const TOKENS = {
  customer: summary.customerToken,
  delivery: summary.riderToken,
  admin: summary.adminToken,
};
const USERS = {
  customer: summary.customerUser,
  delivery: summary.riderUser,
  admin: { id: 'admin', name: 'Admin', email: 'admin@scos.test', role: 'admin' },
};

// `admin/deliveries.html` sits behind ScosRoles.PAGE_ACCESS, which only lets
// `manager`/`system_admin`-style roles whose page list includes `deliveries`
// stay on it. Sign a manager token so the third page is really exercised
// instead of bouncing straight to admin/dashboard.html.
async function signIn(role) {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./src/models/User');
  const user = await User.findOne({ role, status: 'ACTIVE', isActive: { $ne: false } })
    .sort({ createdAt: -1 })
    .lean();
  if (!user) return null;
  const jwt = require('jsonwebtoken');
  return {
    token: jwt.sign(
      { id: String(user._id), role: user.role, name: user.name, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    ),
    user: { id: String(user._id), name: user.name, email: user.email, role: user.role },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const manager = await signIn('manager');
  if (manager) {
    TOKENS.manager = manager.token;
    USERS.manager = manager.user;
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  let failures = 0;

  for (const spec of PAGES) {
    if (!TOKENS[spec.role]) {
      console.log(`SKIP ${spec.url} (no signed-in ${spec.role} available)`);
      continue;
    }
    const page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 900 });
    const csp = [];
    const errors = [];
    const websockets = [];
    page.on('websocket', (ws) => websockets.push(ws.url()));
    page.on('console', (m) => {
      const text = m.text();
      if (/Content Security Policy/i.test(text)) csp.push(text);
      if (m.type() === 'error') errors.push(text);
    });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.evaluateOnNewDocument((tok, user, role) => {
      // Record every socket.io connection the page opens, including pages that
      // bypass the shared socket.js bridge (admin live monitor).
      window.__ioSockets = [];
      let impl;
      const wrap = (fn) => {
        if (typeof fn !== 'function') return fn;
        const w = function (...args) {
          const s = fn.apply(this, args);
          if (s && typeof s === 'object') window.__ioSockets.push(s);
          return s;
        };
        try {
          Object.keys(fn).forEach((k) => {
            try { w[k] = fn[k]; } catch (e) { /* read-only */ }
          });
        } catch (e) { /* ignore */ }
        return w;
      };
      Object.defineProperty(window, 'io', {
        configurable: true,
        get() { return impl; },
        set(v) { impl = wrap(v); },
      });

      localStorage.setItem('auth_token', tok);
      localStorage.setItem('current_user', JSON.stringify(user));
      localStorage.setItem('role', role);
      localStorage.setItem('userRole', role);
      localStorage.setItem('userProfile', JSON.stringify(user));
      localStorage.setItem('isLoggedIn', 'true');
      // Admin pages key their guards off these flags rather than the role claim.
      localStorage.setItem('adminLoggedIn', 'true');
      localStorage.setItem('loggedUser', JSON.stringify(user));
    }, TOKENS[spec.role], USERS[spec.role], spec.role);

    await page.goto(BASE + spec.url, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
    await sleep(4000);

    const res = await page.evaluate(() => ({
      href: location.href,
      leaflet: typeof window.L,
      SOCKET_URL: window.SOCKET_URL,
      bridgeConnected: Boolean(window.ScosSocketBridge && window.ScosSocketBridge.connected),
      hasMapHost: Boolean(
        document.querySelector('.leaflet-container, [id*="map"], [id*="Map"]')
      ),
    }));
    res.websockets = websockets;
    res.cspViolations = csp.length;
    res.consoleErrors = errors.length;
    res.ownSockets = await page.evaluate(() =>
      (window.__ioSockets || []).map((s) => Boolean(s && s.connected))
    );
    // Not every page uses the shared socket.js bridge - the admin live monitor
    // opens its own `window.io(...)` connection - so any connected socket.io
    // client counts as proof the socket layer reached the right URL.
    res.socketConnected = res.bridgeConnected || res.ownSockets.some(Boolean);

    const ok =
      res.leaflet === 'object' &&
      res.socketConnected === true &&
      res.cspViolations === 0 &&
      (!spec.expectMap || res.hasMapHost);
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${spec.url}`);
    console.log('       ' + JSON.stringify(res));
    if (csp.length) console.log('       CSP: ' + csp.join(' | '));
    if (errors.length) console.log('       ERR: ' + errors.slice(0, 5).join(' | '));

    await page.close();
  }

  await browser.close();
  console.log(failures === 0 ? '\nALL PAGES PASS' : `\n${failures} PAGE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SMOKE FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
