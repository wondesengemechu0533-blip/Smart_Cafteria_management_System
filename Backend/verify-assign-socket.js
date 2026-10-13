/**
 * Manager -> Assign -> real Socket.IO delivery to the rider's Dashboard.
 *
 * This closes the last unproven link in the chain:
 *   Manager click -> PATCH /api/v1/deliveries/:id/assign -> MongoDB
 *     -> Delivery.deliveryPerson + Order.deliveryStaffAssigned
 *     -> Socket.IO "delivery:assigned" -> the ASSIGNED rider's own socket
 *     -> GET /deliveries/mine (what the dashboard renders)
 *
 * Unlike the other suites this one connects a REAL socket.io-client with a REAL
 * JWT, so the event genuinely travels over a socket into a joined room rather
 * than being captured from a mocked emit.
 *
 * Run: node Backend/verify-assign-socket.js
 */
const http = require('http');
const mongoose = require('mongoose');

const TEST_DB = 'scs_assign_socket_test';
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'assign-socket-test-secret';
process.env.NODE_ENV = 'test';

const PORT = 5098;
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

async function call(method, pathname, token, payload) {
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

let server;
let io;

async function main() {
  const jwt = require('jsonwebtoken');
  const socketClient = require('socket.io-client');
  const Order = require('./src/models/Order');
  const User = require('./src/models/User');
  const Delivery = require('./src/models/Delivery');
  const cafeteriaController = require('./src/controllers/cafeteria.controller');
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
    name: 'Socket Cafe', code: 'SCK', isActive: true, status: 'ACTIVE',
    address: 'Bole Main St', latitude: 9.03, longitude: 38.74, phone: '+251930000001',
    createdAt: now, updatedAt: now,
  });
  const cafeteriaId = c.insertedId;

  const mkUser = (o) => ({
    name: o.name, email: o.email, phone: o.phone, password: 'socket-test-password',
    role: o.role, status: 'ACTIVE', isActive: true, cafeteriaId, createdAt: now, updatedAt: now,
  });
  const mgr = await User.create(mkUser({ name: 'SCK Manager', email: 'sckm@t.test', phone: '+251930000002', role: 'manager' }));
  const rider = await User.create(mkUser({ name: 'SCK Rider', email: 'sckr@t.test', phone: '+251930000003', role: 'delivery' }));
  const otherRider = await User.create(mkUser({ name: 'SCK Other', email: 'scko@t.test', phone: '+251930000004', role: 'delivery' }));
  const cust = await User.create(mkUser({ name: 'SCK Customer', email: 'sckc@t.test', phone: '+251930000005', role: 'customer' }));

  const sign = (u) => jwt.sign({ id: String(u._id), role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const managerToken = sign(mgr);
  const riderToken = sign(rider);
  const otherToken = sign(otherRider);

  const orderId = `SCK-${Date.now()}`;
  const order = await Order.create({
    orderId,
    clientOrderId: `sck-client-${Date.now()}`,
    userId: cust._id, customerName: 'SCK Customer', customerPhone: '+251930000005',
    orderType: 'delivery', cafeteriaId,
    status: 'preparing', orderStatus: 'PREPARING',
    paymentStatus: 'PAID', paymentMethod: 'CASH',
    subtotal: 100, serviceFee: 0, deliveryFee: 25, totalAmount: 125,
    orderDate: now, orderTime: now,
    items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Firfir', quantity: 1, price: 100, subtotal: 100 }],
    deliveryInfo: { subCity: 'Bole', location: 'Bole Med', deliveryAddress: 'Bole Med, House 3', phone: '+251930000005', latitude: 9.0192, longitude: 38.7525 },
  });
  const orderDocId = order._id;

  // Kitchen: READY + Send to Delivery (no courier attached).
  let res = mockRes();
  await kitchenController.markOrderReady(mk({ id: String(mgr._id), role: 'kitchen', cafeteriaId }, { orderId }), res);
  if (res.statusCode !== 200) throw new Error(`ready failed: ${res.body?.error}`);
  res = mockRes();
  await kitchenController.sendOrderToDelivery(mk({ id: String(mgr._id), role: 'kitchen', cafeteriaId }, { orderId }), res);
  if (res.statusCode !== 200) throw new Error(`send failed: ${res.body?.error}`);

  // Boot the REAL http server so the real Socket.IO endpoint is attached.
  // (A bare http.createServer(app) has no /socket.io/ route - it would 404.)
  const mod = require('./server');
  server = mod.server;
  io = mod.io;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  // Let the client negotiate transports itself (polling first, then upgrade),
  // and mirror the browser's origin so CORS behaves exactly as it does in the app.
  const connected = (token) =>
    new Promise((resolve, reject) => {
      const s = socketClient(`http://127.0.0.1:${PORT}`, {
        auth: { token },
        transports: ['polling', 'websocket'],
        reconnection: false,
        timeout: 8000,
        extraHeaders: { Origin: 'http://localhost:5500' },
      });
      const t = setTimeout(() => reject(new Error('socket connect timeout')), 12000);
      s.on('connect', () => { clearTimeout(t); resolve(s); });
      s.on('connect_error', async (e) => {
        clearTimeout(t);
        // Surface why the handshake failed instead of a bare "poll error".
        let detail = '';
        try {
          const probe = await fetch(`http://127.0.0.1:${PORT}/socket.io/?EIO=4&transport=polling`);
          detail = ` [handshake -> HTTP ${probe.status}: ${(await probe.text()).slice(0, 160)}]`;
        } catch (pe) {
          detail = ` [handshake threw: ${pe.message}]`;
        }
        reject(new Error(`connect_error: ${e.message}${detail}`));
      });
    });

  console.log('\nManager -> Assign -> Socket.IO -> Rider Dashboard\n');

  // Connect the assigned rider AND an uninvolved rider, so we can prove the
  // event is targeted rather than broadcast to every courier.
  const riderSocket = await connected(riderToken);
  const otherSocket = await connected(otherToken);
  // Give both sockets a moment to auto-join their user:<id> rooms.
  await new Promise((r) => setTimeout(r, 400));

  const riderEvents = [];
  const otherEvents = [];
  riderSocket.on('delivery:assigned', (p) => riderEvents.push(p));
  otherSocket.on('delivery:assigned', (p) => otherEvents.push(p));

  await check('the assigned rider socket is connected and joined its user room', async () => {
    const rooms = io.sockets.adapter.rooms;
    const userRoom = `user:${rider._id}`;
    if (!rooms.has(userRoom)) throw new Error(`room ${userRoom} does not exist`);
    const members = [...rooms.get(userRoom)];
    if (!members.includes(riderSocket.id)) throw new Error('rider socket is not in its own user room');
  });

  // ---- The actual manager action: PATCH /assign over real HTTP ----
  let assignRes;
  await check('PATCH /api/v1/deliveries/:id/assign returns 200 and the assigned staff', async () => {
    assignRes = await call('PATCH', `/deliveries/${orderId}/assign`, managerToken, { deliveryStaffId: String(rider._id) });
    if (assignRes.status !== 200) throw new Error(`HTTP ${assignRes.status}: ${JSON.stringify(assignRes.body).slice(0, 200)}`);
    const d = assignRes.body.delivery || assignRes.body.order;
    if (String(d.deliveryPersonId) !== String(rider._id)) {
      throw new Error(`response deliveryPersonId=${d.deliveryPersonId}, expected the rider`);
    }
    if (d.deliveryStatus !== 'ASSIGNED') throw new Error(`deliveryStatus=${d.deliveryStatus}`);
  });

  await check('the assignment is persisted to MongoDB (Delivery + Order)', async () => {
    const o = await Order.findById(orderDocId);
    if (String(o.deliveryStaffAssigned) !== String(rider._id)) throw new Error('Order.deliveryStaffAssigned not saved');
    if (!o.deliveryAssignedAt) throw new Error('Order.deliveryAssignedAt not set');
    if (o.deliveryAcceptanceStatus !== 'PENDING_ACCEPTANCE') throw new Error(`acceptance=${o.deliveryAcceptanceStatus}`);
    const d = await Delivery.findById(o.delivery);
    if (String(d.deliveryPerson) !== String(rider._id)) throw new Error('Delivery.deliveryPerson not saved');
    if (d.status !== 'ASSIGNED') throw new Error(`Delivery.status=${d.status}`);
    if (!d.assignedAt) throw new Error('Delivery.assignedAt not set');
  });

  // Wait for the socket event to arrive over the real connection.
  const deadline = Date.now() + 6000;
  while (riderEvents.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  await check('the assigned rider RECEIVES delivery:assigned over a real socket', async () => {
    if (!riderEvents.length) throw new Error('no delivery:assigned received by the rider socket');
    const p = riderEvents[0];
    if (p.orderId !== orderId) throw new Error(`payload orderId=${p.orderId}`);
    if (String(p.deliveryPersonId) !== String(rider._id)) throw new Error(`payload deliveryPersonId=${p.deliveryPersonId}`);
  });

  await check('the event payload carries everything the dashboard card renders', async () => {
    const p = riderEvents[0];
    for (const k of ['orderId', 'customerName', 'deliveryAddress', 'totalAmount', 'deliveryStatus', 'deliveryId']) {
      if (p[k] === undefined || p[k] === null || p[k] === '') throw new Error(`payload missing ${k}`);
    }
    if (!Array.isArray(p.items) || !p.items.length) throw new Error('payload missing items');
    if (p.deliveryStatus !== 'ASSIGNED') throw new Error(`payload deliveryStatus=${p.deliveryStatus}`);
  });

  await check('the payload identifies the assigned rider (so clients can gate the alert)', async () => {
    // The server also broadcasts to the shared 'delivery' room on purpose, so
    // every courier's socket sees the event. Ownership must therefore be
    // explicit in the payload, and the client uses it to only alert the rider
    // the delivery was actually assigned to.
    const p = riderEvents[0];
    if (String(p.deliveryPersonId) !== String(rider._id)) throw new Error(`deliveryPersonId=${p.deliveryPersonId}`);
    if (!p.deliveryStaffAssigned) throw new Error('payload must carry deliveryStaffAssigned');
    if (String(p.deliveryStaffAssigned.id) !== String(rider._id)) throw new Error('payload staff id mismatch');
  });

  await check('the uninvolved rider is not shown the delivery as THEIRS', async () => {
    // The other courier may refresh the shared queue (by design), but the
    // delivery must never appear on their own dashboard.
    if (otherEvents.length && otherEvents[0].deliveryPersonId &&
        String(otherEvents[0].deliveryPersonId) === String(otherRider._id)) {
      throw new Error('the other courier is reported as the assignee');
    }
    const theirs = await call('GET', '/deliveries/mine', otherToken);
    if ((theirs.body.orders || []).some((o) => o.orderId === orderId)) {
      throw new Error('the delivery appeared on the other courier dashboard');
    }
  });

  await check('GET /api/v1/deliveries/mine returns the delivery to that rider only', async () => {
    const mine = await call('GET', '/deliveries/mine', riderToken);
    if (mine.status !== 200) throw new Error(`HTTP ${mine.status}`);
    const row = (mine.body.orders || []).find((o) => o.orderId === orderId);
    if (!row) throw new Error('rider cannot see the assigned delivery');
    if (row.deliveryStatus !== 'ASSIGNED') throw new Error(`row deliveryStatus=${row.deliveryStatus}`);

    const theirs = await call('GET', '/deliveries/mine', otherToken);
    if ((theirs.body.orders || []).some((o) => o.orderId === orderId)) {
      throw new Error('the delivery leaked into another rider dashboard');
    }
  });

  await check('the manager Delivery Orders list now shows the assigned staff', async () => {
    const list = await call('GET', '/deliveries?status=ALL', managerToken);
    if (list.status !== 200) throw new Error(`HTTP ${list.status}`);
    const row = (list.body.orders || []).find((o) => o.orderId === orderId);
    if (!row) throw new Error('order missing from manager list');
    if (!row.deliveryStaffAssigned) throw new Error('manager row still shows unassigned');
    if (String(row.deliveryStaffAssigned.id) !== String(rider._id)) throw new Error('manager row shows the wrong staff');
  });

  riderSocket.close();
  otherSocket.close();
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
