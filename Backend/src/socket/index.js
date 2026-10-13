const jwt = require('jsonwebtoken');
const { logger } = require('../utils/logger');
const { initSocket } = require('../utils/socket');
const { normalizeRole } = require('../config/roles');
const { registerOrderHandlers } = require('./order.socket');
const { registerNotificationHandlers } = require('./notification.socket');

const setupSocketIO = (io) => {
  // Store Socket.io instance
  initSocket(io);

  // JWT middleware to populate socket.user for room-based notifications
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      logger.warn('Socket connection without token');
      return next();
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;
      next();
    } catch (err) {
      logger.warn('Socket invalid token', { error: err.message });
      next();
    }
  });

  io.on('connection', (socket) => {
    logger.info('Socket client connected', {
      socketId: socket.id,
      userId: socket.user?.id,
      role: socket.user?.role,
    });

    // Auto-join role-based rooms (role from the verified JWT, normalized so
    // aliases like kitchen_staff / delivery_staff match the canonical sets).
    const role = socket.user ? normalizeRole(socket.user.role) : '';
    if (['kitchen', 'admin', 'system_admin', 'cafeteria_admin', 'manager'].includes(role)) {
      socket.join('kitchen');
    }
    if (['admin', 'system_admin', 'cafeteria_admin', 'manager'].includes(role)) {
      socket.join('admin');
    }
    if (role === 'delivery') {
      socket.join('delivery');
    }
    // Personal courier room `delivery:<deliveryStaffId>`: assignment and
    // lifecycle frames for THIS rider only, so private order/customer payloads
    // never ride a broadcast. The id comes from the verified JWT - the client
    // cannot join anyone else's room.
    if (role === 'delivery' && socket.user?.id) {
      socket.join(`delivery:${socket.user.id}`);
    }

    registerOrderHandlers(io, socket);
    registerNotificationHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      logger.info('Socket client disconnected', {
        socketId: socket.id,
        reason,
      });
    });
  });

  return io;
};

module.exports = { setupSocketIO };
