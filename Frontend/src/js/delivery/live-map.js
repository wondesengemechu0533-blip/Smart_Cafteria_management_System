/**
 * Smart Cafeteria Ordering System
 * File: frontend/src/js/delivery/live-map.js
 *
 * Reusable Leaflet (OpenStreetMap) live delivery map.
 *
 * One implementation of "draw the delivery" used by every tracking surface:
 *   - customer tracker   (customer-tracking-map.js)
 *   - courier dashboard  (delivery/dashboard-map.js)
 *   - manager monitor    (admin-deliveries.js)
 *
 * What it draws:
 *   - the customer marker, from the customer's real saved coordinates
 *   - the delivery-person marker, moved on every `delivery:location` frame
 *   - a connection line between them + a distance label (Haversine, from geo.js)
 *   - an accuracy circle for the GPS fix, so a coarse fix is visibly coarse
 *   - the cafeteria marker when its real coordinates are known
 *
 * Routing (optional): if a routing service is configured it draws the real road
 * route; otherwise it falls back to the straight line. The straight line is
 * always drawn first, so a routing failure downgrades the map instead of
 * blanking it.
 *
 * It NEVER invents a coordinate. If Leaflet failed to load (CDN blocked, offline)
 * or the customer shared no location, `available()` is false / the caller is told
 * so and renders a plain message - the page never crashes.
 */

import {
  normalizePoint,
  haversineMeters,
  haversineKm,
  formatDistance,
  queryGeolocationPermission,
  watchGeolocationPermission,
  permissionHelpMessage,
  PERMISSION_STATE,
  checkGeolocationSupport,
} from "./geo.js";

/**
 * Re-exported so pages that only need the map + permission helpers can import
 * them from one place (and so the admin bridge below exposes a single module).
 */
export {
  PERMISSION_STATE,
  queryGeolocationPermission,
  watchGeolocationPermission,
  permissionHelpMessage,
  checkGeolocationSupport,
};

/** Re-route once the courier has really moved this far (metres). */
const ROUTE_REFRESH_M = 75;
/** …and never route more often than this, even when it is moving. */
const ROUTE_MAX_AGE_MS = 60000;

/**
 * Road routing provider.
 *
 * The delivery dashboard must draw the REAL road route automatically, so a real
 * provider is configured out of the box: the public OSRM demo server. It answers
 *   GET {base}/{lng1},{lat1};{lng2},{lat2}?overview=full&geometries=geojson
 * with a GeoJSON LineString, which is exactly what drawRoute() consumes. The
 * public demo is rate limited and not meant for heavy production load, so
 * `window.SCOS_ROUTING_URL` (or config.routingUrl) still overrides it with a
 * self-hosted OSRM / Valhalla / GraphHopper/OSRM-compatible service.
 *
 * Routing is never required: the straight dashed line is drawn first, so a
 * provider outage (or a network error) degrades to a straight line instead of
 * blanking the map.
 */
const OSRM_DEMO_BASE = "https://router.project-osrm.org/route/v1/driving";

function routingBase() {
  try {
    if (typeof window !== "undefined" && typeof window.SCOS_ROUTING_URL === "string" && window.SCOS_ROUTING_URL) {
      return window.SCOS_ROUTING_URL;
    }
  } catch (e) {
    /* fall through to the default provider */
  }
  return OSRM_DEMO_BASE;
}

/**
 * Fetch a real road route between two points.
 *
 * Returns Leaflet-ready `[[lat, lng], …]`, or null when routing is
 * unavailable / the request fails. Shared by the per-card maps (`drawRoute`)
 * and the dashboard overview map, so both draw the SAME road geometry from the
 * SAME configured provider instead of two half-implementations.
 */
export async function fetchRoadRoute(from, to, opts = {}) {
  const base = routingBase();
  if (!base) return null;
  const a = normalizePoint(from);
  const b = normalizePoint(to);
  if (!a || !b) return null;
  const url =
    `${base.replace(/\/$/, "")}/${a.longitude},${a.latitude};${b.longitude},${b.latitude}` +
    "?overview=full&geometries=geojson";
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: opts.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const coords =
      data && data.routes && data.routes[0] && data.routes[0].geometry
        ? data.routes[0].geometry.coordinates
        : null;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    return coords.map((c) => [c[1], c[0]]);
  } catch (e) {
    return null;
  }
}

/** Is Leaflet present? It is loaded from a CDN, so this can legitimately be false. */
export function mapAvailable() {
  return typeof window !== "undefined" && typeof window.L !== "undefined" && !!window.L.map;
}

const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Marker glyphs, matching the existing `.map-pin*` classes in tracking-map.css. */
function pin(kind, icon) {
  return window.L.divIcon({
    className: `map-pin map-pin-${kind}`,
    html: `<i class="fa-solid ${icon}"></i>`,
    iconSize: kind === "courier" ? [30, 30] : [24, 24],
    iconAnchor: kind === "courier" ? [15, 30] : [12, 24],
    popupAnchor: [0, kind === "courier" ? -28 : -22],
  });
}

export class LiveDeliveryMap {
  /**
   * @param {string|HTMLElement} container  element (or id) to render into
   * @param {object} [options]
   * @param {boolean} [options.zoomToFit=true]  keep both markers in view
   */
  constructor(container, options = {}) {
    this.container =
      typeof container === "string" ? document.getElementById(container) : container;
    this.options = Object.assign({ zoomToFit: true }, options);
    this.map = null;
    this.markers = { courier: null, customer: null, cafeteria: null, search: null, pick: null };
    this.accuracyCircle = null;
    this.line = null;
    this.routeLine = null;
    this.customer = null;
    this.courier = null;
    this._routeToken = 0;
    this._lastRouteFrom = null;
    this._lastRouteAt = 0;
    this._pickHandler = null;
    this._searchPickHandler = null;
  }

  /**
   * Create the Leaflet map. Safe to call twice.
   * @returns {boolean} false when Leaflet is unavailable (caller shows a message)
   */
  init() {
    if (this.map) return true;
    if (!this.container || !mapAvailable()) return false;

    this.map = window.L.map(this.container, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false, // a map must not hijack page scrolling
      tap: true,
    });
    window.L.tileLayer(TILE_URL, {
      maxZoom: 19,
      attribution: TILE_ATTRIBUTION,
    }).addTo(this.map);

    // The container is inside a card that starts hidden; Leaflet needs a size.
    // invalidateSize() after the caller reveals it.
    this.refreshSize();
    return true;
  }

  /** Re-measure after the container became visible / the layout changed. */
  refreshSize() {
    if (!this.map) return;
    try {
      this.map.invalidateSize();
    } catch (e) {
      /* ignore - some Leaflet builds throw when the node is detached */
    }
  }

  _place(name, point, kind, icon, popupText) {
    if (!this.map) return;
    const latLng = [point.latitude, point.longitude];
    if (this.markers[name]) {
      this.markers[name].setLatLng(latLng);
      if (popupText) this.markers[name].setPopupContent(popupText);
      return;
    }
    this.markers[name] = window.L.marker(latLng, {
      icon: pin(kind, icon),
      keyboard: true,
      title: popupText || "",
    })
      .addTo(this.map)
      .bindPopup(popupText || "");
  }

  /**
   * Set the customer's real drop-off coordinates.
   * @returns {boolean} false when the order has no usable customer location
   */
  setCustomer(location, label) {
    const point = normalizePoint(location);
    this.customer = point;
    if (!point) {
      // Explicitly clear: a re-render must never leave a stale customer pin.
      this.customer = null;
      this._dropMarker("customer");
      if (this.map) this._fit();
      return false;
    }
    if (!this.init()) return false;
    this._place(
      "customer",
      point,
      "dest",
      "fa-house",
      label || "Customer location"
    );
    this._fit();
    return true;
  }

  /** Set (or move) the delivery person's real GPS fix. */
  setCourier(point, label) {
    const next = normalizePoint(point);
    this.courier = next;
    if (!next) {
      this._dropMarker("courier");
      this._clearAccuracy();
      return false;
    }
    if (!this.init()) return false;
    this._place("courier", next, "courier", "fa-truck-fast", label || "Delivery person");
    this._drawAccuracy(next);
    this._drawLine();
    this._fit();
    return true;
  }

  /** Convenience: move the courier from a `delivery:location` socket payload. */
  moveCourier(payload, label) {
    if (!payload) return false;
    return this.setCourier(
      { latitude: payload.latitude, longitude: payload.longitude, accuracy: payload.accuracy },
      label
    );
  }

  /** Optional cafeteria / pickup marker (only when its real coordinates exist). */
  setCafeteria(location, label) {
    const point = normalizePoint(location);
    if (!point) {
      this._dropMarker("cafeteria");
      return false;
    }
    if (!this.init()) return false;
    this._place("cafeteria", point, "cafe", "fa-utensils", label || "Cafeteria");
    this._fit();
    return true;
  }

  /**
   * Pin the exact place the user picked in the search box
   * (delivery/geocode-search.js) and centre on it.
   *
   * Deliberately separate from setCustomer()/setCourier(): a searched location
   * is a question ("is it around here?"), never an order fact, so it must not
   * touch the customer or the courier marker.
   *
   * @returns {false} when the point is unusable or Leaflet never loaded
   */
  setSearchPin(location, label) {
    const point = normalizePoint(location);
    if (!point) return false;
    if (!this.init()) return false;
    this._place("search", point, "search", "fa-magnifying-glass-location", label || "Searched location");
    try {
      const zoom = typeof this.map.getZoom === "function" ? this.map.getZoom() : 15;
      this.map.setView([point.latitude, point.longitude], Math.max(zoom, 16));
    } catch (e) {
      /* detached container: the pin is still recorded for the next fit */
    }
    return true;
  }

  /** Drop the search pin and let the auto-fit own the view again. */
  clearSearchPin() {
    if (!this.markers.search) return false;
    this._dropMarker("search");
    this._fit();
    return true;
  }

  /**
   * Draw (or move) the "chosen destination" pin.
   *
   * Used by the delivery search when the courier picks a customer/order with no
   * stored coordinates, or taps the map to set the destination by hand. Kept
   * separate from setCustomer(): the customer marker is the order's OWN stored
   * drop-off point; this one is a destination the rider chose, and it is never
   * persisted as if the customer had shared it.
   */
  setPickPin(location, label) {
    const point = normalizePoint(location);
    if (!point) {
      this.clearPickMarker();
      return false;
    }
    if (!this.init()) return false;
    this._place("pick", point, "dest", "fa-location-dot", label || "Chosen destination");
    return true;
  }

  clearPickMarker() {
    if (!this.markers.pick) return false;
    this._dropMarker("pick");
    return true;
  }

  /**
   * Remove the road route (selection changed / teardown).
   *
   * The straight dashed line (`line`) is intentionally kept: it is still a
   * correct connection between the two markers, and drawRoute() will replace it
   * with a real road route for the new destination.
   */
  clearRoute() {
    if (this.routeLine && this.map) this.map.removeLayer(this.routeLine);
    this.routeLine = null;
    this._lastRouteFrom = null;
    this._lastRouteAt = 0;
    this._routeToken++;
  }

  /**
   * Fit the camera so the courier AND the customer (plus any extra points) are
   * both visible. Public because the delivery search focuses one chosen order
   * and must show the rider and their destination together immediately.
   */
  fitTo(extraPoints) {
    if (!this.map || !this.options.zoomToFit) return;
    const points = [];
    if (this.courier) points.push([this.courier.latitude, this.courier.longitude]);
    if (this.customer) points.push([this.customer.latitude, this.customer.longitude]);
    if (this.markers.cafeteria) points.push(this.markers.cafeteria.getLatLng());
    if (this.markers.pick) points.push(this.markers.pick.getLatLng());
    (Array.isArray(extraPoints) ? extraPoints : []).forEach((p) => {
      const n = normalizePoint(p);
      if (n) points.push([n.latitude, n.longitude]);
    });
    if (points.length === 1) {
      this.map.setView(points[0], 15);
      return;
    }
    if (points.length > 1) this.map.fitBounds(points, { padding: [30, 30], maxZoom: 17 });
  }

  /**
   * Let the rider tap the map to set the destination by hand.
   *
   * This is the honest fallback when the customer shared no coordinates AND the
   * saved address could not be geocoded. The tapped lat/lng is a real point the
   * rider chose - never an invented coordinate.
   */
  enableDestinationPick(onPick) {
    if (!this.init()) return false;
    this.disableDestinationPick();
    this._pickHandler = (e) => {
      if (!e || !e.latlng) return;
      const point = { latitude: e.latlng.lat, longitude: e.latlng.lng };
      this.setPickPin(point, "Chosen destination");
      if (typeof onPick === "function") onPick(point);
    };
    this.map.on("click", this._pickHandler);
    try {
      this.map.getContainer().style.cursor = "crosshair";
    } catch (e) {
      /* container may be detached */
    }
    return true;
  }

  disableDestinationPick() {
    if (this._pickHandler && this.map) this.map.off("click", this._pickHandler);
    this._pickHandler = null;
    try {
      if (this.map) this.map.getContainer().style.cursor = "";
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Let the user tap the map to answer "where is this place?" when the search
   * found nothing (a location Google/OSM does not know).
   *
   * Kept separate from enableDestinationPick(): this drops the purple SEARCH pin
   * (setSearchPin), so an ordinary place lookup can never be mistaken for the
   * customer's delivery destination. The tapped lat/lng is a real point the
   * user chose - never an invented coordinate.
   */
  enableSearchPick(onPick) {
    if (!this.init()) return false;
    this.disableSearchPick();
    this._searchPickHandler = (e) => {
      if (!e || !e.latlng) return;
      const point = { latitude: e.latlng.lat, longitude: e.latlng.lng };
      this.setSearchPin(point, "Dropped pin");
      if (typeof onPick === "function") onPick(point);
    };
    this.map.on("click", this._searchPickHandler);
    try {
      this.map.getContainer().style.cursor = "crosshair";
    } catch (e) {
      /* container may be detached */
    }
    return true;
  }

  disableSearchPick() {
    if (this._searchPickHandler && this.map) this.map.off("click", this._searchPickHandler);
    this._searchPickHandler = null;
    try {
      if (this.map && !this._pickHandler) this.map.getContainer().style.cursor = "";
    } catch (e) {
      /* ignore */
    }
  }

  _dropMarker(name) {
    const marker = this.markers[name];
    if (marker && this.map) {
      this.map.removeLayer(marker);
    }
    this.markers[name] = null;
  }

  _clearAccuracy() {
    if (this.accuracyCircle && this.map) this.map.removeLayer(this.accuracyCircle);
    this.accuracyCircle = null;
  }

  _drawAccuracy(point) {
    this._clearAccuracy();
    if (!this.map || !point.accuracy) return;
    const radius = Math.max(5, Math.min(5000, Number(point.accuracy)));
    this.accuracyCircle = window.L.circle([point.latitude, point.longitude], {
      radius,
      color: "#2563eb",
      weight: 1,
      opacity: 0.5,
      fillColor: "#2563eb",
      fillOpacity: 0.12,
    }).addTo(this.map);
  }

  /**
   * Straight-line connection + distance label, drawn first and kept as the
   * fallback if routing is unavailable.
   */
  _drawLine() {
    if (!this.map || !this.courier || !this.customer) {
      this._clearLines();
      return;
    }
    const from = [this.courier.latitude, this.courier.longitude];
    const to = [this.customer.latitude, this.customer.longitude];
    const km = haversineKm(this.courier, this.customer);
    const label = formatDistance(km);

    if (!this.line) {
      this.line = window.L.polyline([from, to], {
        color: "#2563eb",
        weight: 3,
        opacity: 0.75,
        dashArray: "6 6",
      }).addTo(this.map);
      this.line.bindPopup(label ? `Distance: ${label}` : "Distance unavailable");
    } else {
      this.line.setLatLngs([from, to]);
      this.line.setPopupContent(label ? `Distance: ${label}` : "Distance unavailable");
    }
  }

  _clearLines() {
    if (this.line && this.map) this.map.removeLayer(this.line);
    if (this.routeLine && this.map) this.map.removeLayer(this.routeLine);
    this.line = null;
    this.routeLine = null;
  }

  /**
   * Ask the configured routing service for the real road route.
   *
   * Never required: without it the straight line above stays on screen, and a
   * routing failure is silent (the straight line is already correct).
   *
   * Throttled on purpose. The trackers re-render every few seconds to keep the
   * relative "last update" label honest, and re-routing on each of those would
   * hammer a public routing service. A route is only re-requested when the
   * endpoint has actually moved a real distance (>= ROUTE_REFRESH_M) or the
   * previous attempt failed.
   */
  async drawRoute(opts = {}) {
    if (!routingBase() || !this.map || !this.courier || !this.customer) return false;

    const moved = this._lastRouteFrom
      ? haversineMeters(this._lastRouteFrom, this.courier)
      : Infinity;
    const stale = Date.now() - (this._lastRouteAt || 0) > ROUTE_MAX_AGE_MS;
    if (!opts.force && moved < ROUTE_REFRESH_M && !stale && this.routeLine) return false;

    const token = ++this._routeToken;
    const latlngs = await fetchRoadRoute(this.courier, this.customer);
    // A slower request must never overwrite a newer route.
    if (token !== this._routeToken || !latlngs || latlngs.length < 2) return false;
    if (this.routeLine && this.map) this.map.removeLayer(this.routeLine);
    this.routeLine = window.L.polyline(latlngs, {
      color: "#ff6b00",
      weight: 5,
      opacity: 0.8,
    }).addTo(this.map);
    this._lastRouteFrom = { ...this.courier };
    this._lastRouteAt = Date.now();
    return true;
  }

  _fit() {
    if (!this.map || !this.options.zoomToFit) return;
    // A searched location is the view the user asked for. Live GPS frames must
    // not yank the camera away from it; clearSearchPin() hands the view back.
    if (this.markers.search) return;
    const points = [];
    if (this.courier) points.push([this.courier.latitude, this.courier.longitude]);
    if (this.customer) points.push([this.customer.latitude, this.customer.longitude]);
    if (this.markers.cafeteria) points.push(this.markers.cafeteria.getLatLng());
    if (points.length === 1) {
      this.map.setView(points[0], 15);
      return;
    }
    if (points.length > 1) this.map.fitBounds(points, { padding: [30, 30], maxZoom: 17 });
  }

  /** Tear the map down (page teardown / card re-render). */
  destroy() {
    this._routeToken++;
    this._clearAccuracy();
    this._clearLines();
    this.disableDestinationPick();
    this.disableSearchPick();
    ["courier", "customer", "cafeteria", "search", "pick"].forEach((name) => this._dropMarker(name));
    if (this.map) {
      try {
        this.map.remove();
      } catch (e) {
        /* ignore */
      }
    }
    this.map = null;
    this.courier = null;
    this.customer = null;
    this._lastRouteFrom = null;
    this._lastRouteAt = 0;
  }
}

/** One-shot factory. Returns null when Leaflet is unavailable. */
export function createLiveMap(container, options) {
  const map = new LiveDeliveryMap(container, options);
  return map.init() ? map : null;
}
