/**
 * ============================================================================
 * SETTINGS PAGE - role aware rendering (frontend contract test)
 * ============================================================================
 * Drives the REAL Frontend/src/js/admin-settings.js against a fake DOM and a
 * stubbed AdminAPI, then asserts the behaviour the product spec requires:
 *
 *   1. The page markup declares every setting it exposes (data-setting-key),
 *      including the two fees as SEPARATE fields.
 *   2. A Cafeteria Manager sees the cafeteria operating settings enabled and
 *      the global ones (currency, order limits) disabled.
 *   3. A manager whose fee authorization was revoked sees BOTH fees disabled
 *      plus an explanation.
 *   4. The System Admin sees everything enabled, including the platform
 *      permissions card.
 *   5. Saving NEVER sends a key the role may not change (no 403 storm).
 *   6. Notification preferences go to /notifications/preferences (per user),
 *      NOT to the global settings.
 *   7. The 2FA toggle writes to /auth/me (per account), NOT to the global
 *      two_factor_enabled setting.
 *
 * Run: node Backend/tests/settings-page-permissions.test.js
 * ============================================================================
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SETTINGS_JS = path.join(ROOT, 'Frontend', 'src', 'js', 'admin-settings.js');
const SETTINGS_HTML = path.join(ROOT, 'Frontend', 'src', 'pages', 'admin', 'settings.html');
const SECURITY_HTML = path.join(ROOT, 'Frontend', 'src', 'pages', 'admin', 'security.html');

let pass = 0;
let fail = 0;
// The checks mutate shared harness state, so they must run SEQUENTIALLY.
let chain = Promise.resolve();
function check(name, fn) {
  chain = chain.then(async () => {
    try {
      await fn();
      pass++;
      console.log('  PASS ' + name);
    } catch (e) {
      fail++;
      console.log('  FAIL ' + name + ' -- ' + e.message);
    }
  });
}

/* ------------------------------------------------------------- fake DOM */
function makeClassList() {
  const classes = new Set();
  return {
    add(c) { classes.add(c); },
    remove(c) { classes.delete(c); },
    toggle(c, on) {
      if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
      else if (on) classes.add(c); else classes.delete(c);
    },
    contains(c) { return classes.has(c); },
  };
}

function makeEl(id) {
  return {
    id,
    _value: '',
    _text: '',
    _html: '',
    _checked: false,
    disabled: false,
    title: '',
    style: {},
    dataset: {},
    children: [],
    _l: {},
    classList: makeClassList(),
    get value() { return this._value; },
    set value(v) { this._value = v == null ? '' : String(v); },
    get checked() { return this._checked; },
    set checked(v) { this._checked = !!v; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = v == null ? '' : String(v); },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v == null ? '' : String(v); },
    getAttribute(k) { return this._attrs && this._attrs[k] !== undefined ? this._attrs[k] : null; },
    setAttribute(k, v) { (this._attrs || (this._attrs = {}))[k] = String(v); },
    removeAttribute(k) { if (this._attrs) delete this._attrs[k]; },
    hasAttribute(k) { return this.getAttribute(k) !== null; },
    addEventListener(type, fn) { (this._l[type] || (this._l[type] = [])).push(fn); },
    removeEventListener(type, fn) { if (this._l[type]) this._l[type] = this._l[type].filter((f) => f !== fn); },
    dispatch(type, ev) { (this._l[type] || []).slice().forEach((fn) => fn(ev || { type, target: this })); },
    click() { this.dispatch('click', { type: 'click', target: this }); },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    focus() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

/**
 * Build the fake DOM for the settings page.
 *
 * @param {object} options
 * @param {string} options.role               'manager' | 'admin'
 * @param {boolean} options.feeAuthorized      Is the manager allowed to price?
 * @param {object} options.editable            key -> boolean (from the backend)
 */
function buildHarness({ role, feeAuthorized, editable }) {
  const nodes = {};
  const getEl = (id) => nodes[id] || (nodes[id] = makeEl(id));

  const fields = [];
  const wrappers = {};

  function addField(id, key, wrapperId) {
    const el = getEl(id);
    el.setAttribute('data-setting-key', key);
    const wrapper = getEl(wrapperId || 'wrap-' + key);
    wrapper.classList.add('data-restricted-field');
    const badge = makeEl('badge-' + key);
    wrapper._badge = badge;
    wrapper.querySelector = (sel) => (sel === '[data-restricted-badge]' ? badge : null);
    el.closest = (sel) => (sel === '[data-restricted-field]' ? wrapper : null);
    fields.push(el);
    return el;
  }

  // Cafeteria operations
  addField('cafeteriaOpeningTime', 'cafeteria_opening_time');
  addField('cafeteriaClosingTime', 'cafeteria_closing_time');
  addField('paymentCurrency', 'currency', 'wrap-currency');
  addField('maxDailyOrders', 'max_daily_orders', 'wrap-max_daily_orders');
  addField('orderAvailability', 'order_availability');
  // Fees - two separate fields
  addField('deliveryFee', 'delivery_fee', 'wrap-delivery_fee');
  addField('serviceFee', 'service_fee', 'wrap-service_fee');
  addField('deliveryEnabled', 'delivery_enabled');
  // Platform permissions
  addField('managerFeeManagement', 'manager_fee_management_enabled');

  const restricted = {};
  for (const [key, allowed] of Object.entries(editable)) {
    if (allowed) continue;
    // Same wording the backend sends (config/setting-permissions.js).
    restricted[key] =
      key === 'delivery_fee' || key === 'service_fee'
        ? 'Fee management has not been authorized for cafeteria managers. Ask the system administrator to enable it.'
        : `Only the system administrator can update the "${key}" setting`;
  }

  const settingsResponse = {
    success: true,
    settings: [
      { key: 'cafeteria_opening_time', value: '07:00', type: 'string', group: 'general' },
      { key: 'cafeteria_closing_time', value: '22:00', type: 'string', group: 'general' },
      { key: 'currency', value: 'ETB', type: 'string', group: 'general' },
      { key: 'max_daily_orders', value: 100, type: 'number', group: 'operations' },
      { key: 'order_availability', value: true, type: 'boolean', group: 'operations' },
      { key: 'delivery_fee', value: 30, type: 'number', group: 'delivery' },
      { key: 'service_fee', value: 20, type: 'number', group: 'payments' },
      { key: 'delivery_enabled', value: true, type: 'boolean', group: 'delivery' },
      { key: 'manager_fee_management_enabled', value: feeAuthorized, type: 'boolean', group: 'permissions' },
    ],
    permissions: {
      role,
      isSystemAdmin: role === 'admin',
      feeManagementAuthorized: feeAuthorized,
      editable,
      restricted,
    },
  };

  const putCalls = [];
  const getCalls = [];

  const document_ = {
    readyState: 'complete',
    _l: {},
    getElementById: getEl,
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === '[data-setting-key]') return fields;
      if (selector === '.toggle-checkbox') return [];
      if (selector === '.toggle-password-icon') return [];
      return [];
    },
    createElement: () => makeEl('tmp'),
    addEventListener(type, fn) { (this._l[type] || (this._l[type] = [])).push(fn); },
    removeEventListener(type, fn) { if (this._l[type]) this._l[type] = this._l[type].filter((f) => f !== fn); },
    dispatch(type, ev) { (this._l[type] || []).slice().forEach((fn) => fn(ev || { type })); },
    body: makeEl('body'),
  };

  const sandbox = {
    console,
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout: () => {},
    document: document_,
    navigator: { userAgent: 'node' },
    localStorage: {
      _s: { auth_token: 'test-token', userRole: role, role },
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
      setItem(k, v) { this._s[k] = String(v); },
      removeItem(k) { delete this._s[k]; },
    },
    ScosRoles: {
      getCurrentRole: () => role,
      normalizeRole: (r) => String(r || '').toLowerCase(),
      isStaff: () => true,
    },
    AdminAPI: {
      esc: (v) => (v == null ? '' : String(v)),
      getProfile: () => ({ name: 'Test User', email: 'test@example.com', role }),
      get: async (p) => {
        getCalls.push(p);
        if (p.indexOf('/admin/settings') === 0) return settingsResponse;
        if (p.indexOf('/auth/me') === 0) {
          return { success: true, user: { name: 'Test User', email: 'test@example.com', phone: '0911223344', role, avatar: '', twoFactorEnabled: false } };
        }
        if (p.indexOf('/notifications/preferences') === 0) {
          return { success: true, preferences: { soundEnabled: true, newOrders: true, lowStock: true, dailySales: false, securityLogin: true } };
        }
        return {};
      },
      put: async (p, body) => {
        putCalls.push({ path: p, body });
        if (p.indexOf('/auth/me') === 0) return { success: true, user: { twoFactorEnabled: body.twoFactorEnabled } };
        if (p.indexOf('/notifications/preferences') === 0) return { success: true, preferences: body };
        return { success: true, setting: { key: p.split('/').pop(), value: body && body.value } };
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  return { sandbox, document_, nodes, getEl, fields, putCalls, getCalls, wrappers };
}

async function boot(options) {
  const h = buildHarness(options);
  vm.createContext(h.sandbox);
  vm.runInContext(fs.readFileSync(SETTINGS_JS, 'utf8'), h.sandbox, { filename: 'admin-settings.js' });
  h.document_.dispatch('DOMContentLoaded', { type: 'DOMContentLoaded' });
  // let the async init() settle
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  return h;
}

const MANAGER_EDITABLE = {
  cafeteria_opening_time: true,
  cafeteria_closing_time: true,
  currency: false,
  max_daily_orders: false,
  order_availability: true,
  delivery_fee: true,
  service_fee: true,
  delivery_enabled: true,
  manager_fee_management_enabled: false,
};

const ADMIN_EDITABLE = {
  cafeteria_opening_time: true,
  cafeteria_closing_time: true,
  currency: true,
  max_daily_orders: true,
  order_availability: true,
  delivery_fee: true,
  service_fee: true,
  delivery_enabled: true,
  manager_fee_management_enabled: true,
};

(async function run() {
  /* ---------------- markup contract ---------------- */
  await check('the settings page declares a data-setting-key for every setting it exposes', () => {
    const html = fs.readFileSync(SETTINGS_HTML, 'utf8');
    const required = [
      'cafeteria_opening_time',
      'cafeteria_closing_time',
      'currency',
      'max_daily_orders',
      'order_availability',
      'delivery_fee',
      'service_fee',
      'delivery_enabled',
      'manager_fee_management_enabled',
    ];
    for (const key of required) {
      assert.ok(
        html.indexOf(`data-setting-key="${key}"`) !== -1,
        `settings.html is missing data-setting-key="${key}"`
      );
    }
  });

  await check('the delivery fee and the service fee are two separate inputs', () => {
    const html = fs.readFileSync(SETTINGS_HTML, 'utf8');
    assert.ok(/id="deliveryFee"/.test(html), 'the delivery fee input is missing');
    assert.ok(/id="serviceFee"/.test(html), 'the service fee input is missing');
  });

  await check('the system security page exposes the system-wide policy fields', () => {
    const html = fs.readFileSync(SECURITY_HTML, 'utf8');
    for (const key of [
      'session_timeout_minutes',
      'login_max_attempts',
      'two_factor_enabled',
      'otp_verification_enabled',
      'registration_captcha_enabled',
      'admin_account_enabled',
      'otp_expiry_minutes',
    ]) {
      assert.ok(html.indexOf(`data-setting-key="${key}"`) !== -1, `security.html is missing ${key}`);
    }
  });

  /* ---------------- manager ---------------- */
  const manager = await boot({ role: 'manager', feeAuthorized: true, editable: MANAGER_EDITABLE });

  await check('manager: the profile card is titled "Manager Profile"', () => {
    assert.strictEqual(
      manager.getEl('profileSectionTitle').textContent,
      'Manager Profile',
      'the cafeteria manager must not be shown an "Admin Profile" heading'
    );
  });

  await check('manager: the "Fees & Delivery" section is removed from the page', () => {
    assert.ok(
      manager.getEl('feesDeliverySection').classList.contains('hidden'),
      'the manager must not see the Fees & Delivery section'
    );
  });

  await check('manager: the "My Notification Preferences" section is removed from the page', () => {
    assert.ok(
      manager.getEl('notificationPreferencesSection').classList.contains('hidden'),
      'the manager must not see the notification preferences section'
    );
  });

  await check('manager: the cafeteria operating settings are editable', () => {
    assert.strictEqual(manager.getEl('cafeteriaOpeningTime').disabled, false);
    assert.strictEqual(manager.getEl('cafeteriaClosingTime').disabled, false);
    assert.strictEqual(manager.getEl('orderAvailability').disabled, false);
  });

  await check('manager: the global currency and order limit are disabled', () => {
    assert.strictEqual(manager.getEl('paymentCurrency').disabled, true);
    assert.strictEqual(manager.getEl('maxDailyOrders').disabled, true);
    assert.ok(
      manager.getEl('paymentCurrency').title.indexOf('system administrator') !== -1,
      'the disabled field must explain who may change it'
    );
  });

  await check('manager: both fees are editable while authorized', () => {
    assert.strictEqual(manager.getEl('deliveryFee').disabled, false);
    assert.strictEqual(manager.getEl('serviceFee').disabled, false);
  });

  await check('manager: the platform permissions card is hidden', () => {
    assert.ok(
      manager.getEl('platformPermissionsSection').classList.contains('hidden'),
      'the manager must not see the platform permissions card'
    );
  });

  await check('manager: the values loaded from the server are shown in the form', () => {
    assert.strictEqual(manager.getEl('deliveryFee').value, '30');
    assert.strictEqual(manager.getEl('serviceFee').value, '20');
    assert.strictEqual(manager.getEl('paymentCurrency').value, 'ETB');
    assert.strictEqual(manager.getEl('maxDailyOrders').value, '100');
  });

  await check('manager: saving the cafeteria operations never sends a restricted key', async () => {
    manager.putCalls.length = 0;
    manager.getEl('saveSystemConfigBtn').dispatch('click');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    const keys = manager.putCalls.map((c) => decodeURIComponent(c.path.split('/').pop()));
    assert.ok(keys.indexOf('cafeteria_opening_time') !== -1, 'the opening time must be saved');
    assert.ok(keys.indexOf('currency') === -1, 'the manager must not send "currency"');
    assert.ok(keys.indexOf('max_daily_orders') === -1, 'the manager must not send "max_daily_orders"');
  });

  await check('manager: saving the fees only sends the fee keys', async () => {
    manager.putCalls.length = 0;
    manager.getEl('saveDeliveryConfigBtn').dispatch('click');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    const keys = manager.putCalls.map((c) => decodeURIComponent(c.path.split('/').pop()));
    assert.ok(keys.indexOf('delivery_fee') !== -1, 'the delivery fee must be saved');
    assert.ok(keys.indexOf('service_fee') !== -1, 'the service fee must be saved');
    assert.strictEqual(keys.length, 3, 'only the two fees + delivery_enabled may be sent');
  });

  await check('manager: the notification preferences go to /notifications/preferences', async () => {
    manager.putCalls.length = 0;
    manager.getEl('saveNotificationsBtn').dispatch('click');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    const paths = manager.putCalls.map((c) => c.path);
    assert.ok(paths.indexOf('/notifications/preferences') !== -1, 'preferences must use the per-user endpoint');
    assert.ok(
      paths.every((p) => p.indexOf('/admin/settings/notify_') === -1),
      'the preferences must not be written as global settings'
    );
  });

  await check('the 2FA toggle writes to the own account, not to the global setting', async () => {
    manager.putCalls.length = 0;
    const twoFa = manager.getEl('twoFactorEnabled');
    twoFa.checked = true;
    twoFa.dispatch('change');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    const paths = manager.putCalls.map((c) => c.path);
    assert.ok(paths.indexOf('/auth/me') !== -1, '2FA must be written to the own profile');
    assert.ok(
      paths.every((p) => p.indexOf('/admin/settings/two_factor_enabled') === -1),
      '2FA must never be written as a global setting'
    );
  });

  /* ---------------- manager without fee authorization ---------------- */
  const revoked = await boot({
    role: 'manager',
    feeAuthorized: false,
    editable: { ...MANAGER_EDITABLE, delivery_fee: false, service_fee: false },
  });

  await check('manager without authorization: both fees are disabled', () => {
    assert.strictEqual(revoked.getEl('deliveryFee').disabled, true);
    assert.strictEqual(revoked.getEl('serviceFee').disabled, true);
  });

  await check('manager without authorization: an explanation is shown', () => {
    assert.ok(
      !revoked.getEl('feeAuthorizationNote').classList.contains('hidden'),
      'the fee authorization note must be visible'
    );
  });

  await check('manager without authorization: the cafeteria hours stay editable', () => {
    assert.strictEqual(revoked.getEl('cafeteriaOpeningTime').disabled, false);
    assert.strictEqual(revoked.getEl('cafeteriaClosingTime').disabled, false);
  });

  await check('manager without authorization: saving the fees sends no fee key', async () => {
    revoked.putCalls.length = 0;
    revoked.getEl('saveDeliveryConfigBtn').dispatch('click');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    const keys = revoked.putCalls.map((c) => decodeURIComponent(c.path.split('/').pop()));
    assert.ok(keys.indexOf('delivery_fee') === -1, 'the delivery fee must not be sent');
    assert.ok(keys.indexOf('service_fee') === -1, 'the service fee must not be sent');
  });

  /* ---------------- admin ---------------- */
  const admin = await boot({ role: 'admin', feeAuthorized: true, editable: ADMIN_EDITABLE });

  await check('admin: the profile card is titled "Admin Profile"', () => {
    assert.strictEqual(admin.getEl('profileSectionTitle').textContent, 'Admin Profile');
  });

  await check('admin: the "Fees & Delivery" section stays on the page', () => {
    assert.ok(
      !admin.getEl('feesDeliverySection').classList.contains('hidden'),
      'the system admin must keep the Fees & Delivery section'
    );
  });

  await check('admin: the "My Notification Preferences" section stays on the page', () => {
    assert.ok(
      !admin.getEl('notificationPreferencesSection').classList.contains('hidden'),
      'the system admin must keep the notification preferences section'
    );
  });

  await check('admin: every setting is editable', () => {
    for (const id of [
      'cafeteriaOpeningTime',
      'cafeteriaClosingTime',
      'paymentCurrency',
      'maxDailyOrders',
      'orderAvailability',
      'deliveryFee',
      'serviceFee',
      'deliveryEnabled',
      'managerFeeManagement',
    ]) {
      assert.strictEqual(admin.getEl(id).disabled, false, `${id} must be editable for the system admin`);
    }
  });

  await check('admin: the platform permissions card is visible', () => {
    assert.ok(
      !admin.getEl('platformPermissionsSection').classList.contains('hidden'),
      'the system admin must see the platform permissions card'
    );
  });

  await check('admin: the fee authorization note stays hidden', () => {
    assert.ok(admin.getEl('feeAuthorizationNote').classList.contains('hidden'));
  });

  await check('admin: saving the cafeteria operations sends the global keys too', async () => {
    admin.putCalls.length = 0;
    admin.getEl('saveSystemConfigBtn').dispatch('click');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    const keys = admin.putCalls.map((c) => decodeURIComponent(c.path.split('/').pop()));
    assert.ok(keys.indexOf('currency') !== -1, 'the admin must be able to save the currency');
    assert.ok(keys.indexOf('max_daily_orders') !== -1, 'the admin must be able to save the order limit');
  });

  await check('admin: the manager fee authorization switch can be saved', async () => {
    admin.putCalls.length = 0;
    admin.getEl('managerFeeManagement').checked = false;
    admin.getEl('savePermissionsBtn').dispatch('click');
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    const call = admin.putCalls.find((c) => decodeURIComponent(c.path.split('/').pop()) === 'manager_fee_management_enabled');
    assert.ok(call, 'the authorization switch must be saved');
    assert.strictEqual(call.body.value, false);
  });

  await chain;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
