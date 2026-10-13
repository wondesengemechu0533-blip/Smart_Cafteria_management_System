/**
 * Frontend geo/tracking unit tests.
 *
 * Covers the math every tracking surface shares (delivery/geo.js):
 * Haversine distance, the proximity rule, formatting, and coordinate
 * normalization (including the (0,0) "unset" trap).
 *
 * The GPS error matrix is covered separately by gps.error.test.mjs, and the
 * happy-path real-device fix by Backend/gps-e2e-test.js.
 *
 * Run: node Frontend/src/js/delivery/geo.test.mjs
 */

const el = () => ({
  classList: { add() {}, remove() {}, toggle() {} },
  style: {},
  setAttribute() {},
  addEventListener() {},
  textContent: "",
  appendChild() {},
  querySelectorAll: () => [],
  querySelector: () => null,
  children: [],
  remove() {},
});
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.window = {
  addEventListener() {},
  getCurrentLanguage: () => "en",
  MutationObserver: globalThis.MutationObserver,
  isSecureContext: true,
};
globalThis.document = {
  addEventListener() {},
  getElementById: el,
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: el,
  documentElement: { classList: { add() {}, remove() {} } },
  body: el(),
};
globalThis.localStorage = { getItem: () => null, setItem() {} };

let pass = 0;
let fail = 0;
function record(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " -- " + detail : "")); }
}

async function main() {
  const geo = await import("./geo.js");
  const {
    normalizePoint,
    haversineMeters,
    haversineKm,
    formatDistance,
    formatAccuracy,
    formatRelativeTime,
    measureToCustomer,
    isNearCustomer,
    checkGeolocationSupport,
    NEAR_CUSTOMER_RADIUS_M,
  } = geo;

  record("proximity radius is 100 m", NEAR_CUSTOMER_RADIUS_M === 100, String(NEAR_CUSTOMER_RADIUS_M));

  // --- normalizePoint -------------------------------------------------------
  record("normalizePoint accepts a real fix", normalizePoint({ latitude: 9, longitude: 39 }).latitude === 9);
  record("normalizePoint reads timestamp as updatedAt",
    normalizePoint({ latitude: 9, longitude: 39, timestamp: "2026-01-01T00:00:00Z" }).updatedAt === "2026-01-01T00:00:00Z");
  // Number('') === 0, so an empty checkout field must NOT become a real point.
  record("normalizePoint rejects blank", normalizePoint({ latitude: "", longitude: "" }) === null);
  record("normalizePoint rejects (0,0)", normalizePoint({ latitude: 0, longitude: 0 }) === null);
  record("normalizePoint rejects out-of-range lat",
    normalizePoint({ latitude: 91, longitude: 39 }) === null);
  record("normalizePoint rejects out-of-range lng",
    normalizePoint({ latitude: 9, longitude: 181 }) === null);
  record("normalizePoint rejects null", normalizePoint(null) === null);

  // --- Haversine ------------------------------------------------------------
  // 0.01 degrees of latitude is ~1.111 km everywhere on the globe. A naive
  // lat/long subtraction would say "0.01" - that is exactly the bug this guards.
  const km = haversineKm({ latitude: 9, longitude: 39 }, { latitude: 9.01, longitude: 39 });
  record("0.01 deg latitude is ~1.11 km, not 0.01", Math.abs(km - 1.1119) < 0.01, String(km));
  const m = haversineMeters({ latitude: 9, longitude: 39 }, { latitude: 9.01, longitude: 39 });
  record("same distance in metres", Math.abs(m - 1111.9) < 5, String(m));
  record("distance is symmetric",
    Math.abs(haversineKm({ latitude: 9, longitude: 39 }, { latitude: 9.01, longitude: 39 })
      - haversineKm({ latitude: 9.01, longitude: 39 }, { latitude: 9, longitude: 39 })) < 1e-9);
  record("distance to self is 0",
    haversineMeters({ latitude: 9, longitude: 39 }, { latitude: 9, longitude: 39 }) === 0);
  record("missing endpoint -> null (never a guess)",
    haversineMeters({ latitude: 9, longitude: 39 }, null) === null);
  // Reference values against the mean Earth radius the app uses (R = 6371 km).
  // These pin the formula and the radius; a lat/long subtraction could never
  // produce any of them.
  const poles = haversineKm({ latitude: 90, longitude: 0 }, { latitude: -90, longitude: 0 });
  record("pole to pole is half the circumference (20015 km)",
    Math.abs(poles - 20015.09) < 1, String(poles));
  // Reference values against the mean Earth radius the app uses (R = 6371 km).
  // These pin the formula and the radius; a lat/long subtraction could never
  // produce any of them. Longitudes 20/21 are used instead of 0/1 because
  // normalizePoint deliberately treats (0, 0) as "no location shared".
  const oneDeg = haversineKm({ latitude: 0, longitude: 21 }, { latitude: 0, longitude: 20 });
  record("1 degree of arc at the equator is 111.19 km",
    Math.abs(oneDeg - 111.19) < 0.05, String(oneDeg));
  // Meridians converge: 1 degree of longitude is shorter at higher latitudes.
  const at30 = haversineKm({ latitude: 30, longitude: 21 }, { latitude: 30, longitude: 20 });
  const at60 = haversineKm({ latitude: 60, longitude: 21 }, { latitude: 60, longitude: 20 });
  record("longitude degrees shrink towards the poles",
    at30 < oneDeg && at60 < at30, `${oneDeg.toFixed(2)} > ${at30.toFixed(2)} > ${at60.toFixed(2)}`);

  // --- proximity ------------------------------------------------------------
  record("isNearCustomer true inside 100 m",
    isNearCustomer({ latitude: 9, longitude: 39.0005 }, { latitude: 9, longitude: 39 }) === true);
  record("isNearCustomer false outside 100 m",
    isNearCustomer({ latitude: 9, longitude: 39.005 }, { latitude: 9, longitude: 39 }) === false);
  record("isNearCustomer false when customer has no location",
    isNearCustomer({ latitude: 9, longitude: 39 }, null) === false);

  const near = measureToCustomer({ latitude: 9, longitude: 39.0005 }, { latitude: 9, longitude: 39 });
  record("measure near: 50 m", Math.abs(near.distanceMeters - 56) < 6, JSON.stringify(near));
  record("measure near: nearCustomer true", near.nearCustomer === true);
  record("measure near: hasCustomerLocation true", near.hasCustomerLocation === true);

  const far = measureToCustomer({ latitude: 9, longitude: 39.02 }, { latitude: 9, longitude: 39 });
  record("measure far: nearCustomer false", far.nearCustomer === false);

  const noLoc = measureToCustomer({ latitude: 9, longitude: 39 }, null);
  record("measure without customer location reports nulls (not 0)",
    noLoc.hasCustomerLocation === false && noLoc.distanceKm === null && noLoc.distanceMeters === null);
  const noFix = measureToCustomer(null, { latitude: 9, longitude: 39 });
  record("measure without a courier fix reports nulls",
    noFix.hasCustomerLocation === true && noFix.distanceKm === null && noFix.nearCustomer === false);

  // --- formatting -----------------------------------------------------------
  record("formatDistance metres under 1 km", formatDistance(0.82) === "820 m", String(formatDistance(0.82)));
  record("formatDistance one decimal under 10 km", formatDistance(2.4) === "2.4 km", String(formatDistance(2.4)));
  record("formatDistance whole km above 10", formatDistance(24.3) === "24 km", String(formatDistance(24.3)));
  record("formatDistance(null) is null (caller hides the row)", formatDistance(null) === null);
  record("formatDistance(0) is not hidden", formatDistance(0) === "1 m", String(formatDistance(0)));

  record("formatAccuracy metres", formatAccuracy(8) === "±8 m", String(formatAccuracy(8)));
  record("formatAccuracy kilometres", formatAccuracy(1500) === "±1.5 km", String(formatAccuracy(1500)));
  record("formatAccuracy(null) is null", formatAccuracy(null) === null);

  const now = Date.now();
  record("formatRelativeTime just now", formatRelativeTime(new Date(now - 2000), now) === "just now");
  record("formatRelativeTime seconds", formatRelativeTime(new Date(now - 12000), now) === "12s ago");
  record("formatRelativeTime minutes", formatRelativeTime(new Date(now - 180000), now) === "3m ago");
  record("formatRelativeTime(null) is null", formatRelativeTime(null, now) === null);
  record("formatRelativeTime(bad) is null", formatRelativeTime("not-a-date", now) === null);

  // --- geolocation support --------------------------------------------------
  record("geolocation unsupported without navigator.geolocation",
    checkGeolocationSupport().reason === "NOT_SUPPORTED");
  Object.defineProperty(globalThis, "navigator", {
    value: { geolocation: { watchPosition() { return 1; }, clearWatch() {} } },
    configurable: true,
    writable: true,
  });
  record("geolocation supported with navigator.geolocation", checkGeolocationSupport().supported === true);
  globalThis.window.isSecureContext = false;
  record("insecure context reported as INSECURE_CONTEXT",
    checkGeolocationSupport().reason === "INSECURE_CONTEXT");
  globalThis.window.isSecureContext = true;

  console.log("");
  console.log("========== FRONTEND GEO / TRACKING TESTS ==========");
  console.log("PASS: " + pass + "  FAIL: " + fail + "  TOTAL: " + (pass + fail));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
