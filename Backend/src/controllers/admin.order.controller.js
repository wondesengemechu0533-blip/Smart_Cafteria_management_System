const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Notification = require('../models/Notification');
const { PAYMENT_STATUS, ORDER_STATUS, MESSAGES, HTTP_STATUS } = require('../config/constants');
const { logAction } = require('../utils/audit');
const OrderStatusHistory = require('../models/OrderStatusHistory');
const MenuItem = require('../models/MenuItem');
const StockTransaction = require('../models/StockTransaction');
const Cancellation = require('../models/Cancellation');
const svc = require('../services/cancellation.service');

const PICKUP_FLOW = ['PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED'];
const DELIVERY_FLOW = ['PENDING', 'PREPARING', 'READY', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED'];

// Pick the allowed status flow based on the order's fulfillment type.
const getFlow = (order) =>
  String(order.orderType || '').toLowerCase() === 'delivery' ? DELIVERY_FLOW : PICKUP_FLOW;

// Map uppercase flow status -> value allowed in Order.status enum
const STATUS_TO_LOWERCASE = {
  PENDING: ORDER_STATUS.PENDING,
  PREPARING: ORDER_STATUS.PREPARING,
  READY: ORDER_STATUS.READY,
  PICKED_UP: ORDER_STATUS.PICKED_UP,
  SERVED: ORDER_STATUS.SERVED,
  OUT_FOR_DELIVERY: ORDER_STATUS.OUT_FOR_DELIVERY,
  DELIVERED: ORDER_STATUS.DELIVERED,
  COMPLETED: 'Completed',
  CANCELLED: ORDER_STATUS.CANCELLED
};

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

function normalizeStatus(value) {
  if (!value) return null;
  return String(value).toUpperCase();
}

/**
 * Compute the effective order status from both the legacy `status`
 * (lowercase, updated by kitchen flow) and `orderStatus` (uppercase).
 */
function effectiveStatus(order) {
  const up = normalizeStatus(order.orderStatus);
  const low = normalizeStatus(order.status);
  const FLOW = getFlow(order);

  const indexOf = (s) => FLOW.indexOf(s);
  const upIndex = indexOf(up);
  const lowIndex = indexOf(low);

  // Cancelled wins (terminal)
  if (up === 'CANCELLED' || low === 'CANCELLED') return 'CANCELLED';
  if (upIndex === -1 && lowIndex === -1) return up || low || 'PENDING';
  if (upIndex === -1) return low;
  if (lowIndex === -1) return up;
  return upIndex >= lowIndex ? up : low;
}

function serializeOrder(order) {
  const status = effectiveStatus(order);
  const staff = order.deliveryStaffAssigned;
  return {
    id: order._id,
    orderId: order.orderId,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    userId: order.userId,
    orderType: order.orderType,
    tableNumber: order.tableNumber,
    itemCount: order.items ? order.items.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0) : 0,
    items: (order.items || []).map((i) => ({
      itemId: i.itemId,
      name: i.name,
      quantity: i.quantity,
      price: i.price,
      foodNameSnapshot: i.foodNameSnapshot || i.name,
      foodDescriptionSnapshot: i.foodDescriptionSnapshot || '',
      categoryNameSnapshot: i.categoryNameSnapshot || '',
      foodImageSnapshot: i.foodImageSnapshot || null,
      subtotal: i.subtotal || (Number(i.price) || 0) * (Number(i.quantity) || 0),
      notes: i.notes
    })),
    subtotal: order.subtotal,
    serviceFee: order.serviceFee,
    deliveryFee: order.deliveryFee || 0,
    totalAmount: order.totalAmount,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    status,
    orderDate: order.orderDate,
    orderTime: order.orderTime,
    readyTime: order.readyTime,
    completedTime: order.completedTime,
    deliveryInfo: order.deliveryInfo || null,
    deliveryStaffAssigned: staff ? { id: String(staff._id), name: staff.name, phone: staff.phone, role: staff.role } : null,
    deliveryAssignedAt: order.deliveryAssignedAt || null,
    deliveryStartedAt: order.deliveryStartedAt || null,
    deliveredAt: order.deliveredAt || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    cancellationRequested: order.cancellationRequested,
    cancellationStatus: order.cancellationStatus,
    cancellationReason: order.cancellationReason,
    cancellationAdminNote: order.cancellationAdminNote,
    cancellationProcessedAt: order.cancellationProcessedAt,
    cancellationProcessedBy: order.cancellationProcessedBy,
    inventoryRestored: order.inventoryRestored,
    refundStatus: order.refundStatus,
    refundAmount: order.refundAmount,
    refundReference: order.refundReference,
    refundedAt: order.refundedAt || null
  };
}

function buildStatusFilter(value) {
  const s = normalizeStatus(value);
  if (!s || s === 'ALL') return null;
  return {
    $or: [{ orderStatus: s }, { status: s.toLowerCase() }, { status: s }]
  };
}

/**
 * @desc    Get all orders (admin) - search / filter / sort / paginate
 * @route   GET /api/v1/admin/orders
 * @access  Private/Admin
 * Query: search, status, paymentStatus, orderType, date, sort, page, limit
 * sort:   newest | oldest | amount-desc | amount-asc
 */
exports.getAllOrders = async (req, res) => {
  try {
    const {
      search,
      status,
      paymentStatus,
      orderType,
      date,
      from,
      to,
      sort = 'newest',
      page = 1,
      limit = 20
    } = req.query;

    const conditions = [];

    const statusFilter = buildStatusFilter(status);
    if (statusFilter) conditions.push(statusFilter);

    if (paymentStatus && paymentStatus !== 'all') {
      conditions.push({ paymentStatus: normalizeStatus(paymentStatus) });
    }

    if (orderType && orderType !== 'all') {
      conditions.push({ orderType });
    }

    if (date) {
      const day = String(date);
      conditions.push({
        $or: [
          { orderDate: { $regex: day } },
          { orderTime: { $gte: new Date(`${day}T00:00:00.000Z`), $lte: new Date(`${day}T23:59:59.999Z`) } }
        ]
      });
    } else if (from) {
      conditions.push({ orderTime: { $gte: new Date(from) } });
    }
    if (to) {
      conditions.push({ orderTime: { $lte: new Date(to) } });
    }

    if (search) {
      const s = String(search);
      conditions.push({
        $or: [
          { orderId: { $regex: s, $options: 'i' } },
          { customerName: { $regex: s, $options: 'i' } },
          { customerPhone: { $regex: s, $options: 'i' } }
        ]
      });
    }

    const filter = conditions.length ? { $and: conditions } : {};

    let sortOption = { createdAt: -1 };
    switch (sort) {
      case 'oldest':
        sortOption = { createdAt: 1 };
        break;
      case 'amount-desc':
        sortOption = { totalAmount: -1 };
        break;
      case 'amount-asc':
        sortOption = { totalAmount: 1 };
        break;
      default:
        sortOption = { createdAt: -1 };
    }

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const orders = await Order.find(filter)
      .populate('deliveryStaffAssigned', 'name phone role')
      .sort(sortOption)
      .skip(skip)
      .limit(limitNum);
    const total = await Order.countDocuments(filter);

    // Batch-load customer info
    const userIds = [...new Set(orders.map((o) => String(o.userId)).filter(Boolean))];
    const customers = await User.find({ _id: { $in: userIds } }).select('name email phone role').lean();
    const customerMap = {};
    customers.forEach((c) => (customerMap[String(c._id)] = c));

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: orders.length,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      orders: orders.map((order) => {
        const record = serializeOrder(order);
        const customer = customerMap[String(order.userId)];
        record.customer = customer
          ? { id: customer._id, name: customer.name, email: customer.email, phone: customer.phone, role: customer.role }
          : null;
        return record;
      })
    });
  } catch (error) {
    console.error('❌ Admin Get All Orders Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get single order (admin) with customer + payment details
 * @route   GET /api/v1/admin/orders/:id
 * @access  Private/Admin
 */
exports.getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    let order = null;
    if (isValidObjectId(id)) order = await Order.findById(id).populate('deliveryStaffAssigned', 'name phone role');
    if (!order) order = await Order.findOne({ orderId: id }).populate('deliveryStaffAssigned', 'name phone role');
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }

    const customer = await User.findById(order.userId).select('-password').lean();
    const payment = await Payment.findOne({ orderId: order._id }).lean();

    const record = serializeOrder(order);
    record.customer = customer
      ? { id: customer._id, name: customer.name, email: customer.email, phone: customer.phone, role: customer.role }
      : null;
    record.payment = payment
      ? {
          id: payment._id,
          provider: payment.provider,
          amount: payment.amount,
          status: payment.status,
          transactionId: payment.transactionId,
          reference: payment.reference,
          providerReference: payment.providerReference,
          paidAt: payment.paidAt,
          paymentDate: payment.paymentDate
        }
      : null;
    record.cancellation = {
      requested: order.cancellationRequested,
      reason: order.cancellationReason,
      cancellationStatus: order.cancellationStatus,
      requestedAt: order.cancellationRequestedAt,
      adminNote: order.cancellationAdminNote,
      processedAt: order.cancellationProcessedAt,
      inventoryRestored: order.inventoryRestored,
      refundStatus: order.refundStatus,
      refundAmount: order.refundAmount,
      refundReference: order.refundReference
    };
    record.notes = order.notes;

    res.status(HTTP_STATUS.OK).json({ success: true, order: record });
  } catch (error) {
    console.error('❌ Admin Get Order By ID Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * Enforce business rules for status transitions.
 * PICKUP_FLOW: PENDING -> PREPARING -> READY -> SERVED -> COMPLETED
 * DELIVERY_FLOW: PENDING -> PREPARING -> READY -> OUT_FOR_DELIVERY -> DELIVERED
 * Cancellation is handled separately and only allowed from PENDING/PREPARING.
 * Returns the normalized uppercase status or throws an Error with statusCode.
 */
function assertTransitionAllowed(currentStatus, newStatus, FLOW) {
  const cur = normalizeStatus(currentStatus);
  const next = normalizeStatus(newStatus);

  if (!FLOW.includes(next) && next !== 'CANCELLED') {
    const error = new Error(`Invalid order status. Allowed: ${FLOW.join(', ')} or CANCELLED`);
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }

  if (cur === 'CANCELLED' || cur === 'COMPLETED' || cur === 'DELIVERED') {
    const error = new Error(`Cannot modify an order that is already ${cur}`);
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }

  const curIndex = FLOW.indexOf(cur);
  const nextIndex = FLOW.indexOf(next);

  if (next === 'CANCELLED') {
    if (curIndex > FLOW.indexOf('PREPARING')) {
      const error = new Error(`Order can only be cancelled while PENDING or PREPARING (current: ${cur})`);
      error.statusCode = HTTP_STATUS.BAD_REQUEST;
      throw error;
    }
    return next;
  }

  if (nextIndex !== curIndex + 1) {
    const error = new Error(
      `Invalid status transition: ${cur} -> ${next}. Statuses must advance one step at a time through the flow.`
    );
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }

  return next;
}

/**
 * @desc    Update order status (admin) - respects business flow rules
 * @route   PATCH /api/v1/admin/orders/:id/status
 * @access  Private/Admin
 * Body: { status: 'PREPARING' | 'READY' | 'SERVED' | 'COMPLETED' }
 */
exports.updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Status is required' });
    }

    const { id } = req.params;
    let order = null;
    if (isValidObjectId(id)) order = await Order.findById(id).populate('deliveryStaffAssigned', 'name phone role');
    if (!order) order = await Order.findOne({ orderId: id }).populate('deliveryStaffAssigned', 'name phone role');
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }

    const current = effectiveStatus(order);
    const FLOW = getFlow(order);
    let next;
    try {
      next = assertTransitionAllowed(current, status, FLOW);
    } catch (e) {
      return res.status(e.statusCode || HTTP_STATUS.BAD_REQUEST).json({ success: false, error: e.message });
    }

    order.orderStatus = next;
    order.status = STATUS_TO_LOWERCASE[next];

    if (next === 'READY') {
      order.readyTime = new Date();
    }
    if (next === 'OUT_FOR_DELIVERY') {
      order.deliveryStartedAt = new Date();
    }
    if (next === 'DELIVERED') {
      order.deliveredAt = new Date();
      order.completedTime = new Date();
    }
    if (next === 'SERVED' || next === 'COMPLETED') {
      order.completedTime = new Date();
    }

    await order.save();
    await OrderStatusHistory.create({ orderId: order._id, previousStatus: current, newStatus: next, changedBy: req.user.id });

    await logAction({
      req,
      action: 'ORDER_STATUS_UPDATED',
      entityType: 'Order',
      entityId: String(order.orderId || order._id),
      description: `Updated order #${order.orderId} status from ${current.replace(/_/g, ' ')} to ${next.replace(/_/g, ' ')}`,
    });

    try {
      await Notification.create({
        userId: order.userId,
        title: next === 'READY' ? 'Order Ready!' : `Order ${next}`,
        message: `Your order #${order.orderId} is now ${next.replace(/_/g, ' ').toLowerCase()}.`,
        type: 'status_update',
        orderId: order.orderId,
        isRead: false
      });
    } catch (notifError) {
      // notifications are best effort
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${order.orderId} status updated to ${next}`,
      order: serializeOrder(order)
    });
  } catch (error) {
    console.error('❌ Admin Update Order Status Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Cancel order (admin)
 * @route   PATCH /api/v1/admin/orders/:id/cancel
 * @access  Private/Admin
 * Body: { reason, adminNote }
 */
exports.cancelOrder = async (req, res) => {
  try {
    const { reason, adminNote } = req.body;
    const { id } = req.params;

    let order = null;
    if (isValidObjectId(id)) order = await Order.findById(id).populate('deliveryStaffAssigned', 'name phone role');
    if (!order) order = await Order.findOne({ orderId: id }).populate('deliveryStaffAssigned', 'name phone role');
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }

    const current = effectiveStatus(order);
    if (['CANCELLED', 'COMPLETED', 'SERVED', 'DELIVERED'].includes(current)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Order cannot be cancelled (status: ${current})`
      });
    }
    const FLOW = getFlow(order);
    if (FLOW.indexOf(current) > FLOW.indexOf('PREPARING')) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Order can only be cancelled while PENDING or PREPARING (current: ${current})`
      });
    }

    order.orderStatus = 'CANCELLED';
    order.status = STATUS_TO_LOWERCASE.CANCELLED;
    order.cancellationRequested = false;
    order.cancellationReason = reason || 'Cancelled by admin';
    order.cancellationAdminNote = adminNote || '';
    order.cancellationStatus = 'approved';
    order.cancellationProcessedAt = new Date();
    order.cancellationProcessedBy = req.user.id;
    if (!order.inventoryRestored) {
      for (const orderItem of order.items) {
        const food = await MenuItem.findByIdAndUpdate(orderItem.itemId, { $inc: { stockQuantity: orderItem.quantity } }, { new: true });
        if (food) {
          food.availabilityStatus = food.availability === false ? 'UNAVAILABLE' : 'AVAILABLE';
          await food.save();
          await StockTransaction.create({ foodId: food._id, previousQuantity: food.stockQuantity - orderItem.quantity, quantityChanged: orderItem.quantity, newQuantity: food.stockQuantity, action: 'CANCELLATION_RESTORE', performedBy: req.user.id, orderId: order._id });
        }
      }
      order.inventoryRestored = true;
    }
    const previousStatus = current;
    await order.save();
    await OrderStatusHistory.create({ orderId: order._id, previousStatus, newStatus: 'CANCELLED', changedBy: req.user.id, reason: reason || 'Cancelled by admin' });

    // Keep the standalone Cancellation record in sync (create one if missing).
    try {
      let cancellation = await Cancellation.findOne({ orderId: order._id, isActive: true });
      if (!cancellation) {
        const created = await svc.createCancellation(order, req.user, {
          reason: (reason || 'Cancelled by admin').toUpperCase().replace(/\s+/g, '_').slice(0, 40) || 'OTHER',
          description: reason || 'Cancelled by admin',
          adminNote: adminNote || 'Cancelled by admin',
        });
        cancellation = created.cancellation;
        order = created.order;
      }
      cancellation.status = 'CANCELLED';
      cancellation.approvedAt = new Date();
      cancellation.processedBy = req.user.id;
      cancellation.adminNote = adminNote || cancellation.adminNote || 'Cancelled by admin';
      cancellation.isActive = true;
      await cancellation.save();
      // Re-sync order flat fields (createCancellation reset them for a request flow).
      order.orderStatus = 'CANCELLED';
      order.status = STATUS_TO_LOWERCASE.CANCELLED;
      order.cancellationRequested = false;
      order.cancellationStatus = 'approved';
      order.cancellationAdminNote = adminNote || '';
      order.cancellationProcessedAt = new Date();
      order.cancellationProcessedBy = req.user.id;
      await order.save();
    } catch (syncError) {
      console.error('⚠️ Cancellation record sync failed (admin cancel):', syncError.message);
    }

    try {
      await Notification.create({
        userId: order.userId,
        title: 'Order Cancelled',
        message: `Your order #${order.orderId} has been cancelled${adminNote ? ': ' + adminNote : '.'}`,
        type: 'cancellation',
        orderId: order.orderId,
        isRead: false
      });
    } catch (notifError) {
      // best effort
    }

    await logAction({
      req,
      action: 'ORDER_CANCELLED',
      entityType: 'Order',
      entityId: String(order.orderId || order._id),
      description: `Admin cancelled order #${order.orderId}${reason ? ' - reason: ' + reason : ''}`
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${order.orderId} cancelled successfully`,
      order: serializeOrder(order)
    });
  } catch (error) {
    console.error('❌ Admin Cancel Order Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Order statistics (admin)
 * @route   GET /api/v1/admin/orders/stats
 * @access  Private/Admin
 */
exports.getOrderStats = async (req, res) => {
  try {
    const all = await Order.find({}).select('status orderStatus totalAmount createdAt').lean();

    const count = (status) => all.filter((o) => effectiveStatus(o) === status).length;
    const totalOrders = all.length;
    const pendingOrders = count('PENDING');
    const preparingOrders = count('PREPARING');
    const readyOrders = count('READY');
    const servedOrders = count('SERVED');
    const outForDeliveryOrders = count('OUT_FOR_DELIVERY');
    const deliveredOrders = count('DELIVERED');
    const completedOrders = count('COMPLETED');
    const cancelledOrders = count('CANCELLED');

    const completedOrServed = all.filter(
      (o) => effectiveStatus(o) === 'COMPLETED' || effectiveStatus(o) === 'SERVED' || effectiveStatus(o) === 'DELIVERED'
    );
    const totalRevenue = completedOrServed.reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayOrders = all.filter((o) => {
      const d = o.createdAt || o.orderTime;
      return d && new Date(d) >= todayStart;
    }).length;

    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: {
        totalOrders,
        pendingOrders,
        preparingOrders,
        readyOrders,
        servedOrders,
        outForDeliveryOrders,
        deliveredOrders,
        completedOrders,
        cancelledOrders,
        totalRevenue,
        todayOrders
      }
    });
  } catch (error) {
    console.error('❌ Admin Get Order Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Refund a cancelled order (Admin)
 * @route   POST /api/v1/admin/orders/:id/refund
 * @access  Private/Admin
 * Reviews + processes a refund for a cancelled order: marks the order payment
 * status REFUNDED, saves the refund reference/date-time, sends a customer
 * notification, and keeps the Cancellation/Payment records in sync.
 */
exports.refundOrder = async (req, res) => {
  try {
    const { id } = req.params;

    let order = null;
    if (isValidObjectId(id)) order = await Order.findById(id).populate('deliveryStaffAssigned', 'name phone role');
    if (!order) order = await Order.findOne({ orderId: id }).populate('deliveryStaffAssigned', 'name phone role');
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }

    const current = effectiveStatus(order);
    const isCancelled = current === 'CANCELLED' || String(order.status || '').toLowerCase() === 'cancelled';
    if (!isCancelled) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: `Only cancelled orders can be refunded (current: ${current})` });
    }

    // Check payment eligibility: both the top-level paymentStatus and the
    // embedded payment.status must indicate the payment was completed.
    const topPaymentStatus = String(order.paymentStatus || '').toUpperCase();
    const embeddedPaymentStatus = order.payment && order.payment.status
      ? String(order.payment.status).toUpperCase()
      : topPaymentStatus;
    const isPaid = topPaymentStatus === 'PAID' || embeddedPaymentStatus === 'PAID';
    if (!isPaid) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Order is not eligible for a refund (payment was not completed)' });
    }
    if (String(order.refundStatus || '').toUpperCase() === 'REFUNDED') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Refund already processed for this order' });
    }

    // Process the refund through the shared cancellation service (single source of truth):
    // request -> mark processing -> confirm (simulated provider confirmation).
    let cancellation = await svc.findActiveCancellation(order);
    if (!cancellation) {
      const created = await svc.createCancellation(order, req.user, {
        reason: 'ADMIN_REFUND',
        description: 'Cancellation refunded by admin',
        adminNote: 'Refunded by admin',
      });
      cancellation = created.cancellation;
      order = created.order;
      cancellation.status = 'CANCELLED';
      cancellation.approvedAt = new Date();
      cancellation.processedBy = req.user.id;
      cancellation.isActive = true;
      await cancellation.save();
      order.orderStatus = 'CANCELLED';
      order.status = STATUS_TO_LOWERCASE.CANCELLED;
      order.cancellationStatus = 'approved';
      order.cancellationProcessedAt = new Date();
      order.cancellationProcessedBy = req.user.id;
      await order.save();
    }

    await svc.requestRefund({ order, cancellation, amount: order.totalAmount, actorId: req.user.id });
    await svc.markRefundProcessing({ order, cancellation, reference: cancellation.refundReference });
    await svc.confirmRefund({ cancellation, order, providerReference: cancellation.refundReference, actorId: req.user.id });

    // Keep the standalone Payment record in sync (best effort).
    try {
      await Payment.findOneAndUpdate(
        { orderId: order._id },
        { status: 'REFUNDED', refundStatus: 'REFUNDED', refundedAt: new Date(), refundAmount: cancellation.refundAmount, refundReference: cancellation.refundReference }
      );
    } catch (_) { /* best effort */ }

    // Also update the embedded payment.status on the order document.
    try {
      order.payment.status = 'REFUNDED';
      await order.save();
    } catch (_) { /* best effort */ }

    await logAction({
      req,
      action: 'ORDER_REFUNDED',
      entityType: 'Order',
      entityId: String(order.orderId || order._id),
      description: `Admin refunded cancelled order #${order.orderId} (${cancellation.refundAmount} ETB)`
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Refund processed for order #${order.orderId}`,
      order: serializeOrder(order),
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    console.error('❌ Admin Refund Order Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};