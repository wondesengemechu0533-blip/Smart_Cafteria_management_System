/**
 * Smart Cafeteria Ordering System
 * File: frontend/src/js/delivery/live-map-global.js
 *
 * Classic-script bridge for the ES-module live map.
 *
 * The admin / manager delivery pages are classic scripts (admin-deliveries.js is
 * an IIFE using window.AdminAPI), so they cannot `import` the ES module that
 * draws the map. This shim imports the ONE implementation
 * (delivery/live-map.js + delivery/geo.js + delivery/geocode-search.js) and
 * exposes it on `window`, so the manager monitor draws exactly the same map as
 * the customer tracker and the courier dashboard instead of growing a second,
 * divergent copy.
 *
 * Announced with the `scos:live-map-ready` CustomEvent, following the same
 * pattern socket.js already uses for `scos:socket-bridge-ready` (an ES module
 * can finish evaluating after a classic script has already looked for it).
 */
import { LiveDeliveryMap, mapAvailable } from "./live-map.js";
import { geocodeSearchHtml, mountGeocodeSearch } from "./geocode-search.js";
import {
  normalizePoint,
  measureToCustomer,
  formatDistance,
  formatAccuracy,
  formatRelativeTime,
  haversineKm,
  NEAR_CUSTOMER_RADIUS_M,
} from "./geo.js";

if (typeof window !== "undefined") {
  window.ScosLiveMap = {
    LiveDeliveryMap,
    mapAvailable,
    normalizePoint,
    measureToCustomer,
    formatDistance,
    formatAccuracy,
    formatRelativeTime,
    haversineKm,
    NEAR_CUSTOMER_RADIUS_M,
  };
  // The place search box (delivery/geocode-search.js) goes through the same
  // bridge: admin-deliveries.js is a classic script and cannot import it.
  window.ScosGeocode = {
    html: geocodeSearchHtml,
    mount: mountGeocodeSearch,
  };
  try {
    window.dispatchEvent(new CustomEvent("scos:live-map-ready", { detail: window.ScosLiveMap }));
  } catch (e) {
    /* non-browser context */
  }
}

export default window.ScosLiveMap;
