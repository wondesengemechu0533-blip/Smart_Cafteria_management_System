/**
 * Cafeteria Admin Stock Alerts: "Take Responsibility" → "Mark Solved" workflow.
 *
 * WHY this test exists (root causes it locks down):
 *
 *  1. TAKE RESPONSIBILITY did not persist the assignment. The frontend never
 *     sent `assignedTo` and the backend only wrote it when the body carried a
 *     user id, so MongoDB kept `assignedTo: null` / `assignedAt: null` - only
 *     `acknowledgedBy` was saved. The alert is now assigned to the admin who
 *     clicked the button.
 *
 *  2. The UI transition (Take Responsibility → Mark Solved) depended entirely
 *     on a follow-up GET /kitchen/stock-alerts succeeding. If that refetch
 *     failed or was slow, the modal stayed stuck on the disabled
 *     "Submitting…" Take Responsibility button until a manual refresh. The
 *     modal now flips from the acknowledge response itself.
 *
 *  3. No in-flight guard: the modal can be re-rendered mid-request (socket
 *     `stock:alert:updated`, closing/reopening the alert), which handed the
 *     user a fresh, enabled button and fired a SECOND PATCH. One mutating
 *     request per alert is now enforced.
 *
 * Status vocabulary: StockAlert uses `active` (Pending) → `acknowledged`
 * (In Progress) → `resolved` (Resolved). Those existing enum values/endpoints
 * are deliberately preserved - nothing here invents a new status field.
 *
 * Part A drives the real backend (Express + MongoDB) over HTTP.
 * Part B drives the real Frontend/src/js/manager-stock-alerts.js against a
 * minimal DOM (same technique as tests/cancel-confirm-button.test.js).
 *
 * Run: node tests/stock-alert-admin-workflow.test.js
 */
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scs_stock_alert_admin_workflow';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'stock-alert-admin-workflow-secret';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');

const PORT = 5107;
const API = `http://127.0.0.1:${PORT}/api/v1`;
const FRONTEND_SCRIPT = path.join(__dirname, '..', '..', 'Frontend', 'src', 'js', 'manager-stock-alerts.js');
const ROLES_SCRIPT = path.join(__dirname, '..', '..', 'Frontend', 'src', 'js', 'roles.js');

let passed = 0;
const failures = [];
let chain = Promise.resolve();
function check(name, fn) {
  chain = chain.then(async () => {
    try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
    catch (e) { failures.push(name); console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); }
  });
  return chain;
}

const tick = (n = 8) => new Promise((resolve) => {
  let i = 0;
  const step = () => (++i >= n ? resolve() : setImmediate(step));
  step();
});

// ===========================================================================
// Part B harness: minimal DOM + stubbed AdminAPI around the real page script
// ===========================================================================
function loadStockAlertsPage({ listImpl, patchImpl, role = 'cafeteria_admin' }) {
  const registry = new Map();
  const toasts = [];
  const storageWrites = [];
  const state = { gets: 0, patches: [] };

  class El {
    constructor(id, tag) {
      this.id = id || '';
      this.tagName = (tag || 'div').toUpperCase();
      this.className = '';
      this.style = {};
      this.value = '';
      this.disabled = false;
      this.listeners = {};
      this.attrs = {};
      this.parent = null;
      this._html = '';
      this._ownedIds = [];
      this._ownedButtons = [];
      const classes = new Set();
      this.classList = {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        contains: (c) => classes.has(c),
      };
    }
    set innerHTML(html) {
      this._html = String(html);
      for (const id of this._ownedIds) registry.delete(id);
      this._ownedIds = [];
      this._ownedButtons = [];
      const tagRe = /<([a-zA-Z0-9]+)((?:[^>"]|"[^"]*")*)>/g;
      let m;
      while ((m = tagRe.exec(this._html))) {
        const tag = m[1];
        const attrs = m[2];
        const idm = /\bid="([^"]+)"/.exec(attrs);
        if (idm) {
          const el = new El(idm[1], tag);
          el.parent = this;
          registry.set(idm[1], el);
          this._ownedIds.push(idm[1]);
        }
        const bdm = /\bdata-alert-id="([^"]+)"/.exec(attrs);
        if (bdm && tag === 'button') {
          const el = new El('', 'button');
          el.attrs['data-alert-id'] = bdm[1];
          el.parent = this;
          this._ownedButtons.push(el);
        }
      }
    }
    get innerHTML() { return this._html; }
    set textContent(v) { this._html = String(v); }
    get textContent() { return this._html; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener() {}
    getAttribute(name) { return this.attrs[name] !== undefined ? this.attrs[name] : null; }
    setAttribute(name, v) { this.attrs[name] = String(v); }
    querySelector() { return null; }
    querySelectorAll(sel) { return sel === 'button[data-alert-id]' ? this._ownedButtons.slice() : []; }
    focus() {}
    dispatch(type, event) {
      const ev = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {} }, event);
      for (const fn of (this.listeners[type] || []).slice()) fn(ev);
      return ev;
    }
    // A real browser never fires `click` on a disabled control - mirror that.
    click() { if (this.disabled) return; return this.dispatch('click'); }
  }

  for (const id of ['stockTableBody', 'stockModalBackdrop', 'stockModal', 'stockModalContent',
    'refreshStockBtn', 'countAll', 'countActive', 'countAcknowledged', 'countResolved', 'stockTabs']) {
    registry.set(id, new El(id, id === 'refreshStockBtn' ? 'button' : 'div'));
  }

  const documentStub = {
    readyState: 'complete',
    getElementById: (id) => registry.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: (t) => new El('', t),
    head: new El('head', 'head'),
    body: new El('body', 'body'),
  };

  const localStorageStub = {
    _m: {
      auth_token: null, // keeps initRealtime() offline: no socket, no timers
      current_user: JSON.stringify({ id: 'admin1', role }),
    },
    getItem(k) { return this._m[k] !== undefined ? this._m[k] : null; },
    setItem(k, v) { storageWrites.push({ key: k, value: String(v) }); this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
  };

  const windowStub = {
    addEventListener() {},
    removeEventListener() {},
    confirm: () => true,
    AdminToast: {
      show: (m) => toasts.push({ type: 'info', message: m }),
      success: (m) => toasts.push({ type: 'success', message: m }),
      error: (m) => toasts.push({ type: 'error', message: m }),
      warning: (m) => toasts.push({ type: 'warning', message: m }),
      info: (m) => toasts.push({ type: 'info', message: m }),
    },
    AdminAPI: {
      esc: (v) => (v === null || v === undefined ? ''
        : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;')),
      formatDateTime: (v) => (v ? String(v) : '—'),
      formatDate: (v) => (v ? String(v) : '—'),
      get(p) {
        state.gets += 1;
        return Promise.resolve().then(() => listImpl(p, state.gets));
      },
      patch(p, body) {
        state.patches.push({ path: p, body });
        return Promise.resolve().then(() => patchImpl(p, body, state.patches.length));
      },
    },
  };

  // Real role helper (same file the page loads) so role gating is genuine.
  const rolesSrc = fs.readFileSync(ROLES_SCRIPT, 'utf8');
  new Function('window', 'localStorage', rolesSrc)(windowStub, localStorageStub);

  const src = fs.readFileSync(FRONTEND_SCRIPT, 'utf8');
  const factory = new Function(
    'window', 'document', 'localStorage', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'console',
    src
  );
  factory(windowStub, documentStub, localStorageStub, () => 0, () => {}, setTimeout, () => {}, console);

  return { registry, toasts, storageWrites, state, window: windowStub };
}

const FE_ALERT = {
  id: 'fe-alert-1',
  source: 'report',
  itemName: 'Yogurt',
  itemId: '507f1f77bcf86cd799439011',
  currentQuantity: 10,
  minimumQuantity: 5,
  alertType: 'quality_issue',
  severity: 'high',
  reason: 'Sour smell reported by customers',
  status: 'active',
  reportedBy: 'Kitchen Staff',
  createdAt: new Date().toISOString(),
};

const errWith = (status, message) => Object.assign(new Error(message), { status, rawMessage: message });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const { app } = require('../server.js');
  const httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(PORT, r));

  const jwt = require('jsonwebtoken');
  const User = require('../src/models/User');
  const MenuItem = require('../src/models/MenuItem');
  const StockAlert = require('../src/models/StockAlert');
  const StockTransaction = require('../src/models/StockTransaction');
  const { ensureDefaultCafeteria, getDefaultCafeteriaId } = require('../src/utils/cafeteria');

  await ensureDefaultCafeteria();
  const cafeteriaId = await getDefaultCafeteriaId();

  let phoneSeq = 0;
  const mkUser = (name, role, caf = null) =>
    User.create({
      name,
      email: `${name.toLowerCase().replace(/[^a-z]/g, '')}@stockwf.test`,
      phone: '0944' + String(++phoneSeq).padStart(6, '0'),
      password: 'password123',
      role,
      status: 'ACTIVE',
      cafeteriaId: caf,
    });

  const kitchen = await mkUser('WfKitchen', 'kitchen', cafeteriaId);
  const cafAdmin = await mkUser('WfCafAdmin', 'cafeteria_admin', cafeteriaId);
  const manager = await mkUser('WfManager', 'manager', cafeteriaId);
  const customer = await mkUser('WfCustomer', 'customer');

  const tok = (u) => jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const T = { kitchen: tok(kitchen), cafAdmin: tok(cafAdmin), manager: tok(manager), customer: tok(customer) };

  const call = async (method, p, token, body) => {
    const res = await fetch(`${API}${p}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const mkItem = (nameEn, stock, threshold) =>
    MenuItem.create({
      cafeteriaId,
      name: { en: nameEn, am: nameEn },
      category: 'Dairy',
      price: 30,
      stockQuantity: stock,
      lowStockThreshold: threshold,
      availabilityStatus: stock > 0 ? 'AVAILABLE' : 'OUT_OF_STOCK',
    });

  // =========================================================================
  console.log('\nA. Take Responsibility (PATCH /kitchen/stock-alerts/:id/acknowledge)');
  // =========================================================================

  const qualityItem = await mkItem('WfQualityYogurt', 10, 5);
  let alertId = null;

  await check('kitchen reports an issue → alert starts Pending (active)', async () => {
    const r = await call('POST', '/kitchen/stock-alerts', T.kitchen, {
      itemId: String(qualityItem._id),
      itemName: 'WfQualityYogurt',
      alertType: 'quality_issue',
      severity: 'high',
      reason: 'Sour smell reported by customers',
    });
    assert.strictEqual(r.status, 201, `status=${r.status} ${JSON.stringify(r.body)}`);
    alertId = r.body.alert && (r.body.alert.id || r.body.alert._id);
    assert.ok(alertId, 'alert id returned');
    assert.strictEqual(r.body.alert.status, 'active');
  });

  await check('admin Take Responsibility → 200 with IN_PROGRESS status in the payload', async () => {
    const r = await call('PATCH', `/kitchen/stock-alerts/${alertId}/acknowledge`, T.cafAdmin, { note: 'I am on it' });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.alert.status, 'acknowledged', 'the response itself must carry the new status');
    assert.strictEqual(r.body.alert.acknowledgedBy, 'WfCafAdmin', 'display-ready acknowledger name');
    assert.strictEqual(r.body.alert.assignedTo, 'WfCafAdmin', 'display-ready assignee name');
    assert.ok(r.body.alert.assignedAt, 'assignment timestamp in the payload');
  });

  await check('assignment is SAVED in MongoDB (assignedTo = logged-in admin, assignedAt set)', async () => {
    const doc = await StockAlert.findById(alertId);
    assert.strictEqual(doc.status, 'acknowledged', 'status = In Progress');
    assert.strictEqual(String(doc.acknowledgedBy), String(cafAdmin._id), 'acknowledgedBy stored');
    assert.strictEqual(String(doc.assignedTo), String(cafAdmin._id),
      `assignedTo must be the admin who took responsibility, got ${doc.assignedTo}`);
    assert.ok(doc.assignedAt instanceof Date, 'assignedAt must be stored');
    assert.strictEqual(doc.assignedNote, 'I am on it', 'assignment note stored');
  });

  await check('NOT resolved at this stage (no resolution fields, not even attempted)', async () => {
    const doc = await StockAlert.findById(alertId);
    assert.strictEqual(doc.status, 'acknowledged', 'still In Progress');
    assert.ok(!doc.resolvedBy && !doc.resolvedAt, 'no resolver/timestamp yet');
    assert.ok(!doc.resolutionNote && !doc.resolutionReason && !doc.resolutionSolution, 'no resolution details yet');
  });

  await check('status survives a page refresh: fresh GET list/detail report acknowledged + assignee', async () => {
    const list = await call('GET', '/kitchen/stock-alerts', T.cafAdmin);
    const row = (list.body.alerts || []).find((a) => String(a.id) === String(alertId));
    assert.ok(row, 'alert still listed after refresh');
    assert.strictEqual(row.status, 'acknowledged', 'refreshed status must still be In Progress');
    assert.strictEqual(row.assignedTo, 'WfCafAdmin', 'assignee serialized for the UI');

    const details = await call('GET', `/kitchen/stock-alerts/${alertId}`, T.cafAdmin);
    assert.strictEqual(details.status, 200);
    assert.strictEqual(details.body.alert.status, 'acknowledged');
    assert.strictEqual(details.body.alert.assignedTo, 'WfCafAdmin');
    assert.strictEqual(details.body.alert.acknowledgedBy, 'WfCafAdmin');
  });

  await check('duplicate Take Responsibility is idempotent (200, same assignment, still In Progress)', async () => {
    const r = await call('PATCH', `/kitchen/stock-alerts/${alertId}/acknowledge`, T.cafAdmin, { note: 'I am on it' });
    assert.strictEqual(r.status, 200, `status=${r.status}`);
    assert.strictEqual(r.body.alert.status, 'acknowledged');
    const doc = await StockAlert.findById(alertId);
    assert.strictEqual(doc.status, 'acknowledged');
    assert.strictEqual(String(doc.assignedTo), String(cafAdmin._id));
    assert.ok(!doc.resolvedBy, 'a replayed acknowledge must never resolve the alert');
  });

  // =========================================================================
  console.log('\nB. Mark Solved (PATCH /kitchen/stock-alerts/:id/resolve)');
  // =========================================================================

  await check('resolve without reason/solution → 400 success:false, alert untouched (no false success)', async () => {
    const r = await call('PATCH', `/kitchen/stock-alerts/${alertId}/resolve`, T.cafAdmin, { resolutionNote: 'x' });
    assert.strictEqual(r.status, 400, `status=${r.status}`);
    assert.strictEqual(r.body.success, false, 'error responses must carry success:false for the UI');
    assert.ok(r.body.error, 'an error message must be returned');
    const doc = await StockAlert.findById(alertId);
    assert.strictEqual(doc.status, 'acknowledged', 'a rejected resolve must not change the status');
    assert.ok(!doc.resolvedBy && !doc.resolvedAt, 'nothing resolved');
  });

  await check('resolve "Other" without explanation → 400 and still In Progress', async () => {
    const r = await call('PATCH', `/kitchen/stock-alerts/${alertId}/resolve`, T.cafAdmin, {
      resolutionReason: 'Other',
      resolutionSolution: 'Restocked Items',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.success, false);
    const doc = await StockAlert.findById(alertId);
    assert.strictEqual(doc.status, 'acknowledged');
  });

  await check('Mark Solved → 200 resolved:true and full resolution persisted in MongoDB', async () => {
    const r = await call('PATCH', `/kitchen/stock-alerts/${alertId}/resolve`, T.cafAdmin, {
      resolutionReason: 'Expired Items',
      resolutionSolution: 'Removed Expired Items',
      resolutionNote: 'Discarded the spoiled batch',
    });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.resolved, true, 'the backend must confirm the resolution');
    assert.strictEqual(r.body.alert.status, 'resolved', 'confirmed status in the payload');
    assert.strictEqual(r.body.alert.resolvedBy, 'WfCafAdmin', 'display-ready resolver name');

    const doc = await StockAlert.findById(alertId);
    assert.strictEqual(doc.status, 'resolved', 'status = Resolved in MongoDB');
    assert.strictEqual(String(doc.resolvedBy), String(cafAdmin._id), 'resolving admin stored');
    assert.ok(doc.resolvedAt, 'resolution timestamp stored');
    assert.strictEqual(doc.resolutionReason, 'Expired Items');
    assert.strictEqual(doc.resolutionSolution, 'Removed Expired Items');
    assert.strictEqual(doc.resolutionNote, 'Discarded the spoiled batch');
    assert.strictEqual(String(doc.assignedTo), String(cafAdmin._id), 'assignment kept alongside resolution');
  });

  await check('Mark Solved again → 400 already closed, original resolution untouched', async () => {
    const r = await call('PATCH', `/kitchen/stock-alerts/${alertId}/resolve`, T.cafAdmin, {
      resolutionReason: 'Expired Items',
      resolutionSolution: 'Removed Expired Items',
    });
    assert.strictEqual(r.status, 400, `status=${r.status}`);
    assert.strictEqual(r.body.success, false);
    const doc = await StockAlert.findById(alertId);
    assert.strictEqual(doc.status, 'resolved');
    assert.strictEqual(doc.resolutionNote, 'Discarded the spoiled batch');
  });

  await check('resolved status survives a refresh (list + detail + MongoDB agree)', async () => {
    const list = await call('GET', '/kitchen/stock-alerts', T.cafAdmin);
    const row = (list.body.alerts || []).find((a) => String(a.id) === String(alertId));
    assert.ok(row, 'resolved alert stays in history');
    assert.strictEqual(row.status, 'resolved');
    assert.strictEqual(row.resolvedBy, 'WfCafAdmin');
    const details = await call('GET', `/kitchen/stock-alerts/${alertId}`, T.cafAdmin);
    assert.strictEqual(details.body.alert.status, 'resolved');
    const doc = await StockAlert.findById(alertId);
    assert.strictEqual(doc.status, 'resolved');
  });

  // =========================================================================
  console.log('\nC. Real inventory resolution (threshold alerts keep the genuine guard)');
  // =========================================================================

  let systemAlertId = null;
  const lowItem = await mkItem('WfLowCoffee', 2, 5);

  await check('the list sync creates the open low-stock system alert', async () => {
    const r = await call('GET', '/kitchen/stock-alerts', T.cafAdmin);
    assert.strictEqual(r.status, 200);
    const row = (r.body.alerts || []).find((a) => a.itemId === String(lowItem._id) && a.source === 'inventory');
    assert.ok(row, 'system low-stock alert must be listed');
    systemAlertId = String(row.id);
    assert.ok(row.status === 'active' || row.status === 'acknowledged');
  });

  await check('take responsibility on the system alert → assignment persisted too', async () => {
    const r = await call('PATCH', `/kitchen/stock-alerts/${systemAlertId}/acknowledge`, T.cafAdmin, { note: '' });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    const doc = await StockAlert.findById(systemAlertId);
    assert.strictEqual(doc.status, 'acknowledged');
    assert.strictEqual(String(doc.assignedTo), String(cafAdmin._id), 'system alerts get assigned as well');
    assert.ok(doc.assignedAt);
  });

  await check('resolve while stock is still below minimum → 409 error, alert stays open', async () => {
    const r = await call('PATCH', `/kitchen/stock-alerts/${systemAlertId}/resolve`, T.cafAdmin, {
      resolutionReason: 'Restocked Items',
      resolutionSolution: 'Restocked Items',
    });
    assert.strictEqual(r.status, 409, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.success, false, 'the conflict must be an error for the UI');
    assert.ok(/below|threshold/i.test(r.body.error || ''), `explanatory error, got: ${r.body.error}`);
    const doc = await StockAlert.findById(systemAlertId);
    assert.ok(doc.status === 'acknowledged' || doc.status === 'active', `open status kept, got ${doc.status}`);
  });

  await check('resolve with the real counted quantity → resolved + stock updated + audited', async () => {
    const r = await call('PATCH', `/kitchen/stock-alerts/${systemAlertId}/resolve`, T.cafAdmin, {
      resolutionReason: 'Restocked Items',
      resolutionSolution: 'Updated Stock Quantity',
      resolutionNote: 'Received 18 units',
      newStockQuantity: 20,
    });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.resolved, true);

    const doc = await StockAlert.findById(systemAlertId);
    assert.strictEqual(doc.status, 'resolved');
    assert.strictEqual(String(doc.resolvedBy), String(cafAdmin._id));

    const item = await MenuItem.findById(lowItem._id);
    assert.strictEqual(item.stockQuantity, 20, 'the real quantity must be applied to the item');

    const tx = await StockTransaction.find({ foodId: lowItem._id, action: 'SET' });
    assert.ok(tx.length >= 1, 'the quantity change must be audited');
  });

  // =========================================================================
  console.log('\nD. Authorization regressions (existing behaviour kept)');
  // =========================================================================

  let permAlertId = null;
  await check('setup: a fresh alert for the permission checks', async () => {
    const r = await call('POST', '/kitchen/stock-alerts', T.kitchen, {
      itemName: 'WfLooseOnions',
      alertType: 'ingredient_shortage',
      severity: 'medium',
      reason: 'Two sacks missing',
    });
    assert.strictEqual(r.status, 201);
    permAlertId = r.body.alert && (r.body.alert.id || r.body.alert._id);
  });

  await check('manager may acknowledge (Take Responsibility is allowed) …', async () => {
    const r = await call('PATCH', `/kitchen/stock-alerts/${permAlertId}/acknowledge`, T.manager, { note: 'looking' });
    assert.strictEqual(r.status, 200, `status=${r.status}`);
    const doc = await StockAlert.findById(permAlertId);
    assert.strictEqual(String(doc.assignedTo), String(manager._id), 'assignment follows the actor');
    assert.strictEqual(doc.status, 'acknowledged');
  });

  await check('… but manager Mark Solved is still 403 (admin-only, unchanged)', async () => {
    const r = await call('PATCH', `/kitchen/stock-alerts/${permAlertId}/resolve`, T.manager, {
      resolutionReason: 'Restocked Items',
      resolutionSolution: 'Restocked Items',
    });
    assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
    const doc = await StockAlert.findById(permAlertId);
    assert.strictEqual(doc.status, 'acknowledged', 'rejected attempt leaves it open');
    assert.ok(!doc.resolvedBy, 'no resolution recorded');
  });

  await check('kitchen acknowledge still works; kitchen resolve still 403', async () => {
    const kAck = await call('PATCH', `/kitchen/stock-alerts/${permAlertId}/acknowledge`, T.kitchen, {});
    assert.strictEqual(kAck.status, 200, `ack=${kAck.status}`);
    const kRes = await call('PATCH', `/kitchen/stock-alerts/${permAlertId}/resolve`, T.kitchen, {
      resolutionReason: 'Restocked Items',
      resolutionSolution: 'Restocked Items',
    });
    assert.strictEqual(kRes.status, 403, `resolve=${kRes.status}`);
  });

  await check('cafeteria admin can finish it: Mark Solved succeeds after the 403s', async () => {
    const r = await call('PATCH', `/kitchen/stock-alerts/${permAlertId}/resolve`, T.cafAdmin, {
      resolutionReason: 'Supplier Delay',
      resolutionSolution: 'Ordered New Supplies',
      resolutionNote: 'Reordered',
    });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.resolved, true);
  });

  await check('customers remain forbidden from the stock-alert endpoints', async () => {
    assert.strictEqual((await call('GET', '/kitchen/stock-alerts', T.customer)).status, 403);
    assert.strictEqual((await call('PATCH', `/kitchen/stock-alerts/${alertId}/acknowledge`, T.customer, {})).status, 403);
    assert.strictEqual((await call('PATCH', `/kitchen/stock-alerts/${alertId}/resolve`, T.customer, {
      resolutionReason: 'Other',
      resolutionSolution: 'Other',
    })).status, 403);
  });

  await check('unrelated endpoints still healthy (list shape, single-alert details, dashboard)', async () => {
    const list = await call('GET', '/kitchen/stock-alerts', T.cafAdmin);
    assert.strictEqual(list.status, 200);
    assert.ok(Array.isArray(list.body.alerts), 'list still returns alerts[]');
    const dash = await call('GET', '/kitchen/dashboard', T.kitchen);
    assert.strictEqual(dash.status, 200, `dashboard status=${dash.status}`);
    const bad = await call('GET', '/kitchen/stock-alerts/not-an-objectid', T.kitchen);
    assert.strictEqual(bad.status, 400, 'bad ids still 400');
  });

  // =========================================================================
  console.log('\nE. Frontend: the buttons actually drive the workflow');
  // =========================================================================

  await check('Take Responsibility → one PATCH, modal flips to Mark Solved even when the list refetch FAILS', async () => {
    let failRefresh = false;
    const page = loadStockAlertsPage({
      listImpl: () => {
        if (failRefresh) throw errWith(500, 'network down');
        return { success: true, alerts: [{ ...FE_ALERT }] };
      },
      patchImpl: (p) => {
        if (p.includes('/acknowledge')) {
          failRefresh = true; // the follow-up GET /stock-alerts will reject
          return {
            success: true,
            message: 'Alert acknowledged',
            alert: { id: FE_ALERT.id, status: 'acknowledged', acknowledgedBy: 'WfCafAdmin', assignedTo: 'WfCafAdmin' },
          };
        }
        throw new Error('unexpected PATCH ' + p);
      },
    });
    await tick();

    const tbody = page.registry.get('stockTableBody');
    assert.strictEqual(tbody._ownedButtons.length, 1, 'the row renders a View button');
    tbody._ownedButtons[0].click();
    await tick();
    assert.ok(page.registry.get('ackBtn'), 'modal opens on Take Responsibility');
    assert.ok(!page.registry.get('resolveBtn'), 'no Mark Solved yet');

    page.registry.get('ackBtn').click();
    await tick(12);

    assert.strictEqual(page.state.patches.length, 1, `exactly one acknowledge request, got ${page.state.patches.length}`);
    assert.ok(page.state.patches[0].path.includes('/acknowledge'));
    assert.ok(!page.registry.get('ackBtn'), 'Take Responsibility hidden immediately');
    assert.ok(page.registry.get('resolveBtn'), 'Mark Solved visible immediately - no page refresh, no working refetch');
    const html = page.registry.get('stockModalContent').innerHTML;
    assert.ok(/stock-status-acknowledged/.test(html), 'status badge shows In Progress');
    assert.ok(!/stock-status-resolved/.test(html), 'must NOT be Resolved at this stage');
    assert.ok(page.toasts.some((t) => t.type === 'success'), 'acknowledge success reported');
  });

  await check('Mark Solved → one PATCH with reason+solution, modal shows Resolved, both buttons gone', async () => {
    const page = loadStockAlertsPage({
      listImpl: () => ({ success: true, alerts: [{ ...FE_ALERT, status: 'acknowledged', acknowledgedBy: 'WfCafAdmin', assignedTo: 'WfCafAdmin' }] }),
      patchImpl: (p) => {
        if (p.includes('/resolve')) {
          return {
            success: true,
            resolved: true,
            message: 'Alert marked as resolved',
            alert: { id: FE_ALERT.id, status: 'resolved', resolvedBy: 'WfCafAdmin', resolvedAt: new Date().toISOString(), resolutionReason: 'Expired Items' },
          };
        }
        throw new Error('unexpected PATCH ' + p);
      },
    });
    await tick();

    page.registry.get('stockTableBody')._ownedButtons[0].click();
    await tick();
    assert.ok(page.registry.get('resolveBtn'), 'precondition: Mark Solved shown for an In Progress alert');
    assert.ok(!page.registry.get('ackBtn'), 'precondition: Take Responsibility already hidden');

    page.registry.get('resolutionReasonSelect').value = 'Expired Items';
    page.registry.get('resolutionSolutionSelect').value = 'Removed Expired Items';
    page.registry.get('resolveBtn').click();
    await tick(12);

    assert.strictEqual(page.state.patches.length, 1, `exactly one resolve request, got ${page.state.patches.length}`);
    const body = page.state.patches[0].body;
    assert.strictEqual(body.resolutionReason, 'Expired Items', 'the reason reaches the API');
    assert.strictEqual(body.resolutionSolution, 'Removed Expired Items', 'the solution reaches the API');

    const html = page.registry.get('stockModalContent').innerHTML;
    assert.ok(/stock-status-resolved/.test(html), 'final Resolved status shown');
    assert.ok(!page.registry.get('ackBtn'), 'Take Responsibility stays hidden');
    assert.ok(!page.registry.get('resolveBtn'), 'Mark Solved hidden after success');
    assert.ok(page.toasts.some((t) => t.type === 'success' && /resolved/i.test(t.message)), 'success toast shown');
  });

  await check('Mark Solved failure → error toast only, stays In Progress, button retryable', async () => {
    const page = loadStockAlertsPage({
      listImpl: () => ({ success: true, alerts: [{ ...FE_ALERT, status: 'acknowledged' }] }),
      patchImpl: (p) => {
        if (p.includes('/resolve')) throw errWith(409, 'Stock for Yogurt is still below the minimum threshold (5)');
        return { success: true };
      },
    });
    await tick();

    page.registry.get('stockTableBody')._ownedButtons[0].click();
    await tick();
    page.registry.get('resolutionReasonSelect').value = 'Restocked Items';
    page.registry.get('resolutionSolutionSelect').value = 'Restocked Items';
    const btn = page.registry.get('resolveBtn');
    btn.click();
    await tick(12);

    assert.strictEqual(page.state.patches.length, 1, 'the attempt reached the API');
    assert.ok(page.toasts.some((t) => t.type === 'error'), 'an error toast must be shown');
    assert.ok(!page.toasts.some((t) => t.type === 'success'), 'NO false success toast on failure');

    const html = page.registry.get('stockModalContent').innerHTML;
    assert.ok(/stock-status-acknowledged/.test(html), 'still In Progress after the failure');
    assert.ok(!/stock-status-resolved/.test(html), 'never shows Resolved when the API failed');

    const retry = page.registry.get('resolveBtn');
    assert.ok(retry, 'Mark Solved still available for a retry');
    assert.strictEqual(retry.disabled, false, 'button re-enabled, not stuck in Sending…');
  });

  await check('duplicate submits: double-click + mid-flight re-render fire ONE request each', async () => {
    const page = loadStockAlertsPage({
      listImpl: () => ({ success: true, alerts: [{ ...FE_ALERT }] }),
      patchImpl: (p) => new Promise((resolve) => setTimeout(() => {
        if (p.includes('/acknowledge')) {
          resolve({ success: true, message: 'ok', alert: { id: FE_ALERT.id, status: 'acknowledged' } });
        } else resolve({ success: true, resolved: true, message: 'ok', alert: { id: FE_ALERT.id, status: 'resolved' } });
      }, 30)),
    });
    await tick();

    const tbody = page.registry.get('stockTableBody');
    tbody._ownedButtons[0].click();
    await tick();

    const btn = page.registry.get('ackBtn');
    btn.click(); btn.click(); btn.click();          // triple click the same button
    await tick(3);
    tbody._ownedButtons[0].click();                 // re-render (socket/update race)
    await tick(3);
    const fresh = page.registry.get('ackBtn');
    if (fresh && fresh !== btn) fresh.click();      // new button while still in flight
    await new Promise((r) => setTimeout(r, 90));

    const acks = page.state.patches.filter((x) => x.path.includes('/acknowledge'));
    const resolves = page.state.patches.filter((x) => x.path.includes('/resolve'));
    assert.strictEqual(acks.length, 1, `exactly 1 acknowledge request, got ${acks.length}`);
    assert.strictEqual(resolves.length, 0, 'acknowledge must not resolve');
  });

  await check('after a page reload the persisted status drives the UI (Mark Solved shown, no Take Responsibility)', async () => {
    const page = loadStockAlertsPage({
      // Server truth after refresh: acknowledged + assigned.
      listImpl: () => ({
        success: true,
        alerts: [{ ...FE_ALERT, status: 'acknowledged', acknowledgedBy: 'WfCafAdmin', assignedTo: 'WfCafAdmin' }],
      }),
      patchImpl: () => { throw new Error('no mutation expected on reload'); },
    });
    await tick();

    page.registry.get('stockTableBody')._ownedButtons[0].click();
    await tick();
    assert.ok(page.registry.get('resolveBtn'), 'Mark Solved offered for the persisted In Progress alert');
    assert.ok(!page.registry.get('ackBtn'), 'Take Responsibility not offered again');
    assert.strictEqual(page.state.patches.length, 0, 'rendering alone must not POST/PATCH anything');
    assert.strictEqual(page.storageWrites.length, 0, 'localStorage is never written: the API is the source of truth');
    const html = page.registry.get('stockModalContent').innerHTML;
    assert.ok(/WfCafAdmin/, 'assignee name rendered from server data') && assert.ok(html.includes('WfCafAdmin'), 'assignment visible in the modal');
  });

  await check('resolved alert after reload → no action buttons at all', async () => {
    const page = loadStockAlertsPage({
      listImpl: () => ({ success: true, alerts: [{ ...FE_ALERT, status: 'resolved', resolvedBy: 'WfCafAdmin', resolvedAt: new Date().toISOString() }] }),
      patchImpl: () => { throw new Error('no mutation expected'); },
    });
    await tick();
    page.registry.get('stockTableBody')._ownedButtons[0].click();
    await tick();
    assert.ok(!page.registry.get('ackBtn'), 'no Take Responsibility on a resolved alert');
    assert.ok(!page.registry.get('resolveBtn'), 'no Mark Solved on a resolved alert');
    assert.ok(page.registry.get('stockModalContent').innerHTML.includes('stock-status-resolved'), 'Resolved badge shown');
  });

  await check('manager role sees no Mark Solved button (the backend would 403 it)', async () => {
    const page = loadStockAlertsPage({
      role: 'manager',
      listImpl: () => ({ success: true, alerts: [{ ...FE_ALERT, status: 'acknowledged', assignedTo: 'WfManager' }] }),
      patchImpl: () => { throw new Error('no mutation expected'); },
    });
    await tick();
    page.registry.get('stockTableBody')._ownedButtons[0].click();
    await tick();
    assert.ok(!page.registry.get('resolveBtn'), 'manager must not be offered Mark Solved');
    assert.ok(page.registry.get('stockModalContent').innerHTML.includes('Cafeteria Admin'),
      'the modal explains who may resolve');
  });

  await check('validation blocks an empty resolution (no request fired, no status change)', async () => {
    const page = loadStockAlertsPage({
      listImpl: () => ({ success: true, alerts: [{ ...FE_ALERT, status: 'acknowledged' }] }),
      patchImpl: () => { throw new Error('no request should fire'); },
    });
    await tick();
    page.registry.get('stockTableBody')._ownedButtons[0].click();
    await tick();
    page.registry.get('resolveBtn').click();   // reason/solution left empty
    await tick(6);
    assert.strictEqual(page.state.patches.length, 0, 'nothing submitted without reason+solution');
    assert.ok(page.registry.get('resolutionReasonError').innerHTML.length > 0, 'inline validation error shown');
    assert.ok(!page.toasts.some((t) => t.type === 'success'), 'no success toast for an invalid submit');
  });

  await chain;

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log('Failed: ' + failures.join(', '));

  clearInterval(0);
  httpServer.close();
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
