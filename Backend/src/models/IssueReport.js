const mongoose = require('mongoose');

/**
 * IssueReport Schema - Kitchen Staff issue reports awaiting Cafeteria Manager
 * review and Cafeteria Admin resolution.
 *
 * Workflow (only these transitions are valid):
 *   OPEN → UNDER_REVIEW → REQUEST_SENT → RESOLVED
 *
 * - OPEN: kitchen staff just submitted the report.
 * - UNDER_REVIEW: manager clicked "Review Report" and recorded investigation notes.
 * - REQUEST_SENT: manager submitted a ResolutionRequest to the Cafeteria Admin.
 * - RESOLVED: Admin processed the request and marked the report resolved.
 *
 * Frontend Usage:
 * - kitchen/issues.html: Kitchen Staff creates reports, views status + solution
 * - manager/issues.html: Manager reviews reports, submits admin requests
 * - admin/issues.html (or manager/issues.html admin-gated): Admin processes requests
 *
 * Note: existing models were inspected first and none fit this workflow -
 * StockAlert is inventory-specific (active/acknowledged/resolved/cancelled),
 * Feedback is customer rating-based (requires rating, no title/priority), and
 * KitchenReport stores performance metrics. A dedicated model is required.
 */
const ISSUE_REPORT_STATUS = {
  OPEN: 'OPEN',
  UNDER_REVIEW: 'UNDER_REVIEW',
  REQUEST_SENT: 'REQUEST_SENT',
  RESOLVED: 'RESOLVED',
};

const ISSUE_CATEGORIES = ['equipment', 'stock', 'quality', 'safety', 'cleaning', 'staffing', 'other'];

const ISSUE_PRIORITIES = ['low', 'medium', 'high', 'critical'];

const IssueReportSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Issue title is required'],
      trim: true,
      maxlength: [200, 'Title cannot exceed 200 characters'],
    },
    description: {
      type: String,
      required: [true, 'Issue description is required'],
      trim: true,
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
    },
    category: {
      type: String,
      enum: ISSUE_CATEGORIES,
      default: 'other',
    },
    priority: {
      type: String,
      enum: ISSUE_PRIORITIES,
      default: 'medium',
    },
    status: {
      type: String,
      enum: Object.values(ISSUE_REPORT_STATUS),
      default: ISSUE_REPORT_STATUS.OPEN,
    },
    // Authenticated Kitchen Staff user who submitted the report. Stamped
    // server-side from the JWT - never accepted from the client.
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Owning cafeteria (tenant). Stamped server-side from the reporter's
    // User record so cross-cafeteria access can be enforced.
    cafeteriaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafeteria',
      default: null,
    },
    // Manager review (OPEN → UNDER_REVIEW). Investigation notes record what
    // the manager inspected before submitting a request to the Admin.
    investigationNotes: {
      type: String,
      trim: true,
      default: null,
      maxlength: [2000, 'Investigation notes cannot exceed 2000 characters'],
    },
    investigatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    investigatedAt: {
      type: Date,
      default: null,
    },
    // Link to the ResolutionRequest the manager submitted to the Cafeteria
    // Admin (UNDER_REVIEW → REQUEST_SENT). Traceability only - resolving the
    // request also resolves this report, but they remain separate records.
    resolutionRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ResolutionRequest',
      default: null,
    },
    // Admin resolution details (REQUEST_SENT → RESOLVED). Populated when the
    // Admin resolves the linked ResolutionRequest.
    solution: {
      type: String,
      trim: true,
      default: null,
      maxlength: [2000, 'Solution cannot exceed 2000 characters'],
    },
    resolutionReason: {
      type: String,
      trim: true,
      default: null,
      maxlength: [200, 'Resolution reason cannot exceed 200 characters'],
    },
    resolutionSolution: {
      type: String,
      trim: true,
      default: null,
      maxlength: [200, 'Resolution solution cannot exceed 200 characters'],
    },
    resolutionQuantity: {
      type: Number,
      default: null,
    },
    repliedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    repliedAt: {
      type: Date,
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    // Optional link to the menu item this issue concerns (e.g. an Ingredient
    // Shortage or Quality Issue report about "Coffee"). Used so the manager
    // can request a restock or apply a quality hold for the right item.
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      default: null,
    },
    // Link to the restock request raised while handling this issue. The link
    // is traceability only - resolving the issue never resolves the request
    // (or a stock alert) and vice versa.
    restockRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RestockRequest',
      default: null,
    },
    // Link to a stock alert for the same item, when one exists.
    alertId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StockAlert',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for quick queries
IssueReportSchema.index({ cafeteriaId: 1, status: 1 });
IssueReportSchema.index({ reportedBy: 1, status: 1 });
IssueReportSchema.index({ status: 1 });
IssueReportSchema.index({ createdAt: -1 });

module.exports = mongoose.model('IssueReport', IssueReportSchema);
module.exports.ISSUE_REPORT_STATUS = ISSUE_REPORT_STATUS;
module.exports.ISSUE_CATEGORIES = ISSUE_CATEGORIES;
module.exports.ISSUE_PRIORITIES = ISSUE_PRIORITIES;
