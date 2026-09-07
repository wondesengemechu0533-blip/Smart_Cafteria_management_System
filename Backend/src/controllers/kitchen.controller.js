const Order = require('../models/Order');
const Notification = require('../models/Notification');
const { ORDER_STATUS, MESSAGES, HTTP_STATUS } = require('../config/constants');

const KITCHEN_STATUSES = ['pending', 'preparing', 'ready'];
const KITCHEN_STATUS_VALUES = [...KITCHEN_STATUSES, 'PENDING', 'PREPARING', 'READY', 'Received', 'RECEIVED'];

function getKitchenStatus(order) {
const status = String(order.status || '').toLowerCase();
if (KITCHEN_STATUSES.includes(status)) return status;
if (status === 'received') return 'pending';

const legacyStatus = String(order.orderStatus || '').toLowerCase();
if (legacyStatus === 'received') return 'pending';
return KITCHEN_STATUSES.includes(legacyStatus) ? legacyStatus : status;
}

/**
* @desc    Get kitchen dashboard data
* @route   GET /api/kitchen/dashboard
* @access  Private/Kitchen
*
* Frontend: kitchen/dashboard.html → Load dashboard
* Response: { success, stats, orders }
*/
exports.getKitchenDashboard = async (req, res) => {
try {
// ✅ Only show orders created today (past orders are hidden from the board)
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);

const activeOrders = await

Order.find({
 $or: [
 { status: { $in: KITCHEN_STATUS_VALUES } },
 { orderStatus: { $in: ['PENDING', 'PREPARING', 'READY', 'RECEIVED'] } }
 ],
createdAt: { $gte: todayStart }
})
.populate('userId', 'name phone')
.sort({ createdAt: 1 });

// ✅ Group by status
const pendingOrders = activeOrders.filter(o => getKitchenStatus(o) === 'pending');
const preparingOrders = activeOrders.filter(o => getKitchenStatus(o) === 'preparing');
const readyOrders = activeOrders.filter(o => getKitchenStatus(o) === 'ready');
const today = new Date();
today.setHours(0, 0, 0, 0);
const completedToday = await Order.countDocuments({
status: 'served',
completedTime: { $gte: today }
});

// ✅ Stats for dashboard
const stats = {
pending: pendingOrders.length,
preparing: preparingOrders.length,
ready: readyOrders.length,

activeOrders: activeOrders.length,
completedToday: completedToday,
totalActive: activeOrders.length
};

res.status(HTTP_STATUS.OK).json({
success: true,
stats,
orders: {
pending: pendingOrders.map(o => formatKitchenOrder(o)),
preparing: preparingOrders.map(o =>

formatKitchenOrder(o)),
ready: readyOrders.map(o => formatKitchenOrder(o))
}
});

} catch (error) {
console.error('❌ Get Kitchen Dashboard Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};


/**
* @desc    Get kitchen orders (list view)
* @route   GET /api/kitchen/orders
* @access  Private/Kitchen
*
* Frontend: kitchen/orders.html → Load orders list
* Query Params: status
* Response: { success, count, orders: [...] }
*/
exports.getKitchenOrders = async (req, res) => {
try {
const { status } = req.query;

// ✅ Only show orders created today (past orders are hidden from the board)
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);
let filter = { createdAt: { $gte: todayStart } };
if (status && status !== 'all') {
const normalizedStatus = String(status).toLowerCase();
filter.$or = [
  { status: normalizedStatus },
  { status: normalizedStatus.toUpperCase() },
  { orderStatus: normalizedStatus.toUpperCase() }
];
} else {
filter.$or = [
  { status: { $in: ['pending', 'preparing', 'ready', 'served', 'PENDING', 'PREPARING', 'READY', 'SERVED', 'Received', 'RECEIVED'] } },
  { orderStatus: { $in: ['PENDING', 'PREPARING', 'READY', 'SERVED', 'RECEIVED'] } }
];
}

const orders = await Order.find(filter)
.populate('userId', 'name phone')
.sort({ createdAt: -1 });

res.status(HTTP_STATUS.OK).json({
success: true,

count: orders.length,
orders: orders.map(o => formatKitchenOrder(o))
});

} catch (error) {
console.error('❌ Get Kitchen Orders Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**
* @desc    Accept order (Kitchen)
* @route   PATCH /api/kitchen/orders/:orderId/accept
* @access  Private/Kitchen
*
* Frontend: kitchen/dashboard.html → Accept order
* Response: { success, message, order }
*/
exports.acceptOrder = async (req, res) => {
try {
const { orderId } = req.params;

const order = await Order.findOne({ orderId: orderId });

if (!order) {
return res.status(HTTP_STATUS.NOT_FOUND).json({
success: false,
error: 'Order not found'
});
}

// ✅ Check if order can be accepted
if (getKitchenStatus(order) !== 'pending') {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,
error: `Order cannot be accepted (status: ${order.status})`

});
}

// ✅ Update status to preparing
order.status = ORDER_STATUS.PREPARING;

// ✅ Calculate and set estimated completion time
const MenuItem = require('../models/MenuItem');
let maxPrepTime = 0;

for (const item of order.items) {
  const menuItem = await MenuItem.findById(item.itemId);
  if (menuItem) {
    maxPrepTime = Math.max(maxPrepTime, menuItem.preparationTime || 10);
  }
}

// Add buffer for multiple items (2 minutes per additional item)
const itemBuffer = Math.ceil((order.items.length - 1) * 2);
const estimatedMinutes = maxPrepTime + itemBuffer;
order.estimatedCompletionTime = new Date(Date.now() + estimatedMinutes * 60000);

// Assign to current staff member
order.kitchenStaffAssigned = req.user._id;

// Initialize item statuses
order.items.forEach(item => {
  if (!item.itemStatus) {
    item.itemStatus = 'preparing';
  }
});

await order.save();

// ✅ Emit socket event for order status update
const { emitSocketEvent } = require('../utils/socket');
const orderSummary = formatKitchenOrder(order);
emitSocketEvent('kitchen', 'order:status', orderSummary);
emitSocketEvent(`order:${orderId}`, 'order:status', orderSummary);

// ✅ Notify customer - saved for offline, emitted for online (only to correct customer)
const notification = await Notification.create({
userId: order.userId,
title: 'Order Accepted!',
message: `Your order #${orderId} has been accepted and is being prepared by the kitchen. Estimated time: ${estimatedMinutes} minutes`,
type: 'status_update',
orderId: orderId,
link: `/src/pages/customer/order-tracking.html?orderId=${orderId}`,
isRead: false
});

// ✅ Send real-time notification to correct customer only (user room)
emitSocketEvent(`user:${order.userId}`, 'notification:new', {
    id: notification._id,
    title: notification.title,
    message: notification.message,
    type: notification.type,
    orderId: notification.orderId,
    link: notification.link,
    isRead: notification.isRead,
    createdAt: notification.createdAt
});

res.status(HTTP_STATUS.OK).json({
success: true,
message: `Order #${orderId} accepted and is now being prepared`,
order: formatKitchenOrder(order)
});

} catch (error) {
console.error('❌ Accept Order Error:', error);


res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**
* @desc    Mark order as ready (Kitchen)
* @route   PATCH /api/kitchen/orders/:orderId/ready
* @access  Private/Kitchen
*
* Frontend: kitchen/dashboard.html → Mark ready

* Response: { success, message, order }
*/
exports.markOrderReady = async (req, res) => {
try {
const { orderId } = req.params;

const order = await Order.findOne({ orderId: orderId });
if (!order) {
return res.status(HTTP_STATUS.NOT_FOUND).json({
success: false,
error: 'Order not found'
});
}


// ✅ Check if order can be marked ready
if (order.status !== 'preparing') {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,
error: `Order cannot be marked ready (status: ${order.status})`
});
}

// ✅ Update status to ready
order.status = ORDER_STATUS.READY;
order.readyTime = new Date();
const isDelivery = String(order.orderType || '').toLowerCase() === 'delivery';

await order.save();

// ✅ Emit socket event for order status update
const { emitSocketEvent } = require('../utils/socket');
const orderSummary = formatKitchenOrder(order);
emitSocketEvent('kitchen', 'order:status', orderSummary);
emitSocketEvent(`order:${orderId}`, 'order:status', orderSummary);
if (isDelivery) {
  emitSocketEvent('delivery', 'order:status', orderSummary);
}

// ✅ Notify customer - saved for offline, emitted for online (only to correct customer)
const notification = await Notification.create({
userId: order.userId,
title: isDelivery ? 'Order Ready for Delivery!' : 'Order Ready!',
message: isDelivery
  ? `Your order #${orderId} is ready for delivery.`
  : `Your order #${orderId} is ready for pickup.`,
type: 'ready',
orderId: orderId,
link: `/src/pages/customer/order-tracking.html?orderId=${orderId}`,
isRead: false
});

// ✅ Send real-time notification to correct customer only (user room)
emitSocketEvent(`user:${order.userId}`, 'notification:new', {
    id: notification._id,
    title: notification.title,
    message: notification.message,
    type: notification.type,
    orderId: notification.orderId,
    link: notification.link,
    isRead: notification.isRead,
    createdAt: notification.createdAt
});

res.status(HTTP_STATUS.OK).json({
success: true,

message: isDelivery ? `Order #${orderId} is now ready for delivery` : `Order #${orderId} is now ready for pickup`,
order: formatKitchenOrder(order)
});

} catch (error) {
console.error('❌ Mark Order Ready Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};


/**
* @desc    Send order to delivery staff (Kitchen)
* @route   POST /api/kitchen/orders/:orderId/send-to-delivery
* @access  Private/Kitchen/Admin
*
* Frontend: kitchen/dashboard.html → Send to Delivery button
* Notifies ALL active delivery staff in real time (socket + notification)
* that the order is ready for delivery.
* Response: { success, message, order, notified }
*/
exports.sendOrderToDelivery = async (req, res) => {
try {
const { orderId } = req.params;

const order = await Order.findOne({ orderId: orderId });
if (!order) {
return res.status(HTTP_STATUS.NOT_FOUND).json({
success: false,
error: 'Order not found'
});
}

// ✅ Only delivery orders can be sent to delivery
if (String(order.orderType || '').toLowerCase() !== 'delivery') {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,
error: 'Order is not a delivery order'
});
}

// ✅ Must be ready (kitchen has finished preparing)
if (order.status !== 'ready') {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,
error: `Order can only be sent to delivery when ready (status: ${order.status})`
});
}

const { emitSocketEvent } = require('../utils/socket');
const deliverySummary = formatDeliveryOrder(order);

// ✅ Broadcast to the delivery room so every delivery staff page updates live
emitSocketEvent('delivery', 'delivery:new', deliverySummary);
emitSocketEvent('delivery', 'order:status', deliverySummary);
emitSocketEvent(`order:${order.orderId}`, 'order:status', deliverySummary);

const alreadyNotified = Boolean(order.deliveryNotifiedAt);

// ✅ Notify every active delivery staff member (message to deliver)
const User = require('../models/User');
const deliveryStaff = alreadyNotified
  ? []
  : await User.find({
      role: { $in: ['delivery', 'DELIVERY_STAFF', 'delivery_staff', 'driver', 'rider'] },
      status: 'ACTIVE',
      isActive: { $ne: false }
    }).select('_id name');

order.deliveryNotifiedAt = new Date();
await order.save();

const title = 'Order Ready for Delivery!';
const message = `Order #${orderId} is ready for delivery. Please arrange pickup and deliver it to the customer.`;
for (const staff of deliveryStaff) {
const notification = await Notification.create({
userId: staff._id,
title: title,
message: message,
type: 'status_update',
orderId: order.orderId,
link: '/src/pages/delivery/deliveries.html',
isRead: false
});

emitSocketEvent(`user:${staff._id}`, 'notification:new', {
id: notification._id,
title: notification.title,
message: notification.message,
type: notification.type,
orderId: notification.orderId,
link: notification.link,
isRead: notification.isRead,
createdAt: notification.createdAt
});
}

res.status(HTTP_STATUS.OK).json({
      success: true,
      message: alreadyNotified
        ? `Order #${orderId} was already sent to delivery staff (${deliveryStaff.length} new notifications)`
        : `Delivery staff notified that order #${orderId} is ready for delivery (${deliveryStaff.length} notified)`,
      order: deliverySummary,
      notified: deliveryStaff.length,
      alreadyNotified: alreadyNotified
    });
 
  } catch (error) {
    console.error('❌ Send Order To Delivery Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR
    });
  }
};
 
 
/**
 * @desc    Mark order as picked up by driver (Kitchen handoff)
 * @route   PATCH /api/kitchen/orders/:orderId/picked-up
 * @access  Private/Kitchen/Admin
 *
 * Frontend: kitchen/dashboard.html → Hand to Driver button
 * Changes status from ready to picked_up, notifies driver & customer
 */
exports.markOrderPickedUp = async (req, res) => {
  try {
    const { orderId } = req.params;
 
    const order = await Order.findOne({ orderId: orderId });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found'
      });
    }
 
    // ✅ Only delivery orders can be handed to driver
    if (String(order.orderType || '').toLowerCase() !== 'delivery') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Order is not a delivery order'
      });
    }
 
    // ✅ Must be ready (kitchen has finished preparing)
    if (order.status !== 'ready') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Order can only be handed to driver when ready (status: ${order.status})`
      });
    }
 
    // ✅ Update status to picked_up
    order.status = ORDER_STATUS.PICKED_UP;
    order.pickedUpTime = new Date();
    order.pickedUpBy = req.user?.id || req.user?._id;
    await order.save();
 
    // ✅ Emit socket events
    const { emitSocketEvent } = require('../utils/socket');
    const orderSummary = formatKitchenOrder(order);
    emitSocketEvent('kitchen', 'order:status', orderSummary);
    emitSocketEvent(`order:${orderId}`, 'order:status', orderSummary);
    emitSocketEvent('delivery', 'order:status', orderSummary);
 
    // ✅ Notify customer
    const notification = await Notification.create({
      userId: order.userId,
      title: 'Driver Picked Up Order!',
      message: `Your order #${orderId} has been handed to the driver and is on the way.`,
      type: 'status_update',
      orderId: orderId,
      link: `/src/pages/customer/order-tracking.html?orderId=${orderId}`,
      isRead: false
    });
 
    emitSocketEvent(`user:${order.userId}`, 'notification:new', {
      id: notification._id,
      title: notification.title,
      message: notification.message,
      type: notification.type,
      orderId: notification.orderId,
      link: notification.link,
      isRead: notification.isRead,
      createdAt: notification.createdAt
    });
 
    // ✅ Notify assigned driver (if any)
    if (order.deliveryStaffAssigned) {
      const driverNotification = await Notification.create({
        userId: order.deliveryStaffAssigned,
        title: 'Order Ready for Pickup!',
        message: `Order #${orderId} is ready. Please pick it up from the kitchen.`,
        type: 'status_update',
        orderId: orderId,
        link: '/src/pages/delivery/deliveries.html',
        isRead: false
      });
 
      emitSocketEvent(`user:${order.deliveryStaffAssigned}`, 'notification:new', {
        id: driverNotification._id,
        title: driverNotification.title,
        message: driverNotification.message,
        type: driverNotification.type,
        orderId: driverNotification.orderId,
        link: driverNotification.link,
        isRead: driverNotification.isRead,
        createdAt: driverNotification.createdAt
      });
    }
 
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${orderId} handed to driver`,
      order: formatKitchenOrder(order)
    });
 
  } catch (error) {
    console.error('❌ Mark Order Picked Up Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR
    });
  }
};

/**
 * @desc    Mark order as served (Kitchen)
 * @route   PATCH /api/kitchen/orders/:orderId/serve
* @access  Private/Kitchen
*
* Frontend: kitchen/dashboard.html → Mark served
* Response: { success, message, order }
*/
exports.markOrderServed = async (req, res) => {
try {
const { orderId } = req.params;

const order = await Order.findOne({ orderId: orderId });
if (!order) {
return res.status(HTTP_STATUS.NOT_FOUND).json({
success: false,
error: 'Order not found'
});
}

// ✅ Check if order can be marked served
if (String(order.orderType || '').toLowerCase() === 'delivery') {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,
error: 'Delivery orders are not served in the kitchen. Use the delivery dashboard to deliver.'
});
}
if (order.status !== 'ready') {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,

error: `Order cannot be marked served (status: ${order.status})`
});
}

// ✅ Update status to served
order.status = ORDER_STATUS.SERVED;
order.completedTime = new Date();
await order.save();

// ✅ Emit socket event for order status update
const { emitSocketEvent } = require('../utils/socket');
const orderSummary = formatKitchenOrder(order);
emitSocketEvent('kitchen', 'order:status', orderSummary);
emitSocketEvent(`order:${orderId}`, 'order:status', orderSummary);

// ✅ Notify customer
const notification = await Notification.create({
    userId: order.userId,
    title: 'Order Served!',
    message: `Your order #${orderId} has been served. Please pick it up.`,
    type: 'status_update',
    orderId: orderId,
    link: `/src/pages/customer/order-tracking.html?orderId=${orderId}`,
    isRead: false
});

// ✅ Send real-time notification to customer
emitSocketEvent(`user:${order.userId}`, 'notification:new', {
    id: notification._id,
    title: notification.title,
    message: notification.message,
    type: notification.type,
    orderId: notification.orderId,
    link: notification.link,
    isRead: notification.isRead,
    createdAt: notification.createdAt
});

res.status(HTTP_STATUS.OK).json({
    success: true,
    message: `Order #${orderId} has been served`,
    order: formatKitchenOrder(order)
});

} catch (error) {
console.error('❌ Mark Order Served Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**

* @desc    Reject/cancel order from kitchen
* @route   PATCH /api/kitchen/orders/:orderId/reject
* @access  Private/Kitchen
*
* Frontend: kitchen/dashboard.html → Reject order
* Expected Body: { reason }
* Response: { success, message }
*/
exports.rejectOrder = async (req, res) => {
try {
const { orderId } = req.params;
const { reason } = req.body;

const order = await

Order.findOne({ orderId: orderId });
if (!order) {
return res.status(HTTP_STATUS.NOT_FOUND).json({
success: false,
error: 'Order not found'
});
}

// ✅ Check if order can be rejected
if (order.status !== 'pending' && order.status !== 'preparing') {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,

error: `Order cannot be rejected (status: ${order.status})`
});
}

// ✅ Update status to cancelled
order.status = ORDER_STATUS.CANCELLED;
order.cancellationReason = reason || 'Rejected by kitchen';
await order.save();

// ✅ Emit socket event for order status update
const { emitSocketEvent } = require('../utils/socket');
const orderSummary = formatKitchenOrder(order);
emitSocketEvent('kitchen', 'order:status', orderSummary);
emitSocketEvent(`order:${orderId}`, 'order:status', orderSummary);

// ✅ Notify customer
await Notification.create({
userId: order.userId,
title: 'Order Rejected',
message: `Your order #${orderId} has been rejected by the

kitchen. ${reason || ''}`,
type: 'system',
orderId: orderId,
isRead: false
});

res.status(HTTP_STATUS.OK).json({
success: true,
message: `Order #${orderId} has been rejected`
});

} catch (error) {
console.error('❌ Reject Order Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**
* @desc    Get kitchen stats only
* @route   GET /api/kitchen/stats
* @access  Private/Kitchen
*
* Frontend: kitchen/dashboard.html → Live stats update
* Response: { success, stats }
*/
exports.getKitchenStats = async (req, res) => {
try {
const pending = await Order.countDocuments({ status: 'pending' });
const preparing = await Order.countDocuments({ status: 'preparing' });
const ready = await Order.countDocuments({ status: 'ready' });
const activeOrders = pending + preparing;

const today = new Date();
today.setHours(0, 0, 0, 0);
const completedToday = await Order.countDocuments({

status: 'served',
completedTime: { $gte: today }
});

res.status(HTTP_STATUS.OK).json({
success: true,
stats: {
pending,
preparing,
ready,
activeOrders,
completedToday
}
});

} catch (error) {

console.error('❌ Get Kitchen Stats Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**
 * Helper: Format order for delivery display (socket broadcast)
 */
function formatDeliveryOrder(order) {
return {
id: order._id,
orderId: order.orderId,
customerName: order.customerName,
customerPhone: order.customerPhone,
orderType: order.orderType,
items: (order.items || []).map(item => ({
itemId: item.itemId,
name: item.name,
quantity: item.quantity,
price: item.price,
notes: item.notes || '',
subtotal: item.subtotal || (Number(item.price) || 0) * (Number(item.quantity) || 0)
})),
itemCount: (order.items || []).reduce((sum, i) => sum + (Number(i.quantity) || 0), 0),
subtotal: order.subtotal,
serviceFee: order.serviceFee,
deliveryFee: order.deliveryFee || 0,
totalAmount: order.totalAmount,
status: getKitchenStatus(order),
deliveryInfo: order.deliveryInfo || null,
deliveryStaffAssigned: order.deliveryStaffAssigned || null,
deliveryStartedAt: order.deliveryStartedAt || null,
deliveredAt: order.deliveredAt || null,
paymentStatus: order.paymentStatus,
paymentMethod: order.paymentMethod,
orderDate: order.orderDate,
orderTime: order.orderTime,
createdAt: order.createdAt
};
}

/**
 * Helper: Format order for kitchen display
 */
function formatKitchenOrder(order) {
const elapsed = order.createdAt ?

getElapsedTime(order.createdAt) : '0 mins';

const estimatedRemaining = order.estimatedCompletionTime
  ? Math.max(0, Math.round((order.estimatedCompletionTime - Date.now()) / 60000))
  : null;

return {
id: order._id,
orderId: order.orderId,
customerName: order.customerName,
customerPhone: order.customerPhone,
items: order.items.map(item => ({
name: item.name,
quantity: item.quantity,
notes: item.notes || '',
itemStatus: item.itemStatus || 'pending'
})),
status: order.status,
priority: order.priority,
totalAmount: order.totalAmount,
orderType: order.orderType,

tableNumber: order.tableNumber,
createdAt: order.createdAt,
elapsedTime: elapsed,
estimatedCompletionTime: order.estimatedCompletionTime,
estimatedRemainingTime: estimatedRemaining,
readyTime: order.readyTime,
completedTime: order.completedTime,
kitchenStaffAssigned: order.kitchenStaffAssigned,
preparationDelayReason: order.preparationDelayReason
};
}

/**
* Helper: Get elapsed time
*/
function getElapsedTime(date) {
const diffMs = Date.now() - new Date(date).getTime();
const diffMins = Math.floor(diffMs / 60000);

if (diffMins < 1) return 'Just now';
if (diffMins < 60) return `${diffMins} mins`;
const diffHours = Math.floor(diffMins / 60);
return `${diffHours}h ${diffMins % 60}m`;
}

// ============================================================
// FOOD AVAILABILITY MANAGEMENT
// ============================================================

/**
* @desc    Get all menu items with availability status
* @route   GET /api/kitchen/menu-availability
* @access  Private/Kitchen
*
* Frontend: kitchen/availability.html → Display menu items
* Response: { success, count, items: [...] }
*/
exports.getMenuAvailability = async (req, res) => {
try {
const MenuItem = require('../models/MenuItem');
const menuItems = await MenuItem.find().sort({ category: 1, 'name.en': 1 });

res.status(HTTP_STATUS.OK).json({
success: true,
count: menuItems.length,
items: menuItems.map(item => ({
id: item._id,
name: item.name,
category: item.category,
price: item.price,
isAvailable: item.isAvailable,
preparationTime: item.preparationTime,
outOfStockReason: item.outOfStockReason,
lastUpdate: item.lastAvailabilityUpdate
}))
});

} catch (error) {
console.error('❌ Get Menu Availability Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**
* @desc    Toggle item availability (mark as out of stock or available)
* @route   PATCH /api/kitchen/menu/:itemId/availability
* @access  Private/Kitchen
*
* Frontend: kitchen/availability.html → Toggle item
* Body: { isAvailable, reason }
* Response: { success, message, item }
*/
exports.updateItemAvailability = async (req, res) => {
try {
const { itemId } = req.params;
const { isAvailable, reason } = req.body;
const MenuItem = require('../models/MenuItem');

const menuItem = await MenuItem.findById(itemId);
if (!menuItem) {
return res.status(HTTP_STATUS.NOT_FOUND).json({
success: false,
error: 'Menu item not found'
});
}

// ✅ Update availability
const wasAvailable = menuItem.isAvailable;
menuItem.isAvailable = isAvailable;
menuItem.outOfStockReason = isAvailable ? null : (reason || 'Out of stock');
menuItem.lastAvailabilityUpdate = new Date();
menuItem.updatedBy = req.user._id;

await menuItem.save();

// ✅ If item became unavailable, notify affected orders
if (wasAvailable && !isAvailable) {
// Find orders containing this item that are still pending/preparing
const Order = require('../models/Order');
const affectedOrders = await Order.find({
'items.itemId': itemId,
status: { $in: ['pending', 'preparing'] }
});

// Create stock alert
const StockAlert = require('../models/StockAlert');
await StockAlert.create({
itemId: itemId,
itemName: menuItem.name.en,
alertType: 'out_of_stock',
severity: affectedOrders.length > 0 ? 'high' : 'medium',
reason: reason || 'Item marked unavailable by kitchen staff',
reportedBy: req.user._id,
reportedByRole: 'kitchen',
affectedOrders: affectedOrders.map(o => ({
orderId: o._id,
orderNumber: o.orderId
}))
});

// Notify affected customers
for (const order of affectedOrders) {
await Notification.create({
userId: order.userId,
title: 'Item Unavailable',
message: `The item "${menuItem.name.en}" in your order #${order.orderId} is currently unavailable.`,
type: 'alert',
orderId: order._id,
isRead: false
});
}

// Emit socket event
const { emitSocketEvent } = require('../utils/socket');
emitSocketEvent('kitchen', 'item:unavailable', {
itemId: menuItem._id,
itemName: menuItem.name.en,
reason: menuItem.outOfStockReason
});
}

res.status(HTTP_STATUS.OK).json({
success: true,
message: `Item availability updated: ${isAvailable ? 'Available' : 'Out of stock'}`,
item: {
id: menuItem._id,
name: menuItem.name,
isAvailable: menuItem.isAvailable,
outOfStockReason: menuItem.outOfStockReason,
lastUpdate: menuItem.lastAvailabilityUpdate
}
});

} catch (error) {
console.error('❌ Update Item Availability Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**
* @desc    Report a stock/ingredient issue
* @route   POST /api/kitchen/stock-alerts
* @access  Private/Kitchen
*
* Frontend: kitchen/stock-alerts.html → Report issue
* Body: { itemId, itemName, alertType, severity, reason }
* Response: { success, message, alert }
*/
exports.reportStockIssue = async (req, res) => {
try {
const { itemId, itemName, alertType, severity, reason } = req.body;
const StockAlert = require('../models/StockAlert');

// Validate request
if (!itemName || !alertType || !reason) {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,
error: 'Item name, alert type, and reason are required'
});
}

// Create stock alert
const alert = await StockAlert.create({
itemId: itemId || null,
itemName: itemName,
alertType: alertType,
severity: severity || 'high',
reason: reason,
reportedBy: req.user._id,
reportedByRole: 'kitchen',
status: 'active'
});

// Emit socket event to notify admin
const { emitSocketEvent } = require('../utils/socket');
emitSocketEvent('admin', 'stock:alert', {
alertId: alert._id,
itemName: itemName,
severity: severity,
reason: reason,
createdAt: alert.createdAt
});

res.status(HTTP_STATUS.CREATED).json({
success: true,
message: 'Stock issue reported successfully',
alert: {
id: alert._id,
itemName: alert.itemName,
alertType: alert.alertType,
severity: alert.severity,
status: alert.status,
createdAt: alert.createdAt
}
});

} catch (error) {
console.error('❌ Report Stock Issue Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**
* @desc    Get active stock alerts
* @route   GET /api/kitchen/stock-alerts
* @access  Private/Kitchen
*
* Frontend: kitchen/stock-alerts.html → Display alerts
* Query Params: status
* Response: { success, count, alerts: [...] }
*/
exports.getStockAlerts = async (req, res) => {
try {
const { status } = req.query;
const StockAlert = require('../models/StockAlert');

let filter = { reportedByRole: 'kitchen' };
if (status) {
filter.status = status;
} else {
filter.status = { $in: ['active', 'acknowledged'] };
}

const alerts = await StockAlert.find(filter)
.populate('reportedBy', 'name')
.sort({ severity: -1, createdAt: -1 });

res.status(HTTP_STATUS.OK).json({
success: true,
count: alerts.length,
alerts: alerts.map(alert => ({
id: alert._id,
itemName: alert.itemName,
alertType: alert.alertType,
severity: alert.severity,
reason: alert.reason,
status: alert.status,
reportedBy: alert.reportedBy?.name,
affectedOrders: alert.affectedOrders?.length || 0,
createdAt: alert.createdAt
}))
});

} catch (error) {
console.error('❌ Get Stock Alerts Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**
* @desc    Acknowledge a stock alert
* @route   PATCH /api/kitchen/stock-alerts/:id/acknowledge
* @access  Private/Kitchen
* Response: { success, message, alert }
*/
exports.acknowledgeStockAlert = async (req, res) => {
try {
const { id } = req.params;
const StockAlert = require('../models/StockAlert');

const alert = await StockAlert.findById(id);
if (!alert) {
return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Stock alert not found' });
}

if (alert.status === 'resolved' || alert.status === 'cancelled') {
return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'This alert is already closed' });
}

alert.status = 'acknowledged';
await alert.save();

res.status(HTTP_STATUS.OK).json({ success: true, message: 'Alert acknowledged', alert: { id: alert._id, status: alert.status } });
} catch (error) {
console.error('❌ Acknowledge Stock Alert Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
}
};

/**
* @desc    Resolve a stock alert
* @route   PATCH /api/kitchen/stock-alerts/:id/resolve
* @access  Private/Kitchen
* Response: { success, message, alert }
*/
exports.resolveStockAlert = async (req, res) => {
try {
const { id } = req.params;
const StockAlert = require('../models/StockAlert');

const alert = await StockAlert.findById(id);
if (!alert) {
return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Stock alert not found' });
}

if (alert.status === 'resolved' || alert.status === 'cancelled') {
return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'This alert is already closed' });
}

alert.status = 'resolved';
alert.resolvedBy = req.user._id;
alert.resolvedAt = new Date();
alert.resolutionNote = req.body.resolutionNote || null;
await alert.save();

res.status(HTTP_STATUS.OK).json({ success: true, message: 'Alert marked as resolved', alert: { id: alert._id, status: alert.status } });
} catch (error) {
console.error('❌ Resolve Stock Alert Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
}
};

// ============================================================
// ORDER HISTORY & DETAILED VIEW
// ============================================================

/**
* @desc    Get detailed order view with item-level status
* @route   GET /api/kitchen/orders/:orderId/details
* @access  Private/Kitchen
*
* Frontend: kitchen/order-details.html → Show full order
* Response: { success, order }
*/
exports.getOrderDetails = async (req, res) => {
try {
const { orderId } = req.params;

const order = await Order.findOne({ orderId: orderId })
.populate('userId', 'name phone')
.populate('kitchenStaffAssigned', 'name');

if (!order) {
return res.status(HTTP_STATUS.NOT_FOUND).json({
success: false,
error: 'Order not found'
});
}

const elapsed = getElapsedTime(order.createdAt);
const estimate = calculateEstimatedCompletionTime(order);

res.status(HTTP_STATUS.OK).json({
success: true,
order: {
id: order._id,
orderId: order.orderId,
customer: {
name: order.customerName,
phone: order.customerPhone
},
orderType: order.orderType,
tableNumber: order.tableNumber,
status: order.status,
priority: order.priority,
items: order.items.map(item => ({
id: item._id,
name: item.name,
quantity: item.quantity,
price: item.price,
notes: item.notes,
itemStatus: item.itemStatus,
preparationStartedAt: item.preparationStartedAt,
preparationCompletedAt: item.preparationCompletedAt
})),
subtotal: order.subtotal,
serviceFee: order.serviceFee,
totalAmount: order.totalAmount,
createdAt: order.createdAt,
elapsedTime: elapsed,
estimatedCompletionTime: estimate,
preparationDelayReason: order.preparationDelayReason,
kitchenStaffAssigned: order.kitchenStaffAssigned?.name,
readyTime: order.readyTime,
completedTime: order.completedTime
}
});

} catch (error) {
console.error('❌ Get Order Details Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**
* @desc    Update item-level preparation status
* @route   PATCH /api/kitchen/orders/:orderId/items/:itemId/status
* @access  Private/Kitchen
*
* Frontend: kitchen/order-details.html → Update item status
* Body: { itemStatus }
* Response: { success, message, order }
*/
exports.updateItemPreparationStatus = async (req, res) => {
try {
const { orderId, itemId } = req.params;
const { itemStatus } = req.body;

const order = await Order.findOne({ orderId: orderId });
if (!order) {
return res.status(HTTP_STATUS.NOT_FOUND).json({
success: false,
error: 'Order not found'
});
}

// Find the item in the order
const item = order.items.id(itemId);
if (!item) {
return res.status(HTTP_STATUS.NOT_FOUND).json({
success: false,
error: 'Item not found in order'
});
}

// Update item status
item.itemStatus = itemStatus;
if (itemStatus === 'preparing') {
item.preparationStartedAt = new Date();
} else if (itemStatus === 'ready') {
item.preparationCompletedAt = new Date();
}

await order.save();

// Emit socket event
const { emitSocketEvent } = require('../utils/socket');
emitSocketEvent(`order:${orderId}`, 'item:status:updated', {
itemId: itemId,
itemStatus: itemStatus
});

res.status(HTTP_STATUS.OK).json({
success: true,
message: `Item status updated to ${itemStatus}`,
order: formatKitchenOrder(order)
});

} catch (error) {
console.error('❌ Update Item Preparation Status Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

/**
* @desc    Add preparation delay reason
* @route   PATCH /api/kitchen/orders/:orderId/delay
* @access  Private/Kitchen
*
* Frontend: kitchen/dashboard.html → Report delay
* Body: { reason }
* Response: { success, message }
*/
exports.addPreparationDelay = async (req, res) => {
try {
const { orderId } = req.params;
const { reason } = req.body;

if (!reason) {
return res.status(HTTP_STATUS.BAD_REQUEST).json({
success: false,
error: 'Delay reason is required'
});
}

const order = await Order.findOne({ orderId: orderId });
if (!order) {
return res.status(HTTP_STATUS.NOT_FOUND).json({
success: false,
error: 'Order not found'
});
}

order.preparationDelayReason = reason;
await order.save();

// Notify customer
await Notification.create({
userId: order.userId,
title: 'Order Delay',
message: `Your order #${orderId} is taking longer than expected. Reason: ${reason}`,
type: 'delay',
orderId: orderId,
isRead: false
});

// Emit socket event
const { emitSocketEvent } = require('../utils/socket');
emitSocketEvent(`order:${orderId}`, 'order:delayed', {
reason: reason
});

res.status(HTTP_STATUS.OK).json({
success: true,
message: 'Delay reason recorded and customer notified'
});

} catch (error) {
console.error('❌ Add Preparation Delay Error:', error);
res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
success: false,
error: MESSAGES.SERVER_ERROR
});
}
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
* Calculate estimated completion time based on menu items
*/
function calculateEstimatedCompletionTime(order) {
if (!order.items || order.items.length === 0) return null;

// Get max preparation time from all items
const MenuItem = require('../models/MenuItem');
let maxPrepTime = 0;
let itemCount = 0;

order.items.forEach(item => {
const prepTime = item.preparationTime || 10;
maxPrepTime = Math.max(maxPrepTime, prepTime);
itemCount++;
});

// Add buffer for multiple items
const buffer = Math.ceil((itemCount - 1) * 2);
const estimatedMinutes = maxPrepTime + buffer;
const estimatedTime = new Date(Date.now() + estimatedMinutes * 60000);

return estimatedTime;
}
