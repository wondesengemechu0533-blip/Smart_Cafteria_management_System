/**
 * Delivery Issue service.
 *
 * Owns the issue domain rules so the controller stays thin and the rules are
 * unit-testable without Express or Mongo:
 *
 *   - the issue state machine (OPEN -> IN_PROGRESS -> RESOLVED | CANCELLED)
 *   - STRICT coordinate validation. `null` means "no GPS fix available" and is
 *     never coerced to 0,0. A half-pair (lat without lng) is rejected outright.
 *   - which issue types delay the customer, so an internal problem (GPS glitch)
 *     is never leaked to them as a delay
 *   - resolving an issue releases the delivery hold, but NEVER advances the
 *     delivery state - only the courier (or a manager) can do that
 *
 * The delivery state machine (services/delivery.service.js) is deliberately left
 * untouched: an issue is an annotation on a delivery, not a delivery status.
 */

const mongoose = require('mongoose');
const DeliveryIssue = require('../models/DeliveryIssue');
const deliveryService = require('./delivery.service');

const {
  DELIVERY_ISSUE_TYPES,
  DELIVERY_ISSUE_STATUSES,
  ISSUE_TRANSITIONS,
  CUSTOMER_DELAYING_TYPES,
} = DeliveryIssue;

/** Issues may only be raised while the delivery is actually under way. */
const REPORTABLE_DELIVERY_STATUSES = ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED'];

// --- coordinates ---------------------------------------------------------

/**
 * Coerce an untrusted coordinate to a real number inside [min, max], or null.
 *
 * `Number(null)`, `Number('')` and `Number([])` are all 0, so a naive coercion
 * turns "the courier had no GPS fix" into latitude 0 / longitude 0 - a point in
 * the Atlantic that then looks like a real, reportable position. Every
 * falsy-but-not-a-number input is rejected explicitly instead.
 */
function strictCoordinate(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'object') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * Normalise a reported location.
 *
 * Returns `{ ok, latitude, longitude, accuracy, locationAvailable, reason }`.
 *
 * - Both coordinates valid  -> stored, locationAvailable true.
 * - Neither supplied       -> GPS unavailable, BOTH null, locationAvailable
 *   false. This is a legitimate report and is never an error.
 * - Exactly one supplied   -> rejected. A half pair is a client bug, and
 *   guessing the missing half would invent a position.
 */
function normalizeLocation({ latitude, longitude, accuracy } = {}) {
  const lat = strictCoordinate(latitude, -90, 90);
  const lng = strictCoordinate(longitude, -180, 180);

  const latSupplied = latitude !== undefined && latitude !== null && latitude !== '';
  const lngSupplied = longitude !== undefined && longitude !== null && longitude !== '';

  if (!latSupplied && !lngSupplied) {
    return {
      ok: true,
      latitude: null,
      longitude: null,
      accuracy: null,
      locationAvailable: false,
      reason: null,
    };
  }

  if (lat === null || lng === null) {
    return {
      ok: false,
      latitude: null,
      longitude: null,
      accuracy: null,
      locationAvailable: false,
      reason:
        'Invalid GPS location. Both latitude and longitude are required and must be valid coordinates.',
    };
  }

  const acc = strictCoordinate(accuracy, 0, 10000);
  return {
    ok: true,
    latitude: lat,
    longitude: lng,
    accuracy: acc,
    locationAvailable: true,
    reason: null,
  };
}

/**
 * Did the client actually attempt to send a position?
 *
 * Used to tell "no GPS" (acceptable: accept the report and flag it
 * location-unavailable) apart from "malformed GPS" (a client bug: reject).
 * `null`, `undefined` and empty strings count as "not sent".
 */
function hasAnyCoordinate(location) {
  if (!location || typeof location !== 'object') return false;
  return ['latitude', 'longitude'].some((key) => {
    const value = location[key];
    if (value === undefined || value === null) return false;
    if (typeof value === 'string' && value.trim() === '') return false;
    return true;
  });
}

/** Great-circle distance, only when BOTH points are genuinely known. */function kmBetween(a, b) {
  if (!a || !b) return null;
  if (a.lat === null || a.lat === undefined || a.lng === null || a.lng === undefined) return null;
  if (b.lat === null || b.lat === undefined || b.lng === null || b.lng === undefined) return null;
  const lat1 = Number(a.lat), lng1 = Number(a.lng);
  const lat2 = Number(b.lat), lng2 = Number(b.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// --- issue type ----------------------------------------------------------

/** Normalise a client-supplied issue type (tolerates spacing/case). */
function normalizeIssueType(value) {
  const raw = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (!raw) return null;
  return DELIVERY_ISSUE_TYPES.includes(raw) ? raw : null;
}

function normalizeIssueStatus(value) {
  const raw = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (!raw) return null;
  return DELIVERY_ISSUE_STATUSES.includes(raw) ? raw : null;
}

/** Does this issue type, on its own, justify telling the customer it's late? */
function isCustomerDelaying(issueType) {
  return CUSTOMER_DELAYING_TYPES.includes(issueType);
}

/**
 * Resolve an acting user's id.
 *
 * `auth.protect` builds `req.user` from the JWT payload plus the User row, and
 * it exposes the id as `id` - there is no `_id` on that object. A raw User
 * document (or a test double) may only have `_id`. Accept both, and normalise
 * to a string so it can never be written as `undefined` and silently break the
 * "who reported / who resolved" audit trail.
 */
function actorIdOf(actor) {
  if (!actor) return null;
  const id = actor._id ?? actor.id;
  if (!id) return null;
  if (typeof id === 'string') return id;
  if (typeof id.toHexString === 'function') return id.toHexString();
  return String(id);
}

// --- state machine -------------------------------------------------------

/** Can `from` legally become `to`? */
function canTransition(from, to) {
  return Array.isArray(ISSUE_TRANSITIONS[from]) && ISSUE_TRANSITIONS[from].includes(to);
}

function assertTransition(from, to) {
  if (from === to) {
    const err = new Error(`Issue is already ${to}`);
    err.statusCode = 400;
    throw err;
  }
  if (!canTransition(from, to)) {
    const err = new Error(`Cannot change issue status from ${from} to ${to}`);
    err.statusCode = 400;
    throw err;
  }
}

// --- reporting -----------------------------------------------------------

/**
 * Create an issue for a delivery.
 *
 * `actor` must be the delivery's assigned courier - the caller (controller)
 * has already verified ownership against the JWT. This function refuses to
 * write an issue for a delivery that is not in a reportable state, so a stale
 * or forged request cannot attach a problem to a finished delivery.
 */
async function reportIssue({ delivery, order, actor, issueType, description, location, photo = null }) {
  if (!delivery || !order) {
    const err = new Error('Delivery not found');
    err.statusCode = 404;
    throw err;
  }

  if (!REPORTABLE_DELIVERY_STATUSES.includes(delivery.status)) {
    const err = new Error(
      `A problem can only be reported while the delivery is in progress (current: ${delivery.status})`
    );
    err.statusCode = 400;
    throw err;
  }

  const type = normalizeIssueType(issueType);
  if (!type) {
    const err = new Error(`Invalid issue type. Allowed: ${DELIVERY_ISSUE_TYPES.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  const text = String(description ?? '').trim();
  if (!text) {
    const err = new Error('A description is required so the manager knows what happened');
    err.statusCode = 400;
    throw err;
  }

  // One open issue of the same type per delivery: a courier stuck in traffic
  // must not be able to spam ten identical reports.
  const existingOpen = await DeliveryIssue.findOne({
    delivery: delivery._id,
    issueType: type,
    status: { $in: ['OPEN', 'IN_PROGRESS'] },
  });
  if (existingOpen) {
    const err = new Error(
      'An issue of this type is already open for this delivery. It has been updated instead.'
    );
    err.statusCode = 409;
    err.existingIssue = existingOpen;
    throw err;
  }

  const loc = normalizeLocation(location || {});

  // "No GPS at all" is legitimate - a courier in a tunnel genuinely has no fix,
  // and the report must still be accepted and flagged location-unavailable.
  // A *partial or malformed* pair is different: the client meant to send a
  // position and got it wrong, so reject it loudly instead of silently
  // discarding the coordinates.
  if (!loc.locationAvailable && hasAnyCoordinate(location)) {
    const err = new Error(
      'Invalid GPS location. Both latitude and longitude are required and must be valid coordinates.'
    );
    err.statusCode = 400;
    throw err;
  }

  // Prefer the courier's real last fix from the delivery record when the client
  // sent nothing usable - that is a more accurate position than nothing, and it
  // is genuinely theirs. Never fall back to the destination or to 0,0.
  let latitude = loc.latitude;
  let longitude = loc.longitude;
  let accuracy = loc.accuracy;
  let locationAvailable = loc.locationAvailable;
  if (!locationAvailable) {
    const current = delivery.currentLocation || {};
    const fromDelivery = normalizeLocation({
      latitude: current.latitude,
      longitude: current.longitude,
      accuracy: current.accuracy,
    });
    if (fromDelivery.locationAvailable) {
      latitude = fromDelivery.latitude;
      longitude = fromDelivery.longitude;
      accuracy = fromDelivery.accuracy;
      locationAvailable = true;
    }
  }

  // `protect` puts the id on `req.user.id` (there is no `_id` on that object), but
  // a raw User document does have `_id`. Accept either so a reporter is never
  // silently dropped as `undefined`.
  const actorId = actorIdOf(actor);

  const issue = await DeliveryIssue.create({
    order: order._id,
    orderId: order.orderId,
    delivery: delivery._id,
    reportedBy: actorId,
    reportedByName: actor.name || '',
    reportedByPhone: actor.phone || '',
    cafeteriaId: delivery.cafeteriaId || order.cafeteriaId || null,
    customer: delivery.customer || order.userId || null,
    issueType: type,
    description: text,
    photo: photo || null,
    latitude,
    longitude,
    accuracy,
    locationAvailable,
    deliveryStatusAtReport: delivery.status,
    reportedAt: new Date(),
    status: 'OPEN',
    delaysDelivery: isCustomerDelaying(type),
    statusHistory: [{ status: 'OPEN', at: new Date(), by: actorId, note: text.slice(0, 200) }],
  });

  return issue;
}

// --- resolution ----------------------------------------------------------

/**
 * Move an issue to a new status, validating the transition.
 *
 * Resolving or cancelling clears the delivery hold only if no OTHER open issue
 * still needs it. It never advances the delivery status: the courier decides
 * when the food actually arrives.
 */
async function applyIssueStatus({ issue, status, actor, note = null, holdRelease = true }) {
  const target = normalizeIssueStatus(status);
  if (!target) {
    const err = new Error(`Invalid issue status. Allowed: ${DELIVERY_ISSUE_STATUSES.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  assertTransition(issue.status, target);
  const actorId = actorIdOf(actor);

  issue.status = target;
  if (target === 'RESOLVED' || target === 'CANCELLED') {
    issue.resolvedAt = new Date();
    issue.resolvedBy = actorId;
    issue.resolutionNote = note ? String(note).trim() : null;
  }
  issue.statusHistory.push({
    status: target,
    at: new Date(),
    by: actorId,
    note: note ? String(note).trim().slice(0, 200) : '',
  });

  await issue.save();

  // Release the hold only when this was the last open issue.
  if (holdRelease && (target === 'RESOLVED' || target === 'CANCELLED')) {
    await releaseHoldIfClear(issue);
  }

  return issue;
}

/**
 * Clear `onHold` on the delivery once no open issue remains. The Delivery is
 * imported lazily to keep this module free of a circular require.
 */
async function releaseHoldIfClear(issue) {
  const Delivery = require('../models/Delivery');
  const remaining = await DeliveryIssue.countDocuments({
    delivery: issue.delivery,
    status: { $in: ['OPEN', 'IN_PROGRESS'] },
  });
  if (remaining > 0) return false;

  const delivery = await Delivery.findById(issue.delivery);
  if (!delivery || !delivery.onHold) return false;

  delivery.onHold = false;
  delivery.holdReason = null;
  delivery.heldAt = null;
  delivery.heldBy = null;
  delivery.resumedAt = new Date();
  await delivery.save();
  issue.deliveryOnHold = false;
  await issue.save();
  return true;
}

/** Every still-open issue on a delivery, oldest first. */
async function getOpenIssues(deliveryId) {
  return DeliveryIssue.find({
    delivery: deliveryId,
    status: { $in: ['OPEN', 'IN_PROGRESS'] },
  }).sort({ createdAt: 1 });
}

/** True when the delivery has an open issue and therefore must not auto-complete. */
async function hasOpenIssue(deliveryId) {
  const count = await DeliveryIssue.countDocuments({
    delivery: deliveryId,
    status: { $in: ['OPEN', 'IN_PROGRESS'] },
  });
  return count > 0;
}

module.exports = {
  DELIVERY_ISSUE_TYPES,
  DELIVERY_ISSUE_STATUSES,
  ISSUE_TRANSITIONS,
  CUSTOMER_DELAYING_TYPES,
  REPORTABLE_DELIVERY_STATUSES,
  strictCoordinate,
  normalizeLocation,
  hasAnyCoordinate,
  normalizeIssueType,
  normalizeIssueStatus,
  isCustomerDelaying,
  actorIdOf,
  canTransition,
  assertTransition,
  kmBetween,
  reportIssue,
  applyIssueStatus,
  releaseHoldIfClear,
  getOpenIssues,
  hasOpenIssue,
  // Re-exported so callers do not need a second require just to sanity-check a
  // delivery status against the delivery service's own definition.
  isReportableDeliveryStatus: (status) => REPORTABLE_DELIVERY_STATUSES.includes(status),
  deliveryService,
  mongoose,
};
