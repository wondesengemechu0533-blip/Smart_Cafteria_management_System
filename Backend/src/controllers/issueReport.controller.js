const mongoose = require('mongoose');
const IssueReport = require('../models/IssueReport');
const ResolutionRequest = require('../models/ResolutionRequest');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');
const { normalizeRole, isAdminRole } = require('../config/roles');
const { resolveCafeteriaScope, getDefaultCafeteriaId } = require('../utils/cafeteria');
const { notifyUser, findCafeteriaManagers, findCafeteriaAdmins } = require('../utils/notification');
const { emitSocketEvent } = require('../utils/socket');
const { logAction } = require('../utils/audit');

const { ISSUE_REPORT_STATUS, ISSUE_CATEGORIES, ISSUE_PRIORITIES } = require('../models/IssueReport');
const { RESOLUTION_REQUEST_STATUS } = require('../models/ResolutionRequest');

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
    solution: issue.solution,
    resolutionReason: issue.resolutionReason || null,
    resolutionSolution: issue.resolutionSolution || null,
    resolutionQuantity: issue.resolutionQuantity ?? null,
    repliedBy: repliedBy && repliedBy._id ? { id: repliedBy._id, name: repliedBy.name } : issue.repliedBy,
    repliedAt: issue.repliedAt,
    resolvedAt: issue.resolvedAt,
    itemId: issue.itemId && issue.itemId._id ? issue.itemId._id : issue.itemId || null,
    itemName:
      issue.itemId && typeof issue.itemId === 'object' && issue.itemId.name
        ? issue.itemId.name.en || issue.itemId.name
        : undefined,
    itemCurrentQuantity:
      issue.itemId && typeof issue.itemId === 'object' && issue.itemId.stockQuantity !== undefined
        ? issue.itemId.stockQuantity
        : undefined,
    investigationNotes: issue.investigationNotes || null,
    investigatedBy:
      issue.investigatedBy && issue.investigatedBy._id
        ? { id: issue.investigatedBy._id, name: issue.investigatedBy.name }
        : issue.investigatedBy || null,
    investigatedAt: issue.investigatedAt || null,
    resolutionRequestId:
      issue.resolutionRequestId && issue.resolutionRequestId._id
        ? issue.resolutionRequestId._id
        : issue.resolutionRequestId || null,
    resolutionRequestStatus:
      issue.resolutionRequestId && typeof issue.resolutionRequestId === 'object' && issue.resolutionRequestId.status
        ? issue.resolutionRequestId.status
        : undefined,
    restockRequestId:
      issue.restockRequestId && issue.restockRequestId._id ? issue.restockRequestId._id : issue.restockRequestId || null,
    restockRequestStatus:
      issue.restockRequestId && typeof issue.restockRequestId === 'object' && issue.restockRequestId.status
        ? issue.restockRequestId.status
        : undefined,
    alertId: issue.alertId && issue.alertId._id ? issue.alertId._id : issue.alertId || null,
  };
}

const POPULATE = [
  { path: 'reportedBy', select: 'name role' },
  { path: 'repliedBy', select: 'name role' },
  { path: 'itemId', select: 'name stockQuantity lowStockThreshold availabilityStatus qualityHold' },
  { path: 'investigatedBy', select: 'name role' },
  { path: 'resolutionRequestId', select: 'status requestedAction acceptedAt resolvedAt rejectionReason' },
  { path: 'restockRequestId', select: 'status requestedQuantity receivedQuantity' },
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
    const { title, description, category, priority, itemId } = req.body || {};

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
      status: ISSUE_REPORT_STATUS.OPEN,
      reportedBy,
      cafeteriaId,
      itemId: isValidId(itemId) ? itemId : null,
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
// PATCH /api/v1/issues/:id/review - Manager reviews report
//              (OPEN -> UNDER_REVIEW). Sets investigation notes + timestamp.
// ---------------------------------------------------------------
exports.reviewIssueReport = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid issue report ID' });
    }

    const notes = String((req.body && (req.body.notes || req.body.investigationNotes)) || '').trim();
    const { itemId } = req.body || {};
    if (!notes && !itemId) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Provide investigation notes and/or the affected menu item',
      });
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
    if (issue.status !== ISSUE_REPORT_STATUS.OPEN) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'This issue report has already been reviewed',
      });
    }

    if (notes) {
      issue.investigationNotes = notes;
      issue.investigatedBy = req.user.id;
      issue.investigatedAt = new Date();
    }

    if (itemId !== undefined) {
      if (itemId === null || itemId === '') {
        issue.itemId = null;
      } else if (isValidId(itemId)) {
        const MenuItem = require('../models/MenuItem');
        const menuItem = await MenuItem.findById(itemId);
        if (!menuItem) {
          return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Menu item not found' });
        }
        issue.itemId = menuItem._id;
      } else {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid menu item id' });
      }
    }

    issue.status = ISSUE_REPORT_STATUS.UNDER_REVIEW;
    await issue.save();

    await logAction({
      req,
      action: 'ISSUE_REPORT_REVIEWED',
      entityType: 'IssueReport',
      entityId: String(issue._id),
      description: `${req.user.name || 'Manager'} reviewed issue "${issue.title}"`,
      cafeteriaId: issue.cafeteriaId,
    });

    // Notify the reporting Kitchen Staff.
    await notifyUser(String(issue.reportedBy?._id || issue.reportedBy), {
      title: 'Issue Report Under Review',
      message: `Your issue "${issue.title}" is now under review by ${req.user.name || 'the cafeteria manager'}.`,
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
      message: 'Issue report marked as under review',
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
    console.error('❌ Review Issue Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// PATCH /api/v1/issues/:id/investigate - Manager updates investigation
// notes / links the affected menu item. Does NOT change the report
// status (already UNDER_REVIEW) and does NOT touch inventory or stock
// alerts - the three records (IssueReport / RestockRequest / StockAlert)
// stay separate.
// ---------------------------------------------------------------
exports.investigateIssueReport = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid issue report ID' });
    }

    const notes = String((req.body && (req.body.notes || req.body.investigationNotes)) || '').trim();
    const { itemId } = req.body || {};
    if (!notes && !itemId) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Provide investigation notes and/or the affected menu item',
      });
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

    if (notes) {
      issue.investigationNotes = notes;
      issue.investigatedBy = req.user.id;
      issue.investigatedAt = new Date();
    }

    if (itemId !== undefined) {
      if (itemId === null || itemId === '') {
        issue.itemId = null;
      } else if (isValidId(itemId)) {
        const MenuItem = require('../models/MenuItem');
        const menuItem = await MenuItem.findById(itemId);
        if (!menuItem) {
          return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Menu item not found' });
        }
        issue.itemId = menuItem._id;
      } else {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid menu item id' });
      }
    }

    await issue.save();

    await logAction({
      req,
      action: 'ISSUE_REPORT_INVESTIGATED',
      entityType: 'IssueReport',
      entityId: String(issue._id),
      description: `${req.user.name || 'Manager'} recorded investigation notes for issue "${issue.title}"`,
      cafeteriaId: issue.cafeteriaId,
    });

    const populated = await issue.populate(POPULATE);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Investigation notes recorded',
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
    console.error('❌ Investigate Issue Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// PATCH /api/v1/issues/:id/request-admin - Manager submits a Resolution
// request to the Cafeteria Admin (UNDER_REVIEW -> REQUEST_SENT). Also
// creates a ResolutionRequest record (PENDING).
// ---------------------------------------------------------------
exports.sendAdminRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid issue report ID' });
    }

    const requestedAction = String((req.body && (req.body.requestedAction || req.body.action)) || '').trim();
    const itemId = req.body && req.body.itemId;
    if (!requestedAction) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Requested action is required',
      });
    }

    const issue = await IssueReport.findById(id).populate(POPULATE);
    if (!issue) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Issue report not found' });
    }

    const denied = enforceCafeteriaAccess(req, res, issue);
    if (denied) return;

    // Duplicate open-request guard (check BEFORE the status check so a
    // second attempt returns 409 rather than 400).
    const existing = await ResolutionRequest.findOne({
      issueReportId: issue._id,
      status: { $in: [RESOLUTION_REQUEST_STATUS.PENDING, RESOLUTION_REQUEST_STATUS.IN_PROGRESS] },
    });
    if (existing) {
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: 'An open resolution request already exists for this issue report',
      });
    }

    if (issue.status !== ISSUE_REPORT_STATUS.UNDER_REVIEW) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'You must review the issue report before sending a request to the admin',
      });
    }

    const resolutionRequestId = new mongoose.Types.ObjectId();
    const resolutionRequest = await ResolutionRequest.create({
      _id: resolutionRequestId,
      issueReportId: issue._id,
      cafeteriaId: issue.cafeteriaId,
      requestedBy: req.user.id,
      itemId: itemId !== undefined && itemId !== null && itemId !== '' && isValidId(itemId) ? itemId : issue.itemId || null,
      requestedAction,
      investigationNotes: issue.investigationNotes || null,
      status: RESOLUTION_REQUEST_STATUS.PENDING,
    });

    issue.status = ISSUE_REPORT_STATUS.REQUEST_SENT;
    issue.resolutionRequestId = resolutionRequestId;
    await issue.save();

    await logAction({
      req,
      action: 'ISSUE_REPORT_REQUEST_SENT',
      entityType: 'IssueReport',
      entityId: String(issue._id),
      description: `${req.user.name || 'Manager'} sent resolution request for issue "${issue.title}" to Cafeteria Admin`,
      cafeteriaId: issue.cafeteriaId,
    });

    // Notify the reporting Kitchen Staff.
    await notifyUser(String(issue.reportedBy?._id || issue.reportedBy), {
      title: 'Request Sent to Admin',
      message: `A resolution request for your issue "${issue.title}" has been sent to the Cafeteria Admin.`,
      type: 'status_update',
      link: '/src/pages/kitchen/issues.html',
    });

    // Notify the cafeteria's admins.
    const admins = await findCafeteriaAdmins(issue.cafeteriaId);
    const managerName = req.user.name || 'Manager';
    for (const admin of admins) {
      await notifyUser(admin._id, {
        title: 'New Resolution Request',
        message: `${managerName} submitted a resolution request for issue "${issue.title}": ${requestedAction}`,
        type: 'status_update',
        link: '/src/pages/admin/resolution-requests.html',
      });
    }

    // Real-time refresh for kitchen staff + admins.
    try {
      emitSocketEvent('kitchen', 'issue:updated', {
        id: issue._id,
        status: issue.status,
        cafeteriaId: issue.cafeteriaId,
      });
      emitSocketEvent('admin', 'resolution-request:created', {
        id: resolutionRequest._id,
        issueReportId: issue._id,
        title: issue.title,
        requestedAction,
        status: resolutionRequest.status,
        cafeteriaId: issue.cafeteriaId,
      });
    } catch (e) {
      console.warn('Socket emit failed for resolution request:', e.message);
    }

    const populated = await issue.populate(POPULATE);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Resolution request sent to Cafeteria Admin',
      issue: serialize(populated),
      request: {
        id: resolutionRequest._id,
        status: resolutionRequest.status,
        requestedAction: resolutionRequest.requestedAction,
        createdAt: resolutionRequest.createdAt,
      },
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
    console.error('❌ Send Admin Request Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// PATCH /api/v1/issues/:id/solution - Cafeteria Admin sends solution
//              (REQUEST_SENT -> RESOLVED). Managers get 403 at the route.
// ---------------------------------------------------------------
exports.sendIssueSolution = async (req, res) => {
  try {
    const { id } = req.params;
    const resolutionReason = String((req.body && (req.body.resolutionReason || req.body.reason)) || '').trim();
    const selected = String((req.body && (req.body.resolutionSolution || req.body.correctiveAction || req.body.solutionOption)) || '').trim();
    const resolutionSolution = selected || String((req.body && req.body.solution) || '').trim();
    const detailsRaw = String((req.body && (req.body.solutionDetails || req.body.resolutionNote || req.body.resolutionDetails || req.body.details)) || '').trim();
    const legacyDetails = (req.body && req.body.resolutionSolution && req.body.solution) ? String(req.body.solution).trim() : '';
    const details = detailsRaw || legacyDetails;
    const rawQty = (req.body && (req.body.newStockQuantity ?? req.body.newQuantity ?? req.body.stockQuantity ?? req.body.updatedStockQuantity));

    if (!resolutionReason || !resolutionSolution) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Resolution reason and solution are required',
      });
    }
    if ((resolutionReason === 'Other' || resolutionSolution === 'Other') && !details) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Please explain the selected Other option',
      });
    }
    let resolvedQty = null;
    const hasQty = rawQty !== undefined && rawQty !== null && String(rawQty).trim() !== '';
    if (hasQty) {
      const q = Number(rawQty);
      if (!Number.isInteger(q) || q < 0) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Stock quantity must be a non-negative integer' });
      }
      resolvedQty = q;
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
    if (issue.status === ISSUE_REPORT_STATUS.OPEN) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Review the issue report before sending a solution',
      });
    }

    // Security: admin identity comes from the authenticated JWT only.
    const now = new Date();
    issue.solution = details || resolutionSolution || null;
    issue.resolutionReason = resolutionReason || null;
    issue.resolutionSolution = resolutionSolution || null;
    issue.resolutionQuantity = resolvedQty;
    issue.repliedBy = req.user.id;
    issue.repliedAt = now;
    issue.status = ISSUE_REPORT_STATUS.RESOLVED;
    issue.resolvedAt = now;
    await issue.save();

    // If there's an open ResolutionRequest, mark it resolved too.
    if (issue.resolutionRequestId) {
      const request = await ResolutionRequest.findById(issue.resolutionRequestId);
      if (request && [RESOLUTION_REQUEST_STATUS.PENDING, RESOLUTION_REQUEST_STATUS.IN_PROGRESS].includes(request.status)) {
        request.status = RESOLUTION_REQUEST_STATUS.RESOLVED;
        request.resolvedBy = req.user.id;
        request.resolvedAt = now;
        request.resolutionNote = details || resolutionSolution || null;
        await request.save();

        // Notify the requesting manager.
        await notifyUser(String(request.requestedBy?._id || request.requestedBy), {
          title: 'Resolution Request Resolved',
          message: `Your resolution request for issue "${issue.title}" has been resolved by ${req.user.name || 'the Cafeteria Admin'}.`,
          type: 'status_update',
          link: '/src/pages/manager/issues.html',
        });
      }
    }

    await logAction({
      req,
      action: 'ISSUE_REPORT_RESOLVED',
      entityType: 'IssueReport',
      entityId: String(issue._id),
      description: `${req.user.name || 'Cafeteria Admin'} resolved issue "${issue.title}" with a solution`,
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
