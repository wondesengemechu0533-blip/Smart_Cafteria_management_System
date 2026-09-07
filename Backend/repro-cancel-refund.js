require('dotenv').config();
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

function api(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'localhost', port: 5000, path, method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        const out = { status: res.statusCode };
        try { out.data = JSON.parse(d); } catch (e) { out.raw = d; }
        resolve(out);
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const log = (label, r, extra) => {
  console.log(`\n=== ${label} ===`);
  console.log('HTTP', r.status, '|', JSON.stringify(r.data).substring(0, 500));
  if (extra) console.log(extra);
};

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });

  const User = require('./src/models/User');
  const Order = require('./src/models/Order');
  const Cancellation = require('./src/models/Cancellation');
  const Notification = require('./src/models/Notification');
  const MenuItem = require('./src/models/MenuItem');

  const SECRET = process.env.JWT_SECRET;
  const customer = await User.findOne({ role: 'customer' });
  const admin = await User.findOne({ role: { $in: ['admin', 'ADMIN'] } });
  if (!customer || !admin) { console.log('MISSING customer/admin user'); await mongoose.disconnect(); return; }

  const CT = jwt.sign({ id: customer._id, role: customer.role, email: customer.email }, SECRET, { expiresIn: '7d' });
  const AT = jwt.sign({ id: admin._id, role: admin.role, email: admin.email }, SECRET, { expiresIn: '7d' });

  const item = await MenuItem.findOne({ stockQuantity: { $gt: 5 } });
  if (!item) { console.log('No items with stock'); await mongoose.disconnect(); return; }

  // 1. Create a fresh dine-in order
  let r = await api('POST', '/api/v1/orders', CT, {
    orderType: 'dine-in', customerName: customer.name || 'Cancellation Test', customerPhone: customer.phone || '+251900000001',
    paymentMethod: 'CHAPA', items: [{ id: String(item._id), name: item.name?.en || item.name, quantity: 1 }],
    totalAmount: Number(item.price) || 50, tableNumber: 'T99'
  });
  const orderId = r.data?.order?.orderId || r.data?.data?.orderId || r.data?.orderId;
  log('1. CREATE ORDER', r, 'orderId: ' + orderId);
  if (!orderId) { await mongoose.disconnect(); return; }

  // 2. Simulate payment success (like Chapa webhook) so the order is PAID + PENDING
  await Order.findOneAndUpdate({ orderId }, { paymentStatus: 'PAID', 'payment.status': 'PAID', 'payment.paidAt': new Date(), 'payment.amount': Number(item.price) || 50 });
  let orderDoc = await Order.findOne({ orderId });
  console.log('\nDB after mark PAID  -> orderStatus:', orderDoc.orderStatus, '| status:', orderDoc.status, '| paymentStatus:', orderDoc.paymentStatus);

  // 3. Customer cancels (self-service for PENDING order)
  r = await api('POST', '/api/v1/cancellations/request', CT, { orderId, reason: 'CUSTOMER_CHANGED_MIND', details: 'repro' });
  log('3. CUSTOMER CANCEL', r);

  orderDoc = await Order.findOne({ orderId });
  const cancellation = await Cancellation.findOne({ orderId: orderDoc._id, isActive: true });
  console.log('\nDB after cancel -> orderStatus:', orderDoc.orderStatus, '| status:', orderDoc.status, '| paymentStatus:', orderDoc.paymentStatus, '| refundStatus:', orderDoc.refundStatus);
  console.log('Cancellation -> status:', cancellation ? cancellation.status : null, '| refundStatus:', cancellation ? cancellation.refundStatus : null, '| refundAmount:', cancellation ? cancellation.refundAmount : null);

  const notifCount = await Notification.countDocuments({ userId: customer._id, orderId });
  console.log('Customer notifications for order:', notifCount);

  if (!cancellation) { console.log('NO Cancellation doc -> flow broken'); await mongoose.disconnect(); return; }

  // 4. Admin views cancellation list
  r = await api('GET', '/api/v1/cancellations?search=' + orderId, AT);
  log('4. ADMIN LIST', r);
  const listItem = (r.data?.cancellations || []).find((c) => c.orderId === orderId);
  console.log('\nList item -> cancellationStatus:', listItem ? listItem.status : null, '| refundStatus:', listItem ? listItem.refundStatus : null);

  // 5. Admin confirms the refund (simulated provider confirmation)
  const cid = String(cancellation._id);
  r = await api('POST', '/api/v1/cancellations/' + cid + '/refund/confirm', AT, { providerReference: 'REPRO-' + Date.now() });
  log('5. ADMIN CONFIRM REFUND', r);

  // 6. Verify final state + customer notification
  orderDoc = await Order.findOne({ orderId });
  const cancellation2 = await Cancellation.findById(cid);
  const notifAfter = await Notification.find({ userId: customer._id, orderId }).sort({ createdAt: -1 }).lean();
  console.log('\nDB after refund -> paymentStatus:', orderDoc.paymentStatus, '| refundStatus:', orderDoc.refundStatus, '| refundedAt:', orderDoc.refundedAt ? 'SET' : 'NO');
  console.log('Cancellation status:', cancellation2 ? cancellation2.status : null, '| refundStatus:', cancellation2 ? cancellation2.refundStatus : null);
  console.log('Customer notifications now:');
  notifAfter.forEach((n) => console.log('   -', n.title, '|', n.message));

  await mongoose.disconnect();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });