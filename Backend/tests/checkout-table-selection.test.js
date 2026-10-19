/**
 * Dine-In table selection at checkout.
 *
 * Covers the customer-facing flow end to end against a real (local) MongoDB:
 *   - GET /tables/available returns ONLY available + enabled tables.
 *   - A dine-in order for an available table is accepted and that table is
 *     atomically flipped to 'occupied' (so it leaves the available list).
 *   - Two customers racing for the SAME table: exactly one wins, the other gets
 *     a clear 409 TABLE_UNAVAILABLE (the anti-double-booking guarantee).
 *   - Dine-in without a table is rejected; takeaway/delivery never touch a table.
 *   - A rejected order (e.g. out of stock) leaves the table available, not stuck.
 *
 * Run: node tests/checkout-table-selection.test.js
 */
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scs_checkout_table_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'checkout-table-test-secret';
process.env.NODE_ENV = 'test';

// Hard guard: this suite DROPS its database. Never let it run against anything
// but a local Mongo instance.
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(process.env.MONGODB_URI)) {
  console.error('Refusing to run: MONGODB_URI must point at localhost. Got:', process.env.MONGODB_URI);
  process.exit(1);
}

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');

const PORT = 5097;
const API = `http://127.0.0.1:${PORT}/api/v1`;

let passed = 0;
const failures = [];
// Sequential on purpose: the checks share table state (reserve -> list -> race).
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); }
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const { app } = require('../server.js');
  const httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(PORT, r));

  const jwt = require('jsonwebtoken');
  const User = require('../src/models/User');
  const Table = require('../src/models/Table');
  const MenuItem = require('../src/models/MenuItem');

  const customer = await User.create({
    name: 'Test Customer',
    email: 'checkout-table@test.local',
    phone: '0911223344',
    password: 'password123',
    role: 'customer',
    status: 'ACTIVE',
  });
  const token = jwt.sign({ id: customer._id, role: customer.role }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const item = await MenuItem.create({
    name: { en: 'Test Injera', am: 'ጤስት' },
    category: 'Main',
    price: 50,
    stockQuantity: 100,
  });

  // Mixed statuses so the "available only" filter has something to exclude.
  const tAvail1 = await Table.create({ tableNumber: 'T1', seats: 2, zone: 'Window', status: 'available', isActive: true });
  const tOccupied = await Table.create({ tableNumber: 'T2', seats: 4, zone: 'Hall', status: 'occupied', isActive: true });
  const tReserved = await Table.create({ tableNumber: 'T3', seats: 4, zone: 'Hall', status: 'reserved', isActive: true });
  const tMaint = await Table.create({ tableNumber: 'T4', seats: 6, zone: 'Terrace', status: 'maintenance', isActive: true });
  const tDisabled = await Table.create({ tableNumber: 'T5', seats: 4, zone: 'Hall', status: 'available', isActive: false });
  const tAvail2 = await Table.create({ tableNumber: 'T6', seats: 8, zone: 'Group', status: 'available', isActive: true });

  const call = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const orderBody = (over = {}) => ({
    items: [{ id: String(item._id), name: 'Test Injera', quantity: 1, price: 50 }],
    customerName: 'Test Customer',
    customerPhone: '0911223344',
    orderType: 'dine-in',
    paymentMethod: 'CHAPA',
    totalAmount: 50,
    ...over,
  });

  console.log('\nCustomer-facing available tables');
  await check('GET /tables/available returns only available, enabled tables', async () => {
    const r = await call('GET', '/tables/available');
    assert.strictEqual(r.status, 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.success, true);
    const nums = r.body.tables.map((t) => t.tableNumber).sort();
    assert.deepStrictEqual(nums, ['T1', 'T6'], `got ${JSON.stringify(nums)}`);
    const t1 = r.body.tables.find((t) => t.tableNumber === 'T1');
    assert.ok(t1.id, 'each table must expose its real database id');
    assert.strictEqual(t1.status, 'available');
  });

  console.log('\nDine-In reserves the chosen table');
  await check('a dine-in order for an available table is accepted and reserves it', async () => {
    const r = await call('POST', '/orders', orderBody({ tableId: String(tAvail1._id), tableNumber: 'T1' }));
    assert.strictEqual(r.status, 201, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(String(r.body.order.tableId), String(tAvail1._id));
    assert.strictEqual(r.body.order.tableNumber, 'T1');
    const fresh = await Table.findById(tAvail1._id);
    assert.strictEqual(fresh.status, 'occupied', 'the table must become occupied');
  });

  await check('the reserved table disappears from the available list', async () => {
    const r = await call('GET', '/tables/available');
    assert.deepStrictEqual(r.body.tables.map((t) => t.tableNumber).sort(), ['T6']);
  });

  await check('a second order for the same table is rejected as unavailable', async () => {
    const r = await call('POST', '/orders', orderBody({ tableId: String(tAvail1._id), tableNumber: 'T1' }));
    assert.strictEqual(r.status, 409, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'TABLE_UNAVAILABLE');
  });

  await check('dine-in without a table is rejected', async () => {
    const r = await call('POST', '/orders', orderBody({ tableId: '', tableNumber: '' }));
    assert.strictEqual(r.status, 400, `status=${r.status} body=${JSON.stringify(r.body)}`);
  });

  await check('an occupied/reserved/disabled table cannot be selected', async () => {
    for (const t of [tOccupied, tReserved, tMaint, tDisabled]) {
      const r = await call('POST', '/orders', orderBody({ tableId: String(t._id), tableNumber: t.tableNumber }));
      assert.strictEqual(r.status, 409, `${t.tableNumber}: status=${r.status} body=${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'TABLE_UNAVAILABLE', `${t.tableNumber}: missing TABLE_UNAVAILABLE`);
    }
  });

  console.log('\nAtomicity: two customers, one table');
  await check('exactly one of two concurrent orders wins the same table', async () => {
    const [a, b] = await Promise.all([
      call('POST', '/orders', orderBody({ tableId: String(tAvail2._id), tableNumber: 'T6' })),
      call('POST', '/orders', orderBody({ tableId: String(tAvail2._id), tableNumber: 'T6' })),
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepStrictEqual(codes, [201, 409], `statuses=${JSON.stringify([a.status, b.status])} bodies=${JSON.stringify([a.body, b.body])}`);
    const loser = a.status === 409 ? a : b;
    assert.strictEqual(loser.body.code, 'TABLE_UNAVAILABLE');
  });

  console.log('\nTakeaway / Delivery stay table-free');
  await check('a takeaway order is accepted and does not touch any table', async () => {
    const before = await Table.find({}).select('status').lean();
    const r = await call('POST', '/orders', orderBody({ orderType: 'takeaway', tableId: '', tableNumber: 'N/A (Takeaway)' }));
    assert.strictEqual(r.status, 201, `status=${r.status} body=${JSON.stringify(r.body)}`);
    const after = await Table.find({}).select('status').lean();
    assert.deepStrictEqual(after.map((t) => t.status), before.map((t) => t.status), 'no table status should change');
  });

  console.log('\nA rejected order leaves the table available');
  await check('an out-of-stock item does not strand the table as occupied', async () => {
    const tFresh = await Table.create({ tableNumber: 'T9', seats: 2, zone: 'Hall', status: 'available', isActive: true });
    const thinItem = await MenuItem.create({ name: { en: 'Rare Dish', am: 'r' }, category: 'Main', price: 10, stockQuantity: 1 });
    const r = await call('POST', '/orders', orderBody({
      items: [{ id: String(thinItem._id), name: 'Rare Dish', quantity: 5, price: 10 }],
      tableId: String(tFresh._id),
      tableNumber: 'T9',
    }));
    assert.ok(r.status >= 400, `expected rejection, got ${r.status}`);
    const fresh = await Table.findById(tFresh._id);
    assert.strictEqual(fresh.status, 'available', 'table must remain available after a rejected order');
  });

  await new Promise((r) => httpServer.close(r));
  await mongoose.disconnect();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('Failed checks:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
