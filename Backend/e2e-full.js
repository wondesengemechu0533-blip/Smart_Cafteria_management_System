const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const JWT_SECRET = 'CafeAdmin2026SecureRandomKeyForJWTTokenSigning!';
const MONGO = 'mongodb+srv://smartcafe:Cafe2026Secure12345@cluster0.5ijixco.mongodb.net/smart_cafeteria?retryWrites=true&w=majority';

function api(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'localhost', port: 5000, path, method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ raw: d }); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  await mongoose.connect(MONGO);
  const User = require('./src/models/User');
  const MenuItem = require('./src/models/MenuItem');

  // Find an item with stock
  const item = await MenuItem.findOne({ stockQuantity: { $gt: 5 }, isAvailable: true });
  if (!item) { console.log('No items with stock!'); await mongoose.disconnect(); return; }
  console.log('Using item:', item._id, item.name?.en || item.name, 'stock:', item.stockQuantity);

  const customer = await User.findOne({ email: 'wondesengemechuha@gmail.com' });
  const admin = await User.findOne({ role: 'admin' });
  const kitchen = await User.findOne({ role: 'kitchen' });
  const delivery = await User.findOne({ email: 'delivery@cafeteria.com' });

  const CT = jwt.sign({ id: customer._id, role: customer.role, email: customer.email }, JWT_SECRET, { expiresIn: '7d' });
  const AT = jwt.sign({ id: admin._id, role: admin.role, email: admin.email }, JWT_SECRET, { expiresIn: '7d' });
  const KT = jwt.sign({ id: kitchen._id, role: kitchen.role, email: kitchen.email }, JWT_SECRET, { expiresIn: '7d' });
  const DT = jwt.sign({ id: delivery._id, role: delivery.role, email: delivery.email }, JWT_SECRET, { expiresIn: '7d' });

  let r;

  console.log('\n=== STEP 1: Customer places delivery order ===');
  r = await api('POST', '/api/v1/orders', CT, {
    orderType: 'delivery', customerName: 'Test User', customerPhone: '+251911223344',
    paymentMethod: 'CHAPA', items: [{ id: String(item._id), name: item.name?.en || item.name, quantity: 1 }],
    deliveryInfo: { location: '123 Test St', subCity: 'Bole' }, totalAmount: item.price
  });
  const orderId = r.data?.orderId || r.order?.orderId;
  console.log('  Result:', orderId ? 'OK ' + orderId : 'FAIL ' + (r.error || JSON.stringify(r).substring(0,200)));
  if (!orderId) { await mongoose.disconnect(); return; }

  console.log('\n=== STEP 2: Kitchen accepts ===');
  r = await api('PATCH', '/api/v1/kitchen/orders/' + orderId + '/accept', KT);
  console.log('  Result:', r.success, r.message || r.error);

  console.log('\n=== STEP 3: Kitchen marks Ready ===');
  r = await api('PATCH', '/api/v1/kitchen/orders/' + orderId + '/ready', KT);
  console.log('  Result:', r.success, r.message || r.error);

  console.log('\n=== STEP 4: Kitchen hands to driver (Picked Up) ===');
  r = await api('PATCH', '/api/v1/kitchen/orders/' + orderId + '/picked-up', KT);
  console.log('  Result:', r.success, r.message || r.error);

  console.log('\n=== STEP 5: Admin assigns rider ===');
  r = await api('PATCH', '/api/v1/deliveries/' + orderId + '/assign', AT, { deliveryStaffId: String(delivery._id) });
  console.log('  Result:', r.success, r.message || r.error);

  console.log('\n=== STEP 6: Rider marks Out for Delivery ===');
  r = await api('PATCH', '/api/v1/deliveries/' + orderId + '/out-for-delivery', DT);
  console.log('  Result:', r.success, r.message || r.error);

  console.log('\n=== STEP 7: Rider marks Delivered -> Completed ===');
  r = await api('PATCH', '/api/v1/deliveries/' + orderId + '/delivered', DT);
  console.log('  Result:', r.success, r.message || r.error);

  console.log('\n=== CUSTOMER TRACKER (7-step delivery) ===');
  r = await api('GET', '/api/v1/orders/' + orderId, CT);
  const o = r.data;
  const statuses = ['pending','preparing','ready','picked_up','out_for_delivery','delivered','completed'];
  const idx = statuses.indexOf(String(o?.status || '').toLowerCase());
  statuses.forEach((s, i) => console.log((i <= idx ? 'GREEN' : 'grey '), i + 1 + '.', s));
  console.log('\n  Final status:', o?.status);
  console.log('  completedTime:', o?.completedTime ? 'SET' : 'NO');
  console.log('  deliveredAt:', o?.deliveredAt ? 'SET' : 'NO');

  await mongoose.disconnect();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
