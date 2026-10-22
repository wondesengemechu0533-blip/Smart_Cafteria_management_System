const mongoose = require('mongoose');

/**
 * KitchenShift Schema - Track kitchen staff shifts
 *
 * Used for:
 * - Staff clock-in/clock-out
 * - Shift management
 * - Workload tracking
 * - Performance metrics
 */
const KitchenShiftSchema = new mongoose.Schema(
  {
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    shiftType: {
      type: String,
      enum: ['morning', 'afternoon', 'evening', 'night', 'custom'],
      default: 'morning',
    },
    startTime: {
      type: Date,
      required: true,
    },
    endTime: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ['scheduled', 'active', 'completed', 'cancelled'],
      default: 'scheduled',
    },
    clockInTime: {
      type: Date,
      default: null,
    },
    clockOutTime: {
      type: Date,
      default: null,
    },
    breaksStarted: [
      {
        startTime: Date,
        endTime: Date,
        reason: String,
      },
    ],
    ordersAssigned: {
      type: Number,
      default: 0,
    },
    ordersCompleted: {
      type: Number,
      default: 0,
    },
    averagePreparationTime: {
      type: Number,
      default: 0,
    },
    notes: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// Index for quick queries
KitchenShiftSchema.index({ staffId: 1, status: 1 });
KitchenShiftSchema.index({ startTime: 1 });
KitchenShiftSchema.index({ status: 1 });

// In this DB the collection was created as 'kitchenshifts' (lowercase plural)
// while Mongoose defaults to 'kitchenshifts' too, but sometimes connections
// point to a different naming; we explicitly pin it to avoid reading an
// empty collection.
module.exports = mongoose.model('KitchenShift', KitchenShiftSchema, 'kitchenshifts');
