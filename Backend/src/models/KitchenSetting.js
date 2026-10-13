const mongoose = require('mongoose');

/**
 * KitchenSetting Schema - Per-user kitchen preferences
 *
 * Used for:
 * - Kitchen station assignment
 * - Notification/sound preferences
 * - Auto-refresh behavior
 * - Display preferences
 */
const KitchenSettingSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    station: {
      type: String,
      default: 'Station 1',
      trim: true,
    },
    notificationSound: {
      type: Boolean,
      default: true,
    },
    orderAlertSound: {
      type: Boolean,
      default: true,
    },
    preparationTimerAlert: {
      type: Boolean,
      default: true,
    },
    autoRefresh: {
      type: Boolean,
      default: true,
    },
    refreshInterval: {
      type: Number,
      default: 30,
      min: 5,
      max: 300,
    },
    showCompletedOrders: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('KitchenSetting', KitchenSettingSchema);
