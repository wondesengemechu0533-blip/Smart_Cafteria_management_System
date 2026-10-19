const mongoose = require('mongoose');
const ResolutionRequest = require('../models/ResolutionRequest');
const IssueReport = require('../models/IssueReport');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');
const { normalizeRole, isAdminRole } = require('../config/roles');
const { resolveCafeteriaScope } = require('../utils/cafeteria');
const { notifyUser } = require('../utils/notification');
const { emitSocketEvent } = require('../utils/socket');
const { logAction } = require('../utils/audit');

const { RESOLUTION_REQUEST_STATUS } = require('../models/ResolutionRequest');
const { ISSUE_REPORT_STATUS } = require('../models/IssueReport');

const MANAGER_ROLES = ['manager'];
const CAFETERIA_ADMIN_ROLES = ['cafeteria_admin'];

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

function serialize(request) {
  const requestedBy = request.requestedBy;
  const acceptedBy = request.acceptedBy;
  const rejectedBy = request.rejectedBy;
  const resolvedBy = request.resolvedBy;
  return {
    id: request._id,
    issueReportId:
      request.issueReportId && request.issueReportId._id ? request.issueReportId._id : request.issueReportId,
    issueTitle:
      request.issueReportId && typeof request.issueReportId === 'object' && request.issueReportId.title
        ? request.issueReportId.title
        : undefined,
    cafeteriaId: request.cafeteriaId,
    requestedBy: requestedBy && requestedBy._id ? { id: requestedBy._id, name: requestedBy.name } : requestedBy,
    itemId: request.itemId && request.itemId._id ? request.itemId._id : request.itemId || null,
    itemName:
      request.itemId && typeof request.itemId === 'object' && request.itemId.name
        ? request.itemId.name.en || request.itemId.name
        : undefined,
    requestedAction: request.requestedAction,
    investigationNotes: request.investigationNotes || null,
    status: request.status,
    acceptedBy: acceptedBy && acceptedBy._id ? { id: acceptedBy._id, name: acceptedBy.name } : acceptedBy || null,
    acceptedAt: request.acceptedAt || null,
    rejectedBy: rejectedBy && rejectedBy._id ? { id: rejectedBy._id, name: rejectedBy.name } : rejectedBy || null,
    rejectedAt: request.rejectedAt || null,
    rejectionReason: request.rejectionReason || null,
    resolvedBy: resolvedBy && resolvedBy._id ? { id: resolvedBy._id, name: resolvedBy.name } : resolvedBy || null,
    resolvedAt: request.resolvedAt || null,
    resolutionNote: request.resolutionNote || null,
    restockRequestId:
      request.restockRequestId && request.restockRequestId._id ? request.restockRequestId._id : request.restockRequestId || null,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

const POPULATE = [
  { path: 'issueReportId', select: 'title description status priority' },
  { path: 'requestedBy', select: 'name role' },
  { path: 'itemId', select: 'name stockQuantity' },
  { path: 'acceptedBy', select: 'name role' },
  { path: 'rejectedBy', select: 'name role' },
  { path: 'resolvedBy', select: 'name role' },
];

function enforceCafeteriaAccess(req, res, request) {
  const role = normalizeRole(req.user.role);
  if (isAdminRole(role)) return null;

  let scope;
  try {
    scope = resolveCafeteriaScope(req);
  } catch (err) {
    res.status(err.statusCode || HTTP_STATUS.FORBIDDEN).json({ success: false, error: err.message });
    return true;
  }
  if (!request.cafeteriaId || String(request.cafeteriaId) !== String(scope.cafeteriaId)) {
    res.status(HTTP_STATUS.FORBIDDEN).json({
      success: false,
      error: 'This request belongs to another cafeteria',
    });
    return true;
  }
  return null;
}

// ---------------------------------------------------------------
// GET /api/v1/resolution-requests - role-scoped list
// ---------------------------------------------------------------
exports.listResolutionRequests = async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    const { status, issueReportId } = req.query;

    if (status && !Object.values(RESOLUTION_REQUEST_STATUS).includes(status)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Invalid status. Allowed: ${Object.values(RESOLUTION_REQUEST_STATUS).join(', ')}`,
      });
    }

    const filter = {};
    if (status) filter.status = status;
    if (issueReportId && isValidId(issueReportId)) filter.issueReportId = issueReportId;

    if (MANAGER_ROLES.includes(role)) {
      // Manager: only their cafeteria's requests.
      try {
        const scope = resolveCafeteriaScope(req);
        filter.cafeteriaId = scope.cafeteriaId;
      } catch (err) {
        return res.status(err.statusCode || HTTP_STATUS.FORBIDDEN).json({ success: false, error: err.message });
      }
    } else if (CAFETERIA_ADMIN_ROLES.includes(role) || isAdminRole(role)) {
      // Cafeteria Admin / System Admin: cafeteria-scoped (or system-wide for system admin).
      if (!isAdminRole(role)) {
        try {
          const scope = resolveCafeteriaScope(req);
          filter.cafeteriaId = scope.cafeteriaId;
        } catch (err) {
          return res.status(err.statusCode || HTTP_STATUS.FORBIDDEN).json({ success: false, error: err.message });
        }
      }
    } else {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'Forbidden' });
    }

    const requests = await ResolutionRequest.find(filter).populate(POPULATE).sort({ createdAt: -1 }).limit(500);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: requests.length,
      requests: requests.map(serialize),
    });
  } catch (error) {
    console.error('❌ List Resolution Requests Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// GET /api/v1/resolution-requests/:id - request details
// ---------------------------------------------------------------
exports.getResolutionRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid request ID' });
    }

    const request = await ResolutionRequest.findById(id).populate(POPULATE);
    if (!request) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Resolution request not found' });
    }

    const denied = enforceCafeteriaAccess(req, res, request);
    if (denied) return;

    res.status(HTTP_STATUS.OK).json({ success: true, request: serialize(request) });
  } catch (error) {
    console.error('❌ Get Resolution Request Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// PATCH /api/v1/resolution-requests/:id/accept - Cafeteria Admin accepts
//              (PENDING -> IN_PROGRESS).
// ---------------------------------------------------------------
exports.acceptResolutionRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid request ID' });
    }

    const note = String((req.body && (req.body.note || req.body.adminNote)) || '').trim();

    const request = await ResolutionRequest.findById(id).populate(POPULATE);
    if (!request) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Resolution request not found' });
    }

    const denied = enforceCafeteriaAccess(req, res, request);
    if (denied) return;

    if (request.status !== RESOLUTION_REQUEST_STATUS.PENDING) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Only PENDING requests can be accepted. Current status: ${request.status}`,
      });
    }

    request.status = RESOLUTION_REQUEST_STATUS.IN_PROGRESS;
    request.acceptedBy = req.user.id;
    request.acceptedAt = new Date();
    await request.save();

    await logAction({
      req,
      action: 'RESOLUTION_REQUEST_ACCEPTED',
      entityType: 'ResolutionRequest',
      entityId: String(request._id),
      description: `${req.user.name || 'Cafeteria Admin'} accepted resolution request for issue "${request.issueReportId?.title || request.issueReportId}"`,
      cafeteriaId: request.cafeteriaId,
    });

    // Notify the requesting manager.
    await notifyUser(String(request.requestedBy?._id || request.requestedBy), {
      title: 'Resolution Request Accepted',
      message: `Your resolution request for issue "${request.issueReportId?.title || 'an issue'}" has been accepted by ${req.user.name || 'the Cafeteria Admin'}.`,
      type: 'status_update',
      link: '/src/pages/manager/issues.html',
    });

    try {
      emitSocketEvent('admin', 'resolution-request:updated', {
        id: request._id,
        status: request.status,
        cafeteriaId: request.cafeteriaId,
      });
    } catch (e) {
      console.warn('Socket emit failed for resolution-request:updated:', e.message);
    }

    const populated = await request.populate(POPULATE);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Resolution request accepted and is now in progress',
      request: serialize(populated),
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
    console.error('❌ Accept Resolution Request Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// PATCH /api/v1/resolution-requests/:id/reject - Cafeteria Admin rejects
//              (PENDING -> REJECTED) with a required reason.
// ---------------------------------------------------------------
exports.rejectResolutionRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid request ID' });
    }

    const reason = String((req.body && (req.body.reason || req.body.rejectionReason)) || '').trim();
    if (!reason) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Rejection reason is required',
      });
    }

    const request = await ResolutionRequest.findById(id).populate(POPULATE);
    if (!request) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Resolution request not found' });
    }

    const denied = enforceCafeteriaAccess(req, res, request);
    if (denied) return;

    if (request.status !== RESOLUTION_REQUEST_STATUS.PENDING) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Only PENDING requests can be rejected. Current status: ${request.status}`,
      });
    }

    request.status = RESOLUTION_REQUEST_STATUS.REJECTED;
    request.rejectedBy = req.user.id;
    request.rejectedAt = new Date();
    request.rejectionReason = reason;
    await request.save();

    // Return the linked IssueReport to UNDER_REVIEW so the manager can
    // revise and resubmit.
    if (request.issueReportId) {
      const issue = await IssueReport.findById(request.issueReportId);
      if (issue && issue.status === ISSUE_REPORT_STATUS.REQUEST_SENT) {
        issue.status = ISSUE_REPORT_STATUS.UNDER_REVIEW;
        issue.resolutionRequestId = null;
        await issue.save();
      }
    }

    await logAction({
      req,
      action: 'RESOLUTION_REQUEST_REJECTED',
      entityType: 'ResolutionRequest',
      entityId: String(request._id),
      description: `${req.user.name || 'Cafeteria Admin'} rejected resolution request: ${reason}`,
      cafeteriaId: request.cafeteriaId,
    });

    // Notify the requesting manager.
    await notifyUser(String(request.requestedBy?._id || request.requestedBy), {
      title: 'Resolution Request Rejected',
      message: `Your resolution request for issue "${request.issueReportId?.title || 'an issue'}" was rejected: ${reason}`,
      type: 'status_update',
      link: '/src/pages/manager/issues.html',
    });

    try {
      emitSocketEvent('admin', 'resolution-request:updated', {
        id: request._id,
        status: request.status,
        cafeteriaId: request.cafeteriaId,
      });
    } catch (e) {
      console.warn('Socket emit failed for resolution-request:updated:', e.message);
    }

    const populated = await request.populate(POPULATE);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Resolution request rejected',
      request: serialize(populated),
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
    console.error('❌ Reject Resolution Request Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// PATCH /api/v1/resolution-requests/:id/resolve - Cafeteria Admin resolves
//              (IN_PROGRESS -> RESOLVED). Also marks the linked IssueReport
//              as RESOLVED.
// ---------------------------------------------------------------
exports.resolveResolutionRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid request ID' });
    }

    const note = String((req.body && (req.body.note || req.body.resolutionNote)) || '').trim();

    const request = await ResolutionRequest.findById(id).populate(POPULATE);
    if (!request) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Resolution request not found' });
    }

    const denied = enforceCafeteriaAccess(req, res, request);
    if (denied) return;

    if (request.status !== RESOLUTION_REQUEST_STATUS.IN_PROGRESS) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Only IN_PROGRESS requests can be resolved. Current status: ${request.status}`,
      });
    }

    const now = new Date();
    request.status = RESOLUTION_REQUEST_STATUS.RESOLVED;
    request.resolvedBy = req.user.id;
    request.resolvedAt = now;
    request.resolutionNote = note || null;
    await request.save();

    // Mark the linked IssueReport as RESOLVED.
    let issue = null;
    if (request.issueReportId) {
      issue = await IssueReport.findById(request.issueReportId);
      if (issue && issue.status !== ISSUE_REPORT_STATUS.RESOLVED) {
        issue.status = ISSUE_REPORT_STATUS.RESOLVED;
        issue.solution = note || null;
        issue.repliedBy = req.user.id;
        issue.repliedAt = now;
        issue.resolvedAt = now;
        await issue.save();
      }
    }

    await logAction({
      req,
      action: 'RESOLUTION_REQUEST_RESOLVED',
      entityType: 'ResolutionRequest',
      entityId: String(request._id),
      description: `${req.user.name || 'Cafeteria Admin'} resolved resolution request${note ? `: ${note}` : ''}`,
      cafeteriaId: request.cafeteriaId,
    });

    // Notify the requesting manager.
    await notifyUser(String(request.requestedBy?._id || request.requestedBy), {
      title: 'Resolution Request Resolved',
      message: `Your resolution request for issue "${issue?.title || 'an issue'}" has been resolved by ${req.user.name || 'the Cafeteria Admin'}.`,
      type: 'status_update',
      link: '/src/pages/manager/issues.html',
    });

    // Notify the reporting Kitchen Staff.
    if (issue) {
      await notifyUser(String(issue.reportedBy?._id || issue.reportedBy), {
        title: 'Issue Resolved',
        message: `Your issue "${issue.title}" has been resolved by the Cafeteria Admin.`,
        type: 'status_update',
        link: '/src/pages/kitchen/issues.html',
      });
    }

    try {
      emitSocketEvent('admin', 'resolution-request:updated', {
        id: request._id,
        status: request.status,
        cafeteriaId: request.cafeteriaId,
      });
      if (issue) {
        emitSocketEvent('kitchen', 'issue:updated', {
          id: issue._id,
          status: issue.status,
          cafeteriaId: issue.cafeteriaId,
        });
      }
    } catch (e) {
      console.warn('Socket emit failed for resolution-request:updated:', e.message);
    }

    const populated = await request.populate(POPULATE);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Resolution request resolved and issue marked as resolved',
      request: serialize(populated),
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
    console.error('❌ Resolve Resolution Request Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// PATCH /api/v1/resolution-requests/:id/cancel - Manager cancels while
//              PENDING. Linked IssueReport returns to UNDER_REVIEW.
// ---------------------------------------------------------------
exports.cancelResolutionRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid request ID' });
    }

    const request = await ResolutionRequest.findById(id).populate(POPULATE);
    if (!request) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Resolution request not found' });
    }

    const denied = enforceCafeteriaAccess(req, res, request);
    if (denied) return;

    // Only the requesting manager can cancel, and only while PENDING.
    if (String(request.requestedBy?._id || request.requestedBy) !== String(req.user.id)) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'Only the requesting manager can cancel this request',
      });
    }
    if (request.status !== RESOLUTION_REQUEST_STATUS.PENDING) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Only PENDING requests can be cancelled. Current status: ${request.status}`,
      });
    }

    // Mark as REJECTED (cancel = manager withdrawal).
    request.status = RESOLUTION_REQUEST_STATUS.REJECTED;
    request.rejectedBy = req.user.id;
    request.rejectedAt = new Date();
    request.rejectionReason = 'Cancelled by requesting manager';
    await request.save();

    // Return the linked IssueReport to UNDER_REVIEW.
    if (request.issueReportId) {
      const issue = await IssueReport.findById(request.issueReportId);
      if (issue && issue.status === ISSUE_REPORT_STATUS.REQUEST_SENT) {
        issue.status = ISSUE_REPORT_STATUS.UNDER_REVIEW;
        issue.resolutionRequestId = null;
        await issue.save();
      }
    }

    await logAction({
      req,
      action: 'RESOLUTION_REQUEST_CANCELLED',
      entityType: 'ResolutionRequest',
      entityId: String(request._id),
      description: `${req.user.name || 'Manager'} cancelled resolution request`,
      cafeteriaId: request.cafeteriaId,
    });

    const populated = await request.populate(POPULATE);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Resolution request cancelled',
      request: serialize(populated),
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
    console.error('❌ Cancel Resolution Request Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};
