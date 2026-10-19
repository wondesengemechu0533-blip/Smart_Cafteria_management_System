/**
 * End-to-end proof: manager processes a refund -> the customer is notified.
 *
 * The bugs this pins down:
 *
 *  1. `refund.controller.completeRefund` created the customer notice with
 *     `type: 'payment'`, which is not a member of Notification.NOTIFICATION_TYPES.
 *     Mongoose threw a ValidationError that nothing caught, so the endpoint
 *     answered 500 for a refund that had ALREADY been committed as REFUNDED on
 *     the ledger, the order AND the payment. No notification row existed, no
 *     socket frame went out, and every retry then 409'd.
 *
 *  2. In `cancellation.service.confirmRefund` the success notification was sent
 *     BEFORE the Payment record was flipped to REFUNDED (that write lived in the
 *     callers, inside a swallowing try/catch), so a customer could be told
 *     "refunded successfully" while Payment.status was still PAID.
 *
 *  3. Neither refund notification carried an `eventKey`, so they sat outside the
 *     partial unique index that de-duplicates notifications and a retried refund
 *     double-notified the customer.
 *
 * Run: node verify-refund-notification.js
 */
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scs_refund_notify_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'refund-notify-test-secret';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');

const PORT = 5099;
const API = `http://127.0.0.1:${PORT}/api/v1`;

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

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const { app } = require('./server.js');
  const { Server } = require('socket.io');
  const { setupSocketIO } = require('./src/socket');
  const httpServer = http.createServer(app);
  const sio = new Server(httpServer, { cors: { origin: '*' } });
  setupSocketIO(sio);
  await new Promise((r) => httpServer.listen(PORT, r));

  const jwt = require('jsonwebtoken');
  const User = require('./src/models/User');
  const Order = require('./src/models/Order');
  const Payment = require('./src/models/Payment');
  const Notification = require('./src/models/Notification');
  const Cancellation = require('./src/models/Cancellation');
  const Refund = require('./src/models/Refund');
  const MenuItem = require('./src/models/MenuItem');
  const { notifyRefundProcessed, buildRefundMessage } = require('./src/services/refund-notification.service');

  const customer = await User.create({
    name: 'Refund Customer',
    email: 'refund-customer@c.test',
    phone: '0911000111',
    password: 'password123',
    role: 'customer',
    status: 'ACTIVE',
  });
  const manager = await User.create({
    name: 'Cafeteria Manager',
    email: 'refund-manager@c.test',
    phone: '0911000222',
    password: 'password123',
    role: 'manager',
    status: 'ACTIVE',
  });
  const custToken = jwt.sign({ id: customer._id, role: 'customer' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const mgrToken = jwt.sign({ id: manager._id, role: 'manager' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  // A real menu item, because Order.items[].itemId is a required ref and the
  // refund flow re-saves the whole order document.
  const menuItem = await MenuItem.create({
    name: { en: 'Kitfo', am: 'ክትፎ' },
    category: 'Main',
    price: 50,
    cafeteriaId: null,
  });

  let seq = 0;
  const mkOrder = async (over = {}) => {
    const o = new Order(
      Object.assign(
        {
          orderId: `ET-RF-${String(++seq).padStart(4, '0')}`,
          userId: customer._id,
          customerName: customer.name,
          customerPhone: customer.phone,
          orderType: 'dine-in',
          orderStatus: 'CANCELLED',
          status: 'cancelled',
          paymentMethod: 'CASH',
          paymentStatus: 'PAID',
          subtotal: 100,
          serviceFee: 20,
          vatEnabled: true,
          vatRate: 15,
          vatAmount: 18,
          taxAmount: 18,
          deliveryFee: 0,
          totalAmount: 138,
          items: [{ itemId: menuItem._id, name: 'Kitfo', quantity: 2, price: 50, subtotal: 100 }],
        },
        over
      )
    );
    await o.save({ validateBeforeSave: false });
    await Payment.create({
      orderId: o._id,
      userId: customer._id,
      amount: o.totalAmount,
      provider: 'CASH',
      method: 'CASH',
      currency: 'ETB',
      status: 'PAID',
      transactionId: `TX-RF-${seq}`,
    });
    return o;
  };

  const call = async (method, path, token, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const notificationsFor = (orderId) =>
    Notification.find({ userId: customer._id, orderId }).sort({ createdAt: 1 });

  console.log('\nThe required customer message');

  await check('message matches the specified copy exactly', () => {
    const msg = buildRefundMessage({ orderId: 'ET-1042', amount: 100, simulated: false });
    assert.strictEqual(
      msg,
      'Your refund has been processed successfully. Order #ET-1042. Refund Amount: 100.00 ETB.'
    );
  });

  await check('a simulated refund still carries the required sentence, plus an honest caveat', () => {
    const msg = buildRefundMessage({ orderId: 'ET-9', amount: 50, simulated: true });
    assert.ok(msg.startsWith('Your refund has been processed successfully. Order #ET-9. Refund Amount: 50.00 ETB.'));
    assert.ok(/without a payment-provider transfer/.test(msg), 'simulated must be disclosed');
  });

  console.log('\nManager processes the refund (admin orders page)');

  const order = await mkOrder();
  const cancel = await Cancellation.create({
    orderId: order._id,
    customerId: customer._id,
    reason: 'CUSTOMER_CHANGED_MIND',
    status: 'CANCELLED',
    refundStatus: 'REFUND_REQUESTED',
    refundAmount: 100,
    isActive: true,
  });

  let refundRes;
  await check('POST /admin/orders/:id/refund succeeds', async () => {
    refundRes = await call('POST', `/admin/orders/${order._id}/refund`, mgrToken, {});
    assert.strictEqual(refundRes.status, 200, `status=${refundRes.status} body=${JSON.stringify(refundRes.body)}`);
  });

  await check('the order is REFUNDED', async () => {
    const o = await Order.findById(order._id);
    assert.strictEqual(o.paymentStatus, 'REFUNDED');
    assert.strictEqual(o.refundStatus, 'REFUNDED');
  });

  await check('the Payment record is REFUNDED', async () => {
    const p = await Payment.findOne({ orderId: order._id });
    assert.strictEqual(p.status, 'REFUNDED', 'payment must agree with the order');
    assert.strictEqual(p.refundStatus, 'REFUNDED');
  });

  await check('the refund amount is the Subtotal (100), not the VAT-inclusive total', async () => {
    const o = await Order.findById(order._id);
    assert.strictEqual(o.refundAmount, 100);
    assert.notStrictEqual(o.refundAmount, 138);
  });

  console.log('\nThe notification reached the customer');

  let stored;
  await check('exactly one notification row was persisted', async () => {
    const rows = await notificationsFor(order.orderId);
    assert.strictEqual(rows.length, 1, `expected 1 row, found ${rows.length}`);
    stored = rows[0];
  });

  await check('it is addressed to the authenticated customer on the order', async () => {
    assert.strictEqual(String(stored.userId), String(customer._id));
    assert.notStrictEqual(String(stored.userId), String(manager._id));
  });

  await check('its type is a legal Notification type', async () => {
    assert.ok(
      Notification.NOTIFICATION_TYPES.includes(stored.type),
      `type "${stored.type}" must be in Notification.NOTIFICATION_TYPES`
    );
    assert.strictEqual(stored.type, 'refund');
  });

  await check('it carries the order number, amount, status and refund date', async () => {
    assert.strictEqual(stored.orderId, order.orderId);
    assert.strictEqual(stored.message, 'Your refund has been processed successfully. Order #' + order.orderId + '. Refund Amount: 100.00 ETB.');
    assert.strictEqual(stored.meta.refundAmount, 100);
    assert.strictEqual(stored.meta.refundStatus, 'REFUNDED');
    assert.ok(stored.meta.refundedAt, 'meta.refundedAt must be set');
    assert.ok(!Number.isNaN(Date.parse(stored.meta.refundedAt)));
  });

  await check('it is unread so the badge increments', async () => {
    assert.strictEqual(stored.isRead, false);
  });

  console.log('\nThe customer sees it through the notification API');

  await check('GET /notifications lists it', async () => {
    const r = await call('GET', '/notifications', custToken);
    assert.strictEqual(r.status, 200);
    const row = r.body.notifications.find((n) => String(n.id) === String(stored._id));
    assert.ok(row, 'notification must appear in the customer list');
    assert.strictEqual(row.type, 'refund');
    assert.strictEqual(row.orderId, order.orderId);
  });

  await check('GET /notifications/unread counts it (badge count)', async () => {
    const r = await call('GET', '/notifications/unread', custToken);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.count >= 1, 'badge must show at least 1 unread');
  });

  await check('it survives a fresh fetch (the DB is the fallback for a dropped socket frame)', async () => {
    const rows = await Notification.find({ userId: customer._id, orderId: order.orderId });
    assert.strictEqual(rows.length, 1, 'a re-login re-reads the same durable row');
  });

  await check('another customer cannot see it', async () => {
    const stranger = await User.create({
      name: 'Stranger', email: 'stranger@c.test', phone: '0911999888',
      password: 'password123', role: 'customer', status: 'ACTIVE',
    });
    const r = await call('GET', '/notifications', jwt.sign({ id: stranger._id, role: 'customer' }, process.env.JWT_SECRET, { expiresIn: '1h' }));
    assert.strictEqual(r.body.notifications.filter((n) => String(n.id) === String(stored._id)).length, 0);
  });

  console.log('\nNo duplicate notification on a retry');

  await check('retrying the same refund creates no second row', async () => {
    const retry = await call('POST', `/admin/orders/${order._id}/refund`, mgrToken, {});
    assert.strictEqual(retry.status, 400, `expected the retry to be rejected, got ${retry.status}`);
    const rows = await notificationsFor(order.orderId);
    assert.strictEqual(rows.length, 1, `retry produced ${rows.length} notification rows`);
  });

  await check('calling the notifier twice directly is also a no-op', async () => {
    const fresh = await Order.findById(order._id);
    const c = await Cancellation.findOne({ orderId: order._id });
    const a = await notifyRefundProcessed({ order: fresh, cancellation: c });
    const b = await notifyRefundProcessed({ order: fresh, cancellation: c });
    assert.strictEqual(a.created, false, 'first call must be a duplicate (already sent)');
    assert.strictEqual(b.created, false);
    const rows = await notificationsFor(order.orderId);
    assert.strictEqual(rows.length, 1);
  });

  await check('the eventKey is the documented dedupe identity', async () => {
    assert.strictEqual(stored.eventKey, `refund:processed:${order.orderId}`);
  });

  console.log('\nReal-time delivery (Socket.IO)');

  await check('the customer receives notification:new on their personal room', async () => {
    const order2 = await mkOrder();
    const cancel2 = await Cancellation.create({
      orderId: order2._id, customerId: customer._id, reason: 'OTHER',
      status: 'CANCELLED', refundStatus: 'REFUND_REQUESTED', refundAmount: 100, isActive: true,
    });
    void cancel2;

    const received = [];
    // socket.io-client ships in devDependencies for exactly this purpose.
    const { io } = require('socket.io-client');
    const sock = io(`http://127.0.0.1:${PORT}`, {
      auth: { token: custToken },
      transports: ['websocket'],
      forceNew: true,
    });
    const frame = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no notification:new within 5s')), 5000);
      sock.on('notification:new', (n) => {
        clearTimeout(t);
        resolve(n);
      });
      sock.on('connect_error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket never connected')), 5000);
    });

    const r = await call('POST', `/admin/orders/${order2._id}/refund`, mgrToken, {});
    assert.strictEqual(r.status, 200, `refund failed: ${JSON.stringify(r.body)}`);

    const n = await frame;
    received.push(n);
    sock.close();

    assert.strictEqual(n.type, 'refund');
    assert.ok(n.id, 'the frame must carry an id so the client can de-duplicate it');
    assert.strictEqual(n.orderId, order2.orderId);
    assert.strictEqual(n.message, `Your refund has been processed successfully. Order #${order2.orderId}. Refund Amount: 100.00 ETB.`);
    assert.strictEqual(n.meta.refundStatus, 'REFUNDED');
    assert.strictEqual(received.length, 1);
  });

  console.log('\nThe standalone Refund ledger path (was the 500)');

  await check('PATCH /refunds/:id/complete returns 200, not 500', async () => {
    const order3 = await mkOrder({ paymentStatus: 'PAID', refundStatus: 'REFUND_REQUESTED' });
    const payment3 = await Payment.findOne({ orderId: order3._id });
    const refund = await Refund.create({
      orderId: order3._id,
      paymentId: payment3._id,
      amount: 100,
      reason: 'Customer request',
      requestedBy: customer._id,
      status: 'APPROVED',
    });

    const r = await call('PATCH', `/refunds/${refund._id}/complete`, mgrToken, { providerReference: 'CHAPA-REF-9001' });
    assert.strictEqual(r.status, 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.success, true);
  });

  await check('the ledger path also notifies the customer', async () => {
    const rows = await notificationsFor('ET-RF-0003');
    assert.strictEqual(rows.length, 1, 'the ledger path must persist a notification too');
    assert.strictEqual(rows[0].type, 'refund');
    assert.ok(/Order #ET-RF-0003/.test(rows[0].message));
  });

  console.log('\nA failed refund must NOT notify');

  await check('a refund that cannot complete leaves no success notification', async () => {
    const order4 = await mkOrder({ orderStatus: 'PENDING', status: 'pending' }); // not cancelled
    const r = await call('POST', `/admin/orders/${order4._id}/refund`, mgrToken, {});
    assert.notStrictEqual(r.status, 200, 'refunding a non-cancelled order must not succeed');
    const rows = await notificationsFor(order4.orderId);
    assert.strictEqual(rows.length, 0, 'no success notification may exist for a failed refund');
    const o = await Order.findById(order4._id);
    assert.notStrictEqual(o.paymentStatus, 'REFUNDED');
  });

  await check('the payments page reports failure instead of a false success', async () => {
    const order5 = await mkOrder(); // cancelled + PAID, but refund already completed
    const payment5 = await Payment.findOne({ orderId: order5._id });
    await call('POST', `/admin/orders/${order5._id}/refund`, mgrToken, {}); // completes it
    const again = await call('POST', `/payments/${payment5._id}/refund`, mgrToken, {});
    assert.notStrictEqual(again.status, 200, 'a refund that cannot complete must not answer success');
    assert.strictEqual(again.body.success, false);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log('Failed: ' + failures.join(', '));

  httpServer.close();
  sio.close();
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
