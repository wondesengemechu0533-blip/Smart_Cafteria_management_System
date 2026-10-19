const mongoose = require('mongoose');

/**
 * ResolutionRequest Schema - Cafeteria Manager → Cafeteria Admin issue
 * resolution request workflow.
 *
 * A manager reviews an IssueReport (OPEN → UNDER_REVIEW), records
 * investigation notes, then submits a ResolutionRequest asking the Admin to
 * take a specific action (restock, repair, replace, deep clean, etc.).
 *
 * Status lifecycle:
 *   PENDING → IN_PROGRESS → RESOLVED   (Admin accepts, works on it, resolves)
 *   PENDING → REJECTED                 (Admin rejects with a reason)
 *
 * The Cafeteria Admin is the ONLY role that can change this request's status
 * (accept/reject/resolve). The manager can view status and cancel while
 * PENDING. Resolving the request also marks the linked IssueReport as RESOLVED.
 */
const RESOLUTION_REQUEST_STATUS = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
  REJECTED: 'REJECTED',
};

const ResolutionRequestSchema = new mongoose.Schema(
  {
    // The IssueReport this request is about. Required - every request must
    // trace back to a report the manager has reviewed.
    issueReportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'IssueReport',
      required: [true, 'Issue report ID is required'],
    },
    // Owning cafeteria (tenant). Stamped server-side from the reporter's
    // cafeteriaId so cross-cafeteria access can be enforced.
    cafeteriaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafeteria',
      default: null,
    },
    // Authenticated manager who submitted the request - stamped from JWT.
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Optional link to the menu item this request concerns (e.g. restock
    // coffee, replace oven element). Mirrors IssueReport.itemId.
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      default: null,
    },
    // The specific action the manager is asking the Admin to take.
    // Free text so the manager can describe e.g. "Restock 50kg coffee beans",
    // "Replace oven heating element", "Deep clean fryer station".
    requestedAction: {
      type: String,
      required: [true, 'Requested action is required'],
      trim: true,
      maxlength: [500, 'Requested action cannot exceed 500 characters'],
    },
    // Snapshot of the manager's investigation notes at the time of submission.
    investigationNotes: {
      type: String,
      trim: true,
      default: null,
      maxlength: [2000, 'Investigation notes cannot exceed 2000 characters'],
    },
    status: {
      type: String,
      enum: Object.values(RESOLUTION_REQUEST_STATUS),
      default: RESOLUTION_REQUEST_STATUS.PENDING,
    },
    // --- Admin review/accept (PENDING → IN_PROGRESS) ---
    acceptedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    // --- Admin reject (PENDING → REJECTED) ---
    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    rejectedAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      trim: true,
      default: null,
      maxlength: [1000, 'Rejection reason cannot exceed 1000 characters'],
    },
    // --- Admin resolve (IN_PROGRESS → RESOLVED) ---
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    resolutionNote: {
      type: String,
      trim: true,
      default: null,
      maxlength: [2000, 'Resolution note cannot exceed 2000 characters'],
    },
    // Link to a restock request raised while handling this issue, when the
    // requested action is a restock. Traceability only - resolving one never
    // auto-resolves the other.
    restockRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RestockRequest',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

ResolutionRequestSchema.index({ cafeteriaId: 1, status: 1 });
ResolutionRequestSchema.index({ issueReportId: 1 });
ResolutionRequestSchema.index({ requestedBy: 1, createdAt: -1 });
ResolutionRequestSchema.index({ createdAt: -1 });

// Prevent duplicate open requests for the same issue report: at most one
// PENDING and one IN_PROGRESS request per report may exist at any time.
// Application code also checks this, but the partial unique indexes are the
// hard guarantee against concurrent double-submissions.
ResolutionRequestSchema.index(
  { issueReportId: 1 },
  {
    unique: true,
    name: 'one_pending_request_per_report',
    partialFilterExpression: { status: 'PENDING' },
  }
);
ResolutionRequestSchema.index(
  { issueReportId: 1 },
  {
    unique: true,
    name: 'one_in_progress_request_per_report',
    partialFilterExpression: { status: 'IN_PROGRESS' },
  }
);

module.exports = mongoose.model('ResolutionRequest', ResolutionRequestSchema);
module.exports.RESOLUTION_REQUEST_STATUS = RESOLUTION_REQUEST_STATUS;
