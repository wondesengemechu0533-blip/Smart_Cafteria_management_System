/**
 * ============================================================================
 * ROLE RESPONSIBILITIES & SETTINGS PERMISSIONS - acceptance test
 * ============================================================================
 * Drives the REAL backend against a REAL MongoDB and exercises the role
 * matrix from the product spec:
 *
 *   Cafeteria Manager : own profile, own password/2FA, cafeteria opening
 *                       hours, delivery + service fees (ONLY when the System
 *                       Admin authorized it), cafeteria operations.
 *                       RESTRICTED: global currency, global order limits,
 *                       system-wide security & access.
 *   System Admin      : everything, including global currency, global order
 *                       limits, tax policy and system-wide security.
 *
 * Covered:
 *   1. Manager may change the cafeteria operating settings (opening hours).
 *   2. Manager may change BOTH fees, and they stay SEPARATE values.
 *   3. Manager gets 403 for currency / order limits / tax / security.
 *   4. Admin may change all of them.
 *   5. Fees are validated: finite and non-negative.
 *   6. Revoking the fee authorization blocks the manager with 403 and
 *      granting it back lets the manager through.
 *   7. Updates persist in MongoDB and survive a fresh sign-in.
 *   8. Notification preferences are PER USER (one user never changes
 *      another's).
 *   9. 2FA is PER USER (the global policy setting stays untouched).
 *  10. Order money is computed on the backend and snapshotted: changing the
 *      fees later never rewrites an existing order.
 *
 * Run: node Backend/tests/settings-permissions.test.js
 * ============================================================================
 */
process.env.MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scs_settings_permissions_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'settings-permissions-test-secret';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');

const PORT = 5098;
const API = `http://127.0.0.1:${PORT}/api/v1`;

let passed = 0;
const failures = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((e) => {
      failures.push(name);
      console.log(`  FAIL ${name}`);
      console.log(`       ${e.message}`);
    });
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const { app } = require('../server.js');
  const httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(PORT, r));

  const jwt = require('jsonwebtoken');
  const User = require('../src/models/User');
  const Setting = require('../src/models/Setting');
  const MenuItem = require('../src/models/MenuItem');
  const Order = require('../src/models/Order');
  const { ensureDefaultSettings } = require('../src/utils/settings');
  const { ensureDefaultCafeteria, getDefaultCafeteriaId } = require('../src/utils/cafeteria');

  await ensureDefaultSettings();
  await ensureDefaultCafeteria();
  const cafeteriaId = await getDefaultCafeteriaId();

  let phoneSeq = 0;
  const mkUser = (name, role, caf = null) =>
    User.create({
      name,
      email: `${name.toLowerCase().replace(/[^a-z]/g, '')}@settings.test`,
      phone: '0912' + String(++phoneSeq).padStart(6, '0'),
      password: 'password123',
      role,
      status: 'ACTIVE',
      cafeteriaId: caf,
    });

  const sysAdmin = await mkUser('SysAdmin', 'admin');
  const manager = await mkUser('Manager', 'manager', cafeteriaId);
  const manager2 = await mkUser('ManagerTwo', 'manager', cafeteriaId);
  const customer = await mkUser('Customer', 'customer');

  const tok = (u) => jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const T = {
    sysAdmin: tok(sysAdmin),
    manager: tok(manager),
    manager2: tok(manager2),
    customer: tok(customer),
  };

  const call = async (method, path, token, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const setSetting = (token, key, value) => call('PUT', `/admin/settings/${encodeURIComponent(key)}`, token, { value });
  const readSetting = async (key) => {
    const row = await Setting.findOne({ key }).lean();
    return row ? row.value : undefined;
  };

  console.log('\n1. Cafeteria Manager: cafeteria operating settings');
  // ----------------------------------------------------------------------
  await check('every key in the permission matrix is a known setting', () => {
    const perms = require('../src/config/setting-permissions');
    const { DEFAULT_SETTINGS } = require('../src/utils/settings');
    const known = new Set(DEFAULT_SETTINGS.map((s) => s.key));
    const all = [
      ...perms.SYSTEM_ADMIN_ONLY_KEYS,
      ...perms.CAFETERIA_MANAGED_KEYS,
      ...perms.FEE_KEYS,
      perms.MANAGER_FEE_AUTHORIZATION_KEY,
    ];
    const missing = all.filter((k) => !known.has(k));
    assert.deepStrictEqual(missing, [], 'unknown setting keys in the permission matrix');
    // Every default setting must be classified, otherwise it would be an
    // orphan that no role could ever change.
    const classified = new Set(all);
    const orphans = DEFAULT_SETTINGS.map((s) => s.key).filter((k) => !classified.has(k));
    assert.deepStrictEqual(orphans, [], 'settings that no role may change');
  });

  await check('manager can update the cafeteria opening time', async () => {
    const r = await setSetting(T.manager, 'cafeteria_opening_time', '06:30');
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await readSetting('cafeteria_opening_time'), '06:30');
  });

  await check('manager can update the cafeteria closing time', async () => {
    const r = await setSetting(T.manager, 'cafeteria_closing_time', '21:45');
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await readSetting('cafeteria_closing_time'), '21:45');
  });

  await check('manager can toggle online ordering (cafeteria operation)', async () => {
    const r = await setSetting(T.manager, 'order_availability', false);
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
    assert.strictEqual(await readSetting('order_availability'), false);
    await setSetting(T.manager, 'order_availability', true);
  });

  console.log('\n2. Fees: manager may change both, and they stay separate');
  // ----------------------------------------------------------------------
  await check('manager can update the delivery fee when authorized', async () => {
    const r = await setSetting(T.manager, 'delivery_fee', 45);
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await readSetting('delivery_fee'), 45);
  });

  await check('manager can update the service fee when authorized', async () => {
    const r = await setSetting(T.manager, 'service_fee', 15);
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await readSetting('service_fee'), 15);
  });

  await check('delivery fee and service fee are stored as two separate records', async () => {
    const rows = await Setting.find({ key: { $in: ['delivery_fee', 'service_fee'] } }).lean();
    assert.strictEqual(rows.length, 2, 'exactly two fee records must exist');
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    assert.strictEqual(byKey.delivery_fee, 45);
    assert.strictEqual(byKey.service_fee, 15);
    assert.notStrictEqual(byKey.delivery_fee, byKey.service_fee, 'the two fees must be independent values');
  });

  await check('only one record exists per fee key (no duplicates)', async () => {
    const dupes = await Setting.aggregate([
      { $group: { _id: '$key', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    assert.strictEqual(dupes.length, 0, `duplicate setting keys: ${JSON.stringify(dupes)}`);
  });

  console.log('\n3. Restricted settings are refused for the manager');
  // ----------------------------------------------------------------------
  const restrictedForManager = [
    ['currency', 'USD'],
    ['max_daily_orders', 250],
    ['max_order_quantity', 25],
    ['minimum_order_amount', 100],
    ['vat_rate', 10],
    ['platform_fee_rate', 5],
    ['session_timeout_minutes', 30],
    ['login_max_attempts', 3],
    ['two_factor_enabled', true],
    ['admin_account_enabled', false],
    ['manager_fee_management_enabled', false],
  ];

  for (const [key, value] of restrictedForManager) {
    await check(`manager is refused "${key}" with 403`, async () => {
      const before = await readSetting(key);
      const r = await setSetting(T.manager, key, value);
      assert.strictEqual(r.status, 403, `expected 403, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(await readSetting(key), before, 'the stored value must be untouched');
    });
  }

  await check('manager is refused an unknown setting key', async () => {
    const r = await setSetting(T.manager, 'not_a_real_setting', 1);
    assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
  });

  console.log('\n4. System Admin may configure and override everything');
  // ----------------------------------------------------------------------
  await check('admin can update the global currency', async () => {
    const r = await setSetting(T.sysAdmin, 'currency', 'USD');
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await readSetting('currency'), 'USD');
    await setSetting(T.sysAdmin, 'currency', 'ETB');
  });

  await check('admin can update the global order limits', async () => {
    const r = await setSetting(T.sysAdmin, 'max_daily_orders', 250);
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
    assert.strictEqual(await readSetting('max_daily_orders'), 250);
  });

  await check('admin can update the system-wide security policy', async () => {
    const r = await setSetting(T.sysAdmin, 'session_timeout_minutes', 30);
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
    assert.strictEqual(await readSetting('session_timeout_minutes'), 30);
    await setSetting(T.sysAdmin, 'session_timeout_minutes', 10);
  });

  await check('admin can override the fees', async () => {
    const r = await setSetting(T.sysAdmin, 'delivery_fee', 55);
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
    assert.strictEqual(await readSetting('delivery_fee'), 55);
  });

  console.log('\n5. Fee validation');
  // ----------------------------------------------------------------------
  await check('a negative delivery fee is rejected with 400', async () => {
    const before = await readSetting('delivery_fee');
    const r = await setSetting(T.sysAdmin, 'delivery_fee', -5);
    assert.strictEqual(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await readSetting('delivery_fee'), before);
  });

  await check('a negative service fee is rejected with 400', async () => {
    const before = await readSetting('service_fee');
    const r = await setSetting(T.sysAdmin, 'service_fee', -1);
    assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
    assert.strictEqual(await readSetting('service_fee'), before);
  });

  await check('a non-finite fee is rejected with 400', async () => {
    const before = await readSetting('delivery_fee');
    const r = await setSetting(T.sysAdmin, 'delivery_fee', 'Infinity');
    assert.strictEqual(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await readSetting('delivery_fee'), before);
  });

  await check('a zero fee is accepted (free delivery is a valid choice)', async () => {
    const r = await setSetting(T.sysAdmin, 'delivery_fee', 0);
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
    assert.strictEqual(await readSetting('delivery_fee'), 0);
  });

  console.log('\n6. The fee authorization switch');
  // ----------------------------------------------------------------------
  await check('admin revokes manager fee management -> manager gets 403', async () => {
    const r = await setSetting(T.sysAdmin, 'manager_fee_management_enabled', false);
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
    assert.strictEqual(await readSetting('manager_fee_management_enabled'), false);

    const fee = await setSetting(T.manager, 'delivery_fee', 60);
    assert.strictEqual(fee.status, 403, `expected 403, got ${fee.status} ${JSON.stringify(fee.body)}`);

    const svc = await setSetting(T.manager, 'service_fee', 25);
    assert.strictEqual(svc.status, 403, `expected 403, got ${svc.status}`);
  });

  await check('the manager still owns the cafeteria operating settings while revoked', async () => {
    const r = await setSetting(T.manager, 'cafeteria_opening_time', '05:45');
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
    assert.strictEqual(await readSetting('cafeteria_opening_time'), '05:45');
  });

  await check('admin grants fee management again -> manager is allowed', async () => {
    await setSetting(T.sysAdmin, 'manager_fee_management_enabled', true);
    const r = await setSetting(T.manager, 'delivery_fee', 35);
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await readSetting('delivery_fee'), 35);
  });

  console.log('\n7. Persistence across a fresh sign-in');
  // ----------------------------------------------------------------------
  await check('a saved value is still there after a new login (new token)', async () => {
    await setSetting(T.manager, 'cafeteria_closing_time', '23:15');
    const freshToken = tok(manager); // simulates signing in again
    const r = await call('GET', '/admin/settings', freshToken);
    assert.strictEqual(r.status, 200);
    const row = r.body.settings.find((s) => s.key === 'cafeteria_closing_time');
    assert.ok(row, 'cafeteria_closing_time must be returned');
    assert.strictEqual(row.value, '23:15');
  });

  await check('GET /admin/settings returns the permission matrix for the caller', async () => {
    const asManager = await call('GET', '/admin/settings', T.manager);
    assert.strictEqual(asManager.status, 200);
    assert.strictEqual(asManager.body.permissions.role, 'manager');
    assert.strictEqual(asManager.body.permissions.isSystemAdmin, false);
    assert.strictEqual(asManager.body.permissions.editable.cafeteria_opening_time, true);
    assert.strictEqual(asManager.body.permissions.editable.delivery_fee, true);
    assert.strictEqual(asManager.body.permissions.editable.currency, false);
    assert.strictEqual(asManager.body.permissions.editable.max_daily_orders, false);
    assert.strictEqual(asManager.body.permissions.editable.session_timeout_minutes, false);
    assert.ok(
      asManager.body.permissions.restricted.currency,
      'the reason a setting is restricted must be sent to the client'
    );

    const asAdmin = await call('GET', '/admin/settings', T.sysAdmin);
    assert.strictEqual(asAdmin.body.permissions.isSystemAdmin, true);
    assert.strictEqual(asAdmin.body.permissions.editable.currency, true);
    assert.strictEqual(asAdmin.body.permissions.editable.session_timeout_minutes, true);
  });

  console.log('\n8. Notification preferences are per user');
  // ----------------------------------------------------------------------
  await check('a manager can read and write their own notification preferences', async () => {
    const put = await call('PUT', '/notifications/preferences', T.manager, {
      newOrders: false,
      lowStock: false,
      dailySales: true,
      securityLogin: false,
    });
    assert.strictEqual(put.status, 200, `expected 200, got ${put.status} ${JSON.stringify(put.body)}`);

    const get = await call('GET', '/notifications/preferences', T.manager);
    assert.strictEqual(get.status, 200);
    assert.strictEqual(get.body.preferences.newOrders, false);
    assert.strictEqual(get.body.preferences.lowStock, false);
    assert.strictEqual(get.body.preferences.dailySales, true);
    assert.strictEqual(get.body.preferences.securityLogin, false);
  });

  await check("another user's preferences are untouched", async () => {
    const get = await call('GET', '/notifications/preferences', T.manager2);
    assert.strictEqual(get.status, 200);
    assert.strictEqual(get.body.preferences.newOrders, true, 'manager2 must still have the default');
    assert.strictEqual(get.body.preferences.dailySales, false);

    const doc = await User.findById(manager2._id).lean();
    assert.strictEqual(doc.notificationPreferences.newOrders, true);
  });

  await check('the preference is stored on the user document in MongoDB', async () => {
    const doc = await User.findById(manager._id).lean();
    assert.strictEqual(doc.notificationPreferences.newOrders, false);
    assert.strictEqual(doc.notificationPreferences.dailySales, true);
  });

  console.log('\n9. 2FA is per account');
  // ----------------------------------------------------------------------
  await check('a manager can enable 2FA on their OWN account', async () => {
    const r = await call('PUT', '/auth/me', T.manager, { twoFactorEnabled: true });
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.user.twoFactorEnabled, true);

    const doc = await User.findById(manager._id).lean();
    assert.strictEqual(doc.twoFactorEnabled, true);
  });

  await check("another account's 2FA state is untouched", async () => {
    const doc = await User.findById(sysAdmin._id).lean();
    assert.notStrictEqual(doc.twoFactorEnabled, true, 'the admin must not inherit the manager 2FA');
  });

  await check('enabling 2FA does NOT change the global 2FA policy setting', async () => {
    const before = await readSetting('two_factor_enabled');
    assert.strictEqual(await readSetting('two_factor_enabled'), before);
  });

  await check('a manager still cannot change the global 2FA policy setting', async () => {
    const r = await setSetting(T.manager, 'two_factor_enabled', true);
    assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
  });

  console.log('\n10. Order money: backend-computed and snapshotted');
  // ----------------------------------------------------------------------
  const item = await MenuItem.create({
    cafeteriaId,
    name: { en: 'Test Tea', am: 'Test Tea' },
    category: 'Beverages',
    price: 100,
    stockQuantity: 50,
    lowStockThreshold: 5,
    availabilityStatus: 'AVAILABLE',
    isActive: true,
    isAvailable: true,
    availability: true,
  });

  await check('an order snapshot keeps its fees after the settings change', async () => {
    await setSetting(T.sysAdmin, 'delivery_fee', 40);
    await setSetting(T.sysAdmin, 'service_fee', 20);

    const placed = await call('POST', '/orders', T.customer, {
      customerName: 'Fee Tester',
      customerPhone: '0911223344',
      orderType: 'takeaway',
      paymentMethod: 'CHAPA',
      items: [{ id: String(item._id), quantity: 2 }],
    });
    assert.strictEqual(placed.status, 201, `expected 201, got ${placed.status} ${JSON.stringify(placed.body)}`);

    const order = await Order.findOne({ orderId: placed.body.order.orderId }).lean();
    assert.ok(order, 'the order must exist');
    assert.strictEqual(order.subtotal, 200);
    assert.strictEqual(order.serviceFee, 20, 'the service fee must be snapshotted');
    assert.strictEqual(order.deliveryFee, 0, 'a takeaway order carries no delivery fee');
    assert.strictEqual(order.vatAmount, round2((order.subtotal + order.serviceFee) * (order.vatRate / 100)));
    assert.strictEqual(
      order.totalAmount,
      round2(order.subtotal + order.serviceFee + order.deliveryFee + order.vatAmount),
      'the total must be computed on the backend'
    );

    // Now the platform re-prices. The historical order must not change.
    await setSetting(T.sysAdmin, 'delivery_fee', 90);
    await setSetting(T.sysAdmin, 'service_fee', 60);

    const again = await Order.findOne({ orderId: placed.body.order.orderId }).lean();
    assert.strictEqual(again.serviceFee, 20, 'the historical service fee must not change');
    assert.strictEqual(again.deliveryFee, 0, 'the historical delivery fee must not change');
    assert.strictEqual(again.totalAmount, order.totalAmount, 'the historical total must not change');
  });

  await check('a delivery order charges the delivery fee and the service fee separately', async () => {
    const placed = await call('POST', '/orders', T.customer, {
      customerName: 'Fee Tester',
      customerPhone: '0911223344',
      orderType: 'delivery',
      paymentMethod: 'CHAPA',
      items: [{ id: String(item._id), quantity: 1 }],
      deliveryInfo: {
        deliveryAddress: 'Test address',
        location: 'Test area',
        subCity: 'Test sub-city',
        phone: '0911223344',
      },
    });
    assert.strictEqual(placed.status, 201, `expected 201, got ${placed.status} ${JSON.stringify(placed.body)}`);

    const order = await Order.findOne({ orderId: placed.body.order.orderId }).lean();
    assert.strictEqual(order.subtotal, 100);
    assert.strictEqual(order.serviceFee, 60, 'the service fee is applied on a delivery order too');
    assert.strictEqual(order.deliveryFee, 90, 'the delivery fee is applied on a delivery order');
    assert.notStrictEqual(order.serviceFee, order.deliveryFee, 'the two fees are charged separately');
    assert.strictEqual(
      order.totalAmount,
      round2(order.subtotal + order.serviceFee + order.deliveryFee + order.vatAmount)
    );
  });

  await check('a replayed checkout never charges the customer twice', async () => {
    const clientOrderId = 'replay-' + Date.now();
    const body = {
      customerName: 'Fee Tester',
      customerPhone: '0911223344',
      orderType: 'takeaway',
      paymentMethod: 'CHAPA',
      clientOrderId,
      items: [{ id: String(item._id), quantity: 1 }],
    };

    const first = await call('POST', '/orders', T.customer, body);
    assert.strictEqual(first.status, 201, `expected 201, got ${first.status} ${JSON.stringify(first.body)}`);
    const firstId = first.body.order.orderId;
    const countAfterFirst = await Order.countDocuments({ userId: customer._id });

    // The SAME checkout replayed (double click, retry, flaky network) must
    // return the order that already exists instead of creating a second one -
    // that would be a duplicate charge of the same basket.
    const replay = await call('POST', '/orders', T.customer, body);
    assert.strictEqual(replay.status, 200, `expected 200, got ${replay.status} ${JSON.stringify(replay.body)}`);
    assert.strictEqual(replay.body.duplicate, true, 'the replay must be flagged as a duplicate');
    assert.strictEqual(replay.body.order.orderId, firstId, 'the replay must return the original order');

    const countAfterReplay = await Order.countDocuments({ userId: customer._id });
    assert.strictEqual(countAfterReplay, countAfterFirst, 'the replay must not create a second order');

    // ...and the money on that order is charged once.
    const order = await Order.findOne({ orderId: firstId }).lean();
    assert.strictEqual(order.serviceFee, 60, 'the service fee is charged exactly once');
    assert.strictEqual(
      order.totalAmount,
      round2(order.subtotal + order.serviceFee + order.deliveryFee + order.vatAmount),
      'the total is not doubled'
    );
  });

  console.log('\n11. The public settings feed the platform policy');
  // ----------------------------------------------------------------------
  await check('GET /settings/public exposes both fees separately', async () => {
    await setSetting(T.sysAdmin, 'delivery_fee', 40);
    await setSetting(T.sysAdmin, 'service_fee', 20);
    const r = await call('GET', '/settings/public', T.customer);
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
    assert.strictEqual(r.body.settings.deliveryFee, 40);
    assert.strictEqual(r.body.settings.serviceFee, 20);
    assert.notStrictEqual(
      r.body.settings.deliveryFee,
      r.body.settings.serviceFee,
      'the two fees must be two separate configuration values'
    );
  });

  await check('GET /settings/public exposes the idle-session policy for every staff role', async () => {
    await setSetting(T.sysAdmin, 'session_timeout_minutes', 25);
    const r = await call('GET', '/settings/public', T.customer);
    assert.strictEqual(r.body.settings.sessionTimeoutMinutes, 25);
    await setSetting(T.sysAdmin, 'session_timeout_minutes', 10);
  });

  // ----------------------------------------------------------------------
  console.log('\nResult');
  console.log(`  passed: ${passed}`);
  console.log(`  failed: ${failures.length}`);
  if (failures.length) {
    console.log('\nFailed checks:');
    failures.forEach((f) => console.log('  - ' + f));
  }

  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  httpServer.close();
  process.exit(failures.length ? 1 : 0);
})().catch((error) => {
  console.error('\nTest harness crashed:', error);
  process.exit(1);
});

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
