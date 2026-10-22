const Order = require('../models/Order');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Cafeteria = require('../models/Cafeteria');
const { cafeteriaFilter } = require('../utils/cafeteria');
const { canonicalOrderStatus } = require('../utils/order-status');
const { PAYMENT_STATUS } = require('../config/constants');
const { DAY_MS, formatRange, toISODate, zonedNow } = require('../utils/reportRange');

const ORDER_TYPES = [
  { value: 'dine-in', label: 'Dine-in' },
  { value: 'takeaway', label: 'Takeaway' },
  { value: 'delivery', label: 'Delivery' },
];

const ORDER_TYPE_LABELS = ORDER_TYPES.reduce((acc, t) => {
  acc[t.value] = t.label;
  return acc;
}, {});

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

function normalizePaymentStatus(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

/**
 * Reporting-local week key (Monday start) for the given instant.
 */
function weekKey(date) {
  const local = zonedNow(date);
  const day = local.getUTCDay(); // 0 = Sunday
  const offset = (day + 6) % 7; // Monday = 0
  const monday = new Date(date.getTime() - offset * DAY_MS);
  return toISODate(monday);
}

/**
 * Operational (non-financial) report for a period.
 *
 * Everything is derived from the stored Order / Payment collections - no
 * metric is hard-coded and no figure comes from the client. The cafeteria
 * scope is resolved server-side: system admins see every cafeteria, cafeteria
 * staff see only their own.
 *
 * @param {{cafeteriaId: any, global: boolean}} scope
 * @param {{period: string, start: Date, end: Date}} range
 */
async function getOperationalReport(scope, range) {
  const scopeFilter = cafeteriaFilter(scope);
  const dateFilter = { $gte: range.start, $lt: range.end };

  const [orders, payments] = await Promise.all([
    Order.find({ ...scopeFilter, createdAt: dateFilter })
      .select(
        'orderId orderType status orderStatus paymentMethod paymentStatus totalAmount items createdAt'
      )
      .lean(),
    Payment.find({ ...scopeFilter, paymentDate: dateFilter })
      .select('paymentNumber orderId amount method provider status paymentDate')
      .lean(),
  ]);

  /* ---------------------------------------------------------------- */
  /* Orders                                                            */
  /* ---------------------------------------------------------------- */
  const statusCounts = Object.create(null);
  const typeCounts = Object.create(null);
  const itemStats = new Map();
  const bucketCounts = new Map();

  const totalDays = Math.max(1, Math.round((range.end.getTime() - range.start.getTime()) / DAY_MS));
  const granularity = totalDays > 62 ? 'week' : 'day';

  const bucketKeyFor = (date) => (granularity === 'week' ? weekKey(date) : toISODate(date));

  for (const order of orders) {
    const status = canonicalOrderStatus(order);
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    const type = String(order.orderType || '').toLowerCase();
    if (!typeCounts[type]) {
      typeCounts[type] = { type, label: ORDER_TYPE_LABELS[type] || type, orders: 0, revenue: 0 };
    }
    typeCounts[type].orders += 1;
    typeCounts[type].revenue += num(order.totalAmount);

    const key = bucketKeyFor(order.createdAt || range.start);
    if (!bucketCounts.has(key)) {
      bucketCounts.set(key, { date: key, orders: 0, completed: 0, cancelled: 0, pending: 0 });
    }
    const bucket = bucketCounts.get(key);
    bucket.orders += 1;
    if (status === 'COMPLETED' || status === 'SERVED') bucket.completed += 1;
    else if (status === 'CANCELLED') bucket.cancelled += 1;
    else if (status === 'PENDING') bucket.pending += 1;

    for (const item of order.items || []) {
      const name = item.name || item.foodNameSnapshot || 'Unknown item';
      if (!itemStats.has(name)) {
        itemStats.set(name, {
          name,
          category: item.categoryNameSnapshot || item.category || '-',
          totalQuantity: 0,
          orderCount: 0,
          revenue: 0,
        });
      }
      const stat = itemStats.get(name);
      stat.totalQuantity += num(item.quantity);
      stat.orderCount += 1;
      stat.revenue += num(item.price) * num(item.quantity);
    }
  }

  const totalOrders = orders.length;
  const completedOrders = (statusCounts.COMPLETED || 0) + (statusCounts.SERVED || 0);
  const cancelledOrders = statusCounts.CANCELLED || 0;
  const pendingOrders = statusCounts.PENDING || 0;
  const inProgressOrders = Math.max(
    0,
    totalOrders - completedOrders - cancelledOrders - pendingOrders
  );

  /* ---------------------------------------------------------------- */
  /* Payments (counts only - the money itself belongs to the financial   */
  /* report, which is a separate page)                                  */
  /* ---------------------------------------------------------------- */
  const paymentCounts = { total: payments.length, successful: 0, failed: 0, pending: 0, refunded: 0 };
  for (const payment of payments) {
    switch (normalizePaymentStatus(payment.status)) {
      case PAYMENT_STATUS.PAID:
        paymentCounts.successful += 1;
        break;
      case PAYMENT_STATUS.FAILED:
        paymentCounts.failed += 1;
        break;
      case PAYMENT_STATUS.REFUNDED:
        paymentCounts.refunded += 1;
        break;
      default:
        paymentCounts.pending += 1;
        break;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Distributions                                                      */
  /* ---------------------------------------------------------------- */
  const statusDistribution = Object.keys(statusCounts)
    .map((status) => ({
      status,
      count: statusCounts[status],
      share: totalOrders ? round2((statusCounts[status] / totalOrders) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const knownTypes = new Set(ORDER_TYPES.map((t) => t.value));
  const orderTypes = Object.values(typeCounts)
    .filter((t) => t.orders > 0 || knownTypes.has(t.type))
    .map((t) => ({
      ...t,
      revenue: round2(t.revenue),
      share: totalOrders ? round2((t.orders / totalOrders) * 100) : 0,
    }))
    .sort((a, b) => b.orders - a.orders);

  const foodPopularity = Array.from(itemStats.values())
    .map((f) => ({ ...f, revenue: round2(f.revenue) }))
    .sort((a, b) => b.totalQuantity - a.totalQuantity || b.revenue - a.revenue);

  const mostOrderedFoods = foodPopularity.slice(0, 10).map((f) => ({
    name: f.name,
    category: f.category,
    totalQuantity: f.totalQuantity,
    orderCount: f.orderCount,
    totalRevenue: f.revenue,
  }));

  /* ---------------------------------------------------------------- */
  /* Trends - one bucket per day (or per week for long ranges)          */
  /* ---------------------------------------------------------------- */
  const trends = [];
  for (let t = range.start.getTime(); t < range.end.getTime(); t += DAY_MS) {
    const key = granularity === 'week' ? weekKey(new Date(t)) : toISODate(new Date(t));
    if (trends.length && trends[trends.length - 1].date === key) continue;
    trends.push({ date: key, orders: 0, completed: 0, cancelled: 0, pending: 0 });
  }
  for (const [key, bucket] of bucketCounts.entries()) {
    const target = trends.find((t) => t.date === key);
    if (!target) continue;
    target.orders += bucket.orders;
    target.completed += bucket.completed;
    target.cancelled += bucket.cancelled;
    target.pending += bucket.pending;
  }

  /* ---------------------------------------------------------------- */
  /* System-wide metrics (only for global/system-admin scope)            */
  /* ---------------------------------------------------------------- */
  let users = undefined;
  let cafeteriaPerformance = undefined;
  if (scope && scope.global) {
    const [totalUsers, activeUsers] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ status: 'ACTIVE' }),
    ]);
    users = { total: totalUsers, active: activeUsers, inactive: Math.max(0, totalUsers - activeUsers) };

    const cafeterias = await Cafeteria.find({}).select('_id name').lean();
    const orderAgg = await Order.aggregate([
      { $match: { createdAt: dateFilter } },
      { $group: { _id: '$cafeteriaId', orders: { $sum: 1 }, revenue: { $sum: { $ifNull: ['$totalAmount', 0] } } } },
    ]);
    const byCaf = new Map(orderAgg.map((r) => [String(r._id), r]));
    cafeteriaPerformance = cafeterias.map((c) => {
      const agg = byCaf.get(String(c._id)) || { orders: 0, revenue: 0 };
      return { id: String(c._id), name: c.name, orders: agg.orders, revenue: round2(agg.revenue) };
    });
  }

  return {
    users,
    cafeteriaPerformance,
    generatedAt: new Date(),
    period: range.period,
    range: formatRange(range),
    currency: 'ETB',
    orders: {
      total: totalOrders,
      completed: completedOrders,
      cancelled: cancelledOrders,
      pending: pendingOrders,
      inProgress: inProgressOrders,
    },
    payments: paymentCounts,
    statusDistribution,
    orderTypes,
    foodPopularity,
    mostOrderedFoods,
    trends,
    trendGranularity: granularity,
  };
}

module.exports = { getOperationalReport, ORDER_TYPES, ORDER_TYPE_LABELS };
