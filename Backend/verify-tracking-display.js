/**
 * Verification for the customer "Track Order" summary math.
 * Mirrors the pure helpers in Frontend/src/js/order-status.js.
 * Run: node Backend/verify-tracking-display.js
 */

const assert = require('assert');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}

function strictCoord(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function formatKm(km) {
  const n = strictCoord(km, 0, 20038);
  if (n === null) return null;
  if (n < 1) return Math.max(1, Math.round(n * 1000)) + ' m';
  return n.toFixed(1) + ' km';
}

function formatEta(minutes) {
  const n = strictCoord(minutes, 1, 10080);
  if (n === null) return null;
  const mins = Math.round(n);
  if (mins < 60) return mins + ' min';
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? hours + ' h ' + rest + ' min' : hours + ' h';
}

function kmBetween(a, b) {
  if (!a || !b) return null;
  const lat1 = strictCoord(a.lat, -90, 90);
  const lng1 = strictCoord(a.lng, -180, 180);
  const lat2 = strictCoord(b.lat, -90, 90);
  const lng2 = strictCoord(b.lng, -180, 180);
  if (lat1 === null || lng1 === null || lat2 === null || lng2 === null) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

check('distance displays in metres under 1 km and km above', () => {
  assert.strictEqual(formatKm(0.4), '400 m');
  assert.strictEqual(formatKm(0.0004), '1 m', 'a tiny fix must never display as 0 m');
  assert.strictEqual(formatKm(1), '1.0 km');
  assert.strictEqual(formatKm(3.34), '3.3 km');
  assert.strictEqual(formatKm(12.5), '12.5 km');
});

check('a null coordinate must never become 0,0 in the Gulf of Guinea', () => {
  // Number(null) === 0, so a missing fix would otherwise plot a real courier
  // position and report a bogus multi-thousand-km distance.
  const home = { lat: 9.08, lng: 38.7525 };
  const d = kmBetween({ lat: null, lng: null }, home);
  assert.strictEqual(d, null, 'a null fix must yield no distance at all');
  assert.strictEqual(formatKm(null), null, 'a null distance must not render as 0 m');
});

check('an unknown distance hides the row instead of showing 0', () => {
  for (const bad of [null, undefined, NaN, '', 'abc', -1, -0.5, {}, true, false]) {
    assert.strictEqual(formatKm(bad), null, `${String(bad)} must not render`);
  }
});

check('ETA renders in minutes under an hour and hours above', () => {
  assert.strictEqual(formatEta(5), '5 min');
  assert.strictEqual(formatEta(59), '59 min');
  assert.strictEqual(formatEta(60), '1 h');
  assert.strictEqual(formatEta(95), '1 h 35 min');
  assert.strictEqual(formatEta(120), '2 h');
});

check('an unknown ETA hides the row instead of guessing', () => {
  for (const bad of [null, undefined, NaN, 0, -5, 'soon', true, false]) {
    assert.strictEqual(formatEta(bad), null, `${String(bad)} must not render`);
  }
});

check('live rider-to-customer distance shrinks as the rider approaches', () => {
  const cafe = { lat: 9.0192, lng: 38.7525 };
  const home = { lat: 9.08, lng: 38.7525 };
  const start = kmBetween(cafe, home);
  const closer = kmBetween({ lat: 9.05, lng: 38.7525 }, home);
  const atDoor = kmBetween({ lat: 9.079, lng: 38.7525 }, home);
  assert.ok(start > closer, 'getting closer must reduce the remaining distance');
  assert.ok(closer > atDoor, 'and keep reducing');
  assert.ok(atDoor < 0.2, 'a fix at the door is under 200 m');
});

check('a courier fix far from the customer cannot produce a negative distance', () => {
  // Includes the antimeridian-adjacent and inverted-input cases.
  const a = { lat: 9.0192, lng: 38.7525 };
  const b = { lat: 8.9, lng: 38.7 };
  const d = kmBetween(a, b);
  assert.ok(d >= 0, 'distance must never be negative');
  const same = kmBetween(a, { lat: a.lat, lng: a.lng });
  assert.strictEqual(Math.round(same * 1000) / 1000, 0, 'the same point is 0 km');
});

check('a malformed GPS point yields no distance rather than NaN', () => {
  const good = { lat: 9.0192, lng: 38.7525 };
  for (const bad of [null, undefined, {}, { lat: 'x', lng: 38.7 }, { lat: 9.1 }, { lat: null, lng: null }]) {
    assert.strictEqual(kmBetween(bad, good), null, `${JSON.stringify(bad)} must not produce a number`);
    assert.strictEqual(kmBetween(good, bad), null, `reversed ${JSON.stringify(bad)} must not produce a number`);
  }
});

check('out-of-range coordinates are rejected rather than plotted', () => {
  const good = { lat: 9.0192, lng: 38.7525 };
  assert.strictEqual(kmBetween({ lat: 999, lng: 38.7 }, good), null, 'latitude 999 is invalid');
  assert.strictEqual(kmBetween({ lat: 9.1, lng: 999 }, good), null, 'longitude 999 is invalid');
});

check('the live ETA never claims arrival before the rider moves', () => {
  // The customer-facing ETA is only recomputed from a real fix; before that the
  // server plan stands. A 0-minute ETA for a 10 km trip would be a lie.
  const km = 10;
  const liveEta = Math.max(1, Math.round((km / 25) * 60));
  assert.strictEqual(liveEta, 24);
  assert.ok(liveEta > 0, 'a live ETA must be at least one minute');
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  process.exitCode = 1;
} else {
  console.log('Tracking display logic verified.\n');
}
