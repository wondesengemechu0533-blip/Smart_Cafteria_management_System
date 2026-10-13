/**
 * Dependency-free check for the Delivery Staff "Active Deliveries" filter tabs
 * (Frontend/src/pages/delivery/deliveries.html + js/delivery/deliveries.js).
 *
 * Focus: the stage filter bar. Every tab rendered on the page must be wired to a
 * real filter, a click must move the active state, and the rendered list must
 * actually shrink to that stage. A tab that silently renders the whole queue is
 * indistinguishable from a dead button, so "it does not throw" is not enough.
 *
 * The tab definitions are read from the real HTML so a tab added there without
 * a matching rule fails here instead of doing nothing in the browser.
 *
 * Run: node Backend/verify-delivery-filter-tabs.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'Frontend', 'src', 'pages', 'delivery', 'deliveries.html');
const QUEUE = path.join(ROOT, 'Frontend', 'src', 'js', 'delivery', 'deliveries.js');
const SHARED = path.join(ROOT, 'Frontend', 'src', 'js', 'delivery', 'shared.js');

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

// --- tab definitions straight from the real page -----------------------------
function tabsFromPage() {
  const html = fs.readFileSync(PAGE, 'utf8');
  const block = html.match(/<div class="delivery-tabs">([\s\S]*?)<\/div>/);
  assert(block, 'deliveries.html has no .delivery-tabs block');
  const tabs = [];
  const re = /<button[^>]*data-filter="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(block[1])) !== null) {
    // The label is the text left after dropping the icon and the count badge.
    const label = m[2]
      .replace(/<span class="tab-count"[\s\S]*?<\/span>/g, '')
      .replace(/<[^>]*>/g, '')
      .trim();
    tabs.push({ filter: m[1], label });
  }
  return tabs;
}

// --- minimal DOM -------------------------------------------------------------
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
    classes: new Set(),
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener() {},
    getAttribute(k) { return this.attrs[k]; },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    appendChild() {},
    remove() {},
    dataset: {},
    classList: {
      add(c) { this.owner.classes.add(c); },
      remove(c) { this.owner.classes.delete(c); },
      contains(c) { return this.owner.classes.has(c); },
      toggle(c, force) {
        const on = force === undefined ? !this.owner.classes.has(c) : !!force;
        if (on) this.owner.classes.add(c); else this.owner.classes.delete(c);
        return on;
      },
      get owner() { return null; },
    },
  };
}

/**
 * A tab stub behaves like the real <button data-filter="...">: `closest()`
 * resolves it for the [data-filter] selector and null for anything else, which
 * is what makes the page's delegated click handler find it. It also carries the
 * `.tab-count` badge the page writes its live count into.
 */
function tabEl(filter) {
  const node = el('tab-' + filter);
  node.tagName = 'BUTTON';
  node.attrs['data-filter'] = filter;
  const owner = node;
  node.classList = {
    add: (c) => owner.classes.add(c),
    remove: (c) => owner.classes.delete(c),
    contains: (c) => owner.classes.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !owner.classes.has(c) : !!force;
      if (on) owner.classes.add(c); else owner.classes.delete(c);
      return on;
    },
  };
  if (filter === 'all') owner.classes.add('active');
  node.closest = (sel) => (sel === '[data-filter]' ? node : null);
  node.count = { textContent: '', attrs: {} };
  node.count.setAttribute = (k, v) => { node.count.attrs[k] = v; };
  node.count.removeAttribute = (k) => { delete node.count.attrs[k]; };
  node.count.getAttribute = (k) => node.count.attrs[k];
  node.setAttribute = (k, v) => { owner.attrs[k] = v; };
  node.removeAttribute = (k) => { delete owner.attrs[k]; };
  node.querySelector = (sel) => (sel === '.tab-count' ? node.count : null);
  return node;
}

function textNode(id) {
  const node = el(id);
  let raw = '';
  Object.defineProperty(node, 'textContent', {
    get() { return raw; },
    set(v) {
      raw = v == null ? '' : String(v);
      node.innerHTML = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  });
  return node;
}

function loadShared(sandbox) {
  const src = fs.readFileSync(SHARED, 'utf8').replace(/^export\s+/gm, '');
  vm.createContext(sandbox);
  vm.runInContext(
    src + '\nglobalThis.__shared = { esc, tr, statusLabel, deliveryState, normalizeStatus, itemsChips, deliveryAddress, deliveryPhone, deliveryCoords, navUrl, getMyUserId, isAssignedToMe, apiErrorMessage, setRefreshLoading, money, statusClass };',
    sandbox,
    { filename: SHARED }
  );
  return sandbox.__shared;
}

/** Load deliveries.js with its imports injected as sandbox globals. */
function loadQueue(sandbox) {
  const src = fs.readFileSync(QUEUE, 'utf8')
    .replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, '')
    .replace(/document\.addEventListener\(["']DOMContentLoaded["'][\s\S]*$/m, '')
    + '\nglobalThis.__queue = { bindEvents, render, loadQueues, matchesFilter, currentFilter };'
    + '\nglobalThis.__getFilter = () => currentFilter;';
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: QUEUE });
  return sandbox.__queue;
}

const ORDERS = [
  {
    orderId: 'D-READY', customerName: 'Ready One', totalAmount: 100, deliveryFee: 10, paymentStatus: 'PAID',
    status: 'READY', deliveryStatus: 'ACCEPTED', deliveryAcceptanceStatus: 'ACCEPTED',
    deliveryStaffAssigned: { id: 'RIDER1', name: 'Rider' },
    deliveryInfo: { subCity: 'Bole', location: 'House 1', phone: '0700' }, items: [{ name: 'Shiro', quantity: 1 }],
  },
  {
    orderId: 'D-PICKED', customerName: 'Picked One', totalAmount: 120, deliveryFee: 10, paymentStatus: 'PAID',
    status: 'READY', deliveryStatus: 'PICKED_UP', deliveryAcceptanceStatus: 'ACCEPTED',
    deliveryStaffAssigned: { id: 'RIDER1', name: 'Rider' },
    deliveryInfo: { subCity: 'Bole', location: 'House 2', phone: '0701' }, items: [{ name: 'Kitfo', quantity: 2 }],
  },
  {
    orderId: 'D-OUT', customerName: 'Out One', totalAmount: 130, deliveryFee: 10, paymentStatus: 'PENDING',
    status: 'OUT_FOR_DELIVERY', deliveryStatus: 'OUT_FOR_DELIVERY', deliveryAcceptanceStatus: 'ACCEPTED',
    deliveryStaffAssigned: { id: 'RIDER1', name: 'Rider' },
    deliveryInfo: { subCity: 'Bole', location: 'House 3', phone: '0702' }, items: [{ name: 'Firfir', quantity: 1 }],
  },
  {
    orderId: 'D-ARRIVED', customerName: 'Arrived One', totalAmount: 140, deliveryFee: 10, paymentStatus: 'PAID',
    status: 'ARRIVED', deliveryStatus: 'ARRIVED', deliveryAcceptanceStatus: 'ACCEPTED',
    deliveryStaffAssigned: { id: 'RIDER1', name: 'Rider' },
    deliveryInfo: { subCity: 'Bole', location: 'House 4', phone: '0703' }, items: [{ name: 'Doro', quantity: 1 }],
  },
  {
    orderId: 'D-DELIVERED', customerName: 'Delivered One', totalAmount: 150, deliveryFee: 10, paymentStatus: 'PAID',
    status: 'DELIVERED', deliveryStatus: 'DELIVERED', deliveryAcceptanceStatus: 'ACCEPTED',
    deliveryStaffAssigned: { id: 'RIDER1', name: 'Rider' },
    deliveryInfo: { subCity: 'Bole', location: 'House 5', phone: '0704' }, items: [{ name: 'Misir', quantity: 1 }],
  },
];

const PAST = [
  {
    orderId: 'D-DONE', customerName: 'Done One', totalAmount: 160, deliveryFee: 10, paymentStatus: 'PAID',
    status: 'COMPLETED', deliveryStatus: 'COMPLETED', deliveryAcceptanceStatus: 'ACCEPTED',
    deliveryStaffAssigned: { id: 'RIDER1', name: 'Rider' },
    deliveryInfo: { subCity: 'Bole', location: 'House 6', phone: '0705' }, items: [{ name: 'Atkilt', quantity: 1 }],
  },
];

/**
 * Expected visible order ids per tab, derived independently of the page.
 *
 * D-PICKED deliberately keeps `status: 'READY'` while its `deliveryStatus` has
 * already advanced to PICKED_UP - that is what the backend really sends (it holds
 * order.status at READY until pickup). It must therefore appear under "picked" and
 * NOT under "ready": each card belongs to exactly one stage tab, and the stage
 * tabs must sum to "All". An earlier version of this fixture expected it in both,
 * which is why the double-count passed this file.
 */
const EXPECTED = {
  ready: ['D-READY'],
  picked: ['D-PICKED'],
  out: ['D-OUT'],
  arrived: ['D-ARRIVED'],
  delivered: ['D-DELIVERED'],
  past: ['D-DONE'],
  all: ['D-READY', 'D-PICKED', 'D-OUT', 'D-ARRIVED', 'D-DELIVERED'],
};

function makePage() {
  const nodes = {};
  ['deliveryList', 'errorBanner', 'refreshBtn', 'statReady', 'statOut', 'statArrived',
    'statAssignedMe', 'statAwaitingComplete', 'statCompleted'].forEach((id) => {
    nodes[id] = el(id);
  });

  const tabs = tabsFromPage().map((t) => tabEl(t.filter));
  const docListeners = {};
  const tabsWrapper = { querySelectorAll: (sel) => (sel === '[data-filter]' ? tabs : []) };

  const sandbox = {
    console,
    Date, JSON, Number, String, Array, Object, Math, Boolean, RegExp, Error, Promise, Set, Map,
    encodeURIComponent, parseInt, parseFloat, isNaN, Intl,
    setInterval: () => 1, clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {},
    localStorage: {
      getItem: (k) => {
        if (k === 'current_user') return JSON.stringify({ id: 'RIDER1', role: 'delivery' });
        return null;
      },
      setItem: () => {}, removeItem: () => {},
    },
    document: {
      readyState: 'complete',
      hidden: false,
      getElementById: (id) => nodes[id] || null,
      querySelector: (sel) => (sel === '.delivery-tabs' ? tabsWrapper : null),
      querySelectorAll: (sel) => (sel === '[data-filter]' ? tabs : []),
      addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
      createElement: () => textNode('tmp'),
      body: el('body'),
    },
    window: {
      addEventListener: () => {},
      location: { search: '', href: '' },
      open: () => null,
      getText: () => '',
      confirm: () => true,
    },
    confirm: () => true,
    alert: () => {},
    api: {
      get: async (p) => {
        if (p === '/deliveries/mine') return { orders: ORDERS };
        if (p === '/deliveries/my-history?status=completed') return { orders: PAST };
        return { orders: [] };
      },
      patch: async () => ({ success: true }),
      post: async () => ({ success: true }),
    },
    socketClient: {
      on: () => {}, joinOrderRoom: () => {}, joinDeliveryRoom: () => {},
      disconnect: () => {}, isDeliveryStaff: () => true, connect: () => {}, socket: null,
    },
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
    sosButtonHtml: () => '',
    bindSos: () => {},
    openProofModal: () => {},
    CSS: { escape: (v) => String(v) },
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;

  Object.assign(sandbox, loadShared(sandbox));
  const queue = loadQueue(sandbox);

  queue.bindEvents();
  return { sandbox, queue, nodes, tabs, docListeners };
}

function clickOn(page, tab) {
  page.docListeners.click.forEach((fn) => fn({ target: tab, preventDefault() {}, stopPropagation() {} }));
}

/** Order ids actually present in the rendered list html. */
function renderedIds(html) {
  const ids = [];
  const re = /<div class="delivery-card[^"]*" data-order="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) ids.push(m[1]);
  return ids;
}

(async function main() {
  console.log('Delivery Active Deliveries: filter tab bar\n');

  const defs = tabsFromPage();

  await check('the page renders a tab for every delivery stage plus All', () => {
    const filters = defs.map((t) => t.filter);
    ['ready', 'picked', 'out', 'arrived', 'delivered', 'past', 'all'].forEach((f) => {
      assert(filters.includes(f), `tab "${f}" is missing from deliveries.html`);
    });
  });

  const page = makePage();
  await page.queue.loadQueues();

  for (const def of defs) {
    await check(`clicking "${def.label}" filters the queue to that stage`, () => {
      clickOn(page, page.tabs.find((t) => t.getAttribute('data-filter') === def.filter));
      assert(
        page.sandbox.__getFilter() === def.filter,
        `filter is "${page.sandbox.__getFilter()}" after clicking "${def.filter}"`
      );
      const active = page.tabs.filter((t) => t.classes.has('active'));
      assert(
        active.length === 1 && active[0].getAttribute('data-filter') === def.filter,
        `exactly one tab must be active, got [${active.map((t) => t.getAttribute('data-filter')).join(', ')}]`
      );
      const shown = renderedIds(page.nodes.deliveryList.innerHTML);
      assert(
        shown.join(',') === EXPECTED[def.filter].join(','),
        `expected [${EXPECTED[def.filter].join(', ')}], rendered [${shown.join(', ')}]`
      );
    });
  }

  await check('a stage tab really narrows the list (it is not a no-op)', () => {
    const widths = [];
    for (const def of defs) {
      clickOn(page, page.tabs.find((t) => t.getAttribute('data-filter') === def.filter));
      widths.push(renderedIds(page.nodes.deliveryList.innerHTML).length);
    }
    assert(new Set(widths).size > 1, `every tab rendered the same number of cards: ${widths.join(',')}`);
  });

  await check('the stage tabs partition "All": no card is in two tabs', () => {
    // The bug this guards: `isAwaitingPickup()` used to read `order.status` on its
    // own, and the backend keeps order.status === 'READY' until the courier picks
    // the food up. A PICKED_UP delivery therefore matched BOTH "ready" (via
    // status) and "picked" (via deliveryStatus), so the stage counts summed to
    // more than "All" and one card showed up under two tabs.
    clickOn(page, page.tabs.find((t) => t.getAttribute('data-filter') === 'all'));
    const allIds = renderedIds(page.nodes.deliveryList.innerHTML);

    const seen = new Map();
    for (const def of defs) {
      if (def.filter === 'all' || def.filter === 'past') continue; // `past` is a
      // separate terminal-only request, so it is legitimately disjoint.
      clickOn(page, page.tabs.find((t) => t.getAttribute('data-filter') === def.filter));
      renderedIds(page.nodes.deliveryList.innerHTML).forEach((id) => {
        if (!seen.has(id)) seen.set(id, []);
        seen.get(id).push(def.filter);
      });
    }

    const doubled = [...seen.entries()].filter(([, tabs]) => tabs.length > 1);
    assert(
      doubled.length === 0,
      `these cards appear under more than one stage tab: ` +
        doubled.map(([id, tabs]) => `${id} -> [${tabs.join(', ')}]`).join('; ')
    );

    const stageSum = ['ready', 'picked', 'out', 'arrived', 'delivered'].reduce((sum, f) => {
      clickOn(page, page.tabs.find((t) => t.getAttribute('data-filter') === f));
      return sum + renderedIds(page.nodes.deliveryList.innerHTML).length;
    }, 0);
    assert(
      stageSum === allIds.length,
      `the stage tabs hold ${stageSum} cards but "All" holds ${allIds.length}; ` +
        'a card is being counted twice or dropped entirely'
    );
  });

  await check('a picked-up delivery is NOT still listed as awaiting pickup', () => {
    // The concrete production case: order.status stays 'READY' while deliveryStatus
    // has already advanced, exactly as the backend serializes a picked-up run.
    clickOn(page, page.tabs.find((t) => t.getAttribute('data-filter') === 'picked'));
    const picked = renderedIds(page.nodes.deliveryList.innerHTML);
    assert(picked.includes('D-PICKED'), `the picked tab lost D-PICKED: [${picked.join(', ')}]`);

    clickOn(page, page.tabs.find((t) => t.getAttribute('data-filter') === 'ready'));
    const ready = renderedIds(page.nodes.deliveryList.innerHTML);
    assert(
      !ready.includes('D-PICKED'),
      `D-PICKED has deliveryStatus PICKED_UP but still shows under "ready": [${ready.join(', ')}]`
    );
  });

  await check('the tab bar survives a re-render (delegated, not per-node)', () => {
    clickOn(page, page.tabs.find((t) => t.getAttribute('data-filter') === 'out'));
    page.queue.render();
    clickOn(page, page.tabs.find((t) => t.getAttribute('data-filter') === 'arrived'));
    assert(page.sandbox.__getFilter() === 'arrived', 'a later click stopped working after render()');
  });

  await check('every tab shows its live count, including the empty stages', () => {
    page.queue.render();
    defs.forEach((def) => {
      const badge = page.tabs.find((t) => t.getAttribute('data-filter') === def.filter).count;
      const expected = EXPECTED[def.filter].length;
      assert(
        Number(badge.textContent) === expected,
        `"${def.label}" badge reads "${badge.textContent}", expected ${expected}`
      );
      assert(
        badge.getAttribute('data-empty') === (expected === 0 ? '1' : '0'),
        `"${def.label}" empty flag is "${badge.getAttribute('data-empty')}" for count ${expected}`
      );
    });
  });

  await check('an empty tab says WHICH stage is empty, not a generic "no match"', () => {
    // A courier with nothing in any stage: every tab is legitimately empty, and
    // that must read differently from a tab that is not wired up at all.
    page.sandbox.api.get = async () => ({ orders: [] });
    return page.queue.loadQueues().then(() => {
      clickOn(page, page.tabs.find((t) => t.getAttribute('data-filter') === 'out'));
      const html = page.nodes.deliveryList.innerHTML;
      assert(html.includes('empty-state'), 'the empty tab rendered no empty state');
      assert(
        html.includes('out for delivery right now'),
        `an empty stage must name itself so it is not mistaken for a dead tab: ${html}`
      );
      const badge = page.tabs.find((t) => t.getAttribute('data-filter') === 'out').count;
      assert(badge.textContent === '0', `expected a 0 badge, got "${badge.textContent}"`);
    });
  });

  await check('the page ships a count badge node for every tab', () => {
    const html = fs.readFileSync(PAGE, 'utf8');
    defs.forEach((def) => {
      assert(
        html.includes(`data-tab-count="${def.filter}"`),
        `tab "${def.filter}" has no .tab-count node in deliveries.html`
      );
    });
  });

  await check('no tab claims "0" before the server has answered', () => {
    // A hardcoded 0 in the markup is a claim about the world that nobody has
    // verified yet, and it is exactly what made a dead page look like a
    // cafeteria with no deliveries.
    const html = fs.readFileSync(PAGE, 'utf8');
    const shipped = [...html.matchAll(/data-tab-count="([a-z]+)">([^<]*)</g)];
    assert(shipped.length > 0, 'no tab counts found in the markup');
    shipped.forEach(([, filter, text]) => {
      assert(
        text.trim() !== '0',
        `tab "${filter}" ships a hardcoded 0 in the HTML; it must ship an unknown marker instead`
      );
    });
  });

  await check('a failed load shows "could not load", never an empty stage message', async () => {
    // This is what the courier saw: every badge at 0 and a tab bar that did
    // nothing, because the queue request never succeeded.
    const broken = makePage();
    broken.sandbox.api.get = async () => {
      throw new Error('Could not connect to backend server.');
    };
    await broken.queue.loadQueues();

    broken.tabs.forEach((tab) => {
      const badge = tab.count;
      assert(
        badge.textContent !== '0' && badge.textContent !== '0.0',
        `tab "${tab.getAttribute('data-filter')}" still claims 0 after the load failed`
      );
      assert(
        badge.getAttribute('data-unavailable') === '1',
        `tab "${tab.getAttribute('data-filter')}" is not flagged as unavailable after a failed load`
      );
    });

    const html = broken.nodes.deliveryList.innerHTML;
    assert(
      html.includes('Could not load'),
      `a failed load rendered a stage empty-state instead of the error: ${html}`
    );
    assert(
      html.includes('data-action="refresh"'),
      'the failure state offers no way to retry'
    );
  });

  await check('a successful reload clears the unavailable state', async () => {
    const flaky = makePage();
    let offline = true;
    const realGet = flaky.sandbox.api.get;
    flaky.sandbox.api.get = async (p) => {
      if (offline) throw new Error('network down');
      return realGet(p);
    };
    await flaky.queue.loadQueues();
    offline = false;
    await flaky.queue.loadQueues();

    flaky.tabs.forEach((tab) => {
      const filter = tab.getAttribute('data-filter');
      const badge = tab.count;
      assert(
        badge.getAttribute('data-unavailable') == null,
        `tab "${filter}" stayed flagged unavailable after a successful reload`
      );
      assert(
        /^\d+$/.test(badge.textContent),
        `tab "${filter}" shows "${badge.textContent}" instead of a real count after a successful reload`
      );
    });
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
})();