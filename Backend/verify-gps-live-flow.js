/**
 * Rider GPS upload -> storage -> broadcast -> dashboard payload.
 *
 * Locks in the live-GPS pipeline against a REAL MongoDB (throwaway local test
 * database - never the configured Atlas cluster):
 *
 *   1. send -> assign -> accept -> pickup reaches PICKED_UP;
 *   2. the assigned rider's upload is stored (DeliveryLocation history),
 *      mirrored (Delivery + Order + User) and broadcast to the per-order
 *      `delivery:<orderId>` / `order:<orderId>` rooms with a timestamp;
 *   3. the rider dashboard payload carries the fix (what the card, the map
 *      and the metrics panel render) with trackingActive true;
 *   4. uploads are refused before pickup (400) and for strangers (403).
 *
 * Run: node Backend/verify-gps-live-flow.js
 */
const assert = require('assert');
const mongoose = require('mongoose');

const TEST_URI = 'mongodb://127.0.0.1:27017/scs_gps_diag_test';
if (/mongodb\+srv|:\/\/[^/]*@/.test(process.env.MONGODB_URI || '')) {
  console.error('Refusing to run: MONGODB_URI points at a remote cluster.');
  process.exit(1);
}

const Order = require('./src/models/Order');
const User = require('./src/models/User');
const Delivery = require('./src/models/Delivery');
const DeliveryLocation = require('./src/models/DeliveryLocation');

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
let cafeteriaId; let managerId; let riderId; let riderBId; let customerId; let kitchenId;
let orderId;

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const req = (user, params, body) => ({ user, params: params || {}, query: {}, body: body || {}, headers: {} });
const asUser = (id, role) => ({ id: String(id), role, cafeteriaId, name: 't' });

async function mkUser(name, email, phone, role) {
  const u = await User.create({
    name, email, phone, password: 'diag-test-password', role, status: 'ACTIVE', isActive: true,
    cafeteriaId, isAvailable: true, createdAt: now, updatedAt: now,
  });
  return u._id;
}

async function seed() {
  const doc = await mongoose.connection.collection('cafeterias').insertOne({
    name: 'Caf GPS', code: 'GPSD', isActive: true, createdAt: now, updatedAt: now,
  });
  cafeteriaId = doc.insertedId;
  kitchenId = await mkUser('Kitchen', 'k@gpsd.test', '+251900000021', 'kitchen');
  managerId = await mkUser('Manager', 'm@gpsd.test', '+251900000025', 'manager');
  riderId = await mkUser('Rider', 'r@gpsd.test', '+251900000022', 'delivery');
  riderBId = await mkUser('Rider2', 'r2@gpsd.test', '+251900000023', 'delivery');
  customerId = await mkUser('Customer', 'c@gpsd.test', '+251900000024', 'customer');
  orderId = `GPS-${Date.now()}`;
  await Order.create({
    orderId, userId: customerId, customerName: 'C', customerPhone: '+251911000099',
    orderType: 'delivery', cafeteriaId, status: 'ready', orderStatus: 'READY',
    paymentStatus: 'PAID', paymentMethod: 'CASH', subtotal: 100, serviceFee: 0,
    deliveryFee: 25, totalAmount: 125, orderDate: now, orderTime: now,
    items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Shiro', quantity: 1, price: 100, subtotal: 100 }],
    deliveryInfo: {
      subCity: 'Bole', location: 'Bole Med', deliveryAddress: 'Bole Med',
      phone: '+251911000099', latitude: 9.0192, longitude: 38.7525,
    },
  });
}

async function cleanup() {
  await mongoose.connection.collection('cafeterias').deleteMany({ _id: cafeteriaId });
  await User.deleteMany({ email: /@gpsd\.test$/ });
  await Order.deleteMany({ orderId: new RegExp('^GPS-') });
  await Delivery.deleteMany({});
  await DeliveryLocation.deleteMany({});
}

let passed = 0; const failures = []; const queue = [];
function check(name, fn) { queue.push({ name, fn }); }

check('setup: send -> assign -> accept -> pickup', async () => {
  let res = mockRes();
  await kitchenController.sendOrderToDelivery(req(asUser(kitchenId, 'kitchen'), { orderId }), res);
  assert.strictEqual(res.statusCode, 200, `send: ${JSON.stringify(res.body)}`);
  const order = await Order.findOne({ orderId }).lean();
  // Force-assign to our rider deterministically.
  res = mockRes();
  await deliveryController.assignDelivery(
    req(asUser(managerId, 'manager'), { id: orderId }, { deliveryStaffId: String(riderId) }), res
  );
  assert.strictEqual(res.statusCode, 200, `assign: ${JSON.stringify(res.body)}`);
  res = mockRes();
  await deliveryController.respondToAssignment(req(asUser(riderId, 'delivery'), { id: orderId }, { accept: true }), res);
  assert.strictEqual(res.statusCode, 200, `accept: ${JSON.stringify(res.body)}`);
  res = mockRes();
  await deliveryController.pickUpOrder(req(asUser(riderId, 'delivery'), { id: orderId }, {}), res);
  assert.strictEqual(res.statusCode, 200, `pickup: ${JSON.stringify(res.body)}`);
  const d = await Delivery.findOne({ orderId }).lean();
  assert.strictEqual(d.status, 'PICKED_UP', `delivery=${d.status}`);
});

check('rider upload stores + mirrors + broadcasts', async () => {
  emitted.length = 0;
  const res = mockRes();
  await deliveryController.updateDeliveryLocation(
    req(asUser(riderId, 'delivery'), { id: orderId }, {
      latitude: 9.005, longitude: 38.763, accuracy: 12, timestamp: Date.now(),
    }), res
  );
  assert.strictEqual(res.statusCode, 200, `upload: ${JSON.stringify(res.body)}`);
  const d = await Delivery.findOne({ orderId }).lean();
  assert.ok(d.currentLocation && d.currentLocation.latitude === 9.005, `delivery mirror: ${JSON.stringify(d.currentLocation)}`);
  const o = await Order.findOne({ orderId }).lean();
  assert.ok(o.currentLocation && o.currentLocation.latitude === 9.005, `order mirror: ${JSON.stringify(o.currentLocation)}`);
  const u = await User.findById(riderId).lean();
  assert.ok(u.lastKnownLocation && u.lastKnownLocation.latitude === 9.005, `user mirror: ${JSON.stringify(u.lastKnownLocation)}`);
  const hist = await DeliveryLocation.countDocuments({ delivery: d._id });
  assert.strictEqual(hist, 1, `history rows=${hist}`);
  const rooms = emitted.filter((e) => e.event === 'delivery:location').map((e) => e.room);
  assert.ok(rooms.includes(`delivery:${orderId}`), `rooms=${rooms}`);
  assert.ok(rooms.includes(`order:${orderId}`), `rooms=${rooms}`);
  const frame = emitted.find((e) => e.event === 'delivery:location');
  assert.strictEqual(frame.payload.latitude, 9.005);
  assert.ok(frame.payload.updatedAt, 'no updatedAt');
});

check('dashboard payload carries the fix (what the card + map render)', async () => {
  const res = mockRes();
  await deliveryController.getMyDeliveries(req(asUser(riderId, 'delivery')), res);
  const row = (res.body.orders || []).find((o) => o.orderId === orderId);
  assert.ok(row, 'missing from /mine');
  const fix = row.deliveryLocation || row.currentLocation || null;
  assert.ok(fix && Number(fix.latitude) === 9.005, `row fix=${JSON.stringify(fix)}`);
  assert.strictEqual(row.trackingActive, true, 'trackingActive false on PICKED_UP');
});

check('upload before pickup is refused (400), stranger rider gets 403', async () => {
  const oid2 = `GPS-PRE-${Date.now()}`;
  await Order.create({
    orderId: oid2, userId: customerId, customerName: 'C', customerPhone: '+251911000099',
    orderType: 'delivery', cafeteriaId, status: 'ready_for_delivery', orderStatus: 'READY_FOR_DELIVERY',
    paymentStatus: 'PAID', paymentMethod: 'CASH', subtotal: 50, serviceFee: 0,
    deliveryFee: 25, totalAmount: 75, orderDate: now, orderTime: now,
    items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Tea', quantity: 1, price: 50, subtotal: 50 }],
    deliveryInfo: { subCity: 'Bole', location: 'X', deliveryAddress: 'X', phone: '+251911000099' },
    deliveryStaffAssigned: riderId,
  });
  await Delivery.create({
    order: (await Order.findOne({ orderId: oid2 }).lean())._id,
    orderId: oid2, customer: customerId, cafeteriaId,
    deliveryPerson: riderId, status: 'ASSIGNED',
    pickupLocation: {}, destination: {},
  });
  const res = mockRes();
  await deliveryController.updateDeliveryLocation(
    req(asUser(riderId, 'delivery'), { id: oid2 }, { latitude: 9.1, longitude: 38.7, accuracy: 10, timestamp: Date.now() }), res
  );
  assert.strictEqual(res.statusCode, 400, `pre-pickup upload -> ${res.statusCode}`);
  const res2 = mockRes();
  await deliveryController.updateDeliveryLocation(
    req(asUser(riderBId, 'delivery'), { id: orderId }, { latitude: 9.1, longitude: 38.7, accuracy: 10, timestamp: Date.now() }), res2
  );
  assert.strictEqual(res2.statusCode, 403, `stranger upload -> ${res2.statusCode}`);
});

async function runAll() {
  for (const { name, fn } of queue) {
    try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
    catch (e) { failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name}\n       ${e.message}`); }
  }
}

(async () => {
  await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 8000 });
  console.log('GPS live flow diagnostic\n');
  try { await mongoose.connection.dropDatabase(); await seed(); await runAll(); }
  finally { await cleanup(); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('Harness error:', e); process.exit(1); });
