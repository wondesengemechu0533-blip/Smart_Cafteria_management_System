/**
 * i18n parity check for the live-tracking UI strings.
 *
 * Every new GPS/tracking key must exist in BOTH the `en` and the `am` block, so
 * a rider or customer never sees a raw key on the Amharic UI.
 *
 * Run: node Backend/tests/delivery-tracking-i18n.smoke.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'Frontend', 'src', 'js', 'utils', 'i18n.js');
const src = fs.readFileSync(SRC, 'utf8');

const enStart = src.indexOf('\n  en: {');
const amStart = src.indexOf('\n  am: {');
const amEnd = src.indexOf('const directTextMap');

if (enStart < 0 || amStart < 0 || amEnd < 0) {
  console.error('Could not locate the en/am blocks in i18n.js');
  process.exit(1);
}

const enBlock = src.slice(enStart, amStart);
const amBlock = src.slice(amStart, amEnd);

const KEYS = [
  // Summary strip / status line on the customer tracker
  'track_from', 'track_courier', 'track_distance', 'track_eta', 'track_accuracy',
  'track_connected', 'track_reconnecting', 'track_offline', 'track_offline_detail',
  'track_on_the_way', 'track_driver_arrived',
  'track_delayed_title', 'track_delayed_message',
  // Map copy (pre-existing keys reused by the new map)
  'map_live_delivery', 'map_last_update', 'map_no_location_yet', 'map_waiting_location',
  'map_location_unavailable', 'map_cafeteria', 'map_destination', 'map_courier',
  'map_tracking_ended', 'map_last_known', 'map_unavailable_offline', 'map_no_customer_gps',
  // Place search box above the manager monitor + the rider GPS panel
  'map_search_label', 'map_search_placeholder', 'map_search_button', 'map_search_searching',
  'map_search_none', 'map_search_error', 'map_search_rate_limited', 'map_search_picked',
  'map_search_copy', 'map_search_copied', 'map_search_copy_failed', 'map_search_clear',
  // Courier GPS panel
  'gps_metric_lat', 'gps_metric_lng', 'gps_metric_acc', 'gps_metric_updated',
  'gps_metric_distance', 'gps_near_customer',
  'gps_detail_denied', 'gps_detail_not_supported', 'gps_detail_insecure',
  'gps_detail_unavailable', 'gps_detail_timeout', 'gps_detail_send_failed',
  // Manager monitor
  'track_monitor_title', 'track_live', 'track_courier_location', 'track_customer_location',
  // Permission-refusal recovery copy (a rider/customer must never see a raw key)
  'gps_detail_blocked', 'gps_blocked_title', 'gps_blocked_body', 'gps_blocked_hint',
  'gps_blocked_fallback', 'gps_retry',
  'location_using', 'location_blocked', 'location_blocked_steps',
  'location_unavailable', 'location_timeout', 'location_locating', 'location_retry',
  // Checkout (must survive - requirement: keep the existing address + GPS opt-in)
  'checkout_use_my_location', 'checkout_clear_location', 'checkout_location_hint',
];

let fail = 0;
KEYS.forEach((key) => {
  const re = new RegExp('^\\s{4}' + key + ':', 'm');
  const inEn = re.test(enBlock);
  const inAm = re.test(amBlock);
  const ok = inEn && inAm;
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${key}${inEn ? '' : '  (missing en)'}${inAm ? '' : '  (missing am)'}`);
});

console.log('');
console.log(`PASS: ${KEYS.length - fail}  FAIL: ${fail}`);
process.exit(fail ? 1 : 0);
