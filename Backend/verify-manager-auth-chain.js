/**
 * End-to-end manager auth chain test against the REAL server:
 *   login -> token -> /admin/dashboard -> /admin/dashboard/recent-orders -> /deliveries
 * Mirrors exactly what manager-dashboard.html + dashboard-deliveries.js do.
 */
const mongoose = require('mongoose');
const TEST_DB = 'scs_manager_auth_chain_test';
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'manager-chain-test-secret';
process.env.NODE_ENV = 'test';

const BASE = 'http://127.0.0.1:5098';
const API = `${BASE}/api/v1`;
let passed = 0; const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); }
}
async function call(method, pathname, token, body) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

let server, managerToken, cafeteriaId;
async function main() {
  const User = require('./src/models/User');
  const Order = require('./src/models/Order');
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const c = await mongoose.connection.collection('cafeterias').insertOne({
    name: 'Chain Cafe', code: 'CHAIN', isActive: true, status: 'ACTIVE',
    address: 'Bole', latitude: 9.03, longitude: 38.74, phone: '+251920000001',
    createdAt: new Date(), updatedAt: new Date(),
  });
  cafeteriaId = c.insertedId;
  const now = new Date();
  const mgr = await User.create({
    name: 'Chain Manager', email: 'chainmgr@t.test', phone: '+251920000002',
    password: 'chain-pass-123', role: 'manager', status: 'ACTIVE', isActive: true,
    cafeteriaId, createdAt: now, updatedAt: now,
  });

  const { app } = require('./server');
  const http = require('http');
  server = http.createServer(app);
  await new Promise((r) => server.listen(5098, '127.0.0.1', r));

  console.log('\nManager auth chain over real HTTP\n');

  await check('POST /auth/login returns success+token+user.role=manager', async () => {
    const { status, body } = await call('POST', '/auth/login', null, { identifier: 'chainmgr@t.test', password: 'chain-pass-123' });
    if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(body).slice(0,200)}`);
    if (body.success !== true) throw new Error('success != true');
    if (!body.token) throw new Error('no token');
    if (!body.user) throw new Error('no user object');
    if (body.user.role !== 'manager') throw new Error(`user.role=${body.user.role}`);
    managerToken = body.token;
  });

  await check('GET /admin/dashboard accepts the manager token (200)', async () => {
    const { status, body } = await call('GET', '/admin/dashboard', managerToken);
    if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(body).slice(0,200)}`);
  });

  await check('GET /admin/dashboard/recent-orders accepts the manager token (200)', async () => {
    const { status, body } = await call('GET', '/admin/dashboard/recent-orders?limit=6', managerToken);
    if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(body).slice(0,200)}`);
  });

  await check('GET /deliveries accepts the manager token (200)', async () => {
    const { status, body } = await call('GET', '/deliveries?status=ALL', managerToken);
    if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(body).slice(0,200)}`);
  });

  await check('GET /deliveries/staff accepts the manager token (200)', async () => {
    const { status, body } = await call('GET', '/deliveries/staff', managerToken);
    if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(body).slice(0,200)}`);
  });

  await check('a bogus token is rejected with 401 (so the guard can detect it)', async () => {
    const { status } = await call('GET', '/admin/dashboard', 'not-a-real-token');
    if (status !== 401) throw new Error(`expected 401, got ${status}`);
  });
}

main()
  .catch((e) => { failures.push('harness'); console.error('FATAL', e); })
  .finally(async () => {
    if (server) await new Promise((r) => server.close(r));
    try { await mongoose.connection.dropDatabase(); } catch {}
    try { await mongoose.disconnect(); } catch {}
    console.log(`\n${passed} passed, ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
  });