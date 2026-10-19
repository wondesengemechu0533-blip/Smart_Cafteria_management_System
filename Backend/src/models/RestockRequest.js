const mongoose = require('mongoose');

/**
 * RestockRequest Schema - Cafeteria Manager → Cafeteria Admin replenishment
 * workflow.
 *
 * A manager submits a request when a menu item falls below its minimum stock
 * threshold (or is out of stock). The Cafeteria Admin reviews it and, once the
 * goods are physically received, records the ACTUAL received quantity which is
 * then applied to the MenuItem's authoritative stockQuantity.
 *
 * Status lifecycle:
 *   PENDING → APPROVED → RESTOCKED
 *   PENDING → REJECTED
 *   PENDING → CANCELLED (by the requesting manager)
 *
 * IMPORTANT: submitting or approving a request NEVER changes the item's
 * stockQuantity. Stock is only increased when the admin records a restock with
 * the actually received quantity (PATCH /api/v1/restocks/:id/restock).
 */
const RESTOCK_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  RESTOCKED: 'RESTOCKED',
  CANCELLED: 'CANCELLED',
};

const RestockRequestSchema = new mongoose.Schema(
  {
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      required: true,
    },
    itemName: {
      type: String,
      required: true,
      trim: true,
    },
    // Snapshot of the item's stockQuantity when the request was submitted.
    currentQuantity: {
      type: Number,
      required: true,
      min: 0,
    },
    requestedQuantity: {
      type: Number,
      required: true,
      min: [1, 'Requested quantity must be at least 1'],
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: [1000, 'Reason cannot exceed 1000 characters'],
    },
    // Authenticated manager who submitted the request - stamped from JWT.
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(RESTOCK_STATUS),
      default: RESTOCK_STATUS.PENDING,
    },
    // Cafeteria Admin review (approve / reject with optional explanation)
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    reviewNote: {
      type: String,
      trim: true,
      default: null,
      maxlength: [1000, 'Review note cannot exceed 1000 characters'],
    },
    // Actual stock received, recorded by the Cafeteria Admin when the goods
    // physically arrive. This - not requestedQuantity - is what is added to
    // the MenuItem's stockQuantity.
    receivedQuantity: {
      type: Number,
      default: null,
      min: 0,
    },
    restockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    restockedAt: {
      type: Date,
      default: null,
    },
    restockNote: {
      type: String,
      trim: true,
      default: null,
      maxlength: [1000, 'Restock note cannot exceed 1000 characters'],
    },
    // Optional links so the request can be traced back to the stock alert
    // and/or kitchen issue report that triggered it. These links never merge
    // the two records - StockAlert and IssueReport stay independent.
    alertId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StockAlert',
      default: null,
    },
    issueReportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'IssueReport',
      default: null,
    },
    // Owning cafeteria (tenant). Stamped server-side from the requester.
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

RestockRequestSchema.index({ cafeteriaId: 1, status: 1 });
RestockRequestSchema.index({ itemId: 1, status: 1 });
RestockRequestSchema.index({ requestedBy: 1, createdAt: -1 });
RestockRequestSchema.index({ createdAt: -1 });

// Prevent duplicate open requests for the same item: at most one PENDING and
// one APPROVED request per item may exist at any time. Application code also
// checks this, but the partial unique indexes are the hard guarantee against
// concurrent double-submissions. (Equality-based partial filters are used
// instead of $in so the index works on every supported MongoDB version.)
RestockRequestSchema.index(
  { itemId: 1 },
  { unique: true, name: 'one_pending_request_per_item', partialFilterExpression: { status: 'PENDING' } }
);
RestockRequestSchema.index(
  { itemId: 1 },
  { unique: true, name: 'one_approved_request_per_item', partialFilterExpression: { status: 'APPROVED' } }
);

module.exports = mongoose.model('RestockRequest', RestockRequestSchema);
module.exports.RESTOCK_STATUS = RESTOCK_STATUS;
