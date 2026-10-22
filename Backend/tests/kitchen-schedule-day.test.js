/**
 * Kitchen Preparation Schedule - "Current Shift" must show the whole day.
 *
 * WHY this exists: getCurrentShift() was a bare
 *     KitchenShift.findOne({ staffId, status: { $in: ['scheduled','active'] } })
 * with NO SORT. An unsorted findOne returns whichever document the engine
 * reaches first, and every cook is scheduled a morning, an afternoon AND an
 * evening shift each day - so the card rendered one arbitrary row out of ~21.
 * In this deployment it consistently came back as `evening`, which is why the
 * kitchen saw only the evening shift and concluded morning/afternoon were
 * missing. The rows were always in the database; nothing selected them.
 *
 * The second half asserts the day list is scoped to the CALLER:
 * /kitchen-staff/shifts returns every cook's shifts, so resolving the day
 * client-side produced four copies of each shift.
 *
 * Run: node Backend/tests/kitchen-schedule-day.test.js
 */
const assert = require('assert');
const Module = require('module');

let pass = 0;
let fail = 0;
const pendingChecks = [];
function check(name, fn) {
  pendingChecks.push((async () => {
    try { await fn(); pass++; console.log('  PASS ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + ' -- ' + e.message); }
  })());
}

const STAFF_ID = 'chef-1';

/**
 * A KitchenShift stub that answers each of the controller's ladder queries from
 * a scripted queue, and records the filter/sort of every call so the test can
 * assert that NO query is an unsorted findOne.
 */
function loadController(script) {
  const originalLoad = Module._load;
  const calls = [];

  // findOne resolves a DOCUMENT or null - never an array. Returning [] there
  // is truthy, which is what made an "empty roster" look like a real shift made
  // entirely of undefined fields.
  const makeChain = (kind) => {
    const c = {
      _kind: kind,
      sort(spec) { c._sort = spec; return c; },
      populate() { return c; },
      lean() { return c; },
      then(resolve, reject) {
        const hit = script.find((r) => r.match(c._filter));
        const rows = hit ? hit.rows : [];
        calls.push({ kind, filter: c._filter, sort: c._sort });
        return Promise.resolve(kind === 'findOne' ? (rows[0] || null) : rows).then(resolve, reject);
      },
      catch(reject) { return Promise.reject(reject); },
    };
    return c;
  };

  const stubs = {
    '../models/KitchenShift': {
      findOne(filter) { const c = makeChain('findOne'); c._filter = filter; return c; },
      find(filter) { const c = makeChain('find'); c._filter = filter; return c; },
    },
  };

  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalLoad.apply(this, arguments);
  };
  const p = require.resolve('../src/controllers/kitchen-staff.controller.js');
  delete require.cache[p];
  let controller;
  try { controller = require(p); }
  finally { Module._load = originalLoad; }
  return { controller, calls };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const shift = (type, startHour, over) => Object.assign({
  _id: `id-${type}`,
  staffId: { _id: STAFF_ID, name: 'Cook' },
  shiftType: type,
  startTime: new Date(2026, 8, 26, startHour, 0, 0),
  endTime: new Date(2026, 8, 26, startHour + 4, 0, 0),
  status: 'scheduled',
  clockInTime: null,
  clockOutTime: null,
}, over || {});

// The in-progress window query matches { startTime: { $lte }, $or:[...] }
const IN_PROGRESS = (f) => f && f.$or && f.$lte_check !== false && String(f.startTime && f.startTime.$lte) === 'lte';

(async () => {
  console.log('========== KITCHEN SCHEDULE - CURRENT SHIFT SHOWS THE DAY ==========');
  console.log('');

  const day = [
    shift('evening', 16),
    shift('morning', 8),
    shift('afternoon', 12),
  ];

  // Script each ladder rung by matching the shape of its filter.
  const script = [
    { match: (f) => f && f.clockInTime, rows: [] },                       // clocked-in
    { match: (f) => f && f.$or && f.startTime && f.startTime.$lte, rows: [day[0]] }, // in progress
    { match: (f) => f && f.startTime && f.startTime.$gt, rows: [] },       // next
    { match: (f) => f && !f.startTime && !f.status, rows: [] },           // last (no time filter)
    { match: () => true, rows: day },                                     // day list
  ];

  const { controller, calls } = loadController(script);
  const res = fakeRes();
  await controller.getCurrentShift({ user: { id: STAFF_ID } }, res);

  check('responds with the shift and the day', () => {
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.shift, 'no shift returned');
    assert.ok(Array.isArray(res.body.dayShifts), 'dayShifts missing');
  });

  check('ALL THREE shift types are returned for the day', () => {
    const types = res.body.dayShifts.map((s) => s.shiftType);
    ['morning', 'afternoon', 'evening'].forEach((t) =>
      assert.ok(types.includes(t), `${t} is missing from ${JSON.stringify(types)}`));
  });

  check('the day is ordered morning -> afternoon -> evening', () => {
    assert.deepStrictEqual(res.body.dayShifts.map((s) => s.shiftType),
      ['morning', 'afternoon', 'evening'],
      JSON.stringify(res.body.dayShifts.map((s) => s.shiftType)));
  });

  check('every findOne is explicitly sorted (never an unsorted findOne)', () => {
    // This is the original bug: an unsorted findOne returns an arbitrary row.
    // The day LIST is a find() sorted in JS, so it is not covered here.
    const unsorted = calls.filter((c) => c.kind === 'findOne' && c.sort === undefined);
    assert.strictEqual(unsorted.length, 0,
      `${unsorted.length} findOne query/queries had no .sort() - the page picks an arbitrary shift`);
  });

  check('the day list is scoped to the caller', () => {
    // The day query must filter by staffId, never return the whole roster.
    const dayCall = calls.find((c) => c.kind === 'find');
    assert.ok(dayCall, 'no day-list query was issued');
    assert.strictEqual(String(dayCall.filter.staffId), STAFF_ID,
      'the day list is not filtered to this cook');
  });

  check('the reason explains WHICH rung answered', () => {
    assert.ok(['clocked_in', 'in_progress', 'upcoming', 'last'].includes(res.body.reason),
      `unexpected reason: ${res.body.reason}`);
  });

  /* --- the payload must carry _id: the page builds its clock buttons from it - */
  check('every shift exposes _id for the Clock In button', () => {
    const bad = res.body.dayShifts.filter((s) => !s._id);
    assert.strictEqual(bad.length, 0,
      `${bad.length} shift(s) have no _id - the page would POST to /shifts/undefined/clock-in`);
  });

  check('the legacy id key is still present', () => {
    res.body.dayShifts.forEach((s) => {
      assert.strictEqual(String(s.id), String(s._id), 'id and _id disagree');
    });
  });

  /* --- no shift at all ------------------------------------------------------ */
  {
    const empty = loadController([{ match: () => true, rows: [] }]);
    const r2 = fakeRes();
    await empty.controller.getCurrentShift({ user: { id: STAFF_ID } }, r2);
    check('a cook with no shifts gets an empty day, not a crash', () => {
      assert.strictEqual(r2.body.shift, null);
      assert.deepStrictEqual(r2.body.dayShifts, []);
    });

    // "No shift" is a normal answer, not a missing resource. It used to be sent
    // as 404, which every client had to special-case and which made the browser
    // log a red network error on a perfectly healthy page.
    check('"no shift" is a 200 with a null shift, NOT a 404', () => {
      assert.strictEqual(r2.statusCode, 200,
        `"no shift" must answer 200 (got ${r2.statusCode}) - a 404 makes the browser log an error`);
      assert.strictEqual(r2.body.success, true);
      assert.strictEqual(r2.body.reason, 'none');
    });
  }

  await Promise.all(pendingChecks);
  void IN_PROGRESS;

  console.log('');
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });