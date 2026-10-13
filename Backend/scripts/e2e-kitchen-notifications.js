/**
 * End-to-end verification of the Kitchen Dashboard notification flow.
 *
 * Exercises the REAL stack - running HTTP API, real Socket.IO server, real
 * MongoDB documents - with no mocks and no stubs. It proves the behaviours the
 * requirement asks for:
 *
 *   1. A customer placing an order AND paying for it notifies the kitchen in
 *      real time (order:new) AND leaves a durable unread notification. The
 *      payment is the release point: an unpaid order never reaches the kitchen.
 *   2. That notification survives a "page reload" (GET ?unread=true) and stays
 *      unread until someone acknowledges it.
 *   3. The same order event delivered twice produces exactly ONE notification
 *      and ONE realtime frame (de-duplication).
 *   4. Acknowledging is durable in MongoDB and idempotent.
 *   5. Acknowledging ONE notification never touches any other notification -
 *      not another order's, and not the same order's other event type.
 *   6. A customer cancelling an order notifies the kitchen in real time
 *      (order:status cancelled) AND leaves a durable unread cancellation
 *      notification with its own eventKey.
 *
 * Usage:  node scripts/e2e-kitchen-notifications.js
 * Requires the backend server to be listening on API_PORT (default 5000).
 */

require('dotenv').config();
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');

const connectDatabase = require('../src/config/database');
const User = require('../src/models/User');
const MenuItem = require('../src/models/MenuItem');
const Notification = require('../src/models/Notification');
const Order = require('../src/models/Order');

const API_PORT = Number(process.env.PORT || process.env.API_PORT || 5000);
const API_BASE = `http://127.0.0.1:${API_PORT}/api/v1`;

// ---------------------------------------------------------------- helpers ---

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`   PASS  ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` :: ${detail}` : ''}`);
    console.log(`   FAIL  ${label}${detail ? `  <-- ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function api(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: API_PORT,
        path: `/api/v1${path}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = { raw };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `predicate()` is truthy, or time out. */
async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function sign(user) {
  return jwt.sign(
    { id: user._id.toString(), role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

/** Socket frames the kitchen terminal receives, in arrival order. */
function createKitchenListener(kitchenToken) {
  const frames = { orderNew: [], orderStatus: [], notificationNew: [] };
  const socket = io(`http://127.0.0.1:${API_PORT}`, {
    auth: { token: kitchenToken },
    transports: ['websocket', 'polling'],
  });
  socket.on('connect', () => {
    socket.emit('join:kitchen');
  });
  socket.on('order:new', (o) => frames.orderNew.push(o));
  socket.on('order:status', (o) => frames.orderStatus.push(o));
  socket.on('notification:new', (n) => frames.notificationNew.push(n));
  return { socket, frames };
}

const findEvent = (frames, orderId) => (frames || []).find((f) => String(f.orderId) === String(orderId));

/**
 * Pay for an order through the real simulated-payment path.
 *
 * Placing an order does NOT reach the kitchen: the lifecycle is "payment
 * successful -> order = PENDING -> kitchen dashboard", and the `order:new`
 * frame plus the durable notification are emitted from the payment release.
 * The simulator fails ~5% of the time by design, hence the retries.
 */
async function payForOrder(token, orderId) {
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await api('POST', '/payments/simulate', token, { orderId, method: 'CHAPA' });
    if (res.body?.success === true) return res;
    await wait(300);
  }
  return res;
}

// ------------------------------------------------------------------- main ---

async function main() {
  await connectDatabase();
  console.log(`Connected to MongoDB: ${mongoose.connection.name}`);

  // --- fixtures: real users and a real in-stock menu item -------------------
  const kitchenUser = await User.findOne({ role: 'kitchen', status: 'ACTIVE' });
  if (!kitchenUser) throw new Error('No ACTIVE kitchen user in the database');
  const customer = await User.findOne({ role: 'customer', status: 'ACTIVE' });
  if (!customer) throw new Error('No ACTIVE customer in the database');
  const item = await MenuItem.findOne({ isAvailable: true, stockQuantity: { $gt: 5 } });
  if (!item) throw new Error('No available menu item with stock');

  console.log(`kitchen : ${kitchenUser.email}`);
  console.log(`customer: ${customer.email}`);
  console.log(`item    : ${item.name?.en || item.name} (stock ${item.stockQuantity})`);

  const KT = sign(kitchenUser);
  const CT = sign(customer);

  const { socket, frames } = createKitchenListener(KT);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error('kitchen socket did not connect')), 10000);
  });
  // Give the room join time to land before any order is created.
  await wait(300);

  const createdOrderIds = [];

  try {
    // ================================================================
    section('STEP 1 - customer places a real order');
    // ================================================================
    let res = await api('POST', '/orders', CT, {
      orderType: 'takeaway',
      customerName: customer.name || 'E2E Customer',
      customerPhone: customer.phone,
      paymentMethod: 'CHAPA',
      items: [{ id: String(item._id), quantity: 1 }],
      totalAmount: Number(item.price) || 100,
    });
    check('POST /orders succeeds', res.status === 201 || res.status === 200, `status=${res.status} body=${JSON.stringify(res.body).slice(0, 300)}`);
    const orderA = res.body?.data?.order || res.body?.order || res.body?.data;
    const orderAId = orderA?.orderId;
    check('response carries an orderId', Boolean(orderAId), JSON.stringify(res.body).slice(0, 200));
    if (!orderAId) throw new Error('cannot continue without an orderId');
    createdOrderIds.push(orderAId);
    console.log(`   order A = ${orderAId}`);

    // Placing the order is NOT what reaches the kitchen: the lifecycle is
    // "payment successful -> order = PENDING -> kitchen dashboard", so pay for
    // it before waiting on any kitchen frame.
    res = await payForOrder(CT, orderAId);
    check('payment succeeds, releasing the order to the kitchen', res.body?.success === true, JSON.stringify(res.body).slice(0, 250));

    // ================================================================
    section('STEP 2 - kitchen is notified in real time (socket)');
    // ================================================================
    const orderNewFrame = await waitFor(() => findEvent(frames.orderNew, orderAId), { label: 'order:new frame' });
    check('kitchen room received order:new', Boolean(orderNewFrame));

    const notifNewFrame = await waitFor(
      () => frames.notificationNew.find((n) => String(n.orderId) === String(orderAId) && n.type === 'order'),
      { label: 'notification:new (order) frame' }
    );
    check('kitchen user received notification:new of type "order"', Boolean(notifNewFrame));
    check('notification:new payload is the kitchen audience', String(notifNewFrame.meta?.audience) === 'kitchen', JSON.stringify(notifNewFrame.meta));
    check(
      'notification:new carries eventKey kitchen:new:<orderId>',
      notifNewFrame.eventKey === `kitchen:new:${orderAId}`,
      `got ${notifNewFrame.eventKey}`
    );
    check('notification:new starts unread', notifNewFrame.isRead === false);

    // ================================================================
    section('STEP 3 - the notification is durable in MongoDB');
    // ================================================================
    const storedNew = await Notification.findOne({ userId: kitchenUser._id, eventKey: `kitchen:new:${orderAId}` });
    check('a notification row exists in MongoDB', Boolean(storedNew));
    check('stored row is unread', storedNew && storedNew.isRead === false);
    check('stored row has readAt = null', storedNew && storedNew.readAt === null);
    check('stored row links back to the order', storedNew && storedNew.orderId === orderAId);
    check('stored row type is "order"', storedNew && storedNew.type === 'order');
    check(
      'stored row title reads as a new customer order',
      /new customer order/i.test(storedNew?.title || ''),
      storedNew?.title
    );

    // ================================================================
    section('STEP 4 - survives a reload (what the dashboard calls on page load)');
    // ================================================================
    res = await api('GET', '/notifications?unread=true&limit=200', KT);
    check('GET /notifications?unread=true succeeds', res.body?.success === true, JSON.stringify(res.body).slice(0, 200));
    const afterReload = (res.body?.notifications || []).find((n) => n.eventKey === `kitchen:new:${orderAId}`);
    check('the unread notification is returned after a reload', Boolean(afterReload));
    check('reloaded payload keeps eventKey', afterReload?.eventKey === `kitchen:new:${orderAId}`);

    // ================================================================
    section('STEP 5 - de-duplication: the same event twice stays one');
    // ================================================================
    // Re-run the exact production fan-out used by the order controller. This is
    // what a retried request, a duplicate emit or a second call site would do.
    const notificationController = require('../src/controllers/notification.controller');
    const OrderModel = require('../src/models/Order');
    const liveOrder = await OrderModel.findOne({ orderId: orderAId });
    const secondPass = await notificationController.notifyRolesOfNewOrder(
      { ...liveOrder.getSummary(), cafeteriaId: liveOrder.cafeteriaId },
      ['kitchen', 'manager', 'cafeteria_admin', 'admin', 'system_admin'],
      { cafeteriaScoped: true }
    );
    check('repeat fan-out creates 0 new notifications', secondPass === 0, `created=${secondPass}`);

    // Per (user, event): one row per recipient, never two for the same person.
    const dupes = await Notification.countDocuments({
      userId: kitchenUser._id,
      eventKey: `kitchen:new:${orderAId}`,
    });
    check('still exactly ONE row for this kitchen user', dupes === 1, `count=${dupes}`);

    // ...but the same event must reach every recipient, not just the first.
    const perEvent = await Notification.countDocuments({ eventKey: `kitchen:new:${orderAId}` });
    check('the event reached every recipient', perEvent > 1, `rows=${perEvent}`);

    await wait(700);
    const newFramesForA = frames.notificationNew.filter((n) => String(n.orderId) === String(orderAId));
    check('no duplicate realtime frame was emitted', newFramesForA.length === 1, `frames=${newFramesForA.length}`);

    // ================================================================
    section('STEP 6 - a SECOND order, to prove acknowledgement is surgical');
    // ================================================================
    res = await api('POST', '/orders', CT, {
      orderType: 'takeaway',
      customerName: customer.name || 'E2E Customer',
      customerPhone: customer.phone,
      paymentMethod: 'CHAPA',
      items: [{ id: String(item._id), quantity: 2 }],
      totalAmount: (Number(item.price) || 100) * 2,
    });
    const orderB = res.body?.data?.order || res.body?.order || res.body?.data;
    const orderBId = orderB?.orderId;
    check('second order created', Boolean(orderBId), JSON.stringify(res.body).slice(0, 200));
    if (!orderBId) throw new Error('cannot continue without a second orderId');
    createdOrderIds.push(orderBId);
    console.log(`   order B = ${orderBId}`);

    // Same release rule as order A: the kitchen is only told about a paid
    // order, and STEP 9 cancels this one (cancellations are broadcast for
    // orders the kitchen actually knows about).
    res = await payForOrder(CT, orderBId);
    check('second order paid, releasing it to the kitchen', res.body?.success === true, JSON.stringify(res.body).slice(0, 250));

    await waitFor(() => Notification.findOne({ userId: kitchenUser._id, eventKey: `kitchen:new:${orderBId}` }), {
      label: 'second order notification',
    });

    // ================================================================
    section('STEP 7 - acknowledge ONE notification');
    // ================================================================
    res = await api('PATCH', `/notifications/${storedNew._id}/read`, KT);
    check('PATCH /notifications/:id/read succeeds', res.body?.success === true, JSON.stringify(res.body).slice(0, 200));
    check('response reports the persisted read state', res.body?.notification?.isRead === true);

    const reread = await Notification.findById(storedNew._id);
    check('acknowledgement is durable in MongoDB', reread.isRead === true);
    check('readAt was stamped', reread.readAt instanceof Date);

    // Idempotency: a second click must not move readAt.
    const firstReadAt = reread.readAt.getTime();
    await wait(1100);
    res = await api('PATCH', `/notifications/${storedNew._id}/read`, KT);
    check('repeat acknowledge reports alreadyRead', res.body?.alreadyRead === true, JSON.stringify(res.body).slice(0, 200));
    const reread2 = await Notification.findById(storedNew._id);
    check('readAt did not move on the repeat', reread2.readAt.getTime() === firstReadAt);

    // ================================================================
    section('STEP 8 - nothing unrelated was marked as read');
    // ================================================================
    const otherOrderNotif = await Notification.findOne({ userId: kitchenUser._id, eventKey: `kitchen:new:${orderBId}` });
    check('the other order still has an unread notification', Boolean(otherOrderNotif));
    check('the other order notification is STILL UNREAD', otherOrderNotif && otherOrderNotif.isRead === false);

    res = await api('GET', '/notifications?unread=true&limit=200', KT);
    const unreadKeys = (res.body?.notifications || []).map((n) => n.eventKey);
    check('acknowledged event is gone from unread', !unreadKeys.includes(`kitchen:new:${orderAId}`));
    check('unacknowledged event is still listed', unreadKeys.includes(`kitchen:new:${orderBId}`));

    // ================================================================
    section('STEP 9 - customer cancels order B');
    // ================================================================
    const statusFramesBefore = frames.orderStatus.length;
    res = await api('PATCH', `/orders/${orderBId}/cancel`, CT, { reason: 'CUSTOMER_CHANGED_MIND' });
    check('customer cancel succeeds', res.body?.success === true, `status=${res.status} body=${JSON.stringify(res.body).slice(0, 300)}`);

    const cancelStatusFrame = await waitFor(
      () => {
        const fresh = frames.orderStatus.slice(statusFramesBefore);
        return fresh.find((f) => String(f.orderId) === String(orderBId) && String(f.status || f.orderStatus).toLowerCase() === 'cancelled');
      },
      { label: 'order:status cancelled frame' }
    );
    check('kitchen room received order:status cancelled', Boolean(cancelStatusFrame));

    const cancelNotifFrame = await waitFor(
      () => frames.notificationNew.find((n) => String(n.orderId) === String(orderBId) && n.type === 'cancellation'),
      { label: 'notification:new (cancellation) frame' }
    );
    check('kitchen user received a cancellation notification', Boolean(cancelNotifFrame));
    check(
      'cancellation notification uses its own eventKey',
      cancelNotifFrame.eventKey === `kitchen:cancelled:${orderBId}`,
      `got ${cancelNotifFrame.eventKey}`
    );
    check(
      'cancellation eventKey differs from the new-order eventKey',
      cancelNotifFrame.eventKey !== `kitchen:new:${orderBId}`
    );
    check('cancellation notification is unread', cancelNotifFrame.isRead === false);
    check(
      'cancellation notification records the reason',
      Boolean(cancelNotifFrame.meta?.cancellationReason),
      JSON.stringify(cancelNotifFrame.meta)
    );

    // ================================================================
    section('STEP 10 - the cancellation is durable and independently readable');
    // ================================================================
    const storedCancel = await Notification.findOne({ userId: kitchenUser._id, eventKey: `kitchen:cancelled:${orderBId}` });
    check('a cancellation row exists in MongoDB', Boolean(storedCancel));
    check('cancellation row is unread', storedCancel && storedCancel.isRead === false);
    check('cancellation row type is "cancellation"', storedCancel && storedCancel.type === 'cancellation');

    // The NEW-order notification for B was already acknowledged in STEP 8? No -
    // only A was. Acknowledge B's new-order event, then confirm the
    // cancellation is still unread. This is the check that an "acknowledge the
    // ticket" action cannot swallow a later cancellation.
    res = await api('PATCH', `/notifications/${otherOrderNotif._id}/read`, KT);
    check('acknowledging B new-order succeeds', res.body?.success === true);

    const storedCancelAfter = await Notification.findOne({ userId: kitchenUser._id, eventKey: `kitchen:cancelled:${orderBId}` });
    check(
      'acknowledging the new-order event did NOT mark the cancellation read',
      storedCancelAfter && storedCancelAfter.isRead === false,
      `isRead=${storedCancelAfter && storedCancelAfter.isRead}`
    );

    res = await api('GET', '/notifications?unread=true&limit=200', KT);
    const keysAfter = (res.body?.notifications || []).map((n) => n.eventKey);
    check('the cancellation is still in the unread list after a reload', keysAfter.includes(`kitchen:cancelled:${orderBId}`));
    check('the acknowledged new-order event is not', !keysAfter.includes(`kitchen:new:${orderBId}`));

    // ================================================================
    section('STEP 11 - acknowledging the cancellation');
    // ================================================================
    res = await api('PATCH', `/notifications/${storedCancel._id}/read`, KT);
    check('acknowledging the cancellation succeeds', res.body?.success === true);
    const finalCancel = await Notification.findById(storedCancel._id);
    check('cancellation is now read in MongoDB', finalCancel.isRead === true);

    res = await api('GET', '/notifications?unread=true&limit=200', KT);
    const finalKeys = (res.body?.notifications || []).map((n) => n.eventKey);
    check('nothing from this test is left unread', !finalKeys.some((k) => createdOrderIds.some((id) => k && k.includes(id))), JSON.stringify(finalKeys));
  } finally {
    // ---------------------------------------------------------- cleanup --
    socket.close();
    const ids = createdOrderIds;
    if (ids.length) {
      const removedNotifs = await Notification.deleteMany({ eventKey: { $in: ids.flatMap((id) => [`kitchen:new:${id}`, `kitchen:cancelled:${id}`]) } });
      const removedOrders = await Order.deleteMany({ orderId: { $in: ids } });
      console.log(`\ncleanup: removed ${removedNotifs.deletedCount} notification(s) and ${removedOrders.deletedCount} test order(s)`);
    }
    await mongoose.disconnect();
  }

  // ------------------------------------------------------------- report ---
  console.log(`\n================ RESULT: ${passed} passed, ${failed} failed ================`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nE2E run crashed:', error);
  process.exit(1);
});
