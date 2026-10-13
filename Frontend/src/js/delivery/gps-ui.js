/**
 * Smart Cafeteria - shared GPS status UI for delivery staff pages.
 * Renders the six GPS states, Start/Stop visibility, and the rider metrics
 * panel (latitude, longitude, accuracy, last updated). Staff-only - never
 * imported by customer pages. Labels come from the shared i18n system
 * (Frontend/src/js/utils/i18n.js) via window.getText.
 */
import { gpsTracker, gpsUiStatus } from "./gps.js";
import { mapAvailable, PERMISSION_STATE, permissionHelpMessage } from "./live-map.js";
import { formatDistance } from "./geo.js";
import { geocodeSearchHtml } from "./geocode-search.js";

export function isAmharic() {
  return typeof window.getCurrentLanguage === "function" && window.getCurrentLanguage() === "am";
}

export function escGps(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

// Shared i18n lookup with English fallback (single source: i18n.js keys).
function t(key, fallback) {
  try {
    if (window.getText) {
      const v = window.getText(key);
      if (v && v !== key) return v;
    }
  } catch (e) {}
  return fallback;
}

/** i18n keys for the six required GPS statuses. */
export const GPS_STATE_KEY = {
  permission_required: "gps_state_permission_required",
  active: "gps_state_active",
  permission_denied: "gps_state_permission_denied",
  unavailable: "gps_state_unavailable",
  error: "gps_state_error",
  stopped: "gps_state_stopped",
};

export const GPS_STATE_ICON = {
  permission_required: "fa-key",
  active: "fa-satellite-dish",
  permission_denied: "fa-lock",
  unavailable: "fa-signal",
  error: "fa-triangle-exclamation",
  stopped: "fa-circle-stop",
};

/** i18n keys for detail lines under the status pill (errors / waiting). */
export const GPS_DETAIL_KEY = {
  GPS_DENIED: "gps_detail_denied",
  GPS_NOT_SUPPORTED: "gps_detail_not_supported",
  GPS_INSECURE: "gps_detail_insecure",
  GPS_UNAVAILABLE: "gps_detail_unavailable",
  GPS_TIMEOUT: "gps_detail_timeout",
  GPS_ERROR: "gps_detail_error",
  GPS_SEND_FAILED: "gps_detail_send_failed",
  INVALID_FIX: "gps_detail_invalid_fix",
  GPS_PERMISSION_BLOCKED: "gps_detail_blocked",
};

export function gpsStateLabel(status) {
  const key = GPS_STATE_KEY[status] || GPS_STATE_KEY.permission_required;
  return t(key, status);
}

export function gpsDetailText(code) {
  const key = GPS_DETAIL_KEY[code];
  if (!key) return "";
  return t(key, code);
}

function fmtTime(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleTimeString();
  } catch (e) {
    return "—";
  }
}

function fmtCoord(n, digits) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(digits);
}

/**
 * Distance from the rider's fix to the customer's drop-off point.
 *
 * Passed in from the map reconciler (which already measured it with Haversine,
 * from the same helper the customer map uses) so the rider's readout and the
 * customer's map can never disagree. Server value is the fallback for when no
 * live fix has arrived yet.
 */
function distanceText(measure, order) {
  const fromMeasure = measure && measure.distanceKm != null ? measure.distanceKm : null;
  const fromServer = order && typeof order.distanceToCustomerKm === "number" ? order.distanceToCustomerKm : null;
  return formatDistance(fromMeasure != null ? fromMeasure : fromServer);
}

/**
 * Metrics panel HTML: latitude, longitude, accuracy, last updated, distance.
 *
 * `measure` is the per-order measurement from syncDashboardMaps(); `order` is the
 * card's delivery payload (used only for the server-side distance fallback).
 */
export function gpsMetricsHtml(snap, measure, order) {
  // Prefer the browser's own last fix; otherwise fall back to the order's
  // stored fix (server mirror of the last upload). Without the fallback a
  // manager - or a rider between polls - sees only dashes even though the
  // database already holds a real position.
  const stored = order && order.currentLocation;
  const storedFix =
    stored && Number.isFinite(Number(stored.latitude)) && Number.isFinite(Number(stored.longitude))
      ? stored
      : null;
  const fix = (snap && snap.lastFix) || storedFix;
  const lat = fix ? fmtCoord(fix.latitude, 6) : "—";
  const lng = fix ? fmtCoord(fix.longitude, 6) : "—";
  let acc = "—";
  if (fix && Number.isFinite(Number(fix.accuracy))) {
    const a = Number(fix.accuracy);
    acc = a >= 1000 ? "±" + (a / 1000).toFixed(1) + " km" : "±" + Math.round(a) + " m";
  } else if (snap && snap.accuracy != null && Number.isFinite(Number(snap.accuracy))) {
    acc = "±" + Math.round(Number(snap.accuracy)) + " m";
  }
  const updated = fmtTime((fix && (fix.ts || fix.timestamp)) || (snap && snap.lastSyncAt) || null);
  const distance = distanceText(measure, order);

  const labels = [
    t("gps_metric_lat", "Latitude"),
    t("gps_metric_lng", "Longitude"),
    t("gps_metric_acc", "Accuracy"),
    t("gps_metric_updated", "Last updated"),
  ];

  return `
    <div class="gps-metrics">
      <div class="gps-metric"><span class="gps-metric-label">${labels[0]}</span><span class="gps-metric-value">${escGps(lat)}</span></div>
      <div class="gps-metric"><span class="gps-metric-label">${labels[1]}</span><span class="gps-metric-value">${escGps(lng)}</span></div>
      <div class="gps-metric"><span class="gps-metric-label">${labels[2]}</span><span class="gps-metric-value">${escGps(acc)}</span></div>
      <div class="gps-metric"><span class="gps-metric-label">${labels[3]}</span><span class="gps-metric-value">${escGps(updated)}</span></div>
      <div class="gps-metric"><span class="gps-metric-label">${escGps(t("gps_metric_distance", "Distance to customer"))}</span><span class="gps-metric-value">${escGps(distance || "—")}</span></div>
    </div>
  `;
}

/**
 * The per-delivery map container, with the place search box above it.
 *
 * Rendered only when Leaflet actually loaded - otherwise it would leave a grey
 * rectangle with no explanation. `delivery/dashboard-map.js` finds the map node
 * by `[data-gps-map]` and the search form by `#geocodeSearch-<orderId>`, and
 * attaches both.
 */
export function gpsMapHtml(orderId) {
  if (!mapAvailable()) {
    return `<div class="gps-status gps-muted" data-gps-map-unavailable="${escGps(orderId)}">
      ${escGps(t("map_unavailable_offline", "Live map is unavailable right now."))}
    </div>`;
  }
  // The form is a sibling of the map (never a child), so Leaflet's panes can
  // never sit on top of the input or the suggestion dropdown.
  return geocodeSearchHtml(orderId) + `<div class="d-gps-map" data-gps-map="${escGps(orderId)}"></div>`;
}

function statusPillHtml(status) {
  const icon = GPS_STATE_ICON[status] || GPS_STATE_ICON.permission_required;
  return `<i class="fa-solid ${icon}"></i> ${escGps(gpsStateLabel(status))}`;
}

/**
 * Sync every GPS panel on the page:
 *   [data-gps-panel="<orderId>"] with optional children
 *     [data-gps-state], [data-gps="start"], [data-gps="stop"],
 *     [data-gps-metrics], [data-gps-detail], [data-gps-near]
 * showControls: true → Start/Stop buttons visible per status.
 *                false (queue page) → no start/stop buttons (read-only panel).
 * measures:     optional Map<orderId, {distanceKm, nearCustomer, ...}> from
 *               syncDashboardMaps(), used for the distance metric and the
 *               "you are near the customer" hint.
 * orderById:    optional Map/function orderId → order payload, for the
 *               server-side distance fallback when no live fix has arrived.
 */
export function syncGpsPanels(showControls, measures, orderById) {
  const lookupOrder = typeof orderById === "function" ? orderById : (id) => (orderById ? orderById.get(id) : null);

  document.querySelectorAll("[data-gps-panel]").forEach((panel) => {
    const orderId = panel.getAttribute("data-gps-panel");
    const snap = gpsTracker.getState(orderId);
    const status = gpsUiStatus(snap);
    const measure = measures && typeof measures.get === "function" ? measures.get(orderId) : null;
    const order = lookupOrder ? lookupOrder(orderId) : null;

    const pill = panel.querySelector("[data-gps-state]");
    if (pill) {
      pill.className = "gps-state state-" + status;
      pill.innerHTML = statusPillHtml(status);
      pill.setAttribute("data-gps-status-name", status);
    }

    const startBtn = panel.querySelector('[data-gps="start"]');
    const stopBtn = panel.querySelector('[data-gps="stop"]');
    const retryBtn = panel.querySelector('[data-gps="retry"]');
    const help = panel.querySelector("[data-gps-help]");
    // A refused permission is terminal until the user changes their browser
    // setting, so show Retry + the instructions, and hide Start (which could not
    // work and would only re-show a dead prompt).
    const blocked = Boolean(snap && snap.blocked);

    if (startBtn && stopBtn) {
      if (showControls) {
        const watching = status === "active";
        startBtn.style.display = !watching && !blocked ? "" : "none";
        stopBtn.style.display = watching ? "" : "none";
      } else {
        startBtn.style.display = "none";
        stopBtn.style.display = "none";
      }
    }
    if (retryBtn) {
      retryBtn.style.display = showControls && blocked ? "" : "none";
    }
    if (help) {
      help.style.display = blocked ? "" : "none";
      if (blocked && !help.dataset.filled) {
        help.innerHTML = gpsHelpHtml();
        help.dataset.filled = "1";
      }
    }

    const badge = panel.querySelector("[data-gps-badge]");
    if (badge) {
      if (status === "active") {
        badge.textContent = "●";
        badge.classList.add("gps-live");
      } else {
        badge.textContent = "";
        badge.classList.remove("gps-live");
      }
    }

    const metrics = panel.querySelector("[data-gps-metrics]");
    if (metrics) {
      metrics.innerHTML = gpsMetricsHtml(snap, measure, order);
    }

    // Proximity hint. ADVISORY ONLY - it tells the rider they are close, it
    // never marks the order arrived or delivered. The rider still has to press
    // Mark Arrived and Mark Delivered themselves.
    const near = panel.querySelector("[data-gps-near]");
    if (near) {
      const isNear = Boolean(measure && measure.nearCustomer);
      const known = Boolean(measure && measure.hasCustomerLocation);
      near.style.display = isNear ? "" : "none";
      if (isNear) {
        const distance = formatDistance(measure.distanceKm);
        near.innerHTML =
          '<i class="fa-solid fa-location-crosshairs"></i> ' +
          escGps(t("gps_near_customer", "You are near the customer's location.")) +
          (distance ? ` <span class="gps-near-distance">(${escGps(distance)})</span>` : "");
      } else if (!known) {
        // No customer coordinates on this order -> say so once, rather than
        // leaving an empty gap where the hint would be.
        near.style.display = "none";
      }
    }

    const detail = panel.querySelector("[data-gps-detail]");
    if (detail) {
      let line = "";
      let cls = "";
      // Pre-pickup cards (assigned / accepted / ready-for-delivery) have no
      // position to show yet - the backend only accepts fixes once the food
      // moves - so say exactly that instead of inviting a Start tap that the
      // server would refuse. Once tracking is genuinely active, the normal
      // states below take over.
      const prePickup = panel.hasAttribute("data-gps-prepickup");
      const idlePrePickup = prePickup && (status === "permission_required" || status === "stopped");
      if (idlePrePickup) {
        const startBtnPre = panel.querySelector('[data-gps="start"]');
        const stopBtnPre = panel.querySelector('[data-gps="stop"]');
        const retryBtnPre = panel.querySelector('[data-gps="retry"]');
        if (startBtnPre) startBtnPre.style.display = "none";
        if (stopBtnPre) stopBtnPre.style.display = "none";
        if (retryBtnPre) retryBtnPre.style.display = "none";
      }
      if (idlePrePickup && !blocked) {
        line = t(
          "gps_begins_at_pickup",
          "No position yet - GPS tracking begins when you pick up the order."
        );
        cls = "gps-wait";
      } else if (blocked) {
        // The one case that needs the longest copy: the browser will not ask
        // again, so the rider has to change a setting.
        line = t(
          "gps_blocked_hint",
          "Location permission is required to track this delivery. Your browser will not ask again - see the steps below."
        );
        cls = "gps-err";
      } else if (status === "permission_required") {
        line = t("gps_wait_start", "Tap Start to allow location access for this delivery.");
        cls = "gps-wait";
      } else if (status === "active" && snap && snap.status === "starting") {
        line = t("gps_waiting_signal", "Waiting for GPS signal…");
        cls = "gps-wait";
      } else if (status === "active") {
        line = t("gps_live_on", "Live tracking is on.");
        cls = "gps-ok";
      } else if (status === "stopped") {
        line = t("gps_stopped_msg", "Tracking stopped for this delivery.");
        cls = "gps-muted";
      } else if (snap && snap.error) {
        line = gpsDetailText(snap.error) || gpsStateLabel(status);
        cls = "gps-err";
      } else {
        line = gpsStateLabel(status);
        cls = status === "permission_denied" || status === "error" ? "gps-err" : "gps-wait";
      }
      detail.innerHTML = `<span class="${cls}">${escGps(line)}</span>`;
    }
  });
}

/** Default panel markup pieces shared by dashboard + queue pages. */
export function gpsControlsHtml(orderId) {
  const startLabel = t("delivery_gps_start", "Start GPS Tracking");
  const stopLabel = t("delivery_gps_stop", "Stop GPS");
  return `
    <button type="button" class="btn-action btn-gps" data-gps="start" data-order="${escGps(orderId)}">
      <i class="fa-solid fa-satellite-dish"></i> ${startLabel}
    </button>
    <button type="button" class="btn-action btn-gps btn-gps-stop" data-gps="stop" data-order="${escGps(orderId)}" style="display:none">
      <i class="fa-solid fa-circle-stop"></i> ${stopLabel}
    </button>
    <!-- Shown ONLY when the browser refused and will not ask again. It re-reads
         the permission (a query, not a prompt) and starts tracking only if the
         user has since allowed location in site settings. -->
    <button type="button" class="btn-action btn-gps btn-gps-retry" data-gps="retry" data-order="${escGps(orderId)}" style="display:none">
      <i class="fa-solid fa-rotate-right"></i> ${t("gps_retry", "Retry")}
    </button>
    <span class="gps-badge" data-gps-badge="${escGps(orderId)}"></span>
  `;
}

/**
 * The blocked-permission notice: what happened, and the one thing the user has
 * to do (browser site settings). Rendered instead of the Start button so the
 * rider is never invited to press a button that cannot work.
 */
function gpsHelpHtml() {
  const help = permissionHelpMessage();
  return `
    <div class="gps-help">
      <strong><i class="fa-solid fa-lock"></i> ${escGps(t("gps_blocked_title", help.title))}</strong>
      <p>${escGps(t("gps_blocked_body", help.body))}</p>
      <p class="gps-help-steps">${escGps(t("gps_blocked_steps", help.steps))}</p>
      <small>${escGps(t("gps_blocked_fallback", "You can still complete this delivery - the customer address is shown on the card."))}</small>
    </div>
  `;
}
