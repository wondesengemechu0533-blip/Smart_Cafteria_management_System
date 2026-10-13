const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const OrderStatusHistory = require('../models/OrderStatusHistory');
const Delivery = require('../models/Delivery');
const DeliveryLocation = require('../models/DeliveryLocation');
const deliveryService = require('../services/delivery.service');
const { computeOrderCharges } = require('../services/finance.service');
const { HTTP_STATUS, MESSAGES } = require('../config/constants');
const { getSettingsMap } = require('../utils/settings');
const { resolveCafeteriaScope, cafeteriaFilter, getDefaultCafeteriaId } = require('../utils/cafeteria');
const { isAdminRole, normalizeRole, SYSTEM_ADMIN_ROLES } = require('../config/roles');
const { emitSocketEvent } = require('../utils/socket');
const { notifyUser } = require('./notification.controller');
const { logAction } = require('../utils/audit');
// The one user-creation path in the system. Reused so "Add Delivery Staff"
// creates a normal User account instead of a parallel staff store.
const { createUserRecord, respondToCreateUserError } = require('./user.controller');
const { respondWithError } = require('../utils/respondError');

const { DELIVERY_STATUS, normalizeStatus, humanize } = deliveryService;

/**
 * Order-facing status names the existing kitchen / admin / customer screens
 * already understand. The delivery state machine (services/delivery.service.js)
 * owns the real state; this is only the presentation layer for the order.
 */
const DELIVERY_FLOW = [
  'PENDING',
  'PREPARING',
  'READY',
  'READY_FOR_DELIVERY',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'ARRIVED',
  'DELIVERED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

const MANAGEMENT_ROLE_LIST = ['admin', 'system_admin', 'cafeteria_admin', 'manager'];

/**
 * Server-side GPS update throttle. The client already only sends meaningful
 * updates (every ~5-15s or after moving a real distance), but the backend
 * enforces a hard minimum interval so a misbehaving client cannot spam the
 * database. Single-instance deployment -> in-memory is sufficient.
 */
const LAST_LOCATION_AT = new Map();
const MIN_LOCATION_INTERVAL_MS = 3000;

function locationRateLimited(userId) {
  const now = Date.now();
  const last = LAST_LOCATION_AT.get(String(userId)) || 0;
  if (now - last < MIN_LOCATION_INTERVAL_MS) return true;
  LAST_LOCATION_AT.set(String(userId), now);
  return false;
}

function toLocationNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// A device clock may run slightly ahead/behind; reject only obviously bogus
// timestamps (far future = clock tampering, ancient = stale/replayed fix).
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TIMESTAMP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
// Same-fix window: an identical lat/lng within this span is a retry, not new data.
const DUPLICATE_POINT_WINDOW_MS = 5000; // 5 seconds

/**
 * Validate a client-supplied GPS timestamp.
 * Accepts epoch ms (13 digits), epoch seconds (10 digits), or an ISO string.
 * Omitted timestamp -> server time (device may not send one).
 * Returns { ok: true, date } or { ok: false, error }.
 */
function validateLocationTimestamp(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, date: new Date() };
  }

  let date = null;
  const n = toLocationNumber(value);
  if (n !== null) {
    // Devices may report epoch ms (>1e12) or seconds (1e9 range).
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) date = d;
  }
  if (!date && typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) date = d;
  }
  if (!date) {
    return {
      ok: false,
      error: 'Invalid timestamp (must be epoch milliseconds, epoch seconds, or an ISO date string)',
    };
  }

  const now = Date.now();
  if (date.getTime() - now > MAX_FUTURE_SKEW_MS) {
    return { ok: false, error: 'Invalid timestamp (too far in the future)' };
  }
  if (now - date.getTime() > MAX_TIMESTAMP_AGE_MS) {
    return { ok: false, error: 'Invalid timestamp (too old)' };
  }
  return { ok: true, date };
}

/**
 * Validate the optional device movement data that rides along with a fix:
 * heading (degrees) and speed (metres/second). Both may be omitted/null -
 * plenty of GPS receivers report a position without a course. Out-of-range
 * values are rejected the same way bad coordinates are, so garbage never
 * reaches MongoDB.
 * Returns { ok: true, heading, speed } or { ok: false, error }.
 */
function validateMovement(headingRaw, speedRaw) {
  const heading = toLocationNumber(headingRaw);
  const speed = toLocationNumber(speedRaw);
  if (headingRaw !== undefined && headingRaw !== null && headingRaw !== '' &&
      (heading === null || heading < -360 || heading > 360)) {
    return { ok: false, error: 'Invalid heading (must be a number between -360 and 360)' };
  }
  if (speedRaw !== undefined && speedRaw !== null && speedRaw !== '' &&
      (speed === null || speed < 0 || speed > 1000)) {
    return { ok: false, error: 'Invalid speed (must be a number between 0 and 1000 m/s)' };
  }
  return { ok: true, heading: heading ?? null, speed: speed ?? null };
}

// ---------------------------------------------------------------------------
// Lookup / serialization helpers
// ---------------------------------------------------------------------------

/**
 * Find an order by either its Mongo _id or its human orderId.
 * This is the identifier every legacy delivery endpoint has always accepted.
 */
function buildOrderLookup(id) {
  const value = String(id ?? '').trim();
  const clauses = [];
  if (value) {
    if (mongoose.Types.ObjectId.isValid(value)) clauses.push({ _id: value });
    clauses.push({ orderId: value });
  }
  return clauses.length ? { $or: clauses } : null;
}

function findOrderByIdentifier(id) {
  const lookup = buildOrderLookup(id);
  if (!lookup) return Promise.resolve(null);
  return Order.findOne(lookup).populate('deliveryStaffAssigned', 'name phone role');
}

/**
 * Resolve BOTH the Order and its Delivery record for a route parameter.
 * Every endpoint uses this so an id can be an order id, an order ObjectId or a
 * delivery id, and the caller always gets a coherent pair.
 */
async function resolveDeliveryPair(id) {
  const order = await findOrderByIdentifier(id);
  if (order) {
    let delivery = null;
    if (order.delivery) {
      delivery = await Delivery.findById(order.delivery);
    }
    if (!delivery) {
      delivery = await deliveryService.ensureDeliveryForOrder(order);
    }
    return { order, delivery };
  }
  const delivery = await deliveryService.findDeliveryByReference(id);
  if (delivery && delivery.order) return { order: delivery.order, delivery };
  return { order: null, delivery: delivery || null };
}

// After .populate(), deliveryStaffAssigned is a document; String(doc) is not
// the id hex. Handle both lean ObjectId and populated document.
function assignedStaffId(order) {
  const a = order && order.deliveryStaffAssigned;
  if (!a) return '';
  if (typeof a === 'object' && a._id) return String(a._id);
  return String(a);
}

function deliveryStaffId(delivery) {
  if (!delivery || !delivery.deliveryPerson) return '';
  if (typeof delivery.deliveryPerson === 'object' && delivery.deliveryPerson._id) {
    return String(delivery.deliveryPerson._id);
  }
  return String(delivery.deliveryPerson);
}

/**
 * The order-facing status the existing UI already renders.
 * Prefers the live Delivery record when present, then the order's own fields.
 */
function effectiveStatus(order, delivery) {
  if (delivery && delivery.status) {
    const mapped = deliveryService.STATUS_TO_ORDER[delivery.status];
    // Pre-pickup states stay on the kitchen-facing status (PENDING / PREPARING /
    // READY) so the existing order cards and kitchen boards stay accurate.
    if (mapped && ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(mapped.orderStatus)) {
      return mapped.orderStatus;
    }
  }
  const up = String(order.orderStatus || '').toUpperCase();
  const low = String(order.status || '').toLowerCase();
  if (up === 'CANCELLED' || low === 'cancelled') return 'CANCELLED';
  if (up === 'FAILED' || low === 'failed') return 'FAILED';
  // Prefer the UI-facing status field first; it reflects the actual
  // current state. Fall back to orderStatus only when status is not
  // a recognized delivery state (e.g. legacy/partial documents).
  const upperLow = low.toUpperCase();
  if (DELIVERY_FLOW.includes(upperLow)) return upperLow;
  if (DELIVERY_FLOW.includes(up)) return up;
  if (low === 'completed') return 'COMPLETED';
  return up || low.toUpperCase() || 'PENDING';
}

// Active delivery states where GPS tracking and assignment changes are allowed.
const ACTIVE_DELIVERY_STATUSES = ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED'];

// All non-terminal statuses a delivery order can be in while still actionable
// (assigned rider must see PENDING/PREPARING orders too so they can Accept as
// soon as the manager assigns them, not only once the kitchen marks READY).
// DELIVERED is included on purpose: the handover is proven, but the assigned
// courier still owns the delivery until they close it out as COMPLETED. This is
// what keeps the active list and the history list from ever overlapping.
const MY_ACTIVE_STATUSES_UPPER = ['PENDING', 'PREPARING', 'READY', 'READY_FOR_DELIVERY', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED'];
const MY_ACTIVE_STATUSES_LOWER = ['pending', 'preparing', 'ready', 'ready_for_delivery', 'picked_up', 'out_for_delivery', 'arrived', 'delivered'];

/** Terminal delivery states - the only things that belong in history. */
const FINAL_STATUSES_UPPER = ['COMPLETED', 'FAILED', 'CANCELLED'];
const FINAL_STATUSES_LOWER = ['completed', 'Completed', 'failed', 'cancelled'];

/** Filter: delivery orders assigned to `staffId` that are not yet terminal. */
function myActiveDeliveryFilter(staffId, base) {
  return {
    ...base,
    orderType: 'delivery',
    deliveryStaffAssigned: staffId,
    $or: [
      { orderStatus: { $in: MY_ACTIVE_STATUSES_UPPER } },
      { status: { $in: MY_ACTIVE_STATUSES_LOWER } },
    ],
  };
}

function isManagerActor(role) {
  return MANAGEMENT_ROLE_LIST.includes(normalizeRole(role));
}

/**
 * Resolve cafeteria scope for delivery list/stats endpoints.
 * Delivery riders may not yet have cafeteriaId assigned (legacy seed users);
 * they fall back to global queue visibility rather than a hard 403, while
 * cafeteria staff and admins keep the strict tenant filter.
 */
function resolveDeliveryListScope(req) {
  const role = normalizeRole(req?.user?.role);
  if (isAdminRole(role)) {
    return { cafeteriaId: null, global: true, role };
  }
  if (role === 'delivery') {
    const cafeteriaId = req?.user?.cafeteriaId || null;
    return { cafeteriaId, global: !cafeteriaId, role };
  }
  return resolveCafeteriaScope(req);
}

function sendError(res, error, fallbackMessage) {
  // Single source of truth for how a thrown error becomes a response, so a
  // momentarily unreachable database is reported as a retryable 503 rather than
  // a 500 that makes this endpoint look broken. See utils/respondError.js.
  return respondWithError(res, error, fallbackMessage);
}

/**
 * The kitchen-facing state of an order, from whichever field the kitchen screen
 * wrote. Kitchen updates are stored in `orderStatus` (uppercase) and mirrored to
 * `status` (lowercase), so both are checked rather than assuming one.
 */
function kitchenReadyState(order) {
  const upper = String((order && order.orderStatus) || '').toUpperCase();
  const lower = String((order && order.status) || '').toLowerCase();
  const state = upper || lower.toUpperCase();
  return state || 'PENDING';
}

/**
 * Has the kitchen finished preparing this order? A delivery can only be picked
 * up once the food exists.
 *
 * `served` and the post-pickup states count as ready: by the time an order
 * reaches them the food is already in the customer's hands, so a late "ready"
 * tap from the kitchen must not block the courier.
 */
function isKitchenReady(order) {
  const state = kitchenReadyState(order);
  return ['READY', 'READY_FOR_DELIVERY', 'SERVED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'COMPLETED'].includes(
    state
  );
}

function buildDestination(order) {
  const info = order.deliveryInfo || {};
  const address = info.deliveryAddress || [info.subCity, info.location].filter(Boolean).join(', ') || '';
  return {
    contactName: order.customerName || '',
    phone: info.phone || order.customerPhone || '',
    subCity: info.subCity || '',
    address,
    note: info.note || '',
    latitude: deliveryService.cleanCoordinate(info.latitude, -90, 90),
    longitude: deliveryService.cleanCoordinate(info.longitude, -180, 180),
  };
}

/**
 * One canonical delivery payload for every consumer (courier dashboard,
 * manager table, customer tracking). The legacy keys (`status`, `deliveryInfo`,
 * `deliveryStaffAssigned`, ...) are preserved verbatim so no existing screen
 * breaks; the delivery-specific keys are added alongside them.
 */
function serializeDelivery(order, delivery) {
  const staff = order.deliveryStaffAssigned;
  const info = order.deliveryInfo || {};
  const destination = delivery ? delivery.destination : buildDestination(order);
  const status = effectiveStatus(order, delivery);
  const deliveryStatus = delivery ? delivery.status : deliveryService.deliveryStatusFromOrder(order);
  // Canonical GPS pair. These are the SAME stored values as the legacy
  // `currentLocation` / `deliveryInfo.latitude|longitude` keys below - exposed
  // under the deliveryLocation / customerLocation names as well so the courier
  // dashboard, the customer map and the manager monitor can all read one shape.
  // Nothing is duplicated in the database; Order.currentLocation and
  // Order.deliveryInfo are still the only stored columns.
  const deliveryLocation = (delivery && delivery.currentLocation) || order.currentLocation || null;
  const customerLocation = {
    latitude: destination.latitude ?? null,
    longitude: destination.longitude ?? null,
    address: destination.address || '',
  };
  const proximity = deliveryService.proximityToCustomer(deliveryLocation, customerLocation);

  return {
    id: String(order._id),
    orderId: order.orderId,
    // --- delivery record identity (new) ---
    deliveryId: delivery ? String(delivery._id) : null,
    deliveryStatus,
    deliveryStatusLabel: humanize(deliveryStatus),
    // --- legacy / order fields (unchanged contract) ---
    customerId: String(order.userId || ''),
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    orderType: order.orderType,
    items: (order.items || []).map((i) => ({
      itemId: i.itemId,
      name: i.name,
      quantity: i.quantity,
      price: i.price,
      notes: i.notes || '',
      subtotal: i.subtotal || (Number(i.price) || 0) * (Number(i.quantity) || 0),
    })),
    itemCount: (order.items || []).reduce((sum, i) => sum + (Number(i.quantity) || 0), 0),
    subtotal: order.subtotal,
    serviceFee: order.serviceFee,
    deliveryFee: order.deliveryFee || 0,
    totalAmount: order.totalAmount,
    status,
    deliveryInfo: info,
    deliveryAddress: destination.address,
    currentLocation: deliveryLocation,
    // --- live GPS (canonical names + derived distance) ---
    deliveryLocation: deliveryLocation
      ? {
          latitude: deliveryLocation.latitude,
          longitude: deliveryLocation.longitude,
          accuracy: deliveryLocation.accuracy ?? null,
          updatedAt: deliveryLocation.timestamp || null,
        }
      : null,
    customerLocation,
    hasCustomerLocation: proximity.hasCustomerLocation,
    // Straight-line distance from the courier's last fix to the customer, in km
    // (Haversine on the server - never a lat/long subtraction).
    distanceToCustomerKm: proximity.distanceKm,
    // Advisory "you are at the door" signal. It NEVER advances the delivery.
    nearCustomer: proximity.nearCustomer,
    // True only for PICKED_UP / OUT_FOR_DELIVERY / ARRIVED - i.e. exactly when a
    // client should be watching for `delivery:location` frames.
    trackingActive: deliveryService.isGpsAllowed(deliveryStatus),
    deliveryStaffAssigned: staff
      ? { id: String(staff._id), name: staff.name, phone: staff.phone, role: staff.role }
      : null,
    deliveryPersonId: delivery ? deliveryStaffId(delivery) : assignedStaffId(order) || null,
    deliveryAcceptanceStatus: order.deliveryAcceptanceStatus || 'PENDING_ACCEPTANCE',
    deliveryAssignedAt: order.deliveryAssignedAt || (delivery ? delivery.assignedAt : null) || null,
    deliveryAcceptedAt: order.deliveryAcceptedAt || (delivery ? delivery.acceptedAt : null) || null,
    // First time the kitchen sent the order to delivery (READY_FOR_DELIVERY).
    // Shown on the courier card as the Ready time; survives refresh because
    // it is persisted on the Order, not derived from sockets or localStorage.
    readyForDeliveryAt: order.readyForDeliveryAt || null,
    // Pickup has no `order.pickedUpAt` twin (the Order schema calls it
    // `pickedUpTime`), so it is resolved from the Delivery record first. Without
    // this key the Delivery History page had no pickup column to show at all.
    pickedUpAt: (delivery ? delivery.pickedUpAt : null) || order.pickedUpTime || null,
    deliveryStartedAt: order.deliveryStartedAt || (delivery ? delivery.outForDeliveryAt : null) || null,
    deliveryArrivedAt: order.deliveryArrivedAt || (delivery ? delivery.arrivedAt : null) || null,
    deliveredAt: order.deliveredAt || (delivery ? delivery.deliveredAt : null) || null,
    completedAt: (delivery ? delivery.completedAt : null) || order.completedTime || null,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    orderDate: order.orderDate,
    orderTime: order.orderTime,
    createdAt: order.createdAt,
    // --- route + pricing detail (new) ---
    pickupLocation: delivery ? delivery.pickupLocation : null,
    destination,
    latitude: destination.latitude,
    longitude: destination.longitude,
    hasCoordinates: Boolean(destination.hasCoordinates),
    distanceKm: delivery ? delivery.distanceKm : null,
    etaMinutes: delivery ? delivery.etaMinutes : null,
    feeMode: delivery ? delivery.feeMode : 'FLAT',
    // --- failure handling (new) ---
    failureReason: delivery ? delivery.failureReason : order.deliveryFailureReason || null,
    failureNote: delivery ? delivery.failureNote : null,
    failedAt: delivery ? delivery.failedAt : null,
    retryCount: delivery ? delivery.retryCount || 0 : 0,
    // --- lifecycle flags so the UI never guesses ---
    isActive: ACTIVE_DELIVERY_STATUSES.includes(status),
    // DELIVERED is handed over but NOT terminal: the courier still has to close
    // it out, and only COMPLETED finalises the order.
    isTerminal: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status),
    isOpen: !['COMPLETED', 'FAILED', 'CANCELLED'].includes(status),
    canAssign: deliveryService.isAssignable(deliveryStatus),
    statusHistory: delivery ? (delivery.statusHistory || []) : [],
  };
}

/** Attach the Delivery record to a list of orders in one extra query. */
async function attachDeliveries(orders) {
  if (!orders || !orders.length) return new Map();
  const orderIds = orders.map((o) => o._id);
  const deliveries = await Delivery.find({ order: { $in: orderIds } });
  const map = new Map();
  for (const d of deliveries) map.set(String(d.order), d);
  return map;
}

async function serializeOrders(orders) {
  const map = await attachDeliveries(orders);
  return orders.map((o) => serializeDelivery(o, map.get(String(o._id)) || null));
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const CUSTOMER_LINKS = {
  tracking: (orderId) => `/src/pages/customer/order-tracking.html?orderId=${encodeURIComponent(orderId)}`,
  history: () => '/src/pages/customer/order-history.html',
};

const STAFF_LINKS = {
  // With an orderId the rider's queue opens scrolled to + highlighted on that
  // card (deliveries.html reads `?orderId=`), which is what makes a "you have
  // work" notification actionable instead of dropping them on an empty list.
  deliveries: (orderId) =>
    orderId
      ? `/src/pages/delivery/deliveries.html?orderId=${encodeURIComponent(orderId)}`
      : '/src/pages/delivery/deliveries.html',
  history: () => '/src/pages/delivery/history.html',
};

const MANAGER_LINKS = {
  deliveries: () => '/src/pages/admin/deliveries.html',
};

async function notifyManagement({ order, title, message, type = 'status_update' }) {
  const { SYSTEM_ADMIN_ROLES: SA } = require('../config/roles');
  const baseQuery = { status: 'ACTIVE', isActive: { $ne: false } };
  const globalQuery = { ...baseQuery, role: { $in: SA } };
  const scopedQuery = { ...baseQuery, role: { $in: ['cafeteria_admin', 'manager'] }, cafeteriaId: order.cafeteriaId };
  const fallbackQuery = { ...baseQuery, role: { $in: ['cafeteria_admin', 'manager'] } };

  try {
    let recipients = await User.find({ $or: [globalQuery, scopedQuery] }).select('_id');
    // Cafeteria staff without a cafeteriaId bound would otherwise be skipped.
    if ((!recipients || recipients.length === 0) && order.cafeteriaId) {
      recipients = await User.find(fallbackQuery).select('_id');
    }
    if (!recipients || recipients.length === 0) return;
    const link = MANAGER_LINKS.deliveries();
    await Promise.all(
      recipients.map((r) =>
        notifyUser(r._id, title, message, type, order.orderId, link, {
          customerName: order.customerName,
          orderType: order.orderType,
          cafeteriaId: order.cafeteriaId || null,
        })
      )
    );
  } catch (error) {
    console.warn('⚠️ Delivery management notification failed:', error.message);
  }
}

// ---------------------------------------------------------------------------
// Socket fan-out (one place, so every producer emits the same rooms/events)
// ---------------------------------------------------------------------------

/**
 * Strip operator-only fields before a delivery summary goes to a room the
 * order's own customer can join.
 *
 * `statusHistory[].note` carries the free-text reason a manager or courier typed
 * (e.g. "rider vehicle broke down, refunding") and `failureNote` is a staff
 * note. The customer has no business seeing those, so the per-order rooms get
 * the timeline without the annotations. Staff rooms and API responses keep the
 * full record.
 */
function customerSafeSummary(summary) {
  if (!summary || typeof summary !== 'object') return summary;
  const safe = { ...summary };
  if (Array.isArray(summary.statusHistory)) {
    safe.statusHistory = summary.statusHistory.map((entry) => ({
      status: entry.status,
      at: entry.at,
    }));
  }
  if ('failureNote' in safe) safe.failureNote = null;
  return safe;
}

function broadcastStatus(orderSummary) {
  // Keep the payload lean: it is fanned out to every connected client.
  const deliveryPayload = {
    ...orderSummary,
    deliveryId: orderSummary.deliveryId,
    deliveryStatus: orderSummary.deliveryStatus,
  };
  const customerPayload = customerSafeSummary(deliveryPayload);
  emitSocketEvent('delivery', 'order:status', deliveryPayload);
  emitSocketEvent('kitchen', 'order:status', deliveryPayload);
  emitSocketEvent('admin', 'order:status', deliveryPayload);
  emitSocketEvent(`order:${orderSummary.orderId}`, 'order:status', customerPayload);
  // Dedicated delivery event so a tracking page can react to the exact step.
  emitSocketEvent(`delivery:${orderSummary.orderId}`, 'delivery:status', customerPayload);
  emitSocketEvent(`order:${orderSummary.orderId}`, 'delivery:status', customerPayload);
}

/**
 * New orders for dispatch.
 *
 * The plain order summary is not enough for a courier (no route, no distance,
 * no fee), so this sends the delivery tracking payload as well. Managers listen
 * on the admin room, couriers on the delivery room.
 */
function broadcastDispatch(delivery) {
  if (!delivery) return;
  const payload = delivery.toTrackingPayload();
  emitSocketEvent('delivery', 'delivery:dispatch', payload);
  emitSocketEvent('admin', 'delivery:dispatch', payload);
  // The order owner is in this room and only needs to know a rider is on the
  // way - `holdReason` is an operator's free-text note, not customer content.
  emitSocketEvent(`order:${payload.orderId}`, 'delivery:dispatch', {
    ...payload,
    holdReason: null,
  });
}

/**
 * Personal room of the assigned courier: `delivery:<deliveryStaffId>`.
 *
 * Joined automatically on connect for delivery-role sockets (see
 * socket/index.js), so a targeted event reaches ONLY the rider who owns the
 * job - never the whole delivery room. Private order/customer payloads must
 * use this room (or `user:<id>` DMs), never a broadcast.
 */
/**
 * Reduce a staff reference (bare ObjectId, populated doc, serialized summary
 * `{id,...}`, or plain id string) to a room-safe id string. Never trusts
 * `.id` blindly: on a Mongoose ObjectId `.id` is a Buffer, not hex.
 */
function roomIdOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (typeof value === 'object') {
    if (value._id) return roomIdOf(value._id);
    if (typeof value.id === 'string' || typeof value.id === 'number') return String(value.id).trim();
    if (typeof value.toHexString === 'function') {
      try {
        return value.toHexString();
      } catch (e) {}
    }
    const s = String(value);
    if (/^[0-9a-fA-F]{24}$/.test(s)) return s;
    return '';
  }
  return '';
}

function staffRoomOf(order, delivery) {
  // Accept live documents AND serialized summaries. The first usable id wins;
  // an unusable candidate can never shadow a real one.
  const candidates = [
    delivery && delivery.deliveryPerson,
    order && order.deliveryPersonId,
    order && order.deliveryStaffAssigned,
  ];
  for (const candidate of candidates) {
    const id = roomIdOf(candidate);
    if (id && id !== '[object Object]') return `delivery:${id}`;
  }
  return null;
}

/**
 * Fan a named lifecycle event out to exactly the audience that may see it:
 * the dispatch rooms (delivery + admin), the order room (customer tracking),
 * and the assigned courier's personal room. The payload is the full summary
 * for staff rooms and the customer-safe summary for the order room.
 */
function emitLifecycleEvent(orderSummary, event) {
  const customerPayload = customerSafeSummary(orderSummary);
  emitSocketEvent('delivery', event, orderSummary);
  emitSocketEvent('admin', event, orderSummary);
  emitSocketEvent(`order:${orderSummary.orderId}`, event, customerPayload);
  const staffRoom = staffRoomOf(orderSummary, orderSummary);
  if (staffRoom) emitSocketEvent(staffRoom, event, orderSummary);
}

// ---------------------------------------------------------------------------
// Shared list filter (GET /deliveries and GET /deliveries/staff/:staffId/orders)
// ---------------------------------------------------------------------------

/**
 * Apply the `status` / `report` query params to an already-scoped delivery
 * filter. Shared by the dispatch list and the per-courier order list so a
 * manager sees identical semantics on both screens.
 *
 * `report=completed|cancelled|failed` narrows to one terminal outcome.
 * `status=ACTIVE` (or omitting `status` entirely) means live work;
 * `status=ALL` deliberately adds NO $or restriction: it means "every delivery
 * order in my scope", terminal ones included. It used to fall through to the
 * active-only branch, so completed / failed / cancelled deliveries never
 * reached the Manager Dashboard.
 */
function applyDeliveryListStatusFilter(filter, query) {
  const { status, report } = query || {};

  // Every delivery order that still counts as live work. `ACTIVE` is an
  // explicit alias for this set, so a caller that wants it no longer has to
  // rely on omitting `status` (which is indistinguishable from a mistake).
  const activeStatusOr = [
    {
      orderStatus: {
        $in: MY_ACTIVE_STATUSES_UPPER,
      },
    },
    {
      status: {
        $in: MY_ACTIVE_STATUSES_LOWER,
      },
    },
  ];
  const requestedStatus = status ? String(status).toUpperCase() : '';

  if (report === 'completed') {
    // Terminal only. A delivery that is merely DELIVERED is still the
    // courier's active work until it is completed, so it must not show up in
    // a "completed" report (that would duplicate the active list).
    filter.$or = [{ orderStatus: 'COMPLETED' }, { status: 'Completed' }, { status: 'completed' }];
  } else if (report === 'cancelled') {
    filter.$or = [{ orderStatus: 'CANCELLED' }, { status: 'cancelled' }];
  } else if (report === 'failed') {
    filter.$or = [{ orderStatus: 'FAILED' }, { status: 'failed' }];
  } else if (requestedStatus && requestedStatus !== 'ALL') {
    filter.$or =
      requestedStatus === 'ACTIVE'
        ? activeStatusOr
        : [{ orderStatus: requestedStatus }, { status: requestedStatus.toLowerCase() }, { status: requestedStatus }];
  } else if (!requestedStatus) {
    // No status requested at all: default to the active list, as before.
    filter.$or = activeStatusOr;
  }

  return filter;
}

// ---------------------------------------------------------------------------
// Route: GET /api/v1/deliveries
// ---------------------------------------------------------------------------

/**
 * @desc    Get delivery orders (active + completed, filterable)
 * @route   GET /api/v1/deliveries
 * @access  Private/Admin + Delivery
 * Query: status (READY | OUT_FOR_DELIVERY | DELIVERED | ...), report=completed|cancelled|failed
 *
 * A delivery courier only ever sees their OWN assigned deliveries here. They
 * have no dispatch authority, so a cafeteria-wide queue would leak another
 * rider's customer, address and phone number. Managers/admins keep the full
 * cafeteria view.
 */
exports.getDeliveryOrders = async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    const isCourier = role === 'delivery';

    // Scope by the caller's cafeteria (never trusts query/body cafeteriaId).
    // System admins are global; cafeteria staff see only their cafeteria.
    let scope;
    try {
      scope = resolveDeliveryListScope(req);
    } catch (scopeError) {
      return res
        .status(scopeError.statusCode || HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: scopeError.message });
    }

    const filter = { orderType: 'delivery', ...cafeteriaFilter(scope) };

    // Server-side ownership for couriers. The client also filters with
    // isAssignedToMe(), but that is cosmetic - the query itself is the control.
    if (isCourier) {
      filter.deliveryStaffAssigned = req.user.id;
    }

    // Every delivery order that still counts as live work, or whatever
    // `status` / `report` asked for - see applyDeliveryListStatusFilter().
    applyDeliveryListStatusFilter(filter, req.query);

    const orders = await Order.find(filter)
      .populate('deliveryStaffAssigned', 'name phone role')
      .sort({ orderTime: -1 });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: orders.length,
      orders: await serializeOrders(orders),
    });
  } catch (error) {
    console.error('❌ Get Delivery Orders Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get deliveries assigned to the current delivery staff
 * @route   GET /api/v1/deliveries/mine
 * @access  Private/Delivery
 */
exports.getMyDeliveries = async (req, res) => {
  try {
    // Identity comes ONLY from the JWT (req.user.id) - never from the client.
    // Includes PENDING/PREPARING so an assignment appears immediately and the
    // rider can Accept before the kitchen marks the order READY.
    const orders = await Order.find(myActiveDeliveryFilter(req.user.id, {}))
      .populate('deliveryStaffAssigned', 'name phone role')
      .sort({ orderTime: 1 });

    await deliveryService.touchCourier(req.user.id);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: orders.length,
      orders: await serializeOrders(orders),
    });
  } catch (error) {
    console.error('❌ Get My Deliveries Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Unassigned, kitchen-ready deliveries awaiting dispatch
 * @route   GET /api/v1/deliveries/available
 * @access  Private/Delivery + Management (read-only dispatch board)
 *
 * Why this exists: a courier whose manager has not assigned them anything
 * sees an empty "Delivery Queue" with no path forward. This lists the
 * unassigned orders that are actually ready at the kitchen so the rider can
 * see real work exists and ask for dispatch. It never assigns: dispatch
 * stays management-only (PATCH /:id/assign).
 */
exports.getAvailableDeliveries = async (req, res) => {
  try {
    let scope;
    try {
      scope = resolveDeliveryListScope(req);
    } catch (scopeError) {
      return res
        .status(scopeError.statusCode || HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: scopeError.message });
    }

    // Kitchen-ready only: the food must exist before a courier can act.
    // Pending/preparing orders are the kitchen's work, not the rider's.
    const orders = await Order.find({
      orderType: 'delivery',
      ...cafeteriaFilter(scope),
      deliveryStaffAssigned: null,
      $or: [
        { orderStatus: { $in: ['READY', 'READY_FOR_DELIVERY'] } },
        { status: { $in: ['ready', 'ready_for_delivery'] } },
      ],
    })
      .populate('deliveryStaffAssigned', 'name phone role')
      .sort({ orderTime: 1 })
      .limit(50);

    const deliveries = await Delivery.find({ order: { $in: orders.map((o) => o._id) } })
      .select('order status deliveryPerson');
    const eligible = new Set(
      deliveries
        .filter((d) => !d.deliveryPerson && (d.status === DELIVERY_STATUS.REQUESTED || d.status === DELIVERY_STATUS.ASSIGNED))
        .map((d) => String(d.order))
    );

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: orders.filter((o) => eligible.has(String(o._id))).length,
      orders: await serializeOrders(orders.filter((o) => eligible.has(String(o._id)))),
    });
  } catch (error) {
    console.error('❌ Get Available Deliveries Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get completed delivery history for the current delivery staff
 * @route   GET /api/v1/deliveries/my-history
 * @access  Private/Delivery
 */
exports.getMyDeliveryHistory = async (req, res) => {
  try {
    // Terminal states ONLY. DELIVERED is intentionally excluded: it is still on
    // the courier's active list until they complete it, so including it here
    // would show the same delivery in both lists at once.
    // Optional narrow to a single terminal outcome (?status=completed). The
    // courier "Past Deliveries" view needs COMPLETED on its own so that a run of
    // failed/cancelled rows cannot push real completions past the limit below.
    const wanted = String(req.query?.status || '').trim().toUpperCase();
    const terminalOr =
      wanted === 'COMPLETED'
        ? [{ orderStatus: 'COMPLETED' }, { status: 'Completed' }, { status: 'completed' }]
        : [
            { orderStatus: { $in: FINAL_STATUSES_UPPER } },
            { status: { $in: FINAL_STATUSES_LOWER } },
          ];

    const orders = await Order.find({
      orderType: 'delivery',
      deliveryStaffAssigned: req.user.id,
      $or: terminalOr,
    })
      .populate('deliveryStaffAssigned', 'name phone role')
      .sort({ orderTime: -1 })
      .limit(50);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: orders.length,
      orders: await serializeOrders(orders),
    });
  } catch (error) {
    console.error('❌ Get My Delivery History Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------------------
// Route: GET /api/v1/deliveries/:id
// ---------------------------------------------------------------------------

/**
 * @desc    Get a single delivery (order + route + live courier location)
 * @route   GET /api/v1/deliveries/:id
 * @access  Private - the customer who owns it, the assigned courier, or management
 */
exports.getDelivery = async (req, res) => {
  try {
    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }
    if (order.orderType !== 'delivery') {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ success: false, error: 'This order is not a delivery order' });
    }

    const role = normalizeRole(req.user.role);
    const isOwner = String(order.userId) === String(req.user.id);
    const isCourier = assignedStaffId(order) === String(req.user.id) || deliveryStaffId(delivery) === String(req.user.id);
    if (!isOwner && !isCourier && !isManagerActor(role)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'You are not allowed to view this delivery' });
    }

    const summary = serializeDelivery(order, delivery);

    // Live tracking payload: latest real fix + the route the map needs.
    let lastPoint = null;
    if (delivery) {
      lastPoint = await DeliveryLocation.findOne({ delivery: delivery._id })
        .sort({ timestamp: -1 })
        .select('latitude longitude accuracy timestamp')
        .lean();
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      delivery: summary,
      order: summary,
      tracking: {
        deliveryId: summary.deliveryId,
        orderId: summary.orderId,
        status: summary.deliveryStatus,
        statusLabel: summary.deliveryStatusLabel,
        destination: {
          address: summary.destination.address,
          note: summary.destination.note,
          latitude: summary.latitude,
          longitude: summary.longitude,
          hasCoordinates: summary.hasCoordinates,
        },
        pickupLocation: summary.pickupLocation,
        courier: {
          id: summary.deliveryPersonId,
          name: summary.deliveryStaffAssigned ? summary.deliveryStaffAssigned.name : null,
          phone: summary.deliveryStaffAssigned ? summary.deliveryStaffAssigned.phone : null,
        },
        courierLocation: lastPoint || summary.currentLocation || null,
        distanceKm: summary.distanceKm,
        etaMinutes: summary.etaMinutes,
        statusHistory: summary.statusHistory,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('❌ Get Delivery Error:', error);
    sendError(res, error, MESSAGES.SERVER_ERROR);
  }
};

// ---------------------------------------------------------------------------
// Route: GET /api/v1/deliveries/active
// ---------------------------------------------------------------------------

/**
 * @desc    Get the caller's active deliveries (default: own; staff/manager: queue)
 * @route   GET /api/v1/deliveries/active
 * @access  Private
 */
exports.getActiveDeliveries = async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    const mine = String(req.query.mine || '').toLowerCase() === 'true' || role === 'delivery';

    let filter;
    if (mine) {
      filter = myActiveDeliveryFilter(req.user.id, {});
    } else {
      let scope;
      try {
        scope = resolveDeliveryListScope(req);
      } catch (scopeError) {
        return res
          .status(scopeError.statusCode || HTTP_STATUS.FORBIDDEN)
          .json({ success: false, error: scopeError.message });
      }
      filter = { orderType: 'delivery', ...cafeteriaFilter(scope) };
    }

    filter.$or = [
      { orderStatus: { $in: MY_ACTIVE_STATUSES_UPPER } },
      { status: { $in: MY_ACTIVE_STATUSES_LOWER } },
    ];

    const orders = await Order.find(filter)
      .populate('deliveryStaffAssigned', 'name phone role')
      .sort({ orderTime: 1 });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: orders.length,
      orders: await serializeOrders(orders),
    });
  } catch (error) {
    console.error('❌ Get Active Deliveries Error:', error);
    sendError(res, error, MESSAGES.SERVER_ERROR);
  }
};

// ---------------------------------------------------------------------------
// Route: GET /api/v1/deliveries/history
// ---------------------------------------------------------------------------

/**
 * @desc    Get delivery history (own for customers, cafeteria-wide for staff)
 * @route   GET /api/v1/deliveries/history
 * @access  Private
 * Query: status=delivered|failed|cancelled|all, limit
 */
exports.getDeliveryHistory = async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    const requested = String(req.query.status || 'all').toLowerCase();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    // "delivered" here means FINISHED: only the terminal states. A delivery that
    // is merely DELIVERED is still open work on the courier's active list.
    const terminalClauses = {
      delivered: [{ orderStatus: 'COMPLETED' }, { status: 'Completed' }, { status: 'completed' }],
      failed: [{ orderStatus: 'FAILED' }, { status: 'failed' }],
      cancelled: [{ orderStatus: 'CANCELLED' }, { status: 'cancelled' }],
    };

    let filter;
    if (role === 'customer') {
      // A customer may only ever read their OWN deliveries.
      filter = { orderType: 'delivery', userId: req.user.id };
    } else if (role === 'delivery' || String(req.query.mine || '').toLowerCase() === 'true') {
      filter = { orderType: 'delivery', deliveryStaffAssigned: req.user.id };
    } else {
      let scope;
      try {
        scope = resolveDeliveryListScope(req);
      } catch (scopeError) {
        return res
          .status(scopeError.statusCode || HTTP_STATUS.FORBIDDEN)
          .json({ success: false, error: scopeError.message });
      }
      filter = { orderType: 'delivery', ...cafeteriaFilter(scope) };
    }

    if (requested === 'all') {
      filter.$or = [
        ...terminalClauses.delivered,
        ...terminalClauses.failed,
        ...terminalClauses.cancelled,
      ];
    } else {
      filter.$or = terminalClauses[requested] || terminalClauses.delivered;
    }

    const orders = await Order.find(filter)
      .populate('deliveryStaffAssigned', 'name phone role')
      .sort({ updatedAt: -1 })
      .limit(limit);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: orders.length,
      orders: await serializeOrders(orders),
    });
  } catch (error) {
    console.error('❌ Get Delivery History Error:', error);
    sendError(res, error, MESSAGES.SERVER_ERROR);
  }
};

// ---------------------------------------------------------------------------
// Route: POST /api/v1/deliveries
// ---------------------------------------------------------------------------

/**
 * @desc    Create (or return the existing) delivery record for a delivery order
 * @route   POST /api/v1/deliveries
 * @access  Private - customer (own order), kitchen or management
 * Body: { orderId, deliveryAddress?, latitude?, longitude?, note?, phone? }
 *
 * Idempotent: an order can only ever have one Delivery (unique index on
 * `order`), so a retried call returns the same record instead of duplicating.
 */
exports.createDelivery = async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    const reference = req.body.orderId || req.body.order || req.body.id;
    if (!reference) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'orderId is required' });
    }

    const order = await findOrderByIdentifier(reference);
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }
    if (order.orderType !== 'delivery') {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ success: false, error: 'This order is not a delivery order' });
    }

    // A customer may only create a delivery for their own order.
    if (role === 'customer' && String(order.userId) !== String(req.user.id)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'You can only create a delivery for your own order' });
    }

    let delivery = order.delivery ? await Delivery.findById(order.delivery) : null;
    if (delivery) {
      return res.status(HTTP_STATUS.OK).json({
        success: true,
        duplicate: true,
        message: `Delivery for order #${order.orderId} already exists`,
        delivery: serializeDelivery(order, delivery),
      });
    }

    delivery = await deliveryService.ensureDeliveryForOrder(order);
    if (!delivery) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ success: false, error: 'This order is not a delivery order' });
    }

    await order.populate('deliveryStaffAssigned', 'name phone role');
    const summary = serializeDelivery(order, delivery);

    emitSocketEvent('delivery', 'delivery:new', summary);
    emitSocketEvent('admin', 'delivery:new', summary);

    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      message: `Delivery created for order #${order.orderId}`,
      delivery: summary,
    });
  } catch (error) {
    console.error('❌ Create Delivery Error:', error);
    sendError(res, error, 'Failed to create the delivery');
  }
};

// ---------------------------------------------------------------------------
// Route: PATCH /api/v1/deliveries/:id/assign
// ---------------------------------------------------------------------------

/**
 * @desc    Assign (or reassign) delivery staff to a delivery
 * @route   PATCH /api/v1/deliveries/:id/assign
 * @access  Private/Manager
 * Body: { deliveryStaffId }
 */
/**
 * Core of EVERY courier assignment.
 *
 * The manager route (`PATCH /deliveries/:id/assign`), the delivery-issue
 * reassignment path and the kitchen's auto-dispatch all funnel through this one
 * function, so a rider picked by the kitchen behaves exactly like a rider a
 * manager clicked: same guards (role, active, cafeteria, capacity, assignable
 * state), same writes, same state-machine move, same audit row and the same
 * rider/customer/management notifications.
 *
 * @param {object}  options.order    Order document (orderType 'delivery')
 * @param {object}  options.delivery Delivery document for that order
 * @param {object}  options.staff    User document of the courier to attach
 * @param {object}  options.actor    { id, name, role, cafeteriaId } performing the assignment
 * @param {string}  [options.reason] Extra context for the state-history row
 * @param {string}  [options.source] Who triggered it ('manager_assign' | 'kitchen_send_to_delivery')
 * @returns {Promise<{ok:true, summary, message, assignedStaff}|{ok:false, statusCode:number, error:string}>}
 */
async function assignStaffToDelivery({ order, delivery, staff, actor, reason = null, source = 'manager_assign' }) {
  try {
    if (!staff || normalizeRole(staff.role) !== 'delivery') {
      return {
        ok: false,
        statusCode: HTTP_STATUS.BAD_REQUEST,
        error: 'Selected user is not a delivery staff member',
      };
    }
    if (staff.status !== 'ACTIVE' || staff.isActive === false) {
      return { ok: false, statusCode: HTTP_STATUS.BAD_REQUEST, error: 'Selected delivery staff is not active' };
    }
    if (!order || order.orderType !== 'delivery') {
      return { ok: false, statusCode: HTTP_STATUS.BAD_REQUEST, error: 'Order is not a delivery order' };
    }

    // Cross-cafeteria isolation: delivery staff can only be assigned to orders
    // belonging to the same cafeteria as their user record (null cafeteriaId
    // on either side is treated as the default single-cafeteria tenant and is
    // allowed only when both sides are null-or-matching).
    const orderCafeteriaId = order.cafeteriaId ? String(order.cafeteriaId) : null;
    const staffCafeteriaId = staff.cafeteriaId ? String(staff.cafeteriaId) : null;
    if (orderCafeteriaId && staffCafeteriaId && orderCafeteriaId !== staffCafeteriaId) {
      return {
        ok: false,
        statusCode: HTTP_STATUS.FORBIDDEN,
        error: 'Delivery staff and order must belong to the same cafeteria',
      };
    }
    // Management assigning from cafeteria A cannot place a rider onto a
    // different cafeteria's order (when the actor has a cafeteria binding).
    const actorCafeteriaId = actor && actor.cafeteriaId ? String(actor.cafeteriaId) : null;
    if (actorCafeteriaId && orderCafeteriaId && actorCafeteriaId !== orderCafeteriaId) {
      return {
        ok: false,
        statusCode: HTTP_STATUS.FORBIDDEN,
        error: 'You can only assign delivery staff to orders in your cafeteria',
      };
    }

    const previousStaffId = deliveryStaffId(delivery) || assignedStaffId(order);
    let previousStaff = null;
    if (previousStaffId) {
      previousStaff = await User.findById(previousStaffId).select('name');
    }

    const isReassign = Boolean(previousStaffId) && previousStaffId !== String(staff._id);

    // Capacity guard: warn-free hard stop only when the courier is already at
    // the configured limit, so a manager cannot silently overbook a rider.
    const settings = await getSettingsMap();
    const maxActive = Number(settings.delivery_max_active_per_staff) || 0;
    if (maxActive > 0 && !isReassign) {
      const activeCount = await Order.countDocuments({
        orderType: 'delivery',
        deliveryStaffAssigned: staff._id,
        $or: [
          { orderStatus: { $in: MY_ACTIVE_STATUSES_UPPER } },
          { status: { $in: MY_ACTIVE_STATUSES_LOWER } },
        ],
      });
      if (activeCount >= maxActive) {
        return {
          ok: false,
          statusCode: HTTP_STATUS.CONFLICT,
          error: `${staff.name} already has ${activeCount} active deliveries (limit ${maxActive}). Reassign or wait first.`,
        };
      }
    }

    // Assignment is only legal while a courier can still be attached, or when
    // reviving a failed delivery (retry). A reassignment always applies because
    // the rider changes and the previous one is being released.
    const retryable = delivery.status === DELIVERY_STATUS.FAILED;
    if (!isReassign && !retryable && !deliveryService.isAssignable(delivery.status)) {
      return {
        ok: false,
        statusCode: HTTP_STATUS.CONFLICT,
        error: `Cannot assign delivery staff to a ${humanize(delivery.status).toLowerCase()} delivery`,
      };
    }

    // A retry (reassigning a FAILED delivery) is tracked separately from a
    // plain handoff, and it clears the failure that ended the previous attempt.
    const isRetry = delivery.status === DELIVERY_STATUS.FAILED;
    const isSameCourier = previousStaffId === String(staff._id);

    delivery.deliveryPerson = staff._id;
    delivery.assignedAt = new Date();
    delivery.assignedBy = actor && actor.id ? actor.id : null;
    delivery.acceptanceStatus = 'PENDING_ACCEPTANCE';
    delivery.declineReason = null;
    if (isRetry) {
      delivery.retryCount = (delivery.retryCount || 0) + 1;
      delivery.lastRetryAt = new Date();
      delivery.failureReason = null;
      delivery.failureNote = null;
      delivery.failedAt = null;
    }
    await delivery.save();

    order.deliveryStaffAssigned = staff._id;
    order.delivery = delivery._id;
    order.deliveryAssignedAt = delivery.assignedAt;
    order.deliveryAcceptanceStatus = 'PENDING_ACCEPTANCE';
    order.deliveryAcceptedAt = null;
    order.deliveryAcceptedBy = null;
    order.deliveryFailureReason = null;
    await order.save();
    await order.populate('deliveryStaffAssigned', 'name phone role');

    // Update delivery staff availability: new staff becomes unavailable,
    // previous staff (on reassignment) becomes available again.
    if (isReassign && previousStaff) {
      await User.updateOne({ _id: previousStaff._id }, { isAvailable: true });
    }
    await User.updateOne({ _id: staff._id }, { isAvailable: false });

    // Move the state machine. A fresh assignment or a retry goes to ASSIGNED.
    // A reassignment of a delivery that is already physically moving keeps its
    // position (the food is on the road) - the new courier must still accept.
    if (
      delivery.status === DELIVERY_STATUS.REQUESTED ||
      delivery.status === DELIVERY_STATUS.FAILED
    ) {
      await deliveryService.applyDeliveryStatus({
        delivery,
        status: DELIVERY_STATUS.ASSIGNED,
        actor,
        reason: reason || (isRetry
          ? `Delivery retried and reassigned to: ${staff.name}`
          : `Delivery staff assigned: ${staff.name}`),
        allowTerminal: true,
      });
    }

    await order.populate('deliveryStaffAssigned', 'name phone role');
    const summary = serializeDelivery(order, delivery);

    const assignmentLabel = isRetry
      ? `Delivery retried: ${previousStaff ? previousStaff.name : 'previous courier'} -> ${staff.name}`
      : isReassign
        ? `Delivery staff reassigned: ${previousStaff ? previousStaff.name : 'unassigned'} -> ${staff.name}`
        : `Delivery staff assigned: ${staff.name}`;

    await OrderStatusHistory.create({
      orderId: order._id,
      previousStatus: effectiveStatus(order, delivery),
      newStatus: effectiveStatus(order, delivery),
      changedBy: actor && actor.id ? actor.id : null,
      reason: assignmentLabel,
    });

    await logAction({
      // logAction reads the actor (+ip) off `req`; the kitchen has no manager
      // request object of its own, so a bare { user } wrapper is enough here.
      req: { user: actor || {} },
      action: isRetry ? 'DELIVERY_RETRIED' : isReassign ? 'DELIVERY_REASSIGNED' : 'DELIVERY_ASSIGNED',
      entityType: 'Order',
      entityId: String(order._id),
      description: `${isRetry ? 'Retried' : isReassign ? 'Reassigned' : 'Assigned'} delivery of order #${order.orderId} to ${staff.name} (${reason || 'manual dispatch'})`,
      result: 'SUCCESS',
      metadata: {
        deliveryStaffId: String(staff._id),
        previousStaffId: previousStaffId || null,
        retryCount: delivery.retryCount,
        source,
      },
    });

    // --- Notifications -------------------------------------------------
    // New courier: a new delivery / reassignment / retry notification.
    // The link deep-links to their queue, already scrolled to this order.
    await notifyUser(
      staff._id,
      isRetry ? 'Delivery Retry Assigned' : isReassign ? 'Delivery Reassigned to You' : 'Delivery Assigned!',
      isRetry
        ? `The failed delivery of order #${order.orderId} has been assigned to you again. Please accept it.`
        : isReassign
          ? `Order #${order.orderId} has been reassigned to you. Please accept it.`
          : `You have been assigned to deliver order #${order.orderId}.`,
      'delivery_assigned',
      order.orderId,
      STAFF_LINKS.deliveries(order.orderId),
      // `assignment` is an explicit tag (not a title match) so the delivery
      // Notifications page can offer a real "Assignments" filter. `deliveryId`
      // lets the panel deep-link straight to the delivery record.
      { orderType: 'delivery', assignment: true, reassigned: isReassign, retry: isRetry, deliveryId: summary.deliveryId }
    );

    // Previous courier: they no longer own this delivery.
    if (previousStaffId && !isSameCourier) {
      await notifyUser(
        previousStaffId,
        isRetry ? 'Delivery Retry Reassigned' : 'Delivery Reassigned',
        isRetry
          ? `Order #${order.orderId} failed and has been retried by another delivery person.`
          : `Order #${order.orderId} has been reassigned to another delivery person.`,
        'delivery_assigned',
        order.orderId,
        STAFF_LINKS.deliveries(),
        { orderType: 'delivery', assignment: true, unassigned: true, deliveryId: summary.deliveryId }
      );
      emitSocketEvent(`user:${previousStaffId}`, 'delivery:unassigned', {
        orderId: order.orderId,
        deliveryId: summary.deliveryId,
        reason: isRetry ? 'RETRY' : 'REASSIGNED',
      });
    }

    // Customer: a rider is on the way to their order.
    if (order.userId) {
      await notifyUser(
        order.userId,
        isRetry ? 'Delivery Retried' : isReassign ? 'Delivery Rider Updated' : 'Delivery Rider Assigned',
        isRetry
          ? `We are retrying the delivery of your order #${order.orderId} with a rider.`
          : isReassign
            ? `A new delivery rider has been assigned to your order #${order.orderId}.`
            : `A delivery rider has been assigned to your order #${order.orderId}.`,
        'status_update',
        order.orderId,
        CUSTOMER_LINKS.tracking(order.orderId),
        { orderType: 'delivery', courierName: staff.name, deliveryId: summary.deliveryId }
      );
    }

    // --- Realtime ------------------------------------------------------
    broadcastStatus(summary);
    const assignedEvent = isRetry ? 'delivery:retried' : 'delivery:assigned';
    emitSocketEvent('delivery', assignedEvent, summary);
    emitSocketEvent('admin', assignedEvent, summary);
    emitSocketEvent(`user:${staff._id}`, assignedEvent, summary);
    // The new courier needs the route details, which a status summary omits.
    broadcastDispatch(delivery);

    return {
      ok: true,
      summary,
      delivery,
      order,
      assignedStaff: staff,
      isRetry,
      isReassign,
      message: isRetry
        ? `Order #${order.orderId} retried with ${staff.name}`
        : isReassign
          ? `Order #${order.orderId} reassigned to ${staff.name}`
          : `Delivery staff ${staff.name} assigned to order #${order.orderId}`,
    };
  } catch (error) {
    console.error('❌ Assign Delivery Error:', error);
    return {
      ok: false,
      statusCode: error.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR,
      error: error.message || 'Failed to assign delivery staff',
    };
  }
}

/**
 * The thin HTTP shell around the assignment core: resolve the route's `:id`
 * plus the body's `deliveryStaffId`, then let assignStaffToDelivery() decide.
 *
 * Kept separate so the kitchen's auto-dispatch can call the SAME core without
 * faking an Express request/response pair.
 */
async function assignCourier(req, res, payload) {
  try {
    const { deliveryStaffId: requestedId } = payload;
    if (!requestedId) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'deliveryStaffId is required' });
    }
    if (!mongoose.Types.ObjectId.isValid(String(requestedId))) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ success: false, error: 'deliveryStaffId is not a valid user id' });
    }

    const staff = await User.findById(requestedId);
    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }

    const outcome = await assignStaffToDelivery({ order, delivery, staff, actor: req.user });
    if (!outcome.ok) {
      return res.status(outcome.statusCode || HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: outcome.error,
      });
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: outcome.message,
      order: outcome.summary,
      delivery: outcome.summary,
    });
  } catch (error) {
    console.error('❌ Assign Delivery Error:', error);
    sendError(res, error, 'Failed to assign delivery staff');
  }
}

/**
 * Rank the couriers the kitchen's "Send to Delivery" may hand the order to.
 *
 * Ordered so the least busy rider of the order's own cafeteria goes first:
 *   1. ACTIVE riders of the order's cafeteria (or with no cafeteria binding),
 *   2. riders who are not currently marked offline,
 *   3. fewest active deliveries,
 *   4. longest-standing account (fairness between otherwise equal riders).
 *
 * The whole list is returned, not just the head: the caller walks it and the
 * first candidate that passes every guard in assignStaffToDelivery() (capacity
 * being the usual one) gets the job, so one full rider never parks an order
 * nobody owns while idle riders sit next to them.
 *
 * @returns {Promise<import('mongoose').Document[]>} ranked candidates (may be empty)
 */
async function pickFreeRiders({ order }) {
  const orderCafeteriaId = order && order.cafeteriaId ? String(order.cafeteriaId) : null;
  const filter = {
    role: { $in: ['delivery', 'delivery_staff', 'DELIVERY_STAFF', 'driver', 'rider'] },
    status: 'ACTIVE',
    isActive: { $ne: false },
  };
  if (orderCafeteriaId) {
    filter.$or = [{ cafeteriaId: null }, { cafeteriaId: orderCafeteriaId }];
  }

  const candidates = await User.find(filter).select('_id name role status isActive cafeteriaId isAvailable createdAt');
  if (!candidates.length) return [];

  const loadOf = async (userId) => {
    try {
      return await Order.countDocuments({
        orderType: 'delivery',
        deliveryStaffAssigned: userId,
        $or: [
          { orderStatus: { $in: MY_ACTIVE_STATUSES_UPPER } },
          { status: { $in: MY_ACTIVE_STATUSES_LOWER } },
        ],
      });
    } catch (e) {
      return 0;
    }
  };

  const orderCaf = orderCafeteriaId;
  const scored = [];
  for (const rider of candidates) {
    const riderCaf = rider.cafeteriaId ? String(rider.cafeteriaId) : null;
    // Same-cafeteria riders beat legacy riders with no binding at all.
    const sameCafeteria = Boolean(orderCaf && riderCaf && orderCaf === riderCaf);
    scored.push({
      rider,
      sameCafeteria,
      online: rider.isAvailable !== false,
      active: await loadOf(rider._id),
    });
  }

  scored.sort((a, b) => {
    if (a.sameCafeteria !== b.sameCafeteria) return a.sameCafeteria ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    if (a.active !== b.active) return a.active - b.active;
    return new Date(a.rider.createdAt || 0).getTime() - new Date(b.rider.createdAt || 0).getTime();
  });

  return scored.map((entry) => entry.rider);
}

exports.assignStaffToDelivery = assignStaffToDelivery;
exports.pickFreeRiders = pickFreeRiders;

exports.assignDelivery = (req, res) => assignCourier(req, res, req.body || {});

exports.claimDelivery = async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    if (role !== 'delivery') {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'Only delivery staff can claim a delivery' });
    }

    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }
    if (order.orderType !== 'delivery') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Order is not a delivery order' });
    }
    const alreadyAssigned = assignedStaffId(order) || deliveryStaffId(delivery);
    if (alreadyAssigned) {
      if (alreadyAssigned === String(req.user.id)) {
        const summary = serializeDelivery(order, delivery);
        return res.status(HTTP_STATUS.OK).json({
          success: true,
          message: `Order #${order.orderId} is already assigned to you`,
          order: summary,
          delivery: summary,
        });
      }
      return res.status(HTTP_STATUS.CONFLICT).json({ success: false, error: 'This delivery is already assigned' });
    }
    const staff = await User.findById(req.user.id);
    if (!staff) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery staff not found' });
    }

    const outcome = await assignStaffToDelivery({ order, delivery, staff, actor: req.user, source: 'courier_claim' });
    if (!outcome.ok) {
      return res.status(outcome.statusCode || HTTP_STATUS.BAD_REQUEST).json({ success: false, error: outcome.error });
    }

    await deliveryService.applyDeliveryStatus({
      delivery,
      status: DELIVERY_STATUS.ACCEPTED,
      actor: req.user,
      reason: 'Delivery staff claimed and accepted this delivery',
      allowTerminal: true,
    });

    await order.populate('deliveryStaffAssigned', 'name phone role');
    const summary = serializeDelivery(order, delivery);
    emitLifecycleEvent(summary, 'delivery:accepted');
    broadcastStatus(summary);

    res.status(HTTP_STATUS.OK).json({ success: true, message: `Order #${order.orderId} claimed`, order: summary, delivery: summary });
  } catch (error) {
    console.error('❌ Claim Delivery Error:', error);
    sendError(res, error, 'Failed to claim delivery');
  }
};

/** Backwards-compatible alias used by the existing admin UI. */
exports.assignDeliveryStaff = exports.assignDelivery;

// ---------------------------------------------------------------------------
// Route: PATCH /api/v1/deliveries/:id/accept
// ---------------------------------------------------------------------------

/**
 * @desc    Accept or decline an assigned delivery
 * @route   PATCH /api/v1/deliveries/:id/accept
 * @access  Private/Delivery
 * Body: { accept: true|false, reason? }
 */
exports.respondToAssignment = async (req, res) => {
  try {
    const accept = req.body.accept === true || req.body.accept === 'true';
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    const role = normalizeRole(req.user.role);

    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }
    if (order.orderType !== 'delivery') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Order is not a delivery order' });
    }

    const assignedTo = deliveryStaffId(delivery) || assignedStaffId(order);
    if (role === 'delivery' && assignedTo !== String(req.user.id)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'This order is not assigned to you' });
    }
    if (role !== 'delivery' && !isManagerActor(role)) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'You cannot respond to this assignment' });
    }

    if (accept) {
      await deliveryService.applyDeliveryStatus({
        delivery,
        status: DELIVERY_STATUS.ACCEPTED,
        actor: req.user,
        reason: reason ? `Delivery staff accepted the assignment: ${reason}` : 'Delivery staff accepted the assignment',
        allowTerminal: true,
      });
    } else {
      delivery.acceptanceStatus = 'DECLINED';
      delivery.declineReason = reason || 'Declined by delivery staff';
      await delivery.save();
      order.deliveryAcceptanceStatus = 'DECLINED';
      await order.save();
      await OrderStatusHistory.create({
        orderId: order._id,
        previousStatus: effectiveStatus(order, delivery),
        newStatus: effectiveStatus(order, delivery),
        changedBy: req.user.id,
        reason: `Delivery staff declined the assignment${reason ? `: ${reason}` : ''}`,
      });
    }

    await order.populate('deliveryStaffAssigned', 'name phone role');
    const summary = serializeDelivery(order, delivery);

    emitSocketEvent('delivery', 'delivery:assignment', summary);
    // The assigned courier's own dashboard advances on the explicit accept
    // event (not just the generic order:status below): scope it to the
    // dispatch rooms, the order room, and ONLY that courier's personal room.
    // (emitLifecycleEvent already covers delivery + admin, so no second emit
    // here - one frame per room, no duplicates.)
    if (accept) emitLifecycleEvent(summary, 'delivery:accepted');
    else emitLifecycleEvent(summary, 'delivery:declined');
    broadcastStatus(summary);

    if (accept) {
      // Customer: their rider confirmed the run.
      if (order.userId) {
        await notifyUser(
          order.userId,
          'Delivery Accepted',
          `Your delivery rider accepted order #${order.orderId} and will pick it up shortly.`,
          'status_update',
          order.orderId,
          CUSTOMER_LINKS.tracking(order.orderId),
          { orderType: 'delivery' }
        );
      }
      // Management: a rider accepted.
      await notifyManagement({
        order,
        title: 'Delivery Accepted',
        message: `The delivery rider accepted order #${order.orderId}.`,
      });
    } else {
      // Management: dispatch must know the rider bailed out.
      await notifyManagement({
        order,
        title: 'Delivery Declined',
        message: `The delivery rider declined order #${order.orderId}. Please reassign it.`,
      });
    }

    await logAction({
      req,
      action: accept ? 'DELIVERY_ACCEPTED' : 'DELIVERY_DECLINED',
      entityType: 'Order',
      entityId: String(order._id),
      description: `${req.user.name || req.user.email} ${accept ? 'accepted' : 'declined'} delivery of order #${order.orderId}`,
      result: 'SUCCESS',
      metadata: { reason: reason || null },
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: accept
        ? `Assignment for order #${order.orderId} accepted`
        : `Assignment for order #${order.orderId} declined`,
      order: summary,
      delivery: summary,
    });
  } catch (error) {
    console.error('❌ Respond To Assignment Error:', error);
    sendError(res, error, 'Failed to respond to the assignment');
  }
};

/** Explicit alias for the accept path (used by the tracking UI). */
exports.acceptDelivery = async (req, res) => {
  req.body = { ...(req.body || {}), accept: true };
  return exports.respondToAssignment(req, res);
};

// ---------------------------------------------------------------------------
// Status transitions: pickup / out-for-delivery / arrived / delivered
// ---------------------------------------------------------------------------

/**
 * Shared implementation for every state move. Guarantees that:
 *  - the state machine is obeyed (no illegal jumps)
 *  - the assigned courier is the only delivery staff who may act
 *  - the customer + management are notified exactly once per real transition
 */
/**
 * Shared implementation of the pickup / out-for-delivery / arrived / failed /
 * cancelled transitions.
 *
 * Contract: returns the outcome object on success, or `null` when it has
 * already written a rejection response. Callers use `if (!outcome) return;` to
 * detect the rejection, so a rejection MUST return null and never the
 * `res.json()` result - `res.json()` returns the response object, which is
 * truthy, and would make every caller run its success/notify path on a failed
 * transition.
 */
async function moveDelivery({ req, res, target, reason, allowTerminal = false, failure = null }) {
  const role = normalizeRole(req.user.role);
  const { order, delivery } = await resolveDeliveryPair(req.params.id);
  if (!order || !delivery) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    return null;
  }
  if (order.orderType !== 'delivery') {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Order is not a delivery order' });
    return null;
  }

  const isManager = isManagerActor(role);
  if (role === 'delivery') {
    const assignedTo = deliveryStaffId(delivery) || assignedStaffId(order);
    if (assignedTo !== String(req.user.id)) {
      res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'This order is not assigned to you' });
      return null;
    }
  } else if (!isManager) {
    res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'You cannot update this delivery' });
    return null;
  }

  // A courier may only pick up after explicitly accepting the assignment.
  if (
    target === DELIVERY_STATUS.PICKED_UP &&
    role === 'delivery' &&
    delivery.acceptanceStatus !== 'ACCEPTED' &&
    !isManager
  ) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: 'You must accept the delivery assignment before picking up this order',
    });
    return null;
  }

  // A courier may only pick up once the kitchen has actually finished the food.
  // Without this the rider can collect a cold, half-made order while the kitchen
  // board still says PREPARING, and the customer is told the order is "on the
  // way" before it exists. Management can still force a pickup to recover a
  // stuck order, and logs it.
  if (target === DELIVERY_STATUS.PICKED_UP && !isManager && !isKitchenReady(order)) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: 'This order is not ready for pickup yet. Wait for the kitchen to mark it ready.',
      code: 'ORDER_NOT_READY',
      kitchenState: kitchenReadyState(order),
    });
    return null;
  }

  // A manager holding a delivery owns the outcome. The courier cannot mark it
  // delivered (or close it out) while it is held, so an open problem can never
  // be quietly closed by the person who reported it. Releasing the hold (or
  // resolving the last open issue) clears `onHold` automatically.
  if (
    [DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.COMPLETED].includes(target) &&
    delivery.onHold &&
    !isManager
  ) {
    res.status(HTTP_STATUS.CONFLICT).json({
      success: false,
      error:
        'This delivery is on hold while a reported problem is being handled. A manager must release it before it can be completed.',
      code: 'DELIVERY_ON_HOLD',
    });
    return null;
  }

  const result = await deliveryService.applyDeliveryStatus({
    delivery,
    status: target,
    actor: req.user,
    reason,
    failureReason: failure ? failure.reason : null,
    failureNote: failure ? failure.note : null,
    allowTerminal,
  });

  await order.populate('deliveryStaffAssigned', 'name phone role');
  const summary = serializeDelivery(order, result.delivery);

  await logAction({
    req,
    action: `DELIVERY_${target}`,
    entityType: 'Order',
    entityId: String(order._id),
    description: `Order #${order.orderId}: ${humanize(result.from)} -> ${humanize(target)}`,
    result: 'SUCCESS',
    metadata: { from: result.from, to: target, failure: failure || undefined },
  });

  broadcastStatus(summary);

  // The specific `delivery:<status>` event, for listeners that care about which
  // step just happened rather than any status change. It lives here, inside
  // moveDelivery, so EVERY route that advances a delivery emits it: the
  // dedicated endpoints (pickup, arrived, delivered, complete) and the generic
  // status endpoint. Emitting it only in the generic handler left the dedicated
  // endpoints - including completion - silently unannounced.
  const eventName = `delivery:${target.toLowerCase()}`;
  emitSocketEvent('delivery', eventName, summary);
  emitSocketEvent('admin', eventName, summary);
  // Canonical lifecycle aliases the customer tracker and the courier queue
  // listen for: `delivery:started` when the food starts moving,
  // `delivery:completed` when the job closes out. Scoped to the order room
  // and the owning courier's personal room (never a broadcast).
  if (target === DELIVERY_STATUS.OUT_FOR_DELIVERY) emitLifecycleEvent(summary, 'delivery:started');
  if (target === DELIVERY_STATUS.COMPLETED) emitLifecycleEvent(summary, 'delivery:completed');

  return {
    order,
    delivery: result.delivery,
    summary,
    from: result.from,
    to: target,
    isManager,
    actorId: req.user.id,
  };
}

const CUSTOMER_STEP_MESSAGES = {
  [DELIVERY_STATUS.PICKED_UP]: {
    title: 'Order Picked Up',
    message: (orderId) => `Your order #${orderId} has been picked up by our delivery rider and is heading your way.`,
  },
  [DELIVERY_STATUS.OUT_FOR_DELIVERY]: {
    title: 'Driver On The Way',
    message: (orderId) => `Your order #${orderId} is out for delivery. Our delivery person is on the way!`,
  },
  [DELIVERY_STATUS.ARRIVED]: {
    title: 'Your Order Has Arrived',
    message: (orderId) => `Your order #${orderId} has arrived at your location. Please receive your delivery.`,
  },
  [DELIVERY_STATUS.DELIVERED]: {
    title: 'Order Delivered',
    message: (orderId) => `Your order #${orderId} has been handed over. Enjoy your meal!`,
  },
  [DELIVERY_STATUS.COMPLETED]: {
    title: 'Order Completed',
    message: (orderId) => `Your order #${orderId} is complete. Thanks for ordering with us!`,
  },
  [DELIVERY_STATUS.FAILED]: {
    title: 'Delivery Failed',
    message: (orderId) => `We could not deliver your order #${orderId}. Our team will contact you shortly.`,
  },
  [DELIVERY_STATUS.CANCELLED]: {
    title: 'Delivery Cancelled',
    message: (orderId) => `The delivery for your order #${orderId} has been cancelled.`,
  },
};

/**
 * Courier-facing copy for each lifecycle step.
 *
 * A status absent here produces NO courier row: REQUESTED and ASSIGNED are
 * covered by the assignment notice (meta.assignment), which the panel files
 * under "Assignments" rather than "Status Updates". Everything a rider can
 * observe moving forward on their own job is listed here.
 */
const COURIER_STEP_MESSAGES = {
  [DELIVERY_STATUS.ACCEPTED]: {
    title: 'Delivery Accepted',
    message: (orderId) => `You accepted delivery of order #${orderId}.`,
  },
  [DELIVERY_STATUS.PICKED_UP]: {
    title: 'Order Picked Up',
    message: (orderId) => `Order #${orderId} has been picked up. Start delivery when you are on the way.`,
  },
  [DELIVERY_STATUS.OUT_FOR_DELIVERY]: {
    title: 'Out For Delivery',
    message: (orderId) => `Order #${orderId} is now out for delivery.`,
  },
  [DELIVERY_STATUS.ARRIVED]: {
    title: 'Arrived At Destination',
    message: (orderId) => `You arrived with order #${orderId}. Hand it over to complete the delivery.`,
  },
  [DELIVERY_STATUS.DELIVERED]: {
    title: 'Order Delivered',
    message: (orderId) => `Order #${orderId} has been handed over. Nice work!`,
  },
  [DELIVERY_STATUS.COMPLETED]: {
    title: 'Delivery Completed',
    message: (orderId) => `Order #${orderId} is complete. Thanks for delivering with us!`,
  },
  [DELIVERY_STATUS.FAILED]: {
    title: 'Delivery Marked Failed',
    message: (orderId) => `Order #${orderId} was marked as a failed delivery.`,
  },
  [DELIVERY_STATUS.CANCELLED]: {
    title: 'Delivery Cancelled',
    message: (orderId) => `Order #${orderId} has been cancelled.`,
  },
};

async function notifyStepRecipients({ order, target, failure, actorId, delivery, summary, deliveryId }) {
  // The delivery record id, so the panel can link a status row to the delivery
  // itself. Every call site already spreads the moveDelivery() result (which
  // carries `delivery` and `summary`), so this resolves without them having to
  // pass anything extra.
  const stepDeliveryId =
    deliveryId ||
    (summary && summary.deliveryId) ||
    (delivery && delivery._id ? String(delivery._id) : null) ||
    null;

  const step = CUSTOMER_STEP_MESSAGES[target];
  if (step && order.userId) {
    await notifyUser(
      order.userId,
      step.title,
      step.message(order.orderId),
      'status_update',
      order.orderId,
      CUSTOMER_LINKS.tracking(order.orderId),
      {
        orderType: 'delivery',
        deliveryStatus: target,
        failureReason: failure ? failure.reason : null,
        deliveryId: stepDeliveryId,
      }
    );
  }

  // The assigned courier is told about EVERY lifecycle step on their own
  // delivery, not just the terminal failures. Each row is stamped with
  // `meta.deliveryStatus` so the Notifications page can offer a real
  // "Status Updates" filter instead of leaving that tab permanently empty for
  // riders - previously only the customer ever received this tag, so a courier
  // had no row that could ever satisfy that filter.
  //
  // `deliveryStaffAssigned` may be a bare ObjectId OR a populated User
  // document (list endpoints populate it). String()-ing a populated document
  // produced a "{ _id: ..., name: ... }" blob, so Notification.userId failed
  // its ObjectId cast - the courier silently got no "run ended" notice on
  // every failed/cancelled delivery. Reduce both shapes to the real id.
  const courierId = assignedStaffId(order) || '';
  const courierIsActor = courierId && courierId === String(actorId || '');
  if (courierId && !courierIsActor) {
    const courierStep = COURIER_STEP_MESSAGES[target];
    // A step with no courier-facing copy (e.g. REQUESTED/ASSIGNED, which the
    // assignment notice already covers) must not fall through to a blank row.
    if (courierStep) {
      const terminal = target === DELIVERY_STATUS.FAILED || target === DELIVERY_STATUS.CANCELLED;
      await notifyUser(
        courierId,
        courierStep.title,
        courierStep.message(order.orderId),
        'delivery_status',
        order.orderId,
        STAFF_LINKS.deliveries(),
        {
          orderType: 'delivery',
          deliveryStatus: target,
          deliveryId: stepDeliveryId,
          // FAILED/CANCELLED carry the reason so the panel's "Problems" filter can
          // match them on a real field. Without it these rows were indistinguishable
          // from an ordinary status step and landed in BOTH "Status Updates" and
          // "Problems" (the panel treats a terminal status as a problem on its own).
          failureReason: terminal ? (failure && failure.reason) || target : null,
        }
      );
    }
  }

  if ([DELIVERY_STATUS.ARRIVED, DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.COMPLETED, DELIVERY_STATUS.FAILED, DELIVERY_STATUS.CANCELLED].includes(target)) {
    await notifyManagement({
      order,
      title:
        target === DELIVERY_STATUS.ARRIVED
          ? 'Delivery Arrived'
          : target === DELIVERY_STATUS.DELIVERED
            ? 'Delivery Delivered'
            : target === DELIVERY_STATUS.COMPLETED
              ? 'Delivery Completed'
              : target === DELIVERY_STATUS.FAILED
                ? 'Delivery Failed'
                : 'Delivery Cancelled',
      message: `Order #${order.orderId} is now ${humanize(target).toLowerCase()}.`,
      type: 'status_update',
    });
  }
}

/**
 * @desc    Mark a delivery as picked up from the kitchen
 * @route   PATCH /api/v1/deliveries/:id/pickup
 * @access  Private/Delivery + Admin
 * Changes: ACCEPTED (order READY) -> PICKED_UP
 */
exports.pickUpOrder = async (req, res) => {
  try {
    const outcome = await moveDelivery({
      req,
      res,
      target: DELIVERY_STATUS.PICKED_UP,
      reason: 'Delivery staff picked up the order from the kitchen',
    });
    if (!outcome || res.headersSent) return undefined;
    await notifyStepRecipients({ ...outcome, target: DELIVERY_STATUS.PICKED_UP });
    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${outcome.order.orderId} picked up. Start delivery when you are on the way.`,
      order: outcome.summary,
      delivery: outcome.summary,
    });
  } catch (error) {
    console.error('❌ Pick Up Order Error:', error);
    return sendError(res, error, 'Failed to pick up this order');
  }
};

/**
 * @desc    Mark a delivery as out for delivery
 * @route   PATCH /api/v1/deliveries/:id/out-for-delivery
 * @access  Private/Delivery + Admin
 * Changes: PICKED_UP -> OUT_FOR_DELIVERY
 */
exports.markOutForDelivery = async (req, res) => {
  try {
    const outcome = await moveDelivery({
      req,
      res,
      target: DELIVERY_STATUS.OUT_FOR_DELIVERY,
      reason: 'Delivery started',
    });
    if (!outcome || res.headersSent) return undefined;
    await notifyStepRecipients({ ...outcome, target: DELIVERY_STATUS.OUT_FOR_DELIVERY });
    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${outcome.order.orderId} is now out for delivery`,
      order: outcome.summary,
      delivery: outcome.summary,
    });
  } catch (error) {
    console.error('❌ Mark Out For Delivery Error:', error);
    return sendError(res, error, 'Failed to start this delivery');
  }
};

/**
 * @desc    Mark a delivery as arrived at the customer location
 * @route   PATCH /api/v1/deliveries/:id/arrived
 * @access  Private/Delivery + Admin
 * Changes: OUT_FOR_DELIVERY -> ARRIVED
 */
exports.markArrived = async (req, res) => {
  try {
    const outcome = await moveDelivery({
      req,
      res,
      target: DELIVERY_STATUS.ARRIVED,
      reason: 'Delivery arrived at customer location',
    });
    if (!outcome || res.headersSent) return undefined;
    await notifyStepRecipients({ ...outcome, target: DELIVERY_STATUS.ARRIVED });
    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${outcome.order.orderId} has arrived at the customer location`,
      order: outcome.summary,
      delivery: outcome.summary,
    });
  } catch (error) {
    console.error('❌ Mark Arrived Error:', error);
    return sendError(res, error, 'Failed to mark this delivery as arrived');
  }
};

/**
 * @desc    Mark a delivery as delivered, enforcing proof of delivery.
 * @route   PATCH /api/v1/deliveries/:id/delivered
 * @access  Private/Delivery + Admin
 * Changes: ARRIVED -> DELIVERED
 *
 * A courier cannot complete a run on their own word. They must present a
 * proof photo, a verified customer OTP, or a manager must override with a
 * reason. See services/delivery.service.markDeliveredWithProof.
 *
 * @body    { proofNote?, otp?, overrideReason? }
 */
exports.markDelivered = async (req, res) => {
  try {
    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }

    const role = normalizeRole(req.user.role);
    const isManager = isManagerActor(role);

    // Ownership. This endpoint writes the handover directly (it does not go
    // through moveDelivery), so the check has to live here too: without it any
    // authenticated courier could hand over somebody else's delivery by
    // attaching a proof photo. Identity comes from the JWT only.
    if (!isManager) {
      const assignedTo = deliveryStaffId(delivery) || assignedStaffId(order);
      if (assignedTo !== String(req.user.id)) {
        return res
          .status(HTTP_STATUS.FORBIDDEN)
          .json({ success: false, error: 'This order is not assigned to you' });
      }
    }

    // A manager holding a delivery owns the outcome: the courier cannot close the
    // handover while a reported problem is open.
    if (delivery.onHold && !isManager) {
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error:
          'This delivery is on hold while a reported problem is being handled. A manager must release it before it can be completed.',
        code: 'DELIVERY_ON_HOLD',
      });
    }

    // A manager may override the proof requirement, but only with a reason.
    const wantsOverride = Boolean(req.body.overrideReason) || Boolean(req.body.isManagerOverride);
    if (wantsOverride && !isManager) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'Only a manager or admin can override the delivery proof requirement.' });
    }

    const result = await deliveryService.markDeliveredWithProof({
      delivery,
      actor: req.user,
      proofPhoto: req.body.proofPhoto || null,
      proofNote: req.body.proofNote || null,
      otp: req.body.otp !== undefined ? req.body.otp : null,
      isManagerOverride: wantsOverride,
      overrideReason: req.body.overrideReason || null,
    });

    // Restore delivery staff availability after successful delivery
    if (result.delivery && result.delivery.deliveryPerson) {
      try {
        await User.updateOne({ _id: result.delivery.deliveryPerson }, { isAvailable: true });
      } catch (err) {
        console.error('Failed to restore delivery staff availability:', err);
      }
    }

    await order.populate('deliveryStaffAssigned', 'name phone role');
    const summary = serializeDelivery(order, result.delivery);

    // The customer must see "Delivered" turn green the moment the handover is
    // proven. This endpoint writes the status itself (markDeliveredWithProof)
    // rather than going through moveDelivery, so it never hit broadcastStatus -
    // which left the customer's tracking stuck on "Arrived" until they refreshed,
    // or until the separate Completed step happened to fire.
    broadcastStatus(summary);

    // The stage-specific event, matching what moveDelivery emits for every other
    // step, so listeners can react to this exact transition.
    emitSocketEvent('delivery', `delivery:${DELIVERY_STATUS.DELIVERED.toLowerCase()}`, summary);
    emitSocketEvent('admin', `delivery:${DELIVERY_STATUS.DELIVERED.toLowerCase()}`, summary);

    await notifyStepRecipients({ ...result, target: DELIVERY_STATUS.DELIVERED });

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${order.orderId} marked as delivered`,
      order: summary,
      delivery: summary,
      proof: summary.proof,
    });
  } catch (error) {
    console.error('❌ Mark Delivered Error:', error);
    return sendError(res, error, 'Failed to mark this delivery as delivered');
  }
};

/**
 * @desc    Close out a delivered order (the final step)
 * @route   PATCH /api/v1/deliveries/:id/complete
 * @access  Private/Delivery (assigned) + Admin
 * Changes: DELIVERED -> COMPLETED
 *
 * This is the step that finalises the ORDER (orderStatus COMPLETED,
 * completedTime set). It is deliberately separate from /delivered so that:
 *   - the courier still owns the delivery after the handover is proven, and the
 *     active list never drops a delivery the courier has not finished;
 *   - the customer timeline shows "Delivered" and "Completed" as two real,
 *     individually verified moments instead of one compressed jump.
 *
 * Ownership, role, on-hold and exact-next-transition are all enforced by
 * moveDelivery(); no extra proof is required here because the proof was
 * already demanded at DELIVERED.
 *
 * @body    { reason? }
 */
exports.markCompleted = async (req, res) => {
  try {
    const outcome = await moveDelivery({
      req,
      res,
      target: DELIVERY_STATUS.COMPLETED,
      reason: String(req.body.reason || '').slice(0, 300) || 'Delivery completed by the assigned courier',
    });
    if (!outcome || res.headersSent) return undefined;
    await notifyStepRecipients({ ...outcome, target: DELIVERY_STATUS.COMPLETED });
    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${outcome.order.orderId} completed`,
      order: outcome.summary,
      delivery: outcome.summary,
    });
  } catch (error) {
    console.error('❌ Mark Completed Error:', error);
    return sendError(res, error, 'Failed to complete this delivery');
  }
};

/**
 * @desc    Upload a proof-of-delivery photo for a delivery.
 * @route   POST /api/v1/deliveries/:id/proof/photo
 * @access  Private/Delivery (assigned) + Admin
 *
 * The photo is stored through the same provider switch as issue photos
 * (S3 / GCS / local) but in its own `delivery-proofs` folder. The returned URL
 * is then passed to PATCH /:id/delivered as `proofPhoto`.
 */
exports.uploadProofPhoto = async (req, res) => {
  try {
    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }

    const role = normalizeRole(req.user.role);
    const isManager = isManagerActor(role);
    const assignedTo = deliveryStaffId(delivery) || assignedStaffId(order);
    if (role === 'delivery' && assignedTo !== String(req.user.id)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'This order is not assigned to you' });
    }
    if (role !== 'delivery' && !isManager) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'You cannot upload proof for this delivery' });
    }

    if (!req.file) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'A proof photo file is required' });
    }

    const { uploadDeliveryProofPhoto } = require('../utils/cloudUpload');
    const uploaded = await uploadDeliveryProofPhoto(req.file.buffer, req.file.mimetype, req.file.originalname);

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Proof photo uploaded',
      proofPhoto: uploaded.url,
    });
  } catch (error) {
    console.error('❌ Upload Proof Photo Error:', error);
    return sendError(res, error, 'Failed to upload the proof photo');
  }
};

/**
 * @desc    Generate (or refresh) the customer OTP for a delivery.
 * @route   POST /api/v1/deliveries/:id/otp/generate
 * @access  Private/Delivery (assigned) + Admin
 *
 * The code is sent to the customer through the normal notification channel. It
 * is never returned in the response.
 */
exports.generateOtp = async (req, res) => {
  try {
    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }

    const role = normalizeRole(req.user.role);
    const isManager = isManagerActor(role);
    const assignedTo = deliveryStaffId(delivery) || assignedStaffId(order);
    if (role === 'delivery' && assignedTo !== String(req.user.id)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'This order is not assigned to you' });
    }
    if (role !== 'delivery' && !isManager) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'You cannot generate a code for this delivery' });
    }

    const result = await deliveryService.generateDeliveryOtp({ delivery, actor: req.user });

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'A delivery code was sent to the customer.',
      expiresAt: result.expiresAt,
      // Only present in development, so a developer can still exercise the
      // flow without reading the customer's notifications.
      devOtp: result.devOtp,
    });
  } catch (error) {
    console.error('❌ Generate OTP Error:', error);
    return sendError(res, error, 'Failed to generate the delivery code');
  }
};

/**
 * @desc    Verify a customer OTP against a delivery.
 * @route   POST /api/v1/deliveries/:id/otp/verify
 * @access  Private/Delivery (assigned) + Admin
 * @body    { otp: string }
 *
 * On success the delivery is marked confirmedByCustomer, which counts as proof
 * of delivery on its own.
 */
exports.verifyOtp = async (req, res) => {
  try {
    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }

    const role = normalizeRole(req.user.role);
    const isManager = isManagerActor(role);
    const assignedTo = deliveryStaffId(delivery) || assignedStaffId(order);
    if (role === 'delivery' && assignedTo !== String(req.user.id)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'This order is not assigned to you' });
    }
    if (role !== 'delivery' && !isManager) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'You cannot verify a code for this delivery' });
    }

    const ok = await deliveryService.verifyDeliveryOtp({ delivery, otp: req.body.otp });

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      verified: ok,
      confirmedByCustomer: Boolean(delivery.confirmedByCustomer),
      message: ok
        ? 'Delivery code accepted. The customer has confirmed the handover.'
        : 'That code is not correct. The customer can request a new one.',
    });
  } catch (error) {
    console.error('❌ Verify OTP Error:', error);
    return sendError(res, error, 'Failed to verify the delivery code');
  }
};

/**
 * @desc    Read the proof of delivery for a completed delivery.
 * @route   GET /api/v1/deliveries/:id/proof
 * @access  Private - the order's customer, the assigned courier, or management
 *
 * The OTP is never included. The photo URL is included only for audiences that
 * are allowed to see it.
 */
exports.getProof = async (req, res) => {
  try {
    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }

    const role = normalizeRole(req.user.role);
    const isManager = isManagerActor(role);
    const isCourier = role === 'delivery' && deliveryStaffId(delivery) === String(req.user.id);
    const customerId = order.userId ? String(order.userId) : '';
    const isCustomer = customerId === String(req.user.id);

    if (!isManager && !isCourier && !isCustomer) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'You are not allowed to view the proof for this delivery' });
    }

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      orderId: delivery.orderId,
      deliveredAt: delivery.deliveredAt,
      proof: {
        photo: delivery.proofPhoto || null,
        note: delivery.proofNote || null,
        confirmedByCustomer: Boolean(delivery.confirmedByCustomer),
        verifiedAt: delivery.proofVerifiedAt || null,
        overridden: Boolean(delivery.proofOverrideBy),
        overrideReason: delivery.proofOverrideReason || null,
      },
      statusHistory: (delivery.statusHistory || []).map((h) => ({
        status: h.status,
        at: h.at,
        note: h.note || '',
      })),
    });
  } catch (error) {
    console.error('❌ Get Proof Error:', error);
    return sendError(res, error, 'Failed to load the proof of delivery');
  }
};

/**
 * @desc    Raise a delivery emergency (SOS).
 * @route   POST /api/v1/deliveries/:id/emergency
 * @access  Private/Delivery (assigned courier only)
 * @body    { latitude?, longitude?, accuracy? }
 *
 * The rider's own device supplies the GPS fix. A denied permission is not an
 * error: the emergency is still created with locationAvailable false, because
 * "no fix" must never stop an SOS reaching a manager.
 */
exports.triggerEmergency = async (req, res) => {
  try {
    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }

    const emergency = await deliveryService.triggerEmergency({
      delivery,
      actor: req.user,
      latitude: req.body.latitude,
      longitude: req.body.longitude,
      accuracy: req.body.accuracy,
    });

    return res.status(HTTP_STATUS.CREATED).json({
      success: true,
      message: 'Emergency raised. Managers of your cafeteria have been alerted.',
      emergency: emergency.toEmergencyPayload(),
    });
  } catch (error) {
    console.error('❌ Trigger Emergency Error:', error);
    return sendError(res, error, 'Failed to raise the emergency');
  }
};

/**
 * @desc    Acknowledge a delivery emergency.
 * @route   PATCH /api/v1/deliveries/:id/emergency/ack
 * @access  Private/Management only
 *
 * This is the only way an ACTIVE emergency leaves the ACTIVE state, which is
 * what keeps the manager banner and alarm going until a human responds.
 */
exports.acknowledgeEmergency = async (req, res) => {
  try {
    const { delivery } = await resolveDeliveryPair(req.params.id);
    if (!delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }

    const emergency = await deliveryService.getActiveEmergency(delivery._id);
    if (!emergency) {
      return res
        .status(HTTP_STATUS.NOT_FOUND)
        .json({ success: false, error: 'There is no active emergency for this delivery' });
    }

    const updated = await deliveryService.acknowledgeEmergency({ emergency, actor: req.user });

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Emergency acknowledged.',
      emergency: updated.toEmergencyPayload(),
    });
  } catch (error) {
    console.error('❌ Acknowledge Emergency Error:', error);
    return sendError(res, error, 'Failed to acknowledge the emergency');
  }
};

/**
 * @desc    Resolve a delivery emergency.
 * @route   PATCH /api/v1/deliveries/:id/emergency/resolve
 * @access  Private/Management, or the assigned courier
 * @body    { note? }
 *
 * Resolving releases the hold this emergency created, but only when no other
 * open issue is still holding the delivery.
 */
exports.resolveEmergency = async (req, res) => {
  try {
    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }

    const role = normalizeRole(req.user.role);
    const isManager = isManagerActor(role);
    const isCourier = role === 'delivery' && deliveryStaffId(delivery) === String(req.user.id);
    if (!isManager && !isCourier) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'Only a manager or the assigned delivery person can resolve this emergency' });
    }

    const emergency = await deliveryService.getOpenEmergency(delivery._id);
    if (!emergency) {
      return res
        .status(HTTP_STATUS.NOT_FOUND)
        .json({ success: false, error: 'There is no active emergency for this delivery' });
    }

    const updated = await deliveryService.resolveEmergency({
      emergency,
      actor: req.user,
      note: req.body.note || null,
    });

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Emergency resolved.',
      emergency: updated.toEmergencyPayload(),
    });
  } catch (error) {
    console.error('❌ Resolve Emergency Error:', error);
    return sendError(res, error, 'Failed to resolve the emergency');
  }
};

/**
 * @desc    List emergencies (manager dashboard).
 * @route   GET /api/v1/deliveries/emergencies
 * @access  Private/Management only
 * @query   status=ACTIVE|ACKNOWLEDGED|RESOLVED|CANCELLED, cafeteriaId?
 */
exports.getEmergencies = async (req, res) => {
  try {
    const DeliveryEmergency = require('../models/DeliveryEmergency');
    const filter = {};
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.cafeteriaId) filter.cafeteriaId = req.query.cafeteriaId;

    const emergencies = await DeliveryEmergency.find(filter).sort({ triggeredAt: -1 }).limit(100);
    return res.status(HTTP_STATUS.OK).json({
      success: true,
      count: emergencies.length,
      emergencies: emergencies.map((e) => e.toEmergencyPayload()),
    });
  } catch (error) {
    console.error('❌ List Emergencies Error:', error);
    return sendError(res, error, 'Failed to list emergencies');
  }
};

const FAILURE_REASONS = [
  'CUSTOMER_UNAVAILABLE',
  'WRONG_ADDRESS',
  'CUSTOMER_REFUSED',
  'PHONE_UNREACHABLE',
  'OUT_OF_REACH',
  'WEATHER',
  'RESTAURANT_ISSUE',
  'OTHER',
];

function parseFailureReason(raw, { required = false } = {}) {
  const reason = String(raw || '').trim().toUpperCase();
  if (!reason) {
    return required
      ? { error: `A valid reason is required. Allowed: ${FAILURE_REASONS.join(', ')}` }
      : { failure: null };
  }
  if (!FAILURE_REASONS.includes(reason)) {
    return { error: `Invalid failure reason "${reason}". Allowed: ${FAILURE_REASONS.join(', ')}` };
  }
  return { failure: reason };
}

async function applyDeliveryStatus(req, res, { status, failureReason, failureNote, reason }) {
  const failure =
    status === DELIVERY_STATUS.FAILED
      ? { reason: failureReason || 'OTHER', note: String(failureNote || '').slice(0, 300) }
      : null;

  const outcome = await moveDelivery({
    req,
    res,
    target: status,
    reason: String(reason || '').slice(0, 300) || `Status set to ${humanize(status)}`,
    failure,
  });
  if (!outcome || res.headersSent) return undefined;

  await notifyStepRecipients({ ...outcome, target: status, failure });

  return res.status(HTTP_STATUS.OK).json({
    success: true,
    message: `Order #${outcome.order.orderId} is now ${humanize(status).toLowerCase()}`,
    order: outcome.summary,
    delivery: outcome.summary,
  });
}

/**
 * @desc    Generic status transition endpoint used by the tracking UI fallback
 * @route   PATCH /api/v1/deliveries/:id/status
 * @access  Private/Delivery (own, while active) + Manager
 * Body: { status, reason?, failureReason?, failureNote? }
 */
exports.updateDeliveryStatus = async (req, res) => {
  try {
    const requested = normalizeStatus(req.body.status);
    if (!requested) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'status is required' });
    }
    if (!Object.prototype.hasOwnProperty.call(deliveryService.STATUS_TO_ORDER, requested)) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ success: false, error: `Unknown delivery status "${req.body.status}"` });
    }

    const { failure, error: reasonError } = parseFailureReason(
      requested === DELIVERY_STATUS.FAILED ? req.body.failureReason : null
    );
    if (reasonError) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: reasonError });
    }

    return await applyDeliveryStatus(req, res, {
      status: requested,
      failureReason: failure,
      failureNote: req.body.failureNote || req.body.reason || '',
      reason: req.body.reason,
    });
  } catch (error) {
    console.error('❌ Update Delivery Status Error:', error);
    return sendError(res, error, 'Failed to update the delivery status');
  }
};

/**
 * @desc    Mark a delivery as failed (courier could not complete it)
 * @route   PATCH /api/v1/deliveries/:id/fail
 * @access  Private/Delivery (own, while active) + Manager
 * Body: { reason, note? }
 */
exports.failDelivery = async (req, res) => {
  try {
    const { failure, error: reasonError } = parseFailureReason(
      req.body.reason || req.body.failureReason,
      { required: true }
    );
    if (reasonError) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: reasonError });
    }

    return await applyDeliveryStatus(req, res, {
      status: DELIVERY_STATUS.FAILED,
      failureReason: failure,
      failureNote: req.body.note || '',
      reason: `Delivery failed: ${failure}`,
    });
  } catch (error) {
    console.error('❌ Fail Delivery Error:', error);
    return sendError(res, error, 'Failed to mark the delivery as failed');
  }
};

/**
 * @desc    Retry a failed delivery (re-assign the same or another courier)
 * @route   POST /api/v1/deliveries/:id/retry
 * @access  Private/Manager
 * Body: { deliveryStaffId? }  (defaults to keeping the current courier)
 */
exports.retryDelivery = async (req, res) => {
  try {
    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }
    if (delivery.status !== DELIVERY_STATUS.FAILED) {
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: 'Only a failed delivery can be retried',
      });
    }

    const target = req.body.deliveryStaffId || delivery.deliveryPerson;
    if (!target) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ success: false, error: 'No delivery person is assigned. Provide deliveryStaffId to retry.' });
    }

    // Reuse the assignment pipeline so the same notifications, audit and
    // realtime events fire (and the state machine stays the only writer).
    return await assignCourier(req, res, { ...req.body, deliveryStaffId: String(target) });
  } catch (error) {
    console.error('❌ Retry Delivery Error:', error);
    return sendError(res, error, 'Failed to retry this delivery');
  }
};

/**
 * @desc    Cancel a delivery (and its order)
 * @route   PATCH /api/v1/deliveries/:id/cancel
 * @access  Private - the customer who owns it (before pickup) or management
 * Body: { reason? }
 */
exports.cancelDelivery = async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }

    const isOwner = String(order.userId) === String(req.user.id);
    if (!isManagerActor(role) && !isOwner) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'You are not allowed to cancel this delivery',
      });
    }
    if (!isManagerActor(role)) {
      const settings = await getSettingsMap();
      if (settings.delivery_allow_customer_cancel === false) {
        return res.status(HTTP_STATUS.FORBIDDEN).json({
          success: false,
          error: 'Self-cancellation is disabled. Please contact the cafeteria.',
        });
      }
      // Once the rider is on the road, a customer can no longer cancel -
      // the food is already moving and stock/inventory is committed.
      if (deliveryService.isGpsAllowed(delivery.status) || delivery.status === DELIVERY_STATUS.ACCEPTED) {
        return res.status(HTTP_STATUS.CONFLICT).json({
          success: false,
          error: 'This delivery has already been picked up and can no longer be cancelled online. Please call the cafeteria.',
        });
      }
    }

    const reason = String(req.body.reason || '').slice(0, 300) || 'Cancelled by request';
    const outcome = await moveDelivery({
      req,
      res,
      target: DELIVERY_STATUS.CANCELLED,
      reason: `Delivery cancelled: ${reason}`,
    });
    if (!outcome || res.headersSent) return undefined;

    order.cancellationReason = reason;
    order.cancellationRequestedBy = req.user.id;
    order.cancellationProcessedBy = req.user.id;
    order.cancellationProcessedAt = new Date();
    order.cancellationStatus = 'approved';
    await order.save();

    await notifyStepRecipients({ ...outcome, target: DELIVERY_STATUS.CANCELLED });

    emitSocketEvent('delivery', 'delivery:cancelled', outcome.summary);
    emitSocketEvent('admin', 'delivery:cancelled', outcome.summary);

    await logAction({
      req,
      action: 'DELIVERY_CANCELLED',
      entityType: 'Order',
      entityId: String(order._id),
      description: `Delivery for order #${order.orderId} cancelled: ${reason}`,
      result: 'SUCCESS',
    });

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Delivery for order #${order.orderId} cancelled`,
      order: outcome.summary,
      delivery: outcome.summary,
    });
  } catch (error) {
    console.error('❌ Cancel Delivery Error:', error);
    return sendError(res, error, 'Failed to cancel this delivery');
  }
};

/**
 * Manager reassignment, callable from another controller.
 *
 * Used by the Delivery Issue flow ("hand this order to someone else"). Delegates
 * to `assignCourier()` so the cafeteria isolation check, the ACTIVE-staff check,
 * the capacity guard, the state-machine handling for an in-flight delivery, the
 * order fields, the notifications to the new/previous courier and the customer,
 * the audit trail and the realtime events are all exactly the normal ones. A
 * reassignment never rewinds a delivery that is already on the road.
 *
 * @param {object} options
 * @param {object} options.issue   The DeliveryIssue document.
 * @param {object} options.actor   The manager performing the reassignment.
 * @param {string} options.deliveryStaffId  Target delivery staff (same cafeteria).
 */
async function assignCourierForIssue({ issue, actor, deliveryStaffId }) {
  let failure = null;
  let body = null;
  const resShim = {
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      if (payload && payload.success === false) {
        failure = { statusCode: this.statusCode, message: payload.error || 'Failed to reassign' };
      }
      this.headersSent = true;
      return this;
    },
  };

  const reqShim = {
    user: actor,
    params: { id: issue.orderId },
    body: { deliveryStaffId: String(deliveryStaffId) },
    ip: undefined,
  };

  await assignCourier(reqShim, resShim, { deliveryStaffId: String(deliveryStaffId) });

  if (failure) {
    const err = new Error(failure.message);
    err.statusCode = failure.statusCode;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Route: POST /api/v1/deliveries/:id/location
// ---------------------------------------------------------------------------

/**
 * Manager-initiated cancellation, callable from another controller.
 *
 * Used by the Delivery Issue flow ("cancel delivery because of this problem").
 * It deliberately reuses `moveDelivery()`, `notifyStepRecipients()` and the same
 * Socket.IO emits as `cancelDelivery` above, so a cancellation triggered from an
 * issue produces byte-for-byte the same side effects as a normal one: identical
 * state-machine handling, order fields, customer/kitchen notifications and
 * realtime events. Nothing is duplicated and no new status path is invented.
 *
 * @param {object} options
 * @param {object} options.issue    The DeliveryIssue document (gives the order).
 * @param {object} options.actor    The manager performing the cancellation.
 * @param {string} options.reason   Human readable reason.
 * @returns {Promise<object>} The moveDelivery outcome.
 */
async function cancelDeliveryForIssue({ issue, actor, reason }) {
  const order = await findOrderByIdentifier(issue.orderId);
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  const text = String(reason || '').slice(0, 300) || 'Delivery problem could not be resolved';

  // moveDelivery() reports failures by writing to `res`. A tiny shim captures
  // that so this reusable function can throw instead of responding twice.
  let failure = null;
  const resShim = {
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      failure = { statusCode: this.statusCode, message: (body && body.error) || 'Failed to cancel' };
      this.headersSent = true;
      return this;
    },
  };

  const reqShim = {
    user: actor,
    params: { id: issue.orderId },
    body: {},
    ip: undefined,
  };

  const outcome = await moveDelivery({
    req: reqShim,
    res: resShim,
    target: DELIVERY_STATUS.CANCELLED,
    reason: `Delivery cancelled: ${text}`,
  });

  if (failure || !outcome) {
    const err = new Error(failure ? failure.message : 'Failed to cancel the delivery');
    err.statusCode = failure ? failure.statusCode : 400;
    throw err;
  }

  // Same order bookkeeping as cancelDelivery.
  order.cancellationReason = text;
  order.cancellationRequestedBy = actor.id;
  order.cancellationProcessedBy = actor.id;
  order.cancellationProcessedAt = new Date();
  order.cancellationStatus = 'approved';
  await order.save();

  await notifyStepRecipients({ ...outcome, target: DELIVERY_STATUS.CANCELLED });

  emitSocketEvent('delivery', 'delivery:cancelled', outcome.summary);
  emitSocketEvent('admin', 'delivery:cancelled', outcome.summary);

  // A cancelled delivery can never be held or auto-completed afterwards.
  if (outcome.delivery) {
    outcome.delivery.onHold = false;
    outcome.delivery.holdReason = null;
    await outcome.delivery.save();
  }

  return outcome;
}

/**
 * @desc    Report the delivery person's current GPS location for an order
 * @route   POST /api/v1/deliveries/:id/location
 * @route   PUT  /api/v1/deliveries/:id/location
 * @route   PUT  /api/v1/delivery/orders/:orderId/location  (documented alias)
 * @access  Private/Delivery (assigned staff only, from JWT)
 * @body    { latitude, longitude, accuracy, timestamp }
 * Only accepted while the delivery is active (PICKED_UP / OUT_FOR_DELIVERY /
 * ARRIVED). Identity comes ONLY from the JWT (req.user set by `protect`); any
 * deliveryStaffId / staffId / userId in the body is deliberately ignored.
 * Coordinates are always the delivery person's real device GPS fix; the server
 * never generates, mocks, or smooths them.
 *
 * Writes:
 *   1) DeliveryLocation                -> append-only GPS history (indexed)
 *   2) Delivery.currentLocation        -> latest fix for the delivery record
 *   3) Order.currentLocation           -> latest fix for the existing tracking UI
 *   4) User.lastKnownLocation          -> latest fix for the manager staff list
 * Then broadcasts `delivery:location` over Socket.IO to the authorized rooms.
 *
 * Rejects (never stores) when the order does not exist, is not a delivery
 * order, is not assigned to the caller, or is cancelled / delivered /
 * completed - so tracking stops the moment the delivery is over, while the last
 * known fix stays in the database for the delivery history.
 */
exports.updateDeliveryLocation = async (req, res) => {
  try {
    // 1) Role must be delivery - from the verified JWT, never from the body.
    if (normalizeRole(req.user.role) !== 'delivery') {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'Only delivery staff can report GPS locations',
      });
    }

    // 2) Resolve the delivery/order pair by id, orderId or delivery id.
    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }
    if (order.orderType !== 'delivery') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Order is not a delivery order' });
    }

    // 3) Assignment check: the rider uploading must be the assigned rider.
    //    Compare against req.user.id (JWT). Client-sent staff ids are never read.
    const assignedTo = deliveryStaffId(delivery) || assignedStaffId(order);
    if (assignedTo !== String(req.user.id)) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'This order is not assigned to you',
      });
    }

    // 4) Only while the delivery is actually active.
    //    The terminal cases are answered explicitly so the client can tell
    //    "you may still track this" apart from "this delivery is over" - a
    //    courier whose browser was offline when the order closed must stop
    //    uploading instead of retrying forever. Both stop the GPS watch: the
    //    last known fix stays in the database, nothing more is written.
    if (delivery.status === 'CANCELLED' || (order.cancellationStatus === 'approved' && order.cancellationRequested)) {
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: 'This delivery was cancelled. GPS tracking has stopped.',
        reason: 'CANCELLED',
        trackingActive: false,
      });
    }
    if (['DELIVERED', 'COMPLETED', 'FAILED'].includes(delivery.status)) {
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: `This delivery is already ${humanize(delivery.status).toLowerCase()}. GPS tracking has stopped.`,
        reason: delivery.status,
        trackingActive: false,
      });
    }
    if (!deliveryService.isGpsAllowed(delivery.status)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `GPS updates are only allowed while the delivery is active (current: ${humanize(delivery.status)})`,
        reason: delivery.status,
        trackingActive: false,
      });
    }

    // 5) Validate payload. Destructure ONLY the allowed coordinate fields -
    //    identity fields in the body (deliveryStaffId, etc.) are never read.
    const { latitude, longitude, accuracy, heading: headingRaw, speed: speedRaw, timestamp } = req.body || {};
    const lat = toLocationNumber(latitude);
    const lng = toLocationNumber(longitude);
    const acc = toLocationNumber(accuracy);
    if (lat === null || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Invalid latitude (must be a number between -90 and 90)',
      });
    }
    if (lng === null || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Invalid longitude (must be a number between -180 and 180)',
      });
    }
    if (acc === null || !Number.isFinite(acc) || acc < 0 || acc > 10000) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Invalid GPS accuracy (must be a number greater than or equal to 0)',
      });
    }
    const movement = validateMovement(headingRaw, speedRaw);
    if (!movement.ok) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: movement.error,
      });
    }
    const tsResult = validateLocationTimestamp(timestamp);
    if (!tsResult.ok) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: tsResult.error,
      });
    }
    const ts = tsResult.date;
    // [GPS] server-side trace: one line per accepted upload so the courier ->
    // customer pipeline can be followed in the logs during debugging.
    console.log(
      `[GPS] API request orderId=${order.orderId} rider=${req.user.id} lat=${lat} lng=${lng} acc=${acc}` +
        ` heading=${movement.heading ?? 'null'} speed=${movement.speed ?? 'null'}`
    );

    // 6) Per-rider rate limit (after validation so bad input cannot burn budget).
    if (locationRateLimited(req.user.id)) {
      return res.status(429).json({
        success: false,
        error: 'Too many location updates. Please slow down.',
      });
    }

    // 7) Duplicate prevention: identical fix retried within the window
    //    (network retry / double submit) -> idempotent success, no new row.
    const lastPoint = await DeliveryLocation.findOne({ delivery: delivery._id })
      .sort({ timestamp: -1 })
      .select('latitude longitude accuracy heading speed timestamp')
      .lean();
    if (
      lastPoint &&
      lastPoint.latitude === lat &&
      lastPoint.longitude === lng &&
      Math.abs(new Date(lastPoint.timestamp).getTime() - ts.getTime()) <= DUPLICATE_POINT_WINDOW_MS
    ) {
      // Keep the mirrors consistent, but skip history insert + re-broadcast.
      const mirror = {
        latitude: lat,
        longitude: lng,
        accuracy: acc,
        heading: movement.heading,
        speed: movement.speed,
        timestamp: ts,
      };
      await Delivery.updateOne({ _id: delivery._id }, { $set: { currentLocation: mirror } });
      await Order.updateOne({ _id: order._id }, { $set: { currentLocation: mirror } });
      const updatedAt = new Date(lastPoint.timestamp).toISOString();
      console.log(`[GPS] duplicate fix (idempotent, not re-broadcast) orderId=${order.orderId}`);
      return res.status(HTTP_STATUS.OK).json({
        success: true,
        duplicate: true,
        point: {
          orderId: order.orderId,
          deliveryStaffId: String(req.user.id),
          latitude: lastPoint.latitude,
          longitude: lastPoint.longitude,
          accuracy: lastPoint.accuracy,
          heading: lastPoint.heading ?? null,
          speed: lastPoint.speed ?? null,
          updatedAt,
          timestamp: updatedAt,
        },
        location: {
          latitude: lastPoint.latitude,
          longitude: lastPoint.longitude,
          accuracy: lastPoint.accuracy,
          heading: lastPoint.heading ?? null,
          speed: lastPoint.speed ?? null,
          updatedAt,
        },
        trackingActive: true,
      });
    }

    // 8) Append to history + mirror the newest fix onto the delivery record,
    //    the order and the courier's user document.
    const point = await deliveryService.recordCourierLocation({
      delivery,
      deliveryPersonId: req.user.id,
      latitude: lat,
      longitude: lng,
      accuracy: acc,
      heading: movement.heading,
      speed: movement.speed,
      timestamp: ts,
    });
    console.log(`[GPS] backend saved location orderId=${order.orderId} deliveryId=${delivery._id}`);

    // 9) Distance from this fix to the customer's drop-off point, on the server.
    //    Haversine (delivery.service.proximityToCustomer), so the courier's
    //    "distance" readout and the customer's map agree to the metre. Advisory
    //    only: `nearCustomer` never advances the delivery - the courier still
    //    has to confirm ARRIVED and DELIVERED by hand.
    const destination = delivery.destination && (delivery.destination.latitude !== null || delivery.destination.address)
      ? delivery.destination
      : buildDestination(order);
    const proximity = deliveryService.proximityToCustomer(
      { latitude: lat, longitude: lng },
      destination
    );

    // 10) Real-time broadcast through the existing Socket.IO instance.
    // Rooms (no global / role-wide GPS room - riders never see each other, and
    // kitchen staff are in neither of these rooms):
    //   delivery:${orderId} - per-order GPS room (order owner, assigned rider,
    //                          management - authorized in delivery:join)
    //   order:${orderId}    - per-order status room (same audience via order:join)
    //   admin               - management dashboard (role-checked in join:admin)
    // Payload carries ONLY the fields consumers need: orderId, deliveryStaffId,
    // latitude, longitude, accuracy, updatedAt (+ the advisory distance to the
    // customer, which the customer and courier dashboards both display).
    const broadcast = {
      orderId: order.orderId,
      deliveryId: String(delivery._id),
      deliveryStaffId: String(req.user.id),
      latitude: lat,
      longitude: lng,
      accuracy: acc,
      heading: point.heading ?? null,
      speed: point.speed ?? null,
      // `updatedAt` is the canonical "when was this fix taken" field.
      // `timestamp` is kept for backwards compatibility with existing consumers.
      updatedAt: point.timestamp.toISOString(),
      timestamp: point.timestamp.toISOString(),
      status: delivery.status,
      hasCustomerLocation: proximity.hasCustomerLocation,
      distanceToCustomerKm: proximity.distanceKm,
      nearCustomer: proximity.nearCustomer,
    };
    emitSocketEvent(`delivery:${order.orderId}`, 'delivery:location', broadcast);
    emitSocketEvent(`order:${order.orderId}`, 'delivery:location', broadcast);
    emitSocketEvent('admin', 'delivery:location', broadcast);
    console.log(
      `[GPS] socket emitted event=delivery:location orderId=${order.orderId}` +
        ` rooms=delivery:${order.orderId},order:${order.orderId},admin`
    );

    // 11) Return the updated location. `point` keeps its original shape so the
    //     existing client keeps working; `location` / `deliveryLocation` /
    //     `customerLocation` are the canonical GPS contract.
    res.status(HTTP_STATUS.OK).json({
      success: true,
      point: broadcast,
      location: {
        latitude: lat,
        longitude: lng,
        accuracy: acc,
        heading: point.heading ?? null,
        speed: point.speed ?? null,
        updatedAt: broadcast.updatedAt,
      },
      deliveryLocation: {
        latitude: lat,
        longitude: lng,
        accuracy: acc,
        heading: point.heading ?? null,
        speed: point.speed ?? null,
        updatedAt: broadcast.updatedAt,
      },
      customerLocation: {
        latitude: destination.latitude ?? null,
        longitude: destination.longitude ?? null,
        address: destination.address || '',
      },
      distanceToCustomerKm: proximity.distanceKm,
      nearCustomer: proximity.nearCustomer,
      trackingActive: true,
    });
  } catch (error) {
    console.error('❌ Update GPS Location Error:', error);
    sendError(res, error, MESSAGES.SERVER_ERROR);
  }
};

/** Explicit alias for the courier-GPS path. */
exports.updateCourierLocation = exports.updateDeliveryLocation;

// ---------------------------------------------------------------------------
// Route: POST /api/v1/deliveries/calculate-fee
// ---------------------------------------------------------------------------

/**
 * @desc    Calculate the delivery fee / distance / ETA for a destination
 * @route   POST /api/v1/deliveries/calculate-fee
 * @route   GET  /api/v1/deliveries/calculate-fee?latitude=&longitude=
 * @access  Private (any authenticated user - checkout needs it before an order)
 * Body: { latitude, longitude, subtotal? }
 *
 * Uses real coordinates only. When the customer has not shared a location, the
 * response falls back to the configured flat fee and says so explicitly.
 */
exports.calculateDeliveryFee = async (req, res) => {
  try {
    const source = req.method === 'GET' ? req.query : req.body || {};
    const settings = await getSettingsMap();

    const hasCoords = deliveryService.isUsableDeliveryCoordinate(source.latitude, source.longitude);
    const lat = hasCoords ? deliveryService.cleanCoordinate(source.latitude, -90, 90) : null;
    const lng = hasCoords ? deliveryService.cleanCoordinate(source.longitude, -180, 180) : null;

    const subtotal = Math.max(0, Number(source.subtotal) || 0);
    const cafeteriaId = (await getDefaultCafeteriaId()) || null;
    const pickup = await deliveryService.resolvePickupLocation(cafeteriaId);

    const distanceKm = hasCoords ? deliveryService.haversineKm({ latitude: lat, longitude: lng }, pickup) : null;
    const quote = deliveryService.calculateDeliveryFee({ distanceKm, subtotal, settings });

    // Development visibility into every quote, so a wrong distance is traceable
    // to its inputs rather than guessed at from the resulting fee.
    console.log(
      `[delivery-quote] cafeteria=(${pickup.latitude},${pickup.longitude}) ` +
      `customer=(${lat},${lng}) distanceKm=${distanceKm} ` +
      `maxDistanceKm=${quote.maxDistanceKm} withinRange=${quote.withinRange} fee=${quote.fee}`
    );

    // The full charge breakdown, so the checkout can show
    // subtotal + delivery fee + service fee + VAT = final total.
    // `deliveryFee` is the same override createOrder uses, so the quoted total
    // is by construction the total that will be charged.
    const charges = await computeOrderCharges({
      subtotal,
      isDelivery: true,
      settings,
      deliveryFee: quote.fee,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      fee: quote.fee,
      deliveryFee: quote.fee,
      mode: quote.mode,
      feeMode: quote.mode,
      distanceKm: quote.distanceKm,
      etaMinutes: quote.etaMinutes,
      estimatedDeliveryTimeMinutes: quote.etaMinutes,
      withinRange: quote.withinRange,
      maxDistanceKm: quote.maxDistanceKm,
      charges,
      pickupLocation: pickup,
      hasCoordinates: hasCoords,
      // Explicit fallback so the UI can say "address-only, flat fee applied".
      message: hasCoords
        ? quote.fee === 0
          ? 'Free delivery applied'
          : `Delivery fee: ${quote.fee} ${charges.currency}`
        : 'No location shared - the standard delivery fee applies',
    });
  } catch (error) {
    console.error('❌ Calculate Delivery Fee Error:', error);
    sendError(res, error, 'Failed to calculate the delivery fee');
  }
};

// ---------------------------------------------------------------------------
// Route: GET /api/v1/deliveries/stats
// ---------------------------------------------------------------------------

/**
 * @desc    Get delivery statistics
 * @route   GET /api/v1/deliveries/stats
 * @access  Private/Delivery + Admin
 */
exports.getDeliveryStats = async (req, res) => {
  try {
    let scope;
    try {
      scope = resolveDeliveryListScope(req);
    } catch (scopeError) {
      return res
        .status(scopeError.statusCode || HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: scopeError.message });
    }

    const base = { orderType: 'delivery', ...cafeteriaFilter(scope) };

    const ready = await Order.countDocuments({ ...base, $or: [{ orderStatus: { $in: ['READY', 'READY_FOR_DELIVERY'] } }, { status: { $in: ['ready', 'ready_for_delivery'] } }] });
    const outForDelivery = await Order.countDocuments({
      ...base,
      $or: [{ orderStatus: 'OUT_FOR_DELIVERY' }, { status: 'out_for_delivery' }],
    });
    const arrived = await Order.countDocuments({
      ...base,
      $or: [{ orderStatus: 'ARRIVED' }, { status: 'arrived' }],
    });
    const delivered = await Order.countDocuments({
      ...base,
      $or: [
        { orderStatus: 'DELIVERED' },
        { status: 'delivered' },
        { status: 'Completed' },
        { orderStatus: 'COMPLETED' },
      ],
    });
    const failed = await Order.countDocuments({
      ...base,
      $or: [{ orderStatus: 'FAILED' }, { status: 'failed' }],
    });
    const cancelled = await Order.countDocuments({
      ...base,
      $or: [{ orderStatus: 'CANCELLED' }, { status: 'cancelled' }],
    });
    const assigned = await Order.countDocuments({
      ...base,
      deliveryStaffAssigned: { $ne: null },
      $or: [
        { orderStatus: { $in: ['READY', 'READY_FOR_DELIVERY', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED'] } },
        { status: { $in: ['ready', 'ready_for_delivery', 'picked_up', 'out_for_delivery', 'arrived'] } },
      ],
    });
    const unassigned = await Order.countDocuments({
      ...base,
      deliveryStaffAssigned: null,
      $or: [
        { orderStatus: { $in: ['PENDING', 'PREPARING', 'READY', 'READY_FOR_DELIVERY'] } },
        { status: { $in: ['pending', 'preparing', 'ready', 'ready_for_delivery'] } },
      ],
    });

    if (normalizeRole(req.user.role) === 'delivery') {
      // All "my*" counts are scoped to the JWT identity - never the cafeteria
      // wide totals (those remain available to managers/admins below).
      const myActive = await Order.countDocuments(myActiveDeliveryFilter(req.user.id, base));
      const myOut = await Order.countDocuments({
        ...base,
        orderType: 'delivery',
        deliveryStaffAssigned: req.user.id,
        $or: [{ orderStatus: 'OUT_FOR_DELIVERY' }, { status: 'out_for_delivery' }],
      });
      const myArrived = await Order.countDocuments({
        ...base,
        orderType: 'delivery',
        deliveryStaffAssigned: req.user.id,
        $or: [{ orderStatus: 'ARRIVED' }, { status: 'arrived' }],
      });
      const myReady = await Order.countDocuments({
        ...base,
        orderType: 'delivery',
        deliveryStaffAssigned: req.user.id,
        $or: [{ orderStatus: { $in: ['READY', 'READY_FOR_DELIVERY'] } }, { status: { $in: ['ready', 'ready_for_delivery'] } }],
      });
      const myDelivered = await Order.countDocuments({
        ...base,
        orderType: 'delivery',
        deliveryStaffAssigned: req.user.id,
        $or: [
          { orderStatus: { $in: ['DELIVERED', 'COMPLETED'] } },
          { status: { $in: ['delivered', 'Completed', 'completed'] } },
        ],
      });
      const myFailed = await Order.countDocuments({
        ...base,
        orderType: 'delivery',
        deliveryStaffAssigned: req.user.id,
        $or: [{ orderStatus: 'FAILED' }, { status: 'failed' }],
      });

      // Delivered-today count + collected totals for the history summary
      // (same JWT-scoped delivered filter, computed once in a single pass).
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const myDeliveryAgg = await Order.aggregate([
        {
          $match: {
            ...base,
            orderType: 'delivery',
            deliveryStaffAssigned: req.user.id,
            $or: [
              { orderStatus: { $in: ['DELIVERED', 'COMPLETED'] } },
              { status: { $in: ['delivered', 'Completed', 'completed'] } },
            ],
          },
        },
        {
          $group: {
            _id: null,
            collected: { $sum: '$totalAmount' },
            deliveryFees: { $sum: '$deliveryFee' },
            avgDeliveryMinutes: {
              $avg: {
                $cond: [
                  {
                    $and: [{ $ne: ['$pickedUpTime', null] }, { $ne: ['$deliveredAt', null] }],
                  },
                  { $divide: [{ $subtract: ['$deliveredAt', '$pickedUpTime'] }, 60000] },
                  null,
                ],
              },
            },
            deliveredToday: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ['$deliveredAt', null] },
                      { $gte: ['$deliveredAt', todayStart] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]);
      const agg = myDeliveryAgg[0] || {};
      const myCollected = Number(agg.collected) || 0;
      const myDeliveredToday = Number(agg.deliveredToday) || 0;
      const avgDeliveryMinutes = Number.isFinite(agg.avgDeliveryMinutes) ? Math.round(agg.avgDeliveryMinutes) : null;

      return res.status(HTTP_STATUS.OK).json({
        success: true,
        stats: {
          ready,
          outForDelivery,
          arrived,
          delivered,
          failed,
          cancelled,
          assigned,
          unassigned,
          myActive,
          myOut,
          myArrived,
          myReady,
          myDelivered,
          myFailed,
          myCollected,
          myDeliveredToday,
          myDeliveryFees: Number(agg.deliveryFees) || 0,
          myAvgDeliveryMinutes: avgDeliveryMinutes,
        },
      });
    }

    // Manager / admin: cafeteria-wide delivery fee + performance totals.
    const feeAgg = await Order.aggregate([
      { $match: base },
      {
        $group: {
          _id: null,
          totalDeliveries: { $sum: 1 },
          deliveryFees: { $sum: '$deliveryFee' },
          revenue: { $sum: '$totalAmount' },
          avgDeliveryMinutes: {
            $avg: {
              $cond: [
                { $and: [{ $ne: ['$pickedUpTime', null] }, { $ne: ['$deliveredAt', null] }] },
                { $divide: [{ $subtract: ['$deliveredAt', '$pickedUpTime'] }, 60000] },
                null,
              ],
            },
          },
        },
      },
    ]);
    const totals = feeAgg[0] || {};
    const totalDeliveries = Number(totals.totalDeliveries) || 0;
    const totalFailed = failed;
    const successRate = totalDeliveries + totalFailed > 0 ? Math.round((delivered / (delivered + totalFailed)) * 100) : null;

    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: {
        ready,
        outForDelivery,
        arrived,
        delivered,
        failed,
        cancelled,
        assigned,
        unassigned,
        totalDeliveries,
        deliveryFees: Number(totals.deliveryFees) || 0,
        deliveryRevenue: Number(totals.revenue) || 0,
        avgDeliveryMinutes: Number.isFinite(totals.avgDeliveryMinutes) ? Math.round(totals.avgDeliveryMinutes) : null,
        successRate,
      },
    });
  } catch (error) {
    console.error('❌ Get Delivery Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------------------
// Route: GET /api/v1/deliveries/staff
// ---------------------------------------------------------------------------

/**
 * A courier is "online" when they touched the delivery system in the last 5
 * minutes; otherwise they are offline regardless of their manual toggle.
 */
const STAFF_ONLINE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Single shape for a delivery staff member, shared by the list endpoint and the
 * create endpoint so a freshly created rider is indistinguishable from a
 * pre-existing one on the client.
 */
function buildDeliveryStaffRow(u, activeDeliveries) {
  const isActive = u.status === 'ACTIVE' && u.isActive !== false;
  const online = Boolean(u.lastActiveAt) && new Date(u.lastActiveAt).getTime() > Date.now() - STAFF_ONLINE_WINDOW_MS;
  return {
    id: u._id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    username: u.username || null,
    cafeteriaId: u.cafeteriaId || null,
    role: 'delivery',
    createdAt: u.createdAt || null,
    // Both are sent deliberately: `isActive` is the authoritative computed flag,
    // and `status` is the raw account state. Clients were filtering on `status`
    // alone and, because it was omitted, silently dropped EVERY courier -
    // leaving the manager's selector empty and making assignment impossible.
    status: u.status,
    isActive,
    isAvailable: isActive && u.isAvailable !== false,
    isOnline: online,
    statusLabel: !isActive ? 'inactive' : online ? (u.isAvailable !== false ? 'available' : 'offline') : 'offline',
    lastActiveAt: u.lastActiveAt || null,
    lastKnownLocation: u.lastKnownLocation && u.lastKnownLocation.latitude !== null ? u.lastKnownLocation : null,
    activeDeliveries: activeDeliveries || 0,
  };
}

/**
 * @desc    Get list of delivery staff (for assignment dropdown)
 * @route   GET /api/v1/deliveries/staff
 * @access  Private/Admin
 */
exports.getDeliveryStaff = async (req, res) => {
  try {
    // Scope the staff list to the caller's cafeteria so assignment dropdowns
    // never offer riders from another cafeteria.
    let scope;
    try {
      scope = resolveCafeteriaScope(req);
    } catch (scopeError) {
      return res
        .status(scopeError.statusCode || HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: scopeError.message });
    }

    const filter = { role: 'delivery', ...cafeteriaFilter(scope) };
    const staff = await User.find(filter)
      .select('name email phone username status isActive cafeteriaId isAvailable lastActiveAt lastKnownLocation createdAt')
      .lean()
      .sort({ name: 1 });

    // Real live load per courier (one aggregate, not N queries).
    const loads = await Order.aggregate([
      {
        $match: {
          orderType: 'delivery',
          deliveryStaffAssigned: { $in: staff.map((u) => u._id) },
          $or: [
            { orderStatus: { $in: MY_ACTIVE_STATUSES_UPPER } },
            { status: { $in: MY_ACTIVE_STATUSES_LOWER } },
          ],
        },
      },
      { $group: { _id: '$deliveryStaffAssigned', activeDeliveries: { $sum: 1 } } },
    ]);
    const loadByStaff = new Map(loads.map((l) => [String(l._id), l.activeDeliveries]));

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: staff.length,
      staff: staff.map((u) => buildDeliveryStaffRow(u, loadByStaff.get(String(u._id)) || 0)),
    });
  } catch (error) {
    console.error('❌ Get Delivery Staff Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------------------
// Route: GET /api/v1/deliveries/staff/:staffId/orders
// ---------------------------------------------------------------------------

/**
 * @desc    Delivery orders assigned to ONE courier (manager "view orders")
 * @route   GET /api/v1/deliveries/staff/:staffId/orders
 * @access  Private/Management (admin, system_admin, cafeteria_admin, manager)
 * @query   status (ACTIVE | ALL | READY | ...), report=completed|cancelled|failed, limit (<=200)
 *
 * Powers the Delivery Staff screen on the manager dashboard: the row's
 * "Delivery Orders" button opens a list of everything that rider is carrying,
 * using exactly the same status semantics as GET /deliveries so the two
 * screens can never disagree.
 *
 * Both the rider lookup and the order query are cafeteria-scoped from the
 * caller's JWT, so a manager can never read another cafeteria's rider or leak
 * someone else's customer through this endpoint.
 */
exports.getStaffDeliveryOrders = async (req, res) => {
  try {
    const staffId = String(req.params.staffId || '').trim();
    if (!mongoose.Types.ObjectId.isValid(staffId)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid delivery staff id' });
    }

    let scope;
    try {
      scope = resolveDeliveryListScope(req);
    } catch (scopeError) {
      return res
        .status(scopeError.statusCode || HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: scopeError.message });
    }

    const staff = await User.findOne({ _id: staffId, role: 'delivery', ...cafeteriaFilter(scope) })
      .select(
        'name email phone username status isActive cafeteriaId isAvailable lastActiveAt lastKnownLocation createdAt'
      )
      .lean();
    if (!staff) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery staff not found' });
    }

    const scopeFilter = cafeteriaFilter(scope);
    const filter = { orderType: 'delivery', deliveryStaffAssigned: staffId, ...scopeFilter };
    applyDeliveryListStatusFilter(filter, req.query);

    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));

    // Live load is reported alongside the list so the modal header can show
    // "3 active / 12 total" without a second round trip.
    const [orders, activeDeliveries] = await Promise.all([
      Order.find(filter)
        .populate('deliveryStaffAssigned', 'name phone role')
        .sort({ orderTime: -1 })
        .limit(limit),
      Order.countDocuments(myActiveDeliveryFilter(staffId, { ...scopeFilter })),
    ]);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: orders.length,
      staff: buildDeliveryStaffRow(staff, activeDeliveries),
      orders: await serializeOrders(orders),
    });
  } catch (error) {
    console.error('❌ Get Staff Delivery Orders Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ---------------------------------------------------------------------------
// Route: POST /api/v1/deliveries/staff
// ---------------------------------------------------------------------------

/**
 * @desc    Add a delivery staff member (Cafeteria Manager Dashboard)
 * @route   POST /api/v1/deliveries/staff
 * @access  Private/Management (admin, system_admin, cafeteria_admin, manager)
 * @body    { name, phone, email, username, password }
 *
 * Creates a normal User with the canonical `delivery` role - the same document
 * the courier logs into and the same rows `GET /deliveries/staff` returns, so
 * the new rider appears in the Delivery Orders selector with no second system.
 * The role is fixed here and never read from the body; the cafeteria comes from
 * the caller's trusted `cafeteriaId` (global admins may target one explicitly).
 */
exports.createDeliveryStaff = async (req, res) => {
  try {
    let scope;
    try {
      scope = resolveCafeteriaScope(req);
    } catch (scopeError) {
      return res
        .status(scopeError.statusCode || HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: scopeError.message });
    }

    const { name, phone, email, username, password } = req.body;

    // Cafeteria-scoped actors always land in their own cafeteria. A global
    // admin may pass cafeteriaId, defaulting to the platform's cafeteria.
    let targetCafeteriaId = scope.cafeteriaId;
    if (scope.global) {
      targetCafeteriaId =
        req.body.cafeteriaId && mongoose.Types.ObjectId.isValid(req.body.cafeteriaId)
          ? req.body.cafeteriaId
          : await getDefaultCafeteriaId();
    }

    const user = await createUserRecord(req, {
      name,
      phone,
      email,
      username,
      password,
      role: 'delivery', // canonical role; `delivery_staff` normalizes to this
      status: 'ACTIVE',
      forcedCafeteriaId: targetCafeteriaId,
    });

    // Return the row in the exact shape `GET /deliveries/staff` produces, so the
    // client can insert it into the staff list and the Delivery Orders selector
    // without a page reload.
    const staffRow = buildDeliveryStaffRow(user, 0);

    // Tell any already-open Delivery Orders / Manager dashboard tab to re-read
    // the list, so the new rider shows up in their selector too.
    emitSocketEvent('admin', 'delivery:staff', staffRow);
    emitSocketEvent('delivery', 'delivery:staff', staffRow);

    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      message: 'Delivery staff created successfully',
      staff: staffRow,
      user: staffRow,
    });
  } catch (error) {
    respondToCreateUserError(res, error, 'Create Delivery Staff');
  }
};

/**
 * @desc    Set the signed-in courier's availability (Available / Offline)
 * @route   PUT /api/v1/deliveries/availability
 * @access  Private/Delivery
 * Body: { isAvailable: true|false }
 */
exports.setAvailability = async (req, res) => {
  try {
    if (normalizeRole(req.user.role) !== 'delivery') {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'Only delivery staff can change their availability' });
    }
    if (typeof req.body.isAvailable !== 'boolean') {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ success: false, error: 'isAvailable must be true or false' });
    }

    await User.updateOne(
      { _id: req.user.id },
      { $set: { isAvailable: req.body.isAvailable, lastActiveAt: new Date() } }
    );
    await deliveryService.touchCourier(req.user.id);

    // Dispatch boards refresh the rider list immediately.
    emitSocketEvent('admin', 'delivery:availability', {
      deliveryStaffId: String(req.user.id),
      isAvailable: req.body.isAvailable,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      isAvailable: req.body.isAvailable,
      message: req.body.isAvailable ? 'You are now available for deliveries.' : 'You are now marked offline.',
    });
  } catch (error) {
    console.error('❌ Set Availability Error:', error);
    sendError(res, error, 'Failed to update your availability');
  }
};

// ---------------------------------------------------------------------------
// Route: GET /api/v1/deliveries/reports
// ---------------------------------------------------------------------------

/**
 * @desc    Delivery reports / statistics (per-courier + per-day breakdown)
 * @route   GET /api/v1/deliveries/reports
 * @access  Private/Manager
 * Query: days=7 (1-90)
 */
exports.getDeliveryReports = async (req, res) => {
  try {
    let scope;
    try {
      scope = resolveCafeteriaScope(req);
    } catch (scopeError) {
      return res
        .status(scopeError.statusCode || HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: scopeError.message });
    }

    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const base = { orderType: 'delivery', ...cafeteriaFilter(scope) };

    const [byCourier, byDay, totals, failureReasons] = await Promise.all([
      Order.aggregate([
        { $match: { ...base, deliveryStaffAssigned: { $ne: null } } },
        {
          $group: {
            _id: '$deliveryStaffAssigned',
            total: { $sum: 1 },
            delivered: {
              $sum: {
                $cond: [
                  { $in: ['$orderStatus', ['DELIVERED', 'COMPLETED']] },
                  1,
                  0,
                ],
              },
            },
            failed: { $sum: { $cond: [{ $eq: ['$orderStatus', 'FAILED'] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ['$orderStatus', 'CANCELLED'] }, 1, 0] } },
            deliveryFees: { $sum: '$deliveryFee' },
            revenue: { $sum: '$totalAmount' },
            avgDeliveryMinutes: {
              $avg: {
                $cond: [
                  { $and: [{ $ne: ['$pickedUpTime', null] }, { $ne: ['$deliveredAt', null] }] },
                  { $divide: [{ $subtract: ['$deliveredAt', '$pickedUpTime'] }, 60000] },
                  null,
                ],
              },
            },
          },
        },
        { $sort: { delivered: -1 } },
        { $limit: 25 },
      ]),
      Order.aggregate([
        { $match: { ...base, createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            total: { $sum: 1 },
            delivered: { $sum: { $cond: [{ $in: ['$orderStatus', ['DELIVERED', 'COMPLETED']] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$orderStatus', 'FAILED'] }, 1, 0] } },
            deliveryFees: { $sum: '$deliveryFee' },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Order.aggregate([
        { $match: base },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            delivered: { $sum: { $cond: [{ $in: ['$orderStatus', ['DELIVERED', 'COMPLETED']] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$orderStatus', 'FAILED'] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ['$orderStatus', 'CANCELLED'] }, 1, 0] } },
            deliveryFees: { $sum: '$deliveryFee' },
            revenue: { $sum: '$totalAmount' },
          },
        },
      ]),
      Delivery.aggregate([
        { $match: { ...cafeteriaFilter(scope), status: 'FAILED', failedAt: { $gte: since } } },
        { $group: { _id: '$failureReason', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    const courierIds = byCourier.map((c) => c._id).filter(Boolean);
    const couriers = courierIds.length
      ? await User.find({ _id: { $in: courierIds } }).select('name phone isAvailable lastActiveAt').lean()
      : [];
    const courierById = new Map(couriers.map((c) => [String(c._id), c]));
    const onlineCutoff = Date.now() - 5 * 60 * 1000;

    const total = totals[0] || {};
    const deliveredCount = Number(total.delivered) || 0;
    const failedCount = Number(total.failed) || 0;

    res.status(HTTP_STATUS.OK).json({
      success: true,
      days,
      totals: {
        total: Number(total.total) || 0,
        delivered: deliveredCount,
        failed: failedCount,
        cancelled: Number(total.cancelled) || 0,
        deliveryFees: Number(total.deliveryFees) || 0,
        revenue: Number(total.revenue) || 0,
        successRate: deliveredCount + failedCount > 0 ? Math.round((deliveredCount / (deliveredCount + failedCount)) * 100) : null,
      },
      byCourier: byCourier.map((c) => {
        const user = courierById.get(String(c._id));
        return {
          deliveryStaffId: String(c._id),
          name: user ? user.name : 'Unknown',
          phone: user ? user.phone : null,
          isAvailable: user ? user.isAvailable !== false : false,
          isOnline: Boolean(user && user.lastActiveAt && new Date(user.lastActiveAt).getTime() > onlineCutoff),
          total: c.total,
          delivered: c.delivered,
          failed: c.failed,
          cancelled: c.cancelled,
          deliveryFees: Math.round((Number(c.deliveryFees) || 0) * 100) / 100,
          revenue: Math.round((Number(c.revenue) || 0) * 100) / 100,
          avgDeliveryMinutes: Number.isFinite(c.avgDeliveryMinutes) ? Math.round(c.avgDeliveryMinutes) : null,
        };
      }),
      byDay: byDay.map((d) => ({
        date: d._id,
        total: d.total,
        delivered: d.delivered,
        failed: d.failed,
        deliveryFees: Math.round((Number(d.deliveryFees) || 0) * 100) / 100,
      })),
      failureReasons: failureReasons.map((f) => ({ reason: f._id || 'OTHER', count: f.count })),
    });
  } catch (error) {
    console.error('❌ Get Delivery Reports Error:', error);
    sendError(res, error, 'Failed to load delivery reports');
  }
};

/**
 * @desc    GPS history for a delivery (management / audit)
 * @route   GET /api/v1/deliveries/:id/locations
 * @access  Private/Manager
 */
exports.getDeliveryLocations = async (req, res) => {
  try {
    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Delivery not found' });
    }
    const isManager = isManagerActor(normalizeRole(req.user.role));
    const isCourier = deliveryStaffId(delivery) === String(req.user.id);
    if (!isManager && !isCourier) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'You are not allowed to view this tracking history' });
    }

    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const points = await DeliveryLocation.find({ delivery: delivery._id })
      .sort({ timestamp: 1 })
      .limit(limit)
      .select('latitude longitude accuracy heading speed timestamp createdAt')
      .lean();

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: points.length,
      orderId: order.orderId,
      points: points.map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
        accuracy: p.accuracy,
        heading: p.heading ?? null,
        speed: p.speed ?? null,
        timestamp: p.timestamp,
      })),
    });
  } catch (error) {
    console.error('❌ Get Delivery Locations Error:', error);
    sendError(res, error, MESSAGES.SERVER_ERROR);
  }
};

/**
 * @desc    Last known GPS fix for a delivery, plus the customer's drop-off point
 * @route   GET /api/v1/deliveries/:id/location
 * @access  Private - the customer who owns the order, the assigned courier, or
 *          management. Same audience as the `delivery:<orderId>` socket room, so
 *          an HTTP read can never leak more than the live feed already does.
 *
 * This is what powers the delivery-history view: after DELIVERED/COMPLETED no
 * further points are written, and this endpoint keeps returning the final fix
 * so a finished delivery still shows WHERE it ended (without any live marker).
 */
exports.getLastDeliveryLocation = async (req, res) => {
  try {
    const { order, delivery } = await resolveDeliveryPair(req.params.id);
    if (!order || !delivery) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }

    const viewerId = String(req.user.id);
    const isManager = isManagerActor(normalizeRole(req.user.role));
    const isOwner = String(order.userId || '') === viewerId;
    const isCourier = deliveryStaffId(delivery) === viewerId;
    if (!isManager && !isOwner && !isCourier) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'You are not allowed to view this delivery location' });
    }

    const fix = (delivery && delivery.currentLocation) || order.currentLocation || null;
    const destination =
      (delivery && delivery.destination && (delivery.destination.latitude !== null || delivery.destination.address))
        ? delivery.destination
        : buildDestination(order);
    const status = effectiveStatus(order, delivery);
    const deliveryStatus = delivery ? delivery.status : status;
    const proximity = deliveryService.proximityToCustomer(fix, destination);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      orderId: order.orderId,
      status,
      deliveryStatus,
      // GPS runs only for the three in-flight stages; false means "do not
      // subscribe / do not expect a moving marker".
      trackingActive: deliveryService.isGpsAllowed(deliveryStatus),
      deliveryLocation: fix
        ? {
            latitude: fix.latitude,
            longitude: fix.longitude,
            accuracy: fix.accuracy ?? null,
            heading: fix.heading ?? null,
            speed: fix.speed ?? null,
            updatedAt: fix.timestamp || null,
          }
        : null,
      customerLocation: {
        latitude: destination.latitude ?? null,
        longitude: destination.longitude ?? null,
        address: destination.address || '',
      },
      distanceToCustomerKm: proximity.distanceKm,
      nearCustomer: proximity.nearCustomer,
    });
  } catch (error) {
    console.error('❌ Get Last Delivery Location Error:', error);
    sendError(res, error, MESSAGES.SERVER_ERROR);
  }
};

module.exports = exports;
module.exports._internal = {
  effectiveStatus,
  serializeDelivery,
  serializeOrders,
  resolveDeliveryPair,
  buildOrderLookup,
  MANAGEMENT_ROLE_LIST,
  isKitchenReady,
  kitchenReadyState,
  broadcastStatus,
  broadcastDispatch,
  cancelDeliveryForIssue,
  assignCourierForIssue,
  moveDelivery,
  findOrderByIdentifier,
};
