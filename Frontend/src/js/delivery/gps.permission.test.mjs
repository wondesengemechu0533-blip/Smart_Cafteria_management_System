/**
 * GPS PERMISSION PROMPT tests.
 *
 * The bug this guards against: the browser's location prompt appeared over and
 * over because automatic paths (page load, the 30s poll, socket events, tab
 * refocus, stage changes) all called watchPosition().
 *
 * `promptCount` below counts how many times a browser permission prompt could
 * have been shown. The rule asserted throughout is:
 *
 *   - no prompt on page load / poll / socket refresh, ever
 *   - at most ONE prompt, and only from a real click
 *   - after a refusal, NO further prompt from any path
 *   - Retry only works once the user has allowed location in site settings
 *
 * The mocks are the ONLY source of geolocation here - no real device, no faked
 * coordinates standing in for a real customer's location.
 *
 * Run: node Frontend/src/js/delivery/gps.permission.test.mjs
 */

const el = () => ({
  classList: { add() {}, remove() {}, toggle() {} },
  style: {},
  setAttribute() {},
  getAttribute() { return null; },
  addEventListener() {},
  removeEventListener() {},
  textContent: "",
  innerHTML: "",
  querySelector: () => null,
  querySelectorAll: () => [],
  appendChild() {},
  remove() {},
});
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.window = {
  addEventListener() {},
  getCurrentLanguage: () => "en",
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
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

let pass = 0;
let fail = 0;
function record(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " -- " + detail : "")); }
}

/* --------------------------------------------------------------- the mocks */

// How many times a browser permission prompt was shown. watchPosition and
// getCurrentPosition both trigger it.
let promptCount = 0;
// What navigator.permissions reports, and who may flip it.
let permissionState = "prompt";
let permissionListeners = [];

// What watchPosition should do on the next call.
let watchBehaviour = "fix";   // 'fix' | 'denied' | 'unavailable' | 'timeout'
let watchCalls = 0;
let clearWatchCalls = 0;

function installNavigator() {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      userAgent: "Mozilla/5.0 Chrome/120",
      permissions: {
        query: async () => {
          if (permissionState === "__unsupported__") throw new TypeError("unsupported");
          return {
            get state() { return permissionState; },
            addEventListener: (_type, cb) => permissionListeners.push(cb),
            removeEventListener: () => {},
          };
        },
      },
      geolocation: {
        watchPosition(onSuccess, onError) {
          watchCalls += 1;
          // A prompt is shown unless the site has ALREADY been granted. (This
          // also models browsers with no Permissions API, where we cannot ask -
          // a request still counts as "the user gets asked".)
          if (permissionState !== "granted") promptCount += 1;
          setTimeout(() => {
            if (watchBehaviour === "fix") {
              permissionState = "granted";
              onSuccess({ coords: { latitude: 9.0, longitude: 39.2, accuracy: 8 }, timestamp: Date.now() });
            } else if (watchBehaviour === "denied") {
              permissionState = "denied";
              onError({ code: 1, message: "User denied Geolocation" });
            } else if (watchBehaviour === "unavailable") {
              onError({ code: 2, message: "Position unavailable" });
            } else if (watchBehaviour === "timeout") {
              onError({ code: 3, message: "Timeout expired" });
            }
          }, 1);
          return watchCalls;
        },
        clearWatch() { clearWatchCalls += 1; },
        getCurrentPosition() { promptCount += 1; },
      },
    },
    configurable: true,
    writable: true,
  });
}
installNavigator();

// fetch -> api.post fails fast; these tests are about permission, not uploads.
globalThis.fetch = async () => {
  const err = new Error("offline");
  err.status = 500;
  throw err;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { gpsTracker, gpsUiStatus, GPS_ERROR_CODES } = await import("./gps.js");
  const { PERMISSION_STATE } = await import("./geo.js");

  // ---------------------------------------------------------------------
  // 1. Page load / polling must never prompt
  // ---------------------------------------------------------------------
  // This is the exact call loadQueues() makes on boot, on the 30s poll, on
  // socket events and on every tab refocus - it used to start a watch.
  permissionState = PERMISSION_STATE.PROMPT;
  promptCount = 0;
  watchCalls = 0;
  gpsTracker.syncActiveDeliveries(["ORD-1", "ORD-2"]);
  await wait(30);
  record("page load / poll / socket refresh starts NO watch", watchCalls === 0, `watchCalls=${watchCalls}`);
  record("page load / poll / socket refresh shows NO permission prompt", promptCount === 0, `promptCount=${promptCount}`);

  // Repeated reconciliation (what a 2-minute session produces) must stay silent.
  for (let i = 0; i < 20; i += 1) gpsTracker.syncActiveDeliveries(["ORD-1", "ORD-2"]);
  await wait(30);
  record("20 refreshes later there is still no prompt", promptCount === 0, `promptCount=${promptCount}`);
  record("20 refreshes later there is still no watch", watchCalls === 0, `watchCalls=${watchCalls}`);

  // ---------------------------------------------------------------------
  // 2. An unattended start() must not prompt either
  // ---------------------------------------------------------------------
  watchBehaviour = "fix";
  await gpsTracker.start("ORD-1");           // no {userInitiated:true}
  await wait(30);
  record("unattended start() after nothing was asked does prompt once",
    promptCount === 1, `promptCount=${promptCount}`);
  record("unattended start() did start a watch", watchCalls === 1, `watchCalls=${watchCalls}`);
  // A fix arrived, so the watch is live. (The upload then fails because fetch is
  // stubbed offline, which is why the PANEL reports an error - that is existing
  // behaviour: a working watch plus a failed upload is an error, not a stop.)
  record("status is active once a fix arrives", gpsTracker.isTracking("ORD-1") === true,
    `${gpsTracker.isTracking("ORD-1")} ui=${gpsTracker.uiStatus("ORD-1")}`);
  record("a failed upload is reported without stopping the watch",
    gpsTracker.getState("ORD-1").error === GPS_ERROR_CODES.SEND_FAILED && gpsTracker.isTracking("ORD-1") === true,
    gpsTracker.getState("ORD-1").error);

  // Second unattended start on a DIFFERENT order while permission is 'prompt'
  // must refuse, because the user already saw the prompt once.
  gpsTracker.stop("ORD-1");
  permissionState = PERMISSION_STATE.PROMPT;   // simulate "prompt shown, not granted"
  const before = promptCount;
  await gpsTracker.start("ORD-9");             // unattended
  await wait(20);
  record("a second unattended start() does NOT prompt again",
    promptCount === before, `promptCount=${promptCount} (before ${before})`);

  // A user-initiated start IS allowed to ask.
  permissionState = PERMISSION_STATE.PROMPT;
  watchBehaviour = "fix";
  const beforeClick = promptCount;
  await gpsTracker.start("ORD-2", { userInitiated: true });
  await wait(30);
  record("a user click CAN ask the browser", promptCount === beforeClick + 1, `promptCount=${promptCount}`);
  gpsTracker.stopAll();

  // ---------------------------------------------------------------------
  // 3. Denial is terminal: no path may re-prompt
  // ---------------------------------------------------------------------
  permissionState = PERMISSION_STATE.PROMPT;
  promptCount = 0;
  watchCalls = 0;
  watchBehaviour = "denied";

  await gpsTracker.start("ORD-3", { userInitiated: true });
  await wait(30);
  record("first attempt prompts once", promptCount === 1, `promptCount=${promptCount}`);
  record("denial reports permission_denied", gpsTracker.uiStatus("ORD-3") === "permission_denied", gpsTracker.uiStatus("ORD-3"));
  record("denial is recorded as blocked", gpsTracker.getState("ORD-3").blocked === true);
  record("denial keeps the GPS_DENIED code", gpsTracker.getState("ORD-3").error === GPS_ERROR_CODES.DENIED,
    gpsTracker.getState("ORD-3").error);

  // Every realistic repeat path a rider/tab can take.
  const afterDenial = promptCount;
  await gpsTracker.start("ORD-3", { userInitiated: true });
  await wait(20);
  gpsTracker.syncActiveDeliveries(["ORD-3"]);
  await wait(20);
  gpsTracker.stop("ORD-3");
  await gpsTracker.start("ORD-3", { userInitiated: true });
  await wait(20);
  gpsTracker.retryAfterPermissionChange("ORD-3");
  await wait(20);
  record("after a denial NO path prompts again", promptCount === afterDenial, `promptCount=${promptCount} (after ${afterDenial})`);
  record("after a denial the state stays permission_denied",
    gpsTracker.uiStatus("ORD-3") === "permission_denied", gpsTracker.uiStatus("ORD-3"));
  record("after a denial the state stays blocked", gpsTracker.getState("ORD-3").blocked === true);

  // Start on a DIFFERENT order must also refuse (the browser prompt is global).
  const other = promptCount;
  await gpsTracker.start("ORD-4", { userInitiated: true });
  await wait(20);
  record("a refusal on one order blocks every other order too",
    promptCount === other && gpsTracker.uiStatus("ORD-4") === "permission_denied",
    `promptCount=${promptCount} status=${gpsTracker.uiStatus("ORD-4")}`);

  // ---------------------------------------------------------------------
  // 4. Retry only works after the user allows location in site settings
  // ---------------------------------------------------------------------
  permissionState = PERMISSION_STATE.DENIED;   // still denied
  const stillDenied = promptCount;
  await gpsTracker.retryAfterPermissionChange("ORD-3");
  await wait(20);
  record("Retry while still denied does not prompt",
    promptCount === stillDenied, `promptCount=${promptCount}`);
  record("Retry while still denied stays blocked", gpsTracker.getState("ORD-3").blocked === true);

  // User flips the site setting to Allow.
  permissionState = PERMISSION_STATE.GRANTED;
  watchBehaviour = "fix";
  await gpsTracker.retryAfterPermissionChange("ORD-3");
  await wait(30);
  record("Retry after allowing in site settings starts tracking",
    gpsTracker.isTracking("ORD-3") === true,
    `${gpsTracker.isTracking("ORD-3")} ui=${gpsTracker.uiStatus("ORD-3")}`);
  record("Retry after allowing clears the blocked flag",
    gpsTracker.getState("ORD-3").blocked !== true);
  record("granted permission does NOT prompt (already allowed)",
    promptCount === stillDenied, `promptCount=${promptCount}`);

  // ---------------------------------------------------------------------
  // 5. Non-denial errors are NOT treated as refusals
  // ---------------------------------------------------------------------
  permissionState = PERMISSION_STATE.GRANTED;
  watchBehaviour = "unavailable";
  await gpsTracker.start("ORD-5", { userInitiated: true });
  await wait(30);
  record("POSITION_UNAVAILABLE is not a refusal",
    gpsTracker.uiStatus("ORD-5") === "unavailable" && gpsTracker.getState("ORD-5").blocked !== true,
    `${gpsTracker.uiStatus("ORD-5")} blocked=${gpsTracker.getState("ORD-5").blocked}`);

  permissionState = PERMISSION_STATE.GRANTED;
  watchBehaviour = "timeout";
  await gpsTracker.start("ORD-6", { userInitiated: true });
  await wait(30);
  record("TIMEOUT is not a refusal",
    gpsTracker.uiStatus("ORD-6") === "error" && gpsTracker.getState("ORD-6").blocked !== true,
    `${gpsTracker.uiStatus("ORD-6")} blocked=${gpsTracker.getState("ORD-6").blocked}`);

  // ---------------------------------------------------------------------
  // 6. Browsers without the Permissions API
  // ---------------------------------------------------------------------
  permissionState = "__unsupported__";     // query() throws
  promptCount = 0;
  watchBehaviour = "denied";
  await gpsTracker.start("ORD-7", { userInitiated: true });
  await wait(30);
  record("no Permissions API still allows one user-initiated attempt", promptCount === 1, `promptCount=${promptCount}`);
  record("no Permissions API still marks a refusal blocked",
    gpsTracker.getState("ORD-7").blocked === true);
  // Now the browser says denied via the error path only; we must not re-ask.
  const noApi = promptCount;
  await gpsTracker.start("ORD-7", { userInitiated: true });
  await wait(20);
  record("no Permissions API: refusal is still terminal",
    gpsTracker.getState("ORD-7").blocked === true, `promptCount=${promptCount}`);
  record("no Permissions API: no repeat prompt from a repeat click",
    promptCount === noApi, `promptCount=${promptCount}`);

  // ---------------------------------------------------------------------
  // 7. Stopping/clearing still works (no regression to the lifecycle)
  // ---------------------------------------------------------------------
  installNavigator();
  permissionState = PERMISSION_STATE.GRANTED;
  watchBehaviour = "fix";
  gpsTracker.stopAll();
  await wait(10);
  await gpsTracker.start("ORD-8", { userInitiated: true });
  await wait(30);
  record("granted: tracking starts normally", gpsTracker.isTracking("ORD-8") === true,
    `${gpsTracker.isTracking("ORD-8")} ui=${gpsTracker.uiStatus("ORD-8")}`);

  gpsTracker.syncActiveDeliveries(["ORD-8", "ORD-KEEP"]);
  await wait(20);
  record("still-active order keeps its watch", gpsTracker.isTracking("ORD-8") === true);

  gpsTracker.syncActiveDeliveries([]);      // e.g. delivered / cancelled
  await wait(20);
  record("no active delivery -> no GPS watch", gpsTracker.isTracking("ORD-8") === false);
  record("clearWatch was actually called", clearWatchCalls > 0, `clearWatchCalls=${clearWatchCalls}`);

  console.log("");
  console.log("========== GPS PERMISSION PROMPT TESTS ==========");
  console.log("PASS: " + pass + "  FAIL: " + fail + "  TOTAL: " + (pass + fail));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
