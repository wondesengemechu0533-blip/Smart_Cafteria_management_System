// utils/socket.js

const { logger } = require('./logger');

let ioInstance = null;

// Store the Socket.io server instance
const initSocket = (io) => {
  if (!io) {
    throw new Error('Socket.io instance is required');
  }

  ioInstance = io;

  logger.info('Socket.io initialized');
};

// Get the Socket.io instance when needed
const getSocket = () => {
  if (!ioInstance) {
    throw new Error('Socket.io has not been initialized');
  }

  return ioInstance;
};

// Emit an event to a room or all connected clients
const emitSocketEvent = (room, eventName, payload) => {
  if (!ioInstance) {
    logger.warn('Socket.io is not initialized; event was not emitted');

    return false;
  }

  if (room) {
    ioInstance.to(room).emit(eventName, payload);
  } else {
    ioInstance.emit(eventName, payload);
  }

  return true;
};

module.exports = { initSocket, getSocket, emitSocketEvent };
