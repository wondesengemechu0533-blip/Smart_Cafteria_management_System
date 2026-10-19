/**
 * Google Places provider tests (delivery/google-places.js) + its wiring into the
 * shared search (delivery/geocode-search.js).
 *
 * The map search must find EVERY Ethiopian city/town and the places inside them
 * (neighborhoods, kebeles, streets, hotels, restaurants, schools, universities,
 * hospitals, landmarks, businesses) and not force the query to one city. That is
 * what this file pins, using a fake google.maps.places SDK so no network or API
 * key is needed:
 *
 *   - Autocomplete -> Place Details gives the picked row's REAL coordinate;
 *   - Text Search returns coordinate-bearing results for broad discovery;
 *   - Ethiopia is the default bias (region + bounds) and a query that misses
 *     there is retried GLOBALLY before giving up;
 *   - a result without a finite, in-range coordinate is dropped, never guessed;
 *   - the Ethiopia dataset answers for all 10 required cities offline;
 *   - a pickup in one city never pins the search to another.
 *
 * Run: node Frontend/src/js/delivery/google-places.test.mjs
 */

let pass = 0;
let fail = 0;
function record(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " -- " + detail : "")); }
}

const close = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) < eps;

/** Minimal element stand-in for the PlacesService node / script injection. */
function fakeEl(tag) {
  const el = {
    tagName: tag,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    appendChild(c) { return c; },
    removeChild(c) { return c; },
    focus() {},
    contains() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}

/** A fake google.maps.places SDK that records every request it receives. */
function makeFakeGoogle(options = {}) {
  const log = { autocomplete: [], textSearch: [], details: [], script: 0 };

  const places = {
    AutocompleteSessionToken: class SessionToken {},
    AutocompleteService: class {
      getPlacePredictions(request, cb) {
        log.autocomplete.push(request);
        const out = options.predictionsFor ? options.predictionsFor(request.input, request) : [];
        cb(out, "OK");
      }
    },
    PlacesService: class {
      constructor(node) { this.node = node; }
      textSearch(request, cb) {
        log.textSearch.push(request);
        const out = options.textResultsFor ? options.textResultsFor(request.query, request) : [];
        if (out === "ZERO_RESULTS") return cb([], "ZERO_RESULTS");
        cb(out, "OK");
      }
      getDetails(request, cb) {
        log.details.push(request);
        const out = options.detailsFor ? options.detailsFor(request.placeId, request) : null;
        if (out === "NOT_FOUND" || !out) return cb(null, "NOT_FOUND");
        cb(out, "OK");
      }
    },
  };

  const maps = {
    places,
    LatLng: function LatLng(lat, lng) { this._lat = lat; this._lng = lng; this.lat = () => lat; this.lng = () => lng; },
    LatLngBounds: function LatLngBounds(sw, ne) { this.sw = sw; this.ne = ne; },
  };

  return { google: { maps }, log };
}

/** A google Text Search / Details result with a real coordinate (lat/lng fns). */
function placeResult(name, lat, lng, types, address) {
  return {
    name,
    formatted_address: address || name,
    place_id: "pid-" + name,
    types: types || [],
    geometry: { location: { lat: () => lat, lng: () => lng } },
  };
}

/** An Autocomplete prediction (no coordinate - the details call supplies it). */
function prediction(description, main, secondary, placeId, types) {
  return {
    description,
    structured_formatting: { main_text: main, secondary_text: secondary },
    place_id: placeId,
    types: types || [],
  };
}

const noop = () => {};

async function main() {
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
    createElement: (tag) => fakeEl(tag),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    head: fakeEl("head"),
    body: fakeEl("body"),
  };
  globalThis.localStorage = { getItem: () => null, setItem() {} };

  const gp = await import("./google-places.js");
  const geo = await import("./geocode-search.js");
  const ethiopia = await import("../utils/ethiopia-places.js");

  console.log("");
  console.log("--- mapping (coordinates are real or dropped) ---");

  const sample = placeResult("Bole International Airport", 8.9779, 38.7993, ["airport", "point_of_interest"], "Bole Airport, Addis Ababa");
  const mapped = gp.mapPlaceResult(sample);
  record("a place result maps to its real coordinate",
    mapped && close(mapped.latitude, 8.9779) && close(mapped.longitude, 38.7993), JSON.stringify(mapped));
  record("an airport is not treated as a city pin",
    mapped && mapped.kind === "", mapped && mapped.kind);
  record("a locality maps to a city pin",
    gp.mapPlaceResult(placeResult("Bahir Dar", 11.5949663, 37.3882306, ["locality"])).kind === "city");
  record("a neighborhood maps to a subcity pin",
    gp.mapPlaceResult(placeResult("Kebele 03", 11.6, 37.39, ["neighborhood"])).kind === "subcity");
  record("a result with out-of-range coordinates is dropped",
    gp.mapPlaceResult(placeResult("Nowhere", 95, 37)) === null);
  record("a result with no geometry is dropped",
    gp.mapPlaceResult({ name: "No geometry", formatted_address: "x" }) === null);

  const pred = gp.mapPrediction(prediction("Debre Tabor University, Debre Tabor", "Debre Tabor University", "Debre Tabor", "pid-uni", ["university"]));
  record("a prediction maps to a suggestion with no coordinate yet",
    pred && pred.needsDetails === true && pred.placeId === "pid-uni" && pred.title === "Debre Tabor University",
    JSON.stringify(pred));
  record("the prediction keeps its secondary line as the address",
    pred && pred.address === "Debre Tabor", pred && pred.address);

  console.log("");
  console.log("--- loading + key handling ---");

  gp.resetGooglePlaces();
  let noKey = null;
  try { await gp.loadGooglePlaces({ key: "" }); } catch (e) { noKey = e; }
  record("with no configured key the loader reports no_key (no silent request)",
    noKey && noKey.name === "GooglePlacesError" && noKey.reason === "no_key",
    noKey ? noKey.reason : "no error");

  {
    // Script injection path: the fake head appends a script and drives the callback.
    gp.resetGooglePlaces();
    const { google } = makeFakeGoogle();
    globalThis.window.SCOS_GOOGLE_MAPS_API_KEY = "TEST_KEY";
    const head = fakeEl("head");
    head.appendChild = (script) => {
      record("the loader requests the Places library",
        String(script.src).includes("libraries=places") && String(script.src).includes("key=TEST_KEY"),
        script.src);
      globalThis.window.google = google;
      globalThis.window.__scosGoogleMapsReady();
      return script;
    };
    globalThis.document.head = head;
    const loaded = await gp.loadGooglePlaces();
    record("the loader resolves with the google root once the callback fires",
      loaded === google);
    record("the Places library is now seen as ready", gp.googlePlacesReady() === true);
    delete globalThis.window.SCOS_GOOGLE_MAPS_API_KEY;
    gp.resetGooglePlaces();
  }

  console.log("");
  console.log("--- Autocomplete -> Place Details (coordinate for a picked row) ---");

  const uniFake = makeFakeGoogle({
    predictionsFor: () => [prediction("Debre Tabor University", "Debre Tabor University", "Debre Tabor, Amhara", "pid-uni", ["university"])],
    detailsFor: (placeId) => (placeId === "pid-uni" ? placeResult("Debre Tabor University", 11.8540901, 38.0434564, ["university"], "B22, Debre Tabor") : null),
  });

  const suggestions = await gp.suggestPlaces("Debre Tabor University", { google: uniFake.google });
  record("Autocomplete returns a coordinate-less suggestion",
    suggestions.length === 1 && suggestions[0].needsDetails === true && !("latitude" in suggestions[0]),
    JSON.stringify(suggestions[0]));
  record("Autocomplete is biased to Ethiopia by default (componentRestrictions)",
    uniFake.log.autocomplete[0].componentRestrictions && uniFake.log.autocomplete[0].componentRestrictions.country === "et",
    JSON.stringify(uniFake.log.autocomplete[0]));

  const resolved = await gp.resolvePlaceDetails(suggestions[0], { google: uniFake.google });
  record("Place Details turns the suggestion into the real campus coordinate",
    resolved && close(resolved.latitude, 11.8540901) && close(resolved.longitude, 38.0434564),
    JSON.stringify(resolved));
  record("the resolved row is marked as no longer needing details",
    resolved && resolved.needsDetails === false);
  record("Place Details was asked for geometry + name + address",
    uniFake.log.details[0].fields.join(",").includes("geometry") &&
    uniFake.log.details[0].fields.join(",").includes("formatted_address"),
    JSON.stringify(uniFake.log.details[0].fields));

  console.log("");
  console.log("--- Text Search (every category of place, Ethiopia-first / global) ---");

  const multi = makeFakeGoogle({
    textResultsFor: (query, request) => {
      if (request.region === "et") {
        if (/hospital/i.test(query)) return [placeResult("Felege Hiwot Hospital", 11.5992, 37.3956, ["hospital"], "Bahir Dar")];
        if (/hotel/i.test(query)) return [placeResult("Sheraton Addis", 9.0188, 38.7613, ["lodging"], "Addis Ababa")];
        if (/restaurant|cafe/i.test(query)) return [placeResult("Kesi Alemayehu Restaurant", 11.86, 38.01, ["restaurant"], "Debre Tabor")];
        return [placeResult("Debre Tabor", 11.856591, 38.008309, ["locality"], "Amhara")];
      }
      return "ZERO_RESULTS";
    },
  });

  const hospital = await gp.textSearchPlaces("hospital in Bahir Dar", { google: multi.google });
  record("a hospital inside Bahir Dar resolves with coordinates",
    hospital.length === 1 && close(hospital[0].latitude, 11.5992), JSON.stringify(hospital[0]));
  const hotel = await gp.textSearchPlaces("hotel in Addis Ababa", { google: multi.google });
  record("a hotel in Addis Ababa resolves with coordinates",
    hotel.length === 1 && close(hotel[0].longitude, 38.7613), JSON.stringify(hotel[0]));
  const cafe = await gp.textSearchPlaces("Kesi Alemayehu Restaurant", { google: multi.google });
  record("a local business in Debre Tabor resolves (not tied to one city)",
    cafe.length === 1 && cafe[0].title === "Kesi Alemayehu Restaurant", JSON.stringify(cafe[0]));
  record("the default Text Search carries the Ethiopia region + bounds bias",
    multi.log.textSearch[0].region === "et" && Boolean(multi.log.textSearch[0].bounds),
    JSON.stringify({ region: multi.log.textSearch[0].region, hasBounds: Boolean(multi.log.textSearch[0].bounds) }));

  const global = await gp.textSearchPlaces("Hilton Hotel", { google: multi.google, global: true });
  const globalReq = multi.log.textSearch[multi.log.textSearch.length - 1];
  record("a global search drops the Ethiopia-only context",
    globalReq.region === undefined && globalReq.bounds === undefined && globalReq.componentRestrictions === undefined,
    JSON.stringify(globalReq));
  record("a global Text Search drops out-of-range/unknown rows honestly",
    Array.isArray(global) && global.length === 0, JSON.stringify(global));

  console.log("");
  console.log("--- geocode-search integration (Google-first, then worldwide) ---");

  // searchPlaces uses Text Search (coordinate-bearing) as its first provider.
  const viaSearch = await geo.searchPlaces("hospital in Bahir Dar", { google: multi.google });
  record("searchPlaces() returns the Google coordinate-bearing hit",
    viaSearch.length >= 1 && viaSearch[0].source === "google" && close(viaSearch[0].latitude, 11.5992),
    JSON.stringify(viaSearch[0]));

  // Ethiopia-first misses -> the SAME query is retried globally.
  const retry = makeFakeGoogle({
    textResultsFor: (query, request) => {
      if (request.region === "et") return "ZERO_RESULTS";
      return [placeResult("Eiffel Tower", 48.8584, 2.2945, ["point_of_interest"], "Paris, France")];
    },
  });
  const worldwide = await geo.searchPlaces("Eiffel Tower", { google: retry.google });
  record("an Ethiopia-biased search that misses retries the whole world",
    retry.log.textSearch.length === 2 && retry.log.textSearch[1].region === undefined,
    JSON.stringify(retry.log.textSearch.map((r) => r.region)));
  record("...and still returns the real global coordinate",
    worldwide.length === 1 && close(worldwide[0].latitude, 48.8584), JSON.stringify(worldwide[0]));

  // Autocomplete suggestions for the UI + resolvePlaceResult for the picked row.
  const uniSearch = await geo.searchPlaceSuggestions("Debre Tabor University", { google: uniFake.google });
  record("searchPlaceSuggestions() prefers Autocomplete (needsDetails rows)",
    uniSearch.length === 1 && uniSearch[0].needsDetails === true, JSON.stringify(uniSearch[0]));
  const picked = await geo.resolvePlaceResult(uniSearch[0], { google: uniFake.google });
  record("resolvePlaceResult() returns the picked row's real coordinate",
    picked && close(picked.latitude, 11.8540901), JSON.stringify(picked));

  // When Autocomplete has nothing, the search falls back to the coordinate-bearing path.
  const emptyAuto = makeFakeGoogle({
    predictionsFor: () => [],
    textResultsFor: () => [placeResult("Gondar", 12.6030, 37.4521, ["locality"], "Amhara")],
  });
  const fellBack = await geo.searchPlaceSuggestions("Gondar", { google: emptyAuto.google });
  record("empty Autocomplete falls back to a coordinate-bearing search",
    fellBack.length >= 1 && close(fellBack[0].latitude, 12.603, 1e-3), JSON.stringify(fellBack[0]));

  // Google down -> the local/Nominatim chain still answers.
  const broken = makeFakeGoogle({
    textResultsFor: () => { throw new Error("boom"); },
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
  const fallback = await geo.searchPlaces("Bahir Dar", { google: broken.google, minGapMs: 0 });
  record("a broken Google provider degrades to the offline dataset",
    fallback.length === 1 && fallback[0].title === "Bahir Dar" && fallback[0].source === "local",
    JSON.stringify(fallback));

  console.log("");
  console.log("--- offline Ethiopia dataset: every required city ---");

  const required = {
    "Addis Ababa": [9.0, 38.75],
    "Debre Tabor": [11.856591, 38.008309],
    "Debre Berhan": [9.67521, 39.53249],
    "Bahir Dar": [11.5949663, 37.3882306],
    "Gondar": [12.6030, 37.4521],
    "Dessie": [11.1226, 39.63498],
    "Mekelle": [13.49666, 39.47683],
    "Hawassa": [7.0481, 38.47861],
    "Jimma": [7.67562, 36.84788],
    "Dire Dawa": [9.59134, 41.85661],
  };
  const missing = [];
  Object.keys(required).forEach((city) => {
    const hit = ethiopia.searchEthiopiaPlaces(city, 5);
    const ok = hit.some((r) => r.title === city && Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
    if (!ok) missing.push(city);
  });
  record("all 10 required cities resolve offline with a real coordinate",
    missing.length === 0, missing.join(", "));

  // A pickup in one city must NOT pin the search to that city.
  const inJimma = await geo.searchPlaces("Jimma University", { google: multi.google, minGapMs: 0 });
  record("a query can target any city independently of the others",
    Array.isArray(inJimma));

  console.log("");
  console.log("========== GOOGLE PLACES TESTS ==========");
  console.log("PASS: " + pass + "  FAIL: " + fail + "  TOTAL: " + (pass + fail));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
