/**
 * GPS Tracking End-to-End Test
 *
 * Real device coordinates come from Windows Location API via get-real-gps.ps1
 * (not mocked). Mock coordinates are used ONLY for explicit error-handling cases.
 *
 * Covers: upload → validation → Order.currentLocation → DeliveryLocation history
 * → Socket.IO broadcast → auth/role checks → rate limit → terminal states.
 */
require('dotenv').config();
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io: ioc } = require('socket.io-client');

const PORT = Number(process.env.PORT || 5000);
const HOST = '127.0.0.1';
const JWT_SECRET = process.env.JWT_SECRET;
const GPS_PS1 = path.join(__dirname, 'get-real-gps.ps1');

const results = [];
let pass = 0;
let fail = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Retry wrapper for transient infrastructure failures (Atlas 503
// "Database temporarily unavailable" / ECONNRESET on this link). Retries ONLY
// those retryable signals - a real 4xx assertion result is returned at once,
// so pass/fail semantics of every check are unchanged.
async function apiRetry(method, reqPath, token, body, tries = 4) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await api(method, reqPath, token, body);
      if (r.status !== 503 && !(r.body && r.body.retryable)) return r;
      last = r;
    } catch (e) {
      last = { status: 0, body: { error: e && e.message } };
    }
    await sleep(2500 * (i + 1));
  }
  return last;
}

function api(method, reqPath, token, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HOST, port: PORT, path: reqPath, method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    };
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(d); } catch (e) { json = { raw: d }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body !== undefined && body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

function signToken(user) {
  return jwt.sign(
    { id: String(user._id), role: user.role, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/** Real device fix from Windows Location API (not mocked). */
function getWindowsLocation() {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', GPS_PS1],
      { timeout: 20000 },
      (err, stdout) => {
        if (err) return reject(err);
        const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop();
        if (!line) return reject(new Error('empty location output'));
        const parts = line.split(',').map(s => Number(String(s).trim()));
        const [lat, lng, acc] = parts;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          return reject(new Error('bad location: ' + line));
        }
        resolve({
          latitude: lat,
          longitude: lng,
          accuracy: Number.isFinite(acc) && acc >= 0 ? acc : 50,
          ts: Date.now(),
        });
      }
    );
  });
}

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const socket = ioc('http://' + HOST + ':' + PORT, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    const to = setTimeout(() => { socket.disconnect(); reject(new Error('socket connect timeout')); }, 5000);
    socket.on('connect', () => { clearTimeout(to); resolve(socket); });
    socket.on('connect_error', e => { clearTimeout(to); socket.disconnect(); reject(e); });
  });
}

function emitAck(socket, event, payload, timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) { done = true; resolve({ ok: false, error: 'ack timeout' }); }
    }, timeoutMs);
    socket.emit(event, payload, ack => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(ack || { ok: false, error: 'no ack' });
    });
  });
}

function waitForEvent(socket, event, match, timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  return new Promise(resolve => {
    let done = false;
    const handler = data => {
      if (done) return;
      if (match && !match(data)) return;
      done = true;
      clearTimeout(t);
      socket.off(event, handler);
      resolve(data);
    };
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      socket.off(event, handler);
      resolve(null);
    }, timeoutMs);
    socket.on(event, handler);
  });
}

async function main() {
  if (!JWT_SECRET) {
    console.error('JWT_SECRET missing');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const User = require('./src/models/User');
  const Order = require('./src/models/Order');
  const MenuItem = require('./src/models/MenuItem');
  const DeliveryLocation = require('./src/models/DeliveryLocation');
  const Category = require('./src/models/Category');

  // Sweep leftovers from the previous run: the browser harness order (left
  // ACTIVE on purpose for _e2e_browser.js) plus its tokens summary, and any
  // e2e users that outlived their run. Keeps repeated runs from accumulating
  // test data while still allowing: run test -> run browser harness.
  try {
    const fs = require('fs');
    const Delivery = require('./src/models/Delivery');
    const summaryPath = path.join(__dirname, '_e2e_summary.json');
    if (fs.existsSync(summaryPath)) {
      const prev = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      if (prev.orderId) {
        await DeliveryLocation.deleteMany({ orderId: prev.orderId });
        await Delivery.deleteMany({ orderId: prev.orderId });
        await Order.deleteMany({ orderId: prev.orderId });
      }
      fs.unlinkSync(summaryPath);
      console.log('Removed previous browser-harness order ' + (prev.orderId || '?'));
    }
    const swept = await User.deleteMany({ email: { $regex: '^gps-e2e-' } });
    if (swept.deletedCount) console.log('Removed ' + swept.deletedCount + ' leftover e2e user(s)');
  } catch (e) {
    console.warn('Previous-run cleanup warning:', e.message);
  }

  console.log('Reading real device location (Windows Location API)...');
  let fix1;
  try {
    fix1 = await getWindowsLocation();
    console.log('  Real fix #1: lat=' + fix1.latitude + ' lng=' + fix1.longitude + ' acc=' + fix1.accuracy + 'm');
  } catch (e) {
    console.error('FATAL: could not read real device location:', e.message);
    await mongoose.disconnect();
    process.exit(1);
  }

  const admin = await User.findOne({
    role: 'admin', status: 'ACTIVE', isActive: { $ne: false },
  }).sort({ createdAt: 1 });
  const kitchen = await User.findOne({
    role: 'kitchen', status: 'ACTIVE', isActive: { $ne: false },
  }).sort({ createdAt: 1 });
  if (!admin || !kitchen) {
    console.error('FATAL: need at least one admin and one kitchen user in DB');
    await mongoose.disconnect();
    process.exit(1);
  }

  const stamp = Date.now().toString(36);
  const customer = await User.create({
    name: 'GPS E2E Customer',
    email: 'gps-e2e-cust-' + stamp + '@example.com',
    phone: '+251900000001',
    password: 'TestPass123!',
    role: 'customer',
    status: 'ACTIVE',
    isActive: true,
  });
  const rider = await User.create({
    name: 'GPS E2E Rider',
    email: 'gps-e2e-rider-' + stamp + '@example.com',
    phone: '+251900000002',
    password: 'TestPass123!',
    role: 'delivery',
    status: 'ACTIVE',
    isActive: true,
  });
  const otherRider = await User.create({
    name: 'GPS E2E Other Rider',
    email: 'gps-e2e-rider2-' + stamp + '@example.com',
    phone: '+251900000003',
    password: 'TestPass123!',
    role: 'delivery',
    status: 'ACTIVE',
    isActive: true,
  });
  const stranger = await User.create({
    name: 'GPS E2E Stranger',
    email: 'gps-e2e-stranger-' + stamp + '@example.com',
    phone: '+251900000004',
    password: 'TestPass123!',
    role: 'customer',
    status: 'ACTIVE',
    isActive: true,
  });

  const cTok = signToken(customer);
  const rTok = signToken(rider);
  const r2Tok = signToken(otherRider);
  const aTok = signToken(admin);
  const kTok = signToken(kitchen);
  const sTok = signToken(stranger);

  // Menu item (categoryId is required on MenuItem)
  let item = await MenuItem.findOne({
    stockQuantity: { $gt: 5 },
    isActive: true,
    availabilityStatus: 'AVAILABLE',
  }).lean();
  if (!item) {
    let cat = await Category.findOne({ isActive: true }).lean();
    if (!cat) {
      cat = await Category.create({
        name: { en: 'GPS E2E Cat', am: 'GPS E2E Cat' },
        description: { en: '', am: '' },
        isActive: true,
      });
      cat = cat.toObject();
    }
    const created = await MenuItem.create({
      name: { en: 'GPS E2E Burger', am: 'GPS E2E Burger' },
      description: { en: 'Test item', am: 'Test item' },
      price: 150,
      categoryId: cat._id,
      stockQuantity: 99,
      isActive: true,
      isAvailable: true,
      availability: true,
      availabilityStatus: 'AVAILABLE',
    });
    item = created.toObject();
  }

  const itemPrice = Number(item.price) || 150;
  const itemName = (item.name && (item.name.en || item.name)) || 'Item';

  console.log('Creating delivery order...');
  let r = await api('POST', '/api/v1/orders', cTok, {
    orderType: 'delivery',
    customerName: customer.name,
    customerPhone: customer.phone,
    paymentMethod: 'CHAPA',
    items: [{ id: String(item._id), name: itemName, quantity: 1 }],
    deliveryInfo: { location: '123 GPS Test St', subCity: 'Bole', deliveryAddress: '123 GPS Test St, Bole' },
    totalAmount: itemPrice,
  });
  const orderId = (r.body && r.body.data && r.body.data.orderId)
    || (r.body && r.body.order && r.body.order.orderId)
    || (r.body && r.body.orderId);
  record('STEP 1-2: Create delivery order', Boolean(orderId),
    'status=' + r.status + ' ' + JSON.stringify(r.body).slice(0, 250));
  if (!orderId) {
    await cleanup(null, { customer, rider, otherRider, stranger });
    await mongoose.disconnect();
    process.exit(1);
  }
  // Simulate the completed payment (exactly what the CHAPA verify callback
  // does) so the kitchen's PAID gate lets the pipeline continue. This test
  // exercises GPS, not payments - a CHAPA order is created unpaid because the
  // checkout API cannot be driven through a real provider here.
  await Order.updateOne({ orderId }, { $set: { paymentStatus: 'PAID', paidAt: new Date() } });

  // Kitchen accept → ready
  r = await api('PATCH', '/api/v1/kitchen/orders/' + orderId + '/accept', kTok);
  record('Kitchen accept order', r.status === 200, 'status=' + r.status + ' ' + (r.body && r.body.error));
  r = await api('PATCH', '/api/v1/kitchen/orders/' + orderId + '/ready', kTok);
  record('Kitchen mark ready', r.status === 200, 'status=' + r.status + ' ' + (r.body && r.body.error));

  // Admin assigns rider → rider accepts → pickup → out for delivery
  r = await api('PATCH', '/api/v1/deliveries/' + orderId + '/assign', aTok, { deliveryStaffId: String(rider._id) });
  record('Admin assigns rider', r.status === 200, 'status=' + r.status + ' ' + (r.body && r.body.error));
  r = await api('PATCH', '/api/v1/deliveries/' + orderId + '/accept', rTok, { accept: true });
  record('Rider accepts assignment', r.status === 200, 'status=' + r.status + ' ' + (r.body && r.body.error));
  r = await api('PATCH', '/api/v1/deliveries/' + orderId + '/pickup', rTok);
  record('STEP 2: Rider pickup (PICKED_UP)', r.status === 200, 'status=' + r.status + ' ' + (r.body && r.body.error));
  r = await api('PATCH', '/api/v1/deliveries/' + orderId + '/out-for-delivery', rTok);
  record('Rider out for delivery (OUT_FOR_DELIVERY)', r.status === 200,
    'status=' + r.status + ' ' + (r.body && r.body.error));

  // Socket clients
  console.log('Connecting Socket.IO clients...');
  let custSock = null, adminSock = null, riderSock = null, guestSock = null, strangerSock = null, otherSock = null;
  try {
    custSock = await connectSocket(cTok);
    adminSock = await connectSocket(aTok);
    riderSock = await connectSocket(rTok);
    guestSock = await connectSocket(null);
    strangerSock = await connectSocket(sTok);
    otherSock = await connectSocket(r2Tok);
    record('Socket.IO connect (authenticated)', true);
  } catch (e) {
    record('Socket.IO connect (authenticated)', false, e.message);
  }

  // STEP 11: authorized joins
  if (custSock) {
    const ackOrder = await emitAck(custSock, 'order:join', orderId);
    const ackGps = await emitAck(custSock, 'delivery:join', orderId);
    record('STEP 11: Customer joins order room', ackOrder.ok === true, JSON.stringify(ackOrder));
    record('STEP 11: Customer joins delivery GPS room', ackGps.ok === true, JSON.stringify(ackGps));
  }
  if (riderSock) {
    const ack = await emitAck(riderSock, 'delivery:join', orderId);
    record('Rider joins delivery GPS room', ack.ok === true, JSON.stringify(ack));
  }

  // Unauthorized joins
  if (guestSock) {
    const a1 = await emitAck(guestSock, 'order:join', orderId);
    const a2 = await emitAck(guestSock, 'delivery:join', orderId);
    record('Unauthorized customer (guest) order:join rejected', a1.ok === false, JSON.stringify(a1));
    record('Unauthorized customer (guest) delivery:join rejected', a2.ok === false, JSON.stringify(a2));
  }
  if (strangerSock) {
    const a1 = await emitAck(strangerSock, 'order:join', orderId);
    const a2 = await emitAck(strangerSock, 'delivery:join', orderId);
    record('Unauthorized customer (other user) order:join rejected', a1.ok === false, JSON.stringify(a1));
    record('Unauthorized customer (other user) delivery:join rejected', a2.ok === false, JSON.stringify(a2));
  }
  if (otherSock) {
    const a = await emitAck(otherSock, 'delivery:join', orderId);
    record('Unauthorized delivery person (other rider) delivery:join rejected', a.ok === false, JSON.stringify(a));
  }

  // STEP 6-10: first real GPS upload
  console.log('Uploading real device GPS fix #1...');
  const custGps1 = custSock ? waitForEvent(custSock, 'delivery:location', p => p && p.orderId === orderId, 6000) : null;
  const adminGps1 = adminSock ? waitForEvent(adminSock, 'delivery:location', p => p && p.orderId === orderId, 6000) : null;
  const riderGps1 = riderSock ? waitForEvent(riderSock, 'delivery:location', p => p && p.orderId === orderId, 6000) : null;
  const strangerGps = strangerSock ? waitForEvent(strangerSock, 'delivery:location', null, 3000) : null;

  r = await api('POST', '/api/v1/deliveries/' + orderId + '/location', rTok, {
    latitude: fix1.latitude,
    longitude: fix1.longitude,
    accuracy: fix1.accuracy,
    timestamp: fix1.ts,
  });
  const p1 = r.body && r.body.point;
  record('STEP 6-7: POST real GPS location accepted',
    r.status === 200 && r.body && r.body.success === true,
    'status=' + r.status + ' ' + JSON.stringify(r.body).slice(0, 250));
  record('Response point matches real device fix',
    p1 && p1.latitude === fix1.latitude && p1.longitude === fix1.longitude,
    p1 ? 'lat=' + p1.latitude + ' lng=' + p1.longitude : 'no point');

  const orderAfter1 = await Order.findOne({ orderId }).lean();
  const cl1 = orderAfter1 && orderAfter1.currentLocation;
  record('STEP 8: Order.currentLocation updated',
    cl1 && cl1.latitude === fix1.latitude && cl1.longitude === fix1.longitude,
    JSON.stringify(cl1));

  const hist1 = await DeliveryLocation.find({ orderId }).lean();
  record('STEP 9: DeliveryLocation history created',
    hist1.length >= 1 && hist1[0].latitude === fix1.latitude,
    'count=' + hist1.length);

  const cP1 = custGps1 ? await custGps1 : null;
  const aP1 = adminGps1 ? await adminGps1 : null;
  const rP1 = riderGps1 ? await riderGps1 : null;
  record('STEP 10: Customer receives delivery:location',
    Boolean(cP1 && cP1.latitude === fix1.latitude), JSON.stringify(cP1));
  record('STEP 10: Admin receives delivery:location',
    Boolean(aP1 && aP1.latitude === fix1.latitude), JSON.stringify(aP1));
  record('STEP 10: Assigned rider receives delivery:location',
    Boolean(rP1 && rP1.latitude === fix1.latitude), JSON.stringify(rP1));
  const sP = strangerGps ? await strangerGps : null;
  record('Unauthorized customer does NOT receive GPS broadcast', sP === null, JSON.stringify(sP));

  // STEP 13-14: second real fix (rate limit 3s + duplicate window 5s)
  console.log('Waiting for rate-limit window, then real fix #2...');
  await sleep(5500);
  let fix2;
  try {
    fix2 = await getWindowsLocation();
    console.log('  Real fix #2: lat=' + fix2.latitude + ' lng=' + fix2.longitude + ' acc=' + fix2.accuracy + 'm');
  } catch (e) {
    // Fall back to re-reading failed: use fix1 with later timestamp (same real position)
    fix2 = { latitude: fix1.latitude, longitude: fix1.longitude, accuracy: fix1.accuracy, ts: Date.now() };
  }
  if (Math.abs(fix2.ts - fix1.ts) < 6000) fix2.ts = fix1.ts + 6000;

  const custGps2 = custSock
    ? waitForEvent(custSock, 'delivery:location', p => p && p.orderId === orderId && (!cP1 || p.timestamp !== cP1.timestamp), 6000)
    : null;
  r = await api('POST', '/api/v1/deliveries/' + orderId + '/location', rTok, {
    latitude: fix2.latitude,
    longitude: fix2.longitude,
    accuracy: fix2.accuracy,
    timestamp: fix2.ts,
  });
  const moved = fix2.latitude !== fix1.latitude || fix2.longitude !== fix1.longitude;
  record('STEP 13: Second location update accepted',
    r.status === 200 && r.body && r.body.success === true,
    'status=' + r.status + ' moved=' + moved + ' ' + (r.body && r.body.error));
  const cP2 = custGps2 ? await custGps2 : null;
  record('STEP 14: Customer marker update received without refresh', Boolean(cP2), JSON.stringify(cP2));
  const hist2 = await DeliveryLocation.find({ orderId }).sort({ timestamp: 1 }).lean();
  record('STEP 9: DeliveryLocation history has 2+ points after second update',
    hist2.length >= 2, 'count=' + hist2.length);
  const orderAfter2 = await Order.findOne({ orderId }).lean();
  record('STEP 8: Order.currentLocation updated to latest fix',
    orderAfter2 && orderAfter2.currentLocation && orderAfter2.currentLocation.latitude === fix2.latitude,
    JSON.stringify(orderAfter2 && orderAfter2.currentLocation));

  // --- Error handling (mock coords only here) ---
  console.log('Running error-handling cases...');

  await sleep(3200);
  r = await api('POST', '/api/v1/deliveries/' + orderId + '/location', rTok, {
    latitude: 999, longitude: 999, accuracy: 10, timestamp: Date.now(),
  });
  record('Invalid coordinates (lat 999) rejected 400', r.status === 400, 'status=' + r.status);

  await sleep(3200);
  r = await api('POST', '/api/v1/deliveries/' + orderId + '/location', rTok, {
    latitude: fix1.latitude, longitude: -999, accuracy: 10, timestamp: Date.now(),
  });
  record('Invalid longitude rejected 400', r.status === 400, 'status=' + r.status);

  await sleep(3200);
  r = await api('POST', '/api/v1/deliveries/' + orderId + '/location', rTok, {
    latitude: fix1.latitude, longitude: fix1.longitude, accuracy: -5, timestamp: Date.now(),
  });
  record('Invalid accuracy rejected 400', r.status === 400, 'status=' + r.status);

  // Expired auth
  const expired = jwt.sign(
    { id: String(rider._id), role: rider.role, name: rider.name, email: rider.email },
    JWT_SECRET,
    { expiresIn: '-1s' }
  );
  r = await api('POST', '/api/v1/deliveries/' + orderId + '/location', expired, {
    latitude: fix1.latitude, longitude: fix1.longitude, accuracy: 10, timestamp: Date.now(),
  });
  record('Expired authentication rejected 401', r.status === 401,
    'status=' + r.status + ' ' + (r.body && r.body.error));

  // Missing token
  r = await api('POST', '/api/v1/deliveries/' + orderId + '/location', null, {
    latitude: fix1.latitude, longitude: fix1.longitude, accuracy: 10, timestamp: Date.now(),
  });
  record('Missing token rejected 401', r.status === 401, 'status=' + r.status);

  // Unauthorized delivery person
  await sleep(3200);
  r = await api('POST', '/api/v1/deliveries/' + orderId + '/location', r2Tok, {
    latitude: fix1.latitude, longitude: fix1.longitude, accuracy: 10, timestamp: Date.now(),
  });
  record('Unauthorized delivery person rejected 403', r.status === 403,
    'status=' + r.status + ' ' + (r.body && r.body.error));

  // Unauthorized customer role
  await sleep(3200);
  r = await api('POST', '/api/v1/deliveries/' + orderId + '/location', cTok, {
    latitude: fix1.latitude, longitude: fix1.longitude, accuracy: 10, timestamp: Date.now(),
  });
  record('Unauthorized customer (role) rejected 403', r.status === 403,
    'status=' + r.status + ' ' + (r.body && r.body.error));

  // Rate limit. The 3s window is enforced server-side between the START of two
  // uploads; on a slow DB link a single upload's own writes can exceed 3s, so
  // sequential attempts cannot prove the limiter. Two CONCURRENT uploads are
  // deterministic instead: the first check sets the window, the second lands
  // ~0ms later and must be rejected - regardless of DB speed. (A pre-existing
  // 503 storm retries the whole pair once.)
  await sleep(3200);
  async function rateProbe(suffixA, suffixB) {
    return Promise.all([
      api('POST', '/api/v1/deliveries/' + orderId + '/location', rTok, {
        latitude: fix1.latitude + suffixA, longitude: fix1.longitude, accuracy: 15, timestamp: Date.now(),
      }),
      api('POST', '/api/v1/deliveries/' + orderId + '/location', rTok, {
        latitude: fix1.latitude + suffixB, longitude: fix1.longitude, accuracy: 15, timestamp: Date.now(),
      }),
    ]);
  }
  let pair = await rateProbe(0.0001, 0.0002);
  if (!pair.some((x) => x.status === 200) && pair.some((x) => x.status === 503)) {
    await sleep(5000);
    await sleep(3200);
    pair = await rateProbe(0.0003, 0.0004);
  }
  // Exactly one of the pair is accepted and the other is rate-limited -
  // regardless of which upload the server checked first.
  const codes = pair.map((x) => x.status).sort((a, b) => a - b);
  record('Rate limit rejects the concurrent second update',
    pair.some((x) => x.status === 429) && pair.some((x) => x.status === 200),
    'statuses=' + codes.join(','));

  // Network interruption: simulated client-side (GPS_SEND_FAILED). Server side:
  // unreachable host is not testable while server is up; verify server recovers
  // after a short outage by checking the next valid upload succeeds.
  // (Client maps any fetch failure to GPS_SEND_FAILED - covered in frontend tests.)

  // STEP 15-16: complete delivery
  // The handover needs ARRIVED first (exact-next-transition rule) and proof of
  // delivery (photo / customer OTP / manager override). There is no customer
  // here to show an OTP, so the manager override path is used - the same one a
  // supervisor uses when a customer has already walked away.
  console.log('Completing delivery...');
  await sleep(3200);
  r = await api('PATCH', '/api/v1/deliveries/' + orderId + '/arrived', rTok);
  record('Rider marks ARRIVED', r.status === 200, 'status=' + r.status + ' ' + (r.body && r.body.error));
  r = await api('PATCH', '/api/v1/deliveries/' + orderId + '/delivered', aTok, {
    overrideReason: 'GPS E2E test: no customer present for OTP/photo proof',
  });
  record('STEP 15: Delivery marked delivered/completed', r.status === 200,
    'status=' + r.status + ' ' + (r.body && r.body.error));

  r = await api('POST', '/api/v1/deliveries/' + orderId + '/location', rTok, {
    latitude: fix1.latitude, longitude: fix1.longitude, accuracy: 10, timestamp: Date.now(),
  });
  // Terminal deliveries answer 409 (CONFLICT) explicitly; older flows used 400.
  record('STEP 16: GPS rejected after completion', r.status === 400 || r.status === 409,
    'status=' + r.status + ' ' + (r.body && r.body.error));

  const orderFinal = await Order.findOne({ orderId }).lean();
  record('STEP 16: Order status is terminal after delivery',
    ['COMPLETED', 'DELIVERED'].includes(String(orderFinal && orderFinal.orderStatus).toUpperCase())
    || ['completed', 'delivered'].includes(String(orderFinal && orderFinal.status).toLowerCase()),
    'orderStatus=' + (orderFinal && orderFinal.orderStatus) + ' status=' + (orderFinal && orderFinal.status));

  // --- Cancelled order ---
  console.log('Testing cancelled order GPS rejection...');
  r = await api('POST', '/api/v1/orders', cTok, {
    orderType: 'delivery',
    customerName: customer.name,
    customerPhone: customer.phone,
    paymentMethod: 'CHAPA',
    items: [{ id: String(item._id), name: itemName, quantity: 1 }],
    deliveryInfo: { location: 'Cancel GPS St', subCity: 'Bole' },
    totalAmount: itemPrice,
  });
  const orderId2 = (r.body && r.body.data && r.body.data.orderId)
    || (r.body && r.body.order && r.body.order.orderId)
    || (r.body && r.body.orderId);
  record('Second order created for cancel test', Boolean(orderId2), String(orderId2 || JSON.stringify(r.body).slice(0, 200)));
  if (orderId2) {
    await Order.updateOne({ orderId: orderId2 }, { $set: { paymentStatus: 'PAID', paidAt: new Date() } });
    await api('PATCH', '/api/v1/kitchen/orders/' + orderId2 + '/accept', kTok);
    await api('PATCH', '/api/v1/kitchen/orders/' + orderId2 + '/ready', kTok);
    await api('PATCH', '/api/v1/deliveries/' + orderId2 + '/assign', aTok, { deliveryStaffId: String(rider._id) });
    await api('PATCH', '/api/v1/deliveries/' + orderId2 + '/accept', rTok, { accept: true });
    await api('PATCH', '/api/v1/deliveries/' + orderId2 + '/pickup', rTok);
    await api('PATCH', '/api/v1/deliveries/' + orderId2 + '/out-for-delivery', rTok);

    // Mid-delivery cancel: admin cancel only allows PENDING/PREPARING, kitchen
    // reject only pending/preparing. Use the cancellation service path OR set
    // CANCELLED directly to represent an already-cancelled delivery (the GPS
    // gate must reject regardless of how cancel happened).
    let cancelApiOk = false;
    r = await api('PATCH', '/api/v1/admin/orders/' + orderId2 + '/cancel', aTok, { reason: 'GPS E2E cancel test' });
    cancelApiOk = r.status === 200;
    if (!cancelApiOk) {
      // Try customer cancel
      r = await api('PATCH', '/api/v1/orders/' + orderId2 + '/cancel', cTok, { reason: 'GPS E2E cancel test' });
      cancelApiOk = r.status === 200;
    }
    if (!cancelApiOk) {
      // Mid-delivery: force cancel in DB (cancellation workflow may not allow
      // OUT_FOR_DELIVERY via admin). BOTH records must flip, otherwise the
      // Delivery stays active and GPS would (correctly) keep accepting fixes.
      const upd = await Order.updateOne(
        { orderId: orderId2 },
        { $set: { orderStatus: 'CANCELLED', status: 'cancelled', cancellationReason: 'GPS E2E cancel test' } }
      );
      const Delivery = require('./src/models/Delivery');
      await Delivery.updateOne({ orderId: orderId2 }, { $set: { status: 'CANCELLED' } });
      cancelApiOk = upd.modifiedCount === 1;
      record('Cancel order (direct mid-delivery CANCELLED)', cancelApiOk, 'modified=' + upd.modifiedCount);
    } else {
      record('Cancel order API', true, 'status=' + r.status);
    }

    await sleep(3200);
    r = await api('POST', '/api/v1/deliveries/' + orderId2 + '/location', rTok, {
      latitude: fix1.latitude, longitude: fix1.longitude, accuracy: 10, timestamp: Date.now(),
    });
    // Cancelled / terminal states are rejected explicitly (409 in current
    // flows; 400/403 kept for compatibility with older branches).
    record('GPS rejected for cancelled order', r.status === 400 || r.status === 403 || r.status === 409,
      'status=' + r.status + ' ' + (r.body && r.body.error));
  }

  // Unknown order
  r = await api('POST', '/api/v1/deliveries/NO-SUCH-ORDER/location', rTok, {
    latitude: fix1.latitude, longitude: fix1.longitude, accuracy: 10, timestamp: Date.now(),
  });
  record('Unknown order rejected 404', r.status === 404, 'status=' + r.status);

  // Body identity fields ignored (JWT only) — after completion it is a terminal
  // rejection (409, or 400 on older flows), never 403-as-the-body-identity.
  await sleep(3200);
  r = await api('POST', '/api/v1/deliveries/' + orderId + '/location', rTok, {
    latitude: fix1.latitude, longitude: fix1.longitude, accuracy: 10, timestamp: Date.now(),
    deliveryStaffId: String(otherRider._id),
    staffId: String(otherRider._id),
  });
  record('Body deliveryStaffId ignored (JWT rider still used → terminal 400/409, not 403)',
    r.status === 400 || r.status === 409, 'status=' + r.status);

  // Timestamp validation
  await sleep(3200);
  // Need an active order again for timestamp tests - use orderId2 after un-cancelling? Skip if cancelled.
  // Re-test on a fresh active order:
  r = await apiRetry('POST', '/api/v1/orders', cTok, {
    orderType: 'delivery',
    customerName: customer.name,
    customerPhone: customer.phone,
    paymentMethod: 'CHAPA',
    clientOrderId: 'gps-e2e-ts-' + stamp,
    items: [{ id: String(item._id), name: itemName, quantity: 1 }],
    deliveryInfo: { location: 'TS Test', subCity: 'Bole' },
    totalAmount: itemPrice,
  });
  const orderId3 = (r.body && r.body.data && r.body.data.orderId)
    || (r.body && r.body.order && r.body.order.orderId);
  if (orderId3) {
    await Order.updateOne({ orderId: orderId3 }, { $set: { paymentStatus: 'PAID', paidAt: new Date() } });
    await apiRetry('PATCH', '/api/v1/kitchen/orders/' + orderId3 + '/accept', kTok);
    await apiRetry('PATCH', '/api/v1/kitchen/orders/' + orderId3 + '/ready', kTok);
    await apiRetry('PATCH', '/api/v1/deliveries/' + orderId3 + '/assign', aTok, { deliveryStaffId: String(rider._id) });
    await apiRetry('PATCH', '/api/v1/deliveries/' + orderId3 + '/accept', rTok, { accept: true });
    await apiRetry('PATCH', '/api/v1/deliveries/' + orderId3 + '/pickup', rTok);

    await sleep(3200);
    r = await apiRetry('POST', '/api/v1/deliveries/' + orderId3 + '/location', rTok, {
      latitude: fix1.latitude, longitude: fix1.longitude, accuracy: 10,
      timestamp: Date.now() + 10 * 60 * 1000, // 10 min future
    });
    record('Future timestamp rejected 400', r.status === 400, 'status=' + r.status + ' ' + (r.body && r.body.error));

    await sleep(3200);
    r = await apiRetry('POST', '/api/v1/deliveries/' + orderId3 + '/location', rTok, {
      latitude: fix1.latitude, longitude: fix1.longitude, accuracy: 10,
      timestamp: Date.now() - 48 * 60 * 60 * 1000, // 48h old
    });
    record('Stale timestamp rejected 400', r.status === 400, 'status=' + r.status + ' ' + (r.body && r.body.error));

    // Network interruption recovery: next valid fix succeeds
    await sleep(3200);
    const fix3 = await getWindowsLocation().catch(() => ({ ...fix1, ts: Date.now() }));
    r = await apiRetry('POST', '/api/v1/deliveries/' + orderId3 + '/location', rTok, {
      latitude: fix3.latitude, longitude: fix3.longitude, accuracy: fix3.accuracy, timestamp: fix3.ts,
    });
    record('Recovery after failed sends (valid fix accepted)', r.status === 200 && r.body && r.body.success,
      'status=' + r.status + ' ' + (r.body && r.body.error));
  } else {
    record('Third order for timestamp tests', false, JSON.stringify(r.body).slice(0, 200));
  }

  // --- Prepare the browser-harness order --------------------------------------
  // _e2e_browser.js loads the REAL customer tracking page in Chrome and pushes
  // one more rider fix while the customer watches. It needs an order that is
  // still GPS-active (OUT_FOR_DELIVERY) when this process exits, so this order
  // (and its customer/rider users) are deliberately NOT cleaned up here - the
  // NEXT run's start-of-run sweep removes them.
  console.log('Preparing browser-harness order (left ACTIVE on purpose)...');
  await sleep(3200); // per-rider server rate limit since the recovery upload
  r = await apiRetry('POST', '/api/v1/orders', cTok, {
    orderType: 'delivery',
    customerName: customer.name,
    customerPhone: customer.phone,
    paymentMethod: 'CHAPA',
    clientOrderId: 'gps-e2e-browser-' + stamp,
    items: [{ id: String(item._id), name: itemName, quantity: 1 }],
    deliveryInfo: { location: 'Browser Harness St', subCity: 'Bole', deliveryAddress: 'Browser Harness St, Bole' },
    totalAmount: itemPrice,
  });
  const orderIdBrowser = (r.body && r.body.data && r.body.data.orderId)
    || (r.body && r.body.order && r.body.order.orderId)
    || (r.body && r.body.orderId);
  record('Browser-harness order created', Boolean(orderIdBrowser),
    'status=' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
  if (orderIdBrowser) {
    await Order.updateOne({ orderId: orderIdBrowser }, { $set: { paymentStatus: 'PAID', paidAt: new Date() } });
    const steps = [
      ['accept', await apiRetry('PATCH', '/api/v1/kitchen/orders/' + orderIdBrowser + '/accept', kTok)],
      ['ready', await apiRetry('PATCH', '/api/v1/kitchen/orders/' + orderIdBrowser + '/ready', kTok)],
      ['assign', await apiRetry('PATCH', '/api/v1/deliveries/' + orderIdBrowser + '/assign', aTok, { deliveryStaffId: String(rider._id) })],
      ['rider-accept', await apiRetry('PATCH', '/api/v1/deliveries/' + orderIdBrowser + '/accept', rTok, { accept: true })],
      ['pickup', await apiRetry('PATCH', '/api/v1/deliveries/' + orderIdBrowser + '/pickup', rTok)],
      ['out-for-delivery', await apiRetry('PATCH', '/api/v1/deliveries/' + orderIdBrowser + '/out-for-delivery', rTok)],
    ];
    for (const [name, res] of steps) {
      record('Browser-harness step ' + name, res.status === 200,
        'status=' + res.status + ' ' + (res.body && res.body.error));
    }
    // One stored fix so the page has coordinates to render even before the
    // browser pushes its own frame. Real device position from this run.
    await sleep(3200);
    const fixB = await getWindowsLocation().catch(() => ({ ...fix1, ts: Date.now() }));
    r = await apiRetry('POST', '/api/v1/deliveries/' + orderIdBrowser + '/location', rTok, {
      latitude: fixB.latitude, longitude: fixB.longitude, accuracy: fixB.accuracy, timestamp: fixB.ts,
    });
    record('Browser-harness initial GPS fix stored',
      r.status === 200 && r.body && r.body.success === true,
      'status=' + r.status + ' ' + (r.body && r.body.error));

    const fs = require('fs');
    fs.writeFileSync(
      path.join(__dirname, '_e2e_summary.json'),
      JSON.stringify(
        {
          orderId: orderIdBrowser,
          customerToken: cTok,
          customerUser: {
            id: String(customer._id),
            _id: String(customer._id),
            name: customer.name,
            email: customer.email,
            role: 'customer',
          },
          customerUserId: String(customer._id),
          riderToken: rTok,
          riderUserId: String(rider._id),
          adminToken: aTok,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
    console.log('Wrote _e2e_summary.json for orderId ' + orderIdBrowser);
  }

  for (const s of [custSock, adminSock, riderSock, guestSock, strangerSock, otherSock]) {
    if (s) { try { s.disconnect(); } catch (e) { /* ignore */ } }
  }

  await cleanup(
    { orderIds: [orderId, orderId2, orderId3].filter(Boolean) },
    { customer, rider, otherRider, stranger }
  );
  await mongoose.disconnect();

  console.log('');
  console.log('========== RESULTS ==========');
  console.log('PASS: ' + pass + '  FAIL: ' + fail + '  TOTAL: ' + results.length);
  if (fail) {
    console.log('Failures:');
    results.filter(x => !x.ok).forEach(x => console.log('  FAIL ' + x.name + ': ' + (x.detail || '')));
  }
  process.exit(fail ? 1 : 0);
}

async function cleanup(orders, users) {
  try {
    const User = require('./src/models/User');
    const Order = require('./src/models/Order');
    const Delivery = require('./src/models/Delivery');
    const DeliveryLocation = require('./src/models/DeliveryLocation');
    if (orders && orders.orderIds && orders.orderIds.length) {
      await DeliveryLocation.deleteMany({ orderId: { $in: orders.orderIds } });
      await Delivery.deleteMany({ orderId: { $in: orders.orderIds } });
      await Order.deleteMany({ orderId: { $in: orders.orderIds } });
    }
    if (users) {
      // customer + rider are kept: the browser harness (_e2e_browser.js) still
      // needs their tokens to load the tracking page. The next run's
      // start-of-run sweep deletes them together with that harness order.
      for (const u of [users.otherRider, users.stranger]) {
        if (u && u._id) await User.deleteOne({ _id: u._id });
      }
    }
  } catch (e) {
    console.warn('Cleanup warning:', e.message);
  }
}

main().catch(async e => {
  console.error('FATAL:', e);
  try { await mongoose.disconnect(); } catch (e2) { /* ignore */ }
  process.exit(1);
});
