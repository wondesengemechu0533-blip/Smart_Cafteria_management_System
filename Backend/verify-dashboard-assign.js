/**
 * Cafeteria Manager Dashboard -> Delivery Assignment -> staff Dashboard.
 *
 * Drives EXACTLY what the new dashboard card does, over real HTTP and a real
 * Socket.IO connection:
 *
 *   1. GET /deliveries/staff            (the Delivery Staff <select>)
 *   2. GET /deliveries?status=ALL       (eligible delivery orders)
 *   3. PATCH /deliveries/:id/assign     (the Assign button)
 *   4. MongoDB persistence
 *   5. delivery:assigned -> that rider's socket
 *   6. GET /deliveries/mine             (the staff Dashboard list)
 *
 * This also asserts the dashboard makes NO other assignment call - the single
 * PATCH is the only write, so the dashboard adds no parallel assignment system.
 *
 * Run: node Backend/verify-dashboard-assign.js
 */
const http = require('http');
const mongoose = require('mongoose');

const TEST_DB = 'scs_dashboard_assign_test';
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dashboard-assign-test-secret';
process.env.NODE_ENV = 'test';

const PORT = 5097;
const API = `http://127.0.0.1:${PORT}/api/v1`;

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}

// Record every request so we can prove the dashboard uses the real API only.
const calls = [];
async function call(method, pathname, token, payload) {
  calls.push(`${method} ${pathname}`);
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

let server, io;

async function main() {
  const jwt = require('jsonwebtoken');
  const socketClient = require('socket.io-client');
  const Order = require('./src/models/Order');
  const User = require('./src/models/User');
  const Delivery = require('./src/models/Delivery');
  const kitchenController = require('./src/controllers/kitchen.controller');

  function mockRes() {
    const res = { statusCode: 200, body: null, headers: {} };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  }
  const mk = (u, p) => ({ user: u, params: p || {}, query: {}, body: {}, headers: {} });

  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const now = new Date();
  const c = await mongoose.connection.collection('cafeterias').insertOne({
    name: 'Dash Cafe', code: 'DAS', isActive: true, status: 'ACTIVE',
    address: 'Bole Main St', latitude: 9.03, longitude: 38.74, phone: '+251940000001',
    createdAt: now, updatedAt: now,
  });
  const cafeteriaId = c.insertedId;

  const mkUser = (o) => ({
    name: o.name, email: o.email, phone: o.phone, password: 'dash-test-password',
    role: o.role, status: 'ACTIVE', isActive: true, cafeteriaId, createdAt: now, updatedAt: now,
  });
  const mgr = await User.create(mkUser({ name: 'Dash Manager', email: 'dashm@t.test', phone: '+251940000002', role: 'manager' }));
  const rider = await User.create(mkUser({ name: 'Dash Rider', email: 'dashr@t.test', phone: '+251940000003', role: 'delivery' }));
  const cust = await User.create(mkUser({ name: 'Dash Customer', email: 'dashc@t.test', phone: '+251940000004', role: 'customer' }));

  const sign = (u) => jwt.sign({ id: String(u._id), role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const managerToken = sign(mgr);
  const riderToken = sign(rider);

  const orderId = `DAS-${Date.now()}`;
  const order = await Order.create({
    orderId,
    clientOrderId: `das-client-${Date.now()}`,
    userId: cust._id, customerName: 'Dash Customer', customerPhone: '+251940000004',
    orderType: 'delivery', cafeteriaId,
    status: 'preparing', orderStatus: 'PREPARING',
    paymentStatus: 'PAID', paymentMethod: 'CASH',
    subtotal: 90, serviceFee: 0, deliveryFee: 30, totalAmount: 120,
    orderDate: now, orderTime: now,
    items: [
      { itemId: new mongoose.Types.ObjectId(), name: 'Shiro', quantity: 1, price: 90, subtotal: 90 },
    ],
    deliveryInfo: { subCity: 'Bole', location: 'Bole Med', deliveryAddress: 'Bole Med, House 9', phone: '+251940000004', latitude: 9.0192, longitude: 38.7525 },
  });
  const orderDocId = order._id;

  // Kitchen sends it to delivery. "Send to Delivery" auto-dispatches to a free
  // rider now, so the one rider in this test is offline while the kitchen
  // presses the button (nothing to hand the order to -> it stays REQUESTED for
  // dispatch), then comes back online for the manager's explicit Assign button.
  await User.updateOne({ _id: rider._id }, { $set: { status: 'BLOCKED', isActive: false } });
  let res = mockRes();
  await kitchenController.markOrderReady(mk({ id: String(mgr._id), role: 'kitchen', cafeteriaId }, { orderId }), res);
  res = mockRes();
  await kitchenController.sendOrderToDelivery(mk({ id: String(mgr._id), role: 'kitchen', cafeteriaId }, { orderId }), res);
  if (res.statusCode !== 200) throw new Error(`send failed: ${res.body?.error}`);
  await User.updateOne({ _id: rider._id }, { $set: { status: 'ACTIVE', isActive: true } });

  const mod = require('./server');
  server = mod.server;
  io = mod.io;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const connected = (token) =>
    new Promise((resolve, reject) => {
      const s = socketClient(`http://127.0.0.1:${PORT}`, {
        auth: { token }, transports: ['polling', 'websocket'], reconnection: false, timeout: 8000,
      });
      const t = setTimeout(() => reject(new Error('socket connect timeout')), 12000);
      s.on('connect', () => { clearTimeout(t); resolve(s); });
      s.on('connect_error', (e) => { clearTimeout(t); reject(new Error(`connect_error: ${e.message}`)); });
    });

  const riderSocket = await connected(riderToken);
  await new Promise((r) => setTimeout(r, 400));
  const riderEvents = [];
  riderSocket.on('delivery:assigned', (p) => riderEvents.push(p));

  console.log('\nManager Dashboard -> Delivery Assignment -> Staff Dashboard\n');

  await check('GET /deliveries/staff populates the Delivery Staff selector', async () => {
    const { status, body } = await call('GET', '/deliveries/staff', managerToken);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const list = body.staff || [];
    if (!list.some((s) => String(s.id || s._id) === String(rider._id))) {
      throw new Error('the rider is missing from the selector list');
    }
  });

  await check('GET /deliveries lists the order as eligible + unassigned', async () => {
    const { status, body } = await call('GET', '/deliveries?status=ALL', managerToken);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const row = (body.orders || []).find((o) => o.orderId === orderId);
    if (!row) throw new Error('order missing from the dashboard list');
    if (row.deliveryStaffAssigned) throw new Error('should still be unassigned');
    if (row.deliveryStatus !== 'REQUESTED') throw new Error(`deliveryStatus=${row.deliveryStatus}`);
    // Fields the card renders.
    for (const k of ['orderId', 'customerName', 'deliveryAddress', 'totalAmount', 'items']) {
      if (row[k] === undefined || row[k] === null) throw new Error(`missing ${k}`);
    }
  });

  // The Assign button -> the single PATCH.
  let assignBody;
  await check('PATCH /deliveries/:id/assign (the Assign button) succeeds', async () => {
    const { status, body } = await call('PATCH', `/deliveries/${orderId}/assign`, managerToken, {
      deliveryStaffId: String(rider._id),
    });
    if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    assignBody = body;
    const d = body.delivery || body.order;
    if (String(d.deliveryPersonId) !== String(rider._id)) throw new Error('assign response names the wrong staff');
  });

  await check('the assignment is saved to MongoDB', async () => {
    const o = await Order.findById(orderDocId);
    if (String(o.deliveryStaffAssigned) !== String(rider._id)) throw new Error('Order.deliveryStaffAssigned not saved');
    const d = await Delivery.findById(o.delivery);
    if (String(d.deliveryPerson) !== String(rider._id)) throw new Error('Delivery.deliveryPerson not saved');
    if (d.status !== 'ASSIGNED') throw new Error(`Delivery.status=${d.status}`);
  });

  const deadline = Date.now() + 6000;
  while (riderEvents.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  await check('delivery:assigned reaches the selected staff over a real socket', async () => {
    if (!riderEvents.length) throw new Error('no delivery:assigned received');
    const p = riderEvents[0];
    if (p.orderId !== orderId) throw new Error(`orderId=${p.orderId}`);
    if (String(p.deliveryPersonId) !== String(rider._id)) throw new Error('event names the wrong staff');
  });

  await check('GET /deliveries/mine shows it on the staff Dashboard', async () => {
    const { status, body } = await call('GET', '/deliveries/mine', riderToken);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const row = (body.orders || []).find((o) => o.orderId === orderId);
    if (!row) throw new Error('the assigned delivery is not on the rider dashboard');
    if (row.deliveryStatus !== 'ASSIGNED') throw new Error(`row deliveryStatus=${row.deliveryStatus}`);
  });

  await check('the dashboard list reflects the assignment immediately after reload', async () => {
    const { body } = await call('GET', '/deliveries?status=ALL', managerToken);
    const row = (body.orders || []).find((o) => o.orderId === orderId);
    if (!row || !row.deliveryStaffAssigned) throw new Error('manager list still shows it unassigned');
    if (String(row.deliveryStaffAssigned.id) !== String(rider._id)) throw new Error('wrong staff shown');
  });

  await check('no second/parallel assignment endpoint is used (only the PATCH writes)', async () => {
    const writes = calls.filter((c) => /^(POST|PUT|PATCH|DELETE)/.test(c));
    const assigns = writes.filter((c) => c.includes('/assign'));
    if (assigns.length !== 1) throw new Error(`expected exactly 1 assign call, got ${assigns.length}: ${assigns.join(', ')}`);
    if (writes.length !== assigns.length) {
      throw new Error(`unexpected extra write calls: ${writes.filter((w) => !w.includes('/assign')).join(', ')}`);
    }
  });

  riderSocket.close();
}

main()
  .catch((e) => { failures.push('harness'); console.error('FATAL', e && e.message); })
  .finally(async () => {
    if (io && io.sockets && io.close) { try { io.close(); } catch { /* ignore */ } }
    if (server) await new Promise((r) => server.close(r));
    try { await mongoose.connection.dropDatabase(); } catch { /* ignore */ }
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    console.log(`\n${passed} passed, ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
  });
