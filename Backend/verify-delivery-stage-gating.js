/**
 * Dependency-free logic check for the Delivery Staff Active Deliveries card
 * renderer (Frontend/src/js/delivery/deliveries.js).
 *
 * Focus: the courier-owned stage tracker. Every delivery stage must be visible
 * on the card, and exactly ONE stage may be actionable - the next legal one in
 * the backend state machine. A courier must never be offered a skip the server
 * would reject, and Kitchen must never appear as the actor.
 *
 * Run: node Backend/verify-delivery-stage-gating.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const QUEUE = path.join(__dirname, '..', 'Frontend', 'src', 'js', 'delivery', 'deliveries.js');
const SHARED = path.join(__dirname, '..', 'Frontend', 'src', 'js', 'delivery', 'shared.js');

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

// --- minimal DOM -----------------------------------------------------------
function el(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    disabled: false,
    isConnected: true,
    attrs: {},
    addEventListener() {},
    removeEventListener() {},
    getAttribute(k) { return this.attrs[k]; },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    appendChild() {},
    remove() {},
    dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
  };
}

/**
 * esc() in shared.js assigns textContent on a detached div and reads innerHTML
 * back, so the stub element has to behave like a real one:
 * setting textContent -> innerHTML reflects the escaped text.
 */
function textNode(id) {
  const node = el(id);
  let raw = '';
  Object.defineProperty(node, 'textContent', {
    get() { return raw; },
    set(v) {
      raw = v == null ? '' : String(v);
      node.innerHTML = raw
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  });
  return node;
}

// Evaluate the REAL shared.js so the card uses real esc/tr/statusLabel/
// deliveryState logic rather than reimplementations.
function loadShared(sandbox) {
  const src = fs.readFileSync(SHARED, 'utf8').replace(/^export\s+/gm, '');
  vm.createContext(sandbox);
  vm.runInContext(src + '\nglobalThis.__shared = { esc, tr, statusLabel, deliveryState, normalizeStatus, itemsChips, deliveryAddress, deliveryPhone, deliveryCoords, navUrl, getMyUserId, isAssignedToMe, apiErrorMessage, setRefreshLoading, money, statusClass };', sandbox, { filename: SHARED });
  return sandbox.__shared;
}

/**
 * Load deliveries.js, strip its `import` lines (the shared helpers are injected
 * as globals instead) and expose the internal renderers for assertions.
 */
function loadQueue(sandbox) {
  const src = fs.readFileSync(QUEUE, 'utf8')
    // shared helpers come from the sandbox, not from ES module imports
    .replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, '')
    // auto-boot must not run; we drive render()/deliveryCard() directly
    .replace(/document\.addEventListener\(["']DOMContentLoaded["'][\s\S]*$/m, '')
    + '\nglobalThis.__queue = { deliveryCard, stageTracker, render, loadQueues, DELIVERY_STAGES, stageIndex, dedupeDeliveries, withStageLock, pickUpOrder, markOutForDelivery, markArrived, markCompleted, markDelivered };';
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: QUEUE });
  return sandbox.__queue;
}

function makeSandbox({ orders, userId = 'RIDER1' } = {}) {
  const nodes = {};
  nodes.__orders = orders || [];
  ['deliveryList', 'errorBanner', 'refreshBtn', 'gpsStatus',
    'statReady', 'statOut', 'statArrived', 'statAssignedMe', 'statAwaitingComplete'].forEach((id) => {
    nodes[id] = el(id);
  });

  const apiCalls = [];
  const sandbox = {
    console,
    Date, JSON, Number, String, Array, Object, Math, Boolean, RegExp, Error, Promise, Set, Map,
    encodeURIComponent, parseInt, parseFloat, isNaN, Intl,
    setInterval: () => 1, clearInterval: () => {},
    setTimeout: () => 1, clearTimeout: () => {},
    requestAnimationFrame: (cb) => cb(),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      readyState: 'complete',
      hidden: false,
      getElementById: (id) => nodes[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => textNode('tmp'),
      body: el('body'),
    },
    window: {
      addEventListener: () => {},
      location: { search: '', href: '' },
      open: () => null,
      getText: () => '',
      // The courier stages are behind a confirm() by design; the harness
      // answers "yes" so the real PATCH path is exercised.
      confirm: () => true,
    },
    // Native confirm/alert are globals inside the vm context.
    confirm: () => true,
    alert: () => {},
    api: {
      get: async (p) => {
        apiCalls.push(`GET ${p}`);
        if (p === '/deliveries/mine') return { orders };
        if (p === '/deliveries/my-history') return { orders: [] };
        if (p === '/deliveries/stats') return {};
        return {};
      },
      patch: async (p) => { apiCalls.push(`PATCH ${p}`); return { success: true }; },
      post: async (p) => { apiCalls.push(`POST ${p}`); return { success: true }; },
    },
    // Stubs for deliveries.js's other module imports (gps, gps-ui,
    // report-issue, delivery-safety) - none of them own a delivery stage.
    socketClient: { on: () => {}, joinOrderRoom: () => {}, joinDeliveryRoom: () => {}, disconnect: () => {}, isDeliveryStaff: () => true, connect: () => {}, socket: null },
    gpsTracker: {
      // start() is async and permission-guarded in the real module, so the stub
      // resolves rather than returning undefined - the dashboard awaits it.
      start: async () => null, stop: () => {}, stopAll: () => {}, watchPosition: () => {}, getPosition: () => null,
      getStatusText: () => '', isActive: false, syncActiveDeliveries: () => {}, onChange: () => {},
      retryAfterPermissionChange: async () => null,
      watchPermissionChanges: () => {}, unwatchPermissionChanges: () => {},
      refreshPermission: async () => ({ state: 'unknown', known: false }),
    },
    syncGpsPanels: () => {},
    gpsControlsHtml: () => '',
    // Live-map helpers (delivery/dashboard-map.js). The dashboard reconciles one
    // Leaflet map per active card; there is no DOM/Leaflet here, so they are
    // inert. syncDashboardMaps returns the (empty) measurement Map the GPS panel
    // reads - the shape is the part the harness must honour.
    gpsMapHtml: () => '',
    syncDashboardMaps: () => new Map(),
    applyServerFixToMap: () => {},
    rememberServerFix: () => {},
    destroyDashboardMaps: () => {},
    openReportIssue: () => {},
    issueBadge: () => '',
    sosButtonHtml: () => '<button data-action="sos">SOS</button>',
    bindSos: () => {},
    openSosModal: () => {},
    openProofModal: () => {},
    showToast: () => {},
    confirmDialog: async () => true,
    CSS: { escape: (v) => String(v) },
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;

  const shared = loadShared(sandbox);
  // Inject the real shared helpers as globals for deliveries.js.
  Object.assign(sandbox, shared);
  sandbox.getMyUserId = () => userId;
  sandbox.statusClass = shared.statusClass;
  sandbox.money = shared.money;
  sandbox.setRefreshLoading = shared.setRefreshLoading;
  sandbox.apiErrorMessage = shared.apiErrorMessage;
  // stageAction uses these names in deliveryCard
  sandbox.__userId = userId;
  return { sandbox, nodes, apiCalls, shared };
}

/** Real serialized payload shape (matches serializeDelivery in the controller). */
function order(over) {
  return {
    orderId: 'DEL-1',
    customerId: 'CUS1',
    customerName: 'Abebe',
    customerPhone: '0911223344',
    items: [{ name: 'Shiro', quantity: 2, price: 90 }],
    totalAmount: 180,
    orderType: 'delivery',
    status: 'ready',                       // kitchen order status (mirrored)
    deliveryStatus: 'REQUESTED',           // authoritative delivery state
    deliveryAcceptanceStatus: 'pending_acceptance',
    deliveryStaffAssigned: { id: 'RIDER1', name: 'Rider One', role: 'delivery' },
    deliveryPersonId: 'RIDER1',
    deliveryInfo: { address: 'Bole, House 4', phone: '0911223344' },
    paymentMethod: 'cash',
    ...over,
  };
}

// The five courier-owned stage transitions, in order.
const COURIER_STAGES = ['pickup', 'out', 'arrived', 'delivered', 'complete'];

/**
 * Only the stage-tracker's own action buttons count as a delivery stage. The card
 * also renders Accept / Decline / Report / SOS, which are not stage transitions.
 */
function stageButtons(html) {
  const found = [...html.matchAll(/class="btn-action btn-[a-z]+"[^>]*data-action="([a-z_]+)"/g)]
    .map((m) => m[1]);
  return found.filter((a) => COURIER_STAGES.includes(a));
}
function cardHtml(sandbox, o) {
  return sandbox.__loaded.queue.deliveryCard(o);
}

async function main() {
  console.log('\nDelivery Active Deliveries: stage tracker + button gating\n');

  // Build one sandbox and expose the loaded module for the card helper.
  const { sandbox } = makeSandbox({ orders: [] });
  const queue = loadQueue(sandbox);
  sandbox.__loaded = { shared: sandbox.__shared, queue };

  await check('the card renders all seven delivery stages', async () => {
    const html = cardHtml(sandbox, order({}));
    // Fallback labels as written in deliveries.js DELIVERY_STAGES.
    for (const label of ['Assigned', 'Accepted', 'Pickup', 'Out', 'Arrived', 'Delivered', 'Completed']) {
      assert(html.includes(label), `stage "${label}" missing from the tracker`);
    }
    assert((html.match(/d-stage-dot/g) || []).length === 7,
      `expected 7 stage dots, got ${(html.match(/d-stage-dot/g) || []).length}`);
  });

  await check('no stage button is offered before the order is accepted and ready', async () => {
    // Assigned to me but the kitchen has not marked it ready, and I have not
    // accepted - the server would reject a pickup, so no stage may be clickable.
    const html = cardHtml(sandbox, order({ status: 'preparing', deliveryStatus: 'ASSIGNED' }));
    const buttons = stageButtons(html);
    assert(buttons.length === 0,
      `expected no stage buttons while not ready/accepted, got: ${buttons.join(',')}`);
  });

  await check('exactly one stage button: Pickup once accepted and ready', async () => {
    const html = cardHtml(sandbox, order({
      status: 'ready', deliveryStatus: 'ACCEPTED', deliveryAcceptanceStatus: 'accepted',
    }));
    const buttons = stageButtons(html);
    assert(buttons.length === 1, `expected exactly 1 stage button, got: ${buttons.join(',')}`);
    assert(buttons[0] === 'pickup', `expected the pickup button, got ${buttons[0]}`);
  });

  await check('only the next stage is offered after each transition (no skips)', async () => {
    const cases = [
      { deliveryStatus: 'PICKED_UP', expected: 'out' },
      { deliveryStatus: 'OUT_FOR_DELIVERY', expected: 'arrived' },
      { deliveryStatus: 'ARRIVED', expected: 'delivered' },
      { deliveryStatus: 'DELIVERED', expected: 'complete' },
    ];
    for (const c of cases) {
      const html = cardHtml(sandbox, order({
        status: 'out_for_delivery',
        deliveryStatus: c.deliveryStatus,
        deliveryAcceptanceStatus: 'accepted',
      }));
      const buttons = stageButtons(html);
      assert(buttons.length === 1,
        `${c.deliveryStatus}: expected 1 stage button, got ${buttons.join(',') || 'none'}`);
      assert(buttons[0] === c.expected,
        `${c.deliveryStatus}: expected "${c.expected}", got "${buttons[0]}"`);
      // And no earlier stage may remain clickable.
      COURIER_STAGES.forEach((s) => {
        if (s !== c.expected) {
          assert(!buttons.includes(s), `${c.deliveryStatus}: stage "${s}" must not be actionable`);
        }
      });
    }
  });

  await check('a terminal completed order offers no stage button', async () => {
    const html = cardHtml(sandbox, order({
      status: 'completed', deliveryStatus: 'COMPLETED', deliveryAcceptanceStatus: 'accepted',
      isTerminal: true,
    }));
    const buttons = stageButtons(html);
    assert(buttons.length === 0, `completed order must not offer stages, got ${buttons.join(',')}`);
  });

  await check('a cancelled order shows a halted tracker, never a progress bar', async () => {
    const html = cardHtml(sandbox, order({
      deliveryStatus: 'CANCELLED', isCancelled: true,
    }));
    assert(html.includes('d-stages halted'), 'cancelled must use the halted tracker');
    assert(!html.includes('d-stage-dot'), 'cancelled must not render a forward progress bar');
    const buttons = stageButtons(html);
    assert(buttons.length === 0, `cancelled order must not offer stages, got ${buttons.join(',')}`);
  });

  await check('a stage button is bound to its own order id', async () => {
    const html = cardHtml(sandbox, order({
      orderId: 'DEL-77', status: 'ready', deliveryStatus: 'ACCEPTED',
      deliveryAcceptanceStatus: 'accepted',
    }));
    assert(/data-action="pickup"/.test(html), 'pickup button missing');
    assert(/data-order="DEL-77"/.test(html), 'the button must carry the order id it acts on');
  });

  await check('a courier who does not own the order gets no stage button', async () => {
    const other = makeSandbox({ orders: [], userId: 'RIDER2' });
    other.sandbox.__loaded = { shared: other.sandbox.__shared, queue: loadQueue(other.sandbox) };
    const html = cardHtml(other.sandbox, order({
      status: 'ready', deliveryStatus: 'ACCEPTED', deliveryAcceptanceStatus: 'accepted',
      deliveryStaffAssigned: { id: 'RIDER1', name: 'Rider One' },
    }));
    const buttons = stageButtons(html);
    assert(buttons.length === 0,
      `a different courier must not see a stage button, got ${buttons.join(',')}`);
  });

  await check('the stage buttons use the real PATCH endpoints', async () => {
    const calls = [];
    const o = order({ status: 'ready', deliveryStatus: 'ACCEPTED', deliveryAcceptanceStatus: 'accepted' });
    const s = makeSandbox({ orders: [o] });
    s.sandbox.__loaded = { shared: s.sandbox.__shared, queue: loadQueue(s.sandbox) };
    // Replace the API surface with a recorder that also mimics a state change.
    s.sandbox.api.patch = async (p, body) => {
      calls.push(`PATCH ${p} ${JSON.stringify(body || {})}`);
      return { success: true };
    };
    const q = s.sandbox.__queue;
    // Populate the module's own `orders` list the way the page does on boot,
    // so markDelivered can find the order it is asked to hand over.
    await q.loadQueues();
    // Walk each courier stage in order and record the endpoint hit.
    for (const action of COURIER_STAGES) {
      calls.length = 0;
      if (action === 'delivered') {
        // Delivered opens the proof modal rather than calling PATCH directly.
        let opened = false;
        s.sandbox.openProofModal = () => { opened = true; };
        await q.markDelivered('DEL-1');
        assert(opened, 'delivered must open the proof modal (OTP/photo) before writing');
      } else {
        const fn = { pickup: q.pickUpOrder, out: q.markOutForDelivery, arrived: q.markArrived, complete: q.markCompleted }[action];
        await fn('DEL-1');
        await new Promise((r) => setImmediate(r));
        assert(calls.length === 1, `${action}: expected 1 PATCH, got ${calls.length}`);
        assert(calls[0].startsWith('PATCH /deliveries/DEL-1/'),
          `${action}: wrong endpoint ${calls[0]}`);
        const expected = {
          pickup: 'pickup',
          out: 'out-for-delivery',
          arrived: 'arrived',
          complete: 'complete',
        }[action];
        assert(calls[0].includes(expected), `${action}: expected /${expected}, got ${calls[0]}`);
      }
    }
  });

  await check('a double click on one stage fires only one PATCH', async () => {
    const calls = [];
    const s = makeSandbox({ orders: [] });
    s.sandbox.__loaded = { shared: s.sandbox.__shared, queue: loadQueue(s.sandbox) };
    let release;
    const gate = new Promise((r) => { release = r; });
    s.sandbox.api.patch = async (p) => {
      calls.push(p);
      await gate;
      return { success: true };
    };
    const q = s.sandbox.__queue;
    q.pickUpOrder('DEL-1');
    q.pickUpOrder('DEL-1');
    q.pickUpOrder('DEL-1');
    release();
    await new Promise((r) => setImmediate(r));
    assert(calls.length === 1, `expected 1 PATCH for three rapid clicks, got ${calls.length}`);
  });

  await check('the stage button is rendered as a real <button> for keyboard access', async () => {
    const html = cardHtml(sandbox, order({
      status: 'ready', deliveryStatus: 'ACCEPTED', deliveryAcceptanceStatus: 'accepted',
    }));
    assert(/<button class="btn-action btn-[a-z]+"[^>]*data-action="pickup"/.test(html),
      'the live stage must be a <button> with an actionable btn-action class');
  });

  await check('render draws the tracker into the real page list', async () => {
    const s = makeSandbox({
      orders: [order({ status: 'ready', deliveryStatus: 'ACCEPTED', deliveryAcceptanceStatus: 'accepted' })],
    });
    s.sandbox.__loaded = { shared: s.sandbox.__shared, queue: loadQueue(s.sandbox) };
    // loadQueues() is what the page calls on boot: it fills the module state from
    // /deliveries/mine and then renders into the real #deliveryList.
    await s.sandbox.__loaded.queue.loadQueues();
    const html = s.nodes.deliveryList.innerHTML;
    assert(html.includes('DEL-1'), 'the assigned order must render in #deliveryList');
    assert(/data-action="pickup"/.test(html),
      'the rendered card must contain the pickup stage button');
  });

  await check('Kitchen never owns a delivery stage button', async () => {
    const src = fs.readFileSync(QUEUE, 'utf8');
    // Kitchen's transitions are Pending/Preparing/Ready; none may be a courier action.
    for (const kitchenOnly of ['accept-order', 'start-preparing', 'mark-ready', 'send-to-delivery', 'hand-to-driver']) {
      assert(!new RegExp(`data-action="${kitchenOnly}"`).test(src),
        `deliveries.js must not expose the kitchen-only action "${kitchenOnly}"`);
    }
  });

  await check('REGRESSION: the Kitchen picked-up write is gone', async () => {
    const kitchenCtrl = fs.readFileSync(
      path.join(__dirname, 'src', 'controllers', 'kitchen.controller.js'), 'utf8'
    );
    assert(!/exports\.markOrderPickedUp\s*=/.test(kitchenCtrl),
      'markOrderPickedUp must be removed: only Delivery Staff may move an order to PICKED_UP');
    assert(!/orderStatus\s*=\s*ORDER_STATUS\.PICKED_UP/.test(kitchenCtrl),
      'no Kitchen controller code may write PICKED_UP');
    const kitchenRoutes = fs.readFileSync(
      path.join(__dirname, 'src', 'routes', 'kitchen.routes.js'), 'utf8'
    );
    // Only route registrations count - a comment documenting the removal is fine.
    assert(!/router\.(get|post|put|patch|delete)\([^)]*picked-up/i.test(kitchenRoutes),
      'the /kitchen/orders/:id/picked-up route must be removed');
    assert(!/router\.(get|post|put|patch|delete)\([^)]*markOrderPickedUp/i.test(kitchenRoutes),
      'kitchen.routes.js must not reference markOrderPickedUp');
  });

  await check('REGRESSION: Delivery still owns every courier transition', async () => {
    const ctrl = fs.readFileSync(
      path.join(__dirname, 'src', 'controllers', 'delivery.controller.js'), 'utf8'
    );
    for (const fn of ['pickUpOrder', 'markOutForDelivery', 'markArrived', 'markDelivered', 'markCompleted']) {
      assert(new RegExp(`exports\\.${fn}\\s*=`).test(ctrl), `delivery.controller.js must export ${fn}`);
    }
    assert(/broadcastStatus\(summary\)/.test(ctrl),
      'markDelivered must broadcast to the customer order room');
  });

  await check('REGRESSION: customer tracker turns the reached stage fully green', async () => {
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'Frontend', 'src', 'css', 'style.css'), 'utf8'
    );
    for (const sel of [
      /\.timeline-step\.active\s+\.step-icon/,
      /\.timeline-step\.active\s+\.step-label\s+strong/,
      /\.timeline-step\.active\s+\.step-label\s+small/,
      /\.timeline-line\.active/,
    ]) {
      assert(new RegExp(sel).test(css), `style.css is missing the green rule ${sel}`);
    }
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