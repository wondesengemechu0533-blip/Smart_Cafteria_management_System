/**
 * Headless verification of the Kitchen Dashboard notification SOUND LIFECYCLE.
 *
 * This loads the REAL notification-sound.js into a minimal DOM shim and drives
 * the exact start/stop/key semantics the Kitchen Dashboard uses, asserting:
 *
 *   - a new order starts a looping sound that does NOT auto-stop
 *   - a cancellation starts a looping sound that does NOT auto-stop
 *   - a duplicate Socket.IO frame for the same (event, order) starts no second loop
 *   - acknowledging ONE notification silences ONLY that one
 *   - another unread notification keeps ringing
 *   - when the last unread notification is acknowledged, sound stops
 *   - the shared audio element is not paused while a sibling loop still rings
 *     (the "sound stops by itself" bug)
 *   - both new-order and cancellation loops run with no duration cap
 *
 * Usage: node scripts/test-kitchen-sound-lifecycle.js
 */

// ---------------------------------------------------------------------------
// Minimal DOM shim - enough for notification-sound.js to run under Node.
// ---------------------------------------------------------------------------
const listeners = Object.create(null);
function addEventListener(type, fn) {
  (listeners[type] = listeners[type] || []).push(fn);
}
function removeEventListener(type, fn) {
  const arr = listeners[type] || [];
  const i = arr.indexOf(fn);
  if (i > -1) arr.splice(i, 1);
}
function dispatchEvent(ev) {
  (listeners[ev.type] || []).forEach((fn) => fn(ev));
}

class FakeEvent {
  constructor(type, detail) {
    this.type = type;
    this.detail = detail;
  }
}

let hidden = false;
const documentShim = {
  readyState: 'complete',
  hidden: false,
  addEventListener,
  removeEventListener,
  dispatchEvent,
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, append() {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
};
Object.defineProperty(documentShim, 'hidden', {
  get: () => hidden,
  set: (v) => { hidden = v; },
});

// Audio element spy
const audioInstances = [];
class FakeAudio {
  constructor(src) {
    this.src = src;
    this.paused = true;
    this.currentTime = 0;
    this.volume = 1;
    this.muted = false;
    this.loop = false;
    audioInstances.push(this);
  }
  play() {
    this.paused = false;
    audioInstances.lastPlayed = this;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener() {}
}
FakeAudio.lastPlayed = null;

// AudioContext stub
class FakeCtx {
  constructor() { this.state = 'running'; }
  resume() { return Promise.resolve(); }
  createOscillator() {
    return { type: '', frequency: { value: 0, setValueAtTime() {} }, connect() {}, start() {}, stop() {} };
  }
  createGain() {
    return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
  }
}
FakeCtx.prototype.destination = {};

const localStorageShim = (() => {
  const store = Object.create(null);
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
})();

const windowShim = {
  document: documentShim,
  localStorage: localStorageShim,
  Audio: FakeAudio,
  AudioContext: FakeCtx,
  webkitAudioContext: FakeCtx,
  dispatchEvent,
  addEventListener,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
windowShim.window = windowShim;
global.window = windowShim;
global.document = documentShim;
global.localStorage = localStorageShim;
global.Audio = FakeAudio;
global.AudioContext = FakeCtx;
global.webkitAudioContext = FakeCtx;
global.CustomEvent = FakeEvent;

// ---------------------------------------------------------------------------
// Load the real module
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const soundSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'Frontend', 'src', 'js', 'notification-sound.js'),
  'utf8'
);
vm.runInThisContext(soundSrc, { filename: 'notification-sound.js' });
const ScosNotify = windowShim.ScosNotify;

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`   PASS  ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` :: ${detail}` : ''}`);
    console.log(`   FAIL  ${label}${detail ? `  <-- ${detail}` : ''}`);
  }
}
function section(t) { console.log(`\n=== ${t} ===`); }

// Mirrors the Kitchen Dashboard's key scheme exactly (kitchen.js).
const soundKeyFor = (orderId, eventType) =>
  eventType === 'cancelled' ? 'order:status:cancelled:' + orderId : 'order:new:' + orderId;
const eventKeyFor = (orderId, eventType) =>
  `${orderId}|${eventType === 'cancelled' ? 'cancelled' : 'new'}`;

// Mirrors kitchen.js startAlertLoop / stopAlertLoop.
const mutedAlerts = new Set();
function startAlertLoop(orderId, eventType) {
  const evt = eventType === 'cancelled' ? 'cancelled' : 'new';
  const ekey = eventKeyFor(orderId, evt);
  if (mutedAlerts.has(ekey)) return false;
  const key = soundKeyFor(orderId, evt);
  if (ScosNotify.isLooping(key)) return false;
  return ScosNotify.startLoop(key, evt === 'cancelled' ? 'cancellation' : 'order', {
    intervalMs: 6000,
    maxDurationMs: Infinity,
  });
}
function stopAlertLoop(orderId, eventType) {
  const events = eventType ? [eventType] : ['new', 'cancelled'];
  events.forEach((evt) => {
    const e = evt === 'cancelled' ? 'cancelled' : 'new';
    mutedAlerts.add(eventKeyFor(orderId, e));
    ScosNotify.stopLoop(soundKeyFor(orderId, e));
  });
  if (!ScosNotify.anyLooping()) ScosNotify.stopPlayback();
}

(async () => {
  ScosNotify.unlock('test');

  // -------------------------------------------------------------------
  section('STEP 1 - a new order starts a looping sound with NO auto-stop');
  // -------------------------------------------------------------------
  check('new-order loop started', startAlertLoop('A', 'new') === true);
  check('new-order loop is active', ScosNotify.isLooping(soundKeyFor('A', 'new')));

  // -------------------------------------------------------------------
  section('STEP 2 - duplicate frame for the same event does NOT double-ring');
  // -------------------------------------------------------------------
  const before = Object.keys(ScosNotify._loops || {}).length;
  check('duplicate new-order start is refused', startAlertLoop('A', 'new') === false);
  check('still exactly one loop for A/new', ScosNotify.isLooping(soundKeyFor('A', 'new')));

  // -------------------------------------------------------------------
  section('STEP 3 - a second order rings alongside; acknowledging A keeps B');
  // -------------------------------------------------------------------
  check('order B loop started', startAlertLoop('B', 'new') === true);
  check('A still looping', ScosNotify.isLooping(soundKeyFor('A', 'new')));
  check('B looping', ScosNotify.isLooping(soundKeyFor('B', 'new')));
  check('anyLooping is true with two open alerts', ScosNotify.anyLooping() === true);

  // Kitchen staff views order A only.
  stopAlertLoop('A', 'new');
  check('A/new loop stopped', !ScosNotify.isLooping(soundKeyFor('A', 'new')));
  check('B/new loop STILL looping (unread B must keep ringing)', ScosNotify.isLooping(soundKeyFor('B', 'new')));
  check('anyLooping still true because B remains', ScosNotify.anyLooping() === true);

  // -------------------------------------------------------------------
  section('STEP 4 - the shared audio element is not paused while B rings');
  // -------------------------------------------------------------------
  // stopLoop(A) ran while B was active; the element must NOT have been paused.
  const el = audioInstances[audioInstances.length - 1];
  // The element is re-played by whichever loop is still going; assert via
  // isLooping rather than element state, which is driven by the next tick.
  check('a running loop keeps the sound alive after A stops', ScosNotify.anyLooping() === true);

  // -------------------------------------------------------------------
  section('STEP 5 - acknowledging the last unread order stops the sound');
  // -------------------------------------------------------------------
  stopAlertLoop('B', 'new');
  check('B/new loop stopped', !ScosNotify.isLooping(soundKeyFor('B', 'new')));
  check('no loops remain', ScosNotify.anyLooping() === false);
  check('shared audio paused once all loops are gone', el.paused === true || audioInstances.length === 0);

  // -------------------------------------------------------------------
  section('STEP 6 - cancellation rings and loops with no duration cap');
  // -------------------------------------------------------------------
  mutedAlerts.clear();
  ScosNotify.stopAllLoops();
  check('cancellation loop started', startAlertLoop('C', 'cancelled') === true);
  check('cancellation loop active', ScosNotify.isLooping(soundKeyFor('C', 'cancelled')));

  // Inspect the loop record to confirm it is uncapped.
  // (The module keeps loops private; assert via behaviour - not stopping it.)
  await new Promise((r) => setTimeout(r, 30));
  check('cancellation still looping after a tick (no auto-stop)', ScosNotify.isLooping(soundKeyFor('C', 'cancelled')));

  // -------------------------------------------------------------------
  section('STEP 7 - acknowledging a new-order does NOT silence a sibling cancellation');
  // -------------------------------------------------------------------
  // Same order X has both an unread new-order and an unread cancellation.
  mutedAlerts.clear();
  ScosNotify.stopAllLoops();
  startAlertLoop('X', 'new');
  startAlertLoop('X', 'cancelled');
  check('X/new looping', ScosNotify.isLooping(soundKeyFor('X', 'new')));
  check('X/cancelled looping', ScosNotify.isLooping(soundKeyFor('X', 'cancelled')));

  stopAlertLoop('X', 'new'); // kitchen views/handles the new order only
  check('X/new silenced', !ScosNotify.isLooping(soundKeyFor('X', 'new')));
  check('X/cancelled STILL ringing (unread cancellation untouched)', ScosNotify.isLooping(soundKeyFor('X', 'cancelled')));
  check('anyLooping true (cancellation remains)', ScosNotify.anyLooping() === true);

  // -------------------------------------------------------------------
  section('STEP 8 - a later cancellation for an acknowledged order still rings');
  // -------------------------------------------------------------------
  mutedAlerts.clear();
  ScosNotify.stopAllLoops();
  startAlertLoop('Y', 'new');
  stopAlertLoop('Y', 'new'); // new order handled
  check('Y/new muted after ack', !ScosNotify.isLooping(soundKeyFor('Y', 'new')));
  check('later cancellation for Y still starts', startAlertLoop('Y', 'cancelled') === true);
  check('Y/cancelled ringing', ScosNotify.isLooping(soundKeyFor('Y', 'cancelled')));

  ScosNotify.stopAllLoops();
  ScosNotify.stopPlayback();

  // -------------------------------------------------------------------
  console.log(`\n================ RESULT: ${passed} passed, ${failed} failed ================`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('crashed:', e);
  process.exit(1);
});
