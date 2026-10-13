const mongoose = require('mongoose');

/**
 * DeliveryIssue Schema - a problem reported by a delivery person while a
 * delivery is in progress.
 *
 * This is deliberately a SEPARATE collection from `Delivery` rather than a
 * field on it:
 *   - one delivery can accumulate several distinct problems (traffic, then a
 *     flat tyre, then the customer is not answering);
 *   - issues have their own lifecycle (OPEN -> IN_PROGRESS -> RESOLVED) and
 *     their own owner (a manager), which is a different axis from the delivery
 *     state machine;
 *   - the Delivery state machine in services/delivery.service.js stays exactly
 *     as it is, so no existing order / kitchen / tracking behaviour changes.
 *
 * Reporting an issue NEVER moves the delivery forward. In particular it can
 * never make a delivery DELIVERED: only the courier's own `markDelivered`
 * transition (or a manager resolving an issue and letting them continue) can
 * do that. The delivery is blocked from being auto-completed while an issue is
 * open; see services/deliveryIssue.service.js.
 */

/** The problem categories a courier can report. */
const DELIVERY_ISSUE_TYPES = [
  'VEHICLE_PROBLEM',
  'ROAD_BLOCKED',
  'HEAVY_TRAFFIC',
  'CANNOT_FIND_LOCATION',
  'CUSTOMER_NOT_ANSWERING',
  'WRONG_ADDRESS',
  'BAD_WEATHER',
  'ORDER_DAMAGED',
  'ORDER_MISSING',
  'GPS_PROBLEM',
  'PAYMENT_PROBLEM',
  'SAFETY_PROBLEM',
  'OTHER',
];

const DELIVERY_ISSUE_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED'];

const ISSUE_TRANSITIONS = {
  OPEN: ['IN_PROGRESS', 'RESOLVED', 'CANCELLED'],
  IN_PROGRESS: ['RESOLVED', 'CANCELLED'],
  RESOLVED: [],
  CANCELLED: [],
};

/**
 * Issue types that, on their own, mean the customer will wait noticeably
 * longer. Used to decide whether the customer gets the plain-language delay
 * notice. A problem that is purely internal (a GPS glitch, a payment
 * question) must NOT be leaked to the customer as a delay.
 */
const CUSTOMER_DELAYING_TYPES = [
  'VEHICLE_PROBLEM',
  'ROAD_BLOCKED',
  'HEAVY_TRAFFIC',
  'BAD_WEATHER',
  'SAFETY_PROBLEM',
  'CANNOT_FIND_LOCATION',
  'WRONG_ADDRESS',
  // The courier is at the door and the customer does not answer: the food is
  // still on their hands, so they are plainly being kept waiting.
  'CUSTOMER_NOT_ANSWERING',
];

const DeliveryIssueSchema = new mongoose.Schema(
  {
    // --- Linkage ----------------------------------------------------------
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true,
    },
    // Human order id, so an issue is readable without a second lookup.
    orderId: { type: String, required: true, trim: true, index: true },
    delivery: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Delivery',
      required: true,
      index: true,
    },
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Snapshot of the courier's name/phone at report time, so the manager list
    // renders correctly even if the courier account is later removed.
    reportedByName: { type: String, trim: true, default: '' },
    reportedByPhone: { type: String, trim: true, default: '' },
    // The tenant boundary. Every manager read is filtered by this.
    cafeteriaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafeteria',
      default: null,
      index: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // --- What went wrong ---------------------------------------------------
    issueType: {
      type: String,
      enum: DELIVERY_ISSUE_TYPES,
      required: true,
      index: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    // Optional photo, uploaded through the existing cloud upload utility.
    photo: { type: String, default: null, trim: true },

    // --- Where the courier was when they reported it ------------------------
    // Strictly validated. Null is a legitimate, meaningful value: the courier
    // had no GPS fix. `locationAvailable: false` says so explicitly so the UI
    // can render "Location unavailable" instead of an empty map pin - and so
    // nobody ever stores or plots 0,0.
    latitude: { type: Number, default: null, min: -90, max: 90 },
    longitude: { type: Number, default: null, min: -180, max: 180 },
    accuracy: { type: Number, default: null, min: 0 },
    locationAvailable: { type: Boolean, default: false },
    // The delivery status at the moment of the report, for context.
    deliveryStatusAtReport: { type: String, default: null },
    // When the courier says the problem happened (device clock), kept separate
    // from the server-side createdAt.
    reportedAt: { type: Date, default: Date.now },

    // --- Lifecycle --------------------------------------------------------
    status: {
      type: String,
      enum: DELIVERY_ISSUE_STATUSES,
      default: 'OPEN',
      index: true,
    },

    // True when this issue is delaying the customer. Decided by the courier at
    // report time (derived from issueType) and overridable by a manager.
    delaysDelivery: { type: Boolean, default: false },
    // The delivery was placed on hold because of this issue.
    deliveryOnHold: { type: Boolean, default: false },

    // Whether the customer has been told about the delay (exactly once).
    customerNotified: { type: Boolean, default: false },
    customerNotifiedAt: { type: Date, default: null },

    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolutionNote: { type: String, default: null, trim: true, maxlength: 2000 },

    // Manager decided to hand the delivery to a different delivery person.
    reassignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reassignedAt: { type: Date, default: null },
    reassignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // --- Audit -------------------------------------------------------------
    statusHistory: [
      {
        status: { type: String, enum: DELIVERY_ISSUE_STATUSES, required: true },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        note: { type: String, default: '' },
      },
    ],
  },
  {
    timestamps: true,
    minimize: false,
  }
);

// Manager dashboard: open issues for my cafeteria, newest first.
DeliveryIssueSchema.index({ cafeteriaId: 1, status: 1, createdAt: -1 });
// Courier: my reported issues / issues on my delivery.
DeliveryIssueSchema.index({ delivery: 1, createdAt: -1 });
DeliveryIssueSchema.index({ reportedBy: 1, createdAt: -1 });
// Block a delivery from accumulating the same open problem over and over.
DeliveryIssueSchema.index(
  { delivery: 1, issueType: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['OPEN', 'IN_PROGRESS'] } } }
);

DeliveryIssueSchema.methods.isTerminal = function () {
  return ['RESOLVED', 'CANCELLED'].includes(this.status);
};

DeliveryIssueSchema.methods.isOpen = function () {
  return ['OPEN', 'IN_PROGRESS'].includes(this.status);
};

/**
 * Public shape for Socket.IO and the manager/courier UIs. Never includes the
 * reporter's private notes beyond the description, and never includes internal
 * fields such as `customerNotified`.
 */
DeliveryIssueSchema.methods.toIssuePayload = function () {
  return {
    id: String(this._id),
    orderId: this.orderId,
    deliveryId: this.delivery ? String(this.delivery) : null,
    issueType: this.issueType,
    description: this.description,
    status: this.status,
    latitude: this.locationAvailable ? this.latitude : null,
    longitude: this.locationAvailable ? this.longitude : null,
    accuracy: this.locationAvailable ? this.accuracy : null,
    locationAvailable: Boolean(this.locationAvailable),
    photo: this.photo || null,
    reportedBy: this.reportedBy ? String(this.reportedBy) : null,
    reportedByName: this.reportedByName || '',
    cafeteriaId: this.cafeteriaId || null,
    deliveryStatusAtReport: this.deliveryStatusAtReport || null,
    delaysDelivery: Boolean(this.delaysDelivery),
    deliveryOnHold: Boolean(this.deliveryOnHold),
    reportedAt: this.reportedAt || this.createdAt,
    createdAt: this.createdAt,
    resolvedAt: this.resolvedAt || null,
    resolutionNote: this.resolutionNote || null,
    reassignedTo: this.reassignedTo ? String(this.reassignedTo) : null,
    reassignedAt: this.reassignedAt || null,
    statusHistory: (this.statusHistory || []).map((h) => ({
      status: h.status,
      at: h.at,
      note: h.note || '',
    })),
  };
};

module.exports = mongoose.model('DeliveryIssue', DeliveryIssueSchema);
module.exports.DELIVERY_ISSUE_TYPES = DELIVERY_ISSUE_TYPES;
module.exports.DELIVERY_ISSUE_STATUSES = DELIVERY_ISSUE_STATUSES;
module.exports.ISSUE_TRANSITIONS = ISSUE_TRANSITIONS;
module.exports.CUSTOMER_DELAYING_TYPES = CUSTOMER_DELAYING_TYPES;
