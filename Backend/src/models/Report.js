const mongoose = require('mongoose');

/**
 * Report Schema - System reports
 *
 * Frontend Usage:
 * - admin/reports.html: Generate sales, order, and popular items reports
 */
const ReportSchema = new mongoose.Schema(
  {
    reportType: {
      type: String,
      enum: ['daily_orders', 'sales', 'popular_items', 'payments'],
      required: true,
    },
    date: {
      type: String,
      required: true,
    },
    fromDate: {
      type: Date,
      required: true,
    },
    toDate: {
      type: Date,
      required: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    summary: {
      totalOrders: { type: Number, default: 0 },
      totalSales: { type: Number, default: 0 },
      totalItems: { type: Number, default: 0 },
      topItems: { type: Array, default: [] },
    },
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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

module.exports = mongoose.model('Report', ReportSchema);
