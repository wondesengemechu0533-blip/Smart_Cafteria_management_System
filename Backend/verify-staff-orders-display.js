/**
 * Dependency-free check for "display delivery orders per delivery staff member"
 * on the manager Delivery Staff screen.
 *
 * Covers three layers that have to agree for the feature to work:
 *   1. Route    - GET /deliveries/staff/:staffId/orders exists and is declared
 *                 BEFORE the /:id catch-all, so the staff id is never swallowed
 *                 by the single-delivery lookup.
 *   2. Controller - scoped to management, cafeteria-scoped from the JWT, the
 *                 rider must be a `delivery` user, and it reuses the SAME
 *                 status filter as GET /deliveries (no semantic drift between
 *                 the dispatch board and this list).
 *   3. Frontend - the page renders a "view orders" button per rider, the modal
 *                 is wired to the endpoint, and the filter select maps onto the
 *                 query params the backend understands. The controller is
 *                 executed inside a minimal DOM sandbox so a broken render is a
 *                 failure here instead of an empty table in the browser.
 *
 * Run: node Backend/verify-staff-orders-display.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ROUTES = path.join(ROOT, 'Backend', 'src', 'routes', 'delivery.routes.js');
const CONTROLLER = path.join(ROOT, 'Backend', 'src', 'controllers', 'delivery.controller.js');
const PAGE = path.join(ROOT, 'Frontend', 'src', 'pages', 'manager', 'delivery-staff.html');
const SCRIPT = path.join(ROOT, 'Frontend', 'src', 'js', 'manager-delivery-staff.js');
const EN = path.join(ROOT, 'Frontend', 'src', 'locales', 'en.json');
const AM = path.join(ROOT, 'Frontend', 'src', 'locales', 'am.json');

const I18N_KEYS = [
  'mgr_staff_orders_title',
  'mgr_staff_orders_view',
  'mgr_staff_orders_loading',
  'mgr_staff_orders_empty',
  'mgr_staff_orders_failed',
  'mgr_staff_orders_active',
  'mgr_staff_orders_shown',
];

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const read = (p) => fs.readFileSync(p, 'utf8');

// ---------------------------------------------------------------------------
// 1. Route registration
// ---------------------------------------------------------------------------
const routesSrc = read(ROUTES);
const controllerSrc = read(CONTROLLER);
const pageSrc = read(PAGE);
const scriptSrc = read(SCRIPT);

const ROUTE_PATH = "/staff/:staffId/orders'";

(async () => {

await check('route GET /deliveries/staff/:staffId/orders is registered', () => {
  assert(
    routesSrc.includes(ROUTE_PATH),
    'delivery.routes.js has no GET /staff/:staffId/orders registration'
  );
  const line = routesSrc
    .split('\n')
    .find((l) => l.includes('router.get') && l.includes(ROUTE_PATH));
  assert(line, 'the staff orders path is not registered with router.get');
  assert(line.includes('MANAGER_ROLES'), 'the endpoint must be management-only (MANAGER_ROLES)');
  assert(
    line.includes('getStaffDeliveryOrders'),
    'the route must point at deliveryController.getStaffDeliveryOrders'
  );
});

await check('the staff orders route is declared before the /:id catch-all', () => {
  const staffIdx = routesSrc.indexOf(ROUTE_PATH);
  const catchAllIdx = routesSrc.indexOf("router.get('/:id'");
  assert(catchAllIdx !== -1, 'delivery.routes.js has no GET /:id route');
  assert(
    staffIdx < catchAllIdx,
    `GET ${ROUTE_PATH} must be declared before GET /:id (found at ${staffIdx} vs ${catchAllIdx})`
  );
});

// ---------------------------------------------------------------------------
// 2. Controller
// ---------------------------------------------------------------------------
await check('controller exports getStaffDeliveryOrders', () => {
  assert(
    controllerSrc.includes('exports.getStaffDeliveryOrders'),
    'delivery.controller.js does not export getStaffDeliveryOrders'
  );
  const fn = controllerSrc.slice(
    controllerSrc.indexOf('exports.getStaffDeliveryOrders'),
    controllerSrc.indexOf('// Route: POST /api/v1/deliveries/staff')
  );
  assert(fn.length > 400, 'getStaffDeliveryOrders looks truncated');

  assert(
    fn.includes('resolveDeliveryListScope'),
    'the endpoint must resolve its cafeteria scope from the JWT, not the query'
  );
  assert(
    fn.includes('cafeteriaFilter'),
    'the order query must be cafeteria-scoped (cafeteriaFilter)'
  );
  assert(
    fn.includes("role: 'delivery'"),
    'the rider lookup must be restricted to role "delivery"'
  );
  assert(
    fn.includes('applyDeliveryListStatusFilter'),
    'the endpoint must reuse the shared status filter'
  );
  assert(
    fn.includes('orderType: \'delivery\''),
    'the order query must be limited to delivery orders'
  );
  assert(
    fn.includes('deliveryStaffAssigned: staffId'),
    'the order query must be scoped to the requested rider'
  );
  assert(
    fn.includes('mongoose.Types.ObjectId.isValid'),
    'the staff id must be validated before it reaches the query'
  );
});

await check('status semantics are shared with GET /deliveries (no drift)', () => {
  const listFn = controllerSrc.slice(
    controllerSrc.indexOf('exports.getDeliveryOrders'),
    controllerSrc.indexOf('exports.getMyDeliveries')
  );
  assert(
    listFn.includes('applyDeliveryListStatusFilter'),
    'getDeliveryOrders no longer uses the shared helper - the two lists can disagree'
  );
  assert(
    controllerSrc.includes('function applyDeliveryListStatusFilter'),
    'the shared helper is missing'
  );
  // `ALL` must keep meaning "terminal states included".
  const helper = controllerSrc.slice(
    controllerSrc.indexOf('function applyDeliveryListStatusFilter'),
    controllerSrc.indexOf('// Route: GET /api/v1/deliveries')
  );
  assert(
    helper.includes("requestedStatus !== 'ALL'"),
    'status=ALL must still bypass the active-only restriction'
  );
  assert(
    helper.includes('MY_ACTIVE_STATUSES_UPPER'),
    'the active status set must stay the default when no status is requested'
  );
});

// ---------------------------------------------------------------------------
// 3. Frontend wiring
// ---------------------------------------------------------------------------
await check('the page has the delivery-orders modal and its controls', () => {
  for (const needle of [
    'id="staffOrdersModal"',
    'id="staffOrdersTableBody"',
    'id="staffOrdersStatus"',
    'id="staffOrdersMeta"',
    'data-close-modal="staffOrdersModal"',
    'data-i18n="mgr_staff_orders_title"',
  ]) {
    assert(pageSrc.includes(needle), `delivery-staff.html is missing ${needle}`);
  }
  const options = [...pageSrc.matchAll(/<option value="([a-z_]+)"/g)].map((m) => m[1]);
  for (const wanted of ['active', 'all', 'completed', 'failed', 'cancelled']) {
    assert(options.includes(wanted), `the status filter has no "${wanted}" option`);
  }
});

await check('every filter option maps onto a query the backend understands', () => {
  const mapBlock = scriptSrc.slice(
    scriptSrc.indexOf('var STAFF_ORDERS_QUERY'),
    scriptSrc.indexOf('var STATUS_LABEL_KEYS')
  );
  assert(mapBlock.length > 0, 'STAFF_ORDERS_QUERY is missing from manager-delivery-staff.js');
  assert(mapBlock.includes('active: { status: "ACTIVE" }'), 'active must query status=ACTIVE');
  assert(mapBlock.includes('all: { status: "ALL" }'), 'all must query status=ALL');
  // COMPLETED/FAILED/CANCELLED must go through `report=` so the legacy
  // capitalised `status: "Completed"` rows are matched too.
  assert(
    mapBlock.includes('completed: { report: "completed" }'),
    'completed must use report=completed'
  );
  assert(mapBlock.includes('failed: { report: "failed" }'), 'failed must use report=failed');
  assert(mapBlock.includes(
    'cancelled: { report: "cancelled" }'
  ), 'cancelled must use report=cancelled');

  for (const wanted of ['active', 'all', 'completed', 'failed', 'cancelled']) {
    assert(
      mapBlock.includes(`${wanted}:`),
      `STAFF_ORDERS_QUERY has no "${wanted}" entry - the select would fetch nothing`
    );
  }
});

await check('the rider row renders a button that opens the order list', () => {
  assert(
    scriptSrc.includes('staff-orders-btn'),
    'renderStaffRow does not emit the staff-orders-btn button'
  );
  assert(
    scriptSrc.includes('data-staff-id'),
    'the button must carry data-staff-id so the handler knows which rider'
  );
  assert(
    scriptSrc.includes('openStaffOrders'),
    'no openStaffOrders handler is registered'
  );
  assert(
    scriptSrc.includes('/deliveries/staff/'),
    'the client never calls GET /deliveries/staff/:id/orders'
  );
  assert(
    !/\.hide\(\)/.test(scriptSrc),
    'the modal is closed with .hide(), which is not a DOM method - use classList'
  );
  assert(
    scriptSrc.includes('classList.add("open")'),
    'modals must be opened by adding the .open class (admin.css)'
  );
  assert(
    scriptSrc.includes('data-close-modal'),
    'the modal close button is not wired to a handler'
  );
});

// ---------------------------------------------------------------------------
// 4. Behavioural: run the real page script in a minimal DOM sandbox
// ---------------------------------------------------------------------------
function makeElement(id) {
  const listeners = {};
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    dataset: {},
    listeners,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c) { this._set.has(c) ? this.delete(c) : this.add(c); },
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event) { (listeners[type] || []).forEach((fn) => fn(event)); },
    getAttribute() { return null; },
    setAttribute() {},
    appendChild() {},
    querySelector() { return null; },
    closest() { return null; },
  };
}

function buildSandbox() {
  const ids = ['staffOrdersTableBody', 'staffOrdersMeta', 'staffOrdersStatus'];
  const elements = Object.fromEntries(ids.map((id) => [id, makeElement(id)]));
  const docListeners = {};
  const calls = [];
  let nextResponse = null;

  const documentStub = {
    readyState: 'complete',
    getElementById(id) { return elements[id] || null; },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return makeElement('fresh'); },
    body: { appendChild() {} },
  };

  const windowStub = {
    AdminAPI: {
      get(p, q) {
        calls.push({ path: p, query: q });
        return nextResponse
          ? Promise.resolve(nextResponse).then((r) => {
              if (r && r.__reject) {
                const err = new Error(r.__reject);
                err.status = 500;
                throw err;
              }
              return r;
            })
          : Promise.resolve({ success: true, orders: [], staff: {} });
      },
      formatCurrency(v) { return `${Number(v || 0).toFixed(2)} ETB`; },
      formatDateTime(v) { return v ? new Date(v).toISOString() : '—'; },
      formatDate(v) { return v ? new Date(v).toISOString().slice(0, 10) : '—'; },
      esc(v) { return String(v == null ? '' : v); },
    },
    addEventListener() {},
    setInterval() {},
    confirm() { return true; },
    location: { href: '' },
    io: undefined,
  };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console: { log() {}, error() {}, warn() {} },
    setTimeout: (fn) => { fn(); return 0; },
    setInterval: () => 0,
    clearTimeout() {},
    Date,
    JSON,
    Number,
    String,
    encodeURIComponent,
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(scriptSrc, sandbox, { filename: 'manager-delivery-staff.js' });

  return {
    elements,
    docListeners,
    calls,
    respond(payload) { nextResponse = payload; },
    window: windowStub,
  };
}

await check('opening a rider row fetches that rider\'s delivery orders', async () => {
  const box = buildSandbox();
  assert(
    box.window.ManagerDeliveryStaff,
    'the script did not expose window.ManagerDeliveryStaff'
  );

  box.respond({ success: true, staff: { id: 'r1', name: 'Abebe Kebede', phone: '0911', activeDeliveries: 3 }, orders: [] });
  box.window.ManagerDeliveryStaff.openStaffOrders('r1');
  await new Promise((r) => setImmediate(r));

  assert(box.calls.length === 1, `expected 1 request, saw ${box.calls.length}`);
  const call = box.calls[0];
  assert(
    call.path === '/deliveries/staff/r1/orders',
    `wrong endpoint: ${call.path}`
  );
  assert(
    call.query && call.query.status === 'ACTIVE',
    `default filter must request active work, saw ${JSON.stringify(call.query)}`
  );
  assert(
    box.elements.staffOrdersStatus.value === 'active',
    'the modal filter must reset to Active on every open'
  );
  assert(
    box.elements.staffOrdersMeta.innerHTML.includes('Abebe Kebede'),
    'the modal header never rendered the rider name'
  );
});

await check('a delivery order is rendered with id, customer, amount and status', async () => {
  const box = buildSandbox();
  box.respond({
    success: true,
    count: 1,
    staff: { id: 'r1', name: 'Abebe', activeDeliveries: 1 },
    orders: [
      {
        orderId: 'ORD-1001',
        customerName: 'Kebede Alemu',
        customerPhone: '0912345678',
        deliveryAddress: 'Bole, Addis Ababa',
        items: [
          { name: 'Burger', quantity: 2, price: 120 },
          { name: 'Cola', quantity: 1, price: 40 },
        ],
        itemCount: 3,
        totalAmount: 280,
        status: 'OUT_FOR_DELIVERY',
        orderTime: '2026-10-01T10:15:00.000Z',
      },
    ],
  });

  box.window.ManagerDeliveryStaff.openStaffOrders('r1');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const html = box.elements.staffOrdersTableBody.innerHTML;
  assert(html.includes('ORD-1001'), `order id missing from: ${html}`);
  assert(html.includes('Kebede Alemu'), 'customer name missing');
  assert(html.includes('Bole, Addis Ababa'), 'delivery address missing');
  assert(html.includes('280.00 ETB'), 'total amount missing');
  assert(html.includes('order-badge'), 'no status badge rendered');
  assert(html.includes('Burger'), 'item summary missing');
  assert(!html.includes('undefined'), `raw undefined leaked into the row: ${html}`);
});

await check('the status select re-queries with the matching backend filter', async () => {
  const box = buildSandbox();
  box.respond({ success: true, staff: { id: 'r1', name: 'A' }, orders: [] });
  box.window.ManagerDeliveryStaff.openStaffOrders('r1');
  await new Promise((r) => setImmediate(r));
  box.calls.length = 0;

  box.elements.staffOrdersStatus.value = 'completed';
  box.elements.staffOrdersStatus.dispatch('change', {
    target: { value: 'completed' },
  });
  await new Promise((r) => setImmediate(r));

  assert(box.calls.length === 1, 'changing the filter did not re-query');
  assert(
    box.calls[0].query && box.calls[0].query.report === 'completed',
    `completed must send report=completed, saw ${JSON.stringify(box.calls[0].query)}`
  );
});

await check('an empty result and a failed request both explain themselves', async () => {
  const emptyBox = buildSandbox();
  emptyBox.respond({ success: true, staff: { id: 'r1', name: 'A' }, orders: [] });
  emptyBox.window.ManagerDeliveryStaff.openStaffOrders('r1');
  await new Promise((r) => setImmediate(r));
  const emptyHtml = emptyBox.elements.staffOrdersTableBody.innerHTML;
  assert(
    emptyHtml.includes('No delivery orders match'),
    `empty state is unexplained: ${emptyHtml}`
  );

  const failBox = buildSandbox();
  failBox.respond({ __reject: 'boom' });
  failBox.window.ManagerDeliveryStaff.openStaffOrders('r1');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const failHtml = failBox.elements.staffOrdersTableBody.innerHTML;
  assert(
    failHtml.includes('Failed to load delivery orders'),
    `failure state is unexplained: ${failHtml}`
  );
  assert(
    failHtml.includes('dc2626'),
    'the failure row is not styled as an error'
  );
});

// ---------------------------------------------------------------------------
// 5. Translations
// ---------------------------------------------------------------------------
await check('every new label exists in BOTH locale files', () => {
  const en = JSON.parse(read(EN));
  const am = JSON.parse(read(AM));
  for (const key of I18N_KEYS) {
    assert(en[key], `en.json is missing ${key}`);
    assert(am[key], `am.json is missing ${key}`);
  }
  const missingStatus = ['status_failed', 'status_arrived', 'status_picked_up', 'status_delivered', 'status_out_for_delivery']
    .filter((k) => !en[k] || !am[k]);
  assert(
    missingStatus.length === 0,
    `locale files are missing status labels: ${missingStatus.join(', ')}`
  );
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;

})();
