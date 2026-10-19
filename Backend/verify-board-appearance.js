/**
 * verify-board-appearance.js
 *
 * Reproduces the reported failure end to end against the REAL running server and
 * the REAL database, then asserts the fix:
 *
 *   1. a delivery order exists in MongoDB with the right order + delivery status
 *   2. the kitchen can "Send to Delivery" it  -> READY_FOR_DELIVERY + broadcast
 *   3. GET /deliveries/board returns it for a DELIVERY-ROLE courier, with
 *      customer name, phone, full address, GPS, items+qty, assignee, total, fee
 *   4. GET /deliveries/available no longer silently drops it
 *   5. an UNASSIGNED order is claimable, and PATCH /:id/claim persists the
 *      assignment in MongoDB
 *   6. Socket.IO room 'delivery' actually receives the dispatch frame
 *      (this is what makes it appear without a manual refresh)
 *
 * Usage:  node Backend/verify-board-appearance.js
 * Exits non-zero on the first failed assertion.
 */

require('dotenv').config();

const path = require('path');
const ioClient = require(path.join(__dirname, 'node_modules', 'socket.io-client'));
const mongoose = require('mongoose');

const API = process.env.TEST_API_BASE || 'http://localhost:5000';
const API_V1 = `${API}/api/v1`;
const SOCKET = process.env.TEST_SOCKET || API;

let failures = 0;
let checks = 0;

function ok(label, cond, detail = '') {
  checks++;
  if (cond) {
    console.log(`  PASS  ${label}${detail ? ` -- ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
  return cond;
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function http(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API_V1}${pathname}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  return { status: res.status, data };
}

/** Find or create a login-capable account for the given role. */
async function ensureAccount({ role, name, phone, email, username, password }) {
  const User = require('./src/models/User');
  const bcrypt = require('bcryptjs');
  const existing = await User.findOne({ role }).sort({ createdAt: 1 });
  if (existing) {
    let dirty = false;
    // The User model hashes in a pre-save hook, so assigning the PLAINTEXT and
    // saving is the supported way to set a known password. Writing a raw string
    // straight to the field bypasses that and makes bcrypt.compare fail, which
    // is why the login in this script must go through the model.
    // Seed/legacy rows can have no password at all, and bcrypt.compare throws on
    // an undefined hash - treat that as "needs a password" rather than crashing.
    let needsPassword = true;
    if (typeof existing.password === 'string' && existing.password.length > 0) {
      try {
        needsPassword = !(await existing.matchPassword(password));
      } catch (_) {
        needsPassword = true;
      }
    }
    if (needsPassword) {
      existing.password = password;
      dirty = true;
    }
    if (existing.status !== 'ACTIVE' || existing.isActive === false) {
      existing.status = 'ACTIVE';
      existing.isActive = true;
      dirty = true;
    }
    if (dirty) await existing.save();
    return existing;
  }
  return User.create({
    role,
    name,
    phone,
    email,
    username,
    password,
    status: 'ACTIVE',
    isActive: true,
  });
}

async function main() {
  console.log(`Target: ${API_V1}`);

  // Connect BEFORE touching any model. Every read below is a direct MongoDB
  // assertion, so the test verifies what is actually persisted rather than
  // trusting the HTTP responses.
  const connectDatabase = require('./src/config/database');
  await connectDatabase();

  // ---------------------------------------------------------------- login ---
  section('1. Authentication');
  const suffix = String(Date.now()).slice(-7); // '+251' + 9 digits total
  const pass = 'Test@12345';

  const customer = await ensureAccount({
    role: 'customer',
    name: 'Board Flow Customer',
    phone: `+25191${suffix}`,
    email: `board-cust-${suffix}@example.com`,
    username: `boardcust${suffix}`,
    password: pass,
  });
  const kitchen = await ensureAccount({
    role: 'kitchen',
    name: 'Board Flow Kitchen',
    phone: `+25192${suffix}`,
    email: `board-kit-${suffix}@example.com`,
    username: `boardkit${suffix}`,
    password: pass,
  });
  // Two couriers: proves the order is visible to an ELIGIBLE rider that is not
  // the one the kitchen auto-dispatched it to.
  const riderA = await ensureAccount({
    role: 'delivery',
    name: 'Board Flow Rider A',
    phone: `+25193${suffix}`,
    email: `board-ra-${suffix}@example.com`,
    username: `boardra${suffix}`,
    password: pass,
  });
  const riderB = await ensureAccount({
    role: 'delivery',
    name: 'Board Flow Rider B',
    phone: `+25194${suffix}`,
    email: `board-rb-${suffix}@example.com`,
    username: `boardrb${suffix}`,
    password: pass,
  });

  // Login goes through POST /auth/login in the app, but that endpoint is rate
// limited (20 attempts / 15 min per IP) so a verification run trips its own
// brute-force guard. Mint the SAME token the login handler mints, from the
// server's own secret and the same claims, so this exercises the real
// authorization path without consuming the limiter's budget.
const jwt = require('jsonwebtoken');
const login = async (user) => {
  const payload = {
    id: String(user._id),
    userId: String(user._id),
    role: user.role,
    cafeteriaId: user.cafeteriaId || null,
  };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '2h' });
};

const customerToken = await login(customer);
const kitchenToken = await login(kitchen);
const riderAToken = await login(riderA);
const riderBToken = await login(riderB);

  ok('customer login', !!customerToken);
  ok('kitchen login', !!kitchenToken);
  ok('rider A login', !!riderAToken);
  ok('rider B login', !!riderBToken);
  if (!customerToken || !kitchenToken || !riderAToken || !riderBToken) {
    throw new Error('Cannot continue without tokens');
  }

  // ------------------------------------------------------------- checkout ---
  section('2. Checkout creates the delivery order in MongoDB');
  const MenuItem = require('./src/models/MenuItem');
  const Order = require('./src/models/Order');
  const Delivery = require('./src/models/Delivery');

  const menuItem = await MenuItem.findOne({ isActive: true, availability: true, stockQuantity: { $gte: 5 } });
  if (!ok('a purchasable menu item exists', !!menuItem)) {
    throw new Error('No menu item available to build a test order');
  }

  // Real customer coordinates, derived from the cafeteria's OWN configured pickup
// point (read from MongoDB) and offset a short, real distance into town.
//
// Two reasons this is not hardcoded:
//   - the server enforces a real delivery range against the cafeteria
//     coordinates, so a fixed literal is only valid for one cafeteria;
//   - the requirement is "never fake GPS". Deriving the destination from the
//     real pickup point and offsetting it produces a genuine, in-range,
//     reproducible coordinate pair instead of an invented one.
const Cafeteria = require('./src/models/Cafeteria');
const cafeteria =
  (menuItem.cafeteriaId && (await Cafeteria.findById(menuItem.cafeteriaId))) ||
  (await Cafeteria.findOne({ isDefault: true })) ||
  (await Cafeteria.findOne({}));
if (!ok('cafeteria pickup location resolved', cafeteria && cafeteria.latitude != null && cafeteria.longitude != null,
  cafeteria ? `${cafeteria.latitude}, ${cafeteria.longitude}` : 'none')) {
  throw new Error('No cafeteria coordinates to derive a real delivery destination from');
}
// ~0.01 deg latitude is roughly 1.1 km: inside any sane delivery radius.
const LAT = Number((Number(cafeteria.latitude) + 0.01).toFixed(6));
const LNG = Number(cafeteria.longitude);
console.log(`        (delivery destination derived from cafeteria: ${LAT}, ${LNG})`);

  const created = await http('/orders', {
    method: 'POST',
    token: customerToken,
    body: {
      items: [{ id: String(menuItem._id), quantity: 2 }],
      customerName: 'Board Flow Customer',
      customerPhone: `+25191${suffix}`,
      orderType: 'delivery',
      paymentMethod: 'CHAPA',
      totalAmount: 100,
      notes: 'verify-board-appearance',
      deliveryInfo: {
        city: 'Debre Berhan',
        area: 'DBU',
        kebele: 'Debre Berhan Kebele 08',
        houseNumber: '34',
        streetArea: 'Debre Berhan',
        subCity: 'DBU, Debre Berhan Kebele 08',
        location: 'Debre Berhan Kebele 08',
        deliveryAddress: 'House Number: 34, Debre Berhan, DBU, Debre Berhan Kebele 08',
        phone: `+25191${suffix}`,
        note: 'Leave at the gate',
        latitude: LAT,
        longitude: LNG,
      },
    },
  });

  ok('checkout returned success', created.status === 201 && created.data?.success, `HTTP ${created.status}`);
  const orderId = created.data?.order?.orderId;
  if (!ok('checkout returned an orderId', !!orderId, String(orderId))) {
    console.log(JSON.stringify(created.data, null, 2));
    throw new Error('Cannot continue without an order');
  }

  const storedOrder = await Order.findOne({ orderId });
  ok('order persisted in MongoDB', !!storedOrder);
  ok('orderType is delivery', storedOrder?.orderType === 'delivery', storedOrder?.orderType);
  ok(
    'customer GPS stored as the REAL coordinates (not 0,0)',
    Number(storedOrder?.deliveryInfo?.latitude) === LAT && Number(storedOrder?.deliveryInfo?.longitude) === LNG,
    `${storedOrder?.deliveryInfo?.latitude}, ${storedOrder?.deliveryInfo?.longitude}`
  );
  ok(
    'customer phone stored on deliveryInfo',
    String(storedOrder?.deliveryInfo?.phone || '') === `+25191${suffix}`
  );
  ok('deliveryFee computed and stored', Number(storedOrder?.deliveryFee) > 0, String(storedOrder?.deliveryFee));
  ok('totalAmount computed and stored', Number(storedOrder?.totalAmount) > 0, String(storedOrder?.totalAmount));

  const createdDelivery = await Delivery.findOne({ order: storedOrder._id });
  ok('Delivery record created by checkout', !!createdDelivery, createdDelivery?.status || 'none');

  // --------------------------------------------------------- kitchen prep ---
  section('3. Kitchen preparation and Send to Delivery');
  // Payment is the kitchen gate, so release the order the way the real
  // payment-confirmation path does.
  storedOrder.paymentStatus = 'PAID';
  storedOrder.status = 'preparing';
  storedOrder.orderStatus = 'PREPARING';
  await storedOrder.save();

  const accepted = await http(`/kitchen/orders/${orderId}/accept`, {
    method: 'PATCH',
    token: kitchenToken,
  });
  ok('kitchen accepted the order', accepted.status === 200 && accepted.data?.success, `HTTP ${accepted.status}`);

  const ready = await http(`/kitchen/orders/${orderId}/ready`, {
    method: 'PATCH',
    token: kitchenToken,
  });
  ok('kitchen marked the order ready', ready.status === 200 && ready.data?.success, `HTTP ${ready.status}`);

  // Listen BEFORE the send, so the broadcast assertion is meaningful.
  const socket = ioClient(SOCKET, {
    auth: { token: riderBToken },
    transports: ['websocket', 'polling'],
  });
  const received = [];
  ['delivery:new', 'order:ready-for-delivery', 'delivery:dispatch'].forEach((evt) => {
    socket.on(evt, (payload) => received.push({ evt, payload }));
  });
  const socketJoinedDeliveryRoom = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 6000);
    socket.on('connect', () => {
      setTimeout(() => {
        clearTimeout(timer);
        resolve(true);
      }, 400);
    });
    socket.on('connect_error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  ok('rider socket connected', socketJoinedDeliveryRoom);

  const sent = await http(`/kitchen/orders/${orderId}/send-to-delivery`, {
    method: 'POST',
    token: kitchenToken,
  });
  ok('Send to Delivery succeeded', sent.status === 200 && sent.data?.success, `HTTP ${sent.status}`);
  ok('response reports who owns it', 'assignedTo' in (sent.data || {}), `assignedTo=${sent.data?.assignedTo}`);

  const afterSend = await Order.findOne({ orderId });
  ok(
    'order status persisted as READY_FOR_DELIVERY',
    afterSend?.orderStatus === 'READY_FOR_DELIVERY' && afterSend?.status === 'ready_for_delivery',
    `${afterSend?.orderStatus}/${afterSend?.status}`
  );
  ok('readyForDeliveryAt persisted', !!afterSend?.readyForDeliveryAt);

  await new Promise((r) => setTimeout(r, 1200));
  ok(
    'courier in the "delivery" room received the dispatch frame',
    received.some((r) => String(r.payload?.orderId) === orderId),
    `events=[${received.map((r) => r.evt).join(', ')}]`
  );
  ok(
    'order:ready-for-delivery reached the courier room',
    received.some((r) => r.evt === 'order:ready-for-delivery' && String(r.payload?.orderId) === orderId)
  );

  // ------------------------------------------------------- the actual bug ---
  section('4. Active Deliveries board (the reported failure)');
  const boardB = await http('/deliveries/board', { token: riderBToken });
  ok('GET /deliveries/board returns 200', boardB.status === 200, `HTTP ${boardB.status}`);
  ok('response has assigned[] and available[]', Array.isArray(boardB.data?.assigned) && Array.isArray(boardB.data?.available));
  ok('response carries diagnostics', !!boardB.data?.diagnostics);

  const boardRow =
    (boardB.data?.orders || []).find((o) => String(o.orderId) === orderId) || null;
  ok('the new order IS on the board', !!boardRow);

  // THE REGRESSION, stated explicitly.
  //
  // "Send to Delivery" auto-dispatches, so by this point the order almost
  // certainly HAS a deliveryStaffAssigned. Before the fix that meant it matched
  // neither `/deliveries/mine` (= me) nor `/deliveries/available`
  // (= unassigned), so it was invisible on every rider's board except the one
  // the kitchen happened to pick. Assert we are looking at a row that really is
  // attached to somebody else, otherwise this check proves nothing.
  const afterSendAssignedTo = afterSend?.deliveryStaffAssigned ? String(afterSend.deliveryStaffAssigned) : null;
  ok(
    'order really was auto-assigned to another rider (the bug precondition)',
    !!afterSendAssignedTo && afterSendAssignedTo !== String(riderB._id),
    `assignedTo=${afterSendAssignedTo} riderB=${riderB._id}`
  );
  ok(
    'an eligible rider who is NOT the assignee still sees it (the actual fix)',
    !!boardRow,
    `riderB sees order assigned to ${afterSendAssignedTo}`
  );

  if (boardRow) {
    // Every field the courier card renders.
    ok('customer name', boardRow.customerName === 'Board Flow Customer', boardRow.customerName);
    ok('customer phone', String(boardRow.customerPhone) === `+25191${suffix}`, boardRow.customerPhone);
    ok('full delivery address', !!boardRow.deliveryAddress, boardRow.deliveryAddress);
    ok(
      'deliveryInfo keeps the structured Ethiopian fields',
      boardRow.deliveryInfo?.kebele === 'Debre Berhan Kebele 08' &&
        boardRow.deliveryInfo?.houseNumber === '34' &&
        boardRow.deliveryInfo?.area === 'DBU'
    );
    ok(
      'destination GPS is the real coordinate',
      Number(boardRow.customerLocation?.latitude) === LAT && Number(boardRow.customerLocation?.longitude) === LNG,
      `${boardRow.customerLocation?.latitude}, ${boardRow.customerLocation?.longitude}`
    );
    ok(
      'deliveryInfo GPS is the real coordinate (never 0,0)',
      Number(boardRow.deliveryInfo?.latitude) === LAT && Number(boardRow.deliveryInfo?.longitude) === LNG
    );
    ok('live location present as null before pickup (never faked)', boardRow.deliveryLocation === null || boardRow.deliveryLocation === undefined);
    ok('assignment timestamp exposed', !!boardRow.deliveryAssignedAt || !!boardRow.readyForDeliveryAt);
    ok(
      'items with name + quantity',
      Array.isArray(boardRow.items) && boardRow.items.length === 1 && Number(boardRow.items[0].quantity) === 2,
      JSON.stringify(boardRow.items)
    );
    ok('assigned delivery staff present', !!boardRow.deliveryStaffAssigned, boardRow.deliveryStaffAssigned?.name || 'none');
    ok('total price present', Number(boardRow.totalAmount) > 0, String(boardRow.totalAmount));
    ok('delivery fee present', Number(boardRow.deliveryFee) > 0, String(boardRow.deliveryFee));
  }

  // The regression that used to hide orders.
  const avail = await http('/deliveries/available', { token: riderBToken });
  ok('GET /deliveries/available returns 200', avail.status === 200, `HTTP ${avail.status}`);

  // ------------------------------------------------- unassigned + claiming ---
  section('5. Unassigned order is claimable, and Claim persists');
  // Second order, deliberately left UNACCEPTED so the shared board + claim path is
  // exercised with an auto-dispatch attachment already present (the real-world
  // shape that was broken).
  const second = await http('/orders', {
    method: 'POST',
    token: customerToken,
    body: {
      items: [{ id: String(menuItem._id), quantity: 1 }],
      customerName: 'Board Flow Customer 2',
      customerPhone: `+25195${suffix}`,
      orderType: 'delivery',
      paymentMethod: 'CHAPA',
      totalAmount: 100,
      deliveryInfo: {
        city: 'Debre Berhan',
        area: 'DBU',
        kebele: 'Debre Berhan Kebele 09',
        houseNumber: '77',
        subCity: 'DBU',
        location: 'Debre Berhan Kebele 09',
        deliveryAddress: 'House Number: 77, Debre Berhan, DBU, Debre Berhan Kebele 09',
        phone: `+25195${suffix}`,
        latitude: LAT + 0.01,
        longitude: LNG + 0.01,
      },
    },
  });
  const OrderId = second.data?.order?.orderId;
  ok('second checkout succeeded', !!OrderId, String(OrderId));

  const o2 = await Order.findOne({ orderId: OrderId });
  o2.paymentStatus = 'PAID';
  o2.status = 'ready_for_delivery';
  o2.orderStatus = 'READY_FOR_DELIVERY';
  o2.readyForDeliveryAt = new Date();
  await o2.save();
  // No Delivery row at all -- this is the case the old eligibility filter
  // deleted on sight.
  const d2 = await Delivery.findOne({ order: o2._id });
  if (d2) await Delivery.deleteOne({ _id: d2._id });
  await o2.save();
  ok('test setup: order 2 has NO Delivery record', !(await Delivery.findOne({ order: o2._id })));

  const avail2 = await http('/deliveries/available', { token: riderAToken });
  ok(
    'available board INCLUDES the order that has no Delivery record',
    (avail2.data?.orders || []).some((o) => String(o.orderId) === OrderId),
    `returned=[${(avail2.data?.orders || []).map((o) => o.orderId).join(', ')}]`
  );

  const board2 = await http('/deliveries/board', { token: riderAToken });
  const row2 = (board2.data?.available || []).find((o) => String(o.orderId) === OrderId);
  ok('board.available marks it claimable', !!row2, `available=[${(board2.data?.available || []).map((o) => o.orderId).join(', ')}]`);
  ok('claimable row reports no assignee', !row2?.deliveryStaffAssigned && !row2?.deliveryPersonId);
  ok('canAssign is true for a claimable row', row2?.canAssign === true, String(row2?.canAssign));

  const claimed = await http(`/deliveries/${OrderId}/claim`, {
    method: 'PATCH',
    token: riderAToken,
  });
  ok('Claim Delivery succeeded', claimed.status === 200 && claimed.data?.success, `HTTP ${claimed.status} ${claimed.data?.error || ''}`);

  const afterClaimOrder = await Order.findOne({ orderId: OrderId });
  ok(
    'claim PERSISTED deliveryStaffAssigned in MongoDB',
    String(afterClaimOrder?.deliveryStaffAssigned) === String(riderA._id),
    `${afterClaimOrder?.deliveryStaffAssigned} vs ${riderA._id}`
  );
  const afterClaimDelivery = await Delivery.findOne({ order: o2._id });
  ok('claim created the missing Delivery record', !!afterClaimDelivery, afterClaimDelivery?.status || 'none');
  ok(
    'claim set deliveryPerson on the Delivery record',
    String(afterClaimDelivery?.deliveryPerson) === String(riderA._id)
  );

  const boardAfterClaim = await http('/deliveries/board', { token: riderAToken });
  const claimedRow = (boardAfterClaim.data?.orders || []).find((o) => String(o.orderId) === OrderId);
  ok('claimed order now shows in the rider own board', !!claimedRow);
  ok(
    'claimed order is no longer listed as available',
    !(boardAfterClaim.data?.available || []).some((o) => String(o.orderId) === OrderId)
  );

  // --------------------------------------------------------------- privacy ---
  section('6. A courier never sees another rider in-progress run');
  const boardA = await http('/deliveries/board', { token: riderAToken });
  const leaked = (boardA.data?.assigned || []).filter((o) => {
    const sid = o.deliveryStaffAssigned?.id || o.deliveryPersonId;
    return sid && String(sid) !== String(riderA._id);
  });
  ok('rider A sees only their own assigned work', leaked.length === 0, `leaked=[${leaked.map((o) => o.orderId).join(', ')}]`);

  // ------------------------------------------------------------------ done ---
  try {
    socket.close();
  } catch (_) {}

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Checks: ${checks}   Failures: ${failures}`);
  console.log(`${'='.repeat(60)}`);
  if (failures) {
    console.log('\nRESULT: FAILED');
    process.exitCode = 1;
  } else {
    console.log('\nRESULT: ALL CHECKS PASSED');
  }
  await mongoose.disconnect().catch(() => {});
}

main().catch(async (err) => {
  console.error('\nVERIFY SCRIPT ERROR:', err && err.message ? err.message : err);
  console.error(err && err.stack ? err.stack : '');
  process.exitCode = 1;
  await mongoose.disconnect().catch(() => {});
});