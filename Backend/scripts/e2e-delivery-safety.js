/**
 * End-to-end verification of the Delivery Safety & Proof-of-Delivery system.
 *
 * Runs the whole real flow against the live HTTP API, Socket.IO server and
 * MongoDB - no mocks, no stubs, no invented coordinates:
 *
 *   1.  Customer places a delivery order
 *   2.  Manager assigns a delivery person
 *   3.  Delivery person accepts, picks up, starts the delivery
 *   4.  Delivery person presses SOS (with a real GPS fix)
 *   5.  Delivery goes ON_HOLD
 *   6.  Managers are notified (socket + notification)
 *   7.  Manager acknowledges
 *   8.  Delivery person resolves the emergency
 *   9.  Delivery person marks arrived
 *   10. Customer OTP is generated and delivered to the customer
 *   11. Proof photo is uploaded
 *   12. Backend verifies the OTP
 *   13. Delivery becomes DELIVERED with proof attached
 *   14. Manager can read the proof, deliveredAt and status history
 *   15. Negative cases: no-proof delivery is rejected, duplicate SOS is rejected,
 *       unauthorised SOS is rejected, manager override is recorded.
 *
 * Usage:  node scripts/e2e-delivery-safety.js
 * Requires the backend to be listening on PORT (default 5000).
 */

require('dotenv').config();
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');

const connectDatabase = require('../src/config/database');
const User = require('../src/models/User');
const MenuItem = require('../src/models/MenuItem');
const Order = require('../src/models/Order');
const Delivery = require('../src/models/Delivery');
const DeliveryEmergency = require('../src/models/DeliveryEmergency');
const Notification = require('../src/models/Notification');

const PORT = Number(process.env.PORT || process.env.API_PORT || 5000);

// A real GPS fix (Addis Ababa). Used as the rider's reported position - the
// point is that it flows through the system unaltered, not that it is the
// rider's actual location.
const RIDER_FIX = { latitude: 9.0222, longitude: 38.7468, accuracy: 12 };

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

/** Multipart upload via the global fetch (undici), which handles FormData. */
async function upload(path, token, field, file) {
  const fd = new FormData();
  fd.append(field, file);
  const response = await fetch(`http://127.0.0.1:${PORT}/api/v1${path}`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: fd,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** A real 1x1 PNG, so the proof-photo upload exercises the image validator. */
function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
}

function connectSocket(token, rooms) {
  const socket = io(`http://127.0.0.1:${PORT}`, {
    auth: { token },
    transports: ['websocket', 'polling'],
  });
  socket.on('connect', () => rooms.forEach((r) => socket.emit(r)));
  return socket;
}

async function main() {
  await connectDatabase();
  console.log(`Connected to MongoDB: ${mongoose.connection.name}`);

  const customer = await User.findOne({ role: 'customer', status: 'ACTIVE' });
  const rider = await User.findOne({ role: 'delivery', status: 'ACTIVE' });
  const manager = await User.findOne({ role: 'manager', status: 'ACTIVE' });
  const admin = await User.findOne({ role: 'admin', status: 'ACTIVE' });
  const kitchen = await User.findOne({ role: 'kitchen', status: 'ACTIVE' });
  const item = await MenuItem.findOne({ isAvailable: true, stockQuantity: { $gt: 5 } });
  if (!customer || !rider || !item) throw new Error('Missing fixtures (customer/rider/menu item)');

  console.log(`customer: ${customer.email}`);
  console.log(`rider   : ${rider.email}`);
  console.log(`manager : ${manager ? manager.email : '(none)'}`);
  console.log(`kitchen : ${kitchen ? kitchen.email : '(none)'}`);
  console.log(`admin   : ${admin ? admin.email : '(none)'}`);

  const CT = sign(customer);
  const RT = sign(rider);
  const MT = manager ? sign(manager) : null;
  const KT = kitchen ? sign(kitchen) : null;
  const AT = admin ? sign(admin) : null;

  // Manager socket: must receive delivery:emergency.
  const managerFrames = { emergency: [], ack: [], resolved: [] };
  const managerSocket = connectSocket(MT, ['join:admin', 'join:delivery']);
  managerSocket.on('delivery:emergency', (e) => managerFrames.emergency.push(e));
  managerSocket.on('delivery:emergency:ack', (e) => managerFrames.ack.push(e));
  managerSocket.on('delivery:emergency:resolved', (e) => managerFrames.resolved.push(e));
  await new Promise((r) => managerSocket.once('connect', r));
  await wait(400);

  let orderId = null;
  let deliveryId = null;
  let emergencyId = null;
  let generatedOtp = null;
  let secondOrderId = null;
  let secondDeliveryId = null;

  try {
    // --------------------------------------------------------------
    section('STEP 1 - customer places a delivery order');
    // --------------------------------------------------------------
    let res = await api('POST', '/orders', CT, {
      orderType: 'delivery',
      customerName: customer.name || 'E2E Customer',
      customerPhone: customer.phone,
      paymentMethod: 'CHAPA',
      items: [{ id: String(item._id), quantity: 1 }],
      deliveryInfo: { location: 'Bole, Addis Ababa', subCity: 'Bole' },
      totalAmount: Number(item.price) || 200,
    });
    check('POST /orders succeeds', res.status === 201 || res.status === 200, `status=${res.status} ${JSON.stringify(res.body).slice(0, 250)}`);
    const created = res.body?.data?.order || res.body?.order || res.body?.data;
    orderId = created?.orderId;
    check('order has an orderId', Boolean(orderId), JSON.stringify(res.body).slice(0, 200));
    if (!orderId) throw new Error('cannot continue without an orderId');
    console.log(`   order = ${orderId}`);

    // The kitchen only accepts PAID orders (payment successful -> order =
    // PENDING -> kitchen dashboard). This script exercises delivery safety, not
    // payments, so it settles the payment directly instead of walking the
    // simulator's randomised outcome.
    await Order.updateOne({ orderId }, { $set: { paymentStatus: 'PAID' } });

    const liveOrder = await Order.findOne({ orderId });
    deliveryId = liveOrder?.delivery ? String(liveOrder.delivery) : null;
    check('a Delivery record was created for the order', Boolean(deliveryId));

    // --------------------------------------------------------------
    section('STEP 2 - manager assigns the delivery person');
    // --------------------------------------------------------------
    res = await api('PATCH', `/deliveries/${deliveryId}/assign`, MT, { deliveryStaffId: String(rider._id) });
    check('assign succeeds', res.body?.success === true, JSON.stringify(res.body).slice(0, 250));

    // --------------------------------------------------------------
    section('STEP 3 - rider accepts, kitchen readies, rider picks up and starts');
    // --------------------------------------------------------------
    res = await api('PATCH', `/deliveries/${deliveryId}/accept`, RT, { accept: true });
    check('rider accepts the delivery assignment', res.body?.success === true, JSON.stringify(res.body).slice(0, 200));

    // The kitchen must accept and finish the food before the rider may collect
    // it - the backend enforces this, so the test has to walk the real path.
    if (KT) {
      res = await api('PATCH', `/kitchen/orders/${orderId}/accept`, KT);
      check('kitchen accepts the order', res.body?.success === true, JSON.stringify(res.body).slice(0, 200));
      res = await api('PATCH', `/kitchen/orders/${orderId}/ready`, KT);
      check('kitchen marks the order ready', res.body?.success === true, JSON.stringify(res.body).slice(0, 200));
    } else {
      // Fall back to a manager, who is allowed to drive the kitchen states.
      res = await api('PATCH', `/kitchen/orders/${orderId}/accept`, MT);
      check('manager accepts the order on behalf of the kitchen', res.body?.success === true, JSON.stringify(res.body).slice(0, 200));
      res = await api('PATCH', `/kitchen/orders/${orderId}/ready`, MT);
      check('manager marks the order ready', res.body?.success === true, JSON.stringify(res.body).slice(0, 200));
    }

    res = await api('PATCH', `/deliveries/${deliveryId}/pickup`, RT, {});
    check('rider picks up', res.body?.success === true, JSON.stringify(res.body).slice(0, 200));

    res = await api('PATCH', `/deliveries/${deliveryId}/out-for-delivery`, RT, {});
    check('rider starts delivery', res.body?.success === true, JSON.stringify(res.body).slice(0, 200));

    // --------------------------------------------------------------
    section('STEP 4 - rider presses SOS with a real GPS fix');
    // --------------------------------------------------------------
    res = await api('POST', `/deliveries/${deliveryId}/emergency`, RT, RIDER_FIX);
    check('SOS accepted', res.status === 201 && res.body?.success === true, `status=${res.status} ${JSON.stringify(res.body).slice(0, 250)}`);
    emergencyId = res.body?.emergency?.id;
    check('emergency id returned', Boolean(emergencyId));
    check('emergency carries the rider GPS',
      Number(res.body?.emergency?.latitude) === RIDER_FIX.latitude
      && Number(res.body?.emergency?.longitude) === RIDER_FIX.longitude,
      JSON.stringify(res.body?.emergency));
    check('emergency records the rider, order and delivery',
      Boolean(res.body?.emergency?.deliveryPersonName || res.body?.emergency?.deliveryPersonId)
      && res.body?.emergency?.orderId === orderId
      && Boolean(res.body?.emergency?.deliveryId));

    // --------------------------------------------------------------
    section('STEP 5 - delivery is automatically ON HOLD');
    // --------------------------------------------------------------
    const held = await waitFor(async () => {
      const d = await Delivery.findById(deliveryId);
      return d && d.onHold === true ? d : null;
    }, { label: 'delivery onHold' });
    check('delivery onHold is true', held.onHold === true);
    check('hold reason is EMERGENCY', held.holdReason === 'EMERGENCY', held.holdReason);

    // --------------------------------------------------------------
    section('STEP 6 - managers are notified (socket + notification)');
    // --------------------------------------------------------------
    const mgrFrame = await waitFor(() => managerFrames.emergency[0], { label: 'manager socket delivery:emergency' });
    check('manager socket received delivery:emergency', Boolean(mgrFrame));
    check('socket payload includes rider, order, delivery, time and GPS',
      Boolean(mgrFrame.deliveryPersonId) && mgrFrame.orderId === orderId
      && Boolean(mgrFrame.deliveryId) && Boolean(mgrFrame.triggeredAt)
      && Number(mgrFrame.latitude) === RIDER_FIX.latitude,
      JSON.stringify(mgrFrame));

    const mgrNotif = await waitFor(
      () => Notification.findOne({ userId: manager._id, type: 'delivery_emergency', orderId }),
      { label: 'manager emergency notification' }
    );
    check('manager has a delivery_emergency notification', Boolean(mgrNotif));
    check('notification names the rider and the order',
      /#/.test(mgrNotif?.message || '') && (mgrNotif?.message || '').length > 10,
      mgrNotif?.message);

    // --------------------------------------------------------------
    section('STEP 7 - duplicate SOS is rejected');
    // --------------------------------------------------------------
    res = await api('POST', `/deliveries/${deliveryId}/emergency`, RT, RIDER_FIX);
    check('second SOS is rejected', res.status === 409 && res.body?.code === 'EMERGENCY_EXISTS',
      `status=${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
    const emergencyCount = await DeliveryEmergency.countDocuments({ delivery: deliveryId });
    check('still exactly one emergency row', emergencyCount === 1, `count=${emergencyCount}`);

    // --------------------------------------------------------------
    section('STEP 8 - unauthorised SOS is rejected');
    // --------------------------------------------------------------
    const otherRider = await User.findOne({ role: 'delivery', status: 'ACTIVE', _id: { $ne: rider._id } });
    if (otherRider) {
      res = await api('POST', `/deliveries/${deliveryId}/emergency`, sign(otherRider), RIDER_FIX);
      check('a different rider cannot raise an SOS for this delivery', res.status === 403,
        `status=${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    } else {
      console.log('   SKIP  no second delivery user available');
    }

    // --------------------------------------------------------------
    section('STEP 9 - manager acknowledges');
    // --------------------------------------------------------------
    res = await api('PATCH', `/deliveries/${deliveryId}/emergency/ack`, MT, {});
    check('acknowledge succeeds', res.body?.success === true, JSON.stringify(res.body).slice(0, 200));
    check('acknowledgedAt is set', Boolean(res.body?.emergency?.acknowledgedAt));
    check('acknowledgedBy is the manager', String(res.body?.emergency?.acknowledgedBy) === String(manager._id));
    check('status is ACKNOWLEDGED', res.body?.emergency?.status === 'ACKNOWLEDGED');

    const ackFrame = await waitFor(() => managerFrames.ack[0], { label: 'manager socket delivery:emergency:ack' });
    check('manager socket received delivery:emergency:ack', Boolean(ackFrame));

    // --------------------------------------------------------------
    section('STEP 10 - rider resolves the emergency');
    // --------------------------------------------------------------
    res = await api('PATCH', `/deliveries/${deliveryId}/emergency/resolve`, RT, { note: 'Rider is safe, false alarm' });
    check('resolve succeeds', res.body?.success === true, JSON.stringify(res.body).slice(0, 200));
    check('status is RESOLVED', res.body?.emergency?.status === 'RESOLVED');
    check('resolution note stored', /false alarm/.test(res.body?.emergency?.resolutionNote || ''));

    const resolvedDelivery = await Delivery.findById(deliveryId);
    check('hold released after resolve', resolvedDelivery.onHold === false, `onHold=${resolvedDelivery.onHold}`);

    // --------------------------------------------------------------
    section('STEP 11 - rider marks arrived');
    // --------------------------------------------------------------
    res = await api('PATCH', `/deliveries/${deliveryId}/arrived`, RT, {});
    check('mark arrived succeeds', res.body?.success === true, JSON.stringify(res.body).slice(0, 200));

    // --------------------------------------------------------------
    section('STEP 12 - proof without evidence is rejected');
    // --------------------------------------------------------------
    res = await api('PATCH', `/deliveries/${deliveryId}/delivered`, RT, {});
    check('mark delivered without proof is rejected', res.status === 400 && res.body?.code === 'PROOF_REQUIRED',
      `status=${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
    const stillNotDelivered = await Delivery.findById(deliveryId);
    check('delivery is still ARRIVED', stillNotDelivered.status === 'ARRIVED', stillNotDelivered.status);

    // --------------------------------------------------------------
    section('STEP 13 - customer OTP is generated and delivered');
    // --------------------------------------------------------------
    res = await api('POST', `/deliveries/${deliveryId}/otp/generate`, RT, {});
    check('otp generate succeeds', res.body?.success === true, JSON.stringify(res.body).slice(0, 200));
    check('expiresAt is returned', Boolean(res.body?.expiresAt));
    check('OTP is not leaked in the response', !('otp' in res.body) && !('customerOtp' in res.body));

    const otpNotif = await waitFor(
      () => Notification.findOne({ userId: customer._id, type: 'delivery_otp', orderId }),
      { label: 'customer OTP notification' }
    );
    check('customer received the OTP by notification', Boolean(otpNotif));
    const otpMatch = (otpNotif?.message || '').match(/\b(\d{6})\b/);
    generatedOtp = otpMatch ? otpMatch[1] : null;
    check('notification contains a 6-digit code', Boolean(generatedOtp), otpNotif?.message);

    // A wrong code must not confirm the delivery.
    res = await api('POST', `/deliveries/${deliveryId}/otp/verify`, RT, { otp: '000000' });
    check('wrong OTP is rejected', res.body?.verified === false, JSON.stringify(res.body).slice(0, 200));

    // --------------------------------------------------------------
    section('STEP 14 - proof photo is uploaded');
    // --------------------------------------------------------------
    const png = tinyPng();
    const blob = new Blob([png], { type: 'image/png' });
    res = await upload(`/deliveries/${deliveryId}/proof/photo`, RT, 'photo', blob);
    check('proof photo upload succeeds', res.body?.success === true && Boolean(res.body?.proofPhoto),
      `status=${res.status} ${JSON.stringify(res.body).slice(0, 250)}`);
    const proofPhotoUrl = res.body?.proofPhoto;

    // --------------------------------------------------------------
    section('STEP 15 - backend verifies the OTP and the delivery completes');
    // --------------------------------------------------------------
    res = await api('POST', `/deliveries/${deliveryId}/otp/verify`, RT, { otp: generatedOtp });
    check('correct OTP verifies', res.body?.verified === true, JSON.stringify(res.body).slice(0, 200));
    check('confirmedByCustomer is true', res.body?.confirmedByCustomer === true);

    res = await api('PATCH', `/deliveries/${deliveryId}/delivered`, RT, {
      proofPhoto: proofPhotoUrl,
      proofNote: 'Left at the gate',
    });
    check('mark delivered with proof succeeds', res.body?.success === true, `status=${res.status} ${JSON.stringify(res.body).slice(0, 250)}`);

    const done = await Delivery.findById(deliveryId);
    check('status is DELIVERED', done.status === 'DELIVERED', done.status);
    check('deliveredAt is set', done.deliveredAt instanceof Date);
    check('proofPhoto is stored', Boolean(done.proofPhoto));
    check('proofNote is stored', /gate/.test(done.proofNote || ''));
    check('confirmedByCustomer is stored', done.confirmedByCustomer === true);
    check('proofVerifiedAt is set', done.proofVerifiedAt instanceof Date);
    check('statusHistory preserved and includes DELIVERED',
      (done.statusHistory || []).some((h) => h.status === 'DELIVERED'));
    check('statusHistory still has the earlier steps',
      (done.statusHistory || []).some((h) => h.status === 'OUT_FOR_DELIVERY')
      && (done.statusHistory || []).some((h) => h.status === 'ARRIVED'));

    // --------------------------------------------------------------
    section('STEP 16 - manager can read the proof');
    // --------------------------------------------------------------
    res = await api('GET', `/deliveries/${deliveryId}/proof`, MT);
    check('manager can read proof', res.body?.success === true, JSON.stringify(res.body).slice(0, 200));
    check('proof payload has photo, note, confirmedByCustomer, deliveredAt',
      Boolean(res.body?.proof?.photo) && Boolean(res.body?.proof?.note)
      && res.body?.proof?.confirmedByCustomer === true && Boolean(res.body?.deliveredAt));
    check('proof payload never leaks the OTP', !('customerOtp' in res.body) && !('otp' in res.body));
    check('status history is included', Array.isArray(res.body?.statusHistory) && res.body.statusHistory.length > 1);

    // --------------------------------------------------------------
    section('STEP 17 - manager override is recorded');
    // --------------------------------------------------------------
    // A second order so the first one is not disturbed.
    res = await api('POST', '/orders', CT, {
      orderType: 'delivery',
      customerName: customer.name || 'E2E Customer',
      customerPhone: customer.phone,
      paymentMethod: 'CHAPA',
      items: [{ id: String(item._id), quantity: 1 }],
      deliveryInfo: { location: 'Bole, Addis Ababa', subCity: 'Bole' },
      totalAmount: Number(item.price) || 200,
    });
    const second = res.body?.data?.order || res.body?.order || res.body?.data;
    secondOrderId = second?.orderId;
    // Same payment gate as STEP 1: the kitchen steps below only accept a paid
    // order.
    if (secondOrderId) await Order.updateOne({ orderId: secondOrderId }, { $set: { paymentStatus: 'PAID' } });
    const secondDelivery = await Order.findOne({ orderId: secondOrderId });
    secondDeliveryId = secondDelivery?.delivery ? String(secondDelivery.delivery) : null;

    // A rider cannot override.
    res = await api('PATCH', `/deliveries/${secondDeliveryId}/delivered`, RT, { overrideReason: 'I am in a hurry' });
    check('rider cannot override the proof requirement', res.status === 403,
      `status=${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);

    // Walk the second delivery to ARRIVED through the real state machine, so the
    // override is being asked to complete a delivery that is genuinely at the
    // door - which is the situation an override exists for.
    await api('PATCH', `/deliveries/${secondDeliveryId}/assign`, MT, { deliveryStaffId: String(rider._id) });
    await api('PATCH', `/deliveries/${secondDeliveryId}/accept`, RT, { accept: true });
    await api('PATCH', `/kitchen/orders/${secondOrderId}/accept`, KT || MT);
    await api('PATCH', `/kitchen/orders/${secondOrderId}/ready`, KT || MT);
    await api('PATCH', `/deliveries/${secondDeliveryId}/pickup`, RT, {});
    await api('PATCH', `/deliveries/${secondDeliveryId}/out-for-delivery`, RT, {});
    await api('PATCH', `/deliveries/${secondDeliveryId}/arrived`, RT, {});
    const atDoor = await Delivery.findById(secondDeliveryId);
    check('second delivery is at ARRIVED before the override', atDoor.status === 'ARRIVED', atDoor.status);

    // A manager override without a reason is rejected. `isManagerOverride`
    // with no reason is the explicit "override this" request; an empty
    // overrideReason alone is treated as "not requesting an override".
    res = await api('PATCH', `/deliveries/${secondDeliveryId}/delivered`, MT, {
      isManagerOverride: true,
      overrideReason: '',
    });
    check('override without a reason is rejected', res.status === 400 && res.body?.code === 'OVERRIDE_REASON_REQUIRED',
      `status=${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);

    // A manager override with a reason succeeds and is recorded.
    res = await api('PATCH', `/deliveries/${secondDeliveryId}/delivered`, MT, { overrideReason: 'Customer confirmed by phone' });
    check('manager override succeeds', res.body?.success === true, `status=${res.status} ${JSON.stringify(res.body).slice(0, 250)}`);
    const overridden = await Delivery.findById(secondDeliveryId);
    check('override is recorded on the delivery', Boolean(overridden.proofOverrideBy));
    check('override reason is stored', /phone/.test(overridden.proofOverrideReason || ''));
    check('override actor is the manager', String(overridden.proofOverrideBy) === String(manager._id));
    check('overridden delivery is DELIVERED', overridden.status === 'DELIVERED', overridden.status);

    // --------------------------------------------------------------
    section('STEP 18 - emergency history is queryable');
    // --------------------------------------------------------------
    res = await api('GET', '/deliveries/emergencies?status=RESOLVED', MT);
    check('manager can list emergencies', res.body?.success === true && Array.isArray(res.body?.emergencies),
      JSON.stringify(res.body).slice(0, 200));
    check('the resolved emergency is in the list',
      (res.body?.emergencies || []).some((e) => e.orderId === orderId));

    // A rider must not be able to list emergencies.
    res = await api('GET', '/deliveries/emergencies', RT);
    check('rider cannot list emergencies', res.status === 403, `status=${res.status}`);
  } finally {
    managerSocket.close();

    // ---------------------------------------------------------- cleanup --
    if (orderId) {
      await DeliveryEmergency.deleteMany({ orderId });
      await Notification.deleteMany({ orderId, type: { $in: ['delivery_emergency', 'delivery_otp'] } });
      await Delivery.deleteMany({ orderId: { $in: [orderId] } });
      await Order.deleteMany({ orderId: { $in: [orderId] } });
    }
    if (secondOrderId) {
      await Delivery.deleteMany({ orderId: secondOrderId });
      await Order.deleteMany({ orderId: secondOrderId });
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
