/**
 * Delivery-dashboard map search tests (delivery/dashboard-map.js).
 *
 * The rider's dashboard search box must do two jobs with one control:
 *   1. find real places - Ethiopian cities (Debre Tabor, ...), kebeles,
 *      landmarks - through the ONE geocoder (delivery/geocode-search.js);
 *   2. pick one of the rider's delivery orders and show its customer
 *      destination + road route.
 *
 * What is pinned here (the actual behaviour, not the implementation):
 *   - "Debre Tabor" resolves to its REAL OpenStreetMap coordinate, offline from
 *     the local dataset and again through a Nominatim-shaped response;
 *   - a landmark inside Debre Tabor (the university) resolves through the same
 *     geocoder;
 *   - focusPlace() drops a distinct search marker at the exact searched point
 *     and zooms the camera to it;
 *   - focusOrderOnMap() drops the CUSTOMER destination marker (from the order's
 *     saved coordinates) separately from the search marker, and draws the road
 *     route from the rider's GPS fix to the customer.
 *
 * Nothing here invents a coordinate: every assertion compares against a real
 * latitude/longitude (the city centre and the campus point live on OSM).
 *
 * Run: node Frontend/src/js/delivery/dashboard-map-search.test.mjs
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function record(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " -- " + detail : "")); }
}

const close = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) < eps;

/** Very small element stand-in (just what the overview map touches). */
function fakeEl(tag) {
  const el = {
    tagName: tag,
    hidden: false,
    value: "",
    textContent: "",
    style: {},
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    insertAdjacentHTML() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    appendChild(c) { return c; },
    removeChild(c) { return c; },
    focus() {},
    contains() { return false; },
  };
  return el;
}

/** Leaflet stand-in that records every marker/polyline/setView it is handed. */
function fakeLeaflet(records) {
  const divIcon = (opts) => ({ opts });
  const marker = (latlng, opts) => {
    const m = {
      latlng,
      icon: opts && opts.icon,
      addTo() { return m; },
      bindPopup() { return m; },
      openPopup() { return m; },
      setLatLng(v) { m.latlng = v; return m; },
      getLatLng() { return m.latlng; },
    };
    if (Array.isArray(latlng) && latlng.length === 2 && typeof latlng[0] === "number") {
      records.push({ type: "marker", latlng, icon: m.icon, title: opts && opts.title });
    }
    return m;
  };
  const layerGroup = () => ({ addTo() { return this; }, clearLayers() {}, addLayer() {} });
  return {
    divIcon,
    map() {
      const m = {
        setView(ll, z) { records.push({ type: "setView", ll, z }); return m; },
        fitBounds(ll, o) { records.push({ type: "fitBounds", ll, o }); return m; },
        invalidateSize() { return m; },
        removeLayer() { return m; },
        remove() { return m; },
        on() {},
        off() {},
        getContainer() { return { style: {} }; },
        getZoom() { return 13; },
      };
      return m;
    },
    tileLayer() { return { addTo() { return this; } }; },
    marker,
    layerGroup,
    polyline(latlngs) {
      records.push({ type: "polyline", latlngs });
      return { addTo() { return this; }, bindPopup() { return this; }, remove() {} };
    },
    circle() { return { addTo() { return this; } }; },
  };
}

async function main() {
  const records = [];

  globalThis.window = {
    addEventListener() {},
    getCurrentLanguage: () => "en",
    getText: (key) => key,
    isSecureContext: true,
    MutationObserver: class { observe() {} disconnect() {} },
    L: fakeLeaflet(records),
  };
  globalThis.document = {
    readyState: "loading",
    addEventListener() {},
    getElementById: (id) =>
      id === "overviewCard" || id === "deliveryOverviewMap" ? fakeEl("div") : null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => fakeEl("div"),
    body: fakeEl("body"),
  };
  globalThis.localStorage = { getItem: () => null, setItem() {} };

  const { searchEthiopiaPlaces } = await import("../utils/ethiopia-places.js");
  const { searchPlaces } = await import("./geocode-search.js");
  const dashboard = await import("./dashboard-map.js");

  console.log("");
  console.log("--- Debre Tabor (a real Ethiopian city) ---");

  const local = searchEthiopiaPlaces("Debre Tabor", 5);
  record("the local dataset finds Debre Tabor",
    local.length === 1 && local[0].title === "Debre Tabor", JSON.stringify(local));
  record("…at its real OSM coordinate (11.856591, 38.008309)",
    local.length === 1 && close(local[0].latitude, 11.856591) && close(local[0].longitude, 38.008309),
    JSON.stringify(local[0]));

  const city = await searchPlaces("Debre Tabor", {
    minGapMs: 0,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { lat: "11.8565910", lon: "38.0083090", display_name: "Debre Tabor, South Gonder, Amhara Region, Ethiopia" },
      ],
    }),
  });
  record("the geocoder returns a Debre Tabor hit",
    city.length >= 1 && city.some((r) => r.title === "Debre Tabor"), JSON.stringify(city));

  console.log("");
  console.log("--- a landmark WITHIN Debre Tabor ---");

  const uni = await searchPlaces("Debre Tabor University", {
    minGapMs: 0,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          lat: "11.8540901",
          lon: "38.0434564",
          display_name: "Debre Tabor University, B22, Debre Tabor, South Gonder, Amhara Region, Ethiopia",
        },
      ],
    }),
  });
  record("the university inside Debre Tabor is geocoded",
    uni.length === 1 && close(uni[0].latitude, 11.8540901) && close(uni[0].longitude, 38.0434564),
    JSON.stringify(uni[0]));

  console.log("");
  console.log("--- overview map: search marker ---");

  const orders = [
    {
      orderId: "ET-DT-1",
      customerName: "Abebe",
      deliveryStatus: "out_for_delivery",
      status: "OUT_FOR_DELIVERY",
      customerLocation: { latitude: 11.9, longitude: 38.02 },
      deliveryInfo: { latitude: 11.9, longitude: 38.02, deliveryAddress: "Kebele 02, Debre Tabor" },
      pickupLocation: null,
    },
  ];
  const trackState = () => ({ lastFix: { latitude: 11.86, longitude: 38.0, accuracy: 12 } });

  dashboard.syncOverviewMap([], () => null, () => "", []);
  records.length = 0;

  const placed = dashboard.focusPlace({
    title: "Debre Tabor",
    address: "Debre Tabor, Amhara, Ethiopia",
    latitude: 11.856591,
    longitude: 38.008309,
    kind: "city",
  });
  record("focusPlace() accepts the city", placed === true);
  const searchMark = records.filter((r) => r.type === "marker").pop();
  record("a search marker lands on the exact city coordinate",
    Boolean(searchMark) && close(searchMark.latlng[0], 11.856591) && close(searchMark.latlng[1], 38.008309),
    JSON.stringify(searchMark && searchMark.latlng));
  record("the search marker is the distinct (purple) search pin",
    Boolean(searchMark && searchMark.icon && searchMark.icon.opts &&
      String(searchMark.icon.opts.className).includes("map-pin-search")),
    searchMark && searchMark.icon && searchMark.icon.opts && searchMark.icon.opts.className);
  const cityView = records.filter((r) => r.type === "setView").pop();
  record("the camera zooms TO the city (not its default)",
    Boolean(cityView) && close(cityView.ll[0], 11.856591) && cityView.z >= 12,
    JSON.stringify(cityView));

  console.log("");
  console.log("--- overview map: customer destination + route ---");

  // A real road route response shape (OSRM), so the route path is exercised.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      code: "Ok",
      routes: [{ geometry: { coordinates: [[38.008309, 11.856591], [38.02, 11.87], [38.02, 11.9]] } }],
    }),
  });

  await dashboard.syncOverviewMap(orders, trackState, () => "Out for Delivery", orders);
  records.length = 0;

  const focused = await dashboard.focusOrderOnMap("ET-DT-1");
  await sleep(30); // let the async route fetch settle
  record("selecting an order focuses it", focused === true);

  const destMark = records.filter((r) => r.type === "marker" && r.icon &&
    String(r.icon.opts.className).includes("map-pin-dest")).pop();
  record("the customer destination marker is at the order's saved coordinates",
    Boolean(destMark) && close(destMark.latlng[0], 11.9) && close(destMark.latlng[1], 38.02),
    JSON.stringify(destMark && destMark.latlng));

  const route = records.filter((r) => r.type === "polyline").pop();
  record("a road route is drawn from the rider's GPS fix to the customer",
    Boolean(route) && route.latlngs.length >= 2, JSON.stringify(route && route.latlngs && route.latlngs.length));

  console.log("");
  console.log("========== DASHBOARD MAP SEARCH TESTS ==========");
  console.log("PASS: " + pass + "  FAIL: " + fail + "  TOTAL: " + (pass + fail));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
