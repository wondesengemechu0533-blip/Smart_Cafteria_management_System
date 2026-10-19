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
    // 'system'  → automatic threshold alert maintained by the stock-alert
    //             lifecycle service (low stock / out of stock).
    // 'manual'  → reported by a human (kitchen staff report issue form,
    //             mark-unavailable action, ...).
    alertSource: {
      type: String,
      enum: ['system', 'manual'],
      default: 'manual',
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
    // System-generated threshold alerts have no human reporter; manual
    // reports always carry the authenticated reporter's id.
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      default: null,
    },
    reportedByRole: {
      type: String,
      enum: ['kitchen', 'admin', 'manager', 'system'],
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
    resolutionReason: {
      type: String,
      default: null,
    },
    resolutionSolution: {
      type: String,
      default: null,
    },
    resolutionQuantity: {
      type: Number,
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

// Hard guarantee against duplicate ACTIVE system threshold alerts for the
// same item + condition (e.g. two concurrent Low Stock alerts for Coffee).
// Application code also de-duplicates via findOne, but this index makes the
// invariant hold even under races.
StockAlertSchema.index(
  { itemId: 1, alertType: 1 },
  {
    unique: true,
    name: 'one_active_system_alert_per_item_type',
    partialFilterExpression: { status: 'active', alertSource: 'system', itemId: { $type: 'objectId' } },
  }
);

module.exports = mongoose.model('StockAlert', StockAlertSchema);
