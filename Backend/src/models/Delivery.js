const mongoose = require('mongoose');

/**
 * Delivery Schema - first-class delivery record for a delivery order.
 *
 * Relationship: ONE delivery per order that has `Order.orderType === 'delivery'`.
 * The Order stays the source of truth for money (subtotal / serviceFee /
 * deliveryFee / VAT / paymentStatus) and for the kitchen-facing status, so
 * nothing in the existing checkout, payment or kitchen flows has to change.
 * This collection owns everything that is *delivery specific*:
 *
 *   - who the courier is (deliveryPerson) and when they accepted
 *   - where the food is picked up and where it must be dropped off
 *   - the real distance / ETA used for pricing and customer expectations
 *   - the delivery state machine (REQUESTED -> ... -> DELIVERED -> COMPLETED | FAILED | CANCELLED)
 *   - the courier's latest real GPS fix (mirrored from DeliveryLocation history)
 *
 * `status` is kept in lock-step with Order.orderStatus (see
 * services/delivery.service.js) so a delivery never disagrees with the order
 * that backs it.
 */

const DELIVERY_STATUSES = [
  'REQUESTED',
  'ASSIGNED',
  'ACCEPTED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'ARRIVED',
  'DELIVERED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

const DELIVERY_FAILURE_REASONS = [
  'CUSTOMER_UNAVAILABLE',
  'WRONG_ADDRESS',
  'CUSTOMER_REFUSED',
  'PHONE_UNREACHABLE',
  'OUT_OF_REACH',
  'WEATHER',
  'RESTAURANT_ISSUE',
  'OTHER',
];

const DELIVERY_PAYMENT_STATES = ['PAID', 'PENDING', 'REFUND_PENDING', 'REFUNDED', 'NOT_APPLICABLE'];

const geoPoint = (extra = {}) => ({
  latitude: { type: Number, default: null, min: -90, max: 90 },
  longitude: { type: Number, default: null, min: -180, max: 180 },
  accuracy: { type: Number, default: null, min: 0 },
  // Device-reported travel heading (degrees) and speed (m/s), when provided.
  heading: { type: Number, default: null, min: -360, max: 360 },
  speed: { type: Number, default: null, min: 0 },
  timestamp: { type: Date, default: null },
  ...extra,
});

const DeliverySchema = new mongoose.Schema(
  {
    // --- Identity / linkage ---------------------------------------------
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    // Human-facing order id (Order.orderId). Unique so one order can never end
    // up with two competing delivery records.
    orderId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // The assigned courier. Null until a manager assigns one.
    deliveryPerson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    cafeteriaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafeteria',
      default: null,
    },

    // --- Route -----------------------------------------------------------
    // Where the courier collects the food (the cafeteria). Real, configured
    // data - never a hard-coded or generated coordinate.
    pickupLocation: {
      name: { type: String, trim: true, default: '' },
      address: { type: String, trim: true, default: '' },
      phone: { type: String, trim: true, default: '' },
      latitude: { type: Number, default: null, min: -90, max: 90 },
      longitude: { type: Number, default: null, min: -180, max: 180 },
    },
    // Where the food must be delivered (from the customer's real checkout data).
    destination: {
      contactName: { type: String, trim: true, default: '' },
      phone: { type: String, trim: true, default: '' },
      // Structured Ethiopian delivery location (any city - never hardcoded).
      city: { type: String, trim: true, default: '' },
      area: { type: String, trim: true, default: '' },
      kebele: { type: String, trim: true, default: '' },
      streetArea: { type: String, trim: true, default: '' },
      landmark: { type: String, trim: true, default: '' },
      houseNumber: { type: String, trim: true, default: '' },
      subCity: { type: String, trim: true, default: '' },
      // Human readable address (house/street + sub-city).
      address: { type: String, trim: true, default: '' },
      // Free-text customer instructions (gate code, "call on arrival", ...).
      note: { type: String, trim: true, default: '' },
      latitude: { type: Number, default: null, min: -90, max: 90 },
      longitude: { type: Number, default: null, min: -180, max: 180 },
      hasCoordinates: { type: Boolean, default: false },
    },

    // Promoted destination coordinates, exactly as provided by the customer
    // (or null when the customer chose an address-only delivery). The customer
    // tracking map and the courier navigation button both read these.
    latitude: { type: Number, default: null, min: -90, max: 90 },
    longitude: { type: Number, default: null, min: -180, max: 180 },

    // Straight-line distance cafeteria -> customer, in km. Null when either
    // end has no real coordinates (the address-only fallback path).
    distanceKm: { type: Number, default: null, min: 0 },
    // Estimated travel time in minutes (distance based, configurable).
    etaMinutes: { type: Number, default: null, min: 0 },
    // Fee actually charged for this delivery (mirrors Order.deliveryFee).
    deliveryFee: { type: Number, default: 0, min: 0 },
    // Fee basis used, so a report can explain a price: FLAT | DISTANCE | NULL.
    feeMode: { type: String, enum: ['FLAT', 'DISTANCE', 'NULL'], default: 'FLAT' },

    // --- State machine ---------------------------------------------------
    status: {
      type: String,
      enum: DELIVERY_STATUSES,
      default: 'REQUESTED',
      index: true,
    },
    // Explicit accept/decline of an assignment (kept in sync with
    // Order.deliveryAcceptanceStatus for the existing kitchen/admin screens).
    acceptanceStatus: {
      type: String,
      enum: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'DECLINED'],
      default: 'PENDING_ACCEPTANCE',
    },
    declineReason: { type: String, default: null },

    // --- Timestamps (each set once, when the matching step happens) ------
    requestedAt: { type: Date, default: Date.now },
    assignedAt: { type: Date, default: null },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    acceptedAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },
    outForDeliveryAt: { type: Date, default: null },
    arrivedAt: { type: Date, default: null },
    // Handover moment: proof of delivery was accepted. The delivery stays in
    // the courier's ACTIVE list until it is completed, so nothing falls
    // between the two lists.
    deliveredAt: { type: Date, default: null },
    // Final close-out by the assigned courier. This is the terminal state that
    // moves the order to COMPLETED.
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },

    // --- Proof of delivery -------------------------------------------------
    // A delivery is only DELIVERED once the courier can prove the handover
    // happened. Either a photo of the drop-off, or a one-time OTP the customer
    // reads out (and which the backend verifies), is sufficient on its own; a
    // manager may override both when the situation genuinely calls for it.
    //
    // `customerOtp` is the short-lived code sent to the customer. It is written
    // only by generateDeliveryOtp() and is NEVER included in any serialized
    // payload - a proof endpoint that echoed it would let anyone holding a
    // delivery summary confirm a delivery they never made.
    proofPhoto: { type: String, default: null },
    proofNote: { type: String, default: null },
    confirmedByCustomer: { type: Boolean, default: false },
    customerOtp: { type: String, default: null },
    customerOtpExpiresAt: { type: Date, default: null },
    // Wrong-guess counter. Capped so a brute-force attempt against a 6-digit
    // code is not possible; hitting the cap invalidates the code.
    otpAttempts: { type: Number, default: 0, min: 0 },
    proofVerifiedAt: { type: Date, default: null },
    // Who bypassed the proof requirement, and why. Null on every clean
    // delivery, so a non-null value is always a deliberate, auditable act.
    proofOverrideBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    proofOverrideReason: { type: String, default: null },

    // --- Failure handling ------------------------------------------------
    failureReason: {
      type: String,
      enum: [...DELIVERY_FAILURE_REASONS, null],
      default: null,
    },
    failureNote: { type: String, default: null },
    // How many times this delivery has been retried after a failure.
    retryCount: { type: Number, default: 0, min: 0 },
    lastRetryAt: { type: Date, default: null },

    // --- Live courier GPS (mirrors the newest DeliveryLocation row) -------
    currentLocation: geoPoint(),

    // --- Manager hold (set from the Delivery Issue system) -----------------
    // A hold PAUSES a delivery without inventing a new lifecycle state: the
    // delivery stays in its current status (e.g. OUT_FOR_DELIVERY), GPS keeps
    // recording, and the customer keeps seeing the real position. It is
    // deliberately NOT part of DELIVERY_STATUSES so the existing state machine,
    // the kitchen order status and the customer timeline are unaffected.
    // Cleared automatically once the last open issue on this delivery closes.
    onHold: { type: Boolean, default: false },
    holdReason: { type: String, default: null },
    heldAt: { type: Date, default: null },
    heldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resumedAt: { type: Date, default: null },
    // Count of currently OPEN/IN_PROGRESS issues. Not denormalised truth - it is
    // a cache refreshed on write - and never used to decide permissions.
    openIssueCount: { type: Number, default: 0, min: 0 },

    // --- Money / payment mirror (Order remains the source of truth) ------
    subtotal: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, default: 0, min: 0 },
    paymentStatus: {
      type: String,
      enum: DELIVERY_PAYMENT_STATES,
      default: 'PENDING',
    },

    // --- Audit trail (embedded: always read together with the delivery) --
    statusHistory: [
      {
        status: { type: String, enum: DELIVERY_STATUSES, required: true },
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

// One delivery per order - the hard guarantee behind "no duplicate systems".
DeliverySchema.index({ order: 1 }, { unique: true });
// "My active deliveries" / "my history" lookups for the courier dashboard.
DeliverySchema.index({ deliveryPerson: 1, status: 1, updatedAt: -1 });
DeliverySchema.index({ customer: 1, createdAt: -1 });
// Dispatch queues: unassigned requests + cafeteria-wide active deliveries.
DeliverySchema.index({ status: 1, cafeteriaId: 1, createdAt: -1 });
DeliverySchema.index({ cafeteriaId: 1, status: 1, createdAt: -1 });
// Delivery fee / distance reports.
DeliverySchema.index({ deliveredAt: -1 });
DeliverySchema.index({ status: 1, deliveredAt: -1 });
DeliverySchema.index({ status: 1, completedAt: -1 });

/**
 * True once the delivery can no longer change state on its own.
 * DELIVERED is deliberately NOT terminal: the handover is proven, but the
 * assigned courier still has to close the delivery out, and only COMPLETED
 * finalises the order.
 */
DeliverySchema.methods.isTerminal = function () {
  return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(this.status);
};

/** In-flight: the courier is still working this delivery (GPS is tracking). */
DeliverySchema.methods.isActive = function () {
  return ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED'].includes(this.status);
};

/** Still on the courier's active list: in-flight, or handed over but not closed. */
DeliverySchema.methods.isOpen = function () {
  return !this.isTerminal();
};

/** Compact representation used for Socket.IO payloads. */
DeliverySchema.methods.toTrackingPayload = function () {
  return {
    id: String(this._id),
    orderId: this.orderId,
    customerId: String(this.customer),
    deliveryPersonId: this.deliveryPerson ? String(this.deliveryPerson) : null,
    pickupLocation: this.pickupLocation,
    destination: this.destination,
    latitude: this.latitude,
    longitude: this.longitude,
    distanceKm: this.distanceKm,
    etaMinutes: this.etaMinutes,
    deliveryFee: this.deliveryFee,
    status: this.status,
    acceptanceStatus: this.acceptanceStatus,
    currentLocation: this.currentLocation,
    onHold: Boolean(this.onHold),
    holdReason: this.holdReason || null,
    openIssueCount: this.openIssueCount || 0,
    failureReason: this.failureReason,
    retryCount: this.retryCount,
    assignedAt: this.assignedAt,
    acceptedAt: this.acceptedAt,
    pickedUpAt: this.pickedUpAt,
    outForDeliveryAt: this.outForDeliveryAt,
    arrivedAt: this.arrivedAt,
    deliveredAt: this.deliveredAt,
    completedAt: this.completedAt,
    // Proof is reported as booleans/flags only. The OTP itself and the photo
    // URL are deliberately absent: the photo is fetched through the dedicated
    // proof endpoint by someone who is allowed to see it, and the OTP must
    // never leave the server.
    proof: {
      photo: Boolean(this.proofPhoto),
      note: this.proofNote || null,
      confirmedByCustomer: Boolean(this.confirmedByCustomer),
      verifiedAt: this.proofVerifiedAt,
      overridden: Boolean(this.proofOverrideBy),
    },
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model('Delivery', DeliverySchema);
module.exports.DELIVERY_STATUSES = DELIVERY_STATUSES;
module.exports.DELIVERY_FAILURE_REASONS = DELIVERY_FAILURE_REASONS;
