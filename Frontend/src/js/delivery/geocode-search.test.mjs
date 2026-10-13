/**
 * Place-search tests (delivery/geocode-search.js) + the map surface it drives.
 *
 * The search box is the one control on a live map that turns free text into a
 * coordinate, so the rules under test are the ones that keep that coordinate
 * honest and the map responsive:
 *
 *   - the request URL is built from the typed text (nothing invented) and is
 *     pinned to Ethiopia (countrycodes=et);
 *   - the local Ethiopia dataset answers first (offline-safe), Nominatim adds
 *     the rest, duplicates are dropped, and a coordinateless dataset entry is
 *     never suggested;
 *   - a response entry without a finite, in-range lat/lon is dropped;
 *   - every failure mode (network / HTTP / rate limit / bad payload) becomes a
 *     typed GeocodeError the UI can translate, never a silent empty result;
 *   - requests are throttled, because the public Nominatim service allows one
 *     per second;
 *   - mounting wires debounced suggestions -> pick -> map pin + onPick with the
 *     exact numbers, and is idempotent per node;
 *   - the search pin freezes the map's auto-fit (so live GPS frames cannot yank
 *     the camera away) until the result is cleared;
 *   - a rebuilt card gets a rebuilt map, not an instance stuck on a detached
 *     node (delivery/dashboard-map.js).
 *
 * Run: node Frontend/src/js/delivery/geocode-search.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function record(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " -- " + detail : "")); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Type into the box, submit, and wait out the (stubbed) lookup. */
async function submitSearch(form, text) {
  form.parts[".geocode-search-input"].value = text;
  await form.dispatch("submit", { preventDefault() {} });
  await sleep(40);
}

/** Minimal element stand-in: listeners, dataset, classList, innerHTML -> nodes. */
function fakeEl(tag) {
  const listeners = {};
  const nodes = [];
  const children = [];
  const classes = new Set();
  const el = {
    tagName: tag,
    hidden: false,
    value: "",
    textContent: "",
    className: "",
    dataset: {},
    style: {},
    attrs: {},
    parentNode: null,
    listeners,
    _nodes: nodes,
    classList: {
      add: (c) => { classes.add(c); },
      remove: (c) => { classes.delete(c); },
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event) {
      const out = (listeners[type] || []).map((fn) => fn(event || {}));
      return Promise.all(out);
    },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    removeAttribute(k) { delete el.attrs[k]; },
    querySelector(sel) { return (el._queries || {})[sel] || null; },
    querySelectorAll(sel) { return sel === ".geocode-suggestion" ? nodes.slice() : []; },
    appendChild(child) { child.parentNode = el; children.push(child); return child; },
    removeChild(child) {
      const i = children.indexOf(child);
      if (i >= 0) children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    focus() {},
    select() {},
    contains(node) { return node === el || children.indexOf(node) >= 0; },
    get innerHTML() { return el._html || ""; },
    set innerHTML(value) {
      // The mount only ever writes suggestion markup: rebuild one node per
      // `data-index` so clicks and querySelectorAll behave like the browser.
      el._html = String(value);
      nodes.length = 0;
      const re = /data-index="(\d+)"/g;
      let m = re.exec(el._html);
      while (m) {
        const li = fakeEl("li");
        li.dataset.index = m[1];
        li.classList.add("geocode-suggestion");
        li.parentNode = el; // click delegation walks up to the list
        nodes.push(li);
        m = re.exec(el._html);
      }
    },
  };
  el._children = children;
  return el;
}

/** The form geocodeSearchHtml() would produce, wired by selector. */
function fakeForm() {
  const form = fakeEl("form");
  const parts = {
    ".geocode-search-input": fakeEl("input"),
    ".geocode-suggestions": fakeEl("ul"),
    ".geocode-search-status": fakeEl("p"),
    ".geocode-search-result": fakeEl("p"),
    ".geocode-search-result-text": fakeEl("span"),
    ".geocode-search-copy": fakeEl("button"),
    ".geocode-search-clear": fakeEl("button"),
  };
  form._queries = parts;
  form.parts = parts;
  // Matches the markup geocodeSearchHtml() emits: everything after the box is
  // hidden until a lookup actually finds something.
  parts[".geocode-suggestions"].hidden = true;
  parts[".geocode-search-result"].hidden = true;
  parts[".geocode-search-copy"].hidden = true;
  parts[".geocode-search-clear"].hidden = true;
  return form;
}

/** Just enough Leaflet to run LiveDeliveryMap end to end. */
function fakeLeaflet() {
  const calls = { map: [], setView: [], fitBounds: [], removed: 0 };
  const marker = (latLng) => ({
    latLng,
    popup: "",
    addTo() { return this; },
    bindPopup(text) { this.popup = text; return this; },
    setLatLng(v) { this.latLng = v; return this; },
    setPopupContent(text) { this.popup = text; return this; },
    getLatLng() { return this.latLng; },
  });
  return {
    calls,
    divIcon: (opts) => ({ opts }),
    map(container, opts) {
      const state = { zoom: 13 };
      const m = {
        container,
        opts,
        setView(ll, z) { calls.setView.push({ ll, z }); if (z) state.zoom = z; return m; },
        getZoom: () => state.zoom,
        fitBounds(ll) { calls.fitBounds.push(ll); state.zoom = 16; return m; },
        invalidateSize: () => m,
        removeLayer: () => m,
        remove: () => { calls.removed++; },
      };
      calls.map.push(container);
      return m;
    },
    tileLayer: () => ({ addTo() { return this; } }),
    marker: (ll) => marker(ll),
    circle: () => ({ addTo() { return this; }, setLatLng() {}, remove() {} }),
    polyline: () => ({
      addTo() { return this; },
      bindPopup() { return this; },
      setLatLngs() {},
      setPopupContent() {},
      remove() {},
    }),
  };
}

async function main() {
  // --- browser-ish globals (same pattern as geo.test.mjs) -------------------
  globalThis.window = {
    addEventListener() {},
    getCurrentLanguage: () => "en",
    getText: (key) => key,
    isSecureContext: true,
    MutationObserver: class { observe() {} disconnect() {} },
  };
  globalThis.document = {
    readyState: "loading",
    addEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => fakeEl("div"),
    body: fakeEl("body"),
  };
  globalThis.localStorage = { getItem: () => null, setItem() {} };

  const geocode = await import("./geocode-search.js");
  const {
    GEOCODE_ENDPOINT,
    GEOCODE_MIN_GAP_MS,
    GEOCODE_DEBOUNCE_MS,
    GeocodeError,
    geocodeSearchUrl,
    parseGeocodeResults,
    resetGeocodeThrottle,
    searchPlaces,
    geocodeSearchHtml,
    mountGeocodeSearch,
  } = geocode;

  const { LiveDeliveryMap, mapAvailable } = await import("./live-map.js");
  const { syncDashboardMaps, destroyDashboardMaps } = await import("./dashboard-map.js");

  console.log("");
  console.log("--- request / response ---");

  const url = geocodeSearchUrl("Bole, Addis Ababa");
  record("URL points at Nominatim search",
    url.startsWith(GEOCODE_ENDPOINT + "?"), url);
  record("URL carries format + addressdetails + limit",
    url.includes("format=jsonv2") && url.includes("addressdetails=1") && url.includes("limit=5"), url);
  record("URL pins Nominatim to Ethiopia (deliveries are never elsewhere)",
    url.includes("countrycodes=et"), url);
  record("URL encodes the typed text",
    url.includes("q=Bole%2C%20Addis%20Ababa"), url);
  record("URL trims the query",
    !geocodeSearchUrl("  x  ").includes("q=%20%20x"), geocodeSearchUrl("  x  "));

  const good = parseGeocodeResults([
    { lat: "9.0031", lon: "38.7612", display_name: "Bole Road, Addis Ababa", name: "Bole Road" },
    { lat: "not-a-number", lon: "38.7", display_name: "Broken" },
    { lat: "95", lon: "38.7", display_name: "Out of range" },
    { lat: "9.01", lon: "999", display_name: "Out of range 2" },
    null,
  ]);
  record("only finite, in-range coordinates survive", good.length === 1, JSON.stringify(good));
  record("coordinates are numbers, not strings",
    good[0] && typeof good[0].latitude === "number" && good[0].longitude === 38.7612,
    JSON.stringify(good[0]));
  record("title prefers the short name, address keeps the full one",
    good[0].title === "Bole Road" && good[0].address === "Bole Road, Addis Ababa",
    JSON.stringify(good[0]));
  record("title falls back to the first segment of display_name",
    parseGeocodeResults([{ lat: "9", lon: "38", display_name: "Piazza, Addis Ababa" }])[0].title === "Piazza");
  let threw = "";
  try { parseGeocodeResults({ not: "an array" }); } catch (e) { threw = e.reason || e.name; }
  record("a non-array payload is a parse error", threw === "parse", threw);

  console.log("");
  console.log("--- lookup failures ---");

  const expectError = async (label, options, reason) => {
    let got = null;
    try { await searchPlaces("Bole market", options); } catch (e) { got = e; }
    record(label, got instanceof GeocodeError && got.reason === reason,
      got ? got.name + ":" + got.reason : "no error thrown");
  };

  await expectError("network failure is typed", {
    minGapMs: 0,
    fetchImpl: async () => { throw new Error("offline"); },
  }, "network");
  await expectError("HTTP 429 is rate_limited", {
    minGapMs: 0,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => [] }),
  }, "rate_limited");
  await expectError("HTTP 500 is http", {
    minGapMs: 0,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => [] }),
  }, "http");
  await expectError("unreadable body is parse", {
    minGapMs: 0,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad"); } }),
  }, "parse");

  let fetched = 0;
  const shortResult = await searchPlaces("b", { minGapMs: 0, fetchImpl: async () => { fetched++; return { ok: true, json: async () => [] }; } });
  record("one character never reaches the network", shortResult.length === 0 && fetched === 0, String(fetched));

  // "Bole Market": a street-level phrase the local dataset deliberately does
  // not claim, so this exercises the Nominatim half of the lookup on its own.
  const okResult = await searchPlaces("Bole Market", {
    minGapMs: 0,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => [{ lat: "9.01", lon: "38.75", display_name: "Bole, Addis Ababa" }],
    }),
  });
  record("a successful lookup returns parsed results", okResult.length === 1 && okResult[0].latitude === 9.01,
    JSON.stringify(okResult));

  let askedLang = null;
  await searchPlaces("Addis", {
    minGapMs: 0,
    lang: "am",
    fetchImpl: async (u, init) => {
      askedLang = init.headers["Accept-Language"];
      return { ok: true, json: async () => [] };
    },
  });
  record("the request asks for the current language", askedLang === "am", String(askedLang));

  resetGeocodeThrottle();
  const startedAt = Date.now();
  await searchPlaces("one", { minGapMs: 80, fetchImpl: async () => ({ ok: true, json: async () => [] }) });
  await searchPlaces("two", { minGapMs: 80, fetchImpl: async () => ({ ok: true, json: async () => [] }) });
  const gapMs = Date.now() - startedAt;
  record("consecutive lookups are throttled", gapMs >= 70, gapMs + "ms");
  record("the default throttle is one request per second", GEOCODE_MIN_GAP_MS === 1000, String(GEOCODE_MIN_GAP_MS));
  record("typing is debounced", GEOCODE_DEBOUNCE_MS >= 200, String(GEOCODE_DEBOUNCE_MS));
  resetGeocodeThrottle();

  console.log("");
  console.log("--- local Ethiopia layer ---");

  {
    // Nominatim answers for streets and landmarks; the dataset answers for
    // every Ethiopian city and subcity - instantly, offline, and first.
    const localOnly = await searchPlaces("Bahir Dar", {
      minGapMs: 0,
      fetchImpl: async () => ({ ok: true, json: async () => [] }),
    });
    record("a city answers even when Nominatim has nothing",
      localOnly.length === 1 && localOnly[0].title === "Bahir Dar", JSON.stringify(localOnly));
    record("the local hit carries its real coordinate",
      localOnly[0].source === "local" && localOnly[0].latitude === 11.5949663,
      JSON.stringify(localOnly[0]));
    record("the local hit is a full address",
      localOnly[0].address === "Bahir Dar, Amhara, Ethiopia", localOnly[0].address);

    const merged = await searchPlaces("Bahir Dar", {
      minGapMs: 0,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => [
          { lat: "11.6000", lon: "37.3900", display_name: "Bahir Dar, Amhara Region, Ethiopia" },
          { lat: "11.6100", lon: "37.4000", display_name: "Lion of Judah Square, Bahir Dar" },
        ],
      }),
    });
    record("local rows come before Nominatim rows",
      merged[0].source === "local" && merged[0].title === "Bahir Dar", JSON.stringify(merged[0]));
    record("the same title is never listed twice",
      merged.filter((item) => item.title === "Bahir Dar").length === 1, JSON.stringify(merged.map((i) => i.title)));
    record("Nominatim still adds what the dataset has not",
      merged.length === 2 && merged[1].title === "Lion of Judah Square", JSON.stringify(merged.map((i) => i.title)));

    const duplicate = await searchPlaces("Bole", {
      minGapMs: 0,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => [{ lat: "9.01", lon: "38.75", display_name: "Bole, Addis Ababa" }],
      }),
    });
    record("a duplicate title keeps the curated dataset coordinate",
      duplicate.length === 1 && duplicate[0].source === "local",
      JSON.stringify(duplicate));

    const offline = await searchPlaces("Bahir Dar", {
      minGapMs: 0,
      fetchImpl: async () => { throw new Error("offline"); },
    });
    record("an offline search still answers from the dataset",
      offline.length === 1 && offline[0].source === "local", JSON.stringify(offline));

    let networkError = null;
    try {
      await searchPlaces("Bahir Dar", {
        minGapMs: 0,
        localPlaces: false,
        fetchImpl: async () => { throw new Error("offline"); },
      });
    } catch (e) { networkError = e; }
    record("localPlaces:false queries Nominatim only (the old contract)",
      networkError instanceof GeocodeError && networkError.reason === "network",
      networkError ? networkError.reason : "no error thrown");

    const kebele = await searchPlaces("Kebele 03", {
      minGapMs: 0,
      fetchImpl: async () => ({ ok: true, json: async () => [] }),
    });
    record("a dataset entry without a coordinate is never suggested",
      kebele.length === 0, JSON.stringify(kebele));
  }

  console.log("");
  console.log("--- form markup ---");

  const html = geocodeSearchHtml("ET-1000ABC");
  record("the form has a stable id per map",
    html.includes('id="geocodeSearch-ET-1000ABC"'), html.slice(0, 120));
  record("the form marks itself mountable",
    html.includes('data-geocode-search="ET-1000ABC"'), html.slice(0, 160));
  record("suggestions are an ARIA listbox", html.includes('role="listbox"') && html.includes('role="search"'));
  record("the status line is announced", html.includes('aria-live="polite"'));
  record("the resolved coordinates get a result line",
    html.includes("geocode-search-result-text") && html.includes("geocode-search-copy"));
  record("a scope with quotes cannot break the attribute",
    geocodeSearchHtml('a"b').includes('data-geocode-search="a&quot;b"'), geocodeSearchHtml('a"b'));

  // Markup and wiring live in the same file, but the two callers (rider card,
  // manager monitor) reach the form by id from somewhere else. If either side
  // drifts, the box renders and does nothing - so pin the contract here.
  const moduleSource = fs.readFileSync(path.resolve(here, "geocode-search.js"), "utf8");
  const selectors = Array.from(moduleSource.matchAll(/form\.querySelector\("([^"]+)"\)/g), (m) => m[1]);
  const absent = selectors.filter((sel) => html.indexOf(sel.slice(1)) < 0);
  record("every element mount looks for exists in the markup",
    selectors.length >= 6 && absent.length === 0, absent.join(", ") + " of " + selectors.length);

  const dashboardSource = fs.readFileSync(path.resolve(here, "dashboard-map.js"), "utf8");
  record("the rider page reaches the form by the id the markup declares",
    dashboardSource.includes('getElementById("geocodeSearch-" + orderId)') &&
    html.includes('id="geocodeSearch-ET-1000ABC"'));
  record("the rider page mounts the search on every render",
    dashboardSource.includes("mountGeocodeSearch("));

  const gpsUiSource = fs.readFileSync(path.resolve(here, "gps-ui.js"), "utf8");
  record("the GPS panel renders the search box above the map",
    gpsUiSource.includes("geocodeSearchHtml(orderId)"));

  const adminSource = fs.readFileSync(path.resolve(here, "..", "admin-deliveries.js"), "utf8");
  record("the manager monitor renders and mounts the same form",
    adminSource.includes('ScosGeocode.html("liveTrack")') &&
    adminSource.includes('getElementById("geocodeSearch-liveTrack")') &&
    geocodeSearchHtml("liveTrack").includes('id="geocodeSearch-liveTrack"'));
  const bridgeSource = fs.readFileSync(path.resolve(here, "live-map-global.js"), "utf8");
  record("the classic-script bridge exposes the helper to the admin page",
    bridgeSource.includes("window.ScosGeocode"));

  console.log("");
  console.log("--- i18n keys ---");

  const i18nSource = fs.readFileSync(path.resolve(here, "..", "utils", "i18n.js"), "utf8");
  const searchKeys = [
    "map_search_label", "map_search_placeholder", "map_search_button", "map_search_searching",
    "map_search_none", "map_search_error", "map_search_rate_limited", "map_search_picked",
    "map_search_copy", "map_search_copied", "map_search_copy_failed", "map_search_clear",
  ];
  const missing = searchKeys.filter((k) => {
    const n = i18nSource.split(k + ":").length - 1;
    return n !== 2; // one English, one Amharic
  });
  record("every search label exists in English AND Amharic", missing.length === 0, missing.join(", "));
  record("the Amharic block really is Amharic",
    /map_search_button:\s*'[^\x00-\x7F]/.test(i18nSource), "no non-ASCII value found");

  console.log("");
  console.log("--- mount: suggest -> pick -> pin ---");

  {
    const form = fakeForm();
    const picks = [];
    const pins = [];
    const map = {
      setSearchPin(point, label) { pins.push({ point, label }); return true; },
      clearSearchPin() { pins.length = 0; return true; },
      refreshSize() {},
    };
    const requests = [];
    const handle = mountGeocodeSearch(form, {
      getMap: () => map,
      onPick: (item) => picks.push(item),
      fetchImpl: async (u, init) => {
        requests.push(u);
        return {
          ok: true,
          status: 200,
          json: async () => [
            { lat: "9.00310", lon: "38.76120", display_name: "Bole Road, Addis Ababa", name: "Bole Road" },
          ],
        };
      },
      debounceMs: 5,
      minGapMs: 0,
    });

    record("mount returns a handle", Boolean(handle && typeof handle.run === "function"));
    record("mount marks the node as mounted", form.dataset.geocodeMounted === "1");
    record("mounting the same node twice is a no-op", mountGeocodeSearch(form, {}) === null);

    form.parts[".geocode-search-input"].value = "Bole Road";
    await form.parts[".geocode-search-input"].dispatch("input");
    await sleep(40);

    record("typing triggers exactly one lookup", requests.length === 1, String(requests.length));
    record("the lookup carries the typed text",
      requests.length > 0 && requests[0].includes("q=Bole%20Road"), requests[0] || "");
    record("a single hit is picked automatically", picks.length === 1, String(picks.length));
    record("the picked result keeps the exact coordinates",
      picks[0] && picks[0].latitude === 9.0031 && picks[0].longitude === 38.7612,
      JSON.stringify(picks[0]));
    record("the exact coordinates are printed for copying",
      form.parts[".geocode-search-result-text"].textContent.includes("9.00310, 38.76120"),
      form.parts[".geocode-search-result-text"].textContent);
    record("the result line is revealed",
      form.parts[".geocode-search-result"].hidden === false &&
      form.parts[".geocode-search-copy"].hidden === false);
    record("the map gets a search pin at that point",
      pins.length === 1 && pins[0].point.latitude === 9.0031, JSON.stringify(pins));
    record("the status confirms the location",
      form.parts[".geocode-search-status"].textContent === "Location found" &&
      form.parts[".geocode-search-status"].className.includes("is-ok"),
      form.parts[".geocode-search-status"].className + " | " + form.parts[".geocode-search-status"].textContent);
    record("the suggestion list is closed after picking",
      form.parts[".geocode-suggestions"].hidden === true);

    // Clear puts the view back in the map's hands.
    form.parts[".geocode-search-clear"].dispatch("click");
    record("clearing hides the result", form.parts[".geocode-search-result"].hidden === true);
    record("clearing removes the pin", pins.length === 0, JSON.stringify(pins));
  }

  {
    const form = fakeForm();
    const picks = [];
    mountGeocodeSearch(form, {
      getMap: () => null,
      onPick: (item) => picks.push(item),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => [
          { lat: "9.0031", lon: "38.7612", display_name: "Bole Road, Addis Ababa" },
          { lat: "9.0100", lon: "38.7700", display_name: "Kazanchis, Addis Ababa" },
        ],
      }),
      debounceMs: 5,
      minGapMs: 0,
    });

    await submitSearch(form, "Meskel Square");

    // Snapshot: clearing the list empties the live array.
    const nodes = form.parts[".geocode-suggestions"]._nodes.slice();
    record("several hits render as suggestions", nodes.length === 2, String(nodes.length));
    record("nothing is picked while suggestions are open", picks.length === 0, String(picks.length));
    record("each suggestion carries its index",
      nodes.length > 1 && nodes[1].dataset.index === "1", String(nodes.length));

    // Keyboard: move the highlight down, then commit with Enter.
    const handled = [];
    const event = (key) => ({ key, preventDefault() { handled.push(key); } });
    await form.parts[".geocode-search-input"].dispatch("keydown", event("ArrowDown"));
    record("ArrowDown highlights the first row",
      nodes.length > 0 && nodes[0].classList.contains("is-active"), String(nodes.length));
    record("ArrowDown only moves the highlight (no pick, no new lookup)",
      handled.join(",") === "ArrowDown" && picks.length === 0, handled.join(",") + " picks=" + picks.length);
    await form.parts[".geocode-search-input"].dispatch("keydown", event("Enter"));
    record("Enter consumes the key so the form does not resubmit", handled.includes("Enter"), handled.join(","));
    record("Enter picks the highlighted row",
      picks.length === 1 && picks[0].longitude === 38.7612, JSON.stringify(picks));

    // Mouse: re-run, then click the second row.
    await submitSearch(form, "Meskel Square");
    const again = form.parts[".geocode-suggestions"]._nodes.slice();
    record("the list comes back on a second lookup", again.length === 2, String(again.length));
    await form.parts[".geocode-suggestions"].dispatch("click", { target: again[1] });
    record("clicking a suggestion picks that result",
      picks.length === 2 && picks[1].longitude === 38.77, JSON.stringify(picks));
    record("picking closes the list", form.parts[".geocode-suggestions"].hidden === true);
  }

  {
    const form = fakeForm();
    mountGeocodeSearch(form, {
      getMap: () => null,
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => [] }),
      debounceMs: 5,
      minGapMs: 0,
    });
    await submitSearch(form, "Kazanchis");
    const status = form.parts[".geocode-search-status"];
    record("a failed lookup says so instead of showing nothing",
      status.textContent.includes("Search is unavailable right now"), status.textContent);
    record("a failed lookup is marked as an error", status.className.includes("is-error"), status.className);
    record("a failed lookup shows no coordinates", form.parts[".geocode-search-result"].hidden === true);
  }

  {
    const form = fakeForm();
    mountGeocodeSearch(form, {
      getMap: () => null,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }),
      debounceMs: 5,
      minGapMs: 0,
    });
    await submitSearch(form, "Nowhere-village");
    const status = form.parts[".geocode-search-status"];
    record("no matches is an honest 'nothing found'",
      status.textContent.includes("No places found"), status.textContent);
    record("no matches marks the empty state", status.className.includes("is-empty"), status.className);
  }

  {
    const form = fakeForm();
    const picks = [];
    const pins = [];
    const map = {
      setSearchPin(point, label) { pins.push({ point, label }); return true; },
      clearSearchPin() { pins.length = 0; return true; },
      refreshSize() {},
    };
    mountGeocodeSearch(form, {
      getMap: () => map,
      onPick: (item) => picks.push(item),
      fetchImpl: async () => { throw new Error("offline"); },
      debounceMs: 5,
      minGapMs: 0,
    });
    await submitSearch(form, "Jijiga");
    record("an offline search still suggests an Ethiopian city",
      picks.length === 1 && picks[0].title === "Jijiga" && picks[0].source === "local",
      JSON.stringify(picks));
    record("the local hit pins the map at its real coordinate",
      pins.length === 1 && Math.abs(pins[0].point.latitude - 9.3508526) < 1e-6, JSON.stringify(pins));
    record("the picked local result is confirmed like any other",
      form.parts[".geocode-search-status"].textContent === "Location found",
      form.parts[".geocode-search-status"].textContent);
  }

  console.log("");
  console.log("--- map: search pin vs auto-fit ---");

  {
    const L = fakeLeaflet();
    globalThis.window.L = L;
    record("Leaflet is seen as available", mapAvailable() === true);

    const container = fakeEl("div");
    const map = new LiveDeliveryMap(container);
    record("init succeeds with Leaflet present", map.init() === true);

    map.setCustomer({ latitude: 9.0, longitude: 38.0 }, "Customer");
    const fitCalls = L.calls.fitBounds.length + L.calls.setView.length;

    record("search pin lands on the map",
      map.setSearchPin({ latitude: 8.98, longitude: 38.75 }, "Bole") === true);
    record("the camera centres on the searched point",
      L.calls.setView.length > 0 && L.calls.setView[L.calls.setView.length - 1].z >= 16,
      JSON.stringify(L.calls.setView[L.calls.setView.length - 1]));
    record("the search pin does not touch the customer marker",
      map.markers.customer && map.markers.customer.latLng[0] === 9.0,
      JSON.stringify(map.markers.customer && map.markers.customer.latLng));

    const afterSearch = L.calls.fitBounds.length + L.calls.setView.length;
    map.setCourier({ latitude: 9.01, longitude: 38.01 }, "You");
    record("live fixes do not yank the camera off a searched point",
      L.calls.fitBounds.length + L.calls.setView.length === afterSearch,
      "before=" + afterSearch + " after=" + (L.calls.fitBounds.length + L.calls.setView.length));

    record("clearing the pin hands the view back", map.clearSearchPin() === true);
    record("auto-fit runs again once cleared",
      L.calls.fitBounds.length > 0, String(L.calls.fitBounds.length));

    record("an unusable point is refused, not invented", map.setSearchPin({ latitude: null }) === false);

    map.destroy();
    record("destroy removes the map", map.map === null && L.calls.removed === 1, String(L.calls.removed));
    record("destroy leaves no search pin", map.markers.search === null);
  }

  console.log("");
  console.log("--- dashboard: card rebuild ---");

  destroyDashboardMaps();
  {
    const L = fakeLeaflet();
    globalThis.window.L = L;

    const containerA = fakeEl("div");
    const containerB = fakeEl("div");
    const formA = fakeForm();
    const formB = fakeForm();
    let pass1 = true;
    globalThis.document.querySelector = (sel) =>
      String(sel).indexOf("data-gps-map") >= 0 ? (pass1 ? containerA : containerB) : null;
    globalThis.document.getElementById = (id) =>
      id.indexOf("geocodeSearch-") === 0 ? (pass1 ? formA : formB) : null;

    const orders = [{
      orderId: "ET-1000TEST",
      status: "READY",
      customerLocation: { latitude: 9.0, longitude: 38.0 },
      deliveryInfo: { latitude: 9.0, longitude: 38.0 },
      pickupLocation: null,
    }];

    syncDashboardMaps(orders, () => null);
    record("the first pass builds one map", L.calls.map.length === 1, String(L.calls.map.length));
    record("the first pass mounts the search form", formA.dataset.geocodeMounted === "1");
    record("the search form is mounted on the card's own node",
      mountGeocodeSearch(formA, {}) === null);

    pass1 = false;
    syncDashboardMaps(orders, () => null);
    record("a rebuilt card gets a rebuilt map (not a detached one)",
      L.calls.map.length === 2, String(L.calls.map.length));
    record("the rebuilt map is attached to the node now in the DOM",
      L.calls.map[1] === containerB, String(L.calls.map[1] && L.calls.map[1].tagName));
    record("the new card's search form is mounted too", formB.dataset.geocodeMounted === "1");

    globalThis.document.querySelector = () => null;
    globalThis.document.getElementById = () => null;
    destroyDashboardMaps();
    // One map was thrown away when the card was rebuilt, one at teardown.
    record("teardown removes the remaining map", L.calls.removed === 2, String(L.calls.removed));
    record("no map survives the teardown",
      syncDashboardMaps([], () => null).size === 0);
  }

  console.log("");
  console.log("========== PLACE SEARCH TESTS ==========");
  console.log("PASS: " + pass + "  FAIL: " + fail + "  TOTAL: " + (pass + fail));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
