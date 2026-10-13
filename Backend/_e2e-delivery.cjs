// End-to-end delivery stage flow against the REAL backend + REAL Mongo.
// Verifies each stage persists AND that the payload the customer's Socket.IO
// handler receives carries a status that maps to the right tracking step.
require('dotenv').config();
process.env.MONGO_DISABLE_DNS_PIN = '1';

const connectDatabase = require('./src/config/database');
const dc = require('./src/controllers/delivery.controller');
const deliveryService = require('./src/services/delivery.service');
const Order = require('./src/models/Order');
const User = require('./src/models/User');
const Delivery = require('./src/models/Delivery');
const mongoose = require('mongoose');

const CAFE = '6ab1223ef9dd5cafa528c5c1';

// Record every broadcast the app would send, by handing socket.js a fake io.
const captured = [];
const fakeIo = {
  to(room) {
    return { emit: (event, payload) => {
      captured.push({ room, event, status: payload && payload.status, deliveryStatus: payload && payload.deliveryStatus });
    } };
  },
  emit(event, payload) { captured.push({ room: '<broadcast>', event, status: payload && payload.status }); },
};
require('./src/utils/socket').initSocket(fakeIo);

const mkRes = () => {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const call = async (fn, req) => { const res = mkRes(); await fn(req, res); return res; };

// Customer tracking step keys (order-status.js getTimelineConfig).
const STEP_KEYS = ['pending','preparing','ready','picked_up','out_for_delivery','arrived','delivered','completed'];
const stepIndex = (status) => STEP_KEYS.indexOf(String(status || '').trim().toLowerCase());

(async () => {
  await connectDatabase();
  const rider = await User.findOne({ role: 'delivery', status: 'ACTIVE' });
  const admin = await User.findOne({ role: { $in: ['admin', 'manager'] } });

  // Build a real delivery order that is READY, assigned to the rider.
  const order = await Order.create({
    orderId: 'E2E-' + Date.now().toString().slice(-8),
    userId: rider._id,
    customerName: 'E2E Customer',
    customerPhone: '0911000000',
    orderType: 'delivery',
    status: 'ready',
    orderStatus: 'READY',
    cafeteriaId: CAFE,
    items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Test Meal', quantity: 2, price: 100, subtotal: 200 }],
    subtotal: 200, serviceFee: 0, deliveryFee: 30, totalAmount: 230,
    paymentStatus: 'PAID',
    paymentMethod: 'CASH',
    deliveryInfo: { phone: '0911000000', subCity: 'AA', location: 'Test St' },
    deliveryStaffAssigned: rider._id,
    deliveryAcceptanceStatus: 'ACCEPTED',
  });
  await deliveryService.ensureDeliveryForOrder(order);
  const delivery = await Delivery.findOne({ order: order._id });
  console.log('created', order.orderId, '| delivery', String(delivery._id), '\n');

  const asRider = { user: { id: String(rider._id), role: 'delivery' }, params: {}, query: {}, body: {} };
  const asAdmin = { user: { id: String(admin._id), role: admin.role, cafeteriaId: CAFE }, params: {}, query: {}, body: {} };

  const stages = [
    ['Pickup',            () => call(dc.pickUpOrder,           { ...asRider, params: { id: order.orderId } })],
    ['Out for Delivery',  () => call(dc.markOutForDelivery,    { ...asRider, params: { id: order.orderId } })],
    ['Arrived',           () => call(dc.markArrived,           { ...asRider, params: { id: order.orderId } })],
    // Delivered requires proof (photo / customer OTP / manager override), so the
    // test supplies a manager override exactly like the UI's proof modal does.
    ['Delivered',         () => call(dc.markDelivered,         {
                                ...asAdmin,
                                params: { id: order.orderId },
                                body: { isManagerOverride: true, overrideReason: 'E2E verification run' },
                              })],
    ['Completed',         () => call(dc.markCompleted,         { ...asRider, params: { id: order.orderId } })],
  ];

  let failed = 0;
  console.log('stage'.padEnd(18), 'http'.padEnd(5), 'db.orderStatus'.padEnd(17), 'db.status'.padEnd(17), 'emitted->order room');
  console.log('-'.repeat(92));

  for (const [label, run] of stages) {
    captured.length = 0;
    const res = await run();
    const fresh = await Order.findOne({ orderId: order.orderId });
    const toCustomer = captured.find((c) => c.room === `order:${order.orderId}` && c.event === 'order:status');
    const idx = toCustomer ? stepIndex(toCustomer.status) : -1;
    const green = idx >= 0 ? `step ${idx + 1}/8 ${STEP_KEYS[idx]}` : 'NO MAPPED STEP';
    if (idx < 0) {
      console.log('   !! events to order room for this stage:');
      captured.filter((c) => c.room === `order:${order.orderId}`)
        .forEach((c) => console.log(`      ${c.event}  status=${JSON.stringify(c.status)}  deliveryStatus=${JSON.stringify(c.deliveryStatus)}`));
    }
    console.log(
      label.padEnd(18),
      String(res.code).padEnd(5),
      String(fresh.orderStatus).padEnd(17),
      String(fresh.status).padEnd(17),
      green + (res.code >= 400 ? '  ERR=' + JSON.stringify(res.body && res.body.error) : '')
    );
    if (res.code >= 400) failed++;
    if (idx < 0) failed++;
  }

  // Completed must leave the ACTIVE list and land in history.
  const mine = await call(dc.getMyDeliveries, asRider);
  const inActive = (mine.body.orders || []).some((o) => o.orderId === order.orderId);
  const hist = await call(dc.getMyDeliveryHistory, asRider);
  const inHistory = (hist.body.orders || []).some((o) => o.orderId === order.orderId);

  console.log('\nafter Completed:');
  console.log('  in /deliveries/mine (active) :', inActive, '  <- must be false');
  console.log('  in /deliveries/my-history    :', inHistory, '  <- must be true');
  if (inActive) failed++;
  if (!inHistory) failed++;

  console.log('\nFAILURES:', failed);
  process.exit(failed ? 1 : 0);
})();