const Order = require('../models/Order');
const Payment = require('../models/Payment');
const MenuItem = require('../models/MenuItem');
const Category = require('../models/Category');
const { PAYMENT_STATUS } = require('../config/constants');
const { canonicalOrderStatus } = require('../utils/order-status');
const { loadRefundRows } = require('../utils/refunds');

const STATUS_FLOW = ['PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED'];
const DAY_MS = 86400000;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

/** Match fragment that enforces the cafeteria scope (empty for system admins). */
function scopeMatch(scope, field = 'cafeteriaId') {
  return scope && !scope.global ? { [field]: scope.cafeteriaId } : {};
}

function normalizeStatus(value) {
  if (!value) return null;
  return String(value).toUpperCase();
}
/**
 * Reconcile the two order-status fields into one canonical uppercase status.
 * Shared with every other report so the counts cannot drift apart.
 */
function effectiveOrderStatus(order) {
  return canonicalOrderStatus(order);
}
function dayKey(date) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parsePagination(query, defaultLimit = 50, maxLimit = 500) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

/* ------------------------------------------------------------------ */
/* Summary cards                                                       */
/* ------------------------------------------------------------------ */

async function sumOrders(scope, start, end) {
  const rows = await Order.aggregate([
    { $match: { ...scopeMatch(scope), createdAt: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: null,
        orders: { $sum: 1 },
        gross: { $sum: { $ifNull: ['$totalAmount', 0] } },
        subtotal: { $sum: { $ifNull: ['$subtotal', 0] } },
      },
    },
  ]);
  const row = rows[0] || { orders: 0, gross: 0, subtotal: 0 };
  return { orders: row.orders, gross: round2(row.gross), subtotal: round2(row.subtotal) };
}

async function sumPaidPayments(scope, start, end) {
  const rows = await Payment.aggregate([
    { $match: { ...scopeMatch(scope), status: PAYMENT_STATUS.PAID, paymentDate: { $gte: start, $lt: end } } },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$amount', 0] } }, count: { $sum: 1 } } },
  ]);
  const row = rows[0] || { total: 0, count: 0 };
  return { total: round2(row.total), count: row.count };
}

/* ------------------------------------------------------------------ */
/* Sales report                                                        */
/* ------------------------------------------------------------------ */

async function getSales(scope, range) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(todayStart.getTime() + DAY_MS);
  const weekStart = new Date(todayStart.getTime() - 6 * DAY_MS);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [orders, today, weekly, monthly, paid] = await Promise.all([
    Order.find({ ...scopeMatch(scope), createdAt: { $gte: range.start, $lt: range.end } })
      .select('totalAmount status orderStatus paymentMethod paymentStatus createdAt')
      .lean(),
    sumOrders(scope, todayStart, tomorrow),
    sumOrders(scope, weekStart, tomorrow),
    sumOrders(scope, monthStart, new Date(now.getFullYear(), now.getMonth() + 1, 1)),
    sumPaidPayments(scope, range.start, range.end),
  ]);

  const active = orders.filter((o) => effectiveOrderStatus(o) !== 'CANCELLED');
  const totalSales = round2(active.reduce((s, o) => s + num(o.totalAmount), 0));
  const completedOrders = orders.filter((o) => effectiveOrderStatus(o) === 'COMPLETED').length;

  const byDateMap = {};
  active.forEach((o) => {
    const key = dayKey(o.createdAt);
    if (!key) return;
    if (!byDateMap[key]) byDateMap[key] = { date: key, orders: 0, sales: 0 };
    byDateMap[key].orders += 1;
    byDateMap[key].sales += num(o.totalAmount);
  });
  const salesByDate = Object.values(byDateMap)
    .map((d) => ({ ...d, sales: round2(d.sales) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const methodMap = {};
  active.forEach((o) => {
    const m = String(o.paymentMethod || 'UNKNOWN').toUpperCase();
    if (!methodMap[m]) methodMap[m] = { method: m, orders: 0, sales: 0 };
    methodMap[m].orders += 1;
    methodMap[m].sales += num(o.totalAmount);
  });
  const salesByPaymentMethod = Object.values(methodMap)
    .map((m) => ({ ...m, sales: round2(m.sales) }))
    .sort((a, b) => b.sales - a.sales);

  return {
    period: range.period,
    range: { startDate: range.start, endDate: new Date(range.end.getTime() - DAY_MS) },
    currency: 'ETB',
    totalSales,
    todaySales: today.gross,
    weeklySales: weekly.gross,
    monthlySales: monthly.gross,
    completedOrders,
    totalOrders: orders.length,
    totalRevenue: paid.total,
    averageOrderValue: active.length > 0 ? round2(totalSales / active.length) : 0,
    salesByDate,
    salesByPaymentMethod,
  };
}

/* ------------------------------------------------------------------ */
/* Orders report                                                       */
/* ------------------------------------------------------------------ */

async function getOrders(scope, range, query = {}) {
  const { page, limit, skip } = parsePagination(query);
  const statusFilter = normalizeStatus(query.status);
  const paymentStatusFilter = normalizeStatus(query.paymentStatus);

  const match = { ...scopeMatch(scope), createdAt: { $gte: range.start, $lt: range.end } };
  if (paymentStatusFilter && paymentStatusFilter !== 'ALL') match.paymentStatus = paymentStatusFilter;

  const orders = await Order.find(match)
    .select(
      'orderId customerName customerPhone orderType tableNumber totalAmount status orderStatus paymentMethod paymentStatus refundStatus createdAt'
    )
    .sort({ createdAt: -1 })
    .lean();

  const withStatus = orders.map((o) => ({ ...o, effectiveStatus: effectiveOrderStatus(o) }));
  const filtered =
    statusFilter && statusFilter !== 'ALL' ? withStatus.filter((o) => o.effectiveStatus === statusFilter) : withStatus;

  const counts = { total: filtered.length };
  ['PENDING', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'].forEach((s) => {
    counts[s.toLowerCase()] = filtered.filter((o) => o.effectiveStatus === s).length;
  });
  counts.refunded = filtered.filter((o) => normalizeStatus(o.paymentStatus) === 'REFUNDED').length;

  const pageRows = filtered.slice(skip, skip + limit).map((o) => ({
    orderId: o.orderId,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    orderType: o.orderType,
    tableNumber: o.tableNumber,
    totalAmount: num(o.totalAmount),
    status: o.effectiveStatus,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    createdAt: o.createdAt,
  }));

  return {
    period: range.period,
    range: { startDate: range.start, endDate: new Date(range.end.getTime() - DAY_MS) },
    counts,
    totalAmount: round2(filtered.reduce((s, o) => s + num(o.totalAmount), 0)),
    pagination: { page, limit, total: filtered.length, pages: Math.ceil(filtered.length / limit) || 1 },
    orders: pageRows,
  };
}

/* ------------------------------------------------------------------ */
/* Payments report                                                     */
/* ------------------------------------------------------------------ */

async function getPayments(scope, range, query = {}) {
  const { page, limit, skip } = parsePagination(query);
  const statusFilter = normalizeStatus(query.status);
  const methodFilter = normalizeStatus(query.method);

  const match = { ...scopeMatch(scope), paymentDate: { $gte: range.start, $lt: range.end } };
  if (statusFilter && statusFilter !== 'ALL') match.status = statusFilter;
  if (methodFilter && methodFilter !== 'ALL') match.method = methodFilter;

  const payments = await Payment.find(match)
    .select('paymentNumber orderId userId amount method provider status reference transactionId paymentDate')
    .populate('orderId', 'orderId customerName')
    .sort({ paymentDate: -1 })
    .lean();

  const counts = {
    total: payments.length,
    paid: payments.filter((p) => normalizeStatus(p.status) === 'PAID').length,
    pending: payments.filter((p) => normalizeStatus(p.status) === 'PENDING').length,
    failed: payments.filter((p) => normalizeStatus(p.status) === 'FAILED').length,
    refunded: payments.filter((p) => normalizeStatus(p.status) === 'REFUNDED').length,
  };

  const totalPaidAmount = round2(
    payments.filter((p) => normalizeStatus(p.status) === 'PAID').reduce((s, p) => s + num(p.amount), 0)
  );

  const methodMap = {};
  payments.forEach((p) => {
    const m = String(p.method || 'UNKNOWN').toUpperCase();
    if (!methodMap[m]) methodMap[m] = { method: m, count: 0, amount: 0 };
    methodMap[m].count += 1;
    if (normalizeStatus(p.status) === 'PAID') methodMap[m].amount += num(p.amount);
  });
  const paymentMethods = Object.values(methodMap)
    .map((m) => ({ ...m, amount: round2(m.amount) }))
    .sort((a, b) => b.count - a.count);

  const transactions = payments.slice(skip, skip + limit).map((p) => ({
    id: String(p._id),
    paymentNumber: p.paymentNumber || '-',
    orderRef: p.orderId && p.orderId.orderId ? p.orderId.orderId : '-',
    customerName: p.orderId && p.orderId.customerName ? p.orderId.customerName : '-',
    amount: num(p.amount),
    method: p.method,
    status: p.status,
    reference: p.reference || p.transactionId || '-',
    paymentDate: p.paymentDate,
  }));

  return {
    period: range.period,
    range: { startDate: range.start, endDate: new Date(range.end.getTime() - DAY_MS) },
    currency: 'ETB',
    counts,
    totalPaidAmount,
    paymentMethods,
    pagination: { page, limit, total: payments.length, pages: Math.ceil(payments.length / limit) || 1 },
    transactions,
  };
}

/* ------------------------------------------------------------------ */
/* Refunds report                                                      */
/* ------------------------------------------------------------------ */

/**
 * Refund rows come from BOTH ledgers (standalone Refund + Cancellation) and
 * are loaded by the shared helper in utils/refunds.js, so this report and the
 * financial report always agree on what was refunded.
 */
async function getRefunds(scope, range, query = {}) {
  const { page, limit, skip } = parsePagination(query);
  const statusFilter = normalizeStatus(query.status);

  const allRows = await loadRefundRows(scope, range, 'ALL');

  const count = (status) => allRows.filter((r) => r.status === status).length;
  const counts = {
    total: allRows.length,
    requested: count('REFUND_REQUESTED'),
    approved: count('APPROVED'),
    rejected: count('REJECTED'),
    completed: count('REFUNDED'),
    failed: count('REFUND_FAILED'),
  };
  const totalRefundedAmount = round2(
    allRows.filter((r) => r.status === 'REFUNDED').reduce((s, r) => s + num(r.amount), 0)
  );

  let tableRows = allRows;
  if (statusFilter && statusFilter !== 'ALL') {
    const expanded = expandStatusFilter(statusFilter) || [statusFilter];
    tableRows = allRows.filter((r) => expanded.includes(r.status) || expanded.includes(r.rawStatus));
  }

  const rows = tableRows.slice(skip, skip + limit).map((r) => ({
    refundNumber: r.refundNumber,
    orderRef: r.orderRef,
    customerName: r.customerName,
    amount: r.amount,
    reason: r.reason,
    status: r.status,
    paymentMethod: r.paymentMethod,
    requestedBy: r.requestedBy,
    requestedAt: r.requestedAt,
  }));

  return {
    period: range.period,
    range: { startDate: range.start, endDate: new Date(range.end.getTime() - DAY_MS) },
    currency: 'ETB',
    counts,
    totalRefundedAmount,
    pagination: { page, limit, total: tableRows.length, pages: Math.ceil(tableRows.length / limit) || 1 },
    refunds: rows,
  };
}

/* ------------------------------------------------------------------ */
/* Menu performance report                                             */
/* ------------------------------------------------------------------ */

async function getMenuPerformance(scope, range, query = {}) {
  const categoryFilter = String(query.category || '')
    .trim()
    .toLowerCase();

  const [items, orderAgg, categoryRows] = await Promise.all([
    MenuItem.find(scopeMatch(scope))
      .select('name category price isAvailable isActive availabilityStatus stockQuantity')
      .lean(),
    Order.aggregate([
      { $match: { ...scopeMatch(scope), createdAt: { $gte: range.start, $lt: range.end } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.itemId',
          name: { $first: '$items.name' },
          category: { $first: '$items.categoryNameSnapshot' },
          totalQuantity: { $sum: '$items.quantity' },
          totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
          orderCount: { $sum: 1 },
        },
      },
    ]),
    Category.find(scopeMatch(scope)).select('id name').lean(),
  ]);

  const categoryNameById = {};
  categoryRows.forEach((c) => {
    categoryNameById[String(c.id).toLowerCase()] = c.name && c.name.en ? c.name.en : c.id;
  });

  const statsById = {};
  orderAgg.forEach((a) => {
    statsById[String(a._id)] = a;
  });

  const perf = items
    .filter((item) => !categoryFilter || String(item.category || '').toLowerCase() === categoryFilter)
    .map((item) => {
      const stat = statsById[String(item._id)] || {};
      const available =
        item.isActive !== false && item.isAvailable !== false && item.availabilityStatus !== 'UNAVAILABLE';
      return {
        id: String(item._id),
        name: item.name && item.name.en ? item.name.en : String(item.name || '-'),
        category: item.category || '-',
        categoryName: categoryNameById[String(item.category || '').toLowerCase()] || item.category || '-',
        price: num(item.price),
        available,
        totalQuantity: stat.totalQuantity || 0,
        totalRevenue: round2(stat.totalRevenue || 0),
        orderCount: stat.orderCount || 0,
      };
    });

  const ordered = perf.slice().sort((a, b) => b.totalQuantity - a.totalQuantity || b.totalRevenue - a.totalRevenue);
  const mostOrdered = ordered.filter((i) => i.totalQuantity > 0).slice(0, 10);
  const leastOrdered = ordered
    .slice()
    .sort((a, b) => a.totalQuantity - b.totalQuantity)
    .slice(0, 10);

  const availableCount = perf.filter((i) => i.available).length;
  const unavailableCount = perf.length - availableCount;

  const catMap = {};
  perf.forEach((i) => {
    const key = i.category || '-';
    if (!catMap[key])
      catMap[key] = { category: key, categoryName: i.categoryName, totalQuantity: 0, totalRevenue: 0, itemCount: 0 };
    catMap[key].totalQuantity += i.totalQuantity;
    catMap[key].totalRevenue += i.totalRevenue;
    catMap[key].itemCount += 1;
  });
  const bestCategories = Object.values(catMap)
    .map((c) => ({ ...c, totalRevenue: round2(c.totalRevenue) }))
    .sort((a, b) => b.totalQuantity - a.totalQuantity);

  return {
    period: range.period,
    range: { startDate: range.start, endDate: new Date(range.end.getTime() - DAY_MS) },
    currency: 'ETB',
    summary: {
      totalItems: perf.length,
      availableItems: availableCount,
      unavailableItems: unavailableCount,
      totalQuantitySold: perf.reduce((s, i) => s + i.totalQuantity, 0),
      totalRevenue: round2(perf.reduce((s, i) => s + i.totalRevenue, 0)),
    },
    mostOrdered,
    leastOrdered,
    bestCategories,
    items: ordered,
  };
}

/* ------------------------------------------------------------------ */
/* Inventory / Stock report                                           */
/* ------------------------------------------------------------------ */

async function getInventory(scope) {
  const [items, categoryRows] = await Promise.all([
    MenuItem.find(scopeMatch(scope))
      .select('name category price stockQuantity lowStockThreshold isAvailable isActive availabilityStatus')
      .lean(),
    Category.find(scopeMatch(scope)).select('id name').lean(),
  ]);

  const categoryNameById = {};
  categoryRows.forEach((c) => {
    categoryNameById[String(c.id).toLowerCase()] = c.name && c.name.en ? c.name.en : c.id;
  });

  const rows = items.map((item) => {
    const catId = String(item.category || '').toLowerCase();
    return {
      id: item._id,
      name: item.name && item.name.en ? item.name.en : item.name,
      category: categoryNameById[catId] || item.category,
      price: round2(item.price),
      stockQuantity: item.stockQuantity || 0,
      lowStockThreshold: item.lowStockThreshold || 10,
      isAvailable: item.isAvailable !== false,
      isActive: item.isActive !== false,
      availabilityStatus: item.availabilityStatus || 'AVAILABLE',
      lowStock: (item.stockQuantity || 0) > 0 && (item.stockQuantity || 0) <= (item.lowStockThreshold || 10),
      outOfStock: (item.stockQuantity || 0) === 0,
    };
  });

  const totalItems = rows.length;
  const availableItems = rows.filter((r) => r.availabilityStatus === 'AVAILABLE').length;
  const lowStockItems = rows.filter((r) => r.lowStock).length;
  const outOfStockItems = rows.filter((r) => r.outOfStock).length;
  const totalStockValue = round2(rows.reduce((s, r) => s + r.price * r.stockQuantity, 0));
  const totalStockQuantity = rows.reduce((s, r) => s + r.stockQuantity, 0);

  return {
    currency: 'ETB',
    summary: {
      totalItems,
      availableItems,
      unavailableItems: totalItems - availableItems,
      lowStockItems,
      outOfStockItems,
      totalStockQuantity,
      totalStockValue,
    },
    items: rows,
  };
}

module.exports = {
  getSales,
  getOrders,
  getPayments,
  getRefunds,
  getMenuPerformance,
  getInventory,
  effectiveOrderStatus,
};
