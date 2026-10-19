/**
 * Kitchen staff: view RESOLVED stock alert details — acceptance test.
 *
 * Covers:
 *   1. Cafeteria Admin resolves a stock alert (resolution persisted in MongoDB).
 *   2. The resolved alert stays visible in the kitchen staff alert history
 *      (list endpoint does NOT exclude resolved alerts).
 *   3. Kitchen staff can open the details endpoint by MongoDB id and receive
 *      resolution notes, resolver name and the resolution timestamp.
 *   4. Details remain available after a "refresh" (re-fetch); the record stays
 *      resolved and viewing never mutates it (never reopens).
 *   5. Active alerts still list/display correctly and their details show the
 *      "not resolved yet" state with no resolution fields.
 *   6. Kitchen staff cannot resolve alerts or change inventory (403s).
 *   7. Unrelated kitchen features (dashboard, alert list shape) keep working;
 *      customers are still forbidden; bad ids get 400/404 — no crash.
 *
 * Run: node tests/kitchen-resolved-alert-details.test.js
 */
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scs_kitchen_alert_details_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'kitchen-alert-details-test-secret';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');

const PORT = 5102;
const API = `http://127.0.0.1:${PORT}/api/v1`;

let passed = 0;
const failures = [];
let chain = Promise.resolve();
function check(name, fn) {
  chain = chain.then(async () => {
    try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
    catch (e) { failures.push(name); console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); }
  });
}

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
  const { ensureDefaultCafeteria, getDefaultCafeteriaId } = require('../src/utils/cafeteria');

  await ensureDefaultCafeteria();
  const cafeteriaId = await getDefaultCafeteriaId();

  let phoneSeq = 0;
  const mkUser = (name, role, caf = null) =>
    User.create({
      name,
      email: `${name.toLowerCase().replace(/[^a-z]/g, '')}@kitchendetails.test`,
      phone: '0922' + String(++phoneSeq).padStart(6, '0'),
      password: 'password123',
      role,
      status: 'ACTIVE',
      cafeteriaId: caf,
    });

  const kitchen = await mkUser('KitchenStaff', 'kitchen', cafeteriaId);
  const cafAdmin = await mkUser('CafDetailsAdmin', 'cafeteria_admin', cafeteriaId);
  const manager = await mkUser('DetailsManager', 'manager', cafeteriaId);
  const customer = await mkUser('DetailsCustomer', 'customer');

  const tok = (u) => jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const T = { kitchen: tok(kitchen), cafAdmin: tok(cafAdmin), manager: tok(manager), customer: tok(customer) };

  const mkItem = (nameEn, stock, threshold) =>
    MenuItem.create({
      cafeteriaId,
      name: { en: nameEn, am: nameEn },
      category: 'Beverages',
      price: 30,
      stockQuantity: stock,
      lowStockThreshold: threshold,
      availabilityStatus: stock > 0 ? 'AVAILABLE' : 'OUT_OF_STOCK',
    });

  const call = async (method, path, token, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const itemQuality = await mkItem('YogurtDetails', 10, 5);
  const itemActive = await mkItem('CoffeeDetails', 2, 5);

  // ============================================================
  console.log('\n1. Admin resolves a stock alert (kitchen reported)');
  // ============================================================

  let qualityAlertId = null;
  await check('kitchen reports a quality issue → alert created', async () => {
    const r = await call('POST', '/kitchen/stock-alerts', T.kitchen, {
      itemId: String(itemQuality._id),
      itemName: 'YogurtDetails',
      alertType: 'quality_issue',
      severity: 'high',
      reason: 'Sour smell reported by customers',
    });
    assert.strictEqual(r.status, 201, `status=${r.status} ${JSON.stringify(r.body)}`);
    qualityAlertId = r.body.alert && (r.body.alert.id || r.body.alert._id);
    assert.ok(qualityAlertId, 'the created alert id must be returned');
  });

  await check('cafeteria admin resolves it with notes, reason and solution', async () => {
    const r = await call('PATCH', `/kitchen/stock-alerts/${qualityAlertId}/resolve`, T.cafAdmin, {
      resolutionReason: 'Expired Items',
      resolutionSolution: 'Removed Expired Items',
      resolutionNote: 'Discarded the spoiled batch and sanitized the shelf',
    });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.resolved, true);

    const doc = await StockAlert.findById(qualityAlertId);
    assert.strictEqual(doc.status, 'resolved', 'the resolution must be persisted in MongoDB');
    assert.strictEqual(String(doc.resolvedBy), String(cafAdmin._id), 'the resolving admin id must be stored');
    assert.ok(doc.resolvedAt, 'the resolution timestamp must be stored');
    assert.strictEqual(doc.resolutionNote, 'Discarded the spoiled batch and sanitized the shelf');
    assert.strictEqual(doc.resolutionReason, 'Expired Items');
    assert.strictEqual(doc.resolutionSolution, 'Removed Expired Items');
  });

  // ============================================================
  console.log('\n2. Kitchen staff still see the resolved alert in history');
  // ============================================================

  await check('the kitchen list (default "All") includes the resolved alert with status label', async () => {
    const r = await call('GET', '/kitchen/stock-alerts', T.kitchen);
    assert.strictEqual(r.status, 200, `status=${r.status}`);
    const row = r.body.alerts.find((a) => String(a.id) === String(qualityAlertId));
    assert.ok(row, 'the resolved alert must NOT be excluded from the kitchen alert history');
    assert.strictEqual(row.status, 'resolved');
    assert.strictEqual(row.resolutionReason, 'Expired Items');
    assert.strictEqual(row.resolutionSolution, 'Removed Expired Items');
    assert.ok(/spoiled batch/.test(row.resolutionNote || ''), 'the resolution note must be serialized');
    assert.strictEqual(row.resolvedBy, 'CafDetailsAdmin', 'the resolver name must be serialized');
    assert.ok(row.resolvedAt, 'the resolution timestamp must be serialized');
  });

  await check('filtering by ?status=resolved also returns the alert', async () => {
    const r = await call('GET', '/kitchen/stock-alerts?status=resolved', T.kitchen);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.alerts.some((a) => String(a.id) === String(qualityAlertId)));
  });

  // ============================================================
  console.log('\n3. Kitchen staff opens View Details by MongoDB id');
  // ============================================================

  await check('GET /kitchen/stock-alerts/:id returns full details incl. resolution', async () => {
    const r = await call('GET', `/kitchen/stock-alerts/${qualityAlertId}`, T.kitchen);
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    const a = r.body.alert;
    assert.ok(a, 'the alert payload must be present');
    assert.strictEqual(a.itemName, 'YogurtDetails');
    assert.strictEqual(String(a.itemId), String(itemQuality._id), 'the menu item id must be returned');
    assert.strictEqual(a.alertType, 'quality_issue');
    assert.strictEqual(a.severity, 'high');
    assert.strictEqual(a.reason, 'Sour smell reported by customers');
    assert.strictEqual(a.status, 'resolved');
    assert.strictEqual(a.resolutionNote, 'Discarded the spoiled batch and sanitized the shelf');
    assert.strictEqual(a.resolutionReason, 'Expired Items');
    assert.strictEqual(a.resolutionSolution, 'Removed Expired Items');
    assert.strictEqual(a.resolvedBy, 'CafDetailsAdmin', 'the resolver name must be returned');
    assert.ok(a.resolvedAt, 'the resolution timestamp must be returned');
    assert.strictEqual(a.source, 'report');
    assert.notStrictEqual(a.currentQuantity, undefined, 'the live inventory quantity must be returned');
  });

  await check('manager can also open the details endpoint', async () => {
    const r = await call('GET', `/kitchen/stock-alerts/${qualityAlertId}`, T.manager);
    assert.strictEqual(r.status, 200, `status=${r.status}`);
    assert.strictEqual(r.body.alert.status, 'resolved');
  });

  // ============================================================
  console.log('\n4. Still resolved after refresh; viewing never mutates');
  // ============================================================

  await check('re-fetching list + details keeps the alert resolved (survives refresh)', async () => {
    const list = await call('GET', '/kitchen/stock-alerts', T.kitchen);
    const row = list.body.alerts.find((a) => String(a.id) === String(qualityAlertId));
    assert.ok(row, 'the resolved alert must still be listed');
    assert.strictEqual(row.status, 'resolved');

    const details = await call('GET', `/kitchen/stock-alerts/${qualityAlertId}`, T.kitchen);
    assert.strictEqual(details.body.alert.status, 'resolved');
    assert.ok(details.body.alert.resolvedAt);

    const doc = await StockAlert.findById(qualityAlertId);
    assert.strictEqual(doc.status, 'resolved', 'the MongoDB record is still resolved');
    assert.ok(!doc.reopenedAt, 'the record must not carry any reopen marker');
  });

  await check('viewing an ACTIVE alert does not reopen/mutate it', async () => {
    // itemActive: stock 2 <= threshold 5 → a list call runs the sync pass.
    await call('GET', '/kitchen/stock-alerts', T.manager);
    const activeDoc = await StockAlert.findOne({
      itemId: itemActive._id,
      alertSource: 'system',
      status: { $in: ['active', 'acknowledged'] },
    });
    assert.ok(activeDoc, 'the low-stock system alert for CoffeeDetails must exist');

    const before = activeDoc.status;
    for (let i = 0; i < 2; i++) {
      const r = await call('GET', `/kitchen/stock-alerts/${activeDoc._id}`, T.kitchen);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.alert.status, before, 'the details endpoint reports the current status');
      assert.ok(!r.body.alert.resolvedAt, 'an active alert has no resolution timestamp');
      assert.ok(!r.body.alert.resolutionNote, 'an active alert has no resolution note');
    }
    const after = await StockAlert.findById(activeDoc._id);
    assert.strictEqual(after.status, before, 'GET details must never mutate the alert');
    assert.strictEqual(String(after.updatedAt), String(activeDoc.updatedAt), 'the record must not even be touched');
  });

  // ============================================================
  console.log('\n5. Active alerts still display correctly');
  // ============================================================

  await check('the kitchen list still shows the active low-stock alert with live quantities', async () => {
    const r = await call('GET', '/kitchen/stock-alerts', T.kitchen);
    assert.strictEqual(r.status, 200);
    const row = r.body.alerts.find((a) => a.itemId === String(itemActive._id) && a.source === 'inventory');
    assert.ok(row, 'the active inventory alert must be listed');
    assert.ok(row.status === 'active' || row.status === 'acknowledged');
    assert.strictEqual(row.currentQuantity, 2);
    assert.strictEqual(row.minimumQuantity, 5);
    assert.strictEqual(row.stockStatus, 'LOW_STOCK');
    assert.ok(r.body.lowStockCount >= 1, 'lowStockCount must count active low-stock rows');
  });

  await check('details for an unlinked manual alert (no itemId) show a safe null id, no crash', async () => {
    const r = await call('POST', '/kitchen/stock-alerts', T.kitchen, {
      itemName: 'Loose Onions',
      alertType: 'ingredient_shortage',
      severity: 'medium',
      reason: 'Two sacks missing from delivery',
    });
    assert.strictEqual(r.status, 201, `status=${r.status} ${JSON.stringify(r.body)}`);
    const id = r.body.alert && (r.body.alert.id || r.body.alert._id);
    const d = await call('GET', `/kitchen/stock-alerts/${id}`, T.kitchen);
    assert.strictEqual(d.status, 200, `details status=${d.status}`);
    assert.strictEqual(d.body.alert.itemId, null, 'an unlinked alert returns a null item id');
    assert.strictEqual(d.body.alert.source, 'report');
    assert.strictEqual(d.body.alert.status, 'active');
  });

  // ============================================================
  console.log('\n6. Kitchen staff cannot resolve alerts or change inventory');
  // ============================================================

  await check('kitchen staff resolve attempt is 403 and the alert is untouched', async () => {
    const open = await StockAlert.findOne({
      itemId: itemActive._id,
      alertSource: 'system',
      status: { $in: ['active', 'acknowledged'] },
    });
    assert.ok(open, 'an open alert is required');
    const r = await call('PATCH', `/kitchen/stock-alerts/${open._id}/resolve`, T.kitchen, {
      resolutionReason: 'Restocked Items',
      resolutionSolution: 'Restocked Items',
    });
    assert.strictEqual(r.status, 403, `kitchen resolve must be 403, got ${r.status}`);
    const still = await StockAlert.findById(open._id);
    assert.strictEqual(still.status, open.status, 'the rejected attempt must leave the alert open');
    assert.ok(!still.resolvedAt && !still.resolvedBy, 'no resolution may be recorded by kitchen staff');
  });

  await check('kitchen staff cannot submit restocks (inventory changes) — 403', async () => {
    const r = await call('POST', '/restocks', T.kitchen, {
      itemId: String(itemActive._id),
      requestedQuantity: 10,
      reason: 'not allowed',
    });
    assert.strictEqual(r.status, 403, `kitchen restock submit must be 403, got ${r.status}`);
  });

  await check('customers are still forbidden from stock alerts and details', async () => {
    assert.strictEqual((await call('GET', '/kitchen/stock-alerts', T.customer)).status, 403);
    assert.strictEqual((await call('GET', `/kitchen/stock-alerts/${qualityAlertId}`, T.customer)).status, 403);
  });

  // ============================================================
  console.log('\n7. Unrelated features keep working; bad ids handled safely');
  // ============================================================

  await check('bad ids: invalid ObjectId → 400, unknown id → 404, no crash', async () => {
    const invalid = await call('GET', '/kitchen/stock-alerts/not-an-objectid', T.kitchen);
    assert.strictEqual(invalid.status, 400, `expected 400, got ${invalid.status}`);
    const unknown = await call('GET', `/kitchen/stock-alerts/${new mongoose.Types.ObjectId()}`, T.kitchen);
    assert.strictEqual(unknown.status, 404, `expected 404, got ${unknown.status}`);
  });

  await check('the kitchen dashboard endpoint still works (unrelated feature)', async () => {
    const r = await call('GET', '/kitchen/dashboard', T.kitchen);
    assert.strictEqual(r.status, 200, `dashboard status=${r.status} ${JSON.stringify(r.body)}`);
  });

  await check('no duplicate alerts or status fields were created by the flow', async () => {
    const docs = await StockAlert.find({ itemId: itemQuality._id });
    assert.strictEqual(docs.length, 1, `expected exactly 1 alert for the yogurt item, found ${docs.length}`);
    assert.ok(docs[0].status, 'the single status field must exist');
  });

  await chain;

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log('Failed: ' + failures.join(', '));

  httpServer.close();
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
