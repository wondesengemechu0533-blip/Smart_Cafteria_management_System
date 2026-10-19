/**
 * Smart Cafeteria Ordering System
 * File: frontend/src/js/delivery/gps.js
 *
 * Real GPS tracking for delivery staff.
 *
 * Uses the browser Geolocation API (navigator.geolocation.watchPosition).
 * Coordinates are ALWAYS the delivery person's real device fix - never
 * generated, mocked, interpolated, incremented, or invented. The backend
 * validates every upload (ownership, active delivery status, value ranges,
 * server-side rate limit), so a broken/malicious client cannot forge or spam
 * locations.
 *
 * Cadence: upload when moving at least MOVE_THRESHOLD_M from the last upload
 * (and at least MIN_SYNC_INTERVAL_MS has passed) or once per SYNC_INTERVAL_MS.
 * Fixes coarser than MAX_ACCURACY_M are real but not reliable enough to share.
 *
 * Lifecycle: tracking runs ONLY while the delivery person has an active
 * delivery (PICKED_UP / OUT_FOR_DELIVERY / ARRIVED). Call syncActiveDeliveries()
 * with the current active order ids to start tracking for active orders and stop
 * it for completed/cancelled ones - so there is never a GPS watch without an
 * active delivery.
 *
 * UI statuses (gpsUiStatus):
 *   permission_required | active | permission_denied | unavailable | error | stopped
 */

import api from "../api.js";
// Shared distance math (Haversine) + geolocation support / permission checks.
// One implementation for the whole app, so a distance shown here and the same
// distance on the customer map can never disagree.
import {
  haversineMeters,
  normalizePoint,
  checkGeolocationSupport,
  queryGeolocationPermission,
  watchGeolocationPermission,
  permissionHelpMessage,
  PERMISSION_STATE,
} from "./geo.js";

const MIN_SYNC_INTERVAL_MS = 5000;
const SYNC_INTERVAL_MS = 15000;
const MOVE_THRESHOLD_M = 30;
const MAX_ACCURACY_M = 200;

const GEO_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 8000,
  timeout: 30000,
};

/** Terminal / retryable error codes stored on tracker state.error. */
export const GPS_ERROR_CODES = {
  DENIED: "GPS_DENIED",
  NOT_SUPPORTED: "GPS_NOT_SUPPORTED",
  INSECURE: "GPS_INSECURE",
  UNAVAILABLE: "GPS_UNAVAILABLE",
  TIMEOUT: "GPS_TIMEOUT",
  ERROR: "GPS_ERROR",
  SEND_FAILED: "GPS_SEND_FAILED",
  INVALID_FIX: "INVALID_FIX",
  /**
   * The browser already showed its permission prompt and the user did not
   * grant it. Unlike the transient codes above this is NOT retryable from
   * code: after a refusal the browser ignores further JS requests, so the only
   * way forward is the user changing the site setting and pressing Retry.
   */
  BLOCKED: "GPS_PERMISSION_BLOCKED",
};

/** Six customer-facing (staff UI) GPS statuses. */
export const GPS_UI_STATUSES = [
  "permission_required",
  "active",
  "permission_denied",
  "unavailable",
  "error",
  "stopped",
];

function haversine(lat1, lon1, lat2, lon2) {
  return haversineMeters({ latitude: lat1, longitude: lon1 }, { latitude: lat2, longitude: lon2 });
}

function snapshot(state) {
  if (!state) return null;
  return {
    orderId: state.orderId,
    status: state.status,
    error: state.error,
    accuracy: state.accuracy,
    lastSyncAt: state.lastSyncAt,
    sentCount: state.sentCount,
    lastFix: state.lastFix ? { ...state.lastFix } : null,
    // Permission bookkeeping. `blocked` means the browser refused and will not
    // ask again, so the UI must offer site-settings + Retry instead of another
    // "Start" that silently does nothing.
    blocked: Boolean(state.blocked),
    permission: state.permission,
    promptIssued: Boolean(state.promptIssued),
    attempt: state.attempt || 0,
  };
}

function baseState(orderId, status, error, extra) {
  return {
    orderId,
    status,
    error: error || null,
    watchId: null,
    lastFix: null,
    lastSentLat: undefined,
    lastSentLng: undefined,
    lastSentAt: 0,
    lastSyncAt: null,
    accuracy: null,
    sentCount: 0,
    blocked: false,
    permission: PERMISSION_STATE.UNKNOWN,
    promptIssued: false,
    attempt: 0,
    ...(extra || {}),
  };
}

/** The "asked and refused" state, shared by every refusal path. */
function blockedState(orderId) {
  return baseState(orderId, "error", GPS_ERROR_CODES.BLOCKED, {
    blocked: true,
    permission: PERMISSION_STATE.DENIED,
    promptIssued: true,
  });
}

/**
 * Map a tracker snapshot (or null) to one of the six UI statuses.
 * - null                      → permission_required (nothing started yet)
 * - blocked permission        → permission_denied (asked, refused, needs settings)
 * - GPS_DENIED                → permission_denied
 * - not supported / insecure /
 *   POSITION_UNAVAILABLE      → unavailable
 * - timeout / send / invalid /
 *   generic                   → error
 * - starting / tracking       → active
 */
export function gpsUiStatus(snap) {
  if (!snap) return "permission_required";
  if (snap.status === "stopped") return "stopped";
  if (snap.blocked) return "permission_denied";
  if (snap.error === GPS_ERROR_CODES.DENIED) return "permission_denied";
  if (
    snap.error === GPS_ERROR_CODES.NOT_SUPPORTED ||
    snap.error === GPS_ERROR_CODES.INSECURE ||
    snap.error === GPS_ERROR_CODES.UNAVAILABLE
  ) {
    return "unavailable";
  }
  if (snap.error) return "error";
  if (snap.status === "starting" || snap.status === "tracking") return "active";
  if (snap.status === "error") return "error";
  return "permission_required";
}

class DeliveryGpsTracker {
  constructor() {
    this.trackers = new Map();
    this._listeners = new Set();
    // Last permission state read from the browser, refreshed on demand and kept
    // live by the Permissions API watcher. Reading it never prompts.
    this.permission = {
      state: PERMISSION_STATE.UNKNOWN,
      known: false,
      reason: null,
    };
    /**
     * Latch: has this page already caused the browser to show its location
     * prompt? Once true, NO automatic path may fire another request - that is
     * what stops the repeated-prompt loop (page load, 30s poll, socket events,
     * tab refocus, and every status transition all used to re-request).
     */
    this._promptIssued = false;
    this._permissionWatch = null;
  }

  /** Read the permission state. Pass {fresh:true} to re-query the browser. */
  async refreshPermission({ fresh = false } = {}) {
    if (!fresh && this.permission.known) return this.permission;
    const result = await queryGeolocationPermission();
    this.permission = result;
    // Becoming un-blocked (the user allowed it in site settings) must make the
    // Retry button live again, so clear the block and let the UI repaint.
    if (result.state === PERMISSION_STATE.GRANTED) {
      this.trackers.forEach((state) => {
        if (!state.blocked) return;
        state.blocked = false;
        state.error = null;
        state.status = "stopped";
      });
      this._notify();
    }
    return this.permission;
  }

  /**
   * Start watching the device's real GPS.
   *
   * This is the ONLY method that calls navigator.geolocation.watchPosition(),
   * and it is guarded so an unattended caller can never cause a permission
   * prompt:
   *
   *   permission === 'denied'            -> refuse, mark blocked, NO request.
   *                                         The browser ignores JS requests after
   *                                         a refusal anyway, so firing one just
   *                                         re-shows a dead prompt.
   *   permission === 'prompt' && prompt already issued && !userInitiated
   *                                      -> refuse. The user was already asked
   *                                         once and did not grant.
   *   otherwise                          -> request (this is what shows the
   *                                         browser prompt, at most once).
   *
   * @param {string} orderId
   * @param {{userInitiated?: boolean}} [opts]
   *        userInitiated MUST be true only from a real click handler
   *        ("Start Delivery" / "Start GPS Tracking" / "Retry").
   */
  async start(orderId, opts = {}) {
    if (!orderId) return null;
    const userInitiated = opts.userInitiated === true;

    const support = checkGeolocationSupport();
    if (!support.supported) {
      const code =
        support.reason === "INSECURE_CONTEXT" ? GPS_ERROR_CODES.INSECURE : GPS_ERROR_CODES.NOT_SUPPORTED;
      this.trackers.set(orderId, baseState(orderId, "error", code));
      this._notify();
      return this.getState(orderId);
    }

    // Re-read the permission before every request. This is a query, not a
    // prompt, so it is safe to do here.
    const permission = await this.refreshPermission({ fresh: true });
    const permissionState = permission.state;
    console.log(`[GPS] permission state=${permissionState} orderId=${orderId} userInitiated=${userInitiated}`);

    // Already watching: nothing to do (and definitely no second prompt).
    const existing = this.trackers.get(orderId);
    if (existing && (existing.status === "starting" || existing.status === "tracking")) {
      return this.getState(orderId);
    }

    if (permissionState === PERMISSION_STATE.DENIED) {
      // Refused. Do not attempt again from any path.
      this.trackers.set(orderId, blockedState(orderId));
      this._notify();
      return this.getState(orderId);
    }

    if (
      permissionState === PERMISSION_STATE.PROMPT &&
      this._promptIssued &&
      !userInitiated
    ) {
      // Already asked once this session and not granted. Refuse to ask again
      // from an unattended path - the fix is site settings + a manual Retry.
      this.trackers.set(
        orderId,
        baseState(orderId, "error", GPS_ERROR_CODES.BLOCKED, {
          blocked: true,
          permission: permissionState,
          promptIssued: true,
        })
      );
      this._notify();
      return this.getState(orderId);
    }

    // A fresh attempt: drop any previous watch first so we never leak one.
    if (existing) {
      this._clearWatch(existing);
      this.trackers.delete(orderId);
    }

    const state = baseState(orderId, "starting", null, {
      permission: permissionState,
      promptIssued: this._promptIssued || permissionState === PERMISSION_STATE.PROMPT,
      attempt: (existing && existing.attempt ? existing.attempt : 0) + 1,
    });

    // This is the single line in the whole app that can show the browser's
    // location prompt. Everything else only *queries* the permission.
    if (permissionState === PERMISSION_STATE.PROMPT) this._promptIssued = true;

    state.watchId = navigator.geolocation.watchPosition(
      (pos) => this._onPosition(orderId, state, pos),
      (err) => this._onError(orderId, state, err),
      GEO_OPTIONS
    );

    this.trackers.set(orderId, state);
    this._notify();
    return this.getState(orderId);
  }

  /**
   * Retry after the user changed the site's location setting.
   *
   * Re-reads the permission and only proceeds when the browser now reports
   * `granted` - so pressing Retry can never re-trigger the prompt, it either
   * starts tracking or explains that the setting is still off.
   */
  async retryAfterPermissionChange(orderId) {
    if (!orderId) return null;
    const permission = await this.refreshPermission({ fresh: true });
    if (permission.state === PERMISSION_STATE.DENIED) {
      this.trackers.set(orderId, blockedState(orderId));
      this._notify();
      return this.getState(orderId);
    }
    if (permission.state !== PERMISSION_STATE.GRANTED) {
      // Still unknown / never asked. A deliberate click is a legitimate moment
      // to ask, so go through the normal guarded path as a user gesture.
      return this.start(orderId, { userInitiated: true });
    }
    // Granted: clear the block and start. No prompt is shown in this branch.
    const existing = this.trackers.get(orderId);
    if (existing) {
      existing.blocked = false;
      existing.error = null;
      if (existing.status === "error" || existing.status === "stopped") {
        existing.status = "stopped";
      }
      this._notify();
    }
    return this.start(orderId, { userInitiated: true });
  }

  /**
   * The delivery person's current fix, used to draw the route to a chosen
   * destination immediately (before any watch uploads a point).
   *
   * Order of preference:
   *   1. the freshest fix from a running watch (no new permission prompt),
   *   2. a one-shot getCurrentPosition (prompts only when `allowPrompt` is true
   *      and the browser has not already refused).
   * Never invents a coordinate: returns null when unavailable.
   *
   * @returns {Promise<{latitude, longitude, accuracy, ts}|null>}
   */
  async currentFix({ timeoutMs = 8000, allowPrompt = true } = {}) {
    // 1) A running watch already holds the freshest fix - use it, don't prompt.
    for (const state of this.trackers.values()) {
      if (state && state.lastFix && Number.isFinite(state.lastFix.latitude) && Number.isFinite(state.lastFix.longitude)) {
        return { ...state.lastFix };
      }
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) return null;

    // Only prompt when the caller allows it AND the browser has not refused.
    try {
      if (navigator.permissions && typeof navigator.permissions.query === "function") {
        const status = await navigator.permissions.query({ name: "geolocation" });
        if (status && status.state === "denied") return null;
        if (status && status.state !== "granted" && !allowPrompt) return null;
      }
    } catch (e) {
      /* Permissions API unavailable: fall through and let the request decide */
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const c = pos && pos.coords ? pos.coords : null;
            if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return finish(null);
            finish({
              latitude: c.latitude,
              longitude: c.longitude,
              accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
              ts: Number.isFinite(pos.timestamp) ? pos.timestamp : Date.now(),
            });
          },
          () => finish(null),
          { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs }
        );
      } catch (e) {
        finish(null);
      }
    });
  }

  onChange(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }
  _notify() {
    this._listeners.forEach((cb) => cb(this));
  }

  isTracking(orderId) {
    const st = this.trackers.get(orderId);
    return Boolean(st && (st.status === "starting" || st.status === "tracking"));
  }

  trackedOrderIds() {
    return Array.from(this.trackers.keys()).filter((id) => this.isTracking(id));
  }

  getState(orderId) {
    return snapshot(this.trackers.get(orderId));
  }

  /** UI-facing status for an order (one of GPS_UI_STATUSES). */
  uiStatus(orderId) {
    return gpsUiStatus(this.trackers.get(orderId) || null);
  }

  _clearWatch(state) {
    if (
      state &&
      state.watchId != null &&
      typeof navigator !== "undefined" &&
      navigator.geolocation
    ) {
      try {
        navigator.geolocation.clearWatch(state.watchId);
      } catch (e) {
        /* ignore */
      }
    }
    if (state) state.watchId = null;
  }

  /**
   * Stop watching. Keeps a terminal "stopped" snapshot so the UI can show
   * "Tracking Stopped" instead of silently going blank. The watch handle is
   * always cleared - no background GPS without an active user/auto start.
   */
  stop(orderId) {
    const state = this.trackers.get(orderId);
    if (!state) return;
    this._clearWatch(state);
    state.status = "stopped";
    state.error = null;
    this._notify();
  }

  /** Fully forget an order's GPS state (used when the order is no longer active). */
  clear(orderId) {
    const state = this.trackers.get(orderId);
    if (!state) return;
    this._clearWatch(state);
    this.trackers.delete(orderId);
    this._notify();
  }

  stopAll() {
    Array.from(this.trackers.keys()).forEach((id) => this.stop(id));
  }

  /**
   * Reconcile RUNNING watches against the caller's active deliveries.
   *
   * This method deliberately NEVER starts a watch.
   *
   * It used to call start() for every active order, which meant the browser's
   * location prompt fired on page load, on the 30s poll, on every socket event,
   * on every tab refocus and after every stage change - the repeated-prompt
   * loop. loadQueues() calls this ~10x per minute, so a rider was re-prompted
   * constantly and could never dismiss the prompt.
   *
   * Now:
   *   - orders no longer active -> tracking is cleared (no GPS without work)
   *   - orders still active with a running watch -> left running
   *   - orders still active with no watch -> left in `permission_required`.
   *     The rider presses "Start GPS Tracking" (or Start Delivery), which is the
   *     only path allowed to request the browser prompt.
   */
  syncActiveDeliveries(activeOrderIds) {
    const active = new Set(
      (Array.isArray(activeOrderIds) ? activeOrderIds : [])
        .filter((id) => id != null && id !== "")
        .map(String)
    );
    Array.from(this.trackers.keys()).forEach((id) => {
      if (!active.has(String(id))) this.clear(id);
    });
  }

  /**
   * Begin the Permissions API watcher so a rider who allows location in their
   * browser settings sees the Retry button become usable without reloading.
   * Idempotent, and safe when the Permissions API is unavailable.
   */
  watchPermissionChanges() {
    if (this._permissionWatch) return;
    this._permissionWatch = watchGeolocationPermission(() => {
      // Drop the cached answer so the next explicit start/retry re-reads it.
      this.permission = { state: PERMISSION_STATE.UNKNOWN, known: false, reason: null };
      this.refreshPermission({ fresh: true });
    });
  }

  /** Stop the Permissions API watcher (page teardown). */
  unwatchPermissionChanges() {
    if (typeof this._permissionWatch === "function") this._permissionWatch();
    this._permissionWatch = null;
  }

  /** Current permission state + the site-settings help text. */
  permissionHelp() {
    return permissionHelpMessage();
  }

  _onPosition(orderId, state, pos) {
    const { latitude, longitude, accuracy } = pos.coords;
    // Optional movement data reported by the device: course over ground
    // (degrees) and speed (m/s). Null when the receiver does not provide them
    // - never invented.
    const heading = Number.isFinite(pos.coords.heading) ? pos.coords.heading : null;
    const speed = Number.isFinite(pos.coords.speed) && pos.coords.speed >= 0 ? pos.coords.speed : null;
    // Prefer the device fix's own timestamp (epoch ms) so the stored point
    // reflects when the GPS fix was taken, not when we processed it.
    const ts = Number.isFinite(pos.timestamp) ? pos.timestamp : Date.now();

    // Basic shape validation before we even consider storing/uploading.
    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      !Number.isFinite(accuracy) ||
      accuracy < 0
    ) {
      // Keep the previous good fix (if any); only flag the bad sample.
      console.log(`[GPS] invalid fix rejected orderId=${orderId} lat=${latitude} lng=${longitude} acc=${accuracy}`);
      state.error = GPS_ERROR_CODES.INVALID_FIX;
      state.status = state.status === "stopped" ? state.status : "tracking";
      this._notify();
      return;
    }

    const firstFix = state.status === "starting";
    state.lastFix = { latitude, longitude, accuracy, heading, speed, ts };
    state.accuracy = accuracy;
    state.error = null;
    state.status = "tracking";
    if (firstFix) {
      console.log(
        `[GPS] first fix orderId=${orderId} lat=${latitude} lng=${longitude}` +
          ` acc=${accuracy} heading=${heading} speed=${speed}`
      );
    }

    // Keep the map/status informed even when we don't upload.
    if (accuracy > MAX_ACCURACY_M) {
      this._notify();
      return;
    }

    const now = Date.now();
    const sinceLast = now - state.lastSentAt;
    const moved =
      state.lastSentLat === undefined ||
      haversine(state.lastSentLat, state.lastSentLng, latitude, longitude) >= MOVE_THRESHOLD_M;

    if (sinceLast >= SYNC_INTERVAL_MS || (moved && sinceLast >= MIN_SYNC_INTERVAL_MS) || state.lastSentAt === 0) {
      void this._send(orderId, state, latitude, longitude, accuracy, heading, speed, ts);
    } else {
      this._notify();
    }
  }

  async _send(orderId, state, latitude, longitude, accuracy, heading = null, speed = null, ts = Date.now()) {
    // Ignore late sends after a manual stop.
    if (state.status === "stopped" || !this.trackers.has(orderId)) return;
    console.log(
      `[GPS] API request orderId=${orderId} lat=${latitude} lng=${longitude}` +
        ` acc=${accuracy} heading=${heading} speed=${speed}`
    );
    try {
      await api.post(`/deliveries/${orderId}/location`, {
        latitude,
        longitude,
        accuracy,
        heading,
        speed,
        timestamp: ts,
      });
      // State may have been stopped/cleared while the request was in flight.
      if (!this.trackers.has(orderId) || this.trackers.get(orderId) !== state) return;
      state.lastSentAt = Date.now();
      state.lastSyncAt = new Date().toISOString();
      state.lastSentLat = latitude;
      state.lastSentLng = longitude;
      state.sentCount += 1;
      state.error = null;
      console.log(`[GPS] upload ok orderId=${orderId} sentCount=${state.sentCount}`);
    } catch (err) {
      if (!this.trackers.has(orderId) || this.trackers.get(orderId) !== state) return;
      console.log(`[GPS] upload failed orderId=${orderId} status=${err && err.status}`);
      // Network failure / 5xx / 4xx all surface as a clear upload error;
      // 4xx means the backend says this delivery can't be tracked anymore
      // (e.g. already delivered, cancelled, or not assigned) - stop watching
      // so we don't hammer the server with retries that will never succeed.
      state.error = GPS_ERROR_CODES.SEND_FAILED;
      if (state.status !== "stopped" && state.status !== "error") {
        state.status = "tracking";
      }
      if (err && err.status && err.status >= 400 && err.status < 500) {
        this.stop(orderId);
        state.error = GPS_ERROR_CODES.SEND_FAILED;
      }
    } finally {
      this._notify();
    }
  }

  _onError(orderId, state, err) {
    if (!this.trackers.has(orderId) || this.trackers.get(orderId) !== state) return;
    // GeolocationPositionError codes:
    //   1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
    const code = err && err.code;
    if (code === 1) {
      state.error = GPS_ERROR_CODES.DENIED;
      // Terminal: the browser refused. It will not prompt again from JS, so
      // record the refusal and let the UI ask for site settings + Retry. The
      // cached permission is refreshed so every later guard sees `denied`.
      state.blocked = true;
      state.permission = PERMISSION_STATE.DENIED;
      state.promptIssued = true;
      this._promptIssued = true;
      this.permission = { state: PERMISSION_STATE.DENIED, known: true, reason: null };
    } else if (code === 2) state.error = GPS_ERROR_CODES.UNAVAILABLE;
    else if (code === 3) state.error = GPS_ERROR_CODES.TIMEOUT;
    else state.error = GPS_ERROR_CODES.ERROR;

    state.status = "error";

    // The browser stops the watch after a permission denial; drop our handle so
    // a later tap on "Start"/"Retry" can request permission again. For transient
    // errors (unavailable / timeout) keep the handle - the watch may recover -
    // but the UI still reports the specific status until a fix arrives.
    if (code === 1) state.watchId = null;

    this._notify();
  }
}

export const gpsTracker = new DeliveryGpsTracker();
export default gpsTracker;
