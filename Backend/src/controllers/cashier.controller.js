const mongoose = require('mongoose');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const Refund = require('../models/Refund');
const User = require('../models/User');
const { HTTP_STATUS, MESSAGES, PAYMENT_METHOD_VALUES } = require('../config/constants');
const { logAction } = require('../utils/audit');
const { respondWithError } = require('../utils/respondError');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const DAY_MS = 86400000;

function startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// `orderStatus` is uppercase while the legacy `status` field is mixed-case
// ('Completed' in the enum, lowercase elsewhere), so every status comparison
// has to match both spellings or the row is silently skipped.
const anyCase = (...values) => values.flatMap((v) => [v, v.toLowerCase()]);
const FULFILLED_STATES = anyCase('SERVED', 'COMPLETED', 'DELIVERED', 'ARRIVED');
const CANCELLED_STATES = anyCase('CANCELLED');

// Refund.status enum is REFUND_REQUESTED / APPROVED / REJECTED / REFUNDED /
// REFUND_FAILED. 'REFUND_APPROVED' is an Order.refundStatus value, so pairing
// it with 'REFUNDED' missed every genuinely approved refund.
const REFUNDED_REFUND_STATUSES = ['REFUNDED', 'APPROVED', 'REFUND_APPROVED', 'REFUND_PROCESSING'];

/**
 * Resolve a `date` query param into a half-open LOCAL day range [start, end).
 * utils/reportRange.js and every other report in this backend use local
 * midnight, so `YYYY-MM-DD` has to be read in the server timezone too.
 * Reading it as UTC shifts the window by the server offset (EAT = +3h) and
 * silently drops every order taken between 00:00 and 03:00.
 * Returns null when the input is not a usable YYYY-MM-DD date.
 */
function resolveLocalDay(dateStr) {
  if (!dateStr) return null;
  const day = new Date(`${String(dateStr).trim()}T00:00:00`);
  if (isNaN(day.getTime())) return null;
  day.setHours(0, 0, 0, 0);
  return { start: day, end: new Date(day.getTime() + DAY_MS) };
}

/** A `date` param becomes a createdAt window; without one, "today so far". */
function createdAtWindow(dateStr) {
  return resolveLocalDay(dateStr) || { start: startOfDay(), end: new Date(startOfDay().getTime() + DAY_MS) };
}

/**
 * Orders that represent money actually collected: payment confirmed, or the
 * order reached a fulfilled state. Cancelled orders are excluded even when
 * paymentStatus is still PAID, otherwise refunded revenue stays in the
 * totals.
 */
function collectedOrderConditions(window) {
  return [
    {
      $or: [
        { paymentStatus: 'PAID' },
        { orderStatus: { $in: FULFILLED_STATES } },
        { status: { $in: FULFILLED_STATES } },
      ],
    },
    { orderStatus: { $nin: CANCELLED_STATES } },
    { status: { $nin: CANCELLED_STATES } },
    { createdAt: { $gte: window.start, $lt: window.end } },
  ];
}

/**
 * @desc    Cashier dashboard - today's payments, refunds and cash-up summary
 * @route   GET /api/v1/cashier/dashboard
 * @access  Private/Cashier + admin roles
 */
exports.getCashierDashboard = async (req, res) => {
  try {
    const window = createdAtWindow();
    const collected = { $and: collectedOrderConditions(window) };

    const [todayOrders, todayPaid, todayCash, todayPending, todayRefunds, totalRefunds, recentPaidOrders] =
      await Promise.all([
        Order.countDocuments({ createdAt: { $gte: window.start, $lt: window.end } }),
        Order.find(collected).select('totalAmount vatAmount vatEnabled paymentMethod paymentStatus orderId createdAt'),
        Order.find({ ...collected, paymentMethod: { $regex: /^cash$/i } }).select(
          'totalAmount paymentStatus orderId createdAt'
        ),
        Order.countDocuments({
          createdAt: { $gte: window.start, $lt: window.end },
          paymentStatus: 'PENDING',
        }),
        Refund.find({
          requestedAt: { $gte: window.start, $lt: window.end },
          status: { $in: REFUNDED_REFUND_STATUSES },
        })
          .select('amount status requestedAt orderId')
          .populate('orderId', 'totalAmount vatAmount paymentMethod'),
        Refund.countDocuments({ status: { $in: REFUNDED_REFUND_STATUSES } }),
        Order.find({ createdAt: { $gte: window.start, $lt: window.end } })
          .select('orderId customerName totalAmount paymentMethod paymentStatus createdAt orderStatus status')
          .sort({ createdAt: -1 })
          .limit(20),
      ]);

    const grossPaidToday = todayPaid.reduce((s, o) => s + (o.totalAmount || 0), 0);
    const vatPaidToday = todayPaid.reduce((s, o) => s + (o.vatAmount || 0), 0);
    const cashPaidToday = todayCash.reduce((s, o) => s + (o.totalAmount || 0), 0);
    const refundsToday = todayRefunds.reduce((s, r) => s + (r.amount || 0), 0);

    // Cut from today's stats the VAT / cash that was actually refunded earlier
    // the same day, so the income and VAT figures reflect net money kept.
    const vatRefundedToday = todayRefunds.reduce((s, r) => {
      const order = r.orderId;
      if (!order) return s;
      const total = Number(order.totalAmount) || Number(r.amount) || 0;
      const vat = Number(order.vatAmount) || 0;
      if (!total || !vat) return s;
      return s + (Number(r.amount || 0) / total) * vat;
    }, 0);
    const refundedCashToday = todayRefunds.reduce((s, r) => {
      const pm = String((r.orderId && r.orderId.paymentMethod) || '');
      return s + (/^cash$/i.test(pm) ? Number(r.amount || 0) : 0);
    }, 0);

    const grossToday = Math.max(0, grossPaidToday - refundsToday);
    const vatToday = Math.max(0, vatPaidToday - vatRefundedToday);
    const cashToday = Math.max(0, cashPaidToday - refundedCashToday);

        // "Recent Orders" should never look dead: when there are no orders in
        // today's window, fall back to the 20 most recent orders overall so the
        // cashier can still see live rows and confirm payments against them.
        const effectiveRecent =
          recentPaidOrders.length > 0
            ? recentPaidOrders
            : await Order.find({})
                .select('orderId customerName totalAmount paymentMethod paymentStatus createdAt orderStatus status')
                .sort({ createdAt: -1 })
                .limit(20);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      dashboard: {
        date: window.start.toISOString(),
        todayOrders,
        pendingPayments: todayPending,
        grossToday: round2(grossToday),
        vatCollectedToday: round2(vatToday),
        cashCollectedToday: round2(cashToday),
        refundsRequestedToday: round2(refundsToday),
        totalRefundsApproved: totalRefunds,
        netCashAtHand: round2(cashToday),
        recentOrders: effectiveRecent.map((o) => ({
          id: String(o._id),
          orderId: o.orderId,
          customerName: o.customerName,
          totalAmount: o.totalAmount,
          paymentMethod: o.paymentMethod,
          paymentStatus: o.paymentStatus,
          orderStatus: o.orderStatus || o.status,
          createdAt: o.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error('❌ Get Cashier Dashboard Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Confirm / record payment for an order (cash collection at counter)
 * @route   PATCH /api/v1/cashier/orders/:id/mark-paid
 * @access  Private/Cashier + admin roles
 * Body: { method? }
 */
exports.confirmPayment = async (req, res) => {
  try {
    // Never trust the method from the request body beyond upper-casing it. Both
    // `paymentMethod` and `payment.method` are enum fields, so writing an
    // unknown value would store a document that fails its own schema - and then
    // every later whole-document save of that order (refund, cancellation,
    // kitchen queue release, ...) would start failing too. Reject it up front
    // with a 400 the cashier can act on.
    const method = String(req.body.method || 'CASH').toUpperCase();
    if (!PAYMENT_METHOD_VALUES.includes(method)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Unsupported payment method: ${method}`,
      });
    }

    const order = await Order.findOne({
      $or: [
        {
          // `new` is required: in Mongoose 8+ ObjectId is a class, and calling
          // it as a function throws "Class constructor ObjectId cannot be
          // invoked without 'new'". That throw happened on every request with
          // a real order id, so recording a payment failed with a 500 for every
          // order rather than just the unusual ones.
          _id: mongoose.Types.ObjectId.isValid(req.params.id)
            ? new mongoose.Types.ObjectId(req.params.id)
            : null,
        },
        { orderId: req.params.id },
      ].filter(Boolean),
    });

    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }
    if (String(order.paymentStatus || '').toUpperCase() === 'PAID') {
      return res.status(HTTP_STATUS.CONFLICT).json({ success: false, error: 'Order is already paid' });
    }
    if (String(order.orderStatus || '').toUpperCase() === 'CANCELLED') {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ success: false, error: 'Cannot confirm payment on a cancelled order' });
    }

    const paidAt = new Date();

    // Write ONLY the payment fields instead of `order.save()`.
    //
    // A full save re-validates the entire document, so a single pre-existing
    // value that the current schema disagrees with anywhere on the order would
    // reject the save and turn "record this payment" into a 500 - even though
    // the payment itself is perfectly valid. That is exactly what happened to
    // the orders stored with a mobile-money `paymentMethod` before those values
    // were added to the schema. A scoped update also cannot half-apply: the
    // `paymentStatus: { $ne: 'PAID' }` filter makes recording the payment a
    // single atomic step, so two cashiers clicking at once cannot both win.
    const result = await Order.updateOne(
      { _id: order._id, paymentStatus: { $ne: 'PAID' } },
      {
        $set: {
          paymentStatus: 'PAID',
          // Keep the two method fields in step; previously only the nested one
          // was written, which let them drift apart.
          paymentMethod: method,
          'payment.status': 'PAID',
          'payment.method': method,
          'payment.paidAt': paidAt,
        },
      }
    );

    if (result.matchedCount === 0) {
      // Lost the race: someone else recorded the payment first.
      return res.status(HTTP_STATUS.CONFLICT).json({ success: false, error: 'Order is already paid' });
    }

    // Mirror the write onto the loaded document so the steps below (kitchen
    // queue release, audit trail, socket payload) all observe the new state.
    order.paymentStatus = 'PAID';
    order.paymentMethod = method;
    if (order.payment) {
      order.payment.status = 'PAID';
      order.payment.method = method;
      order.payment.paidAt = paidAt;
    }

    // Counter collection is a confirmed payment too, so the order joins the
    // kitchen queue here (payment successful -> order = PENDING -> kitchen).
    try {
      const { releaseOrderToKitchen } = require('../services/order-queue.service');
      await releaseOrderToKitchen(order, {
        actorId: req.user.id,
        reason: `Cashier recorded ${method} payment`,
      });
    } catch (queueError) {
      console.warn('⚠️ Could not release order to the kitchen queue:', queueError.message);
    }

    try {
      await Payment.updateOne(
        { orderId: order._id },
        { $set: { status: 'PAID', method, paidAt } },
        { upsert: true }
      );
    } catch (e) {
      console.warn('Payment upsert skipped (best effort):', e.message);
    }

    await logAction({
      req,
      action: 'CASHIER_PAYMENT_CONFIRMED',
      entityType: 'Order',
      entityId: String(order._id),
      description: `Cashier recorded ${method} payment of ${order.totalAmount} for order #${order.orderId}`,
      result: 'SUCCESS',
      metadata: { method },
    });

    const { emitSocketEvent } = require('../utils/socket');
    const orderSummary = order.getSummary ? order.getSummary() : order.toObject();
    emitSocketEvent('admin', 'order:status', orderSummary);
    emitSocketEvent(`order:${order.orderId}`, 'order:status', orderSummary);

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Payment recorded for order #${order.orderId}`,
      order: {
        id: String(order._id),
        orderId: order.orderId,
        totalAmount: order.totalAmount,
        paymentMethod: method,
        paymentStatus: 'PAID',
        // The real timestamp. This used to read `order.paidAt`, which is not a
        // schema path, so the response always reported `paidAt: null`.
        paidAt,
      },
    });
  } catch (error) {
    console.error('❌ Confirm Payment Error:', error);
    // A transient database outage must not be reported as a 500 - see
    // utils/respondError.js. A genuine validation failure keeps its own status.
    return respondWithError(res, error, MESSAGES.SERVER_ERROR, { exposeMessage: false });
  }
};

/**
 * @desc    Daily cash-up summary (end-of-day reconciliation for the cashier)
 * @route   GET /api/v1/cashier/cashup
 * @access  Private/Cashier + admin roles
 * Query: { date: YYYY-MM-DD } (defaults to today)
 */
exports.getDailyCashup = async (req, res) => {
  try {
    const window = createdAtWindow(req.query.date);
    const dateStr = req.query.date || window.start.toISOString().slice(0, 10);

    const orders = await Order.find({ $and: collectedOrderConditions(window) })
      .select(
        'totalAmount subtotal serviceFee deliveryFee vatAmount vatEnabled platformFee cafeteriaShare platformShare paymentMethod orderId createdAt'
      )
      .lean();

    const totals = orders.reduce(
      (acc, o) => {
        acc.cash = acc.cash + (String(o.paymentMethod || '').toLowerCase() === 'cash' ? o.totalAmount || 0 : 0);
        acc.other = acc.other + (String(o.paymentMethod || '').toLowerCase() !== 'cash' ? o.totalAmount || 0 : 0);
        acc.totals = acc.totals + (o.totalAmount || 0);
        acc.subtotal = acc.subtotal + (o.subtotal || 0);
        acc.serviceFees = acc.serviceFees + (o.serviceFee || 0);
        acc.deliveryFees = acc.deliveryFees + (o.deliveryFee || 0);
        acc.vat = acc.vat + (o.vatAmount || 0);
        acc.platformShare = acc.platformShare + (o.platformShare || 0);
        return acc;
      },
      { cash: 0, other: 0, totals: 0, subtotal: 0, serviceFees: 0, deliveryFees: 0, vat: 0, platformShare: 0 }
    );
    for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);

    const refunds = await Refund.find({
      requestedAt: { $gte: window.start, $lt: window.end },
      status: { $in: REFUNDED_REFUND_STATUSES },
    })
      .select('amount status')
      .lean();
    const refunded = round2(refunds.reduce((s, r) => s + (r.amount || 0), 0));

    res.status(HTTP_STATUS.OK).json({
      success: true,
      cashup: {
        date: dateStr,
        transactionCount: orders.length,
        totalCollected: totals.totals,
        cash: totals.cash,
        electronic: round2(totals.other),
        subtotal: totals.subtotal,
        serviceFeesCollected: totals.serviceFees,
        deliveryFeesCollected: totals.deliveryFees,
        vatCollected: totals.vat,
        platformShare: totals.platformShare,
        cafeteriaShare: round2(totals.subtotal - totals.platformShare),
        refundsToday: refunded,
        netCashAtHand: round2(totals.cash - refunded),
      },
    });
  } catch (error) {
    console.error('❌ Get Daily Cashup Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

function buildOrderFilter(req) {
  const { search, status, paymentStatus, date, from, to, sort = 'newest' } = req.query;
  const conditions = [];

  if (status && status !== 'all') {
    const s = String(status);
    conditions.push({
      $or: [{ orderStatus: s.toUpperCase() }, { status: s.toLowerCase() }, { status: s }],
    });
  }
  if (paymentStatus && paymentStatus !== 'all') {
    conditions.push({ paymentStatus: String(paymentStatus).toUpperCase() });
  }
  if (date) {
    // orderDate is a toLocaleString() string, so a YYYY-MM-DD regex never
    // matched it; filter on createdAt only, over the local day.
    const day = resolveLocalDay(date);
    if (day) conditions.push({ createdAt: { $gte: day.start, $lt: day.end } });
  } else if (from) {
    conditions.push({ createdAt: { $gte: new Date(from) } });
  }
  if (to) {
    conditions.push({ createdAt: { $lte: new Date(to) } });
  }
  if (search) {
    const s = String(search);
    conditions.push({
      $or: [
        { orderId: { $regex: s, $options: 'i' } },
        { customerName: { $regex: s, $options: 'i' } },
        { customerPhone: { $regex: s, $options: 'i' } },
      ],
    });
  }

  const filter = conditions.length ? { $and: conditions } : {};
  const sortOption = sort === 'oldest' ? { createdAt: 1 } : { createdAt: -1 };
  return { filter, sortOption };
}

function serializeOrder(o) {
  return {
    id: String(o._id),
    orderId: o.orderId,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    totalAmount: o.totalAmount,
    subtotal: o.subtotal,
    vatAmount: o.vatAmount,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    orderStatus: o.orderStatus || o.status,
    orderType: o.orderType,
    createdAt: o.createdAt,
    paidAt: o.paidAt || (o.payment && o.payment.paidAt) || null,
    itemCount: Array.isArray(o.items) ? o.items.length : undefined,
  };
}

/**
 * @desc    Cashier order list (search / filter / paginate)
 * @route   GET /api/v1/cashier/orders
 * @access  Private/Cashier + admin roles
 * Query: search, status, paymentStatus, date, from, to, sort, page, limit
 */
exports.getOrders = async (req, res) => {
  try {
    const { filter, sortOption } = buildOrderFilter(req);
    const pageNum = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const [total, orders] = await Promise.all([
      Order.countDocuments(filter),
      Order.find(filter)
        .sort(sortOption)
        .skip(skip)
        .limit(limitNum)
        .select(
          'orderId customerName customerPhone totalAmount subtotal vatAmount paymentMethod paymentStatus orderStatus status orderType createdAt paidAt payment items'
        ),
    ]);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      orders: orders.map((o) => serializeOrder(o)),
    });
  } catch (error) {
    console.error('❌ Get Cashier Orders Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Cashier payment list (read-only)
 * @route   GET /api/v1/cashier/payments
 * @access  Private/Cashier + admin roles
 * Query: method, status, date, search, page, limit
 */
exports.getPayments = async (req, res) => {
  try {
    const { method, status, date, search, page = 1, limit = 20 } = req.query;
    const conditions = [];

    if (method && method !== 'all') {
      conditions.push({ method: String(method).toUpperCase() });
    }
    if (status && status !== 'all') {
      conditions.push({ status: String(status).toUpperCase() });
    }
    if (date) {
      const day = resolveLocalDay(date);
      if (day) conditions.push({ createdAt: { $gte: day.start, $lt: day.end } });
    }
    if (search) {
      const s = String(search);
      const orders = await Order.find({
        $or: [
          { orderId: { $regex: s, $options: 'i' } },
          { customerName: { $regex: s, $options: 'i' } },
        ],
      })
        .select('_id')
        .lean();
      conditions.push({
        $or: [
          { transactionId: { $regex: s, $options: 'i' } },
          { providerReference: { $regex: s, $options: 'i' } },
          ...(orders.length ? [{ orderId: { $in: orders.map((o) => o._id) } }] : []),
        ],
      });
    }

    const filter = conditions.length ? { $and: conditions } : {};
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const [total, payments] = await Promise.all([
      Payment.countDocuments(filter),
      Payment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
    ]);

    const orderIds = payments.map((p) => p.orderId).filter(Boolean);
    const orders = orderIds.length
      ? await Order.find({ _id: { $in: orderIds } }).select('orderId customerName totalAmount').lean()
      : [];
    const orderById = new Map(orders.map((o) => [String(o._id), o]));

    res.status(HTTP_STATUS.OK).json({
      success: true,
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      payments: payments.map((p) => {
        const order = orderById.get(String(p.orderId));
        return {
          id: String(p._id),
          orderId: order ? order.orderId : p.orderId,
          customerName: order ? order.customerName : null,
          method: p.method || p.provider,
          amount: p.amount,
          currency: p.currency || 'ETB',
          paymentStatus: p.status,
          transactionId: p.transactionId,
          paidAt: p.paidAt || p.paymentDate || p.createdAt,
          createdAt: p.createdAt,
        };
      }),
    });
  } catch (error) {
    console.error('❌ Get Cashier Payments Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Paid / billable orders for receipt viewing
 * @route   GET /api/v1/cashier/receipts
 * @access  Private/Cashier + admin roles
 * Query: search, date, page, limit
 */
exports.getReceipts = async (req, res) => {
  try {
    const { search, date, page = 1, limit = 20 } = req.query;
    // The createdAt window defaults to today only when no date was requested;
    // passing one must replace it, not be ANDed with it.
    const conditions = collectedOrderConditions(createdAtWindow(date));
    if (search) {
      const s = String(search);
      conditions.push({
        $or: [
          { orderId: { $regex: s, $options: 'i' } },
          { customerName: { $regex: s, $options: 'i' } },
        ],
      });
    }

    const filter = { $and: conditions };
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const [total, orders] = await Promise.all([
      Order.countDocuments(filter),
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
    ]);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.max(Math.ceil(total / limitNum), 1),
      receipts: orders.map((o) => ({
        id: String(o._id),
        orderId: o.orderId,
        customerName: o.customerName,
        totalAmount: o.totalAmount,
        paymentMethod: o.paymentMethod,
        paymentStatus: o.paymentStatus,
        createdAt: o.createdAt,
        itemCount: Array.isArray(o.items) ? o.items.length : 0,
      })),
    });
  } catch (error) {
    console.error('❌ Get Cashier Receipts Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Single receipt payload for printing / display
 * @route   GET /api/v1/cashier/receipts/:id
 * @access  Private/Cashier + admin roles
 */
exports.getReceipt = async (req, res) => {
  try {
    const id = req.params.id;
    const lookup = [{ orderId: id }];
    if (mongoose.Types.ObjectId.isValid(id)) lookup.push({ _id: id });

    const order = await Order.findOne({ $or: lookup });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }

    const customer = order.userId ? await User.findById(order.userId) : null;

    res.status(HTTP_STATUS.OK).json({
      success: true,
      receipt: {
        orderNumber: order.orderId,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerEmail: customer ? customer.email : null,
        orderType: order.orderType,
        items: (order.items || []).map((i) => ({
          name: i.foodNameSnapshot || i.name,
          qty: i.quantity,
          unitPrice: i.price,
          subtotal: i.subtotal || i.quantity * i.price,
        })),
        subtotal: order.subtotal,
        serviceFee: order.serviceFee,
        vatAmount: order.vatAmount,
        total: order.totalAmount,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        orderDate: order.orderDate,
        createdAt: order.createdAt,
      },
    });
  } catch (error) {
    console.error('❌ Get Cashier Receipt Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};
