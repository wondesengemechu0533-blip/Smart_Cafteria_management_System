const mongoose = require('mongoose');

/**
 * DeliveryLocation - GPS point history for active deliveries.
 *
 * Deliberately a separate collection from Order / Delivery so that frequent
 * GPS updates never bloat the main delivery document. The latest point is
 * mirrored onto Delivery.currentLocation and Order.currentLocation (see
 * delivery.controller.updateDeliveryLocation) so a single lightweight read
 * always returns the last known fix.
 *
 * Only created while a delivery is actually active (PICKED_UP /
 * OUT_FOR_DELIVERY / ARRIVED). Coordinates are always the delivery person's
 * real device GPS fix - never generated, mocked, or invented on the server.
 */
const DeliveryLocationSchema = new mongoose.Schema(
  {
    // The Delivery record this point belongs to.
    delivery: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Delivery',
      required: true,
    },
    // Owning order. Stored alongside `delivery` so the history stays joinable
    // even if a delivery record is ever rebuilt from the order.
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      default: null,
    },
    orderId: {
      type: String,
      trim: true,
      index: true,
    },
    deliveryPerson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    latitude: {
      type: Number,
      required: true,
      min: -90,
      max: 90,
    },
    longitude: {
      type: Number,
      required: true,
      min: -180,
      max: 180,
    },
    accuracy: {
      type: Number,
      required: true,
      min: 0,
    },
    // Optional device-reported movement data: heading in degrees (0-360) and
    // speed in metres per second. Null when the GPS does not provide them.
    heading: {
      type: Number,
      default: null,
      min: -360,
      max: 360,
    },
    speed: {
      type: Number,
      default: null,
      min: 0,
    },
    // Timestamp reported by the device GPS (ms since epoch or ISO date).
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Allow fast "latest point for a delivery" lookups.
DeliveryLocationSchema.index({ delivery: 1, timestamp: -1 });
DeliveryLocationSchema.index({ delivery: 1, deliveryPerson: 1 });
// Prune-able history per delivery person (reports / analytics).
DeliveryLocationSchema.index({ deliveryPerson: 1, createdAt: -1 });
// Per-rider history by device GPS timestamp (admin rider tracking, replay,
// pruning). deliveryPerson is stamped from the JWT - never from the client.
DeliveryLocationSchema.index({ deliveryPerson: 1, timestamp: -1 });

module.exports = mongoose.model('DeliveryLocation', DeliveryLocationSchema);