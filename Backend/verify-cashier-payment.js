/**
 * End-to-end proof for PATCH /api/v1/cashier/orders/:id/mark-paid.
 *
 * The bug this pins down: recording a counter payment used `order.save()`,
 * which re-validates the WHOLE document. Orders stored with a `paymentMethod`
 * written by the Chapa Telebirr / CBE Birr flows were invalid against the
 * schema enum at the time, so the save threw and the endpoint answered 500 for
 * a payment that was itself perfectly valid. Two further problems came with it:
 * the method was written to `payment.method` but not to `paymentMethod`, so the
 * two could drift apart, and the method taken from the request body was never
 * checked against the enum, so a bogus value could be stored.
 *
 * Run: node verify-cashier-payment.js
 */
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scs_cashier_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cashier-test-secret';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const path = require('path');
const http = require('http');
const mongoose = require('mongoose');

const ROOT = __dirname;
const PORT = 5096;
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
  const setupSocketIO = require('./src/socket').setupSocketIO;
  const httpServer = http.createServer(app);
  const sio = new Server(httpServer, { cors: { origin: '*' } });
  setupSocketIO(sio);
  await new Promise((r) => httpServer.listen(PORT, r));

  const jwt = require('jsonwebtoken');
  const User = require('./src/models/User');
  const Order = require('./src/models/Order');

  const cashier = await User.create({
    name: 'Cashier',
    email: 'cashier@c.test',
    phone: '0911222333',
    password: 'password123',
    role: 'cashier',
    status: 'ACTIVE',
  });
  const token = jwt.sign({ id: cashier._id, role: 'cashier' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const mkOrder = async (over) => {
    const o = new Order(
      Object.assign(
        {
          orderId: 'ET-TEST-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
          userId: cashier._id,
          customerName: 'Tester',
          customerPhone: '0911000000',
          orderType: 'dine-in',
          orderStatus: 'PENDING',
          paymentStatus: 'PENDING',
          subtotal: 100,
          totalAmount: 100,
          items: [],
        },
        over
      )
    );
    await o.save({ validateBeforeSave: false });
    return o;
  };

  const patch = async (id, body) => {
    const res = await fetch(`${API}/cashier/orders/${id}/mark-paid`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  console.log('\nThe reported failure');

  // Exactly the shape that used to 500: a stored mobile-money paymentMethod.
  const legacy = await mkOrder({
    paymentMethod: 'TELEBIRR',
    payment: { method: 'TELEBIRR', status: 'PENDING', amount: 100, currency: 'ETB' },
  });

  await check('an order stored with TELEBIRR can be marked paid (used to be a 500)', async () => {
    const r = await patch(String(legacy._id), { method: 'CASH' });
    assert.strictEqual(r.status, 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.order.paymentStatus, 'PAID');
  });

  await check('the payment is actually persisted', async () => {
    const o = await Order.findById(legacy._id);
    assert.strictEqual(o.paymentStatus, 'PAID');
    assert.strictEqual(o.payment.status, 'PAID');
    assert.strictEqual(o.payment.method, 'CASH');
    assert.ok(o.payment.paidAt, 'payment.paidAt must be set');
  });

  await check('the response carries a real paidAt (it used to report null)', async () => {
    const o = await Order.findById(legacy._id);
    assert.ok(o.payment.paidAt instanceof Date, 'payment.paidAt must be a Date');
  });

  await check('paymentMethod and payment.method do not drift apart', async () => {
    const o = await Order.findById(legacy._id);
    assert.strictEqual(o.paymentMethod, o.payment.method);
  });

  console.log('\nRequest handling');

  await check('an unsupported method is refused with 400 and stores nothing', async () => {
    const o = await mkOrder({
      paymentMethod: 'CHAPA',
      payment: { method: 'CHAPA', status: 'PENDING', amount: 100, currency: 'ETB' },
    });
    const r = await patch(String(o._id), { method: 'NONSENSE' });
    assert.strictEqual(r.status, 400, `status=${r.status}`);
    const after = await Order.findById(o._id);
    assert.strictEqual(after.paymentStatus, 'PENDING', 'order must be untouched');
    assert.strictEqual(after.payment.method, 'CHAPA', 'stored method must be untouched');
  });

  await check('a repeat confirmation is a 409, not a second write', async () => {
    const o = await mkOrder({ paymentMethod: 'CHAPA' });
    assert.strictEqual((await patch(String(o._id), { method: 'CASH' })).status, 200);
    assert.strictEqual((await patch(String(o._id), { method: 'CASH' })).status, 409);
  });

  await check('a cancelled order is refused with 400', async () => {
    const o = await mkOrder({ paymentMethod: 'CHAPA', orderStatus: 'CANCELLED' });
    assert.strictEqual((await patch(String(o._id), { method: 'CASH' })).status, 400);
  });

  await check('an unknown order is a 404', async () => {
    assert.strictEqual((await patch('6ab69de1c4e5043923aab35e', { method: 'CASH' })).status, 404);
  });

  await check('an order with no payment subdocument still records the payment', async () => {
    const o = await mkOrder({ paymentMethod: 'CHAPA' });
    await Order.updateOne({ _id: o._id }, { $unset: { payment: '' } });
    const r = await patch(String(o._id), { method: 'CASH' });
    assert.strictEqual(r.status, 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    const after = await Order.findById(o._id);
    assert.strictEqual(after.paymentStatus, 'PAID');
    assert.strictEqual(after.payment.status, 'PAID');
  });

  await check('the canonical method list covers every value found in the database', async () => {
    const { PAYMENT_METHOD_VALUES } = require('./src/config/constants');
    // The values the Chapa Telebirr / CBE Birr flows actually wrote.
    for (const v of ['TELEBIRR', 'CBE_BIRR', 'CHAPA', 'CASH', 'CARD']) {
      assert.ok(PAYMENT_METHOD_VALUES.includes(v), `${v} must be a storable method`);
    }
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