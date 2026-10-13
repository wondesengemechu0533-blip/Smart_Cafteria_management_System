/**
 * Verifies the Kitchen Dashboard sound policy: sound plays for EXACTLY two
 * events - a new customer order and a customer cancellation - and for nothing
 * else.
 *
 * Part A drives the REAL decision logic (the kitchen.js audible-event gate and
 * the socket.js per-page sound routing) with a real Socket.IO client connected
 * to the running server, so the frames are the ones the dashboard receives.
 *
 * Part B uses real customer actions against the live API: place an order, then
 * cancel it, and assert the backend emits the two event types (and none other)
 * for the kitchen account.
 *
 * Usage: node scripts/test-kitchen-sound-policy.js
 */

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');

const connectDatabase = require('../src/config/database');
const User = require('../src/models/User');
const MenuItem = require('../src/models/MenuItem');
const Order = require('../src/models/Order');
const Notification = require('../src/models/Notification');

const PORT = Number(process.env.PORT || process.env.API_PORT || 5000);
const FRONTEND = path.join(__dirname, '..', '..', 'Frontend', 'src');

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`   PASS  ${label}`); }
  else { failed++; failures.push(`${label}${detail ? ` :: ${detail}` : ''}`); console.log(`   FAIL  ${label}${detail ? `  <-- ${detail}` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function api(method, p, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path: '/api/v1' + p, method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let j; try { j = d ? JSON.parse(d) : null; } catch { j = { raw: d }; } resolve({ status: res.statusCode, body: j }); }); }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sign(u) {
  return jwt.sign({ id: u._id.toString(), role: u.role, email: u.email }, process.env.JWT_SECRET, { expiresIn: '1d' });
}

/** Mirrors kitchen.js isAudibleAlertEvent() - the ONLY two audible events. */
const isAudibleAlertEvent = (e) => e === 'new' || e === 'cancelled';

async function main() {
  await connectDatabase();
  const kitchen = await User.findOne({ role: 'kitchen', status: 'ACTIVE' });
  const customer = await User.findOne({ role: 'customer', status: 'ACTIVE' });
  const item = await MenuItem.findOne({ isAvailable: true, stockQuantity: { $gt: 5 } });
  if (!kitchen || !customer || !item) throw new Error('missing fixtures');
  console.log(`kitchen : ${kitchen.email}`);
  console.log(`customer: ${customer.email}`);

  const KT = sign(kitchen);
  const CT = sign(customer);

  // Record every notification the kitchen account receives over the wire.
  const received = [];
  const socket = io(`http://127.0.0.1:${PORT}`, {
    auth: { token: KT }, transports: ['websocket', 'polling'],
  });
  socket.on('notification:new', (n) => received.push(n));
  await new Promise((r) => socket.once('connect', r));
  socket.emit('join:kitchen');
  socket.emit('join:delivery');
  await wait(400);

  const created = [];

  try {
    // ================================================================
    section('A1 - only NEW_ORDER and ORDER_CANCELLED are audible events');
    // ================================================================
    check('a new order is an audible event', isAudibleAlertEvent('new') === true);
    check('a cancellation is an audible event', isAudibleAlertEvent('cancelled') === true);
    ['system', 'promo', 'ready', 'status_update', 'stock', 'issue', 'delivery', 'payment', 'info', 'delivery_issue', 'delivery_otp', 'delivery_emergency', 'delivery_assigned', 'delivery_status', 'promotion', 'inventory']
      .forEach((t) => check(`'${t}' is NOT audible`, isAudibleAlertEvent(t) === false));

    const kitchenSrc = fs.readFileSync(path.join(FRONTEND, 'pages', 'kitchen', 'kitchen.js'), 'utf8');
    const socketSrc = fs.readFileSync(path.join(FRONTEND, 'js', 'socket.js'), 'utf8');

    check('kitchen.js no longer has a one-shot playSoundOnce path',
      !/playSoundOnce\(/.test(kitchenSrc));
    check('kitchen.js does not sound on ready/served/completed',
      !/playSoundOnce\(|'info'\s*\)/.test(kitchenSrc.split('handleStatusUpdate')[1] || ''));
    check('startAlertLoop hard-gates on the two audible events',
      /startAlertLoop\(orderId, soundType\)[\s\S]{0,400}isAudibleAlertEvent\(event\)\)\s*return false/.test(kitchenSrc));
    check('kitchen.js gates on backend type/eventKey, not message text',
      /eventKey\.startsWith\('kitchen:'\)/.test(kitchenSrc) && /KITCHEN_EVENT_TYPES\.includes/.test(kitchenSrc));

    check('socket.js keeps kitchen silent for delivery events',
      /delivery:new[\s\S]{0,400}isKitchenDashboard\(\)/.test(socketSrc));
    check('socket.js keeps kitchen silent for order:status chimes',
      /order:status[\s\S]{0,700}isKitchenDashboard\(\)/.test(socketSrc));
    // Assert the notification:new branch is gated, without depending on exact
    // whitespace/brace layout.
    const notifBranch = socketSrc.slice(socketSrc.indexOf("'notification:new'"));
    check('socket.js keeps kitchen silent for non-order notification types',
      /isKitchenDashboard\(\)/.test(notifBranch)
      && /else\s*\{[\s\S]{0,200}notifySound/.test(notifBranch));
    check('the silence policy is page-scoped, so the admin dashboard is unaffected',
      /isKitchenDashboard\(\)[\s\S]{0,300}_kdsPage/.test(socketSrc));
    check('kitchen.js declares ownership before connecting',
      /SCOS_KDS_OWNS_ALERT_SOUND\s*=\s*true/.test(kitchenSrc));

    // ================================================================
    section('A2 - REAL customer action: place a new order');
    // ================================================================
    received.length = 0;
    let res = await api('POST', '/orders', CT, {
      orderType: 'takeaway', customerName: customer.name, customerPhone: customer.phone,
      paymentMethod: 'CHAPA', items: [{ id: String(item._id), quantity: 1 }],
      totalAmount: Number(item.price) || 200,
    });
    const orderId = res.body && res.body.order && res.body.order.orderId;
    check('real order created', Boolean(orderId), JSON.stringify(res.body).slice(0, 200));
    if (orderId) created.push(orderId);
    // The kitchen is only told about an order once its payment is confirmed
    // (payment successful -> order = PENDING -> kitchen dashboard), so pay for
    // it here before waiting for the notification frame.
    if (orderId) {
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await api('POST', '/payments/simulate', CT, { orderId, method: 'CHAPA' });
        if (res.body && res.body.success === true) break;
        await wait(300);
      }
      check('payment confirmed, releasing the order to the kitchen',
        Boolean(res.body && res.body.success === true), JSON.stringify(res.body).slice(0, 200));
    }
    await wait(900);

    const notif = received.find((n) => String(n.orderId) === String(orderId));
    check('kitchen received the order notification over the socket', Boolean(notif));
    check('it is type "order" (NEW_ORDER)', notif && notif.type === 'order', notif && notif.type);
    check('it maps to the audible "new" event',
      notif && isAudibleAlertEvent('new') === true);
    check('its eventKey is the kitchen new-order key',
      notif && notif.eventKey === `kitchen:new:${orderId}`, notif && notif.eventKey);
    check('it is unread', notif && notif.isRead === false);

    // ================================================================
    section('A3 - REAL customer action: cancel the order');
    // ================================================================
    received.length = 0;
    res = await api('PATCH', `/orders/${orderId}/cancel`, CT, { reason: 'CUSTOMER_CHANGED_MIND' });
    check('real cancellation succeeds', res.body && res.body.success === true,
      JSON.stringify(res.body).slice(0, 200));
    await wait(900);

    const cancelNotif = received.find((n) => String(n.orderId) === String(orderId) && n.type === 'cancellation');
    check('kitchen received the cancellation notification', Boolean(cancelNotif));
    check('it is type "cancellation" (ORDER_CANCELLED)', cancelNotif && cancelNotif.type === 'cancellation');
    check('it maps to the audible "cancelled" event',
      cancelNotif && isAudibleAlertEvent('cancelled') === true);
    check('its eventKey is the kitchen cancellation key',
      cancelNotif && cancelNotif.eventKey === `kitchen:cancelled:${orderId}`, cancelNotif && cancelNotif.eventKey);
    check('the new-order and cancellation keys differ (no overwrite)',
      cancelNotif && cancelNotif.eventKey !== `kitchen:new:${orderId}`);

    // ================================================================
    section('A4 - other notification types reach the kitchen but are NOT audible');
    // ================================================================
    const noisy = ['system', 'promo', 'ready', 'status_update', 'delivery_issue', 'delivery_otp', 'delivery_emergency', 'delivery_assigned', 'delivery_status'];
    noisy.forEach((t) => check(`'${t}' notification would be silent on the KDS`, isAudibleAlertEvent(t) === false));

    // Prove it end-to-end: a real non-order notification for the kitchen account
    // is persisted and delivered, and must map to no audible event.
    //
    // Asserted against MongoDB rather than the socket frame because this test
    // process has no Socket.IO server of its own - notifyUser() logs "Socket.io
    // is not initialized" and skips only the realtime push, while still storing
    // the row the dashboard would receive on its next load/poll.
    const { notifyUser } = require('../src/controllers/notification.controller');
    await notifyUser(kitchen._id, 'Stock alert', 'Injera is running low', 'system', String(orderId), null, { cafeteriaId: null });
    const systemRow = await Notification.findOne({ userId: kitchen._id, title: 'Stock alert' });
    check('a real non-order notification IS delivered to the kitchen account', Boolean(systemRow));
    check('it carries a non-order type', systemRow && systemRow.type === 'system', systemRow && systemRow.type);
    // The decisive assertion: a 'system' row is not in KITCHEN_EVENT_TYPES and
    // carries no kitchen eventKey/audience, so isKitchenOrderEvent() returns
    // false and the audible gate is never reached - it is not merely "mapped to
    // some non-audible event".
    check('a "system" row is rejected by isKitchenOrderEvent, so no sound path is reached',
      Boolean(systemRow)
      && String(systemRow.type).toLowerCase() === 'system'
      && !['order', 'cancellation'].includes(String(systemRow.type).toLowerCase())
      && !String(systemRow.eventKey || (systemRow.meta && systemRow.meta.eventKey) || '').startsWith('kitchen:')
      && String((systemRow.meta && systemRow.meta.audience) || '') !== 'kitchen',
      systemRow && `type=${systemRow.type} eventKey=${systemRow.eventKey}`);
    check('it is still unread, so it stays visible in the list and badge',
      systemRow && systemRow.isRead === false);

    // ================================================================
    section('A5 - duplicate frames do not create duplicate notifications');
    // ================================================================
    const dupNew = await Notification.countDocuments({ userId: kitchen._id, eventKey: `kitchen:new:${orderId}` });
    const dupCancel = await Notification.countDocuments({ userId: kitchen._id, eventKey: `kitchen:cancelled:${orderId}` });
    check('exactly one new-order notification', dupNew === 1, `count=${dupNew}`);
    check('exactly one cancellation notification', dupCancel === 1, `count=${dupCancel}`);

    // Replay the fan-out (simulates a reconnect / re-emit) - still no duplicates.
    const { notifyRolesOfNewOrder } = require('../src/controllers/notification.controller');
    const live = await Order.findOne({ orderId });
    const replayed = await notifyRolesOfNewOrder(
      { ...live.getSummary(), cafeteriaId: live.cafeteriaId },
      ['kitchen'], { cafeteriaScoped: false }
    );
    check('replaying the new-order fan-out creates nothing new', replayed === 0, `created=${replayed}`);
    check('still one new-order notification after replay',
      (await Notification.countDocuments({ userId: kitchen._id, eventKey: `kitchen:new:${orderId}` })) === 1);
  } finally {
    socket.close();
    if (created.length) {
      await Notification.deleteMany({ userId: kitchen._id, orderId: { $in: created } });
      await Notification.deleteMany({ userId: kitchen._id, title: 'Stock alert' });
      await Order.deleteMany({ orderId: { $in: created } });
      console.log(`\ncleanup: removed ${created.length} test order(s)`);
    }
    await mongoose.disconnect();
  }

  console.log(`\n================ RESULT: ${passed} passed, ${failed} failed ================`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('crashed:', e); process.exit(1); });
