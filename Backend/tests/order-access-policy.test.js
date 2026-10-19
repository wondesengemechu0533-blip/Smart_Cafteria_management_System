/**
 * Order access: the cancel endpoint must agree with the read endpoint.
 *
 * THE BUG: `GET /orders/:id` let the owner, the assigned courier OR an
 * operations role through, but `POST /cancellations/request` only recognised
 * the owner or a literal `admin`/`system_admin`. A cafeteria manager or the
 * assigned courier could therefore open the cancellation page, be shown the
 * "Confirm Cancellation" button, click it, and be refused with:
 *
 *     "You can only cancel your own orders"
 *
 * which is not just unhelpful - it is false. They were not trying to cancel
 * their own order; they were legitimately acting on a customer's. Worse,
 * `admin.order.routes.js` already grants those very roles a working cancel
 * route (`POST /admin/orders/:id/cancel`), so the permission existed - only
 * the customer-facing endpoint failed to know about it.
 *
 * Run: node tests/order-access-policy.test.js
 */
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scs_order_access_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'order-access-test-secret';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');

const PORT = 5095;
const API = `http://127.0.0.1:${PORT}/api/v1`;

let passed = 0;
const failures = [];
const pending = [];
function check(name, fn) {
  pending.push((async () => {
    try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
    catch (e) { failures.push(name); console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); }
  })());
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const { app } = require('../server.js');
  const httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(PORT, r));

  const jwt = require('jsonwebtoken');
  const User = require('../src/models/User');
  const Order = require('../src/models/Order');
  const MenuItem = require('../src/models/MenuItem');
  const { describeOrderAccess, ORDER_CANCEL_ROLES } = require('../src/utils/order-access');

  const item = await MenuItem.create({ name: { en: 'Kitfo', am: 'k' }, category: 'Main', price: 50 });

  // Phone is unique in the User schema; the index is (re)built in the
  // background after the database drop, so sharing one number across users
  // races the index build and flakes with E11000. Give every user its own.
  let phoneSeq = 0;
  const mkUser = (name, role) =>
    User.create({
      name, email: `${name.toLowerCase().replace(/[^a-z]/g, '')}@o.test`,
      phone: '0911' + String(++phoneSeq).padStart(6, '0'),
      password: 'password123', role, status: 'ACTIVE',
    });

  const owner = await mkUser('Owner', 'customer');
  const manager = await mkUser('Manager', 'manager');
  const cafAdmin = await mkUser('CafAdmin', 'cafeteria_admin');
  const admin = await mkUser('Admin', 'admin');
  const cashier = await mkUser('Cashier', 'cashier');
  const rider = await mkUser('Rider', 'delivery');
  const stranger = await mkUser('Stranger', 'customer');

  const tok = (u) => jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const mkOrder = async (userId, over = {}) => {
    const o = new Order({
      orderId: 'ET-ACC-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      userId, customerName: 'Cust', customerPhone: '09', orderType: 'dine-in',
      orderStatus: 'PENDING', status: 'pending',
      paymentMethod: 'CASH', paymentStatus: 'PAID',
      subtotal: 100, serviceFee: 20, totalAmount: 120,
      items: [{ itemId: item._id, name: 'Kitfo', quantity: 2, price: 50, subtotal: 100 }],
      ...over,
    });
    await o.save({ validateBeforeSave: false });
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

  const cancel = (order, token) =>
    call('POST', '/cancellations/request', token, { orderId: order.orderId, reason: 'CUSTOMER_CHANGED_MIND', details: '' });

  console.log('\nThe customer who owns the order');

  await check('the owner can cancel their own order', async () => {
    const order = await mkOrder(owner._id);
    const r = await cancel(order, tok(owner));
    assert.strictEqual(r.status, 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.success, true);
  });

  console.log('');
  console.log('Staff acting on a customer order (the reported failure)');

  for (const [label, actor] of [['a cafeteria manager', manager], ['a cafeteria admin', cafAdmin], ['an admin', admin]]) {
    await check(`${label} can cancel a customer's order`, async () => {
      const order = await mkOrder(owner._id);
      const r = await cancel(order, tok(actor));
      assert.strictEqual(r.status, 200, `status=${r.status} error=${r.body.error}`);
      assert.ok(!/your own orders/i.test(r.body.error || ''), 'must not claim it is their own order');
    });
  }

  await check('the old "You can only cancel your own orders" error is gone entirely', async () => {
    const order = await mkOrder(owner._id);
    for (const actor of [manager, cafAdmin, cashier, rider, stranger]) {
      const r = await cancel(order, tok(actor));
      assert.ok(
        !/You can only cancel your own orders/i.test(r.body.error || ''),
        `${actor.role} still receives the misleading message: ${r.body.error}`
      );
    }
  });

  console.log('');
  console.log('Read and cancel must agree');

  await check('anyone who can load the order as an operator can also cancel it', async () => {
    for (const [label, actor] of [['manager', manager], ['cafeteria_admin', cafAdmin], ['admin', admin]]) {
      const order = await mkOrder(owner._id);
      const read = await call('GET', `/orders/${order.orderId}`, tok(actor));
      const can = await cancel(order, tok(actor));
      assert.strictEqual(read.status, 200, `${label} should be able to read`);
      assert.strictEqual(can.status, 200, `${label} could read the order but not cancel it`);
    }
  });

  console.log('');
  console.log('Refusals are still refusals, and they are honest');

  await check('an unrelated customer is refused', async () => {
    const order = await mkOrder(owner._id);
    const r = await cancel(order, tok(stranger));
    assert.strictEqual(r.status, 403);
    assert.ok(!/your own orders/i.test(r.body.error || ''));
  });

  await check('the assigned courier is refused, and told why', async () => {
    // Read access is required to deliver the order, but delivering it must not
    // confer the authority to cancel it and trigger a refund.
    const order = await mkOrder(owner._id, { deliveryStaffAssigned: rider._id, orderType: 'delivery' });
    const read = await call('GET', `/orders/${order.orderId}`, tok(rider));
    assert.strictEqual(read.status, 200, 'the courier can still read the order');

    const r = await cancel(order, tok(rider));
    assert.strictEqual(r.status, 403, 'a courier must not be able to cancel');
    assert.ok(/manager|cafeteria administrator/i.test(r.body.error || ''), `should point at who can help, got: ${r.body.error}`);
  });

  await check('a cashier cannot cancel a customer order', async () => {
    const order = await mkOrder(owner._id);
    const r = await cancel(order, tok(cashier));
    assert.strictEqual(r.status, 403);
  });

  console.log('');
  console.log('The eligibility endpoint must not disagree with the cancel endpoint');

  await check('check says cancellable exactly when cancel is allowed', async () => {
    for (const [label, actor] of [
      ['owner', owner], ['manager', manager], ['cafeteria_admin', cafAdmin],
      ['admin', admin], ['cashier', cashier], ['stranger', stranger],
    ]) {
      const order = await mkOrder(owner._id);
      const token = tok(actor);

      const view = await call('GET', `/orders/${order.orderId}`, token);
      if (view.status !== 200) continue; // cannot even see it - nothing to promise

      const checkRes = await call('GET', `/cancellations/${order.orderId}/check`, token);
      if (checkRes.status !== 200) continue;

      const actual = await cancel(order, token);
      const promised = checkRes.body.canCancel === true;
      assert.strictEqual(
        promised,
        actual.status === 200,
        `${label}: check said canCancel=${promised} but cancel returned ${actual.status}`
      );
    }
  });

  console.log('');
  console.log('The shared policy itself');

  await check('no one loses access they already had via the staff cancel route', () => {
    // The regression that caused the reported bug runs one way only: an actor
    // who could already reach the order (and therefore the Confirm button) was
    // refused by the customer-facing endpoint. So assert THAT direction - every
    // operations role the staff route accepts must be able to cancel here too.
    const routeFile = require('path').join(__dirname, '..', 'src', 'routes', 'admin.order.routes.js');
    const route = require('fs').readFileSync(routeFile, 'utf8');
    const authorizeLine = route.split('\n').find((l) => l.includes('router.use(authorize(')) || '';
    assert.ok(authorizeLine, 'could not find the staff cancel route authorize() guard');

    const { OPERATIONS_ROLES } = require('../src/utils/order-access');
    for (const role of OPERATIONS_ROLES) {
      const access = describeOrderAccess({ userId: 'someone-else' }, { id: 'me', role });
      assert.strictEqual(
        access.canCancel,
        true,
        `${role} is an operations role and can reach the cancel button, but /cancellations/request refuses it`
      );
    }
  });

  await check('every role the cancel endpoint accepts can also read the order', () => {
    const order = { userId: 'someone-else', deliveryStaffAssigned: null };
    for (const role of ORDER_CANCEL_ROLES) {
      const access = describeOrderAccess(order, { id: 'me', role });
      assert.strictEqual(access.canView, true, `${role} can cancel but not view - impossible state`);
    }
  });

  await check('an unassigned courier can view but never cancel', () => {
    const order = { userId: 'someone-else', deliveryStaffAssigned: null };
    const access = describeOrderAccess(order, { id: 'me', role: 'delivery' });
    assert.strictEqual(access.canView, false);
    assert.strictEqual(access.canCancel, false);
  });

  await check('a populated deliveryStaffAssigned still resolves to the courier', () => {
    const order = { userId: 'someone-else', deliveryStaffAssigned: { _id: 'me', name: 'Rider' } };
    const access = describeOrderAccess(order, { id: 'me', role: 'delivery' });
    assert.strictEqual(access.isAssignedCourier, true, 'a populated courier doc must still be recognised');
    assert.strictEqual(access.canView, true);
    assert.strictEqual(access.canCancel, false);
  });

  await Promise.all(pending);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log('Failed: ' + failures.join(', '));

  httpServer.close();
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
