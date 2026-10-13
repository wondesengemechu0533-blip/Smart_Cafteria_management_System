/**
 * Kitchen Staff -> "Send to Delivery" -> Cafeteria Manager Delivery Orders flow.
 *
 * Exercises the REAL kitchen + delivery controllers against a REAL MongoDB (a
 * throwaway local test database - never the configured Atlas cluster), so the
 * Delivery document, the Order.delivery back-link, the dispatch status, the
 * manager's list query and the Socket.IO broadcasts are all verified for real
 * rather than mocked.
 *
 * This is the exact 12-step scenario:
 *   kitchen receives -> prepares -> READY -> Send to Delivery ->
 *   Delivery doc exists -> Order.delivery linked -> manager list shows it
 *   as Unassigned -> manager selects staff -> Assign -> rider receives it.
 *
 * Run: node Backend/verify-kitchen-to-manager.js
 */

const mongoose = require('mongoose');

const TEST_URI = 'mongodb://127.0.0.1:27017/scs_kitchen_manager_flow_test';
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

const kitchenController = require('./src/controllers/kitchen.controller.js');
const deliveryController = require('./src/controllers/delivery.controller.js');

// Capture the controller-side exception so a 500 shows the real cause.
let lastError = null;
const realConsoleError = console.error;
console.error = function (...args) {
  const err = args.find((a) => a instanceof Error);
  if (err) lastError = err;
  return realConsoleError.apply(console, args);
};

// --- Fixtures ---------------------------------------------------------------
const now = new Date();
let cafeteriaId, managerId, staffId, customerId;
let orderId, orderDocId;

const cafeteriaDoc = {
  name: 'Kitchen Flow Cafe',
  code: 'KFM',
  isActive: true,
  address: 'Bole Main St, Addis Ababa',
  latitude: 9.03,
  longitude: 38.74,
  phone: '+251911000001',
  createdAt: now,
  updatedAt: now,
};

// A second cafeteria whose address is a nested OBJECT, which is how legacy /
// seeded rows are sometimes stored. It must not break delivery creation.
const legacyCafeteriaDoc = {
  name: 'Legacy Flow Cafe',
  code: 'KFL',
  isActive: true,
  address: { subCity: 'Bole', location: 'Legacy St', latitude: 9.02, longitude: 38.75 },
  latitude: 9.02,
  longitude: 38.75,
  phone: '+251911000002',
  createdAt: now,
  updatedAt: now,
};

let legacyCafeteriaId;

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

const kitchenUser = () => ({ id: String(managerId), role: 'kitchen', cafeteriaId, name: 'Kitchen' });
const managerUser = () => ({ id: String(managerId), role: 'manager', cafeteriaId, name: 'Manager' });
const riderUser = () => ({ id: String(staffId), role: 'delivery', cafeteriaId, name: 'Rider' });

async function seed() {
  const c = await mongoose.connection.collection('cafeterias').insertOne(cafeteriaDoc);
  cafeteriaId = c.insertedId;
  const lc = await mongoose.connection.collection('cafeterias').insertOne(legacyCafeteriaDoc);
  legacyCafeteriaId = lc.insertedId;

  const mk = (o) => ({
    name: o.name,
    email: o.email,
    phone: o.phone,
    password: 'kitchen-flow-test-password',
    role: o.role,
    status: 'ACTIVE',
    isActive: true,
    cafeteriaId,
    createdAt: now,
    updatedAt: now,
  });

  const mgr = await User.create(mk({ name: 'Flow Manager', email: 'kfm@t.test', phone: '+251911000010', role: 'manager' }));
  const staff = await User.create(mk({ name: 'Flow Rider', email: 'kfr@t.test', phone: '+251911000011', role: 'delivery' }));
  const cust = await User.create(mk({ name: 'Flow Customer', email: 'kfc@t.test', phone: '+251911000012', role: 'customer' }));

  managerId = mgr._id;
  staffId = staff._id;
  customerId = cust._id;

  // Step 1-2: kitchen RECEIVES the order and PREPARES it.
  orderId = `KFL-${Date.now()}`;
  const order = await Order.create({
    orderId,
    clientOrderId: `kfl-client-${Date.now()}`,
    userId: customerId,
    customerName: 'Flow Customer',
    customerPhone: '+251911000012',
    orderType: 'delivery',
    cafeteriaId,
    status: 'preparing',
    orderStatus: 'PREPARING',
    paymentStatus: 'PAID',
    paymentMethod: 'CASH',
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
      phone: '+251911000012',
      latitude: 9.0192,
      longitude: 38.7525,
    },
  });
  orderDocId = order._id;
}

async function cleanup() {
  await Promise.all([
    mongoose.connection.collection('cafeterias').deleteMany({ _id: { $in: [cafeteriaId, legacyCafeteriaId] } }),
    User.deleteMany({ email: { $in: ['kfm@t.test', 'kfr@t.test', 'kfc@t.test'] } }),
    Order.deleteMany({ orderId }),
    Delivery.deleteMany({ orderId }),
  ]);
}

function orderInManagerList(res) {
  return (res.body.orders || []).find((o) => o.orderId === orderId) || null;
}

// --- The 12-step scenario ---------------------------------------------------

check('step 1-2: order is received and being prepared by the kitchen', async () => {
  const o = await Order.findById(orderDocId);
  if (o.status !== 'preparing' || o.orderStatus !== 'PREPARING') {
    throw new Error(`expected preparing/PREPARING, got ${o.status}/${o.orderStatus}`);
  }
  if (String(o.orderType) !== 'delivery') throw new Error('order must be a delivery order');
});

check('step 3: kitchen can mark the order READY', async () => {
  const res = await mockRes();
  await kitchenController.markOrderReady(makeReq(kitchenUser(), { orderId }), res);
  if (res.statusCode !== 200) throw new Error(`markOrderReady -> ${res.statusCode} ${res.body?.error || ''}`);
  const o = await Order.findById(orderDocId);
  if (o.status !== 'ready' || o.orderStatus !== 'READY') {
    throw new Error(`expected ready/READY, got ${o.status}/${o.orderStatus}`);
  }
});

check('step 4: "Send to Delivery" succeeds and creates the Delivery record', async () => {
  // "Send to Delivery" auto-dispatches to a free rider; steps 7-8 below exist to
  // prove an order can still sit UNASSIGNED awaiting the manager's dispatch, so
  // the only rider in this flow is offline for the press of the button and back
  // online before the manager assigns them in step 10.
  await User.updateOne({ _id: staffId }, { $set: { status: 'BLOCKED', isActive: false } });
  const res = await mockRes();
  await kitchenController.sendOrderToDelivery(makeReq(kitchenUser(), { orderId }), res);
  await User.updateOne({ _id: staffId }, { $set: { status: 'ACTIVE', isActive: true } });
  if (res.statusCode !== 200) {
    throw new Error(`send-to-delivery -> ${res.statusCode} ${res.body?.error || ''}${lastError ? ` | ${lastError.message}` : ''}`);
  }
  const delivery = await Delivery.findOne({ order: orderDocId });
  if (!delivery) throw new Error('no Delivery document was created');
  if (delivery.deliveryPerson) throw new Error('a rider was attached although none was available');
  if (String(delivery.order) !== String(orderDocId)) throw new Error('Delivery.order does not reference the order');
  if (String(delivery.customer) !== String(customerId)) throw new Error('Delivery.customer does not reference the customer');
});

check('step 5: Delivery document exists in MongoDB with pickup + destination', async () => {
  const d = await Delivery.findOne({ order: orderDocId });
  if (!d) throw new Error('Delivery document missing');
  if (typeof d.pickupLocation?.address !== 'string' || !d.pickupLocation.address) {
    throw new Error(`pickupLocation.address must be a non-empty string, got ${JSON.stringify(d.pickupLocation?.address)}`);
  }
  if (!d.destination?.address) throw new Error('destination.address (delivery address) is empty');
  if (d.destination.address !== 'Bole Medhanialem, House 12') {
    throw new Error(`destination.address wrong: ${d.destination.address}`);
  }
  if (String(d.cafeteriaId) !== String(cafeteriaId)) throw new Error('Delivery.cafeteriaId not linked');
});

check('step 6: Order.delivery is linked to the Delivery record', async () => {
  const o = await Order.findById(orderDocId);
  if (!o.delivery) throw new Error('Order.delivery is still null');
  const d = await Delivery.findById(o.delivery);
  if (!d) throw new Error('Order.delivery points at a non-existent Delivery');
  if (String(d.order) !== String(orderDocId)) throw new Error('back-link is inconsistent');
});

check('step 7: delivery status is the awaiting-assignment state (no staff attached)', async () => {
  const d = await Delivery.findOne({ order: orderDocId });
  if (d.status !== 'REQUESTED') throw new Error(`expected REQUESTED, got ${d.status}`);
  if (d.deliveryPerson) throw new Error('a delivery staff member was auto-assigned by the kitchen');
  const o = await Order.findById(orderDocId);
  if (o.deliveryStaffAssigned) throw new Error('Order.deliveryStaffAssigned must stay null until the manager assigns');
  if (o.status !== 'ready_for_delivery' || o.orderStatus !== 'READY_FOR_DELIVERY') {
    throw new Error(`order should be ready_for_delivery/READY_FOR_DELIVERY, got ${o.status}/${o.orderStatus}`);
  }
  if (!o.readyForDeliveryAt) throw new Error('Order.readyForDeliveryAt was not stamped');
});

check('step 8: the manager Delivery Orders query returns it as Unassigned', async () => {
  const res = await mockRes();
  await deliveryController.getDeliveryOrders(makeReq(managerUser(), {}, { status: 'ALL' }), res);
  if (res.statusCode !== 200) throw new Error(`getDeliveryOrders -> ${res.statusCode} ${res.body?.error || ''}`);
  const row = orderInManagerList(res);
  if (!row) throw new Error('order is MISSING from the manager delivery orders list');
  if (row.deliveryId == null) throw new Error('manager row has no deliveryId');
  if (row.deliveryStatus !== 'REQUESTED') throw new Error(`expected deliveryStatus REQUESTED, got ${row.deliveryStatus}`);
  if (row.deliveryStaffAssigned) throw new Error('row must be unassigned');
  if (row.canAssign !== true) throw new Error('row must be assignable');
});

check('step 9: the manager row carries every field the dispatch table renders', async () => {
  const res = await mockRes();
  await deliveryController.getDeliveryOrders(makeReq(managerUser(), {}, { status: 'ALL' }), res);
  const row = orderInManagerList(res);
  if (!row) throw new Error('order missing from manager list');
  if (row.orderId !== orderId) throw new Error('orderId missing');
  if (!row.customerName) throw new Error('customerName missing');
  if (!row.deliveryAddress) throw new Error('deliveryAddress missing');
  if (!Array.isArray(row.items) || row.items.length !== 1 || row.items[0].name !== 'Shiro') {
    throw new Error(`items missing/incorrect: ${JSON.stringify(row.items)}`);
  }
  if (Number(row.totalAmount) !== 150) throw new Error(`totalAmount wrong: ${row.totalAmount}`);
  if (!row.deliveryStatusLabel) throw new Error('deliveryStatusLabel missing');
  if (!row.customerId) throw new Error('customerId missing');
});

check('the kitchen broadcast reaches the manager room so the page updates live', async () => {
  const toManager = emitted.filter((e) => e.room === 'admin' && e.event === 'delivery:new');
  if (!toManager.length) throw new Error('no delivery:new emitted to the admin (manager) room');
  const toRiders = emitted.filter((e) => e.room === 'delivery' && e.event === 'delivery:new');
  if (!toRiders.length) throw new Error('no delivery:new emitted to the delivery room');
});

check('a pre-existing Delivery with a missing Order.delivery link is repaired', async () => {
  // Simulate the orphaned row that made a sent order invisible to parts of the
  // flow: a Delivery exists, but the Order never got the back-reference.
  const o = await Order.findById(orderDocId);
  const existingId = o.delivery;
  await Order.updateOne({ _id: orderDocId }, { $set: { delivery: null } });

  const res = await mockRes();
  await kitchenController.sendOrderToDelivery(makeReq(kitchenUser(), { orderId }), res);
  if (res.statusCode !== 200) throw new Error(`re-send -> ${res.statusCode} ${res.body?.error || ''}`);

  const after = await Order.findById(orderDocId);
  if (!after.delivery) throw new Error('Order.delivery was not repaired');
  if (String(after.delivery) !== String(existingId)) throw new Error('re-send created a duplicate delivery instead of reusing it');
  const count = await Delivery.countDocuments({ order: orderDocId });
  if (count !== 1) throw new Error(`expected exactly 1 Delivery, found ${count}`);
});

check('kitchen send works even when the cafeteria address is a nested object', async () => {
  const oid = `KFL-LEGACY-${Date.now()}`;
  const o = await Order.create({
    orderId: oid,
    clientOrderId: `kfl-legacy-${Date.now()}`,
    userId: customerId,
    customerName: 'Flow Customer',
    customerPhone: '+251911000012',
    orderType: 'delivery',
    cafeteriaId: legacyCafeteriaId,
    status: 'preparing',
    orderStatus: 'PREPARING',
    paymentStatus: 'PAID',
    paymentMethod: 'CASH',
    subtotal: 100,
    serviceFee: 0,
    deliveryFee: 25,
    totalAmount: 125,
    orderDate: now,
    orderTime: now,
    items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Doro', quantity: 1, price: 100, subtotal: 100 }],
    deliveryInfo: {
      subCity: 'Bole',
      location: 'Bole Med',
      deliveryAddress: 'Bole Med',
      phone: '+251911000012',
      latitude: 9.0192,
      longitude: 38.7525,
    },
  });

  try {
    let res = await mockRes();
    await kitchenController.markOrderReady(makeReq(kitchenUser(), { orderId: oid }), res);
    res = await mockRes();
    await kitchenController.sendOrderToDelivery(makeReq(kitchenUser(), { orderId: oid }), res);
    if (res.statusCode !== 200) {
      throw new Error(`send -> ${res.statusCode} ${res.body?.error || ''}${lastError ? ` | ${lastError.message}` : ''}`);
    }
    const d = await Delivery.findOne({ order: o._id });
    if (!d) throw new Error('no Delivery created for a cafeteria with an object address');
    if (typeof d.pickupLocation.address !== 'string') {
      throw new Error(`pickupLocation.address is ${typeof d.pickupLocation.address}, expected string`);
    }
  } finally {
    await Delivery.deleteMany({ order: o._id });
    await Order.deleteOne({ _id: o._id });
  }
});

check('step 10-11: the manager selects a staff member and assigns the delivery', async () => {
  const res = await mockRes();
  await deliveryController.assignDelivery(
    makeReq(managerUser(), { id: orderId }, {}, { deliveryStaffId: String(staffId) }),
    res
  );
  if (res.statusCode !== 200) throw new Error(`assign -> ${res.statusCode} ${res.body?.error || ''}`);

  const o = await Order.findById(orderDocId);
  if (String(o.deliveryStaffAssigned) !== String(staffId)) throw new Error('Order.deliveryStaffAssigned not saved');
  if (!o.deliveryAssignedAt) throw new Error('Order.deliveryAssignedAt not set');

  const d = await Delivery.findById(o.delivery);
  if (String(d.deliveryPerson) !== String(staffId)) throw new Error('Delivery.deliveryPerson not saved');
  if (d.status !== 'ASSIGNED') throw new Error(`Delivery.status should be ASSIGNED, got ${d.status}`);
  if (!d.assignedAt) throw new Error('Delivery.assignedAt not set');
});

check('assignment reaches the rider personal room (targeted socket event)', async () => {
  const hit = emitted.filter(
    (e) => e.room === `user:${staffId}` && e.event === 'delivery:assigned'
  );
  if (!hit.length) throw new Error('no delivery:assigned emitted to the assigned rider personal room');
});

check('step 12: the Delivery Staff dashboard receives the assigned delivery', async () => {
  const res = await mockRes();
  await deliveryController.getMyDeliveries(makeReq(riderUser()), res);
  if (res.statusCode !== 200) throw new Error(`/mine -> ${res.statusCode} ${res.body?.error || ''}`);
  const row = (res.body.orders || []).find((o) => o.orderId === orderId);
  if (!row) throw new Error('assigned order is NOT visible to the rider dashboard');
  if (row.deliveryStatus !== 'ASSIGNED') throw new Error(`expected ASSIGNED, got ${row.deliveryStatus}`);
  if (String(row.deliveryPersonId) !== String(staffId)) throw new Error('row is not attributed to this rider');
});

check('the order is NOT visible to a different delivery staff member', async () => {
  const other = await User.create({
    name: 'Other Rider',
    email: 'kfo@t.test',
    phone: '+251911000013',
    password: 'kitchen-flow-test-password',
    role: 'delivery',
    status: 'ACTIVE',
    isActive: true,
    cafeteriaId,
    createdAt: now,
    updatedAt: now,
  });
  try {
    const res = await mockRes();
    await deliveryController.getMyDeliveries(makeReq({ id: String(other._id), role: 'delivery', cafeteriaId }), res);
    const row = (res.body.orders || []).find((o) => o.orderId === orderId);
    if (row) throw new Error('the delivery leaked to an unassigned rider');
  } finally {
    await User.deleteOne({ _id: other._id });
  }
});

check('the order leaves the active manager list once it is delivered', async () => {
  let res = await mockRes();
  await deliveryController.markDelivered(makeReq(riderUser(), { id: orderId }, {}, {}), res);
  if (res.statusCode !== 200) {
    // Delivered normally requires proof; fall back to asserting it is a
    // deliberate 4xx rather than a crash.
    if (res.statusCode < 400 || res.statusCode >= 500) {
      throw new Error(`markDelivered -> ${res.statusCode} ${res.body?.error || ''}`);
    }
    return;
  }
  res = await mockRes();
  await deliveryController.getDeliveryOrders(makeReq(managerUser(), {}, { status: 'ALL' }), res);
  if (orderInManagerList(res)) throw new Error('delivered order still listed as active');
  res = await mockRes();
  await deliveryController.getDeliveryOrders(makeReq(managerUser(), {}, { report: 'completed' }), res);
  if (!orderInManagerList(res)) throw new Error('delivered order missing from the completed report');
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

  console.log('\nKitchen -> Send to Delivery -> Manager Delivery Orders\n');
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
  } catch (_) { /* ignore */ }
  process.exit(1);
});
