const Refund = require('../models/Refund');
const Cancellation = require('../models/Cancellation');
const { cafeteriaFilter } = require('./cafeteria');

/**
 * Refund states that mean "money was (or will be) given back".
 * A cancellation that never reached REFUNDED is not a refund.
 */
const CANCELLATION_REFUND_STATUSES = [
  'REFUND_REQUESTED',
  'REFUND_APPROVED',
  'REFUND_PROCESSING',
  'REFUNDED',
  'REFUND_FAILED',
];

function normalizeStatus(value) {
  if (!value) return null;
  return String(value).toUpperCase();
}

/**
 * Expand a coarse status filter into the concrete stored values.
 */
function expandStatusFilter(statusFilter) {
  if (!statusFilter || statusFilter === 'ALL') return null;
  if (statusFilter === 'APPROVED') return ['APPROVED', 'REFUND_APPROVED', 'REFUND_PROCESSING'];
  return [statusFilter];
}

/**
 * Collapse the two vocabularies into one report-friendly status.
 */
function reportStatus(raw) {
  const s = normalizeStatus(raw);
  if (s === 'REFUND_APPROVED' || s === 'REFUND_PROCESSING') return 'APPROVED';
  return s;
}

/**
 * Load every refund that belongs to a scope, regardless of which ledger it was
 * written to.
 *
 * A refund can be recorded in two places:
 *   - the standalone Refund ledger (POST /refunds -> PATCH /refunds/:id/complete)
 *   - the Cancellation flow (POST /cancellations/:id/refund/confirm)
 *
 * Both write the same flat flags onto the order and the payment, so the two
 * ledgers have to be merged or a report would silently miss half of the
 * refunds. This helper is the single place that knows about both.
 *
 * @param {{cafeteriaId: any, global: boolean}} scope
 * @param {{start: Date, end: Date}} range
 * @param {string} [statusFilter] ALL (default) or a concrete status
 * @returns {Promise<Array<object>>} refund rows, newest first
 */
async function loadRefundRows(scope, range, statusFilter) {
  const dateMatch = { $gte: range.start, $lt: range.end };
  const expanded = expandStatusFilter(statusFilter);
  const scopeFilter = cafeteriaFilter(scope);

  const refundMatch = { ...scopeFilter, $and: [{ createdAt: dateMatch }] };
  if (expanded) refundMatch.status = { $in: expanded };

  const standalone = await Refund.find(refundMatch)
    .select(
      'refundNumber orderId paymentId amount reason status requestedBy processedBy requestedAt approvedAt refundedAt createdAt cafeteriaId'
    )
    .populate('orderId', 'orderId customerName paymentMethod totalAmount subtotal serviceFee deliveryFee vatAmount taxAmount vatRate vatEnabled cafeteriaId')
    .populate('paymentId', 'method')
    .populate('requestedBy', 'name role')
    .lean();

  const standaloneRows = standalone
    .filter((r) => {
      if (scope && !scope.global && r.cafeteriaId) {
        return String(r.cafeteriaId) === String(scope.cafeteriaId);
      }
      if (scope && !scope.global && r.orderId && r.orderId.cafeteriaId) {
        return String(r.orderId.cafeteriaId) === String(scope.cafeteriaId);
      }
      return true;
    })
    .map((r) => ({
      source: 'refund',
      orderId: r.orderId ? r.orderId._id : null,
      refundNumber: r.refundNumber || '-',
      orderRef: r.orderId && r.orderId.orderId ? r.orderId.orderId : '-',
      customerName: r.orderId && r.orderId.customerName ? r.orderId.customerName : '-',
      amount: Number(r.amount) || 0,
      reason: r.reason || '-',
      status: reportStatus(r.status),
      rawStatus: normalizeStatus(r.status),
      paymentMethod:
        r.paymentId && r.paymentId.method ? r.paymentId.method : (r.orderId && r.orderId.paymentMethod) || '-',
      requestedBy: r.requestedBy && r.requestedBy.name ? r.requestedBy.name : '-',
      requestedAt: r.requestedAt || r.createdAt,
      createdAt: r.createdAt,
      refundedAt: r.refundedAt || null,
      order: r.orderId || null,
    }));

  const cancelMatch = {
    refundStatus: { $in: CANCELLATION_REFUND_STATUSES },
    createdAt: dateMatch,
  };
  if (expanded) {
    const cancelStatuses = [];
    for (const s of expanded) {
      if (s === 'APPROVED') cancelStatuses.push('REFUND_APPROVED', 'REFUND_PROCESSING');
      else if (CANCELLATION_REFUND_STATUSES.includes(s)) cancelStatuses.push(s);
    }
    cancelMatch.refundStatus = { $in: cancelStatuses };
  }

  const cancellations = await Cancellation.aggregate([
    { $match: cancelMatch },
    { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'order' } },
    { $unwind: { path: '$order', preserveNullAndEmptyArrays: false } },
    ...(scope && !scope.global ? [{ $match: { 'order.cafeteriaId': scope.cafeteriaId } }] : []),
    { $lookup: { from: 'users', localField: 'customerId', foreignField: '_id', as: 'customer' } },
    { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
    {
      $lookup: { from: 'users', localField: 'processedBy', foreignField: '_id', as: 'processor' },
    },
    { $unwind: { path: '$processor', preserveNullAndEmptyArrays: true } },
    { $sort: { createdAt: -1 } },
  ]);

  const cancellationRows = cancellations.map((c) => ({
    source: 'cancellation',
    orderId: c.order ? c.order._id : c.orderId,
    refundNumber: c.refundReference || c.cancellationNumber || '-',
    orderRef: c.order.orderId || '-',
    customerName: c.order.customerName || (c.customer && c.customer.name) || '-',
    amount: Number(c.refundAmount) || 0,
    reason: c.description || c.reason || '-',
    status: reportStatus(c.refundStatus),
    rawStatus: normalizeStatus(c.refundStatus),
    paymentMethod: c.order.paymentMethod || '-',
    requestedBy: (c.customer && c.customer.name) || (c.processor && c.processor.name) || '-',
    requestedAt: c.requestedAt || c.createdAt,
    createdAt: c.createdAt,
    refundedAt: c.completedAt || null,
    order: c.order || null,
  }));

  const rows = standaloneRows.concat(cancellationRows);
  rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return rows;
}

/**
 * Only the refunds that were actually processed successfully.
 *
 * A requested / approved / processing / failed / rejected refund has NOT
 * returned any money yet, so it must never be counted as money returned.
 *
 * @returns {Promise<Array<object>>} processed refunds, one per order.
 */
async function loadProcessedRefunds(scope, range) {
  const rows = await loadRefundRows(scope, range, 'REFUNDED');
  const seen = new Set();
  const processed = [];
  for (const row of rows) {
    if (row.status !== 'REFUNDED') continue;
    const key = row.orderId ? String(row.orderId) : `refund:${row.refundNumber}`;
    if (seen.has(key)) continue; // the same refund can exist in both ledgers
    seen.add(key);
    processed.push(row);
  }
  return processed;
}

module.exports = {
  CANCELLATION_REFUND_STATUSES,
  expandStatusFilter,
  reportStatus,
  loadRefundRows,
  loadProcessedRefunds,
};
