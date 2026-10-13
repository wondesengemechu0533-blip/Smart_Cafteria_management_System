/**
 * Delivery Staff Dashboard: end-to-end verification of the real-data pipeline.
 *
 * Requirement-by-requirement audit of the courier dashboard, exercised against
 * the REAL controllers / service / socket layer and a REAL MongoDB (a throwaway
 * local database - it refuses to run against a remote cluster).
 *
 * What this proves:
 *   1. no mock data reaches the courier dashboard
 *   2. the list is scoped to the JWT user id, never a hardcoded id
 *   3. a manager's assignment persists on Delivery AND Order
 *   4. unassigned orders are never listed as Active Deliveries
 *   5. the real status sequence is enforced (Ready -> Pickup -> Out -> Arrived
 *      -> Delivered -> Completed)
 *   6. illegal jumps are rejected by the BACKEND, not just hidden in the UI
 *   7. reassignment moves the order between riders
 *   8. completion removes it from Active and lands it in history
 *   9. each transition is broadcast on the socket for the customer tracker
 *
 * Run: node Backend/verify-delivery-staff-dashboard.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const TEST_URI = 'mongodb://127.0.0.1:27017/scs_staff_dashboard_test';
if (/mongodb\+srv|:\/\/[^/]*@/.test(process.env.MONGODB_URI || '')) {
  console.error('Refusing to run: MONGODB_URI points at a remote cluster.');
  process.exit(1);
}

const Order = require('./src/models/Order');
const User = require('./src/models/User');
const Delivery = require('./src/models/Delivery');

const socketUtilsPath = require.resolve('./src/utils/socket.js');
const emitted = [];
const realSocket = require(socketUtilsPath);
require.cache[socketUtilsPath].exports = Object.assign({}, realSocket, {
  emitSocketEvent: (room, event, payload) => {
    emitted.push({ room, event, payload });
    return true;
  },
});

const deliveryController = require('./src/controllers/delivery.controller.js');
const deliveryService = require('./src/services/delivery.service.js');

let lastError = null;
const realConsoleError = console.error;
console.error = function (...args) {
  const err = args.find((a) => a instanceof Error);
  if (err) lastError = err;
  return realConsoleError.apply(console, args);
};

let passed = 0;
const failures = [];
const queue = [];
function check(name, fn) {
  queue.push({ name, fn });
}

const now = new Date();
let cafeteriaId, managerId, riderA, riderB, customerId, orderId;
// The order that was carried all the way to COMPLETED, so the socket check can
// look at the full transition history even after `orderId` is rotated.
let deliveredOrderId = null;

function mockRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  return res;
}

function makeReq(user, params, query, body) {
  return { user, params: params || {}, query: query || {}, body: body || {}, headers: {} };
}

async function seed() {
  const cafeteria = await mongoose.connection.collection('cafeterias').insertOne({
    name: 'Test Cafeteria',
    code: 'DSD',
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  cafeteriaId = cafeteria.insertedId;

  const mk = (name, email, phone, role) =>
    User.create({
      name,
      email,
      phone,
      password: 'hashed-placeholder-not-used-in-this-test',
      role,
      status: 'ACTIVE',
      isActive: true,
      cafeteriaId,
      createdAt: now,
      updatedAt: now,
    });

  managerId = (await mk('Manager', 'mgr@dsd.test', '+251900000001', 'manager'))._id;
  riderA = (await mk('Rider A', 'riderA@dsd.test', '+251900000002', 'delivery'))._id;
  riderB = (await mk('Rider B', 'riderB@dsd.test', '+251900000003', 'delivery'))._id;
  customerId = (await mk('Customer', 'cust@dsd.test', '+251900000004', 'customer'))._id;

  orderId = `DSD-${Date.now()}`;
  await Order.create({
    orderId,
    userId: customerId,
    customerName: 'Customer',
    customerPhone: '+251900000000',
    orderType: 'delivery',
    cafeteriaId,
    status: 'pending',
    orderStatus: 'PENDING',
    paymentStatus: 'PAID',
    paymentMethod: 'CASH',
    subtotal: 100,
    serviceFee: 0,
    deliveryFee: 25,
    totalAmount: 125,
    orderDate: now,
    orderTime: now,
    items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Shiro', quantity: 1, price: 100, subtotal: 100 }],
    deliveryInfo: {
      subCity: 'Bole',
      location: 'Bole Medhanialem',
      deliveryAddress: 'Bole Medhanialem',
      phone: '+251900000000',
      latitude: 9.0192,
      longitude: 38.7525,
    },
  });
}

async function cleanup() {
  await Promise.all([
    mongoose.connection.collection('cafeterias').deleteMany({ _id: cafeteriaId }),
    User.deleteMany({ email: /@dsd\.test$/ }),
    Order.deleteMany({ orderId }),
    Delivery.deleteMany({ orderId }),
  ]);
}

const asManager = () => ({ id: String(managerId), role: 'manager', cafeteriaId, name: 'mgr' });
const asRider = (id) => ({ id: String(id), role: 'delivery', cafeteriaId, name: 'rider' });

async function mine(id) {
  const res = mockRes();
  await deliveryController.getMyDeliveries(makeReq(asRider(id)), res);
  assert.strictEqual(res.statusCode, 200, `getMyDeliveries -> ${res.statusCode}`);
  return res.body.orders || [];
}

async function history(id) {
  const res = mockRes();
  await deliveryController.getMyDeliveryHistory(makeReq(asRider(id)), res);
  assert.strictEqual(res.statusCode, 200, `getMyDeliveryHistory -> ${res.statusCode}`);
  return res.body.orders || [];
}

async function call(fn, id, body) {
  const res = mockRes();
  await fn(makeReq(asRider(id), { id: orderId }, {}, body), res);
  return res;
}

// ===========================================================================
// 1. No mock data anywhere in the courier dashboard
// ===========================================================================

check('the courier dashboard loads no mock/demo data module', () => {
  const page = fs.readFileSync(path.join(__dirname, '../Frontend/src/pages/delivery/deliveries.html'), 'utf8');
  const sources = ['deliveries.js', 'shared.js', 'history.js', 'notifications.js', 'profile.js'].map((f) =>
    fs.readFileSync(path.join(__dirname, '../Frontend/src/js/delivery', f), 'utf8')
  );
  const all = [page, ...sources].join('\n');

  ['mock-orders-data', 'mock-menu-data', 'MOCK_ORDERS', 'MOCK_DELIVER'].forEach((needle) => {
    assert(!all.includes(needle), `the courier dashboard references "${needle}"`);
  });

  // A hardcoded courier id is the classic way demo data leaks in. The only id
  // the page may know is the one it reads from the session.
  assert(
    !/deliveryStaffId\s*[:=]\s*['"][0-9a-f]{8,}/i.test(all),
    'the dashboard hardcodes a delivery staff id instead of using the authenticated user'
  );
  assert(
    !/['"]Demo\s+(Driver|Rider|Courier)/i.test(all),
    'the dashboard contains a demo courier name'
  );

  // Every script the page loads must be a real module. Query-string cache
  // busters (?v=...) are stripped before resolving - they are not files.
  const scripts = [...page.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  scripts.forEach((src) => {
    if (src.startsWith('/public/') || src.includes('vendor')) return;
    const file = String(src).split('?')[0];
    const resolved = path.resolve(path.join(__dirname, '../Frontend/src/pages/delivery', file));
    assert(fs.existsSync(resolved), `deliveries.html loads a script that does not exist: ${src}`);
  });
});

check('the mock order module is not reachable from any delivery page', () => {
  const dir = path.join(__dirname, '../Frontend/src/pages/delivery');
  fs.readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .forEach((f) => {
      const html = fs.readFileSync(path.join(dir, f), 'utf8');
      assert(!html.includes('orders.js'), `${f} loads the mock-backed orders.js`);
    });
});

// ===========================================================================
// 2-4. Assignment, scoping, no unassigned leakage
// ===========================================================================

check('an unassigned order is NOT listed as Active Deliveries for any rider', async () => {
  assert.strictEqual((await mine(riderA)).length, 0, 'rider A sees an unassigned order');
  assert.strictEqual((await mine(riderB)).length, 0, 'rider B sees an unassigned order');
});

check('the manager assignment is saved on BOTH Delivery and Order', async () => {
  const res = mockRes();
  const req = makeReq(asManager(), { id: orderId });
  req.body = { deliveryStaffId: String(riderA) };
  await deliveryController.assignDelivery(req, res);
  assert.strictEqual(res.statusCode, 200, `assign -> ${res.statusCode} ${JSON.stringify(res.body)}`);

  const delivery = await Delivery.findOne({ orderId }).lean();
  const order = await Order.findOne({ orderId }).lean();
  assert.strictEqual(String(delivery.deliveryPerson), String(riderA), 'Delivery.deliveryPerson not saved');
  assert.strictEqual(String(order.deliveryStaffAssigned), String(riderA), 'Order.deliveryStaffAssigned not saved');
  assert.strictEqual(String(order.delivery), String(delivery._id), 'Order.delivery back-reference not saved');
  assert.strictEqual(delivery.status, 'ASSIGNED', `Delivery.status=${delivery.status}`);
});

check('only the ASSIGNED rider sees the order (req 8)', async () => {
  const a = await mine(riderA);
  assert.ok(a.find((o) => o.orderId === orderId), 'rider A cannot see their own assignment');
  const b = await mine(riderB);
  assert.ok(!b.find((o) => o.orderId === orderId), 'rider B can see an order assigned to rider A');
});

check('the assigned row carries the real order detail (req 3)', async () => {
  const row = (await mine(riderA)).find((o) => o.orderId === orderId);
  assert.strictEqual(row.orderId, orderId, 'order number missing');
  assert.strictEqual(row.customerName, 'Customer', 'customer name missing');
  assert.ok(row.customerPhone || (row.deliveryInfo && row.deliveryInfo.phone), 'customer phone missing');
  assert.strictEqual(row.deliveryAddress, 'Bole Medhanialem', 'delivery address missing');
  assert.strictEqual(row.items.length, 1, 'order items missing');
  assert.strictEqual(row.totalAmount, 125, 'order total missing');
  assert.strictEqual(row.deliveryFee, 25, 'delivery fee missing');
  assert.ok(row.deliveryStaffAssigned, 'assigned staff missing');
  assert.ok(row.deliveryStatus, 'delivery status missing');
  assert.ok(row.orderTime || row.createdAt, 'order date/time missing');
  assert.strictEqual(row.hasCoordinates, true, 'GPS coordinates missing for a deliverable address');
  assert.ok(row.latitude && row.longitude, 'latitude/longitude missing');
});

// ===========================================================================
// 5-6. The real sequence, enforced by the backend
// ===========================================================================

check('the backend refuses to skip stages (req 6)', async () => {
  // ASSIGNED only: Out-for-delivery before pickup must be rejected.
  const out = await call(deliveryController.markOutForDelivery, riderA);
  assert.ok(out.statusCode >= 400, `out-for-delivery before pickup was allowed (HTTP ${out.statusCode})`);

  const arrived = await call(deliveryController.markArrived, riderA);
  assert.ok(arrived.statusCode >= 400, `arrived before out-for-delivery was allowed (HTTP ${arrived.statusCode})`);

  const done = await call(deliveryController.markCompleted, riderA);
  assert.ok(done.statusCode >= 400, `completed before delivered was allowed (HTTP ${done.statusCode})`);

  const delivery = await Delivery.findOne({ orderId }).lean();
  assert.strictEqual(delivery.status, 'ASSIGNED', `a rejected transition still moved the status to ${delivery.status}`);
});

check('pickup is refused before the rider accepts AND before the kitchen is ready', async () => {
  // Acceptance is checked first, so an un-accepted rider is turned away here.
  const notAccepted = await call(deliveryController.pickUpOrder, riderA);
  assert.ok(notAccepted.statusCode >= 400, 'pickup was allowed before the rider accepted');

  // Now accept, and the kitchen gate becomes the blocker.
  const accept = await call(deliveryController.acceptDelivery, riderA, { accept: true });
  assert.strictEqual(accept.statusCode, 200, `accept -> ${accept.statusCode} ${JSON.stringify(accept.body)}`);

  const notReady = await call(deliveryController.pickUpOrder, riderA);
  assert.ok(notReady.statusCode >= 400, 'pickup was allowed while the kitchen had not started');
  assert.strictEqual(
    notReady.body.code,
    'ORDER_NOT_READY',
    `expected ORDER_NOT_READY, got ${notReady.body.code} (${notReady.body.error || ''})`
  );

  const delivery = await Delivery.findOne({ orderId }).lean();
  assert.strictEqual(delivery.status, 'ACCEPTED', `a refused pickup still moved the status to ${delivery.status}`);
});

check('a rider cannot act on an order assigned to someone else (req 2)', async () => {
  await Order.updateOne({ orderId }, { $set: { status: 'ready', orderStatus: 'READY' } });
  const res = await call(deliveryController.pickUpOrder, riderB);
  assert.strictEqual(res.statusCode, 403, `rider B picked up rider A's order (HTTP ${res.statusCode})`);
});

check('the full real sequence runs in order and is persisted (req 4)', async () => {
  const steps = [
    [deliveryController.pickUpOrder, 'PICKED_UP'],
    [deliveryController.markOutForDelivery, 'OUT_FOR_DELIVERY'],
    [deliveryController.markArrived, 'ARRIVED'],
  ];
  for (const [fn, expected] of steps) {
    const res = await call(fn, riderA);
    assert.strictEqual(res.statusCode, 200, `${fn.name} -> ${res.statusCode} ${JSON.stringify(res.body)}`);
    const stored = await Delivery.findOne({ orderId }).lean();
    assert.strictEqual(stored.status, expected, `after ${fn.name} the Delivery is ${stored.status}, expected ${expected}`);
    const order = await Order.findOne({ orderId }).lean();
    assert.strictEqual(
      String(order.status).toLowerCase(),
      expected.toLowerCase(),
      `the Order mirror is "${order.status}", expected ${expected}`
    );
  }
});

check('Delivered requires proof of handover, then Completed finalises it', async () => {
  // No OTP yet: the handover cannot be claimed.
  const noProof = await call(deliveryController.markDelivered, riderA);
  assert.ok(noProof.statusCode >= 400, 'delivered was accepted without proof of handover');

  const otpRes = mockRes();
  await deliveryController.generateOtp(makeReq(asRider(riderA), { id: orderId }), otpRes);
  assert.strictEqual(otpRes.statusCode, 200, `generateOtp -> ${otpRes.statusCode}`);
  const stored = await Delivery.findOne({ orderId }).lean();
  assert.ok(stored.customerOtp, 'no OTP stored for the customer to read out');

  const delivered = await call(deliveryController.markDelivered, riderA, { otp: stored.customerOtp });
  assert.strictEqual(delivered.statusCode, 200, `delivered -> ${delivered.statusCode} ${JSON.stringify(delivered.body)}`);

  const done = await call(deliveryController.markCompleted, riderA);
  assert.strictEqual(done.statusCode, 200, `complete -> ${done.statusCode} ${JSON.stringify(done.body)}`);
  const final = await Delivery.findOne({ orderId }).lean();
  assert.strictEqual(final.status, 'COMPLETED', `the Delivery ended at ${final.status}`);
  deliveredOrderId = orderId;
});

check('a completed delivery leaves Active and appears in history (req 13)', async () => {
  const active = await mine(riderA);
  assert.ok(!active.find((o) => o.orderId === orderId), 'a completed delivery is still in Active Deliveries');

  const hist = await history(riderA);
  const row = hist.find((o) => o.orderId === orderId);
  assert.ok(row, 'the completed delivery is missing from Delivery History');
  assert.strictEqual(String(row.deliveryStatus).toUpperCase(), 'COMPLETED', `history status is ${row.deliveryStatus}`);

  // No double-booking between the two lists.
  assert.ok(!active.find((o) => o.orderId === orderId), 'the order is in both Active and History');
});

check('state survives a re-fetch, i.e. after a refresh or re-login (req 7)', async () => {
  const again = await mine(riderA);
  assert.ok(!again.find((o) => o.orderId === orderId), 'the completed order came back on a fresh fetch');
  const hist = await history(riderA);
  assert.strictEqual(
    String(hist.find((o) => o.orderId === orderId).deliveryStatus).toUpperCase(),
    'COMPLETED',
    'the completed status did not survive a re-fetch'
  );
});

// ===========================================================================
// 8. Reassignment moves the order between riders
// ===========================================================================

check('reassigning moves the order from rider A to rider B (req 8)', async () => {
  const firstOrderId = orderId;
  orderId = `DSD2-${Date.now()}`;
  await Order.create({
    orderId,
    userId: customerId,
    customerName: 'Customer',
    customerPhone: '+251900000000',
    orderType: 'delivery',
    cafeteriaId,
    status: 'pending',
    orderStatus: 'PENDING',
    paymentStatus: 'PAID',
    paymentMethod: 'CASH',
    subtotal: 100,
    deliveryFee: 25,
    totalAmount: 125,
    orderDate: now,
    orderTime: now,
    items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Shiro', quantity: 1, price: 100, subtotal: 100 }],
    deliveryInfo: { subCity: 'Bole', deliveryAddress: 'Bole', phone: '+251900000000', latitude: 9.0192, longitude: 38.7525 },
  });

  const assign = (rid) => {
    const res = mockRes();
    const req = makeReq(asManager(), { id: orderId });
    req.body = { deliveryStaffId: String(rid) };
    return deliveryController.assignDelivery(req, res).then(() => res);
  };

  const first = await assign(riderA);
  assert.strictEqual(first.statusCode, 200, `assign A -> ${first.statusCode}`);
  assert.ok((await mine(riderA)).find((o) => o.orderId === orderId), 'rider A cannot see the order assigned to them');
  assert.ok(!(await mine(riderB)).find((o) => o.orderId === orderId), 'rider B sees an order assigned to rider A');

  const second = await assign(riderB);
  assert.strictEqual(second.statusCode, 200, `reassign to B -> ${second.statusCode}`);
  assert.ok(
    !(await mine(riderA)).find((o) => o.orderId === orderId),
    'the order did NOT disappear from rider A after reassignment'
  );
  assert.ok((await mine(riderB)).find((o) => o.orderId === orderId), 'the order did NOT appear for rider B');

  const delivery = await Delivery.findOne({ orderId }).lean();
  assert.strictEqual(String(delivery.deliveryPerson), String(riderB), 'Delivery.deliveryPerson was not moved to rider B');
  assert.strictEqual(
    await Delivery.countDocuments({ orderId }),
    1,
    'reassignment created a second Delivery record for the same order'
  );
});

// ===========================================================================
// 9. Real-time: the customer tracker is told about every transition
// ===========================================================================

check('every transition is broadcast so the customer tracker updates live (req 5/9)', () => {
  const trackedOrderId = deliveredOrderId;
  const room = `order:${trackedOrderId}`;
  const customerRoom = `user:${customerId}`;
  ['delivery:status', 'order:status'].forEach((event) => {
    const hits = emitted.filter((e) => e.event === event && e.room === room);
    assert.ok(hits.length > 0, `no "${event}" broadcast to ${room}`);
  });
  const toCustomer = emitted.filter(
    (e) => (e.room === customerRoom || e.room === room) && e.payload && e.payload.orderId === trackedOrderId
  );
  assert.ok(toCustomer.length > 0, 'nothing was ever broadcast for this order to the customer');

  // Each stage the courier actually passed through must have been announced,
  // otherwise the customer tracker silently freezes mid-delivery.
  ['ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'COMPLETED'].forEach((status) => {
    const seen = emitted.some(
      (e) => e.room === room && e.payload && String(e.payload.deliveryStatus).toUpperCase() === status
    );
    assert.ok(seen, `"${status}" was never broadcast to the customer tracker`);
  });

  // The assignment itself must reach the rider's own room (req 9).
  const assigned = emitted.filter((e) => e.event === 'delivery:assigned' && e.room === `user:${riderA}`);
  assert.ok(assigned.length > 0, 'the assigned rider got no delivery:assigned push');
});

check('the state machine itself forbids every illegal jump (service level)', () => {
  assert.strictEqual(deliveryService.canTransition('ACCEPTED', 'OUT_FOR_DELIVERY'), false);
  assert.strictEqual(deliveryService.canTransition('ACCEPTED', 'ARRIVED'), false);
  assert.strictEqual(deliveryService.canTransition('PICKED_UP', 'ARRIVED'), false);
  assert.strictEqual(deliveryService.canTransition('ARRIVED', 'COMPLETED'), false);
  assert.strictEqual(deliveryService.canTransition('COMPLETED', 'PICKED_UP'), false);
  assert.strictEqual(deliveryService.canTransition('ACCEPTED', 'PICKED_UP'), true);
  assert.strictEqual(deliveryService.canTransition('PICKED_UP', 'OUT_FOR_DELIVERY'), true);
  assert.strictEqual(deliveryService.canTransition('OUT_FOR_DELIVERY', 'ARRIVED'), true);
  assert.strictEqual(deliveryService.canTransition('ARRIVED', 'DELIVERED'), true);
  assert.strictEqual(deliveryService.canTransition('DELIVERED', 'COMPLETED'), true);
});

// ===========================================================================

async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok  ${name}`);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      console.log(`  FAIL ${name}\n       ${error.message}`);
    }
  }
}

(async () => {
  await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 8000 });
  console.log('Delivery Staff Dashboard: real-data end-to-end\n');
  try {
    await mongoose.connection.dropDatabase();
    await seed();
    await runAll();
  } finally {
    await cleanup();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('Harness error:', e);
  process.exit(1);
});