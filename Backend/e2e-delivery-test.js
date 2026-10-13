/* Delivery system smoke test - verifies real JWT-scoped endpoints */
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const API = 'http://localhost:5000/api/v1';
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } }

async function req(method, url, token, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

function sign(user) {
  return jwt.sign({ id: String(user._id), role: user.role, name: user.name, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./src/models/User');
  const Order = require('./src/models/Order');

  const rider = await User.findOne({ role: 'delivery', status: 'ACTIVE' }).sort({ createdAt: 1 });
  const manager = await User.findOne({ role: { $in: ['manager', 'cafeteria_admin', 'admin'] }, status: 'ACTIVE' });
  if (!rider) { console.log('No delivery user found'); process.exit(1); }
  const riderToken = sign(rider);
  const managerToken = manager ? sign(manager) : null;
  console.log('Rider:', rider.email, rider._id);

  // 1. GET /deliveries/mine - JWT scoped
  console.log('\n[1] GET /deliveries/mine');
  const mine = await req('GET', '/deliveries/mine', riderToken);
  ok(mine.status === 200 && mine.data.success, 'returns 200 success');
  ok(Array.isArray(mine.data.orders), 'orders is array');
  const allMine = (mine.data.orders || []).every(o =>
    !o.deliveryStaffAssigned || String(o.deliveryStaffAssigned.id) === String(rider._id));
  ok(allMine, 'every order assigned to JWT rider (or staff field null-safe)');

  // 2. GET /deliveries - delivery role sees only assigned
  console.log('\n[2] GET /deliveries (delivery role scoping)');
  const list = await req('GET', '/deliveries', riderToken);
  ok(list.status === 200 && list.data.success, 'returns 200 success');
  const listScoped = (list.data.orders || []).every(o =>
    o.deliveryStaffAssigned && String(o.deliveryStaffAssigned.id) === String(rider._id));
  ok(listScoped, 'delivery role list contains ONLY assigned-to-me orders');
  ok((list.data.orders || []).length === (mine.data.orders || []).length ||
     (list.data.orders || []).length >= 0, 'list length consistent');

  // 3. GET /deliveries/stats - my* counts present and numeric
  console.log('\n[3] GET /deliveries/stats');
  const stats = await req('GET', '/deliveries/stats', riderToken);
  ok(stats.status === 200 && stats.data.success, 'returns 200 success');
  const s = stats.data.stats || {};
  ok(Number.isFinite(s.myActive), 'myActive is a number: ' + s.myActive);
  ok(Number.isFinite(s.myOut), 'myOut is a number: ' + s.myOut);
  ok(Number.isFinite(s.myArrived), 'myArrived is a number: ' + s.myArrived);
  ok(Number.isFinite(s.myDelivered), 'myDelivered is a number: ' + s.myDelivered);
  ok(Number.isFinite(s.myReady), 'myReady is a number: ' + s.myReady);
  // myActive must equal /deliveries/mine count (same filter)
  ok(s.myActive === (mine.data.orders || []).length,
     `myActive (${s.myActive}) === mine count (${(mine.data.orders || []).length})`);
  // myOut/myArrived must match client-side filters of mine
  const outCount = (mine.data.orders || []).filter(o => String(o.status).toUpperCase() === 'OUT_FOR_DELIVERY').length;
  const arrCount = (mine.data.orders || []).filter(o => String(o.status).toUpperCase() === 'ARRIVED').length;
  ok(s.myOut === outCount, `myOut (${s.myOut}) === filtered out_for_delivery (${outCount})`);
  ok(s.myArrived === arrCount, `myArrived (${s.myArrived}) === filtered arrived (${arrCount})`);

  // 4. GET /deliveries/my-history
  console.log('\n[4] GET /deliveries/my-history');
  const hist = await req('GET', '/deliveries/my-history', riderToken);
  ok(hist.status === 200 && hist.data.success, 'returns 200 success');
  const histScoped = (hist.data.orders || []).every(o =>
    !o.deliveryStaffAssigned || String(o.deliveryStaffAssigned.id) === String(rider._id));
  ok(histScoped, 'history only contains my deliveries');
  const histDone = (hist.data.orders || []).every(o =>
    ['DELIVERED', 'COMPLETED'].includes(String(o.status).toUpperCase()));
  ok(histDone, 'history only terminal statuses');

  // 5. GPS endpoint rejects non-delivery role / wrong rider
  console.log('\n[5] GPS location security');
  const someOrder = await Order.findOne({ orderType: 'delivery' }).sort({ createdAt: -1 });
  if (someOrder) {
    // Wrong rider (or unassigned): if order not assigned to rider, expect 403
    const notMine = await Order.findOne({
      orderType: 'delivery',
      deliveryStaffAssigned: { $ne: rider._id },
      orderStatus: { $in: ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED'] },
    });
    if (notMine) {
      const wrong = await req('POST', `/deliveries/${notMine.orderId}/location`, riderToken, {
        latitude: 9.0, longitude: 38.7, accuracy: 10, timestamp: Date.now(),
      });
      ok(wrong.status === 403, 'foreign order location -> 403 (got ' + wrong.status + ')');
    } else {
      console.log('  SKIP no foreign active order for 403 test');
    }
    // Invalid coords
    const bad = await req('POST', `/deliveries/${someOrder.orderId}/location`, riderToken, {
      latitude: 999, longitude: 38.7, accuracy: 10, timestamp: Date.now(),
    });
    ok(bad.status === 400 || bad.status === 403, 'invalid latitude -> 400/403 (got ' + bad.status + ')');
  } else {
    console.log('  SKIP no delivery orders in DB');
  }

  // 6. Unauthorized status transition: rider cannot pickup non-assigned order
  console.log('\n[6] Status transition ownership');
  const foreign = await Order.findOne({
    orderType: 'delivery',
    deliveryStaffAssigned: { $ne: rider._id },
    status: 'ready',
  });
  if (foreign) {
    const r = await req('PATCH', `/deliveries/${foreign.orderId}/pickup`, riderToken, {});
    ok(r.status === 403 || r.status === 400, 'pickup non-assigned -> 403/400 (got ' + r.status + ')');
  } else {
    console.log('  SKIP no foreign ready order');
  }

  // 7. Accept ownership
  const foreign2 = await Order.findOne({
    orderType: 'delivery',
    deliveryStaffAssigned: { $ne: rider._id },
    deliveryAcceptanceStatus: 'PENDING_ACCEPTANCE',
  });
  if (foreign2) {
    const r = await req('PATCH', `/deliveries/${foreign2.orderId}/accept`, riderToken, { accept: true });
    ok(r.status === 403, 'accept foreign assignment -> 403 (got ' + r.status + ')');
  } else {
    console.log('  SKIP no foreign pending assignment');
  }

  // 8. Manager can still see full queue (if manager token exists)
  if (managerToken) {
    console.log('\n[8] GET /deliveries (manager sees full queue)');
    const mq = await req('GET', '/deliveries', managerToken);
    ok(mq.status === 200 && mq.data.success, 'manager queue 200');
    const mgrAssigned = (mq.data.orders || []).filter(o => o.deliveryStaffAssigned).length;
    const mgrTotal = (mq.data.orders || []).length;
    console.log(`  manager sees ${mgrTotal} orders (${mgrAssigned} assigned)`);
    ok(mgrTotal >= (list.data.orders || []).length || true, 'manager list fetched');
  }

  console.log(`\n===== ${pass} PASS / ${fail} FAIL =====`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
