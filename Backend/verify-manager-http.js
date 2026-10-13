/**
 * HTTP-level proof that the Cafeteria Manager Delivery Orders page works.
 *
 * Boots the REAL server (real middleware, real JWT, real routes) against a
 * throwaway LOCAL database, seeds one kitchen-sent order, then drives the exact
 * requests the manager page makes:
 *   GET /api/v1/deliveries            (Delivery Orders table)
 *   GET /api/v1/deliveries/stats      (metric cards)
 *   GET /api/v1/deliveries/staff      (staff <select>)
 *   PATCH /api/v1/deliveries/:id/assign
 *   GET /api/v1/deliveries?report=completed
 * ...and the rider's GET /api/v1/deliveries/mine.
 *
 * Run: node Backend/verify-manager-http.js
 */
const path = require('path');
const mongoose = require('mongoose');

const TEST_DB = 'scs_manager_http_test';
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'manager-http-test-secret';
process.env.NODE_ENV = 'test';

const BASE = 'http://127.0.0.1:5099';
const API = `${BASE}/api/v1`;

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

let server;
let managerToken;
let riderToken;
let orderId;
let orderDocId;
let staffId;
let cafeteriaId;

async function apiGet(pathname, token) {
  const res = await fetch(`${API}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function apiSend(method, pathname, token, payload) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function main() {
  const jwt = require('jsonwebtoken');
  const Order = require('./src/models/Order');
  const User = require('./src/models/User');
  const Delivery = require('./src/models/Delivery');
  const cafeteriaController = require('./src/controllers/cafeteria.controller');
  const kitchenController = require('./src/controllers/kitchen.controller');
  const deliveryController = require('./src/controllers/delivery.controller');

  function mockRes() {
    const res = { statusCode: 200, body: null, headers: {} };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  }
  const mk = (u, p) => ({ user: u, params: p || {}, query: {}, body: {}, headers: {} });

  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  // --- seed a cafeteria, manager, rider, customer and a ready-to-send order ---
  const c = await mongoose.connection.collection('cafeterias').insertOne({
    name: 'HTTP Cafe', code: 'HTTP', isActive: true, status: 'ACTIVE',
    address: 'Bole Main St', latitude: 9.03, longitude: 38.74, phone: '+251920000001',
    createdAt: new Date(), updatedAt: new Date(),
  });
  cafeteriaId = c.insertedId;

  const now = new Date();
  const mkUser = (o) => ({
    name: o.name, email: o.email, phone: o.phone, password: 'http-test-password',
    role: o.role, status: 'ACTIVE', isActive: true, cafeteriaId, createdAt: now, updatedAt: now,
  });
  const mgr = await User.create(mkUser({ name: 'HTTP Manager', email: 'httpm@t.test', phone: '+251920000002', role: 'manager' }));
  const rider = await User.create(mkUser({ name: 'HTTP Rider', email: 'httpr@t.test', phone: '+251920000003', role: 'delivery' }));
  const cust = await User.create(mkUser({ name: 'HTTP Customer', email: 'httpc@t.test', phone: '+251920000004', role: 'customer' }));
  staffId = rider._id;

  managerToken = jwt.sign({ id: String(mgr._id), role: 'manager' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  riderToken = jwt.sign({ id: String(rider._id), role: 'delivery' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  orderId = `HTTP-${Date.now()}`;
  const order = await Order.create({
    orderId,
    clientOrderId: `http-client-${Date.now()}`,
    userId: cust._id, customerName: 'HTTP Customer', customerPhone: '+251920000004',
    orderType: 'delivery', cafeteriaId,
    status: 'preparing', orderStatus: 'PREPARING',
    paymentStatus: 'PAID', paymentMethod: 'CASH',
    subtotal: 150, serviceFee: 0, deliveryFee: 30, totalAmount: 180,
    orderDate: now, orderTime: now,
    items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Kitfo', quantity: 1, price: 150, subtotal: 150 }],
    deliveryInfo: { subCity: 'Bole', location: 'Bole Med', deliveryAddress: 'Bole Med, House 7', phone: '+251920000004', latitude: 9.0192, longitude: 38.7525 },
  });
  orderDocId = order._id;

  // --- boot the REAL server ---
  const { app } = require('./server');
  const http = require('http');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(5099, '127.0.0.1', resolve));

  console.log('\nManager Delivery Orders over real HTTP\n');

  // 1. kitchen READY + Send to Delivery
  await check('kitchen marks the order READY and sends it to delivery', async () => {
    let res = mockRes();
    await kitchenController.markOrderReady(mk({ id: String(mgr._id), role: 'kitchen', cafeteriaId }, { orderId }), res);
    if (res.statusCode !== 200) throw new Error(`ready -> ${res.statusCode} ${res.body?.error || ''}`);
    // "Send to Delivery" auto-dispatches to a free rider now. This check (and
    // the two below) exist to prove the manager's Delivery Orders table still
    // renders an UNASSIGNED ready order, so the only rider in this test is
    // offline while the kitchen presses the button - they come back online for
    // the manager's explicit Assign step further down.
    await User.updateOne({ _id: rider._id }, { $set: { status: 'BLOCKED', isActive: false } });
    res = mockRes();
    await kitchenController.sendOrderToDelivery(mk({ id: String(mgr._id), role: 'kitchen', cafeteriaId }, { orderId }), res);
    if (res.statusCode !== 200) throw new Error(`send -> ${res.statusCode} ${res.body?.error || ''}`);
    await User.updateOne({ _id: rider._id }, { $set: { status: 'ACTIVE', isActive: true } });
    const d = await Delivery.findOne({ order: orderDocId });
    if (!d) throw new Error('no Delivery document created');
    if (d.deliveryPerson) throw new Error('a rider was attached although none was available');
  });

  // 2. the exact request the Delivery Orders table makes
  await check('GET /api/v1/deliveries returns the order (200, not a fetch error)', async () => {
    const { status, body } = await apiGet('/deliveries?status=ALL', managerToken);
    if (status !== 200) throw new Error(`got HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    const row = (body.orders || []).find((o) => o.orderId === orderId);
    if (!row) throw new Error('order missing from the Delivery Orders table');
    if (row.deliveryStaffAssigned) throw new Error('row should be unassigned');
    if (row.deliveryStatus !== 'REQUESTED') throw new Error(`deliveryStatus=${row.deliveryStatus}`);
  });

  await check('GET /api/v1/deliveries/stats populates the metric cards', async () => {
    const { status, body } = await apiGet('/deliveries/stats', managerToken);
    if (status !== 200) throw new Error(`got HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    const s = body.stats || body;
    if (s.unassigned < 1) throw new Error(`unassigned should be >= 1, got ${s.unassigned}`);
  });

  await check('GET /api/v1/deliveries/staff returns selectable riders', async () => {
    const { status, body } = await apiGet('/deliveries/staff', managerToken);
    if (status !== 200) throw new Error(`got HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    const list = body.staff || body.deliveryStaff || [];
    if (!list.some((s) => String(s.id || s._id) === String(staffId))) {
      throw new Error('the rider is not in the staff dropdown');
    }
  });

  // 3. manager assigns
  await check('PATCH /api/v1/deliveries/:id/assign saves the assignment', async () => {
    const { status, body } = await apiSend('PATCH', `/deliveries/${orderId}/assign`, managerToken, { deliveryStaffId: String(staffId) });
    if (status !== 200) throw new Error(`got HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    const o = await Order.findById(orderDocId);
    if (String(o.deliveryStaffAssigned) !== String(staffId)) throw new Error('assignment not saved on the order');
    const d = await Delivery.findById(o.delivery);
    if (String(d.deliveryPerson) !== String(staffId)) throw new Error('assignment not saved on the delivery');
    if (d.status !== 'ASSIGNED') throw new Error(`delivery status=${d.status}`);
  });

  await check('GET /api/v1/deliveries/mine shows the rider the assigned delivery', async () => {
    const { status, body } = await apiGet('/deliveries/mine', riderToken);
    if (status !== 200) throw new Error(`got HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    const row = (body.orders || []).find((o) => o.orderId === orderId);
    if (!row) throw new Error('rider cannot see the assigned delivery');
  });

  // 4. the delivery runs to a terminal state and shows in the completed report
  await check('a terminal order appears in the Completed / Cancelled report', async () => {
    // Real lifecycle: the rider accepts first, then picks up / goes out / arrives.
    let res = mockRes();
    await deliveryController.acceptDelivery(
      {
        ...mk({ id: String(staffId), role: 'delivery', cafeteriaId }, { id: orderId }, {}),
        body: { accept: true },
      },
      res
    );
    if (res.statusCode !== 200) throw new Error(`accept -> ${res.statusCode} ${res.body?.error || ''}`);

    // Pickup additionally requires the kitchen to have marked the order READY.
    // ("Send to Delivery" leaves the order pending-acceptance, so drive the
    // order-facing readiness flag directly the way markOrderReady would.)
    await Order.updateOne(
      { _id: orderDocId },
      { $set: { status: 'ready', orderStatus: 'READY', readyTime: new Date() } }
    );

    for (const fn of [
      deliveryController.pickUpOrder,
      deliveryController.markOutForDelivery,
      deliveryController.markArrived,
    ]) {
      const res2 = mockRes();
      // Populate deliveryStaffAssigned to mirror the list endpoints - this is the
      // shape that used to break the courier notification on failure/cancel.
      const fresh = await Order.findById(orderDocId).populate('deliveryStaffAssigned');
      await fn(
        {
          ...mk({ id: String(staffId), role: 'delivery', cafeteriaId }, { id: orderId }, {}),
          order: fresh,
          delivery: await Delivery.findOne({ order: orderDocId }),
        },
        res2
      );
      if (res2.statusCode !== 200) throw new Error(`${fn.name} -> ${res2.statusCode} ${res2.body?.error || ''}`);
    }
    const { status, body } = await apiGet('/deliveries?report=completed', managerToken);
    if (status !== 200) throw new Error(`got HTTP ${status}`);
    // ARRIVED is still in progress, so it belongs in All Active - verify that.
    const stillActive = (body.orders || []).find((o) => o.orderId === orderId);
    if (stillActive) throw new Error('an arrived order must not be reported as completed yet');

    // Delivered requires proof of handover. The OTP is sent to the customer and
    // deliberately never returned by the API, so drive the documented manager
    // override instead - the same path the UI uses when a courier cannot get
    // the code from the customer.
    const done = await apiSend('PATCH', `/deliveries/${orderId}/delivered`, managerToken, {
      overrideReason: 'Customer unavailable at handover (automated verification)',
    });
    if (done.status !== 200) throw new Error(`delivered -> ${done.status} ${JSON.stringify(done.body).slice(0, 200)}`);

    const after = await apiGet('/deliveries?report=completed', managerToken);
    if (after.status !== 200) throw new Error(`got HTTP ${after.status}`);
    // DELIVERED is proven handover but not final: the courier still has to close
    // it out, so it is deliberately NOT a completed-report row yet.
    if ((after.body.orders || []).some((o) => o.orderId === orderId)) {
      throw new Error('a delivered-but-uncompleted order must not be reported as completed yet');
    }
    // ?status=ACTIVE is the explicit active-list alias (?status=ALL deliberately
    // includes terminal rows, so it is the wrong probe here).
    const stillListed = await apiGet('/deliveries?status=ACTIVE', managerToken);
    if (!(stillListed.body.orders || []).some((o) => o.orderId === orderId)) {
      throw new Error('a delivered order must stay on the active list until the courier completes it');
    }

    // The final courier tap is what makes it terminal.
    const completed = await apiSend('PATCH', `/deliveries/${orderId}/complete`, riderToken);
    if (completed.status !== 200) {
      throw new Error(`complete -> ${completed.status} ${JSON.stringify(completed.body).slice(0, 200)}`);
    }

    const final = await apiGet('/deliveries?report=completed', managerToken);
    if (final.status !== 200) throw new Error(`got HTTP ${final.status}`);
    const row = (final.body.orders || []).find((o) => o.orderId === orderId);
    if (!row) throw new Error('completed order missing from the completed report');
    if (row.deliveryStatus !== 'COMPLETED') throw new Error(`deliveryStatus=${row.deliveryStatus}`);

    // ...and it must be gone from the active list.
    const activeRes = await apiGet('/deliveries?status=ACTIVE', managerToken);
    if ((activeRes.body.orders || []).some((o) => o.orderId === orderId)) {
      throw new Error('completed order still listed as active');
    }
  });

  await check('unauthenticated access to the deliveries list is rejected', async () => {
    const res = await fetch(`${API}/deliveries`, { headers: { Authorization: 'Bearer not-a-real-token' } });
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
  });
}

main()
  .catch((e) => { failures.push('harness'); console.error('FATAL', e); })
  .finally(async () => {
    if (server) await new Promise((r) => server.close(r));
    try { await mongoose.connection.dropDatabase(); } catch { /* ignore */ }
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    console.log(`\n${passed} passed, ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
  });
