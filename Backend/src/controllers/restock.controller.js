const mongoose = require('mongoose');
const RestockRequest = require('../models/RestockRequest');
const MenuItem = require('../models/MenuItem');
const IssueReport = require('../models/IssueReport');
const { RESTOCK_STATUS } = require('../models/RestockRequest');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');
const { normalizeRole, isAdminRole } = require('../config/roles');
const { resolveCafeteriaScope, cafeteriaFilter } = require('../utils/cafeteria');
const { notifyUser, findCafeteriaAdmins, findCafeteriaManagers } = require('../utils/notification');
const { emitSocketEvent } = require('../utils/socket');
const { logAction } = require('../utils/audit');
const { applyStockDelta, syncStockAlertsForItem } = require('../services/stock-alert.service');

/**
 * Restock request workflow (Manager → Cafeteria Admin).
 *
 * Manager  : POST   /restocks            submit a replenishment request
 *            GET    /restocks            monitor request status
 *            POST   /restocks/:id/cancel cancel a PENDING request
 * Admin    : GET    /restocks            review incoming requests
 *            PATCH  /restocks/:id/review approve / reject with explanation
 *            PATCH  /restocks/:id/restock record the ACTUAL received quantity
 *
 * Stock quantity is ONLY changed by the last endpoint, using an atomic $inc
 * against the latest database value, and is always paired with a
 * StockTransaction audit record.
 */

const MANAGER_ROLES = ['manager', 'cafeteria_manager'];
const ADMIN_ROLES = ['cafeteria_admin', 'admin', 'system_admin'];

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

function serialize(request, extras) {
  const base = {
    id: request._id,
    itemId: request.itemId && request.itemId._id ? request.itemId._id : request.itemId,
    itemName: request.itemName,
    currentQuantity: request.currentQuantity,
    requestedQuantity: request.requestedQuantity,
    reason: request.reason,
    requestedBy:
      request.requestedBy && request.requestedBy._id
        ? { id: request.requestedBy._id, name: request.requestedBy.name }
        : request.requestedBy,
    status: request.status,
    reviewedBy:
      request.reviewedBy && request.reviewedBy._id
        ? { id: request.reviewedBy._id, name: request.reviewedBy.name }
        : request.reviewedBy,
    reviewedAt: request.reviewedAt,
    reviewNote: request.reviewNote || null,
    receivedQuantity: request.receivedQuantity,
    restockedBy:
      request.restockedBy && request.restockedBy._id
        ? { id: request.restockedBy._id, name: request.restockedBy.name }
        : request.restockedBy,
    restockedAt: request.restockedAt,
    restockNote: request.restockNote || null,
    alertId: request.alertId && request.alertId._id ? request.alertId._id : request.alertId || null,
    issueReportId:
      request.issueReportId && request.issueReportId._id ? request.issueReportId._id : request.issueReportId || null,
    // Linked issue report summary so dashboards can show WHICH report
    // triggered the request without a second lookup. Only present when the
    // field was populated (see POPULATE below).
    issueReport:
      request.issueReportId && request.issueReportId._id
        ? {
            id: request.issueReportId._id,
            title: request.issueReportId.title || null,
            status: request.issueReportId.status || null,
          }
        : null,
    cafeteriaId: request.cafeteriaId,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    // Live item state when available (item may have changed since submission)
    itemCurrentQuantity:
      request.itemId && typeof request.itemId === 'object' && request.itemId.stockQuantity !== undefined
        ? request.itemId.stockQuantity
        : undefined,
    itemLowStockThreshold:
      request.itemId && typeof request.itemId === 'object' && request.itemId.lowStockThreshold !== undefined
        ? request.itemId.lowStockThreshold
        : undefined,
  };
  return Object.assign(base, extras || {});
}

const POPULATE = [
  { path: 'requestedBy', select: 'name role' },
  { path: 'reviewedBy', select: 'name role' },
  { path: 'restockedBy', select: 'name role' },
  { path: 'itemId', select: 'name stockQuantity lowStockThreshold availabilityStatus qualityHold cafeteriaId' },
  { path: 'issueReportId', select: 'title status' },
];

function emitRestockEvent(eventName, payload) {
  try {
    emitSocketEvent('admin', eventName, payload);
    emitSocketEvent('kitchen', eventName, payload);
  } catch (e) {
    // socket fan-out is best-effort
  }
}

// ---------------------------------------------------------------
// POST /api/v1/restocks - Manager submits a restock request
// ---------------------------------------------------------------
exports.submitRestockRequest = async (req, res) => {
  try {
    const { itemId, requestedQuantity, reason, alertId, issueReportId } = req.body || {};

    if (!isValidId(itemId)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'A valid menu item id is required' });
    }
    const qty = Number(requestedQuantity);
    if (!Number.isInteger(qty) || qty < 1) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Requested quantity must be a whole number of at least 1',
      });
    }
    const trimmedReason = String(reason || '').trim();
    if (!trimmedReason) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'A reason for the restock request is required' });
    }

    let scope;
    try {
      scope = resolveCafeteriaScope(req);
    } catch (err) {
      return res.status(err.statusCode || HTTP_STATUS.FORBIDDEN).json({ success: false, error: err.message });
    }

    const item = await MenuItem.findById(itemId);
    if (!item) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Menu item not found' });
    }
    if (!scope.global && item.cafeteriaId && String(item.cafeteriaId) !== String(scope.cafeteriaId)) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'This menu item belongs to another cafeteria',
      });
    }

    // Duplicate submission guard (double-click / retry): one open request per item.
    const duplicate = await RestockRequest.findOne({
      itemId: item._id,
      status: { $in: [RESTOCK_STATUS.PENDING, RESTOCK_STATUS.APPROVED] },
    });
    if (duplicate) {
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: `An open ${duplicate.status.toLowerCase()} restock request already exists for this item`,
        request: serialize(duplicate),
      });
    }

    let request;
    try {
      request = await RestockRequest.create({
        itemId: item._id,
        itemName: item.name && item.name.en ? item.name.en : String(item._id),
        currentQuantity: Math.max(0, Number(item.stockQuantity) || 0),
        requestedQuantity: qty,
        reason: trimmedReason,
        requestedBy: req.user.id,
        status: RESTOCK_STATUS.PENDING,
        alertId: isValidId(alertId) ? alertId : null,
        issueReportId: isValidId(issueReportId) ? issueReportId : null,
        cafeteriaId: item.cafeteriaId || scope.cafeteriaId || null,
      });
    } catch (e) {
      if (e && e.code === 11000) {
        return res.status(HTTP_STATUS.CONFLICT).json({
          success: false,
          error: 'An open restock request already exists for this item (possible double submission)',
        });
      }
      throw e;
    }

    // Back-link on the triggering issue report (traceability only - the
    // issue report's own lifecycle is untouched).
    if (request.issueReportId) {
      try {
        await IssueReport.updateOne({ _id: request.issueReportId }, { $set: { restockRequestId: request._id } });
      } catch (e) {
        // non-fatal
      }
    }

    await logAction({
      req,
      action: 'RESTOCK_REQUEST_SUBMITTED',
      entityType: 'RestockRequest',
      entityId: String(request._id),
      description: `${req.user.name || 'Manager'} requested restock of ${request.itemName} (current ${request.currentQuantity}, requested ${request.requestedQuantity})`,
      cafeteriaId: request.cafeteriaId,
      metadata: {
        itemId: String(item._id),
        currentQuantity: request.currentQuantity,
        requestedQuantity: request.requestedQuantity,
        issueReportId: request.issueReportId ? String(request.issueReportId) : null,
        alertId: request.alertId ? String(request.alertId) : null,
      },
    });

    // Notify the Cafeteria Admins of this cafeteria (only after the DB write
    // succeeded).
    const admins = await findCafeteriaAdmins(request.cafeteriaId);
    const managerName = req.user.name || 'Cafeteria Manager';
    await Promise.allSettled(
      admins.map((admin) =>
        notifyUser(admin._id, {
          title: 'New Restock Request',
          message: `${managerName} requested ${request.requestedQuantity} units of ${request.itemName} (current stock: ${request.currentQuantity}).`,
          type: 'stock_alert',
          link: '/src/pages/admin/menu.html',
        })
      )
    );

    emitRestockEvent('restock:request', {
      requestId: request._id,
      itemId: request.itemId,
      itemName: request.itemName,
      status: request.status,
      cafeteriaId: request.cafeteriaId,
      createdAt: request.createdAt,
    });

    const populated = await request.populate(POPULATE);
    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      message: 'Restock request submitted. The cafeteria admin has been notified.',
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
    console.error('❌ Submit Restock Request Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// GET /api/v1/restocks - role-scoped list
// ---------------------------------------------------------------
exports.listRestockRequests = async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    const { status, itemId } = req.query;

    if (status && !Object.values(RESTOCK_STATUS).includes(status)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Invalid status. Allowed: ${Object.values(RESTOCK_STATUS).join(', ')}`,
      });
    }

    const filter = {};
    if (status) filter.status = status;
    if (itemId && isValidId(itemId)) filter.itemId = itemId;

    if (isAdminRole(role)) {
      // system admin: system-wide
    } else if (MANAGER_ROLES.includes(role) || ADMIN_ROLES.includes(role)) {
      try {
        Object.assign(filter, cafeteriaFilter(resolveCafeteriaScope(req)));
      } catch (err) {
        return res.status(err.statusCode || HTTP_STATUS.FORBIDDEN).json({ success: false, error: err.message });
      }
    } else {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'Forbidden' });
    }

    const requests = await RestockRequest.find(filter).populate(POPULATE).sort({ createdAt: -1 }).limit(500);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: requests.length,
      requests: requests.map((r) => serialize(r)),
    });
  } catch (error) {
    console.error('❌ List Restock Requests Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// GET /api/v1/restocks/:id
// ---------------------------------------------------------------
exports.getRestockRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid restock request id' });
    }
    const request = await RestockRequest.findById(id).populate(POPULATE);
    if (!request) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Restock request not found' });
    }

    const role = normalizeRole(req.user.role);
    if (!isAdminRole(role)) {
      try {
        const scope = resolveCafeteriaScope(req);
        if (request.cafeteriaId && String(request.cafeteriaId) !== String(scope.cafeteriaId)) {
          return res.status(HTTP_STATUS.FORBIDDEN).json({
            success: false,
            error: 'This restock request belongs to another cafeteria',
          });
        }
      } catch (err) {
        return res.status(err.statusCode || HTTP_STATUS.FORBIDDEN).json({ success: false, error: err.message });
      }
    }

    res.status(HTTP_STATUS.OK).json({ success: true, request: serialize(request) });
  } catch (error) {
    console.error('❌ Get Restock Request Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// POST /api/v1/restocks/:id/cancel - requesting manager cancels (PENDING only)
// ---------------------------------------------------------------
exports.cancelRestockRequest = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid restock request id' });
    }

    const request = await RestockRequest.findById(id).populate(POPULATE);
    if (!request) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Restock request not found' });
    }

    // Only the requesting manager (or a system admin) may cancel, and only
    // while it is still PENDING (an approved request is already being worked).
    if (!isAdminRole(normalizeRole(req.user.role)) && String(request.requestedBy?._id || request.requestedBy) !== String(req.user.id)) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'Only the requesting manager can cancel this restock request',
      });
    }
    if (request.status !== RESTOCK_STATUS.PENDING) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Only PENDING requests can be cancelled (this one is ${request.status})`,
      });
    }

    const updated = await RestockRequest.findOneAndUpdate(
      { _id: request._id, status: RESTOCK_STATUS.PENDING },
      { $set: { status: RESTOCK_STATUS.CANCELLED } },
      { new: true }
    );
    if (!updated) {
      return res.status(HTTP_STATUS.CONFLICT).json({ success: false, error: 'Request status changed; please refresh' });
    }

    await logAction({
      req,
      action: 'RESTOCK_REQUEST_CANCELLED',
      entityType: 'RestockRequest',
      entityId: String(request._id),
      description: `${req.user.name || 'Manager'} cancelled the restock request for ${request.itemName}`,
      cafeteriaId: request.cafeteriaId,
    });

    emitRestockEvent('restock:updated', {
      requestId: request._id,
      itemId: request.itemId,
      itemName: request.itemName,
      status: RESTOCK_STATUS.CANCELLED,
      cafeteriaId: request.cafeteriaId,
    });

    const populated = await updated.populate(POPULATE);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Restock request cancelled',
      request: serialize(populated),
    });
  } catch (error) {
    console.error('❌ Cancel Restock Request Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// PATCH /api/v1/restocks/:id/review - Cafeteria Admin approves / rejects
// ---------------------------------------------------------------
exports.reviewRestockRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const decision = String((req.body && (req.body.decision || req.body.status)) || '').toUpperCase();
    const explanation = String((req.body && (req.body.explanation || req.body.reviewNote || req.body.note)) || '').trim();

    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid restock request id' });
    }
    if (decision !== RESTOCK_STATUS.APPROVED && decision !== RESTOCK_STATUS.REJECTED) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Decision must be APPROVED or REJECTED`,
      });
    }
    if (decision === RESTOCK_STATUS.REJECTED && !explanation) {
      // A rejection must tell the requesting manager why their request was
      // turned down; an empty rejection is not actionable for them.
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'An explanation is required when rejecting a restock request',
      });
    }

    // Atomic PENDING → APPROVED/REJECTED transition: a second concurrent
    // review gets null and cannot overwrite the first decision.
    const updated = await RestockRequest.findOneAndUpdate(
      { _id: id, status: RESTOCK_STATUS.PENDING },
      {
        $set: {
          status: decision,
          reviewedBy: req.user.id,
          reviewedAt: new Date(),
          reviewNote: explanation || null,
        },
      },
      { new: true }
    );
    if (!updated) {
      const existing = await RestockRequest.findById(id);
      if (!existing) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Restock request not found' });
      }
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: `This request has already been ${existing.status.toLowerCase()} and can no longer be reviewed`,
      });
    }

    await logAction({
      req,
      action: decision === RESTOCK_STATUS.APPROVED ? 'RESTOCK_REQUEST_APPROVED' : 'RESTOCK_REQUEST_REJECTED',
      entityType: 'RestockRequest',
      entityId: String(updated._id),
      description: `${req.user.name || 'Admin'} ${decision.toLowerCase()} the restock request for ${updated.itemName}${explanation ? `: ${explanation}` : ''}`,
      cafeteriaId: updated.cafeteriaId,
      metadata: { itemId: String(updated.itemId), requestedQuantity: updated.requestedQuantity },
    });

    // Notify the requesting manager (only after the DB write succeeded).
    await notifyUser(updated.requestedBy, {
      title: decision === RESTOCK_STATUS.APPROVED ? 'Restock Request Approved' : 'Restock Request Rejected',
      message:
        decision === RESTOCK_STATUS.APPROVED
          ? `Your request for ${updated.requestedQuantity} units of ${updated.itemName} was approved.${explanation ? ` Note: ${explanation}` : ''}`
          : `Your restock request for ${updated.itemName} was rejected.${explanation ? ` Reason: ${explanation}` : ''}`,
      type: 'stock_alert',
      link: '/src/pages/manager/stock-alerts.html',
    });

    emitRestockEvent('restock:updated', {
      requestId: updated._id,
      itemId: updated.itemId,
      itemName: updated.itemName,
      status: updated.status,
      cafeteriaId: updated.cafeteriaId,
    });

    const populated = await updated.populate(POPULATE);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message:
        decision === RESTOCK_STATUS.APPROVED
          ? 'Restock request approved. Record the received quantity once the stock physically arrives.'
          : 'Restock request rejected',
      request: serialize(populated),
    });
  } catch (error) {
    console.error('❌ Review Restock Request Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// PATCH /api/v1/restocks/:id/restock - Cafeteria Admin records the ACTUAL
// received quantity and updates the item's authoritative stock.
// ---------------------------------------------------------------
exports.recordRestock = async (req, res) => {
  try {
    const { id } = req.params;
    const received = Number(req.body && (req.body.receivedQuantity ?? req.body.quantity));
    const note = String((req.body && (req.body.note || req.body.restockNote)) || '').trim();

    if (!isValidId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid restock request id' });
    }
    if (!Number.isInteger(received) || received <= 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Received quantity must be a positive whole number (the actual amount physically received)',
      });
    }

    // 1) Claim the request: only an APPROVED request may be restocked, and the
    //    status flip is atomic so the same request can never be processed twice
    //    (the second concurrent call gets null → 409).
    const claimed = await RestockRequest.findOneAndUpdate(
      { _id: id, status: RESTOCK_STATUS.APPROVED },
      {
        $set: {
          status: RESTOCK_STATUS.RESTOCKED,
          receivedQuantity: received,
          restockedBy: req.user.id,
          restockedAt: new Date(),
          restockNote: note || null,
        },
      },
      { new: true }
    );
    if (!claimed) {
      const existing = await RestockRequest.findById(id);
      if (!existing) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Restock request not found' });
      }
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error:
          existing.status === RESTOCK_STATUS.RESTOCKED
            ? 'This request has already been recorded as restocked'
            : `Only APPROVED requests can be restocked (this one is ${existing.status})`,
      });
    }

    // 2) Apply the received quantity to the AUTHORITATIVE item record using an
    //    atomic $inc, so any concurrent stock change (order decrement, other
    //    transaction) is preserved instead of overwritten.
    let item;
    try {
      item = await applyStockDelta({
        itemId: claimed.itemId,
        delta: received,
        action: 'RESTOCK',
        performedBy: req.user.id,
        performedByRole: normalizeRole(req.user.role),
        restockRequestId: claimed._id,
        cafeteriaId: claimed.cafeteriaId || null,
      });
    } catch (e) {
      item = null;
      console.error('❌ Record Restock stock update failed:', e);
    }

    if (!item) {
      // Compensate: the item could not be updated - put the request back to
      // APPROVED so the admin can retry (nothing was fabricated).
      await RestockRequest.updateOne(
        { _id: claimed._id, status: RESTOCK_STATUS.RESTOCKED },
        { $set: { status: RESTOCK_STATUS.APPROVED, receivedQuantity: null, restockedBy: null, restockedAt: null } }
      );
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Inventory item for this request no longer exists; restock was not recorded',
      });
    }

    // 3) Recalculate the alert lifecycle with the item's LATEST quantity.
    //    (applyStockDelta already synced; re-sync is a cheap no-op.)
    await syncStockAlertsForItem(item);

    await logAction({
      req,
      action: 'STOCK_RESTOCKED',
      entityType: 'MenuItem',
      entityId: String(item._id),
      description: `${req.user.name || 'Admin'} recorded ${received} units received for ${claimed.itemName} (stock ${item.stockQuantity - received} → ${item.stockQuantity})`,
      cafeteriaId: claimed.cafeteriaId || item.cafeteriaId,
      metadata: {
        itemId: String(item._id),
        previousQuantity: item.stockQuantity - received,
        receivedQuantity: received,
        newQuantity: item.stockQuantity,
        restockRequestId: String(claimed._id),
      },
    });

    // 4) Notify the requesting manager (only after the DB write succeeded).
    await notifyUser(claimed.requestedBy, {
      title: 'Stock Restocked',
      message: `${received} units of ${claimed.itemName} were received. New stock quantity: ${item.stockQuantity}.`,
      type: 'stock_alert',
      link: '/src/pages/manager/stock-alerts.html',
    });

    emitRestockEvent('restock:updated', {
      requestId: claimed._id,
      itemId: item._id,
      itemName: claimed.itemName,
      status: RESTOCK_STATUS.RESTOCKED,
      receivedQuantity: received,
      newQuantity: item.stockQuantity,
      cafeteriaId: claimed.cafeteriaId,
    });
    emitRestockEvent('stock:alert:updated', {
      itemId: item._id,
      itemName: claimed.itemName,
      currentQuantity: item.stockQuantity,
      minimumQuantity: item.lowStockThreshold,
      status: 'restocked',
    });

    const populated = await claimed.populate(POPULATE);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Restock recorded. ${claimed.itemName} stock is now ${item.stockQuantity}.`,
      request: serialize(populated),
      item: {
        id: item._id,
        name: item.name,
        stockQuantity: item.stockQuantity,
        lowStockThreshold: item.lowStockThreshold,
        availabilityStatus: item.availabilityStatus,
        qualityHold: item.qualityHold === true,
      },
    });
  } catch (error) {
    console.error('❌ Record Restock Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------
// GET /api/v1/restocks/item/:itemId/open - helper for the manager page:
// latest open (or most recent) request for a specific item.
// ---------------------------------------------------------------
exports.getOpenRequestForItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    if (!isValidId(itemId)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid item id' });
    }

    const filter = { itemId };
    if (req.query.open === 'true') {
      filter.status = { $in: [RESTOCK_STATUS.PENDING, RESTOCK_STATUS.APPROVED] };
    }

    const request = await RestockRequest.findOne(filter).populate(POPULATE).sort({ createdAt: -1 });
    res.status(HTTP_STATUS.OK).json({
      success: true,
      request: request ? serialize(request) : null,
    });
  } catch (error) {
    console.error('❌ Get Open Restock Request Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};
