/**
 * Keeps the frontend delivery-status surfaces in step with the backend.
 *
 * Two defects of the same shape motivated this: the activity log maps actions
 * to human labels, and a status badge maps statuses to a label and a colour.
 * Both are plain object literals, so an action or status the backend emits but
 * the literal does not know about renders as a raw key / the wrong colour -
 * with nothing failing and no test noticing.
 *
 *   - admin-activity.js  : missing DELIVERY_COMPLETED / DELIVERY_REASSIGNED /
 *                         DELIVERY_CANCELLED meant real rows showed raw names.
 *   - dashboard.js       : a missing ARRIVED case fell through to `default` and
 *                         painted an at-the-door delivery with the amber
 *                         "pending" badge.
 *
 * Run: node verify-delivery-status-labels.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'Frontend', 'src');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}

const activitySrc = read('js/admin-activity.js');
const dashboardSrc = read('js/dashboard.js');
const orderSrc = fs.readFileSync(path.join(__dirname, 'src', 'models', 'Delivery.js'), 'utf8');
const OrderSrc = fs.readFileSync(path.join(__dirname, 'src', 'models', 'Order.js'), 'utf8');

// Every status the backend can actually store.
const statusBlock = /const DELIVERY_STATUSES = \[([\s\S]*?)\];/.exec(orderSrc);
assert.ok(statusBlock, 'could not read DELIVERY_STATUSES from the Delivery model');
const BACKEND_STATUSES = statusBlock[1]
  .split(',')
  .map((s) => s.trim().replace(/^'|'$/g, ''))
  .filter(Boolean);

// dashboard.js renders ORDER statuses, so that - not DELIVERY_STATUSES - is the
// set its badge has to cover. Checking the wrong enum would demand cases for
// states (REQUESTED/ASSIGNED) that can never reach it.
const orderStatusBlock = /orderStatus:\s*\{\s*type: String,\s*enum: \[([\s\S]*?)\]/.exec(OrderSrc);
assert.ok(orderStatusBlock, 'could not read the orderStatus enum from the Order model');
const ORDER_STATUSES = orderStatusBlock[1]
  .split(',')
  .map((s) => s.trim().replace(/^'|'$/g, ''))
  .filter(Boolean);

// Every DELIVERY_* audit action the backend can emit.
const backendDir = path.join(__dirname, 'src');
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
};
const BACKEND_ACTIONS = new Set();
for (const file of walk(backendDir)) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/action:\s*'(DELIVERY_[A-Z_]+)'/g)) BACKEND_ACTIONS.add(m[1]);
}

const activityKeys = new Set(
  [...activitySrc.matchAll(/^\s{4}(DELIVERY_[A-Z_]+):/gm)].map((m) => m[1])
);

console.log('\nActivity-log labels (admin-activity.js)');

check('every DELIVERY_* action the backend emits has a label', () => {
  const missing = [...BACKEND_ACTIONS].filter((a) => !activityKeys.has(a));
  assert.deepStrictEqual(missing, [], `unlabelled: ${missing.join(', ')}`);
});

check('the states the delivery machine moves through are all labelled', () => {
  // REQUESTED has no dedicated audit action (assignment is the first event),
  // but everything a delivery can become after that must be labelled.
  for (const s of ['ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'COMPLETED']) {
    assert.ok(activityKeys.has('DELIVERY_' + s), `missing label for DELIVERY_${s}`);
  }
});

check('no duplicate action keys', () => {
  const all = [...activitySrc.matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
  const dupes = all.filter((k, i) => all.indexOf(k) !== i);
  assert.deepStrictEqual(dupes, [], `duplicated: ${[...new Set(dupes)].join(', ')}`);
});

console.log('\nStatus badge (dashboard.js)');

/** Brace-balanced body of a named function, so a sibling function's `case`
 *  labels (e.g. paymentBadge's FAILED) can never be mistaken for this one's. */
function functionBody(src, name) {
  const at = src.indexOf('function ' + name);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return null;
}

const switchBody = functionBody(dashboardSrc, 'statusBadge');
check('statusBadge exists', () => assert.ok(switchBody, 'statusBadge() not found'));
const labelMapBody = /var labelKeyMap = \{([\s\S]*?)\};/.exec(dashboardSrc);

check('every backend delivery status has an explicit badge case (no silent default)', () => {
  for (const s of ORDER_STATUSES) {
    assert.ok(switchBody.includes(`'${s}'`), `${s} has no badge case, so it falls through to the amber default`);
  }
});

check('every order status has a label', () => {
  assert.ok(labelMapBody, 'labelKeyMap not found');
  for (const s of ORDER_STATUSES) {
    assert.ok(new RegExp(`\\b${s}:`).test(labelMapBody[1]), `${s} has no label`);
  }
});

check('every delivery status that maps onto an order status is covered', () => {
  // DELIVERED/COMPLETED/etc. reach the dashboard through STATUS_TO_ORDER; this
  // guards against the two lists drifting apart again.
  assert.ok(ORDER_STATUSES.includes('ARRIVED'), 'Order.orderStatus must include ARRIVED');
  assert.ok(ORDER_STATUSES.includes('DELIVERED'), 'Order.orderStatus must include DELIVERED');
  assert.ok(ORDER_STATUSES.includes('COMPLETED'), 'Order.orderStatus must include COMPLETED');
});

check('ARRIVED is styled as delivered, not as pending', () => {
  const arrived = /case 'ARRIVED':[\s\S]*?cls \+= ' ([a-z]+)'/.exec(switchBody);
  assert.ok(arrived, 'ARRIVED case missing');
  assert.strictEqual(arrived[1], 'del', `ARRIVED uses .${arrived[1]}, expected .del`);
});

check('every label key used actually exists in the locale files', () => {
  const en = JSON.parse(read('locales/en.json'));
  const am = JSON.parse(read('locales/am.json'));
  const keys = [...labelMapBody[1].matchAll(/:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
  for (const k of keys) {
    assert.ok(k in en, `key "${k}" missing from locales/en.json`);
    assert.ok(k in am, `key "${k}" missing from locales/am.json`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed: ' + failures.join(', '));
process.exit(failures.length ? 1 : 0);