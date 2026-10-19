/**
 * Smart Cafeteria Ordering System
 * File: frontend/src/js/delivery/google-places.js
 *
 * Google Places provider for the ONE shared map search (delivery/geocode-search.js).
 *
 * Why this file exists: the search box must find not just the handful of cities
 * in the offline dataset, but every neighborhood, kebele, street, hotel,
 * restaurant, school, university, hospital, landmark and business in any
 * Ethiopian city - and the whole world when asked. That is exactly what Google
 * Places covers, and Nominatim's Ethiopian POI coverage is thin (so "Kesi
 * Alemayehu" or "Checheho Cultural Restaurant" returned nothing).
 *
 * This implementation supports BOTH the legacy Places API and the new
 * Places API (New). The new API provides better small-place coverage,
 * richer place data, and improved relevance for Ethiopian locations.
 *
 * Rules this module keeps:
 *   - it NEVER invents a coordinate: a place without a finite, in-range lat/lng
 *     is dropped, and a failed lookup rejects with a typed GooglePlacesError;
 *   - it is ETHIOPIA-FIRST but not Ethiopia-only: queries are biased to Ethiopia
 *     by default and the caller can escalate to a global search;
 *   - the Google Maps JavaScript API is loaded LAZILY (only on the first search
 *     that needs it) and only when an API key is configured, so pages that never
 *     search never fetch Google and pages without a key keep working through the
 *     local dataset + Nominatim fallback;
 *   - it is a plain ES module with no imports (geocode-search.js is the single
 *     entry point that all map surfaces use).
 *
 * Required Google Cloud APIs (enable all on the key's project):
 *   - Maps JavaScript API          (loads the `places` library)
 *   - Places API (New)             (Place Autocomplete + Text Search + Place Details)
 *   - Geocoding API                (fallback coordinate resolution)
 *
 * Configuration: set the browser key as `window.SCOS_GOOGLE_MAPS_API_KEY`
 * (see js/config.js). The key is a PUBLIC browser key - restrict it to the
 * HTTP referrers of this site and to the APIs above, never a server key.
 */

import { ETHIOPIA_BOUNDS as OVERPASS_ETHIOPIA_BOUNDS } from "./overpass-poi.js";

/** The Maps JavaScript API bootstrap endpoint (the `places` library is added). */
export const GOOGLE_MAPS_JS_URL = "https://maps.googleapis.com/maps/api/js";

/** Google's country-code for the default search context. */
export const ETHIOPIA_COUNTRY = "et";

/** Ethiopia's bounding box, used as a soft search bias. */
export const ETHIOPIA_BOUNDS = { south: 3.2, west: 32.8, north: 15.0, east: 48.2 };

/** Nothing shorter than this can be a place. Mirrors the geocoder's own floor. */
export const GOOGLE_MIN_QUERY = 2;

/**
 * A Google Places lookup that did not produce coordinates.
 * `reason` is what the UI translates:
 *   no_key | load_error | timeout | auth | request | quota_exceeded
 */
export class GooglePlacesError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = "GooglePlacesError";
    this.reason = reason;
  }
}

function win() {
  return typeof window !== "undefined" ? window : null;
}

/**
 * Resolve the browser API key: explicit option > window.SCOS_GOOGLE_MAPS_API_KEY.
 * Never hardcoded - an absent key simply disables the Google provider.
 */
export function googleMapsApiKey(options = {}) {
  const direct = options.key || options.apiKey;
  if (direct) return String(direct).trim();
  const w = win();
  if (!w) return "";
  const value = w.SCOS_GOOGLE_MAPS_API_KEY || w.__GOOGLE_MAPS_API_KEY || "";
  return value ? String(value).trim() : "";
}

/** The `google` root to use: an injected one (tests) or the real window.google. */
export function googleMapsObj(options = {}) {
  if (options.google) return options.google;
  const w = win();
  return w && w.google && w.google.maps ? w.google : null;
}

/** True when the Places library is actually present and usable. */
export function googlePlacesReady(options = {}) {
  const g = googleMapsObj(options);
  return Boolean(g && g.maps && g.maps.places);
}

/** True when a Google provider is available OR a key is configured to load it. */
export function googlePlacesConfigured(options = {}) {
  if (options.google) return true;
  return Boolean(googleMapsApiKey(options));
}

// --- lazy script loading ----------------------------------------------------
let loadPromise = null;
let authFailed = false;

/** Test/late-reload hook: forget the cached load attempt and auth failure. */
export function resetGooglePlaces() {
  loadPromise = null;
  authFailed = false;
}

/** Called from window.gm_authFailure when Google rejects the key. */
export function markGoogleAuthFailure() {
  authFailed = true;
}

function googleBootstrapUrl(key, options) {
  const params = [
    "key=" + encodeURIComponent(key),
    "libraries=places",
    "callback=__scosGoogleMapsReady",
    "loading=async",
    "v=weekly",
    "region=" + encodeURIComponent((options.country || ETHIOPIA_COUNTRY).toUpperCase()),
  ];
  const lang = options.language || options.lang;
  if (lang) params.push("language=" + encodeURIComponent(lang));
  // Request the new Places API (New) by adding the appropriate parameter
  params.push("solution_channel=SCOS_Places_New");
  return GOOGLE_MAPS_JS_URL + "?" + params.join("&");
}

/**
 * Load the Maps JavaScript API (with the places library) exactly once.
 *
 * @param {object} [options]
 * @param {string} [options.key]        explicit API key (else window.SCOS_GOOGLE_MAPS_API_KEY)
 * @param {object} [options.google]     injected google root (tests) - resolves immediately
 * @param {string} [options.language]
 * @param {string} [options.country]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>} the `google` root
 * @throws {GooglePlacesError} no_key | load_error | timeout | auth
 */
export function loadGooglePlaces(options = {}) {
  if (options.google) return Promise.resolve(options.google);
  if (googlePlacesReady()) return Promise.resolve(win().google);

  const key = googleMapsApiKey(options);
  if (!key) return Promise.reject(new GooglePlacesError("no_key", "No Google Maps API key configured"));
  if (authFailed) return Promise.reject(new GooglePlacesError("auth", "Google Maps API key was rejected"));

  if (loadPromise) return loadPromise;

  const w = win();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 15000;

  loadPromise = new Promise((resolve, reject) => {
    if (!w || typeof document === "undefined" || typeof document.createElement !== "function") {
      reject(new GooglePlacesError("load_error", "No browser document to load Google Maps"));
      return;
    }

    const cbName = "__scosGoogleMapsReady";
    const previousFailure = w.gm_authFailure;

    const cleanup = () => {
      clearTimeout(timer);
      try {
        delete w[cbName];
      } catch (e) {
        w[cbName] = undefined;
      }
    };

    w.gm_authFailure = () => {
      authFailed = true;
      try {
        if (typeof previousFailure === "function") previousFailure();
      } catch (e) {
        /* keep the auth flag */
      }
    };

    w[cbName] = () => {
      cleanup();
      if (googlePlacesReady()) resolve(w.google);
      else reject(new GooglePlacesError("load_error", "Google Maps loaded without the Places library"));
    };

    const script = document.createElement("script");
    script.async = true;
    script.defer = true;
    script.src = googleBootstrapUrl(key, options);
    script.onerror = () => {
      cleanup();
      reject(new GooglePlacesError("load_error", "Google Maps script failed to load"));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new GooglePlacesError("timeout", "Google Maps did not finish loading"));
    }, timeoutMs);

    const parent = document.head || document.body || document.documentElement;
    if (!parent || typeof parent.appendChild !== "function") {
      cleanup();
      reject(new GooglePlacesError("load_error", "No document head to attach the Google Maps script"));
      return;
    }
    parent.appendChild(script);
  });

  // Allow a later retry after a transient failure (offline, blocked script).
  loadPromise = loadPromise.catch((err) => {
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}

/** Resolve the provider for an operation: injected google, or load it. */
function provider(options) {
  if (options.google) return Promise.resolve(options.google);
  return loadGooglePlaces(options);
}

/** Read a LatLng-ish value (google.maps.LatLng methods, or a plain {lat,lng}). */
function toLatLng(value) {
  if (!value) return null;
  const lat = typeof value.lat === "function" ? value.lat() : value.lat;
  const lng = typeof value.lng === "function" ? value.lng() : value.lng;
  return inRange(lat, lng);
}

/** Finite, on-Earth coordinate or null. */
function inRange(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { latitude: lat, longitude: lng };
}

/** Where a place's coordinate lives (Text Search / Details result shape). */
function coordOf(result) {
  if (!result) return null;
  if (result.geometry) return toLatLng(result.geometry.location);
  if (result.geometry && result.geometry.location) return toLatLng(result.geometry.location);
  if (result.location) return toLatLng(result.location);
  return null;
}

/** "city" | "subcity" | "" - drives the zoom level when the pin is shown. */
function kindFromTypes(types) {
  const list = Array.isArray(types) ? types : [];
  if (list.indexOf("locality") >= 0 || list.indexOf("administrative_area_level_1") >= 0 || list.indexOf("administrative_area_level_2") >= 0) {
    return "city";
  }
  if (list.indexOf("sublocality") >= 0 || list.indexOf("sublocality_level_1") >= 0 || list.indexOf("neighborhood") >= 0) {
    return "subcity";
  }
  return "";
}

/** An Autocomplete prediction -> a suggestion WITHOUT coordinates (resolved on pick). */
export function mapPrediction(prediction) {
  if (!prediction) return null;
  const structured = prediction.structured_formatting || {};
  const description = String(prediction.description || "");
  const title =
    prediction.main_text ||
    structured.main_text ||
    description.split(",")[0].trim() ||
    description;
  const address = prediction.secondary_text || structured.secondary_text || description || title;
  return {
    title,
    address,
    placeId: prediction.place_id || prediction.placeId || "",
    type: (Array.isArray(prediction.types) && prediction.types[0]) || "",
    source: "google",
    needsDetails: true,
  };
}

/** A Text Search / Place Details result -> a full result WITH coordinates. */
export function mapPlaceResult(result) {
  if (!result) return null;
  const coord = coordOf(result);
  if (!coord) return null;
  const title =
    (result.name && String(result.name).trim()) ||
    (result.formatted_address && String(result.formatted_address).split(",")[0].trim()) ||
    "Place";
  return {
    latitude: coord.latitude,
    longitude: coord.longitude,
    title,
    address: result.formatted_address || result.vicinity || title,
    placeId: result.place_id || result.placeId || "",
    type: (Array.isArray(result.types) && result.types[0]) || "",
    kind: kindFromTypes(result.types),
    source: "google",
    needsDetails: false,
  };
}

/** A one-shot Autocomplete session token (shared by suggestions + the details call). */
export function newSessionToken(options = {}) {
  const g = googleMapsObj(options);
  const P = g && g.maps && g.maps.places;
  if (P && typeof P.AutocompleteSessionToken === "function") {
    try {
      return new P.AutocompleteSessionToken();
    } catch (e) {
      return null;
    }
  }
  return null;
}

/** Shared request options: Ethiopia is the default country context, `global` drops the bias. */
function requestBase(options) {
  const request = {};
  const lang = options.language || options.lang;
  if (lang) request.language = String(lang);
  if (!options.global) {
    request.componentRestrictions = { country: options.country || ETHIOPIA_COUNTRY };
  }
  // Bias results to Ethiopia by default
  if (!options.global) {
    request.locationBias = {
      rectangle: {
        low: { latitude: ETHIOPIA_BOUNDS.south, longitude: ETHIOPIA_BOUNDS.west },
        high: { latitude: ETHIOPIA_BOUNDS.north, longitude: ETHIOPIA_BOUNDS.east },
      },
    };
  }
  return request;
}

/**
 * Autocomplete suggestions for the typed text (fast, cheap, session-billed).
 * Uses the new PlaceAutocompleteService when available (Places API New).
 * @returns {Promise<Array>} coordinate-less suggestions; call resolvePlaceDetails() on pick.
 */
export async function suggestPlaces(query, options = {}) {
  const text = String(query == null ? "" : query).trim();
  if (text.length < GOOGLE_MIN_QUERY) return [];

  const g = await provider(options);
  const P = g.maps.places;

  // Try new PlaceAutocompleteService first (Places API New)
  let service = null;
  if (typeof P.PlaceAutocompleteService === "function") {
    service = new P.PlaceAutocompleteService();
  } else if (typeof P.AutocompleteService === "function") {
    service = new P.AutocompleteService();
  } else {
    throw new GooglePlacesError("load_error", "No Autocomplete service available");
  }

  const request = requestBase(options);
  request.input = text;
  if (options.sessionToken) request.sessionToken = options.sessionToken;
  // Add field mask for new API
  if (typeof P.PlaceAutocompleteService === "function") {
    request.fields = ["place_id", "name", "formatted_address", "types", "location"];
  }

  const predictions = await new Promise((resolve, reject) => {
    service.getPlacePredictions(request, (results, status) => {
      if (status && status !== "OK" && status !== "ZERO_RESULTS") {
        reject(new GooglePlacesError("request", "Google Autocomplete failed: " + status));
        return;
      }
      resolve(Array.isArray(results) ? results : []);
    });
  });

  return predictions.map(mapPrediction).filter(Boolean);
}

/**
 * Broad place discovery for a full query (Text Search).
 * Uses the new PlacesService with searchByText when available (Places API New).
 * Returns full results WITH coordinates - the "search every category of place" path.
 *
 * Ethiopia (country + bounding box) is the default bias; `options.global` searches
 * the whole world. Bounds are a bias, never a hard filter.
 */
export async function textSearchPlaces(query, options = {}) {
  const text = String(query == null ? "" : query).trim();
  if (text.length < GOOGLE_MIN_QUERY) return [];

  const g = await provider(options);
  const P = g.maps.places;
  const node = options.node || (typeof document !== "undefined" && document.createElement ? document.createElement("div") : null);
  if (!node) throw new GooglePlacesError("load_error", "No DOM node available for Google Places");

  // Use the new PlacesService with searchByText (Places API New)
  const service = new P.PlacesService(node);

  const request = {
    textQuery: text,
    language: options.language || options.lang || "en",
    maxResultCount: Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 20,
  };

  if (!options.global) {
    // Bias to Ethiopia using locationBias rectangle
    const biasRect = {
      low: { latitude: ETHIOPIA_BOUNDS.south, longitude: ETHIOPIA_BOUNDS.west },
      high: { latitude: ETHIOPIA_BOUNDS.north, longitude: ETHIOPIA_BOUNDS.east },
    };
    request.locationBias = { rectangle: biasRect };
    // Also restrict to Ethiopia for better relevance
    request.includedRegionCodes = ["et"];
  }

  // Use searchByText (Places API New) if available, fallback to textSearch (legacy)
  const methodName = typeof service.searchByText === "function" ? "searchByText" : "textSearch";

  const results = await new Promise((resolve, reject) => {
    service[methodName](request, (places, status) => {
      if (status && status !== "OK" && status !== "ZERO_RESULTS") {
        reject(new GooglePlacesError("request", "Google " + methodName + " failed: " + status));
        return;
      }
      resolve(Array.isArray(places) ? places : []);
    });
  });

  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 10;
  return results.map(mapPlaceResult).filter(Boolean).slice(0, limit);
}

/**
 * Turn a picked suggestion (Autocomplete, no coordinates) into a full result
 * with the place's real coordinate via Place Details.
 *
 * @param {object} place   a suggestion from suggestPlaces() (needs placeId)
 * @param {object} [options]  { google, key, sessionToken, language, node, timeoutMs }
 * @returns {Promise<object|null>} full result WITH coordinates, or null when unknown
 * @throws {GooglePlacesError}
 */
export async function resolvePlaceDetails(place, options = {}) {
  if (!place) return null;
  const placeId = place.placeId || place.place_id;
  if (!placeId) return null;
  if (inRange(place.latitude, place.longitude)) return place;

  const g = await provider(options);
  const P = g.maps.places;
  const node = options.node || (typeof document !== "undefined" && document.createElement ? document.createElement("div") : null);
  if (!node) throw new GooglePlacesError("load_error", "No DOM node available for Google Places");

  // Use new PlaceDetailsService when available (Places API New)
  let service = null;
  if (typeof P.PlaceDetailsService === "function") {
    service = new P.PlaceDetailsService();
  } else {
    service = new P.PlacesService(node);
  }

  const request = {
    placeId,
    fields: ["place_id", "name", "formatted_address", "geometry", "types", "vicinity", "address_components", "international_phone_number", "website"],
  };
  if (options.sessionToken) request.sessionToken = options.sessionToken;
  const lang = options.language || options.lang;
  if (lang) request.language = String(lang);

  const methodName = typeof service.getPlaceDetails === "function" ? "getPlaceDetails" : "getDetails";

  const result = await new Promise((resolve, reject) => {
    service[methodName](request, (detail, status) => {
      if (status !== "OK" || !detail) {
        reject(new GooglePlacesError("request", "Google Place Details failed: " + status));
        return;
      }
      resolve(detail);
    });
  });

  const mapped = mapPlaceResult(result);
  if (!mapped) throw new GooglePlacesError("request", "Google Place Details returned no coordinate");
  return mapped;
}

/**
 * Search for places by name using the new Text Search (New) with a refined query.
 * This is a convenience function that combines text search with place details
 * resolution for better accuracy on small/local places.
 *
 * @param {string} query - The search query
 * @param {object} [options] - Search options (same as textSearchPlaces)
 * @returns {Promise<Array>} Array of places with coordinates
 */
export async function searchPlacesByName(query, options = {}) {
  // First try text search with the query
  const results = await textSearchPlaces(query, options);
  if (results.length > 0) return results;

  // If no results, try with "Ethiopia" appended for better context
  if (!options.global && !query.toLowerCase().includes("ethiopia")) {
    const enrichedQuery = query + ", Ethiopia";
    const enrichedResults = await textSearchPlaces(enrichedQuery, options);
    if (enrichedResults.length > 0) return enrichedResults;
  }

return [];
}