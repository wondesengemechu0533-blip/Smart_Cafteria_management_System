/**
 * Kitchen Order Queue - table render reproduction.
 *
 * Loads the REAL Frontend/src/pages/kitchen/kitchen.js against a fake DOM and the
 * EXACT payload shape getKitchenDashboard() returns, then inspects what actually
 * lands in #kitchenOrdersBody (the <tbody id="kitchenOrdersBody"> of
 * kitchen/orders.html).
 *
 * Run: node Backend/tests/kitchen-queue-render.repro.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const KITCHEN_JS = path.join(__dirname, '..', '..', 'Frontend', 'src', 'pages', 'kitchen', 'kitchen.js');

/* ------------------------------------------------------------- fake DOM */
function makeEl(id) {
  const el = {
    _id: id, id,
    style: {},
    dataset: {},
    className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [],
    firstElementChild: null,
    innerHTML: '',
    textContent: '',
    hidden: false,
    attributes: {},
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    focus() {},
    click() {},
    play() { return Promise.resolve(); },
  };
  return el;
}

const nodes = {};
const TABLE_ID = 'kitchenOrdersBody';
nodes[TABLE_ID] = makeEl(TABLE_ID);
[
  'kitchenTicketsGrid', 'pendingCount', 'preparingCount', 'readyCount', 'cancelledCount',
  'soundToggleBtn', 'soundToggleIcon', 'soundToggleLabel', 'kdsToastStack', 'kdsNewOrderBanner',
  'kdsNotifPanel', 'kdsNotifList', 'kdsNotifUnreadCount', 'soundUnlockBanner', 'enableSoundBtn',
  'orderNotificationSound', 'userMenuBtn', 'userMenu', 'kdsSidebarToggle', 'kdsSidebar',
  'kdsSidebarBackdrop', 'userName', 'kdsAlertBanner',
].forEach((id) => { nodes[id] = makeEl(id); });

// Filter buttons, as they exist in orders.html
const filterButtons = [
  makeEl('f-all'), makeEl('f-pending'), makeEl('f-preparing'), makeEl('f-ready'), makeEl('f-cancelled'),
];
filterButtons[0].dataset.status = 'all';
filterButtons[1].dataset.status = 'Pending';
filterButtons[2].dataset.status = 'Preparing';
filterButtons[3].dataset.status = 'Ready';
filterButtons[4].dataset.status = 'Cancelled';

const document_ = {
  readyState: 'complete',
  hidden: false,
  getElementById: (id) => nodes[id] || null,
  querySelector: () => null,
  querySelectorAll: (sel) => (sel.includes('filter-group') ? filterButtons : []),
  createElement: () => makeEl('tmp'),
  addEventListener: () => {},
  removeEventListener: () => {},
  body: makeEl('body'),
};

/* ------------------------------------------------ the real backend payload */
// Exactly what getKitchenDashboard() returns for a queue with one order in
// each kitchen stage, using formatKitchenOrder()'s field names.
const DASHBOARD_PAYLOAD = {
  success: true,
  stats: { pending: 1, preparing: 1, ready: 1, cancelled: 1, activeOrders: 3, totalActive: 3 },
  orders: {
    pending: [{
      id: '1', orderId: 'ET-P1', customerName: 'Alice', customerPhone: '0911',
      items: [{ name: 'Kitfo', quantity: 2, notes: 'no onion', itemStatus: 'pending' }],
      status: 'pending', orderStatus: 'PENDING', paymentStatus: 'PAID', priority: 'normal',
      totalAmount: 120, orderType: 'dine-in', tableNumber: '4',
      createdAt: new Date(Date.now() - 300000).toISOString(), elapsedTime: '5 mins',
    }],
    preparing: [{
      id: '2', orderId: 'ET-P2', customerName: 'Beko', customerPhone: '0922',
      items: [{ name: 'Doro', quantity: 1, notes: '', itemStatus: 'preparing' }],
      status: 'preparing', orderStatus: 'PREPARING', paymentStatus: 'PAID', priority: 'normal',
      totalAmount: 200, orderType: 'delivery', tableNumber: 'N/A',
      createdAt: new Date(Date.now() - 600000).toISOString(), elapsedTime: '10 mins',
    }],
    ready: [{
      id: '3', orderId: 'ET-P3', customerName: 'Chala', customerPhone: '0933',
      items: [{ name: 'Shiro', quantity: 3, notes: '', itemStatus: 'ready' }],
      status: 'ready', orderStatus: 'READY', paymentStatus: 'PAID', priority: 'normal',
      totalAmount: 90, orderType: 'takeaway', tableNumber: 'N/A',
      createdAt: new Date(Date.now() - 900000).toISOString(), elapsedTime: '15 mins',
    }],
    cancelled: [{
      id: '4', orderId: 'ET-C1', customerName: 'Dani', customerPhone: '0944',
      items: [{ name: 'Firfir', quantity: 1, notes: '', itemStatus: 'pending' }],
      status: 'cancelled', orderStatus: 'CANCELLED', paymentStatus: 'PAID', priority: 'normal',
      totalAmount: 60, orderType: 'dine-in', tableNumber: '2',
      createdAt: new Date(Date.now() - 1200000).toISOString(), elapsedTime: '20 mins',
    }],
  },
};

const apiCalls = [];
const sandbox = {
  console,
  setTimeout: () => 0, clearTimeout: () => {},
  setInterval: () => 0, clearInterval: () => {},
  Audio: function () { return makeEl('audio'); },
  URLSearchParams,
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  document: document_,
  navigator: { userAgent: 'node' },
  localStorage: {
    _s: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem(k, v) { this._s[k] = String(v); },
    removeItem(k) { delete this._s[k]; },
  },
  api: {
    get: async (p) => {
      apiCalls.push(`GET ${p}`);
      if (p.startsWith('/kitchen/dashboard')) return JSON.parse(JSON.stringify(DASHBOARD_PAYLOAD));
      if (p.startsWith('/notifications')) return { success: true, notifications: [] };
      return { success: true };
    },
    patch: async (p) => { apiCalls.push(`PATCH ${p}`); return { success: true }; },
    post: async (p) => { apiCalls.push(`POST ${p}`); return { success: true }; },
  },
  socketClient: {
    on() {}, off() {}, connect() {}, disconnect() {},
    isKitchenStaff: () => true, isKitchenDashboard: () => true,
    socket: null, notifySound() {},
  },
  fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

// Strip the ES module imports (api / socketClient are injected as globals) and
// the auto-boot DOMContentLoaded hook - we drive loadInitialOrders()/render()
// ourselves so nothing starts on its own.
//
// NOTE: unlike delivery/deliveries.js, this file registers DOMContentLoaded near
// the TOP (line ~28), so the hook must be removed as a whole block - a
// "everything after DOMContentLoaded" strip would delete the entire module.
let src = fs.readFileSync(KITCHEN_JS, 'utf8')
  .replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, '')
  .replace(/document\.addEventListener\(\s*["']DOMContentLoaded["'][\s\S]*?\}\s*\);\s*$/m, '');
if (/^\s*import\s/m.test(src)) {
  console.error('FATAL: import stripping failed');
  process.exit(1);
}
vm.createContext(sandbox);
try {
  vm.runInContext(src, sandbox, { filename: KITCHEN_JS });
} catch (e) {
  console.error('vm load error: ' + e.message);
  console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

const KDS = sandbox.window.KDS || sandbox.KDS;
if (!KDS) {
  console.error('FATAL: KDS did not load (window.KDS=' + typeof sandbox.window.KDS + ')');
  process.exit(1);
}

/* ------------------------------------------------------------------ drive it */
(async () => {
  KDS.cacheDOM();
  await KDS.loadInitialOrders();
  KDS.render();

  const html = nodes[TABLE_ID].innerHTML;
  const rows = (html.match(/<tr data-order-id=/g) || []).length;

  console.log('API calls: ' + apiCalls.join(', '));
  console.log('KDS.orders size: ' + KDS.orders.size + ' -> ' + Array.from(KDS.orders.keys()).join(', '));
  console.log('currentFilter: ' + JSON.stringify(KDS.currentFilter));
  console.log('tbody <tr data-order-id> count: ' + rows);
  console.log('tbody empty string: ' + (html === ''));
  console.log('tbody contains empty-state: ' + /No .* orders found in queue/.test(html));
  console.log('--- tbody (first 600 chars) ---');
  console.log(html.slice(0, 600) || '(EMPTY)');

  console.log('');
  console.log('--- per-filter row counts ---');
  let bad = 0;
  const expected = { all: 3, pending: 1, preparing: 1, ready: 1, cancelled: 1 };
  for (const label of ['all', 'pending', 'preparing', 'ready', 'cancelled']) {
    KDS.currentFilter = label;
    KDS.render();
    const n = (nodes[TABLE_ID].innerHTML.match(/<tr data-order-id=/g) || []).length;
    const empty = /No .* orders found in queue|orders right now|queue is clear/.test(nodes[TABLE_ID].innerHTML);
    const ok = n === expected[label];
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label.padEnd(10)} rows=${n} (expected ${expected[label]})${empty ? '  (empty-state shown)' : ''}`);
  }
  console.log('');
  console.log(bad ? `FAILED: ${bad} filter(s)` : 'ALL FILTERS OK');
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
