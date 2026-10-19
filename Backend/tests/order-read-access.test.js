/**
 * GET /api/v1/orders/:id - WHO may read an order.
 *
 * WHY this exists: the customer tracking page polls this endpoint every 5s and
 * was logging a 403 forever. The cause was a hardcoded role list in
 * getOrderById():
 *
 *     ['admin', 'staff', 'kitchen', 'kitchen_staff', 'foodmaker']
 *
 * which had drifted from config/roles.js. It omitted `delivery`, `manager`,
 * `cafeteria_admin` and `system_admin`, so the courier ASSIGNED to a delivery
 * was refused the order they were delivering - while every other delivery-aware
 * endpoint in this codebase documents its audience as "the customer who owns it,
 * the assigned courier, or management" (see delivery.controller.js
 * getDelivery() / getDeliveryTracking()).
 *
 * This is an AUTHORIZATION test, so it asserts BOTH directions: the audiences
 * that must be allowed, and - just as importantly - the ones that must stay
 * refused. A test that only checked "the courier can read it" would pass just as
 * happily if the check had been replaced with `return true`.
 *
 * Run: node Backend/tests/order-read-access.test.js
 */
const assert = require('assert');
const Module = require('module');

let pass = 0;
let fail = 0;
const pendingChecks = [];
function check(name, fn) {
  pendingChecks.push((async () => {
    try { await fn(); pass++; console.log('  PASS ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + ' -- ' + e.message); }
  })());
}

const OWNER_ID = 'owner-1';
const COURIER_ID = 'courier-1';
const OTHER_ID = 'stranger-1';

/** A populated order: `deliveryStaffAssigned` is a document, as it is in prod. */
function makeOrder(over) {
  const o = Object.assign({
    _id: 'order-1',
    orderId: 'ET-TEST-1',
    userId: OWNER_ID,
    orderType: 'delivery',
    status: 'out_for_delivery',
    orderStatus: 'OUT_FOR_DELIVERY',
    items: [{ name: 'Kitfo', quantity: 1, price: 100 }],
    deliveryInfo: { subCity: 'Bole', location: 'Bole', latitude: 9.0, longitude: 38.7 },
    deliveryStaffAssigned: { _id: COURIER_ID, name: 'Rider', phone: '09', role: 'delivery' },
    getSummary() { return { orderId: this.orderId, status: this.status }; },
  }, over || {});
  return o;
}

function loadController(order) {
  const originalLoad = Module._load;

  const OrderStub = {
    findOne() {
      const c = {
        populate() { return c; },
        then(resolve) { return Promise.resolve(order === undefined ? null : order).then(resolve); },
        catch(reject) { return Promise.reject(reject); },
      };
      return c;
    },
  };
  const leanChain = (value) => ({ lean() { return Promise.resolve(value); } });

  const stubs = {
    '../models/Order': OrderStub,
    '../models/Cafeteria': {
      findById: () => Promise.resolve({ name: 'Main', latitude: 9, longitude: 38 }),
      findOne: () => Promise.resolve({ name: 'Main', latitude: 9, longitude: 38 }),
    },
    '../models/Delivery': { findOne: () => leanChain(null) },
  };

  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalLoad.apply(this, arguments);
  };
  const ctrlPath = require.resolve('../src/controllers/order.controller.js');
  delete require.cache[ctrlPath];
  let controller;
  try { controller = require(ctrlPath); }
  finally { Module._load = originalLoad; }
  return controller;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  return res;
}

/** GET /orders/:id as `viewer`, against an order built by `orderFactory`. */
async function readAs(viewer, orderFactory) {
  const controller = loadController(orderFactory ? orderFactory() : makeOrder());
  const res = fakeRes();
  await controller.getOrderById({ params: { id: 'ET-TEST-1' }, user: viewer }, res);
  return res;
}

(async () => {
  console.log('========== ORDER READ ACCESS ==========');
  console.log('');

  /* --- MUST be allowed ----------------------------------------------------- */
  check('the customer who owns the order', async () => {
    const r = await readAs({ id: OWNER_ID, role: 'customer' });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.order.orderId, 'ET-TEST-1');
  });

  check('the ASSIGNED courier - the regression that started this', async () => {
    const r = await readAs({ id: COURIER_ID, role: 'delivery' });
    assert.strictEqual(r.statusCode, 200,
      'the courier assigned to this delivery cannot read the order they are delivering');
  });

  check('an unpopulated courier id still matches (bare ObjectId)', async () => {
    // Defence in depth: if the populate is ever dropped or the field is read
    // before it runs, the id must still compare equal.
    const r = await readAs({ id: COURIER_ID, role: 'delivery' }, () =>
      makeOrder({ deliveryStaffAssigned: COURIER_ID }));
    assert.strictEqual(r.statusCode, 200,
      'the courier check only works on a populated document');
  });

  ['admin', 'system_admin', 'manager', 'cafeteria_admin', 'kitchen'].forEach((role) => {
    check(`management/staff role "${role}"`, async () => {
      const r = await readAs({ id: OTHER_ID, role });
      assert.strictEqual(r.statusCode, 200, `${role} was refused`);
    });
  });

  check('the "foodmaker" alias resolves to kitchen', async () => {
    const r = await readAs({ id: OTHER_ID, role: 'foodmaker' });
    assert.strictEqual(r.statusCode, 200, 'an aliased role stopped working');
  });

  /* --- MUST stay refused --------------------------------------------------- */
  check('a different customer is still refused', async () => {
    const r = await readAs({ id: OTHER_ID, role: 'customer' });
    assert.strictEqual(r.statusCode, 403);
  });

  check('an UNASSIGNED rider is still refused', async () => {
    // Granting `delivery` must not have granted every rider every order.
    const r = await readAs({ id: 'some-other-rider', role: 'delivery' });
    assert.strictEqual(r.statusCode, 403,
      'any delivery account can now read any order');
  });

  check('the cashier is still refused', async () => {
    const r = await readAs({ id: OTHER_ID, role: 'cashier' });
    assert.strictEqual(r.statusCode, 403);
  });

  check('the tax authority is still refused', async () => {
    const r = await readAs({ id: OTHER_ID, role: 'tax_authority' });
    assert.strictEqual(r.statusCode, 403);
  });

  /* --- unchanged behaviour around the check -------------------------------- */
  check('a missing order is still 404, not 403', async () => {
    const r = await readAs({ id: OWNER_ID, role: 'customer' }, () => undefined);
    assert.strictEqual(r.statusCode, 404);
  });

  check('the refusal body still names the order, not the viewer', async () => {
    const r = await readAs({ id: OTHER_ID, role: 'customer' });
    assert.strictEqual(r.body.success, false);
    assert.strictEqual(r.body.error, 'Unauthorized to view this order');
  });

  check('the check keys on normalizeRole, not on raw string equality', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'controllers', 'order.controller.js'), 'utf8');
    const fn = src.slice(src.indexOf('exports.getOrderById'));
    assert.ok(!/const isStaff = \[/.test(fn),
      "the hardcoded role list is back in getOrderById()");
    assert.ok(/normalizeRole\(req\.user\.role\)/.test(fn),
      'getOrderById() no longer normalizes the viewer role');
  });

  await Promise.all(pendingChecks);

  console.log('');
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });