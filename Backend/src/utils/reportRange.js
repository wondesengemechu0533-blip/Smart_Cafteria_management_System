const { HTTP_STATUS } = require('../config/constants');

const PERIODS = ['today', 'yesterday', 'last7', 'last30', 'month', 'custom'];
const DAY_MS = 86400000;

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isValidDate(value) {
  return value instanceof Date && !isNaN(value.getTime());
}

function parseDateParam(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (!isValidDate(date)) {
    const error = new Error(`${fieldName} must be a valid date (YYYY-MM-DD)`);
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Resolve a report period into a half-open local date range [start, end).
 * Throws { message, statusCode: 400 } on invalid input.
 */
function resolveRange({ period, startDate, endDate }) {
  const normalized = String(period || 'month').toLowerCase();

  if (!PERIODS.includes(normalized)) {
    const error = new Error(`Invalid period. Allowed: ${PERIODS.join(', ')}`);
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }

  const now = new Date();
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
    case 'month':
      return {
        period: normalized,
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
      };
    case 'custom': {
      const start = parseDateParam(startDate, 'startDate');
      const end = parseDateParam(endDate, 'endDate');
      if (!start || !end) {
        const error = new Error('Custom date range requires both startDate and endDate');
        error.statusCode = HTTP_STATUS.BAD_REQUEST;
        throw error;
      }
      if (start.getTime() > end.getTime()) {
        const error = new Error('startDate must be before or equal to endDate');
        error.statusCode = HTTP_STATUS.BAD_REQUEST;
        throw error;
      }
      return { period: normalized, start, end: new Date(end.getTime() + DAY_MS) };
    }
  }

  const error = new Error('Invalid period');
  error.statusCode = HTTP_STATUS.BAD_REQUEST;
  throw error;
}

function toISODate(date) {
  if (!isValidDate(date)) return null;
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

module.exports = { PERIODS, DAY_MS, resolveRange, toISODate, startOfDay };
