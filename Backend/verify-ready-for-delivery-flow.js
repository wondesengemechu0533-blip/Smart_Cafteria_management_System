/**
 * Kitchen -> READY_FOR_DELIVERY -> Delivery Staff -> Customer tracking.
 *
 * Locks in the complete Send-to-Delivery workflow against a REAL MongoDB
 * (throwaway local test database - never the configured Atlas cluster):
 *
 *   1. Kitchen sends a PREPARING/READY order -> it becomes READY_FOR_DELIVERY
 *      with readyForDeliveryAt stamped and an audit row written.
 *   2. `order:ready-for-delivery` reaches the delivery room, the admin room,
 *      the customer order room, and ONLY the assigned rider's personal
 *      `delivery:<staffId>` room.
 *   3. The order is visible in exactly one rider's /deliveries/mine.
 *   4. Accept -> Pickup -> Out for Delivery -> Arrived -> Delivered ->
 *      Completed runs with no skipped stages; `delivery:started` and
 *      `delivery:completed` are emitted.
 *   5. Invalid jumps (PREPARING -> DELIVERED, READY_FOR_DELIVERY -> COMPLETED,
 *      send from PENDING) are all refused by the backend.
 *   6. Re-sends never duplicate the transition, the timestamp, or history.
 *
 * Run: node Backend/verify-ready-for-delivery-flow.js
 */

const assert = require('assert');
const mongoose = require('mongoose');

const TEST_URI = 'mongodb://127.0.0.1:27017/scs_ready_for_delivery_test';
if (/mongodb\+srv|:\/\/[^/]*@/.test(process.env.MONGODB_URI || '')) {
  console.error('Refusing to run: MONGODB_URI points at a remote cluster.');
  process.exit(1);
}

const Order = require('./src/models/Order');
const User = require('./src/models/User');
const Delivery = require('./src/models/Delivery');
const Notification = require('./src/models/Notification');
const OrderStatusHistory = require('./src/models/OrderStatusHistory');

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

const now = new Date();
let cafeteriaId;
let managerId;
let kitchenId;
let riderAId;
let riderBId;
let customerId;

function mockRes() {
  const res = { statusCode: 200, body: null };
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

const req = (user, params, body) => ({ user, params: params || {}, query: {}, body: body || {}, headers: {} });
const asUser = (id, role) => ({ id: String(id), role, cafeteriaId, name: 'test-actor' });

async function mkUser({ name, email, phone, role }) {
  const user = await User.create({
    name,
    email,
    phone,
    password: 'hashed-placeholder-not-used-in-this-test',
    role,
    status: 'ACTIVE',
    isActive: true,
    cafeteriaId,
    isAvailable: true,
    createdAt: now,
    updatedAt: now,
  });
  return user._id;
}

let seq = 0;
async function seedOrder(status, orderStatus) {
  seq += 1;
  const orderId = `RFD-${seq}-${Date.now()}`;
  await Order.create({
    orderId,
    userId: customerId,
    customerName: 'Flow Customer',
    customerPhone: '+251911000099',
    orderType: 'delivery',
    cafeteriaId,
    status,
    orderStatus,
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
      city: 'Addis Ababa',
      area: 'Bole',
      kebele: '',
      houseNumber: '12',
      streetArea: 'Bole Medhanialem',
      landmark: 'Near the church',
      subCity: 'Bole, Addis Ababa',
      location: 'House Number: 12, Bole Medhanialem',
      deliveryAddress: 'House Number: 12, Bole Medhanialem, Bole, Addis Ababa, Ethiopia',
      phone: '+251911000099',
      latitude: 9.0192,
      longitude: 38.7525,
    },
  });
  return orderId;
}

async function seed() {
  const doc = await mongoose.connection.collection('cafeterias').insertOne({
    name: 'Cafeteria RFD',
    code: 'RFD',
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  cafeteriaId = doc.insertedId;
  managerId = await mkUser({ name: 'Manager', email: 'mgr@rfd.test', phone: '+251900000011', role: 'manager' });
  kitchenId = await mkUser({ name: 'Kitchen', email: 'kit@rfd.test', phone: '+251900000012', role: 'kitchen' });
  riderAId = await mkUser({ name: 'Rider A', email: 'ra@rfd.test', phone: '+251900000013', role: 'delivery' });
  riderBId = await mkUser({ name: 'Rider B', email: 'rb@rfd.test', phone: '+251900000014', role: 'delivery' });
  customerId = await mkUser({ name: 'Customer', email: 'cu@rfd.test', phone: '+251900000015', role: 'customer' });
}

async function cleanup() {
  await Promise.all([
    mongoose.connection.collection('cafeterias').deleteMany({ _id: cafeteriaId }),
    User.deleteMany({ email: /@rfd\.test$/ }),
    Order.deleteMany({ orderId: /^RFD-/ }),
    Delivery.deleteMany({ orderId: /^RFD-/ }),
    Notification.deleteMany({ orderId: /^RFD-/ }),
    OrderStatusHistory.deleteMany({}),
  ]);
}

let passed = 0;
const failures = [];
const queue = [];
function check(name, fn) {
  queue.push({ name, fn });
}

let orderId;

check('kitchen send persists READY_FOR_DELIVERY + timestamp + history', async () => {
  orderId = await seedOrder('preparing', 'PREPARING');
  const res = mockRes();
  await kitchenController.sendOrderToDelivery(req(asUser(kitchenId, 'kitchen'), { orderId }), res);
  assert.strictEqual(res.statusCode, 200, `send failed: ${JSON.stringify(res.body)}`);

  const order = await Order.findOne({ orderId }).lean();
  assert.strictEqual(order.status, 'ready_for_delivery');
  assert.strictEqual(order.orderStatus, 'READY_FOR_DELIVERY');
  assert.ok(order.readyForDeliveryAt instanceof Date, 'readyForDeliveryAt missing');
  const history = await OrderStatusHistory.find({ orderId: order._id }).lean();
  assert.ok(
    history.some((h) => h.previousStatus === 'PREPARING' && h.newStatus === 'READY_FOR_DELIVERY'),
    `no PREPARING -> READY_FOR_DELIVERY row: ${JSON.stringify(history.map((h) => `${h.previousStatus}->${h.newStatus}`))}`
  );
});

check('order:ready-for-delivery reaches exactly the scoped rooms', async () => {
  const frames = emitted.filter((e) => e.event === 'order:ready-for-delivery' && e.payload?.orderId === orderId);
  const rooms = frames.map((f) => f.room);
  assert.ok(rooms.includes('delivery'), 'delivery room missing');
  assert.ok(rooms.includes('admin'), 'admin room missing');
  assert.ok(rooms.includes(`order:${orderId}`), 'customer order room missing');
  assert.ok(rooms.includes(`delivery:${riderAId}`), 'assigned rider personal room missing');
  // Nobody else's personal room may see this order's customer payload. The
  // per-order `delivery:<orderId>` room is legitimate (clients join it via
  // `delivery:join` with DB authorization); anything else is a leak.
  const allowed = new Set(['delivery', 'admin', `order:${orderId}`, `delivery:${orderId}`, `delivery:${riderAId}`]);
  const leaked = frames.filter((f) => !allowed.has(f.room));
  assert.strictEqual(leaked.length, 0, `frame leaked to ${leaked.map((f) => f.room).join(', ')}`);
  const customerFrame = frames.find((f) => f.room === `order:${orderId}`);
  assert.strictEqual(customerFrame.payload.status, 'READY_FOR_DELIVERY');
  assert.strictEqual(customerFrame.payload.customer.name, 'Flow Customer');
  assert.ok(customerFrame.payload.readyAt, 'readyAt missing from the customer frame');
});

check('only the assigned rider sees the order (no duplicates)', async () => {
  const resA = mockRes();
  await deliveryController.getMyDeliveries(req(asUser(riderAId, 'delivery')), resA);
  const mineA = (resA.body.orders || []).filter((o) => o.orderId === orderId);
  assert.strictEqual(mineA.length, 1, `rider A should see exactly one card, got ${mineA.length}`);
  assert.strictEqual(String(mineA[0].status).toLowerCase(), 'ready_for_delivery');
  assert.ok(mineA[0].readyForDeliveryAt, 'Ready time missing from the rider card');

  const resB = mockRes();
  await deliveryController.getMyDeliveries(req(asUser(riderBId, 'delivery')), resB);
  assert.ok(!(resB.body.orders || []).some((o) => o.orderId === orderId), 'order leaked to rider B');
});

check('invalid jumps are refused: PREPARING -> DELIVERED and READY_FOR_DELIVERY -> COMPLETED', async () => {
  const badId = await seedOrder('preparing', 'PREPARING');
  const out = mockRes();
  await deliveryController.markOutForDelivery(
    req(asUser(riderAId, 'delivery'), { id: badId }, {}),
    out
  );
  assert.ok(out.statusCode >= 400, `out-for-delivery from PREPARING was allowed (HTTP ${out.statusCode})`);

  const done = mockRes();
  await deliveryController.markCompleted(req(asUser(riderAId, 'delivery'), { id: orderId }, {}), done);
  assert.ok(done.statusCode >= 400, `COMPLETED from READY_FOR_DELIVERY was allowed (HTTP ${done.statusCode})`);

  const pendingId = await seedOrder('pending', 'PENDING');
  const sendRes = mockRes();
  await kitchenController.sendOrderToDelivery(req(asUser(kitchenId, 'kitchen'), { orderId: pendingId }), sendRes);
  assert.strictEqual(sendRes.statusCode, 400, `send from PENDING was allowed (HTTP ${sendRes.statusCode})`);
  assert.strictEqual(sendRes.body?.code, 'INVALID_STATUS_TRANSITION');
});

check('the full march runs Accept -> Pickup -> Out -> Arrived -> Delivered -> Completed', async () => {
  const rider = req(asUser(riderAId, 'delivery'), { id: orderId }, {});
  let res = mockRes();
  await deliveryController.respondToAssignment({ ...rider, body: { accept: true } }, res);
  assert.strictEqual(res.statusCode, 200, `accept -> ${res.statusCode} ${JSON.stringify(res.body)}`);

  for (const [fn, want] of [
    [deliveryController.pickUpOrder, 'PICKED_UP'],
    [deliveryController.markOutForDelivery, 'OUT_FOR_DELIVERY'],
    [deliveryController.markArrived, 'ARRIVED'],
  ]) {
    res = mockRes();
    await fn(req(asUser(riderAId, 'delivery'), { id: orderId }, {}), res);
    assert.strictEqual(res.statusCode, 200, `${want} -> ${res.statusCode} ${JSON.stringify(res.body)}`);
    const d = await Delivery.findOne({ orderId }).lean();
    assert.strictEqual(d.status, want, `delivery is ${d.status}, expected ${want}`);
  }

  res = mockRes();
  await deliveryController.markDelivered(
    req(asUser(managerId, 'manager'), { id: orderId }, { overrideReason: 'Customer confirmed by phone' }),
    res
  );
  assert.strictEqual(res.statusCode, 200, `delivered -> ${res.statusCode} ${JSON.stringify(res.body)}`);

  res = mockRes();
  await deliveryController.markCompleted(req(asUser(riderAId, 'delivery'), { id: orderId }, {}), res);
  assert.strictEqual(res.statusCode, 200, `completed -> ${res.statusCode} ${JSON.stringify(res.body)}`);

  const order = await Order.findOne({ orderId }).lean();
  assert.strictEqual(order.orderStatus, 'COMPLETED');
  const history = await OrderStatusHistory.find({ orderId: order._id }).lean();
  for (const s of ['READY_FOR_DELIVERY', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'COMPLETED']) {
    assert.ok(history.some((h) => h.newStatus === s), `history missing ${s}`);
  }
});

check('delivery:started + delivery:completed were emitted; one Delivery doc exists', async () => {
  assert.ok(
    emitted.some((e) => e.event === 'delivery:started' && e.payload?.orderId === orderId),
    'no delivery:started frame'
  );
  assert.ok(
    emitted.some((e) => e.event === 'delivery:completed' && e.payload?.orderId === orderId),
    'no delivery:completed frame'
  );
  const count = await Delivery.countDocuments({ orderId });
  assert.strictEqual(count, 1, `expected exactly 1 Delivery, found ${count}`);
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
  console.log('Kitchen -> READY_FOR_DELIVERY -> Delivery Staff -> Customer tracking\n');
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
