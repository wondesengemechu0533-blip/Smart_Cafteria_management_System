/**
 * Smart Cafeteria Ordering System
 * File: frontend/src/js/customer-tracking-map.js
 *
 * Live GPS delivery tracking for the Customer Order Tracking page.
 *
 * This is the CONSUMER half of the GPS feature. The producer half already exists
 * (delivery/gps.js uploads the courier's real device fix, the server stores it and
 * fans it out on `delivery:location`); this module renders it.
 *
 * Data flow - all of it server-side, nothing from localStorage:
 *   GET /orders/:id            -> initial state (status, customer location,
 *                                 courier, cafeteria, last known fix, distance)
 *   order:status / delivery:*  -> status changes (socket + the page's own poll)
 *   delivery:location          -> the moving courier marker (socket)
 *   socket disconnect/reconnect-> explicit "Reconnecting… / Connected" status
 *
 * Behaviour by delivery status (see README section "GPS tracking rules"):
 *   picked_up        GPS tracking starts, map becomes live
 *   out_for_delivery "Your order is on the way" + live map
 *   arrived          "Driver has arrived near your location." + live map
 *   delivered        STOP live tracking, show the final state
 *   completed        last known location only - no marker, no socket
 *   cancelled        map hidden
 *
 * Backward compatible: an order with neither customer GPS nor a courier fix
 * shows "GPS location unavailable for this order." and the rest of the page
 * keeps working. The message is cleared as soon as real courier coordinates
 * arrive (socket frame or stored fix) - the courier's own position is enough
 * to place a marker. Leaflet missing (blocked or not yet loaded) degrades to a
 * plain text status - the page never throws.
 */

import api from "./api.js";
import { socketClient } from "./socket.js";
import { LiveDeliveryMap, mapAvailable } from "./delivery/live-map.js";
import { normalizePoint, measureToCustomer, formatDistance, formatAccuracy, formatRelativeTime } from "./delivery/geo.js";

// Delivery statuses for which the courier's device is uploading a live fix.
const GPS_ACTIVE = new Set(["picked_up", "out_for_delivery", "arrived"]);
// Terminal statuses: no live marker, no socket subscription, last fix only.
const FINISHED = new Set(["delivered", "completed", "failed", "cancelled"]);

let map = null;
let orderId = null;
let joined = false;
let subscribed = false;
let lastOrder = null;
let lastPoint = null;
let hasCustomerLocation = false;
let relativeTimer = null;

const $ = (id) => document.getElementById(id);

/** i18n lookup with an English fallback (keys live in src/js/utils/i18n.js). */
function t(key, fallback) {
  try {
    if (typeof window.getText === "function") {
      const v = window.getText(key);
      if (v && v !== key) return v;
    }
  } catch (e) {
    /* fall through */
  }
  return fallback != null ? fallback : key;
}

function esc(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

/** Delivery-record status if present, else the order status, lower-cased. */
function effectiveStage(order) {
  if (!order) return "";
  const raw = order.deliveryStatus || order.status || "";
  return String(raw).toString().trim().toLowerCase();
}

function show(el, visible) {
  if (!el) return;
  el.style.display = visible ? "" : "none";
}

function setSummaryItem(itemId, valueId, value) {
  const item = $(itemId);
  const target = $(valueId);
  const text = value == null || value === "" ? null : String(value);
  if (target) target.textContent = text || "—";
  if (item) show(item, Boolean(text));
}

/* -------------------------------------------------------------------------
 * Status line under the map
 * ---------------------------------------------------------------------- */

function setMapStatus(text, kind) {
  const el = $("delivery-map-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("is-waiting", "is-unavailable");
  if (kind) el.classList.add(kind);
}

/** Connection badge: explicit "Reconnecting…" / "Connected", never silent. */
function setConnection(state, detail) {
  const el = $("track-connection");
  if (!el) return;
  el.classList.remove("is-live", "is-waiting", "is-offline");
  if (state === "connected") {
    el.innerHTML = '<i class="fa-solid fa-wifi"></i> ' + esc(t("track_connected", "Connected"));
    el.classList.add("is-live");
  } else if (state === "reconnecting") {
    el.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + esc(t("track_reconnecting", "Reconnecting…"));
    el.classList.add("is-waiting");
  } else {
    el.innerHTML =
      '<i class="fa-solid fa-wifi"></i> ' +
      esc(detail || t("track_offline", "Live updates unavailable"));
    el.classList.add("is-offline");
  }
}

/* -------------------------------------------------------------------------
 * Header copy for the tracked status
 * ---------------------------------------------------------------------- */

const STAGE_HEADING = {
  ready_for_delivery: ["Sent for Delivery", null],
  picked_up: ["Picked Up", "🚚 Your order has left the cafeteria and is on its way to you."],
  out_for_delivery: ["Out for Delivery", null],
  arrived: ["Arrived", "Driver has arrived near your location."],
  delivered: ["Delivered", "Your order has been delivered. Enjoy your meal!"],
  completed: ["Completed", "Your order has been completed."],
};

/**
 * Localized subtext for stages whose wording must match the timeline exactly.
 * Null entries in STAGE_HEADING resolve here so English/Amharic stay in sync
 * with order-status.js instead of drifting into a second copy of the strings.
 */
function stageSubtext(stage) {
  if (stage === "ready_for_delivery") return t("track_ready_for_delivery", "🚚 Your order is ready and has been sent for delivery.");
  if (stage === "out_for_delivery") return t("track_out_for_delivery", "🛵 Your order is out for delivery.");
  return null;
}

/**
 * The tracker heading for a delivery stage. Only OVERWRITES what the timeline
 * already showed for the same stage, so it can never contradict the receipt.
 */
function applyStageHeading(stage) {
  const entry = STAGE_HEADING[stage];
  if (!entry) return;
  const heading = $("status-heading");
  const subtext = $("status-subtext");
  if (heading && (!heading.textContent || heading.textContent === "Order Tracker")) {
    heading.textContent = entry[0];
  }
  if (subtext) {
    const localized = stageSubtext(stage);
    subtext.textContent = localized != null ? localized : entry[1];
  }
}

/* -------------------------------------------------------------------------
 * Map wiring
 * ---------------------------------------------------------------------- */

function customerLocationOf(order) {
  const info = order.deliveryInfo || {};
  const fromCanonical = order.customerLocation;
  const source =
    fromCanonical && (fromCanonical.latitude != null || fromCanonical.longitude != null)
      ? fromCanonical
      : { latitude: info.latitude, longitude: info.longitude };
  return normalizePoint(source);
}

function courierPointOf(order) {
  const loc = order.deliveryLocation || order.currentLocation;
  if (!loc) return null;
  return normalizePoint(loc);
}

function showMapError(message) {
  const el = $("delivery-map");
  if (!el) return;
  // Replace the (possibly empty/grey) map placeholder entirely: the customer
  // must see an honest error, never a blank grey rounded box.
  el.classList.add("delivery-map--error");
  el.innerHTML =
    '<div class="delivery-map-error-message">' +
    '<i class="fa-solid fa-triangle-exclamation"></i> ' +
    esc(message) +
    "</div>";
}

function clearMapError() {
  const el = $("delivery-map");
  if (!el) return;
  el.classList.remove("delivery-map--error");
  el.style.height = "";
  // Leaflet was gone (retry a later snapshot): if error text is still
  // present, wipe it before L.map tries to render tiles into the div.
  if (el.querySelector(".delivery-map-error-message")) {
    el.textContent = "";
  }
}

function ensureMap() {
  if (map) return map;
  const container = $("delivery-map");
  if (!mapAvailable()) {
    showMapError(t("map_unavailable_offline", "Live map is unavailable right now."));
    return null;
  }
  if (!container) return null;
  let created = null;
  let ok = false;
  try {
    created = new LiveDeliveryMap(container);
    ok = created.init();
  } catch (e) {
    ok = false;
    console.error("[map] init failed:", e && e.message);
  }
  if (!ok) {
    showMapError(t("map_unavailable_offline", "Live map is unavailable right now."));
    return null;
  }
  clearMapError();
  map = created;
  return map;
}

function teardownMap() {
  if (map) {
    map.destroy();
    map = null;
  }
}

/**
 * Render everything from one order snapshot + (optionally) one live GPS frame.
 *
 * @param {object} order        live order from GET /orders/:id
 * @param {object} [point]      a `delivery:location` payload
 * @param {boolean} [liveFrame] true when `point` just arrived over the socket
 */
export function renderCustomerTracking(order, point, liveFrame) {
  lastOrder = order || lastOrder;
  if (!lastOrder) return;

  if (liveFrame && point) lastPoint = point;

  const stage = effectiveStage(lastOrder);
  const isDelivery = String(lastOrder.orderType || "").toLowerCase() === "delivery";
  const customer = customerLocationOf(lastOrder);
  hasCustomerLocation = Boolean(customer);
  const gpsActive = GPS_ACTIVE.has(stage);
  const finished = FINISHED.has(stage);

  // Once the delivery is over the live frame is dropped on purpose: the marker
  // must freeze on the LAST KNOWN fix stored in the database, and the distance
  // shown must come from that stored fix - not from a position the customer
  // happened to still be holding in memory.
  if (!gpsActive && finished) lastPoint = null;

  const courier = lastPoint
    ? normalizePoint({
        latitude: lastPoint.latitude,
        longitude: lastPoint.longitude,
        accuracy: lastPoint.accuracy,
        updatedAt: lastPoint.updatedAt || lastPoint.timestamp,
      })
    : courierPointOf(lastOrder);

  // ---- 1. Map card visibility -------------------------------------------------
  // Shown for a delivery order from pickup onwards, and kept visible (frozen)
  // afterwards so the customer can still see where the food was dropped off.
  const showCard = isDelivery && stage !== "" && stage !== "cancelled" && stage !== "failed";
  show($("delivery-map-card"), showCard);
  show($("track-summary"), showCard);

  if (!showCard) {
    teardownMap();
    stopRelativeClock();
    leaveRoom();
    return;
  }

  // ---- 2. Summary strip -------------------------------------------------------
  const cafeteria = lastOrder.cafeteriaLocation || lastOrder.pickupLocation || null;
  setSummaryItem(
    "track-cafeteria-item",
    "track-cafeteria",
    (cafeteria && (cafeteria.name || cafeteria.address)) || null
  );
  setSummaryItem(
    "track-courier-item",
    "track-courier",
    (lastOrder.deliveryCourier && lastOrder.deliveryCourier.name) ||
      (lastOrder.deliveryStaffAssigned &&
        (lastOrder.deliveryStaffAssigned.name || lastOrder.deliveryStaffAssigned)) ||
      null
  );

  // Distance is Haversine (geo.js) between the courier's real fix and the
  // customer's real saved location - never a lat/long subtraction.
  const measure = measureToCustomer(courier, customer);
  const serverDistance =
    measure.distanceKm != null
      ? measure.distanceKm
      : typeof lastOrder.distanceToCustomerKm === "number"
        ? lastOrder.distanceToCustomerKm
        : null;
  setSummaryItem("track-distance-item", "track-distance", formatDistance(serverDistance));
  setSummaryItem(
    "track-eta-item",
    "track-eta",
    lastOrder.etaMinutes ? `~${lastOrder.etaMinutes} min` : null
  );

  // ---- 3. Status line ---------------------------------------------------------
  // "GPS location unavailable" is a LAST RESORT: it needs BOTH the customer's
  // destination coordinates AND the courier's fix to be missing. As soon as the
  // courier reports a real position, the message is replaced by the live status
  // line - the customer does not need destination GPS to watch the rider move.
  if (!hasCustomerLocation && !courier) {
    setMapStatus(t("map_no_customer_gps", "GPS location unavailable for this order."), "is-unavailable");
  } else if (!mapAvailable()) {
    // Never blank the page because a CDN was blocked.
    setMapStatus(t("map_unavailable_offline", "Live map is unavailable right now."), "is-unavailable");
  } else if (!gpsActive) {
    if (finished) {
      setMapStatus(t("map_tracking_ended", "GPS tracking has ended for this delivery."), "is-unavailable");
    } else {
      setMapStatus(t("map_no_location_yet", "Waiting for the delivery person to share GPS location..."), "is-waiting");
    }
  } else if (!courier) {
    setMapStatus(t("map_no_location_yet", "Waiting for the delivery person to share GPS location..."), "is-waiting");
  } else {
    const when = formatRelativeTime(courier.updatedAt);
    const accuracy = formatAccuracy(courier.accuracy);
    const distance = formatDistance(serverDistance);
    setMapStatus(
      [
        t("map_courier", "Delivery Person") + ": " + (lastOrder.deliveryCourier?.name || "—"),
        distance ? t("track_distance", "Distance") + ": " + distance : null,
        accuracy ? t("track_accuracy", "Accuracy") + ": " + accuracy : null,
        when ? t("map_last_update", "Last GPS update") + ": " + when : null,
      ]
        .filter(Boolean)
        .join("  ·  "),
      ""
    );
  }

  // ---- 4. Map render ----------------------------------------------------------
  const live = ensureMap();
  if (live) {
    live.setCustomer(customer, t("map_destination", "Your Delivery Location"));
    if (cafeteria && (cafeteria.latitude != null || cafeteria.longitude != null)) {
      live.setCafeteria(cafeteria, t("map_cafeteria", "Cafeteria"));
    } else {
      live.setCafeteria(null);
    }
    if (courier) {
      // Active delivery -> the live rider marker. Finished delivery -> the SAME
      // marker frozen on the stored last fix, labelled "Last known location":
      // history shows where it ended, never a moving dot.
      live.setCourier(
        courier,
        gpsActive ? t("map_courier", "Delivery Person") : t("map_last_known", "Last known location")
      );
      console.log(
        `[GPS] map marker orderId=${orderId} lat=${courier.latitude} lng=${courier.longitude}` +
          ` stage=${stage} live=${Boolean(lastPoint)}`
      );
    }
    live.refreshSize();
    if (gpsActive && serverDistance != null) live.drawRoute();
  }

  // ---- 5. Stage heading / socket subscription ---------------------------------
  applyStageHeading(stage);
  if (gpsActive) {
    joinRoom();
    startRelativeClock();
  } else {
    // DELIVERED / COMPLETED / CANCELLED: stop live tracking. No more frames are
    // accepted, so the marker can never move for a finished order.
    leaveRoom();
    stopRelativeClock();
  }
}

/* -------------------------------------------------------------------------
 * Socket room + relative clock
 * ---------------------------------------------------------------------- */

function joinRoom() {
  if (joined || !orderId) return;
  joined = true;
  // The server authorizes this join (order owner / assigned courier / management).
  socketClient.joinDeliveryRoom(orderId);
}

function leaveRoom() {
  if (!joined || !orderId) return;
  joined = false;
  socketClient.leaveDeliveryRoom(orderId);
}

/** Keeps "Last GPS update: 12s ago" honest without a server round-trip. */
function startRelativeClock() {
  if (relativeTimer) return;
  relativeTimer = setInterval(() => {
    if (!lastOrder) return;
    if (!GPS_ACTIVE.has(effectiveStage(lastOrder))) return stopRelativeClock();
    renderCustomerTracking(lastOrder, lastPoint, false);
  }, 5000);
}

function stopRelativeClock() {
  if (!relativeTimer) return;
  clearInterval(relativeTimer);
  relativeTimer = null;
}

/* -------------------------------------------------------------------------
 * Wiring
 * ---------------------------------------------------------------------- */

function onLivePoint(point) {
  if (!point || !point.orderId) return;
  if (orderId && String(point.orderId).replace(/^#/, "") !== String(orderId).replace(/^#/, "")) return;
  console.log(
    `[GPS] customer received location orderId=${point.orderId}` +
      ` lat=${point.latitude} lng=${point.longitude} acc=${point.accuracy ?? "null"}` +
      ` heading=${point.heading ?? "null"} speed=${point.speed ?? "null"}`
  );
  // A frame that arrives after the delivery is over must not resurrect the marker.
  if (lastOrder && FINISHED.has(effectiveStage(lastOrder))) return;
  // The customer page sits in BOTH `order:<id>` and `delivery:<id>`, and the
  // server fans the fix out to each room, so one upload arrives twice. Render
  // it once - the second copy is byte-identical, not a newer position.
  if (
    lastPoint &&
    Number(lastPoint.latitude) === Number(point.latitude) &&
    Number(lastPoint.longitude) === Number(point.longitude) &&
    String(lastPoint.timestamp || lastPoint.updatedAt || "") ===
      String(point.timestamp || point.updatedAt || "") &&
    (point.timestamp || point.updatedAt)
  ) {
    return;
  }
  lastPoint = point;
  renderCustomerTracking(lastOrder, point, true);
}

function subscribe() {
  // mountCustomerTracking() can be reached twice (URL id, then the first live
  // order announcement). Subscribing twice would double every listener.
  if (subscribed) return;
  subscribed = true;

  socketClient.on("delivery:location", onLivePoint);

  socketClient.on("connect", () => {
    setConnection("connected");
    // Re-subscribe after a reconnect: the client replays queued joins, and this
    // guarantees a fresh join too. A customer never has to refresh.
    if (GPS_ACTIVE.has(effectiveStage(lastOrder))) joinRoom();
    refresh();
  });
  socketClient.on("socket:connected", () => setConnection("connected"));
  socketClient.on("socket:disconnected", () => setConnection("reconnecting"));
  socketClient.on("socket:reconnecting", () => setConnection("reconnecting"));
  socketClient.on("socket:error", () => setConnection("offline"));
  socketClient.on("socket:unavailable", () =>
    setConnection("offline", t("track_offline_detail", "We will keep trying to reconnect."))
  );

  // order-status.js is the page's single source of truth for the order. It
  // announces every authoritative snapshot (initial fetch, socket frame, poll)
  // so the map, the timeline and the receipt can never disagree.
  //
  // This is also how a page opened WITHOUT ?orderId= adopts its order:
  // order-status.js bootstraps from the signed-in customer's own order, and the
  // first announcement supplies the id. One code path for both entry points.
  window.addEventListener("scos:order-live", (e) => {
    const order = e && e.detail && e.detail.order;
    if (!order) return;
    const incoming = String(order.orderId || order.id || "").replace(/^#/, "");
    if (!incoming) return;
    if (!orderId) {
      mountCustomerTracking(incoming);
      return;
    }
    if (incoming !== orderId) return; // not the order this page tracks
    renderCustomerTracking(order, lastPoint, false);
  });

  // Delivery lifecycle frames (arrived / delivered / cancelled ...). They carry
  // no coordinates, so they only re-drive the stage.
  ["delivery:status", "delivery:arrived", "delivery:out_for_delivery", "delivery:delivered",
   "delivery:completed", "delivery:cancelled", "delivery:failed"].forEach((event) => {
    socketClient.on(event, () => refresh());
  });

  try {
    socketClient.connect(localStorage.getItem("auth_token"));
  } catch (e) {
    setConnection("offline");
  }
}

/** Re-read the authoritative order from the backend (used on reconnect/events). */
async function refresh() {
  if (!orderId) return;
  if (!localStorage.getItem("auth_token")) return;
  try {
    const res = await api.get(`/orders/${encodeURIComponent(orderId)}`);
    const order = res?.data?.order || res?.order;
    if (order) {
      const loc = order.deliveryLocation || order.currentLocation || null;
      console.log(
        `[GPS] GET /orders/${orderId} status=${order.deliveryStatus || order.status}` +
          ` deliveryLocation=${loc && loc.latitude != null ? `${loc.latitude},${loc.longitude}` : "null"}` +
          ` hasCustomerLocation=${order.hasCustomerLocation}`
      );
      renderCustomerTracking(order, lastPoint, false);
    }
  } catch (e) {
    // Backend unreachable / offline: keep the last known rendering rather than
    // blanking the page. The connection badge already reports the outage.
    console.log(`[GPS] GET /orders/${orderId} failed: ${e && e.message}`);
  }
}

/**
 * Mount the live tracker for one order.
 * @param {string} id orderId (leading `#` tolerated)
 */
export function mountCustomerTracking(id) {
  if (!id) return;
  orderId = String(id).replace(/^#/, "");
  console.log(`[GPS] customer tracking mounted orderId=${orderId}`);
  subscribe();
  setConnection(socketClient.connected ? "connected" : "reconnecting");
  refresh();
}

export function unmountCustomerTracking() {
  leaveRoom();
  stopRelativeClock();
  teardownMap();
}

/* Auto-mount from the URL so the page works with only the script tag.
   Without ?orderId=, the order is adopted from the first `scos:order-live`
   announcement (see subscribe()), so no id is ever guessed. */
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("orderId") || params.get("id");
    if (id) mountCustomerTracking(id);
  });
  // Leaving the page must never leave a map or a socket subscription behind.
  window.addEventListener("pagehide", unmountCustomerTracking);
}
