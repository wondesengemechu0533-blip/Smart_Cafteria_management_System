const mongoose = require('mongoose');
const Order = require('../models/Order');
const MenuItem = require('../models/MenuItem');
const StockTransaction = require('../models/StockTransaction');
const Notification = require('../models/Notification');
const Cancellation = require('../models/Cancellation');
const { CANCELLATION_STATUS, CANCELLATION_FLOW_STATUS, REFUND_STATUS } = require('../config/constants');

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

  const cancellation = await Cancellation.create({
    orderId: order._id,
    customerId: order.userId,
    reason: reason || 'OTHER',
    description: description || '',
    status: CANCELLATION_FLOW_STATUS.REQUESTED,
    requestedAt: new Date(),
    paymentStatus: order.paymentStatus || 'PENDING',
    refundStatus: REFUND_STATUS.NOT_REQUIRED,
    inventoryRestored: false,
    isActive: true,
  });

  // Keep order flat fields in sync (backward compatible w/ existing frontend + admin-orders.js)
  order.cancellationRequested = true;
  order.cancellationReason = description || reason;
  order.cancellationDetails = description || '';
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
    const orderIsCancelled = String(order.orderStatus || '').toUpperCase() === 'CANCELLED' || String(order.status || '').toLowerCase() === 'cancelled';
    if (!orderIsPaid || !orderIsCancelled) {
      throw Object.assign(new Error('Order is not eligible for a refund (order must be cancelled and paid)'), { statusCode: 400 });
    }
  }

  // Duplicate refund protection: only allow requesting if never started, or if
  // already REFUND_REQUESTED (idempotent - allows continuing toward processing).
  if ([REFUND_STATUS.REFUND_PROCESSING, REFUND_STATUS.REFUND_APPROVED, REFUND_STATUS.REFUNDED].includes(cancellation.refundStatus)) {
    throw Object.assign(new Error(`Refund already ${cancellation.refundStatus.toLowerCase()} for this cancellation`), { statusCode: 409 });
  }

  const refundAmount = Number.isFinite(Number(amount)) ? Number(amount) : (order ? order.totalAmount : 0);

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
    const orderIsCancelled = String(order.orderStatus || '').toUpperCase() === 'CANCELLED' || String(order.status || '').toLowerCase() === 'cancelled';
    if (!orderIsPaid || !orderIsCancelled) {
      throw Object.assign(new Error('Order is not eligible for a refund (order must be cancelled and paid)'), { statusCode: 400 });
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
      title: 'Order Cancelled & Refunded',
      message: `Your order #${order.orderId} has been cancelled and your payment of ${cancellation.refundAmount} ETB has been refunded. Refund reference: ${cancellation.refundReference}.`,
      type: 'order',
      orderId: order.orderId,
      isRead: false,
    });
  }

  try {
    const { emitSocketEvent } = require('../utils/socket');
    if (order) {
      if (createdNotification) emitSocketEvent(`user:${order.userId}`, 'notification:new', createdNotification);
      const payload = { orderId: order.orderId, status: order.status || 'cancelled', orderType: order.orderType, paymentStatus: 'REFUNDED' };
      emitSocketEvent(`order:${order.orderId}`, 'order:status', payload);
      emitSocketEvent('kitchen', 'order:status', payload);
      emitSocketEvent('admin', 'order:status', payload);
      emitSocketEvent(`user:${order.userId}`, 'order:status', payload);
    }
  } catch (_) { /* realtime is best effort */ }

  return cancellation;
}

/**
 * Mark a refund as failed after a provider error.
 */
async function failRefund({ cancellation, order, error }) {
  if (!cancellation) throw Object.assign(new Error('Cancellation record not found'), { statusCode: 404 });
  cancellation.refundStatus = REFUND_STATUS.REFUND_FAILED;
  cancellation.adminNote = (cancellation.adminNote ? cancellation.adminNote + ' ' : '') + `Refund failed: ${error || 'provider error'}`;
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
async function cancelOrderForApproval({ order, cancellation, actorId, adminNote }) {
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
  return { order, stock };
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
  cancelOrderForApproval,
  serializeCancellation,
};
