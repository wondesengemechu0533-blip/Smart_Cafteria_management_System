/**
 * Session-guard tests for the delivery layout.
 *
 * The delivery dashboard used to keep polling GET /deliveries/mine and POST
 * /deliveries/:id/location with a token that belonged to a completely
 * different account (another tab signed in as kitchen/customer), producing a
 * stream of 403s. These tests pin down the two rules that stop it:
 *
 *   1. sessionRoleAllowed() says no for any non-delivery session, so the page
 *      can refuse to ask before the server has to refuse to answer;
 *   2. a storage / pageshow event re-runs the guard and sends the page to
 *      login when the signed-in account no longer belongs here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const layoutPath = path.resolve(here, '..', 'delivery-layout.js');
const source = fs.readFileSync(layoutPath, 'utf8');

/** Build a browser-ish sandbox and evaluate delivery-layout.js inside it. */
function loadLayout(initialStorage = {}) {
  const storage = { ...initialStorage };
  const listeners = { storage: [], pageshow: [], domReady: [] };
  const element = () => ({
    innerHTML: '',
    textContent: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {},
    addEventListener() {},
    setAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const sandbox = {
    console,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    document: {
      head: { appendChild() {} },
      body: { appendChild() {} },
      addEventListener(type, fn) {
        if (type === 'DOMContentLoaded') listeners.domReady.push(fn);
      },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: element,
    },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    Date,
    JSON,
    String,
    Number,
    Object,
    Array,
  };
  sandbox.window = {
    addEventListener(type, fn) {
      if (listeners[type]) listeners[type].push(fn);
    },
    removeEventListener() {},
    location: {
      pathname: '/src/pages/delivery/deliveries.html',
      href: '',
      reloadCount: 0,
      reload() { this.reloadCount += 1; },
    },
    innerWidth: 1200,
    confirm: () => true,
    __API_URL: '',
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'delivery-layout.js' });

  return {
    layout: sandbox.window.DeliveryLayout,
    storage,
    /** Run the real boot guard (what DOMContentLoaded does in the browser). */
    boot() {
      listeners.domReady.forEach((fn) => fn());
    },
    /** Fire a cross-tab `storage` event for `key` after mutating the store. */
    fireStorage(key, newValue) {
      if (newValue === undefined || newValue === null) delete storage[key];
      else storage[key] = newValue;
      listeners.storage.forEach((fn) => fn({ key, newValue: newValue ?? null }));
    },
    /** Fire a back/forward-cache restore. */
    firePageshow() {
      listeners.pageshow.forEach((fn) => fn({ persisted: true }));
    },
    window: sandbox.window,
  };
}

test('delivery session is allowed', () => {
  const { layout } = loadLayout({ userRole: 'DELIVERY_STAFF' });
  assert.equal(layout.sessionRoleAllowed(), true);
  assert.equal(layout.currentUserRole(), 'delivery_staff');
});

test('management session is allowed (the dashboard is shared with dispatch)', () => {
  const { layout } = loadLayout({ userRole: 'ADMIN' });
  assert.equal(layout.sessionRoleAllowed(), true);
});

test('non-delivery sessions are rejected before any request is made', () => {
  for (const role of ['KITCHEN_STAFF', 'CUSTOMER', 'CASHIER', 'MANAGER', 'TAX_AUTHORITY', '']) {
    const { layout } = loadLayout(role ? { userRole: role } : {});
    assert.equal(layout.sessionRoleAllowed(), false, `role ${role || '(empty)'} must be rejected`);
  }
});

test('another tab signing in as kitchen sends the open delivery page to login', () => {
  const env = loadLayout({ userRole: 'DELIVERY_STAFF', auth_token: 'rider-token' });
  assert.equal(env.layout.sessionRoleAllowed(), true);

  // A second tab logs in as kitchen: it rewrites the shared auth keys and this
  // page (which never navigated) sees a `storage` event.
  env.fireStorage('userRole', 'KITCHEN_STAFF');
  env.fireStorage('auth_token', 'kitchen-token');

  assert.equal(env.window.location.href, '../common/login.html');
});

test('another tab signing out sends the open delivery page to login', () => {
  const env = loadLayout({ userRole: 'DELIVERY_STAFF', role: 'DELIVERY_STAFF', auth_token: 'rider-token' });
  // Logout clears the role keys as well as the token.
  env.fireStorage('userRole', null);
  env.fireStorage('role', null);
  env.fireStorage('auth_token', null);
  assert.equal(env.window.location.href, '../common/login.html');
});

test('a restored page whose session was replaced leaves (pageshow)', () => {
  const env = loadLayout({ userRole: 'DELIVERY_STAFF' });
  env.storage.userRole = 'CUSTOMER'; // replaced while the page was in history
  env.firePageshow();
  assert.equal(env.window.location.href, '../common/login.html');
});

test('a still-valid session never redirects on a storage event', () => {
  const env = loadLayout({ userRole: 'DELIVERY_STAFF', auth_token: 'rider-token' });
  // Unrelated key: profile picture renamed, language switched, ...
  env.fireStorage('scos_language', 'am');
  assert.equal(env.window.location.href, '');
});

test('booting with a non-delivery session leaves before rendering anything', () => {
  const env = loadLayout({ userRole: 'KITCHEN_STAFF', auth_token: 'kitchen-token' });
  env.boot();
  assert.equal(env.window.location.href, '../common/login.html');
  assert.equal(env.layout.sessionRoleAllowed(), false);
});

test('booting with a delivery session stays and remembers the role', () => {
  const env = loadLayout({ userRole: 'DELIVERY_STAFF', auth_token: 'rider-token' });
  env.boot();
  assert.equal(env.window.location.href, '');
  assert.equal(env.layout.sessionRoleAllowed(), true);
});

test('another allowed account signing in reloads the page instead of mixing state', () => {
  const env = loadLayout({ userRole: 'DELIVERY_STAFF', auth_token: 'rider-token' });
  env.boot();
  // e.g. an admin opens the shared dashboard in another tab: still allowed, so
  // the page must rebuild its queues/GPS/socket rooms for the new account
  // rather than keep showing the previous one's deliveries.
  env.fireStorage('userRole', 'ADMIN');
  assert.equal(env.window.location.reloadCount, 1);
  assert.equal(env.window.location.href, '');
});
