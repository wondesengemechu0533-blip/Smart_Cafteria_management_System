/**
 * Reporting period boundaries - the "September 30 - October 30" bug.
 *
 * WHY this test exists:
 *
 *   The reports page showed a period of "September 30 - October 30, 2026" even
 *   though the report was generated on October 22, 2026. The cause was the
 *   date formatting, not the query: `Date#toISOString()` renders an instant in
 *   UTC, and a reporting-local midnight of 2026-10-01 in Africa/Addis_Ababa
 *   (UTC+03:00) is 2026-09-30T21:00Z. Both ends of the range were therefore
 *   reported one day early.
 *
 *   The periods themselves were wrong too: "This Month" used to run to the end
 *   of the month instead of ending on the current date.
 *
 * This test pins down every period in the reporting timezone:
 *   today      -> the current day
 *   yesterday  -> the previous day
 *   last7      -> today and the 6 days before it
 *   last30     -> today and the 29 days before it
 *   month      -> the 1st of the month through today
 *   custom     -> exactly the selected days
 *
 * Run: node tests/report-period-range.test.js
 */
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scs_report_period';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'report-period-secret';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const {
  resolveRange,
  previousRange,
  formatRange,
  eachDay,
  REPORT_TIMEZONE,
} = require('../src/utils/reportRange');

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

// The reference moment used by the task: October 22, 2026, 10:00 in
// Africa/Addis_Ababa (07:00 UTC).
const NOW = new Date('2026-10-22T10:00:00+03:00');

console.log('\nA. Period boundaries (Africa/Addis_Ababa)');

check('the reporting timezone is Africa/Addis_Ababa', () => {
  assert.strictEqual(REPORT_TIMEZONE, 'Africa/Addis_Ababa');
});

check('today covers exactly the current day', () => {
  const range = resolveRange({ period: 'today', now: NOW });
  assert.deepStrictEqual(formatRange(range), { startDate: '2026-10-22', endDate: '2026-10-22' });
});

check('yesterday covers exactly the previous day', () => {
  const range = resolveRange({ period: 'yesterday', now: NOW });
  assert.deepStrictEqual(formatRange(range), { startDate: '2026-10-21', endDate: '2026-10-21' });
});

check('last7 covers seven days ending today', () => {
  const range = resolveRange({ period: 'last7', now: NOW });
  assert.deepStrictEqual(formatRange(range), { startDate: '2026-10-16', endDate: '2026-10-22' });
  assert.strictEqual(eachDay(range).length, 7);
});

check('last30 covers thirty days ending today', () => {
  const range = resolveRange({ period: 'last30', now: NOW });
  assert.deepStrictEqual(formatRange(range), { startDate: '2026-09-23', endDate: '2026-10-22' });
  assert.strictEqual(eachDay(range).length, 30);
});

check('this month starts on the 1st and ends on the current date', () => {
  const range = resolveRange({ period: 'month', now: NOW });
  assert.deepStrictEqual(formatRange(range), { startDate: '2026-10-01', endDate: '2026-10-22' });
  assert.strictEqual(eachDay(range).length, 22);
});

check('this month is NOT reported as September 30 - October 30 (regression)', () => {
  const range = resolveRange({ period: 'month', now: NOW });
  const shown = formatRange(range);
  assert.notStrictEqual(shown.startDate, '2026-09-30', 'start date must not slip back a day');
  assert.notStrictEqual(shown.endDate, '2026-10-30', 'end date must not slip forward a day');
  assert.notStrictEqual(
    shown.startDate + ' to ' + shown.endDate,
    '2026-09-30 to 2026-10-30',
    'the old, wrong range must not come back'
  );
});

check('a custom range respects the selected start and end dates', () => {
  const range = resolveRange({
    period: 'custom',
    startDate: '2026-09-30',
    endDate: '2026-10-30',
    now: NOW,
  });
  assert.deepStrictEqual(formatRange(range), { startDate: '2026-09-30', endDate: '2026-10-30' });
});

check('a custom range includes both boundary days', () => {
  const range = resolveRange({
    period: 'custom',
    startDate: '2026-10-01',
    endDate: '2026-10-03',
    now: NOW,
  });
  assert.deepStrictEqual(eachDay(range), ['2026-10-01', '2026-10-02', '2026-10-03']);
});

check('the boundaries are reporting-local midnights', () => {
  const range = resolveRange({ period: 'today', now: NOW });
  // Local midnight of 2026-10-22 in UTC+03:00 is 2026-10-21T21:00:00Z.
  assert.strictEqual(range.start.toISOString(), '2026-10-21T21:00:00.000Z');
  assert.strictEqual(range.end.toISOString(), '2026-10-22T21:00:00.000Z');
});

check('an invalid period is rejected', () => {
  assert.throws(() => resolveRange({ period: 'last-year', now: NOW }), /Invalid period/);
});

check('an impossible calendar date is rejected', () => {
  assert.throws(
    () => resolveRange({ period: 'custom', startDate: '2026-02-31', endDate: '2026-03-05', now: NOW }),
    /valid date/
  );
});

check('a custom range without both dates is rejected', () => {
  assert.throws(() => resolveRange({ period: 'custom', startDate: '2026-10-01', now: NOW }), /requires both/);
});

check('a reversed custom range is rejected', () => {
  assert.throws(
    () => resolveRange({ period: 'custom', startDate: '2026-10-10', endDate: '2026-10-01', now: NOW }),
    /before or equal/
  );
});

console.log('\nB. Previous period (period-over-period comparison)');

check('the previous 7-day window ends where the current one starts', () => {
  const current = resolveRange({ period: 'last7', now: NOW });
  const previous = previousRange(current);
  assert.deepStrictEqual(formatRange(previous), { startDate: '2026-10-09', endDate: '2026-10-15' });
});

check('the previous 30-day window ends where the current one starts', () => {
  const current = resolveRange({ period: 'last30', now: NOW });
  const previous = previousRange(current);
  assert.deepStrictEqual(formatRange(previous), { startDate: '2026-08-24', endDate: '2026-09-22' });
});

check('the previous month compares against the same stretch of the previous month', () => {
  const current = resolveRange({ period: 'month', now: NOW });
  const previous = previousRange(current);
  assert.deepStrictEqual(formatRange(previous), { startDate: '2026-09-01', endDate: '2026-09-22' });
});

check('yesterday compares against the day before yesterday', () => {
  const current = resolveRange({ period: 'yesterday', now: NOW });
  const previous = previousRange(current);
  assert.deepStrictEqual(formatRange(previous), { startDate: '2026-10-20', endDate: '2026-10-20' });
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed: ' + failures.join(', '));
process.exit(failures.length ? 1 : 0);
