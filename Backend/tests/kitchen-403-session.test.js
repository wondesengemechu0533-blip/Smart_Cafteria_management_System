/**
 * Kitchen dashboard - a 403 must STOP the board, not be retried forever.
 *
 * WHAT BROKE: an account that is not a kitchen account (the database row's role
 * was `delivery`, not `kitchen`) opened the KDS. Every kitchen route answered 403
 * - correctly - and the page kept polling anyway:
 *
 *   kitchen.js Failed to refresh orders: Error: You do not have permission...
 *   ...repeating every 15s, forever...
 *
 * A 403 is a PERMANENT answer: the session is not (and will not become) a
 * kitchen session, so retrying cannot ever succeed. Worse, each retry is a real
 * round trip to Mongo on the same bandwidth-limited link that had already made
 * the first dashboard request time out - so the loop actively made the original
 * symptom worse.
 *
 * deliveries.js already guards this (abortForSessionChange on 403); the kitchen
 * board did not, and is the one page that polls every 15s.
 *
 * This loads the REAL KDS object out of kitchen.js and drives it against a
 * stubbed api that always answers 403, then asserts the page goes quiet.
 *
 * Run: node Backend/tests/kitchen-403-session.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const KITCHEN_JS = path.join(__dirname, '..', '..', 'Frontend', 'src', 'pages', 'kitchen', 'kitchen.js');

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
 * Pull the KDS object literal out of kitchen.js and evaluate it with `api` and
 * the timers stubbed, so the REAL page logic runs without a DOM or a server.
 */
function loadKds() {
  const src = fs.readFileSync(KITCHEN_JS, 'utf8');
  const start = src.indexOf('const KDS = {');
  assert.notStrictEqual(start, -1, 'could not find the KDS object in kitchen.js');
  const body = src.slice(start).replace(/^\s*window\.KDS = KDS;?/m, '');

  const state = { apiCalls: 0, intervals: [], cleared: 0, redirected: '' };

  const window = { location: { href: '' }, addEventListener() {} };
  const api = {
    get() {
      state.apiCalls++;
      const err = new Error('You do not have permission to perform this action.');
      err.status = 403;
      return Promise.reject(err);
    },
  };

  const KDS = new Function(
    'api', 'tr', 'setInterval', 'clearInterval', 'console', 'localStorage', 'window',
    body + '\nreturn KDS;'
  )(
    api,
    (key, fallback) => fallback,
    (fn, ms) => { state.intervals.push({ fn, ms }); return state.intervals.length; },
    () => { state.cleared++; },
    { log() {}, warn() {}, error() {} },
    { getItem: () => 'token' },
    window
  );

  // abortForSessionChange() navigates; record it instead of touching the DOM.
  return { KDS, state, window };
}

(async () => {
  console.log('========== KITCHEN DASHBOARD - 403 STOPS THE BOARD ==========');
  console.log('');

  const { KDS, state, window } = loadKds();
  const kds = KDS;

  kds.startPolling();
  kds.startNotificationPolling();
  kds.startTimer();

  check('the board starts three timers (poll, notifications, ticket clock)', () =>
    assert.strictEqual(state.intervals.length, 3));

  await kds.loadInitialOrders();

  check('a 403 latches the session as no longer valid', () =>
    assert.strictEqual(kds.sessionAborted, true));

  check('every timer is cleared, so nothing keeps calling the API', () =>
    assert.strictEqual(state.cleared, 3, `only ${state.cleared} of 3 timers were cleared`));

  const callsAfterAbort = state.apiCalls;

  check('refreshOrders() makes no further requests once aborted', async () => {
    await kds.refreshOrders();
    assert.strictEqual(state.apiCalls, callsAfterAbort,
      `refreshOrders() issued ${state.apiCalls - callsAfterAbort} more call(s) after the 403`);
  });

  check('a poll tick that was already queued makes no further requests', () => {
    // Even if a timer callback fires after the abort (clearInterval races an
    // in-flight tick), it must not reach the network.
    state.intervals.forEach((t) => t.fn());
    assert.strictEqual(state.apiCalls, callsAfterAbort,
      'a queued tick still hit the API after the session was aborted');
  });

  check('the tab is sent back to login so the user can pick a kitchen account', () =>
    assert.ok(/login\.html$/.test(window.location.href),
      `expected a redirect to login.html, got "${window.location.href}"`));

  /* --- the bug this guards: a NON-403 failure must still retry -------------- */
  {
    // Regression guard in the OTHER direction: a timeout or a dropped connection
    // is transient and the board MUST keep polling, or a momentary network blip
    // would log the kitchen out of its own screen.
    const src = fs.readFileSync(KITCHEN_JS, 'utf8');

    check('a 401 also aborts the session (missing/expired/invalid token)', () =>
      assert.strictEqual(
        kds.handleSessionError(Object.assign(new Error('Authentication required'), { status: 401 })),
        true,
        'a 401 did not stop the board, so it kept polling with a rejected token'
      ));

    check('a timeout does not abort the session', () =>
      assert.strictEqual(kds.handleSessionError(new Error('Request timed out.')), false,
        'a transient timeout was treated as a permanent 403 and stopped the board'));

    check('a dropped connection does not abort the session', () =>
      assert.strictEqual(
        kds.handleSessionError(Object.assign(new Error('Could not connect to the server.'), {
          status: undefined,
        })),
        false,
        'a network failure was treated as a permanent 403'
      ));

    check('a 500 does not abort the session', () =>
      assert.strictEqual(
        kds.handleSessionError(Object.assign(new Error('Server error'), { status: 500 })),
        false,
        'a server error was treated as a permanent 403'
      ));

    check('the 403/401 handler is keyed on status, not on the message text', () => {
      // Guards against someone "fixing" this later by string-matching the
      // English message, which breaks the moment the copy is translated.
      assert.ok(/error\.status/.test(src),
        'the session guard no longer reads error.status');
      assert.ok(/status === 401/.test(src) && /status === 403/.test(src),
        'the session guard no longer handles both 401 and 403');
    });
  }

  await Promise.all(pendingChecks);

  console.log('');
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });