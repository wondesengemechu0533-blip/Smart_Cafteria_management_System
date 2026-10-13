const mongoose = require('mongoose');
const Refund = require('../models/Refund');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const Notification = require('../models/Notification');
const { HTTP_STATUS, MESSAGES, REFUND_STATUS } = require('../config/constants');
const { logAction } = require('../utils/audit');

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * Resolve an order by ObjectId or human-friendly orderId string.
 */
async function resolveOrder(id) {
  if (!id) return null;
  if (isValidId(id)) {
    const byId = await Order.findById(id);
    if (byId) return byId;
  }
  return Order.findOne({ orderId: String(id) });
}

/**
 * Resolve a payment for an order (prefer PAID).
 */
async function findPaymentForOrder(order, onlyPaid = false) {
  if (!order) return null;
  const query = onlyPaid ? { orderId: order._id, status: 'PAID' } : { orderId: order._id };
  return Payment.findOne(query).sort({ createdAt: -1 });
}

function serializeRefund(refund) {
  if (!refund) return null;
  return {
    id: refund._id,
    refundNumber: refund.refundNumber,
    orderId: refund.orderId ? String(refund.orderId) : null,
    orderRef: refund.orderId && refund.orderId.orderId ? refund.orderId.orderId : null,
    orderType: refund.orderId ? refund.orderId.orderType : null,
    customerName: refund.orderId ? refund.orderId.customerName : null,
    customerPhone: refund.orderId ? refund.orderId.customerPhone : null,
    amount: refund.amount,
    reason: refund.reason,
    requestedBy: refund.requestedBy ? { id: String(refund.requestedBy) } : null,
    requestedByName: refund.requestedByName || null,
    processedBy: refund.processedBy ? { id: String(refund.processedBy) } : null,
    processedByName: refund.processedByName || null,
    status: refund.status,
    requestedAt: refund.requestedAt,
    approvedAt: refund.approvedAt,
    rejectedAt: refund.rejectedAt,
    refundedAt: refund.refundedAt,
    providerReference: refund.providerReference,
    adminNote: refund.adminNote,
    metadata: refund.metadata || {},
    createdAt: refund.createdAt,
    updatedAt: refund.updatedAt,
  };
}

async function hydrate(refund) {
  if (!refund) return null;
  if (refund.orderId && typeof refund.orderId === 'object') {
    await refund.populate(
      'orderId',
      'orderId customerName customerPhone orderType totalAmount paymentStatus orderStatus status'
    );
  }
  if (refund.requestedBy && typeof refund.requestedBy === 'object' && !refund.requestedByName) {
    await refund.populate('requestedBy', 'name email phone role');
    refund.requestedByName = refund.requestedBy.name;
  }
  if (refund.processedBy && typeof refund.processedBy === 'object' && !refund.processedByName) {
    await refund.populate('processedBy', 'name email phone role');
    refund.processedByName = refund.processedBy.name;
  }
  return refund;
}

/**
 * @desc    Request a refund for a paid order (customer, or staff on behalf)
 * @route   POST /api/v1/refunds
 * @access  Private (customer / cashier / manager / cafeteria_admin / admin)
 * Body: { orderId, amount?, reason }
 */
exports.requestRefund = async (req, res) => {
  try {
    const { orderId, amount, reason } = req.body;
    if (!orderId) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'orderId is required' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Reason is required' });
    }

    const order = await resolveOrder(orderId);
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }

    const isStaff = ['cashier', 'admin', 'cafeteria_admin', 'manager'].includes(req.user.role);
    // Customers may only request a refund for their own orders.
    if (req.user.role === 'customer' && String(order.userId) !== String(req.user.id)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'You can only request a refund for your own orders' });
    }

    // Refund eligibility: order must be paid and either completed/delivered or cancelled.
    const paid = String(order.paymentStatus || '').toUpperCase() === 'PAID';
    const terminal =
      ['COMPLETED', 'DELIVERED', 'CANCELLED'].includes(String(order.orderStatus || '').toUpperCase()) ||
      ['completed', 'delivered', 'cancelled'].includes(String(order.status || '').toLowerCase());
    if (!paid || !terminal) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Refund can only be requested for PAID and completed/delivered/cancelled orders',
      });
    }

    // Prevent duplicate active refund requests.
    const existing = await Refund.findOne({
      orderId: order._id,
      status: { $in: ['REFUND_REQUESTED', 'APPROVED', 'REFUNDED'] },
    });
    if (existing) {
      return res
        .status(HTTP_STATUS.CONFLICT)
        .json({ success: false, error: 'A refund request already exists for this order' });
    }

    // Verify the order was actually paid (real payment reference), unless simulated.
    const payment = await findPaymentForOrder(order, true);
    const usedAmount =
      Number.isFinite(Number(amount)) && Number(amount) > 0 ? Number(amount) : Number(order.totalAmount) || 0;

    const refund = await Refund.create({
      orderId: order._id,
      paymentId: payment ? payment._id : null,
      cafeteriaId: order.cafeteriaId || null,
      amount: Math.min(usedAmount, Number(order.totalAmount) || usedAmount),
      reason: String(reason).trim(),
      requestedBy: req.user.id,
      status: 'REFUND_REQUESTED',
      requestedAt: new Date(),
      metadata: { orderAmount: order.totalAmount, paymentStatus: order.paymentStatus },
    });
    await hydrate(refund);

    // Keep order flat fields in sync.
    order.refundStatus = REFUND_STATUS.REFUND_REQUESTED;
    order.refundAmount = refund.amount;
    await order.save();

    await logAction({
      req,
      action: 'REFUND_REQUESTED',
      entityType: 'Refund',
      entityId: String(refund._id),
      description: `Refund request for order #${order.orderId} amounting ${refund.amount}`,
      metadata: { orderId: String(order._id), amount: refund.amount },
    });

    res
      .status(HTTP_STATUS.CREATED)
      .json({ success: true, message: 'Refund requested successfully', refund: serializeRefund(refund) });
  } catch (error) {
    console.error('❌ Request Refund Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    List refunds (staff) / my refunds (customer)
 * @route   GET /api/v1/refunds
 * @access  Private (customer sees own; staff see all, filterable)
 * Query: status, search, startDate, endDate, page, limit
 */
exports.getRefunds = async (req, res) => {
  try {
    const { status, search, startDate, endDate, page = 1, limit = 20 } = req.query;
    const filter = {};

    if (req.user.role === 'customer') {
      filter.requestedBy = req.user.id;
    }

    if (status && status !== 'all') filter.status = String(status).toUpperCase();
    if (search && String(search).trim()) {
      const term = String(search).trim();
      const orderIds = [];
      // `new` is required: in Mongoose 8+ ObjectId is a class, and calling it
      // as a function throws "Class constructor ObjectId cannot be invoked
      // without 'new'". Searching refunds by an order id therefore failed with
      // a 500 whenever the term happened to be a valid id.
      if (isValidId(term)) orderIds.push(new mongoose.Types.ObjectId(term));
      const orders = await Order.find({ orderId: { $regex: term, $options: 'i' } })
        .select('_id')
        .lean();
      orderIds.push(...orders.map((o) => o._id));
      filter.$or = [{ _id: { $in: orderIds } }, { refundNumber: { $regex: term, $options: 'i' } }];
    }
    if (startDate || endDate) {
      const range = {};
      if (startDate) {
        const s = new Date(startDate);
        if (!isNaN(s.getTime())) range.$gte = s;
      }
      if (endDate) {
        const e = new Date(endDate);
        if (!isNaN(e.getTime())) {
          e.setHours(23, 59, 59, 999);
          range.$lte = e;
        }
      }
      if (Object.keys(range).length) filter.requestedAt = range;
    }

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const [refunds, total] = await Promise.all([
      Refund.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('orderId', 'orderId customerName customerPhone orderType totalAmount paymentStatus')
        .populate('requestedBy', 'name email phone role')
        .populate('processedBy', 'name email phone role')
        .lean(),
      Refund.countDocuments(filter),
    ]);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: refunds.length,
      total,
      page: pageNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      refunds: refunds.map((r) => {
        const copy = { ...r, id: r._id };
        copy.orderRef = r.orderId ? r.orderId.orderId : null;
        copy.orderType = r.orderId ? r.orderId.orderType : null;
        copy.customerName = r.orderId ? r.orderId.customerName : null;
        copy.customerPhone = r.orderId ? r.orderId.customerPhone : null;
        copy.orderTotal = r.orderId ? r.orderId.totalAmount : null;
        copy.requestedByName = r.requestedBy ? r.requestedBy.name : null;
        copy.processedByName = r.processedBy ? r.processedBy.name : null;
        copy.requestedBy = r.requestedBy ? { id: String(r.requestedBy._id), name: r.requestedBy.name } : null;
        copy.processedBy = r.processedBy ? { id: String(r.processedBy._id), name: r.processedBy.name } : null;
        copy.orderObject = r.orderId ? { id: String(r.orderId._id), orderId: r.orderId.orderId } : null;
        return copy;
      }),
    });
  } catch (error) {
    console.error('❌ Get Refunds Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get a single refund
 * @route   GET /api/v1/refunds/:id
 * @access  Private
 */
exports.getRefundById = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid refund id' });
    }
    let refund = await Refund.findById(req.params.id)
      .populate('orderId', 'orderId customerName customerPhone orderType totalAmount paymentStatus orderStatus')
      .populate('requestedBy', 'name email phone role')
      .populate('processedBy', 'name email phone role');
    if (!refund) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Refund not found' });
    }
    if (req.user.role === 'customer' && String(refund.requestedBy._id) !== String(req.user.id)) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'Access denied' });
    }
    await hydrate(refund);
    res.status(HTTP_STATUS.OK).json({ success: true, refund: serializeRefund(refund) });
  } catch (error) {
    console.error('❌ Get Refund By Id Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Approve a refund request (staff)
 * @route   PATCH /api/v1/refunds/:id/approve
 * @access  Private (cashier / manager / cafeteria_admin / admin)
 * Body: { adminNote }
 */
exports.approveRefund = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid refund id' });
    }
    const { adminNote } = req.body;
    const refund = await Refund.findById(req.params.id);
    if (!refund) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Refund not found' });
    }
    if (refund.status !== 'REFUND_REQUESTED') {
      return res
        .status(HTTP_STATUS.CONFLICT)
        .json({ success: false, error: `Cannot approve a refund in ${refund.status} status` });
    }

    refund.status = 'APPROVED';
    refund.approvedAt = new Date();
    refund.processedBy = req.user.id;
    if (adminNote) refund.adminNote = String(adminNote).trim();
    await refund.save();
    await hydrate(refund);

    // Sync order + payment flat fields.
    const order = await Order.findById(refund.orderId);
    if (order) {
      order.refundStatus = REFUND_STATUS.REFUND_APPROVED;
      order.refundAmount = refund.amount;
      await order.save();
    }

    await logAction({
      req,
      action: 'REFUND_APPROVED',
      entityType: 'Refund',
      entityId: String(refund._id),
      description: `Approved refund ${refund.refundNumber} (${refund.amount})`,
      metadata: { status: 'APPROVED' },
    });

    res.status(HTTP_STATUS.OK).json({ success: true, message: 'Refund approved', refund: serializeRefund(refund) });
  } catch (error) {
    console.error('❌ Approve Refund Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Reject a refund request (staff)
 * @route   PATCH /api/v1/refunds/:id/reject
 * @access  Private (cashier / manager / cafeteria_admin / admin)
 * Body: { adminNote }
 */
exports.rejectRefund = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid refund id' });
    }
    const { adminNote } = req.body;
    const refund = await Refund.findById(req.params.id);
    if (!refund) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Refund not found' });
    }
    if (!['REFUND_REQUESTED', 'APPROVED'].includes(refund.status)) {
      return res
        .status(HTTP_STATUS.CONFLICT)
        .json({ success: false, error: `Cannot reject a refund in ${refund.status} status` });
    }

    refund.status = 'REJECTED';
    refund.rejectedAt = new Date();
    refund.processedBy = req.user.id;
    if (adminNote) refund.adminNote = String(adminNote).trim();
    await refund.save();
    await hydrate(refund);

    const order = await Order.findById(refund.orderId);
    if (order) {
      order.refundStatus = REFUND_STATUS.REFUND_FAILED;
      await order.save();
    }

    await logAction({
      req,
      action: 'REFUND_REJECTED',
      entityType: 'Refund',
      entityId: String(refund._id),
      description: `Rejected refund ${refund.refundNumber} (${refund.amount})`,
      metadata: { status: 'REJECTED' },
    });

    res.status(HTTP_STATUS.OK).json({ success: true, message: 'Refund rejected', refund: serializeRefund(refund) });
  } catch (error) {
    console.error('❌ Reject Refund Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Complete a refund (mark REFUNDED) after provider confirmation
 * @route   PATCH /api/v1/refunds/:id/complete
 * @access  Private (cashier / manager / cafeteria_admin / admin)
 * Body: { providerReference }
 *
 * Honesty note: the Chapa gateway integration in this project does not issue
 * real refunds against a live account. When a reference starting with "SIM-"
 * is supplied (or none is given), the refund is recorded as REFUNDED in the
 * ledger WITH an explicit `simulated: true` metadata flag and a note that no
 * real money was transferred. Otherwise a real providerReference is expected.
 */
exports.completeRefund = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid refund id' });
    }
    const { providerReference } = req.body;
    const refund = await Refund.findById(req.params.id);
    if (!refund) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Refund not found' });
    }
    if (!['APPROVED', 'REFUND_REQUESTED'].includes(refund.status)) {
      return res
        .status(HTTP_STATUS.CONFLICT)
        .json({ success: false, error: `Cannot complete a refund in ${refund.status} status` });
    }

    const ref = providerReference || `SIM-${Date.now()}`;
    const simulated = String(ref).startsWith('SIM-');
    const metadata = { ...(refund.metadata || {}) };
    if (simulated) {
      metadata.simulated = true;
      metadata.note = 'Recorded only. The payment provider was not actually instructed to transfer funds.';
    }

    refund.status = 'REFUNDED';
    refund.refundedAt = new Date();
    refund.providerReference = ref;
    refund.processedBy = req.user.id;
    refund.metadata = metadata;
    await refund.save();
    await hydrate(refund);

    const order = await Order.findById(refund.orderId);
    if (order) {
      order.refundStatus = REFUND_STATUS.REFUNDED;
      order.refundAmount = refund.amount;
      order.refundReference = ref;
      order.refundedAt = refund.refundedAt;
      if (String(order.paymentStatus || '').toUpperCase() === 'PAID') order.paymentStatus = 'REFUNDED';
      await order.save();
    }
    const payment = refund.paymentId ? await Payment.findById(refund.paymentId) : null;
    if (payment) {
      payment.status = 'REFUNDED';
      payment.refundStatus = 'REFUNDED';
      payment.refundAmount = refund.amount;
      payment.refundReference = ref;
      payment.refundedAt = refund.refundedAt;
      await payment.save();
    }

    // Notify the requesting customer.
    if (order) {
      const title = simulated ? 'Refund Recorded' : 'Refund Complete';
      const message = simulated
        ? `Your refund of ${refund.amount} for order #${order.orderId} was APPROVED and recorded. Please contact support if you have not received the money on your account.`
        : `Your refund of ${refund.amount} for order #${order.orderId} has been completed. Ref: ${ref}`;
      await Notification.create({
        userId: order.userId,
        title,
        message,
        type: 'payment',
        orderId: order.orderId,
        isRead: false,
      });
      const { emitSocketEvent } = require('../utils/socket');
      emitSocketEvent(`user:${order.userId}`, 'notification:new', {
        title,
        message,
        type: 'payment',
        orderId: order.orderId,
        isRead: false,
        createdAt: new Date(),
      });
    }

    await logAction({
      req,
      action: 'REFUND_COMPLETED',
      entityType: 'Refund',
      entityId: String(refund._id),
      description: `Completed refund ${refund.refundNumber} (${refund.amount})${simulated ? ' [SIMULATED - no money transferred]' : ''}`,
      metadata: { status: 'REFUNDED', simulated, providerReference: ref },
    });

    res
      .status(HTTP_STATUS.OK)
      .json({
        success: true,
        message: simulated ? 'Refund recorded (simulated, no money transferred)' : 'Refund completed',
        refund: serializeRefund(refund),
      });
  } catch (error) {
    console.error('❌ Complete Refund Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

module.exports = {
  requestRefund: exports.requestRefund,
  getRefunds: exports.getRefunds,
  getRefundById: exports.getRefundById,
  approveRefund: exports.approveRefund,
  rejectRefund: exports.rejectRefund,
  completeRefund: exports.completeRefund,
};
