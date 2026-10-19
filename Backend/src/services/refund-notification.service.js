/**
 * Refund Notification Service
 *
 * The ONE place that tells a customer their refund went through.
 *
 * Every refund path (the cancellation flow, the admin order button, the admin
 * payments page, the standalone Refund ledger) funnels through here so the
 * wording, the deduplication and the delivery are identical everywhere - and so
 * a success notice can never be produced by a path that forgot to check.
 *
 * Contract:
 *   - Persist first, emit second. The DB row is the source of truth, so a
 *     dropped socket frame only costs live-ness: the customer's notification
 *     panel (GET /notifications) and badge (GET /notifications/unread) both
 *     read the same row, which is why it survives a refresh or a new login.
 *   - Deduplicated on `eventKey` = `refund:processed:<orderId>`, backed by the
 *     partial unique index on {userId, eventKey}. Retrying the same refund -
 *     a double click, a retried request, a webhook replayed by the provider -
 *     updates nothing and emits nothing.
 *   - Never throws. The money has already moved by the time this runs, so a
 *     notification problem must never turn a completed refund into a 500.
 */

const Notification = require('../models/Notification');
const { emitSocketEvent } = require('../utils/socket');
const { computeRefundSummary } = require('../utils/money');

const round2 = (value) => Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;

/** Stable identity of "the refund for this order completed", for dedupe. */
function buildRefundEventKey(orderId) {
  return orderId ? `refund:processed:${orderId}` : null;
}

/** The amount actually refunded, preferring the value the refund pipeline settled on. */
function resolveRefundedAmount(order, cancellation) {
  const candidates = [
    cancellation && cancellation.refundAmount,
    order && order.refundAmount,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return round2(n);
  }
  return order ? computeRefundSummary(order).refundAmount : 0;
}

/**
 * Build the customer-facing refund notice.
 *
 * Required copy:
 *   "Your refund has been processed successfully. Order #[OrderNumber].
 *    Refund Amount: [Amount] ETB."
 *
 * When `simulated` is set the provider was never actually instructed to move
 * money, so an honest caveat is appended rather than letting the customer
 * believe funds are on the way.
 */
function buildRefundMessage({ orderId, amount, simulated }) {
  const base = `Your refund has been processed successfully. Order #${orderId}. Refund Amount: ${amount.toFixed(2)} ETB.`;
  if (!simulated) return base;
  return `${base} This refund was recorded without a payment-provider transfer; contact support if the funds have not reached your account.`;
}

/**
 * Notify a customer that their refund completed.
 *
 * Call this ONLY after the order and payment have both been persisted as
 * REFUNDED - a success notice must never precede (or survive) a failure.
 *
 * @param {object} params
 * @param {object} params.order        Order document (must carry userId + orderId).
 * @param {object} [params.cancellation] Cancellation carrying the settled refundAmount.
 * @param {boolean} [params.simulated] True when no provider transfer happened.
 * @returns {Promise<{created:boolean, notification:object|null, reason?:string}>}
 */
async function notifyRefundProcessed({ order, cancellation = null, simulated = false }) {
  if (!order || !order.userId) {
    return { created: false, notification: null, reason: 'no-recipient' };
  }

  const orderId = order.orderId;
  const amount = resolveRefundedAmount(order, cancellation);
  const status = String(order.refundStatus || 'REFUNDED').toUpperCase();
  const refundedAt = order.refundedAt || new Date();

  const title = 'Refund Processed';
  const message = buildRefundMessage({ orderId, amount, simulated });
  const link = `/src/pages/customer/order-tracking.html?orderId=${encodeURIComponent(orderId || '')}`;
  const eventKey = buildRefundEventKey(orderId);

  let notification;
  let created = false;
  try {
    // Check first so a retry is a cheap no-op, then rely on the unique index to
    // make the write itself safe - two concurrent retries can both pass the
    // check, but only one can win the insert.
    if (eventKey) {
      const existing = await Notification.findOne({ userId: order.userId, eventKey }).lean();
      if (existing) {
        return { created: false, notification: existing, reason: 'duplicate' };
      }
    }

    notification = await Notification.create({
      userId: order.userId,
      title,
      message,
      type: 'refund',
      orderId: orderId || null,
      link,
      eventKey: eventKey || undefined,
      meta: {
        refundStatus: status,
        refundAmount: amount,
        paymentStatus: order.paymentStatus || 'REFUNDED',
        refundedAt: refundedAt instanceof Date ? refundedAt.toISOString() : new Date().toISOString(),
        refundReference: cancellation?.refundReference || order.refundReference || null,
        simulated: Boolean(simulated),
      },
      isRead: false,
    });
    created = true;
  } catch (error) {
    // 11000 = lost the insert race against a concurrent retry. That is the
    // desired outcome, not a failure.
    if (error && error.code === 11000) {
      const existing = eventKey
        ? await Notification.findOne({ userId: order.userId, eventKey }).lean()
        : null;
      return { created: false, notification: existing, reason: 'duplicate' };
    }
    console.warn('Refund notification persist failed:', error.message);
    return { created: false, notification: null, reason: 'persist-failed' };
  }

  // Only now, with a durable row in hand, push it live. If this fails the
  // customer still sees it on next load - which is the DB-persistence fallback.
  try {
    emitSocketEvent(`user:${order.userId}`, 'notification:new', {
      id: notification._id,
      title: notification.title,
      message: notification.message,
      type: notification.type,
      orderId: notification.orderId,
      link: notification.link,
      eventKey: notification.eventKey || null,
      meta: notification.meta || {},
      isRead: notification.isRead,
      createdAt: notification.createdAt,
    });
  } catch (error) {
    console.warn('Refund notification socket emit failed:', error.message);
  }

  return { created: true, notification };
}

module.exports = {
  notifyRefundProcessed,
  buildRefundMessage,
  buildRefundEventKey,
  resolveRefundedAmount,
  REFUND_NOTIFICATION_TITLE: 'Refund Processed',
};
