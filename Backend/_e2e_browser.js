/**
 * Browser-level check of the customer Live Delivery Tracking page.
 *
 * Loads the real page in Chrome against the local dev servers, records every
 * console message / page error / failed request, and reports exactly what the
 * customer would see (connection badge, map status line, Leaflet state).
 *
 * Usage: node _e2e_browser.js [orderId]
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require(path.join(process.env.TEMP, 'opencode', 'pw', 'node_modules', 'puppeteer-core'));

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:5500';
const summary = JSON.parse(
  fs.readFileSync(path.join(__dirname, '_e2e_summary.json'), 'utf8')
);
const orderId = process.argv[2] || summary.orderId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const consoleLines = [];
  const pageErrors = [];
  const failedRequests = [];
  const responses = [];
  const allRequests = [];

  page.on('console', (msg) => {
    consoleLines.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => pageErrors.push(String(err && err.stack ? err.stack : err)));
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.failure() && req.failure().errorText} ${req.url()}`);
  });
  page.on('request', (req) => allRequests.push(`${req.method()} ${req.url()}`));
  page.on('response', (res) => {
    const u = res.url();
    responses.push(`${res.status()} ${res.request().method()} ${u}`);
  });

  // Fake the device position so watchPosition/getPosition resolve like a real
  // phone would (the coordinates are only ever used to prove the PIPELINE).
  const client = await page.createCDPSession();
  await client.send('Emulation.setGeolocationOverride', {
    latitude: 9.03,
    longitude: 38.76,
    accuracy: 20,
  });
  await client.send('Browser.setPermission', {
    permission: { name: 'geolocation' },
    setting: 'granted',
    origin: BASE,
  }).catch(() => {});

  // Seed the signed-in session exactly the way login.html would.
  await page.evaluateOnNewDocument((tok, user) => {
    localStorage.setItem('auth_token', tok);
    localStorage.setItem('current_user', JSON.stringify(user));
    localStorage.setItem('role', user.role);
    localStorage.setItem('userRole', user.role);
    localStorage.setItem('userProfile', JSON.stringify(user));
    localStorage.setItem('isLoggedIn', 'true');
  }, summary.customerToken, summary.customerUser);

  const url = `${BASE}/src/pages/customer/order-tracking.html?orderId=${encodeURIComponent(orderId)}`;
  console.log('loading', url);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(6000);

  const state = await page.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    const txt = (id) => ($(id) ? $(id).textContent.trim() : null);
    const card = $('delivery-map-card');
    const mapEl = $('delivery-map');
    const L = window.L;
    let leaflet = null;
    if (mapEl && L && L.Map) {
      // Leaflet stamps its container with _leaflet_id when a map was created.
      leaflet = {
        initialized: Boolean(mapEl._leaflet_id),
        childCount: mapEl.childElementCount,
        hasTilePane: Boolean(mapEl.querySelector('.leaflet-tile-pane')),
        markerCount: mapEl.querySelectorAll('.leaflet-marker-icon').length,
        circleCount: mapEl.querySelectorAll('.leaflet-circle').length,
        size: mapEl.getBoundingClientRect
          ? { w: Math.round(mapEl.getBoundingClientRect().width), h: Math.round(mapEl.getBoundingClientRect().height) }
          : null,
      };
    }
    return {
      globals: {
        io: typeof window.io,
        SOCKET_URL: window.SOCKET_URL,
        __API_BASE: window.__API_BASE,
        __API_URL: window.__API_URL,
        API_BASE_URL: window.API_BASE_URL,
        L: typeof window.L,
        socketConnected: Boolean(window.ScosSocketBridge && window.ScosSocketBridge.connected),
      },
      cardVisible: card ? getComputedStyle(card).display !== 'none' : false,
      connection: txt('track-connection'),
      mapStatus: txt('delivery-map-status'),
      mapStatusClass: $('delivery-map-status') ? $('delivery-map-status').className : null,
      heading: txt('status-heading'),
      summaryVisible: $('track-summary') ? getComputedStyle($('track-summary')).display !== 'none' : false,
      distance: txt('track-distance'),
      eta: txt('track-eta'),
      courier: txt('track-courier'),
      cafeteria: txt('track-cafeteria'),
      leafletAvailable: typeof L !== 'undefined',
      leaflet,
      bodyHasError: /uncaught|error/i.test(document.body.innerText.slice(0, 200)),
    };
  });

  console.log('\n=== PAGE STATE ===');
  console.log(JSON.stringify(state, null, 2));

  await sleep(1000);

  // Record every `delivery:location` frame the page receives so we can prove
  // the socket path (not a poll) is what moves the marker.
  await page.evaluate(() => {
    window.__gpsFrames = [];
    const sc = window.ScosSocketBridge;
    if (sc) sc.on('delivery:location', (p) => window.__gpsFrames.push(p));
  });

  // ---- live push check: the rider's device uploads a NEW fix while the
  // customer is watching; the marker/status must move without a page reload.
  const livePush = await page.evaluate(async (tok, id) => {
    const markerBefore = document.querySelectorAll('#delivery-map .leaflet-marker-icon').length;
    const before = (document.getElementById('delivery-map-status') || {}).textContent;
    const res = await fetch(`http://localhost:5000/api/v1/deliveries/${id}/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ latitude: 9.021, longitude: 38.764, accuracy: 12, timestamp: Date.now() }),
    });
    const body = await res.json().catch(() => null);
    await new Promise((r) => setTimeout(r, 4000));
    const after = (document.getElementById('delivery-map-status') || {}).textContent;
    const markers = Array.from(document.querySelectorAll('#delivery-map .leaflet-marker-icon')).map((m) => ({
      lat: m.getAttribute('data-marker-index'),
      cls: m.className,
    }));
    return {
      uploadStatus: res.status,
      uploadBody: body,
      before,
      after,
      markerBefore,
      markerCount: markers.length,
      moved: before !== after,
    };
  }, summary.riderToken, orderId);
  console.log('\n=== LIVE GPS PUSH ===');
  console.log(JSON.stringify(livePush, null, 2));

  const late = await page.evaluate(() => {
    const txt = (id) => {
      const el = document.getElementById(id);
      return el ? el.textContent.trim() : null;
    };
    const mapEl = document.getElementById('delivery-map');
    return {
      connection: txt('track-connection'),
      mapStatus: txt('delivery-map-status'),
      leaflet: typeof window.L,
      socketConnected: Boolean(window.ScosSocketBridge && window.ScosSocketBridge.connected),
      gpsFrames: window.__gpsFrames || [],
      markerCount: mapEl ? mapEl.querySelectorAll('.leaflet-marker-icon').length : -1,
      tilePane: mapEl ? Boolean(mapEl.querySelector('.leaflet-tile-pane')) : null,
    };
  });
  console.log('\n=== LATE STATE (after live push) ===');
  console.log(JSON.stringify(late, null, 2));

  console.log('\n=== API / SOCKET RESPONSES ===');
  console.log(responses.filter((r) => /\/api\/v1\/|socket\.io/.test(r)).join('\n') || '(none)');
  console.log('\n=== OTHER RESPONSES (non 2xx) ===');
  console.log(responses.filter((r) => !/\/api\/v1\/|socket\.io/.test(r) && !/^2\d\d /.test(r)).join('\n') || '(none)');
  console.log('\n=== FAILED REQUESTS ===');
  console.log(failedRequests.join('\n') || '(none)');
  console.log('\n=== PAGE ERRORS ===');
  console.log(pageErrors.join('\n---\n') || '(none)');
  console.log('\n=== CONSOLE ===');
  console.log(consoleLines.join('\n') || '(none)');

  const shot = path.join(__dirname, '_e2e_tracking.png');
  await page.screenshot({ path: shot, fullPage: true });
  console.log('\nscreenshot:', shot);

  await browser.close();
})().catch((e) => {
  console.error('BROWSER HARNESS FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
