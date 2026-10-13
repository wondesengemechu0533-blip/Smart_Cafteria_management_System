const Order = require('../models/Order');
const Payment = require('../models/Payment');
const { PAYMENT_STATUS, MESSAGES, HTTP_STATUS } = require('../config/constants');

const FLOW = ['PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED'];

const PERIODS = ['today', 'yesterday', 'last7', 'last30', 'month', 'custom'];
const DAY_MS = 86400000;

function normalizeStatus(value) {
  if (!value) return null;
  return String(value).toUpperCase();
}

/**
 * Reconcile the two order-status fields:
 *  - orderStatus (uppercase, driven by admin order management)
 *  - status (lowercase, driven by the kitchen flow)
 */
function effectiveOrderStatus(order) {
  const up = normalizeStatus(order.orderStatus);
  const low = normalizeStatus(order.status);

  const indexOf = (s) => FLOW.indexOf(s);
  const upIndex = indexOf(up);
  const lowIndex = indexOf(low);

  if (up === 'CANCELLED' || low === 'CANCELLED') return 'CANCELLED';
  if (upIndex === -1 && lowIndex === -1) return up || low || 'PENDING';
  if (upIndex === -1) return low;
  if (lowIndex === -1) return up;
  return upIndex >= lowIndex ? up : low;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isValidDate(value) {
  return value instanceof Date && !isNaN(value.getTime());
}

/**
 * Parse a YYYY-MM-DD (or ISO) date query param into a Date at local midnight.
 * Throws { message, statusCode: 400 } when invalid.
 */
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
 * Resolve the report period from query params.
 * Returns { period, start, end } where [start, end) is the local date range
 * (end is exclusive - the day after the last included day).
 */
function resolveRange({ period, startDate, endDate }) {
  const normalized = String(period || '').toLowerCase();

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

      const endExclusive = new Date(end.getTime() + DAY_MS);
      return { period: normalized, start, end: endExclusive };
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

/**
 * @desc    Admin report summary scoped to a period
 * @route   GET /api/v1/admin/reports/summary
 * @access  Private/Admin
 *
 * Query:
 *   period      today | yesterday | last7 | last30 | month | custom   (default: month)
 *   startDate   required only when period=custom (YYYY-MM-DD)
 *   endDate     required only when period=custom (YYYY-MM-DD)
 *
 * Revenue is computed exclusively from payments the provider verified
 * as PAID within the selected period. Most ordered foods are aggregated
 * from the server-side Order collection - never from frontend data.
 * Currency reported is ETB.
 */
exports.getReportSummary = async (req, res) => {
  try {
    const now = new Date();

    let range;
    try {
      range = resolveRange({
        period: req.query.period,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      });
    } catch (error) {
      const status = (error && error.statusCode) || HTTP_STATUS.BAD_REQUEST;
      return res.status(status).json({ success: false, error: error.message });
    }

    const dateFilter = { $gte: range.start, $lt: range.end };

    const [revenueTotal, orders, paymentCounts, mostOrderedFoods] = await Promise.all([
      // Revenue: PAID payments only, within the period.
      Payment.aggregate([
        { $match: { status: PAYMENT_STATUS.PAID, paymentDate: dateFilter } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      // Orders created within the period.
      Order.find({ createdAt: dateFilter }).select('status orderStatus createdAt').lean(),
      // Payment counts within the period.
      Payment.aggregate([{ $match: { paymentDate: dateFilter } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      // Most ordered foods - pure server-side aggregation on actual orders.
      Order.aggregate([
        { $match: { createdAt: dateFilter } },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.name',
            name: { $first: '$items.name' },
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
            orderCount: { $sum: 1 },
          },
        },
        { $sort: { totalQuantity: -1 } },
        { $limit: 10 },
      ]),
    ]);

    const totalOrders = orders.length;
    const completedOrders = orders.filter((o) => effectiveOrderStatus(o) === 'COMPLETED').length;
    const cancelledOrders = orders.filter((o) => effectiveOrderStatus(o) === 'CANCELLED').length;

    const countByStatus = (status) => {
      const row = paymentCounts.find((r) => String(r._id || '').toUpperCase() === String(status || '').toUpperCase());
      return row ? row.count : 0;
    };

    res.status(HTTP_STATUS.OK).json({
      success: true,
      report: {
        generatedAt: now,
        period: range.period,
        range: {
          startDate: toISODate(range.start),
          endDate: toISODate(new Date(range.end.getTime() - DAY_MS)),
        },
        currency: 'ETB',
        revenue: revenueTotal[0] ? revenueTotal[0].total : 0,
        orders: {
          totalOrders,
          completedOrders,
          cancelledOrders,
        },
        payments: {
          successfulPayments: countByStatus(PAYMENT_STATUS.PAID),
          failedPayments: countByStatus(PAYMENT_STATUS.FAILED),
          pendingPayments: countByStatus(PAYMENT_STATUS.PENDING),
          totalPayments: paymentCounts.reduce((sum, r) => sum + r.count, 0),
        },
        mostOrderedFoods: mostOrderedFoods.map((item) => ({
          name: item.name,
          totalQuantity: item.totalQuantity,
          totalRevenue: item.totalRevenue,
          orderCount: item.orderCount,
        })),
      },
    });
  } catch (error) {
    console.error('❌ Admin Get Report Summary Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};
