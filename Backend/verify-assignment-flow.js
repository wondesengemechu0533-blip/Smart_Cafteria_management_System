/**
 * Manager -> Delivery Staff Assignment flow verification.
 *
 * Exercises the REAL controllers against a REAL MongoDB (a throwaway local
 * test database - never the configured Atlas cluster) so the persisted
 * documents, the authenticated-user scoping and the Socket.IO rooms are all
 * verified for real rather than mocked.
 *
 * Run: node Backend/verify-assignment-flow.js
 */

const assert = require('assert');
const path = require('path');
const mongoose = require('mongoose');

// Always a throwaway LOCAL database. If MONGODB_URI points at a remote cluster
// this test refuses to run so it can never touch real data.
const TEST_URI = 'mongodb://127.0.0.1:27017/scs_assignment_flow_test';
if (/mongodb\+srv|:\/\/[^/]*@/.test(process.env.MONGODB_URI || '')) {
  console.error('Refusing to run: MONGODB_URI points at a remote cluster.');
  process.exit(1);
}

const Order = require('./src/models/Order');
const User = require('./src/models/User');
const Delivery = require('./src/models/Delivery');

let passed = 0;
const failures = [];
const queue = [];
function check(name, fn) {
  queue.push({ name, fn });
}

// --- Socket capture ---------------------------------------------------------
// The controllers emit through utils/socket.js. We swap the module export in
// require.cache so every emitSocketEvent call is recorded instead of sent.
const socketUtilsPath = require.resolve('./src/utils/socket.js');
const emitted = [];
const realSocket = require(socketUtilsPath);
const fakeSocket = Object.assign({}, realSocket, {
  emitSocketEvent: (room, event, payload) => {
    emitted.push({ room, event, payload });
    return true;
  },
});
require.cache[socketUtilsPath].exports = fakeSocket;

const deliveryController = require('./src/controllers/delivery.controller.js');
const deliveryService = require('./src/services/delivery.service.js');
const kitchenController = require('./src/controllers/kitchen.controller.js');

// Capture the last controller-side exception so a 500 in the test can show the
// real server stack instead of just the client-visible message.
let lastError = null;
const realConsoleError = console.error;
console.error = function (...args) {
  const err = args.find((a) => a instanceof Error);
  if (err) lastError = err;
  return realConsoleError.apply(console, args);
};

// --- Fixtures ---------------------------------------------------------------
const now = new Date();
let cafeteriaId, managerId, staffId, otherStaffId, customerId, orderId, orderDocId;

const cafeteriaDoc = {
  name: 'Test Cafeteria',
  code: 'TST',
  isActive: true,
  createdAt: now,
  updatedAt: now,
};

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

function makeReq(user, params, query) {
  return { user, params: params || {}, query: query || {}, body: {}, headers: {} };
}

async function seed() {
  const cafeteria = await mongoose.connection.collection('cafeterias').insertOne(cafeteriaDoc);
  cafeteriaId = cafeteria.insertedId;

  const mk = (over) => ({
    name: over.name,
    email: over.email,
    phone: over.phone,
    password: 'hashed-placeholder-not-used-in-this-test',
    role: over.role,
    status: 'ACTIVE',
    isActive: true,
    cafeteriaId: over.cafeteriaId,
    createdAt: now,
    updatedAt: now,
  });

  const mgr = await User.create(mk({ name: 'Manager', email: 'mgr@t.test', phone: '+251900000001', role: 'manager', cafeteriaId }));
  const staff = await User.create(mk({ name: 'Rider One', email: 'rider1@t.test', phone: '+251900000002', role: 'delivery', cafeteriaId }));
  const staff2 = await User.create(mk({ name: 'Rider Two', email: 'rider2@t.test', phone: '+251900000003', role: 'delivery', cafeteriaId }));
  const cust = await User.create(mk({ name: 'Customer', email: 'cust@t.test', phone: '+251900000004', role: 'customer', cafeteriaId }));

  managerId = mgr._id;
  staffId = staff._id;
  otherStaffId = staff2._id;
  customerId = cust._id;

  orderId = `TST-${Date.now()}`;
  const order = await Order.create({
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
    subtotal: 120,
    serviceFee: 0,
    deliveryFee: 30,
    totalAmount: 150,
    orderDate: now,
    orderTime: now,
    items: [
      { itemId: new mongoose.Types.ObjectId(), name: 'Shiro', quantity: 2, price: 60, subtotal: 120 },
    ],
    deliveryInfo: {
      subCity: 'Bole',
      location: 'Bole Medhanialem',
      deliveryAddress: 'Bole Medhanialem',
      phone: '+251900000000',
      latitude: 9.0192,
      longitude: 38.7525,
    },
  });
  orderDocId = order._id;

  await Delivery.create({
    order: order._id,
    orderId,
    customer: customerId,
    cafeteriaId,
    status: 'REQUESTED',
    deliveryPerson: null,
    pickupLocation: { name: 'Test Cafeteria', address: 'Cafe St', latitude: 9.03, longitude: 38.74 },
    destination: {
      contactName: 'Customer',
      phone: '+251900000000',
      subCity: 'Bole',
      address: 'Bole Medhanialem',
      latitude: 9.0192,
      longitude: 38.752,
      hasCoordinates: true,
    },
    latitude: 9.0192,
    longitude: 38.7525,
    totalAmount: 150,
    subtotal: 120,
    deliveryFee: 30,
    paymentStatus: 'PAID',
  });
}

function freshUser(id, role) {
  return { id: String(id), role, cafeteriaId, name: 'x' };
}

async function cleanup() {
  await Promise.all([
    mongoose.connection.collection('cafeterias').deleteMany({ _id: cafeteriaId }),
    User.deleteMany({ email: /@t\.test$/ }),
    Order.deleteMany({ orderId }),
    Delivery.deleteMany({ orderId }),
  ]);
}

// ===========================================================================
// The flow
// ===========================================================================

check('manager assignment persists the staff id on Delivery AND Order', async () => {
  emitted.length = 0;
  const req = makeReq(freshUser(managerId, 'manager'), { id: orderId });
  req.body = { deliveryStaffId: String(staffId) };
  const res = mockRes();
  await deliveryController.assignDelivery(req, res);

  assert.strictEqual(res.statusCode, 200, `assign failed: ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.success, true);

  // Real MongoDB read-back - not the in-memory object.
  const delivery = await Delivery.findOne({ orderId }).lean();
  const order = await Order.findOne({ orderId }).lean();

  assert.ok(delivery.deliveryPerson, 'Delivery.deliveryPerson was not saved');
  assert.strictEqual(String(delivery.deliveryPerson), String(staffId), 'Delivery.deliveryPerson is not the assigned staff id');
  assert.strictEqual(delivery.status, 'ASSIGNED', 'Delivery.status is not ASSIGNED');
  assert.ok(delivery.assignedAt, 'Delivery.assignedAt not set');

  assert.ok(order.deliveryStaffAssigned, 'Order.deliveryStaffAssigned was not saved');
  assert.strictEqual(String(order.deliveryStaffAssigned), String(staffId), 'Order.deliveryStaffAssigned is not the assigned staff id');
  assert.ok(order.delivery, 'Order.delivery reference not set');
  assert.strictEqual(String(order.delivery), String(delivery._id), 'Order.delivery does not reference the Delivery doc');
  assert.ok(order.deliveryAssignedAt, 'Order.deliveryAssignedAt not set');
});

check('delivery:assigned is emitted to the assigned staff personal room', async () => {
  const toUser = emitted.filter(
    (e) => e.event === 'delivery:assigned' && e.room === `user:${staffId}`
  );
  assert.ok(toUser.length === 1, `expected exactly 1 delivery:assigned to user:${staffId}, got ${toUser.length}`);
  assert.strictEqual(toUser[0].payload.orderId, orderId, 'payload carries the wrong orderId');
});

check('assigned delivery appears in the assigned rider\'s /deliveries/mine', async () => {
  const req = makeReq(freshUser(staffId, 'delivery'));
  const res = mockRes();
  await deliveryController.getMyDeliveries(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.orders), 'orders is not an array');
  const found = res.body.orders.find((o) => o.orderId === orderId);
  assert.ok(found, `assigned delivery missing from /deliveries/mine (got ${res.body.orders.length} orders)`);
});

check('the delivery is NOT leaked to a different rider', async () => {
  const req = makeReq(freshUser(otherStaffId, 'delivery'));
  const res = mockRes();
  await deliveryController.getMyDeliveries(req, res);
  const found = res.body.orders.find((o) => o.orderId === orderId);
  assert.ok(!found, 'delivery leaked to a rider who was never assigned it');
});

check('the rider payload carries the data the dashboard card needs', async () => {
  const req = makeReq(freshUser(staffId, 'delivery'));
  const res = mockRes();
  await deliveryController.getMyDeliveries(req, res);
  const found = res.body.orders.find((o) => o.orderId === orderId);

  assert.ok(found.orderId, 'no order number');
  assert.ok(found.customerName, 'no customer name');
  assert.ok(found.deliveryAddress, 'no delivery address');
  assert.ok(Number(found.totalAmount) === 150, `no order amount (got ${found.totalAmount})`);
  assert.ok(found.status, 'no status');
  assert.ok(found.deliveryAssignedAt, 'no assigned time');
  assert.strictEqual(found.deliveryPersonId, String(staffId), 'deliveryPersonId is not the authenticated staff id');
});

check('the payload reports ASSIGNED so the dashboard can show "Assigned"', async () => {
  const req = makeReq(freshUser(staffId, 'delivery'));
  const res = mockRes();
  await deliveryController.getMyDeliveries(req, res);
  const found = res.body.orders.find((o) => o.orderId === orderId);

  // The Order mirrors ASSIGNED/ACCEPTED onto PENDING, so `status` alone cannot
  // distinguish them. `deliveryStatus` is the authoritative delivery state.
  assert.strictEqual(
    found.deliveryStatus,
    'ASSIGNED',
    `deliveryStatus should be ASSIGNED, got ${found.deliveryStatus} (status=${found.status})`
  );
});

check('ACCEPTED is reported after the rider accepts', async () => {
  const req = makeReq(freshUser(staffId, 'delivery'), { id: orderId });
  req.body = { accept: true };
  const res = mockRes();
  await deliveryController.respondToAssignment(req, res);
  assert.strictEqual(res.statusCode, 200, `accept failed: ${JSON.stringify(res.body)}`);

  const mine = mockRes();
  await deliveryController.getMyDeliveries(makeReq(freshUser(staffId, 'delivery')), mine);
  const found = mine.body.orders.find((o) => o.orderId === orderId);
  assert.ok(found, 'delivery vanished from /mine after accepting');
  assert.strictEqual(found.deliveryStatus, 'ACCEPTED', `expected ACCEPTED, got ${found.deliveryStatus}`);
  assert.strictEqual(found.deliveryAcceptanceStatus, 'ACCEPTED');
});

check('every delivery state is reported distinctly (req 13)', async () => {
  // A courier may only pick up once the kitchen has actually finished the food.
  // Drive that through the real kitchen endpoint so the prerequisite is genuine.
  const kitchen = await User.create({
    name: 'Chef',
    email: 'chef@t.test',
    phone: '+251900000006',
    password: 'hashed-placeholder-not-used-in-this-test',
    role: 'kitchen',
    status: 'ACTIVE',
    isActive: true,
    cafeteriaId,
  });
  const kreq = freshUser(kitchen._id, 'kitchen');
  // Real kitchen sequence: PENDING -> PREPARING (accept) -> READY.
  const acceptRes = mockRes();
  await kitchenController.acceptOrder(
    { user: kreq, params: { orderId }, body: {}, headers: {} },
    acceptRes
  );
  assert.strictEqual(acceptRes.statusCode, 200, `kitchen accept failed: ${JSON.stringify(acceptRes.body)}`);

  const readyRes = mockRes();
  await kitchenController.markOrderReady(
    { user: kreq, params: { orderId }, body: {}, headers: {} },
    readyRes
  );
  assert.strictEqual(readyRes.statusCode, 200, `kitchen ready failed: ${JSON.stringify(readyRes.body)}`);

  const seen = {};
  const steps = [
    ['pickup', 'pickUpOrder', 'PICKED_UP'],
    ['out', 'markOutForDelivery', 'OUT_FOR_DELIVERY'],
    ['arrived', 'markArrived', 'ARRIVED'],
  ];
  for (const [label, fn, expect] of steps) {
    const res = mockRes();
    await deliveryController[fn](makeReq(freshUser(staffId, 'delivery'), { id: orderId }), res);
    assert.strictEqual(res.statusCode, 200, `${label} failed: ${JSON.stringify(res.body)}\n${(lastError && lastError.stack) || ''}`);
    const mine = mockRes();
    await deliveryController.getMyDeliveries(makeReq(freshUser(staffId, 'delivery')), mine);
    const found = mine.body.orders.find((o) => o.orderId === orderId);
    seen[label] = found && found.deliveryStatus;
    assert.strictEqual(seen[label], expect, `${label}: expected ${expect}, got ${seen[label]}`);
  }
  const all = new Set([seen.pickup, seen.out, seen.arrived]);
  assert.strictEqual(all.size, 3, `states collapsed into ${[...all].join(',')}`);
});

check('a delivered order stays active until completed, then moves to history', async () => {
  // DELIVERED is proven handover but NOT terminal: the courier still owns the
  // order and closes it out with one more tap. It must therefore stay on the
  // active list - if it left there, the Complete Delivery button would have no
  // row left to sit on and the order could never be finalised. COMPLETED is the
  // state that moves it to history.
  const otpRes = mockRes();
  await deliveryController.generateOtp(makeReq(freshUser(staffId, 'delivery'), { id: orderId }), otpRes);
  assert.strictEqual(otpRes.statusCode, 200, `generateOtp failed: ${JSON.stringify(otpRes.body)}`);

  const stored = await Delivery.findOne({ orderId }).lean();
  assert.ok(stored.customerOtp, 'no OTP was stored on the Delivery');

  const res = mockRes();
  const delivReq = makeReq(freshUser(staffId, 'delivery'), { id: orderId });
  // The customer reads the code out; the courier submits it.
  delivReq.body = { otp: stored.customerOtp };
  await deliveryController.markDelivered(delivReq, res);
  assert.strictEqual(res.statusCode, 200, `deliver failed: ${JSON.stringify(res.body)}\n${(lastError && lastError.stack) || ''}`);

  const afterDeliver = mockRes();
  await deliveryController.getMyDeliveries(makeReq(freshUser(staffId, 'delivery')), afterDeliver);
  const activeRow = afterDeliver.body.orders.find((o) => o.orderId === orderId);
  assert.ok(activeRow, 'a delivered order vanished from the active list before it was completed');
  assert.strictEqual(
    String(activeRow.deliveryStatus).toUpperCase(),
    'DELIVERED',
    `the active row should read DELIVERED, got ${activeRow.deliveryStatus}`
  );

  const histBefore = mockRes();
  await deliveryController.getMyDeliveryHistory(makeReq(freshUser(staffId, 'delivery')), histBefore);
  assert.ok(
    !histBefore.body.orders.find((o) => o.orderId === orderId),
    'an unfinished (DELIVERED) order is already in history: active and history overlap'
  );

  // The courier's final tap.
  const done = mockRes();
  await deliveryController.markCompleted(makeReq(freshUser(staffId, 'delivery'), { id: orderId }), done);
  assert.strictEqual(done.statusCode, 200, `complete failed: ${JSON.stringify(done.body)}\n${(lastError && lastError.stack) || ''}`);

  const mine = mockRes();
  await deliveryController.getMyDeliveries(makeReq(freshUser(staffId, 'delivery')), mine);
  assert.ok(
    !mine.body.orders.find((o) => o.orderId === orderId),
    'a completed order is still listed as active'
  );

  const hist = mockRes();
  await deliveryController.getMyDeliveryHistory(makeReq(freshUser(staffId, 'delivery')), hist);
  const histRow = hist.body.orders.find((o) => o.orderId === orderId);
  assert.ok(histRow, 'completed order missing from history');
  assert.strictEqual(
    String(histRow.deliveryStatus).toUpperCase(),
    'COMPLETED',
    `history row should read COMPLETED, got ${histRow.deliveryStatus}`
  );
});

check('no duplicate rows for a single order (req 15)', async () => {
  const res = mockRes();
  await deliveryController.getMyDeliveries(makeReq(freshUser(staffId, 'delivery')), res);
  const ids = res.body.orders.map((o) => o.orderId);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  assert.strictEqual(dupes.length, 0, `duplicate orderIds in /mine: ${[...new Set(dupes)]}`);
  const deliveries = await Delivery.countDocuments({ orderId });
  assert.strictEqual(deliveries, 1, `expected exactly 1 Delivery doc, found ${deliveries}`);
});

check('a rider with no assignments gets an empty list (req 16)', async () => {
  const fresh = await User.create({
    name: 'Rider Three',
    email: 'rider3@t.test',
    phone: '+251900000005',
    password: 'hashed-placeholder-not-used-in-this-test',
    role: 'delivery',
    status: 'ACTIVE',
    isActive: true,
    cafeteriaId,
  });
  const res = mockRes();
  await deliveryController.getMyDeliveries(makeReq(freshUser(fresh._id, 'delivery')), res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.orders, [], 'expected an empty active list for an unassigned rider');
});

check('assignment rejects a non-delivery user (no cross-role leak)', async () => {
  const res = mockRes();
  const req = makeReq(freshUser(managerId, 'manager'), { id: orderId });
  req.body = { deliveryStaffId: String(customerId) };
  await deliveryController.assignDelivery(req, res);
  assert.ok(res.statusCode >= 400, `expected a 4xx, got ${res.statusCode}`);
  const order = await Order.findOne({ orderId }).lean();
  assert.strictEqual(String(order.deliveryStaffAssigned), String(staffId), 'a bad assignment overwrote the good one');
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
  console.log('Connected to local test DB');
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
