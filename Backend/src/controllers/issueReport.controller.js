const mongoose = require('mongoose');
const IssueReport = require('../models/IssueReport');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');
const { normalizeRole, isAdminRole } = require('../config/roles');
const { resolveCafeteriaScope, getDefaultCafeteriaId } = require('../utils/cafeteria');
const { notifyUser, findCafeteriaManagers } = require('../utils/notification');
const { emitSocketEvent } = require('../utils/socket');
const { logAction } = require('../utils/audit');

const { ISSUE_REPORT_STATUS, ISSUE_CATEGORIES, ISSUE_PRIORITIES } = require('../models/IssueReport');

const KITCHEN_ROLES = ['kitchen'];
const MANAGER_ROLES = ['manager'];
const CAFETERIA_ADMIN_ROLES = ['cafeteria_admin'];

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

/** Serialize an IssueReport (populated) into the API shape. */
function serialize(issue) {
  const reporter = issue.reportedBy;
  const acceptedBy = issue.acceptedBy;
  const repliedBy = issue.repliedBy;
  return {
    id: issue._id,
    title: issue.title,
    description: issue.description,
    category: issue.category,
    priority: issue.priority,
    status: issue.status,
    reportedBy: reporter && reporter._id ? { id: reporter._id, name: reporter.name } : issue.reportedBy,
    cafeteriaId: issue.cafeteriaId,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    acceptedBy: acceptedBy && acceptedBy._id ? { id: acceptedBy._id, name: acceptedBy.name } : issue.acceptedBy,
    acceptedAt: issue.acceptedAt,
    solution: issue.solution,
    repliedBy: repliedBy && repliedBy._id ? { id: repliedBy._id, name: repliedBy.name } : issue.repliedBy,
    repliedAt: issue.repliedAt,
    resolvedAt: issue.resolvedAt,
  };
}

const POPULATE = [
  { path: 'reportedBy', select: 'name role' },
  { path: 'acceptedBy', select: 'name role' },
  { path: 'repliedBy', select: 'name role' },
];

/**
 * Resolve + enforce the caller's cafeteria scope for a loaded report.
 * Returns null when access is allowed, otherwise writes the error response.
 */
function enforceCafeteriaAccess(req, res, issue) {
  const role = normalizeRole(req.user.role);
  if (isAdminRole(role)) return null; // system admins keep system-wide access

  if (KITCHEN_ROLES.includes(role)) {
    if (String(issue.reportedBy?._id || issue.reportedBy) !== String(req.user.id)) {
      res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'You can only view issue reports you submitted',
      });
      return true;
    }
    return null;
  }

  // manager / cafeteria_admin: strict cafeteria scoping
  let scope;
  try {
    scope = resolveCafeteriaScope(req);
  } catch (err) {
    res.status(err.statusCode || HTTP_STATUS.FORBIDDEN).json({ success: false, error: err.message });
    return true;
  }
  if (!issue.cafeteriaId || String(issue.cafeteriaId) !== String(scope.cafeteriaId)) {
    res.status(HTTP_STATUS.FORBIDDEN).json({
      success: false,
      error: 'This issue report belongs to another cafeteria',
    });
    return true;
  }
  return null;
}

// ---------------------------------------------------------------
// POST /api/v1/issues - Kitchen Staff creates an issue report
// ---------------------------------------------------------------
exports.createIssueReport = async (req, res) => {
  try {
    const { title, description, category, priority } = req.body || {};

    const trimmedTitle = String(title || '').trim();
    const trimmedDescription = String(description || '').trim();
    if (!trimmedTitle || !trimmedDescription) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Issue title and description are required',
      });
    }
    if (category && !ISSUE_CATEGORIES.includes(category)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Invalid issue category. Allowed: ${ISSUE_CATEGORIES.join(', ')}`,
      });
    }
    if (priority && !ISSUE_PRIORITIES.includes(priority)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Invalid priority. Allowed: ${ISSUE_PRIORITIES.join(', ')}`,
      });
    }

    // Security: reporter + cafeteria always come from the authenticated user.
    const reportedBy = req.user.id;
    const cafeteriaId = req.user.cafeteriaId || (await getDefaultCafeteriaId()) || null;

    // Duplicate submission guard (double-click / retry of the same open issue).
    const duplicate = await IssueReport.findOne({
      reportedBy,
      cafeteriaId,
      status: { $ne: ISSUE_REPORT_STATUS.RESOLVED },
      title: trimmedTitle,
      description: trimmedDescription,
      category: category || 'other',
    });
    if (duplicate) {
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: 'An identical open issue report already exists. Please wait for the manager response.',
      });
    }

    const issue = await IssueReport.create({
      title: trimmedTitle,
      description: trimmedDescription,
      category: category || 'other',
      priority: priority || 'medium',
      status: ISSUE_REPORT_STATUS.PENDING,
      reportedBy,
      cafeteriaId,
    });

    await logAction({
      req,
      action: 'ISSUE_REPORT_CREATED',
      entityType: 'IssueReport',
      entityId: String(issue._id),
      description: `${req.user.name || 'Kitchen staff'} reported issue "${trimmedTitle}"`,
      cafeteriaId,
    });

    // Notify the cafeteria's managers (persist -> MongoDB -> socket).
    const managers = await findCafeteriaManagers(cafeteriaId);
    const reporterName = req.user.name || 'Kitchen staff';
    for (const manager of managers) {
      await notifyUser(manager._id, {
        title: 'New Issue Report',
        message: `${reporterName} reported a new issue: "${trimmedTitle}"`,
        type: 'status_update',
        link: '/src/pages/manager/issues.html',
      });
    }

    // Real-time list refresh for managers (they join the "admin" room).
    try {
      emitSocketEvent('admin', 'issue:created', {
        id: issue._id,
        title: issue.title,
        category: issue.category,
        priority: issue.priority,
        status: issue.status,
        cafeteriaId: issue.cafeteriaId,
        reportedBy: { id: reportedBy, name: reporterName },
        createdAt: issue.createdAt,
      });
    } catch (e) {
      console.warn('Socket emit failed for issue:created:', e.message);
    }

    const populated = await issue.populate(POPULATE);
    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      message: 'Issue report submitted successfully',
      issue: serialize(populated),
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: Object.values(error.errors)
          .map((e) => e.message)
          .join('; '),
      });
    }
    console.error('❌ Create Issue Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// GET /api/v1/issues - role-scoped list
// ---------------------------------------------------------------
exports.listIssueReports = async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    const { status } = req.query;

    if (status && !Object.values(ISSUE_REPORT_STATUS).includes(status)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Invalid status. Allowed: ${Object.values(ISSUE_REPORT_STATUS).join(', ')}`,
      });
    }

    const filter = {};
    if (status) filter.status = status;

    if (KITCHEN_ROLES.includes(role)) {
      // Kitchen Staff: only their own submitted reports.
      filter.reportedBy = req.user.id;
    } else if (isAdminRole(role)) {
      // System Admin: system-wide monitoring (all cafeterias).
    } else if (MANAGER_ROLES.includes(role) || CAFETERIA_ADMIN_ROLES.includes(role)) {
      // Manager / Cafeteria Admin: only their assigned cafeteria.
      try {
        const scope = resolveCafeteriaScope(req);
        filter.cafeteriaId = scope.cafeteriaId;
      } catch (err) {
        return res.status(err.statusCode || HTTP_STATUS.FORBIDDEN).json({
          success: false,
          error: err.message,
        });
      }
    } else {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'Forbidden' });
    }

    const issues = await IssueReport.find(filter).populate(POPULATE).sort({ createdAt: -1 }).limit(500);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: issues.length,
      issues: issues.map(serialize),
    });
  } catch (error) {
    console.error('❌ List Issue Reports Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// GET /api/v1/issues/:id - issue details
// ---------------------------------------------------------------
exports.getIssueReport = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid issue report ID' });
    }

    const issue = await IssueReport.findById(id).populate(POPULATE);
    if (!issue) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Issue report not found' });
    }

    const denied = enforceCafeteriaAccess(req, res, issue);
    if (denied) return;

    res.status(HTTP_STATUS.OK).json({ success: true, issue: serialize(issue) });
  } catch (error) {
    console.error('❌ Get Issue Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// PATCH /api/v1/issues/:id/accept - Manager accepts (PENDING -> ACCEPTED)
// ---------------------------------------------------------------
exports.acceptIssueReport = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid issue report ID' });
    }

    const issue = await IssueReport.findById(id).populate(POPULATE);
    if (!issue) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Issue report not found' });
    }

    const denied = enforceCafeteriaAccess(req, res, issue);
    if (denied) return;

    // Nobody may accept their own report.
    if (String(issue.reportedBy?._id || issue.reportedBy) === String(req.user.id)) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'You cannot accept your own issue report',
      });
    }

    if (issue.status === ISSUE_REPORT_STATUS.ACCEPTED) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'This issue report has already been accepted',
      });
    }
    if (issue.status === ISSUE_REPORT_STATUS.RESOLVED) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'This issue report is already resolved and can no longer be accepted',
      });
    }

    // Security: manager identity comes from the authenticated JWT only.
    issue.status = ISSUE_REPORT_STATUS.ACCEPTED;
    issue.acceptedBy = req.user.id;
    issue.acceptedAt = new Date();
    await issue.save();

    await logAction({
      req,
      action: 'ISSUE_REPORT_ACCEPTED',
      entityType: 'IssueReport',
      entityId: String(issue._id),
      description: `${req.user.name || 'Manager'} accepted issue "${issue.title}"`,
      cafeteriaId: issue.cafeteriaId,
    });

    // Notify the reporting Kitchen Staff.
    await notifyUser(String(issue.reportedBy?._id || issue.reportedBy), {
      title: 'Issue Report Accepted',
      message: `Your issue "${issue.title}" has been accepted by ${req.user.name || 'the cafeteria manager'}.`,
      type: 'status_update',
      link: '/src/pages/kitchen/issues.html',
    });

    // Real-time refresh for kitchen staff (they join the "kitchen" room).
    try {
      emitSocketEvent('kitchen', 'issue:updated', {
        id: issue._id,
        status: issue.status,
        cafeteriaId: issue.cafeteriaId,
      });
    } catch (e) {
      console.warn('Socket emit failed for issue:updated:', e.message);
    }

    const populated = await issue.populate(POPULATE);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Issue report accepted',
      issue: serialize(populated),
    });
  } catch (error) {
    console.error('❌ Accept Issue Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// PATCH /api/v1/issues/:id/solution - Manager sends solution
//              (ACCEPTED -> RESOLVED)
// ---------------------------------------------------------------
exports.sendIssueSolution = async (req, res) => {
  try {
    const { id } = req.params;
    const solution = String((req.body && req.body.solution) || '').trim();

    if (!solution) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Solution cannot be empty',
      });
    }
    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid issue report ID' });
    }

    const issue = await IssueReport.findById(id).populate(POPULATE);
    if (!issue) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Issue report not found' });
    }

    const denied = enforceCafeteriaAccess(req, res, issue);
    if (denied) return;

    if (issue.status === ISSUE_REPORT_STATUS.RESOLVED) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'This issue report is already resolved',
      });
    }
    if (issue.status === ISSUE_REPORT_STATUS.PENDING) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Accept the issue report before sending a solution',
      });
    }

    // Security: manager identity comes from the authenticated JWT only.
    const now = new Date();
    issue.solution = solution;
    issue.repliedBy = req.user.id;
    issue.repliedAt = now;
    issue.status = ISSUE_REPORT_STATUS.RESOLVED;
    issue.resolvedAt = now;
    await issue.save();

    await logAction({
      req,
      action: 'ISSUE_REPORT_RESOLVED',
      entityType: 'IssueReport',
      entityId: String(issue._id),
      description: `${req.user.name || 'Manager'} resolved issue "${issue.title}" with a solution`,
      cafeteriaId: issue.cafeteriaId,
    });

    // Notify the reporting Kitchen Staff that a solution was provided.
    await notifyUser(String(issue.reportedBy?._id || issue.reportedBy), {
      title: 'Solution Provided',
      message: `A solution has been provided for your issue "${issue.title}".`,
      type: 'status_update',
      link: '/src/pages/kitchen/issues.html',
    });

    try {
      emitSocketEvent('kitchen', 'issue:updated', {
        id: issue._id,
        status: issue.status,
        cafeteriaId: issue.cafeteriaId,
      });
    } catch (e) {
      console.warn('Socket emit failed for issue:updated:', e.message);
    }

    const populated = await issue.populate(POPULATE);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Solution sent and issue resolved',
      issue: serialize(populated),
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: Object.values(error.errors)
          .map((e) => e.message)
          .join('; '),
      });
    }
    console.error('❌ Send Issue Solution Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};
