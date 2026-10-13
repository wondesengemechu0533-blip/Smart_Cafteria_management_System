/**
 * delivery.service.js - the single source of truth for the delivery domain.
 *
 * Everything that both the HTTP layer and the Socket.IO layer need lives here:
 *
 *   1. The delivery state machine (REQUESTED -> ASSIGNED -> ACCEPTED ->
 *      PICKED_UP -> OUT_FOR_DELIVERY -> ARRIVED -> DELIVERED, with the
 *      FAILED / CANCELLED alternatives). Illegal transitions are rejected
 *      here, so no controller can invent a shortcut.
 *   2. The mapping between a delivery status and the legacy Order status
 *      fields (orderStatus / status / deliveryAcceptanceStatus) that the
 *      existing kitchen, admin and customer screens already read. Nothing in
 *      those screens has to change; they simply keep working.
 *   3. Real geodata helpers: haversine distance, ETA, and delivery-fee
 *      calculation from configurable Settings. No coordinate is ever invented.
 *   4. Delivery record lifecycle: create the Delivery when a delivery order is
 *      placed, and move it in lock-step with the Order.
 *
 * The service is transport agnostic: it returns plain data / throws Errors
 * carrying `statusCode`, and the controller turns those into HTTP responses.
 */

const mongoose = require('mongoose');
const Order = require('../models/Order');
const Delivery = require('../models/Delivery');
const DeliveryLocation = require('../models/DeliveryLocation');
const User = require('../models/User');
const Cafeteria = require('../models/Cafeteria');
const { getSettingsMap } = require('../utils/settings');
const { round2 } = require('./finance.service');

const DELIVERY_STATUS = {
  REQUESTED: 'REQUESTED',
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  PICKED_UP: 'PICKED_UP',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  ARRIVED: 'ARRIVED',
  DELIVERED: 'DELIVERED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

/**
 * Allowed transitions. A status absent as a key is terminal and can never
 * change state (a completed/failed/cancelled delivery is final - the customer
 * or a manager places a NEW order instead).
 *
 * DELIVERED -> COMPLETED is the courier's close-out: the handover is already
 * proven at DELIVERED, so the only thing left is confirming the delivery is
 * finished. It exists as its own state (rather than collapsing the two) so the
 * active list keeps showing the delivery until it is genuinely finished, and so
 * the customer timeline can distinguish "handed over" from "completed".
 */
const DELIVERY_TRANSITIONS = {
  REQUESTED: ['ASSIGNED', 'CANCELLED', 'FAILED'],
  ASSIGNED: ['ACCEPTED', 'ASSIGNED', 'CANCELLED', 'FAILED'],
  ACCEPTED: ['PICKED_UP', 'ASSIGNED', 'CANCELLED', 'FAILED'],
  PICKED_UP: ['OUT_FOR_DELIVERY', 'FAILED', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['ARRIVED', 'FAILED', 'CANCELLED'],
  ARRIVED: ['DELIVERED', 'FAILED', 'CANCELLED'],
  DELIVERED: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: ['ASSIGNED', 'CANCELLED'],
  CANCELLED: [],
};

const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];
/** States where the courier is physically moving the food: GPS is allowed. */
const GPS_ALLOWED_STATUSES = ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED'];
/** States a manager can still hand a courier (assignment / reassignment). */
const ASSIGNABLE_STATUSES = ['REQUESTED', 'ASSIGNED', 'ACCEPTED', 'PICKED_UP'];

/**
 * Delivery status <-> legacy Order status mapping.
 * `orderStatus` is the uppercase enum, `status` the lowercase one, and
 * `kitchenState` the kitchen-facing state (PENDING / PREPARING / READY) that a
 * delivery passes through before the courier may pick it up.
 */
const STATUS_TO_ORDER = {
  [DELIVERY_STATUS.REQUESTED]: { orderStatus: 'PENDING', status: 'pending' },
  [DELIVERY_STATUS.ASSIGNED]: { orderStatus: 'PENDING', status: 'pending' },
  [DELIVERY_STATUS.ACCEPTED]: { orderStatus: 'PENDING', status: 'pending' },
  [DELIVERY_STATUS.PICKED_UP]: { orderStatus: 'PICKED_UP', status: 'picked_up' },
  [DELIVERY_STATUS.OUT_FOR_DELIVERY]: { orderStatus: 'OUT_FOR_DELIVERY', status: 'out_for_delivery' },
  [DELIVERY_STATUS.ARRIVED]: { orderStatus: 'ARRIVED', status: 'arrived' },
  [DELIVERY_STATUS.DELIVERED]: { orderStatus: 'DELIVERED', status: 'delivered' },
  [DELIVERY_STATUS.COMPLETED]: { orderStatus: 'COMPLETED', status: 'Completed' },
  [DELIVERY_STATUS.FAILED]: { orderStatus: 'FAILED', status: 'failed' },
  [DELIVERY_STATUS.CANCELLED]: { orderStatus: 'CANCELLED', status: 'cancelled' },
};

/**
 * Delivery states that happen BEFORE the courier collects the food. They map onto
 * the Order's kitchen stage as PENDING, which is only correct while the kitchen
 * has not finished yet.
 */
const PRE_PICKUP_STATUSES = [DELIVERY_STATUS.REQUESTED, DELIVERY_STATUS.ASSIGNED, DELIVERY_STATUS.ACCEPTED];

/** Kitchen/dispatch stages that mean the food is already done or gone. */
const KITCHEN_STAGE_DONE = [
  'READY',
  'READY_FOR_DELIVERY',
  'SERVED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'ARRIVED',
  'DELIVERED',
  'COMPLETED',
];

/**
 * Has this order already moved past the point where a delivery status may set
 * the kitchen stage?
 *
 * Requested / assigned / accepted are DISPATCH states, not kitchen states: they
 * only say who is carrying the order. Writing their PENDING mapping over a READY
 * the kitchen had already set walked the kitchen backwards - the order fell out
 * of the courier's "Ready for Delivery" tab, the Pick Up button degraded into a
 * disabled "Waiting for Kitchen", and the pickup API then refused the order with
 * ORDER_NOT_READY. Dispatch must never undo kitchen work.
 */
function kitchenStageAlreadyDone(order) {
  // Same precedence the kitchen uses to read the stage, so both agree.
  const current = String((order && (order.orderStatus || order.status)) || '').toUpperCase();
  return KITCHEN_STAGE_DONE.includes(current);
}

/** Reverse map: derive the delivery status from an existing Order document. */
function deliveryStatusFromOrder(order) {
  const orderStatus = String(order?.orderStatus || '').toUpperCase();
  const status = String(order?.status || '').toLowerCase();

  if (orderStatus === 'CANCELLED' || status === 'cancelled') return DELIVERY_STATUS.CANCELLED;
  if (orderStatus === 'FAILED' || status === 'failed') return DELIVERY_STATUS.FAILED;
  // COMPLETED is the canonical terminal delivery state. DELIVERED is only the
  // handed-over-but-not-yet-closed-out state, so it must be checked on its own.
  if (orderStatus === 'COMPLETED' || status === 'completed') return DELIVERY_STATUS.COMPLETED;
  if (orderStatus === 'DELIVERED' || status === 'delivered') return DELIVERY_STATUS.DELIVERED;
  if (orderStatus === 'ARRIVED' || status === 'arrived') return DELIVERY_STATUS.ARRIVED;
  if (orderStatus === 'OUT_FOR_DELIVERY' || status === 'out_for_delivery') return DELIVERY_STATUS.OUT_FOR_DELIVERY;
  if (orderStatus === 'PICKED_UP' || status === 'picked_up') return DELIVERY_STATUS.PICKED_UP;

  // Not picked up yet. The courier's accept/decline decides between
  // ASSIGNED and ACCEPTED; otherwise the order is still a fresh request.
  if (order?.deliveryStaffAssigned) {
    return order?.deliveryAcceptanceStatus === 'ACCEPTED' ? DELIVERY_STATUS.ACCEPTED : DELIVERY_STATUS.ASSIGNED;
  }
  return DELIVERY_STATUS.REQUESTED;
}

/**
 * Build an Error carrying an HTTP status and an optional machine-readable code.
 *
 * The `code` is what lets a client branch on the specific condition
 * (PROOF_REQUIRED, OTP_EXPIRED, EMERGENCY_EXISTS, ...) instead of matching on
 * human-readable text, which translates and drifts.
 */
function httpError(message, statusCode = 400, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function normalizeStatus(value) {
  const raw = String(value ?? '')
    .trim()
    // camelCase / PascalCase -> SNAKE_CASE ("outForDelivery" -> "OUT_FOR_DELIVERY")
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (!raw) return '';
  // Accept the legacy/order spellings so a single client can drive both.
  const aliases = {
    CANCELED: DELIVERY_STATUS.CANCELLED,
    CANCELED_BY_CUSTOMER: DELIVERY_STATUS.CANCELLED,
    OUT_FOR_DELIVER: DELIVERY_STATUS.OUT_FOR_DELIVERY,
    ON_THE_WAY: DELIVERY_STATUS.OUT_FOR_DELIVERY,
    PICKEDUP: DELIVERY_STATUS.PICKED_UP,
    PICK_UP: DELIVERY_STATUS.PICKED_UP,
    PENDING: DELIVERY_STATUS.REQUESTED,
    PREPARING: DELIVERY_STATUS.REQUESTED,
    READY: DELIVERY_STATUS.REQUESTED,
    NEW: DELIVERY_STATUS.REQUESTED,
    DELIVERY_REQUESTED: DELIVERY_STATUS.REQUESTED,
    // 'received' is the kitchen-facing spelling of the final customer state.
    RECEIVED: DELIVERY_STATUS.COMPLETED,
    FAILED_DELIVERY: DELIVERY_STATUS.FAILED,
  };
  return aliases[raw] || raw;
}

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(normalizeStatus(status));
}

function isGpsAllowed(status) {
  return GPS_ALLOWED_STATUSES.includes(normalizeStatus(status));
}

function isAssignable(status) {
  return ASSIGNABLE_STATUSES.includes(normalizeStatus(status));
}

function canTransition(from, to) {
  const fromStatus = normalizeStatus(from);
  const toStatus = normalizeStatus(to);
  if (!toStatus) return false;
  if (fromStatus === toStatus) return false; // no-op transitions are rejected
  if (!DELIVERY_TRANSITIONS[fromStatus]) return false;
  return DELIVERY_TRANSITIONS[fromStatus].includes(toStatus);
}

/**
 * Throw a user-facing error when a transition is not allowed.
 * Managers get a slightly more detailed message so they can act on it.
 */
function assertTransition(from, to, { isManager = false } = {}) {
  if (canTransition(from, to)) return;
  const fromStatus = normalizeStatus(from);
  const toStatus = normalizeStatus(to);
  if (isTerminal(fromStatus)) {
    throw httpError(`This delivery is already ${humanize(fromStatus).toLowerCase()} and can no longer be changed.`, 409);
  }
  if (isManager) {
    throw httpError(
      `Invalid status change: ${humanize(fromStatus)} cannot move to ${humanize(toStatus)}. ` +
        `Allowed next steps: ${DELIVERY_TRANSITIONS[fromStatus].map(humanize).join(', ') || 'none'}.`,
      409
    );
  }
  throw httpError(`You cannot set this delivery to ${humanize(toStatus)} while it is ${humanize(fromStatus)}.`, 409);
}

const HUMAN_LABELS = {
  REQUESTED: 'Delivery Requested',
  ASSIGNED: 'Assigned',
  ACCEPTED: 'Accepted',
  PICKED_UP: 'Picked Up',
  OUT_FOR_DELIVERY: 'Out for Delivery',
  ARRIVED: 'Arrived',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  FAILED: 'Failed Delivery',
  CANCELLED: 'Cancelled',
};

function humanize(status) {
  return HUMAN_LABELS[normalizeStatus(status)] || String(status || '');
}

// ---------------------------------------------------------------------------
// Geodata helpers - real coordinates only, never generated.
// ---------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371;

/**
 * Proximity radius, in metres, at which the courier is considered to be at the
 * customer's door. Advisory only - see proximityToCustomer() for why it must
 * never advance a delivery by itself.
 */
const NEAR_CUSTOMER_RADIUS_M = 100;

/**
 * Coerce a coordinate to a finite number, or null.
 *
 * `Number(null)`, `Number('')` and `Number([])` are all 0, so a missing or
 * blank coordinate would otherwise silently become a real point in the Gulf of
 * Guinea. Anything that is not a real, finite number is rejected outright.
 */
function toCoordinate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'object') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Great-circle distance in km. Returns null for incomplete coordinates. */
function haversineKm(a, b) {
  const lat1 = toCoordinate(a?.latitude);
  const lng1 = toCoordinate(a?.longitude);
  const lat2 = toCoordinate(b?.latitude);
  const lng2 = toCoordinate(b?.longitude);
  if ([lat1, lng1, lat2, lng2].some((n) => n === null)) return null;
  if (Math.abs(lat1) > 90 || Math.abs(lat2) > 90 || Math.abs(lng1) > 180 || Math.abs(lng2) > 180) return null;

  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return round2(2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h))));
}

function isValidCoordinate(lat, lng) {
  const la = toCoordinate(lat);
  const ln = toCoordinate(lng);
  if (la === null || ln === null) return false;
  return la >= -90 && la <= 90 && ln >= -180 && ln <= 180;
}

/**
 * How close a courier's fix is to the customer's saved drop-off point.
 *
 * Powers the "You are near the customer's location." hint on the courier
 * dashboard (Frontend/src/js/delivery/geo.js renders the same rule from the same
 * radius). It is ADVISORY ONLY - proximity never moves a delivery forward. The
 * courier still has to tap Mark Arrived and Mark Delivered themselves, so an
 * inaccurate fix (or a customer who is a neighbour) can never auto-confirm a
 * handover.
 *
 * Returns nulls (never a guess) when either end has no usable coordinates, so an
 * address-only delivery simply reports "no distance" instead of a fabricated one.
 */
function proximityToCustomer(fix, destination) {
  const hasCustomerLocation = isUsableDeliveryCoordinate(destination?.latitude, destination?.longitude);
  if (!hasCustomerLocation) {
    return { hasCustomerLocation: false, distanceKm: null, distanceMeters: null, nearCustomer: false };
  }
  const distanceKm = haversineKm(fix, destination);
  if (distanceKm === null) {
    return { hasCustomerLocation: true, distanceKm: null, distanceMeters: null, nearCustomer: false };
  }
  const distanceMeters = Math.round(distanceKm * 1000);
  return {
    hasCustomerLocation: true,
    distanceKm,
    distanceMeters,
    nearCustomer: distanceMeters <= NEAR_CUSTOMER_RADIUS_M,
  };
}

/**
 * Are these coordinates usable for a delivery-range decision?
 *
 * Stricter than isValidCoordinate: (0, 0) is a syntactically valid coordinate
 * but it is in the Gulf of Guinea, not a place anyone can receive food. It
 * reaches the backend when a client sends an unset field (Number('') === 0),
 * and treating it as a real location produced a ~4,400 km distance and a
 * false "beyond our 10 km delivery range" rejection. Such a pair is treated
 * as "no location shared" instead.
 */
function isUsableDeliveryCoordinate(lat, lng) {
  if (!isValidCoordinate(lat, lng)) return false;
  if (Number(lat) === 0 && Number(lng) === 0) return false;
  return true;
}

/** Trim a coordinate to null unless it is a real, in-range value. */
function cleanCoordinate(value, min, max) {
  const n = toCoordinate(value);
  if (n === null) return null;
  return n >= min && n <= max ? n : null;
}

/** Pickup point = the real, configured cafeteria (address + coordinates). */
async function resolvePickupLocation(cafeteriaId) {
  const cafeteria = cafeteriaId
    ? await Cafeteria.findById(cafeteriaId).lean()
    : (await Cafeteria.findOne({ isDefault: true }).lean()) || (await Cafeteria.findOne({}).lean());
  if (!cafeteria) return { name: '', address: '', phone: '', latitude: null, longitude: null };
  return {
    name: stringifyPickupField(cafeteria.name),
    // Cafeteria.address is declared as String, but legacy/seeded rows and older
    // imports can hold a nested object ({ subCity, location, latitude, ... }).
    // `lean()` skips schema casting, so passing that object straight through
    // made Delivery.create() throw "Cast to string failed ... pickupLocation.address",
    // which aborted the whole kitchen send and left the order with NO delivery
    // record at all. Always flatten to text.
    address: stringifyPickupField(cafeteria.address),
    phone: stringifyPickupField(cafeteria.phone),
    latitude: cleanCoordinate(cafeteria.latitude, -90, 90),
    longitude: cleanCoordinate(cafeteria.longitude, -180, 180),
  };
}

/**
 * Reduce a possibly-structured cafeteria field to a single readable string.
 * Strings pass through untouched; objects contribute their human-readable
 * parts only (never raw coordinates, which would be noise in an address field).
 */
function stringifyPickupField(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const parts = [
      value.address,
      value.deliveryAddress,
      value.location,
      value.street,
      value.streetArea,
      value.landmark,
      value.houseNumber,
      value.subCity,
      value.subcity,
      value.area,
      value.city,
      value.district,
      value.kebele,
    ]
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim());
    // De-duplicate while preserving order (address is often repeated in objects).
    const unique = parts.filter((p, i) => parts.indexOf(p) === i);
    if (unique.length) return unique.join(', ');
  }
  return '';
}

/** Configured average urban speed (km/h) with a sane floor. */
function averageSpeedKmh(settings) {
  const speed = Number(settings?.delivery_speed_kmh);
  return Number.isFinite(speed) && speed > 0 ? speed : 25;
}

/**
 * ETA in minutes from a real distance. Null when the distance is unknown, so
 * the UI can fall back to "distance unavailable" instead of inventing a time.
 *
 * Travel time at the configured average urban speed, plus the kitchen prep time
 * the customer is already waiting on, plus a small traffic buffer.
 */
function estimateEtaMinutes(distanceKm, settings) {
  const km = Number(distanceKm);
  if (!Number.isFinite(km) || km <= 0) return null;
  const buffer = Math.max(0, Number(settings?.delivery_eta_buffer_minutes) || 0);
  const prep = Math.max(0, Number(settings?.delivery_prep_time_minutes) || 0);
  const travelMinutes = (km / averageSpeedKmh(settings)) * 60;
  return Math.max(1, Math.round(travelMinutes + prep + buffer));
}

/**
 * Delivery fee for a real distance.
 *
 * - `delivery_free_over_amount` > 0 and the subtotal reaches it -> free.
 * - `delivery_fee_per_km` > 0 -> distance based, rounded up to whole ETB.
 * - otherwise the flat `delivery_fee`.
 *
 * Returns { fee, mode, distanceKm, etaMinutes, withinRange, maxDistanceKm }.
 */
function calculateDeliveryFee({ distanceKm = null, subtotal = 0, settings = {} } = {}) {
  const flatFee = Math.max(0, Number(settings.delivery_fee) || 0);
  const perKm = Math.max(0, Number(settings.delivery_fee_per_km) || 0);
  const freeOver = Math.max(0, Number(settings.delivery_free_over_amount) || 0);
  const maxDistance = Math.max(0, Number(settings.delivery_max_distance_km) || 0);

  const km = Number(distanceKm);
  // A real, finite distance. Null (address-only delivery) is NOT a distance of
  // zero, and must not be priced as a free ride at the customer's door.
  const hasDistance = Number.isFinite(km) && km > 0;
  const withinRange = !hasDistance || maxDistance === 0 || km <= maxDistance;

  const base = Number(subtotal) || 0;
  const etaMinutes = hasDistance ? estimateEtaMinutes(km, settings) : null;

  if (freeOver > 0 && base >= freeOver) {
    return { fee: 0, mode: 'FLAT', distanceKm: hasDistance ? round2(km) : null, etaMinutes, withinRange, maxDistanceKm: maxDistance };
  }

  if (perKm > 0 && hasDistance) {
    // Round up to the next whole bir so a short ride is never free, and never
    // price a near trip below the flat fee (which is the minimum charge).
    const distanceFee = Math.max(Math.ceil(perKm * km), Math.ceil(flatFee));
    return {
      fee: distanceFee,
      mode: 'DISTANCE',
      distanceKm: round2(km),
      etaMinutes,
      withinRange,
      maxDistanceKm: maxDistance,
    };
  }

  return {
    fee: round2(flatFee),
    mode: 'FLAT',
    distanceKm: hasDistance ? round2(km) : null,
    etaMinutes,
    withinRange,
    maxDistanceKm: maxDistance,
  };
}

// ---------------------------------------------------------------------------
// Delivery record lifecycle
// ---------------------------------------------------------------------------

/**
 * Create (or fetch) the Delivery record for a delivery order.
 *
 * Idempotent by `order` - a retried checkout or a duplicate request can never
 * produce two delivery records.
 *
 * @param {object} order Order document (must be orderType 'delivery')
 * @param {object} [opts] { settings, requestedStatus }
 */
async function ensureDeliveryForOrder(order, opts = {}) {
  if (!order || order.orderType !== 'delivery') return null;

  const settings = opts.settings || (await getSettingsMap());
  const existing = await Delivery.findOne({ order: order._id });
  if (existing) {
    // Self-heal the back-reference. A Delivery row can outlive the link that
    // created it (a failed `order.save()`, legacy data, a manual insert), and
    // this early return used to skip the repair - leaving `order.delivery`
    // permanently null. Every consumer that reads `order.delivery` (customer
    // tracking, kitchen payloads, dispatch) then saw "no delivery" even though
    // the record existed, so the order silently vanished from parts of the
    // delivery flow.
    const linkIsStale = !order.delivery || String(order.delivery) !== String(existing._id);
    if (linkIsStale) {
      order.delivery = existing._id;
      await order.save();
    }
    return existing;
  }

  const info = order.deliveryInfo || {};
  const pickupLocation = await resolvePickupLocation(order.cafeteriaId);

  const destination = {
    contactName: order.customerName || '',
    phone: info.phone || order.customerPhone || '',
    // Structured Ethiopian delivery location (any city - separate values).
    city: info.city || '',
    area: info.area || '',
    kebele: info.kebele || '',
    streetArea: info.streetArea || '',
    landmark: info.landmark || '',
    houseNumber: info.houseNumber || '',
    subCity: info.subCity || '',
    address: info.deliveryAddress || [info.subCity, info.location].filter(Boolean).join(', '),
    note: info.note || '',
    latitude: cleanCoordinate(info.latitude, -90, 90),
    longitude: cleanCoordinate(info.longitude, -180, 180),
  };
  destination.hasCoordinates = isValidCoordinate(destination.latitude, destination.longitude);

  const distanceKm = destination.hasCoordinates
    ? haversineKm({ latitude: pickupLocation.latitude, longitude: pickupLocation.longitude }, destination)
    : null;
  const quote = calculateDeliveryFee({ distanceKm, subtotal: order.subtotal, settings });

  // An order can only exist because it was accepted at checkout, so an
  // over-distance destination is flagged here for dispatch (not rejected) -
  // cancelling a placed order silently would be worse.
  if (!quote.withinRange && distanceKm !== null) {
    console.warn(
      `⚠️ Delivery ${order.orderId}: destination is ${distanceKm} km away, over the ${quote.maxDistanceKm} km limit.`
    );
  }

  const requestedStatus = opts.requestedStatus || deliveryStatusFromOrder(order);
  const now = new Date();
  // Why the delivery row appeared - the dispatch history must stay truthful.
  const createdReason = opts.reason
    || (opts.requestedStatus ? 'Order sent to delivery by kitchen' : 'Delivery requested from checkout');

  const [delivery] = await Delivery.create([
    {
      order: order._id,
      orderId: order.orderId,
      customer: order.userId,
      // Never auto-attach a courier HERE. Creating a Delivery (checkout, or the
      // kitchen's "Send to Delivery") must always leave it unassigned so no row
      // is silently given to somebody as a side effect of existing - copying
      // `order.deliveryStaffAssigned` would also resurrect a stale assignment
      // from a previous lifecycle. The kitchen's send-to-delivery handler then
      // hands the fresh row to a free rider as its own explicit step
      // (assignStaffToDelivery in delivery.controller), so "created" and
      // "dispatched" stay two distinguishable events in the history.
      deliveryPerson: null,
      cafeteriaId: order.cafeteriaId || null,
      pickupLocation,
      destination,
      latitude: destination.latitude,
      longitude: destination.longitude,
      distanceKm,
      etaMinutes: quote.etaMinutes,
      deliveryFee: Number(order.deliveryFee) || 0,
      feeMode: quote.mode,
      status: requestedStatus,
      acceptanceStatus: order.deliveryAcceptanceStatus || 'PENDING_ACCEPTANCE',
      requestedAt: order.orderTime || now,
      assignedAt: order.deliveryAssignedAt || null,
      assignedBy: null,
      acceptedAt: order.deliveryAcceptedAt || null,
      pickedUpAt: order.pickedUpTime || null,
      outForDeliveryAt: order.deliveryStartedAt || null,
      arrivedAt: order.deliveryArrivedAt || null,
      deliveredAt: order.deliveredAt || null,
      subtotal: Number(order.subtotal) || 0,
      totalAmount: Number(order.totalAmount) || 0,
      paymentStatus: String(order.paymentStatus || 'PENDING').toUpperCase(),
      statusHistory: [
        {
          status: requestedStatus,
          at: now,
          by: opts.actor?.id || null,
          note: createdReason,
        },
      ],
    },
  ]);

  order.delivery = delivery._id;
  await order.save();
  return delivery;
}

/**
 * Return a usable, saveable Order document for a Delivery's `order` reference.
 *
 * `Delivery.order` is a plain ObjectId ref, so it is unpopulated unless a
 * caller explicitly asked for it. Mutating a bare ObjectId silently does
 * nothing and `order.save()` then throws, which loses the whole status
 * transition (the order-status mirror and timestamps never persist).
 *
 * So: an already-populated document is used as-is, an id is loaded, and a
 * missing/unresolvable order yields null (the caller then only advances the
 * Delivery, which is the safe degradation).
 */
async function resolveOrderDocument(orderRef) {
  if (!orderRef) return null;
  // Already a full document (has a save method), not a bare ObjectId.
  if (typeof orderRef.save === 'function') return orderRef;
  if (orderRef._bsontype === 'ObjectId' || orderRef._id) {
    return Order.findById(orderRef._id || orderRef);
  }
  return null;
}

/**
 * Apply a delivery status change to BOTH the Delivery record and the Order.
 *
 * This is the only place allowed to move a delivery forward. It enforces the
 * transition table, stamps the matching timestamps on both documents, records
 * the audit trail (OrderStatusHistory + Delivery.statusHistory) and applies the
 * order-status mapping the rest of the system already understands.
 *
 * @param {object}  options
 * @param {object}  options.delivery   Delivery document. `delivery.order` may be
 *                                     a bare ObjectId ref - the Order document
 *                                     is resolved internally (see
 *                                     resolveOrderDocument).
 * @param {string}  options.status     Target delivery status
 * @param {object}  options.actor      req.user (JWT identity)
 * @param {string}  [options.reason]   Audit reason
 * @param {string}  [options.failureReason]
 * @param {string}  [options.failureNote]
 * @param {boolean} [options.allowTerminal] Allow moving out of a terminal state
 *                                          (manager retry: FAILED -> ASSIGNED)
 */
async function applyDeliveryStatus({
  delivery,
  status,
  actor = null,
  reason = '',
  failureReason = null,
  failureNote = null,
  allowTerminal = false,
}) {
  const target = normalizeStatus(status);
  if (!DELIVERY_STATUSES_FOR_TRANSITIONS.includes(target)) {
    throw httpError(`Unknown delivery status "${status}".`, 400);
  }

  const from = normalizeStatus(delivery.status);
  if (from === target) {
    throw httpError(`This delivery is already ${humanize(target).toLowerCase()}.`, 409);
  }
  if (!allowTerminal && isTerminal(from)) {
    throw httpError(`This delivery is already ${humanize(from).toLowerCase()} and can no longer be changed.`, 409);
  }
  if (!allowTerminal && !canTransition(from, target)) {
    const isManager = actor && ['admin', 'system_admin', 'cafeteria_admin', 'manager'].includes(String(actor.role).toLowerCase());
    assertTransition(from, target, { isManager });
  }
  if (allowTerminal && from !== target && !canTransition(from, target)) {
    assertTransition(from, target, { isManager: true });
  }

  const now = new Date();
  // `delivery.order` is a ref, so it is an unpopulated ObjectId unless the
  // caller explicitly populated it. This function mutates and saves the Order
  // (status mirror, timestamps, delivery back-reference), so it must hold a
  // real document. Resolve it here rather than trusting every call site to
  // remember to populate - an unpopulated ref makes `order.save()` throw
  // "order.save is not a function" and the whole transition is lost.
  const order = await resolveOrderDocument(delivery.order);

  delivery.status = target;
  delivery.statusHistory.push({
    status: target,
    at: now,
    by: actor?.id || null,
    note: reason || '',
  });

  // Timestamps: first time each state is reached wins, so a retry never
  // rewrites the original "picked up at" moment.
  const stampOnce = (field) => {
    if (!delivery[field]) delivery[field] = now;
  };
  if (target === DELIVERY_STATUS.ASSIGNED) {
    delivery.assignedAt = delivery.assignedAt || now;
    delivery.acceptanceStatus = 'PENDING_ACCEPTANCE';
  }
  if (target === DELIVERY_STATUS.ACCEPTED) {
    stampOnce('acceptedAt');
    delivery.acceptanceStatus = 'ACCEPTED';
    delivery.declineReason = null;
  }
  if (target === DELIVERY_STATUS.PICKED_UP) stampOnce('pickedUpAt');
  if (target === DELIVERY_STATUS.OUT_FOR_DELIVERY) stampOnce('outForDeliveryAt');
  if (target === DELIVERY_STATUS.ARRIVED) stampOnce('arrivedAt');
  if (target === DELIVERY_STATUS.DELIVERED) stampOnce('deliveredAt');
  if (target === DELIVERY_STATUS.COMPLETED) stampOnce('completedAt');
  if (target === DELIVERY_STATUS.FAILED) {
    delivery.failedAt = now;
    delivery.failureReason = failureReason || 'OTHER';
    delivery.failureNote = failureNote || null;
  }
  if (target === DELIVERY_STATUS.CANCELLED) delivery.cancelledAt = now;

  if (order) {
    const mapped = STATUS_TO_ORDER[target] || {};
    // REQUESTED / ASSIGNED / ACCEPTED carry a PENDING kitchen stage in their
    // mapping, which is only the starting value. Once the kitchen (or the
    // courier) has moved the order past READY, honour the newer stage instead of
    // resetting it - otherwise accepting an assignment silently un-readyes food
    // the kitchen already finished.
    const keepKitchenStage = PRE_PICKUP_STATUSES.includes(target) && kitchenStageAlreadyDone(order);
    if (!keepKitchenStage) {
      if (mapped.orderStatus) order.orderStatus = mapped.orderStatus;
      if (mapped.status) order.status = mapped.status;
    }
    order.deliveryFailureReason = target === DELIVERY_STATUS.FAILED ? delivery.failureReason : null;

    if (target === DELIVERY_STATUS.ACCEPTED) {
      order.deliveryAcceptanceStatus = 'ACCEPTED';
      order.deliveryAcceptedAt = order.deliveryAcceptedAt || now;
      order.deliveryAcceptedBy = order.deliveryAcceptedBy || actor?.id || null;
    }
    if (target === DELIVERY_STATUS.ASSIGNED) {
      order.deliveryAcceptanceStatus = 'PENDING_ACCEPTANCE';
      order.deliveryAssignedAt = order.deliveryAssignedAt || now;
    }
    if (target === DELIVERY_STATUS.PICKED_UP) {
      order.pickedUpTime = order.pickedUpTime || now;
      order.pickedUpBy = order.pickedUpBy || delivery.deliveryPerson || actor?.id || null;
      order.readyTime = order.readyTime || now;
    }
    if (target === DELIVERY_STATUS.OUT_FOR_DELIVERY) order.deliveryStartedAt = order.deliveryStartedAt || now;
    if (target === DELIVERY_STATUS.ARRIVED) order.deliveryArrivedAt = order.deliveryArrivedAt || now;
    if (target === DELIVERY_STATUS.DELIVERED) {
      // The handover is proven, but the order is NOT closed yet: the assigned
      // courier still has to confirm completion. Only COMPLETED finalises the
      // order, so the customer's "Delivered" and "Completed" timeline steps stay
      // distinct.
      order.deliveredAt = order.deliveredAt || now;
    }
    if (target === DELIVERY_STATUS.COMPLETED) {
      order.completedTime = order.completedTime || now;
      order.deliveredAt = order.deliveredAt || now;
      order.orderStatus = 'COMPLETED';
      // Order.status is an enum whose terminal member is 'Completed' (capital
      // C) - there is no lowercase 'completed'. Writing the lowercase value made
      // Mongoose reject the save, so the whole final transition (and the
      // delivery:completed broadcast) failed with a 500 on every handover.
      order.status = 'Completed';
    }
    if (target === DELIVERY_STATUS.CANCELLED) {
      order.cancellationStatus = order.cancellationStatus || 'approved';
      order.cancellationProcessedAt = now;
    }
    if (order.delivery) order.delivery = delivery._id;
    await order.save();

    try {
      const OrderStatusHistory = require('../models/OrderStatusHistory');
      await OrderStatusHistory.create({
        orderId: order._id,
        previousStatus: from,
        newStatus: mapped.orderStatus || from,
        changedBy: actor?.id || null,
        reason: reason || `Delivery ${humanize(target)}`,
      });
    } catch (historyError) {
      console.warn('⚠️ Could not write OrderStatusHistory:', historyError.message);
    }
  }

  await delivery.save();
  return { delivery, order, from, to: target };
}

// `DELIVERY_STATUSES_FOR_TRANSITIONS` is derived once so a typo in a status
// string is rejected with a clear 400 instead of a silent no-op.
const DELIVERY_STATUSES_FOR_TRANSITIONS = Object.keys(DELIVERY_TRANSITIONS);

/**
 * Find the Delivery for a reference that may be:
 *   - a Delivery._id            (Mongo ObjectId)
 *   - an Order._id              (Mongo ObjectId)  <- the most common case
 *   - an Order.orderId          (human id, e.g. "ET-1234ABC")
 */
async function findDeliveryByReference(reference, { populateOrder = true } = {}) {
  const stringRef = String(reference ?? '').trim();
  if (!stringRef) return null;

  let query;
  if (!mongoose.Types.ObjectId.isValid(stringRef)) {
    query = { orderId: stringRef };
  } else {
    // An ObjectId is ambiguous: it may be the delivery, the order, or neither.
    // Resolve the order first so both spellings work from the same URL.
    const order = await Order.findById(stringRef).select('orderId').lean();
    if (order && order.orderId) {
      query = { $or: [{ _id: stringRef }, { orderId: order.orderId }] };
    } else {
      query = { $or: [{ _id: stringRef }, { order: stringRef }] };
    }
  }

  let delivery = Delivery.findOne(query);
  if (populateOrder) {
    delivery = delivery.populate({
      path: 'order',
      populate: { path: 'deliveryStaffAssigned', select: 'name phone role' },
    });
  }
  return delivery;
}

/**
 * Store a courier GPS fix.
 *
 * Writes the append-only history (DeliveryLocation) and mirrors the newest fix
 * onto Delivery.currentLocation, Order.currentLocation and
 * User.lastKnownLocation so every reader gets it from one lightweight read.
 * Coordinates come straight from the device; the server never alters them.
 */
async function recordCourierLocation({ delivery, deliveryPersonId, latitude, longitude, accuracy, heading = null, speed = null, timestamp }) {
  const point = { latitude, longitude, accuracy, heading, speed, timestamp };

  await DeliveryLocation.create({
    delivery: delivery._id,
    order: delivery.order ? (delivery.order._id || delivery.order) : null,
    orderId: delivery.orderId,
    deliveryPerson: deliveryPersonId,
    latitude,
    longitude,
    accuracy,
    heading,
    speed,
    timestamp,
  });

  await Delivery.updateOne({ _id: delivery._id }, { $set: { currentLocation: point } });
  delivery.currentLocation = point;

  const orderId = delivery.order ? delivery.order._id || delivery.order : null;
  if (orderId) {
    await Order.updateOne({ _id: orderId }, { $set: { currentLocation: point } });
  }
  await User.updateOne({ _id: deliveryPersonId }, { $set: { lastKnownLocation: point, lastActiveAt: new Date() } });

  return point;
}

/** Mark a courier as recently active (drives the Available / Offline badge). */
async function touchCourier(userId) {
  if (!userId) return;
  await User.updateOne({ _id: userId }, { $set: { lastActiveAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Proof of delivery
// ---------------------------------------------------------------------------

// A 6-digit code is short enough for a customer to read out over the phone and
// long enough that guessing it is not a realistic attack on a code that expires
// in OTP_TTL_MINUTES and is single-use.
const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

function generateOtpCode() {
  // crypto, not Math.random(): this is a security control, and Math.random()
  // is not a CSPRNG.
  const bytes = require('crypto').randomBytes(OTP_LENGTH);
  let out = '';
  for (let i = 0; i < OTP_LENGTH; i++) out += String(bytes[i] % 10);
  return out;
}

/**
 * Create (or refresh) the customer OTP for a delivery and tell the customer.
 *
 * The code is delivered through the normal notification channel, so it appears
 * in the customer's existing notification list - there is no separate "OTP
 * screen" to build. The code itself is never returned in an API response after
 * this call: it is written to the delivery and emailed/pushed to the customer
 * only.
 *
 * @returns {{ expiresAt: Date, devOtp?: string }} `devOtp` is included only when
 *          the server is explicitly in development mode, so a developer can
 *          still see the code in logs without weakening production.
 */
async function generateDeliveryOtp({ delivery, actor = null }) {
  if (!delivery) throw httpError('Delivery not found', 404);

  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  delivery.customerOtp = code;
  delivery.customerOtpExpiresAt = expiresAt;
  delivery.otpAttempts = 0;
  await delivery.save();

  const order = delivery.order;
  const orderId = delivery.orderId || (order && order.orderId);
  const customerId = delivery.customer
    ? delivery.customer._id || delivery.customer
    : order && (order.userId || order.customer);

  if (customerId) {
    try {
      const { notifyUser } = require('../controllers/notification.controller');
      await notifyUser(
        customerId,
        'Your Delivery Code',
        `Your delivery #${orderId} is arriving. Give this code to the delivery person to confirm handover: ${code}. It expires in ${OTP_TTL_MINUTES} minutes. Do not share it with anyone else.`,
        'delivery_otp',
        orderId,
        `/src/pages/customer/order-tracking.html?orderId=${encodeURIComponent(orderId)}`,
        { orderType: 'delivery', otpExpiresAt: expiresAt, cafeteriaId: delivery.cafeteriaId || null }
      );
    } catch (error) {
      // The OTP is still valid and stored; a notification failure must not
      // block the courier. The code can be re-sent.
      console.warn('⚠️ Delivery OTP notification failed:', error.message);
    }
  }

  const isDev = String(process.env.NODE_ENV).toLowerCase() === 'development'
    || process.env.DELIVERY_OTP_DEV === '1';
  return { expiresAt, devOtp: isDev ? code : undefined };
}

/**
 * Verify a customer OTP against the stored one.
 *
 * Single-use and attempt-capped: a wrong guess does not clear the code (so a
 * customer who mishears a digit is not locked out), but too many wrong guesses
 * invalidates it and forces a fresh one to be generated.
 *
 * @returns {Promise<boolean>} true when the code is correct and the delivery is
 *          now marked confirmedByCustomer.
 */
async function verifyDeliveryOtp({ delivery, otp }) {
  if (!delivery) throw httpError('Delivery not found', 404);
  if (!delivery.customerOtp) {
    throw httpError('No delivery code has been generated for this order. Ask the customer to request one.', 400);
  }
  if (delivery.customerOtpExpiresAt && delivery.customerOtpExpiresAt.getTime() < Date.now()) {
    throw httpError('This delivery code has expired. Please request a new one.', 400, 'OTP_EXPIRED');
  }

  const guess = String(otp || '').trim();
  if (!/^\d{4,8}$/.test(guess)) {
    throw httpError('Enter the numeric delivery code the customer received.', 400);
  }

  if (guess !== String(delivery.customerOtp)) {
    delivery.otpAttempts = (delivery.otpAttempts || 0) + 1;
    if (delivery.otpAttempts >= OTP_MAX_ATTEMPTS) {
      delivery.customerOtp = null;
      delivery.customerOtpExpiresAt = null;
      await delivery.save();
      throw httpError('Too many incorrect codes. A new code must be generated.', 400, 'OTP_LOCKED');
    }
    await delivery.save();
    return false;
  }

  // Correct: consume the code so it cannot be replayed, and record the proof.
  delivery.customerOtp = null;
  delivery.customerOtpExpiresAt = null;
  delivery.otpAttempts = 0;
  delivery.confirmedByCustomer = true;
  delivery.proofVerifiedAt = new Date();
  await delivery.save();
  return true;
}

/**
 * Decide whether a delivery currently has acceptable proof of handover.
 *
 * Either a photo or a customer-confirmed OTP is sufficient on its own; a
 * manager override satisfies the requirement by itself and is recorded.
 */
function deliveryHasProof(delivery) {
  if (!delivery) return false;
  if (delivery.proofOverrideBy) return true;
  if (delivery.proofPhoto) return true;
  if (delivery.confirmedByCustomer) return true;
  return false;
}

/**
 * Move a delivery to DELIVERED, enforcing the proof requirement.
 *
 * This is the single writer for "the food reached the customer". A courier
 * cannot complete a run on their word alone: they must present a proof photo,
 * a verified customer OTP, or a manager must explicitly override (and say why).
 *
 * @param {object}  options
 * @param {object}  options.delivery
 * @param {object}  options.actor       req.user
 * @param {string}  [options.proofPhoto]  URL already stored by uploadDeliveryProofPhoto
 * @param {string}  [options.proofNote]
 * @param {string}  [options.otp]        Customer-entered code, verified here
 * @param {boolean} [options.isManagerOverride]
 * @param {string}  [options.overrideReason]
 */
async function markDeliveredWithProof({
  delivery,
  actor = null,
  proofPhoto = null,
  proofNote = null,
  otp = null,
  isManagerOverride = false,
  overrideReason = null,
}) {
  if (!delivery) throw httpError('Delivery not found', 404);

  const role = actor ? String(actor.role).toLowerCase() : '';
  const isManager = ['admin', 'system_admin', 'cafeteria_admin', 'manager'].includes(role);

  // A manager override is the only way past the proof requirement, and it always
  // needs a reason: an override with no explanation is exactly the kind of
  // silent exception that makes a proof system worthless.
  if (isManagerOverride) {
    if (!isManager) {
      throw httpError('Only a manager or admin can override the delivery proof requirement.', 403);
    }
    if (!String(overrideReason || '').trim()) {
      throw httpError('A reason is required to override the proof requirement.', 400, 'OVERRIDE_REASON_REQUIRED');
    }
  } else {
    // Verify the OTP if one was supplied. A wrong code is a hard stop, not a
    // silent fall-through to "no proof".
    if (otp !== null && otp !== undefined && String(otp).trim() !== '') {
      const ok = await verifyDeliveryOtp({ delivery, otp });
      if (!ok) {
        throw httpError('Incorrect delivery code. The customer can request a new one.', 400, 'OTP_INVALID');
      }
    }

    if (proofPhoto) {
      delivery.proofPhoto = proofPhoto;
    }
    if (proofNote !== undefined && proofNote !== null) {
      delivery.proofNote = String(proofNote).slice(0, 500);
    }

    if (!deliveryHasProof(delivery)) {
      throw httpError(
        'Proof of delivery required. Upload a proof photo or enter the customer delivery code, or ask a manager to override.',
        400,
        'PROOF_REQUIRED'
      );
    }
  }

  if (isManagerOverride) {
    delivery.proofOverrideBy = actor ? actor.id : null;
    delivery.proofOverrideReason = String(overrideReason).trim().slice(0, 500);
    delivery.proofVerifiedAt = delivery.proofVerifiedAt || new Date();
  } else if (!delivery.proofVerifiedAt) {
    delivery.proofVerifiedAt = new Date();
  }

  const result = await applyDeliveryStatus({
    delivery,
    status: DELIVERY_STATUS.DELIVERED,
    actor,
    reason: isManagerOverride
      ? `Marked delivered by manager override: ${String(overrideReason).trim()}`
      : 'Order delivered to customer (proof verified)',
  });

  return result;
}

// ---------------------------------------------------------------------------
// Delivery emergency (SOS)
// ---------------------------------------------------------------------------

/**
 * Raise a delivery emergency.
 *
 * Deliberately NOT a DeliveryIssue: an SOS must be acknowledged by a human
 * before it can disappear, and it must never be auto-released by the
 * issue/hold bookkeeping. This function owns that guarantee.
 *
 * Side effects, in order:
 *   1. create the emergency row (one ACTIVE per delivery, enforced by index)
 *   2. put the delivery on hold so nothing else can close it
 *   3. notify every manager of that cafeteria
 *   4. emit `delivery:emergency` to the admin/delivery rooms
 *
 * A missing GPS fix is not fatal: the rider's safety matters more than the
 * coordinates, and `locationAvailable: false` tells the dashboard to show the
 * last known position instead of pretending there is a fix.
 */
async function triggerEmergency({ delivery, actor = null, latitude = null, longitude = null, accuracy = null }) {
  if (!delivery) throw httpError('Delivery not found', 404);

  const DeliveryEmergency = require('../models/DeliveryEmergency');

  // Ownership: only the assigned rider may raise an SOS for their own run.
  const assignedId = delivery.deliveryPerson
    ? delivery.deliveryPerson._id || delivery.deliveryPerson
    : null;
  const actorId = actor ? actor.id : null;
  if (!assignedId || String(assignedId) !== String(actorId)) {
    throw httpError('Only the assigned delivery person can raise an emergency for this delivery.', 403);
  }

  // An emergency is only meaningful while the delivery is actually in flight.
  if (!isGpsAllowed(delivery.status)) {
    throw httpError(
      `An emergency can only be raised while a delivery is active (current status: ${delivery.status}).`,
      409,
      'EMERGENCY_NOT_ACTIVE'
    );
  }

  // Duplicate guard. The unique partial index is the real guarantee; this
  // pre-check just turns a race into a readable 409 instead of a driver error.
  const existing = await DeliveryEmergency.findOne({ delivery: delivery._id, status: 'ACTIVE' });
  if (existing) {
    const err = httpError('An emergency is already active for this delivery.', 409, 'EMERGENCY_EXISTS');
    err.existing = existing.toEmergencyPayload();
    throw err;
  }

  const hasFix = Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude));
  const now = new Date();

  let emergency;
  try {
    emergency = await DeliveryEmergency.create({
      delivery: delivery._id,
      order: delivery.order ? (delivery.order._id || delivery.order) : null,
      orderId: delivery.orderId,
      deliveryPerson: assignedId,
      deliveryPersonName: actor && actor.name ? actor.name : '',
      deliveryPersonPhone: actor && actor.phone ? actor.phone : '',
      cafeteriaId: delivery.cafeteriaId || null,
      latitude: hasFix ? Number(latitude) : null,
      longitude: hasFix ? Number(longitude) : null,
      accuracy: hasFix && Number.isFinite(Number(accuracy)) ? Number(accuracy) : null,
      locationAvailable: hasFix,
      status: 'ACTIVE',
      triggeredAt: now,
      statusHistory: [{ status: 'ACTIVE', at: now, by: actor ? actor.id : null, note: 'SOS raised by delivery person' }],
    });
  } catch (error) {
    if (error && error.code === 11000) {
      const err = httpError('An emergency is already active for this delivery.', 409, 'EMERGENCY_EXISTS');
      throw err;
    }
    throw error;
  }

  // Hold the delivery so it cannot be completed or failed while the rider is
  // waiting for help. Reuses the existing hold mechanism rather than inventing
  // a parallel one.
  delivery.onHold = true;
  delivery.holdReason = 'EMERGENCY';
  delivery.heldAt = delivery.heldAt || now;
  delivery.heldBy = actor ? actor.id : null;
  await delivery.save();

  // Notify every manager of this cafeteria. Best-effort: an emergency must
  // never fail to be recorded because a notification could not be sent.
  try {
    const { notifyUser } = require('../controllers/notification.controller');
    const { SYSTEM_ADMIN_ROLES } = require('../config/roles');
    const baseQuery = { status: 'ACTIVE', isActive: { $ne: false } };
    const globalQuery = { ...baseQuery, role: { $in: SYSTEM_ADMIN_ROLES } };
    const scopedQuery = {
      ...baseQuery,
      role: { $in: ['cafeteria_admin', 'manager'] },
      cafeteriaId: delivery.cafeteriaId,
    };
    const fallbackQuery = { ...baseQuery, role: { $in: ['cafeteria_admin', 'manager'] } };

    let recipients = await User.find({ $or: [globalQuery, scopedQuery] }).select('_id');
    if ((!recipients || recipients.length === 0) && delivery.cafeteriaId) {
      recipients = await User.find(fallbackQuery).select('_id');
    }

    const orderId = delivery.orderId;
    const where = hasFix
      ? `Last known location: ${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`
      : 'Location unavailable (GPS permission denied)';

    if (recipients && recipients.length) {
      await Promise.all(
        recipients.map((r) =>
          notifyUser(
            r._id,
            'EMERGENCY: Delivery Person Needs Help',
            `Delivery person ${emergency.deliveryPersonName || 'a rider'} pressed SOS on order #${orderId}. ${where}. Acknowledge it immediately in the deliveries dashboard.`,
            'delivery_emergency',
            orderId,
            `/src/pages/admin/deliveries.html?orderId=${encodeURIComponent(orderId)}`,
            {
              orderType: 'delivery',
              emergencyId: String(emergency._id),
              cafeteriaId: delivery.cafeteriaId || null,
              latitude: hasFix ? Number(latitude) : null,
              longitude: hasFix ? Number(longitude) : null,
            }
          )
        )
      );
    }
  } catch (error) {
    console.warn('⚠️ Emergency manager notification failed:', error.message);
  }

  // Realtime fan-out. The manager dashboard listens for this and shows the
  // banner + map + sound.
  try {
    const { emitSocketEvent } = require('../utils/socket');
    const payload = emergency.toEmergencyPayload();
    emitSocketEvent('admin', 'delivery:emergency', payload);
    emitSocketEvent('delivery', 'delivery:emergency', payload);
  } catch (error) {
    console.warn('⚠️ Emergency socket emit failed:', error.message);
  }

  return emergency;
}

/**
 * Acknowledge an emergency. This is the ONLY way an ACTIVE emergency leaves the
 * ACTIVE state, which is what keeps the manager banner and sound going until a
 * human has actually responded.
 */
async function acknowledgeEmergency({ emergency, actor = null }) {
  if (!emergency) throw httpError('Emergency not found', 404);
  if (emergency.status !== 'ACTIVE') {
    throw httpError(`This emergency is already ${emergency.status.toLowerCase()}.`, 409);
  }

  const now = new Date();
  emergency.status = 'ACKNOWLEDGED';
  emergency.acknowledgedAt = now;
  emergency.acknowledgedBy = actor ? actor.id : null;
  emergency.acknowledgedByName = actor && actor.name ? actor.name : '';
  emergency.statusHistory.push({
    status: 'ACKNOWLEDGED',
    at: now,
    by: actor ? actor.id : null,
    note: 'Acknowledged by manager',
  });
  await emergency.save();

  const { emitSocketEvent } = require('../utils/socket');
  emitSocketEvent('admin', 'delivery:emergency:ack', emergency.toEmergencyPayload());
  emitSocketEvent('delivery', 'delivery:emergency:ack', emergency.toEmergencyPayload());

  return emergency;
}

/**
 * Resolve an emergency (rider is safe / situation handled).
 *
 * Resolving releases the delivery hold when no other open issue is keeping it
 * held, reusing the existing issue/hold resolution path rather than duplicating
 * that logic.
 */
async function resolveEmergency({ emergency, actor = null, note = null }) {
  if (!emergency) throw httpError('Emergency not found', 404);
  if (!['ACTIVE', 'ACKNOWLEDGED'].includes(emergency.status)) {
    throw httpError(`This emergency is already ${emergency.status.toLowerCase()}.`, 409);
  }

  const now = new Date();
  emergency.status = 'RESOLVED';
  emergency.resolvedAt = now;
  emergency.resolvedBy = actor ? actor.id : null;
  emergency.resolutionNote = note ? String(note).slice(0, 500) : null;
  emergency.statusHistory.push({
    status: 'RESOLVED',
    at: now,
    by: actor ? actor.id : null,
    note: note ? String(note).slice(0, 500) : 'Emergency resolved',
  });
  await emergency.save();

  // Release the hold this emergency created, but only if nothing else is
  // holding the delivery. DeliveryIssue owns the authoritative open-issue
  // count, so ask it rather than guessing.
  try {
    const Delivery = require('../models/Delivery');
    const delivery = await Delivery.findById(emergency.delivery);
    if (delivery && delivery.onHold && delivery.holdReason === 'EMERGENCY') {
      const DeliveryIssue = require('../models/DeliveryIssue');
      const openCount = await DeliveryIssue.countDocuments({
        delivery: delivery._id,
        status: { $in: ['OPEN', 'IN_PROGRESS'] },
      });
      if (openCount === 0) {
        delivery.onHold = false;
        delivery.holdReason = null;
        delivery.resumedAt = now;
        await delivery.save();
      }
    }
  } catch (error) {
    console.warn('⚠️ Could not release emergency hold:', error.message);
  }

  const { emitSocketEvent } = require('../utils/socket');
  emitSocketEvent('admin', 'delivery:emergency:resolved', emergency.toEmergencyPayload());
  emitSocketEvent('delivery', 'delivery:emergency:resolved', emergency.toEmergencyPayload());

  return emergency;
}

/** The currently ACTIVE emergency for a delivery, or null. */
async function getActiveEmergency(deliveryId) {
  const DeliveryEmergency = require('../models/DeliveryEmergency');
  return DeliveryEmergency.findOne({ delivery: deliveryId, status: 'ACTIVE' });
}

/**
 * The emergency a manager still has to deal with: ACTIVE, or ACKNOWLEDGED and
 * not yet resolved. Resolving is only possible from one of these two states,
 * which is what lets a rider acknowledge a manager's response and then close
 * the incident themselves.
 */
async function getOpenEmergency(deliveryId) {
  const DeliveryEmergency = require('../models/DeliveryEmergency');
  return DeliveryEmergency.findOne({
    delivery: deliveryId,
    status: { $in: ['ACTIVE', 'ACKNOWLEDGED'] },
  }).sort({ triggeredAt: -1 });
}

module.exports = {
  DELIVERY_STATUS,
  DELIVERY_TRANSITIONS,
  TERMINAL_STATUSES,
  GPS_ALLOWED_STATUSES,
  ASSIGNABLE_STATUSES,
  STATUS_TO_ORDER,
  normalizeStatus,
  humanize,
  isTerminal,
  isGpsAllowed,
  isAssignable,
  canTransition,
  assertTransition,
  deliveryStatusFromOrder,
  haversineKm,
  proximityToCustomer,
  isValidCoordinate,
  isUsableDeliveryCoordinate,
  cleanCoordinate,
  resolvePickupLocation,
  estimateEtaMinutes,
  calculateDeliveryFee,
  ensureDeliveryForOrder,
  applyDeliveryStatus,
  findDeliveryByReference,
  recordCourierLocation,
  touchCourier,
  NEAR_CUSTOMER_RADIUS_M,
  generateDeliveryOtp,
  verifyDeliveryOtp,
  deliveryHasProof,
  markDeliveredWithProof,
  triggerEmergency,
  acknowledgeEmergency,
  resolveEmergency,
  getActiveEmergency,
  getOpenEmergency,
  httpError,
};
