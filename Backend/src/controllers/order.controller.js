const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const MenuItem = require('../models/MenuItem');
const Notification = require('../models/Notification');
const { ORDER_STATUS, PAYMENT_STATUS, PAYMENT_METHODS, MESSAGES, HTTP_STATUS } = require('../config/constants');
const { getSettingsMap } = require('../utils/settings');
const StockTransaction = require('../models/StockTransaction');
const OrderStatusHistory = require('../models/OrderStatusHistory');

/**
* @desc    Create new order
* @route   POST /api/orders
* @access  Private
*
* Frontend: checkout.js → Place Order
* Expected Body: { items, customerName, customerPhone, orderType, tableNumber, paymentMethod, totalAmount }
* Response: { success, order }
*/
exports.createOrder = async (req, res) => {
let reservations = [];
try {
const {
items,
customerName,
customerPhone,
orderType = 'dine-in',
tableNumber = 'N/A',
paymentMethod,
totalAmount,
notes,
deliveryInfo
} = req.body;
const normalizedPaymentMethod = String(paymentMethod || '').toUpperCase();

// ✅ Validate required fields
if (!items || !Array.isArray(items) || items.length === 0) {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,
error: 'Order must have at least one item'
});
}

if (!customerName || !customerPhone) {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,
error: 'Customer name and phone are required'
});
}

if (!Object.values(PAYMENT_METHODS).includes(normalizedPaymentMethod)) {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,
error: 'Payment method must be CHAPA'
});
}

// ✅ Validate items and calculate subtotal
let subtotal = 0;
const validatedItems = [];

for (const item of items) {
let menuItem = null;

if (item.id && mongoose.Types.ObjectId.isValid(item.id)) {
menuItem = await MenuItem.findById(item.id);
}

if (!menuItem && item.name) {
const cleanName = String(item.name).trim();
menuItem = await MenuItem.findOne({
$or: [
{ 'name.en': { $regex: new RegExp(`^${cleanName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i') } },
{ 'name.am': cleanName }
]
});
}

    if (!menuItem) return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Food item not found' });
const quantity = parseInt(item.quantity);
if (!Number.isInteger(quantity) || quantity < 1) return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Quantity must be at least 1' });

// Auto-repair: if item is active + available but availabilityStatus is stale, fix it
if (menuItem.isActive && menuItem.availability !== false && menuItem.isAvailable !== false && menuItem.availabilityStatus !== 'AVAILABLE') {
  await MenuItem.updateOne({ _id: menuItem._id }, { $set: { availabilityStatus: 'AVAILABLE' } });
  menuItem.availabilityStatus = 'AVAILABLE';
}

// Check stock
const currentStock = menuItem.stockQuantity || 0;
if (currentStock < quantity) {
  return res.status(HTTP_STATUS.CONFLICT).json({
    success: false,
    error: currentStock === 0
      ? `"${menuItem.name?.en || item.name}" is currently out of stock.`
      : `Only ${currentStock} "${menuItem.name?.en || item.name}" left in stock.`
  });
}

// Atomic stock reservation
const reserved = await MenuItem.findOneAndUpdate(
  { _id: menuItem._id, isActive: true, availability: true, isAvailable: true, stockQuantity: { $gte: quantity } },
  { $inc: { stockQuantity: -quantity } },
  { new: false }
);
if (!reserved) return res.status(HTTP_STATUS.CONFLICT).json({ success: false, error: `Only ${menuItem.stockQuantity || 0} items are currently available.` });
reservations.push({ id: menuItem._id, quantity, previous: reserved.stockQuantity });
const price = menuItem.price;
const name = menuItem ? (menuItem.name?.en || menuItem.name) : (item.name || 'Food Item');
      const itemTotal = price * quantity;
      subtotal += itemTotal;

      validatedItems.push({
        itemId: menuItem ? menuItem._id : new mongoose.Types.ObjectId(),
        name: name,
        quantity: quantity,
        price: price,
        notes: item.notes || ''
        , foodNameSnapshot: name
        , foodDescriptionSnapshot: menuItem.description?.en || ''
        , categoryNameSnapshot: menuItem.category || ''
        , foodImageSnapshot: menuItem.image || null
        , subtotal: itemTotal
      });
    }

    // ✅ Enforce system settings: maintenance mode, order availability, max order quantity
    const settings = await getSettingsMap();
    if (settings.maintenance_mode) {
      return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
        success: false,
        error: 'System is under maintenance. Please try again later.'
      });
    }
    if (settings.order_availability === false) {
      return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
        success: false,
        error: 'Online ordering is currently unavailable.'
      });
    }
    const maxQty = Number(settings.max_order_quantity) || 10;
    const totalQty = validatedItems.reduce((sum, i) => sum + i.quantity, 0);
    if (totalQty > maxQty) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Maximum order quantity is ${maxQty} items.`
      });
    }

    // ✅ Calculate totals
const serviceFee = 20;
const isDelivery = String(orderType).toLowerCase() === 'delivery';
const deliveryFee = isDelivery ? Number((await getSettingsMap()).delivery_fee) || 0 : 0;
const total = subtotal + serviceFee + deliveryFee;

// ✅ Create order
const order = await Order.create({
userId: req.user.id,
customerName: customerName.trim(),
customerPhone: customerPhone,
orderType: orderType,
tableNumber: tableNumber,
deliveryInfo: isDelivery
  ? {
      subCity: deliveryInfo?.subCity || '',
      location: deliveryInfo?.location || '',
      note: deliveryInfo?.note || '',
      phone: deliveryInfo?.phone || customerPhone || ''
    }
  : undefined,
deliveryFee: deliveryFee,
items: validatedItems,
subtotal: subtotal,

serviceFee: serviceFee,
totalAmount: total,
paymentMethod: normalizedPaymentMethod,
paymentStatus: PAYMENT_STATUS.PENDING,
payment: {
method: normalizedPaymentMethod,
status: PAYMENT_STATUS.PENDING,
amount: total,
currency: 'ETB'
},
orderStatus: 'PENDING',
status: ORDER_STATUS.PENDING,
orderDate: new Date().toLocaleString(),
notes: notes || ''
});
await OrderStatusHistory.create({ orderId: order._id, previousStatus: 'NONE', newStatus: 'PENDING', changedBy: req.user.id, reason: 'Order placed' });
for (const reservation of reservations) {
  const updated = await MenuItem.findById(reservation.id);
  if (updated) {
    if (updated.stockQuantity === 0) {
      updated.availabilityStatus = 'OUT_OF_STOCK';
    } else if (updated.availability !== false && updated.isAvailable !== false) {
      updated.availabilityStatus = 'AVAILABLE';
    }
    await updated.save();
    await StockTransaction.create({ foodId: updated._id, previousQuantity: reservation.previous, quantityChanged: -reservation.quantity, newQuantity: updated.stockQuantity, action: 'ORDER', performedBy: req.user.id, orderId: order._id });
  }
}

// ✅ Emit socket event for new order (kitchen + admin dashboard real-time updates)
const { emitSocketEvent } = require('../utils/socket');
const orderSummary = order.getSummary();
// Real customer information straight from the backend (authenticated user).
const orderPayload = {
  ...orderSummary,
  id: order._id,
  orderStatus: order.orderStatus,
  createdAt: order.createdAt,
  customer: {
    id: String(req.user.id),
    name: req.user.name || order.customerName,
    email: req.user.email || '',
    phone: req.user.phone || order.customerPhone,
    role: req.user.role || 'customer'
  }
};
emitSocketEvent('kitchen', 'order:new', orderPayload);
emitSocketEvent('admin', 'order:new', orderPayload);
emitSocketEvent(`order:${order.orderId}`, 'order:created', orderPayload);
if (isDelivery) {
  emitSocketEvent('delivery', 'delivery:new', orderPayload);
}

res.status(HTTP_STATUS.CREATED).json({
success: true,
message: MESSAGES.ORDER_PLACED,
order: orderSummary
});

} catch (error) {
console.error('❌ Create Order Error:', error);
for (const reservation of reservations) {
  await MenuItem.findByIdAndUpdate(reservation.id, { $inc: { stockQuantity: reservation.quantity } }).catch(() => {});
}
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR

});
}
};

/**
* @desc    Get all orders (Admin only)
* @route   GET /api/orders
* @access  Private/Admin
*
* Frontend: admin/orders.html → Load all orders
* Query Params: status, paymentStatus, date
* Response: { success, count, orders: [...] }
*/
exports.getAllOrders = async (req,

res) => {
try {
const { status, paymentStatus, date, limit = 50, page = 1 } = req.query;

// ✅ Build filter
let filter = {};
if (status && status !== 'all') filter.status = status;
if (paymentStatus && paymentStatus !== 'all') filter.paymentStatus = paymentStatus;
if (date) filter.orderDate = { $regex: date };

// ✅ Pagination

const skip = (parseInt(page) - 1) * parseInt(limit);

// ✅ Execute query
const orders = await Order.find(filter)
.sort({ createdAt: -1 })
.skip(skip)
.limit(parseInt(limit));

const total = await Order.countDocuments(filter);

res.status(HTTP_STATUS.OK).json({
success: true,
count: orders.length,
total: total,

orders: orders.map(order => order.getSummary())
});

} catch (error) {
console.error('❌ Get All Orders Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**

* @desc    Get user's orders
* @route   GET /api/orders/myorders
* @access  Private
*
* Frontend: order-history.js → Load user orders
* Response: { success, count, orders: [...] }
*/
exports.getMyOrders = async (req, res) => {
try {
// ✅ Only show orders created today (past orders are hidden from the customer dashboard)
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);

const orders = await Order.find({ userId: req.user.id, createdAt: { $gte: todayStart } })
.sort({ createdAt: -1 });



res.status(HTTP_STATUS.OK).json({
success: true,
count: orders.length,
orders: orders.map(order => order.getSummary())
});

} catch (error) {
console.error('❌ Get My Orders Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}

};

/**
* @desc    Get order by ID
* @route   GET /api/orders/:id
* @access  Private
*
* Frontend: order-status.js → Load order details
* Response: { success, order }
*/
exports.getOrderById = async (req, res) => {
try {
const order = await Order.findOne({ orderId: req.params.id });

if (!order) {
return res.status(HTTP_STATUS.NOT_FOUND).json({
success: false,
error: 'Order not found'
});
}

// ✅ Check if user owns order or is admin / kitchen staff
const viewerRole = String(req.user.role || '').toLowerCase();
const isStaff = ['admin', 'staff', 'kitchen', 'kitchen_staff', 'foodmaker'].includes(viewerRole);
if (order.userId.toString() !== req.user.id.toString() && !isStaff) {
return res.status(HTTP_STATUS.FORBIDDEN).json({
success: false,

error: 'Unauthorized to view this order'
});
}

res.status(HTTP_STATUS.OK).json({
success: true,
order: {
...order.getSummary(),
items: order.items,
orderDate: order.orderDate,
orderTime: order.orderTime,
readyTime: order.readyTime,
completedTime: order.completedTime,
cancellationReason:

order.cancellationReason,
notes: order.notes
}
});

} catch (error) {
console.error('❌ Get Order By ID Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**
* @desc    Update order status (Kitchen/Admin)
* @route   PATCH /api/orders/:id/status
* @access  Private/Kitchen/Admin
*
* Frontend: kitchen/dashboard.html → Update status
* Expected Body: { status }
* Response: { success, order }
*/
exports.updateOrderStatus = async (req, res) => {
try {
const { status } = req.body;

// ✅ Validate status

const validStatuses = ['pending', 'preparing', 'ready', 'served', 'out_for_delivery', 'delivered', 'cancelled'];
if (!validStatuses.includes(status)) {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,
error: 'Invalid status'
});
}

const order = await Order.findOne({ orderId: req.params.id });
if (!order) {
return

res.status(HTTP_STATUS.NOT_FOUND).json({
success: false,
error: 'Order not found'
});
}

// ✅ Update status
order.status = status;

// ✅ Set timestamps
if (status === 'ready') {
order.readyTime = new Date();
}
if (status === 'served') {
order.completedTime = new Date();
}
if (status === 'out_for_delivery') {
order.deliveryStartedAt = new Date();
}
if (status === 'delivered') {
order.deliveredAt = new Date();
order.completedTime = new Date();
}


await order.save();

// ✅ Emit socket event for order status update
const { emitSocketEvent } = require('../utils/socket');
const orderSummary = order.getSummary();
emitSocketEvent('kitchen', 'order:status', orderSummary);
emitSocketEvent(`order:${order.orderId}`, 'order:status', orderSummary);
if (order.orderType === 'delivery') {
  emitSocketEvent('delivery', 'order:status', orderSummary);
}

// ✅ Create notification for customer
const readyMsg = order.orderType === 'delivery' ? 'ready for delivery' : 'ready for pickup';
const statusTitle = {
  ready: order.orderType === 'delivery' ? 'Order Ready for Delivery!' : 'Order Ready!',
  out_for_delivery: 'Order Out for Delivery!',
  delivered: 'Order Delivered!',
  preparing: 'Order Preparing'
};
const statusMessage = {
  ready: `Your order #${order.orderId} is ${readyMsg}!`,
  out_for_delivery: `Your order #${order.orderId} is out for delivery. Our delivery person is on the way!`,
  delivered: `Your order #${order.orderId} has been delivered. Enjoy your meal!`,
  preparing: `Your order #${order.orderId} is being prepared`
};
if (statusMessage[status]) {
const notification = await Notification.create({
userId: order.userId,
title: statusTitle[status],
message: statusMessage[status],
type: status === 'ready' ? 'ready' : 'status_update',
orderId: order.orderId,
isRead: false
});

// ✅ Send real-time notification to correct customer only (user room)
emitSocketEvent(`user:${order.userId}`, 'notification:new', {
    id: notification._id,
    title: notification.title,
    message: notification.message,
    type: notification.type,
    orderId: notification.orderId,
    link: notification.link || `/src/pages/customer/order-tracking.html?orderId=${order.orderId}`,
    isRead: notification.isRead,
    createdAt: notification.createdAt
});
}

res.status(HTTP_STATUS.OK).json({
success: true,
message: `Order status updated to ${status}`,
order: orderSummary
});

} catch (error) {
console.error('❌ Update Order Status Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**
* @desc    Cancel order (Customer)
* @route   PATCH /api/orders/:id/cancel
* @access  Private
*
* Frontend: order-status.js → Cancel Order
* Expected Body: { reason }
* Response: { success, message }

*/
exports.cancelOrder = async (req, res) => {
try {
const { reason } = req.body;

const order = await Order.findOne({ orderId: req.params.id });
if (!order) {
return res.status(HTTP_STATUS.NOT_FOUND).json({
success: false,
error: 'Order not found'
});
}

// ✅ Check if user owns order
if (order.userId.toString() !== req.user.id) {
return res.status(HTTP_STATUS.FORBIDDEN).json({
success: false,
error: 'You can only cancel your own orders'
});
}

// ✅ Check if order can be cancelled (use both status fields)
const currentStatus = String(order.orderStatus || order.status || '').toUpperCase();
if (['CANCELLED', 'COMPLETED', 'DELIVERED', 'SERVED'].includes(currentStatus)) {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,
error: `Order cannot be cancelled (status: ${currentStatus})`
});
}

// ✅ Only PENDING orders can be cancelled by customer
if (currentStatus !== 'PENDING') {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,
error: `Order can only be cancelled while pending (current status: ${currentStatus})`
});
}

// ✅ For PAID orders, route through the cancellation service which handles
//    refund requests and admin notification (PENDING → CANCELLED → Admin Refund → REFUNDED)
const paid = String(order.paymentStatus || '').toUpperCase() === 'PAID';
if (paid) {
  const svc = require('../services/cancellation.service');
  const { cancellation } = await svc.createCancellation(
    order,
    req.user,
    { reason: reason || 'CUSTOMER_CHANGED_MIND', description: reason || 'Cancelled by customer', source: 'customer' }
  );

  // Approve immediately (PENDING order is always cancellable)
  cancellation.status = 'APPROVED';
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

  // Mark refund as requested — admin will process it
  cancellation.refundStatus = 'REFUND_REQUESTED';
  cancellation.refundAmount = order.totalAmount;
  await cancellation.save();

  order.refundStatus = 'REFUND_REQUESTED';
  order.refundAmount = order.totalAmount;
  await order.save();

  const Payment = require('../models/Payment');
  try {
    await Payment.findOneAndUpdate(
      { orderId: order._id },
      { status: 'PAID', refundStatus: 'PENDING', refundAmount: order.totalAmount },
    );
  } catch (_) { /* best effort */ }

  const Notification = require('../models/Notification');
  const notice = await Notification.create({
    userId: order.userId,
    title: 'Order Cancelled',
    message: `Your order #${order.orderId} has been cancelled. Your refund of ${order.totalAmount} ETB will be processed shortly.`,
    type: 'order',
    orderId: order.orderId,
    isRead: false,
  });
  try { await svc.emitUserNotification(order.userId, notice, order); } catch (_) { /* best effort */ }

  await svc.emitOrderStatusRealtime(order);
  try { await svc.emitCancellationQueueUpdate(await svc.serializeCancellation(cancellation, order)); } catch (_) { /* best effort */ }

  res.status(HTTP_STATUS.OK).json({
    success: true,
    message: `Order #${order.orderId} cancelled successfully. Your refund will be processed by an administrator.`
  });
  return;
}

// ✅ For unpaid orders, cancel directly (no refund needed)
order.status = 'cancelled';
order.orderStatus = 'CANCELLED';
order.refundStatus = 'NOT_REQUIRED';
order.cancellationReason = reason || 'Cancelled by customer';
order.cancellationStatus = 'approved';
order.cancellationProcessedAt = new Date();
order.cancellationProcessedBy = req.user.id;
await order.save();

const svc = require('../services/cancellation.service');
await svc.emitOrderStatusRealtime(order);

const Notification = require('../models/Notification');
const notice = await Notification.create({
  userId: order.userId,
  title: 'Order Cancelled',
  message: `Your order #${order.orderId} has been cancelled.`,
  type: 'order',
  orderId: order.orderId,
  isRead: false,
});
try { await svc.emitUserNotification(order.userId, notice, order); } catch (_) { /* best effort */ }

res.status(HTTP_STATUS.OK).json({
  success: true,
  message: `Order #${order.orderId} cancelled successfully`
});

} catch (error) {
console.error('❌ Cancel Order Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**
* @desc    Get order statistics

(Admin only)
* @route   GET /api/orders/stats
* @access  Private/Admin
*
* Frontend: admin/dashboard.html → Metrics
* Response: { totalOrders, pendingOrders, preparingOrders, completedOrders, totalRevenue }
*/
exports.getOrderStats = async (req, res) => {
try {
const totalOrders = await Order.countDocuments();
const pendingOrders = await Order.countDocuments({ status: 'pending' });

const preparingOrders = await Order.countDocuments({ status: 'preparing' });
const readyOrders = await Order.countDocuments({ status: 'ready' });
const completedOrders = await Order.countDocuments({ status: 'served' });
const cancelledOrders = await Order.countDocuments({ status: 'cancelled' });

// ✅ Calculate revenue (only completed orders)
const completedOrdersData = await Order.find({ status: 'served' });
const totalRevenue =

completedOrdersData.reduce((sum, order) => sum + order.totalAmount, 0);

// ✅ Today's orders
const today = new Date().toISOString().split('T')[0];
const todayOrders = await Order.countDocuments({
orderDate: { $regex: today }
});

res.status(HTTP_STATUS.OK).json({
success: true,
stats: {
totalOrders,
pendingOrders,

preparingOrders,
readyOrders,
completedOrders,
cancelledOrders,
totalRevenue,
todayOrders
}
});

} catch (error) {
console.error('❌ Get Order Stats Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR

});
}
};

/**
* @desc    Get kitchen orders (For Kitchen Dashboard)
* @route   GET /api/orders/kitchen
* @access  Private/Kitchen
*
* Frontend: kitchen/dashboard.html → Live orders
* Response: { success, orders: [...] }
*/
exports.getKitchenOrders = async (req, res) => {
try {
const orders = await Order.find({

status: { $in: ['pending', 'preparing', 'ready'] }
})
.sort({ createdAt: 1 });

res.status(HTTP_STATUS.OK).json({
success: true,
count: orders.length,
orders: orders.map(order => ({
...order.getSummary(),
items: order.items,
orderTime: order.orderTime
}))
});

} catch (error) {
console.error('Get Kitchen Orders Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};
