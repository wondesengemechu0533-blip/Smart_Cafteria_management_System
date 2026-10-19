/**
 * Customer tracking - the live-status poll must stop on a PERMANENT failure.
 *
 * WHY: startStatusPolling() in order-status.js fires every 5s and only ever
 * stopped on a TERMINAL STATUS it had managed to read. A 403 (this viewer may
 * never read this order) or a 404 (no such order) can never produce that status,
 * so the loop ran for the entire life of the tab - one guaranteed 403 and one
 * round trip every five seconds, forever.
 *
 * The opposite guard matters just as much: a timeout, a dropped connection or a
 * 5xx is TRANSIENT, and the tracker must keep polling through it. A fix that
 * stopped on any error would silently freeze every customer's live tracker
 * whenever the network hiccuped.
 *
 * Run: node Backend/tests/order-tracking-poll-stop.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ORDER_STATUS_JS = path.join(__dirname, '..', '..', 'Frontend', 'src', 'js', 'order-status.js');

let pass = 0;
let fail = 0;
const pendingChecks = [];
function check(name, fn) {
  pendingChecks.push((async () => {
    try { await fn(); pass++; console.log('  PASS ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + ' -- ' + e.message); }
  })());
}

/**
 * Load order-status.js with a stubbed `api`, a manual clock and a stubbed
 * `localStorage`, then return its poll starter plus a tick() driver.
 */
function loadPage(failingWith) {
  const src = fs.readFileSync(ORDER_STATUS_JS, 'utf8');

  const state = { apiCalls: 0, intervals: [], cleared: 0, logged: [] };

  const api = {
    get() {
      state.apiCalls++;
      return Promise.reject(failingWith());
    },
  };

  const localStorage = {
    getItem: (k) => (k === 'auth_token' ? 'token' : null),
    setItem() {}, removeItem() {},
  };

  const documentStub = { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] };

  // order-status.js is an ES module. Strip the import/export syntax so the body
  // can run under `new Function`, and hand the bindings in as parameters instead.
  const body = src
    .replace(/^import\s+[^;]+;\s*$/gm, '')
    .replace(/^export\s+/gm, '');

  // Expose the module's internals for the test without changing the file.
  const instrumented = body + `
;return { startStatusPolling, stopStatusPolling,
  isPolling: () => statusPollTimer !== null };
`;

  const sandbox = {
    api,
    localStorage,
    document: documentStub,
    window: { location: { search: '' }, addEventListener() {} },
    setInterval(fn, ms) { state.intervals.push({ fn, ms }); return state.intervals.length; },
    clearInterval() { state.cleared++; },
    console: { log: (...a) => state.logged.push(a.join(' ')), warn() {}, error() {} },
    URLSearchParams,
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    setTimeout, clearTimeout,
    // socket.js is not under test here; the tracker only needs it to exist.
    socketClient: { on() {}, off() {}, disconnect() {} },
  };

  const names = Object.keys(sandbox);
  const factory = new Function(...names, instrumented);
  return { page: factory(...names.map((n) => sandbox[n])), state };
}

const forbidden = () => Object.assign(new Error('You do not have permission to perform this action.'), { status: 403 });
const notFound = () => Object.assign(new Error('Order not found'), { status: 404 });
const timedOut = () => Object.assign(new Error('Request timed out. Please try again.'), { status: undefined });
const serverError = () => Object.assign(new Error('Server error'), { status: 500 });

(async () => {
  console.log('========== TRACKING POLL - STOPS ON PERMANENT FAILURE ==========');
  console.log('');

  check('the poll is scheduled every 5s', () => {
    const { page, state } = loadPage(forbidden);
    page.startStatusPolling('ET-TEST-1');
    assert.strictEqual(state.intervals.length, 1);
    assert.strictEqual(state.intervals[0].ms, 5000);
  });

  check('a 403 stops the poll', async () => {
    const { page, state } = loadPage(forbidden);
    page.startStatusPolling('ET-TEST-1');
    assert.strictEqual(page.isPolling(), true, 'poll did not start');
    await state.intervals[0].fn();       // one tick -> one 403
    assert.strictEqual(page.isPolling(), false, 'still polling after a 403');
    assert.ok(state.cleared >= 1, 'clearInterval was never called');
  });

  check('a 404 stops the poll', async () => {
    const { page, state } = loadPage(notFound);
    page.startStatusPolling('ET-TEST-1');
    await state.intervals[0].fn();
    assert.strictEqual(page.isPolling(), false, 'still polling after a 404');
  });

  check('later ticks after a 403 make NO further requests', async () => {
    const { page, state } = loadPage(forbidden);
    page.startStatusPolling('ET-TEST-1');
    const tick = state.intervals[0].fn;
    await tick();
    const callsAtStop = state.apiCalls;
    // A timer already queued in the event loop still fires once - it must not
    // reach the network.
    await tick(); await tick(); await tick();
    assert.strictEqual(state.apiCalls, callsAtStop,
      `${state.apiCalls - callsAtStop} extra request(s) after the poll stopped`);
  });

  check('the 403 stop is explained in the log, not silent', async () => {
    const { page, state } = loadPage(forbidden);
    page.startStatusPolling('ET-TEST-1');
    await state.intervals[0].fn();
    assert.ok(state.logged.some((l) => /403/.test(l)),
      `expected a line naming the 403, got: ${JSON.stringify(state.logged)}`);
  });

  /* --- the other direction: transient failures must NOT stop the poll ------ */
  [
    ['a timeout', timedOut],
    ['a dropped connection', () => new Error('Could not connect to the server.')],
    ['a 500', serverError],
  ].forEach(([label, make]) => {
    check(`${label} does NOT stop the poll`, async () => {
      const { page, state } = loadPage(make);
      page.startStatusPolling('ET-TEST-1');
      await state.intervals[0].fn();
      assert.strictEqual(page.isPolling(), true,
        'a transient failure froze the customer tracker');
      const before = state.apiCalls;
      await state.intervals[0].fn();
      assert.ok(state.apiCalls > before, 'polling stopped instead of retrying');
    });
  });

  check('restarting the poll does not leave the old timer running', () => {
    const { page, state } = loadPage(forbidden);
    page.startStatusPolling('ET-TEST-1');
    const clearedBefore = state.cleared;
    page.startStatusPolling('ET-TEST-1');
    assert.strictEqual(state.cleared, clearedBefore + 1,
      'the previous timer was not cleared before a new one was scheduled');
    assert.strictEqual(state.intervals.length, 2, 'a second timer should have been scheduled');
    assert.strictEqual(page.isPolling(), true);
  });

  await Promise.all(pendingChecks);

  console.log('');
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });