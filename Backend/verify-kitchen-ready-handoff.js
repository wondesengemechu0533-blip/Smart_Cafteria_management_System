/**
 * Kitchen READY -> courier pickup handoff.
 *
 * The reported bug, in the courier's words: "after kitchen staff ready, pick up
 * the order, why does it not come to Ready for Delivery and work".
 *
 * It reproduces the REAL sequence against a REAL MongoDB (a throwaway local
 * test database - never the configured Atlas cluster):
 *
 *   manager assigns -> kitchen accepts -> kitchen marks READY -> courier accepts
 *   -> courier picks up
 *
 * The middle step is the dangerous one. `applyDeliveryStatus` maps the
 * pre-pickup transitions (ASSIGNED / ACCEPTED) onto the Order's kitchen stage as
 * PENDING, which is only correct while the kitchen has not started. Writing it
 * unconditionally erased a READY the kitchen had already set, so the order fell
 * out of the courier's "Ready for Delivery" tab, its Pick Up button degraded
 * into a disabled "Waiting for Kitchen", and the pickup API rejected the very
 * order the kitchen had finished with ORDER_NOT_READY.
 *
 * Run: node Backend/verify-kitchen-ready-handoff.js
 */

const assert = require('assert');
const mongoose = require('mongoose');

const TEST_URI = 'mongodb://127.0.0.1:27017/scs_ready_handoff_test';
if (/mongodb\+srv|:\/\/[^/]*@/.test(process.env.MONGODB_URI || '')) {
  console.error('Refusing to run: MONGODB_URI points at a remote cluster.');
  process.exit(1);
}

const Order = require('./src/models/Order');
const User = require('./src/models/User');
const Delivery = require('./src/models/Delivery');
const Notification = require('./src/models/Notification');

// Record socket traffic instead of sending it.
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
const kitchenController = require('./src/controllers/kitchen.controller.js');

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
let cafeteriaId, managerId, staffId, customerId, orderId;

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

function makeReq(user, params) {
  return { user, params: params || {}, query: {}, body: {}, headers: {} };
}

function asUser(id, role) {
  return { id: String(id), role, cafeteriaId, name: 'test' };
}

async function seed() {
  const cafeteria = await mongoose.connection.collection('cafeterias').insertOne({
    name: 'Test Cafeteria',
    code: 'RDY',
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

  managerId = (await mk('Manager', 'mgr@rdy.test', '+251900000001', 'manager'))._id;
  staffId = (await mk('Rider', 'rider@rdy.test', '+251900000002', 'delivery'))._id;
  customerId = (await mk('Customer', 'cust@rdy.test', '+251900000003', 'customer'))._id;

  orderId = `RDY-${Date.now()}`;
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
    User.deleteMany({ email: /@rdy\.test$/ }),
    Order.deleteMany({ orderId }),
    Delivery.deleteMany({ orderId }),
    Notification.deleteMany({ orderId }),
  ]);
}

/** The exact payload the courier's "Ready for Delivery" tab filters on. */
async function courierReadyForDeliveryTab() {
  const res = mockRes();
  await deliveryController.getMyDeliveries(makeReq(asUser(staffId, 'delivery')), res);
  assert.strictEqual(res.statusCode, 200, `/deliveries/mine failed: ${JSON.stringify(res.body)}`);
  const mine = res.body.orders.find((o) => o.orderId === orderId);
  return { mine, list: res.body.orders };
}

/** Mirrors the browser button: ready AND mine AND accepted -> "Pick Up". */
function wouldShowPickUpButton(o) {
  return String(o.status || '').toLowerCase() === 'ready' && o.deliveryAcceptanceStatus === 'ACCEPTED';
}

// ===========================================================================
// The flow
// ===========================================================================

check('manager assignment, kitchen accept, kitchen READY: the order lands in Ready for Delivery', async () => {
  const assign = makeReq(asUser(managerId, 'manager'), { id: orderId });
  assign.body = { deliveryStaffId: String(staffId) };
  const assignRes = mockRes();
  await deliveryController.assignDelivery(assign, assignRes);
  assert.strictEqual(assignRes.statusCode, 200, `assign failed: ${JSON.stringify(assignRes.body)}`);

  const acceptKitchen = mockRes();
  await kitchenController.acceptOrder(makeReq(asUser(managerId, 'manager'), { orderId }), acceptKitchen);
  assert.strictEqual(acceptKitchen.statusCode, 200, `kitchen accept failed: ${JSON.stringify(acceptKitchen.body)}`);

  const readyRes = mockRes();
  await kitchenController.markOrderReady(makeReq(asUser(managerId, 'manager'), { orderId }), readyRes);
  assert.strictEqual(readyRes.statusCode, 200, `kitchen ready failed: ${JSON.stringify(readyRes.body)}`);

  const { mine } = await courierReadyForDeliveryTab();
  assert.ok(mine, `the ready order is missing from /deliveries/mine (got ${JSON.stringify(mine)})`);
  assert.strictEqual(
    String(mine.status).toLowerCase(),
    'ready',
    `the Ready for Delivery tab filters on status "ready", got "${mine.status}"`
  );
});

check('the kitchen tells the ASSIGNED courier the order is ready', async () => {
  const note = await Notification.findOne({ userId: staffId, orderId }).lean();
  assert.ok(
    note,
    'no notification reached the courier: marking an order ready only notified the customer, so the rider had to refresh the page by hand'
  );
  assert.ok(
    emitted.some((e) => e.room === `user:${staffId}` && e.event === 'notification:new'),
    'the courier was not pushed the notification in real time'
  );
  assert.ok(
    emitted.some((e) => e.event === 'delivery:ready-for-pickup'),
    'no delivery:ready-for-pickup broadcast, so the courier dashboard does not re-render'
  );
});

check('ACCEPTING the assignment does not erase the kitchen READY state', async () => {
  const res = mockRes();
  await deliveryController.acceptDelivery(makeReq(asUser(staffId, 'delivery'), { id: orderId }), res);
  assert.strictEqual(res.statusCode, 200, `accept failed: ${JSON.stringify(res.body)}`);

  const order = await Order.findOne({ orderId }).lean();
  assert.strictEqual(
    String(order.status).toLowerCase(),
    'ready',
    `accepting rewrote order.status to "${order.status}": the kitchen had already marked it ready, and a pre-pickup transition must never walk the kitchen stage backwards`
  );
  assert.strictEqual(
    String(order.orderStatus).toUpperCase(),
    'READY',
    `accepting rewrote order.orderStatus to "${order.orderStatus}" for the same reason`
  );
});

check('the order stays in Ready for Delivery after the courier accepts', async () => {
  const { mine } = await courierReadyForDeliveryTab();
  assert.ok(mine, 'the order vanished from /deliveries/mine after accepting');
  assert.strictEqual(
    String(mine.status).toLowerCase(),
    'ready',
    `the order dropped out of the Ready for Delivery tab on accept (status "${mine.status}")`
  );
  assert.ok(
    wouldShowPickUpButton(mine),
    `the Pick Up button is not shown after accept (status "${mine.status}", acceptance "${mine.deliveryAcceptanceStatus}")`
  );
});

check('the courier can actually pick the order up', async () => {
  const res = mockRes();
  await deliveryController.pickUpOrder(makeReq(asUser(staffId, 'delivery'), { id: orderId }), res);
  assert.strictEqual(
    res.statusCode,
    200,
    `pickup was rejected: ${JSON.stringify(res.body)}\n${(lastError && lastError.stack) || ''}`
  );

  const delivery = await Delivery.findOne({ orderId }).lean();
  assert.strictEqual(delivery.status, 'PICKED_UP', 'the delivery did not reach PICKED_UP');
  const order = await Order.findOne({ orderId }).lean();
  assert.strictEqual(String(order.status).toLowerCase(), 'picked_up', 'the order mirror did not follow');
  assert.ok(order.pickedUpTime, 'no pickup timestamp was recorded');
});

check('a re-assignment after pickup cannot drag the order back to pending', async () => {
  const res = mockRes();
  const req = makeReq(asUser(managerId, 'manager'), { id: orderId });
  req.body = { deliveryStaffId: String(staffId) };
  await deliveryController.assignDelivery(req, res);
  assert.ok(res.statusCode >= 200 && res.statusCode < 500, `assign threw: ${JSON.stringify(res.body)}`);

  const order = await Order.findOne({ orderId }).lean();
  assert.notStrictEqual(
    String(order.status).toLowerCase(),
    'pending',
    're-assigning a collected order reset the kitchen stage to pending'
  );
});

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
  console.log('Kitchen READY -> courier pickup handoff\n');
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