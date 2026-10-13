/**
 * End-to-end verification of the delivery-range validation fix.
 *
 * Root cause this guards against: the default cafeteria was created with
 * Debre Berhan coordinates (9.6797, 39.5328) while the business operates in
 * Addis Ababa, so the range check measured ~113 km for a customer who was
 * effectively next door and rejected every valid address.
 *
 * These tests exercise the real API and database:
 *   1. A real in-range delivery location is accepted and the order is created.
 *   2. A real out-of-range location is rejected with code DELIVERY_OUT_OF_RANGE.
 *   3. The quote endpoint reports the correct distance and withinRange flag.
 *   4. Address-only (no coordinates) is still accepted.
 *   5. Null / 0 / non-finite coordinates never produce a false rejection.
 *   6. The configured 10 km limit is still enforced (not removed).
 *
 * Usage:  node scripts/e2e-delivery-range.js
 * Requires the backend to be listening on PORT (default 5000).
 */

require('dotenv').config();
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const connectDatabase = require('../src/config/database');
const User = require('../src/models/User');
const MenuItem = require('../src/models/MenuItem');
const Order = require('../src/models/Order');
const Cafeteria = require('../src/models/Cafeteria');
const deliveryService = require('../src/services/delivery.service');

const PORT = Number(process.env.PORT || process.env.API_PORT || 5000);

// Real Addis Ababa coordinates. The cafeteria is at (9.03, 38.74).
const CAFE = { latitude: 9.03, longitude: 38.74 };
// ~1.1 km from the cafeteria - comfortably in range.
const NEAR = { latitude: 9.0222, longitude: 38.7468 };
// ~15 km north of the cafeteria - genuinely out of range.
const FAR = { latitude: 9.17, longitude: 38.74 };

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`   PASS  ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` :: ${detail}` : ''}`);
    console.log(`   FAIL  ${label}${detail ? `  <-- ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function sign(user) {
  return jwt.sign(
    { id: user._id.toString(), role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function api(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: `/api/v1${path}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = { raw };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await connectDatabase();
  console.log(`Connected to MongoDB: ${mongoose.connection.name}`);

  const customer = await User.findOne({ role: 'customer', status: 'ACTIVE' });
  const item = await MenuItem.findOne({ isAvailable: true, stockQuantity: { $gt: 5 } });
  if (!customer || !item) throw new Error('Missing fixtures');

  const CT = sign(customer);
  console.log(`customer: ${customer.email}`);
  console.log(`item    : ${item.name?.en || item.name}`);

  const cafe = await Cafeteria.findOne({ isDefault: true }).lean();
  console.log(`cafeteria: ${cafe.name} at (${cafe.latitude}, ${cafe.longitude})`);

  const createdOrderIds = [];

  try {
    // --------------------------------------------------------------
    section('STEP 1 - the cafeteria coordinates are the real operating city');
    // --------------------------------------------------------------
    check('default cafeteria has coordinates', Number.isFinite(cafe.latitude) && Number.isFinite(cafe.longitude));
    const cafeDistToNear = deliveryService.haversineKm(cafe, NEAR);
    check('cafeteria is within 10 km of a real Addis Ababa address',
      cafeDistToNear != null && cafeDistToNear <= 10,
      `distance=${cafeDistToNear}`);

    // --------------------------------------------------------------
    section('STEP 2 - quote reports the correct distance and range flag');
    // --------------------------------------------------------------
    let res = await api('POST', '/deliveries/quote', CT, { ...NEAR, subtotal: 200 });
    check('quote succeeds for an in-range address', res.body?.success === true, JSON.stringify(res.body).slice(0, 250));
    check('quote distanceKm is ~1.1 km', Math.abs(Number(res.body?.distanceKm) - cafeDistToNear) < 0.5,
      `distanceKm=${res.body?.distanceKm} expected~${cafeDistToNear}`);
    check('quote withinRange is true', res.body?.withinRange === true);
    check('quote maxDistanceKm is 10', Number(res.body?.maxDistanceKm) === 10, `max=${res.body?.maxDistanceKm}`);
    check('quote echoes the cafeteria coordinates',
      Number(res.body?.pickupLocation?.latitude) === cafe.latitude
      && Number(res.body?.pickupLocation?.longitude) === cafe.longitude,
      JSON.stringify(res.body?.pickupLocation));

    res = await api('POST', '/deliveries/quote', CT, { ...FAR, subtotal: 200 });
    const farDist = deliveryService.haversineKm(cafe, FAR);
    check('quote distanceKm is ~15 km for the far address',
      Math.abs(Number(res.body?.distanceKm) - farDist) < 1.5,
      `distanceKm=${res.body?.distanceKm} expected~${farDist}`);
    check('quote withinRange is false for the far address', res.body?.withinRange === false);

    // --------------------------------------------------------------
    section('STEP 3 - an in-range delivery order is accepted');
    // --------------------------------------------------------------
    res = await api('POST', '/orders', CT, {
      orderType: 'delivery',
      customerName: customer.name || 'E2E Customer',
      customerPhone: customer.phone,
      paymentMethod: 'CHAPA',
      items: [{ id: String(item._id), quantity: 1 }],
      deliveryInfo: {
        location: 'Bole, Addis Ababa',
        subCity: 'Bole',
        latitude: NEAR.latitude,
        longitude: NEAR.longitude,
      },
      totalAmount: Number(item.price) || 200,
    });
    check('in-range order is created', res.status === 201 || res.status === 200,
      `status=${res.status} ${JSON.stringify(res.body).slice(0, 250)}`);
    const nearOrderId = res.body?.order?.orderId || res.body?.data?.orderId || res.body?.orderId;
    check('in-range order has an orderId', Boolean(nearOrderId));
    if (nearOrderId) createdOrderIds.push(nearOrderId);

    // --------------------------------------------------------------
    section('STEP 3b - empty and (0,0) coordinates are never false-rejected');
    // --------------------------------------------------------------
    // Number('') === 0, so an unset coordinate field used to become (0, 0) -
    // a "valid" coordinate 4,400 km away in the Gulf of Guinea. Both the
    // frontend and the backend must treat that as "no location shared".
    const emptyCases = [
      { label: 'no coordinate fields at all', omit: true },
      { label: 'explicit (0, 0)', latitude: 0, longitude: 0 },
    ];
    for (const ec of emptyCases) {
      const deliveryInfo = { location: 'Bole, Addis Ababa', subCity: 'Bole' };
      if (!ec.omit) {
        deliveryInfo.latitude = ec.latitude;
        deliveryInfo.longitude = ec.longitude;
      }
      const r = await api('POST', '/orders', CT, {
        orderType: 'delivery',
        customerName: customer.name || 'E2E Customer',
        customerPhone: customer.phone,
        paymentMethod: 'CHAPA',
        items: [{ id: String(item._id), quantity: 1 }],
        deliveryInfo,
        totalAmount: Number(item.price) || 200,
      });
      const oid = r.body && r.body.order && r.body.order.orderId;
      check(`${ec.label} is accepted as address-only`, r.status === 201 || r.status === 200,
        `status=${r.status} code=${r.body && r.body.code} ${JSON.stringify(r.body).slice(0, 200)}`);
      if (oid) createdOrderIds.push(oid);
    }

    // --------------------------------------------------------------
    section('STEP 4 - an out-of-range delivery order is rejected with a code');
    // --------------------------------------------------------------
    res = await api('POST', '/orders', CT, {
      orderType: 'delivery',
      customerName: customer.name || 'E2E Customer',
      customerPhone: customer.phone,
      paymentMethod: 'CHAPA',
      items: [{ id: String(item._id), quantity: 1 }],
      deliveryInfo: {
        location: 'Far away',
        subCity: 'Nowhere',
        latitude: FAR.latitude,
        longitude: FAR.longitude,
      },
      totalAmount: Number(item.price) || 200,
    });
    check('out-of-range order is rejected', res.status === 400, `status=${res.status}`);
    check('rejection carries code DELIVERY_OUT_OF_RANGE', res.body?.code === 'DELIVERY_OUT_OF_RANGE',
      `code=${res.body?.code}`);
    check('rejection message mentions the range', /delivery range/i.test(res.body?.error || ''),
      res.body?.error);
    check('rejection echoes distanceKm and maxDistanceKm',
      Number(res.body?.distanceKm) > 10 && Number(res.body?.maxDistanceKm) === 10,
      `distanceKm=${res.body?.distanceKm} maxDistanceKm=${res.body?.maxDistanceKm}`);

    // --------------------------------------------------------------
    section('STEP 5 - address-only delivery (no coordinates) is still accepted');
    // --------------------------------------------------------------
    res = await api('POST', '/orders', CT, {
      orderType: 'delivery',
      customerName: customer.name || 'E2E Customer',
      customerPhone: customer.phone,
      paymentMethod: 'CHAPA',
      items: [{ id: String(item._id), quantity: 1 }],
      deliveryInfo: { location: 'Bole', subCity: 'Bole' },
      totalAmount: Number(item.price) || 200,
    });
    check('address-only order is accepted', res.status === 201 || res.status === 200,
      `status=${res.status} ${JSON.stringify(res.body).slice(0, 250)}`);
    const addrOrderId = res.body?.order?.orderId || res.body?.data?.orderId || res.body?.orderId;
    if (addrOrderId) createdOrderIds.push(addrOrderId);

    // --------------------------------------------------------------
    section('STEP 6 - null / 0 / non-finite coordinates never false-reject');
    // --------------------------------------------------------------
    // (0, 0) is a real coordinate (Gulf of Guinea) but is ~5000 km from Addis
    // Ababa. It must NOT crash, and must NOT be silently treated as a valid
    // in-range location. It is treated as "no location shared" (address-only),
    // because Number('') === 0 means an unset field arrives as (0, 0).
    res = await api('POST', '/orders', CT, {
      orderType: 'delivery',
      customerName: customer.name || 'E2E Customer',
      customerPhone: customer.phone,
      paymentMethod: 'CHAPA',
      items: [{ id: String(item._id), quantity: 1 }],
      deliveryInfo: { location: 'Null Island', subCity: 'Nowhere', latitude: 0, longitude: 0 },
      totalAmount: Number(item.price) || 200,
    });
    check('(0,0) is treated as address-only, not rejected and not crashed',
      (res.status === 201 || res.status === 200) && res.body?.code !== 'DELIVERY_OUT_OF_RANGE',
      `status=${res.status} code=${res.body && res.body.code}`);

    // Non-finite coordinates must not crash the quote either.
    res = await api('POST', '/deliveries/quote', CT, { latitude: 'abc', longitude: null, subtotal: 200 });
    check('non-finite coordinates do not crash the quote', res.status === 200 && res.body?.success === true,
      `status=${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    check('non-finite coordinates are treated as address-only', res.body?.withinRange === true);

    // --------------------------------------------------------------
    section('STEP 7 - the 10 km limit is still enforced');
    // --------------------------------------------------------------
    // A point just inside 10 km and just outside 10 km.
    const settings = { delivery_max_distance_km: 10 };
    const justInside = { latitude: 9.11, longitude: 38.74 };   // ~8.9 km
    const justOutside = { latitude: 9.13, longitude: 38.74 };  // ~11.1 km
    const dIn = deliveryService.haversineKm(cafe, justInside);
    const dOut = deliveryService.haversineKm(cafe, justOutside);
    const qIn = deliveryService.calculateDeliveryFee({ distanceKm: dIn, subtotal: 200, settings });
    const qOut = deliveryService.calculateDeliveryFee({ distanceKm: dOut, subtotal: 200, settings });
    check('a point at ~8.9 km is within range', qIn.withinRange === true, `km=${dIn}`);
    check('a point at ~11.1 km is out of range', qOut.withinRange === false, `km=${dOut}`);
  } finally {
    // ---------------------------------------------------------- cleanup --
    if (createdOrderIds.length) {
      const removed = await Order.deleteMany({ orderId: { $in: createdOrderIds } });
      console.log(`\ncleanup: removed ${removed.deletedCount} test order(s)`);
    }
    await mongoose.disconnect();
  }

  console.log(`\n================ RESULT: ${passed} passed, ${failed} failed ================`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nE2E run crashed:', error);
  process.exit(1);
});
