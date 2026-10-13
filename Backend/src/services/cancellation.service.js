const mongoose = require('mongoose');
const Order = require('../models/Order');
const MenuItem = require('../models/MenuItem');
const StockTransaction = require('../models/StockTransaction');
const Notification = require('../models/Notification');
const Cancellation = require('../models/Cancellation');
const { CANCELLATION_STATUS, CANCELLATION_FLOW_STATUS, REFUND_STATUS } = require('../config/constants');

const CANCELLATION_REASON_VALUES = new Set([
  'CUSTOMER_CHANGED_MIND',
  'ORDERED_BY_MISTAKE',
  'LONG_PREPARATION_TIME',
  'FOOD_UNAVAILABLE',
  'PAYMENT_ISSUE',
  'DUPLICATE_ORDER',
  'CAFETERIA_ISSUE',
  'OTHER',
]);

function normalizeCancellationReason(reason) {
  const value = String(reason || '').trim().toUpperCase().replace(/\s+/g, '_');
  return CANCELLATION_REASON_VALUES.has(value) ? value : 'OTHER';
}

/**
 * Cancellation Service
 *
 * Reusable, idempotent operations shared by the cancellation controller and
 * the admin order controller. Every business operation:
 *   - validates order/cancellation state before mutating
 *   - prevents duplicate operations (idempotency flags + guards)
 *   - keeps the standalone Cancellation record and the Order flat fields in sync
 *   - records stock, refund, and audit history
 */

/**
 * Resolve an order by its human-friendly orderId OR its ObjectId.
 */
async function resolveOrder(id) {
  if (!id) return null;
  if (mongoose.Types.ObjectId.isValid(id)) {
    const byId = await Order.findById(id);
    if (byId) return byId;
  }
  return Order.findOne({ orderId: String(id) });
}

/**
 * Resolve the active (isActive) Cancellation document for an order.
 */
async function findActiveCancellation(order) {
  if (!order) return null;
  return Cancellation.findOne({ orderId: order._id, isActive: true });
}

/**
 * Create a standalone Cancellation record and sync its fields onto the order.
 * Used when a customer (or admin) requests a cancellation.
 */
async function createCancellation(order, actor, { reason, description, adminNote, source }) {
  if (!order) throw Object.assign(new Error('Order not found'), { statusCode: 404 });

  if (order.cancellationRequested) {
    throw Object.assign(new Error('Cancellation already requested for this order'), { statusCode: 409 });
  }

  const existing = await Cancellation.findOne({ orderId: order._id, isActive: true });
  if (existing) {
    throw Object.assign(new Error('A cancellation record already exists for this order'), { statusCode: 409 });
  }

  const normalizedReason = normalizeCancellationReason(reason);
  const normalizedDescription = String(
    description || (normalizedReason === 'OTHER' ? reason || '' : '')
  ).slice(0, 500);

  const cancellation = await Cancellation.create({
    orderId: order._id,
    customerId: order.userId,
    reason: normalizedReason,
    description: normalizedDescription,
    status: CANCELLATION_FLOW_STATUS.REQUESTED,
    requestedAt: new Date(),
    paymentStatus: order.paymentStatus || 'PENDING',
    refundStatus: REFUND_STATUS.NOT_REQUIRED,
    inventoryRestored: false,
    isActive: true,
  });

  // Keep order flat fields in sync (backward compatible w/ existing frontend + admin-orders.js)
  order.cancellationRequested = true;
  order.cancellationReason = normalizedDescription || normalizedReason;
  order.cancellationDetails = normalizedDescription;
  order.cancellationStatus = CANCELLATION_STATUS.PENDING;
  order.cancellationRequestedAt = new Date();
  order.cancellationAdminNote = adminNote || '';
  await order.save();

  return { cancellation, order };
}

/**
 * Idempotently restore the stock quantities reserved for an order's items.
 * Only runs once per order; creates one StockTransaction per restored item.
 */
async function restoreStock(order, actorId) {
  if (!order) return { restored: false, reason: 'no-order' };
  if (order.inventoryRestored) return { restored: false, reason: 'already-restored' };

  const restoredItems = [];
  for (const orderItem of order.items || []) {
    if (!orderItem.itemId) continue;
    const food = await MenuItem.findByIdAndUpdate(
      orderItem.itemId,
      { $inc: { stockQuantity: orderItem.quantity } },
      { new: true }
    );
    if (!food) continue;

    if (food.availability === false) {
      food.availabilityStatus = 'UNAVAILABLE';
    } else {
      food.availabilityStatus = food.stockQuantity > 0 ? 'AVAILABLE' : 'OUT_OF_STOCK';
    }
    await food.save();

    await StockTransaction.create({
      foodId: food._id,
      previousQuantity: food.stockQuantity - orderItem.quantity,
      quantityChanged: orderItem.quantity,
      newQuantity: food.stockQuantity,
      action: 'CANCELLATION_RESTORE',
      performedBy: actorId || null,
      orderId: order._id,
    });

    restoredItems.push({ itemId: food._id, quantity: orderItem.quantity });
  }

  order.inventoryRestored = true;
  await order.save();

  return { restored: true, items: restoredItems };
}

/**
 * Begin a refund for an approved cancellation.
 *
 * Marks the refund as REQUESTED (simulated provider request) and returns the
 * refund payload. Completion is only achieved later via confirmRefund() after a
 * provider confirmation — never here. Guards against duplicate refund requests.
 */
async function requestRefund({ order, cancellation, amount, actorId }) {
  if (!cancellation) throw Object.assign(new Error('Cancellation record not found'), { statusCode: 404 });

  // Refund eligibility guard: the order must be cancelled AND its payment must
  // have succeeded. Orders that are still active, unpaid, or non-refundable are
  // rejected so a refund can never be issued for them.
  if (order) {
    const orderIsPaid = ['PAID', 'REFUNDED'].includes(String(order.paymentStatus || '').toUpperCase());
    const orderIsCancelled =
      String(order.orderStatus || '').toUpperCase() === 'CANCELLED' ||
      String(order.status || '').toLowerCase() === 'cancelled';
    if (!orderIsPaid || !orderIsCancelled) {
      throw Object.assign(new Error('Order is not eligible for a refund (order must be cancelled and paid)'), {
        statusCode: 400,
      });
    }
  }

  // Duplicate refund protection: only allow requesting if never started, or if
  // already REFUND_REQUESTED (idempotent - allows continuing toward processing).
  if (
    [REFUND_STATUS.REFUND_PROCESSING, REFUND_STATUS.REFUND_APPROVED, REFUND_STATUS.REFUNDED].includes(
      cancellation.refundStatus
    )
  ) {
    throw Object.assign(new Error(`Refund already ${cancellation.refundStatus.toLowerCase()} for this cancellation`), {
      statusCode: 409,
    });
  }

  // Refund is the original order SUBTOTAL only: the VAT portion (and fees)
  // are never refunded. Prefer the stored subtotal; fall back to
  // Total Paid - VAT if the subtotal is missing/legacy zero. An explicit
  // admin-set amount (including 0) is honored with no double VAT deduction.
  const subtotal = order && Number(order.subtotal) > 0 ? Number(order.subtotal) : null;
  const vatCut = order && Number(order.vatAmount) > 0 ? Number(order.vatAmount) : 0;
  const fallback = order ? Math.max(0, (Number(order.totalAmount) || 0) - vatCut) : 0;
  const defaultRefund = subtotal != null ? subtotal : fallback;
  const refundAmount = Number.isFinite(Number(amount)) ? Number(amount) : defaultRefund;

  cancellation.refundStatus = REFUND_STATUS.REFUND_REQUESTED;
  cancellation.refundAmount = refundAmount;
  if (order) {
    order.refundStatus = REFUND_STATUS.REFUND_REQUESTED;
    order.refundAmount = refundAmount;
    await order.save();
  }
  await cancellation.save();

  return {
    refundStatus: cancellation.refundStatus,
    refundAmount,
    refundReference: cancellation.refundReference,
  };
}

/**
 * Mark a refund as processing (after the provider accepts the request).
 */
async function markRefundProcessing({ cancellation, order, reference }) {
  if (!cancellation) throw Object.assign(new Error('Cancellation record not found'), { statusCode: 404 });
  cancellation.refundStatus = REFUND_STATUS.REFUND_PROCESSING;
  cancellation.refundReference = reference || cancellation.refundReference || `RF-${Date.now()}`;
  if (order) {
    order.refundStatus = REFUND_STATUS.REFUND_PROCESSING;
    order.refundReference = cancellation.refundReference;
    await order.save();
  }
  await cancellation.save();
  return cancellation;
}

/**
 * Complete a refund — ONLY after the payment provider confirms it.
 * Never called as part of the initial approve flow.
 */
async function confirmRefund({ cancellation, order, providerReference, actorId }) {
  if (!cancellation) throw Object.assign(new Error('Cancellation record not found'), { statusCode: 404 });

  if (cancellation.refundStatus === REFUND_STATUS.REFUNDED) {
    throw Object.assign(new Error('Refund already marked as refunded'), { statusCode: 409 });
  }

  // Refund eligibility guard: the order must be cancelled AND its payment must
  // have succeeded. Orders that are still active, unpaid, or non-refundable are
  // rejected so a refund can never be issued for them.
  if (order) {
    const orderIsPaid = ['PAID', 'REFUNDED'].includes(String(order.paymentStatus || '').toUpperCase());
    const orderIsCancelled =
      String(order.orderStatus || '').toUpperCase() === 'CANCELLED' ||
      String(order.status || '').toLowerCase() === 'cancelled';
    if (!orderIsPaid || !orderIsCancelled) {
      throw Object.assign(new Error('Order is not eligible for a refund (order must be cancelled and paid)'), {
        statusCode: 400,
      });
    }
  }

  cancellation.refundStatus = REFUND_STATUS.REFUNDED;
  cancellation.refundReference = providerReference || cancellation.refundReference || `RF-${Date.now()}`;
  if (order) {
    order.paymentStatus = 'REFUNDED';
    order.refundStatus = REFUND_STATUS.REFUNDED;
    order.refundReference = cancellation.refundReference;
    order.refundAmount = Number(cancellation.refundAmount) || order.totalAmount || 0;
    order.refundedAt = new Date();
    await order.save();
  }
  await cancellation.save();

  let createdNotification = null;
  if (order) {
    createdNotification = await Notification.create({
      userId: order.userId,
      title: 'Payment Refunded',
      message: 'Your payment has been refunded successfully.',
      type: 'order',
      orderId: order.orderId,
      isRead: false,
    });
  }

  // Real-time half of the refund: the customer's tracker and the Manager/Admin
  // dashboards both key off this frame, so it has to carry the refund fields
  // (not just paymentStatus) or a page would keep showing "Refund Required"
  // after the money went back.
  await emitRefundStatus(order, actorId ? 'admin' : 'refund');

  try {
    const { emitSocketEvent } = require('../utils/socket');
    if (order && createdNotification) {
      emitSocketEvent(`user:${order.userId}`, 'notification:new', {
        id: createdNotification._id,
        title: createdNotification.title,
        message: createdNotification.message,
        type: createdNotification.type,
        orderId: createdNotification.orderId,
        link: `/src/pages/customer/order-tracking.html?orderId=${order.orderId}`,
        isRead: createdNotification.isRead,
        createdAt: createdNotification.createdAt,
      });
    }
  } catch (_) {
    /* realtime is best effort */
  }

  return cancellation;
}

/**
 * Broadcast the refund state of an order to every surface that renders it:
 * the customer's order tracker (`user:<id>`), the Manager/Admin dashboard
 * (`admin`) and the per-order room (`order:<id>`). The kitchen is skipped -
 * a refund is not a preparation event.
 *
 * Called whenever `refundStatus` changes so a badge flips to/from
 * "Refund Required" without a page refresh.
 */
async function emitRefundStatus(order, source) {
  if (!order || !order.orderId) return false;
  try {
    const { emitSocketEvent } = require('../utils/socket');
    const payload = {
      ...(typeof order.getSummary === 'function' ? order.getSummary() : {}),
      refundStatus: order.refundStatus || null,
      refundAmount: order.refundAmount || 0,
      refundReference: order.refundReference || null,
      refundedAt: order.refundedAt || null,
      paymentStatus: order.paymentStatus,
      status: order.status,
      orderStatus: order.orderStatus,
      cafeteriaId: order.cafeteriaId || null,
      eventId: `order-refund:${order.orderId}:${order.refundStatus || 'none'}`,
      eventType: 'refund',
      eventSource: source || 'system',
      eventAt: new Date(),
    };
    emitSocketEvent(`order:${order.orderId}`, 'order:status', payload);
    emitSocketEvent('admin', 'order:status', payload);
    if (order.userId) emitSocketEvent(`user:${order.userId}`, 'order:status', payload);
  } catch (_) {
    /* realtime is best effort */
  }
  return true;
}

/**
 * Run a refund end-to-end for a CANCELLED + PAID order:
 * request -> processing -> confirmed (provider confirmation).
 *
 * This is the single entry point every "process refund" button goes through -
 * the admin order modal, the cancellations list and the payments page - so the
 * guards (cancelled, paid, not already refunded), the REFUNDED bookkeeping and
 * the customer notification can never drift apart between them.
 *
 * Returns the Cancellation record that carries refundReference/refundAmount.
 */
async function completeOrderRefund({ order, actorId, amount, providerReference }) {
  if (!order) throw Object.assign(new Error('Order not found'), { statusCode: 404 });

  if (String(order.refundStatus || '').toUpperCase() === REFUND_STATUS.REFUNDED) {
    throw Object.assign(new Error('Refund already processed for this order'), { statusCode: 400 });
  }

  let cancellation = await findActiveCancellation(order);
  if (!cancellation) {
    try {
      const created = await createCancellation(order, actorId ? { id: actorId } : null, {
        reason: 'ADMIN_REFUND',
        description: 'Cancellation refunded by admin',
        adminNote: 'Refunded by admin',
      });
      cancellation = created.cancellation;
      order = created.order;
    } catch (createError) {
      // createCancellation is idempotent-guarded; if it lost a race with an
      // existing record, carry on with that record instead of failing.
      cancellation = await findActiveCancellation(order);
      if (!cancellation) throw createError;
    }
    cancellation.status = CANCELLATION_FLOW_STATUS.CANCELLED;
    cancellation.approvedAt = new Date();
    cancellation.processedBy = actorId || null;
    cancellation.isActive = true;
    await cancellation.save();
    order.orderStatus = 'CANCELLED';
    order.status = 'cancelled';
    order.cancellationStatus = CANCELLATION_STATUS.APPROVED;
    order.cancellationProcessedAt = new Date();
    order.cancellationProcessedBy = actorId || null;
    await order.save();
  }

  // Request -> processing is a pipeline, but the cancellations page may have
  // already moved it to APPROVED/PROCESSING. Re-requesting from there is a
  // 409, so only enter the pipeline when the refund has not started yet.
  const refundState = String(cancellation.refundStatus || '').toUpperCase();
  if (![REFUND_STATUS.REFUND_APPROVED, REFUND_STATUS.REFUND_PROCESSING, REFUND_STATUS.REFUNDED].includes(refundState)) {
    await requestRefund({ order, cancellation, amount, actorId });
  }
  await markRefundProcessing({ order, cancellation, reference: cancellation.refundReference });
  await confirmRefund({ cancellation, order, providerReference: providerReference || cancellation.refundReference, actorId });

  return cancellation;
}

/**
 * Mark a refund as failed after a provider error.
 */
async function failRefund({ cancellation, order, error }) {
  if (!cancellation) throw Object.assign(new Error('Cancellation record not found'), { statusCode: 404 });
  cancellation.refundStatus = REFUND_STATUS.REFUND_FAILED;
  cancellation.adminNote =
    (cancellation.adminNote ? cancellation.adminNote + ' ' : '') + `Refund failed: ${error || 'provider error'}`;
  if (order) {
    order.refundStatus = REFUND_STATUS.REFUND_FAILED;
    await order.save();
  }
  await cancellation.save();
  return cancellation;
}

/**
 * Cancel the order itself (called after an approval decision). Already-guarded
 * so it never re-cancels an order or re-restores stock.
 */
function buildCancellationStatusPayload(order, source, eventAt) {
  if (!order || !order.orderId) return null;

  const summary = typeof order.getSummary === 'function' ? order.getSummary() : {
    orderId: order.orderId,
    customerName: order.customerName,
    orderType: order.orderType,
    items: order.items || [],
    totalAmount: order.totalAmount,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };

  return {
    ...summary,
    status: 'cancelled',
    orderStatus: 'CANCELLED',
    // Not part of getSummary(), but the kitchen notification fan-out scopes
    // recipients by cafeteria, so it has to travel with the payload.
    cafeteriaId: order.cafeteriaId || null,
    eventId: `order-cancelled:${order.orderId}`,
    eventType: 'cancelled',
    eventSource: source || 'system',
    eventAt: eventAt || new Date(),
    cancellationReason: order.cancellationReason || null,
  };
}

/**
 * Broadcast a cancellation to every surface that cares, and give the kitchen a
 * durable, acknowledgeable record of it.
 *
 * This is the SINGLE choke point for "an order was cancelled": the customer's
 * pending-order cancel, the paid-order auto-cancel, the admin cancel, and the
 * cancellation-approval flow all route through here, so the kitchen can never
 * miss a cancellation because a new call site was added somewhere else.
 *
 * The `order:status` socket frames are the real-time half (unchanged). The
 * persisted notification is the durable half: it survives a browser refresh,
 * stays unread until a Kitchen Staff member views it, and is de-duplicated by
 * `eventKey` = `kitchen:cancelled:<orderId>` so a re-broadcast cannot ring a
 * second alert.
 *
 * The KITCHEN half (its room frame + its durable notification) is only sent
 * for an order the kitchen actually knows about: its board is payment-gated
 * (payment successful -> order = PENDING -> kitchen dashboard), so an unpaid
 * order never appeared there and a cancellation must not inject a row the
 * client would store but the server list would never return. The customer,
 * admin and per-order rooms always get the frame.
 */
async function emitCancellationStatus(order, source, eventAt) {
  const payload = buildCancellationStatusPayload(order, source, eventAt);
  if (!payload) return false;

  const paymentNeverConfirmed = ['PENDING', 'FAILED'].includes(String(order.paymentStatus || '').toUpperCase());
  const kitchenKnowsOrder = !(paymentNeverConfirmed && !order.queuedForKitchenAt);

  try {
    const { emitSocketEvent } = require('../utils/socket');
    if (kitchenKnowsOrder) emitSocketEvent('kitchen', 'order:status', payload);
    emitSocketEvent(`order:${order.orderId}`, 'order:status', payload);
    emitSocketEvent('admin', 'order:status', payload);
    if (order.userId) emitSocketEvent(`user:${order.userId}`, 'order:status', payload);
  } catch (_) {
    /* realtime is best effort */
  }

  // Persist the kitchen-facing cancellation notification. A failure here must
  // never roll back a cancellation that has already moved stock and money.
  if (kitchenKnowsOrder) {
    try {
      const { notifyRolesOfCancellation } = require('../controllers/notification.controller');
      await notifyRolesOfCancellation(payload, { cafeteriaScoped: true });
    } catch (error) {
      console.error(`Failed to store kitchen cancellation notification for #${order.orderId}:`, error.message);
    }
  }

  return true;
}

async function cancelOrderForApproval({ order, cancellation, actorId, adminNote, source }) {
  if (!order) throw Object.assign(new Error('Order not found'), { statusCode: 404 });

  order.orderStatus = 'CANCELLED';
  order.status = 'cancelled';
  order.cancellationStatus = CANCELLATION_STATUS.APPROVED;
  order.cancellationAdminNote = adminNote || order.cancellationAdminNote || '';
  order.cancellationProcessedAt = new Date();
  order.cancellationProcessedBy = actorId || null;

  const stock = await restoreStock(order, actorId);

  if (cancellation) {
    cancellation.status = CANCELLATION_FLOW_STATUS.CANCELLED;
    cancellation.approvedAt = new Date();
    cancellation.processedBy = actorId || null;
    cancellation.inventoryRestored = stock.restored;
    await cancellation.save();
  }

  await order.save();
  await syncDeliveryCancellation(order, { actorId, adminNote, source });
  await emitCancellationStatus(order, source, order.cancellationProcessedAt);
  return { order, stock };
}

/**
 * Keep the delivery record in step with an approved cancellation.
 *
 * The Order is authoritative, so cancelling the order must also end the
 * delivery run - otherwise a courier would keep a ghost job on their dashboard
 * and the customer would keep seeing a live rider. Best-effort: a delivery-side
 * problem must never fail a cancellation that already moved money and stock.
 */
async function syncDeliveryCancellation(order, { actorId, adminNote, source } = {}) {
  if (!order || order.orderType !== 'delivery') return null;
  try {
    const deliveryService = require('./delivery.service');
    const existing = await deliveryService.findDeliveryByReference(order, { populateOrder: false });
    if (!existing) return null; // pre-feature order: nothing to sync

    const reason = String(adminNote || '').trim() || 'Order cancelled';
    const result = await deliveryService.applyDeliveryStatus({
      delivery: existing,
      status: deliveryService.DELIVERY_STATUS.CANCELLED,
      actor: actorId ? { id: actorId } : null,
      reason: `Order cancelled (${source || 'system'}): ${reason}`,
      allowTerminal: true,
    });
    return result.delivery;
  } catch (error) {
    console.error(
      `Failed to sync delivery cancellation for order ${order.orderId}:`,
      error.message
    );
    return null;
  }
}

/**
 * Serialize a cancellation for API responses, joined with the order.
 */
async function serializeCancellation(cancellation, order) {
  const itemPrice = (i) => (Number(i.price) || 0) * (Number(i.quantity) || 0);
  return {
    id: cancellation._id,
    cancellationNumber: cancellation.cancellationNumber,
    orderId: order ? order.orderId : null,
    orderObjectId: order ? order._id : null,
    customerName: order ? order.customerName : null,
    customerPhone: order ? order.customerPhone : null,
    userId: order ? order.userId : null,
    reason: cancellation.reason,
    description: cancellation.description,
    status: cancellation.status,
    requestedAt: cancellation.requestedAt,
    approvedAt: cancellation.approvedAt,
    rejectedAt: cancellation.rejectedAt,
    completedAt: cancellation.completedAt,
    adminNote: cancellation.adminNote,
    processedBy: cancellation.processedBy,
    orderAmount: order ? order.totalAmount : 0,
    orderSubtotal: order ? order.subtotal : 0,
    orderVatAmount: order ? Number(order.vatAmount) || 0 : 0,
    serviceFee: order ? order.serviceFee : 0,
    paymentStatus: order ? order.paymentStatus : cancellation.paymentStatus,
    paymentMethod: order ? order.paymentMethod : null,
    refundStatus: cancellation.refundStatus,
    refundAmount: cancellation.refundAmount,
    refundReference: cancellation.refundReference,
    inventoryRestored: cancellation.inventoryRestored,
    orderStatus: order ? order.status : null,
    orderType: order ? order.orderType : null,
    tableNumber: order ? order.tableNumber : null,
    items: order
      ? (order.items || []).map((i) => ({
          name: i.name,
          quantity: i.quantity,
          price: i.price,
          subtotal: i.subtotal || itemPrice(i),
        }))
      : [],
    createdAt: cancellation.createdAt,
    updatedAt: cancellation.updatedAt,
  };
}

module.exports = {
  resolveOrder,
  findActiveCancellation,
  createCancellation,
  restoreStock,
  requestRefund,
  markRefundProcessing,
  confirmRefund,
  failRefund,
  buildCancellationStatusPayload,
  emitCancellationStatus,
  emitRefundStatus,
  completeOrderRefund,
  cancelOrderForApproval,
  syncDeliveryCancellation,
  serializeCancellation,
};
