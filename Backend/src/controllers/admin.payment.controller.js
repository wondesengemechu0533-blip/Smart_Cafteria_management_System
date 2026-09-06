const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Order = require('../models/Order');
const User = require('../models/User');
const { PAYMENT_STATUS, MESSAGES, HTTP_STATUS } = require('../config/constants');

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * Serialize a payment document into the admin-facing shape.
 * Payment status and order status are deliberately kept separate —
 * paymentStatus reflects only what the payment provider verified.
 * No provider credentials are ever included here.
 */
function serializePayment(payment, order, user) {
  return {
    id: payment._id,
    orderId: order ? order.orderId : null,
    customerName: order ? order.customerName : null,
    customerPhone: order ? order.customerPhone : null,
    customer: user
      ? { name: user.name, email: user.email, phone: user.phone }
      : null,
    method: payment.method || payment.provider,
    amount: payment.amount,
    currency: payment.currency || 'ETB',
    paymentStatus: payment.status,
    transactionId: payment.transactionId,
    providerReference: payment.providerReference || payment.chapaReference || payment.reference,
    paymentDate: payment.paymentDate,
    paidAt: payment.paidAt,
    createdAt: payment.createdAt
  };
}

async function buildPaymentSearchFilter(search) {
  const s = String(search);

  const paymentFieldMatch = {
    $or: [
      { transactionId: { $regex: s, $options: 'i' } },
      { providerReference: { $regex: s, $options: 'i' } },
      { chapaReference: { $regex: s, $options: 'i' } },
      { reference: { $regex: s, $options: 'i' } },
      { phone: { $regex: s, $options: 'i' } }
    ]
  };

  // Matches against data living on the linked Order (orderId / customer)
  const orders = await Order.find({
    $or: [
      { orderId: { $regex: s, $options: 'i' } },
      { customerName: { $regex: s, $options: 'i' } },
      { customerPhone: { $regex: s, $options: 'i' } }
    ]
  })
    .select('_id')
    .lean();

  if (orders.length) {
    const ids = orders.map((o) => o._id);
    return {
      $or: [
        ...paymentFieldMatch.$or,
        { orderId: { $in: ids } }
      ]
    };
  }

  return paymentFieldMatch;
}

/**
 * @desc    List payments (admin) - read-only monitoring
 * @route   GET /api/v1/admin/payments
 * @access  Private/Admin
 * Query: method, status, date (YYYY-MM-DD), search, page, limit, sort
 * Note:    Intentionally GET-only. There is NO endpoint that lets an admin
 *          change paymentStatus — only provider verification sets PAID.
 */
exports.getAllPayments = async (req, res) => {
  try {
    const {
      method,
      status,
      date,
      search,
      sort = 'newest',
      page = 1,
      limit = 20
    } = req.query;

    const conditions = [];

    if (method && method !== 'all') {
      conditions.push({ method: String(method).toUpperCase() });
    }

    if (status && status !== 'all') {
      conditions.push({ status: String(status).toUpperCase() });
    }

    if (date) {
      const now = new Date();
      const parseDay = (d) => {
        const parsed = new Date(`${d}T00:00:00.000Z`);
        return isNaN(parsed.getTime()) ? null : parsed;
      };

      let range = null;
      if (date === 'today') {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        range = { $gte: start, $lt: new Date(start.getTime() + 86400000) };
      } else if (/^\d+d$/.test(date)) {
        const days = parseInt(date, 10);
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        start.setDate(start.getDate() - (days - 1));
        range = { $gte: start, $lt: new Date(start.getTime() + days * 86400000) };
      } else {
        const day = parseDay(date);
        if (day) {
          range = { $gte: day, $lt: new Date(day.getTime() + 86400000) };
        }
      }
      if (range) conditions.push({ paymentDate: range });
    }

    if (search && String(search).trim()) {
      conditions.push(await buildPaymentSearchFilter(String(search).trim()));
    }

    const filter = conditions.length ? { $and: conditions } : {};

    let sortOption = { createdAt: -1 };
    switch (sort) {
      case 'oldest':
        sortOption = { createdAt: 1 };
        break;
      case 'amount-desc':
        sortOption = { amount: -1 };
        break;
      case 'amount-asc':
        sortOption = { amount: 1 };
        break;
      default:
        sortOption = { createdAt: -1 };
    }

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const payments = await Payment.find(filter).sort(sortOption).skip(skip).limit(limitNum);
    const total = await Payment.countDocuments(filter);

    const orderIds = [...new Set(payments.map((p) => String(p.orderId)).filter(Boolean))];
    const orders = await Order.find({ _id: { $in: orderIds } }).lean();
    const orderMap = {};
    orders.forEach((o) => (orderMap[String(o._id)] = o));

    const userIds = [...new Set(payments.map((p) => String(p.userId)).filter(Boolean))];
    const users = await User.find({ _id: { $in: userIds } }).select('name email phone').lean();
    const userMap = {};
    users.forEach((u) => (userMap[String(u._id)] = u));

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: payments.length,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      payments: payments.map((payment) =>
        serializePayment(
          payment,
          orderMap[String(payment.orderId)],
          userMap[String(payment.userId)]
        )
      )
    });
  } catch (error) {
    console.error('❌ Admin Get All Payments Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Payment statistics (admin) - read-only metric cards
 * @route   GET /api/v1/admin/payments/stats
 * @access  Private/Admin
 */
exports.getPaymentStats = async (req, res) => {
  try {
    const [successfulPayments, pendingPayments, failedPayments, cancelledPayments] = await Promise.all([
      Payment.countDocuments({ status: PAYMENT_STATUS.PAID }),
      Payment.countDocuments({ status: PAYMENT_STATUS.PENDING }),
      Payment.countDocuments({ status: PAYMENT_STATUS.FAILED }),
      Payment.countDocuments({ status: PAYMENT_STATUS.CANCELLED })
    ]);

    const paidPayments = await Payment.find({ status: PAYMENT_STATUS.PAID }).select('amount').lean();
    const totalRevenue = paidPayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

    const telebirr = 0;
    const chapa = await Payment.countDocuments({ method: 'CHAPA' });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: {
        totalPayments: successfulPayments + pendingPayments + failedPayments + cancelledPayments,
        successfulPayments,
        pendingPayments,
        failedPayments,
        cancelledPayments,
        totalRevenue,
        methods: { telebirr, chapa }
      }
    });
  } catch (error) {
    console.error('❌ Admin Get Payment Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Payment detail (admin) - read-only
 * @route   GET /api/v1/admin/payments/:id
 * @access  Private/Admin
 */
exports.getPaymentById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Payment not found' });
    }

    const payment = await Payment.findById(id).lean();
    if (!payment) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Payment not found' });
    }

    const order = await Order.findById(payment.orderId).lean();
    const user = await User.findById(payment.userId).select('name email phone').lean();

    const record = serializePayment(payment, order, user);
    record.order = order
      ? {
          orderType: order.orderType,
          tableNumber: order.tableNumber,
          items: order.items,
          subtotal: order.subtotal,
          serviceFee: order.serviceFee,
          totalAmount: order.totalAmount,
          orderStatus: order.orderStatus || String(order.status || '').toUpperCase(),
          paymentStatus: order.paymentStatus,
          orderDate: order.orderDate,
          orderTime: order.orderTime
        }
      : null;

    res.status(HTTP_STATUS.OK).json({ success: true, payment: record });
  } catch (error) {
    console.error('❌ Admin Get Payment By ID Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get payment history/event log
 * @route   GET /api/v1/admin/payments/:id/history
 * @access  Private/Admin
 */
exports.getPaymentHistory = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Payment not found' });
    }

    const PaymentEventLog = require('../models/PaymentEventLog');
    const history = await PaymentEventLog.find({ paymentId: id })
      .sort({ createdAt: -1 })
      .lean();

    res.status(HTTP_STATUS.OK).json({
      success: true,
      history: history.map((evt) => ({
        id: evt._id,
        eventType: evt.eventType,
        status: evt.status,
        reason: evt.reason,
        createdAt: evt.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: 'Failed to fetch history' });
  }
};

/**
 * @desc    Get payment for an order
 * @route   GET /api/v1/admin/orders/:orderId/payment
 * @access  Private/Admin
 */
exports.getOrderPayment = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!isValidObjectId(orderId)) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Payment not found' });
    }

    const payment = await Payment.findOne({ orderId }).lean();
    if (!payment) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'No payment found for this order' });
    }

    const order = await Order.findById(payment.orderId).lean();
    const user = await User.findById(payment.userId).select('name email phone').lean();

    res.status(HTTP_STATUS.OK).json({
      success: true,
      payment: serializePayment(payment, order, user),
    });
  } catch (error) {
    console.error('Error fetching order payment:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: 'Failed to fetch payment' });
  }
};

/**
 * @desc    Process a refund for a payment
 * @route   POST /api/v1/admin/payments/:id/refund
 * @access  Private/Admin
 */
exports.refundPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, reason } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Payment not found' });
    }

    const payment = await Payment.findById(id);
    if (!payment) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Payment not found' });
    }

    // Refund eligibility: only a payment tied to a cancelled order can be
    // refunded (PENDING paid order → customer cancels → admin refund).
    const linkedOrder = await Order.findById(payment.orderId).lean();
    const orderCancelled = linkedOrder
      ? (String(linkedOrder.orderStatus || '').toUpperCase() === 'CANCELLED' ||
         String(linkedOrder.status || '').toLowerCase() === 'cancelled')
      : false;
    const paymentPaid = payment.status === 'PAID';
    if (!orderCancelled) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Refund not allowed: the linked order is not cancelled.',
      });
    }
    if (!paymentPaid || payment.status === 'REFUNDED') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Refund not allowed: payment was not completed (or already refunded).',
      });
    }

    // Validate refund amount
    const refundableAmount = payment.amount - (payment.refundAmount || 0);
    if (amount > refundableAmount) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Refund amount exceeds available refundable amount (${refundableAmount} ETB)`,
      });
    }

    // Update payment
    payment.refundAmount = (payment.refundAmount || 0) + amount;
    if (payment.refundAmount >= payment.amount) {
      payment.status = 'REFUNDED';
      payment.refundedAt = new Date();
    }
    payment.refundStatus = 'PENDING';
    payment.refundReason = reason || 'Refund requested';
    payment.refundReference = `REF-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    await payment.save();

    // Log refund event
    const PaymentEventLog = require('../models/PaymentEventLog');
    await PaymentEventLog.create({
      paymentId: payment._id,
      orderId: payment.orderId,
      userId: payment.userId,
      eventType: 'PAYMENT_REFUND_INITIATED',
      status: payment.status,
      amount: amount,
      reason: reason,
      performedBy: req.user?.id,
    });

    const order = await Order.findById(payment.orderId).lean();
    const user = await User.findById(payment.userId).select('name email phone').lean();

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Refund initiated successfully',
      payment: serializePayment(payment, order, user),
    });
  } catch (error) {
    console.error('Error processing refund:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: 'Failed to process refund' });
  }
};