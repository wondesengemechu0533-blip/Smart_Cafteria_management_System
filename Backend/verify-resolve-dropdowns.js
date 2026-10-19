/**
 * Ad-hoc verification: stock-alert resolve with Reason/Solution dropdowns.
 * Runs against the LIVE backend (port 5000) + MongoDB.
 */
require('dotenv').config();
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('./src/models/User');
const StockAlert = require('./src/models/StockAlert');
const Notification = require('./src/models/Notification');

const PORT = Number(process.env.PORT || 5000);
let pass = 0, fail = 0;
function record(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}
function api(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port: PORT, path, method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    };
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        let json; try { json = JSON.parse(d); } catch (e) { json = { raw: d }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body !== undefined && body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}
const sign = u => jwt.sign({ id: String(u._id), role: u.role, name: u.name, email: u.email }, process.env.JWT_SECRET, { expiresIn: '1h' });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI, { dbName: undefined });
  console.log('Connected to MongoDB');

  async function login(identifier, password) {
    const r = await api('POST', '/api/v1/auth/login', null, { identifier, password });
    if (r.status !== 200 || !r.body.token) throw new Error(`login failed ${identifier}: HTTP ${r.status} ${r.body.error || ''}`);
    return r.body.token;
  }
  const KT = await login('e2e.kitchen2@scos.test', 'E2ePass@73116');
  const MT = await login('e2e.mgr1@scos.test', 'E2ePass@73116');
  console.log('Logged in provisioned e2e kitchen2 + mgr1');

  // Resolution is cafeteria-admin-only now. The e2e cafeteria admin password
  // rotates per provisioning run, so mint a JWT straight from the user doc.
  let caDoc = await User.findOne({ email: 'e2e.cafadmin@scos.test' });
  if (!caDoc) {
    const mgrForCaf = await User.findOne({ email: 'e2e.mgr1@scos.test' });
    caDoc = await User.create({
      name: 'E2E CafAdmin Resolve',
      email: 'e2e.cafadmin@scos.test',
      phone: '0911' + String(Math.floor(1e6 + Math.random() * 9e6)).slice(0, 6),
      password: 'E2ePass@73116',
      role: 'cafeteria_admin',
      status: 'ACTIVE',
      cafeteriaId: (mgrForCaf && mgrForCaf.cafeteriaId) || null,
    });
  }
  const AT = sign(caDoc);
  console.log('Cafeteria admin token ready:', caDoc.email);

  // 1. Kitchen reports a stock issue
  const create = await api('POST', '/api/v1/kitchen/stock-alerts', KT, {
    itemName: 'E2E Resolve Modal Burger Bun', alertType: 'out_of_stock', severity: 'high',
    reason: 'Bun rack empty before lunch service.',
  });
  record('Kitchen reports stock alert -> 201', create.status === 201, JSON.stringify(create.body));
  const alertId = create.body.alert && create.body.alert.id;
  if (!alertId) throw new Error('no alert id');

  // 2. The manager may NOT resolve (403) - review actions only.
  const mgrBlocked = await api('PATCH', `/api/v1/kitchen/stock-alerts/${alertId}/resolve`, MT, {
    resolutionReason: 'Out of Stock', resolutionSolution: 'Restocked Items',
  });
  record('Manager resolve -> 403 (admins only)', mgrBlocked.status === 403,
    `HTTP ${mgrBlocked.status} ${mgrBlocked.body.error || ''}`);

  // 3. Resolve with empty body -> 400 (dropdowns are required)
  const empty = await api('PATCH', `/api/v1/kitchen/stock-alerts/${alertId}/resolve`, AT, {});
  record('Resolve with empty body -> 400', empty.status === 400, `HTTP ${empty.status} ${empty.body.error || ''}`);

  // 4. Resolve with reason+solution=Other but no explanation -> 400
  const otherNoText = await api('PATCH', `/api/v1/kitchen/stock-alerts/${alertId}/resolve`, AT, {
    resolutionReason: 'Other', resolutionSolution: 'Other',
  });
  record('Other without explanation -> 400', otherNoText.status === 400, `HTTP ${otherNoText.status} ${otherNoText.body.error || ''}`);

  // 5. Acknowledge first (active -> acknowledged), then resolve properly
  const ack = await api('PATCH', `/api/v1/kitchen/stock-alerts/${alertId}/acknowledge`, MT, { note: 'Taking this now.' });
  record('Manager acknowledges -> 200', ack.status === 200, `HTTP ${ack.status} ${ack.body.error || ''}`);

  const resolve = await api('PATCH', `/api/v1/kitchen/stock-alerts/${alertId}/resolve`, AT, {
    resolutionReason: 'Out of Stock',
    resolutionSolution: 'Restocked Items',
    resolutionNote: 'Restocked 60 buns from the central store.',
  });
  record('Admin resolve with reason + solution -> 200', resolve.status === 200, `HTTP ${resolve.status} ${resolve.body.error || ''}`);
  const saved = resolve.body.alert || {};
  record('Response carries resolutionReason', saved.resolutionReason === 'Out of Stock', JSON.stringify(saved.resolutionReason));
  record('Response carries resolutionSolution', saved.resolutionSolution === 'Restocked Items', JSON.stringify(saved.resolutionSolution));

  // 6. Persisted in MongoDB with resolved status + admin identity + timestamp
  const db = await StockAlert.findById(alertId).lean();
  record('MongoDB: status=resolved', db && db.status === 'resolved');
  record('MongoDB: reason/solution saved',
    db && db.resolutionReason === 'Out of Stock' && db.resolutionSolution === 'Restocked Items');
  record('MongoDB: resolvedBy = cafeteria admin + resolvedAt set',
    db && String(db.resolvedBy) === String(caDoc._id) && Boolean(db.resolvedAt));

  // 7. Reporter (kitchen staff) notified
  const notif = await Notification.findOne({ userId: db.reportedBy, title: 'Stock Issue Resolved' }).sort({ createdAt: -1 }).lean();
  record('Notification persisted for reporting kitchen staff', Boolean(notif));

  // 8. Kitchen list shows the saved selections
  const list = await api('GET', '/api/v1/kitchen/stock-alerts', KT);
  const row = (list.body.alerts || []).find(a => a.id === alertId);
  record('List view exposes reason/solution after refresh',
    row && row.resolutionReason === 'Out of Stock' && row.resolutionSolution === 'Restocked Items',
    JSON.stringify(row && { r: row.resolutionReason, s: row.resolutionSolution }));

  await mongoose.disconnect();
  console.log(`\nSUMMARY  PASS: ${pass}  FAIL: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
