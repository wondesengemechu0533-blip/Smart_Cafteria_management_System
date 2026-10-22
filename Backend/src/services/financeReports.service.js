const Order = require('../models/Order');
const Payment = require('../models/Payment');
const { cafeteriaFilter } = require('../utils/cafeteria');
const { canonicalOrderStatus } = require('../utils/order-status');
const { loadProcessedRefunds } = require('../utils/refunds');
const { getSettingsMap } = require('../utils/settings');
const { PAYMENT_STATUS } = require('../config/constants');
const {
  DAY_MS,
  formatRange,
  previousRange,
  toISODate,
  zonedNow,
  TZ_OFFSET_MS,
} = require('../utils/reportRange');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
function monthLabel(key) {
  const parts = String(key).split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (!year || !month) return key;
  return new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

const PAYMENT_METHOD_LABELS = {
  CHAPA: 'Chapa',
  TELEBIRR: 'Telebirr',
  CBE_BIRR: 'CBE Birr (Telebirr)',
  CASH: 'Cash',
};

const ORDER_TYPE_LABELS = {
  'dine-in': 'Dine-in',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
};

function paymentMethodLabel(method) {
  const key = String(method || '').trim().toUpperCase();
  return PAYMENT_METHOD_LABELS[key] || key || 'Unknown';
}

function paymentStatus(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Tax configuration                                                   */
/* ------------------------------------------------------------------ */

/**
 * Read the CONFIGURED tax settings.
 *
 * The VAT rate is never assumed: it comes from the Settings collection
 * (admin-configurable under the "tax" group), and an order that stored its own
 * rate keeps using that stored rate.
 */
async function loadTaxConfig() {
  const map = await getSettingsMap();
  const vatEnabled = map.vat_enabled !== false && map.vat_enabled !== 'false';
  return {
    vatEnabled,
    vatRate: Math.max(0, Number(map.vat_rate) || 0),
    taxAuthorityName: map.tax_authority_name || 'Tax Authority',
    vatNumber: map.vat_number || '',
    currency: map.currency || 'ETB',
    serviceFee: Number(map.service_fee) || 0,
    platformFeeRate: Math.max(0, Number(map.platform_fee_rate) || 0),
  };
}

/**
 * Food subtotal of an order, recovered for legacy rows that never stored it.
 */
function orderSubtotal(order) {
  const stored = Number(order.subtotal) || 0;
  if (stored > 0) return round2(stored);
  const total = Number(order.totalAmount) || 0;
  const vat = Number(order.vatAmount) || Number(order.taxAmount) || 0;
  const serviceFee = Number(order.serviceFee) || 0;
  const deliveryFee = Number(order.deliveryFee) || 0;
  return round2(Math.max(0, total - serviceFee - deliveryFee - vat));
}

/**
 * The amount VAT is charged on: food + service fee + delivery fee.
 */
function taxableBase(order) {
  return round2(orderSubtotal(order) + num(order.serviceFee) + num(order.deliveryFee));
}

/**
 * VAT of a single order.
 *
 * Uses the order's own stored VAT amount / rate when present, otherwise the
 * configured rate. A disabled VAT on the order means no VAT at all.
 */
function orderVat(order, config) {
  const base = taxableBase(order);
  const storedAmount = num(order.vatAmount) || num(order.taxAmount) || 0;
  const orderEnabled = order.vatEnabled !== false;
  const storedRate = Number(order.vatRate) || 0;
  const rate = storedRate > 0 ? storedRate : config.vatRate;

  if (!orderEnabled || !config.vatEnabled || rate <= 0) {
    return { amount: 0, rate: 0, base, enabled: orderEnabled && config.vatEnabled };
  }
  if (storedAmount > 0) {
    return { amount: round2(storedAmount), rate, base, enabled: true };
  }
  return { amount: round2((base * rate) / 100), rate, base, enabled: true };
}

/* ------------------------------------------------------------------ */
/* Period loading                                                      */
/* ------------------------------------------------------------------ */

async function loadPeriod(scope, range) {
  const scopeFilter = cafeteriaFilter(scope);
  const dateFilter = { $gte: range.start, $lt: range.end };

  const [orders, payments, refunds] = await Promise.all([
    Order.find({ ...scopeFilter, createdAt: dateFilter })
      .select(
        'orderId orderType status orderStatus paymentMethod paymentStatus totalAmount subtotal serviceFee deliveryFee platformFee platformShare cafeteriaShare vatEnabled vatRate vatAmount taxAmount items createdAt refundedAt'
      )
      .lean(),
    Payment.find({ ...scopeFilter, paymentDate: dateFilter })
      .select('paymentNumber orderId amount method provider status refundAmount refundStatus paymentDate')
      .lean(),
    loadProcessedRefunds(scope, range),
  ]);

  // The ids of the orders a successful payment was actually recorded for.
  // The order document keeps its own denormalised `paymentStatus`, and on
  // older records that flag was never updated even though the money was
  // collected - so the payment records are the authority on what was paid.
  const collectedOrderIds = new Set();
  for (const payment of payments) {
    const status = paymentStatus(payment.status);
    if (status !== PAYMENT_STATUS.PAID && status !== PAYMENT_STATUS.REFUNDED) continue;
    if (payment.orderId) collectedOrderIds.add(String(payment.orderId));
  }

  return { orders, payments, refunds, collectedOrderIds };
}

/* ------------------------------------------------------------------ */
/* Headline numbers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Reduce a period's records into the financial headline figures.
 *
 * Rules that matter:
 *  - cancelled orders never produced revenue, so they are excluded;
 *  - a payment that was collected and later refunded keeps its money in the
 *    collections total and is subtracted again through the refund, so
 *    collections - refunds is the real net;
 *  - only refunds that were actually PROCESSED are counted as money returned.
 */
function summarise(period, config) {
  const active = period.orders.filter((o) => canonicalOrderStatus(o) !== 'CANCELLED');

  let grossSales = 0;
  let foodSubtotal = 0;
  let discounts = 0;
  let serviceFees = 0;
  let deliveryFees = 0;
  let vatCharged = 0;
  let platformShare = 0;
  let cafeteriaShare = 0;
  let unpaidValue = 0;

  for (const order of active) {
    grossSales += num(order.totalAmount);
    foodSubtotal += orderSubtotal(order);
    discounts += num(order.platformFee);
    serviceFees += num(order.serviceFee);
    deliveryFees += num(order.deliveryFee);
    platformShare += num(order.platformShare);
    cafeteriaShare += num(order.cafeteriaShare) || orderSubtotal(order);
    vatCharged += orderVat(order, config).amount;

    const pay = paymentStatus(order.paymentStatus);
    const collected =
      pay === PAYMENT_STATUS.PAID ||
      pay === PAYMENT_STATUS.REFUNDED ||
      (period.collectedOrderIds && period.collectedOrderIds.has(String(order._id)));
    if (!collected) {
      unpaidValue += num(order.totalAmount);
    }
  }

  const payments = {
    total: period.payments.length,
    successful: { count: 0, amount: 0 },
    refunded: { count: 0, amount: 0 },
    pending: { count: 0, amount: 0 },
    failed: { count: 0, amount: 0 },
    cancelled: { count: 0, amount: 0 },
    byMethod: [],
  };

  const methodMap = new Map();
  for (const payment of period.payments) {
    const status = paymentStatus(payment.status);
    const amount = num(payment.amount);

    // One bucket per payment status. A REFUNDED payment was collected
    // successfully first and was returned afterwards, so its money is part of
    // the collections and the refund is subtracted again below.
    const bucket =
      status === PAYMENT_STATUS.PAID
        ? payments.successful
        : status === PAYMENT_STATUS.REFUNDED
          ? payments.refunded
          : status === PAYMENT_STATUS.FAILED
            ? payments.failed
            : status === PAYMENT_STATUS.CANCELLED
              ? payments.cancelled
              : payments.pending;

    bucket.count += 1;
    bucket.amount += amount;

    if (status === PAYMENT_STATUS.PAID || status === PAYMENT_STATUS.REFUNDED) {
      const key = String(payment.method || payment.provider || 'UNKNOWN').toUpperCase();
      if (!methodMap.has(key)) {
        methodMap.set(key, { method: key, label: paymentMethodLabel(key), count: 0, amount: 0 });
      }
      const entry = methodMap.get(key);
      entry.count += 1;
      entry.amount += amount;
    }
  }

  payments.successful.amount = round2(payments.successful.amount);
  payments.refunded.amount = round2(payments.refunded.amount);
  payments.pending.amount = round2(payments.pending.amount);
  payments.failed.amount = round2(payments.failed.amount);
  payments.cancelled.amount = round2(payments.cancelled.amount);

  // Money that came in: successful payments plus the ones that were later
  // refunded (they were collected first, the refund is subtracted afterwards).
  const collections = round2(payments.successful.amount + payments.refunded.amount);
  const successfulRefunds = round2(period.refunds.reduce((sum, r) => sum + num(r.amount), 0));
  const netCollectedRevenue = round2(collections - successfulRefunds);

  const orderCount = active.length;
  const componentTotal = round2(foodSubtotal + serviceFees + deliveryFees + vatCharged);

  payments.byMethod = Array.from(methodMap.values())
    .map((m) => ({ ...m, amount: round2(m.amount), share: collections ? round2((m.amount / collections) * 100) : 0 }))
    .sort((a, b) => b.amount - a.amount);

  return {
    orderCount,
    grossSales: round2(grossSales),
    foodSubtotal: round2(foodSubtotal),
    discounts: round2(discounts),
    serviceFees: round2(serviceFees),
    deliveryFees: round2(deliveryFees),
    // VAT charged on every non-cancelled order of the period. This is the
    // order-record figure used by the reconciliation below - the VAT that was
    // actually COLLECTED (and can be remitted) is `vat.vatCollected`.
    vatCharged: round2(vatCharged),
    platformShare: round2(platformShare),
    cafeteriaShare: round2(cafeteriaShare),
    averageOrderValue: orderCount > 0 ? round2(grossSales / orderCount) : 0,
    collections,
    successfulRefunds,
    netCollectedRevenue,
    unpaidValue: round2(unpaidValue),
    componentTotal,
    componentDifference: round2(grossSales - componentTotal),
    payments,
  };
}

/* ------------------------------------------------------------------ */
/* Trend buckets                                                       */
/* ------------------------------------------------------------------ */

function weekKey(date) {
  const local = zonedNow(date);
  const day = local.getUTCDay();
  const offset = (day + 6) % 7;
  return toISODate(new Date(date.getTime() - offset * DAY_MS));
}

function monthKey(date) {
  const local = zonedNow(date);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
}

function emptyBucket(key) {
  return {
    date: key,
    label: key,
    orders: 0,
    grossSales: 0,
    collections: 0,
    refunds: 0,
    netCollected: 0,
    vat: 0,
  };
}

function buildTrends(range, period, config) {
  // A "year" report always renders all 12 months of the selected year, even
  // the months that have not happened yet (they simply carry zero values).
  var bucketEnd = range.end;
  if (range.period === 'year') {
    var local = zonedNow(range.start);
    bucketEnd = new Date(Date.UTC(local.getUTCFullYear() + 1, 0, 1) - TZ_OFFSET_MS);
  }
  const daily = [];
  for (let t = range.start.getTime(); t < bucketEnd.getTime(); t += DAY_MS) {
    daily.push(emptyBucket(toISODate(new Date(t))));
  }
  const dailyIndex = new Map(daily.map((b) => [b.date, b]));

  for (const order of period.orders) {
    if (canonicalOrderStatus(order) === 'CANCELLED') continue;
    const bucket = dailyIndex.get(toISODate(order.createdAt || range.start));
    if (!bucket) continue;
    bucket.orders += 1;
    bucket.grossSales += num(order.totalAmount);
    bucket.vat += orderVat(order, config).amount;
  }

  for (const payment of period.payments) {
    const status = paymentStatus(payment.status);
    if (status !== PAYMENT_STATUS.PAID && status !== PAYMENT_STATUS.REFUNDED) continue;
    const bucket = dailyIndex.get(toISODate(payment.paymentDate || range.start));
    if (!bucket) continue;
    bucket.collections += num(payment.amount);
  }

  for (const refund of period.refunds) {
    const when = refund.refundedAt || refund.createdAt;
    const bucket = dailyIndex.get(toISODate(when || range.start));
    if (!bucket) continue;
    bucket.refunds += num(refund.amount);
  }

  for (const bucket of daily) {
    bucket.grossSales = round2(bucket.grossSales);
    bucket.collections = round2(bucket.collections);
    bucket.refunds = round2(bucket.refunds);
    bucket.netCollected = round2(bucket.collections - bucket.refunds);
    bucket.vat = round2(bucket.vat);
  }

  const aggregate = (keyFn, labelFn) => {
    const map = new Map();
    for (const bucket of daily) {
      const key = keyFn(bucket.date);
      if (!map.has(key)) map.set(key, emptyBucket(key));
      const target = map.get(key);
      target.orders += bucket.orders;
      target.grossSales += bucket.grossSales;
      target.collections += bucket.collections;
      target.refunds += bucket.refunds;
      target.netCollected += bucket.netCollected;
      target.vat += bucket.vat;
    }
    return Array.from(map.values())
      .map((b) => ({
        ...b,
        label: labelFn(b.date),
        grossSales: round2(b.grossSales),
        collections: round2(b.collections),
        refunds: round2(b.refunds),
        netCollected: round2(b.netCollected),
        vat: round2(b.vat),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  };

  return {
    daily,
    weekly: aggregate(
      (date) => {
        const d = new Date(`${date}T00:00:00.000Z`);
        return weekKey(d);
      },
      (date) => `Week of ${date}`
    ),
    monthly: aggregate(
      (date) => date.slice(0, 7),
      (date) => monthLabel(date.slice(0, 7))
    ),
    yearly: aggregate(
      (date) => date.slice(0, 4),
      (date) => date.slice(0, 4)
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Financial report for a period (revenue + collections + reconciliation).
 *
 * @param {{cafeteriaId: any, global: boolean}} scope
 * @param {{period: string, start: Date, end: Date}} range
 */
async function getFinancialReport(scope, range) {
  const config = await loadTaxConfig();
  const current = await loadPeriod(scope, range);
  const previousWindow = previousRange(range);
  const previous = await loadPeriod(scope, previousWindow);

  const summary = summarise(current, config);
  const previousSummary = summarise(previous, config);

  // The VAT figures come from the SAME helper the tax compliance report
  // uses, so the financial page and the Tax/VAT page always agree. Only the
  // totals are exposed here - the transaction-level detail lives on the
  // dedicated Tax/VAT page and is not duplicated.
  const taxSummary = summariseTax(current, config);

  const change = (now, before) => {
    if (!before) return now > 0 ? 100 : 0;
    return round2(((now - before) / before) * 100);
  };

  const activeOrders = current.orders.filter((o) => canonicalOrderStatus(o) !== 'CANCELLED');

  const revenueByFoodItem = new Map();
  for (const order of activeOrders) {
    for (const item of order.items || []) {
      const name = item.name || item.foodNameSnapshot || 'Unknown item';
      if (!revenueByFoodItem.has(name)) {
        revenueByFoodItem.set(name, { name, category: item.categoryNameSnapshot || '-', quantity: 0, revenue: 0 });
      }
      const entry = revenueByFoodItem.get(name);
      entry.quantity += num(item.quantity);
      entry.revenue += num(item.price) * num(item.quantity);
    }
  }

  const revenueByOrderType = new Map();
  for (const order of activeOrders) {
    const type = String(order.orderType || '').toLowerCase() || 'unknown';
    if (!revenueByOrderType.has(type)) {
      revenueByOrderType.set(type, {
        type,
        label: ORDER_TYPE_LABELS[type] || type,
        orders: 0,
        revenue: 0,
      });
    }
    const entry = revenueByOrderType.get(type);
    entry.orders += 1;
    entry.revenue += num(order.totalAmount);
  }

  const expectedNet = round2(summary.grossSales - summary.unpaidValue - summary.successfulRefunds);

  return {
    generatedAt: new Date(),
    period: range.period,
    range: formatRange(range),
    currency: config.currency,
    tax: {
      vatEnabled: config.vatEnabled,
      configuredVatRate: config.vatRate,
      taxAuthorityName: config.taxAuthorityName,
      vatNumber: config.vatNumber,
      taxableSales: taxSummary.taxableSales,
      vatCollected: taxSummary.vatCollected,
      vatRefunded: taxSummary.vatRefunded,
      netVatRetained: taxSummary.netVatRetained,
      taxableTransactions: taxSummary.transactionCount,
    },
    summary: {
      grossSales: summary.grossSales,
      foodSubtotal: summary.foodSubtotal,
      discounts: summary.discounts,
      serviceFees: summary.serviceFees,
      deliveryFees: summary.deliveryFees,
      platformShare: summary.platformShare,
      cafeteriaShare: summary.cafeteriaShare,
      successfulCollections: summary.collections,
      successfulRefunds: summary.successfulRefunds,
      netCollectedRevenue: summary.netCollectedRevenue,
      averageOrderValue: summary.averageOrderValue,
      orderCount: summary.orderCount,
      unpaidValue: summary.unpaidValue,
    },
    payments: summary.payments,
    reconciliation: {
      orderValue: summary.grossSales,
      componentTotal: summary.componentTotal,
      componentDifference: summary.componentDifference,
      collections: summary.collections,
      collectionVariance: round2(summary.collections - summary.grossSales),
      unpaidValue: summary.unpaidValue,
      successfulRefunds: summary.successfulRefunds,
      netCollectedRevenue: summary.netCollectedRevenue,
      expectedNet,
      netDifference: round2(summary.netCollectedRevenue - expectedNet),
      balanced: Math.abs(summary.componentDifference) < 0.05 && Math.abs(summary.netCollectedRevenue - expectedNet) < 0.05,
    },
    comparison: {
      period: previousWindow.period,
      range: formatRange(previousWindow),
      grossSales: previousSummary.grossSales,
      collections: previousSummary.collections,
      successfulRefunds: previousSummary.successfulRefunds,
      netCollectedRevenue: previousSummary.netCollectedRevenue,
      orderCount: previousSummary.orderCount,
      averageOrderValue: previousSummary.averageOrderValue,
      change: {
        grossSales: change(summary.grossSales, previousSummary.grossSales),
        collections: change(summary.collections, previousSummary.collections),
        netCollectedRevenue: change(summary.netCollectedRevenue, previousSummary.netCollectedRevenue),
        orderCount: change(summary.orderCount, previousSummary.orderCount),
        averageOrderValue: change(summary.averageOrderValue, previousSummary.averageOrderValue),
      },
    },
    trends: buildTrends(range, current, config),
    revenueByFoodItem: Array.from(revenueByFoodItem.values())
      .map((f) => ({ ...f, revenue: round2(f.revenue) }))
      .sort((a, b) => b.revenue - a.revenue),
    revenueByOrderType: Array.from(revenueByOrderType.values())
      .map((t) => ({
        ...t,
        revenue: round2(t.revenue),
        share: summary.grossSales ? round2((t.revenue / summary.grossSales) * 100) : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue),
  };
}

/**
 * The ONE definition of the VAT figures of a period.
 *
 * Both the financial report and the tax compliance report are built from
 * this function, so the two pages can never disagree about how much VAT was
 * collected, refunded or retained - and the transactions are computed once.
 *
 * Rules:
 *  - only sales that were actually COLLECTED are taxable (a pending order is
 *    not a taxable sale yet);
 *  - the VAT of a processed refund is subtracted from the retained amount;
 *  - the rate comes from the order's own stored rate, falling back to the
 *    CONFIGURED rate - never a hard-coded percentage.
 */
function summariseTax(period, config) {
  const collected = period.orders.filter((o) => {
    if (canonicalOrderStatus(o) === 'CANCELLED') return false;
    const pay = paymentStatus(o.paymentStatus);
    return pay === PAYMENT_STATUS.PAID || pay === PAYMENT_STATUS.REFUNDED;
  });

  const refundByOrder = new Map();
  for (const refund of period.refunds) {
    if (refund.orderId) refundByOrder.set(String(refund.orderId), refund);
  }

  let taxableSales = 0;
  let vatCollected = 0;
  let vatRefunded = 0;
  let vatInclusiveOrders = 0;
  let vatExemptOrders = 0;

  const transactions = collected.map((order) => {
    const vat = orderVat(order, config);
    const refund = refundByOrder.get(String(order._id));
    const refundedAmount = refund ? num(refund.amount) : 0;
    // A refund in this system returns the food subtotal, so it only carries
    // VAT when it covers more than the food. Anything above the food
    // subtotal is treated as the VAT that was returned.
    const vatPortionOfRefund = refund
      ? round2(Math.min(Math.max(0, refundedAmount - orderSubtotal(order)), vat.amount))
      : 0;

    taxableSales += vat.base;
    vatCollected += vat.amount;
    vatRefunded += vatPortionOfRefund;
    if (vat.enabled && vat.rate > 0) vatInclusiveOrders += 1;
    else vatExemptOrders += 1;

    return {
      orderId: order.orderId,
      orderRef: String(order._id),
      date: toISODate(order.createdAt),
      orderType: order.orderType,
      gross: round2(num(order.totalAmount)),
      foodSubtotal: orderSubtotal(order),
      serviceFee: round2(num(order.serviceFee)),
      deliveryFee: round2(num(order.deliveryFee)),
      taxableBase: vat.base,
      vatRate: vat.rate,
      vatAmount: vat.amount,
      vatRefunded: vatPortionOfRefund,
      netVat: round2(vat.amount - vatPortionOfRefund),
      paymentStatus: order.paymentStatus,
      refundStatus: refund ? refund.status : order.refundStatus || 'NONE',
      refundedAmount,
      refundedAt: refund ? refund.refundedAt : order.refundedAt || null,
    };
  });

  transactions.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const months = new Map();
  for (const tx of transactions) {
    const key = String(tx.date || '').slice(0, 7) || 'unknown';
    if (!months.has(key)) {
      months.set(key, { month: key, taxableSales: 0, vatCollected: 0, vatRefunded: 0, transactions: 0 });
    }
    const entry = months.get(key);
    entry.taxableSales += tx.taxableBase;
    entry.vatCollected += tx.vatAmount;
    entry.vatRefunded += tx.vatRefunded;
    entry.transactions += 1;
  }

  return {
    transactionCount: transactions.length,
    taxableSales: round2(taxableSales),
    vatCollected: round2(vatCollected),
    vatRefunded: round2(vatRefunded),
    netVatRetained: round2(vatCollected - vatRefunded),
    vatInclusiveOrders,
    vatExemptOrders,
    transactions,
    monthlyBreakdown: Array.from(months.values())
      .map((m) => ({
        month: m.month,
        taxableSales: round2(m.taxableSales),
        vatCollected: round2(m.vatCollected),
        vatRefunded: round2(m.vatRefunded),
        netVatRetained: round2(m.vatCollected - m.vatRefunded),
        transactions: m.transactions,
      }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  };
}

/**
 * Taxable sales / VAT trend buckets (day, week, month) for the tax report.
 */
function buildTaxTrends(range, transactions, vatRate) {
  var bucketEnd = range.end;
  if (range.period === 'year') {
    var local = zonedNow(range.start);
    bucketEnd = new Date(Date.UTC(local.getUTCFullYear() + 1, 0, 1) - TZ_OFFSET_MS);
  }
  const daily = [];
  for (let t = range.start.getTime(); t < bucketEnd.getTime(); t += DAY_MS) {
    daily.push({
      date: toISODate(new Date(t)),
      label: toISODate(new Date(t)),
      taxableSales: 0,
      vatCollected: 0,
      vatRefunded: 0,
      transactions: 0,
      vatRate: vatRate || 0,
    });
  }
  const dailyIndex = new Map(daily.map((b) => [b.date, b]));

  for (const tx of transactions) {
    const bucket = dailyIndex.get(tx.date);
    if (!bucket) continue;
    bucket.taxableSales += tx.taxableBase;
    bucket.vatCollected += tx.vatAmount;
    bucket.vatRefunded += tx.vatRefunded;
    bucket.transactions += 1;
    if (tx.vatRate) bucket.vatRate = tx.vatRate;
  }

  for (const bucket of daily) {
    bucket.taxableSales = round2(bucket.taxableSales);
    bucket.vatCollected = round2(bucket.vatCollected);
    bucket.vatRefunded = round2(bucket.vatRefunded);
  }

  const aggregate = (keyFn, labelFn) => {
    const map = new Map();
    for (const bucket of daily) {
      const key = keyFn(bucket.date);
      if (!map.has(key)) {
        map.set(key, {
          date: key,
          label: labelFn(key),
          taxableSales: 0,
          vatCollected: 0,
          vatRefunded: 0,
          transactions: 0,
          vatRate: vatRate || 0,
        });
      }
      const target = map.get(key);
      target.taxableSales += bucket.taxableSales;
      target.vatCollected += bucket.vatCollected;
      target.vatRefunded += bucket.vatRefunded;
      target.transactions += bucket.transactions;
      if (bucket.vatRate) target.vatRate = bucket.vatRate;
    }
    return Array.from(map.values())
      .map((b) => ({
        ...b,
        taxableSales: round2(b.taxableSales),
        vatCollected: round2(b.vatCollected),
        vatRefunded: round2(b.vatRefunded),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  };

  return {
    daily,
    weekly: aggregate(
      (date) => weekKey(new Date(`${date}T00:00:00.000Z`)),
      (date) => `Week of ${date}`
    ),
    monthly: aggregate(
      (date) => date.slice(0, 7),
      (date) => monthLabel(date.slice(0, 7))
    ),
    yearly: aggregate(
      (date) => date.slice(0, 4),
      (date) => date.slice(0, 4)
    ),
  };
}

/**
 * VAT / tax compliance report for a period.
 *
 * Tax is reported on the sales that were actually collected, the VAT of the
 * successfully processed refunds is subtracted, and every transaction is
 * listed so the report can be exported and remitted.
 *
 * @param {{cafeteriaId: any, global: boolean}} scope
 * @param {{period: string, start: Date, end: Date}} range
 * @param {{limit?: number}} [options]
 */
async function getTaxReport(scope, range, options = {}) {
  const config = await loadTaxConfig();
  const period = await loadPeriod(scope, range);
  const limit = Math.min(500, Math.max(1, parseInt(options.limit, 10) || 100));

  const tax = summariseTax(period, config);

  return {
    generatedAt: new Date(),
    period: range.period,
    range: formatRange(range),
    currency: config.currency,
    tax: {
      vatEnabled: config.vatEnabled,
      configuredVatRate: config.vatRate,
      taxAuthorityName: config.taxAuthorityName,
      vatNumber: config.vatNumber,
    },
    transactionCount: tax.transactionCount,
    taxableSales: tax.taxableSales,
    vatCollected: tax.vatCollected,
    vatRefunded: tax.vatRefunded,
    netVatRetained: tax.netVatRetained,
    vatInclusiveOrders: tax.vatInclusiveOrders,
    vatExemptOrders: tax.vatExemptOrders,
    monthlyBreakdown: tax.monthlyBreakdown,
    trends: buildTaxTrends(range, tax.transactions, config.vatRate),
    transactions: tax.transactions.slice(0, limit),
    transactionsTruncated: tax.transactions.length > limit,
    totalTransactions: tax.transactions.length,
  };
}

module.exports = {
  getFinancialReport,
  getTaxReport,
  loadTaxConfig,
  orderVat,
  orderSubtotal,
  taxableBase,
  summarise,
  summariseTax,
  buildTaxTrends,
};
