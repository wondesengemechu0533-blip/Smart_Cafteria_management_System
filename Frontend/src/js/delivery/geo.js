/**
 * Smart Cafeteria Ordering System
 * File: frontend/src/js/delivery/geo.js
 *
 * Shared geographic helpers for real-time delivery tracking.
 *
 * ONE implementation of the two things every tracking surface needs:
 *   1. great-circle distance (Haversine - never a lat/long subtraction)
 *   2. the "you are near the customer" proximity rule
 *
 * Reused by the courier GPS tracker (delivery/gps.js), the courier dashboard
 * (delivery/gps-ui.js), the customer tracking map (customer-tracking-map.js) and
 * the manager monitor, so a distance shown to a customer and the same distance
 * shown to their rider can never disagree.
 *
 * Nothing in this module invents a coordinate: it only measures between points
 * that already exist, and it returns null (never a guess) when either end is
 * missing.
 */

/** Proximity radius in metres. Mirrors delivery.service.NEAR_CUSTOMER_RADIUS_M. */
export const NEAR_CUSTOMER_RADIUS_M = 100;

const EARTH_RADIUS_M = 6371000;

/**
 * Coerce a coordinate to a finite number, or null.
 *
 * `Number(null)`, `Number('')` and `Number([])` are all 0, so a blank field
 * would otherwise become a real point in the Gulf of Guinea. Anything that is
 * not a real, finite number is rejected outright.
 */
export function toCoord(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean" || typeof value === "object") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A usable {latitude, longitude} pair, or null. Rejects (0, 0) as "unset". */
export function normalizePoint(point) {
  if (!point) return null;
  const lat = toCoord(point.latitude);
  const lng = toCoord(point.longitude);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return {
    latitude: lat,
    longitude: lng,
    accuracy: toCoord(point.accuracy),
    // `updatedAt` is the canonical field name; `timestamp` is the stored /
    // legacy name. Both are accepted so every caller can pass its own shape.
    updatedAt: point.updatedAt || point.timestamp || null,
  };
}

/**
 * Great-circle distance in METRES between two points (Haversine).
 * Returns null when either point is missing or out of range.
 */
export function haversineMeters(a, b) {
  const p1 = normalizePoint(a);
  const p2 = normalizePoint(b);
  if (!p1 || !p2) return null;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(p2.latitude - p1.latitude);
  const dLng = toRad(p2.longitude - p1.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(p1.latitude)) * Math.cos(toRad(p2.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Great-circle distance in KM, or null. */
export function haversineKm(a, b) {
  const m = haversineMeters(a, b);
  return m === null ? null : m / 1000;
}

/**
 * Human-readable distance, e.g. "820 m" / "2.4 km".
 * Returns null when the distance cannot be measured - the caller then hides the
 * row instead of showing "0 km".
 */
export function formatDistance(km) {
  if (km === null || km === undefined || !Number.isFinite(Number(km))) return null;
  const n = Number(km);
  if (n < 1) return `${Math.max(1, Math.round(n * 1000))} m`;
  if (n < 10) return `${n.toFixed(1)} km`;
  return `${Math.round(n)} km`;
}

/** Human-readable GPS accuracy, e.g. "8 m" / "±1.2 km". */
export function formatAccuracy(meters) {
  const n = toCoord(meters);
  if (n === null) return null;
  return n >= 1000 ? `±${(n / 1000).toFixed(1)} km` : `±${Math.round(n)} m`;
}

/**
 * Is `point` within the proximity radius of the customer?
 *
 * ADVISORY ONLY. This never advances a delivery: the courier must still confirm
 * ARRIVED and DELIVERED by hand, so an inaccurate fix (or a customer next door)
 * can never auto-confirm a handover.
 */
export function isNearCustomer(point, customerLocation, radiusM = NEAR_CUSTOMER_RADIUS_M) {
  const meters = haversineMeters(point, customerLocation);
  return meters === null ? false : meters <= radiusM;
}

/**
 * One measurement object for every tracking surface:
 *   { hasCustomerLocation, distanceKm, distanceMeters, nearCustomer }
 * All nulls (never zero) when the customer shared no location, so an
 * address-only delivery honestly reports "no distance" instead of "0 km away".
 */
export function measureToCustomer(point, customerLocation, radiusM = NEAR_CUSTOMER_RADIUS_M) {
  const customer = normalizePoint(customerLocation);
  if (!customer) {
    return { hasCustomerLocation: false, distanceKm: null, distanceMeters: null, nearCustomer: false };
  }
  const meters = haversineMeters(point, customer);
  if (meters === null) {
    return { hasCustomerLocation: true, distanceKm: null, distanceMeters: null, nearCustomer: false };
  }
  return {
    hasCustomerLocation: true,
    distanceKm: meters / 1000,
    distanceMeters: Math.round(meters),
    nearCustomer: meters <= radiusM,
  };
}

/** "Just now" / "12s ago" / "3m ago" / an absolute time once it is old. */
export function formatRelativeTime(value, now = Date.now()) {
  if (!value) return null;
  const when = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(when)) return null;
  const seconds = Math.max(0, Math.round((now - when) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(when).toLocaleString();
}

/**
 * Is the Geolocation API usable at all?
 * `reason` explains which precondition failed so the UI can say something
 * specific instead of a generic failure.
 */
export function checkGeolocationSupport() {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return { supported: false, secure: false, reason: "NOT_SUPPORTED" };
  }
  // Browsers only expose Geolocation in a secure context (HTTPS or localhost).
  const secure = typeof window === "undefined" || window.isSecureContext !== false;
  if (!secure) return { supported: false, secure: false, reason: "INSECURE_CONTEXT" };
  return { supported: true, secure: true, reason: null };
}

/* ---------------------------------------------------------------------------
 * Permission state
 *
 * Reading the permission NEVER triggers a prompt. That is the whole point: the
 * app must be able to answer "has this browser already been asked, and what was
 * the answer?" without causing another prompt. Once answered, `prompt` is a
 * refusal to try again unattended - the only way forward is the user changing
 * the site's location setting and clicking Retry.
 * ------------------------------------------------------------------------- */

export const PERMISSION_STATE = {
  GRANTED: "granted",
  DENIED: "denied",
  PROMPT: "prompt",      // supported, but the user has never been asked
  UNKNOWN: "unknown",    // browser will not tell us (no Permissions API)
  UNSUPPORTED: "unsupported",
};

/**
 * Read the current geolocation permission WITHOUT prompting.
 *
 * @returns {Promise<{state: string, known: boolean}>}
 *   state   one of PERMISSION_STATE
 *   known   false when the browser does not expose the Permissions API for
 *           geolocation, so the caller must fall back to the error code from a
 *           real attempt instead of assuming anything.
 */
export async function queryGeolocationPermission() {
  const support = checkGeolocationSupport();
  if (!support.supported) {
    return { state: PERMISSION_STATE.UNSUPPORTED, known: true, reason: support.reason };
  }
  const perms = typeof navigator !== "undefined" ? navigator.permissions : null;
  if (!perms || typeof perms.query !== "function") {
    // Firefox with `permissions.geolocation.events.enabled` off, or an old
    // engine. We genuinely do not know - say so instead of guessing "granted".
    return { state: PERMISSION_STATE.UNKNOWN, known: false, reason: "NO_PERMISSIONS_API" };
  }
  try {
    // NOTE: this is a *query*, not a request. It resolves without any UI.
    const status = await perms.query({ name: "geolocation" });
    return { state: status.state, known: true, reason: null };
  } catch (e) {
    // Some engines know the Permissions API but not the geolocation name.
    return { state: PERMISSION_STATE.UNKNOWN, known: false, reason: "QUERY_UNSUPPORTED" };
  }
}

/**
 * Subscribe to permission changes (the user flipping the site setting, or the
 * OS revoking it). Returns an unsubscribe function; safe to call when the
 * Permissions API is missing (returns a no-op).
 *
 * This is how a blocked rider can recover WITHOUT being re-prompted: the app
 * watches the state, and once it flips to "granted" the Retry button becomes
 * live again.
 */
export function watchGeolocationPermission(onChange) {
  const perms = typeof navigator !== "undefined" ? navigator.permissions : null;
  if (!perms || typeof perms.query !== "function" || typeof perms.addEventListener !== "function") {
    return () => {};
  }
  let status = null;
  const handler = () => {
    if (status && onChange) onChange(status.state);
  };
  perms
    .query({ name: "geolocation" })
    .then((s) => {
      status = s;
      if (typeof s.addEventListener === "function") s.addEventListener("change", handler);
      else if (typeof s.onchange !== "undefined") s.onchange = handler;
    })
    .catch(() => {
      /* permission name unsupported - nothing to watch */
    });
  return () => {
    if (status && typeof status.removeEventListener === "function") {
      status.removeEventListener("change", handler);
    }
  };
}

/**
 * Human-readable guidance for a denied permission, per the browser.
 * Returned as a ready-to-show object so every surface (courier panel, checkout)
 * tells the user the same thing.
 */
export function permissionHelpMessage() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  let where;
  if (/Edg\//.test(ua)) {
    where = "click the padlock / lock icon in the address bar → Site permissions → Location → Allow, then Reload.";
  } else if (/OPR\//.test(ua) || /Opera/.test(ua)) {
    where = "click the padlock icon in the address bar → Site settings → Location → Allow, then Reload.";
  } else if (/Firefox\//.test(ua)) {
    where = "click the padlock icon in the address bar → Clear permission for Location, then Reload and try again.";
  } else if (/Chrome\//.test(ua)) {
    where = "click the lock icon in the address bar → Site settings → Location → Allow, then Reload.";
  } else if (/Safari\//.test(ua)) {
    where = "open Safari → Settings for This Website → Location → Allow, then Reload.";
  } else {
    where = "open your browser's site settings for this page, set Location to Allow, then Reload.";
  }
  return {
    title: "Location permission denied",
    body:
      "Your browser will not ask again on its own. Allow location for this site in your browser settings, " +
      "then press Retry. You can keep ordering either way - the delivery address is still used.",
    steps: where,
  };
}
