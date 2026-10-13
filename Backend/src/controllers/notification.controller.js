const Notification = require('../models/Notification');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');
const { respondWithError } = require('../utils/respondError');

// Roles that must be told about order lifecycle events. The kitchen acts on
// them; the cafeteria/system management panels surface them for oversight.
const ORDER_EVENT_ROLES = ['kitchen', 'manager', 'cafeteria_admin', 'admin', 'system_admin'];

/**
 * @desc    Serialise a Notification document to the shape the API and the
 *          `notification:new` socket payload both use.
 *          One function so the realtime frame can never drift from the stored
 *          row the dashboard reloads.
 */
function serializeNotification(notif) {
  const meta = notif.meta && typeof notif.meta === 'object' ? notif.meta : {};
  return {
    id: notif._id,
    title: notif.title,
    message: notif.message,
    type: notif.type,
    orderId: notif.orderId,
    // The delivery a delivery-domain row refers to, when there is one. Surfaced
    // as a top-level field (rather than left buried in `meta`) so a client can
    // link a notification straight to its delivery without knowing which tag
    // the producing controller happened to use.
    deliveryId: meta.deliveryId || null,
    link: notif.link,
    eventKey: notif.eventKey || null,
    meta,
    isRead: notif.isRead,
    readAt: notif.readAt || null,
    createdAt: notif.createdAt,
  };
}

/**
 * @desc    Get notification preferences (sound on/off)
 * @route   GET /api/notifications/preferences
 * @access  Private
 */
exports.getPreferences = async (req, res) => {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.user.id).select('notificationSoundEnabled');
    res.status(HTTP_STATUS.OK).json({
      success: true,
      preferences: {
        soundEnabled: user ? user.notificationSoundEnabled !== false : true,
      },
    });
  } catch (error) {
    console.error('❌ Get Notification Preferences Error:', error);
    return respondWithError(res, error, MESSAGES.SERVER_ERROR, { exposeMessage: false });
  }
};

/**
 * @desc    Update notification preferences (sound on/off)
 * @route   PUT /api/notifications/preferences
 * @access  Private
 * Body: { soundEnabled: boolean }
 */
exports.updatePreferences = async (req, res) => {
  try {
    const soundEnabled = req.body.soundEnabled === true || req.body.soundEnabled === 'true';
    const User = require('../models/User');
    await User.updateOne({ _id: req.user.id }, { $set: { notificationSoundEnabled: soundEnabled } });
    res.status(HTTP_STATUS.OK).json({
      success: true,
      preferences: { soundEnabled },
      message: soundEnabled ? 'Notification sound enabled' : 'Notification sound muted',
    });
  } catch (error) {
    console.error('❌ Update Notification Preferences Error:', error);
    return respondWithError(res, error, MESSAGES.SERVER_ERROR, { exposeMessage: false });
  }
};

/**
 * @desc    Get user's notifications
 * @route   GET /api/notifications
 * @access  Private
 * Query Params: unread (true/false)
 */
exports.getNotifications = async (req, res) => {
  try {
    const { unread, types, limit } = req.query;
    let filter = { userId: req.user.id };
    if (unread === 'true') filter.isRead = false;
    // Optional narrowing, used by the kitchen panel to show order events only.
    if (types) {
      const wanted = String(types)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      if (wanted.length) filter.type = { $in: wanted };
    }

    let query = Notification.find(filter).sort({ createdAt: -1 });
    const max = Number(limit);
    if (Number.isInteger(max) && max > 0 && max <= 500) query = query.limit(max);
    const notifications = await query;

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: notifications.length,
      notifications: notifications.map((notif) => ({
        ...serializeNotification(notif),
        timeAgo: getTimeAgo(notif.createdAt),
      })),
    });
  } catch (error) {
    console.error('❌ Get Notifications Error:', error);
    return respondWithError(res, error, MESSAGES.SERVER_ERROR, { exposeMessage: false });
  }
};

/**
 * @desc    Get unread notification count
 * @route   GET /api/notifications/unread
 * @access  Private
 */
exports.getUnreadCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({ userId: req.user.id, isRead: false });
    res.status(HTTP_STATUS.OK).json({ success: true, count });
  } catch (error) {
    console.error('❌ Get Unread Count Error:', error);
    return respondWithError(res, error, MESSAGES.SERVER_ERROR, { exposeMessage: false });
  }
};

/**
 * @desc    Mark notification as read
 * @route   PATCH /api/notifications/:id/read
 * @access  Private
 */
exports.markAsRead = async (req, res) => {
  try {
    const notification = await Notification.findOne({ _id: req.params.id, userId: req.user.id });
    if (!notification) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Notification not found' });
    }
    // Scoped to this one _id AND this one owner: acknowledging notification A
    // can never flip notification B (or another user's) to read. The `isRead`
    // filter also makes this idempotent - a double click or a retried request
    // simply reports alreadyRead instead of moving readAt.
    const result = await Notification.updateOne(
      { _id: notification._id, userId: req.user.id, isRead: false },
      { $set: { isRead: true, readAt: new Date() } }
    );
    if (result.modifiedCount > 0) {
      notification.isRead = true;
      notification.readAt = new Date();
    }
    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Notification marked as read',
      // Reflect the persisted state, not the pre-update snapshot, so a client
      // that trusts the response never re-displays the item it just cleared.
      notification: serializeNotification(notification),
      alreadyRead: result.modifiedCount === 0,
    });
  } catch (error) {
    console.error('❌ Mark As Read Error:', error);
    return respondWithError(res, error, MESSAGES.SERVER_ERROR, { exposeMessage: false });
  }
};

/**
 * @desc    Mark all notifications as read
 * @route   PATCH /api/notifications/read-all
 * @access  Private
 */
exports.markAllRead = async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { userId: req.user.id, isRead: false },
      { isRead: true, readAt: new Date() }
    );
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'All notifications marked as read',
      count: result.modifiedCount,
    });
  } catch (error) {
    console.error('❌ Mark All Read Error:', error);
    return respondWithError(res, error, MESSAGES.SERVER_ERROR, { exposeMessage: false });
  }
};

/**
 * @desc    Delete notification
 * @route   DELETE /api/notifications/:id
 * @access  Private
 */
exports.deleteNotification = async (req, res) => {
  try {
    const notification = await Notification.findOne({ _id: req.params.id, userId: req.user.id });
    if (!notification) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Notification not found' });
    }
    await notification.deleteOne();
    res.status(HTTP_STATUS.OK).json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    console.error('❌ Delete Notification Error:', error);
    return respondWithError(res, error, MESSAGES.SERVER_ERROR, { exposeMessage: false });
  }
};

/**
 * @desc    Delete ALL of the user's notifications (clear all)
 * @route   DELETE /api/notifications
 * @access  Private
 */
exports.clearAllNotifications = async (req, res) => {
  try {
    const result = await Notification.deleteMany({ userId: req.user.id });
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'All notifications cleared',
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('❌ Clear All Notifications Error:', error);
    return respondWithError(res, error, MESSAGES.SERVER_ERROR, { exposeMessage: false });
  }
};

/**
 * @desc    Create notification (internal helper)
 */
exports.createNotification = async (userId, title, message, type = 'system', orderId = null, link = null, meta = null) => {
  try {
    const notification = await Notification.create({
      userId,
      title,
      message,
      type,
      orderId,
      link,
      meta: meta && typeof meta === 'object' ? meta : {},
      isRead: false,
      createdAt: new Date(),
    });
    return notification;
  } catch (error) {
    console.error('❌ Create Notification Error:', error);
    return null;
  }
};

/**
 * @desc    Create a notification AND push it over the socket in one call.
 *          Single source of truth so producers never dual-write and the
 *          `notification:new` payload always matches the stored document.
 * @returns {Promise<Object|null>} The created notification, or null on failure.
 */
exports.notifyUser = async (userId, title, message, type = 'system', orderId = null, link = null, meta = null) => {
  const notification = await exports.createNotification(userId, title, message, type, orderId, link, meta);
  if (!notification) return null;
  emitNotificationToUser(notification);
  return notification;
};

/**
 * Normalise the "which ops inserted a row" result of a bulkWrite into
 * `[{ index, id }]`.
 *
 * Driver v6 / Mongoose 9 expose `upsertedIds` as a Map (or plain object) of
 * op-index -> new _id. Older drivers returned `upserted` as an array of
 * `{ index, _id }`. Reading only one shape silently emits nothing at all, which
 * is exactly how the kitchen's realtime frame went missing while the database
 * row was still written.
 */
function normalizeUpserted(result) {
  const out = [];
  const ids = result && (result.upsertedIds || result.upserted);
  if (!ids) return out;
  if (typeof ids.forEach === 'function' && typeof ids[Symbol.iterator] === 'function' && !Array.isArray(ids)) {
    // Map-like: forEach((value, key))
    ids.forEach((value, key) => {
      const id = value && value._id !== undefined ? value._id : value;
      out.push({ index: Number(key), id });
    });
    return out;
  }
  if (Array.isArray(ids)) {
    ids.forEach((entry) => {
      if (!entry) return;
      out.push({ index: Number(entry.index), id: entry._id !== undefined ? entry._id : entry.id });
    });
    return out;
  }
  // Plain object: { "0": ObjectId, ... }
  Object.keys(ids).forEach((key) => {
    const value = ids[key];
    const id = value && value._id !== undefined ? value._id : value;
    out.push({ index: Number(key), id });
  });
  return out;
}

/**
 * Push one stored notification to its owner's `user:<id>` room.
 *
 * Best-effort by design: realtime must never be able to fail the business
 * operation that produced the notification. The row is already persisted, so a
 * dropped frame is still delivered on the next page load / poll.
 */
function emitNotificationToUser(notification) {
  try {
    const { emitSocketEvent } = require('../utils/socket');
    emitSocketEvent(`user:${notification.userId}`, 'notification:new', serializeNotification(notification));
  } catch (error) {
    console.warn('⚠️ notification:new emit failed:', error.message);
  }
}

/**
 * Order-lifecycle copy. Kept in one place so a new order and its cancellation
 * always read the same way to the kitchen, and so the on-screen wording the
 * requirement asks for ("New Customer Order" / "Order Cancelled") is decided
 * by the backend rather than re-guessed by every client.
 */
function describeOrderEvent(order, eventType) {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemCount =
    order.itemCount != null
      ? order.itemCount
      : items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const total = Number(order.totalAmount);

  if (eventType === 'cancelled') {
    const reason = String(order.cancellationReason || '').trim();
    const cancelledBy = String(order.eventSource || '').trim();
    const origin = cancelledBy ? ` (by ${cancelledBy})` : '';
    return {
      type: 'cancellation',
      title: `Order Cancelled - #${order.orderId}`,
      message: `Order #${order.orderId} for ${order.customerName || 'a customer'} has been cancelled${origin}.${
        reason ? ` Reason: ${reason}` : ''
      } The kitchen does not need to prepare it.`,
    };
  }

  return {
    type: 'order',
    title: 'New Customer Order',
    message: `New order #${order.orderId} from ${order.customerName || 'a customer'} (${itemCount} item${
      itemCount === 1 ? '' : 's'
    }${Number.isFinite(total) ? `, total ${total.toFixed(2)} ETB` : ''}).`,
  };
}

/**
 * @desc    Persist + emit ONE notification per (recipient, order, event) for an
 *          order lifecycle event, so the Kitchen Dashboard has a durable,
 *          de-duplicated record that survives a reload — not just a toast.
 *
 *          De-duplication is keyed on `eventKey` = `kitchen:<event>:<orderId>`,
 *          which is backed by a unique index in MongoDB. A retried order create,
 *          a replayed socket frame, or a second call site therefore cannot
 *          produce a second row (and therefore cannot ring a second sound).
 *
 * @param   {Object}   order     Order document (or summary) with orderId.
 * @param   {string[]} roles     Canonical role names to notify.
 * @param   {Object}   [opts]
 * @param   {string}   [opts.eventType='new']  'new' | 'cancelled'
 * @param   {boolean}  [opts.cafeteriaScoped]  Only notify staff of the order's cafeteria.
 * @param   {string}   [opts.audience='kitchen']
 * @returns {Promise<number>} Number of notifications actually created.
 */
exports.notifyRolesOfOrderEvent = async (order, roles, opts = {}) => {
  if (!order || !order.orderId || !Array.isArray(roles) || roles.length === 0) return 0;
  const User = require('../models/User');
  const eventType = opts.eventType === 'cancelled' ? 'cancelled' : 'new';
  const audience = opts.audience || 'kitchen';
  const { title, message, type } = describeOrderEvent(order, eventType);

  const meta = {
    eventType,
    audience,
    customerName: order.customerName || null,
    orderType: order.orderType || null,
    totalAmount: order.totalAmount ?? null,
    cafeteriaId: order.cafeteriaId || null,
    itemCount: order.itemCount ?? null,
  };
  if (eventType === 'cancelled') {
    meta.cancellationReason = order.cancellationReason || null;
    meta.cancellationSource = order.eventSource || null;
  }

  const { SYSTEM_ADMIN_ROLES } = require('../config/roles');
  const scopeToCafeteria = opts.cafeteriaScoped === true && Boolean(order.cafeteriaId);

  // System admins (admin / system_admin) are global operators: they are not
  // attached to a single cafeteria, so their `cafeteriaId` is null. Applying
  // `cafeteriaId: order.cafeteriaId` to the whole query silently excluded them,
  // and the empty-recipients safety net below never fired because the cafeteria
  // staff did match - so the admin dashboard's notification panel stayed empty
  // even though kitchen/manager got the notification. Split the lookup so
  // cafeteria-scoped roles stay scoped while system admins are always included.
  const globalRoles = roles.filter((r) => SYSTEM_ADMIN_ROLES.includes(r));
  const scopedRoles = roles.filter((r) => !SYSTEM_ADMIN_ROLES.includes(r));
  const baseQuery = { status: 'ACTIVE', isActive: { $ne: false } };

  const queries = [];
  if (globalRoles.length) queries.push({ ...baseQuery, role: { $in: globalRoles } });
  if (!scopeToCafeteria) {
    if (scopedRoles.length) queries.push({ ...baseQuery, role: { $in: scopedRoles } });
  } else if (scopedRoles.length) {
    queries.push({ ...baseQuery, role: { $in: scopedRoles }, cafeteriaId: order.cafeteriaId });
  }

  let recipients = queries.length ? await User.find({ $or: queries }).select('_id') : [];

  // Safety net: if a cafeteria has no staff accounts with cafeteriaId set yet,
  // fall back to every active member of the roles rather than notifying nobody.
  if ((!recipients || recipients.length === 0) && scopeToCafeteria && scopedRoles.length) {
    recipients = await User.find({ ...baseQuery, role: { $in: scopedRoles } }).select('_id');
    if (recipients && recipients.length) {
      console.warn(
        '⚠️ No cafeteria-scoped staff found; falling back to all active staff for roles:',
        scopedRoles.join(', ')
      );
    }
  }
  if (!recipients || recipients.length === 0) return 0;

  const link = `/src/pages/kitchen/orders.html?orderId=${encodeURIComponent(order.orderId)}`;

  // One batched round trip instead of a findOne+create per recipient.
  //
  // The production database is MongoDB Atlas reached over the internet, where a
  // single query costs ~450-510ms. Doing that twice per staff member (17 staff
  // => ~34 sequential round trips) took >16s and made `POST /orders` blow past
  // the frontend's 15s AbortController timeout, so the customer saw a timeout
  // even though the order had been created.
  //
  // The upsert is also strictly better for de-duplication than
  // read-then-write: it is atomic, so two concurrent requests for the same
  // order can never both insert a duplicate, and a retried order create is
  // idempotent.
  const now = new Date();
  const ops = recipients.map((recipient) => ({
    updateOne: {
      filter: { userId: recipient._id, eventKey: Notification.buildEventKey(audience, eventType, order.orderId) },
      update: {
        $setOnInsert: {
          userId: recipient._id,
          title,
          message,
          type,
          orderId: order.orderId,
          link,
          eventKey: Notification.buildEventKey(audience, eventType, order.orderId),
          meta,
          isRead: false,
          createdAt: now,
        },
      },
      upsert: true,
    },
  }));

  let result;
  try {
    result = await Notification.bulkWrite(ops, { ordered: false });
  } catch (error) {
    // A concurrent duplicate key (E11000) means the exact same event was
    // already stored by a racing request - which is the guarantee working, not
    // a failure. Anything else is a genuine problem worth surfacing.
    if (error && error.code === 11000) {
      console.warn(`⚠️ Duplicate order-event notification suppressed for #${order.orderId} (${eventType})`);
      return 0;
    }
    throw error;
  }

  // `ordered: false` reports per-op failures in `writeErrors` instead of
  // throwing, so a single colliding recipient must not be mistaken for a total
  // failure - and must not be silently invisible either.
  const writeErrors = result.writeErrors || [];
  if (writeErrors.length) {
    const unexpected = writeErrors.filter((e) => e && e.code !== 11000);
    if (unexpected.length) {
      console.error(
        `❌ Order-event fan-out for #${order.orderId} (${eventType}) had ${unexpected.length} non-duplicate write error(s):`,
        unexpected.map((e) => e.errmsg).join('; ')
      );
    } else {
      console.warn(
        `⚠️ ${writeErrors.length} duplicate order-event row(s) suppressed for #${order.orderId} (${eventType})`
      );
    }
  }

  const created = (result.upsertedCount || 0) + (result.insertedCount || 0);

  // Realtime push ONLY for rows that were actually created.
  //
  // Mongoose 9 / driver v6 report these in `upsertedIds` (a Map of op index ->
  // new _id); older shapes used `upserted` (an array of { index, _id }). Reading
  // only one of the two silently emits nothing, which is exactly how the
  // kitchen's realtime frame went missing while the database row was written.
  // Normalise both, and re-sending a duplicate is not an option either - the
  // panel would show the same order twice and ring a second time.
  const upserted = normalizeUpserted(result);
  for (const { index, id } of upserted) {
    const recipient = recipients[index];
    if (!recipient) continue;
    emitNotificationToUser({
      _id: id,
      userId: recipient._id,
      title,
      message,
      type,
      orderId: order.orderId,
      link,
      eventKey: Notification.buildEventKey(audience, eventType, order.orderId),
      meta,
      isRead: false,
      readAt: null,
      createdAt: now,
    });
  }

  if (created > 0) {
    console.log(
      `🔔 Kitchen ${eventType === 'cancelled' ? 'cancellation' : 'new order'} notification for #${order.orderId}:`,
      `${created} recipient(s), eventKey=${Notification.buildEventKey(audience, eventType, order.orderId)}`
    );
  }
  return created;
};

/**
 * @desc    Backwards-compatible wrapper for the original "new order" call site.
 */
exports.notifyRolesOfNewOrder = async (order, roles, opts = {}) => {
  return exports.notifyRolesOfOrderEvent(order, roles, { ...opts, eventType: 'new' });
};

/**
 * @desc    Tell the kitchen + management that an order was cancelled.
 *          Separate from the customer-facing cancellation notice on purpose:
 *          the kitchen has an operational action (stop cooking) and needs its
 *          own durable, acknowledgeable record.
 */
exports.notifyRolesOfCancellation = async (order, opts = {}) => {
  return exports.notifyRolesOfOrderEvent(order, opts.roles || ORDER_EVENT_ROLES, {
    ...opts,
    eventType: 'cancelled',
  });
};

function getTimeAgo(date) {
  const now = new Date();
  const diffMs = now - new Date(date);
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} mins ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  return `${diffDays} days ago`;
}
