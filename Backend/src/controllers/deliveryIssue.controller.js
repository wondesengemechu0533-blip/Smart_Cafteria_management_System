/**
 * Delivery Issue controller - problem reporting during an active delivery.
 *
 * Integrates with the existing delivery / notification / Socket.IO systems
 * rather than introducing parallel ones:
 *   - notifications go through `notification.controller.notifyUser`
 *   - realtime events go through `utils/socket.emitSocketEvent` into the
 *     existing `admin` / `delivery` / `order:<id>` / `user:<id>` rooms
 *   - manager actions reuse `delivery.controller`'s assignment and status moves
 *
 * Security model (all enforced here, on the server, from the JWT):
 *   - a delivery person may only report on a delivery assigned to THEM
 *   - a manager may only read/act on issues in THEIR OWN cafeteria
 *   - a customer may only see an issue on THEIR OWN order, and only a
 *     customer-safe projection of it
 *   - nothing in the request body is trusted for identity, role or ownership
 */

const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Delivery = require('../models/Delivery');
const DeliveryIssue = require('../models/DeliveryIssue');
const deliveryService = require('../services/delivery.service');
const issueService = require('../services/deliveryIssue.service');
const { HTTP_STATUS } = require('../config/constants');
const { isAdminRole, normalizeRole, SYSTEM_ADMIN_ROLES } = require('../config/roles');
const { emitSocketEvent } = require('../utils/socket');
const { notifyUser } = require('./notification.controller');
const { logAction } = require('../utils/audit');
const { uploadDeliveryIssuePhoto } = require('../utils/cloudUpload');
const { respondWithError } = require('../utils/respondError');

const { DELIVERY_ISSUE_TYPES, DELIVERY_ISSUE_STATUSES } = DeliveryIssue;

const MANAGEMENT_ROLE_LIST = ['admin', 'system_admin', 'cafeteria_admin', 'manager'];
const ISSUE_LINKS = {
  manager: () => '/src/pages/admin/deliveries.html#issues',
  courier: () => '/src/pages/delivery/deliveries.html',
};

function isManagerActor(role) {
  return MANAGEMENT_ROLE_LIST.includes(normalizeRole(role));
}

function sendError(res, error, fallbackMessage) {
  // Single source of truth for how a thrown error becomes a response, so a
  // momentarily unreachable database is reported as a retryable 503 rather than
  // a 500 that makes this endpoint look broken. See utils/respondError.js.
  return respondWithError(res, error, fallbackMessage);
}

/**
 * A single id may be an issue id, a delivery id, or a human order id. Issues
 * are looked up by their own id first so a manager navigating to an issue deep
 * link always lands on that issue.
 */
function buildIssueLookup(id) {
  const value = String(id === null || id === undefined ? '' : id).trim();
  if (!value) return null;
  const clauses = [];
  // Only query _id with a real ObjectId. A human order id like "ORD-1042"
  // would otherwise raise a CastError (500) instead of simply not matching.
  const isObjectId = mongoose.Types.ObjectId.isValid(value);
  if (isObjectId) clauses.push({ _id: value }, { delivery: value }, { order: value });
  clauses.push({ orderId: value });
  return { $or: clauses };
}

async function findIssueByIdentifier(id) {
  const lookup = buildIssueLookup(id);
  if (!lookup) return null;
  return DeliveryIssue.findOne(lookup);
}

/** Courier id from a Delivery, tolerating lean ObjectId or populated doc. */
function deliveryCourierId(delivery) {
  const p = delivery && delivery.deliveryPerson;
  if (!p) return '';
  if (typeof p === 'object' && p._id) return String(p._id);
  return String(p);
}

function orderCourierId(order) {
  const a = order && order.deliveryStaffAssigned;
  if (!a) return '';
  if (typeof a === 'object' && a._id) return String(a._id);
  return String(a);
}

/**
 * Resolve the Order + Delivery an issue belongs to, from either the issue or a
 * route parameter. Reuses the delivery controller's resolver so an order id, an
 * order ObjectId and a delivery id all keep working exactly as they do for the
 * rest of the delivery API.
 */
async function resolveIssueContext(issue) {
  const order = await Order.findById(issue.order).populate('deliveryStaffAssigned', 'name phone role');
  if (!order) return { order: null, delivery: null };
  let delivery = null;
  if (issue.delivery) delivery = await Delivery.findById(issue.delivery);
  if (!delivery && order.delivery) delivery = await Delivery.findById(order.delivery);
  if (!delivery) {
    try {
      delivery = await deliveryService.ensureDeliveryForOrder(order);
    } catch (e) {
      delivery = null;
    }
  }
  return { order, delivery };
}

// ---------------------------------------------------------------------------
// Notifications (reuses the existing notification + Socket.IO systems)
// ---------------------------------------------------------------------------

/**
 * The customer-facing delay message. Deliberately generic: it never leaks the
 * issue type, the courier's name, the GPS position or the internal notes. The
 * customer learns that they are late and nothing more.
 */
const CUSTOMER_DELAY_MESSAGE =
  'Your delivery is temporarily delayed. We will update you when delivery continues.';

async function notifyManagersOfIssue(issue, order) {
  const baseQuery = { status: 'ACTIVE', isActive: { $ne: false } };
  try {
    const globalQuery = { ...baseQuery, role: { $in: SYSTEM_ADMIN_ROLES } };
    // Cafeteria staff are strictly scoped: a manager may only ever be told
    // about an issue in their own cafeteria.
    const scopedQuery = {
      ...baseQuery,
      role: { $in: ['cafeteria_admin', 'manager'] },
      cafeteriaId: issue.cafeteriaId,
    };
    const recipients = await User.find({ $or: [globalQuery, scopedQuery] }).select('_id');
    if (!recipients || recipients.length === 0) return 0;

    const typeLabel = humanizeIssueType(issue.issueType);
    const title = `Delivery problem reported - #${issue.orderId}`;
    const message = `${typeLabel}${issue.locationAvailable ? '' : ' (no GPS fix)'} reported for order #${issue.orderId}. ${
      order && order.customerName ? `Customer: ${order.customerName}. ` : ''
    }Review and decide.`;

    await Promise.all(
      recipients.map((r) =>
        notifyUser(r._id, title, message, 'delivery_issue', issue.orderId, ISSUE_LINKS.manager(), {
          issueId: String(issue._id),
          issueType: issue.issueType,
          status: issue.status,
          cafeteriaId: issue.cafeteriaId || null,
        })
      )
    );
    return recipients.length;
  } catch (error) {
    // A notification failure must never lose the issue itself.
    console.warn('Delivery issue manager notification failed:', error.message);
    return 0;
  }
}

async function notifyCourierOfIssueUpdate(issue, order, title, message) {
  const courierId = issue.reportedBy;
  if (!courierId) return null;
  try {
    return await notifyUser(
      courierId,
      title,
      message,
      'delivery_issue',
      issue.orderId,
      ISSUE_LINKS.courier(),
      { issueId: String(issue._id), status: issue.status }
    );
  } catch (error) {
    console.warn('Delivery issue courier notification failed:', error.message);
    return null;
  }
}

/**
 * Tell the customer their delivery is delayed - exactly once per issue, and
 * only for issue types that genuinely delay them.
 */
async function notifyCustomerOfDelay(issue) {
  if (!issue.delaysDelivery) return false;
  if (issue.customerNotified) return false;
  const customerId = issue.customer;
  if (!customerId) return false;

  try {
    await notifyUser(
      customerId,
      'Delivery delayed',
      CUSTOMER_DELAY_MESSAGE,
      'delivery_issue',
      issue.orderId,
      `/src/pages/customer/order-tracking.html?orderId=${encodeURIComponent(issue.orderId)}`,
      // Only the flag - never the issue type, description or GPS position.
      { delayed: true }
    );
    issue.customerNotified = true;
    issue.customerNotifiedAt = new Date();
    await issue.save();
    return true;
  } catch (error) {
    console.warn('Delivery issue customer notification failed:', error.message);
    return false;
  }
}

/** Recount a delivery's live issues so the manager list and badge stay correct. */
async function refreshOpenIssueCount(delivery) {
  if (!delivery) return 0;
  const open = await DeliveryIssue.countDocuments({
    delivery: delivery._id,
    status: { $in: ['OPEN', 'IN_PROGRESS'] },
  });
  delivery.openIssueCount = open;
  await delivery.save();
  return open;
}

/**
 * Realtime fan-out.
 *
 * The shared `admin` and `delivery` rooms span EVERY cafeteria, so a full issue
 * payload (description, courier notes, GPS) must never be broadcast there -
 * that would leak one cafeteria's problems to another tenant's console. Staff
 * are therefore addressed individually through their authenticated
 * `user:<id>` room, using exactly the same scoping rules as the notification.
 *
 * The per-order rooms are a different matter: a socket can only join
 * `order:<id>` / `delivery:<id>` after `canAccessOrder` verified it is the
 * owner, the assigned courier or management. A customer may legitimately be in
 * that room, so only the safe projection is sent there.
 */
async function broadcastIssue(issue, eventName, staffPayload) {
  try {
    const staffBody = staffPayload || issue.toIssuePayload();

    // 1) Scoped staff: cafeteria managers + global admins + the reporting courier.
    const baseQuery = { status: 'ACTIVE', isActive: { $ne: false } };
    const recipients = await User.find({
      $or: [
        { ...baseQuery, role: { $in: SYSTEM_ADMIN_ROLES } },
        { ...baseQuery, role: { $in: ['cafeteria_admin', 'manager'] }, cafeteriaId: issue.cafeteriaId },
        { _id: issue.reportedBy },
      ],
    }).select('_id');

    for (const recipient of recipients) {
      emitSocketEvent(`user:${recipient._id}`, eventName, staffBody);
    }

    // 2) Per-order listeners (tracking page, courier dashboard). BOTH rooms are
    //    reachable by the customer who owns the order - `canAccessOrder` admits
    //    the owner, and the tracking page joins both - so both get the safe
    //    projection and nothing else. Staff detail only ever travels over the
    //    individually addressed `user:<id>` rooms above.
    const customerBody = serializeIssueForCustomer(issue);
    emitSocketEvent(`order:${issue.orderId}`, 'delivery:issue', customerBody);
    if (issue.delivery) {
      emitSocketEvent(`delivery:${issue.orderId}`, 'delivery:issue', customerBody);
    }
  } catch (error) {
    // Realtime is best-effort; the issue is already persisted and notified.
    console.warn('Delivery issue broadcast failed:', error.message);
  }
}

function humanizeIssueType(type) {
  return String(type || '')
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Manager / courier view: everything an operator needs, including the live
 * position of the issue and who is involved.
 */
async function serializeIssueForStaff(issue) {
  const { order, delivery } = await resolveIssueContext(issue);
  const courierId = (delivery && deliveryCourierId(delivery)) || orderCourierId(order) || null;
  const courier = courierId ? await User.findById(courierId).select('name phone role') : null;

  const payload = issue.toIssuePayload();
  return {
    ...payload,
    // Order + customer detail.
    customerName: order ? order.customerName : '',
    customerPhone: order ? order.customerPhone : '',
    deliveryAddress: order
      ? order.deliveryInfo?.deliveryAddress ||
        [order.deliveryInfo?.subCity, order.deliveryInfo?.location].filter(Boolean).join(', ')
      : '',
    orderType: order ? order.orderType : null,
    orderStatus: order ? order.orderStatus : null,
    // Courier contact detail for the manager.
    courier: courier
      ? { id: String(courier._id), name: courier.name, phone: courier.phone || '', role: courier.role }
      : null,
    courierName: courier ? courier.name : issue.reportedByName || '',
    courierPhone: courier ? courier.phone || '' : issue.reportedByPhone || '',
    // Current delivery state + hold, so the manager sees the whole picture.
    deliveryStatus: delivery ? delivery.status : null,
    deliveryOnHold: delivery ? Boolean(delivery.onHold) : false,
    holdReason: delivery ? delivery.holdReason || null : null,
    // Distance from the issue position to the customer, ONLY when both ends
    // are genuinely known. Never a fabricated 0.
    distanceToCustomerKm: deliveryIssueServiceKm(issue, delivery),
  };
}

function deliveryIssueServiceKm(issue, delivery) {
  const dest = delivery && delivery.destination;
  if (!dest) return null;
  return issueService.kmBetween(
    { lat: issue.latitude, lng: issue.longitude },
    { lat: dest.latitude, lng: dest.longitude }
  );
}

/**
 * Customer-facing projection. Intentionally minimal: the customer sees that
 * there is a delay, nothing about the cause, the courier's notes, the issue id
 * or the exact GPS position of the problem.
 */
function serializeIssueForCustomer(issue) {
  return {
    delayed: Boolean(issue.delaysDelivery) && !issue.isTerminal(),
    status: issue.isTerminal() ? issue.status : 'OPEN',
    message: issue.isTerminal() ? null : CUSTOMER_DELAY_MESSAGE,
    reportedAt: issue.reportedAt || issue.createdAt,
    resolvedAt: issue.resolvedAt || null,
  };
}

// ---------------------------------------------------------------------------
// 1. Delivery person reports a problem
// ---------------------------------------------------------------------------

/**
 * @desc    Report a problem on a delivery you are assigned to
 * @route   POST /api/v1/delivery-issues
 * @access  Private/Delivery
 */
exports.reportDeliveryIssue = async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    if (role !== 'delivery' && !isManagerActor(role)) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'Only delivery staff can report a delivery problem',
      });
    }

    const { issueType, description, latitude, longitude, accuracy } = req.body || {};
    const targetId = req.params.id || req.body?.delivery || req.body?.orderId;

    // Reuse the delivery controller's resolver: an order id, an order ObjectId
    // or a delivery id all work, exactly as for every other delivery endpoint.
    const deliveryController = require('./delivery.controller');
    const { order, delivery } = await deliveryController._internal.resolveDeliveryPair(targetId);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }
    if (order.orderType !== 'delivery') {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ success: false, error: 'This order is not a delivery order' });
    }

    // Ownership: the courier may only report on THEIR OWN delivery. Checked
    // against the JWT, never a client-supplied id.
    if (role === 'delivery') {
      const assignedTo = deliveryCourierId(delivery) || orderCourierId(order);
      if (assignedTo !== String(req.user.id)) {
        return res
          .status(HTTP_STATUS.FORBIDDEN)
          .json({ success: false, error: 'This delivery is not assigned to you' });
      }
    }

    // Optional photo through the existing upload utility.
    let photo = null;
    if (req.file && req.file.buffer) {
      try {
        const uploaded = await uploadDeliveryIssuePhoto(
          req.file.buffer,
          req.file.mimetype,
          req.file.originalname
        );
        photo = uploaded && uploaded.url ? uploaded.url : null;
      } catch (uploadError) {
        // A failed photo must not lose the report: the text matters more.
        console.warn('Delivery issue photo upload failed:', uploadError.message);
      }
    }

    let issue;
    try {
      issue = await issueService.reportIssue({
        delivery,
        order,
        actor: req.user,
        issueType,
        description,
        photo,
        location: { latitude, longitude, accuracy },
      });
    } catch (error) {
      // A duplicate open issue of the same type is returned rather than lost.
      if (error.statusCode === 409 && error.existingIssue) {
        return res.status(HTTP_STATUS.CONFLICT).json({
          success: false,
          error: error.message,
          issue: error.existingIssue.toIssuePayload(),
        });
      }
      throw error;
    }

    // Keep the denormalised counters in step for the manager list.
    await refreshOpenIssueCount(delivery);

    await logAction({
      req,
      action: 'DELIVERY_ISSUE_REPORTED',
      entityType: 'DeliveryIssue',
      entityId: String(issue._id),
      description: `Order #${issue.orderId}: ${humanizeIssueType(issue.issueType)}`,
      result: 'SUCCESS',
      metadata: { issueType: issue.issueType, locationAvailable: issue.locationAvailable },
    });

    // Delivery person -> Manager
    await notifyManagersOfIssue(issue, order);
    // Only a genuine delay reaches the customer, and only once.
    await notifyCustomerOfDelay(issue);

    const payload = issue.toIssuePayload();
    await broadcastIssue(issue, 'delivery:issue', payload);
    // The delivery itself is untouched: its status did NOT change. It is still
    // OUT_FOR_DELIVERY and can never become DELIVERED from here.
    deliveryController._internal.serializeDelivery && broadcastIssueStatus(order, delivery);

    return res.status(HTTP_STATUS.CREATED).json({
      success: true,
      message: 'Problem reported. Your manager has been notified.',
      issue: payload,
      // Explicit so the UI can say "location unavailable" instead of a blank pin.
      locationAvailable: issue.locationAvailable,
      deliveryStatus: delivery.status,
      customerNotified: issue.customerNotified,
    });
  } catch (error) {
    console.error('Report delivery issue error:', error);
    return sendError(res, error, 'Failed to report the problem');
  }
};

/** Re-emit the unchanged delivery status so tracking stays consistent. */
function broadcastIssueStatus(order, delivery) {
  try {
    const deliveryController = require('./delivery.controller');
    const summary = deliveryController._internal.serializeDelivery(order, delivery);
    emitSocketEvent(`order:${order.orderId}`, 'order:status', summary);
    emitSocketEvent(`delivery:${order.orderId}`, 'delivery:status', summary);
  } catch (error) {
    console.warn('Delivery issue status re-broadcast failed:', error.message);
  }
}

// ---------------------------------------------------------------------------
// 2. Manager lists issues (strictly cafeteria-scoped)
// ---------------------------------------------------------------------------

/**
 * @desc    List delivery issues for the manager's cafeteria
 * @route   GET /api/v1/delivery-issues
 * @access  Private/Management
 */
exports.getDeliveryIssues = async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    if (!isManagerActor(role)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'Only managers can view delivery issues' });
    }

    // Tenant boundary. A global admin sees everything; a cafeteria manager sees
    // only their own cafeteria. Never both combined by accident.
    const filter = {};
    if (!isAdminRole(role)) {
      const cafeteriaId = req.user.cafeteriaId || null;
      if (!cafeteriaId) {
        // A cafeteria manager with no cafeteria bound must see nothing rather
        // than everything.
        return res.status(HTTP_STATUS.OK).json({ success: true, count: 0, issues: [] });
      }
      filter.cafeteriaId = cafeteriaId;
    } else if (req.query.cafeteriaId && mongoose.Types.ObjectId.isValid(req.query.cafeteriaId)) {
      filter.cafeteriaId = req.query.cafeteriaId;
    }

    const statusFilter = issueService.normalizeIssueStatus(req.query.status);
    if (statusFilter) {
      filter.status = statusFilter;
    } else if (req.query.status === 'open') {
      filter.status = { $in: ['OPEN', 'IN_PROGRESS'] };
    } else if (req.query.status === 'all') {
      // no status filter
    } else {
      // Default to what a manager actually needs: live issues.
      filter.status = { $in: ['OPEN', 'IN_PROGRESS'] };
    }

    if (req.query.delivery) {
      filter.delivery = req.query.delivery;
    }

    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const issues = await DeliveryIssue.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit);

    const detailed = await Promise.all(issues.map((i) => serializeIssueForStaff(i)));

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      count: detailed.length,
      issues: detailed,
    });
  } catch (error) {
    console.error('Get delivery issues error:', error);
    return sendError(res, error, 'Failed to load delivery issues');
  }
};

/**
 * @desc    Issue counts for the dashboard badge
 * @route   GET /api/v1/delivery-issues/stats
 * @access  Private/Management
 */
exports.getDeliveryIssueStats = async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    if (!isManagerActor(role)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'Only managers can view delivery issue stats' });
    }
    const filter = {};
    if (!isAdminRole(role)) {
      const cafeteriaId = req.user.cafeteriaId || null;
      if (!cafeteriaId) return res.status(HTTP_STATUS.OK).json({ success: true, stats: {} });
      filter.cafeteriaId = cafeteriaId;
    }

    const [open, inProgress, resolved, cancelled, onHoldDeliveries] = await Promise.all([
      DeliveryIssue.countDocuments({ ...filter, status: 'OPEN' }),
      DeliveryIssue.countDocuments({ ...filter, status: 'IN_PROGRESS' }),
      DeliveryIssue.countDocuments({ ...filter, status: 'RESOLVED' }),
      DeliveryIssue.countDocuments({ ...filter, status: 'CANCELLED' }),
      Delivery.countDocuments({ ...filter, onHold: true }),
    ]);

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: {
        open,
        inProgress,
        resolved,
        cancelled,
        total: open + inProgress + resolved + cancelled,
        onHoldDeliveries,
      },
    });
  } catch (error) {
    console.error('Delivery issue stats error:', error);
    return sendError(res, error, 'Failed to load delivery issue stats');
  }
};

// ---------------------------------------------------------------------------
// 3. Detail view (manager / reporting courier)
// ---------------------------------------------------------------------------

/**
 * @desc    Delivery issue detail
 * @route   GET /api/v1/delivery-issues/:id
 * @access  Private/Management + the reporting courier
 */
exports.getDeliveryIssue = async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    const issue = await findIssueByIdentifier(req.params.id);
    if (!issue) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Issue not found' });
    }

    if (isManagerActor(role)) {
      if (!isAdminRole(role) && String(issue.cafeteriaId || '') !== String(req.user.cafeteriaId || '')) {
        return res
          .status(HTTP_STATUS.FORBIDDEN)
          .json({ success: false, error: 'This issue belongs to another cafeteria' });
      }
    } else if (role === 'delivery') {
      if (String(issue.reportedBy || '') !== String(req.user.id)) {
        return res
          .status(HTTP_STATUS.FORBIDDEN)
          .json({ success: false, error: 'You can only view issues you reported' });
      }
    } else if (role === 'customer') {
      if (String(issue.customer || '') !== String(req.user.id)) {
        return res
          .status(HTTP_STATUS.FORBIDDEN)
          .json({ success: false, error: 'You can only view issues on your own orders' });
      }
      return res.status(HTTP_STATUS.OK).json({
        success: true,
        issue: serializeIssueForCustomer(issue),
      });
    } else {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'Not permitted' });
    }

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      issue: await serializeIssueForStaff(issue),
    });
  } catch (error) {
    console.error('Get delivery issue error:', error);
    return sendError(res, error, 'Failed to load the issue');
  }
};

// ---------------------------------------------------------------------------
// 4. Manager actions: start work, resolve, cancel
// ---------------------------------------------------------------------------

async function managerAction(req, res, targetStatus) {
  try {
    const role = normalizeRole(req.user.role);
    if (!isManagerActor(role)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'Only managers can update delivery issues' });
    }

    const issue = await findIssueByIdentifier(req.params.id);
    if (!issue) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Issue not found' });
    }
    if (!isAdminRole(role) && String(issue.cafeteriaId || '') !== String(req.user.cafeteriaId || '')) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'This issue belongs to another cafeteria' });
    }

    const note = req.body?.resolutionNote || req.body?.note || null;
    const updated = await issueService.applyIssueStatus({
      issue,
      status: targetStatus,
      actor: req.user,
      note,
    });

    await logAction({
      req,
      action: `DELIVERY_ISSUE_${targetStatus}`,
      entityType: 'DeliveryIssue',
      entityId: String(updated._id),
      description: `Order #${updated.orderId}: issue -> ${targetStatus}`,
      result: 'SUCCESS',
      metadata: { from: targetStatus },
    });

    // Manager action -> Delivery Person
    const title =
      targetStatus === 'RESOLVED'
        ? 'Delivery problem resolved'
        : targetStatus === 'CANCELLED'
          ? 'Delivery problem closed'
          : 'Delivery problem in progress';
    const message =
      targetStatus === 'RESOLVED'
        ? `Your report on order #${updated.orderId} was resolved.${note ? ` Note: ${note}` : ''} You can continue the delivery.`
        : targetStatus === 'CANCELLED'
          ? `Your report on order #${updated.orderId} was closed.${note ? ` Note: ${note}` : ''}`
          : `A manager is now handling your report on order #${updated.orderId}.`;
    await notifyCourierOfIssueUpdate(updated, null, title, message);

    const refreshedDelivery = updated.delivery ? await Delivery.findById(updated.delivery) : null;
    await refreshOpenIssueCount(refreshedDelivery);
    if (refreshedDelivery) {
      broadcastIssueStatus(
        await Order.findById(updated.order).populate('deliveryStaffAssigned', 'name phone role'),
        refreshedDelivery
      );
    }

    await broadcastIssue(updated, 'delivery:issue', updated.toIssuePayload());

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message:
        targetStatus === 'RESOLVED'
          ? 'Issue resolved. The delivery can continue.'
          : `Issue moved to ${targetStatus}.`,
      issue: await serializeIssueForStaff(updated),
    });
  } catch (error) {
    console.error('Delivery issue action error:', error);
    return sendError(res, error, 'Failed to update the issue');
  }
}

/** @route PATCH /api/v1/delivery-issues/:id/start */
exports.startDeliveryIssue = async (req, res) => managerAction(req, res, 'IN_PROGRESS');

/** @route PATCH /api/v1/delivery-issues/:id/resolve */
exports.resolveDeliveryIssue = async (req, res) => managerAction(req, res, 'RESOLVED');

/** @route PATCH /api/v1/delivery-issues/:id/cancel */
exports.cancelDeliveryIssue = async (req, res) => managerAction(req, res, 'CANCELLED');

// ---------------------------------------------------------------------------
// 5. Manager actions on the DELIVERY: continue / hold / reassign / cancel
// ---------------------------------------------------------------------------

/** Assert the manager owns this issue's cafeteria. Returns the issue. */
async function assertIssueCafeteria(req) {
  const role = normalizeRole(req.user.role);
  if (!isManagerActor(role)) {
    const err = new Error('Only managers can perform this action');
    err.statusCode = HTTP_STATUS.FORBIDDEN;
    throw err;
  }
  const issue = await findIssueByIdentifier(req.params.id);
  if (!issue) {
    const err = new Error('Issue not found');
    err.statusCode = HTTP_STATUS.NOT_FOUND;
    throw err;
  }
  if (!isAdminRole(role) && String(issue.cafeteriaId || '') !== String(req.user.cafeteriaId || '')) {
    const err = new Error('This issue belongs to another cafeteria');
    err.statusCode = HTTP_STATUS.FORBIDDEN;
    throw err;
  }
  return issue;
}

/**
 * Hand the delivery to a different delivery person. Delegates to the delivery
 * controller's normal assignment pipeline, so the cafeteria isolation check,
 * the ACTIVE-staff check, the capacity guard, the new courier's acceptance
 * requirement and every notification stay in one place.
 *
 * The issue itself stays open - the new courier is the one who has to take it
 * over, and the old rider has already been told they lost the delivery.
 *
 * @route PATCH /api/v1/delivery-issues/:id/reassign
 * @body { deliveryStaffId }
 */
exports.reassignDelivery = async (req, res) => {
  try {
    const issue = await assertIssueCafeteria(req);
    const delivery = await Delivery.findById(issue.delivery);
    if (!delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }
    if (deliveryService.isTerminal(delivery.status)) {
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: `A ${delivery.status} delivery cannot be reassigned`,
      });
    }

    const targetId = req.body?.deliveryStaffId || req.body?.deliveryPersonId;
    if (!targetId || !mongoose.Types.ObjectId.isValid(String(targetId))) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ success: false, error: 'deliveryStaffId is required and must be a valid user id' });
    }
    if (String(targetId) === String(deliveryCourierId(delivery))) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ success: false, error: 'This delivery is already assigned to that delivery person' });
    }

    const deliveryController = require('./delivery.controller');
    const outcome = await deliveryController._internal.assignCourierForIssue({
      issue,
      actor: req.user,
      deliveryStaffId: targetId,
    });

    issue.reassignedTo = String(targetId);
    issue.reassignedAt = new Date();
    // `req.user` is built by auth.protect and carries `id`, not `_id`.
    issue.reassignedBy = issueService.actorIdOf(req.user);
    await issue.save();

    const newCourier = await User.findById(targetId).select('name phone role');

    await logAction({
      req,
      action: 'DELIVERY_ISSUE_REASSIGN',
      entityType: 'Delivery',
      entityId: String(delivery._id),
      description: `Order #${issue.orderId}: reassigned to ${newCourier ? newCourier.name : targetId} because of an issue`,
      result: 'SUCCESS',
      metadata: { issueId: String(issue._id), deliveryStaffId: String(targetId) },
    });

    await notifyCourierOfIssueUpdate(
      issue,
      null,
      'Delivery reassigned',
      `Order #${issue.orderId} was reassigned to another delivery person.${issue.issueType ? ' The reported problem is still being handled by management.' : ''}`
    );

    await broadcastIssue(issue, 'delivery:issue', issue.toIssuePayload());
    broadcastIssueStatus(await Order.findById(issue.order).populate('deliveryStaffAssigned', 'name phone role'), delivery);

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Delivery reassigned to ${newCourier ? newCourier.name : 'another delivery person'}.`,
      reassignedTo: { id: String(targetId), name: newCourier ? newCourier.name : '', phone: newCourier ? newCourier.phone || '' : '' },
      delivery: outcome && outcome.delivery ? outcome.delivery : undefined,
      issue: await serializeIssueForStaff(issue),
    });
  } catch (error) {
    console.error('Reassign delivery from issue error:', error);
    return sendError(res, error, 'Failed to reassign this delivery');
  }
};

/**
 * Put the delivery on hold. The delivery keeps its current status (so tracking,
 * GPS and the state machine are untouched) and simply stops progressing until
 * the manager resumes it or the last open issue is resolved.
 *
 * @route PATCH /api/v1/delivery-issues/:id/hold
 */
exports.holdDelivery = async (req, res) => {
  try {
    const issue = await assertIssueCafeteria(req);
    const delivery = await Delivery.findById(issue.delivery);
    if (!delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }
    if (deliveryService.isTerminal(delivery.status)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `A ${delivery.status} delivery cannot be put on hold`,
      });
    }
    // A hold is a live response to a live problem. Holding an issue that is
    // already resolved/cancelled would silently freeze a delivery forever.
    if (issue.isTerminal()) {
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: `This issue is already ${issue.status} and cannot put the delivery on hold`,
      });
    }

    delivery.onHold = true;
    delivery.holdReason = req.body?.reason ? String(req.body.reason).trim() : issue.issueType;
    delivery.heldAt = new Date();
    // `req.user` is built by auth.protect and carries `id`, not `_id`.
    delivery.heldBy = issueService.actorIdOf(req.user);
    await delivery.save();

    issue.deliveryOnHold = true;
    await issue.save();

    await logAction({
      req,
      action: 'DELIVERY_ISSUE_HOLD',
      entityType: 'Delivery',
      entityId: String(delivery._id),
      description: `Order #${delivery.orderId}: delivery put on hold`,
      result: 'SUCCESS',
      metadata: { reason: delivery.holdReason },
    });

    await notifyCourierOfIssueUpdate(
      issue,
      null,
      'Delivery on hold',
      `Order #${delivery.orderId} was put on hold by a manager.${delivery.holdReason ? ` Reason: ${delivery.holdReason}` : ''}`
    );

    const payload = issue.toIssuePayload();
    await broadcastIssue(issue, 'delivery:issue', payload);
    broadcastIssueStatus(await Order.findById(issue.order).populate('deliveryStaffAssigned', 'name phone role'), delivery);

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Delivery put on hold. It will not be marked delivered while on hold.',
      issue: await serializeIssueForStaff(issue),
    });
  } catch (error) {
    console.error('Hold delivery error:', error);
    return sendError(res, error, 'Failed to put the delivery on hold');
  }
};

/**
 * Release the hold and let the courier continue. The delivery status is NOT
 * changed here - only the courier can pick up / deliver, so nothing can be
 * auto-completed from a manager action.
 *
 * @route PATCH /api/v1/delivery-issues/:id/continue
 */
exports.continueDelivery = async (req, res) => {
  try {
    const issue = await assertIssueCafeteria(req);
    const delivery = await Delivery.findById(issue.delivery);
    if (!delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }

    delivery.onHold = false;
    delivery.holdReason = null;
    delivery.heldAt = null;
    delivery.heldBy = null;
    delivery.resumedAt = new Date();
    await delivery.save();

    issue.deliveryOnHold = false;
    await issue.save();

    await notifyCourierOfIssueUpdate(
      issue,
      null,
      'Delivery resumed',
      `Order #${delivery.orderId} was released. Please continue the delivery.`
    );

    const payload = issue.toIssuePayload();
    await broadcastIssue(issue, 'delivery:issue', payload);
    broadcastIssueStatus(await Order.findById(issue.order).populate('deliveryStaffAssigned', 'name phone role'), delivery);

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Delivery released. The delivery person can continue.',
      issue: await serializeIssueForStaff(issue),
    });
  } catch (error) {
    console.error('Continue delivery error:', error);
    return sendError(res, error, 'Failed to release the delivery');
  }
};

/**
 * Cancel the delivery because of this issue. Reuses the delivery controller's
 * cancellation path so the order, the delivery and the customer all stay in
 * step exactly as they do for a normal cancellation.
 *
 * @route PATCH /api/v1/delivery-issues/:id/cancel-delivery
 */
exports.cancelDeliveryFromIssue = async (req, res) => {
  try {
    const issue = await assertIssueCafeteria(req);
    const reason = req.body?.reason || 'Delivery problem could not be resolved';

    const deliveryController = require('./delivery.controller');
    // Reuse the real cancellation implementation rather than duplicating it.
    await deliveryController._internal.cancelDeliveryForIssue({ issue, actor: req.user, reason });

    await logAction({
      req,
      action: 'DELIVERY_ISSUE_CANCEL_DELIVERY',
      entityType: 'Order',
      entityId: String(issue.order),
      description: `Order #${issue.orderId}: delivery cancelled because of an issue`,
      result: 'SUCCESS',
      metadata: { reason },
    });

    if (issue.status !== 'CANCELLED' && issue.status !== 'RESOLVED') {
      await issueService.applyIssueStatus({
        issue,
        status: 'CANCELLED',
        actor: req.user,
        note: reason,
        holdRelease: false,
      });
    }
    await refreshOpenIssueCount(await Delivery.findById(issue.delivery));

    await notifyCourierOfIssueUpdate(
      issue,
      null,
      'Delivery cancelled',
      `Order #${issue.orderId} was cancelled by a manager. Reason: ${reason}`
    );

    await broadcastIssue(issue, 'delivery:issue', issue.toIssuePayload());

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Delivery cancelled.',
      issue: await serializeIssueForStaff(issue),
    });
  } catch (error) {
    console.error('Cancel delivery from issue error:', error);
    return sendError(res, error, 'Failed to cancel the delivery');
  }
};

// ---------------------------------------------------------------------------
// 6. Customer view
// ---------------------------------------------------------------------------

/**
 * Customer-visible delay state for an order. The tracking page uses this to show
 * "delayed" without ever receiving the cause, the courier's notes or the issue
 * position.
 *
 * @route GET /api/v1/delivery-issues/order/:orderId
 * @access Private/Customer (owner) + staff
 */
exports.getCustomerOrderIssues = async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    const orderId = String(req.params.orderId || '').replace(/^#/, '');

    const order = await Order.findOne({
      $or: [{ orderId }, ...(mongoose.Types.ObjectId.isValid(orderId) ? [{ _id: orderId }] : [])],
    });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }

    // A customer may only ever read their own order.
    if (role === 'customer' && String(order.userId) !== String(req.user.id)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'You can only view issues on your own orders' });
    }

    const issues = await DeliveryIssue.find({ order: order._id }).sort({ createdAt: -1 });

    // The customer gets only the safe projection. Nothing else.
    const visible = issues.map(serializeIssueForCustomer);
    const active = visible.filter((i) => i.delayed && i.status !== 'RESOLVED' && i.status !== 'CANCELLED');

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      // One boolean + one sentence. The detail endpoints above carry the rest
      // for staff.
      delayed: active.length > 0,
      delayMessage: active.length > 0 ? CUSTOMER_DELAY_MESSAGE : null,
      issues: visible,
    });
  } catch (error) {
    console.error('Customer delivery issues error:', error);
    return sendError(res, error, 'Failed to load delivery issues');
  }
};

/**
 * Issue types + statuses, so the courier UI never hard-codes a stale list.
 * @route GET /api/v1/delivery-issues/meta/types
 */
exports.getDeliveryIssueMeta = async (req, res) => {
  const role = normalizeRole(req.user.role);
  if (role !== 'delivery' && !isManagerActor(role)) {
    return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'Not permitted' });
  }
  return res.status(HTTP_STATUS.OK).json({
    success: true,
    types: DELIVERY_ISSUE_TYPES.map((t) => ({ value: t, label: humanizeIssueType(t) })),
    statuses: DELIVERY_ISSUE_STATUSES,
    reportableDeliveryStatuses: issueService.REPORTABLE_DELIVERY_STATUSES,
    delayingTypes: issueService.CUSTOMER_DELAYING_TYPES,
  });
};

module.exports._internal = {
  serializeIssueForStaff,
  serializeIssueForCustomer,
  humanizeIssueType,
  isManagerActor,
  deliveryCourierId,
  orderCourierId,
  resolveIssueContext,
  findIssueByIdentifier,
  buildIssueLookup,
  ISSUE_LINKS,
  CUSTOMER_DELAY_MESSAGE,
};
