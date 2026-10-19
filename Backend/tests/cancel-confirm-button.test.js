/**
 * Customer cancellation - the "Confirm Cancellation" button must actually work.
 *
 * WHY: two defects made the button look completely inert.
 *
 *  1. Every failure was rendered with `showAlert()`, which writes to
 *     `#alertMessage` - an element in normal document flow. The confirmation
 *     modal is a `position:fixed; inset:0; z-index:10000` overlay with a dark
 *     backdrop, so that alert was painted BEHIND the modal and was never
 *     visible. The customer clicked Confirm, the request failed, the spinner
 *     stopped, and nothing appeared to happen at all.
 *
 *  2. `ApiClient.request` THROWS on every non-2xx and attaches the server's own
 *     `error` string to `Error.message`. The handler's `else { showAlert(result.error) }`
 *     branch was therefore dead code, and the live `catch` threw the real
 *     message away in favour of a hardcoded "An unexpected error occurred."
 *     So even the backend's precise reason ("this order has already entered the
 *     PREPARING stage", "a cancellation record already exists") never reached
 *     the customer.
 *
 * This test drives the real inline module from cancel-order.html against a
 * minimal DOM, so it fails if the error stops being shown inside the modal, if
 * the real server message is swallowed again, or if the button gets stuck
 * disabled and cannot be retried.
 *
 * Run: node Backend/tests/cancel-confirm-button.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', '..', 'Frontend', 'src', 'pages', 'customer', 'cancel-order.html');

let pass = 0;
const failures = [];
const checks = [];
function check(name, fn) {
  const p = (async () => {
    try { await fn(); pass++; console.log(`  ok  ${name}`); }
    catch (e) { failures.push(name); console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); }
  })();
  checks.push(p);
  return p;
}

// ---------------------------------------------------------------------------
// Minimal DOM
// ---------------------------------------------------------------------------

class El {
  constructor(id, tag = 'div', cls = '') {
    this.id = id;
    this.tagName = (tag || 'div').toUpperCase();
    this.className = cls;
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.parent = null;
    this._text = '';
    this._html = '';
    this.value = '';
    this.disabled = false;
    this.checked = false;
    this.focused = false;
    this.listeners = {};
    const classes = new Set(cls.split(' ').filter(Boolean));
    this.classList = {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)),
    };
  }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  contains() { return false; }
  focus() { this.focused = true; }
  closest(sel) {
    let n = this;
    const cls = sel.replace(/^\./, '');
    while (n) { if (String(n.className || '').split(' ').includes(cls)) return n; n = n.parent; }
    return null;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute() {}
  getAttribute() { return null; }
  insertAdjacentHTML() {}
  dispatch(type, event) {
    const ev = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {} }, event);
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  click() { return this.dispatch('click', { target: this }); }
}

/**
 * Build the page's DOM and run the real inline module against it.
 * `postImpl` decides what the cancellation POST does.
 *
 * Async on purpose: the page module is an ES module with top-level `await`
 * (it fetches the order before it attaches the form + confirm handlers), so a
 * test must not drive the DOM until the module has settled.
 */
async function loadPage({ postImpl, orderOver = {} }) {
  const src = fs.readFileSync(PAGE, 'utf8');
  const match = src.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match, 'inline module script must exist');

  // The elements the flow touches. getElementById is registry-based, so the
  // template string the page renders into #cancelContent does not need to be
  // parsed into real nodes.
  const ids = [
    'cancelContent', 'alertMessage', 'alertText',
    'cancelForm', 'cancelReason', 'cancelDetails', 'cancelBtn',
    'cancelConfirmModal', 'modalConfirmBtn', 'modalKeepOrderBtn',
    'mOrderId', 'mOrderStatus', 'mOrderTotal',
    'mRefundSubtotal', 'mRefundServiceFee', 'mRefundTotalPaid', 'mRefundAmount',
    'mOrderReason', 'mPrepWarning',
    'mModalAlert', 'mModalAlertText',
  ];
  const registry = new Map();
  for (const id of ids) {
    const tag = id.startsWith('modal') || id === 'cancelConfirmModal' ? 'button' : 'div';
    const cls = id === 'cancelConfirmModal' ? '' : (id === 'modalConfirmBtn' ? 'btn-cancel-order' : '');
    registry.set(id, new El(id, tag, cls));
  }
  // Hierarchy the handler relies on.
  const modalOverlay = registry.get('cancelConfirmModal');
  const modalBox = new El('', 'div', 'cancel-modal');
  modalOverlay.appendChild(modalBox);
  for (const id of ids) {
    if (id === 'cancelConfirmModal') continue;
    const el = registry.get(id);
    (id === 'modalConfirmBtn' || id === 'modalKeepOrderBtn' ? modalBox : modalOverlay).appendChild(el);
  }

  const state = { posted: [], errors: [] };

  const api = {
    get: async () => ({
      success: true,
      order: Object.assign({
        orderId: 'ET-CANCEL-1',
        status: 'pending',
        orderStatus: 'PENDING',
        paymentStatus: 'PAID',
        subtotal: 100,
        serviceFee: 20,
        totalAmount: 138,
        refundSummary: { subtotal: 100, serviceFee: 20, totalPaid: 120, refundAmount: 100, currency: 'ETB' },
      }, orderOver),
    }),
    post: async (pathName, body) => {
      state.posted.push({ pathName, body });
      return postImpl(state.posted.length, body);
    },
  };

  const documentStub = {
    getElementById: (id) => registry.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (t) => new El('', t, ''),
    addEventListener: () => {},
    body: new El('body', 'body', ''),
    documentElement: new El('html', 'html', ''),
  };

  const windowStub = {
    location: { search: '?id=ET-CANCEL-1', href: '', pathname: '/cancel-order.html' },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({}),
    scrollTo() {},
    confirm: () => true,
    alert() {},
  };

  const localStorage = {
    getItem: (k) => (k === 'auth_token' || k === 'current_user' ? (k === 'auth_token' ? 'token' : '{"role":"customer"}') : null),
    setItem() {}, removeItem() {},
  };

  // Strip ESM syntax and hand every import in as a parameter.
  const body = match[1]
    .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+/gm, '');

  const sandbox = {
    api,
    window: windowStub,
    document: documentStub,
    localStorage,
    URLSearchParams,
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error: (...a) => state.errors.push(a.join(' ')) },
    consoleStub: null,
    fetch: async () => { throw new Error('unexpected fetch'); },
    FormData: class {},
    // imports
    createHeader() {}, createFooter() {}, getCartCount: () => 0,
    requestCancellation: async (orderId, reason, details) =>
      api.post('/cancellations/request', { orderId, reason, details }),
    getCancellationReasons: () => [{ value: 'CUSTOMER_CHANGED_MIND', label: 'I changed my mind' }],
    isLoggedIn: () => true,
    getCurrentUser: () => ({ id: 'u1', role: 'customer', name: 'Tester' }),
    showToast() {},
    formatDate: (d) => String(d),
    formatTime: (d) => String(d),
    computeRefundSummary: (o) => (o && o.refundSummary) || {
      subtotal: Number(o?.subtotal) || 0,
      serviceFee: Number(o?.serviceFee) || 0,
      totalPaid: (Number(o?.subtotal) || 0) + (Number(o?.serviceFee) || 0),
      refundAmount: Number(o?.subtotal) || 0,
      currency: 'ETB',
    },
    __registerLangChange() {},
    formatStatus: (s) => s,
    window_tr: undefined,
  };
  sandbox.globalThis = sandbox;

  const names = Object.keys(sandbox).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  let factory;
  try {
    // The page module uses top-level `await`, which a bare `new Function`
    // body cannot hold - wrap it in an async IIFE, which keeps the module's
    // semantics (deferred, non-blocking) intact.
    factory = new Function(...names, 'return (async () => {\n' + body + '\n})();');
  } catch (e) {
    throw new Error('inline module failed to compile: ' + e.message);
  }
  factory(...names.map((n) => sandbox[n])).catch((e) => {
    state.errors.push('module: ' + (e && e.message));
  });

  // Let the module's async body finish so the form + confirm handlers exist.
  await new Promise((r) => setTimeout(r, 10));

  return { registry, state, modalOverlay, modalBox };
}

/** Open the confirmation modal the way the customer does. */
async function openModal(page) {
  const form = page.registry.get('cancelForm');
  const reason = page.registry.get('cancelReason');
  reason.value = 'CUSTOMER_CHANGED_MIND';
  form.dispatch('submit', {});
  // The form handler is synchronous apart from the open, so settle a tick.
  await new Promise((r) => setImmediate(r));
}

const alertIsVisible = (page) => page.registry.get('mModalAlert').style.display === 'block';
const alertText = (page) => page.registry.get('mModalAlertText').textContent;

// api.js rejects with an Error carrying the server's own message + status.
const apiError = (status, message) => Object.assign(new Error(message), { status, rawMessage: message });

(async () => {
  console.log('========== CANCEL CONFIRM BUTTON ==========');
  console.log('');

  console.log('A failure must be visible INSIDE the modal');

  await check('the error renders in the modal, not behind its overlay', async () => {
    const page = await loadPage({
      postImpl: () => Promise.reject(apiError(400, 'This order can no longer be cancelled because it has already entered the "PREPARING" stage.')),
    });
    await openModal(page);
    assert.strictEqual(page.modalOverlay.style.display, 'flex', 'modal must open first');

    page.registry.get('modalConfirmBtn').click();
    await new Promise((r) => setImmediate(r));

    // The page-level #alertMessage is in normal document flow, underneath a
    // position:fixed z-index:10000 overlay. Only an in-modal region can be seen.
    assert.ok(alertIsVisible(page), 'the in-modal error region must be shown');
    assert.strictEqual(alertText(page).length > 0, true, 'the in-modal error must carry text');

    const pageLevel = page.registry.get('alertMessage');
    assert.notStrictEqual(pageLevel.className, 'alert alert-error show',
      'the failure must not be routed to the hidden page-level alert');
  });

  await check("the backend's own reason is shown, not a generic apology", async () => {
    const serverMsg = 'This order can no longer be cancelled because it has already entered the "PREPARING" stage.';
    const page = await loadPage({ postImpl: () => Promise.reject(apiError(400, serverMsg)) });
    await openModal(page);
    page.registry.get('modalConfirmBtn').click();
    await new Promise((r) => setImmediate(r));

    assert.ok(alertText(page).includes('PREPARING'), `expected the server reason, got: ${alertText(page)}`);
    assert.ok(!/unexpected error/i.test(alertText(page)), 'the generic apology must be gone');
  });

  await check('a 409 duplicate-cancellation is explained', async () => {
    const page = await loadPage({
      postImpl: () => Promise.reject(apiError(409, 'A cancellation record already exists for this order')),
    });
    await openModal(page);
    page.registry.get('modalConfirmBtn').click();
    await new Promise((r) => setImmediate(r));

    assert.ok(alertIsVisible(page));
    assert.ok(/already exists/i.test(alertText(page)), `got: ${alertText(page)}`);
  });

  await check('a network failure (no status) still produces a readable message', async () => {
    const page = await loadPage({ postImpl: () => Promise.reject(new Error('Failed to fetch')) });
    await openModal(page);
    page.registry.get('modalConfirmBtn').click();
    await new Promise((r) => setImmediate(r));

    assert.ok(alertIsVisible(page));
    assert.ok(alertText(page).length > 0, 'must never show an empty error');
  });

  console.log('');
  console.log('The button must stay usable');

  await check('the button is disabled + spinning in flight, and re-enabled after a failure', async () => {
    let release;
    let attempt = 0;
    const page = await loadPage({
      postImpl: () => {
        attempt++;
        if (attempt === 1) {
          // Hold the request open so the in-flight state is observable.
          return new Promise((resolve, reject) => { release = () => reject(apiError(500, 'Server error')); });
        }
        return Promise.resolve({ success: true, refunded: false, refundRequested: true, cancellation: { refundAmount: 100 } });
      },
    });
    await openModal(page);

    const btn = page.registry.get('modalConfirmBtn');
    btn.click();
    await new Promise((r) => setImmediate(r));

    assert.ok(btn.classList.contains('loading'), 'spinner shows while in flight');
    assert.strictEqual(btn.disabled, true, 'button is locked while in flight');

    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.ok(!btn.classList.contains('loading'), 'spinner clears after the failure');
    assert.strictEqual(btn.disabled, false, 'button must be re-enabled so it can be retried');

    btn.click();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(page.state.posted.length, 2, 'the retry must reach the API');
    assert.ok(page.modalBox.innerHTML.includes('Order Cancelled'), 'the retry succeeds');
  });

  await check('a double click cannot submit twice', async () => {
    const page = await loadPage({
      postImpl: () => new Promise((r) => setTimeout(() => r({ success: true }), 5)),
    });
    await openModal(page);
    const btn = page.registry.get('modalConfirmBtn');
    btn.click();
    btn.click();
    btn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(page.state.posted.length, 1, `expected 1 request, got ${page.state.posted.length}`);
  });

  await check('"Keep Order" closes the modal and clears a stale error', async () => {
    const page = await loadPage({ postImpl: () => Promise.reject(apiError(409, 'A cancellation record already exists for this order')) });
    await openModal(page);
    page.registry.get('modalConfirmBtn').click();
    await new Promise((r) => setImmediate(r));
    assert.ok(alertIsVisible(page), 'precondition: an error is showing');

    page.registry.get('modalKeepOrderBtn').click();
    assert.strictEqual(page.modalOverlay.style.display, 'none', 'modal closes');
    assert.strictEqual(alertIsVisible(page), false, 'the error is cleared for next time');
  });

  console.log('');
  console.log('Success');

  await check('a successful cancellation confirms in the modal with the refund amount', async () => {
    const page = await loadPage({
      postImpl: () => Promise.resolve({ success: true, refunded: false, refundRequested: true, cancellation: { refundAmount: 100 } }),
    });
    await openModal(page);
    page.registry.get('modalConfirmBtn').click();
    await new Promise((r) => setImmediate(r));

    assert.ok(page.modalBox.innerHTML.includes('Order Cancelled'));
    assert.ok(page.modalBox.innerHTML.includes('100.00 ETB'), 'refund amount shown');
  });

  await check('the confirmation step shows the VAT-free refund summary', async () => {
    const page = await loadPage({ postImpl: () => Promise.resolve({ success: true }) });
    await openModal(page);
    const r = page.registry;
    assert.strictEqual(r.get('mRefundSubtotal').textContent, '100.00 ETB');
    assert.strictEqual(r.get('mRefundServiceFee').textContent, '20.00 ETB');
    assert.strictEqual(r.get('mRefundTotalPaid').textContent, '120.00 ETB');
    assert.strictEqual(r.get('mRefundAmount').textContent, '100.00 ETB');
    assert.ok(!page.modalBox.innerHTML.includes('VAT'), 'VAT must not appear');
  });

  await check('success offers a way onward instead of yanking the page away', async () => {
    const page = await loadPage({ postImpl: () => Promise.resolve({ success: true }) });
    await openModal(page);
    page.registry.get('modalConfirmBtn').click();
    await new Promise((r) => setImmediate(r));
    assert.ok(/order-tracking\.html\?orderId=ET-CANCEL-1/.test(page.modalBox.innerHTML), 'links to the tracker by orderId');
  });

  console.log('');
  console.log('Viewers who may read but not cancel');

  await check('a viewer who may not cancel is not shown a Confirm button at all', async () => {
    // e.g. the assigned courier: GET /orders/:id succeeds (they must be able to
    // deliver it) but canCancel is false. Rendering the button would guarantee a
    // 403 on click.
    const page = await loadPage({
      postImpl: () => Promise.resolve({ success: true }),
      orderOver: {
        canCancel: false,
        cancelBlockedReason: 'This order belongs to another customer. Ask a manager or the cafeteria administrator to cancel it.',
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    const content = page.registry.get('cancelContent').innerHTML;
    assert.ok(/Ask a manager or the cafeteria administrator/.test(content),
      'the page must state why it cannot cancel, not claim the order is already past its stage');
    assert.ok(!/This order is already/.test(content),
      'the status-based message is nonsense for a viewer who simply may not cancel');
    assert.strictEqual(
      (page.registry.get('cancelForm').listeners.submit || []).length,
      0,
      'no cancel form may be wired up for a viewer who cannot cancel'
    );
    assert.strictEqual(page.state.posted.length, 0, 'nothing may be submitted');
  });

  await check('a viewer who may cancel still gets the form', async () => {
    const page = await loadPage({
      postImpl: () => Promise.resolve({ success: true }),
      orderOver: { canCancel: true, cancelBlockedReason: null },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(
      (page.registry.get('cancelForm').listeners.submit || []).length,
      1,
      'the form must be available to an owner / manager'
    );
  });

  console.log('');
  console.log(`${pass + failures.length} checks, ${failures.length} failed`);
  if (failures.length) {
    console.log('Failed: ' + failures.join(', '));
    process.exit(1);
  }
  process.exit(0);
})();
