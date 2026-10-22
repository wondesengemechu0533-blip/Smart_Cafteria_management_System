/**
 * Order Status Buckets - one definition of "which tab does this order belong to".
 *
 * WHY: the Order document carries TWO status fields in TWO different
 * vocabularies, and neither is a subset of the other:
 *
 *   status      (lowercase + two Title-Case outliers 'Received' / 'Completed')
 *   orderStatus (SCREAMING_SNAKE)
 *
 * The customer Order History tabs used to bucket orders with
 *
 *     order.status === "Completed"      // Title-Case
 *     order.status === "Pending"        // Title-Case
 *     order.status === "Cancelled"      // Title-Case
 *
 * while everything that writes the value writes it LOWERCASE ('completed',
 * 'pending', 'cancelled'). So the Completed / In Progress / Cancelled tabs each
 * matched almost nothing, and any status not named in the if-chain (e.g.
 * 'out_for_delivery') fell through to `return true` and appeared under EVERY
 * tab at once.
 *
 * Both sides now use this file, so the tab a customer sees and the query the
 * database runs cannot disagree.
 */

// Values that mean "still moving". Mirrors the delivered-is-not-terminal rule:
// a delivered order stays active until the courier closes the run out, which is
// what moves it to 'completed'.
const ACTIVE_STATUS_VALUES = [
  'pending',
  'received',
  'preparing',
  'ready',
  'ready_for_delivery',
  'picked_up',
  'out_for_delivery',
  'arrived',
  'delivered',
];

const COMPLETED_STATUS_VALUES = ['completed', 'served'];

const CANCELLED_STATUS_VALUES = ['cancelled', 'canceled'];

const FAILED_STATUS_VALUES = ['failed'];

const BUCKETS = ['active', 'completed', 'cancelled', 'failed'];

const VALUE_TO_BUCKET = new Map();
for (const [bucket, values] of [
  ['active', ACTIVE_STATUS_VALUES],
  ['completed', COMPLETED_STATUS_VALUES],
  ['cancelled', CANCELLED_STATUS_VALUES],
  ['failed', FAILED_STATUS_VALUES],
]) {
  for (const v of values) VALUE_TO_BUCKET.set(v, bucket);
}

/** Normalize any casing/spacing variant to its canonical lowercase form. */
function normalizeStatusValue(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * Which bucket does a single status VALUE fall into?
 * @returns {'active'|'completed'|'cancelled'|'failed'|null} null when unknown.
 */
function bucketForValue(value) {
  return VALUE_TO_BUCKET.get(normalizeStatusValue(value)) || null;
}

/**
 * Which bucket does an ORDER fall into?
 *
 * `status` is the UI-facing field and wins when it is a recognised value;
 * `orderStatus` is the fallback for legacy rows whose `status` is missing or
 * unknown. Terminal states are checked first so a row that somehow carries
 * both never lands in the active bucket.
 *
 * @returns {'active'|'completed'|'cancelled'|'failed'}
 */
function bucketForOrder(order) {
  if (!order) return 'active';

  const candidates = [
    order.status,
    order.orderStatus,
    order.deliveryStatus,
  ];

  let fallback = null;
  for (const candidate of candidates) {
    const bucket = bucketForValue(candidate);
    if (!bucket) continue;
    // Remember the first recognised value but let a terminal bucket win, so a
    // stale `status: 'pending'` next to `orderStatus: 'CANCELLED'` is cancelled.
    if (bucket === 'cancelled' || bucket === 'completed' || bucket === 'failed') return bucket;
    if (!fallback) fallback = bucket;
  }
  return fallback || 'active';
}

/** Was this order's money refunded (or is a refund in flight)? */
function isRefunded(order) {
  if (!order) return false;
  const payment = String(order.paymentStatus || '').toUpperCase();
  const refund = String(order.refundStatus || '').toUpperCase();
  return (
    payment === 'REFUNDED' ||
    refund === 'REFUNDED' ||
    refund === 'REFUND_REQUESTED' ||
    refund === 'REFUND_PROCESSING'
  );
}

/** Does this order belong in the given tab? */
function matchesBucket(order, bucket) {
  if (bucket === 'refunded') return isRefunded(order);
  return bucketForOrder(order) === bucket;
}

/**
 * Mongo `$or` fragment matching every REAL stored value for a bucket.
 *
 * Both fields are matched because the two vocabularies coexist in the
 * collection, and both casings are listed because the schema carries Title-Case
 * outliers ('Received', 'Completed') alongside the lowercase ones.
 */
function bucketQuery(bucket) {
  const byBucket = {
    active: ACTIVE_STATUS_VALUES,
    completed: COMPLETED_STATUS_VALUES,
    cancelled: CANCELLED_STATUS_VALUES,
    failed: FAILED_STATUS_VALUES,
  };

  const values = byBucket[bucket];
  if (!values) return null;

  // Flatten to the exact strings that can appear in either field.
  const stored = new Set();
  for (const v of values) {
    stored.add(v);
    stored.add(v.toUpperCase());
    // Title-case outlier, e.g. 'Received' / 'Completed'.
    stored.add(v.charAt(0).toUpperCase() + v.slice(1));
  }

  const list = Array.from(stored);
  return { $or: [{ status: { $in: list } }, { orderStatus: { $in: list } }] };
}

/** Count the customer's orders per tab. */
function countByBucket(orders) {
  const counts = { all: 0, active: 0, completed: 0, cancelled: 0, failed: 0, refunded: 0 };
  for (const order of orders || []) {
    counts.all += 1;
    counts[bucketForOrder(order)] += 1;
    if (isRefunded(order)) counts.refunded += 1;
  }
  return counts;
}

/**
 * Canonical status used by every report.
 *
 * The Order document stores the same lifecycle twice - `status` (lowercase,
 * kitchen flow) and `orderStatus` (SCREAMING_SNAKE, admin flow) - and the two
 * can disagree. Reports need ONE value per order, so the two fields are merged
 * here: the furthest step of the fulfilment flow wins, and a cancellation on
 * either side always wins.
 *
 * This used to be copy-pasted into three controllers/services, which is how
 * the report counts drifted apart. One definition, imported everywhere.
 */
const REPORT_STATUS_FLOW = ['PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED'];

/**
 * @param {object} order
 * @returns {string} one of PENDING / PREPARING / READY / SERVED / COMPLETED /
 *                   CANCELLED (or the raw stored value when it is unknown).
 */
function canonicalOrderStatus(order) {
  if (!order) return 'PENDING';
  const upper = String(order.orderStatus || '')
    .trim()
    .toUpperCase();
  const lower = String(order.status || '')
    .trim()
    .toUpperCase();

  if (upper === 'CANCELLED' || lower === 'CANCELLED') return 'CANCELLED';

  const upperIndex = REPORT_STATUS_FLOW.indexOf(upper);
  const lowerIndex = REPORT_STATUS_FLOW.indexOf(lower);

  if (upperIndex === -1 && lowerIndex === -1) return upper || lower || 'PENDING';
  if (upperIndex === -1) return lower;
  if (lowerIndex === -1) return upper;
  return upperIndex >= lowerIndex ? upper : lower;
}

module.exports = {
  ACTIVE_STATUS_VALUES,
  COMPLETED_STATUS_VALUES,
  CANCELLED_STATUS_VALUES,
  FAILED_STATUS_VALUES,
  BUCKETS,
  REPORT_STATUS_FLOW,
  normalizeStatusValue,
  bucketForValue,
  bucketForOrder,
  canonicalOrderStatus,
  isRefunded,
  matchesBucket,
  bucketQuery,
  countByBucket,
};
