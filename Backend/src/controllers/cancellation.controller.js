const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Notification = require('../models/Notification');
const Cancellation = require('../models/Cancellation');
const { PAYMENT_STATUS, CANCELLATION_STATUS, CANCELLATION_FLOW_STATUS, REFUND_STATUS, MESSAGES, HTTP_STATUS } = require('../config/constants');
const { logAction } = require('../utils/audit');
const svc = require('../services/cancellation.service');

/**
 * Get the order behind a Cancellation (or null).
 */
async function loadOrder(cancellation) {
  if (!cancellation) return null;
  if (cancellation.populated && cancellation.populated('orderId') && cancellation.orderId) {
    return cancellation.orderId;
  }
  if (cancellation.orderId) {
    const oid = String(cancellation.orderId._id || cancellation.orderId);
    return Order.findById(oid);
  }
  return null;
}

/**
 * Build a query for the standalone Cancellation collection including filters
 * that require joining against the Order collection.
 */
async function buildCancellationFilter(query) {
  const filter = { isActive: { $ne: false } };

  const { status, paymentStatus, refundStatus, date, search, from, to } = query;

  if (status && status !== 'all') {
    const s = String(status).toUpperCase();
    if (Object.values(CANCELLATION_FLOW_STATUS).includes(s)) filter.status = s;
  }
  if (refundStatus && refundStatus !== 'all') {
    filter.refundStatus = String(refundStatus).toUpperCase();
  }

  // Date filtering on requestedAt (support exact date or range)
  if (date) {
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(`${date}T23:59:59.999Z`);
    if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
      filter.requestedAt = { $gte: start, $lte: end };
    }
  } else if (from || to) {
    const range = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lte = new Date(to);
    if (Object.keys(range).length) filter.requestedAt = range;
  }

  // Order-facing filters (payment status / search) require a join to Order.
  let restrictedOrderIds = null;
  if (search || (paymentStatus && paymentStatus !== 'all')) {
    const orderFilter = [];
    if (paymentStatus && paymentStatus !== 'all') {
      orderFilter.push({ paymentStatus: String(paymentStatus).toUpperCase() });
    }
    if (search) {
      const term = String(search).trim();
      const orClause = [
        { orderId: { $regex: term, $options: 'i' } },
        { customerName: { $regex: term, $options: 'i' } },
        { customerPhone: { $regex: term, $options: 'i' } },
      ];
      if (mongoose.Types.ObjectId.isValid(term)) orClause.push({ _id: term });
      orderFilter.push({ $or: orClause });
    }
    const matching = await Order.find({ $and: orderFilter }).select('_id').lean();
    restrictedOrderIds = matching.map((o) => o._id);
    if (!restrictedOrderIds.length) restrictedOrderIds = [null]; // force empty result
    filter.orderId = { $in: restrictedOrderIds };
  }

  // Allow direct search by the standalone cancellation number too.
  if (search && String(search).trim()) {
    const term = String(search).trim();
    const numberMatch = { cancellationNumber: { $regex: term, $options: 'i' } };
    if (filter.orderId) {
      filter.$or = [{ orderId: filter.orderId }, numberMatch];
      delete filter.orderId;
    } else {
      filter.cancellationNumber = { $regex: term, $options: 'i' };
    }
  }

  return filter;
}

/**
 * @desc    Request order cancellation (creates standalone Cancellation record)
 * @route   POST /api/v1/cancellations/request
 * @access  Private
 * Body: { orderId, reason, details }
 */
exports.requestCancellation = async (req, res) => {
  try {
    const { orderId, reason, details } = req.body;
    if (!orderId || !reason) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Order ID and reason are required' });
    }

    const order = await svc.resolveOrder(orderId);
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }

    let isOwner = false;
    if (order.userId) isOwner = String(order.userId) === String(req.user.id);
    if (!isOwner && req.user.role !== 'admin') {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'You can only cancel your own orders' });
    }

    const current = String(order.orderStatus || order.status || '').toUpperCase();

    // Cancellation is only allowed while the order is still awaiting
    // preparation (PENDING / RECEIVED). Once the kitchen begins preparing the
    // order, the food may already be cooked, so a cancellation is no longer
    // permitted. This guarantees any approved cancellation always happened
    // before preparation, so a full refund is always valid.
    const CANCELLABLE = ['PENDING', 'RECEIVED'];
    if (!CANCELLABLE.includes(current)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `This order can no longer be cancelled because it has already entered the "${current || 'active'}" stage. Cancellation is only available before preparation begins.`
      });
    }

    const { cancellation } = await svc.createCancellation(
      order,
      req.user,
      { reason, description: details || '', source: 'customer' }
    );

    try {
      await logAction({
        req,
        action: 'CANCELLATION_REQUESTED',
        entityType: 'Cancellation',
        entityId: String(cancellation.cancellationNumber || cancellation._id),
        description: `Customer requested cancellation for order #${order.orderId} (${reason})`,
      });
    } catch (_) { /* audit is best effort */ }

    // ================================================================
    // Self-service cancellation: the eligibility check above guarantees
    // the order is still PENDING/RECEIVED (awaiting preparation), so the
    // order is cancelled immediately. However, if the payment was already
    // completed (PAID), the refund is NOT processed automatically — it
    // requires admin review and approval first (PENDING → CANCELLED →
    // Admin Refund → REFUNDED workflow).
    // ================================================================

    // 1. Approve the cancellation immediately, then cancel the order + restore stock.
    cancellation.status = CANCELLATION_FLOW_STATUS.APPROVED;
    cancellation.approvedAt = new Date();
    cancellation.processedBy = req.user.id;
    cancellation.adminNote = 'Auto-cancelled by customer (pending order)';
    cancellation.paymentStatus = order.paymentStatus || 'PENDING';
    await cancellation.save();

    await svc.cancelOrderForApproval({
      order,
      cancellation,
      actorId: req.user.id,
      adminNote: cancellation.adminNote,
    });

    // 2. Handle refund: if payment was PAID, leave the refund for admin
    //    review and processing. If unpaid, mark as not required.
    const paid = String(order.paymentStatus || '').toUpperCase() === PAYMENT_STATUS.PAID;

    if (paid && Number(order.totalAmount) > 0) {
      // Mark refund as requested but do NOT process it yet — the admin must
      // review the cancellation and process the refund from the admin panel.
      cancellation.refundStatus = REFUND_STATUS.REFUND_REQUESTED;
      cancellation.refundAmount = order.totalAmount;
      await cancellation.save();

      // Sync order refund fields so admin panel sees the request.
      order.refundStatus = REFUND_STATUS.REFUND_REQUESTED;
      order.refundAmount = order.totalAmount;
      await order.save();

      try {
        await Payment.findOneAndUpdate(
          { orderId: order._id },
          { status: 'PAID', refundStatus: 'PENDING', refundAmount: order.totalAmount },
        );
      } catch (_) { /* best effort */ }

      await Notification.create({
        userId: order.userId,
        title: 'Order Cancelled',
        message: `Your order #${order.orderId} has been cancelled. Your refund of ${order.totalAmount} ETB will be processed shortly. You will be notified once the refund is complete.`,
        type: 'order',
        orderId: order.orderId,
        isRead: false,
      });

      // Keep cancellation as CANCELLED (not COMPLETED) so admin sees it
      // in the refund queue.
    } else {
      cancellation.refundStatus = REFUND_STATUS.NOT_REQUIRED;
      cancellation.refundAmount = 0;
      await cancellation.save();
      try {
        await Payment.findOneAndUpdate(
          { orderId: order._id },
          { status: 'CANCELLED', cancelledAt: new Date() },
        );
      } catch (_) { /* best effort */ }
      await Notification.create({
        userId: order.userId,
        title: 'Order Cancelled',
        message: `Your order #${order.orderId} has been cancelled.`,
        type: 'order',
        orderId: order.orderId,
        isRead: false,
      });

      // Mark as completed since no refund is needed.
      cancellation.status = CANCELLATION_FLOW_STATUS.COMPLETED;
      cancellation.completedAt = new Date();
      await cancellation.save();
    }

    await OrderStatusHistoryCreate(order, current, 'CANCELLED', req.user.id, 'Customer cancelled pending order');

    try {
      await logAction({
        req,
        action: 'CANCELLATION_AUTO_FULFILLED',
        entityType: 'Cancellation',
        entityId: String(cancellation.cancellationNumber || cancellation._id),
        description: `Pending order #${order.orderId} cancelled immediately by customer. Refund: ${paid ? cancellation.refundAmount + ' ETB pending admin processing' : 'not required'}`,
      });
    } catch (_) { /* audit is best effort */ }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: paid
        ? `Order cancelled successfully. A refund of ${cancellation.refundAmount} ETB will be processed by an administrator.`
        : 'Order cancelled successfully.',
      refunded: false,
      refundRequested: paid && Number(order.totalAmount) > 0,
      cancellation: await svc.serializeCancellation(cancellation, order),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    console.error('❌ Request Cancellation Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get all cancellations (Admin) - search / filter / sort / paginate
 * @route   GET /api/v1/cancellations
 * @access  Private/Admin
 * Query: search, status, paymentStatus, refundStatus, date, from, to, sort, page, limit
 */
exports.getCancellations = async (req, res) => {
  try {
    const filter = await buildCancellationFilter(req.query);

    const { sort = 'newest', page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    let sortOption = { requestedAt: -1 };
    if (sort === 'oldest') sortOption = { requestedAt: 1 };
    else if (sort === 'amount-desc') sortOption = { orderAmount: -1 };

    const cancellations = await Cancellation.find(filter)
      .sort(sortOption)
      .skip(skip)
      .limit(limitNum)
      .populate('orderId')
      .populate('customerId', 'name email phone');

    const total = await Cancellation.countDocuments(filter);

    const serialized = [];
    for (const cancellation of cancellations) {
      const order = await loadOrder(cancellation);
      const record = await svc.serializeCancellation(cancellation, order);
      if (cancellation.customerId && cancellation.customerId.name) {
        record.customer = { name: cancellation.customerId.name, email: cancellation.customerId.email, phone: cancellation.customerId.phone };
      }
      serialized.push(record);
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: serialized.length,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      cancellations: serialized,
    });
  } catch (error) {
    console.error('❌ Get Cancellations Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get cancellation statistics (Admin)
 * @route   GET /api/v1/cancellations/stats
 * @access  Private/Admin
 */
exports.getCancellationStats = async (req, res) => {
  try {
    const match = { isActive: { $ne: false } };
    const [
      totalCancellations,
      pendingApproval,
      approved,
      rejected,
      cancelled,
      completed,
      refunded,
      refundFailed,
      refundsPending,
    ] = await Promise.all([
      Cancellation.countDocuments(match),
      Cancellation.countDocuments({ ...match, status: CANCELLATION_FLOW_STATUS.REQUESTED }),
      Cancellation.countDocuments({ ...match, status: CANCELLATION_FLOW_STATUS.APPROVED }),
      Cancellation.countDocuments({ ...match, status: CANCELLATION_FLOW_STATUS.REJECTED }),
      Cancellation.countDocuments({ ...match, status: CANCELLATION_FLOW_STATUS.CANCELLED }),
      Cancellation.countDocuments({ ...match, status: CANCELLATION_FLOW_STATUS.COMPLETED }),
      Cancellation.countDocuments({ ...match, refundStatus: REFUND_STATUS.REFUNDED }),
      Cancellation.countDocuments({ ...match, refundStatus: REFUND_STATUS.REFUND_FAILED }),
      Cancellation.countDocuments({
        ...match,
        refundStatus: { $in: [REFUND_STATUS.REFUND_REQUESTED, REFUND_STATUS.REFUND_PROCESSING] },
      }),
    ]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const refundedToday = await Cancellation.countDocuments({
      ...match,
      refundStatus: REFUND_STATUS.REFUNDED,
      updatedAt: { $gte: today },
    });

    const refundedRecords = await Cancellation.find({ ...match, refundStatus: REFUND_STATUS.REFUNDED })
      .select('refundAmount')
      .lean();
    const totalRefundAmount = refundedRecords.reduce((s, r) => s + (Number(r.refundAmount) || 0), 0);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: {
        totalCancellations,
        pendingApproval,
        approved,
        rejected,
        cancelled,
        completed,
        refunded,
        refundFailed,
        refundsPending,
        refundedToday,
        totalRefundAmount,
      },
    });
  } catch (error) {
    console.error('❌ Get Cancellation Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get single cancellation by id (or orderId)
 * @route   GET /api/v1/cancellations/:id
 * @access  Private/Admin
 */
exports.getCancellationById = async (req, res) => {
  try {
    const { id } = req.params;
    let cancellation = null;
    if (mongoose.Types.ObjectId.isValid(id)) cancellation = await Cancellation.findById(id);
    if (!cancellation) cancellation = await Cancellation.findOne({ cancellationNumber: id });
    if (!cancellation && mongoose.Types.ObjectId.isValid(id)) {
      const order = await Order.findById(id);
      if (order) cancellation = await Cancellation.findOne({ orderId: order._id });
    }
    if (!cancellation) {
      const order = await Order.findOne({ orderId: String(id) });
      if (order) cancellation = await Cancellation.findOne({ orderId: order._id });
    }
    if (!cancellation) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Cancellation not found' });
    }

    const order = await loadOrder(cancellation);
    const customer = await User.findById(cancellation.customerId || (order && order.userId)).select('name email phone').lean();
    const record = await svc.serializeCancellation(cancellation, order);
    if (customer) record.customer = { name: customer.name, email: customer.email, phone: customer.phone };

    res.status(HTTP_STATUS.OK).json({ success: true, cancellation: record });
  } catch (error) {
    console.error('❌ Get Cancellation Details Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * Resolve a Cancellation document from either a cancellation id, a
 * cancellationNumber, an order ObjectId, or an orderId.
 */
async function resolveCancellationParam(id) {
  if (!id) return null;
  let cancellation = null;
  if (mongoose.Types.ObjectId.isValid(id)) cancellation = await Cancellation.findById(id);
  if (!cancellation) cancellation = await Cancellation.findOne({ cancellationNumber: String(id) });
  if (!cancellation) {
    let order = mongoose.Types.ObjectId.isValid(id) ? await Order.findById(id) : null;
    if (!order) order = await Order.findOne({ orderId: String(id) });
    if (order) cancellation = await Cancellation.findOne({ orderId: order._id });
  }
  return cancellation;
}

/**
 * @desc    Approve cancellation (Admin) - runs the full cancellation flow
 * @route   PATCH /api/v1/cancellations/:id/approve
 * @access  Private/Admin
 * Body: { adminNote, allowServed }
 */
exports.approveCancellation = async (req, res) => {
  try {
    const { adminNote, allowServed, refundAmount } = req.body;
    const cancellation = await resolveCancellationParam(req.params.id);
    if (!cancellation) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Cancellation not found' });
    }

    // Validate status: only REQUESTED cancellations can be approved
    if (cancellation.status === CANCELLATION_FLOW_STATUS.REJECTED) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Cancellation was already rejected' });
    }
    if (cancellation.status === CANCELLATION_FLOW_STATUS.COMPLETED) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Cancellation already completed' });
    }
    if (cancellation.status !== CANCELLATION_FLOW_STATUS.REQUESTED) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: `Cancellation already ${cancellation.status.toLowerCase()}` });
    }

    const order = await Order.findById(cancellation.orderId);
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }

    // Validate order status before cancellation. Per policy, a cancellation is
    // only approved if the order is still awaiting preparation (PENDING /
    // RECEIVED). If the kitchen has already started preparing/ready/served, the
    // request is no longer valid and is rejected instead of auto-approving.
    const current = String(order.orderStatus || order.status || '').toUpperCase();
    const CANCELLABLE = ['PENDING', 'RECEIVED'];
    if (!CANCELLABLE.includes(current) && !allowServed) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Order has already entered the "${current || 'active'}" stage and can no longer be cancelled (cancellation is only available before preparation).`
      });
    }

    const previousStatus = current;

    // 1. Approve the request
    cancellation.status = CANCELLATION_FLOW_STATUS.APPROVED;
    cancellation.approvedAt = new Date();
    cancellation.processedBy = req.user.id;
    cancellation.adminNote = adminNote || cancellation.adminNote || '';
    cancellation.paymentStatus = order.paymentStatus || 'PENDING';
    await cancellation.save();

    // 2. Cancel the order + restore stock (idempotent)
    await svc.cancelOrderForApproval({ order, cancellation, actorId: req.user.id, adminNote: cancellation.adminNote });

    try {
      await Payment.findOneAndUpdate(
        { orderId: order._id },
        { status: 'CANCELLED', cancelledAt: new Date() },
      );
    } catch (_) { /* best effort */ }

    // 3. Refund if payment was successful, otherwise complete immediately.
    //    Refund amount is admin-controlled (full, partial, or none). If the
    //    admin supplies a valid refundAmount (e.g. 0 for no refund, or a partial
    //    amount), it is honored; otherwise it defaults to the full total.
    const paid = String(order.paymentStatus || '').toUpperCase() === PAYMENT_STATUS.PAID;
    let refundAmountUsed = order.totalAmount;
    if (refundAmount !== undefined && refundAmount !== null && refundAmount !== '') {
      const num = Number(refundAmount);
      if (Number.isFinite(num) && num >= 0) {
        refundAmountUsed = num;
      }
    }

    if (paid && refundAmountUsed > 0) {
      await svc.requestRefund({ order, cancellation, amount: refundAmountUsed, actorId: req.user.id });
      // Simulate provider acceptance so the refund enters the provider pipeline.
      await svc.markRefundProcessing({ order, cancellation, reference: cancellation.refundReference });
    } else if (paid) {
      // Approved but no refund (admin set amount to 0) → record that explicitly.
      cancellation.refundStatus = REFUND_STATUS.NOT_REQUIRED;
      cancellation.refundAmount = 0;
      await cancellation.save();
    }

    await OrderStatusHistoryCreate(order, previousStatus, 'CANCELLED', req.user.id, adminNote || 'Cancellation approved');

    await Notification.create({
      userId: order.userId,
      title: 'Cancellation Approved',
      message: paid
        ? `Your order #${order.orderId} has been cancelled. A refund of ${order.totalAmount} ETB is being processed.`
        : `Your order #${order.orderId} has been cancelled.`,
      type: 'order',
      orderId: order.orderId,
      isRead: false,
    });

    await logAction({
      req,
      action: 'CANCELLATION_APPROVED',
      entityType: 'Cancellation',
      entityId: String(cancellation.cancellationNumber || cancellation._id),
      description: `Cancellation approved for order #${order.orderId}. Refund: ${paid ? 'requested' : 'not required'}`,
    });

    const record = await svc.serializeCancellation(cancellation, order);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: paid
        ? 'Cancellation approved. Order cancelled; refund processing started.'
        : 'Cancellation approved. Order cancelled.',
      cancellation: record,
    });
  } catch (error) {
    console.error('❌ Approve Cancellation Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

async function OrderStatusHistoryCreate(order, previousStatus, newStatus, changedBy, reason) {
  const OrderStatusHistory = require('../models/OrderStatusHistory');
  try {
    await OrderStatusHistory.create({ orderId: order._id, previousStatus, newStatus, changedBy, reason: reason || '' });
  } catch (_) { /* best effort */ }
}

/**
 * @desc    Reject cancellation (Admin) - does NOT cancel the order
 * @route   PATCH /api/v1/cancellations/:id/reject
 * @access  Private/Admin
 * Body: { adminNote }
 */
exports.rejectCancellation = async (req, res) => {
  try {
    const { adminNote } = req.body;
    const cancellation = await resolveCancellationParam(req.params.id);
    if (!cancellation) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Cancellation not found' });
    }

    if (cancellation.status === CANCELLATION_FLOW_STATUS.COMPLETED) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Cancellation already completed' });
    }
    if (cancellation.status === CANCELLATION_FLOW_STATUS.REJECTED) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Cancellation was already rejected' });
    }
    if (cancellation.status !== CANCELLATION_FLOW_STATUS.REQUESTED) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: `Cancellation already ${cancellation.status.toLowerCase()}; cannot reject` });
    }

    const order = await Order.findById(cancellation.orderId);

    cancellation.status = CANCELLATION_FLOW_STATUS.REJECTED;
    cancellation.rejectedAt = new Date();
    cancellation.processedBy = req.user.id;
    cancellation.adminNote = adminNote || 'Cancellation request rejected';
    await cancellation.save();

    // Sync + release the request on the order WITHOUT cancelling it.
    if (order) {
      order.cancellationRequested = false;
      order.cancellationStatus = CANCELLATION_STATUS.REJECTED;
      order.cancellationAdminNote = cancellation.adminNote;
      order.cancellationProcessedAt = new Date();
      order.cancellationProcessedBy = req.user.id;
      await order.save();
    }

    await Notification.create({
      userId: order ? order.userId : cancellation.customerId,
      title: 'Cancellation Request Rejected',
      message: `Your cancellation request for order #${order ? order.orderId : ''} was rejected. ${cancellation.adminNote || 'Please contact support for more information.'}`,
      type: 'order',
      orderId: order ? order.orderId : null,
      isRead: false,
    });

    await logAction({
      req,
      action: 'CANCELLATION_REJECTED',
      entityType: 'Cancellation',
      entityId: String(cancellation.cancellationNumber || cancellation._id),
      description: `Cancellation rejected for order #${order ? order.orderId : ''}${cancellation.adminNote ? ' - ' + cancellation.adminNote : ''}`,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Cancellation rejected. The order remains active.',
      cancellation: await svc.serializeCancellation(cancellation, order),
    });
  } catch (error) {
    console.error('❌ Reject Cancellation Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Request refund for an approved/cancelled cancellation (Admin)
 * @route   POST /api/v1/cancellations/:id/refund/request
 * @access  Private/Admin
 */
exports.requestRefund = async (req, res) => {
  try {
    const cancellation = await resolveCancellationParam(req.params.id);
    if (!cancellation) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Cancellation not found' });
    }
    const order = await Order.findById(cancellation.orderId);
    if (!order) return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });

    const result = await svc.requestRefund({ order, cancellation, amount: order.totalAmount, actorId: req.user.id });
    await svc.markRefundProcessing({ order, cancellation, reference: cancellation.refundReference });

    await logAction({
      req,
      action: 'REFUND_REQUESTED',
      entityType: 'Cancellation',
      entityId: String(cancellation.cancellationNumber || cancellation._id),
      description: `Refund requested for order #${order.orderId} (${result.refundAmount} ETB)`,
    });

    res.status(HTTP_STATUS.OK).json({ success: true, refund: result, cancellation: await svc.serializeCancellation(cancellation, order) });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    console.error('❌ Request Refund Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Confirm refund (simulated provider webhook) - ONLY source of REFUNDED
 * @route   POST /api/v1/cancellations/:id/refund/confirm
 * @access  Private/Admin (and provider webhook when integrated)
 * Body: { providerReference }
 */
exports.confirmRefund = async (req, res) => {
  try {
    const { providerReference } = req.body;
    const cancellation = await resolveCancellationParam(req.params.id);
    if (!cancellation) return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Cancellation not found' });
    const order = await Order.findById(cancellation.orderId);

    await svc.confirmRefund({ cancellation, order, providerReference, actorId: req.user && req.user.id });

    if (order) {
      try {
        await Payment.findOneAndUpdate({ orderId: order._id }, { status: 'REFUNDED', refundStatus: 'REFUNDED', refundedAt: new Date(), refundAmount: cancellation.refundAmount, refundReference: cancellation.refundReference });
      } catch (_) { /* best effort */ }
    }

    // Refund resolved => cancellation is complete.
    cancellation.status = CANCELLATION_FLOW_STATUS.COMPLETED;
    cancellation.completedAt = new Date();
    await cancellation.save();

    await logAction({
      req,
      action: 'REFUND_CONFIRMED',
      entityType: 'Cancellation',
      entityId: String(cancellation.cancellationNumber || cancellation._id),
      description: `Refund confirmed by provider for order #${order ? order.orderId : ''} (${cancellation.refundAmount} ETB)`,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Refund confirmed. Cancellation completed.',
      cancellation: await svc.serializeCancellation(cancellation, order),
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    console.error('❌ Confirm Refund Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Mark refund as failed (Admin / provider error callback)
 * @route   POST /api/v1/cancellations/:id/refund/fail
 * @access  Private/Admin
 * Body: { error }
 */
exports.failRefund = async (req, res) => {
  try {
    const { error } = req.body;
    const cancellation = await resolveCancellationParam(req.params.id);
    if (!cancellation) return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Cancellation not found' });
    const order = await Order.findById(cancellation.orderId);

    await svc.failRefund({ cancellation, order, error: error || 'Provider error' });

    if (order) {
      try {
        await Payment.findOneAndUpdate({ orderId: order._id }, { refundStatus: 'FAILED' });
      } catch (_) { /* best effort */ }
    }

    await logAction({
      req,
      action: 'REFUND_FAILED',
      entityType: 'Cancellation',
      entityId: String(cancellation.cancellationNumber || cancellation._id),
      description: `Refund failed for order #${order ? order.orderId : ''} (${error || 'provider error'})`,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Refund marked as failed.',
      cancellation: await svc.serializeCancellation(cancellation, order),
    });
  } catch (error) {
    console.error('❌ Fail Refund Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Check cancellation eligibility (customer-facing)
 * @route   GET /api/v1/cancellations/:orderId/check
 * @access  Private
 */
exports.checkCancellationEligibility = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await svc.resolveOrder(orderId);
    if (!order) return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });

    if (order.userId && String(order.userId) !== String(req.user.id) && req.user.role !== 'admin') {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'Unauthorized to check this order' });
    }

    let canCancel = false;
    let message = '';
    const current = String(order.orderStatus || order.status || '').toUpperCase();

    if (['CANCELLED', 'COMPLETED', 'SERVED'].includes(current)) {
      message = `Order has already been ${current.toLowerCase()} and cannot be cancelled`;
    } else if (order.cancellationRequested) {
      const cancellation = await svc.findActiveCancellation(order);
      message = `Cancellation already requested (status: ${cancellation ? cancellation.status : order.cancellationStatus})`;
    } else {
      canCancel = true;
      message = 'Order can be cancelled';
    }

    const activeCancellation = await svc.findActiveCancellation(order);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      canCancel,
      status: current,
      message,
      cancellationNumber: activeCancellation ? activeCancellation.cancellationNumber : null,
      cancellationStatus: activeCancellation ? activeCancellation.status : null,
      refundStatus: activeCancellation ? activeCancellation.refundStatus : null,
      orderSummary: {
        orderId: order.orderId,
        totalAmount: order.totalAmount,
        items: order.items.map((item) => ({ name: item.name, quantity: item.quantity, price: item.price })),
      },
    });
  } catch (error) {
    console.error('❌ Check Cancellation Eligibility Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};