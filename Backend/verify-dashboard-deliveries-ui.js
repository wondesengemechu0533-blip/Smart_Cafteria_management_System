/**
 * Dependency-free logic check for Frontend/src/js/dashboard-deliveries.js.
 *
 * There is no jsdom in this project, so instead of adding one this stubs just
 * enough DOM/window surface to load the REAL module file and drive it, then
 * asserts on the real rendered HTML and the real AdminAPI calls it makes.
 *
 * Run: node Backend/verify-dashboard-deliveries-ui.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULE_PATH = path.join(__dirname, '..', 'Frontend', 'src', 'js', 'dashboard-deliveries.js');
// The `manager` role is redirected to pages/manager/dashboard.html (see
// admin-layout.js dashboardForRole), so the card MUST live there or the
// Cafeteria Manager never sees it.
const MANAGER_PAGE = path.join(__dirname, '..', 'Frontend', 'src', 'pages', 'manager', 'dashboard.html');
const ADMIN_PAGE = path.join(__dirname, '..', 'Frontend', 'src', 'pages', 'admin', 'dashboard.html');

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

// --- Minimal DOM ------------------------------------------------------------
function el(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    disabled: false,
    attrs: {},
    addEventListener() {},
    getAttribute(k) { return this.attrs[k]; },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    appendChild() {},
  };
}

function makeSandbox({ orders, staff, confirmResult = true }) {
  const nodes = {};
  const ids = [
    'dashDeliveryCard', 'dashDeliveryTableBody', 'dashDeliveryError',
    'dashDeliveryRefreshBtn', 'dashDeliveryUnassigned', 'dashDeliveryAssigned',
    'dashDeliveryActive', 'dashDeliveryStaff',
  ];
  ids.forEach((id) => { nodes[id] = el(id); });

  const apiCalls = [];

  const sandbox = {
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    requestAnimationFrame: (cb) => cb(),
    Date,
    JSON,
    Number,
    String,
    Array,
    Object,
    Math,
    encodeURIComponent,
    Promise,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      readyState: 'complete',
      hidden: false,
      getElementById: (id) => nodes[id] || null,
      querySelector: () => null,
      addEventListener: () => {},
      createElement: () => el('tmp'),
    },
    window: {
      addEventListener: () => {},
      confirm: () => confirmResult,
      esc: (v) => String(v === null || v === undefined ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      tr: (k, f) => f,
      AdminToast: { show: () => {}, error: () => {}, success: () => {} },
      AdminAPI: {
        get: async (p, q) => {
          apiCalls.push(`GET ${p}${q && q.status ? `?status=${q.status}` : ''}`);
          if (p === '/deliveries/staff') return { staff };
          if (p === '/deliveries') return { orders };
          return {};
        },
        patch: async (p, body) => {
          apiCalls.push(`PATCH ${p} ${JSON.stringify(body)}`);
          return { success: true, message: 'Delivery staff assigned.' };
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.confirm = () => confirmResult;
  return { sandbox, nodes, apiCalls };
}

function loadModule(sandbox) {
  const code = fs.readFileSync(MODULE_PATH, 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: MODULE_PATH });
  return sandbox.window.AdminDashboardDeliveries;
}

/**
 * init() fires its own load() on evaluation, and load() de-duplicates
 * concurrent calls - so awaiting load() again would return early. Let the
 * initial render settle first, then flush any microtasks.
 */
async function settled(mod) {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
  return mod;
}

const baseOrder = {
  orderId: 'DAS-1',
  customerName: 'Abebe',
  deliveryAddress: 'Bole, House 4',
  items: [{ name: 'Shiro', quantity: 2 }],
  totalAmount: 180,
  deliveryStatus: 'REQUESTED',
  deliveryStaffAssigned: null,
  isTerminal: false,
  createdAt: new Date().toISOString(),
};

const staff = [
  { id: 'RIDER1', name: 'Rider One', status: 'ACTIVE', isActive: true },
  { id: 'RIDER2', name: 'Rider Two', status: 'ACTIVE', isActive: true },
  { id: 'OFF1', name: 'Inactive One', status: 'INACTIVE', isActive: false },
];

async function main() {
  console.log('\nManager Dashboard delivery card - render + assign logic\n');

  await check('renders one row per eligible delivery with all required columns', async () => {
    const orders = [
      baseOrder,
      {
        ...baseOrder,
        orderId: 'DAS-2',
        customerName: 'Belete',
        deliveryStatus: 'ASSIGNED',
        deliveryStaffAssigned: { id: 'RIDER1', name: 'Rider One' },
      },
    ];
    const { sandbox, nodes } = makeSandbox({ orders, staff });
    const mod = await settled(loadModule(sandbox));
    const html = nodes.dashDeliveryTableBody.innerHTML;
    assert(html.includes('#DAS-1'), 'DAS-1 row missing');
    assert(html.includes('#DAS-2'), 'DAS-2 row missing');
    for (const col of ['Abebe', 'Bole, House 4', '2x Shiro', '180.00', 'Dash']) {
      assert(html.includes(col) || html.includes('ETB'), `expected ${col} in row`);
    }
    assert(html.includes('Assign'), 'Assign button missing for the unassigned row');
    assert(html.includes('dash-delivery-staff-select'), 'staff <select> missing');
  });

  await check('an unassigned order offers the Assign button; an assigned one does not', async () => {
    const orders = [
      baseOrder,
      { ...baseOrder, orderId: 'DAS-2', deliveryStatus: 'ASSIGNED', deliveryStaffAssigned: { id: 'RIDER1', name: 'Rider One' } },
    ];
    const { sandbox, nodes } = makeSandbox({ orders, staff });
    const mod = await settled(loadModule(sandbox));
    const html = nodes.dashDeliveryTableBody.innerHTML;
    const unassignedRow = html.split('<tr>').find((r) => r.includes('DAS-1'));
    const assignedRow = html.split('<tr>').find((r) => r.includes('DAS-2'));
    assert(unassignedRow.includes('dash-delivery-assign-btn'), 'unassigned row needs an Assign button');
    assert(assignedRow.includes('Rider One'), 'assigned row should show the courier name');
    assert(!assignedRow.includes('dash-delivery-assign-btn'), 'assigned row should not offer a second Assign');
  });

  await check('the selector lists only ACTIVE delivery staff', async () => {
    const { sandbox, nodes } = makeSandbox({ orders: [baseOrder], staff });
    const mod = await settled(loadModule(sandbox));
    const html = nodes.dashDeliveryTableBody.innerHTML;
    assert(html.includes('Rider One'), 'active rider missing');
    assert(html.includes('Rider Two'), 'active rider 2 missing');
    assert(!html.includes('Inactive One'), 'inactive staff must not be selectable');
  });

  await check('terminal orders stay listed but are never assignable', async () => {
    const orders = [
      { ...baseOrder, orderId: 'DONE-1', deliveryStatus: 'DELIVERED', isTerminal: true },
      { ...baseOrder, orderId: 'CXL-1', deliveryStatus: 'CANCELLED', isTerminal: true },
      baseOrder,
    ];
        const { sandbox, nodes } = makeSandbox({ orders, staff });
        const mod = await settled(loadModule(sandbox));
        const html = nodes.dashDeliveryTableBody.innerHTML;
        // Every delivery order is listed (that was the fix), so a finished one is
        // visible here - but it must never offer the Assign control, because a
        // terminal delivery can no longer be handed to a courier.
        assert(html.includes('DONE-1'), 'delivered orders are listed on the dashboard');
        assert(html.includes('CXL-1'), 'cancelled orders are listed on the dashboard');
        assert(html.includes('DAS-1'), 'eligible order must show');
        const doneRow = html.split('</tr>').find((row) => row.includes('DONE-1')) || '';
        assert(!doneRow.includes('dash-delivery-assign-btn'),
          'a delivered order must not offer Assign');
        const cxlRow = html.split('</tr>').find((row) => row.includes('CXL-1')) || '';
        assert(!cxlRow.includes('dash-delivery-assign-btn'),
          'a cancelled order must not offer Assign');
        assert(html.split('dash-delivery-assign-btn').length - 1 === 1,
          'exactly one Assign button (the eligible order) must be rendered');
      });

      await check('the empty state is shown when nothing is eligible', async () => {
    const { sandbox, nodes } = makeSandbox({ orders: [], staff });
    const mod = await settled(loadModule(sandbox));
    const html = nodes.dashDeliveryTableBody.innerHTML;
    assert(html.includes('No delivery orders yet'), `unexpected empty state: ${html.slice(0, 120)}`);
  });

  await check('status uses the delivery state, not the mirrored order status', async () => {
    // ASSIGNED is mirrored onto the order as PENDING; the card must show "Assigned".
    const orders = [{ ...baseOrder, deliveryStatus: 'ASSIGNED', status: 'pending', deliveryStaffAssigned: { id: 'RIDER1', name: 'Rider One' } }];
    const { sandbox, nodes } = makeSandbox({ orders, staff });
    const mod = await settled(loadModule(sandbox));
    const html = nodes.dashDeliveryTableBody.innerHTML;
    assert(/badge-(out-for-delivery|assigned)/.test(html), 'expected the assigned badge class');
    assert(!html.includes('>Pending<'), 'must not render the mirrored Pending status');
  });

  await check('Assign with no staff selected is refused (no API call)', async () => {
    const { sandbox, apiCalls } = makeSandbox({ orders: [baseOrder], staff });
    const mod = await settled(loadModule(sandbox));
    apiCalls.length = 0;
    await mod.assign('DAS-1', '');
    assert(apiCalls.length === 0, `expected no API call, got ${apiCalls.join(', ')}`);
  });

  await check('Assign calls the single real PATCH endpoint with the chosen staff', async () => {
    const { sandbox, apiCalls } = makeSandbox({ orders: [baseOrder], staff });
    const mod = await settled(loadModule(sandbox));
    apiCalls.length = 0;
    await mod.assign('DAS-1', 'RIDER2');
    const assigns = apiCalls.filter((c) => c.startsWith('PATCH'));
    assert(assigns.length === 1, `expected exactly 1 PATCH, got ${assigns.length}`);
    assert(assigns[0].includes('/deliveries/DAS-1/assign'), `wrong path: ${assigns[0]}`);
    assert(assigns[0].includes('RIDER2'), 'the chosen staff id must be sent');
  });

  await check('declining the confirmation performs no assignment', async () => {
    const { sandbox, apiCalls } = makeSandbox({ orders: [baseOrder], staff, confirmResult: false });
    const mod = await settled(loadModule(sandbox));
    apiCalls.length = 0;
    await mod.assign('DAS-1', 'RIDER1');
    assert(apiCalls.length === 0, `expected no calls after cancel, got ${apiCalls.join(', ')}`);
  });

  await check('assigning an unknown staff id is refused', async () => {
    const { sandbox, apiCalls } = makeSandbox({ orders: [baseOrder], staff });
    const mod = await settled(loadModule(sandbox));
    apiCalls.length = 0;
    await mod.assign('DAS-1', 'NOT-A-STAFF-ID');
    assert(apiCalls.length === 0, 'an unknown staff id must not be sent to the API');
  });

  await check('the load() call reads only the real delivery endpoints', async () => {
    const { sandbox, apiCalls } = makeSandbox({ orders: [baseOrder], staff });
    const mod = await settled(loadModule(sandbox));
    assert(apiCalls.some((c) => c === 'GET /deliveries/staff'), 'staff endpoint not used');
    assert(apiCalls.some((c) => c.startsWith('GET /deliveries?status=ALL')), 'orders endpoint not used');
    const unexpected = apiCalls.filter((c) => !c.startsWith('GET /deliveries'));
    assert(unexpected.length === 0, `unexpected calls: ${unexpected.join(', ')}`);
  });

  await check('the card is present on the CAFETERIA MANAGER dashboard page', async () => {
    const html = fs.readFileSync(MANAGER_PAGE, 'utf8');
    assert(html.includes('id="dashDeliveryCard"'), 'manager dashboard has no Delivery Assignment card');
    assert(html.includes('id="dashDeliveryTableBody"'), 'manager dashboard has no delivery table body');
    assert(/dashboard-deliveries\.js/.test(html), 'manager dashboard does not load dashboard-deliveries.js');
    assert(html.includes('data-i18n="dash_delivery_col_staff"'), 'missing the Delivery Staff column');
  });

  await check('the manager dashboard loads the API client + config the card needs', async () => {
    const html = fs.readFileSync(MANAGER_PAGE, 'utf8');
    assert(/config\.js/.test(html), 'config.js (window.__API_URL) is required');
    assert(/admin-api\.js/.test(html), 'admin-api.js (window.AdminAPI) is required');
  });

  await check('the manager dashboard loads the Socket.IO client (live assignment events)', async () => {
    const html = fs.readFileSync(MANAGER_PAGE, 'utf8');
    assert(/socket\.io-4[\w.\-]*\.min\.js/.test(html),
      'manager dashboard has no socket.io client, so live assignment events cannot arrive');
  });

  await check('the socket.io vendor asset the manager page references exists', async () => {
    const html = fs.readFileSync(MANAGER_PAGE, 'utf8');
    const m = html.match(/src="(\/public\/assets\/vendor\/js\/socket\.io-[\w.\-]*\.min\.js)"/);
    assert(m, 'no socket.io script tag found to verify');
    const asset = path.join(__dirname, '..', 'Frontend', m[1].replace(/^\//, ''));
    assert(fs.existsSync(asset), `referenced asset is missing: ${m[1]}`);
  });

  await check('the system admin dashboard also keeps the card', async () => {
    const html = fs.readFileSync(ADMIN_PAGE, 'utf8');
    assert(html.includes('id="dashDeliveryCard"'), 'admin dashboard lost the card');
    assert(/dashboard-deliveries\.js/.test(html), 'admin dashboard does not load the module');
  });

  await check('REGRESSION: a rider with no `status` field is still selectable', async () => {
    // /deliveries/staff returns a server-computed `isActive` and used to omit
    // `status`. Filtering on status alone produced an EMPTY selector, so the
    // manager could not assign anybody.
    const staffNoStatus = [
      { id: 'R1', name: 'No Status Field', isActive: true },
      { id: 'R2', name: 'Blocked Rider', isActive: false },
    ];
    const { sandbox, nodes } = makeSandbox({ orders: [baseOrder], staff: staffNoStatus });
    await settled(loadModule(sandbox));
    const html = nodes.dashDeliveryTableBody.innerHTML;
    assert(html.includes('No Status Field'), 'an active rider without a status field must be selectable');
    assert(!html.includes('Blocked Rider'), 'a rider with isActive:false must be hidden');
  });

  await check('REGRESSION: riders are selectable with the real API payload shape', async () => {
    const realShape = [
      { id: '6ab1', name: 'Delivery', cafeteriaId: '6ab0', status: 'ACTIVE', isActive: true, isAvailable: true, activeDeliveries: 0 },
      { id: '6ab2', name: 'Delivery Staff', cafeteriaId: '6ab0', status: 'BLOCKED', isActive: false, activeDeliveries: 0 },
      { id: '6ab3', name: 'GER GER', cafeteriaId: '6ab0', status: 'ACTIVE', isActive: true, activeDeliveries: 2 },
    ];
    const { sandbox, nodes } = makeSandbox({ orders: [baseOrder], staff: realShape });
    await settled(loadModule(sandbox));
    const html = nodes.dashDeliveryTableBody.innerHTML;
    assert(html.includes('Delivery<') || html.includes('>Delivery'), 'active rider "Delivery" missing');
    assert(html.includes('GER GER'), 'active rider "GER GER" missing');
    assert(!html.includes('Delivery Staff'), 'BLOCKED rider must not be selectable');
    assert(String(nodes.dashDeliveryStaff.textContent) === '2',
      `expected 2 selectable riders, got "${nodes.dashDeliveryStaff.textContent}"`);
  });

  await check('REGRESSION: the backend returns the raw status the clients filter on', async () => {
        // The staff row shape is built by buildDeliveryStaffRow, so assert on that
        // helper rather than on a map() literal that moved.
        const ctrl = fs.readFileSync(
          path.join(__dirname, 'src', 'controllers', 'delivery.controller.js'), 'utf8'
        );
        const m = ctrl.match(/function buildDeliveryStaffRow\([\s\S]*?\n\}/);
        assert(m, 'could not locate buildDeliveryStaffRow');
        assert(/status:\s*u\.status/.test(m[0]),
          'getDeliveryStaff must include the raw `status` field, or clients filtering on it drop every rider');
        assert(/isActive,/.test(m[0]), 'getDeliveryStaff must keep the computed isActive flag');
      });

  await check('REGRESSION: the Delivery Orders page uses the same safe filter', async () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'Frontend', 'src', 'js', 'admin-deliveries.js'), 'utf8'
    );
    const body = src.match(/function isDeliveryStaffActive\([\s\S]*?\n\s*\}/);
    assert(body, 'isDeliveryStaffActive not found');
    assert(/typeof\s+\w+\.isActive\s*===\s*'boolean'/.test(body[0]),
      'isDeliveryStaffActive must prefer the server-computed isActive boolean');
    assert(!/String\(user\.status\s*\|\|\s*''\)\.toUpperCase\(\)\s*===\s*'ACTIVE'/.test(body[0]),
      'the old status-only check (which emptied the selector) is still present');
  });

  // Same ids the real page uses, so init() must find the card and render.
  await check('the card mounts against the manager page element ids', async () => {
    const { sandbox, nodes } = makeSandbox({ orders: [baseOrder], staff });
    const mod = await settled(loadModule(sandbox));
    const html = nodes.dashDeliveryTableBody.innerHTML;
    assert(html.includes('DAS-1'), 'manager card did not render a row');
    assert(String(nodes.dashDeliveryUnassigned.textContent) === '1',
      `Unassigned tile should show 1, got "${nodes.dashDeliveryUnassigned.textContent}"`);
    assert(String(nodes.dashDeliveryStaff.textContent) === '2',
      `Available Staff tile should show 2 active riders, got "${nodes.dashDeliveryStaff.textContent}"`);
  });
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
  })
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });
