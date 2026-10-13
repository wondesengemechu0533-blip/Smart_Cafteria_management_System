const mongoose = require('mongoose');

/**
 * KitchenReport Schema - Track kitchen performance metrics
 *
 * Used for:
 * - Performance analytics
 * - Preparation time tracking
 * - Order fulfillment rates
 * - Staff efficiency metrics
 * - Daily/weekly/monthly reports
 */
const KitchenReportSchema = new mongoose.Schema(
  {
    reportDate: {
      type: Date,
      required: true,
    },
    reportType: {
      type: String,
      enum: ['daily', 'weekly', 'monthly'],
      default: 'daily',
    },
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    totalOrdersReceived: {
      type: Number,
      default: 0,
    },
    totalOrdersCompleted: {
      type: Number,
      default: 0,
    },
    totalOrdersCancelled: {
      type: Number,
      default: 0,
    },
    orderFulfillmentRate: {
      type: Number,
      default: 0,
    },
    averagePreparationTime: {
      type: Number,
      default: 0,
    },
    peakHourOrders: {
      type: Number,
      default: 0,
    },
    peakHourTime: {
      type: String,
      default: null,
    },
    totalItemsPrepared: {
      type: Number,
      default: 0,
    },
    mostPreparedItems: [
      {
        itemId: mongoose.Schema.Types.ObjectId,
        itemName: String,
        count: Number,
      },
    ],
    leastPreparedItems: [
      {
        itemId: mongoose.Schema.Types.ObjectId,
        itemName: String,
        count: Number,
      },
    ],
    staffPerformance: [
      {
        staffId: mongoose.Schema.Types.ObjectId,
        staffName: String,
        ordersCompleted: Number,
        averageTime: Number,
        efficiency: Number,
      },
    ],
    qualityIssuesReported: {
      type: Number,
      default: 0,
    },
    stockIssuesReported: {
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
KitchenReportSchema.index({ reportDate: -1, reportType: 1 });
KitchenReportSchema.index({ staffId: 1, reportDate: -1 });

module.exports = mongoose.model('KitchenReport', KitchenReportSchema);
