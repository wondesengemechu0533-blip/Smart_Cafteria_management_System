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
 * Which personal preference governs which notification type.
 *
 * Only the categories a user can actually switch off in "Notification
 * Preferences" are mapped. Transactional and safety messages (cancellations,
 * refunds, delivery events, promotions) are deliberately NOT mapped: they
 * carry money, food-safety or courier information and must always be
 * delivered, whatever the receiver has muted.
 */
const NOTIFICATION_PREFERENCE_BY_TYPE = {
  order: 'newOrders',
  stock_alert: 'lowStock',
};

/**
 * Is this user currently opted in to this notification category?
 *
 * The preference lives on the USER document, so it is personal: one manager
 * muting "new order alerts" never silences anybody else.
 *
 * @param {string} userId
 * @param {string} type            Notification type.
 * @param {string} [preferenceKey] Explicit preference key (overrides the map).
 * @returns {Promise<boolean>}
 */
async function isNotificationEnabled(userId, type, preferenceKey) {
  if (!userId) return false;
  const key = preferenceKey || NOTIFICATION_PREFERENCE_BY_TYPE[String(type || '').trim()];
  if (!key) return true; // no category -> always deliver
  try {
    const user = await User.findById(userId).select('notificationPreferences').lean();
    if (!user) return true;
    const prefs = user.notificationPreferences || {};
    return prefs[key] !== false;
  } catch (error) {
    // Never drop a notification because the preference lookup failed.
    return true;
  }
}

/**
 * Persist a notification for a user and fan it out over Socket.IO.
 * Failures never break the main flow (best-effort by design).
 *
 * The recipient's own notification preferences are honoured: a user who
 * switched a category off does not get that category any more.
 */
async function notifyUser(userId, { title, message, type = 'status_update', link = null, preference = null }) {
  if (!userId) return null;
  try {
    if (!(await isNotificationEnabled(userId, type, preference))) {
      console.log(`🔕 Notification suppressed by preference (${type}) for user ${userId}`);
      return null;
    }
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

/** Active reviewers of a cafeteria (restock approvers) - the real users from MongoDB.
 *
 * WHY the role list changed:
 * This used to look for the `cafeteria_admin` role alone. That role was
 * folded into `admin` when the cafeteria_admin/manager roles were
 * consolidated, and `User.role` normalizes the old spelling on write, so the
 * query could no longer match ANY account. The result was silent: a submitted
 * restock request produced no notification for the person who has to approve
 * it. The reviewers are now the admins (see REVIEW_ROLES in
 * routes/restock.routes.js), with the legacy spelling kept in the list so a
 * database that still holds pre-migration rows keeps working.
 */
async function findCafeteriaAdmins(cafeteriaId) {
  if (!cafeteriaId) return [];
  return User.find({
    role: { $in: ['admin', 'system_admin', 'cafeteria_admin'] },
    cafeteriaId,
    status: 'ACTIVE',
    isActive: { $ne: false },
  })
    .select('_id name')
    .lean();
}

module.exports = {
  notifyUser,
  isNotificationEnabled,
  NOTIFICATION_PREFERENCE_BY_TYPE,
  findCafeteriaManagers,
  findCafeteriaAdmins,
};