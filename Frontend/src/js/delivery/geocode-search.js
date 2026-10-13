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
 * `countrycodes=et` pins Nominatim to Ethiopia: the service delivers for one
 * country only, so "Bole" cannot surface a Bole in Uganda while the customer
 * is addressing a delivery inside Ethiopia.
 */
export function geocodeSearchUrl(query, limit) {
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : GEOCODE_LIMIT;
  return (
    GEOCODE_ENDPOINT +
    "?format=jsonv2&addressdetails=1&countrycodes=et&limit=" +
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
  const local = options.localPlaces === false ? [] : searchEthiopiaPlaces(text, limit);

  const doFetch =
    options.fetchImpl ||
    (typeof fetch === "function" ? (url, init) => fetch(url, init) : null);
  if (!doFetch) {
    if (local.length) return local;
    throw new GeocodeError("network", "This browser cannot run the place search");
  }

  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const sleep = typeof options.sleep === "function" ? options.sleep : defaultSleep;
  const gap = Number.isFinite(Number(options.minGapMs)) ? Number(options.minGapMs) : GEOCODE_MIN_GAP_MS;
  const wait = lastRequestAt + gap - now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = now();

  const headers = { Accept: "application/json" };
  const lang = options.lang || currentLang();
  if (lang) headers["Accept-Language"] = lang;

  let res;
  try {
    res = await doFetch(geocodeSearchUrl(text, options.limit), { headers, signal: options.signal });
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    if (local.length) return local;
    throw new GeocodeError("network", "The place search could not be reached");
  }

  if (!res || res.ok !== true) {
    if (local.length) return local;
    const status = res && typeof res.status === "number" ? res.status : 0;
    if (status === 429) throw new GeocodeError("rate_limited", "Place search rate limit reached");
    throw new GeocodeError("http", "Place search failed" + (status ? " (" + status + ")" : ""));
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    if (local.length) return local;
    throw new GeocodeError("parse", "Place search returned unreadable data");
  }

  const remote = parseGeocodeResults(payload);
  const seen = new Set(local.map((item) => String(item.title).toLowerCase()));
  const fresh = remote.filter((item) => !seen.has(String(item.title).toLowerCase()));
  return local.concat(fresh);
}

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
  if (!input || !list || !statusEl || !resultEl || !resultText) return null;

  if (form.dataset) form.dataset.geocodeMounted = "1";

  const debounceMs = Number.isFinite(Number(options.debounceMs)) ? Number(options.debounceMs) : GEOCODE_DEBOUNCE_MS;
  const state = { timer: null, token: 0, items: [], active: -1, picked: null, controller: null };

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
    resultText.textContent = `${item.address || item.title} · ${formatCoord(item.latitude, item.longitude)}`;
    if (copyBtn) copyBtn.hidden = false;
    if (clearBtn) clearBtn.hidden = false;
  };

  const clearResult = () => {
    state.picked = null;
    resultEl.hidden = true;
    resultText.textContent = "";
    if (copyBtn) copyBtn.hidden = true;
    if (clearBtn) clearBtn.hidden = true;
    setStatus("");
    const map = currentMap();
    if (map && typeof map.clearSearchPin === "function") {
      map.clearSearchPin();
      if (typeof map.refreshSize === "function") map.refreshSize();
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

  const pick = (index) => {
    const item = state.items[index];
    if (!item) return;
    state.picked = item;
    revealResult(item);
    closeList();
    setStatus(t("map_search_picked", "Location found"), "is-ok");
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
        const sub = item.address && item.address !== item.title ? item.address : formatCoord(item.latitude, item.longitude);
        return (
          `<li class="geocode-suggestion" role="option" data-index="${i}">` +
          `<span class="geocode-suggestion-title">${esc(item.title)}</span>` +
          `<small>${esc(sub)}</small></li>`
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
      const results = await searchPlaces(
        text,
        Object.assign({}, options, controller ? { signal: controller.signal } : {})
      );
      if (token !== state.token) return; // a newer keystroke owns the UI now
      if (!results.length) {
        closeList();
        setStatus(t("map_search_none", "No places found. Try a more specific address."), "is-empty");
        return;
      }
      setStatus("");
      renderList(results);
      // One exact hit: skip the ceremony and jump straight to it.
      if (results.length === 1) pick(0);
    } catch (err) {
      if (token !== state.token || (err && err.name === "AbortError")) return;
      closeList();
      setStatus(
        err && err.reason === "rate_limited"
          ? t("map_search_rate_limited", "Too many searches in a row. Wait a moment and try again.")
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

  return {
    run,
    clear: clearResult,
    get picked() {
      return state.picked;
    },
  };
}
