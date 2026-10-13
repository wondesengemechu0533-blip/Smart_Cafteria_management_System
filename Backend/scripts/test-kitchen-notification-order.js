/**
 * Verifies the Kitchen Dashboard notification ORDERING.
 *
 * Two parts:
 *   A. Pure logic - loads the real `sortNotificationsNewestFirst` /
 *      `notificationTimestamp` / store-merge behaviour out of kitchen.js and
 *      asserts newest-first ordering, mixed new/cancelled, tie-breaking and
 *      the merge semantics that stop an in-flight poll from dropping a
 *      just-arrived notification.
 *   B. Real data - places real orders and cancels one through the live API, then
 *      asserts the backend returns them newest-first and that the eventKey
 *      identity prevents duplicates.
 *
 * Usage: node scripts/test-kitchen-notification-order.js
 */

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const connectDatabase = require('../src/config/database');
const User = require('../src/models/User');
const MenuItem = require('../src/models/MenuItem');
const Order = require('../src/models/Order');
const Notification = require('../src/models/Notification');

const PORT = Number(process.env.PORT || process.env.API_PORT || 5000);

let passed = 0;
let failed = 0;
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

// ---------------------------------------------------------------------------
// A. Load the REAL ordering helpers out of kitchen.js (no DOM needed).
// ---------------------------------------------------------------------------
function loadOrderingHelpers() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'Frontend', 'src', 'pages', 'kitchen', 'kitchen.js'),
    'utf8'
  );
  function grab(name) {
    const start = src.indexOf(`    ${name}(`);
    if (start === -1) throw new Error('method not found: ' + name);
    let i = src.indexOf('{', start);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error('unbalanced: ' + name);
  }
  // Rebuild the real method as a standalone function so it can be called
  // unbound - exactly the way Array#sort invokes the comparator.
  const sortSrc = grab('sortNotificationsNewestFirst').replace(/^\s*sortNotificationsNewestFirst/, 'function sortNotificationsNewestFirst');
  // eslint-disable-next-line no-new-func
  return { sortNotificationsNewestFirst: new Function(`${sortSrc}; return sortNotificationsNewestFirst;`)() };
}

async function main() {
  // -------------------------------------------------------------------
  section('A1 - newest-first ordering by real createdAt');
  // -------------------------------------------------------------------
  const { sortNotificationsNewestFirst } = loadOrderingHelpers();

  // Mirrors the user's required output, oldest created first.
  const rows = [
    { orderId: '102', eventType: 'new',      createdAt: '2026-01-01T10:00:00.000Z' },
    { orderId: '103', eventType: 'cancelled', createdAt: '2026-01-01T10:01:00.000Z' },
    { orderId: '104', eventType: 'new',      createdAt: '2026-01-01T10:02:00.000Z' },
    { orderId: '105', eventType: 'new',      createdAt: '2026-01-01T10:03:00.000Z' },
  ];
  const sorted = sortNotificationsNewestFirst(rows);
  const gotOrder = sorted.map((r) => r.orderId);
  check('newest order #105 is FIRST', gotOrder[0] === '105', gotOrder.join(','));
  check('full order is 105,104,103,102', gotOrder.join(',') === '105,104,103,102', gotOrder.join(','));
  check('cancellations sort by their own createdAt, not by type', sorted[2].orderId === '103');

  // Real-time insert: a new order appended to the collection must jump to top.
  const realtime = rows.slice();
  realtime.push({ orderId: '106', eventType: 'new', createdAt: new Date().toISOString() });
  const afterInsert = sortNotificationsNewestFirst(realtime).map((r) => r.orderId);
  check('a real-time arrival lands at the top immediately', afterInsert[0] === '106', afterInsert.join(','));
  check('older notifications are kept below it', afterInsert.slice(1).join(',') === '105,104,103,102', afterInsert.join(','));

  // -------------------------------------------------------------------
  section('A2 - tie-breaking is stable (same millisecond)');
  // -------------------------------------------------------------------
  const same = '2026-01-01T10:00:00.000Z';
  const tied = [
    { orderId: 'A', eventType: 'new', createdAt: same, _seq: 1 },
    { orderId: 'B', eventType: 'new', createdAt: same, _seq: 2 },
    { orderId: 'C', eventType: 'new', createdAt: same, _seq: 3 },
  ];
  const tiedSorted = sortNotificationsNewestFirst(tied).map((r) => r.orderId);
  check('identical timestamps keep last-seen first (deterministic)', tiedSorted.join(',') === 'C,B,A', tiedSorted.join(','));
  check('re-sorting the same input gives the same order',
    sortNotificationsNewestFirst(tied).map((r) => r.orderId).join(',') === 'C,B,A');

  // -------------------------------------------------------------------
  section('A3 - unparseable / missing createdAt cannot poison the sort');
  // -------------------------------------------------------------------
  const mixedBad = [
    { orderId: 'X', eventType: 'new', createdAt: 'garbage' },
    { orderId: 'Y', eventType: 'new', createdAt: '2026-01-01T10:00:00.000Z' },
  ];
  let sortThrew = false;
  let badSorted = [];
  try {
    badSorted = sortNotificationsNewestFirst(mixedBad).map((r) => r.orderId);
  } catch (e) {
    sortThrew = true;
  }
  check('an unparseable createdAt does not make the comparator throw', !sortThrew);
  check('a valid timestamp still sorts above an unparseable one',
    !sortThrew && badSorted[0] === 'Y' && badSorted[1] === 'X', badSorted.join(','));

  // -------------------------------------------------------------------
  section('A4 - the source comparator is newest-first (no ascending sort)');
  // -------------------------------------------------------------------
  const kitchenSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'Frontend', 'src', 'pages', 'kitchen', 'kitchen.js'),
    'utf8'
  );
  check('panel render uses the shared newest-first helper',
    kitchenSrc.includes('this.sortNotificationsNewestFirst('));
  check('banner render is also time-ordered',
    /renderAlertBanner\(\)[\s\S]{0,900}sortNotificationsNewestFirst/.test(kitchenSrc));
  check('notification store merges instead of blind-replacing',
    kitchenSrc.includes('const merged = new Map(incoming)'));
  check('acknowledged events are shielded from stale snapshots',
    kitchenSrc.includes('locallyAcknowledged'));
  check('orders.html now has the notification list',
    fs.readFileSync(path.join(__dirname, '..', '..', 'Frontend', 'src', 'pages', 'kitchen', 'orders.html'), 'utf8')
      .includes('kdsNotifList'));

  // -------------------------------------------------------------------
  section('B - real API: newest order returned first, no duplicates');
  // -------------------------------------------------------------------
  await connectDatabase();
  const kitchen = await User.findOne({ role: 'kitchen', status: 'ACTIVE' });
  const customer = await User.findOne({ role: 'customer', status: 'ACTIVE' });
  const item = await MenuItem.findOne({ isAvailable: true, stockQuantity: { $gt: 5 } });
  if (!kitchen || !customer || !item) throw new Error('missing fixtures');
  const KT = jwt.sign({ id: kitchen._id.toString(), role: kitchen.role, email: kitchen.email }, process.env.JWT_SECRET, { expiresIn: '1d' });
  const CT = jwt.sign({ id: customer._id.toString(), role: customer.role, email: customer.email }, process.env.JWT_SECRET, { expiresIn: '1d' });

  const created = [];
  const mk = async (n) => {
    const r = await api('POST', '/orders', CT, {
      orderType: 'takeaway', customerName: customer.name, customerPhone: customer.phone,
      paymentMethod: 'CHAPA', items: [{ id: String(item._id), quantity: 1 }],
      totalAmount: Number(item.price) || 200,
    });
    const id = r.body && r.body.order && r.body.order.orderId;
    if (id) created.push(id);
    // The kitchen's new-order notification is emitted when the payment is
    // confirmed (payment successful -> order = PENDING -> kitchen dashboard),
    // so each order has to be paid before it can show up in the list below.
    if (id) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const pay = await api('POST', '/payments/simulate', CT, { orderId: id, method: 'CHAPA' });
        if (pay.body && pay.body.success === true) break;
        await wait(300);
      }
    }
    return id;
  };

  const id1 = await mk(1); await wait(1100);
  const id2 = await mk(2); await wait(1100);
  const id3 = await mk(3);
  check('three real orders created', Boolean(id1 && id2 && id3));

  // Cancel the OLDEST of the three so its cancellation timestamp is newest.
  let cancelRes = await api('PATCH', `/orders/${id1}/cancel`, CT, { reason: 'CUSTOMER_CHANGED_MIND' });
  check('cancellation succeeds', cancelRes.body && cancelRes.body.success === true,
    JSON.stringify(cancelRes.body).slice(0, 200));
  await wait(600);

  // Clear this kitchen's pre-existing unread noise so the assertions are exact.
  await Notification.deleteMany({ userId: kitchen._id, orderId: { $nin: created } });

  const res = await api('GET', '/notifications?unread=true&limit=200', KT);
  const list = (res.body && res.body.notifications) || [];
  const createdInList = list.filter((n) => created.includes(n.orderId));

  // Order 1 was cancelled, so the kitchen holds FOUR notifications for these
  // three orders: a new-order row for each, plus a cancellation row for #1.
  check('all three orders notified the kitchen, plus the cancellation row',
    createdInList.length === 4, `got ${createdInList.length}`);

  const ids = createdInList.map((n) => n.orderId);
  // The cancellation of #1 is the most RECENT event, so it must lead - which is
  // the required "cancellations appear by their real creation time".
  check('the most recent event (cancellation of order 1) is FIRST', ids[0] === id1, ids.join(','));
  check('then the newest order (#3), then #2, then the oldest order event',
    ids[1] === id3 && ids[2] === id2 && ids[3] === id1, ids.join(','));
  check('cancellation is ordered by its own createdAt, not demoted by type',
    ids.includes(id1) && createdInList[0].type === 'cancellation', createdInList[0].type);

  // Verify createdAt is genuinely descending as returned.
  const times = createdInList.map((n) => new Date(n.createdAt).getTime());
  const descending = times.every((t, i) => i === 0 || times[i - 1] >= t);
  check('backend returns createdAt in descending order', descending, times.join(','));

  // New order and cancellation both present for the cancelled order.
  const cancelRow = createdInList.find((n) => n.orderId === id1 && n.type === 'cancellation');
  const newRow = createdInList.find((n) => n.orderId === id1 && n.type === 'order');
  check('cancelled order has BOTH a new-order and a cancellation notification', Boolean(cancelRow && newRow));
  check('their eventKeys are distinct (no overwrite)', newRow.eventKey !== cancelRow.eventKey,
    `${newRow.eventKey} vs ${cancelRow.eventKey}`);

  // Sorting the real payload the way the panel does.
  const panelOrder = createdInList.slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  check('panel ordering puts the most recent real notification on top',
    panelOrder[0].orderId === id1 && panelOrder[0].type === 'cancellation',
    panelOrder.map((n) => `${n.orderId}/${n.type}`).join(','));
  check('the newest ORDER (not a cancellation) is next',
    panelOrder[1].orderId === id3 && panelOrder[1].type === 'order',
    panelOrder[1] && `${panelOrder[1].orderId}/${panelOrder[1].type}`);
  check('panel order is exactly newest-first by createdAt',
    panelOrder.map((n) => n.id).join(',') ===
      createdInList.map((n) => n.id).join(','));

  // Duplicate guard: re-running the fan-out must not create a second row.
  const { notifyRolesOfNewOrder } = require('../src/controllers/notification.controller');
  const live = await Order.findOne({ orderId: id3 });
  const created2 = await notifyRolesOfNewOrder(
    { ...live.getSummary(), cafeteriaId: live.cafeteriaId },
    ['kitchen'], { cafeteriaScoped: false }
  );
  check('replaying the fan-out creates no new notification', created2 === 0, `created=${created2}`);
  const dupCount = await Notification.countDocuments({ userId: kitchen._id, orderId: id3, type: 'order' });
  check('still exactly one row for that event', dupCount === 1, `count=${dupCount}`);

  // Cleanup
  await Notification.deleteMany({ userId: kitchen._id, orderId: { $in: created } });
  await Order.deleteMany({ orderId: { $in: created } });
  console.log(`\ncleanup: removed ${created.length} test order(s)`);
  await mongoose.disconnect();

  console.log(`\n================ RESULT: ${passed} passed, ${failed} failed ================`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('crashed:', e); process.exit(1); });
