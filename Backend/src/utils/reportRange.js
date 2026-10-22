const { HTTP_STATUS } = require('../config/constants');

const PERIODS = ['today', 'yesterday', 'last7', 'last30', 'last90', 'month', 'year', 'custom'];
const DAY_MS = 86400000;

/**
 * Reporting timezone.
 *
 * Ethiopia (Africa/Addis_Ababa / EAT) is a fixed UTC+03:00 offset and does not
 * observe daylight saving time, so every report boundary can be derived from a
 * constant offset instead of whatever timezone the host machine happens to be
 * configured with.
 *
 * WHY this matters (the bug this file exists to prevent):
 *   `Date#toISOString()` renders an instant in UTC. Local midnight of
 *   2026-10-01 in EAT is 2026-09-30T21:00Z, so a "This Month" period was
 *   reported as "September 30 - October 30" although it really covered
 *   October 1 - October 31. Formatting through the report offset instead of
 *   through UTC keeps the label and the underlying query on the same day.
 */
const REPORT_TIMEZONE = 'Africa/Addis_Ababa';
const TZ_OFFSET_MINUTES = 180;
const TZ_OFFSET_MS = TZ_OFFSET_MINUTES * 60 * 1000;

function isValidDate(value) {
  return value instanceof Date && !isNaN(value.getTime());
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = HTTP_STATUS.BAD_REQUEST;
  return error;
}

/**
 * The current instant shifted into reporting-local time.
 * Use the UTC getters on the result to read the local calendar fields.
 */
function zonedNow(now = new Date()) {
  return new Date(now.getTime() + TZ_OFFSET_MS);
}

/**
 * Midnight (reporting-local) of the day the given instant falls into.
 */
function startOfDay(date) {
  const shifted = Number(new Date(date).getTime()) + TZ_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - TZ_OFFSET_MS);
}

/**
 * Calendar date (YYYY-MM-DD) of the given instant in reporting-local time.
 */
function toISODate(date) {
  if (!isValidDate(date)) return null;
  return new Date(date.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Reporting-local midnight of the calendar date an instant belongs to.
 */
function startOfDayFor(date) {
  return startOfDay(date);
}

/**
 * Parse a YYYY-MM-DD (or full ISO) query param into reporting-local midnight.
 * Throws { message, statusCode: 400 } when the value is not a valid date.
 */
function parseDateParam(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);

  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day) - TZ_OFFSET_MS);
    // Reject impossible calendar dates (e.g. 2026-02-31) - Date.UTC would
    // silently roll them over into the next month.
    if (isNaN(date.getTime()) || toISODate(date) !== raw) {
      throw badRequest(`${fieldName} must be a valid date (YYYY-MM-DD)`);
    }
    return date;
  }

  const parsed = new Date(raw);
  if (!isValidDate(parsed)) {
    throw badRequest(`${fieldName} must be a valid date (YYYY-MM-DD)`);
  }
  return startOfDay(parsed);
}

/**
 * Resolve a report period into a half-open date range [start, end).
 *
 * The boundaries are always reporting-local days:
 *   today      -> today
 *   yesterday  -> yesterday
 *   last7      -> today and the 6 days before it
 *   last30     -> today and the 29 days before it
 *   month      -> the 1st of the current month through today
 *   custom     -> the selected start/end dates (both inclusive)
 *
 * `end` is exclusive - it is the first instant of the day AFTER the last
 * included day - so `$gte: start, $lt: end` selects exactly the intended days.
 *
 * @param {object}   options
 * @param {string}   [options.period]
 * @param {string}   [options.startDate] YYYY-MM-DD (custom only)
 * @param {string}   [options.endDate]   YYYY-MM-DD (custom only)
 * @param {Date}     [options.now]       Injectable clock (tests).
 */
function resolveRange({ period, startDate, endDate, now = new Date() } = {}) {
  const normalized = String(period || 'month').toLowerCase();

  if (!PERIODS.includes(normalized)) {
    throw badRequest(`Invalid period. Allowed: ${PERIODS.join(', ')}`);
  }

  const todayStart = startOfDay(now);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);

  switch (normalized) {
    case 'today':
      return { period: normalized, start: todayStart, end: tomorrowStart };

    case 'yesterday': {
      const start = new Date(todayStart.getTime() - DAY_MS);
      return { period: normalized, start, end: todayStart };
    }

    case 'last7': {
      const start = new Date(todayStart.getTime() - 6 * DAY_MS);
      return { period: normalized, start, end: tomorrowStart };
    }

    case 'last30': {
      const start = new Date(todayStart.getTime() - 29 * DAY_MS);
      return { period: normalized, start, end: tomorrowStart };
    }

    case 'last90': {
      const start = new Date(todayStart.getTime() - 89 * DAY_MS);
      return { period: normalized, start, end: tomorrowStart };
    }

    case 'month': {
      // First day of the current reporting month ... up to and including today.
      const local = zonedNow(now);
      const year = local.getUTCFullYear();
      const month = local.getUTCMonth();
      const start = new Date(Date.UTC(year, month, 1) - TZ_OFFSET_MS);
      return { period: normalized, start, end: tomorrowStart };
    }

    case 'year': {
      const local = zonedNow(now);
      const y = local.getUTCFullYear();
      const start = new Date(Date.UTC(y, 0, 1) - TZ_OFFSET_MS);
      return { period: normalized, start, end: tomorrowStart };
    }

    case 'custom': {
      const start = parseDateParam(startDate, 'startDate');
      const end = parseDateParam(endDate, 'endDate');
      if (!start || !end) {
        throw badRequest('Custom date range requires both startDate and endDate');
      }
      if (start.getTime() > end.getTime()) {
        throw badRequest('startDate must be before or equal to endDate');
      }
      return { period: normalized, start, end: new Date(end.getTime() + DAY_MS) };
    }

    default:
      throw badRequest('Invalid period');
  }
}

/**
 * The window immediately BEFORE the given range, used for period-over-period
 * comparisons. "This Month" compares against the same number of days of the
 * previous month; every other period compares against the equally long window
 * that ends where the current one begins.
 */
function previousRange(range) {
  const span = range.end.getTime() - range.start.getTime();

  if (range.period === 'month') {
    const local = zonedNow(range.start);
    const prevStart = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1) - TZ_OFFSET_MS);
    return { period: 'previous-month', start: prevStart, end: new Date(prevStart.getTime() + span) };
  }

  return {
    period: `previous-${range.period}`,
    start: new Date(range.start.getTime() - span),
    end: new Date(range.start.getTime()),
  };
}

/**
 * Serialise a range for the API: inclusive first/last day as YYYY-MM-DD.
 */
function formatRange(range) {
  return {
    startDate: toISODate(range.start),
    endDate: toISODate(new Date(range.end.getTime() - DAY_MS)),
  };
}

/**
 * Number of whole days the range covers.
 */
function rangeDays(range) {
  return Math.max(1, Math.round((range.end.getTime() - range.start.getTime()) / DAY_MS));
}

/**
 * Every reporting-local day in the range, as YYYY-MM-DD strings.
 */
function eachDay(range) {
  const days = [];
  for (let t = range.start.getTime(); t < range.end.getTime(); t += DAY_MS) {
    days.push(toISODate(new Date(t)));
  }
  return days;
}

module.exports = {
  PERIODS,
  DAY_MS,
  REPORT_TIMEZONE,
  TZ_OFFSET_MINUTES,
  TZ_OFFSET_MS,
  resolveRange,
  previousRange,
  formatRange,
  rangeDays,
  eachDay,
  toISODate,
  startOfDay,
  startOfDayFor,
  zonedNow,
  parseDateParam,
};
