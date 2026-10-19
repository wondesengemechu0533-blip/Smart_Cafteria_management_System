/**
 * Smart Cafeteria Ordering System
 * File: frontend/src/js/delivery/geocode-search.js
 *
 * Place search for the live maps - "where is that, exactly?"
 *
 * One helper backs every map that has a search box:
 *   - the manager's Live Delivery Monitor (admin/deliveries.html)
 *   - the rider's per-delivery GPS panels (delivery/deliveries.html)
 *
 * The flow is deliberately small and honest:
 *   type -> local Ethiopia places + debounced request to OpenStreetMap
 *   Nominatim -> suggestion list -> pick one -> the map pans to the REAL
 *   latitude/longitude and the resolved address + coordinates are printed
 *   under the box (selectable / copyable).
 *
 * Rules this module keeps:
 *   - it NEVER invents a coordinate: an entry without a finite, in-range
 *     lat/lon pair is dropped, and a failed lookup says so instead of guessing;
 *   - the public Nominatim service is rate limited to 1 request/second, so
 *     requests are debounced in the UI and throttled in searchPlaces();
 *   - a search failure degrades to a message in the status line - the map, the
 *     GPS panel and the rest of the page keep working;
 *   - it is a plain ES module (delivery/live-map-global.js re-exports it for
 *     the classic-script bridge), with one import: the local Ethiopia dataset
 *     (utils/ethiopia-places.js) so every Ethiopian city and subcity is
 *     suggestable even while Nominatim is unreachable.
 */
import { searchEthiopiaPlaces } from "../utils/ethiopia-places.js";
import {
  GooglePlacesError,
  googlePlacesConfigured,
  suggestPlaces,
  textSearchPlaces,
  searchPlacesByName,
  resolvePlaceDetails,
  newSessionToken,
} from "./google-places.js";
import { searchPOIsByName, ETHIOPIA_BOUNDS as OVERPASS_ETHIOPIA_BOUNDS } from "./overpass-poi.js";

export { GooglePlacesError };

/** Public OSM Nominatim endpoint (no API key; usage policy limits apply). */
export const GEOCODE_ENDPOINT = "https://nominatim.openstreetmap.org/search";

/** Nominatim usage policy: never more than one request per second. */
export const GEOCODE_MIN_GAP_MS = 1000;

/** Idle time in the box before a lookup fires while the user is still typing. */
export const GEOCODE_DEBOUNCE_MS = 450;

/** Fewer characters than this cannot be a place yet. */
export const GEOCODE_MIN_QUERY = 2;

/** Suggestions shown. The first one is the best Nominatim match. */
export const GEOCODE_LIMIT = 5;

/**
 * A lookup that did not produce coordinates.
 * `reason` is what the UI translates: network | http | rate_limited | parse.
 */
export class GeocodeError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = "GeocodeError";
    this.reason = reason;
  }
}

/** i18n lookup with an English fallback (same pattern as delivery/gps-ui.js). */
function t(key, fallback) {
  try {
    if (typeof window !== "undefined" && window.getText) {
      const value = window.getText(key);
      if (value && value !== key) return value;
    }
  } catch (e) {
    /* fall through to the English default */
  }
  return fallback;
}

/** HTML escaping for text AND attribute values (quotes included). */
function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentLang() {
  try {
    if (typeof window !== "undefined" && typeof window.getCurrentLanguage === "function") {
      return window.getCurrentLanguage();
    }
  } catch (e) {
    /* no language helper on this page */
  }
  return "";
}

/** The exact request URL for a place search (kept separate so it can be tested).
 *
 * `countrycodes=et` is the DEFAULT context: deliveries are inside Ethiopia, so
 * "Bole" cannot surface a Bole in Uganda. It is a default, not a hard rule -
 * pass a falsy `country` (e.g. when the user asked to search worldwide) and the
 * filter is dropped so any country's places can be found.
 */
export function geocodeSearchUrl(query, limit, country) {
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : GEOCODE_LIMIT;
  const cc = country === undefined ? "et" : country;
  const countryParam = cc ? "countrycodes=" + encodeURIComponent(String(cc)) + "&" : "";
  return (
    GEOCODE_ENDPOINT +
    "?format=jsonv2&addressdetails=1&" +
    countryParam +
    "limit=" +
    n +
    "&q=" +
    encodeURIComponent(String(query == null ? "" : query).trim())
  );
}

/**
 * Turn the Nominatim response into plain results.
 *
 * Anything without a usable coordinate is dropped rather than guessed at -
 * the whole point of the box is an exact position.
 */
export function parseGeocodeResults(payload) {
  if (!Array.isArray(payload)) {
    throw new GeocodeError("parse", "Unexpected response from the place search");
  }
  const results = [];
  payload.forEach((item) => {
    if (!item) return;
    const latitude = Number(item.lat);
    const longitude = Number(item.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return;
    const full = typeof item.display_name === "string" ? item.display_name : "";
    const first = full.split(",")[0].trim();
    const title = (typeof item.name === "string" && item.name.trim()) || first || full.trim();
    results.push({
      latitude,
      longitude,
      title,
      address: full || title,
      type: item.type || item.category || "",
    });
  });
  return results;
}

/**
 * Combine the user's typed text with its city/country context.
 *
 * A LOCAL place is usually known by its local name alone ("Kesi Alemayehu" in
 * Debre Tabor), which providers only resolve when the city is part of the query.
 * This appends the missing city / region / country parts and NEVER drops or
 * replaces what the user typed - "never replace a specific local query with only
 * the city name". The typed text always stays the first part of the query.
 *
 * @param {string} text  the user's text (kept verbatim)
 * @param {object|string} [context]  { city, region, country } or a city string
 * @returns {string} the enriched query, or `text` unchanged when there is no context
 */
export function enrichPlaceQuery(text, context) {
  const base = String(text == null ? "" : text).trim();
  if (!base) return "";
  const ctx = typeof context === "string" ? { city: context } : context || {};
  const city = ctx.city || ctx.town || ctx.subCity || "";
  const region = ctx.region || ctx.state || "";
  const country = ctx.country === null ? "" : ctx.country || "Ethiopia";
  const lowered = base.toLowerCase();
  const parts = [base];
  const add = (value) => {
    const v = String(value == null ? "" : value).trim();
    if (!v) return;
    const lv = v.toLowerCase();
    if (lowered.indexOf(lv) >= 0) return; // the user already named it
    if (parts.some((p) => p.toLowerCase() === lv)) return; // no duplicates
    parts.push(v);
  };
  add(city);
  add(region);
  add(country);
  return parts.join(", ");
}

/**
 * Provider queries to try, best first: the raw text, then the same text with its
 * missing city/country context appended. Deduplicated, so a query that already
 * carries its city (or a call with no context at all) yields exactly one entry.
 */
export function placeSearchQueries(text, context) {
  const base = String(text == null ? "" : text).trim();
  const out = [];
  if (base) out.push(base);
  const enriched = enrichPlaceQuery(base, context);
  if (enriched && out.indexOf(enriched) < 0) out.push(enriched);
  return out;
}

/** Does a context object actually name a place we can bias the search with? */
function hasContext(context) {
  if (!context) return false;
  if (typeof context === "string") return Boolean(context.trim());
  const named = context.city || context.town || context.subCity || context.country;
  return Boolean(named && String(named).trim());
}

/**
 * Relevant alternatives when NO exact result exists (requirement: "if no exact
 * result exists, display relevant alternatives"). We do NOT invent a coordinate:
 * the alternative is the context city itself, a real dataset entry, and it is
 * FLAGGED `alternative: true` so the UI can say "nearest city, not the exact
 * place" instead of passing an approximate location off as exact.
 */
function cityAlternatives(text, context, limit) {
  if (!hasContext(context)) return [];
  const ctx = typeof context === "string" ? { city: context } : context || {};
  const city = String(ctx.city || ctx.town || ctx.subCity || ctx.country || "").trim();
  if (!city) return [];
  // Don't offer the city when the user literally typed it - that IS the result.
  if (String(text).toLowerCase().indexOf(city.toLowerCase()) >= 0) {
    const direct = searchEthiopiaPlaces(text, limit || 3);
    if (direct.length) return direct;
  }
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 3;
  return searchEthiopiaPlaces(city, max).map((hit) => Object.assign({}, hit, {
    alternative: true,
    approximate: true,
  }));
}

// Last time a request actually went out, for the 1 request/second policy.
let lastRequestAt = 0;

/** Test hook: forget the throttle window. */
export function resetGeocodeThrottle() {
  lastRequestAt = 0;
}

/**
 * Look a place up: the local Ethiopia dataset first, Nominatim second.
 *
 * The local layer (utils/ethiopia-places.js) answers for every Ethiopian city
 * and subcity instantly and offline; Nominatim then adds streets, landmarks
 * and anything outside the dataset. Local rows come first, duplicates (same
 * title) are dropped, and when Nominatim fails but the local layer has a hit
 * the lookup still succeeds - an honest local coordinate beats an error line.
 *
 * @param {string} query  free text ("Bole, Addis Ababa", a landmark, ...)
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]  injected fetch (tests)
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.limit]
 * @param {number} [options.minGapMs]  throttle gap (tests use a small value)
 * @param {boolean} [options.localPlaces]  false = Nominatim only (tests)
 * @param {Function} [options.now] / [options.sleep]  injectable clock (tests)
 * @returns {Promise<Array<{latitude, longitude, title, address, type, source?}>>}
 * @throws {GeocodeError} network | http | rate_limited | parse
 */
export async function searchPlaces(query, options = {}) {
  const text = String(query == null ? "" : query).trim();
  if (text.length < GEOCODE_MIN_QUERY) return [];

  const limit =
    Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : GEOCODE_LIMIT;
  // The offline dataset matches the RAW text (its keys are city names), so an
  // enriched "Kesi Alemayehu, Debre Tabor, Ethiopia" must not be used here.
  const local = options.localPlaces === false ? [] : searchEthiopiaPlaces(text, limit);

  // Provider queries: the raw text first, then the same text with its missing
  // city/country context appended, so a bare local name can still resolve.
  const candidates = placeSearchQueries(text, options.context);

  // Google Places (Text Search) first when a key/library is configured: it is
  // the only provider with real POI coverage (kebeles, streets, hotels,
  // restaurants, schools, hospitals, businesses) across every Ethiopian city.
  // Ethiopia is the default bias; the helper broadens to the whole world once
  // if the Ethiopia-biased search comes back empty. Each candidate is tried in
  // turn so "Kesi Alemayehu" is queried raw, then as "…, Debre Tabor, Ethiopia".
  let googleError = null;
  if (options.google !== false && googlePlacesConfigured(options)) {
    for (const candidate of candidates) {
      try {
        const places = await googleTextSearch(candidate, options, limit);
        if (places.length) return mergeResults(places, local);
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        googleError = err;
      }
    }
  }

  // A failure worth reporting only once every provider has been tried.
  const fail = (reason, message) => {
    if (googleError) throw googleError;
    throw new GeocodeError(reason, message);
  };

  const doFetch =
    options.fetchImpl ||
    (typeof fetch === "function" ? (url, init) => fetch(url, init) : null);
  if (!doFetch) {
    if (local.length) return local;
    fail("network", "This browser cannot run the place search");
    return [];
  }

  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const sleep = typeof options.sleep === "function" ? options.sleep : defaultSleep;
  const gap = Number.isFinite(Number(options.minGapMs)) ? Number(options.minGapMs) : GEOCODE_MIN_GAP_MS;

  const headers = { Accept: "application/json" };
  const lang = options.lang || currentLang();
  if (lang) headers["Accept-Language"] = lang;
  const cc = options.global ? "" : options.country || "et";

  // Try each candidate (raw, then contextual) and stop at the first that yields
  // results. A truthful local hit is always kept even when the network fails.
  let failure = null;
  for (const candidate of candidates) {
    const wait = lastRequestAt + gap - now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();

    let res;
    try {
      res = await doFetch(geocodeSearchUrl(candidate, options.limit, cc), { headers, signal: options.signal });
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      failure = { reason: "network" };
      continue;
    }

    if (!res || res.ok !== true) {
      const status = res && typeof res.status === "number" ? res.status : 0;
      failure = status === 429 ? { reason: "rate_limited" } : { reason: "http", status };
      // A rate limit is global - retrying the next candidate immediately would
      // only burn another rejected request.
      if (status === 429) break;
      continue;
    }

    let payload;
    try {
      payload = await res.json();
    } catch (err) {
      failure = { reason: "parse" };
      continue;
    }

    const remote = parseGeocodeResults(payload);
    const seen = new Set(local.map((item) => String(item.title).toLowerCase()));
    const fresh = remote.filter((item) => !seen.has(String(item.title).toLowerCase()));
    // A successful response (even with zero results) is a valid answer - return it.
    // Only network/http/parse errors should trigger trying the next candidate.
    return local.concat(fresh);
  }

  // Overpass API fallback: free-text name search on OpenStreetMap data.
  // This provides POI coverage (universities, hospitals, hotels, etc.) without
  // requiring a Google API key. Uses Ethiopia bounding box by default.
  // Only run in production (when no custom fetchImpl is injected for testing).
  if (!options.fetchImpl) {
    try {
      // Use Ethiopia bounding box for the search area
      const [minLat, minLon, maxLat, maxLon] = [
        OVERPASS_ETHIOPIA_BOUNDS.south,
        OVERPASS_ETHIOPIA_BOUNDS.west,
        OVERPASS_ETHIOPIA_BOUNDS.north,
        OVERPASS_ETHIOPIA_BOUNDS.east,
      ];
      // Use the first candidate (raw query) for Overpass name search
      const queryForOverpass = candidates[0] || text;
      const overpassResult = await searchPOIsByName(
        minLat, minLon, maxLat, maxLon,
        queryForOverpass,
        limit
      );
      if (overpassResult.pois && overpassResult.pois.length) {
        // Convert Overpass POIs to the same format as other providers
        const overpassPlaces = overpassResult.pois.map((poi) => ({
          latitude: poi.latitude,
          longitude: poi.longitude,
          title: poi.name,
          address: poi.tags?.addr || poi.type || 'OpenStreetMap',
          type: poi.type,
          source: 'overpass',
        }));
        const seen = new Set(local.map((item) => String(item.title).toLowerCase()));
        const fresh = overpassPlaces.filter((item) => !seen.has(String(item.title).toLowerCase()));
        return local.concat(fresh);
      }
    } catch (e) {
      // Overpass failed - continue to local/error handling
    }
  }

  if (local.length) return local;
  if (failure && failure.reason === "rate_limited") fail("rate_limited", "Place search rate limit reached");
  else if (failure && failure.reason === "parse") fail("parse", "Place search returned unreadable data");
  else if (failure && failure.reason === "http") fail("http", "Place search failed" + (failure.status ? " (" + failure.status + ")" : ""));
  else fail("network", "The place search could not be reached");
  return [];
}

/**
 * Google Text Search, Ethiopia-first then worldwide.
 *
 * The delivery context is Ethiopia, so the first try is biased there; if that
 * finds nothing the SAME query is retried with the bias removed, so a rider can
 * look up any place on Earth without a special mode - "global when needed".
 */
async function googleTextSearch(text, options, limit) {
  const base = {
    key: options.key,
    google: options.google,
    language: options.language,
    country: options.country,
    limit,
  };

  // Try the new enhanced search first (better for small/local places)
  const enhanced = await searchPlacesByName(text, Object.assign({}, base, { global: !!options.global }));
  if (enhanced.length) return mergeResults(enhanced, []);

  // Fallback to legacy text search
  const localish = await textSearchPlaces(text, Object.assign({}, base, { global: !!options.global }));
  if (localish.length || options.global) return localish;
  return textSearchPlaces(text, Object.assign({}, base, { global: true }));
}

/** Google rows first, then any offline local rows that are not duplicates. */
function mergeResults(primary, local) {
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if (!item) return;
    if (!Number.isFinite(Number(item.latitude)) || !Number.isFinite(Number(item.longitude))) return;
    const key = String(item.title || "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  (Array.isArray(primary) ? primary : []).forEach(push);
  (Array.isArray(local) ? local : []).forEach(push);
  return out;
}

/**
 * Dropdown suggestions for the live search box.
 *
 * Prefers Google Autocomplete (fast, session-billed, coordinate-less - the
 * coordinate is fetched for the picked row only). Falls back to the full
 * coordinate-bearing search (Google Text Search / local dataset / Nominatim)
 * when Google is not configured, returns nothing, or fails.
 *
 * @returns {Promise<Array<{title, address, latitude?, longitude?, placeId?, source, needsDetails?}>>}
 */
export async function searchPlaceSuggestions(query, options = {}) {
  const text = String(query == null ? "" : query).trim();
  if (text.length < GEOCODE_MIN_QUERY) return [];

  const candidates = placeSearchQueries(text, options.context);

  let googleError = null;
  if (options.google !== false && googlePlacesConfigured(options)) {
    for (const candidate of candidates) {
      try {
        const predictions = await suggestPlaces(candidate, {
          key: options.key,
          google: options.google,
          language: options.language,
          country: options.country,
          global: options.global,
          sessionToken: options.sessionToken,
        });
        if (predictions.length) return predictions;
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        googleError = err;
        /* fall through to the coordinate-bearing providers */
      }
    }
  }

  const results = await searchPlaces(text, options);
  if (results.length) return results;

  // No exact result: offer the context city as a clearly-flagged alternative so
  // the user still gets a usable, honest answer (never passed off as exact).
  const alternatives = cityAlternatives(text, options.context, options.limit);
  if (alternatives.length) return alternatives;

  // A configured-but-broken Google key is worth surfacing instead of the vague
  // "nothing found", so the operator learns the API needs fixing.
  if (
    googleError &&
    (googleError.reason === "auth" || googleError.reason === "load_error" || googleError.reason === "timeout")
  ) {
    throw googleError;
  }
  return results;
}

/**
 * Resolve a suggestion into a full result WITH coordinates (Place Details for a
 * Google Autocomplete row). Non-Google rows already carry coordinates and are
 * returned unchanged.
 *
 * @returns {Promise<object|null>} null when the coordinate could not be resolved
 */
export async function resolvePlaceResult(item, options = {}) {
  if (!item) return null;
  if (!item.needsDetails || !item.placeId) return item;
  try {
    const full = await resolvePlaceDetails(item, {
      key: options.key,
      google: options.google,
      language: options.language,
      sessionToken: options.sessionToken,
    });
    return full || null;
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    return null;
  }
}

export { newSessionToken };

/**
 * The search form markup: box + button + suggestion list + status + result line.
 *
 * Rendered as a SIBLING of the map (never inside it) so Leaflet's panes can
 * never cover the input, and so the suggestion dropdown can stack above the
 * tiles. `scope` makes the id/attribute unique per map on the page.
 */
export function geocodeSearchHtml(scope) {
  const key = scope == null ? "" : String(scope);
  const idAttr = key ? ` id="geocodeSearch-${esc(key)}"` : "";
  const dataAttr = key ? ` data-geocode-search="${esc(key)}"` : " data-geocode-search";
  const label = esc(t("map_search_label", "Search for an exact location"));
  return (
    `<form class="geocode-search"${idAttr}${dataAttr} role="search" autocomplete="off">` +
    `<div class="geocode-search-row">` +
    `<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>` +
    `<input type="search" class="geocode-search-input" aria-label="${label}" ` +
    `placeholder="${esc(t("map_search_placeholder", "Search a place (address, landmark…)"))}" />` +
    `<button type="submit" class="btn btn-sm btn-outline-info geocode-search-go">` +
    `${esc(t("map_search_button", "Search"))}</button>` +
    `</div>` +
    `<ul class="geocode-suggestions" role="listbox" aria-label="${label}" hidden></ul>` +
    `<p class="geocode-search-status" aria-live="polite"></p>` +
    `<p class="geocode-search-result" hidden>` +
    `<i class="fa-solid fa-location-dot" aria-hidden="true"></i>` +
    `<span class="geocode-search-result-text"></span>` +
    `<button type="button" class="geocode-search-copy" hidden>` +
    `${esc(t("map_search_copy", "Copy"))}</button>` +
    `<button type="button" class="geocode-search-clear" hidden aria-label="${esc(t("map_search_clear", "Clear search result"))}">` +
    `&times;</button>` +
    `</p>` +
    `<button type="button" class="btn btn-sm btn-outline-secondary geocode-search-pick" hidden>` +
    `${esc(t("map_search_pick_on_map", "Set location on map"))}</button>` +
    `</form>`
  );
}

/** "9.003, 38.761" - the exact numbers behind the address. */
function formatCoord(latitude, longitude) {
  return `${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`;
}

async function copyText(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    /* fall through to the legacy path */
  }
  try {
    if (typeof document !== "undefined" && document.body && typeof document.createElement === "function") {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const copied = typeof document.execCommand === "function" ? document.execCommand("copy") : false;
      document.body.removeChild(area);
      return Boolean(copied);
    }
  } catch (e) {
    /* nothing else to try */
  }
  return false;
}

/**
 * Wire a rendered form up to the lookup + the map.
 *
 * Safe to call on every render pass: a node that is already mounted is left
 * alone, and a form whose card has been rebuilt from scratch is simply a new
 * node needing new listeners.
 *
 * @param {HTMLElement} form        result of geocodeSearchHtml()
 * @param {object} [options]
 * @param {Function} [options.getMap]  current map (LiveDeliveryMap) or null
 * @param {Function} [options.onPick]  called with the chosen {latitude, longitude, ...}
 * @param {Function} [options.fetchImpl], [options.debounceMs], [options.minGapMs]
 * @returns {object|null} handle with clear()/picked state, or null when unusable
 */
export function mountGeocodeSearch(form, options = {}) {
  if (!form || typeof form.addEventListener !== "function") return null;
  if (form.dataset && form.dataset.geocodeMounted === "1") return null;

  const input = form.querySelector(".geocode-search-input");
  const list = form.querySelector(".geocode-suggestions");
  const statusEl = form.querySelector(".geocode-search-status");
  const resultEl = form.querySelector(".geocode-search-result");
  const resultText = form.querySelector(".geocode-search-result-text");
  const copyBtn = form.querySelector(".geocode-search-copy");
  const clearBtn = form.querySelector(".geocode-search-clear");
  const pickBtn = form.querySelector(".geocode-search-pick");
  if (!input || !list || !statusEl || !resultEl || !resultText) return null;

  if (form.dataset) form.dataset.geocodeMounted = "1";

  const debounceMs = Number.isFinite(Number(options.debounceMs)) ? Number(options.debounceMs) : GEOCODE_DEBOUNCE_MS;
  const state = { timer: null, token: 0, items: [], active: -1, picked: null, controller: null, sessionToken: null };

  /** A fresh Google Autocomplete session token (billing), best-effort. */
  const refreshSession = () => {
    try {
      state.sessionToken = newSessionToken(options);
    } catch (e) {
      state.sessionToken = null;
    }
  };
  refreshSession();

  const revealPickButton = (show) => {
    if (pickBtn) pickBtn.hidden = !show;
  };

  const setStatus = (text, cls) => {
    statusEl.textContent = text || "";
    statusEl.className = "geocode-search-status" + (cls ? " " + cls : "");
  };

  const cancelPending = () => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  };

  const closeList = () => {
    list.hidden = true;
    list.innerHTML = "";
    state.items = [];
    state.active = -1;
    if (input.removeAttribute) input.removeAttribute("aria-activedescendant");
  };

  const currentMap = () => (typeof options.getMap === "function" ? options.getMap() : null);

  const revealResult = (item) => {
    resultEl.hidden = false;
    const coords = ` · ${formatCoord(item.latitude, item.longitude)}`;
    resultText.textContent = `${item.address || item.title}${coords}`;
    if (copyBtn) copyBtn.hidden = false;
    if (clearBtn) clearBtn.hidden = false;
    revealPickButton(false);
  };

  const clearResult = () => {
    state.picked = null;
    resultEl.hidden = true;
    resultText.textContent = "";
    if (copyBtn) copyBtn.hidden = true;
    if (clearBtn) clearBtn.hidden = true;
    revealPickButton(false);
    setStatus("");
    const map = currentMap();
    if (map && typeof map.clearSearchPin === "function") {
      map.clearSearchPin();
      if (typeof map.refreshSize === "function") map.refreshSize();
    }
    if (map && typeof map.disableSearchPick === "function") {
      map.disableSearchPick();
    }
  };

  /** Move the map onto the chosen point (when this surface has a map at all). */
  const showOnMap = (item) => {
    const map = currentMap();
    if (!map) return;
    if (typeof map.setSearchPin === "function") {
      map.setSearchPin({ latitude: item.latitude, longitude: item.longitude }, item.title);
      return;
    }
    const leaflet = map.map || (typeof map.setView === "function" ? map : null);
    if (leaflet && typeof leaflet.setView === "function") {
      try {
        leaflet.setView([item.latitude, item.longitude], 16);
      } catch (e) {
        /* the map may have been torn down between lookup and pick */
      }
    }
  };

  const pick = async (index) => {
    const item = state.items[index];
    if (!item) return;
    const myToken = state.token;
    closeList();

    // A Google Autocomplete row has no coordinate yet: fetch it with Place
    // Details so the pin is always a real point (never an invented one).
    if (item.needsDetails && item.placeId) {
      state.picked = item;
      setStatus(t("map_search_resolving", "Getting the exact location…"), "is-waiting");
      const full = await resolvePlaceResult(item, Object.assign({}, options, { sessionToken: state.sessionToken }));
      if (myToken !== state.token) return;
      if (!full || !Number.isFinite(Number(full.latitude))) {
        setStatus(t("map_search_error", "Search is unavailable right now. Check your connection and try again."), "is-error");
        return;
      }
      refreshSession();
      state.picked = full;
      revealResult(full);
      setStatus(t("map_search_picked", "Location found"), "is-ok");
      showOnMap(full);
      if (typeof options.onPick === "function") options.onPick(full);
      return;
    }

    state.picked = item;
    revealResult(item);
    // An ALTERNATIVE (the nearest city when the exact place is unknown) is shown
    // as such - it must never read as an exact match.
    setStatus(
      item.alternative
        ? t("map_search_nearest", "Showing the nearest city - not the exact place.")
        : t("map_search_picked", "Location found"),
      item.alternative ? "is-waiting" : "is-ok"
    );
    showOnMap(item);
    if (typeof options.onPick === "function") options.onPick(item);
  };

  const renderList = (items) => {
    if (!items.length) {
      closeList();
      return;
    }
    // The rows are only worth their index into this exact result set: a later
    // lookup replaces it (closeList() clears it too), so a stale click can
    // never resolve to a coordinate nobody asked for.
    state.items = items;
    list.innerHTML = items
      .map((item, i) => {
        const hasCoords = Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude));
        const sub =
          item.address && item.address !== item.title
            ? item.address
            : hasCoords
            ? formatCoord(item.latitude, item.longitude)
            : item.address || "";
        const alt = item.alternative
          ? `<em class="geocode-alt">${esc(t("map_search_alternative", "nearest city, not the exact place"))}</em>`
          : "";
        return (
          `<li class="geocode-suggestion" role="option" data-index="${i}">` +
          `<span class="geocode-suggestion-title">${esc(item.title)}</span>` +
          `<small>${esc(sub)}</small>${alt}</li>`
        );
      })
      .join("");
    list.hidden = false;
    setActive(-1);
  };

  function setActive(index) {
    state.active = index;
    const nodes = typeof list.querySelectorAll === "function" ? list.querySelectorAll(".geocode-suggestion") : [];
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].classList) nodes[i].classList.toggle("is-active", i === index);
    }
  }

  async function run() {
    const text = String(input.value == null ? "" : input.value).trim();
    if (text.length < GEOCODE_MIN_QUERY) {
      closeList();
      setStatus("");
      return;
    }

    const token = ++state.token;
    if (state.controller && typeof state.controller.abort === "function") {
      try {
        state.controller.abort();
      } catch (e) {
        /* a finished controller cannot be aborted again */
      }
    }
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    state.controller = controller;

    setStatus(t("map_search_searching", "Searching…"), "is-waiting");
    try {
      const results = await searchPlaceSuggestions(
        text,
        Object.assign({}, options, { sessionToken: state.sessionToken }, controller ? { signal: controller.signal } : {})
      );
      if (token !== state.token) return; // a newer keystroke owns the UI now
      if (!results.length) {
        closeList();
        // Nothing matched: offer the honest fallback - drop the pin by hand.
        const map = currentMap();
        revealPickButton(Boolean(map && typeof map.enableSearchPick === "function"));
        setStatus(t("map_search_none", "No places found. Try a more specific address."), "is-empty");
        return;
      }
      revealPickButton(false);
      setStatus("");
      renderList(results);
      // One exact hit: skip the ceremony and jump straight to it.
      if (results.length === 1) pick(0);
    } catch (err) {
      if (token !== state.token || (err && err.name === "AbortError")) return;
      closeList();
      revealPickButton(false);
      setStatus(
        err && err.reason === "rate_limited"
          ? t("map_search_rate_limited", "Too many searches in a row. Wait a moment and try again.")
          : err && (err.reason === "auth" || err.reason === "load_error" || err.reason === "timeout")
          ? t("map_search_google_unavailable", "Place search is unavailable (Google Maps key rejected or not enabled).")
          : t("map_search_error", "Search is unavailable right now. Check your connection and try again."),
        "is-error"
      );
    }
  }

  const schedule = () => {
    cancelPending();
    state.timer = setTimeout(() => {
      state.timer = null;
      run();
    }, debounceMs);
  };

  input.addEventListener("input", schedule);

  input.addEventListener("keydown", (event) => {
    if (!event) return;
    const key = event.key;
    if (key === "Escape") {
      cancelPending();
      closeList();
      return;
    }
    const count = state.items.length;
    if (key === "ArrowDown" && count) {
      if (event.preventDefault) event.preventDefault();
      setActive((state.active + 1) % count);
      return;
    }
    if (key === "ArrowUp" && count) {
      if (event.preventDefault) event.preventDefault();
      setActive((state.active - 1 + count) % count);
      return;
    }
    if (key === "Enter" && state.active >= 0 && state.active < count) {
      // Consume Enter so the form does not also submit a second lookup.
      if (event.preventDefault) event.preventDefault();
      cancelPending();
      pick(state.active);
    }
  });

  // Clicks land after blur, so the 150ms hold keeps a suggestion pickable.
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (state.active === -1) closeList();
    }, 150);
  });

  form.addEventListener("submit", (event) => {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    cancelPending();
    run();
  });

  list.addEventListener("click", (event) => {
    let node = event && event.target ? event.target : null;
    while (node && node !== list && !(node.dataset && node.dataset.index != null)) {
      node = node.parentNode;
    }
    if (!node || node === list) return;
    cancelPending();
    pick(Number(node.dataset.index));
  });

  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const text = resultText.textContent || "";
      if (!text) return;
      const copied = await copyText(text);
      setStatus(
        copied
          ? t("map_search_copied", "Coordinates copied")
          : t("map_search_copy_failed", "Select the coordinates and copy them manually."),
        copied ? "is-ok" : "is-error"
      );
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      clearResult();
      if (input.focus) input.focus();
    });
  }

  // Manual fallback: when nothing matched (a place Google/OSM does not know),
  // let the user drop a real pin by hand instead of inventing a coordinate.
  if (pickBtn) {
    pickBtn.addEventListener("click", () => {
      const map = currentMap();
      if (!map || typeof map.enableSearchPick !== "function") {
        setStatus(t("map_search_pick_unavailable", "Tap the map to set the location."), "is-waiting");
        return;
      }
      setStatus(t("map_search_pick_hint", "Tap the map to drop the pin."), "is-waiting");
      revealPickButton(false);
      map.enableSearchPick((point) => {
        if (!point || !Number.isFinite(Number(point.latitude))) return;
        const item = {
          latitude: Number(point.latitude),
          longitude: Number(point.longitude),
          title: t("map_search_dropped", "Dropped pin"),
          address: formatCoord(point.latitude, point.longitude),
          source: "manual",
        };
        state.picked = item;
        revealResult(item);
        setStatus(t("map_search_picked", "Location found"), "is-ok");
        if (typeof options.onPick === "function") options.onPick(item);
      });
    });
  }

  return {
    run,
    clear: clearResult,
    get picked() {
      return state.picked;
    },
  };
}
