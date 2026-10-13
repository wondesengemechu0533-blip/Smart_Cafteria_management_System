require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const http = require('http');

function api(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const o = {
      hostname: '127.0.0.1',
      port: 5000,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) o.headers.Authorization = 'Bearer ' + token;
    const req = http.request(o, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./src/models/User');
  const Order = require('./src/models/Order');
  const MenuItem = require('./src/models/MenuItem');

  const kitchens = await User.find({ role: 'kitchen' }).select('email status isActive name').lean();
  console.log('kitchens:', JSON.stringify(kitchens, null, 2));

  const admins = await User.find({ role: { $in: ['admin', 'system_admin', 'cafeteria_admin'] } })
    .select('email status isActive role')
    .limit(5)
    .lean();
  console.log('admins:', JSON.stringify(admins, null, 2));

  const item = await MenuItem.findOne({
    stockQuantity: { $gt: 5 },
    isActive: true,
    availabilityStatus: 'AVAILABLE',
  }).lean();
  console.log('item:', item && String(item._id), item && item.price);

  const kitchen = await User.findOne({ role: 'kitchen', status: 'ACTIVE', isActive: { $ne: false } })
    .sort({ createdAt: 1 });
  const admin = await User.findOne({ role: 'admin' }).sort({ createdAt: 1 });
  if (!kitchen || !admin || !item) {
    console.error('missing setup piece', { kitchen: !!kitchen, admin: !!admin, item: !!item });
    process.exit(1);
  }
  console.log('using kitchen', kitchen.email, kitchen.status, 'admin', admin.email);

  const stamp = Date.now().toString(36);
  const rider = await User.create({
    name: 'Debug Rider', email: `debug-rider-${stamp}@ex.com`,
    phone: '+251911' + String(Date.now()).slice(-6), password: 'TestPass123!', role: 'delivery',
    status: 'ACTIVE', isActive: true,
  });
  const cust = await User.create({
    name: 'Debug Cust', email: `debug-cust-${stamp}@ex.com`,
    phone: '+251922' + String(Date.now()).slice(-6), password: 'TestPass123!', role: 'customer',
    status: 'ACTIVE', isActive: true,
  });

  const sign = (u) => jwt.sign({ id: String(u._id), role: u.role, email: u.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const ct = sign(cust), at = sign(admin), kt = sign(kitchen), rt = sign(rider);

  let r = await api('POST', '/api/v1/orders', ct, {
    orderType: 'delivery', customerName: cust.name, customerPhone: cust.phone,
    paymentMethod: 'CHAPA',
    items: [{ id: String(item._id), name: item.name && item.name.en, quantity: 1 }],
    deliveryInfo: { location: 'x', subCity: 'y' },
    totalAmount: item.price,
  });
  const oid = r.body.order && r.body.order.orderId;
  console.log('create', r.status, oid, r.body.error || r.body.message || '');

  r = await api('PATCH', '/api/v1/kitchen/orders/' + oid + '/accept', kt);
  console.log('kitchen accept', r.status, r.body.error || r.body.message || '');
  r = await api('PATCH', '/api/v1/kitchen/orders/' + oid + '/ready', kt);
  console.log('kitchen ready', r.status, r.body.error || r.body.message || '');

  r = await api('PATCH', '/api/v1/deliveries/' + oid + '/assign', at, { deliveryStaffId: String(rider._id) });
  console.log('assign', r.status, JSON.stringify(r.body).slice(0, 300));

  const o = await Order.findOne({ orderId: oid }).lean();
  console.log('DB assigned to:', o && o.deliveryStaffAssigned, 'rider:', String(rider._id),
    'match:', o && String(o.deliveryStaffAssigned) === String(rider._id),
    'status:', o && o.status, 'type:', o && o.orderType);

  r = await api('PATCH', '/api/v1/deliveries/' + oid + '/accept', rt, { accept: true });
  console.log('rider accept', r.status, r.body.error || r.body.message || '');
  r = await api('PATCH', '/api/v1/deliveries/' + oid + '/pickup', rt);
  console.log('pickup', r.status, r.body.error || r.body.message || '');
  r = await api('PATCH', '/api/v1/deliveries/' + oid + '/out-for-delivery', rt);
  console.log('out', r.status, r.body.error || r.body.message || '');

  await Order.deleteMany({ orderId: oid });
  await User.deleteOne({ _id: rider._id });
  await User.deleteOne({ _id: cust._id });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
