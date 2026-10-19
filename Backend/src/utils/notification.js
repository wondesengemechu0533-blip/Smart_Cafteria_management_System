const Notification = require('../models/Notification');
const User = require('../models/User');
const { emitSocketEvent } = require('./socket');

/**
 * Shared notification helpers.
 *
 * Single source of truth for the project's persist-then-emit notification
 * pattern so every controller (issue reports, stock alerts, delivery, ...)
 * notifies users the same way instead of re-implementing it.
 */

/**
 * Persist a notification for a user and fan it out over Socket.IO.
 * Failures never break the main flow (best-effort by design).
 */
async function notifyUser(userId, { title, message, type = 'status_update', link = null }) {
  if (!userId) return null;
  try {
    const notification = await Notification.create({
      userId,
      title,
      message,
      type,
      link,
      isRead: false,
      createdAt: new Date(),
    });
    try {
      emitSocketEvent(`user:${userId}`, 'notification:new', {
        id: notification._id,
        title: notification.title,
        message: notification.message,
        type: notification.type,
        orderId: notification.orderId,
        link: notification.link,
        isRead: notification.isRead,
        createdAt: notification.createdAt,
      });
    } catch (e) {
      console.warn('Socket emit failed for notification:new:', e.message);
    }
    return notification;
  } catch (error) {
    console.warn('Notification persist/emit failed:', error.message);
    return null;
  }
}

/** Active Cafeteria Managers of the given cafeteria (real users from MongoDB). */
async function findCafeteriaManagers(cafeteriaId) {
  if (!cafeteriaId) return [];
  return User.find({
    role: { $in: ['manager', 'cafeteria_manager'] },
    cafeteriaId,
    status: 'ACTIVE',
    isActive: { $ne: false },
  })
    .select('_id')
    .lean();
}

/** Active Cafeteria Admins of the given cafeteria (restock reviewers). */
async function findCafeteriaAdmins(cafeteriaId) {
  if (!cafeteriaId) return [];
  return User.find({
    role: { $in: ['cafeteria_admin'] },
    cafeteriaId,
    status: 'ACTIVE',
    isActive: { $ne: false },
  })
    .select('_id name')
    .lean();
}

module.exports = { notifyUser, findCafeteriaManagers, findCafeteriaAdmins };