/**
 * Smart Cafeteria Ordering System
 * File: frontend/src/js/delivery/dashboard-map.js
 *
 * Per-delivery maps for the Delivery Staff Dashboard.
 *
 * The courier already has a GPS status panel (delivery/gps-ui.js) showing the
 * status pill, latitude, longitude, accuracy and last update. This adds the map
 * the rider actually navigates by: the customer's real drop-off point, their own
 * live position, the connection between them and the live distance.
 *
 * Lifecycle - the card list is re-rendered from scratch on every refresh, so:
 *   - a map is created lazily for each `[data-gps-map="<orderId>"]` node that is
 *     actually in the DOM (only cards that are visible get a map);
 *   - a map whose node has disappeared (filter change, delivery closed) is torn
 *     down, so a hidden tab never keeps a Leaflet instance (and its tile
 *     requests) alive.
 *
 * Like every other tracking surface it degrades to nothing when Leaflet failed to
 * load, and it never invents a coordinate.
 */

import { LiveDeliveryMap, mapAvailable } from "./live-map.js";
import { normalizePoint, measureToCustomer, formatDistance } from "./geo.js";
import { mountGeocodeSearch, searchPlaces } from "./geocode-search.js";
import { tr } from "../utils/i18n.js";
import { statusLabel, deliveryState, deliveryAddress } from "./shared.js";

const maps = new Map();      // orderId -> LiveDeliveryMap
const lastFrames = new Map(); // orderId -> latest server-confirmed `delivery:location`

// Address-only fallback: the customer typed an address at checkout but did not
// share GPS, so the first render shows the "no map" message. We geocode that
// address (Nominatim + the local Ethiopia dataset) and upgrade the card the
// moment a coordinate comes back. A cached `false` means "looked up, no hit".
const geocodedCustomers = new Map(); // orderId -> {latitude, longitude} | false
const geocodeInFlight = new Set();   // orderIds with a running lookup
let lastSyncArgs = null;             // for the immediate re-sync after a resolve

/** Latest server-confirmed fix for an order (payload from the socket). */
export function rememberServerFix(point) {
  if (!point || !point.orderId) return;
  lastFrames.set(String(point.orderId), point);
}

function customerLocationOf(order) {
  const info = order.deliveryInfo || {};
  const canonical = order.customerLocation;
  const source =
    canonical && (canonical.latitude != null || canonical.longitude != null)
      ? canonical
      : { latitude: info.latitude, longitude: info.longitude };
  return normalizePoint(source);
}

/** Get the raw address the customer shared for an order (may be ""). */
function customerAddressText(order) {
  const text = deliveryAddress(order);
  return text && text !== "—" ? String(text).trim() : "";
}

/**
 * Customer destination pin: server-provided GPS first, then the geocoded
 * address fallback (or null until geocoding answers).
 */
function customerPoint(order) {
  const direct = customerLocationOf(order);
  if (direct) return direct;
  const orderId = String(order && order.orderId);
  if (!orderId || !geocodedCustomers.has(orderId)) return null;
  const cached = geocodedCustomers.get(orderId);
  return cached || null;
}

/**
 * Kick an address lookup once per order/address. When it resolves we re-run
 * the last reconcile pass so the card upgrades from "no map" to a real map
 * without waiting for the next poll.
 */
function resolveCustomerAddress(order) {
  const orderId = String(order && order.orderId);
  if (!orderId) return;
  if (geocodedCustomers.has(orderId) || geocodeInFlight.has(orderId)) return;
  const address = customerAddressText(order);
  if (!address) return;
  geocodeInFlight.add(orderId);
  searchPlaces(address, { limit: 1 })
    .then((results) => {
      const best = Array.isArray(results) && results.length ? results[0] : null;
      geocodedCustomers.set(
        orderId,
        best && Number.isFinite(Number(best.latitude)) && Number.isFinite(Number(best.longitude))
          ? { latitude: best.latitude, longitude: best.longitude }
          : false
      );
      if (lastSyncArgs) {
        syncDashboardMaps(lastSyncArgs.orders, lastSyncArgs.trackState);
      }
      // The overview map isn't re-run by the call above; the caller (which owns
      // both reconcilers) listens for this and refreshes the full layout.
      try {
        window.dispatchEvent(new CustomEvent("scos:customer-geocoded", { detail: { orderId } }));
      } catch (e) { /* non-DOM context */ }
    })
    .catch(() => {
      // Network down / throttled: don't spam lookups on every re-render. Try
      // again only when the next card re-mount happens after this order id was
      // evicted from the cache (i.e. not on a hot loop).
      geocodedCustomers.set(orderId, false);
    })
    .finally(() => {
      geocodeInFlight.delete(orderId);
    });
}

/**
 * Live courier position for a card, preferring the freshest source:
 *   1. the browser's own last fix (sub-second fresh)
 *   2. the newest server-confirmed `delivery:location` frame for this order
 *   3. the last fix stored on the order (page load / after a refresh)
 */
function courierPointOf(order, trackState) {
  const fix = trackState && trackState.lastFix;
  const fromTracker = fix ? normalizePoint(fix) : null;
  if (fromTracker) return fromTracker;

  const frame = lastFrames.get(String(order.orderId));
  const fromFrame = frame
    ? normalizePoint({
        latitude: frame.latitude,
        longitude: frame.longitude,
        accuracy: frame.accuracy,
        updatedAt: frame.updatedAt || frame.timestamp,
      })
    : null;
  if (fromFrame) return fromFrame;

  return normalizePoint(order.deliveryLocation || order.currentLocation);
}

/**
 * Reconcile the maps against what is currently on screen.
 *
 * @param {Array} orders   the visible delivery cards (delivery/deliveries.js)
 * @param {(orderId: string) => object|null} trackState  gpsTracker.getState
 * @returns {Map<string, object>} orderId -> {distanceKm, nearCustomer, meters}
 *          measurements, so the caller can render the distance + the
 *          "you are near the customer" hint without re-measuring.
 */
export function syncDashboardMaps(orders, trackState) {
  const results = new Map();
  if (!mapAvailable()) return results;

  const list = Array.isArray(orders) ? orders : [];
  const present = new Set(list.map((o) => String(o && o.orderId)).filter(Boolean));
  lastSyncArgs = { orders: list, trackState: trackState || null };

  // Tear down maps whose card is gone (re-render, filter change, closed order).
  Array.from(maps.keys()).forEach((orderId) => {
    if (present.has(orderId)) return;
    const map = maps.get(orderId);
    if (map) map.destroy();
    maps.delete(orderId);
    lastFrames.delete(orderId);
  });

  list.forEach((order) => {
    const orderId = String(order && order.orderId);
    if (!orderId || !present.has(orderId)) return;

    const container = document.querySelector(`[data-gps-map="${cssEscape(orderId)}"]`);
    if (!container) return;

    // Place search above the map. render() rebuilds the card markup, so the
    // form is a fresh node on every pass - mounting is idempotent per node.
    mountGeocodeSearch(document.getElementById("geocodeSearch-" + orderId), {
      getMap: () => maps.get(orderId),
    });

    const customer = customerPoint(order);
    const courier = courierPointOf(order, trackState ? trackState(orderId) : null);
    const measure = measureToCustomer(courier, customer);
    results.set(orderId, measure);

    // No customer coordinates on this order (the customer did not tap "Use My
    // Current Location" at checkout, so deliveryInfo carries an address only).
    // Leaving the map div empty looked like a broken dashboard, so degrade
    // honestly instead: with a courier fix, still draw a map centred on the
    // rider plus the cafeteria; without one, explain why there is no map. The
    // address + Navigate button above keep working either way, and a later
    // `delivery:location` frame re-runs this reconciler and upgrades the
    // fallback to a live map.
    if (!customer) {
      // Try to turn the shared address into a destination pin before we admit
      // there is no map. While the lookup runs, say so honestly instead of
      // announcing a permanent "No map".
      resolveCustomerAddress(order);
      const pending = !geocodedCustomers.has(orderId);
      let existing = maps.get(orderId);
      if (existing && existing.container !== container) {
        existing.destroy();
        maps.delete(orderId);
        existing = null;
      }
      // Even without a courier fix yet, a usable destination/cafeteria map is
      // expected instead of an empty grey box: with a cafeteria point, a courier
      // point, or both, draw a real map now (the customer pin drops in as soon
      // as the address geocodes).
      const hasCafeteriaPoint = order.pickupLocation && normalizePoint(order.pickupLocation);
      if (courier || hasCafeteriaPoint) {
        if (!existing || !existing.map) {
          container.innerHTML = "";
          const created = new LiveDeliveryMap(container, { zoomToFit: true });
          if (!created.init()) return;
          existing = created;
          maps.set(orderId, existing);
        }
        if (hasCafeteriaPoint) {
          existing.setCafeteria(
            order.pickupLocation,
            (order.pickupLocation && order.pickupLocation.name) || "Cafeteria"
          );
        }
        if (courier) existing.setCourier(courier, "You");
        existing.refreshSize();
        return;
      }
      if (existing) {
        existing.destroy();
        maps.delete(orderId);
      }
      container.innerHTML = pending
        ? '<div class="gps-status gps-muted" style="padding:12px;text-align:center;">Locating the customer\'s shared address on the map…</div>'
        : "";
      return;
    }

    let map = maps.get(orderId);
    // The previous card markup was replaced by the re-render, so an existing
    // instance is attached to a detached node: its marker would never show up
    // on screen (and a search pick would pan a map nobody can see). Rebuild it
    // on the container that is actually in the DOM.
    if (map && map.container !== container) {
      map.destroy();
      maps.delete(orderId);
      map = null;
    }
    if (!map || !map.map) {
      const created = new LiveDeliveryMap(container, { zoomToFit: true });
      if (!created.init()) return;
      map = created;
      maps.set(orderId, map);
      // Draw the destination first so the map always has something to centre on.
      map.setCustomer(customer, "Customer");
      map.setCafeteria(
        order.pickupLocation,
        (order.pickupLocation && order.pickupLocation.name) || "Cafeteria"
      );
    }
    map.setCustomer(customer, "Customer");
    map.setCourier(courier, "You");
    map.refreshSize();
  });

  return results;
}

/** Update one map from a server-confirmed `delivery:location` frame. */
export function applyServerFixToMap(point) {
  if (!point || !point.orderId) return;
  rememberServerFix(point);
  const map = maps.get(String(point.orderId));
  if (!map) return;
  map.moveCourier(point, "You");
}

/** Release every map (page teardown). */
export function destroyDashboardMaps() {
  Array.from(maps.values()).forEach((map) => map.destroy());
  maps.clear();
  lastFrames.clear();
}

/** Formatted distance helper shared with the GPS panel. */
export { formatDistance };

/** CSS.escape with a manual fallback (older Safari / non-browser contexts). */
function cssEscape(value) {
  const str = String(value);
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(str);
  return str.replace(/["\\]/g, "\\$&");
}

/* ---------------------------------------------------------------------------
 * Dashboard overview map: one map for the whole Delivery Queue.
 *
 * The per-card maps above answer "where is THIS order?". This answers "where
 * is my work?": every visible delivery destination as a pin, the rider's own
 * live position, and the cafeteria pickup point. It reads the same payloads
 * and the same tracker state as the cards, so the two can never disagree.
 *
 * Update policy: destination pins are rebuilt on every sync (cheap, few
 * cards); the camera only refits when the SET of points changes, so a moving
 * courier marker never yanks the map while the rider is navigating.
 * ------------------------------------------------------------------------- */

let overviewMap = null; // window.L map instance (created once)
let overviewDests = null; // window.L layer group for the destination pins
let overviewCourier = null; // window.L marker for the rider
let overviewCafeteria = null; // window.L marker for the pickup point
let overviewSignature = ""; // last fitted set of points
let overviewCafeteriaKey = ""; // last drawn cafeteria (rebuilt only on change)

/** Marker glyphs, same `.map-pin*` classes as the per-card maps. */
function overviewPin(kind, icon) {
  return window.L.divIcon({
    className: `map-pin map-pin-${kind}`,
    html: `<i class="fa-solid ${icon}"></i>`,
    iconSize: kind === "courier" ? [30, 30] : [24, 24],
    iconAnchor: kind === "courier" ? [15, 30] : [12, 24],
    popupAnchor: [0, kind === "courier" ? -28 : -22],
  });
}

function overviewEls() {
  if (typeof document === "undefined") return {};
  return {
    card: document.getElementById("overviewCard"),
    container: document.getElementById("deliveryOverviewMap"),
    status: document.getElementById("deliveryOverviewStatus"),
    head: document.querySelector("#overviewCard .delivery-map-head"),
  };
}

function overviewStatus(el, text, tone) {
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("is-waiting", tone === "waiting");
  el.classList.toggle("is-unavailable", tone === "unavailable");
}

/**
 * Reconcile the overview map against the currently visible delivery cards.
 *
 * @param {Array} orders    the visible cards (same list as syncDashboardMaps)
 * @param {Function} trackState  gpsTracker.getState(orderId)
 * @param {Function} label a (order) => short status string for the pin popup
 */
export function syncOverviewMap(orders, trackState, label) {
  const { card, container, status, head } = overviewEls();
  if (!card || !container) return; // page has no overview map
  if (!mapAvailable()) {
    // Leaflet blocked / offline: show card with offline message, not blank.
    card.style.display = "";
    if (container) container.style.display = "none";
    overviewStatus(status, tr("map_unavailable_offline", "Live map is unavailable right now."), "unavailable");
    return;
  }
  card.style.display = "";
  container.style.display = "";

  const list = Array.isArray(orders) ? orders : [];
  const dests = [];
  list.forEach((order) => {
    if (!order) return;
    const customer = customerPoint(order);
    if (!customer) {
      // Same address-to-pin fallback as the per-card maps; without it the
      // overview would silently drop address-only deliveries.
      resolveCustomerAddress(order);
      return;
    }
    dests.push({ order, customer });
  });
  let courier = null;
  for (const order of list) {
    const point = courierPointOf(order, trackState ? trackState(order.orderId) : null);
    if (point) { courier = point; break; }
  }
  let cafeteria = null;
  let cafeteriaName = "Cafeteria";
  for (const order of list) {
    const point = normalizePoint(order.pickupLocation);
    if (point) {
      cafeteria = point;
      cafeteriaName = (order.pickupLocation && order.pickupLocation.name) || "Cafeteria";
      break;
    }
  }

  // Initialize map once with WORLD view (not Ethiopia-specific)
  if (!overviewMap) {
    overviewMap = window.L.map(container, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false,
      tap: true,
      worldCopyJump: true,
    });
    // Start with world view - works everywhere
    overviewMap.setView([20, 0], 2);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(overviewMap);
    overviewDests = window.L.layerGroup().addTo(overviewMap);

    // Put the simple place search directly above the map (not inside the
    // card heading row), so it is always easy to see and never covered by
    // Leaflet panes.
    if (window.ScosGeocode && container) {
      const searchHtml = window.ScosGeocode.html("overview");
      container.insertAdjacentHTML("beforebegin", searchHtml);
      const searchForm = document.getElementById("geocodeSearch-overview");
      if (searchForm) {
        window.ScosGeocode.mount(searchForm, { getMap: () => overviewMap });
      }
    }

    // Ensure proper sizing after initialization (fixes gray map in hidden tabs)
    setTimeout(() => {
      if (overviewMap) overviewMap.invalidateSize();
    }, 200);
  }

  // Destination pins, rebuilt from the visible list.
  overviewDests.clearLayers();
  dests.forEach(({ order, customer }) => {
    const text = typeof label === "function" ? label(order) : String(order.orderId || "");
    const marker = window.L.marker([customer.latitude, customer.longitude], {
      icon: overviewPin("dest", "fa-house"),
      keyboard: true,
      title: `#${order.orderId}`,
    }).bindPopup(`<strong>#${escapeHtml(order.orderId)}</strong><br>${escapeHtml(text)}`);
    overviewDests.addLayer(marker);
  });

  // Rider pin: moved, never refit (the camera stays where the rider left it).
  if (courier) {
    if (!overviewCourier) {
      overviewCourier = window.L.marker([courier.latitude, courier.longitude], {
        icon: overviewPin("courier", "fa-truck-fast"),
        keyboard: true,
        title: "You",
      })
        .bindPopup(buildCourierPopup(courier, list))
        .addTo(overviewMap);
    } else {
      overviewCourier.setLatLng([courier.latitude, courier.longitude]);
      overviewCourier.setPopupContent(buildCourierPopup(courier, list));
    }
    // Update GPS badge in header
    updateGpsBadge(true, courier);
  } else if (overviewCourier) {
    overviewMap.removeLayer(overviewCourier);
    overviewCourier = null;
    updateGpsBadge(false, null);
  }

  // Cafeteria pin, rebuilt only when it actually changed.
  const cafeKey = cafeteria ? `${cafeteria.latitude},${cafeteria.longitude}` : "";
  if (cafeKey !== overviewCafeteriaKey) {
    if (overviewCafeteria) {
      overviewMap.removeLayer(overviewCafeteria);
      overviewCafeteria = null;
    }
    if (cafeteria) {
      overviewCafeteria = window.L.marker([cafeteria.latitude, cafeteria.longitude], {
        icon: overviewPin("cafe", "fa-utensils"),
        keyboard: true,
        title: cafeteriaName,
      })
        .bindPopup(escapeHtml(cafeteriaName))
        .addTo(overviewMap);
    }
    overviewCafeteriaKey = cafeKey;
  }

  // Camera: refit only when the set of points changed (not on every courier move).
  const signature = JSON.stringify({
    d: dests.map(({ order, customer }) => [order.orderId, customer.latitude, customer.longitude]),
    c: cafeKey,
  });
  const points = [];
  dests.forEach(({ customer }) => points.push([customer.latitude, customer.longitude]));
  if (courier) points.push([courier.latitude, courier.longitude]);
  if (cafeteria) points.push([cafeteria.latitude, cafeteria.longitude]);
  if (signature !== overviewSignature) {
    overviewSignature = signature;
    if (points.length === 1) {
      overviewMap.setView(points[0], 15);
    } else if (points.length > 1) {
      overviewMap.fitBounds(points, { padding: [30, 30], maxZoom: 16 });
    }
    // If no points at all, keep world view
  }
  try {
    overviewMap.invalidateSize();
  } catch (e) {
    /* ignore - some Leaflet builds throw when the node is detached */
  }

  // Status line under the map - never hide the map itself.
  if (!points.length) {
    overviewStatus(status, tr("delivery_map_no_locations", "No delivery locations yet. World map ready."), "unavailable");
  } else {
    const n = dests.length;
    overviewStatus(
      status,
      n === 0
        ? tr("delivery_map_showing_position", "Showing your position on world map.")
        : `${n} ${n === 1 ? "delivery" : "deliveries"} on the map.`,
      ""
    );
  }
}

/** Build popup content for courier marker with real-time info. */
function buildCourierPopup(courier, orders) {
  const order = orders[0]; // Any active order works for staff info
  const name = order?.deliveryStaffAssigned?.name || tr("delivery_staff", "Delivery Staff");
  const status = order ? statusLabel(deliveryState(order)) : tr("delivery_active", "Active");
  const updated = courier.updatedAt ? new Date(courier.updatedAt).toLocaleTimeString() : "";
  const accuracy = courier.accuracy ? `±${Math.round(courier.accuracy)}m` : "";
  return `
    <div style="min-width:180px;">
      <strong><i class="fa-solid fa-truck-fast" style="color:#2563eb;"></i> ${escapeHtml(name)}</strong><br>
      <small>${escapeHtml(status)}</small><br>
      <small>${tr("delivery_last_update", "Last update")}: ${escapeHtml(updated || tr("delivery_just_now", "just now"))}</small><br>
      <small>${tr("delivery_accuracy", "Accuracy")}: ${escapeHtml(accuracy || "—")}</small>
    </div>
  `;
}

/** Update GPS status badge in map header. */
function updateGpsBadge(active, courier) {
  const head = document.querySelector("#overviewCard .delivery-map-head");
  if (!head) return;
  let badge = head.querySelector(".overview-gps-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "overview-gps-badge track-connection";
    head.appendChild(badge);
  }
  if (active) {
    badge.className = "overview-gps-badge track-connection is-live";
    const time = courier?.updatedAt ? new Date(courier.updatedAt).toLocaleTimeString() : "";
    badge.innerHTML = `<i class="fa-solid fa-satellite-dish"></i> ${tr("delivery_gps_active", "GPS Active")}${time ? ` · ${time}` : ""}`;
  } else {
    badge.className = "overview-gps-badge track-connection is-waiting";
    badge.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${tr("delivery_gps_waiting", "Waiting for GPS")}`;
  }
}

/** Release the overview map (page teardown). */
export function destroyOverviewMap() {
  if (overviewDests && overviewMap) {
    try {
      overviewMap.removeLayer(overviewDests);
    } catch (e) {
      /* ignore */
    }
  }
  overviewDests = null;
  overviewCourier = null;
  overviewCafeteria = null;
  if (overviewMap) {
    try {
      overviewMap.remove();
    } catch (e) {
      /* ignore */
    }
  }
  overviewMap = null;
  overviewSignature = "";
  overviewCafeteriaKey = "";
}

/** Minimal HTML escape for pin popups (order ids / status labels). */
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
