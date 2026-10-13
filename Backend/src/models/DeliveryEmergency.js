const mongoose = require('mongoose');

/**
 * DeliveryEmergency - a rider's SOS, kept deliberately separate from
 * DeliveryIssue.
 *
 * A DeliveryIssue answers "something is slowing this delivery down" (traffic,
 * vehicle trouble, customer not answering). It is a workflow object: it can
 * hold the delivery, it can be reassigned, and it resolves back into the
 * normal flow.
 *
 * A DeliveryEmergency answers "the rider is in danger". It is not a dropdown
 * option in a problem modal and it does not share a state machine with issues,
 * because the response is different: an emergency must be acknowledged by a
 * human before it can disappear, and it must never be auto-cleared by the
 * issue/hold bookkeeping that releases a delivery when its last issue closes.
 *
 * Lifecycle:
 *   ACTIVE -> ACKNOWLEDGED -> RESOLVED
 *   ACTIVE -> CANCELLED        (a false alarm / duplicate)
 *
 * ACTIVE means "a rider is waiting for a manager to respond". While an
 * emergency is ACTIVE the delivery is on hold and the manager dashboard keeps
 * sounding and showing the banner - neither goes away on its own.
 */

const EMERGENCY_STATUSES = ['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'CANCELLED'];

const EMERGENCY_TRANSITIONS = {
  ACTIVE: ['ACKNOWLEDGED', 'CANCELLED'],
  ACKNOWLEDGED: ['RESOLVED', 'CANCELLED'],
  RESOLVED: [],
  CANCELLED: [],
};

const EmergencySchema = new mongoose.Schema(
  {
    // --- Linkage -----------------------------------------------------------
    delivery: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Delivery',
      required: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    orderId: { type: String, required: true, trim: true },
    // The rider who pressed SOS. Snapshotted so the record still names the
    // person in danger even if the assignment is later changed or cleared.
    deliveryPerson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    deliveryPersonName: { type: String, default: '' },
    deliveryPersonPhone: { type: String, default: '' },
    cafeteriaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafeteria',
      default: null,
    },

    // --- Where the rider was when they pressed SOS -------------------------
    // Real GPS, captured by the rider's own device at the moment of the press.
    // Null only when the browser refused location permission - the emergency
    // is still created, because "no fix" must never stop an SOS reaching a
    // manager.
    latitude: { type: Number, default: null, min: -90, max: 90 },
    longitude: { type: Number, default: null, min: -180, max: 180 },
    accuracy: { type: Number, default: null, min: 0 },
    locationAvailable: { type: Boolean, default: false },

    // --- State -------------------------------------------------------------
    status: {
      type: String,
      enum: EMERGENCY_STATUSES,
      default: 'ACTIVE',
      index: true,
    },
    triggeredAt: { type: Date, default: Date.now },
    acknowledgedAt: { type: Date, default: null },
    acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    acknowledgedByName: { type: String, default: '' },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolutionNote: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelNote: { type: String, default: null },

    statusHistory: [
      {
        status: { type: String, enum: EMERGENCY_STATUSES, required: true },
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

// The duplicate guard: a delivery can have at most ONE active emergency.
// Without this, a rider tapping SOS repeatedly (panic, flaky connection,
// double-tap) would spawn a row per tap and make the manager dashboard
// unreadable - and would look like several riders are in danger when only
// one is.
//
// Partial so it only applies to ACTIVE rows: a delivery may legitimately
// accumulate historical emergencies over its life.
EmergencySchema.index(
  { delivery: 1 },
  {
    unique: true,
    name: 'delivery_emergency_active_unique',
    partialFilterExpression: { status: 'ACTIVE' },
  }
);
EmergencySchema.index({ cafeteriaId: 1, status: 1, triggeredAt: -1 });
EmergencySchema.index({ orderId: 1, triggeredAt: -1 });

EmergencySchema.methods.isTerminal = function () {
  return ['RESOLVED', 'CANCELLED'].includes(this.status);
};

/** Compact shape for the manager dashboard banner and socket payload. */
EmergencySchema.methods.toEmergencyPayload = function () {
  return {
    id: String(this._id),
    deliveryId: String(this.delivery),
    orderId: this.orderId,
    deliveryPersonId: String(this.deliveryPerson),
    deliveryPersonName: this.deliveryPersonName || null,
    deliveryPersonPhone: this.deliveryPersonPhone || null,
    cafeteriaId: this.cafeteriaId ? String(this.cafeteriaId) : null,
    latitude: this.latitude,
    longitude: this.longitude,
    accuracy: this.accuracy,
    locationAvailable: Boolean(this.locationAvailable),
    status: this.status,
    triggeredAt: this.triggeredAt,
    acknowledgedAt: this.acknowledgedAt,
    acknowledgedBy: this.acknowledgedBy ? String(this.acknowledgedBy) : null,
    acknowledgedByName: this.acknowledgedByName || null,
    resolvedAt: this.resolvedAt,
    resolutionNote: this.resolutionNote || null,
  };
};

module.exports = mongoose.model('DeliveryEmergency', EmergencySchema);
module.exports.EMERGENCY_STATUSES = EMERGENCY_STATUSES;
module.exports.EMERGENCY_TRANSITIONS = EMERGENCY_TRANSITIONS;
