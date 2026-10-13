/**
 * Kitchen "Send to Delivery" -> the order actually reaches a delivery staff member.
 *
 * The reported bug, in the courier's words: the kitchen sends the order to
 * delivery, but "all the necessary things" never reach the delivery staff. It
 * reproduced like this:
 *
 *   - `GET /deliveries/mine` (the rider queue) only ever returns orders whose
 *     `deliveryStaffAssigned` is the caller, so a delivery left at REQUESTED is
 *     invisible to EVERY courier no matter how many notifications are sent;
 *   - 55 of 74 Delivery rows in the live database sat at REQUESTED, e.g.
 *     ET-1000MUVEBHJ2 was READY, "notified", and owned by nobody;
 *   - rider notifications linked to the queue without `?orderId=`, so tapping
 *     one landed on a list that did not contain the order.
 *
 * This reproduces the real sequence against a REAL MongoDB (a throwaway local
 * test database - never the configured Atlas cluster):
 *
 *   kitchen presses Send to Delivery
 *     -> least-busy ACTIVE rider of that cafeteria is assigned (same core the
 *        manager route uses: guards, state machine, audit, sockets)
 *     -> only that rider is notified, deep-linked to the order card
 *     -> the order is immediately in their Ready for Delivery tab
 *   re-send  -> no duplicate notification, same rider
 *   every rider at capacity -> nobody is assigned, but the announcement still
 *     reaches every active rider of that cafeteria instead of vanishing
 *
 * Run: node Backend/verify-kitchen-send-to-delivery.js
 */

const assert = require('assert');
const mongoose = require('mongoose');

const TEST_URI = 'mongodb://127.0.0.1:27017/scs_send_to_delivery_test';
if (/mongodb\+srv|:\/\/[^/]*@/.test(process.env.MONGODB_URI || '')) {
  console.error('Refusing to run: MONGODB_URI points at a remote cluster.');
  process.exit(1);
}

const Order = require('./src/models/Order');
const User = require('./src/models/User');
const Delivery = require('./src/models/Delivery');
const Notification = require('./src/models/Notification');
const OrderStatusHistory = require('./src/models/OrderStatusHistory');
const Setting = require('./src/models/Setting');

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
let cafeteriaAId;
let cafeteriaBId;
let managerId;
let kitchenUserId;
let riderOldId;
let riderNewId;
let riderOtherCafeteriaId;
let riderBlockedId;
let customerId;
const orderIds = [];

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

function makeReq(user, params, body) {
  return { user, params: params || {}, query: {}, body: body || {}, headers: {} };
}

function asUser(id, role, cafeteriaId) {
  return { id: String(id), role, cafeteriaId, name: 'test-actor' };
}

async function seedCafeteria(code) {
  const doc = await mongoose.connection.collection('cafeterias').insertOne({
    name: `Cafeteria ${code}`,
    code,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  return doc.insertedId;
}

async function mkUser({ name, email, phone, role, cafeteriaId, status = 'ACTIVE', createdAt }) {
  const user = await User.create({
    name,
    email,
    phone,
    password: 'hashed-placeholder-not-used-in-this-test',
    role,
    status,
    isActive: status === 'ACTIVE',
    cafeteriaId,
    isAvailable: true,
    createdAt,
    updatedAt: createdAt || now,
  });
  return user._id;
}

/** A delivery order the kitchen has finished (READY) and not yet sent off. */
async function seedReadyDeliveryOrder(tag) {
  const orderId = `STD-${tag}-${Date.now()}`;
  orderIds.push(orderId);
  await Order.create({
    orderId,
    userId: customerId,
    customerName: 'Customer',
    customerPhone: '+251900000000',
    orderType: 'delivery',
    cafeteriaId: cafeteriaAId,
    status: 'ready',
    orderStatus: 'READY',
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
  return orderId;
}

async function sendToDelivery(orderId, actor) {
  const res = mockRes();
  await kitchenController.sendOrderToDelivery(makeReq(actor, { orderId }), res);
  return res;
}

const notificationsFor = (orderId, userId) =>
  Notification.find(userId ? { orderId, userId } : { orderId }).lean();

async function seed() {
  cafeteriaAId = await seedCafeteria('SDT');
  cafeteriaBId = await seedCafeteria('SDT2');

  managerId = await mkUser({
    name: 'Manager A',
    email: 'mgr@sdt.test',
    phone: '+251900000001',
    role: 'manager',
    cafeteriaId: cafeteriaAId,
  });
  kitchenUserId = await mkUser({
    name: 'Kitchen A',
    email: 'kitchen@sdt.test',
    phone: '+251900000002',
    role: 'kitchen',
    cafeteriaId: cafeteriaAId,
  });
  customerId = await mkUser({
    name: 'Customer',
    email: 'cust@sdt.test',
    phone: '+251900000003',
    role: 'customer',
    cafeteriaId: cafeteriaAId,
  });

  // Two riders in cafeteria A. Equal load, so the OLDER account must win the
  // auto-dispatch tie-break - otherwise the choice would be arbitrary.
  riderOldId = await mkUser({
    name: 'Rider Old',
    email: 'rider.old@sdt.test',
    phone: '+251900000004',
    role: 'delivery',
    cafeteriaId: cafeteriaAId,
    createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
  });
  riderNewId = await mkUser({
    name: 'Rider New',
    email: 'rider.new@sdt.test',
    phone: '+251900000005',
    role: 'delivery',
    cafeteriaId: cafeteriaAId,
    createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
  });
  riderOtherCafeteriaId = await mkUser({
    name: 'Rider Other Cafeteria',
    email: 'rider.other@sdt.test',
    phone: '+251900000006',
    role: 'delivery',
    cafeteriaId: cafeteriaBId,
  });
  riderBlockedId = await mkUser({
    name: 'Rider Blocked',
    email: 'rider.blocked@sdt.test',
    phone: '+251900000007',
    role: 'delivery',
    cafeteriaId: cafeteriaAId,
    status: 'BLOCKED',
  });
}

async function cleanup() {
  await Promise.all([
    mongoose.connection.collection('cafeterias').deleteMany({ _id: { $in: [cafeteriaAId, cafeteriaBId] } }),
    User.deleteMany({ email: /@sdt\.test$/ }),
    Order.deleteMany({ orderId: { $in: orderIds } }),
    Delivery.deleteMany({ orderId: { $in: orderIds } }),
    Notification.deleteMany({ orderId: { $in: orderIds } }),
    OrderStatusHistory.deleteMany({}),
    Setting.deleteOne({ key: 'delivery_max_active_per_staff' }),
  ]);
}

let passed = 0;
const failures = [];
const queue = [];
function check(name, fn) {
  queue.push({ name, fn });
}

// ===========================================================================
// The flow
// ===========================================================================

let order1;

check('Send to Delivery hands the order to the least busy rider of that cafeteria', async () => {
  order1 = await seedReadyDeliveryOrder('one');
  const res = await sendToDelivery(order1, asUser(kitchenUserId, 'kitchen', cafeteriaAId));

  assert.strictEqual(res.statusCode, 200, `send-to-delivery failed: ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.autoAssigned, true, `expected an auto-assignment, got ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.assignedTo, 'Rider Old', `wrong rider chosen: ${res.body.assignedTo}`);

  const order = await Order.findOne({ orderId: order1 }).lean();
  assert.strictEqual(
    String(order.deliveryStaffAssigned),
    String(riderOldId),
    'the order was not attached to the chosen rider - it would stay invisible in every queue'
  );

  const delivery = await Delivery.findOne({ order: order._id }).lean();
  assert.ok(delivery, 'no Delivery record was created');
  assert.strictEqual(delivery.status, 'ASSIGNED', `delivery status is ${delivery.status}, expected ASSIGNED`);
  assert.strictEqual(
    String(delivery.deliveryPerson),
    String(riderOldId),
    'the Delivery record did not record the courier'
  );
});

check('only the rider who owns the job is notified, deep-linked to the order', async () => {
  const all = await notificationsFor(order1);
  const byUser = (userId) => all.filter((n) => String(n.userId) === String(userId));

  // The owning rider hears twice: "you own this" (assignment) + "the food is
  // ready". Everyone else - including the customer - must be silent or told
  // about their own part only.
  const mine = byUser(riderOldId);
  assert.strictEqual(mine.length, 2, `expected 2 notifications for the owner, got ${mine.length}`);
  mine.forEach((note) => {
    assert.ok(
      note.link && note.link.includes(`?orderId=${order1}`),
      `notification link does not deep-link the order: ${note.link}`
    );
  });

  assert.strictEqual(byUser(riderNewId).length, 0, 'the other rider of the same cafeteria was spammed');
  assert.strictEqual(byUser(riderOtherCafeteriaId).length, 0, 'a rider of ANOTHER cafeteria was notified');
  assert.strictEqual(byUser(riderBlockedId).length, 0, 'a blocked rider was notified');
  assert.strictEqual(
    byUser(customerId).length,
    1,
    'the customer was not told that a rider was assigned to their order'
  );
  assert.strictEqual(
    all.length,
    3,
    `expected owner(2) + customer(1), got ${all.length} notifications for ${order1}`
  );

  assert.ok(
    emitted.some((e) => e.room === `user:${riderOldId}` && e.event === 'notification:new'),
    'the owning rider was not pushed the notification in real time'
  );
  assert.ok(
    emitted.some((e) => e.event === 'delivery:assigned' && (e.room === 'delivery' || e.room === 'admin')),
    'dispatch boards were not told a courier was attached'
  );
});

check('the order is immediately in that rider Ready for Delivery tab', async () => {
  const res = mockRes();
  await deliveryController.getMyDeliveries(makeReq(asUser(riderOldId, 'delivery', cafeteriaAId)), res);
  assert.strictEqual(res.statusCode, 200, `/deliveries/mine failed: ${JSON.stringify(res.body)}`);
  const mine = res.body.orders.find((o) => o.orderId === order1);
  assert.ok(mine, 'the kitchen-sent order is missing from the rider queue');
  assert.strictEqual(String(mine.status).toLowerCase(), 'ready_for_delivery', `tab status is "${mine.status}"`);
  assert.ok(mine.readyForDeliveryAt, 'the Ready time was not exposed to the rider queue');

  // The send is a persisted state change, not just a notification.
  const order = await Order.findOne({ orderId: order1 }).lean();
  assert.strictEqual(order.status, 'ready_for_delivery', `order.status is ${order.status}`);
  assert.strictEqual(order.orderStatus, 'READY_FOR_DELIVERY', `order.orderStatus is ${order.orderStatus}`);
  assert.ok(order.readyForDeliveryAt instanceof Date, 'readyForDeliveryAt was not stamped');
  const history = await OrderStatusHistory.find({ orderId: order._id }).lean();
  assert.ok(
    history.some((h) => h.newStatus === 'READY_FOR_DELIVERY'),
    `no READY_FOR_DELIVERY history row: ${JSON.stringify(history.map((h) => h.newStatus))}`
  );
  assert.ok(
    emitted.some((e) => e.event === 'order:ready-for-delivery' && e.room === `order:${order1}`),
    'the customer order room never got order:ready-for-delivery'
  );
  assert.ok(
    emitted.some((e) => e.event === 'order:ready-for-delivery' && e.room === `delivery:${riderOldId}`),
    'the owning rider never got order:ready-for-delivery in their personal room'
  );

  // The rider nobody assigned must NOT see somebody else's job.
  const otherRes = mockRes();
  await deliveryController.getMyDeliveries(makeReq(asUser(riderNewId, 'delivery', cafeteriaAId)), otherRes);
  assert.ok(
    !otherRes.body.orders.some((o) => o.orderId === order1),
    'the order leaked into a second rider queue'
  );
});

check('re-sending keeps the same rider and does not re-notify anyone', async () => {
  const before = (await notificationsFor(order1)).length;
  const beforeOrder = await Order.findOne({ orderId: order1 }).lean();
  const beforeHistory = (
    await OrderStatusHistory.find({ orderId: beforeOrder._id, newStatus: 'READY_FOR_DELIVERY' }).lean()
  ).length;
  assert.ok(beforeHistory >= 1, 'the first send never wrote its READY_FOR_DELIVERY history row');
  const res = await sendToDelivery(order1, asUser(kitchenUserId, 'kitchen', cafeteriaAId));

  assert.strictEqual(res.statusCode, 200, `re-send failed: ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.autoAssigned, false, 'a re-send must not re-run the dispatch');
  assert.strictEqual(res.body.assignedTo, 'Rider Old', 'the rider changed on re-send');
  assert.strictEqual(
    (await notificationsFor(order1)).length,
    before,
    're-sending duplicated the rider notification'
  );

  const order = await Order.findOne({ orderId: order1 }).lean();
  assert.strictEqual(String(order.deliveryStaffAssigned), String(riderOldId), 're-send moved the order');
  assert.strictEqual(order.orderStatus, 'READY_FOR_DELIVERY', 're-send moved the order out of READY_FOR_DELIVERY');
  assert.strictEqual(
    String(order.readyForDeliveryAt),
    String(beforeOrder.readyForDeliveryAt),
    're-send rewrote the original Ready time'
  );
  const afterHistory = (
    await OrderStatusHistory.find({ orderId: order._id, newStatus: 'READY_FOR_DELIVERY' }).lean()
  ).length;
  assert.strictEqual(
    afterHistory,
    beforeHistory,
    're-send duplicated the READY_FOR_DELIVERY history row'
  );
});

check('when every rider is at capacity the order is still announced instead of vanishing', async () => {
  // Cap each rider at one active run, then give both riders one run each.
  await Setting.updateOne(
    { key: 'delivery_max_active_per_staff' },
    { $set: { value: 1, type: 'number', group: 'delivery', label: 'Max Active Deliveries per Staff' } },
    { upsert: true }
  );
  const fillId = await seedReadyDeliveryOrder('filler');
  await Order.updateOne(
    { orderId: fillId },
    { $set: { status: 'pending', orderStatus: 'PENDING', deliveryStaffAssigned: riderNewId } }
  );

  const order2 = await seedReadyDeliveryOrder('two');
  const res = await sendToDelivery(order2, asUser(kitchenUserId, 'kitchen', cafeteriaAId));

  assert.strictEqual(res.statusCode, 200, `send failed: ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.autoAssigned, false, 'nobody was free, so nothing could be assigned');
  assert.strictEqual(res.body.assignedTo, null, 'a rider was attached despite being over the limit');

  const order = await Order.findOne({ orderId: order2 }).lean();
  assert.ok(!order.deliveryStaffAssigned, 'the order was attached to a rider over capacity');

  const delivery = await Delivery.findOne({ order: order._id }).lean();
  assert.strictEqual(delivery.status, 'REQUESTED', `expected REQUESTED, got ${delivery.status}`);

  const notes = await notificationsFor(order2);
  assert.strictEqual(notes.length, 2, `expected both free riders of the cafeteria to hear about it, got ${notes.length}`);
  const userIds = notes.map((n) => String(n.userId)).sort();
  assert.deepStrictEqual(
    userIds,
    [String(riderOldId), String(riderNewId)].sort(),
    'the fallback announcement went to the wrong people'
  );
  notes.forEach((n) => {
    assert.ok(n.link && n.link.includes(`?orderId=${order2}`), `fallback link does not deep-link: ${n.link}`);
  });
  assert.ok(
    !userIds.includes(String(riderOtherCafeteriaId)),
    'another cafeteria was dragged in'
  );
  assert.ok(res.body.message.includes('No free rider'), `message should say no rider was free: ${res.body.message}`);
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
  console.log('Kitchen Send to Delivery -> rider queue handoff\n');
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
