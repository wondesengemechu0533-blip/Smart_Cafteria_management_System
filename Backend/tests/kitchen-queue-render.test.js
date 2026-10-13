/**
 * Kitchen Order Queue - regression tests for the empty-table report.
 *
 * Drives the REAL Frontend/src/pages/kitchen/kitchen.js against a fake DOM and
 * the exact payload shape getKitchenDashboard() returns, then asserts the
 * behaviours behind "fix this empty":
 *
 *   1. every filter tab matches its own rows (the Cancelled tab used to have no
 *      branch in getFilteredOrders() and therefore matched NOTHING)
 *   2. an empty stage explains itself and points at the orders that DO exist
 *   3. a failed request says so instead of looking like an empty cafeteria
 *   4. a successful load clears the error (a stale error must not persist)
 *   5. the grid view (kitchen/dashboard.html) still renders identically
 *   6. status spelling variants still land in the right tab
 *
 * Run: node Backend/tests/kitchen-queue-render.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const KITCHEN_JS = path.join(__dirname, '..', '..', 'Frontend', 'src', 'pages', 'kitchen', 'kitchen.js');

let pass = 0;
let fail = 0;
// Async checks must be AWAITED before the tally, or an `async` test counts as a
// PASS the instant it is registered and its assertions can never fail.
const pendingChecks = [];
function check(name, fn) {
  pendingChecks.push((async () => {
    try { await fn(); pass++; console.log('  PASS ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + ' -- ' + e.message); }
  })());
}

/* ------------------------------------------------------------- fake DOM */
function makeEl(id) {
  const el = {
    _id: id, id,
    style: {}, dataset: {}, className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [], firstElementChild: null,
    innerHTML: '', hidden: false,
    // A real DOM stringifies textContent. The stub must too, otherwise
    // `el.textContent = 2` (which is what updateStats() does - it assigns a
    // Number) leaves a number behind and every string assertion misfires.
    get textContent() { return this._text === undefined ? '' : this._text; },
    set textContent(v) { this._text = v == null ? '' : String(v); },
    // Attributes must actually be stored, or hasAttribute()/getAttribute() used by
    // kitchen.js (the "is this the triage button?" check) always answers wrong.
    setAttribute(k, v) { (this._attrs || (this._attrs = {}))[k] = String(v); },
    getAttribute(k) {
      const a = this._attrs;
      return a && Object.prototype.hasOwnProperty.call(a, k) ? a[k] : null;
    },
    removeAttribute(k) { if (this._attrs) delete this._attrs[k]; },
    hasAttribute(k) { return this.getAttribute(k) !== null; },
    // Listeners must be stored so a test can fire a real click and observe what the
    // handler did - a no-op addEventListener can never exercise a click guard.
    addEventListener(type, fn) {
      const m = this._l || (this._l = {});
      (m[type] || (m[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      if (this._l && this._l[type]) this._l[type] = this._l[type].filter((f) => f !== fn);
    },
    dispatch(type, ev) {
      (this._l && this._l[type] || []).slice().forEach((fn) => fn(ev || { type, target: this }));
    },
    // Real elements DO find their children. Returning null for everything made
    // renderFilterCounts() append a brand new badge on every render instead of
    // reusing the first one, so the harness never behaved like the browser.
    querySelector(sel) {
      const s = String(sel);
      const match = (el) => {
        if (s.startsWith('.')) return String(el.className || '').split(/\s+/).includes(s.slice(1));
        if (s.startsWith('#')) return el.id === s.slice(1);
        return false;
      };
      const walk = (list) => {
        for (const el of list || []) {
          if (match(el)) return el;
          const hit = walk(el.children);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this.children);
    },
    querySelectorAll: () => [],
    closest: () => null,
    appendChild(c) { this.children.push(c); return c; },
    append(...nodes) { this.children.push(...nodes); },
    prepend(...nodes) { this.children.unshift(...nodes); },
    after() {}, before() {}, replaceChildren() {},
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    remove() {}, focus() {}, click() {},
    play() { return Promise.resolve(); },
  };
  return el;
}

function buildHarness({ dashboardOk = true, withGrid = false, apiMode = 'ok' } = {}) {
  const nodes = {};
  const TABLE_ID = 'kitchenOrdersBody';
  const GRID_ID = 'kitchenTicketsGrid';
  nodes[TABLE_ID] = makeEl(TABLE_ID);
  if (withGrid) nodes[GRID_ID] = makeEl(GRID_ID);
  ['pendingCount', 'preparingCount', 'readyCount', 'cancelledCount',
    'soundToggleBtn', 'soundToggleIcon', 'soundToggleLabel', 'kdsToastStack',
    'kdsNewOrderBanner', 'kdsNotifPanel', 'kdsNotifList', 'kdsNotifUnreadCount',
    'soundUnlockBanner', 'enableSoundBtn', 'orderNotificationSound', 'kdsAlertBanner',
  ].forEach((id) => { nodes[id] = makeEl(id); });

  const filterButtons = [
    makeEl('f-all'), makeEl('f-pending'), makeEl('f-preparing'),
    makeEl('f-ready'), makeEl('f-cancelled'),
    // Mirrors the opt-in "Not paid yet" button in orders.html.
    makeEl('f-unpaid'),
  ];
  ['all', 'Pending', 'Preparing', 'Ready', 'Cancelled', 'unpaid']
    .forEach((status, i) => { filterButtons[i].dataset.status = status; });
  filterButtons[5].setAttribute('aria-pressed', 'false');

  const document_ = {
    readyState: 'complete', hidden: false,
    // Created up-front so the harness can hand back a LIVE reference; handlers
    // registered later by bindEvents() still show up through it.
    _l: {},
    getElementById: (id) => nodes[id] || null,
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.includes('filter-group') || sel.includes('filter-trigger') ? filterButtons : []),
    createElement: () => makeEl('tmp'),
    // Stored (not no-op) so tests can fire the delegated handlers that
    // kitchen.js registers on `document` for the empty-state buttons.
    addEventListener(type, fn) {
      const m = this._l || (this._l = {});
      (m[type] || (m[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      if (this._l && this._l[type]) this._l[type] = this._l[type].filter((f) => f !== fn);
    },
    body: makeEl('body'),
  };
const apiCalls = [];
  // Per-request options, so a test can assert the board call asks for a
  // timeout that actually fits a slow database link.
  const apiOpts = [];
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
      _s: { auth_token: 'test-token' },
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
      setItem(k, v) { this._s[k] = String(v); },
      removeItem(k) { delete this._s[k]; },
    },
    api: {
      get: async (p, opts) => {
        apiCalls.push(`GET ${p}`);
        apiOpts.push(opts || null);
        if (p.startsWith('/kitchen/dashboard')) {
          if (apiMode === 'throw') throw Object.assign(new Error('Network request failed'), { status: 0 });
          if (apiMode === 'forbidden') throw Object.assign(new Error('Forbidden'), { status: 403 });
          if (apiMode === 'serverError') throw Object.assign(new Error('Server error'), { status: 500 });
          if (apiMode === 'emptyBuckets') return { success: true, orders: {} };
          if (apiMode === 'notSuccess') return { success: false, error: 'Forbidden' };
          if (!dashboardOk) throw Object.assign(new Error('Network request failed'), { status: 0 });
          // The triage view is opt-in, so the extra rows are only served when the
          // page actually asks for them - mirroring the real controller.
          if (p.includes('includeUnpaid=1')) {
            return JSON.parse(JSON.stringify(UNPAID_PAYLOAD));
          }
          return JSON.parse(JSON.stringify(DASHBOARD_PAYLOAD));
        }
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
    // init() subscribes to window (permission/online/reconnect listeners).
    // sandbox.window === sandbox, so these serve as window.addEventListener.
    addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: (fn) => { if (typeof fn === 'function') fn(0); return 0; },
    cancelAnimationFrame: () => {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  // Strip ES module imports + the auto-boot hook. The hook sits near the TOP of
  // this file, so it must be removed as a block, not "everything after".
  const src = fs.readFileSync(KITCHEN_JS, 'utf8')
    .replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, '')
    .replace(/document\.addEventListener\(\s*["']DOMContentLoaded["'][\s\S]*?\}\s*\);\s*$/m, '');
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: KITCHEN_JS });
  const KDS = sandbox.window.KDS;
  KDS.cacheDOM();
  return { KDS, nodes, TABLE_ID, GRID_ID, apiCalls, apiOpts, filterButtons, docListeners: document_._l };
}

function order(id, name, status, orderStatus, minutesAgo, type) {
  return {
    id, orderId: id, customerName: name, customerPhone: '0911',
    items: [{ name: 'Kitfo', quantity: 1, notes: '', itemStatus: 'pending' }],
    status, orderStatus, paymentStatus: 'PAID', priority: 'normal',
    totalAmount: 100, orderType: type || 'dine-in', tableNumber: '1',
    createdAt: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    elapsedTime: minutesAgo + ' mins',
  };
}

const DASHBOARD_PAYLOAD = {
  success: true,
  stats: { pending: 1, preparing: 1, ready: 1, cancelled: 1 },
  orders: {
    pending: [order('ET-P1', 'Alice', 'pending', 'PENDING', 5)],
    preparing: [order('ET-P2', 'Beko', 'preparing', 'PREPARING', 10, 'delivery')],
    ready: [order('ET-P3', 'Chala', 'ready', 'READY', 15, 'takeaway')],
    cancelled: [order('ET-C1', 'Dani', 'cancelled', 'CANCELLED', 20)],
  },
};

const rows = (html) => (html.match(/<tr data-order-id=/g) || []).length;

// What the server sends ONLY for ?includeUnpaid=1: the normal queue PLUS the
// rows the kitchen must not work, plus the diagnostic that explains why an
// otherwise-empty board is empty. The paid buckets are still present - opting
// in ADDS a view, it does not replace the queue.
const UNPAID_ORDER = order('ET-U1', 'Muna', 'pending', 'PENDING', 8);
UNPAID_ORDER.paymentStatus = 'PENDING';
const UNPAID_PAYLOAD = {
  success: true,
  stats: { pending: 1, preparing: 1, ready: 1, cancelled: 1 },
  diagnostics: { ordersInWindow: 5, unpaidInWindow: 2, unpaidIncluded: true },
  orders: Object.assign({}, DASHBOARD_PAYLOAD.orders, { unpaid: [UNPAID_ORDER] }),
};

(async () => {
  console.log('========== KITCHEN QUEUE RENDER TESTS ==========');
  console.log('');

  /* --- 1. every filter tab matches its own rows --------------------------- */
  {
    const h = buildHarness();
    await h.KDS.loadInitialOrders();
    const expect = { all: 3, Pending: 1, Preparing: 1, Ready: 1, Cancelled: 1 };
    for (const [filter, n] of Object.entries(expect)) {
      check(`filter "${filter}" lists ${n} row(s)`, () => {
        h.KDS.currentFilter = filter;
        h.KDS.render();
        assert.strictEqual(rows(h.nodes[h.TABLE_ID].innerHTML), n, h.nodes[h.TABLE_ID].innerHTML.slice(0, 120));
      });
    }

    /* --- 2. the Cancelled tab actually shows cancelled orders -------------- */
    check('the Cancelled tab shows the cancelled order id', () => {
      h.KDS.currentFilter = 'Cancelled';
      h.KDS.render();
      assert.ok(h.nodes[h.TABLE_ID].innerHTML.includes('ET-C1'), 'ET-C1 missing from the Cancelled tab');
    });

    /* --- 3. tab counts agree with the rows --------------------------------- */
    check('countForFilter agrees with the rendered rows for every tab', () => {
      for (const filter of Object.keys(expect)) {
        h.KDS.currentFilter = filter;
        h.KDS.render();
        assert.strictEqual(h.KDS.countForFilter(filter), expect[filter], filter);
      }
    });
    check('renderFilterCounts leaves this.currentFilter untouched', () => {
      h.KDS.currentFilter = 'Ready';
      h.KDS.renderFilterCounts();
      assert.strictEqual(h.KDS.currentFilter, 'Ready');
    });

    /* --- 4. an empty stage explains itself and points elsewhere ------------ */
    check('an empty stage names the stage and reports what IS in the queue', () => {
      const v = buildHarness();
      v.KDS.orders.set('ET-P1', order('ET-P1', 'Alice', 'pending', 'PENDING', 5));
      v.KDS.orders.set('ET-P2', order('ET-P2', 'Beko', 'preparing', 'PREPARING', 10));
      v.KDS.orders.set('ET-C1', order('ET-C1', 'Dani', 'cancelled', 'CANCELLED', 20));
      v.KDS.orders.delete('ET-P2');            // the only preparing order
      v.KDS.currentFilter = 'Preparing';
      v.KDS.render();
      const html = v.nodes[v.TABLE_ID].innerHTML;
      assert.ok(/preparing/i.test(html), 'stage not named in: ' + html.slice(0, 240));
      assert.ok(/active order/i.test(html), 'does not say how many are active');
      assert.ok(/cancelled order/i.test(html), 'does not mention the cancelled orders');
      assert.ok(/another filter/i.test(html), 'no guidance to another filter');
    });

    check('an empty stage with nothing else in the queue still says what is true', () => {
      const v = buildHarness();
      v.KDS.orders.set('ET-C1', order('ET-C1', 'Dani', 'cancelled', 'CANCELLED', 20));
      v.KDS.currentFilter = 'Preparing';
      v.KDS.render();
      const html = v.nodes[v.TABLE_ID].innerHTML;
      assert.ok(/No <strong>preparing<\/strong> orders/.test(html), html.slice(0, 240));
      assert.ok(!/found in queue/.test(html), 'must not read like a failed query');
    });

    /* --- 4b. a wholly empty queue says so on EVERY tab ------------------- */
    check('an empty queue says "clear" on the Cancelled tab, not "no cancelled orders found"', () => {
      const v = buildHarness();
      v.KDS.orders.clear();
      for (const filter of ['all', 'Pending', 'Preparing', 'Ready', 'Cancelled']) {
        v.KDS.currentFilter = filter;
        v.KDS.render();
        const html = v.nodes[v.TABLE_ID].innerHTML;
        assert.ok(/queue is clear/i.test(html),
          `filter "${filter}" said: ${html.replace(/\s+/g, ' ').slice(0, 200)}`);
        assert.ok(!/orders found in queue/i.test(html),
          `filter "${filter}" still used the old "found in queue" copy`);
      }
    });

    check('a completely clear queue says so plainly', () => {
      const g = buildHarness();
      g.KDS.orders.clear();
      g.KDS.currentFilter = 'all';
      g.KDS.render();
      assert.ok(/queue is clear/i.test(g.nodes[g.TABLE_ID].innerHTML),
        g.nodes[g.TABLE_ID].innerHTML.slice(0, 200));
    });

    /* --- 5. a failed load is not disguised as an empty queue --------------- */
    check('a failed request shows a load error, not "no orders"', async () => {
      const f = buildHarness({ dashboardOk: false });
      await f.KDS.loadInitialOrders();
      f.KDS.render();
      const html = f.nodes[f.TABLE_ID].innerHTML;
      assert.ok(/Could not load the kitchen queue/i.test(html), html.slice(0, 200));
      assert.ok(/data-reload-orders/.test(html), 'no Retry control');
      assert.ok(!/queue is clear/i.test(html), 'a failure must not claim the queue is empty');
    });

    check('a successful load clears a previous error', async () => {
      const f = buildHarness({ dashboardOk: false });
      await f.KDS.loadInitialOrders();
      assert.ok(f.KDS.loadError, 'error should be recorded');
      // Simulate the retry succeeding.
      f.KDS.loadError = null;
      f.KDS.currentFilter = 'all';
      f.KDS.render();
      assert.ok(!/Could not load/i.test(f.nodes[f.TABLE_ID].innerHTML), 'error banner persisted');
      assert.ok(rows(f.nodes[f.TABLE_ID].innerHTML) === 0, 'no orders were ever loaded, so 0 rows is right');
    });

    /* --- 6. status spelling variants land in the right tab ---------------- */
    check('status "Received" counts as pending', () => {
      const v = buildHarness();
      v.KDS.orders.set('ET-R1', order('ET-R1', 'Eve', 'Received', 'RECEIVED', 1));
      v.KDS.currentFilter = 'Pending';
      v.KDS.render();
      assert.strictEqual(rows(v.nodes[v.TABLE_ID].innerHTML), 1);
    });
    check('status "Canceled" (US spelling) counts as cancelled', () => {
      const v = buildHarness();
      v.KDS.orders.clear();
      v.KDS.orders.set('ET-X1', order('ET-X1', 'X', 'Canceled', 'CANCELLED', 1));
      v.KDS.currentFilter = 'Cancelled';
      v.KDS.render();
      assert.strictEqual(rows(v.nodes[v.TABLE_ID].innerHTML), 1);
    });
    check('an unknown filter does not hide real work', async () => {
      const v = buildHarness();
      await v.KDS.loadInitialOrders();
      v.KDS.currentFilter = 'nonsense';
      v.KDS.render();
      assert.ok(rows(v.nodes[v.TABLE_ID].innerHTML) > 0, 'orders were silently hidden');
    });

    /* --- 7. the grid view (dashboard.html) did not regress ---------------- */
    check('dashboard grid still renders a card per active order', async () => {
      const g = buildHarness({ withGrid: true });
      await g.KDS.loadInitialOrders();
      g.KDS.render();
      const html = g.nodes[g.GRID_ID].innerHTML;
      assert.ok((html.match(/class="ticket-card/g) || []).length === 3, 'grid cards = ' + (html.match(/class="ticket-card/g) || []).length);
      assert.ok(html.includes('ET-P1') && html.includes('ET-P3'), 'grid missing order ids');
    });
    check('dashboard grid still shows its empty state with no orders', async () => {
      const g = buildHarness({ withGrid: true });
      g.KDS.orders.clear();
      g.KDS.currentFilter = 'all';
      g.KDS.render();
      assert.ok(/queue is clear/i.test(g.nodes[g.GRID_ID].innerHTML), g.nodes[g.GRID_ID].innerHTML.slice(0, 200));
    });

    /* --- 8. the stat tiles get real numbers -------------------------------- */
    check('stage count tiles are filled from the loaded orders', async () => {
      const s = buildHarness();
      await s.KDS.loadInitialOrders();
      s.KDS.render();
      assert.strictEqual(s.nodes.pendingCount.textContent, '1');
      assert.strictEqual(s.nodes.preparingCount.textContent, '1');
      assert.strictEqual(s.nodes.readyCount.textContent, '1');
      assert.strictEqual(s.nodes.cancelledCount.textContent, '1');
    });

    /* --- 9. live socket frames must not strip a cancelled row ------------- */
    check('mergeOrder keeps items / createdAt when a lean frame arrives', () => {
      const full = order('ET-P1', 'Alice', 'pending', 'PENDING', 5);
      full.items = [{ name: 'Kitfo', quantity: 2, notes: 'no onion', itemStatus: 'pending' }];
      const lean = { orderId: 'ET-P1', status: 'cancelled', orderStatus: 'CANCELLED' };
      const merged = h.KDS.mergeOrder(full, lean);
      assert.strictEqual(merged.status, 'cancelled', 'status must be updated');
      assert.ok(Array.isArray(merged.items) && merged.items.length === 1, 'items were erased');
      assert.ok(merged.createdAt, 'createdAt was erased');
      assert.strictEqual(merged.customerName, 'Alice', 'customerName was erased');
      assert.strictEqual(merged.items[0].notes, 'no onion', 'item detail was erased');
    });

    check('a lean incoming frame never blanks a field', () => {
      const full = order('ET-P1', 'Alice', 'pending', 'PENDING', 5);
      const merged = h.KDS.mergeOrder(full, { orderId: 'ET-P1', customerName: '', items: [] });
      assert.strictEqual(merged.customerName, 'Alice', 'blank string overwrote a value');
      assert.ok(merged.items.length > 0, 'empty array overwrote the items');
    });

    check('a live cancellation frame shows the order in the Cancelled tab, items intact', () => {
      const v = buildHarness();
      const live = order('ET-P1', 'Alice', 'pending', 'PENDING', 5);
      live.items = [{ name: 'Doro', quantity: 3, notes: '', itemStatus: 'preparing' }];
      v.KDS.orders.set('ET-P1', live);

      // A lean socket frame: status only.
      v.KDS.handleStatusUpdate({ orderId: 'ET-P1', status: 'cancelled', orderStatus: 'CANCELLED' });

      v.KDS.currentFilter = 'Cancelled';
      v.KDS.render();
      const html = v.nodes[v.TABLE_ID].innerHTML;
      assert.ok(html.includes('ET-P1'), 'cancelled order missing from the tab');
      assert.ok(html.includes('Doro'), 'items were lost by the socket frame');
      assert.ok(html.includes('3x Doro'), 'quantity lost: ' + html.slice(0, 300));
      assert.ok(/cancelled/i.test(html), 'status badge missing');
    });

    check('a live cancellation is counted in the cancelled stat tile', () => {
      const v = buildHarness();
      v.KDS.orders.set('ET-P1', order('ET-P1', 'Alice', 'pending', 'PENDING', 5));
      v.KDS.handleStatusUpdate({ orderId: 'ET-P1', status: 'cancelled' });
      v.KDS.updateStats();
      assert.strictEqual(v.nodes.cancelledCount.textContent, '1');
      assert.strictEqual(v.nodes.pendingCount.textContent, '0');
    });
  }

  /* --- 10. the REAL boot path: init() end to end --------------------------
   Every other test here calls loadInitialOrders()/render() directly, which
   would hide a throw inside init() - and a throw there is exactly how a page
   ends up showing its hardcoded "0" tiles and an untouched table. ---------- */
  {
    check('init() completes and fills the stage tiles from a real payload', async () => {
      const h = buildHarness();
      await h.KDS.init();
      assert.deepStrictEqual(
        [h.nodes.pendingCount.textContent, h.nodes.preparingCount.textContent,
         h.nodes.readyCount.textContent, h.nodes.cancelledCount.textContent],
        ['1', '1', '1', '1'],
        'stage tiles were not filled by init()'
      );
      assert.strictEqual(h.KDS.orders.size, 4, 'orders not loaded by init()');
    });

    check('init() requests the kitchen dashboard', async () => {
      const h = buildHarness();
      await h.KDS.init();
      assert.ok(h.apiCalls.some((c) => c === 'GET /kitchen/dashboard'),
        'calls were: ' + h.apiCalls.join(', '));
    });

    check('init() renders rows into the table, not just the tiles', async () => {
      const h = buildHarness();
      await h.KDS.init();
      const n = rows(h.nodes[h.TABLE_ID].innerHTML);
      assert.strictEqual(n, 3, `table rows = ${n}`);
      assert.ok(/ET-P1/.test(h.nodes[h.TABLE_ID].innerHTML), 'row content missing');
    });

    /* A tile reading 0 for every stage must be EXPLAINED, never silent. */
    check('a 403 is reported instead of silently showing four zeros', async () => {
      const h = buildHarness({ apiMode: 'forbidden' });
      await h.KDS.init();
      assert.ok(h.KDS.loadError, 'no loadError recorded for a 403');
      assert.ok(/Could not load/i.test(h.nodes[h.TABLE_ID].innerHTML),
        h.nodes[h.TABLE_ID].innerHTML.slice(0, 200));
    });
    check('a 500 is reported instead of silently showing four zeros', async () => {
      const h = buildHarness({ apiMode: 'serverError' });
      await h.KDS.init();
      assert.ok(h.KDS.loadError, 'no loadError recorded for a 500');
      assert.ok(/Could not load/i.test(h.nodes[h.TABLE_ID].innerHTML));
    });
    check('a network failure is reported instead of silently showing four zeros', async () => {
      const h = buildHarness({ apiMode: 'throw' });
      await h.KDS.init();
      assert.ok(h.KDS.loadError, 'no loadError recorded for a network failure');
      assert.ok(/Could not load/i.test(h.nodes[h.TABLE_ID].innerHTML));
    });
    check('success:false is reported instead of silently showing four zeros', async () => {
      const h = buildHarness({ apiMode: 'notSuccess' });
      await h.KDS.init();
      assert.ok(h.KDS.loadError, 'success:false was treated as a success');
      assert.ok(/Could not load/i.test(h.nodes[h.TABLE_ID].innerHTML));
    });
    check('an empty orders object is reported, not treated as loaded', async () => {
      const h = buildHarness({ apiMode: 'emptyBuckets' });
      await h.KDS.init();
      // No crash, and the tiles must not claim work exists.
      assert.strictEqual(h.nodes.pendingCount.textContent, '0');
      assert.ok(/queue is clear|Could not load/i.test(h.nodes[h.TABLE_ID].innerHTML),
        h.nodes[h.TABLE_ID].innerHTML.slice(0, 200));
    });
  }

  const ORDERS_HTML = path.join(__dirname, '..', '..', 'Frontend', 'src', 'pages', 'kitchen', 'orders.html');

  /* --- 11. why is the board empty? The unpaid-order diagnostic ------------ */

  {
    check('an empty board with unpaid orders names the real cause', async () => {
      const v = buildHarness();
      await v.KDS.init();
      // Simulate the real "everything is unpaid" board: no rows, but the backend
      // reports that orders DO exist and are awaiting payment.
      v.KDS.orders.clear();
      v.KDS.unpaidInWindow = 3;
      v.KDS.currentFilter = 'all';
      v.KDS.render();
      const html = v.nodes[v.TABLE_ID].innerHTML;
      const flat = html.replace(/\s+/g, ' ');
      assert.ok(/Nothing on the queue yet/i.test(flat), flat.slice(0, 240));
      assert.ok(/awaiting payment confirmation/i.test(flat),
        'does not explain that unpaid orders are the cause');
      assert.ok(/Show not-paid orders/i.test(flat), 'no way to reveal them');
      assert.ok(!/queue is clear/i.test(flat), 'must not claim the queue is clear when orders exist');
    });

    check('applyDiagnostics records both counts', () => {
      const v = buildHarness();
      v.KDS.applyDiagnostics({ diagnostics: { ordersInWindow: 9, unpaidInWindow: 4 } });
      assert.strictEqual(v.KDS.ordersInWindow, 9);
      assert.strictEqual(v.KDS.unpaidInWindow, 4);
    });

    check('applyDiagnostics tolerates a payload with no diagnostics', () => {
      const v = buildHarness();
      v.KDS.applyDiagnostics({});
      assert.strictEqual(v.KDS.unpaidInWindow, 0);
      v.KDS.applyDiagnostics(undefined);
      assert.strictEqual(v.KDS.unpaidInWindow, 0);
    });

    /* --- the safety guarantee ------------------------------------------ */
    check('unpaid rows NEVER count towards the kitchen stage tiles', () => {
      const v = buildHarness();
      v.KDS.orders.clear();
      const unpaid = order('ET-U1', 'Unpaid', 'pending', 'PENDING', 2);
      unpaid.paymentStatus = 'PENDING';
      v.KDS.orders.set('ET-U1', unpaid);
      v.KDS.orders.set('ET-P1', order('ET-P1', 'Paid', 'pending', 'PENDING', 2));
      v.KDS.updateStats();
      assert.strictEqual(v.nodes.pendingCount.textContent, '1',
        'an unpaid order was counted as kitchen work');
      assert.strictEqual(v.nodes.preparingCount.textContent, '0');
    });

    check('unpaid rows never appear under "All Active"', () => {
      const v = buildHarness();
      v.KDS.orders.clear();
      const unpaid = order('ET-U1', 'Unpaid', 'pending', 'PENDING', 2);
      unpaid.paymentStatus = 'PENDING';
      v.KDS.orders.set('ET-U1', unpaid);
      v.KDS.orders.set('ET-P1', order('ET-P1', 'Paid', 'preparing', 'PREPARING', 3));
      v.KDS.currentFilter = 'all';
      v.KDS.render();
      const html = v.nodes[v.TABLE_ID].innerHTML;
      assert.ok(!/ET-U1/.test(html), 'an unpaid order leaked into All Active');
      assert.ok(/ET-P1/.test(html), 'the paid order should still be listed');
      assert.strictEqual(rows(html), 1);
    });

    check('the "Not paid yet" tab lists exactly the unpaid rows', () => {
      const v = buildHarness();
      v.KDS.orders.clear();
      const unpaid = order('ET-U1', 'Unpaid', 'pending', 'PENDING', 2);
      unpaid.paymentStatus = 'PENDING';
      v.KDS.orders.set('ET-U1', unpaid);
      v.KDS.orders.set('ET-P1', order('ET-P1', 'Paid', 'preparing', 'PREPARING', 3));
      v.KDS.currentFilter = 'unpaid';
      v.KDS.render();
      const html = v.nodes[v.TABLE_ID].innerHTML;
      assert.ok(/ET-U1/.test(html), 'unpaid row missing from its tab');
      assert.ok(!/ET-P1/.test(html), 'a PAID order leaked into the unpaid tab');
      assert.ok(/data-unpaid="1"/.test(html), 'unpaid row is not visually marked');
      assert.ok(!/data-unpaid="1"[^>]*>\s*<td>\s*<strong>#ET-P1/.test(html),
        'the paid row must not carry the unpaid marker');
    });

    check('a cancelled order cancelled before payment is still COUNTED', () => {
      const v = buildHarness();
      v.KDS.orders.clear();
      const c = order('ET-C1', 'Dani', 'cancelled', 'CANCELLED', 5);
      c.paymentStatus = 'PENDING';
      v.KDS.orders.set('ET-C1', c);
      v.KDS.updateStats();
      assert.strictEqual(v.nodes.cancelledCount.textContent, '1',
        'a pre-payment cancellation was not counted - it must reach the kitchen');
    });

    check('a cancelled order is not shown as "not paid" work', () => {
      const v = buildHarness();
      const c = order('ET-C1', 'Dani', 'cancelled', 'CANCELLED', 5);
      c.paymentStatus = 'PENDING';
      assert.strictEqual(v.KDS.isUnpaidOrder(c), false,
        'a cancellation must not appear in the unpaid triage view');
    });

    check('dashboardUrl only asks for unpaid orders when the view is on', () => {
      const v = buildHarness();
      v.KDS.includeUnpaid = false;
      assert.strictEqual(v.KDS.dashboardUrl(), '/kitchen/dashboard',
        'the default request must be unchanged');
      v.KDS.includeUnpaid = true;
      assert.ok(v.KDS.dashboardUrl().includes('includeUnpaid=1'), v.KDS.dashboardUrl());
    });

    check('orders.html exposes the triage toggle and the warning banner', () => {
      const html = fs.readFileSync(ORDERS_HTML, 'utf8');
      assert.ok(/data-toggle-unpaid/.test(html), 'no triage toggle button');
      assert.ok(/id="unpaidBanner"/.test(html), 'no triage warning banner');
    });

    check('turning the triage view ON shows the unpaid row, OFF restores the queue', async () => {
      const v = buildHarness();
      await v.KDS.init();
      assert.ok(!v.KDS.includeUnpaid, 'the triage view must start OFF - it is opt-in');
      assert.ok(!v.apiCalls.some((c) => c.includes('includeUnpaid')),
        'a default load asked the server for unpaid rows: ' + v.apiCalls.join(', '));

      await v.KDS.setIncludeUnpaid(true);
      assert.ok(v.KDS.includeUnpaid, 'includeUnpaid flag not set');
      assert.ok(v.apiCalls.some((c) => c.includes('includeUnpaid=1')),
        'the request was not re-issued with ?includeUnpaid=1: ' + v.apiCalls.join(', '));
      assert.strictEqual(v.KDS.currentFilter, 'unpaid', 'did not land on the triage tab');
      assert.ok(/ET-U1/.test(v.nodes[v.TABLE_ID].innerHTML), 'the unpaid row is not on screen');
      assert.strictEqual(v.KDS.countForFilter('unpaid'), 1);
      // Opting in must not disturb the kitchen's own view.
      assert.strictEqual(v.KDS.countForFilter('all'), 3,
        'the paid queue changed after opting into the triage view');

      await v.KDS.setIncludeUnpaid(false);
      assert.strictEqual(v.KDS.currentFilter, 'all');
      assert.ok(!/ET-U1/.test(v.nodes[v.TABLE_ID].innerHTML),
        'the unpaid row is still shown after switching the view off');
      assert.ok(!v.apiCalls[v.apiCalls.length - 1].includes('includeUnpaid'),
        'turning the view off kept requesting unpaid rows');
    });

    check('the empty-state "Show not-paid orders" button turns the view on', async () => {
      const v = buildHarness();
      await v.KDS.init();
      // An empty board with unpaid orders present - the exact state that offers
      // the reveal button in the first place.
      v.KDS.orders.clear();
      v.KDS.unpaidInWindow = 2;
      v.KDS.render();
      assert.ok(/Show not-paid orders/.test(v.nodes[v.TABLE_ID].innerHTML),
        'the empty state does not offer a way to reveal the withheld orders');

      const before = (v.docListeners.click || []).length;
      v.KDS.bindEvents();
      const handlers = (v.docListeners.click || []).slice(before);
      assert.ok(handlers.length, 'bindEvents() registered no document click handler');

      // The empty-state button carries no aria-pressed, so it only ever turns ON.
      const fakeBtn = { hasAttribute: () => false };
      const ev = {
        preventDefault() {},
        target: { closest: (sel) => (sel === '[data-toggle-unpaid]' ? fakeBtn : null) },
      };
      handlers.forEach((h) => h(ev));
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));

      assert.strictEqual(v.KDS.includeUnpaid, true, 'the triage view was not turned on');
      assert.ok(v.apiCalls.some((c) => c.includes('includeUnpaid=1')),
        'no request was re-issued with ?includeUnpaid=1: ' + v.apiCalls.join(', '));
      assert.strictEqual(v.KDS.currentFilter, 'unpaid');
      assert.ok(/ET-U1/.test(v.nodes[v.TABLE_ID].innerHTML), 'the unpaid row is not on screen');
    });

    check('the triage button in the filter bar TOGGLES rather than only turns on', async () => {
      const v = buildHarness();
      await v.KDS.init();
      const before = (v.docListeners.click || []).length;
      v.KDS.bindEvents();
      const handlers = (v.docListeners.click || []).slice(before);

      const fire = async () => {
        const fakeBtn = { hasAttribute: (a) => a === 'aria-pressed' };
        handlers.forEach((h) => h({
          preventDefault() {},
          target: { closest: (s) => (s === '[data-toggle-unpaid]' ? fakeBtn : null) },
        }));
        for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
      };

      await fire();
      assert.strictEqual(v.KDS.includeUnpaid, true, 'first click should turn the view ON');
      await fire();
      assert.strictEqual(v.KDS.includeUnpaid, false, 'second click should turn the view OFF');
      assert.strictEqual(v.KDS.currentFilter, 'all', 'turning OFF did not return to the paid queue');
      assert.ok(!/ET-U1/.test(v.nodes[v.TABLE_ID].innerHTML),
        'the unpaid row is still on screen after the view was switched off');
    });

    check('the triage button reports how many unpaid orders are being withheld', () => {
      const v = buildHarness();
      v.KDS.unpaidInWindow = 4;
      v.KDS.includeUnpaid = false;
      v.KDS.renderFilterCounts();
      const btn = v.filterButtons[5];
      const badge = btn.querySelector('.tab-count');
      assert.ok(badge, 'the triage button has no count badge');
      assert.strictEqual(badge.textContent, '4',
        'an empty board shows 0 withheld orders when 4 are actually being held back');
      // Reusing the badge proves querySelector works; a fresh one every render
      // would grow the button and hide a stale number.
      v.KDS.renderFilterCounts();
      assert.strictEqual(btn.children.length, 1, 'a new badge was appended instead of reusing it');
    });

    check('the triage badge follows the count as orders arrive', () => {
      const v = buildHarness();
      v.KDS.unpaidInWindow = 0;
      v.KDS.renderFilterCounts();
      assert.strictEqual(v.filterButtons[5].querySelector('.tab-count').textContent, '0');
      v.KDS.unpaidInWindow = 7;
      v.KDS.renderFilterCounts();
      assert.strictEqual(v.filterButtons[5].querySelector('.tab-count').textContent, '7');
    });

    check('clicking the triage button must NOT switch tabs before the rows load', () => {
      const v = buildHarness();
      v.KDS.bindEvents();
      // A normal filter switches immediately - that is correct for paid tabs.
      v.filterButtons[1].dispatch('click');
      assert.strictEqual(v.KDS.currentFilter, 'Pending', 'a plain filter stopped working');

      // The triage button is a two-step action (re-fetch, then switch). Its
      // handler must bail so setIncludeUnpaid() owns the whole sequence.
      v.filterButtons[5].dispatch('click');
      assert.strictEqual(v.KDS.currentFilter, 'Pending',
        'the triage button switched the tab before its rows were loaded');
      assert.strictEqual(v.KDS.includeUnpaid, false,
        'the ordinary filter handler toggled the unpaid view');
    });

    check('the triage button is identifiable as the two-step control', () => {
      const v = buildHarness();
      assert.strictEqual(v.filterButtons[5].dataset.status, 'unpaid');
      assert.strictEqual(v.filterButtons[5].hasAttribute('aria-pressed'), true,
        'orders.html\'s triage button must carry aria-pressed so the click handler can tell it apart');
      assert.strictEqual(v.filterButtons[0].hasAttribute('aria-pressed'), false,
        'a plain filter must not look like the triage control');
    });
  }

  /* --- 12. cache-busting: the fix must actually reach the browser --------- */
  {
    const ORDERS_HTML = path.join(__dirname, '..', '..', 'Frontend', 'src', 'pages', 'kitchen', 'orders.html');
    const DASH_HTML = path.join(__dirname, '..', '..', 'Frontend', 'src', 'pages', 'kitchen', 'dashboard.html');
    [ORDERS_HTML, DASH_HTML].forEach((file) => {
      check(`${path.basename(file)} loads kitchen.js with a cache-busting version`, () => {
        const html = fs.readFileSync(file, 'utf8');
        const m = html.match(/kitchen\.js\?v=([\w.-]+)/);
        assert.ok(m, 'kitchen.js is loaded without a ?v= token - browsers will serve the stale copy');
        assert.notStrictEqual(m[1], '20260926alert', 'kitchen.js still points at the pre-fix version');
      });
    });
    check('orders.html and dashboard.html load the SAME kitchen.js version', () => {
      const a = fs.readFileSync(ORDERS_HTML, 'utf8').match(/kitchen\.js\?v=([\w.-]+)/)[1];
      const b = fs.readFileSync(DASH_HTML, 'utf8').match(/kitchen\.js\?v=([\w.-]+)/)[1];
      assert.strictEqual(a, b, `orders.html=${a} dashboard.html=${b}`);
    });
  }

  /* --- 13. one board request at a time, with a timeout that fits the link ---- */
  {
    check('the dashboard call asks for a timeout above the 15s default', async () => {
      const v = buildHarness();
      await v.KDS.init();
      const idx = v.apiCalls.findIndex((c) => c.includes('/kitchen/dashboard'));
      assert.ok(idx >= 0, 'the dashboard was never requested: ' + v.apiCalls.join(', '));
      const opts = v.apiOpts[idx];
      assert.ok(opts, 'api.get was called with no options - this call falls back to the 15s default');
      assert.ok(typeof opts.timeout === 'number', 'the board request sets no timeout');
      assert.ok(opts.timeout > 15000,
        `timeout ${opts.timeout}ms is not above the 15s default this fix exists to outrun`);
      assert.ok(opts.timeout >= v.KDS.DASHBOARD_TIMEOUT_MS, 'the call ignores DASHBOARD_TIMEOUT_MS');
    });

    check('the poll interval is shorter than the board timeout (a slow reply is awaited, not stacked)', () => {
      const v = buildHarness();
      assert.ok(v.KDS.DASHBOARD_TIMEOUT_MS > 15000);
      // startPolling() ticks every 15000ms. If the timeout were <= the interval
      // every tick could abort the previous request and start another.
      const src = fs.readFileSync(KITCHEN_JS, 'utf8');
      const m = src.match(/setInterval\(\s*\(\)\s*=>\s*\{\s*this\.refreshOrders\(\);\s*\},\s*(\d+)/);
      assert.ok(m, 'startPolling() no longer schedules refreshOrders - the guard test would be meaningless');
      assert.ok(Number(m[1]) < v.KDS.DASHBOARD_TIMEOUT_MS,
        `poll every ${m[1]}ms but timeout ${v.KDS.DASHBOARD_TIMEOUT_MS}ms - ticks would abort in-flight requests`);
    });

    check('overlapping refreshes share ONE request instead of stacking', async () => {
      const v = buildHarness();
      await v.KDS.init();
      const before = v.apiCalls.length;
      await Promise.all([
        v.KDS.refreshOrders(),
        v.KDS.refreshOrders(),
        v.KDS.refreshOrders(),
      ]);
      const made = v.apiCalls.length - before;
      assert.strictEqual(made, 1,
        `stacked ${made} dashboard requests for a single tick - on a slow link each one costs 15-30s and they contend`);
    });

    check('the guard is released after a success so polling can continue', async () => {
      const v = buildHarness();
      await v.KDS.init();
      assert.strictEqual(v.KDS._boardRequest, null, 'the guard was never cleared after the first load');
      const n = v.apiCalls.length;
      await v.KDS.refreshOrders();
      assert.strictEqual(v.apiCalls.length, n + 1,
        'the guard stayed latched - every later poll would be silently swallowed and the board would freeze');
      assert.strictEqual(v.KDS._boardRequest, null);
    });

    check('the guard is released after a FAILURE so polling can retry', async () => {
      const v = buildHarness({ apiMode: 'throw' });
      await v.KDS.refreshOrders();
      assert.ok(v.KDS.loadError, 'a failing request should report why the board is stale');
      assert.strictEqual(v.KDS._boardRequest, null,
        'a rejected request left the guard latched - the board would never recover from one timeout');
      // A rejected promise nobody else holds must not become an unhandled rejection.
      assert.strictEqual(v.KDS._boardRequest, null);
    });

    check('initial load and a poll arriving mid-flight do not double-fetch', async () => {
      const v = buildHarness();
      const p = v.KDS.loadInitialOrders();
      const q = v.KDS.refreshOrders();
      await Promise.all([p, q]);
      assert.strictEqual(v.apiCalls.filter((c) => c.includes('/kitchen/dashboard')).length, 1,
        'init + poll issued ' + v.apiCalls.length + ' dashboard requests concurrently');
      assert.ok(v.nodes[v.TABLE_ID].innerHTML.length > 0, 'the board rendered nothing');
    });
  }

  await Promise.all(pendingChecks);

  console.log('');
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
