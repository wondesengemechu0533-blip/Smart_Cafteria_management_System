/**
 * Manager Inventory - regression tests for the missing Action button.
 *
 * Drives the REAL Frontend/src/js/manager-inventory.js against a fake DOM and
 * a stubbed AdminAPI, then asserts:
 *
 *   1. the Actions cell is rendered for EVERY stock status
 *      (IN STOCK, LOW STOCK, OUT OF STOCK) - no status branch drops it
 *   2. each row exposes working Edit + Restock / Update Quantity buttons
 *      carrying the correct MongoDB `_id` in data-id
 *   3. the delegated click handler opens the right modal for the right item
 *   4. LOW STOCK is derived correctly for quantity 3 / minimum 10
 *   5. the Edit form loads the item's REAL data from GET /admin/menu/:id
 *
 * Run: node Backend/tests/manager-inventory-actions.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INV_JS = path.join(__dirname, '..', '..', 'Frontend', 'src', 'js', 'manager-inventory.js');

let pass = 0;
let fail = 0;
const pending = [];
function check(name, fn) {
  pending.push(
    (async () => {
      try {
        await fn();
        pass++;
        console.log('  PASS ' + name);
      } catch (e) {
        fail++;
        console.log('  FAIL ' + name + ' -- ' + e.message);
      }
    })()
  );
}

/* ------------------------------------------------------------- fake DOM */
function makeEl(id) {
  const classes = new Set();
  return {
    id,
    _value: '',
    _html: '',
    style: {},
    dataset: {},
    children: [],
    _l: {},
    get value() { return this._value; },
    set value(v) { this._value = v == null ? '' : String(v); },
    get textContent() { return this._text === undefined ? '' : this._text; },
    set textContent(v) { this._text = v == null ? '' : String(v); },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v == null ? '' : String(v); },
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      toggle(c, on) { if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else if (on) classes.add(c); else classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
    setAttribute(k, v) { (this._attrs || (this._attrs = {}))[k] = String(v); },
    getAttribute(k) { const a = this._attrs; return a && Object.prototype.hasOwnProperty.call(a, k) ? a[k] : null; },
    removeAttribute(k) { if (this._attrs) delete this._attrs[k]; },
    hasAttribute(k) { return this.getAttribute(k) !== null; },
    addEventListener(type, fn) { (this._l[type] || (this._l[type] = [])).push(fn); },
    removeEventListener(type, fn) { if (this._l[type]) this._l[type] = this._l[type].filter((f) => f !== fn); },
    dispatch(type, ev) { (this._l[type] || []).slice().forEach((fn) => fn(ev || { type, target: this })); },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    focus() {},
    click() {},
  };
}

const FRESH_JUICE = {
  id: '65f000000000000000000001',
  name: { en: 'Fresh Juice', am: 'ጭማቂ' },
  category: 'beverages',
  price: 45,
  preparationTime: 5,
  stockQuantity: 3,
  lowStockThreshold: 10,
  stockStatus: 'LOW_STOCK',
};

const IN_ITEM = { id: 'id-in', name: { en: 'In Stock Item', am: 'x' }, category: 'snacks', price: 10, stockQuantity: 40, lowStockThreshold: 10, stockStatus: 'IN_STOCK' };
const LOW_ITEM = FRESH_JUICE;
const OUT_ITEM = { id: 'id-out', name: { en: 'Out Item', am: 'x' }, category: 'snacks', price: 10, stockQuantity: 0, lowStockThreshold: 10, stockStatus: 'OUT_OF_STOCK' };

function buildHarness() {
  const nodes = {};
  const getEl = (id) => nodes[id] || (nodes[id] = makeEl(id));

  const putCalls = [];
  const getCalls = [];
  let role = 'manager';

  const document_ = {
    readyState: 'complete',
    _l: {},
    getElementById: getEl,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeEl('tmp'),
    addEventListener(type, fn) { (this._l[type] || (this._l[type] = [])).push(fn); },
    removeEventListener(type, fn) { if (this._l[type]) this._l[type] = this._l[type].filter((f) => f !== fn); },
    dispatch(type, ev) { (this._l[type] || []).slice().forEach((fn) => fn(ev || { type })); },
    body: makeEl('body'),
  };

  const sandbox = {
    console,
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout: () => {},
    document: document_,
    navigator: { userAgent: 'node' },
    localStorage: {
      _s: { auth_token: 'test-token', userRole: role, role: role },
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
      setItem(k, v) { this._s[k] = String(v); },
      removeItem(k) { delete this._s[k]; },
    },
    AdminAPI: {
      esc: (v) => (v == null ? '' : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')),
      get: async (p) => {
        getCalls.push(p);
        if (p.indexOf('/kitchen/stock-alerts') === 0) return { alerts: [] };
        if (p.indexOf('/categories') === 0) return { categories: [{ id: 'beverages', name: { en: 'Beverages' } }, { id: 'snacks', name: { en: 'Snacks' } }] };
        if (p.indexOf('/admin/menu/') === 0) {
          const id = p.split('/').pop();
          const all = [FRESH_JUICE, IN_ITEM, OUT_ITEM];
          const item = all.find((i) => String(i.id) === String(id)) || FRESH_JUICE;
          return { item: JSON.parse(JSON.stringify(item)) };
        }
        if (p.indexOf('/admin/menu') === 0) return { items: [JSON.parse(JSON.stringify(FRESH_JUICE)), JSON.parse(JSON.stringify(IN_ITEM)), JSON.parse(JSON.stringify(OUT_ITEM))] };
        return {};
      },
      put: async (p, body) => {
        putCalls.push({ path: p, body });
        return { item: Object.assign({}, FRESH_JUICE, { stockQuantity: body.stockQuantity, lowStockThreshold: body.lowStockThreshold }) };
      },
    },
    // no window.socket → socket block skipped
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return { sandbox, nodes, getEl, putCalls, getCalls, document_ };
}

async function boot() {
  const h = buildHarness();
  vm.createContext(h.sandbox);
  vm.runInContext(fs.readFileSync(INV_JS, 'utf8'), h.sandbox, { filename: 'manager-inventory.js' });
  // Fire DOMContentLoaded → bindEvents + loadCategories + refreshAll
  h.document_.dispatch('DOMContentLoaded', { type: 'DOMContentLoaded' });
  // Let the async AdminAPI.get promises resolve
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return h;
}

(async function run() {
  const h = await boot();
  const tbody = h.getEl('inventoryTableBody');
  const html = tbody.innerHTML;

  check('LOW STOCK row (qty 3 / min 10) shows the LOW STOCK badge', () => {
    assert.ok(html.indexOf('LOW STOCK') !== -1, 'LOW STOCK label missing');
  });

  check('Actions column header is always present in the page contract', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'Frontend', 'src', 'pages', 'manager', 'inventory.html'), 'utf8');
    assert.ok(/<th[^>]*>\s*Actions\s*<\/th>/i.test(page), 'no Actions <th> in inventory.html');
  });

  check('manager role is allowed to open the inventory page (auth guard)', () => {
    const rolesJs = fs.readFileSync(path.join(__dirname, '..', '..', 'Frontend', 'src', 'js', 'roles.js'), 'utf8');
    const sandbox = { window: {}, global: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
    sandbox.window = sandbox;
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(rolesJs, sandbox, { filename: 'roles.js' });
    const ScosRoles = sandbox.ScosRoles || (sandbox.window && sandbox.window.ScosRoles);
    assert.ok(ScosRoles && typeof ScosRoles.visiblePages === 'function', 'ScosRoles not exposed');
    assert.ok(ScosRoles.visiblePages('manager').indexOf('inventory') !== -1, "PAGE_ACCESS.manager must include 'inventory'");
  });

  check('EVERY row renders an Edit button (all statuses)', () => {
    const edits = html.match(/data-action="edit"/g) || [];
    assert.strictEqual(edits.length, 3, 'expected 3 Edit buttons, got ' + edits.length);
  });

  check('EVERY row renders a Restock / Update Quantity button (all statuses)', () => {
    const restocks = html.match(/data-action="restock"/g) || [];
    assert.strictEqual(restocks.length, 3, 'expected 3 Restock buttons, got ' + restocks.length);
  });

  check('LOW STOCK row buttons carry the item MongoDB _id', () => {
    const re = new RegExp('data-action="restock" data-id="' + FRESH_JUICE.id + '"');
    assert.ok(re.test(html), 'restock button for Fresh Juice _id not found');
    const reEdit = new RegExp('data-action="edit" data-id="' + FRESH_JUICE.id + '"');
    assert.ok(reEdit.test(html), 'edit button for Fresh Juice _id not found');
  });

  check('stats classify 1 IN / 1 LOW / 1 OUT', () => {
    assert.strictEqual(h.getEl('statInStock').textContent, '1');
    assert.strictEqual(h.getEl('statLowStock').textContent, '1');
    assert.strictEqual(h.getEl('statOutOfStock').textContent, '1');
  });

  const tbodyNode = h.getEl('inventoryTableBody');

  check('delegated click on LOW STOCK "Restock" opens the update modal for that item', () => {
    const btn = { getAttribute: (k) => ({ 'data-action': 'restock', 'data-id': FRESH_JUICE.id }[k] || null) };
    tbodyNode.dispatch('click', { target: { closest: (sel) => (sel === 'button[data-action]' ? btn : null) } });
    assert.strictEqual(h.getEl('updateItemId').value, FRESH_JUICE.id, 'wrong id in update modal');
    assert.ok(h.getEl('invModalBackdrop').classList.contains('active'), 'update modal did not open');
  });

  check('delegated click on "Edit" loads the item REAL data into the edit form', async () => {
    const btn = { getAttribute: (k) => ({ 'data-action': 'edit', 'data-id': FRESH_JUICE.id }[k] || null) };
    tbodyNode.dispatch('click', { target: { closest: (sel) => (sel === 'button[data-action]' ? btn : null) } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.ok(h.getCalls.some((p) => p.indexOf('/admin/menu/' + FRESH_JUICE.id) === 0), 'did not GET the item by _id');
    assert.strictEqual(h.getEl('editItemId').value, FRESH_JUICE.id);
    assert.strictEqual(h.getEl('editNameEn').value, 'Fresh Juice');
    assert.strictEqual(h.getEl('editStockQty').value, '3');
    assert.strictEqual(h.getEl('editMinStock').value, '10');
    assert.ok(h.getEl('editModalBackdrop').classList.contains('active'), 'edit modal did not open');
  });

  await Promise.all(pending);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
