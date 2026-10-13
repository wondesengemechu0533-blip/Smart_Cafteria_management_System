const mongoose = require('mongoose');

/**
 * Notification Schema - User notifications
 *
 * Frontend Usage:
 * - notifications.html: Display user notifications
 * - active-order.js: Show order status updates
 */

// Order-lifecycle notifications the kitchen must never miss.
// `order`        -> a customer placed a new order
// `cancellation` -> an existing order was cancelled
const ORDER_EVENT_TYPES = ['order', 'cancellation'];
const NOTIFICATION_TYPES = [
  'order',
  'promo',
  'system',
  'status_update',
  'ready',
  'cancellation',
  // Delivery safety. Distinct from the above because they are raised by the
  // delivery safety system and are read by different surfaces: the OTP code is
  // shown to the customer, the emergency alert is shown to managers.
  'delivery_otp',
  'delivery_emergency',
  // A courier-reported delivery problem (wrong address, unreachable customer,
  // damaged/lost item, ...). Produced by deliveryIssue.controller.js.
  //
  // MUST stay in this enum: it is the tag the delivery panel's "Problems" filter
  // matches on. It was previously produced at three call sites while missing
  // here, so every one of those Notification.create() calls failed validation
  // and createNotification() swallowed the error and returned null - the rows
  // were never persisted at all. Adding the value here is what makes those
  // notifications exist.
  'delivery_issue',
  // A delivery job was assigned to / taken off this courier. The delivery
  // panel's "Assignments" filter matches on THIS, not on the message text.
  //
  // These two values exist because every delivery notification used to be filed
  // under the generic `status_update`, which made an assignment notice and a
  // "picked up" notice indistinguishable by type. The panel then had to depend
  // on ad-hoc `meta.assignment` / `meta.deliveryStatus` tags, and any row
  // written without those tags (including every historical row) was
  // uncategorisable - so "Assignments" and "Status Updates" could render empty
  // while the rows were plainly there under "All". A real type is the durable
  // category the filters are supposed to read.
  'delivery_assigned',
  // A delivery lifecycle step reached this courier (picked up, out for
  // delivery, arrived, delivered, completed, failed, cancelled).
  'delivery_status',
  // A kitchen stock/ingredient issue report (StockAlert workflow). Raised when
  // kitchen staff report an out-of-stock / low-stock / shortage / quality issue
  // so cafeteria managers get a badge + toast, and again when a manager
  // acknowledges or resolves the report so the reporting staff can track it.
  // MUST stay in this enum: it is the tag the badge and stock-alert filters
  // match on - without it every Notification.create() call here fails
  // validation and the rows are silently dropped.
  'stock_alert',
];

const NotificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: NOTIFICATION_TYPES,
      default: 'system',
    },
    orderId: {
      type: String,
      default: null,
    },
    link: {
      type: String,
      default: null,
    },
    /**
     * Stable identity of the DOMAIN EVENT that produced this row, in the form
     * `kitchen:<eventType>:<orderId>` (e.g. `kitchen:new:ET-1002ABCD`).
     *
     * This is the de-duplication key required so a single order event can never
     * produce two notifications (or two alert sounds): producers upsert on it
     * and a partial unique index makes the guarantee atomic in the database
     * rather than relying on a read-then-write race being won by luck.
     *
     * Deliberately has NO default so that notifications which are not tied to a
     * domain event (customer-facing status updates, promo/system notices, ...)
     * simply omit the field and stay outside the unique index.
     */
    eventKey: {
      type: String,
      default: undefined,
    },
    // Optional structured context rendered by the notification centre
    // (e.g. { customerName, orderType, totalAmount, cafeteriaId, eventType }).
    // Mixed + default {} keeps existing documents/API consumers valid.
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    readAt: {
      type: Date,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Mark as read
NotificationSchema.methods.markAsRead = function () {
  // Idempotent: acknowledging an already-read notification must not move its
  // readAt, so "when did staff actually see this?" stays truthful.
  if (this.isRead) return Promise.resolve(this);
  this.isRead = true;
  this.readAt = new Date();
  return this.save();
};

/** Build the canonical event key for an order lifecycle event. */
NotificationSchema.statics.buildEventKey = function (audience, eventType, orderId) {
  if (!audience || !eventType || !orderId) return undefined;
  return `${audience}:${eventType}:${orderId}`;
};

// Supports the newest-first list, the unread badge count, and the
// duplicate-avoidance lookup used when fanning out an order event.
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, isRead: 1 });
NotificationSchema.index({ userId: 1, orderId: 1, type: 1 });
// The kitchen panel opens with "everything still unread, newest first".
NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

// THE duplicate guard. Partial + unique so only order-event rows (the ones that
// actually carry an eventKey) participate: two concurrent order creations, a
// retried request, or a second call site all collapse onto a single row
// instead of alerting the kitchen twice.
//
// The compound `userId + eventKey` shape is essential and was a real bug once:
// indexed on `eventKey` ALONE it allowed the event to exist only once in the
// entire collection, so the fan-out inserted a row for the first recipient and
// every other staff member hit E11000 and silently got nothing. Each recipient
// needs their own copy, because "has THIS staff member seen it?" is per user.
NotificationSchema.index(
  { userId: 1, eventKey: 1 },
  {
    unique: true,
    name: 'notification_event_key_unique',
    // `$type: 'string'` keeps documents without an eventKey out of the index,
    // so unrelated notification rows can never collide on a shared null.
    partialFilterExpression: { eventKey: { $type: 'string' } },
  }
);

module.exports = mongoose.model('Notification', NotificationSchema);
module.exports.ORDER_EVENT_TYPES = ORDER_EVENT_TYPES;
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
