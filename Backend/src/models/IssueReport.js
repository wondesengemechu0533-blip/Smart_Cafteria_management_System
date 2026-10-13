const mongoose = require('mongoose');

/**
 * IssueReport Schema - Kitchen Staff issue reports awaiting a Cafeteria
 * Manager response/solution.
 *
 * Workflow (only these transitions are valid):
 *   PENDING -> ACCEPTED -> RESOLVED
 *
 * Frontend Usage:
 * - kitchen/issues.html: Kitchen Staff creates reports, views manager solution
 * - manager/issues.html: Cafeteria Manager accepts reports and sends solutions
 *
 * Note: existing models were inspected first and none fit this workflow -
 * StockAlert is inventory-specific (active/acknowledged/resolved/cancelled),
 * Feedback is customer rating-based (requires rating, no title/priority), and
 * KitchenReport stores performance metrics. A dedicated model is required.
 */
const ISSUE_REPORT_STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
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
      default: ISSUE_REPORT_STATUS.PENDING,
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
    // Manager acceptance (PENDING -> ACCEPTED)
    acceptedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    // Manager solution/reply (ACCEPTED -> RESOLVED)
    solution: {
      type: String,
      trim: true,
      default: null,
      maxlength: [2000, 'Solution cannot exceed 2000 characters'],
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
