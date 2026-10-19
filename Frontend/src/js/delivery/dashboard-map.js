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

import { LiveDeliveryMap, mapAvailable, fetchRoadRoute } from "./live-map.js";
import { normalizePoint, measureToCustomer, formatDistance, haversineMeters } from "./geo.js";
import { mountGeocodeSearch, searchPlaces, searchPlaceSuggestions, resolvePlaceResult, newSessionToken } from "./geocode-search.js";
import { gpsTracker } from "./gps.js";
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
      context: contextFromOrder(order),
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

// Selected-delivery focus (the order/customer search above the map).
let overviewOrders = [];      // last synced card list (fresh on every refresh)
let overviewTrackState = null; // gpsTracker.getState
let overviewLabelFn = null;    // (order) => short status string for popups
let overviewSelectedId = null; // orderId currently focused, or null
let overviewSelected = null;   // the focused order object
let overviewSelectedDest = null; // L.marker for the focused customer
let overviewPick = null;         // L.marker for a hand-picked destination
let overviewSearchMark = null;   // L.marker for a searched city/place
let overviewSearchPickHandler = null; // click handler for "drop a pin by hand"
let overviewRoute = null;        // L.polyline for the focused road route
let selectedRouteToken = 0;
let selectedRouteFrom = null;
let selectedRouteAt = 0;
let selectedRouteOrderId = null;
let pickMode = false;
let pickHandler = null;

/** Same throttle policy as the per-card maps (metres / ms). */
const SEL_ROUTE_REFRESH_M = 75;
const SEL_ROUTE_MAX_AGE_MS = 60000;

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
 * The delivery-person's current fix, permission-gated. Never throws.
 * `allowPrompt=false` only returns a fix the browser already granted, so the
 * live reconciliation pass can never pop a permission dialog on its own.
 */
async function safeCurrentFix(allowPrompt) {
  try {
    return await gpsTracker.currentFix({ allowPrompt: !!allowPrompt });
  } catch (e) {
    return null;
  }
}

/** Customer name for the search result / focused marker. */
function customerNameOf(order) {
  if (!order) return "";
  return (
    order.customerName ||
    (order.deliveryInfo && order.deliveryInfo.name) ||
    tr("delivery_customer", "Customer")
  );
}

/** Everything a rider might type to find an order (id / name / phone / address). */
function orderSearchText(order) {
  if (!order) return "";
  const info = order.deliveryInfo || {};
  return [
    order.orderId,
    order.customerName,
    order.customerPhone,
    info.name,
    info.phone,
    deliveryAddress(order),
    info.city,
    info.area,
    info.kebele,
    info.landmark,
    info.subCity,
    info.location,
  ]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase())
    .join(" ");
}

/**
 * Search context for ONE order: its own city, so a bare local place name
 * ("Kesi Alemayehu") is queried as "Kesi Alemayehu, Debre Tabor, Ethiopia"
 * instead of losing the city hint. Never returns a coordinate - only text.
 */
function contextFromOrder(order) {
  const info = (order && order.deliveryInfo) || {};
  const city = info.city || info.subCity || info.area || "";
  return city ? { city: String(city), country: "Ethiopia" } : null;
}

/**
 * Search context for the WHOLE queue: the most common city among the loaded
 * orders, so the shared Delivery Map search is biased to where the work is
 * without hardcoding any city. Returns null when no order names a city.
 */
function contextCityOf(orders) {
  const counts = new Map();
  (Array.isArray(orders) ? orders : []).forEach((o) => {
    const info = (o && o.deliveryInfo) || {};
    const city = info.city || info.subCity || "";
    if (!city) return;
    const key = String(city).trim();
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  let best = "";
  let top = 0;
  counts.forEach((n, city) => {
    if (n > top) {
      top = n;
      best = city;
    }
  });
  return best ? { city: best, country: "Ethiopia" } : null;
}

/** Awaitable version of resolveCustomerAddress() for the focused order. */
async function resolveCustomerPoint(order) {
  const direct = customerLocationOf(order);
  if (direct) return direct;
  const orderId = String(order && order.orderId);
  if (!orderId) return null;
  if (geocodedCustomers.has(orderId)) return geocodedCustomers.get(orderId) || null;
  const address = customerAddressText(order);
  if (!address) return null;
  try {
    const results = await searchPlaces(address, { limit: 1 });
    const best = Array.isArray(results) && results.length ? results[0] : null;
    const point =
      best && Number.isFinite(Number(best.latitude)) && Number.isFinite(Number(best.longitude))
        ? { latitude: Number(best.latitude), longitude: Number(best.longitude) }
        : false;
    geocodedCustomers.set(orderId, point);
    return point || null;
  } catch (e) {
    geocodedCustomers.set(orderId, false);
    return null;
  }
}

/** Publish a line of feedback under the search box (with an optional tone class). */
function setSearchStatus(text, tone) {
  const el = document.getElementById("deliveryOrderSearchStatus");
  if (!el) return;
  el.textContent = text || "";
  el.className = "geocode-search-status" + (tone ? " " + tone : "");
}

/** "11.85659, 38.00831" - the exact numbers behind a searched place. */
function formatCoord(latitude, longitude) {
  return `${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`;
}

/**
 * Drop the city/place search marker (distinct from the customer destination
 * marker: the search marker answers "where did I look?"; the destination marker
 * is an order fact).
 */
function clearOverviewSearchMarker() {
  if (overviewSearchMark && overviewMap) overviewMap.removeLayer(overviewSearchMark);
  overviewSearchMark = null;
  disableOverviewSearchPick();
  const clearBtn = document.getElementById("deliveryOrderSearchClear");
  if (clearBtn) clearBtn.hidden = true;
}

/**
 * Paint the shared search pin: a distinct (purple) marker + popup + camera.
 * Used both for a searched place (focusPlace) and for a hand-dropped pin.
 */
function showOverviewSearchPin(point, title, address, kind) {
  clearOverviewSearchMarker();
  overviewSearchMark = window.L.marker([point.latitude, point.longitude], {
    icon: overviewPin("search", "fa-location-dot"),
    keyboard: true,
    title,
    zIndexOffset: 700,
  })
    .bindPopup(
      `<strong>${escapeHtml(title)}</strong><br><small>${escapeHtml(address || "")}</small><br>` +
        `<small>${formatCoord(point.latitude, point.longitude)}</small>`
    )
    .addTo(overviewMap);
  try {
    overviewSearchMark.openPopup();
  } catch (e) {
    /* popup may be unsupported in a torn-down map */
  }
  const zoom = kind === "city" ? 13 : kind === "subcity" ? 15 : 16;
  overviewMap.setView([point.latitude, point.longitude], zoom);
  try {
    overviewMap.invalidateSize();
  } catch (e) {
    /* ignore */
  }
  const clearBtn = document.getElementById("deliveryOrderSearchClear");
  if (clearBtn) clearBtn.hidden = false;
}

/**
 * Show a searched place: a visible, named marker + the camera zoomed to it.
 * City hits open wide; a school/hospital/street opens close.
 */
export function focusPlace(place) {
  if (!overviewMap || !place) return false;
  const point = normalizePoint(place);
  if (!point) return false;
  showOverviewSearchPin(point, place.title || place.address || "", place.address || "", place.kind);
  return true;
}

/** Arm click-to-pick: the next map tap drops the shared search pin. */
function enableOverviewSearchPick() {
  if (!overviewMap || overviewSearchPickHandler) return false;
  try {
    overviewMap.getContainer().style.cursor = "crosshair";
  } catch (e) {
    /* detached node */
  }
  overviewSearchPickHandler = (e) => {
    if (!e || !e.latlng) return;
    dropOverviewSearchPin({ latitude: e.latlng.lat, longitude: e.latlng.lng });
  };
  overviewMap.on("click", overviewSearchPickHandler);
  return true;
}

function disableOverviewSearchPick() {
  if (overviewMap && overviewSearchPickHandler) overviewMap.off("click", overviewSearchPickHandler);
  overviewSearchPickHandler = null;
  if (overviewMap) {
    try {
      overviewMap.getContainer().style.cursor = "";
    } catch (e) {
      /* ignore */
    }
  }
}

/** Apply a hand-dropped search pin and report it in the status line. */
function dropOverviewSearchPin(point) {
  if (!overviewMap || !point) return;
  disableOverviewSearchPick();
  const coordText = formatCoord(point.latitude, point.longitude);
  showOverviewSearchPin(point, tr("map_search_dropped", "Dropped pin"), coordText, "pin");
  setSearchStatus(tr("map_search_picked", "Location found"), "is-ok");
}

/**
 * The single search box above the overview map: Ethiopian cities / kebeles /
 * landmarks (via delivery/geocode-search.js, the one geocoder) AND the rider's
 * own delivery orders. Both result kinds are selectable; a place drops the
 * purple search marker, an order drops the customer destination marker + route.
 */
function deliverySearchHtml() {
  return `
    <form class="geocode-search delivery-search" id="deliveryOrderSearch" role="search" autocomplete="off">
      <div class="geocode-search-row">
        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
        <input id="deliveryOrderSearchInput" class="geocode-search-input" type="search"
               aria-label="${escapeAttr(tr("delivery_search_label", "Search a city, place or delivery"))}"
               placeholder="${escapeAttr(
                 tr("delivery_search_placeholder", "Search a city, place or delivery (Debre Tabor, kebele, order #)…")
               )}" />
        <button type="button" class="geocode-search-clear delivery-search-clear" id="deliveryOrderSearchClear"
                hidden aria-label="${escapeAttr(tr("map_search_clear", "Clear search result"))}">&times;</button>
      </div>
      <ul class="geocode-suggestions delivery-search-suggestions" id="deliveryOrderSearchResults" role="listbox" hidden></ul>
      <p class="geocode-search-status" id="deliveryOrderSearchStatus" aria-live="polite"></p>
      <button type="button" class="btn btn-sm btn-outline-secondary delivery-search-pick" id="deliveryOrderSearchPick" hidden>${escapeAttr(
        tr("map_search_pick_on_map", "Set location on map")
      )}</button>
    </form>`;
}

/** Bind the unified search box once (the order list it reads stays fresh via sync). */
function mountDeliverySearch() {
  const form = document.getElementById("deliveryOrderSearch");
  if (!form || form.dataset.bound === "1") return;
  form.dataset.bound = "1";
  const input = form.querySelector("#deliveryOrderSearchInput");
  const list = form.querySelector("#deliveryOrderSearchResults");
  const clearBtn = form.querySelector("#deliveryOrderSearchClear");
  const pickBtn = form.querySelector("#deliveryOrderSearchPick");

  let token = 0;
  let timer = null;
  let items = [];
  let active = -1;
  let controller = null;
  let sessionToken = null;
  const refreshSession = () => {
    try {
      sessionToken = newSessionToken();
    } catch (e) {
      sessionToken = null;
    }
  };
  refreshSession();
  const revealPick = (show) => {
    if (pickBtn) pickBtn.hidden = !show;
  };

  const setStatus = (text, tone) => setSearchStatus(text, tone);
  const closeList = () => {
    if (list) {
      list.hidden = true;
      list.innerHTML = "";
    }
    items = [];
    active = -1;
    if (input && input.removeAttribute) input.removeAttribute("aria-activedescendant");
  };

  const setActive = (index) => {
    active = index;
    if (!list || typeof list.querySelectorAll !== "function") return;
    const nodes = list.querySelectorAll(".geocode-suggestion[data-index]");
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].classList) nodes[i].classList.toggle("is-active", Number(nodes[i].getAttribute("data-index")) === index);
    }
  };

  const renderList = (orders, places) => {
    items = [];
    let html = "";
    if (orders.length) {
      html += `<li class="geocode-group" role="presentation">${escapeHtml(
        tr("delivery_search_orders_group", "Deliveries")
      )}</li>`;
      orders.forEach((o) => {
        const index = items.push({ kind: "order", orderId: String(o.orderId) }) - 1;
        const label = typeof overviewLabelFn === "function" ? overviewLabelFn(o) : statusLabel(deliveryState(o));
        html +=
          `<li role="option" tabindex="0" class="geocode-suggestion" data-index="${index}" ` +
          `data-order-id="${escapeAttr(o.orderId)}">` +
          `<span class="geocode-suggestion-title">#${escapeHtml(o.orderId)} · ${escapeHtml(customerNameOf(o))}</span>` +
          `<small>${escapeHtml(deliveryAddress(o))}</small>` +
          `<small>${escapeHtml(label || "")}</small>` +
          `</li>`;
      });
    }
    if (places.length) {
      html += `<li class="geocode-group" role="presentation">${escapeHtml(
        tr("delivery_search_places_group", "Places")
      )}</li>`;
      places.forEach((p) => {
        const index = items.push({ kind: "place", place: p }) - 1;
        const hasCoords = Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude));
        const sub =
          p.address && p.address !== p.title
            ? p.address
            : hasCoords
            ? formatCoord(p.latitude, p.longitude)
            : p.address || "";
        const alt = p.alternative
          ? `<em class="geocode-alt">${escapeHtml(tr("map_search_alternative", "nearest city, not the exact place"))}</em>`
          : "";
        html +=
          `<li role="option" tabindex="0" class="geocode-suggestion" data-index="${index}">` +
          `<span class="geocode-suggestion-title">${escapeHtml(p.title || "")}</span>` +
          `<small>${escapeHtml(sub)}</small>${alt}` +
          `</li>`;
      });
    }
    if (list) {
      list.innerHTML = html;
      list.hidden = items.length === 0;
    }
    active = -1;
  };

  const choose = async (index) => {
    const item = items[index];
    if (!item) return;
    const myToken = token;
    closeList();
    revealPick(false);
    if (item.kind === "order") {
      if (input) input.value = "";
      focusOrderOnMap(item.orderId);
      return;
    }
    let place = item.place;
    // A Google Autocomplete row carries no coordinate: resolve it with Place
    // Details before moving the camera (never an invented point).
    if (place && place.needsDetails && place.placeId) {
      setStatus(tr("map_search_resolving", "Getting the exact location…"), "is-waiting");
      const full = await resolvePlaceResult(place, { sessionToken });
      if (myToken !== token) return;
      if (!full || !Number.isFinite(Number(full.latitude))) {
        setStatus(tr("map_search_error", "Search is unavailable right now. Check your connection and try again."), "is-error");
        return;
      }
      refreshSession();
      place = full;
    }
    if (input) input.value = place.title || "";
    focusPlace(place);
    // Never present an approximate city fallback as the exact place.
    setStatus(
      place.alternative
        ? tr("map_search_nearest", "Showing the nearest city - not the exact place.")
        : tr("map_search_picked", "Location found"),
      place.alternative ? "is-waiting" : "is-ok"
    );
  };

  const run = async () => {
    const q = (input && input.value ? input.value : "").trim();
    if (q.length < 2) {
      setStatus("");
      closeList();
      return;
    }
    const myToken = ++token;
    if (controller && typeof controller.abort === "function") {
      try {
        controller.abort();
      } catch (e) {
        /* finished controller */
      }
    }
    controller = typeof AbortController === "function" ? new AbortController() : null;

    const localOrders = (overviewOrders || [])
      .filter((o) => orderSearchText(o).includes(q.toLowerCase()))
      .slice(0, 5);

    setStatus(tr("map_search_searching", "Searching…"), "is-waiting");
    let places = [];
    let placeError = null;
    // Bias the provider search toward where this rider's deliveries actually
    // are (most common city among the loaded orders), so a bare local name
    // ("Kesi Alemayehu") still resolves without hardcoding any city.
    const context = contextCityOf(overviewOrders);
    try {
      places = await searchPlaceSuggestions(
        q,
        Object.assign({ sessionToken, context }, controller ? { signal: controller.signal } : {})
      );
    } catch (err) {
      if (myToken !== token || (err && err.name === "AbortError")) return;
      placeError = err;
    }
    if (myToken !== token) return;

    renderList(localOrders, Array.isArray(places) ? places : []);
    // Exactly one hit: open it directly (e.g. "Debre Tabor" -> the city).
    // Several hits stay as a list so an unrelated place is never auto-chosen.
    if (items.length === 1) {
      choose(0);
      return;
    }
    if (!items.length) {
      // Offer the manual fallback: a location nobody has registered.
      revealPick(Boolean(overviewMap));
      setStatus(
        placeError && placeError.reason === "rate_limited"
          ? tr("map_search_rate_limited", "Too many searches in a row. Wait a moment and try again.")
          : placeError && (placeError.reason === "auth" || placeError.reason === "load_error" || placeError.reason === "timeout")
          ? tr("map_search_google_unavailable", "Place search is unavailable (Google Maps key rejected or not enabled).")
          : placeError
          ? tr("map_search_error", "Search is unavailable right now. Check your connection and try again.")
          : tr("delivery_search_none", "No matching delivery or place. Try a city, kebele, landmark or order number."),
        placeError ? "is-error" : "is-empty"
      );
      return;
    }
    revealPick(false);
    setStatus("");
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, 450);
  };

  if (input) {
    input.addEventListener("input", schedule);
    input.addEventListener("keydown", (event) => {
      if (!event) return;
      const count = items.length;
      if (event.key === "Escape") {
        closeList();
        return;
      }
      if (event.key === "ArrowDown" && count) {
        if (event.preventDefault) event.preventDefault();
        setActive((active + 1) % count);
        return;
      }
      if (event.key === "ArrowUp" && count) {
        if (event.preventDefault) event.preventDefault();
        setActive((active - 1 + count) % count);
        return;
      }
      if (event.key === "Enter" && active >= 0 && active < count) {
        if (event.preventDefault) event.preventDefault();
        choose(active);
      }
    });
  }
  form.addEventListener("submit", (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    run();
  });
  if (list) {
    list.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-index]");
      if (li) choose(Number(li.getAttribute("data-index")));
    });
    list.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const li = e.target.closest("li[data-index]");
      if (li) {
        e.preventDefault();
        choose(Number(li.getAttribute("data-index")));
      }
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      clearOverviewSearchMarker();
      if (input) input.value = "";
      setStatus("");
      closeList();
      revealPick(false);
    });
  }
  if (pickBtn) {
    pickBtn.addEventListener("click", () => {
      if (!overviewMap) return;
      revealPick(false);
      setStatus(tr("map_search_pick_hint", "Tap the map to drop the pin."), "is-waiting");
      enableOverviewSearchPick();
    });
  }
  document.addEventListener("click", (e) => {
    if (!form.contains(e.target)) closeList();
  });
}

/** Remove the focused destination/route/pick layers (selection changed / teardown). */
function clearSelectionVisuals() {
  selectedRouteToken++;
  if (overviewRoute && overviewMap) overviewMap.removeLayer(overviewRoute);
  overviewRoute = null;
  if (overviewSelectedDest && overviewMap) overviewMap.removeLayer(overviewSelectedDest);
  overviewSelectedDest = null;
  clearPick();
  disablePick();
  selectedRouteFrom = null;
  selectedRouteAt = 0;
  selectedRouteOrderId = null;
  // Let the next sync restore the whole-queue camera view.
  overviewSignature = "";
}

/** Draw / move the focused customer destination marker (never a duplicate). */
function setSelectedDestMarker(customer) {
  if (!overviewMap) return;
  if (!customer) {
    if (overviewSelectedDest) {
      overviewMap.removeLayer(overviewSelectedDest);
      overviewSelectedDest = null;
    }
    return;
  }
  const latlng = [customer.latitude, customer.longitude];
  if (overviewSelectedDest) {
    overviewSelectedDest.setLatLng(latlng);
    return;
  }
  const orderId = overviewSelected ? overviewSelected.orderId : "";
  overviewSelectedDest = window.L.marker(latlng, {
    icon: overviewPin("dest", "fa-location-dot"),
    keyboard: true,
    title: `#${orderId}`,
    zIndexOffset: 500,
  })
    .bindPopup(
      `<strong>${escapeHtml(tr("delivery_selected_customer", "Customer destination"))}</strong><br>#${escapeHtml(orderId)}`
    )
    .addTo(overviewMap);
}

/** Fit the camera around the focused customer + rider (and any picked point). */
function fitSelected(customer, courier) {
  if (!overviewMap) return;
  const points = [];
  if (customer) points.push([customer.latitude, customer.longitude]);
  if (courier) points.push([courier.latitude, courier.longitude]);
  if (overviewPick) points.push(overviewPick.getLatLng());
  if (!points.length) return;
  if (points.length === 1) overviewMap.setView(points[0], 15);
  else overviewMap.fitBounds(points, { padding: [40, 40], maxZoom: 16 });
}

/**
 * Draw the real road route from the rider to the focused destination.
 * Throttled like the per-card maps so a moving rider does not hammer the
 * routing provider; `opts.force` (new selection / manual pick) always re-routes.
 */
async function drawSelectedRoute(customer, courier, opts = {}) {
  if (!overviewMap) return;
  if (!customer || !courier) {
    if (overviewRoute) {
      overviewMap.removeLayer(overviewRoute);
      overviewRoute = null;
    }
    selectedRouteFrom = null;
    selectedRouteAt = 0;
    selectedRouteOrderId = null;
    return;
  }
  const moved = selectedRouteFrom ? haversineMeters(selectedRouteFrom, courier) : Infinity;
  const stale = Date.now() - (selectedRouteAt || 0) > SEL_ROUTE_MAX_AGE_MS;
  const sameOrder = selectedRouteOrderId === overviewSelectedId;
  if (!opts.force && sameOrder && moved < SEL_ROUTE_REFRESH_M && !stale && overviewRoute) return;

  const token = ++selectedRouteToken;
  const latlngs = await fetchRoadRoute(courier, customer);
  if (token !== selectedRouteToken || !overviewMap || !latlngs || latlngs.length < 2) return;
  if (overviewRoute) overviewMap.removeLayer(overviewRoute);
  overviewRoute = window.L.polyline(latlngs, { color: "#ff6b00", weight: 5, opacity: 0.85 }).addTo(overviewMap);
  selectedRouteFrom = { ...courier };
  selectedRouteAt = Date.now();
  selectedRouteOrderId = overviewSelectedId;
}

/** Marker + route + camera for the focused order in one call. */
function drawSelected(customer, courier, opts = {}) {
  setSelectedDestMarker(customer);
  drawSelectedRoute(customer, courier, opts);
  if (opts.fit !== false) fitSelected(customer, courier);
}

/** Remove a hand-picked destination marker. */
function clearPick() {
  if (overviewPick && overviewMap) overviewMap.removeLayer(overviewPick);
  overviewPick = null;
}

/** Let the rider tap the map to set the destination when no coordinates exist. */
function enablePick() {
  if (!overviewMap || pickMode) return;
  pickMode = true;
  try {
    overviewMap.getContainer().style.cursor = "crosshair";
  } catch (e) {
    /* detached node */
  }
  pickHandler = (e) => {
    if (!e || !e.latlng) return;
    setPick({ latitude: e.latlng.lat, longitude: e.latlng.lng });
  };
  overviewMap.on("click", pickHandler);
}

function disablePick() {
  if (overviewMap && pickHandler) overviewMap.off("click", pickHandler);
  pickHandler = null;
  if (overviewMap) {
    try {
      overviewMap.getContainer().style.cursor = "";
    } catch (e) {
      /* ignore */
    }
  }
  pickMode = false;
}

/** Apply a hand-picked destination: draw it and route the rider to it. */
function setPick(point) {
  if (!overviewMap || !point) return;
  const latlng = [point.latitude, point.longitude];
  if (overviewPick) {
    overviewPick.setLatLng(latlng);
  } else {
    overviewPick = window.L.marker(latlng, {
      icon: overviewPin("dest", "fa-location-dot"),
      keyboard: true,
      title: "Chosen destination",
      zIndexOffset: 600,
    })
      .bindPopup(escapeHtml(tr("delivery_destination_set", "Destination set on the map.")))
      .addTo(overviewMap);
  }
  // The picked point replaces the (missing) customer pin.
  if (!customerPoint(overviewSelected) && overviewSelectedDest) {
    overviewMap.removeLayer(overviewSelectedDest);
    overviewSelectedDest = null;
  }
  setSearchStatus(tr("delivery_destination_set", "Destination set on the map."));
  disablePick();
  drawSelectedRoute(point, null, { force: true });
  safeCurrentFix(true).then((fix) => {
    drawSelectedRoute(point, fix, { force: true, fit: true });
  });
  fitSelected(point, null);
}

/**
 * Search → focus: plot a chosen order's customer destination and the real road
 * route from the rider to it. Also the honest no-coordinates path: explain and
 * arm click-to-pick instead of inventing a point.
 *
 * @returns {Promise<boolean>} true when a destination was plotted.
 */
export async function focusOrderOnMap(orderId, opts = {}) {
  if (!mapAvailable() || !overviewMap) return false;
  const id = String(orderId || "");
  if (!id) return false;
  const order =
    (overviewOrders || []).find((o) => String(o && o.orderId) === id) || (opts.order || null);
  if (!order) return false;

  if (overviewSelectedId !== id) clearSelectionVisuals();
  overviewSelectedId = id;
  overviewSelected = order;
  setSearchStatus(tr("delivery_focus_searching", "Locating the delivery…"));

  let customer = customerPoint(order);
  if (!customer) customer = await resolveCustomerPoint(order);
  if (!customer) {
    setSearchStatus(
      tr("delivery_destination_missing", "This order has no customer coordinates. Tap the map to set the destination.")
    );
    enablePick();
    return false;
  }
  disablePick();

  const state = overviewTrackState ? overviewTrackState(id) : null;
  let courier = courierPointOf(order, state);
  if (!courier) courier = await safeCurrentFix(true);

  drawSelected(customer, courier, { force: true, fit: true });
  setSearchStatus(
    courier
      ? tr("delivery_focus_route", "Showing the route to the selected customer.")
      : tr("delivery_courier_missing", "Waiting for your GPS to draw the route…")
  );
  return true;
}

/**
 * Keep the focused selection aligned with the freshest data on every sync
 * (a moving rider refreshes the road route automatically). No permission
 * prompt here - only a fix the browser already granted.
 */
async function reconcileSelectedOrder() {
  if (!overviewMap || !overviewSelectedId) return;
  const order =
    (overviewOrders || []).find((o) => String(o && o.orderId) === overviewSelectedId) || overviewSelected;
  if (!order) return;
  overviewSelected = order;

  if (overviewPick) {
    const picked = overviewPick.getLatLng();
    const point = { latitude: picked.lat, longitude: picked.lng };
    const courier = courierPointOf(order, overviewTrackState ? overviewTrackState(overviewSelectedId) : null) || (await safeCurrentFix(false));
    drawSelectedRoute(point, courier, { fit: false });
    return;
  }

  const customer = customerPoint(order) || (await resolveCustomerPoint(order));
  if (!customer) return;
  const courier = courierPointOf(order, overviewTrackState ? overviewTrackState(overviewSelectedId) : null) || (await safeCurrentFix(false));
  drawSelected(customer, courier, { fit: false });
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

/**
 * Reconcile the overview map against the currently visible delivery cards.
 *
 * @param {Array} orders    the visible cards (same list as syncDashboardMaps)
 * @param {Function} trackState  gpsTracker.getState(orderId)
 * @param {Function} label a (order) => short status string for the pin popup
 */
export function syncOverviewMap(orders, trackState, label, searchOrders) {
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
  // Keep the freshest list/state for the delivery search + focused route. The
  // search covers every loaded order (searchOrders), not just the visible tab.
  overviewOrders = Array.isArray(searchOrders) ? searchOrders : list;
  overviewTrackState = trackState || null;
  overviewLabelFn = typeof label === "function" ? label : null;

  const dests = [];
  list.forEach((order) => {
    if (!order) return;
    // The focused order draws its own highlighted marker + route; skip its
    // plain queue pin so the map does not show two pins on the same spot.
    if (overviewSelectedId && String(order.orderId) === String(overviewSelectedId)) return;
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

    // Delivery search: choose an order/customer to focus the route on. Mounted
    // directly above the map (not inside the card heading row) so it is always
    // easy to see and never covered by a Leaflet pane.
    if (container && !document.getElementById("deliveryOrderSearch")) {
      container.insertAdjacentHTML("beforebegin", deliverySearchHtml());
    }
    mountDeliverySearch();

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
    // While a delivery is focused the camera belongs to that route; only
    // auto-fit the whole queue when nothing is focused.
    if (!overviewSelectedId) {
      if (points.length === 1) {
        overviewMap.setView(points[0], 15);
      } else if (points.length > 1) {
        overviewMap.fitBounds(points, { padding: [30, 30], maxZoom: 16 });
      }
      // If no points at all, keep world view
    }
  }
  try {
    overviewMap.invalidateSize();
  } catch (e) {
    /* ignore - some Leaflet builds throw when the node is detached */
  }

  // Refresh the focused order's marker/route with the latest data. Async so a
  // slow geocode/route never blocks the queue rendering.
  if (overviewSelectedId) reconcileSelectedOrder();

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
  clearSelectionVisuals();
  clearOverviewSearchMarker();
  overviewSelectedId = null;
  overviewSelected = null;
  overviewOrders = [];
  overviewTrackState = null;
  overviewLabelFn = null;
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
