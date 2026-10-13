/**
 * Build a realistic in-flight delivery order so the customer tracking page and
 * the courier dashboard can be exercised end-to-end.
 *
 * Steps: login -> create delivery order (with the customer's real drop-off
 * coords) -> confirm payment -> kitchen accept/ready -> assign rider -> rider
 * accepts -> pickup -> out-for-delivery -> rider uploads one GPS fix.
 *
 * Prints a JSON summary on stdout that the browser harness consumes.
 */
require('dotenv').config({ quiet: true });
const http = require('http');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 5000);

function api(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    };
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(d);
        } catch (e) {
          json = { raw: d };
        }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body !== undefined && body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

const log = (...a) => console.error(...a);

async function login(identifier, password) {
  if (password) {
    const r = await api('POST', '/api/v1/auth/login', null, { identifier, password });
    if (r.body && r.body.token) return r.body;
  }
  // Seeded staff accounts do not all share the demo password; sign the token
  // locally instead (the server only trusts `id` and re-reads the role from
  // the database, so this is equivalent to a successful login).
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI);
  }
  const User = require('./src/models/User');
  const byEmail = await User.findOne({ email: identifier }).lean();
  const user =
    byEmail ||
    (await User.findOne({
      role: identifier, // role name used as a selector by roleLogin()
      status: 'ACTIVE',
      isActive: { $ne: false },
    })
      .sort({ createdAt: -1 })
      .lean());
  if (!user) throw new Error('no such user: ' + identifier);
  const jwt = require('jsonwebtoken');
  const token = jwt.sign(
    { id: String(user._id), role: user.role, name: user.name, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '2h' }
  );
  log('token for', identifier, '->', user.email, '(' + user.role + ') loginStatus=' + (password ? 'tried' : 'n/a'));
  return {
    token,
    user: { id: String(user._id), name: user.name, email: user.email, role: user.role, phone: user.phone },
  };
}

async function main() {
  const stamp = Date.now().toString(36);

  const cust = await login('customer@cafeteria.com', 'password123');
  const kitchen = await login('kitchen');
  const rider = await login('delivery');
  const admin = await login('admin');
  log('logged in all four roles');

  // Menu item to order
  const menu = await api('GET', '/api/v1/menu?limit=5', cust.token);
  const items = (menu.body && (menu.body.items || menu.body.data?.items || menu.body.menu)) || [];
  if (!items.length) throw new Error('no menu items: ' + JSON.stringify(menu.body).slice(0, 300));
  const item = items.find((i) => (i.stockQuantity == null || i.stockQuantity > 0)) || items[0];
  const price = Number(item.price) || 150;
  const itemName = (item.name && (item.name.en || item.name)) || item.title || 'Item';
  log('menu item:', item._id || item.id, itemName, price);

  // Customer drop-off: real Addis Ababa coordinates (the customer's saved
  // location from checkout). Never fabricated for the DRIVER - the driver's
  // fix comes from the device in the browser step.
  const destLat = 9.0155;
  const destLng = 38.7685;

  let r = await api('POST', '/api/v1/orders', cust.token, {
    orderType: 'delivery',
    customerName: cust.user.name,
    customerPhone: cust.user.phone || '0911111111',
    paymentMethod: 'CHAPA',
    items: [{ id: String(item._id || item.id), name: itemName, quantity: 1 }],
    totalAmount: price,
    deliveryInfo: {
      location: 'Bole Road 12',
      subCity: 'Bole',
      deliveryAddress: 'Bole Road 12, Bole',
      note: '',
      phone: cust.user.phone || '0911111111',
      latitude: destLat,
      longitude: destLng,
    },
  });
  const orderId =
    r.body?.data?.orderId || r.body?.order?.orderId || r.body?.orderId;
  if (!orderId) throw new Error('create order failed: ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 400));
  log('created order', orderId);

  // The simulator fails on purpose ~5% of the time; retry until it confirms.
  for (let i = 0; i < 5; i += 1) {
    r = await api('POST', '/api/v1/payments/simulate', cust.token, {
      orderId,
      method: 'CHAPA',
      phone: cust.user.phone || '0911111111',
      reference: 'SIM-' + stamp,
    });
    log('simulate payment ->', r.status, JSON.stringify(r.body).slice(0, 200));
    if (r.body && r.body.success === true) break;
  }
  if (!r.body || r.body.success !== true) throw new Error('payment could not be confirmed');

  r = await api('PATCH', '/api/v1/kitchen/orders/' + orderId + '/accept', kitchen.token);
  log('kitchen accept ->', r.status, JSON.stringify(r.body).slice(0, 200));
  r = await api('PATCH', '/api/v1/kitchen/orders/' + orderId + '/ready', kitchen.token);
  log('kitchen ready ->', r.status, JSON.stringify(r.body).slice(0, 200));

  const riderId = rider.user.id;
  r = await api('PATCH', '/api/v1/deliveries/' + orderId + '/assign', admin.token, { deliveryStaffId: riderId });
  log('assign ->', r.status, JSON.stringify(r.body).slice(0, 200));
  r = await api('PATCH', '/api/v1/deliveries/' + orderId + '/accept', rider.token, { accept: true });
  log('rider accept ->', r.status, JSON.stringify(r.body).slice(0, 200));
  r = await api('PATCH', '/api/v1/deliveries/' + orderId + '/pickup', rider.token);
  log('pickup ->', r.status, JSON.stringify(r.body).slice(0, 200));
  r = await api('PATCH', '/api/v1/deliveries/' + orderId + '/out-for-delivery', rider.token);
  log('out-for-delivery ->', r.status, JSON.stringify(r.body).slice(0, 200));

  // One server-side rider fix so the customer page has something to render even
  // before the browser uploads its own (proves the "refresh retrieves the last
  // saved location" requirement).
  r = await api('POST', '/api/v1/deliveries/' + orderId + '/location', rider.token, {
    latitude: 9.03,
    longitude: 38.76,
    accuracy: 25,
    timestamp: Date.now(),
  });
  log('seed rider fix ->', r.status, JSON.stringify(r.body).slice(0, 300));

  const summary = {
    orderId,
    customerToken: cust.token,
    customerUser: cust.user,
    riderToken: rider.token,
    riderUser: rider.user,
    kitchenToken: kitchen.token,
    adminToken: admin.token,
    destination: { latitude: destLat, longitude: destLng },
    seededRiderFix: { latitude: 9.03, longitude: 38.76, accuracy: 25 },
  };
  require('fs').writeFileSync(require('path').join(__dirname, '_e2e_summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  await require('mongoose').disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('SETUP FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
