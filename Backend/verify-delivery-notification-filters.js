/**
 * Dependency-free check for the Delivery Staff notification filters
 * (Frontend/src/pages/delivery/notifications.html + js/delivery/notifications.js
 *  + js/notification-center.js + the backend notification contract).
 *
 * WHY THIS EXISTS
 * ---------------
 * Every delivery notification used to be filed under the generic
 * `status_update` type, so an assignment notice and a "picked up" notice were
 * indistinguishable by category. The panel tabs could therefore only be driven
 * by ad-hoc `meta` tags - and any row written without them (which includes every
 * historical row) satisfied no predicate at all. The result: "Assignments" and
 * "Status Updates" rendered empty while those same rows were plainly visible
 * under "All", which looks exactly like a dead filter.
 *
 * So this verifies the whole chain rather than the switch statement:
 *   1. the backend emits REAL categories (delivery_assigned / delivery_status /
 *      delivery_issue) and serialises deliveryId,
 *   2. the panel filters on that category, never on message text,
 *   3. historical rows (no new type) still land in the right tab,
 *   4. unread / mark-as-read / realtime insertion behave against the real engine,
 *   5. every tab declared in the real HTML is reachable and reports a count.
 *
 * The tab list is read from the real HTML, so a tab added there without a
 * matching rule fails here instead of silently doing nothing in the browser.
 *
 * Run: node Backend/verify-delivery-notification-filters.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'Frontend', 'src', 'pages', 'delivery', 'notifications.html');
const PANEL = path.join(ROOT, 'Frontend', 'src', 'js', 'delivery', 'notifications.js');
const CENTER = path.join(ROOT, 'Frontend', 'src', 'js', 'notification-center.js');
const MODEL = path.join(ROOT, 'Backend', 'src', 'models', 'Notification.js');
const NOTIF_CTRL = path.join(ROOT, 'Backend', 'src', 'controllers', 'notification.controller.js');
const DELIVERY_CTRL = path.join(ROOT, 'Backend', 'src', 'controllers', 'delivery.controller.js');

const read = (p) => fs.readFileSync(p, 'utf8');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const FILTERS = ['all', 'unread', 'assignments', 'updates', 'problems'];

// --- the tab list, straight from the real page --------------------------------
function tabsFromPage() {
  const html = read(PAGE);
  const block = html.match(/<div class="delivery-tabs" id="notifFilterTabs">([\s\S]*?)<\/div>/);
  assert(block, 'notifications.html has no #notifFilterTabs block');
  return Array.from(block[1].matchAll(/data-filter="([\w-]+)"/g)).map((m) => m[1]);
}

// --- minimal DOM good enough to mount the real panel engine -------------------
function makeEl(tag, attrs, kids) {
  const node = {
    tagName: (tag || 'div').toUpperCase(),
    attrs: Object.assign({}, attrs),
    dataset: {},
    style: {},
    classes: new Set(),
    _kids: kids || [],
    innerHTML: '',
    textContent: '',
    addEventListener() {},
    removeEventListener() {},
    contains() {
      return false;
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    appendChild(c) {
      this._kids.push(c);
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      const out = [];
      const cls = sel.startsWith('.') ? sel.slice(1) : null;
      const attrM = /\[([\w-]+)\]$/.exec(sel);
      (function walk(n) {
        for (const c of n._kids || []) {
          const hit = cls ? c.classes.has(cls) : attrM ? c.getAttribute(attrM[1]) !== null : c.tagName === sel;
          if (hit) out.push(c);
          walk(c);
        }
      })(this);
      return out;
    },
  };
  const self = node;
  node.classList = {
    add: (c) => self.classes.add(c),
    remove: (c) => self.classes.delete(c),
    contains: (c) => self.classes.has(c),
    toggle: (c, f) => {
      const on = f === undefined ? !self.classes.has(c) : !!f;
      if (on) self.classes.add(c);
      else self.classes.delete(c);
      return on;
    },
  };
  return node;
}

/** Mount the REAL engine + REAL matchFilter over a fixed payload. */
function mountPanel(payload) {
  const html = read(PAGE);
  const tabsHtml = /<div class="delivery-tabs" id="notifFilterTabs">([\s\S]*?)<\/div>/.exec(html)[1];
  const tabs = [];
  for (const m of tabsHtml.matchAll(/data-filter="([\w-]+)"[^>]*>([\s\S]*?)<\/button>/g)) {
    const b = makeEl('button', { 'data-filter': m[1] });
    const label = makeEl('span', {});
    label.textContent = m[2].replace(/<[^>]*>/g, '').trim();
    const count = makeEl('span', { 'data-count-for': m[1], class: 'tab-count' });
    b._kids.push(label, count);
    b.countEl = count;
    if (m[1] === 'all') b.classes.add('active');
    tabs.push(b);
  }
  const byId = {
    notifList: makeEl('div', { id: 'notifList', class: 'notif-list' }),
    notifFilterTabs: makeEl('div', { id: 'notifFilterTabs' }, tabs),
    emptyState: makeEl('div', { id: 'emptyState' }, [makeEl('p', { 'data-empty-message': '' })]),
    unreadCount: makeEl('span', { id: 'unreadCount' }),
  };

  const requests = [];
  const sandbox = {
    console,
    JSON,
    Math,
    Date,
    Number,
    String,
    Array,
    Object,
    Boolean,
    RegExp,
    Error,
    Promise,
    Set,
    Map,
    isNaN,
    parseInt,
    parseFloat,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    encodeURIComponent,
    CustomEvent: function (type, o) {
      this.type = type;
      this.detail = o && o.detail;
    },
    document: {
      readyState: 'complete',
      getElementById: (id) => byId[id] || null,
      querySelector: (s) => (s === '[data-empty-message]' ? byId.emptyState._kids[0] : null),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => makeEl('div', {}),
      body: makeEl('body', {}),
    },
    localStorage: { getItem: (k) => (k === 'auth_token' ? 'test-token' : null), setItem() {}, removeItem() {} },
    fetch(url, opts) {
      requests.push({ url, method: (opts && opts.method) || 'GET' });
      if (/\/notifications\/.+\/read$/.test(url)) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
      }
      if (/^\/notifications(\?|$)/.test(url.replace(/^.*\/api\/v1/, ''))) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ success: true, count: payload.length, notifications: payload }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, count: 0 }) });
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read(CENTER), sandbox, { filename: 'notification-center.js' });

  // Lift the real predicate (and the constants it closes over) out of the page
  // bootstrap, so this exercises shipped code rather than a copy of it.
  const src = read(PANEL);
  const slice = /var ASSIGNMENT_TYPES[\s\S]*?\n  function matchFilter\(filter, n\) \{[\s\S]*?\n  \}/.exec(src);
  assert(slice, 'could not extract matchFilter() from delivery/notifications.js');
  vm.runInContext(slice[0], sandbox, { filename: 'delivery/notifications.js' });

  const NC = sandbox.ScosNotifications;
  const panel = NC.mount({
    list: 'notifList',
    empty: 'emptyState',
    filter: 'notifFilterTabs',
    count: 'unreadCount',
    matchFilter: sandbox.matchFilter,
    emptyMessages: { unread: 'No unread notifications' },
    markViewedAsRead: false,
    realtime: false,
    poll: false,
  });
  return { panel, tabs, byId, requests, matchFilter: sandbox.matchFilter, NC };
}

// --- payload shapes copied from the real producers ---------------------------
const now = Date.now();
const n = (id, type, meta, isRead, orderId, minutesAgo) => ({
  id,
  title: `${type} ${id}`,
  message: `message for ${id}`,
  type,
  orderId,
  deliveryId: meta.deliveryId || null,
  link: '/src/pages/delivery/deliveries.html',
  meta,
  isRead,
  createdAt: new Date(now - minutesAgo * 60000).toISOString(),
});

const PAYLOAD = [
  // --- current rows: real backend categories ---
  n('a1', 'delivery_assigned', { orderType: 'delivery', assignment: true, deliveryId: 'D1' }, false, 'ORD-1008', 1),
  n('a2', 'delivery_assigned', { orderType: 'delivery', assignment: true, unassigned: true, deliveryId: 'D2' }, true, 'ORD-1007', 2),
  n('s1', 'delivery_status', { orderType: 'delivery', deliveryStatus: 'PICKED_UP', deliveryId: 'D1' }, false, 'ORD-1008', 3),
  n('s2', 'delivery_status', { orderType: 'delivery', deliveryStatus: 'OUT_FOR_DELIVERY', deliveryId: 'D1' }, false, 'ORD-1008', 4),
  n('s3', 'delivery_status', { orderType: 'delivery', deliveryStatus: 'DELIVERED', deliveryId: 'D1' }, true, 'ORD-1006', 5),
  n('p1', 'delivery_issue', { orderType: 'delivery', deliveryStatus: 'ARRIVED', issueId: 'I1', deliveryId: 'D5' }, false, 'ORD-1005', 6),
  n('s4', 'delivery_status', { orderType: 'delivery', deliveryStatus: 'FAILED', failureReason: 'unreachable', deliveryId: 'D4' }, false, 'ORD-1004', 7),
  n('x1', 'system', {}, false, '', 8),
  // --- legacy rows written before the types existed (fallback path) ---
  n('L1', 'status_update', { orderType: 'delivery', assignment: true }, false, 'ORD-1003', 9),
  n('L2', 'status_update', { orderType: 'delivery', deliveryStatus: 'ARRIVED' }, false, 'ORD-1002', 10),
];

const EXPECT = {
  all: PAYLOAD.length,
  unread: PAYLOAD.filter((x) => !x.isRead).length,
  assignments: ['a1', 'a2', 'L1'],
  updates: ['s1', 's2', 's3', 'p1', 'L2'],
  problems: ['p1', 's4'],
};

(async () => {
  console.log('\nDelivery Staff notification filters\n');

  console.log('Backend contract');
  await check('the notification enum defines real delivery categories', () => {
    const src = read(MODEL);
    for (const t of ['delivery_assigned', 'delivery_status', 'delivery_issue']) {
      assert(new RegExp(`'${t}'`).test(src), `NOTIFICATION_TYPES is missing '${t}'`);
    }
  });
  await check('assignment notices are typed delivery_assigned, not status_update', () => {
    const src = read(DELIVERY_CTRL);
    const assignBlock = src.slice(src.indexOf('New courier: a new delivery'), src.indexOf('Delivery Retry Reassigned') + 400);
    assert(assignBlock.includes("'delivery_assigned'"), 'no courier assignment notice uses delivery_assigned');
    assert(!/notifyUser\(\s*staff\._id[\s\S]{0,400}?'status_update'/.test(assignBlock), 'a courier assignment notice still uses status_update');
  });
  await check('the courier lifecycle notice is typed delivery_status', () => {
    const src = read(DELIVERY_CTRL);
    const block = src.slice(src.indexOf('const courierStep = COURIER_STEP_MESSAGES[target]'), src.indexOf('notifyManagement', src.indexOf('const courierStep')));
    assert(block.includes("'delivery_status'"), 'courier lifecycle notice still uses status_update');
  });
  await check('the API serialises deliveryId and the read state', () => {
    const src = read(NOTIF_CTRL);
    const fn = src.slice(src.indexOf('function serializeNotification'), src.indexOf('exports.getPreferences'));
    for (const f of ['deliveryId', 'isRead', 'type', 'createdAt', 'orderId', 'title', 'message']) {
      assert(new RegExp(`\\b${f}\\b`).test(fn), `serializeNotification does not return ${f}`);
    }
  });
  await check('the API scopes notifications to the authenticated user', () => {
    const src = read(NOTIF_CTRL);
    const fn = src.slice(src.indexOf('exports.getNotifications'), src.indexOf('exports.getUnreadCount'));
    assert(/userId:\s*req\.user\.id/.test(fn), 'getNotifications is not scoped to req.user.id');
    assert(/sort\(\{\s*createdAt:\s*-1\s*\}\)/.test(fn), 'getNotifications is not newest-first');
  });
  await check('mark-as-read is scoped to one notification and one owner', () => {
    const src = read(NOTIF_CTRL);
    const fn = src.slice(src.indexOf('exports.markAsRead'), src.indexOf('exports.markAllRead'));
    assert(/findOne\(\{[^}]*userId:\s*req\.user\.id/.test(fn), 'markAsRead is not owner-scoped');
    assert(/isRead:\s*false/.test(fn), 'markAsRead is not idempotent');
  });

  console.log('\nFilter behaviour (real engine + real predicate)');
  const env = mountPanel(PAYLOAD);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  await check('every tab declared in the page is a known filter', () => {
    const declared = tabsFromPage();
    for (const f of declared) assert(FILTERS.includes(f), `page declares unhandled filter '${f}'`);
  });

  for (const filter of FILTERS) {
    await check(`'${filter}' shows only its own notifications`, () => {
      env.panel.setFilter(filter);
      const shown = env.panel.items.filter((x) => env.matchFilter(filter, x)).map((x) => x.id);
      const want = Array.isArray(EXPECT[filter]) ? EXPECT[filter] : null;
      if (want) {
        assert(shown.length === want.length, `expected ${want.length} (${want.join(',')}) got ${shown.length} (${shown.join(',')})`);
        for (const id of want) assert(shown.includes(id), `'${filter}' is missing ${id}`);
      } else {
        assert(shown.length === EXPECT[filter], `expected ${EXPECT[filter]} got ${shown.length}`);
      }
      const cards = (env.byId.notifList.innerHTML.match(/class="notif-card/g) || []).length;
      assert(cards === shown.length, `rendered ${cards} cards but ${shown.length} notifications matched`);
    });
  }

  await check('the active tab always matches the rendered list', () => {
    for (const filter of FILTERS) {
      env.panel.setFilter(filter);
      const active = env.tabs.filter((t) => t.classes.has('active')).map((t) => t.getAttribute('data-filter'));
      assert(active.length === 1 && active[0] === filter, `'${filter}' left active state as ${active.join(',')}`);
    }
  });

  await check('every tab publishes a count that agrees with its own filter', () => {
    for (const tab of env.tabs) {
      const key = tab.getAttribute('data-filter');
      const badge = tab.countEl.textContent;
      const want = env.panel.items.filter((x) => env.matchFilter(key, x)).length;
      assert(badge === String(want), `tab '${key}' badge reads ${badge}, filter holds ${want}`);
    }
  });

  await check('"All" includes read and unread, and nothing is dropped', () => {
    env.panel.setFilter('all');
    assert(env.byId.notifList.innerHTML.includes('class="notif-card'), 'no cards rendered under All');
    const unread = env.byId.notifList.innerHTML.match(/notif-card unread/g) || [];
    assert(unread.length === EXPECT.unread, `expected ${EXPECT.unread} unread rows, saw ${unread.length}`);
  });

  await check('filters never fall back to matching the message text', () => {
    const src = read(PANEL);
    const slice = /var ASSIGNMENT_TYPES[\s\S]*?\n  function matchFilter\(filter, n\) \{[\s\S]*?\n  \}/.exec(src)[0];
    // Membership tests against a known list of types are the point; reading the
    // human-readable fields (or substring-matching them) would be the bug.
    assert(!/\bn\.(title|message)\b/.test(slice), 'the predicate inspects title/message text');
    assert(!/\.(includes|startsWith|endsWith|match)\(/.test(slice), 'the predicate uses substring matching');
  });

  await check('an empty Unread tab says so explicitly', async () => {
    const clean = PAYLOAD.map((x) => ({ ...x, isRead: true }));
    const e2 = mountPanel(clean);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    e2.panel.setFilter('unread');
    assert(e2.panel.items.filter((x) => e2.matchFilter('unread', x)).length === 0, 'expected zero unread');
    assert(
      e2.byId.emptyState.style.display !== 'none',
      'empty state not shown'
    );
    const msg = e2.byId.emptyState._kids[0].textContent;
    assert(/no unread/i.test(msg), `empty state reads "${msg}"`);
  });

  await check('marking one notification read does not touch the others', async () => {
    const before = env.panel.items.filter((x) => !x.isRead).length;
    const target = env.panel.items.find((x) => !x.isRead);
    await env.panel.markRead(target.id);
    env.panel.render();
    const after = env.panel.items.filter((x) => !x.isRead).length;
    assert(after === before - 1, `unread count went ${before} -> ${after}`);
    assert(env.requests.some((r) => r.method === 'PATCH' && /\/read$/.test(r.url)), 'no mark-as-read PATCH was issued');
    assert(!env.requests.some((r) => /read-all/.test(r.url)), 'opening a notification hit the read-all endpoint');
  });

  await check('a realtime notification appears only in the filters it matches', () => {
    env.panel.setFilter('all');
    const before = env.panel.items.length;
    const unreadBefore = env.panel.items.filter((x) => !x.isRead).length;
    env.panel.ingest({
      id: 'rt1',
      type: 'delivery_assigned',
      title: 'Delivery Assigned!',
      message: 'x',
      orderId: 'ORD-2000',
      deliveryId: 'D9',
      meta: { orderType: 'delivery', assignment: true, deliveryId: 'D9' },
      isRead: false,
      createdAt: new Date().toISOString(),
    });
    assert(env.panel.items.length === before + 1, 'realtime notification was not added');
    assert(
      env.panel.items.filter((x) => !x.isRead).length === unreadBefore + 1,
      'unread count did not grow'
    );
    assert(env.byId.unreadCount.textContent === String(unreadBefore + 1), 'unread pill did not update');
    env.panel.setFilter('assignments');
    assert(env.byId.notifList.innerHTML.includes('rt1'), 'assignment filter hid a new assignment');
    env.panel.setFilter('problems');
    assert(!env.byId.notifList.innerHTML.includes('rt1'), 'problems filter showed an assignment');
  });

  await check('a repeated realtime frame does not duplicate a notification', () => {
    const first = env.panel.items.find((x) => x.id === 'rt1');
    env.panel.ingest({
      id: 'rt1',
      type: 'delivery_assigned',
      title: 'Delivery Assigned!',
      message: 'x',
      orderId: 'ORD-2000',
      meta: { orderType: 'delivery', assignment: true },
      isRead: false,
      createdAt: new Date().toISOString(),
    });
    assert(env.panel.items.filter((x) => x.id === 'rt1').length === 1, 'duplicate notification inserted');
    assert(env.panel.items.find((x) => x.id === 'rt1').id === first.id, 'record identity changed');
  });

  await check('switching filters does not refetch or lose the loaded data', () => {
    const before = env.panel.items.length;
    env.panel.setFilter('all');
    env.panel.setFilter('updates');
    env.panel.setFilter('unread');
    assert(env.panel.items.length === before, 'the loaded notification set changed while switching filters');
  });

  await check('the panel reads the API, not a hard-coded list', () => {
    assert(env.requests.some((r) => r.method === 'GET' && /\/notifications/.test(r.url)), 'no GET /notifications was issued');
    const src = read(PANEL);
    assert(!/orderId:\s*['"][A-Z]{2,}-\d/.test(src), 'delivery/notifications.js contains hard-coded order ids');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFAILED:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(failures.length ? 1 : 0);
})();