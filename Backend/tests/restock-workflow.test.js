/**
 * Stock alerts + restock workflow - acceptance test.
 *
 * Covers the end-to-end inventory workflow:
 *   1. Threshold alerts auto-lifecycle (order decrement → Low Stock,
 *      zero → Out of Stock, cancellation restore → auto-resolve,
 *      GET self-healing sync).
 *   2. Kitchen reports (quality issue → quality hold → availability blocked →
 *      admin resolve lifts the hold; manager/kitchen get 403 on resolve).
 *   3. Admin resolution guard (admins only; genuine resolution only; partial
 *      restock records the counted quantity but keeps the alert open).
 *   4. Restock request workflow (Manager submit → Admin approve → Admin record
 *      actual received stock with atomic $inc + RESTOCK transaction + audit +
 *      notifications), with role enforcement, duplicate guard, cancel rules.
 *   5. Issue report investigation notes + restock linkage (records stay
 *      separate; status untouched by the restock flow), plus the permission
 *      split: manager reviews/investigates (403 on solution), cafeteria admin
 *      accepts and resolves with notes + admin id + timestamp.
 *   6. Serialized list shape (source inventory/report, counts).
 *
 * Run: node tests/restock-workflow.test.js
 */
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scs_restock_workflow_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'restock-workflow-test-secret';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');

const PORT = 5096;
const API = `http://127.0.0.1:${PORT}/api/v1`;

let passed = 0;
const failures = [];
// Workflow scenarios are strictly ordered (submit → approve → record), so
// checks are chained sequentially rather than fired concurrently.
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
  const StockTransaction = require('../src/models/StockTransaction');
  const RestockRequest = require('../src/models/RestockRequest');
  const IssueReport = require('../src/models/IssueReport');
  const Notification = require('../src/models/Notification');
  const ActivityLog = require('../src/models/ActivityLog');
  const Order = require('../src/models/Order');
  const { ensureDefaultCafeteria, getDefaultCafeteriaId } = require('../src/utils/cafeteria');

  // Deterministic tenancy: one default cafeteria, every staff account + item
  // assigned to it (resolveCafeteriaScope hard-403s unassigned staff).
  await ensureDefaultCafeteria();
  const cafeteriaId = await getDefaultCafeteriaId();

  // Phone is unique in the User schema; the index is (re)built in the
  // background after the database drop, so one shared number across users
  // races the index build and flakes with E11000. Give every user its own.
  let phoneSeq = 0;
  const mkUser = (name, role, caf = null) =>
    User.create({
      name,
      email: `${name.toLowerCase().replace(/[^a-z]/g, '')}@restock.test`,
      phone: '0911' + String(++phoneSeq).padStart(6, '0'),
      password: 'password123',
      role,
      status: 'ACTIVE',
      cafeteriaId: caf,
    });

  const customer = await mkUser('Customer', 'customer');
  const manager = await mkUser('Manager', 'manager', cafeteriaId);
  const manager2 = await mkUser('ManagerTwo', 'manager', cafeteriaId);
  // The cafeteria ADMINISTRATOR's duties (reviewing reports, resolving stock
  // alerts, approving/recording restocks) were folded into the admin role
  // when the cafeteria_admin and manager roles were consolidated. This user
  // plays that role: it keeps the 'CafAdmin' name, which several assertions
  // below read back from the API payload.
  const cafAdmin = await mkUser('CafAdmin', 'admin', cafeteriaId);
  const kitchen = await mkUser('Kitchen', 'kitchen', cafeteriaId);
  const sysAdmin = await mkUser('SysAdmin', 'admin');

  const tok = (u) => jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const T = {
    customer: tok(customer),
    manager: tok(manager),
    manager2: tok(manager2),
    cafAdmin: tok(cafAdmin),
    kitchen: tok(kitchen),
    sysAdmin: tok(sysAdmin),
  };

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

  const itemA = await mkItem('Coffee', 10, 5);   // ordered down, then cancelled back
  const itemB = await mkItem('Buns', 2, 5);      // ordered to zero
  const itemQ = await mkItem('Yogurt', 10, 5);   // quality issue
  const itemG = await mkItem('Juice', 20, 5);    // resolve-guard target
  const itemD = await mkItem('Bread', 20, 5);    // approve (stays APPROVED)
  const itemE = await mkItem('Milk', 20, 5);     // record received stock
  const itemF = await mkItem('Tea', 20, 5);      // reject flow
  const itemH = await mkItem('Sugar', 20, 5);    // cancel rules (PENDING)
  const itemI = await mkItem('Salt', 20, 5);     // cancel rules (APPROVED)
  const itemJ = await mkItem('Eggs', 20, 5);     // issue-report linkage

  const call = async (method, path, token, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const setStock = (item, stock) =>
    MenuItem.updateOne({ _id: item._id }, { $set: { stockQuantity: stock } });

  const openSystemAlert = (item) =>
    StockAlert.findOne({ itemId: item._id, alertSource: 'system', status: { $in: ['active', 'acknowledged'] } });

  const alertsAsManager = () => call('GET', '/kitchen/stock-alerts', T.manager);

  const placeOrder = (item, quantity) =>
    call('POST', '/orders', T.customer, {
      customerName: 'Acceptance Tester',
      customerPhone: '0911223344',
      orderType: 'takeaway',
      paymentMethod: 'CHAPA',
      items: [{ id: String(item._id), quantity }],
    });

  const latestOrder = () => Order.findOne({}).sort({ createdAt: -1 });

  // ============================================================
  console.log('\nThreshold alerts: order decrement, zero stock, cancellation restore');
  // ============================================================

  await check('an order that pushes stock to/below the threshold creates a Low Stock system alert', async () => {
    const r = await placeOrder(itemA, 6); // 10 → 4, threshold 5
    assert.strictEqual(r.status, 201, `order status=${r.status} ${JSON.stringify(r.body)}`);

    const refreshed = await MenuItem.findById(itemA._id);
    assert.strictEqual(refreshed.stockQuantity, 4, 'stock must be 4 after the order');

    const list = await alertsAsManager();
    assert.strictEqual(list.status, 200);
    const row = list.body.alerts.find(
      (a) => a.itemId === String(itemA._id) && a.source === 'inventory' && a.status === 'active'
    );
    assert.ok(row, 'an active inventory alert for Coffee must be listed');
    assert.strictEqual(row.alertType, 'low_stock');
    assert.strictEqual(row.alertSource, 'system');
    assert.strictEqual(row.currentQuantity, 4);
    assert.strictEqual(row.minimumQuantity, 5);
    assert.strictEqual(row.reportedBy, 'System');

    const doc = await openSystemAlert(itemA);
    assert.ok(doc, 'the alert must be persisted as a StockAlert document');
    assert.strictEqual(doc.alertSource, 'system');
  });

  await check('an order that consumes the last unit classifies the item as Out of Stock', async () => {
    const r = await placeOrder(itemB, 2); // 2 → 0
    assert.strictEqual(r.status, 201, `order status=${r.status}`);

    const refreshed = await MenuItem.findById(itemB._id);
    assert.strictEqual(refreshed.stockQuantity, 0);
    assert.strictEqual(refreshed.availabilityStatus, 'OUT_OF_STOCK');

    const doc = await openSystemAlert(itemB);
    assert.ok(doc, 'out_of_stock alert must exist');
    assert.strictEqual(doc.alertType, 'out_of_stock');
    assert.strictEqual(doc.severity, 'critical');
  });

  await check('cancelling the order restores stock and auto-resolves the threshold alert', async () => {
    const order = await latestOrder();
    assert.ok(order, 'an order must exist');
    // The latest order is itemB's; cancel the Coffee order explicitly.
    const coffeeOrder = await Order.findOne({ 'items.itemId': itemA._id }).sort({ createdAt: -1 });
    assert.ok(coffeeOrder, 'coffee order must exist');

    const r = await call('PATCH', `/admin/orders/${coffeeOrder._id}/cancel`, T.sysAdmin, { reason: 'acceptance test' });
    assert.strictEqual(r.status, 200, `cancel status=${r.status} ${JSON.stringify(r.body)}`);

    const refreshed = await MenuItem.findById(itemA._id);
    assert.strictEqual(refreshed.stockQuantity, 10, 'stock must be restored to 10');

    const doc = await openSystemAlert(itemA);
    assert.ok(!doc, 'the threshold alert must be auto-resolved once stock recovered');
    const resolvedDoc = await StockAlert.findOne({
      itemId: itemA._id,
      alertSource: 'system',
      status: 'resolved',
    }).sort({ resolvedAt: -1 });
    assert.ok(resolvedDoc, 'a resolved system alert must remain for history');
    assert.strictEqual(resolvedDoc.resolutionReason, 'Stock recovered');
  });

  await check('GET /kitchen/stock-alerts self-heals after out-of-band stock edits', async () => {
    await setStock(itemA, 3); // breach without any endpoint touching it
    let list = await alertsAsManager();
    let row = list.body.alerts.find((a) => a.itemId === String(itemA._id) && a.source === 'inventory' && a.status === 'active');
    assert.ok(row, 'sync pass must create the alert on the next list read');
    assert.strictEqual(row.currentQuantity, 3);

    await setStock(itemA, 9); // genuine recovery
    list = await alertsAsManager();
    row = list.body.alerts.find((a) => a.itemId === String(itemA._id) && a.source === 'inventory' && a.status === 'active');
    assert.ok(!row, 'the alert must be resolved once stock is above the minimum');
  });

  // ============================================================
  console.log('\nKitchen report → quality hold → availability guard → resolve lifts hold');
  // ============================================================

  await check('a quality issue report puts the item on quality hold and makes it unavailable', async () => {
    const r = await call('POST', '/kitchen/stock-alerts', T.kitchen, {
      itemId: String(itemQ._id),
      itemName: 'Yogurt',
      alertType: 'quality_issue',
      severity: 'high',
      reason: 'Sour smell reported by customers',
    });
    assert.strictEqual(r.status, 201, `status=${r.status} ${JSON.stringify(r.body)}`);

    const q = await MenuItem.findById(itemQ._id);
    assert.strictEqual(q.qualityHold, true, 'qualityHold must be set');
    assert.strictEqual(q.availabilityStatus, 'UNAVAILABLE', 'item must not stay AVAILABLE under a quality hold');
  });

  await check('a duplicate quality report returns the existing alert instead of a second one', async () => {
    const r = await call('POST', '/kitchen/stock-alerts', T.kitchen, {
      itemId: String(itemQ._id),
      itemName: 'Yogurt',
      alertType: 'quality_issue',
      severity: 'high',
      reason: 'Sour smell reported by customers',
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.existing, true, 'duplicate must be detected');
  });

  await check('the item cannot be flipped back to available while the quality issue is open', async () => {
    const r = await call('PATCH', `/kitchen/menu/${itemQ._id}/availability`, T.manager, {
      isAvailable: true,
      reason: 'try to re-enable',
    });
    assert.strictEqual(r.status, 409, `expected 409, got ${r.status}`);
    assert.ok(/quality/i.test(r.body.error || ''), `error should mention quality, got: ${r.body.error}`);
  });

  await check('only managers and admins may resolve a stock alert (kitchen and customers get 403)', async () => {
    const alert = await StockAlert.findOne({ itemId: itemQ._id, alertType: 'quality_issue', status: 'active' });
    assert.ok(alert, 'the quality alert must exist');
    const body = { resolutionReason: 'Expired Items', resolutionSolution: 'Removed Expired Items' };
    // The cafeteria manager resolves inventory alerts too (the resolve route
    // allows manager/admin/system_admin), so the roles that must still be
    // refused are kitchen staff and customers.
    const byKitchen = await call('PATCH', `/kitchen/stock-alerts/${alert._id}/resolve`, T.kitchen, body);
    assert.strictEqual(byKitchen.status, 403, `kitchen resolve must be 403, got ${byKitchen.status}`);
    const byCustomer = await call('PATCH', `/kitchen/stock-alerts/${alert._id}/resolve`, T.customer, body);
    assert.strictEqual(byCustomer.status, 403, `customer resolve must be 403, got ${byCustomer.status}`);

    const still = await StockAlert.findById(alert._id);
    assert.strictEqual(still.status, 'active', 'the rejected attempts must leave the alert open');
    const q = await MenuItem.findById(itemQ._id);
    assert.strictEqual(q.qualityHold, true, 'the quality hold must stay until an admin resolves');
  });

  await check('an admin resolving the quality alert lifts the hold and availability can be restored', async () => {
    const alert = await StockAlert.findOne({ itemId: itemQ._id, alertType: 'quality_issue', status: 'active' });
    assert.ok(alert, 'the quality alert must exist');

    const r = await call('PATCH', `/kitchen/stock-alerts/${alert._id}/resolve`, T.cafAdmin, {
      resolutionReason: 'Expired Items',
      resolutionSolution: 'Removed Expired Items',
      resolutionNote: 'Discarded spoiled batch',
    });
    assert.strictEqual(r.status, 200, `resolve status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.resolved, true);
    // The resolve RESPONSE is display-ready like the list/detail endpoints:
    // person fields are names (the modal renders "By {name}" from resolvedBy).
    assert.strictEqual(r.body.alert.resolvedBy, 'CafAdmin', 'the resolver name must be in the payload');
    assert.ok(r.body.alert.resolvedAt, 'the resolution timestamp must be recorded');
    const storedQ = await StockAlert.findById(alert._id);
    assert.strictEqual(String(storedQ.resolvedBy), String(cafAdmin._id), 'the resolving admin id must be stored');

    const q = await MenuItem.findById(itemQ._id);
    assert.strictEqual(q.qualityHold, false, 'quality hold must be lifted on resolution');

    const back = await call('PATCH', `/kitchen/menu/${itemQ._id}/availability`, T.manager, {
      isAvailable: true,
      reason: 'inspection passed',
    });
    assert.strictEqual(back.status, 200, `availability restore should work now: ${JSON.stringify(back.body)}`);
    const q2 = await MenuItem.findById(itemQ._id);
    assert.strictEqual(q2.availabilityStatus, 'AVAILABLE');
  });

  // ============================================================
  console.log('\nAdmin resolution guard: genuine resolution only');
  // ============================================================

  const prepGuardItem = async () => {
    await setStock(itemG, 3); // breach: 3 <= 5
    await alertsAsManager();  // run the sync pass
    const alert = await openSystemAlert(itemG);
    assert.ok(alert, 'guard item must have an open system alert');
    return alert;
  };

  await check('resolving a still-breached threshold alert without a quantity is refused (409)', async () => {
    const alert = await prepGuardItem();
    const r = await call('PATCH', `/kitchen/stock-alerts/${alert._id}/resolve`, T.cafAdmin, {
      resolutionReason: 'Low Stock',
      resolutionSolution: 'Restocked Items',
    });
    assert.strictEqual(r.status, 409, `expected 409, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(/restock|unavailable/i.test(r.body.error || ''), `guidance missing: ${r.body.error}`);
    assert.strictEqual(r.body.currentQuantity, 3);
    assert.strictEqual(r.body.minimumQuantity, 5);

    const stillOpen = await StockAlert.findById(alert._id);
    assert.strictEqual(stillOpen.status, 'active', 'the alert must NOT be closed');
  });

  await check('recording a counted quantity below the minimum records it but keeps the alert open', async () => {
    const alert = await openSystemAlert(itemG);
    assert.ok(alert, 'guard alert still open');
    const r = await call('PATCH', `/kitchen/stock-alerts/${alert._id}/resolve`, T.cafAdmin, {
      resolutionReason: 'Incorrect Stock Record',
      resolutionSolution: 'Updated Stock Quantity',
      newStockQuantity: 4,
    });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.resolved, false, 'partial restock must not close the alert');

    const g = await MenuItem.findById(itemG._id);
    assert.strictEqual(g.stockQuantity, 4, 'counted quantity must be stored');

    const stillOpen = await StockAlert.findById(alert._id);
    assert.strictEqual(stillOpen.status, 'active');
    assert.strictEqual(stillOpen.resolutionQuantity, 4, 'the counted quantity is recorded on the alert');

    const tx = await StockTransaction.findOne({ foodId: itemG._id, action: 'SET' });
    assert.ok(tx, 'a SET StockTransaction must audit the quantity change');
    assert.strictEqual(tx.newQuantity, 4);
    const log = await ActivityLog.findOne({ action: 'STOCK_QUANTITY_SET' });
    assert.ok(log, 'the quantity change must be in the audit trail');
  });

  await check('resolving with a real quantity above the minimum genuinely resolves the alert', async () => {
    const alert = await openSystemAlert(itemG);
    const r = await call('PATCH', `/kitchen/stock-alerts/${alert._id}/resolve`, T.cafAdmin, {
      resolutionReason: 'Restocked Items',
      resolutionSolution: 'Restocked Items',
      newStockQuantity: 8,
    });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.resolved, true);
    const g = await MenuItem.findById(itemG._id);
    assert.strictEqual(g.stockQuantity, 8);
    const closed = await StockAlert.findById(alert._id);
    assert.strictEqual(closed.status, 'resolved');
    assert.strictEqual(String(closed.resolvedBy), String(cafAdmin._id), 'the resolving admin id must be recorded');
    assert.ok(closed.resolvedAt, 'the resolution timestamp must be recorded');
  });

  await check('the manager can still acknowledge a stock alert (review action, not resolution)', async () => {
    await setStock(itemG, 3); // breach: 3 <= 5
    await alertsAsManager();  // run the sync pass
    const alert = await openSystemAlert(itemG);
    assert.ok(alert, 'a fresh open alert is needed');
    const r = await call('PATCH', `/kitchen/stock-alerts/${alert._id}/acknowledge`, T.manager, { note: 'On it.' });
    assert.strictEqual(r.status, 200, `acknowledge status=${r.status} ${JSON.stringify(r.body)}`);
    const doc = await StockAlert.findById(alert._id);
    assert.strictEqual(doc.status, 'acknowledged', 'acknowledging does not resolve');
    // Leave the item breached so later list-shape checks still see low stock.
    await setStock(itemG, 20);
    await alertsAsManager();
  });

  // ============================================================
  console.log('\nRestock workflow: roles first');
  // ============================================================

  const submitD = () =>
    call('POST', '/restocks', T.manager, {
      itemId: String(itemD._id),
      requestedQuantity: 30,
      reason: 'Daily bread delivery shortfall',
    });

  await check('customers, kitchen staff and system admins cannot submit restock requests', async () => {
    for (const [label, token] of [['customer', T.customer], ['kitchen', T.kitchen], ['admin', T.sysAdmin]]) {
      const r = await call('POST', '/restocks', token, {
        itemId: String(itemD._id),
        requestedQuantity: 10,
        reason: 'not allowed',
      });
      assert.strictEqual(r.status, 403, `${label} must be 403, got ${r.status}`);
    }
  });

  await check('non-manager roles cannot review or record, and customers cannot even list', async () => {
    assert.strictEqual((await call('GET', '/restocks', T.customer)).status, 403);
    assert.strictEqual((await call('PATCH', '/restocks/x/review', T.manager, { decision: 'APPROVED' })).status, 403);
    assert.strictEqual((await call('PATCH', '/restocks/x/restock', T.manager, { receivedQuantity: 1 })).status, 403);
    assert.strictEqual((await call('POST', '/restocks', T.cafAdmin, { itemId: String(itemD._id), requestedQuantity: 5, reason: 'nope' })).status, 403);
  });

  // ============================================================
  console.log('\nRestock workflow: submit → approve → record');
  // ============================================================

  let requestD = null;
  await check('the manager submits a restock request (PENDING) and admins are notified', async () => {
    await setStock(itemD, 1); // genuine low stock for the request snapshot
    const r = await submitD();
    assert.strictEqual(r.status, 201, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.request.status, 'PENDING');
    assert.strictEqual(r.body.request.currentQuantity, 1, 'snapshot must capture the stock at submission');
    requestD = r.body.request;

    const notif = await Notification.findOne({ userId: cafAdmin._id, title: 'New Restock Request' });
    assert.ok(notif, 'the cafeteria admin must be notified');
    assert.ok(/Bread/.test(notif.message || ''));

    const log = await ActivityLog.findOne({ action: 'RESTOCK_REQUEST_SUBMITTED' });
    assert.ok(log, 'submission must be audited');

    const list = await call('GET', '/restocks', T.manager);
    assert.strictEqual(list.status, 200);
    const mine = list.body.requests.find((x) => x.id === requestD.id);
    assert.ok(mine, 'the manager can monitor their request');
    assert.strictEqual(mine.status, 'PENDING');

    // Acceptance 3: the cafeteria admin sees the SAME server-side record
    // (a page refresh re-reads it; nothing lives in localStorage).
    const adminList = await call('GET', '/restocks', T.cafAdmin);
    assert.strictEqual(adminList.status, 200, `admin list status=${adminList.status}`);
    assert.ok(
      adminList.body.requests.some((x) => x.id === requestD.id),
      'the admin must see the pending request'
    );
  });

  await check('a second open request for the same item is blocked (409) with the existing one attached', async () => {
    const r = await submitD();
    assert.strictEqual(r.status, 409, `expected 409, got ${r.status}`);
    assert.ok(/open pending restock request/i.test(r.body.error || ''), `got: ${r.body.error}`);
    assert.strictEqual(r.body.request && r.body.request.id, requestD.id);
  });

  await check('the admin approves with an explanation, inventory untouched, manager notified, re-review conflicts', async () => {
    const stockBefore = (await MenuItem.findById(itemD._id)).stockQuantity;
    const r = await call('PATCH', `/restocks/${requestD.id}/review`, T.cafAdmin, {
      decision: 'APPROVED',
      explanation: 'Supplier arrives at 4pm',
    });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.request.status, 'APPROVED');
    assert.strictEqual((r.body.request.reviewedBy || {}).name, 'CafAdmin');

    // Acceptance 4: approval alone must NEVER change the inventory quantity -
    // stock moves only when the actual received quantity is recorded.
    const stockAfter = (await MenuItem.findById(itemD._id)).stockQuantity;
    assert.strictEqual(stockAfter, stockBefore, 'approval must not touch MenuItem.stockQuantity');
    assert.strictEqual(stockAfter, 1, 'inventory must still be the pre-approval quantity');

    const notif = await Notification.findOne({ userId: manager._id, title: 'Restock Request Approved' });
    assert.ok(notif, 'the requesting manager must be notified of the approval');

    const again = await call('PATCH', `/restocks/${requestD.id}/review`, T.cafAdmin, { decision: 'REJECTED', explanation: 'changed mind' });
    assert.strictEqual(again.status, 409, 'a decided request cannot be re-reviewed');
    assert.ok(/already been/i.test(again.body.error || ''), `got: ${again.body.error}`);
  });

  await check('recording stock on a PENDING request is refused (409)', async () => {
    const sub = await call('POST', '/restocks', T.manager, {
      itemId: String(itemE._id),
      requestedQuantity: 20,
      reason: 'Milk runs out daily',
    });
    assert.strictEqual(sub.status, 201, `submit status=${sub.status}`);
    const r = await call('PATCH', `/restocks/${sub.body.request.id}/restock`, T.cafAdmin, { receivedQuantity: 10 });
    assert.strictEqual(r.status, 409, `expected 409, got ${r.status}`);
    assert.ok(/only approved/i.test(r.body.error || ''), `got: ${r.body.error}`);
    requestE = sub.body.request;
  });
  var requestE; // hoisted holder (assigned inside the check above)

  await check('after approval, recording the ACTUAL received quantity updates stock atomically with full audit', async () => {
    // E starts at 20; set it to 1 (low) and let the sync pass create the alert.
    await setStock(itemE, 1);
    await alertsAsManager();
    const alertBefore = await openSystemAlert(itemE);
    assert.ok(alertBefore, 'Milk must have an open low-stock alert before the restock');

    const review = await call('PATCH', `/restocks/${requestE.id}/review`, T.cafAdmin, { decision: 'APPROVED', explanation: 'ok' });
    assert.strictEqual(review.status, 200, `approve status=${review.status}`);

    const r = await call('PATCH', `/restocks/${requestE.id}/restock`, T.cafAdmin, {
      receivedQuantity: 24,
      note: 'Two crates, one damaged',
    });
    assert.strictEqual(r.status, 200, `record status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.request.status, 'RESTOCKED');
    assert.strictEqual(r.body.request.receivedQuantity, 24);
    assert.strictEqual((r.body.request.restockedBy || {}).name, 'CafAdmin');

    const e = await MenuItem.findById(itemE._id);
    assert.strictEqual(e.stockQuantity, 25, 'stock must be 1 + 24 = 25');

    const tx = await StockTransaction.findOne({ foodId: itemE._id, action: 'RESTOCK' });
    assert.ok(tx, 'a RESTOCK StockTransaction must exist');
    assert.strictEqual(tx.quantityChanged, 24);
    assert.strictEqual(String(tx.restockRequestId), String(requestE.id));
    assert.strictEqual(tx.performedByRole, 'admin');

    const log = await ActivityLog.findOne({ action: 'STOCK_RESTOCKED' });
    assert.ok(log, 'the restock must be audited');

    const notif = await Notification.findOne({ userId: manager._id, title: 'Stock Restocked' });
    assert.ok(notif, 'the requesting manager must be notified');

    const alertAfter = await StockAlert.findById(alertBefore._id);
    assert.strictEqual(alertAfter.status, 'resolved', '25 > 5 must auto-resolve the threshold alert');
  });

  await check('the same APPROVED request cannot be recorded twice', async () => {
    const r = await call('PATCH', `/restocks/${requestE.id}/restock`, T.cafAdmin, { receivedQuantity: 5 });
    assert.strictEqual(r.status, 409, `expected 409, got ${r.status}`);
    assert.ok(/already been recorded/i.test(r.body.error || ''), `got: ${r.body.error}`);
    const e = await MenuItem.findById(itemE._id);
    assert.strictEqual(e.stockQuantity, 25, 'stock must not be double-incremented');
  });

  await check('rejection requires an explanation and notifies the manager', async () => {
    const sub = await call('POST', '/restocks', T.manager, {
      itemId: String(itemF._id),
      requestedQuantity: 15,
      reason: 'Tea stock low',
    });
    assert.strictEqual(sub.status, 201);

    const noNote = await call('PATCH', `/restocks/${sub.body.request.id}/review`, T.cafAdmin, { decision: 'REJECTED' });
    assert.strictEqual(noNote.status, 400, 'reject without explanation must fail');

    const ok = await call('PATCH', `/restocks/${sub.body.request.id}/review`, T.cafAdmin, {
      decision: 'REJECTED',
      explanation: 'Backup stock exists in the store room',
    });
    assert.strictEqual(ok.status, 200, `status=${ok.status} ${JSON.stringify(ok.body)}`);
    assert.strictEqual(ok.body.request.status, 'REJECTED');

    const notif = await Notification.findOne({ userId: manager._id, title: 'Restock Request Rejected' });
    assert.ok(notif, 'the requesting manager must be notified of the rejection');
  });

  await check('only the requesting manager can cancel, only while PENDING', async () => {
    // Another manager cannot cancel someone else's request.
    const subH = await call('POST', '/restocks', T.manager, {
      itemId: String(itemH._id),
      requestedQuantity: 10,
      reason: 'Sugar running low',
    });
    assert.strictEqual(subH.status, 201);
    const byOther = await call('POST', `/restocks/${subH.body.request.id}/cancel`, T.manager2, {});
    assert.strictEqual(byOther.status, 403, `another manager must be 403, got ${byOther.status}`);

    const byOwner = await call('POST', `/restocks/${subH.body.request.id}/cancel`, T.manager, {});
    assert.strictEqual(byOwner.status, 200, `owner cancel status=${byOwner.status} ${JSON.stringify(byOwner.body)}`);
    assert.strictEqual(byOwner.body.request.status, 'CANCELLED');

    const again = await call('POST', `/restocks/${subH.body.request.id}/cancel`, T.manager, {});
    assert.strictEqual(again.status, 400, 'a cancelled request cannot be cancelled again');

    // An APPROVED request is already being worked → cannot be cancelled.
    const subI = await call('POST', '/restocks', T.manager, {
      itemId: String(itemI._id),
      requestedQuantity: 8,
      reason: 'Salt restock',
    });
    const approveI = await call('PATCH', `/restocks/${subI.body.request.id}/review`, T.cafAdmin, { decision: 'APPROVED' });
    assert.strictEqual(approveI.status, 200);
    const cancelApproved = await call('POST', `/restocks/${subI.body.request.id}/cancel`, T.manager, {});
    assert.strictEqual(cancelApproved.status, 400, `approved cancel must be 400, got ${cancelApproved.status}`);
  });

  // ============================================================
  console.log('\nIssue reports: investigation notes + restock linkage (records stay separate)');
  // ============================================================

  await check('a kitchen issue report can carry the affected menu item', async () => {
    await setStock(itemJ, 1);
    await alertsAsManager();
    const r = await call('POST', '/issues', T.kitchen, {
      title: 'Egg crate arrived cracked',
      description: '12 eggs broken in the morning delivery',
      category: 'stock',
      priority: 'high',
      itemId: String(itemJ._id),
    });
    assert.strictEqual(r.status, 201, `status=${r.status} ${JSON.stringify(r.body)}`);
    issueJ = r.body.issue || r.body;
    assert.ok(issueJ.id, 'the created issue id must be returned');

    // Acceptance 1: the kitchen report shows up in the manager dashboard's
    // list endpoint (and in the kitchen reporter's own list).
    const managerList = await call('GET', '/issues', T.manager);
    assert.strictEqual(managerList.status, 200, `manager list status=${managerList.status}`);
    assert.ok(
      managerList.body.issues.some((i) => String(i.id) === String(issueJ.id)),
      'the manager dashboard must list the kitchen staff report'
    );
    const ownList = await call('GET', '/issues', T.kitchen);
    assert.strictEqual(ownList.status, 200);
    assert.ok(
      ownList.body.issues.some((i) => String(i.id) === String(issueJ.id)),
      'the reporting kitchen user must still see their own report'
    );
  });
  var issueJ;

  await check('the manager records investigation notes without changing the report status', async () => {
    const r = await call('PATCH', `/issues/${issueJ.id}/investigate`, T.manager, {
      notes: 'Checked delivery - supplier packed loose eggs without padding',
      itemId: String(itemJ._id),
    });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.issue.investigationNotes, 'Checked delivery - supplier packed loose eggs without padding');
    assert.strictEqual(r.body.issue.status, 'OPEN', 'investigation must not advance the status');
    assert.strictEqual((r.body.issue.investigatedBy || {}).name, 'Manager');

    const log = await ActivityLog.findOne({ action: 'ISSUE_REPORT_INVESTIGATED' });
    assert.ok(log, 'the investigation must be audited');
  });

  await check('kitchen staff and customers cannot write investigation notes', async () => {
    const byKitchen = await call('PATCH', `/issues/${issueJ.id}/investigate`, T.kitchen, { notes: 'nope' });
    assert.strictEqual(byKitchen.status, 403);
    const byCustomer = await call('PATCH', `/issues/${issueJ.id}/investigate`, T.customer, { notes: 'nope' });
    assert.strictEqual(byCustomer.status, 403);
  });

  await check('requesting restock from the issue links the request without touching the issue status', async () => {
    const r = await call('POST', '/restocks', T.manager, {
      itemId: String(itemJ._id),
      requestedQuantity: 40,
      reason: 'Replace cracked eggs',
      issueReportId: issueJ.id,
    });
    assert.strictEqual(r.status, 201, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.request.issueReportId, issueJ.id);

    const issue = await IssueReport.findById(issueJ.id);
    assert.strictEqual(String(issue.restockRequestId), String(r.body.request.id), 'the issue must back-link the request');
    assert.strictEqual(issue.status, 'OPEN', 'the issue status is untouched by the restock flow');

    const detail = await call('GET', `/issues/${issueJ.id}`, T.manager);
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.body.issue.restockRequestStatus, 'PENDING', 'the linked status is exposed for display');

    // The admin's restock list carries the linked report summary (the
    // "Linked Report" column) so no second lookup is needed on the page.
    const adminList = await call('GET', '/restocks', T.cafAdmin);
    assert.strictEqual(adminList.status, 200);
    const linked = adminList.body.requests.find((x) => x.id === r.body.request.id);
    assert.ok(linked, 'the admin sees the issue-triggered request');
    assert.ok(linked.issueReport, 'the linked report summary must be serialized');
    assert.strictEqual(String(linked.issueReport.id), String(issueJ.id));
    assert.strictEqual(linked.issueReport.title, 'Egg crate arrived cracked');
    assert.strictEqual(linked.issueReport.status, 'OPEN');
  });

  await check('the manager can never send a solution (403) - review actions stay allowed', async () => {
    const body = {
      resolutionReason: 'Incorrect Stock Record',
      resolutionSolution: 'Corrected Inventory Record',
    };
    const byManager = await call('PATCH', `/issues/${issueJ.id}/solution`, T.manager, body);
    assert.strictEqual(byManager.status, 403, `manager solution must be 403, got ${byManager.status}`);
    const byKitchen = await call('PATCH', `/issues/${issueJ.id}/solution`, T.kitchen, body);
    assert.strictEqual(byKitchen.status, 403, `kitchen solution must be 403, got ${byKitchen.status}`);
    const byCustomer = await call('PATCH', `/issues/${issueJ.id}/solution`, T.customer, body);
    assert.strictEqual(byCustomer.status, 403, `customer solution must be 403, got ${byCustomer.status}`);

    // The rejected attempts must not have touched the report.
    const still = await IssueReport.findById(issueJ.id);
    assert.strictEqual(still.status, 'OPEN', 'the report must stay open');
    assert.ok(!still.repliedBy && !still.resolvedAt, 'no resolution may be recorded by a rejected call');
  });

  await check('only the cafeteria admin reviews and resolves the report, recording notes, admin id and timestamp', async () => {
    const review = await call('PATCH', `/issues/${issueJ.id}/review`, T.cafAdmin, {
      notes: 'Confirmed with the kitchen: 12 eggs were broken in transit.',
    });
    assert.strictEqual(review.status, 200, `review status=${review.status} ${JSON.stringify(review.body)}`);
    assert.strictEqual(review.body.issue.status, 'UNDER_REVIEW');

    const r = await call('PATCH', `/issues/${issueJ.id}/solution`, T.cafAdmin, {
      resolutionReason: 'Incorrect Stock Record',
      resolutionSolution: 'Corrected Inventory Record',
      resolutionNote: 'Recounted crate: 40 good eggs; supplier credited the 12 broken ones',
    });
    assert.strictEqual(r.status, 200, `solution status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.issue.status, 'RESOLVED');
    assert.strictEqual(String(r.body.issue.repliedBy && r.body.issue.repliedBy.id), String(cafAdmin._id),
      'the resolving admin id must be recorded');
    assert.ok(r.body.issue.resolvedAt, 'the resolution timestamp must be recorded');
    assert.strictEqual(r.body.issue.resolutionReason, 'Incorrect Stock Record');
    assert.ok(/Recounted crate/.test(r.body.issue.solution || ''), 'the resolution notes must be stored');

    const log = await ActivityLog.findOne({ action: 'ISSUE_REPORT_RESOLVED' });
    assert.ok(log, 'the resolution must be audited');
  });

  // ============================================================
  console.log('\nFeedback: new-feedback count for the manager');
  // ============================================================

  await check('new customer feedback raises the manager count and marking it read lowers it', async () => {
    const before = await call('GET', '/feedback/stats', T.manager);
    assert.strictEqual(before.status, 200, `stats status=${before.status}`);
    assert.strictEqual(typeof before.body.stats.unread, 'number', 'stats must expose the unread (new feedback) count');
    const unreadBefore = before.body.stats.unread;

    const sub = await call('POST', '/feedback', T.customer, {
      rating: 4,
      comment: 'The bread was stale this morning',
      category: 'Food Quality',
    });
    assert.strictEqual(sub.status, 201, `feedback status=${sub.status} ${JSON.stringify(sub.body)}`);
    const fbId = sub.body.feedback && sub.body.feedback.id;
    assert.ok(fbId, 'the created feedback id must be returned');

    const mid = await call('GET', '/feedback/stats', T.manager);
    assert.strictEqual(mid.body.stats.unread, unreadBefore + 1, 'the submission must raise the new-feedback count');

    const read = await call('PATCH', `/feedback/${fbId}/read`, T.manager, {});
    assert.strictEqual(read.status, 200, `mark-read status=${read.status} ${JSON.stringify(read.body)}`);
    assert.strictEqual(read.body.feedback.isRead, true);

    const after = await call('GET', '/feedback/stats', T.manager);
    assert.strictEqual(after.body.stats.unread, unreadBefore, 'marking read must lower the count');

    const denied = await call('GET', '/feedback/stats', T.customer);
    assert.strictEqual(denied.status, 403, 'customers must not read staff feedback stats');
  });

  // ============================================================
  console.log('\nList shape + counts');
  // ============================================================

  await check('the alert list mixes both sources with explicit typing and live quantities', async () => {
    const r = await alertsAsManager();
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.alerts));
    assert.strictEqual(typeof r.body.lowStockCount, 'number');
    assert.strictEqual(typeof r.body.outOfStockCount, 'number');

    for (const a of r.body.alerts) {
      assert.ok(a.source === 'inventory' || a.source === 'report', `unknown source ${a.source}`);
      if (a.source === 'inventory') {
        assert.strictEqual(a.alertSource, 'system', 'inventory rows must be system-generated');
        assert.strictEqual(a.reportedBy, 'System');
        assert.notStrictEqual(a.currentQuantity, null, 'inventory rows carry the live quantity');
        assert.notStrictEqual(a.minimumQuantity, null, 'inventory rows carry the threshold');
        assert.ok(a.itemId, 'inventory rows are linked to the menu item');
      } else {
        assert.strictEqual(a.alertSource, 'manual', 'report rows must be manual');
      }
    }

    const bread = r.body.alerts.find((a) => a.itemId === String(itemD._id) && a.source === 'inventory');
    assert.ok(bread, 'the still-low Bread item must be listed');
    assert.strictEqual(bread.currentQuantity, 1);
    assert.strictEqual(bread.minimumQuantity, 5);
    assert.ok(r.body.lowStockCount >= 1, 'lowStockCount must count the active low-stock rows');
  });

  await check('every stock change in the workflow left an audit trail', async () => {
    for (const action of [
      'RESTOCK_REQUEST_SUBMITTED',
      'RESTOCK_REQUEST_APPROVED',
      'RESTOCK_REQUEST_REJECTED',
      'RESTOCK_REQUEST_CANCELLED',
      'STOCK_RESTOCKED',
      'STOCK_QUANTITY_SET',
      'ISSUE_REPORT_INVESTIGATED',
    ]) {
      const n = await ActivityLog.countDocuments({ action });
      assert.ok(n >= 1, `expected at least one "${action}" audit entry, found ${n}`);
    }
  });

  await chain;

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log('Failed: ' + failures.join(', '));

  httpServer.close();
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
