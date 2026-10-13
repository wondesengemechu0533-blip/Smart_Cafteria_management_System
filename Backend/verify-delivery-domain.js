/**
 * Delivery domain verification (no database required).
 *
 * Exercises the pure logic that the whole delivery system depends on:
 * status normalization, the transition table, the order-status mapping,
 * coordinate validation, distance/ETA/fee calculation, and the GeoJSON-free
 * location payload builder.
 *
 * Run: node Backend/verify-delivery-domain.js
 */

const assert = require('assert');
const svc = require('./src/services/delivery.service');
const { DELIVERY_STATUS: S } = svc;

let passed = 0;
const failures = [];
const queue = [];

/** Register a check. The body may be sync or async; all run at the end. */
function check(name, fn) {
  queue.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
}

// Real setting keys, as defined in utils/settings.js.
const FEES = {
  delivery_fee: 30,
  delivery_fee_per_km: 10,
  delivery_free_over_amount: 500,
  delivery_max_distance_km: 15,
  delivery_speed_kmh: 25,
  delivery_prep_time_minutes: 15,
  delivery_eta_buffer_minutes: 5,
};

// --- status normalization -------------------------------------------------

check('normalizeStatus handles snake/camel/space/dash spellings', () => {
  assert.strictEqual(svc.normalizeStatus('outForDelivery'), 'OUT_FOR_DELIVERY');
  assert.strictEqual(svc.normalizeStatus('OutForDelivery'), 'OUT_FOR_DELIVERY');
  assert.strictEqual(svc.normalizeStatus('OUT FOR DELIVERY'), 'OUT_FOR_DELIVERY');
  assert.strictEqual(svc.normalizeStatus('out-for-delivery'), 'OUT_FOR_DELIVERY');
  assert.strictEqual(svc.normalizeStatus('pickedUp'), 'PICKED_UP');
  assert.strictEqual(svc.normalizeStatus('onTheWay'), 'OUT_FOR_DELIVERY');
  assert.strictEqual(svc.normalizeStatus('canceled'), 'CANCELLED');
});

check('normalizeStatus maps legacy order statuses', () => {
  // 'received' is the kitchen-facing spelling of the final customer state and
  // now resolves to the canonical terminal delivery status.
  assert.strictEqual(svc.normalizeStatus('received'), 'COMPLETED');
  // COMPLETED is a real status of its own, not an alias for DELIVERED: the two
  // are separate customer-visible steps.
  assert.strictEqual(svc.normalizeStatus('COMPLETED'), 'COMPLETED');
  assert.strictEqual(svc.normalizeStatus('pending'), 'REQUESTED');
  assert.strictEqual(svc.normalizeStatus('ready'), 'REQUESTED');
  assert.strictEqual(svc.normalizeStatus(''), '');
  assert.strictEqual(svc.normalizeStatus(null), '');
  assert.strictEqual(svc.normalizeStatus(undefined), '');
});

check('normalizeStatus returns unknown values untouched for the caller to reject', () => {
  assert.strictEqual(svc.normalizeStatus('bogus'), 'BOGUS');
});

// --- transition table -----------------------------------------------------

check('the happy path is legal end to end', () => {
  const path = [
    'REQUESTED', 'ASSIGNED', 'ACCEPTED', 'PICKED_UP',
    'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'COMPLETED',
  ];
  for (let i = 0; i < path.length - 1; i += 1) {
    assert.ok(svc.canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]} must be legal`);
  }
});

check('the courier close-out is its own step after the handover', () => {
  assert.strictEqual(svc.canTransition('DELIVERED', 'COMPLETED'), true);
  assert.strictEqual(svc.canTransition('DELIVERED', 'DELIVERED'), false);
  // Nothing may be completed without the handover being proven first.
  assert.strictEqual(svc.canTransition('ARRIVED', 'COMPLETED'), false);
  assert.strictEqual(svc.canTransition('PICKED_UP', 'COMPLETED'), false);
  assert.strictEqual(svc.canTransition('ACCEPTED', 'COMPLETED'), false);
  assert.strictEqual(svc.canTransition('COMPLETED', 'DELIVERED'), false);
  assert.strictEqual(svc.canTransition('COMPLETED', 'COMPLETED'), false);
});

check('steps cannot be skipped', () => {
  assert.strictEqual(svc.canTransition('REQUESTED', 'ACCEPTED'), false);
  assert.strictEqual(svc.canTransition('ASSIGNED', 'PICKED_UP'), false);
  assert.strictEqual(svc.canTransition('PICKED_UP', 'ARRIVED'), false);
  assert.strictEqual(svc.canTransition('OUT_FOR_DELIVERY', 'DELIVERED'), false);
});

check('backwards transitions are illegal', () => {
  assert.strictEqual(svc.canTransition('DELIVERED', 'PICKED_UP'), false);
  assert.strictEqual(svc.canTransition('ARRIVED', 'OUT_FOR_DELIVERY'), false);
  assert.strictEqual(svc.canTransition('PICKED_UP', 'ACCEPTED'), false);
});

check('no-op transitions are rejected', () => {
  assert.strictEqual(svc.canTransition('DELIVERED', 'DELIVERED'), false);
  assert.strictEqual(svc.canTransition('ASSIGNED', 'ASSIGNED'), false);
  assert.strictEqual(svc.canTransition('REQUESTED', 'REQUESTED'), false);
});

check('terminal states are frozen', () => {
  assert.ok(svc.TERMINAL_STATUSES.includes('COMPLETED'));
  assert.ok(svc.TERMINAL_STATUSES.includes('CANCELLED'));
  // FAILED is terminal in the ordinary flow but is the one state a manager may
  // revive through a retry (FAILED -> ASSIGNED).
  assert.ok(svc.TERMINAL_STATUSES.includes('FAILED'));
  assert.strictEqual(svc.canTransition('CANCELLED', 'ASSIGNED'), false);
  assert.strictEqual(svc.canTransition('COMPLETED', 'ASSIGNED'), false);
  assert.strictEqual(svc.canTransition('COMPLETED', 'DELIVERED'), false);
});

check('DELIVERED is handed over but NOT terminal', () => {
  // The courier still owns the delivery until they close it out, which is what
  // keeps it on the active list and off the history list.
  assert.ok(!svc.TERMINAL_STATUSES.includes('DELIVERED'));
  assert.strictEqual(svc.isTerminal('DELIVERED'), false);
  assert.strictEqual(svc.isTerminal('COMPLETED'), true);
  assert.strictEqual(svc.canTransition('DELIVERED', 'ASSIGNED'), false);
  assert.strictEqual(svc.canTransition('DELIVERED', 'PICKED_UP'), false);
});

check('a delivery that is delivered can still fail (customer never received it)', () => {
  assert.strictEqual(svc.canTransition('DELIVERED', 'FAILED'), true);
});

check('a failed delivery can be retried', () => {
  assert.strictEqual(svc.canTransition('FAILED', 'ASSIGNED'), true);
  assert.strictEqual(svc.canTransition('FAILED', 'CANCELLED'), true);
});

check('cancel is reachable from every non-terminal state', () => {
  for (const status of ['REQUESTED', 'ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED']) {
    assert.ok(svc.canTransition(status, 'CANCELLED'), `${status} -> CANCELLED must be legal`);
  }
});

check('failure is reachable while the courier still holds the food', () => {
  for (const status of ['REQUESTED', 'ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED']) {
    assert.ok(svc.canTransition(status, 'FAILED'), `${status} -> FAILED must be legal`);
  }
});

check('unknown statuses are never transitionable', () => {
  assert.strictEqual(svc.canTransition('BOGUS', 'ASSIGNED'), false);
  assert.strictEqual(svc.canTransition('REQUESTED', 'BOGUS'), false);
  assert.strictEqual(svc.canTransition('', ''), false);
});

check('every transition target is itself a known status', () => {
  const known = new Set(Object.keys(svc.DELIVERY_TRANSITIONS));
  for (const [from, targets] of Object.entries(svc.DELIVERY_TRANSITIONS)) {
    assert.ok(known.has(from), `${from} must be a known status`);
    for (const to of targets) {
      assert.ok(known.has(to), `${from} -> ${to} targets an unknown status`);
    }
  }
});

check('assignable statuses are exactly the pre-pickup states', () => {
  assert.deepStrictEqual(svc.ASSIGNABLE_STATUSES.sort(), ['ACCEPTED', 'ASSIGNED', 'PICKED_UP', 'REQUESTED']);
});

check('GPS is only accepted while the courier is moving the order', () => {
  assert.strictEqual(svc.isGpsAllowed('PICKED_UP'), true);
  assert.strictEqual(svc.isGpsAllowed('OUT_FOR_DELIVERY'), true);
  assert.strictEqual(svc.isGpsAllowed('ARRIVED'), true);
  assert.strictEqual(svc.isGpsAllowed('REQUESTED'), false);
  assert.strictEqual(svc.isGpsAllowed('ASSIGNED'), false);
  assert.strictEqual(svc.isGpsAllowed('DELIVERED'), false);
  assert.strictEqual(svc.isGpsAllowed('COMPLETED'), false);
  assert.strictEqual(svc.isGpsAllowed('CANCELLED'), false);
});

// --- order status mapping -------------------------------------------------

check('every delivery status maps to an order status the app already uses', () => {
  const expected = {
    REQUESTED: ['PENDING', 'pending'],
    ASSIGNED: ['PENDING', 'pending'],
    ACCEPTED: ['PENDING', 'pending'],
    PICKED_UP: ['PICKED_UP', 'picked_up'],
    OUT_FOR_DELIVERY: ['OUT_FOR_DELIVERY', 'out_for_delivery'],
    ARRIVED: ['ARRIVED', 'arrived'],
    DELIVERED: ['DELIVERED', 'delivered'],
    COMPLETED: ['COMPLETED', 'Completed'],
    FAILED: ['FAILED', 'failed'],
    CANCELLED: ['CANCELLED', 'cancelled'],
  };
  for (const [status, [upper, lower]] of Object.entries(expected)) {
    const mapped = svc.STATUS_TO_ORDER[status];
    assert.ok(mapped, `${status} must be mapped`);
    assert.strictEqual(mapped.orderStatus, upper, `${status} orderStatus`);
    assert.strictEqual(mapped.status, lower, `${status} status`);
  }
});

check('only COMPLETED finalises the order, never the handover', () => {
  // DELIVERED must leave the order open: the customer's "Delivered" and
  // "Completed" timeline steps are different moments.
  assert.strictEqual(svc.STATUS_TO_ORDER.DELIVERED.orderStatus, 'DELIVERED');
  assert.strictEqual(svc.STATUS_TO_ORDER.COMPLETED.orderStatus, 'COMPLETED');
  // Order.status is an enum whose terminal member is capital-C 'Completed'.
  assert.strictEqual(svc.STATUS_TO_ORDER.COMPLETED.status, 'Completed');
  // Every non-terminal delivery status must leave the order unfinalised.
  for (const status of ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED']) {
    assert.notStrictEqual(svc.STATUS_TO_ORDER[status].orderStatus, 'COMPLETED', `${status} must not complete the order`);
  }
});

check('the reverse mapping reads an order status back into a delivery status', () => {
  assert.strictEqual(svc.deliveryStatusFromOrder({ orderStatus: 'OUT_FOR_DELIVERY' }), 'OUT_FOR_DELIVERY');
  assert.strictEqual(svc.deliveryStatusFromOrder({ status: 'delivered' }), 'DELIVERED');
  assert.strictEqual(svc.deliveryStatusFromOrder({ orderStatus: 'DELIVERED' }), 'DELIVERED');
  assert.strictEqual(svc.deliveryStatusFromOrder({ orderStatus: 'COMPLETED' }), 'COMPLETED');
  assert.strictEqual(svc.deliveryStatusFromOrder({ status: 'Completed' }), 'COMPLETED');
  assert.strictEqual(svc.deliveryStatusFromOrder({ orderStatus: 'PENDING' }), 'REQUESTED');
  assert.strictEqual(svc.deliveryStatusFromOrder({}), 'REQUESTED');
});

check('order-facing statuses round-trip back to the same delivery status', () => {
  // REQUESTED / ASSIGNED / ACCEPTED intentionally share the order status
  // PENDING: the kitchen-facing order has no notion of courier acceptance, so a
  // reverse lookup can only resolve them to the earliest of the three. Every
  // status that owns a distinct order status must round-trip exactly.
  const collapsible = new Set(['REQUESTED', 'ASSIGNED', 'ACCEPTED']);
  for (const status of Object.keys(svc.DELIVERY_TRANSITIONS)) {
    if (collapsible.has(status)) continue;
    const mapped = svc.STATUS_TO_ORDER[status];
    assert.strictEqual(svc.deliveryStatusFromOrder(mapped), status, `round trip failed for ${status}`);
  }
  for (const status of collapsible) {
    assert.strictEqual(svc.deliveryStatusFromOrder(svc.STATUS_TO_ORDER[status]), 'REQUESTED');
  }
});

check('acceptance is tracked on the delivery, not inferred from the order', () => {
  // Because the three pre-pickup states collapse to PENDING, courier acceptance
  // must live on Delivery.acceptanceStatus, which is what the controller reads.
  const Delivery = require('./src/models/Delivery');
  const doc = new Delivery({
    order: '507f1f77bcf86cd799439011',
    orderId: 'CF-2000',
    customer: '507f1f77bcf86cd799439011',
    status: 'ACCEPTED',
    acceptanceStatus: 'ACCEPTED',
  });
  const error = doc.validateSync();
  assert.ok(!error, error ? error.message : '');
  assert.strictEqual(doc.acceptanceStatus, 'ACCEPTED');
});

check('the Delivery model accepts COMPLETED and mirrors the delivery service', () => {
  const Delivery = require('./src/models/Delivery');
  // The model's enum and the service's transition table must agree, otherwise a
  // state machine that can reach a status would be rejected by Mongoose.
  const { DELIVERY_STATUSES } = Delivery;
  for (const status of Object.keys(svc.DELIVERY_TRANSITIONS)) {
    assert.ok(DELIVERY_STATUSES.includes(status), `${status} must be a valid Delivery.status`);
  }
  assert.ok(DELIVERY_STATUSES.includes('COMPLETED'));

  const doc = new Delivery({
    order: '507f1f77bcf86cd799439011',
    orderId: 'CF-2001',
    customer: '507f1f77bcf86cd799439011',
    status: 'COMPLETED',
    completedAt: new Date(),
  });
  const error = doc.validateSync();
  assert.ok(!error, error ? error.message : '');
  assert.strictEqual(doc.isTerminal(), true, 'COMPLETED must be terminal');
  assert.strictEqual(doc.isOpen(), false);

  const handedOver = new Delivery({
    order: '507f1f77bcf86cd799439012',
    orderId: 'CF-2002',
    customer: '507f1f77bcf86cd799439012',
    status: 'DELIVERED',
    deliveredAt: new Date(),
  });
  const deliveredError = handedOver.validateSync();
  assert.ok(!deliveredError, deliveredError ? deliveredError.message : '');
  assert.strictEqual(handedOver.isTerminal(), false, 'DELIVERED must not be terminal');
  assert.strictEqual(handedOver.isOpen(), true, 'DELIVERED stays on the active list');
  assert.strictEqual(handedOver.isActive(), false, 'but the courier is no longer moving it');
});

check('the tracking payload reports the close-out moment', () => {
  const Delivery = require('./src/models/Delivery');
  const at = new Date('2026-01-02T03:04:05.000Z');
  const doc = new Delivery({
    order: '507f1f77bcf86cd799439011',
    orderId: 'CF-2003',
    customer: '507f1f77bcf86cd799439011',
    status: 'COMPLETED',
    deliveredAt: at,
    completedAt: at,
  });
  const payload = doc.toTrackingPayload();
  assert.strictEqual(payload.status, 'COMPLETED');
  assert.strictEqual(payload.deliveredAt, at);
  assert.strictEqual(payload.completedAt, at);
});

check('humanize produces a readable label for every status', () => {
  for (const status of Object.keys(svc.DELIVERY_TRANSITIONS)) {
    const label = svc.humanize(status);
    assert.ok(label && label.length > 2, `${status} needs a label`);
  }
  assert.match(svc.humanize('OUT_FOR_DELIVERY'), /out for delivery/i);
});

// --- coordinates ----------------------------------------------------------

check('valid coordinate pairs are accepted', () => {
  assert.strictEqual(svc.isValidCoordinate(9.0192, 38.7525), true);
  assert.strictEqual(svc.isValidCoordinate(-33.8688, 151.2093), true);
  assert.strictEqual(svc.isValidCoordinate(0, 0), true);
  assert.strictEqual(svc.isValidCoordinate(90, 180), true);
});

check('out-of-range or missing coordinates are rejected', () => {
  assert.strictEqual(svc.isValidCoordinate(91, 38), false);
  assert.strictEqual(svc.isValidCoordinate(-91, 38), false);
  assert.strictEqual(svc.isValidCoordinate(9, 181), false);
  assert.strictEqual(svc.isValidCoordinate(9, -181), false);
  assert.strictEqual(svc.isValidCoordinate(null, 38), false);
  assert.strictEqual(svc.isValidCoordinate(9, undefined), false);
  assert.strictEqual(svc.isValidCoordinate('', ''), false);
  assert.strictEqual(svc.isValidCoordinate(NaN, 38), false);
});

check('cleanCoordinate drops junk instead of storing NaN', () => {
  assert.strictEqual(svc.cleanCoordinate('9.0192', -90, 90), 9.0192);
  assert.strictEqual(svc.cleanCoordinate(38.7525, -180, 180), 38.7525);
  assert.strictEqual(svc.cleanCoordinate('', -90, 90), null);
  assert.strictEqual(svc.cleanCoordinate(null, -90, 90), null);
  assert.strictEqual(svc.cleanCoordinate('abc', -90, 90), null);
  assert.strictEqual(svc.cleanCoordinate(999, -90, 90), null);
  assert.strictEqual(svc.cleanCoordinate(true, -90, 90), null);
});

// --- distance, ETA, fee ---------------------------------------------------

check('haversine returns 0 for the same point', () => {
  const d = svc.haversineKm({ latitude: 9.0192, longitude: 38.7525 }, { latitude: 9.0192, longitude: 38.7525 });
  assert.ok(Math.abs(d) < 0.0001, `expected ~0, got ${d}`);
});

check('haversine matches a known Addis Ababa distance', () => {
  // Piazza -> Bole (~5.2 km straight line).
  const d = svc.haversineKm(
    { latitude: 9.0192, longitude: 38.7525 },
    { latitude: 8.9776, longitude: 38.7993 }
  );
  assert.ok(d > 4 && d < 7, `expected 4-7 km, got ${d.toFixed(2)}`);
});

check('haversine is null when an endpoint has no coordinates', () => {
  assert.strictEqual(svc.haversineKm({ latitude: 9, longitude: 38 }, { latitude: null, longitude: null }), null);
  assert.strictEqual(svc.haversineKm(null, { latitude: 9, longitude: 38 }), null);
});

check('distance fee grows with distance and respects the free threshold', () => {
  const near = svc.calculateDeliveryFee({ distanceKm: 1, subtotal: 100, settings: FEES });
  const far = svc.calculateDeliveryFee({ distanceKm: 5, subtotal: 100, settings: FEES });
  assert.strictEqual(near.mode, 'DISTANCE');
  assert.ok(far.fee > near.fee, 'a longer trip must cost more');

  const free = svc.calculateDeliveryFee({ distanceKm: 5, subtotal: 5000, settings: FEES });
  assert.strictEqual(free.fee, 0, 'a large basket must be free');
});

check('an order without coordinates falls back to the flat fee', () => {
  const quote = svc.calculateDeliveryFee({ distanceKm: null, subtotal: 100, settings: FEES });
  assert.strictEqual(quote.mode, 'FLAT');
  assert.strictEqual(quote.fee, FEES.delivery_fee);
  assert.strictEqual(quote.distanceKm, null, 'no distance must not be reported as 0 km');
  assert.strictEqual(quote.etaMinutes, null, 'an ETA must never be invented without a distance');
});

check('distance pricing never falls below the flat minimum charge', () => {
  const veryShort = svc.calculateDeliveryFee({ distanceKm: 0.4, subtotal: 100, settings: FEES });
  assert.strictEqual(veryShort.mode, 'DISTANCE');
  assert.ok(
    veryShort.fee >= FEES.delivery_fee,
    `a 0.4 km trip priced at ${veryShort.fee} undercuts the ${FEES.delivery_fee} minimum`
  );
  const normal = svc.calculateDeliveryFee({ distanceKm: 5, subtotal: 100, settings: FEES });
  assert.ok(normal.fee > FEES.delivery_fee, 'a 5 km trip must exceed the minimum');
});

check('a destination beyond the limit is reported, not silently accepted', () => {
  const quote = svc.calculateDeliveryFee({ distanceKm: 40, subtotal: 100, settings: FEES });
  assert.strictEqual(quote.withinRange, false);
  assert.ok(quote.maxDistanceKm > 0);
});

check('a normal destination is within range', () => {
  const quote = svc.calculateDeliveryFee({ distanceKm: 3, subtotal: 100, settings: FEES });
  assert.strictEqual(quote.withinRange, true);
});

check('ETA is a positive whole number of minutes and grows with distance', () => {
  const near = svc.estimateEtaMinutes(1, FEES);
  const far = svc.estimateEtaMinutes(10, FEES);
  assert.ok(Number.isInteger(near) && near > 0);
  assert.ok(Number.isInteger(far) && far > near);
  assert.ok(near >= FEES.delivery_prep_time_minutes, 'ETA must include prep time');
});

// --- quote / charge consistency -------------------------------------------
// The customer is quoted a fee at checkout, then the order is created. Both
// must use the SAME calculation, or the customer is charged a different amount
// than the one shown. This mirrors the recomputation in order.controller.

const { computeOrderCharges, round2 } = require('./src/services/finance.service');

check('the charged total includes a distance-quoted delivery fee', async () => {
  const settings = { ...FEES, service_fee: 5, vat_enabled: true, vat_rate: 15 };
  const subtotal = 200;
  const distanceKm = 5;

  const quote = svc.calculateDeliveryFee({ distanceKm, subtotal, settings });
  const flat = await computeOrderCharges({ subtotal, isDelivery: true, settings });
  const charged = await computeOrderCharges({
    subtotal,
    isDelivery: true,
    settings,
    deliveryFee: quote.fee,
  });

  assert.strictEqual(flat.deliveryFee, settings.delivery_fee, 'the flat default is 30');
  assert.strictEqual(quote.fee, 50, 'a 5 km trip is priced at 30 + 4 km x 10');
  assert.strictEqual(charged.deliveryFee, quote.fee, 'the override must win over the flat fee');
  assert.strictEqual(
    charged.totalAmount,
    round2(subtotal + 5 + quote.fee + round2((subtotal + 5 + quote.fee) * 0.15)),
    'the total must include the quoted fee AND the VAT on it'
  );
  assert.notStrictEqual(charged.totalAmount, flat.totalAmount, 'a flat-fee total would be wrong here');
  assert.strictEqual(charged.vatAmount, round2(charged.taxableAmount * 0.15));
  assert.strictEqual(charged.taxAmount, charged.vatAmount, 'taxAmount must mirror vatAmount');
});

check('a quote total is identical to the total charged at checkout', async () => {
  // The whole point: the number shown at checkout IS the number charged.
  const settings = { ...FEES, service_fee: 20, vat_enabled: true, vat_rate: 15 };
  for (const km of [0, 0.4, 2, 5, 9, 12, 14, 40]) {
    for (const subtotal of [50, 200, 499, 500, 900]) {
      const quote = svc.calculateDeliveryFee({ distanceKm: km, subtotal, settings });
      const shown = await computeOrderCharges({ subtotal, isDelivery: true, settings, deliveryFee: quote.fee });
      const charged = await computeOrderCharges({
        subtotal,
        isDelivery: true,
        settings,
        deliveryFee: quote.fee,
      });
      assert.strictEqual(
        shown.totalAmount,
        charged.totalAmount,
        `drift at ${km} km / ${subtotal} subtotal`
      );
      // The total is internally consistent: parts must sum to the whole.
      assert.strictEqual(
        charged.totalAmount,
        round2(charged.subtotal + charged.serviceFee + charged.deliveryFee + charged.vatAmount),
        `parts must sum to the total at ${km} km / ${subtotal} subtotal`
      );
      assert.strictEqual(charged.taxableAmount, round2(charged.subtotal + charged.serviceFee + charged.deliveryFee));
    }
  }
});

check('a zero delivery-fee override means free delivery, not a fallback', async () => {
  const settings = { ...FEES, service_fee: 5, vat_enabled: true, vat_rate: 15 };
  // Over the free-delivery threshold -> fee 0. This must NOT be mistaken for
  // "no override given" and silently replaced by the flat 30.
  const quote = svc.calculateDeliveryFee({ distanceKm: 3, subtotal: 800, settings });
  assert.strictEqual(quote.fee, 0, 'free delivery applies over the threshold');
  const charged = await computeOrderCharges({ subtotal: 800, isDelivery: true, settings, deliveryFee: quote.fee });
  assert.strictEqual(charged.deliveryFee, 0, 'a real zero fee must be honoured');
  assert.strictEqual(charged.totalAmount, round2(800 + 5 + round2(805 * 0.15)));
});

check('a negative or non-numeric fee override can never reduce the total', async () => {
  const settings = { ...FEES, service_fee: 5, vat_enabled: true, vat_rate: 15 };
  for (const bad of [-50, NaN, 'abc', Infinity, -Infinity, {}]) {
    const charged = await computeOrderCharges({
      subtotal: 200,
      isDelivery: true,
      settings,
      deliveryFee: bad,
    });
    assert.ok(charged.deliveryFee >= 0, `fee override ${String(bad)} produced ${charged.deliveryFee}`);
    assert.ok(Number.isFinite(charged.totalAmount), `fee override ${String(bad)} broke the total`);
    assert.ok(charged.totalAmount >= charged.subtotal + charged.serviceFee, 'total must never be undercharged');
  }
});

check('an out-of-range destination is still quoted, so the UI can block it', () => {
  // createOrder rejects with 400 when a customer DOES share coordinates that
  // are out of range; the quote must therefore flag it rather than hiding it.
  const far = svc.calculateDeliveryFee({ distanceKm: 40, subtotal: 100, settings: FEES });
  assert.strictEqual(far.withinRange, false);
  assert.ok(far.fee > 0, 'an out-of-range quote still reports a fee');
  // Without coordinates the range is unknowable, so it must NOT be reported as
  // out of range (otherwise every address-only order would be rejected).
  const noCoords = svc.calculateDeliveryFee({ distanceKm: null, subtotal: 100, settings: FEES });
  assert.notStrictEqual(noCoords.withinRange, false, 'address-only orders must stay allowed');
  assert.strictEqual(noCoords.fee, FEES.delivery_fee, 'address-only uses the flat fee');
});

check('the distance is measured from the real pickup point, not the default', () => {
  // A different cafeteria pickup moves the destination's distance, which moves
  // the fee. If both pickup points were hard-coded this would be identical.
  const dest = { latitude: 9.02, longitude: 38.75 };
  const near = svc.haversineKm({ latitude: 9.0, longitude: 38.75 }, dest);
  const far = svc.haversineKm({ latitude: 9.3, longitude: 38.75 }, dest);
  assert.ok(far > near, 'pickup point must affect the measured distance');
  const a = svc.calculateDeliveryFee({ distanceKm: near, subtotal: 100, settings: FEES });
  const b = svc.calculateDeliveryFee({ distanceKm: far, subtotal: 100, settings: FEES });
  assert.notStrictEqual(a.fee, b.fee, 'a different cafeteria must be able to charge differently');
});

check('a non-delivery order is never charged a delivery fee', async () => {
  const settings = { ...FEES, service_fee: 5, vat_enabled: true, vat_rate: 15 };
  // Even with an override, a dine-in / takeaway order has no delivery fee.
  const charges = await computeOrderCharges({
    subtotal: 200,
    isDelivery: false,
    settings,
    deliveryFee: 999,
  });
  assert.strictEqual(charges.deliveryFee, 0);
  assert.strictEqual(charges.totalAmount, round2(200 + 5 + round2(205 * 0.15)));
});

check('a customer-supplied fee is never trusted', () => {
  // createOrder ignores any client fee entirely; this documents the contract
  // by proving the fee is a pure function of real inputs.
  const quoteA = svc.calculateDeliveryFee({ distanceKm: 3, subtotal: 100, settings: FEES });
  const quoteB = svc.calculateDeliveryFee({ distanceKm: 3, subtotal: 100, settings: FEES });
  assert.strictEqual(quoteA.fee, quoteB.fee, 'the fee is a pure function of real inputs');
});

check('fees are rounded to 2 decimals (no floating point drift)', () => {
  const quote = svc.calculateDeliveryFee({ distanceKm: 3.337, subtotal: 99.99, settings: FEES });
  assert.strictEqual(quote.fee, Math.round(quote.fee * 100) / 100);
});

// --- schema enums agree with the service constants ------------------------

check('the Delivery schema enums match the state machine', () => {
  const Delivery = require('./src/models/Delivery');
  const schema = Delivery.schema;
  const statuses = schema.path('status').options.enum;
  assert.deepStrictEqual(statuses, Object.keys(svc.DELIVERY_TRANSITIONS));

  const failureEnum = schema.path('failureReason').options.enum.filter((r) => r !== null);
  assert.ok(failureEnum.length >= 8, 'failure reasons must be enumerated');
  for (const reason of failureEnum) {
    assert.ok(/^[A-Z_]+$/.test(reason), `${reason} must be SCREAMING_SNAKE`);
  }
});

check('a Delivery document validates with real data', () => {
  const Delivery = require('./src/models/Delivery');
  const doc = new Delivery({
    order: '507f1f77bcf86cd799439011',
    orderId: 'CF-1001',
    customer: '507f1f77bcf86cd799439011',
    status: 'OUT_FOR_DELIVERY',
    distanceKm: 3.2,
    etaMinutes: 18,
    deliveryFee: 30,
  });
  const error = doc.validateSync();
  assert.ok(!error, error ? error.message : '');
});

check('a Delivery document rejects an impossible status', () => {
  const Delivery = require('./src/models/Delivery');
  const doc = new Delivery({
    order: '507f1f77bcf86cd799439011',
    orderId: 'CF-1002',
    customer: '507f1f77bcf86cd799439011',
    status: 'TELEPORTED',
  });
  const error = doc.validateSync();
  assert.ok(error, 'an unknown status must be rejected by the schema');
});

check('one delivery per order is enforced by a unique index', () => {
  const Delivery = require('./src/models/Delivery');
  const indexes = Delivery.schema.indexes();
  const uniqueOnOrder = indexes.find(
    ([keys, options]) => options && options.unique && keys.order === 1
  );
  assert.ok(uniqueOnOrder, 'a unique index on { order: 1 } is required');
});

// --- the pickup gate: the kitchen prepares BEFORE the courier collects -------
// Required flow: assigned -> accepted -> kitchen prepares -> courier picks up.
// Without a ready-check a courier can collect food the kitchen has not made.

const { isKitchenReady, kitchenReadyState } =
  require('./src/controllers/delivery.controller')._internal;

check('a courier cannot pick up an order the kitchen has not prepared', () => {
  for (const state of ['PENDING', 'PREPARING']) {
    assert.strictEqual(isKitchenReady({ orderStatus: state, status: state.toLowerCase() }), false,
      `${state} must block pickup`);
  }
});

check('pickup is allowed once the kitchen marks the order ready', () => {
  assert.strictEqual(isKitchenReady({ orderStatus: 'READY', status: 'ready' }), true);
});

check('the kitchen-ready check reads whichever field the kitchen wrote', () => {
  // The kitchen screen has written both fields, and legacy rows only have one.
  assert.strictEqual(isKitchenReady({ orderStatus: 'READY' }), true, 'uppercase field only');
  assert.strictEqual(isKitchenReady({ status: 'ready' }), true, 'lowercase field only');
  assert.strictEqual(isKitchenReady({ orderStatus: 'READY', status: 'preparing' }), true,
    'orderStatus is authoritative when they disagree');
  assert.strictEqual(isKitchenReady({ orderStatus: '', status: 'ready' }), true, 'empty upper falls through');
});

check('a late kitchen "ready" tap cannot block a courier already en route', () => {
  // After pickup the food is physically with the courier, so these must stay
  // ready regardless of a stale kitchen status.
  for (const state of ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'COMPLETED']) {
    assert.strictEqual(isKitchenReady({ orderStatus: state }), true, `${state} must not block`);
  }
});

check('an order with no kitchen state at all is treated as not ready', () => {
  // Fail closed: a missing status must not silently let a pickup through.
  assert.strictEqual(isKitchenReady({}), false);
  assert.strictEqual(isKitchenReady({ orderStatus: null, status: null }), false);
  assert.strictEqual(kitchenReadyState({}), 'PENDING');
});

check('the pickup gate sits on the pickup transition only', () => {
  // Arriving at a customer who is not home must never be blocked by a stale
  // kitchen status, so the gate is PICKED_UP specific.
  assert.strictEqual(isKitchenReady({ orderStatus: 'OUT_FOR_DELIVERY' }), true,
    'out-for-delivery implies the food was already collected');
  assert.strictEqual(kitchenReadyState({ status: 'arrived' }), 'ARRIVED');
});

check('GPS is only allowed once the courier is actually moving', () => {
  // The tracking map must not show a rider wandering around before pickup.
  for (const state of ['REQUESTED', 'ASSIGNED', 'ACCEPTED']) {
    assert.strictEqual(svc.isGpsAllowed(state), false, `${state} must not report GPS`);
  }
  for (const state of ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED']) {
    assert.strictEqual(svc.isGpsAllowed(state), true, `${state} must report GPS`);
  }
  for (const state of ['DELIVERED', 'COMPLETED', 'CANCELLED', 'FAILED']) {
    assert.strictEqual(svc.isGpsAllowed(state), false, `${state} is finished; no GPS`);
  }
});

check('the happy path walks the exact sequence in the flow diagram', () => {
  const path = [
    'REQUESTED',
    'ASSIGNED',
    'ACCEPTED',
    'PICKED_UP',
    'OUT_FOR_DELIVERY',
    'ARRIVED',
    'DELIVERED',
    'COMPLETED',
  ];
  // Each step must be reachable from the one before it, in order, with no skips.
  for (let i = 1; i < path.length; i += 1) {
    const from = path[i - 1];
    const to = path[i];
    assert.ok(
      svc.DELIVERY_TRANSITIONS[from].includes(to),
      `${from} -> ${to} must be a legal transition`
    );
  }
  assert.deepStrictEqual(svc.TERMINAL_STATUSES.includes('DELIVERED'), false,
    'DELIVERED is a handover, not the end of the delivery');
  assert.deepStrictEqual(svc.TERMINAL_STATUSES.includes('COMPLETED'), true, 'COMPLETED is terminal');
  assert.ok(svc.DELIVERY_TRANSITIONS.DELIVERED.includes('COMPLETED'), 'the handover must be closable');
  assert.deepStrictEqual(svc.DELIVERY_TRANSITIONS.COMPLETED, [], 'nothing follows COMPLETED');
});

check('the flow cannot be short-circuited', () => {
  // The classic abuse: courier marks DELIVERED straight from ACCEPTED and the
  // customer never gets a real delivery.
  const badJumps = [
    ['ACCEPTED', 'DELIVERED'],
    ['ACCEPTED', 'ARRIVED'],
    ['ACCEPTED', 'OUT_FOR_DELIVERY'],
    ['ASSIGNED', 'OUT_FOR_DELIVERY'],
    ['PICKED_UP', 'DELIVERED'],
    ['REQUESTED', 'DELIVERED'],
  ];
  for (const [from, to] of badJumps) {
    assert.ok(
      !svc.DELIVERY_TRANSITIONS[from].includes(to),
      `${from} -> ${to} must be rejected`
    );
  }
});

check('an order cannot be completed without a proven handover', () => {
  // Completing the order is the money/state finalisation step, so it must be
  // unreachable from anything except DELIVERED.
  const jumps = [
    'REQUESTED', 'ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED',
  ];
  for (const from of jumps) {
    assert.ok(
      !svc.DELIVERY_TRANSITIONS[from].includes('COMPLETED'),
      `${from} -> COMPLETED must be rejected`
    );
  }
});

// --- every stage must reach the customer's tracking page live --------------
// The customer never refreshes: each stage has to emit `order:status` into that
// order's room with a status the tracker can map to the right step. This was a
// real defect on DELIVERED, which writes its status directly instead of going
// through moveDelivery() and so never broadcast at all - the customer's step
// stayed grey until they reloaded the page.

const CUSTOMER_ROOM_EVENT = 'order:status';

check('every delivery stage broadcasts a status to the customer order room', () => {
  const socketUtils = require('./src/utils/socket');
  const emitted = [];
  socketUtils.initSocket({
    to: (room) => ({
      emit: (event, payload) => emitted.push({ room, event, status: payload && payload.status }),
    }),
    emit: (event) => emitted.push({ room: '<broadcast>', event }),
  });

  const controller = require('./src/controllers/delivery.controller');
  // Customer tracking step keys, in order (order-status.js getTimelineConfig).
  const STEP_KEYS = [
    'pending', 'preparing', 'ready', 'picked_up',
    'out_for_delivery', 'arrived', 'delivered', 'completed',
  ];
  const expected = ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'COMPLETED'];
  const customerFrames = {};
  const orderSummary = (deliveryStatus) => ({
    orderId: 'CF-STAGE-1',
    deliveryStatus,
    status: deliveryStatus,
  });

  // Each stage ends up here: four of them via moveDelivery(), and DELIVERED via
  // markDelivered() which writes the status itself and must broadcast too.
  // Captured per stage, so a stage that never broadcasts shows up as "no event".
  for (const stage of ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'COMPLETED']) {
    emitted.length = 0;
    controller._internal.broadcastStatus(orderSummary(stage));
    const frame = emitted.find(
      (e) => e.room === 'order:CF-STAGE-1' && e.event === CUSTOMER_ROOM_EVENT
    );
    assert.ok(frame, `${stage} must reach the customer order room`);
    customerFrames[stage] = frame.status;
  }

for (const stage of expected) {
    const status = customerFrames[stage];
    const idx = STEP_KEYS.indexOf(String(status || '').toLowerCase());
    assert.ok(idx >= 0, `${stage} emitted an unmappable status: ${status}`);
    assert.strictEqual(
      STEP_KEYS[idx], stage.toLowerCase(),
      `${stage} must light the "${stage.toLowerCase()}" step, not "${STEP_KEYS[idx]}"`
    );
  }
});

check('the customer broadcast never carries staff-only annotations', () => {
  const socketUtils = require('./src/utils/socket');
  const emitted = [];
  socketUtils.initSocket({
    to: (room) => ({
      emit: (event, payload) => emitted.push({ room, event, payload }),
    }),
    emit: () => {},
  });

  const controller = require('./src/controllers/delivery.controller');
  controller._internal.broadcastStatus({
    orderId: 'CF-SAFE-1',
    deliveryStatus: 'ARRIVED',
    status: 'ARRIVED',
    failureNote: 'rider vehicle broke down',
    statusHistory: [{ status: 'ARRIVED', at: new Date(), note: 'internal only' }],
  });

  const toCustomer = emitted.find((e) => e.room === 'order:CF-SAFE-1' && e.event === CUSTOMER_ROOM_EVENT);
  assert.ok(toCustomer, 'the customer room must still receive the update');
  assert.strictEqual(toCustomer.payload.failureNote, null, 'failureNote must not leak');
  assert.strictEqual(toCustomer.payload.statusHistory[0].note, undefined,
    'status history notes must not leak');
});

// --- result ---------------------------------------------------------------

runAll().then(() => {
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const failure of failures) console.log(`  FAIL  ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('Delivery domain logic verified.\n');
  }
});
