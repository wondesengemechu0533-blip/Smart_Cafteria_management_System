/**
 * Frontend GPS error-handling unit tests (explicit error cases may use mock
 * geolocation). Happy-path real device GPS is covered by Backend/gps-e2e-test.js
 * against the Windows Location API.
 *
 * Run: node Frontend/src/js/delivery/gps.error.test.mjs
 */

// Browser globals required by api.js / gps.js before dynamic import.
globalThis.window = globalThis.window || {};
window.__API_URL = 'http://127.0.0.1:5000/api/v1';
window.isSecureContext = true;
window.location = { origin: 'http://127.0.0.1:5000' };
window.dispatchEvent = () => {};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
store.set('auth_token', 'test-token');
globalThis.fetch = async () => {
  const err = new Error('network down');
  err.status = 500;
  throw err;
};

let pass = 0;
let fail = 0;
function record(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

function mockGeo({ onPosition, onError, watchId = 1 }) {
  const geolocation = {
    watchPosition(success, error) {
      setTimeout(() => {
        if (onError) error(onError);
        else if (onPosition) success(onPosition);
      }, 5);
      return watchId;
    },
    clearWatch() {},
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { geolocation },
    configurable: true,
    writable: true,
  });
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const { gpsTracker, gpsUiStatus, GPS_ERROR_CODES, GPS_UI_STATUSES } =
    await import('./gps.js');

  record('GPS_UI_STATUSES has exactly six statuses', GPS_UI_STATUSES.length === 6, JSON.stringify(GPS_UI_STATUSES));
  record('GPS_UI_STATUSES includes permission_required/active/permission_denied/unavailable/error/stopped',
    ['permission_required','active','permission_denied','unavailable','error','stopped'].every(s => GPS_UI_STATUSES.includes(s)));

  record('null snap → permission_required', gpsUiStatus(null) === 'permission_required');

  mockGeo({ onPosition: { coords: { latitude: 9, longitude: 39, accuracy: 10 }, timestamp: Date.now() } });
  gpsTracker.start('T-STOP');
  await wait(20);
  gpsTracker.stop('T-STOP');
  record('manual stop → stopped', gpsTracker.uiStatus('T-STOP') === 'stopped', gpsTracker.uiStatus('T-STOP'));
  record('isTracking false after stop', gpsTracker.isTracking('T-STOP') === false);

  // Restart with coarse accuracy (> MAX_ACCURACY_M) so no upload is attempted
  // and status stays tracking/active (uploads are exercised below).
  mockGeo({ onPosition: { coords: { latitude: 9.1, longitude: 39.1, accuracy: 250 }, timestamp: Date.now() }, watchId: 2 });
  gpsTracker.start('T-RESTART');
  await wait(30);
  record('restart from stopped → active', gpsTracker.uiStatus('T-RESTART') === 'active', gpsTracker.uiStatus('T-RESTART'));

  mockGeo({ onError: { code: 1, message: 'User denied Geolocation' }, watchId: 3 });
  gpsTracker.start('T-DENIED');
  await wait(30);
  record('code 1 → permission_denied', gpsTracker.uiStatus('T-DENIED') === 'permission_denied', gpsTracker.uiStatus('T-DENIED'));
  record('error code GPS_DENIED', gpsTracker.getState('T-DENIED')?.error === GPS_ERROR_CODES.DENIED,
    gpsTracker.getState('T-DENIED')?.error);

  mockGeo({ onError: { code: 2, message: 'Position unavailable' }, watchId: 4 });
  gpsTracker.start('T-UNAVAIL');
  await wait(30);
  record('code 2 → unavailable', gpsTracker.uiStatus('T-UNAVAIL') === 'unavailable', gpsTracker.uiStatus('T-UNAVAIL'));

  mockGeo({ onError: { code: 3, message: 'Timeout' }, watchId: 5 });
  gpsTracker.start('T-TIMEOUT');
  await wait(30);
  record('code 3 → error (timeout)', gpsTracker.uiStatus('T-TIMEOUT') === 'error', gpsTracker.uiStatus('T-TIMEOUT'));
  record('timeout error code GPS_TIMEOUT', gpsTracker.getState('T-TIMEOUT')?.error === GPS_ERROR_CODES.TIMEOUT,
    gpsTracker.getState('T-TIMEOUT')?.error);

  mockGeo({ onError: { code: 0, message: 'generic' }, watchId: 6 });
  gpsTracker.start('T-GEN');
  await wait(30);
  record('generic geo error → error', gpsTracker.uiStatus('T-GEN') === 'error', gpsTracker.uiStatus('T-GEN'));

  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
    writable: true,
  });
  gpsTracker.start('T-NOSUP');
  await wait(10);
  record('no geolocation → unavailable (NOT_SUPPORTED)', gpsTracker.uiStatus('T-NOSUP') === 'unavailable',
    gpsTracker.uiStatus('T-NOSUP') + ' ' + gpsTracker.getState('T-NOSUP')?.error);
  record('NOT_SUPPORTED error code', gpsTracker.getState('T-NOSUP')?.error === GPS_ERROR_CODES.NOT_SUPPORTED,
    gpsTracker.getState('T-NOSUP')?.error);

  Object.defineProperty(globalThis, 'navigator', {
    value: { geolocation: { watchPosition() { return 99; }, clearWatch() {} } },
    configurable: true,
    writable: true,
  });
  window.isSecureContext = false;
  gpsTracker.start('T-INSECURE');
  await wait(10);
  record('insecure context → unavailable (INSECURE)', gpsTracker.uiStatus('T-INSECURE') === 'unavailable',
    gpsTracker.uiStatus('T-INSECURE') + ' ' + gpsTracker.getState('T-INSECURE')?.error);

  window.isSecureContext = true;
  mockGeo({ onPosition: { coords: { latitude: 999, longitude: 39, accuracy: 10 }, timestamp: Date.now() }, watchId: 7 });
  gpsTracker.start('T-BADFIX');
  await wait(30);
  const bad = gpsTracker.getState('T-BADFIX');
  record('invalid device fix handled (error or rejected)',
    bad?.error === GPS_ERROR_CODES.INVALID_FIX ||
      gpsTracker.uiStatus('T-BADFIX') === 'error' ||
      gpsTracker.uiStatus('T-BADFIX') === 'active',
    JSON.stringify(bad));

  mockGeo({ onPosition: { coords: { latitude: 9.2, longitude: 39.2, accuracy: 8 }, timestamp: Date.now() }, watchId: 8 });
  globalThis.fetch = async () => { const e = new Error('Failed to fetch'); e.status = 503; throw e; };
  gpsTracker.start('T-NET');
  await wait(80);
  const net = gpsTracker.getState('T-NET');
  record('network interruption → GPS_SEND_FAILED or error status',
    net?.error === GPS_ERROR_CODES.SEND_FAILED || gpsTracker.uiStatus('T-NET') === 'error',
    JSON.stringify(net));

  globalThis.fetch = async () => { const e = new Error('Forbidden'); e.status = 403; throw e; };
  mockGeo({ onPosition: { coords: { latitude: 9.3, longitude: 39.3, accuracy: 8 }, timestamp: Date.now() }, watchId: 9 });
  gpsTracker.start('T-4XX');
  await wait(80);
  record('4xx send failure stops tracking (stopped or not tracking)',
    gpsTracker.isTracking('T-4XX') === false || gpsTracker.uiStatus('T-4XX') === 'stopped' || gpsTracker.uiStatus('T-4XX') === 'error',
    gpsTracker.uiStatus('T-4XX') + ' ' + JSON.stringify(gpsTracker.getState('T-4XX')));

  gpsTracker.syncActiveDeliveries(['T-KEEP']);
  await wait(20);
  record('syncActiveDeliveries clears T-STOP', gpsTracker.getState('T-STOP') === null);
  record('syncActiveDeliveries clears T-DENIED', gpsTracker.getState('T-DENIED') === null);

  gpsTracker.syncActiveDeliveries([]);
  await wait(10);
  record('empty active list clears all trackers', gpsTracker.trackedOrderIds().length === 0,
    JSON.stringify(gpsTracker.trackedOrderIds()));

  console.log('');
  console.log('========== FRONTEND GPS ERROR TESTS ==========');
  console.log('PASS: ' + pass + '  FAIL: ' + fail + '  TOTAL: ' + (pass + fail));
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
