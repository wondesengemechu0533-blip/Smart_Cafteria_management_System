/**
 * Customer Order History - regression tests for "No Past Orders Found".
 *
 * Drives the REAL Frontend/src/js/order-history.js against a fake DOM and the
 * exact payload shape GET /api/v1/orders/my-orders?scope=all returns, then
 * asserts:
 *
 *   1. real orders render (order id / items / total)
 *   2. every filter tab (All / Completed / In Progress+Pending / Cancelled /
 *      Refunded) shows exactly its own orders
 *   3. "No Past Orders Found" is shown ONLY after a SUCCESSFUL empty request
 *   4. a failed request shows an error + Retry instead of the empty message
 *   5. an expired token (401) shows "session expired" + a sign-in link
 *   6. a 403 (blocked account / not a customer) shows a permission error, NOT
 *      "session expired", and a 5xx/network failure never claims expiry either
 *   7. localStorage is NOT the source of truth when the API succeeds
 *   8. local orders are only a fallback when the API fails
 *
 * Run: node Backend/tests/order-history-render.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ORDER_HISTORY_JS = path.join(__dirname, '..', '..', 'Frontend', 'src', 'js', 'order-history.js');

let pass = 0;
let fail = 0;
const pending = [];
function check(name, fn) {
  pending.push((async () => {
    try { await fn(); pass++; console.log('  PASS ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + ' -- ' + e.message); }
  })());
}

function makeEl(id) {
  return {
    _id: id, id,
    style: {}, dataset: {}, className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [], innerHTML: '', hidden: false, textContent: '',
    _attrs: {},
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
    hasAttribute(k) { return this.getAttribute(k) !== null; },
    addEventListener(type, fn) {
      const m = this._l || (this._l = {});
      (m[type] || (m[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      if (this._l && this._l[type]) this._l[type] = this._l[type].filter((f) => f !== fn);
    },
    dispatch(type, ev) {
      (this._l && this._l[type] || []).slice().forEach((fn) => fn(ev || { type, target: this, preventDefault() {}, stopImmediatePropagation() {} }));
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    appendChild(c) { this.children.push(c); return c; },
    click() { this.dispatch('click'); },
  };
}

function order(id, status, orderStatus, extra) {
  return Object.assign({
    orderId: id,
    customerName: 'Customer User',
    customerPhone: '0922334455',
    orderType: 'dine-in',
    tableNumber: '1',
    items: [{ name: 'Pasta', quantity: 2, price: 75 }],
    subtotal: 150,
    serviceFee: 20,
    totalAmount: 170,
    status,
    orderStatus,
    paymentStatus: 'PAID',
    refundStatus: 'NOT_REQUIRED',
    orderDate: '10/5/2026, 9:55:58 AM',
    createdAt: new Date('2026-10-05T09:55:58Z').toISOString(),
  }, extra || {});
}

const THREE_ORDERS = [
  order('ET-3001', 'pending', 'PENDING', { paymentStatus: 'PENDING' }),
  order('ET-3002', 'Completed', 'COMPLETED'),
  order('ET-3003', 'cancelled', 'CANCELLED'),
];

function buildHarness({ apiMode = 'ok', payload = { success: true, count: 0, orders: [] }, localHistory = [] } = {}) {
  const nodes = {
    'orders-history-list': makeEl('orders-history-list'),
    'clear-history-btn': makeEl('clear-history-btn'),
    'history-retry-btn': makeEl('history-retry-btn'),
  };
  const tabs = ['all', 'Completed', 'Pending', 'Cancelled', 'Refunded'].map((f) => {
    const el = makeEl('tab-' + f);
    el.dataset.filter = f;
    el._attrs['data-filter'] = f;
    return el;
  });

  const store = { auth_token: 'test-token', orderHistory: JSON.stringify(localHistory) };
  const apiCalls = [];

  const document_ = {
    readyState: 'complete', hidden: false, _l: {},
    getElementById: (id) => nodes[id] || null,
    querySelector: () => null,
    querySelectorAll: (sel) => (String(sel).includes('history-tab') ? tabs : []),
    createElement: () => makeEl('tmp'),
    addEventListener(type, fn) { (this._l[type] || (this._l[type] = [])).push(fn); },
    removeEventListener(type, fn) { if (this._l[type]) this._l[type] = this._l[type].filter((f) => f !== fn); },
    body: makeEl('body'),
  };

  const sandbox = {
    console,
    setTimeout, clearTimeout, Promise, JSON, Date, String, Number, Array, Object, Math, RegExp, Set, Map,
    document: document_,
    navigator: { userAgent: 'node' },
    confirm: () => true,
    alert: () => {},
    location: { href: '', origin: 'http://localhost:5500', hostname: 'localhost', port: '5500', protocol: 'http:' },
    localStorage: {
      _s: store,
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
      setItem(k, v) { this._s[k] = String(v); },
      removeItem(k) { delete this._s[k]; },
    },
    requestCancellation: async () => ({ success: true }),
    syncMyOrders: async () => {},
    api: {
      get: async (p) => {
        apiCalls.push(p);
        if (apiMode === 'throw') throw Object.assign(new Error('Could not connect to backend server.'), { status: 0 });
        if (apiMode === 'unauthorized') throw Object.assign(new Error('Invalid or expired token'), { status: 401 });
        if (apiMode === 'forbidden') throw Object.assign(new Error('Account is inactive or suspended'), { status: 403 });
        if (apiMode === 'serverError') throw Object.assign(new Error('Server error'), { status: 500 });
        return JSON.parse(JSON.stringify(payload));
      },
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  // Strip the ES module imports; the identifiers resolve to sandbox globals above.
  const src = fs.readFileSync(ORDER_HISTORY_JS, 'utf8')
    .replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, '');

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: ORDER_HISTORY_JS });

  return { sandbox, nodes, tabs, store, apiCalls, document_, boot: async () => {
    (document_._l['DOMContentLoaded'] || []).forEach((fn) => fn({}));
    await new Promise((r) => setTimeout(r, 25));
  } };
}

const html = (h) => h.nodes['orders-history-list'].innerHTML;

(async () => {
  console.log('========== CUSTOMER ORDER HISTORY RENDER TESTS ==========\n');

  /* 1. real orders render -------------------------------------------------- */
  {
    const h = buildHarness({ apiMode: 'ok', payload: { success: true, count: 3, orders: THREE_ORDERS } });
    await h.boot();
    check('renders every real order returned by the API', () => {
      const out = html(h);
      ['ET-3001', 'ET-3002', 'ET-3003'].forEach((id) => assert.ok(out.includes(id), id + ' missing'));
      assert.ok(!out.includes('No Past Orders Found'), 'empty state shown despite orders');
      assert.ok(out.includes('170'), 'total amount not rendered');
      assert.ok(out.includes('Pasta'), 'item name not rendered');
    });
    check('calls the full-history endpoint (/orders/my-orders?scope=all)', () => {
      assert.ok(h.apiCalls.includes('/orders/my-orders?scope=all'), JSON.stringify(h.apiCalls));
    });
  }

  /* 2. each filter tab shows its own orders -------------------------------- */
  {
    const h = buildHarness({ apiMode: 'ok', payload: { success: true, count: 3, orders: THREE_ORDERS } });
    await h.boot();
    const expect = { all: 3, Completed: 1, Pending: 1, Cancelled: 1, Refunded: 0 };
    for (const [filter, n] of Object.entries(expect)) {
      const tab = h.tabs.find((t) => t.getAttribute('data-filter') === filter);
      await (async () => {
        tab.dispatch('click', { type: 'click', target: tab, preventDefault() {} });
        await new Promise((r) => setTimeout(r, 25));
      })();
      const id = { all: 'ET-3001', Completed: 'ET-3002', Pending: 'ET-3001', Cancelled: 'ET-3003', Refunded: null }[filter];
      check(`filter "${filter}" shows ${n} order(s)`, () => {
        const cards = (html(h).match(/class="order-history-card"/g) || []).length;
        assert.strictEqual(cards, n, `${filter} rendered ${cards}: ${html(h).slice(0, 160)}`);
        if (id) assert.ok(html(h).includes(id), `${filter} missing ${id}`);
      });
    }
  }

  /* 3. empty state ONLY after a successful empty request ------------------- */
  {
    const h = buildHarness({ apiMode: 'ok', payload: { success: true, count: 0, orders: [] } });
    await h.boot();
    check('successful empty request shows "No Past Orders Found"', () => {
      assert.ok(html(h).includes('No Past Orders Found'), html(h).slice(0, 200));
    });
  }

  /* 4. failed request shows error + Retry, never the empty state ----------- */
  {
    const h = buildHarness({ apiMode: 'throw' });
    await h.boot();
    check('network failure shows an error, not "No Past Orders Found"', () => {
      const out = html(h);
      assert.ok(!out.includes('No Past Orders Found'), 'empty state shown on failure');
      assert.ok(/Couldn't load your orders/.test(out), out.slice(0, 200));
      assert.ok(out.includes('history-retry-btn'), 'no Retry button rendered');
    });
  }

  /* 5. 401 shows session expired + sign-in link ---------------------------- */
  {
    const h = buildHarness({ apiMode: 'unauthorized' });
    await h.boot();
    check('expired token shows "session has expired" + sign-in link', () => {
      const out = html(h);
      assert.ok(out.includes('session has expired'), out.slice(0, 200));
      assert.ok(out.includes('../common/login.html'), 'no sign-in link');
      assert.ok(!out.includes('No Past Orders Found'), 'empty state shown for 401');
    });
  }

  /* 5b. 403 is a permission problem, NOT an expired session ---------------- */
  {
    const h = buildHarness({ apiMode: 'forbidden' });
    await h.boot();
    check('403 shows a permission error, never "session expired"', () => {
      const out = html(h);
      assert.ok(!/session has expired/i.test(out), 'a valid session was reported as expired on 403');
      assert.ok(/Can't access order history/.test(out), out.slice(0, 200));
      assert.ok(out.includes('history-retry-btn'), 'no Retry button for 403');
      assert.ok(!out.includes('No Past Orders Found'), 'empty state shown for 403');
    });
  }

  /* 5c. a server error is never reported as an expired session ------------ */
  {
    const h = buildHarness({ apiMode: 'serverError' });
    await h.boot();
    check('500 shows a retryable error, never "session expired"', () => {
      const out = html(h);
      assert.ok(!/session has expired/i.test(out), 'a server error was reported as an expired session');
      assert.ok(/Couldn't load your orders/.test(out), out.slice(0, 200));
      assert.ok(out.includes('history-retry-btn'), 'no Retry button for 500');
    });
  }

  /* 6. localStorage is not the source of truth when the API succeeds ------- */
  {
    const h = buildHarness({
      apiMode: 'ok',
      payload: { success: true, count: 1, orders: [order('ET-9001', 'completed', 'COMPLETED')] },
      localHistory: [order('ET-FAKE-LOCAL', 'pending', 'PENDING')],
    });
    await h.boot();
    check('does not render stale localStorage orders when the API succeeds', () => {
      const out = html(h);
      assert.ok(out.includes('ET-9001'), 'server order missing');
      assert.ok(!out.includes('ET-FAKE-LOCAL'), 'localStorage order leaked into a server-backed list');
    });
  }

  /* 7. local orders are a fallback when the API fails ---------------------- */
  {
    const h = buildHarness({
      apiMode: 'throw',
      localHistory: [order('ET-LOCAL-1', 'pending', 'PENDING')],
    });
    await h.boot();
    check('falls back to saved orders (with a warning) when the API fails', () => {
      const out = html(h);
      assert.ok(out.includes('ET-LOCAL-1'), 'saved order not shown on API failure');
      assert.ok(out.includes('history-warning'), 'no warning about stale data');
      assert.ok(out.includes('history-retry-btn'), 'no Retry button');
    });
  }

  await Promise.all(pending);
  console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
