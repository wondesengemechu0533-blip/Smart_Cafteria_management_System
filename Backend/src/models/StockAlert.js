const mongoose = require('mongoose');

/**
 * StockAlert Schema - Track out-of-stock and inventory issues
 *
 * Used for:
 * - Reporting items out of stock
 * - Tracking ingredient shortages
 * - Notifying admin of issues
 * - Historical tracking of availability changes
 */
const StockAlertSchema = new mongoose.Schema(
  {
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      required: false,
    },
    itemName: {
      type: String,
      required: true,
    },
    alertType: {
      type: String,
      enum: ['out_of_stock', 'low_stock', 'ingredient_shortage', 'quality_issue'],
      default: 'out_of_stock',
    },
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'high',
    },
    reason: {
      type: String,
      required: true,
    },
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    reportedByRole: {
      type: String,
      enum: ['kitchen', 'admin'],
      default: 'kitchen',
    },
    status: {
      type: String,
      enum: ['active', 'acknowledged', 'resolved', 'cancelled'],
      default: 'active',
    },
    // Manager responsibility assignment (recognizes the issue and who owns it).
    acknowledgedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    assignedAt: {
      type: Date,
      default: null,
    },
    assignedNote: {
      type: String,
      default: null,
    },
    resolutionNote: {
      type: String,
      default: null,
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    affectedOrders: {
      type: [
        {
          orderId: mongoose.Schema.Types.ObjectId,
          orderNumber: String,
        },
      ],
      default: [],
    },
    estimatedResolutionTime: {
      type: Date,
      default: null,
    },
    // Owning cafeteria (tenant). Stamped server-side when the alert is created
    // so kitchen stock alerts stay scoped to the caller's cafeteria.
    cafeteriaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafeteria',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Index for quick queries
StockAlertSchema.index({ itemId: 1, status: 1 });
StockAlertSchema.index({ status: 1 });
StockAlertSchema.index({ reportedBy: 1 });
StockAlertSchema.index({ createdAt: -1 });
StockAlertSchema.index({ cafeteriaId: 1, status: 1 });

module.exports = mongoose.model('StockAlert', StockAlertSchema);
