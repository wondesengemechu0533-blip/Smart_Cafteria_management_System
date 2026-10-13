// socket/order.socket.js

const Order = require('../models/Order');
const { normalizeRole } = require('../config/roles');
const { logger } = require('../utils/logger');

// Canonical role sets for room authorization. Roles are normalized via
// normalizeRole so aliases (delivery_staff, kitchen_staff, ...) match.
const MANAGEMENT_ROLES = ['admin', 'system_admin', 'cafeteria_admin', 'manager'];
const KITCHEN_ROOM_ROLES = ['kitchen', 'admin', 'system_admin', 'cafeteria_admin', 'manager'];
const ADMIN_ROOM_ROLES = ['admin', 'system_admin', 'cafeteria_admin', 'manager'];
// Delivery staff room also admits management: the admin deliveries page
// listens for delivery:new / order:status from this room. GPS is NOT
// broadcast here - only per-order delivery:${orderId} rooms.
const DELIVERY_ROOM_ROLES = ['delivery', ...MANAGEMENT_ROLES];

const roleOf = (socket) => (socket.user ? normalizeRole(socket.user.role) : '');

// Reduce a possibly-populated reference (bare ObjectId OR a populated document)
// to its id string. Both call sites currently use .lean() without populate, but
// an authorization check must not silently start denying a rider their own room
// if someone later adds a populate() to the query.
const refId = (value) => {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

// Order-room / GPS-room audience: the customer who owns the order, the rider
// assigned to it (role must be delivery AND id must match the assignment),
// or management. Verified against the database - never trusts the client to
// self-identify. Guests (no socket.user) are always denied.
const canAccessOrder = (socket, order) => {
  if (!socket.user) return false;
  const role = roleOf(socket);
  const isManagement = MANAGEMENT_ROLES.includes(role);
  const isOwner = refId(order.userId) === String(socket.user.id);
  const isAssignedStaff = role === 'delivery' && refId(order.deliveryStaffAssigned) === String(socket.user.id);
  return isManagement || isOwner || isAssignedStaff;
};

const registerOrderHandlers = (io, socket) => {
  // Kitchen staff joins the 'kitchen' room for real-time order broadcasts.
  // Role comes from the verified JWT (socket.user), never from the client.
  socket.on('join:kitchen', () => {
    const role = roleOf(socket);
    if (!KITCHEN_ROOM_ROLES.includes(role)) {
      logger.warn('Rejected join:kitchen (unauthorized)', { socketId: socket.id, role });
      return;
    }
    socket.join('kitchen');
    logger.info('Socket joined kitchen room', {
      socketId: socket.id,
      userId: socket.user?.id,
    });
  });

  // Admin/management joins the 'admin' room (order events + delivery:location
  // broadcast for the admin deliveries dashboard).
  socket.on('join:admin', () => {
    const role = roleOf(socket);
    if (!ADMIN_ROOM_ROLES.includes(role)) {
      logger.warn('Rejected join:admin (unauthorized)', { socketId: socket.id, role });
      return;
    }
    socket.join('admin');
    logger.info('Socket joined admin room', {
      socketId: socket.id,
      userId: socket.user?.id,
    });
  });

  // Delivery staff joins the 'delivery' room for assignment/status broadcasts
  // (NOT GPS - GPS stays in per-order delivery:${orderId} rooms only, so one
  // rider can never observe another rider's location).
  socket.on('join:delivery', () => {
    const role = roleOf(socket);
    if (!DELIVERY_ROOM_ROLES.includes(role)) {
      logger.warn('Rejected join:delivery (unauthorized)', { socketId: socket.id, role });
      return;
    }
    socket.join('delivery');
    logger.info('Socket joined delivery room', {
      socketId: socket.id,
      userId: socket.user?.id,
    });
  });
  // Leave the delivery room
  socket.on('leave:delivery', () => {
    socket.leave('delivery');
    logger.info('Socket left delivery room', {
      socketId: socket.id,
      userId: socket.user?.id,
    });
  });

  // Join the per-order room for status + GPS events.
  // Authentication is REQUIRED; only the order owner, the assigned delivery
  // person, or management may join (verified against the database).
  socket.on('order:join', async (orderId, ack) => {
    if (!orderId || typeof orderId !== 'string') {
      return;
    }

    const room = `order:${orderId}`;

    if (!socket.user) {
      logger.warn('Rejected order:join (authentication required)', { socketId: socket.id, orderId });
      if (typeof ack === 'function') ack({ ok: false, error: 'Authentication required' });
      return;
    }

    try {
      const order = await Order.findOne({ orderId })
        .select('userId deliveryStaffAssigned orderType')
        .lean();
      if (!order) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Order not found' });
        return;
      }
      if (!canAccessOrder(socket, order)) {
        logger.warn('Rejected order:join (forbidden)', {
          socketId: socket.id,
          userId: socket.user.id,
          orderId,
        });
        if (typeof ack === 'function') ack({ ok: false, error: 'Forbidden' });
        return;
      }

      socket.join(room);
      logger.info('Socket joined order room', {
        socketId: socket.id,
        userId: socket.user?.id,
        orderId,
        room,
      });
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      logger.error('order:join failed', { socketId: socket.id, orderId, error: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: 'Server error' });
    }
  });

  // Customer leaves the order room
  socket.on('order:leave', (orderId) => {
    if (!orderId || typeof orderId !== 'string') {
      return;
    }

    const room = `order:${orderId}`;

    socket.leave(room);

    logger.info('Socket left order room', {
      socketId: socket.id,
      userId: socket.user?.id,
      orderId,
      room,
    });
  });

  // Join the room that receives real-time GPS locations for a delivery.
  // Authentication is REQUIRED (no guest watching). Authenticated sockets are
  // restricted to the order owner, the assigned delivery person, and
  // management roles - all verified against the database. Never trusts the
  // client to self-identify as a delivery person.
  socket.on('delivery:join', async (orderId, ack) => {
    if (!orderId || typeof orderId !== 'string') {
      return;
    }

    const room = `delivery:${orderId}`;

    if (!socket.user) {
      logger.warn('Rejected delivery:join (authentication required)', { socketId: socket.id, orderId });
      if (typeof ack === 'function') ack({ ok: false, error: 'Authentication required' });
      return;
    }

    try {
      const order = await Order.findOne({ orderId }).select('userId deliveryStaffAssigned orderType').lean();
      if (!order || order.orderType !== 'delivery') {
        if (typeof ack === 'function') ack({ ok: false, error: 'Order not found' });
        return;
      }

      if (!canAccessOrder(socket, order)) {
        logger.warn('Rejected delivery:join (forbidden)', {
          socketId: socket.id,
          userId: socket.user.id,
          orderId,
        });
        if (typeof ack === 'function') ack({ ok: false, error: 'Forbidden' });
        return;
      }

      socket.join(room);
      logger.info('Socket joined delivery GPS room', {
        socketId: socket.id,
        userId: socket.user?.id,
        orderId,
        room,
      });
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      logger.error('delivery:join failed', { socketId: socket.id, orderId, error: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: 'Server error' });
    }
  });

  // Leave the delivery GPS room
  socket.on('delivery:leave', (orderId) => {
    if (!orderId || typeof orderId !== 'string') {
      return;
    }

    const room = `delivery:${orderId}`;

    socket.leave(room);

    logger.info('Socket left delivery GPS room', {
      socketId: socket.id,
      userId: socket.user?.id,
      orderId,
      room,
    });
  });
};

module.exports = { registerOrderHandlers };
