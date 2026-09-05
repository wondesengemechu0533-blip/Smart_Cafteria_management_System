const Order = require('../models/Order');
const User = require('../models/User');
const Notification = require('../models/Notification');
const OrderStatusHistory = require('../models/OrderStatusHistory');
const { HTTP_STATUS, MESSAGES } = require('../config/constants');

const DELIVERY_FLOW = ['PENDING', 'PREPARING', 'READY', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED'];

function effectiveStatus(order) {
  const up = String(order.orderStatus || '').toUpperCase();
  const low = String(order.status || '').toUpperCase();
  if (up === 'CANCELLED' || low === 'CANCELLED') return 'CANCELLED';
  const ui = DELIVERY_FLOW.indexOf(up);
  const li = DELIVERY_FLOW.indexOf(low);
  if (ui === -1 && li === -1) return up || low || 'PENDING';
  if (ui === -1) return low;
  if (li === -1) return up;
  return ui >= li ? up : low;
}

function serializeDelivery(order) {
  const staff = order.deliveryStaffAssigned;
  return {
    id: String(order._id),
    orderId: order.orderId,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    orderType: order.orderType,
    items: (order.items || []).map((i) => ({
      itemId: i.itemId,
      name: i.name,
      quantity: i.quantity,
      price: i.price,
      notes: i.notes || '',
      subtotal: i.subtotal || (Number(i.price) || 0) * (Number(i.quantity) || 0)
    })),
    itemCount: (order.items || []).reduce((sum, i) => sum + (Number(i.quantity) || 0), 0),
    subtotal: order.subtotal,
    serviceFee: order.serviceFee,
    deliveryFee: order.deliveryFee || 0,
    totalAmount: order.totalAmount,
    status: effectiveStatus(order),
    deliveryInfo: order.deliveryInfo || null,
    deliveryStaffAssigned: staff ? { id: String(staff._id), name: staff.name, phone: staff.phone, role: staff.role } : null,
    deliveryAssignedAt: order.deliveryAssignedAt || null,
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
 * @desc    Get delivery orders (active + completed, filterable)
 * @route   GET /api/v1/deliveries
 * @access  Private/Admin + Delivery
 * Query: status (READY | OUT_FOR_DELIVERY | DELIVERED | ...), report=completed|cancelled
 */
exports.getDeliveryOrders = async (req, res) => {
  try {
    const { status, report } = req.query;

    const filter = { orderType: 'delivery' };

    if (report === 'completed') {
      filter.$or = [{ orderStatus: 'COMPLETED' }, { status: 'completed' }, { orderStatus: 'DELIVERED' }, { status: 'delivered' }];
    } else if (report === 'cancelled') {
      filter.$or = [{ orderStatus: 'CANCELLED' }, { status: 'cancelled' }];
    } else if (status && String(status).toUpperCase() !== 'ALL') {
      const s = String(status).toUpperCase();
      filter.$or = [
        { orderStatus: s },
        { status: s.toLowerCase() },
        { status: s }
      ];
    } else {
      filter.$or = [
        { orderStatus: { $in: ['PENDING', 'PREPARING', 'READY', 'PICKED_UP', 'OUT_FOR_DELIVERY'] } },
        { status: { $in: ['pending', 'preparing', 'ready', 'picked_up', 'out_for_delivery'] } }
      ];
    }

    const orders = await Order.find(filter)
      .populate('deliveryStaffAssigned', 'name phone role')
      .sort({ orderTime: -1 });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: orders.length,
      orders: orders.map(serializeDelivery)
    });
  } catch (error) {
    console.error('❌ Get Delivery Orders Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get deliveries assigned to the current delivery staff
 * @route   GET /api/v1/deliveries/mine
 * @access  Private/Delivery
 */
exports.getMyDeliveries = async (req, res) => {
  try {
    const orders = await Order.find({
      orderType: 'delivery',
      deliveryStaffAssigned: req.user.id,
      $or: [
        { orderStatus: { $in: ['READY', 'PICKED_UP', 'OUT_FOR_DELIVERY'] } },
        { status: { $in: ['ready', 'picked_up', 'out_for_delivery'] } }
      ]
    })
      .populate('deliveryStaffAssigned', 'name phone role')
      .sort({ orderTime: 1 });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: orders.length,
      orders: orders.map(serializeDelivery)
    });
  } catch (error) {
    console.error('❌ Get My Deliveries Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get completed delivery history for the current delivery staff
 * @route   GET /api/v1/deliveries/my-history
 * @access  Private/Delivery
 */
exports.getMyDeliveryHistory = async (req, res) => {
  try {
    const orders = await Order.find({
      orderType: 'delivery',
      deliveryStaffAssigned: req.user.id,
      $or: [
        { orderStatus: 'DELIVERED' },
        { orderStatus: 'COMPLETED' },
        { status: 'delivered' },
        { status: 'completed' }
      ]
    })
      .populate('deliveryStaffAssigned', 'name phone role')
      .sort({ orderTime: -1 })
      .limit(50);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: orders.length,
      orders: orders.map(serializeDelivery)
    });
  } catch (error) {
    console.error('❌ Get My Delivery History Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Assign delivery staff to an order (Admin only)
 * @route   PATCH /api/v1/deliveries/:id/assign
 * @access  Private/Admin
 * Body: { deliveryStaffId }
 */
exports.assignDeliveryStaff = async (req, res) => {
  try {
    const { deliveryStaffId } = req.body;
    if (!deliveryStaffId) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'deliveryStaffId is required' });
    }

    const staff = await User.findById(deliveryStaffId);
    if (!staff || staff.role !== 'delivery') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Selected user is not a delivery staff member' });
    }
    if (staff.status !== 'ACTIVE' || staff.isActive === false) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Selected delivery staff is not active' });
    }

    const order = await Order.findOne({
      $or: [
        { _id: require('mongoose').Types.ObjectId.isValid(req.params.id) ? require('mongoose').Types.ObjectId(req.params.id) : null },
        { orderId: req.params.id }
      ].filter(Boolean)
    }).populate('deliveryStaffAssigned', 'name phone role');

    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }
    if (order.orderType !== 'delivery') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Order is not a delivery order' });
    }

    const current = effectiveStatus(order);
    if (current === 'CANCELLED' || current === 'DELIVERED' || current === 'COMPLETED') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: `Cannot assign delivery staff to a ${current} order` });
    }

    const previousStaff = order.deliveryStaffAssigned;
    order.deliveryStaffAssigned = staff._id;
    if (!order.deliveryAssignedAt) order.deliveryAssignedAt = new Date();
    await order.save();
    await order.populate('deliveryStaffAssigned', 'name phone role');

    await OrderStatusHistory.create({
      orderId: order._id,
      previousStatus: current,
      newStatus: current,
      changedBy: req.user.id,
      reason: `Delivery staff assigned: ${staff.name}${previousStaff ? ` (was ${previousStaff.name || ''})` : ''}`
    });

    const { emitSocketEvent } = require('../utils/socket');

    const orderSummary = serializeDelivery(order);

    // Notify the (new) delivery staff
    await Notification.create({
      userId: staff._id,
      title: 'Delivery Assigned!',
      message: `You have been assigned to deliver order #${order.orderId}.`,
      type: 'status_update',
      orderId: order.orderId,
      link: `/src/pages/delivery/dashboard.html`,
      isRead: false
    });
    emitSocketEvent(`user:${staff._id}`, 'notification:new', {
      title: 'Delivery Assigned!',
      message: `You have been assigned to deliver order #${order.orderId}.`,
      type: 'delivery',
      orderId: order.orderId,
      link: '/src/pages/delivery/dashboard.html',
      isRead: false
    });

    emitSocketEvent('delivery', 'delivery:assigned', orderSummary);
    emitSocketEvent('admin', 'delivery:assigned', orderSummary);
    emitSocketEvent(`order:${order.orderId}`, 'order:status', orderSummary);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Delivery staff ${staff.name} assigned to order #${order.orderId}`,
      order: orderSummary
    });
  } catch (error) {
    console.error('❌ Assign Delivery Staff Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Mark a delivery order as out for delivery
 * @route   PATCH /api/v1/deliveries/:id/out-for-delivery
 * @access  Private/Delivery + Admin
 */
exports.markOutForDelivery = async (req, res) => {
  try {
    const order = await Order.findOne({
      $or: [
        { _id: require('mongoose').Types.ObjectId.isValid(req.params.id) ? require('mongoose').Types.ObjectId(req.params.id) : null },
        { orderId: req.params.id }
      ].filter(Boolean)
    }).populate('deliveryStaffAssigned', 'name phone role');

    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }
    if (order.orderType !== 'delivery') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Order is not a delivery order' });
    }

    const current = effectiveStatus(order);
    if (current !== 'READY' && current !== 'PICKED_UP') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Order can only be marked out for delivery when READY or PICKED_UP (current: ${current})`
      });
    }

    if (req.user.role === 'delivery' && String(order.deliveryStaffAssigned || '') !== String(req.user.id)) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'This order is not assigned to you'
      });
    }

    order.orderStatus = 'OUT_FOR_DELIVERY';
    order.status = 'out_for_delivery';
    order.deliveryStartedAt = new Date();

    await order.save();
    await OrderStatusHistory.create({ orderId: order._id, previousStatus: current, newStatus: 'OUT_FOR_DELIVERY', changedBy: req.user.id, reason: 'Delivery started' });

    const { emitSocketEvent } = require('../utils/socket');
    const orderSummary = serializeDelivery(order);
    emitSocketEvent('delivery', 'order:status', orderSummary);
    emitSocketEvent('kitchen', 'order:status', orderSummary);
    emitSocketEvent('admin', 'order:status', orderSummary);
    emitSocketEvent(`order:${order.orderId}`, 'order:status', orderSummary);

    await Notification.create({
      userId: order.userId,
      title: 'Order Out for Delivery!',
      message: `Your order #${order.orderId} is out for delivery. Our delivery person is on the way!`,
      type: 'status_update',
      orderId: order.orderId,
      link: `/src/pages/customer/order-tracking.html?orderId=${order.orderId}`,
      isRead: false
    });
    emitSocketEvent(`user:${order.userId}`, 'notification:new', {
      title: 'Order Out for Delivery!',
      message: `Your order #${order.orderId} is out for delivery. Our delivery person is on the way!`,
      type: 'status_update',
      orderId: order.orderId,
      link: `/src/pages/customer/order-tracking.html?orderId=${order.orderId}`,
      isRead: false
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${order.orderId} is now out for delivery`,
      order: orderSummary
    });
  } catch (error) {
    console.error('❌ Mark Out For Delivery Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Pick up an order from the kitchen (Delivery Staff)
 * @route   PATCH /api/v1/deliveries/:id/pickup
 * @access  Private/Delivery + Admin
 * Body: { }
 * Changes: READY -> PICKED_UP
 */
exports.pickUpOrder = async (req, res) => {
  try {
    const order = await Order.findOne({
      $or: [
        { _id: require('mongoose').Types.ObjectId.isValid(req.params.id) ? require('mongoose').Types.ObjectId(req.params.id) : null },
        { orderId: req.params.id }
      ].filter(Boolean)
    }).populate('deliveryStaffAssigned', 'name phone role');

    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }
    if (order.orderType !== 'delivery') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Order is not a delivery order' });
    }

    const current = effectiveStatus(order);
    if (current !== 'READY') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Order can only be picked up when READY (current: ${current})`
      });
    }

    if (req.user.role === 'delivery' && String(order.deliveryStaffAssigned || '') !== String(req.user.id)) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'This order is not assigned to you'
      });
    }

    order.orderStatus = 'PICKED_UP';
    order.status = 'picked_up';
    order.pickedUpTime = new Date();
    order.pickedUpBy = req.user.id;
    order.deliveryStartedAt = new Date();

    await order.save();
    await OrderStatusHistory.create({
      orderId: order._id,
      previousStatus: current,
      newStatus: 'PICKED_UP',
      changedBy: req.user.id,
      reason: 'Delivery staff picked up the order from kitchen'
    });

    const { emitSocketEvent } = require('../utils/socket');
    const orderSummary = serializeDelivery(order);
    emitSocketEvent('delivery', 'order:status', orderSummary);
    emitSocketEvent('kitchen', 'order:status', orderSummary);
    emitSocketEvent('admin', 'order:status', orderSummary);
    emitSocketEvent(`order:${order.orderId}`, 'order:status', orderSummary);

    // Notify the customer
    await Notification.create({
      userId: order.userId,
      title: 'Order Picked Up! 🛵',
      message: `Your order #${order.orderId} has been picked up by our delivery rider and is heading your way.`,
      type: 'status_update',
      orderId: order.orderId,
      link: `/src/pages/customer/order-tracking.html?orderId=${order.orderId}`,
      isRead: false
    });
    emitSocketEvent(`user:${order.userId}`, 'notification:new', {
      title: 'Order Picked Up! 🛵',
      message: `Your order #${order.orderId} has been picked up by our delivery rider and is heading your way.`,
      type: 'status_update',
      orderId: order.orderId,
      link: `/src/pages/customer/order-tracking.html?orderId=${order.orderId}`,
      isRead: false
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${order.orderId} picked up. Start delivery when you are on the way.`,
      order: orderSummary
    });
  } catch (error) {
    console.error('❌ Pick Up Order Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Mark a delivery order as delivered
 * @route   PATCH /api/v1/deliveries/:id/delivered
 * @access  Private/Delivery + Admin
 */
exports.markDelivered = async (req, res) => {
  try {
    const order = await Order.findOne({
      $or: [
        { _id: require('mongoose').Types.ObjectId.isValid(req.params.id) ? require('mongoose').Types.ObjectId(req.params.id) : null },
        { orderId: req.params.id }
      ].filter(Boolean)
    }).populate('deliveryStaffAssigned', 'name phone role');

    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }
    if (order.orderType !== 'delivery') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Order is not a delivery order' });
    }

    const current = effectiveStatus(order);
    if (current !== 'OUT_FOR_DELIVERY') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Order can only be marked delivered when OUT_FOR_DELIVERY (current: ${current})`
      });
    }

    if (req.user.role === 'delivery' && String(order.deliveryStaffAssigned || '') !== String(req.user.id)) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'This order is not assigned to you'
      });
    }

    order.orderStatus = 'COMPLETED';
    order.status = 'Completed';
    order.deliveredAt = new Date();
    order.completedTime = new Date();

    await order.save();
    await OrderStatusHistory.create({ orderId: order._id, previousStatus: current, newStatus: 'COMPLETED', changedBy: req.user.id, reason: 'Order delivered to customer' });

    const { emitSocketEvent } = require('../utils/socket');
    const orderSummary = serializeDelivery(order);
    emitSocketEvent('delivery', 'order:status', orderSummary);
    emitSocketEvent('kitchen', 'order:status', orderSummary);
    emitSocketEvent('admin', 'order:status', orderSummary);
    emitSocketEvent(`order:${order.orderId}`, 'order:status', orderSummary);

    await Notification.create({
      userId: order.userId,
      title: 'Order Delivered! 🎉',
      message: `Your order #${order.orderId} has been delivered. Enjoy your meal!`,
      type: 'status_update',
      orderId: order.orderId,
      link: `/src/pages/customer/order-tracking.html?orderId=${order.orderId}`,
      isRead: false
    });
    emitSocketEvent(`user:${order.userId}`, 'notification:new', {
      title: 'Order Delivered! 🎉',
      message: `Your order #${order.orderId} has been delivered. Enjoy your meal!`,
      type: 'status_update',
      orderId: order.orderId,
      link: `/src/pages/customer/order-tracking.html?orderId=${order.orderId}`,
      isRead: false
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${order.orderId} marked as delivered`,
      order: orderSummary
    });
  } catch (error) {
    console.error('❌ Mark Delivered Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get delivery stats
 * @route   GET /api/v1/deliveries/stats
 * @access  Private/Delivery + Admin
 */
exports.getDeliveryStats = async (req, res) => {
  try {
    const base = { orderType: 'delivery' };

    const ready = await Order.countDocuments({ ...base, $or: [{ orderStatus: 'READY' }, { status: 'ready' }] });
    const outForDelivery = await Order.countDocuments({ ...base, $or: [{ orderStatus: 'OUT_FOR_DELIVERY' }, { status: 'out_for_delivery' }] });
    const delivered = await Order.countDocuments({ ...base, $or: [{ orderStatus: 'DELIVERED' }, { status: 'delivered' }, { status: 'Completed' }] });
    const assigned = await Order.countDocuments({
      ...base,
      deliveryStaffAssigned: { $ne: null },
      $or: [{ orderStatus: { $in: ['READY', 'OUT_FOR_DELIVERY'] } }, { status: { $in: ['ready', 'out_for_delivery'] } }]
    });
    const unassigned = await Order.countDocuments({
      ...base,
      deliveryStaffAssigned: null,
      $or: [{ orderStatus: { $in: ['PENDING', 'PREPARING', 'READY'] } }, { status: { $in: ['pending', 'preparing', 'ready'] } }]
    });

    if (req.user.role === 'delivery') {
      const myActive = await Order.countDocuments({
        ...base,
        deliveryStaffAssigned: req.user.id,
        $or: [
          { orderStatus: { $in: ['READY', 'OUT_FOR_DELIVERY'] } },
          { status: { $in: ['ready', 'out_for_delivery'] } }
        ]
      });
      const myDelivered = await Order.countDocuments({
        ...base,
        deliveryStaffAssigned: req.user.id,
        $or: [{ orderStatus: 'DELIVERED' }, { status: 'delivered' }, { status: 'Completed' }]
      });

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        stats: { ready, outForDelivery, delivered, assigned, unassigned, myActive, myDelivered }
      });
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: { ready, outForDelivery, delivered, assigned, unassigned }
    });
  } catch (error) {
    console.error('❌ Get Delivery Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get list of delivery staff (for assignment dropdown)
 * @route   GET /api/v1/deliveries/staff
 * @access  Private/Admin
 */
exports.getDeliveryStaff = async (req, res) => {
  try {
    const staff = await User.find({ role: 'delivery' }).select('name email phone status isActive').lean().sort({ name: 1 });
    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: staff.length,
      staff: staff.map((u) => ({
        id: u._id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        isActive: u.status === 'ACTIVE' && u.isActive !== false,
        activeDeliveries: 0
      }))
    });
  } catch (error) {
    console.error('❌ Get Delivery Staff Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};