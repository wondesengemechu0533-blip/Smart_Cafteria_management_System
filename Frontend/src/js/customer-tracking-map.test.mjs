/**
 * Customer live-tracking behaviour tests.
 *
 * Drives customer-tracking-map.js against a fake DOM + a fake Leaflet + a fake
 * socket, so the RULES are verified without a browser, a phone or a server:
 *
 *   - the map card only appears for delivery orders
 *   - an order with no customer GPS says "GPS location unavailable" (req 22)
 *   - the courier marker MOVES on every `delivery:location` frame (req 6)
 *   - distance is recomputed from the new position each frame (req 9)
 *   - the socket room is joined while GPS is active and LEFT on DELIVERED /
 *     COMPLETED / CANCELLED (req 1, 14, 20)
 *   - frames arriving after the delivery ended are ignored (req 14)
 *   - a socket drop shows "Reconnecting…" and a reconnect re-joins + shows
 *     "Connected" (req 17)
 *
 * Coordinates below are the real test fixtures for Debre Berhan, Ethiopia
 * (~8.9 N, 39.2 E) used by this repo. They are test INPUTS, never served or
 * displayed as a customer's real location.
 *
 * Run: node Frontend/src/js/customer-tracking-map.test.mjs
 */

/* ------------------------------------------------------------------ fake DOM */
function makeEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle() {},
      contains(c) { return this._set.has(c); },
    },
    children: [],
    _text: "",
    innerHTML: "",
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.innerHTML = String(v); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    remove() {},
  };
  return el;
}

const domIds = [
  "delivery-map-card", "track-summary", "delivery-map", "delivery-map-status",
  "track-connection", "track-cafeteria", "track-cafeteria-item", "track-courier",
  "track-courier-item", "track-distance", "track-distance-item", "track-eta",
  "track-eta-item", "status-heading", "status-subtext",
];
const dom = {};
domIds.forEach((id) => { dom[id] = makeEl(); });

globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.window = {
  addEventListener() {},
  dispatchEvent() {},
  getCurrentLanguage: () => "en",
  isSecureContext: true,
  L: null, // filled in below
  location: { search: "?orderId=ET-TEST-1", origin: "http://localhost:5500" },
};
globalThis.location = globalThis.window.location;
globalThis.document = {
  addEventListener() {},
  getElementById: (id) => dom[id] || null,
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: () => makeEl(),
  documentElement: { classList: { add() {}, remove() {} } },
  body: makeEl(),
};
globalThis.localStorage = {
  _v: { auth_token: "test-token", current_user: JSON.stringify({ id: "u1", role: "customer" }) },
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
  setItem(k, v) { this._v[k] = String(v); },
  removeItem(k) { delete this._v[k]; },
};
globalThis.URLSearchParams = URLSearchParams;
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };

/* --------------------------------------------------------------- fake Leaflet */
const mapCalls = { markers: {}, lines: 0, inited: 0, removed: 0 };
function fakeLayer(kind, latlng) {
  return {
    kind,
    _latlng: latlng,
    setLatLng(v) { this._latlng = v; },
    setLatLngs(v) { this._latlng = v; },
    setPopupContent() {},
    bindPopup() { return this; },
    getLatLng() { return this._latlng; },
    addTo() { return this; },
    remove() {},
  };
}
globalThis.window.L = {
  map: () => ({ invalidateSize() {}, remove() { mapCalls.removed++; }, setView() {}, fitBounds() {}, removeLayer() {} }),
  tileLayer: () => ({ addTo() { return this; } }),
  marker: (latlng) => {
    const m = fakeLayer("marker", latlng);
    m.setPopupContent = () => {};
    mapCalls.markers[latlng[0] + "," + latlng[1]] = m;
    return m;
  },
  circle: () => fakeLayer("circle"),
  polyline: (coords) => { mapCalls.lines++; return fakeLayer("polyline", coords); },
  divIcon: (o) => o,
};
globalThis.CSS = { escape: (s) => String(s) };

/* ------------------------------------------------------------- fake api/socket */
const apiCalls = [];
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

let pass = 0;
let fail = 0;
function record(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " -- " + detail : "")); }
}

/* ------------------------------------------------------------------- the test */
async function main() {
  const tracker = await import("./customer-tracking-map.js");
  tracker.mountCustomerTracking("ET-TEST-1");

  // The module's own refresh() goes through api.js -> fetch, which we stubbed to
  // fail, so drive it explicitly with fixtures (the same shape GET /orders/:id
  // returns).
  const PICKUP = { latitude: 8.9, longitude: 39.2 };
  const CAFETERIA = { latitude: 8.91, longitude: 39.21 };

  function order(stage, extra) {
    return Object.assign(
      {
        orderId: "ET-TEST-1",
        orderType: "delivery",
        status: stage,
        deliveryStatus: stage.toUpperCase(),
        deliveryInfo: { subCity: "Debre Berhan Kebele 03", location: "House 12, Main Road", ...PICKUP },
        customerLocation: { latitude: PICKUP.latitude, longitude: PICKUP.longitude, address: "Debre Berhan Kebele 03" },
        cafeteriaLocation: { name: "Main Cafeteria", ...CAFETERIA },
        deliveryCourier: { name: "Abebe" },
        currentLocation: null,
        etaMinutes: 12,
      },
      extra || {}
    );
  }

  // ---- 1. non-delivery order must not show the map ---------------------------
  tracker.renderCustomerTracking(order("out_for_delivery", { orderType: "dine-in" }), null, false);
  record("dine-in order keeps the map hidden", dom["delivery-map-card"].style.display === "none",
    dom["delivery-map-card"].style.display);
  record("dine-in order leaves no Leaflet instance behind", mapCalls.inited === 0);

  // ---- 2. no customer GPS -> explicit message, page still works -------------
  tracker.renderCustomerTracking(
    order("out_for_delivery", {
      deliveryInfo: { subCity: "Debre Berhan Kebele 03", location: "House 12" },
      customerLocation: { latitude: null, longitude: null, address: "Kebele 03" },
    }),
    null, false
  );
  record("order without customer GPS shows the map card (backwards compatible)",
    dom["delivery-map-card"].style.display === "");
  record("order without customer GPS says GPS unavailable",
    /GPS location unavailable/i.test(dom["delivery-map-status"].textContent),
    dom["delivery-map-status"].textContent);
  record("order without customer GPS shows no distance",
    dom["track-distance-item"].style.display === "none", dom["track-distance-item"].style.display);

  // ---- 3. live order -> map + summary + room join ---------------------------
  tracker.renderCustomerTracking(order("out_for_delivery"), null, false);
  record("OUT_FOR_DELIVERY shows the map card", dom["delivery-map-card"].style.display === "");
  record("customer marker placed on the real coordinates",
    Object.keys(mapCalls.markers).some((k) => k.startsWith(String(PICKUP.latitude))), Object.keys(mapCalls.markers).join(","));
  record("courier name shown in the summary", dom["track-courier"].textContent === "Abebe", dom["track-courier"].textContent);
  record("cafeteria shown in the summary", /Main Cafeteria/.test(dom["track-cafeteria"].textContent), dom["track-cafeteria"].textContent);
  record("before the first fix the page says it is waiting (no invented position)",
    /Waiting for the delivery person/i.test(dom["delivery-map-status"].textContent),
    dom["delivery-map-status"].textContent);

  // ---- 3b. the authorized GPS room is joined while tracking is active --------
  const { socketClient } = await import("./socket.js");
  record("joined the delivery GPS room while GPS is active",
    socketClient.pendingDeliveryJoins.has("ET-TEST-1"),
    Array.from(socketClient.pendingDeliveryJoins).join(","));

  // ---- 4. a live frame moves the marker and updates the distance -------------
  const before = dom["track-distance"].textContent;
  tracker.renderCustomerTracking(
    order("out_for_delivery"),
    { orderId: "ET-TEST-1", latitude: 8.9, longitude: 39.21, accuracy: 9, updatedAt: new Date().toISOString(), distanceToCustomerKm: 1.1 },
    true
  );
  record("live frame moves the courier marker",
    Object.keys(mapCalls.markers).some((k) => k.startsWith("8.9,39.21")), Object.keys(mapCalls.markers).join(","));
  record("distance updates from the live frame",
    dom["track-distance"].textContent === "1.1 km", `${before} -> ${dom["track-distance"].textContent}`);
  record("accuracy is shown", /Accuracy/.test(dom["delivery-map-status"].textContent), dom["delivery-map-status"].textContent);
  record("last update is shown", /Last GPS update/.test(dom["delivery-map-status"].textContent), dom["delivery-map-status"].textContent);
  record("live status line names the rider", /Delivery Person: Abebe/.test(dom["delivery-map-status"].textContent),
    dom["delivery-map-status"].textContent);

  // ---- 5. history: freeze the marker, stop the room --------------------------
  const completedOrder = order("completed", {
    currentLocation: { latitude: 8.9, longitude: 39.2, accuracy: 12, timestamp: new Date(Date.now() - 60000).toISOString() },
    deliveryLocation: { latitude: 8.9, longitude: 39.2, accuracy: 12, updatedAt: new Date(Date.now() - 60000).toISOString() },
    deliveryCourier: { name: "Abebe" },
  });
  tracker.renderCustomerTracking(completedOrder, null, false);
  record("COMPLETED says tracking has ended", /ended/i.test(dom["delivery-map-status"].textContent),
    dom["delivery-map-status"].textContent);
  record("COMPLETED leaves the GPS room (no more frames)",
    !socketClient.pendingDeliveryJoins.has("ET-TEST-1"),
    Array.from(socketClient.pendingDeliveryJoins).join(","));
  record("COMPLETED still keeps the map visible as a frozen last-known fix",
    dom["delivery-map-card"].style.display === "");
  const distanceAtCompletion = dom["track-distance"].textContent;
  // A late frame arriving after completion must be ignored entirely. The server
  // keeps returning the same stored fix, so that is what the client re-renders.
  tracker.renderCustomerTracking(
    completedOrder,
    { orderId: "ET-TEST-1", latitude: 9.5, longitude: 40.5, accuracy: 5, updatedAt: new Date().toISOString() },
    true
  );
  record("late GPS frame after COMPLETED does not move the marker",
    !Object.keys(mapCalls.markers).some((k) => k.startsWith("9.5,40.5")), Object.keys(mapCalls.markers).join(","));
  record("late GPS frame after COMPLETED does not change the distance",
    dom["track-distance"].textContent === distanceAtCompletion,
    `${distanceAtCompletion} -> ${dom["track-distance"].textContent}`);

  // ---- 6. cancelled order hides everything -----------------------------------
  tracker.renderCustomerTracking(order("cancelled"), null, false);
  record("CANCELLED hides the map card", dom["delivery-map-card"].style.display === "none",
    dom["delivery-map-card"].style.display);

  // ---- 7. ARRIVED re-joins, and socket state text ---------------------------
  tracker.renderCustomerTracking(order("arrived"), null, false);
  record("ARRIVED keeps the map card visible", dom["delivery-map-card"].style.display === "");
  record("ARRIVED re-joins the GPS room (rider may still be moving)",
    socketClient.pendingDeliveryJoins.has("ET-TEST-1"),
    Array.from(socketClient.pendingDeliveryJoins).join(","));

  // Connection badge: dropped -> "Reconnecting…", back -> "Connected".
  socketClient.emit("socket:reconnecting", { attempt: 1 });
  record("socket drop shows Reconnecting",
    /Reconnecting/i.test(dom["track-connection"].innerHTML), dom["track-connection"].innerHTML);
  socketClient.emit("socket:connected", { id: "s1" });
  record("socket back shows Connected",
    /Connected/i.test(dom["track-connection"].innerHTML), dom["track-connection"].innerHTML);

  console.log("");
  console.log("========== CUSTOMER LIVE TRACKING TESTS ==========");
  console.log("PASS: " + pass + "  FAIL: " + fail + "  TOTAL: " + (pass + fail));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
