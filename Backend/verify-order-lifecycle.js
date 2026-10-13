/**
 * The order lifecycle, end to end, against a REAL MongoDB:
 *
 *   customer places order -> payment successful -> order = PENDING ->
 *   Kitchen Dashboard -> PREPARING -> READY -> Delivery Staff Dashboard
 *   (new delivery order) -> ACCEPT -> PICKED UP -> OUT FOR DELIVERY ->
 *   DELIVERED -> order = COMPLETED -> Delivery History
 *
 * The parts this exists to lock down (they were the gaps):
 *   - an UNPAID order is invisible on the kitchen board AND cannot be accepted
 *     (409 PAYMENT_REQUIRED);
 *   - a confirmed payment releases it: PENDING/PENDING + OrderStatusHistory +
 *     `order:new` to the kitchen room + a durable kitchen notification;
 *   - every kitchen transition writes BOTH status fields and an audit row;
 *   - the courier chain mirrors onto the order and ends at COMPLETED, which is
 *     what Delivery History reads.
 *
 * Run: node Backend/verify-order-lifecycle.js  (or npm run verify:lifecycle)
 * Uses a throwaway local test database - never the configured cluster.
 */

const mongoose = require('mongoose');

const TEST_URI = 'mongodb://127.0.0.1:27017/scs_order_lifecycle_test';
if (/mongodb\+srv|:\/\/[^/]*@/.test(process.env.MONGODB_URI || '')) {
  console.error('Refusing to run: MONGODB_URI points at a remote cluster.');
  process.exit(1);
}

const Order = require('./src/models/Order');
const User = require('./src/models/User');
const Delivery = require('./src/models/Delivery');
const OrderStatusHistory = require('./src/models/OrderStatusHistory');

let passed = 0;
const failures = [];
const queue = [];
function check(name, fn) {
  queue.push({ name, fn });
}

// --- Socket capture ---------------------------------------------------------
const socketUtilsPath = require.resolve('./src/utils/socket.js');
const emitted = [];
const realSocket = require(socketUtilsPath);
require.cache[socketUtilsPath].exports = Object.assign({}, realSocket, {
  emitSocketEvent: (room, event, payload) => {
    emitted.push({ room, event, payload });
    return true;
  },
});

const kitchenController = require('./src/controllers/kitchen.controller.js');
const deliveryController = require('./src/controllers/delivery.controller.js');
const cashierController = require('./src/controllers/cashier.controller.js');

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

const kitchenUser = () => ({ id: String(kitchenId), role: 'kitchen', name: 'Kitchen' });
const managerUser = () => ({ id: String(managerId), role: 'manager', name: 'Manager' });
const riderUser = () => ({ id: String(riderId), role: 'delivery', name: 'Rider' });

// --- Fixtures ---------------------------------------------------------------
const now = new Date();
let cafeteriaId;
let kitchenId, managerId, riderId, customerId;
let orderId, orderDocId;

const mkUser = (o) => ({
  name: o.name,
  email: o.email,
  phone: o.phone,
  password: 'order-lifecycle-test-password',
  role: o.role,
  status: 'ACTIVE',
  isActive: true,
  cafeteriaId,
  createdAt: now,
  updatedAt: now,
});

async function seed() {
  const c = await mongoose.connection.collection('cafeterias').insertOne({
    name: 'Lifecycle Cafe',
    code: 'LCF',
    isActive: true,
    address: 'Bole Main St, Addis Ababa',
    latitude: 9.03,
    longitude: 38.74,
    phone: '+251911000101',
    createdAt: now,
    updatedAt: now,
  });
  cafeteriaId = c.insertedId;

  kitchenId = (await User.create(mkUser({ name: 'LC Kitchen', email: 'lck@t.test', phone: '+251911000020', role: 'kitchen' })))._id;
  managerId = (await User.create(mkUser({ name: 'LC Manager', email: 'lcm@t.test', phone: '+251911000021', role: 'manager' })))._id;
  riderId = (await User.create(mkUser({ name: 'LC Rider', email: 'lcr@t.test', phone: '+251911000022', role: 'delivery' })))._id;
  customerId = (await User.create(mkUser({ name: 'LC Customer', email: 'lcc@t.test', phone: '+251911000023', role: 'customer' })))._id;

  // Exactly what POST /api/orders writes before any payment: PENDING/PENDING
  // with paymentStatus PENDING, for a delivery order.
  orderId = `LC-${Date.now()}`;
  const order = await Order.create({
    orderId,
    clientOrderId: `lc-client-${Date.now()}`,
    userId: customerId,
    customerName: 'LC Customer',
    customerPhone: '+251911000023',
    orderType: 'delivery',
    cafeteriaId,
    status: 'pending',
    orderStatus: 'PENDING',
    paymentStatus: 'PENDING',
    paymentMethod: 'CHAPA',
    subtotal: 120,
    serviceFee: 0,
    deliveryFee: 30,
    totalAmount: 150,
    orderDate: now,
    orderTime: now,
    items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Shiro', quantity: 2, price: 60, subtotal: 120 }],
    deliveryInfo: {
      subCity: 'Bole',
      location: 'Bole Medhanialem',
      deliveryAddress: 'Bole Medhanialem, House 12',
      phone: '+251911000023',
      latitude: 9.0192,
      longitude: 38.7525,
    },
  });
  orderDocId = order._id;
}

async function cleanup() {
  await Promise.all([
    mongoose.connection.collection('cafeterias').deleteMany({ _id: cafeteriaId }),
    User.deleteMany({ email: { $in: ['lck@t.test', 'lcm@t.test', 'lcr@t.test', 'lcc@t.test'] } }),
    Order.deleteMany({ orderId }),
    Delivery.deleteMany({ orderId }),
    OrderStatusHistory.deleteMany({ orderId: orderDocId }),
  ]);
}

// --- The lifecycle ----------------------------------------------------------

check('1. the unpaid order does NOT appear on the Kitchen Dashboard', async () => {
  const res = await mockRes();
  await kitchenController.getKitchenDashboard(makeReq(kitchenUser()), res);
  if (res.statusCode !== 200) throw new Error(`getKitchenDashboard -> ${res.statusCode}`);
  const board = res.body.orders || {};
  const seen = ['pending', 'preparing', 'ready', 'cancelled'].flatMap((k) => board[k] || []);
  if (seen.some((o) => o.orderId === orderId)) {
    throw new Error('an unpaid order is showing on the kitchen board');
  }
  if (res.body.stats.pending !== 0) throw new Error(`stats.pending should be 0, got ${res.body.stats.pending}`);
});

check('2. the kitchen cannot start cooking an unpaid order (409 PAYMENT_REQUIRED)', async () => {
  const res = await mockRes();
  await kitchenController.acceptOrder(makeReq(kitchenUser(), { orderId }), res);
  if (res.statusCode !== 409 || res.body?.code !== 'PAYMENT_REQUIRED') {
    throw new Error(`expected 409 PAYMENT_REQUIRED, got ${res.statusCode} ${JSON.stringify(res.body)}`);
  }
  const o = await Order.findById(orderDocId);
  if (o.status !== 'pending' || o.orderStatus !== 'PENDING') throw new Error('the unpaid order was mutated');
});

check('3. payment confirmed -> the order is released to the kitchen queue', async () => {
  // Cashier counter collection is a confirmed payment like any other and is
  // deterministic (no randomised gateway), so it is the path exercised here.
  const res = await mockRes();
  await cashierController.confirmPayment(makeReq(managerUser(), { id: orderId }, {}, { method: 'CASH' }), res);
  if (res.statusCode !== 200) throw new Error(`confirmPayment -> ${res.statusCode} ${res.body?.error || ''}`);

  const o = await Order.findById(orderDocId);
  if (o.paymentStatus !== 'PAID') throw new Error(`paymentStatus should be PAID, got ${o.paymentStatus}`);
  if (o.status !== 'pending' || o.orderStatus !== 'PENDING') {
    throw new Error(`expected pending/PENDING after release, got ${o.status}/${o.orderStatus}`);
  }
  if (!o.queuedForKitchenAt) throw new Error('queuedForKitchenAt was not stamped');

  const history = await OrderStatusHistory.find({ orderId: orderDocId }).lean();
  const released = history.find((h) => /payment|cashier/i.test(h.reason || ''));
  if (!released) throw new Error(`no payment-release history row, got ${JSON.stringify(history.map((h) => h.reason))}`);
  if (released.newStatus !== 'PENDING') throw new Error(`release row newStatus should be PENDING, got ${released.newStatus}`);

  const orderNew = emitted.find((e) => e.room === 'kitchen' && e.event === 'order:new' && e.payload?.orderId === orderId);
  if (!orderNew) throw new Error('no order:new frame was emitted to the kitchen room on payment');
});

check('4. the paid order now shows as PENDING on the Kitchen Dashboard', async () => {
  const res = await mockRes();
  await kitchenController.getKitchenDashboard(makeReq(kitchenUser()), res);
  const pending = (res.body.orders?.pending || []).find((o) => o.orderId === orderId);
  if (!pending) throw new Error('the paid order is missing from the pending column');
  if (res.body.stats.pending !== 1) throw new Error(`stats.pending should be 1, got ${res.body.stats.pending}`);
});

check('5. Kitchen -> PREPARING writes both status fields and an audit row', async () => {
  const res = await mockRes();
  await kitchenController.acceptOrder(makeReq(kitchenUser(), { orderId }), res);
  if (res.statusCode !== 200) throw new Error(`acceptOrder -> ${res.statusCode} ${res.body?.error || ''}`);
  const o = await Order.findById(orderDocId);
  if (o.status !== 'preparing' || o.orderStatus !== 'PREPARING') {
    throw new Error(`expected preparing/PREPARING, got ${o.status}/${o.orderStatus}`);
  }
  const row = await OrderStatusHistory.findOne({ orderId: orderDocId, newStatus: 'PREPARING' });
  if (!row) throw new Error('no PENDING -> PREPARING history row');
  if (String(row.changedBy) !== String(kitchenId)) throw new Error('history row is not attributed to the kitchen staff');
});

check('6. Kitchen -> READY writes both status fields and an audit row', async () => {
  const res = await mockRes();
  await kitchenController.markOrderReady(makeReq(kitchenUser(), { orderId }), res);
  if (res.statusCode !== 200) throw new Error(`markOrderReady -> ${res.statusCode} ${res.body?.error || ''}`);
  const o = await Order.findById(orderDocId);
  if (o.status !== 'ready' || o.orderStatus !== 'READY') {
    throw new Error(`expected ready/READY, got ${o.status}/${o.orderStatus}`);
  }
  const row = await OrderStatusHistory.findOne({ orderId: orderDocId, newStatus: 'READY' });
  if (!row) throw new Error('no PREPARING -> READY history row');
});

check('7. Send to Delivery publishes the new delivery order to the staff queue', async () => {
  emitted.length = 0;
  // "Send to Delivery" auto-dispatches to a free rider now; step 8 is this
  // flow's explicit manager assignment, so the only rider in the system is
  // offline for the press of the button (the order stays awaiting dispatch)
  // and back online for the assignment below.
  await User.updateOne({ _id: riderId }, { $set: { status: 'BLOCKED', isActive: false } });
  const res = await mockRes();
  await kitchenController.sendOrderToDelivery(makeReq(kitchenUser(), { orderId }), res);
  await User.updateOne({ _id: riderId }, { $set: { status: 'ACTIVE', isActive: true } });
  if (res.statusCode !== 200) throw new Error(`send-to-delivery -> ${res.statusCode} ${res.body?.error || ''}`);
  const delivery = await Delivery.findOne({ order: orderDocId });
  if (!delivery) throw new Error('no Delivery record was created');
  if (delivery.status !== 'REQUESTED') throw new Error(`expected REQUESTED, got ${delivery.status}`);
  const frame = emitted.find((e) => e.room === 'delivery' && e.event === 'delivery:new' && e.payload?.orderId === orderId);
  if (!frame) throw new Error('the delivery room was not told about the new delivery order');
});

check('8. Delivery Staff -> ACCEPT', async () => {
  let res = await mockRes();
  await deliveryController.assignDelivery(
    makeReq(managerUser(), { id: orderId }, {}, { deliveryStaffId: String(riderId) }),
    res
  );
  if (res.statusCode !== 200) throw new Error(`assign -> ${res.statusCode} ${res.body?.error || ''}`);

  res = await mockRes();
  await deliveryController.respondToAssignment(makeReq(riderUser(), { id: orderId }, {}, { accept: true }), res);
  if (res.statusCode !== 200) throw new Error(`accept -> ${res.statusCode} ${res.body?.error || ''}`);

  const d = await Delivery.findOne({ order: orderDocId });
  if (d.status !== 'ACCEPTED') throw new Error(`expected ACCEPTED, got ${d.status}`);
  const o = await Order.findById(orderDocId);
  if (o.deliveryAcceptanceStatus !== 'ACCEPTED') throw new Error('order is not marked accepted');
});

check('9. PICKED UP -> OUT FOR DELIVERY mirrors onto the order', async () => {
  let res = await mockRes();
  await deliveryController.pickUpOrder(makeReq(riderUser(), { id: orderId }, {}, {}), res);
  if (res.statusCode !== 200) throw new Error(`pickup -> ${res.statusCode} ${res.body?.error || ''}`);
  let o = await Order.findById(orderDocId);
  if (o.status !== 'picked_up' || o.orderStatus !== 'PICKED_UP') {
    throw new Error(`expected picked_up/PICKED_UP, got ${o.status}/${o.orderStatus}`);
  }

  res = await mockRes();
  await deliveryController.markOutForDelivery(makeReq(riderUser(), { id: orderId }, {}, {}), res);
  if (res.statusCode !== 200) throw new Error(`out-for-delivery -> ${res.statusCode} ${res.body?.error || ''}`);
  o = await Order.findById(orderDocId);
  if (o.status !== 'out_for_delivery' || o.orderStatus !== 'OUT_FOR_DELIVERY') {
    throw new Error(`expected out_for_delivery/OUT_FOR_DELIVERY, got ${o.status}/${o.orderStatus}`);
  }
});

check('10. DELIVERED (manager proof override) keeps the order at DELIVERED', async () => {
  let res = await mockRes();
  await deliveryController.markArrived(makeReq(riderUser(), { id: orderId }, {}, {}), res);
  if (res.statusCode !== 200) throw new Error(`arrived -> ${res.statusCode} ${res.body?.error || ''}`);

  res = await mockRes();
  await deliveryController.markDelivered(
    makeReq(managerUser(), { id: orderId }, {}, { overrideReason: 'Customer confirmed by phone' }),
    res
  );
  if (res.statusCode !== 200) throw new Error(`delivered -> ${res.statusCode} ${res.body?.error || ''}`);

  const o = await Order.findById(orderDocId);
  if (o.orderStatus !== 'DELIVERED') throw new Error(`order should be DELIVERED, got ${o.orderStatus}`);
  if (o.status === 'Completed' || o.orderStatus === 'COMPLETED') {
    throw new Error('the order was completed by the handover step alone');
  }
});

check('11. DELIVERED -> COMPLETED finalises the order', async () => {
  const res = await mockRes();
  await deliveryController.markCompleted(makeReq(riderUser(), { id: orderId }, {}, {}), res);
  if (res.statusCode !== 200) throw new Error(`complete -> ${res.statusCode} ${res.body?.error || ''}`);

  const o = await Order.findById(orderDocId);
  if (o.orderStatus !== 'COMPLETED' || o.status !== 'Completed') {
    throw new Error(`expected COMPLETED/Completed, got ${o.orderStatus}/${o.status}`);
  }
  if (!o.completedTime) throw new Error('completedTime was not stamped');

  const d = await Delivery.findOne({ order: orderDocId });
  if (d.status !== 'COMPLETED') throw new Error(`delivery should be COMPLETED, got ${d.status}`);
});

check('12. Delivery History contains the completed order', async () => {
  const res = await mockRes();
  await deliveryController.getMyDeliveryHistory(makeReq(riderUser(), {}, { status: 'completed' }), res);
  if (res.statusCode !== 200) throw new Error(`my-history -> ${res.statusCode} ${res.body?.error || ''}`);
  const row = (res.body.orders || []).find((o) => o.orderId === orderId);
  if (!row) throw new Error('the completed order is missing from the rider history');
});

check('13. the audit trail covers every lifecycle step', async () => {
  const rows = await OrderStatusHistory.find({ orderId: orderDocId }).sort({ createdAt: 1 }).lean();
  const sequence = rows.map((r) => r.newStatus);
  for (const expected of ['PENDING', 'PREPARING', 'READY', 'READY_FOR_DELIVERY', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED']) {
    if (!sequence.includes(expected)) {
      throw new Error(`missing ${expected} in history: ${sequence.join(' -> ')}`);
    }
  }
});

check('14. every payment path releases the order to the kitchen', async () => {
  const fs = require('fs');
  const path = require('path');
  const readers = {
    'chapa.controller.js': fs.readFileSync(path.join(__dirname, 'src/controllers/chapa.controller.js'), 'utf8'),
    'payment.controller.js': fs.readFileSync(path.join(__dirname, 'src/controllers/payment.controller.js'), 'utf8'),
    'cashier.controller.js': fs.readFileSync(path.join(__dirname, 'src/controllers/cashier.controller.js'), 'utf8'),
    'order.controller.js': fs.readFileSync(path.join(__dirname, 'src/controllers/order.controller.js'), 'utf8'),
  };
  for (const name of ['chapa.controller.js', 'payment.controller.js', 'cashier.controller.js']) {
    if (!readers[name].includes('releaseOrderToKitchen')) {
      throw new Error(`${name} does not release the order to the kitchen on payment success`);
    }
  }
  // Order placement must NOT pre-announce the order to the kitchen anymore.
  if (/emitSocketEvent\('kitchen',\s*'order:new'/.test(readers['order.controller.js'])) {
    throw new Error('order.controller.js still emits order:new at placement time');
  }
  if (readers['order.controller.js'].includes('notifyRolesOfNewOrder')) {
    throw new Error('order.controller.js still notifies the kitchen before payment');
  }
});

async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok  ${name}`);
    } catch (e) {
      failures.push({ name, error: e });
      console.log(`  FAIL ${name}`);
      console.log(`       ${e.message}`);
    }
  }
}

(async () => {
  await mongoose.connect(TEST_URI);
  await mongoose.connection.dropDatabase();
  await seed();

  console.log('\nOrder lifecycle: payment -> kitchen -> delivery -> history\n');
  await runAll();

  await cleanup();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
