/**
 * End-to-end proof for "Add Delivery Staff" on the Cafeteria Manager Dashboard.
 *
 * Boots the REAL server (real middleware, real JWT, real routes) against a
 * throwaway LOCAL database, then drives the exact requests the new manager UI
 * makes:
 *   GET  /api/v1/deliveries/staff    -> the Delivery Staff list + the staff
 *                                       <select> in Delivery Orders
 *   POST /api/v1/deliveries/staff    -> the "Create Delivery Staff" form
 *
 * ...and proves the new account is a normal, securely stored User:
 *   - role is the canonical `delivery` (what `delivery_staff` normalizes to)
 *   - the password is bcrypt-hashed in MongoDB, never stored in plain text
 *   - the account logs in through the EXISTING auth endpoint
 *   - the new rider is immediately selectable in the Delivery Orders dropdown
 *
 * Run: node Backend/verify-delivery-staff-creation.js
 */
const path = require('path');
const mongoose = require('mongoose');

const TEST_DB = 'scs_delivery_staff_create_test';
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${TEST_DB}`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'delivery-staff-create-test-secret';
process.env.NODE_ENV = 'test';

const BASE = 'http://127.0.0.1:5098';
const API = `${BASE}/api/v1`;

const PLAIN_PASSWORD = 'Rider#2026pass';
const PHONE = '+251911223344';
const EMAIL = 'new.rider@test.local';
const USERNAME = 'new_rider';

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}

let server;
let managerToken;
let cafeteriaId;
let createdStaffId;
let bodyTokenOfDelivery;

async function apiGet(pathname, token) {
  const res = await fetch(`${API}${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function apiSend(method, pathname, token, payload) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function main() {
  const jwt = require('jsonwebtoken');
  const bcrypt = require('bcryptjs');
  const User = require('./src/models/User');

  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  // --- seed one cafeteria + its manager (exactly how the real DB is shaped) ---
  const c = await mongoose.connection.collection('cafeterias').insertOne({
    name: 'Staff Cafe', code: 'STAFF', isActive: true, status: 'ACTIVE',
    address: 'Bole Main St', latitude: 9.03, longitude: 38.74, phone: '+251920000001',
    createdAt: new Date(), updatedAt: new Date(),
  });
  cafeteriaId = c.insertedId;

  const now = new Date();
  const mgr = await User.create({
    name: 'Staff Manager', email: 'staff.mgr@test.local', phone: '+251920000002',
    password: 'Manager#2026pass', role: 'manager', status: 'ACTIVE', isActive: true,
    cafeteriaId, createdAt: now, updatedAt: now,
  });
  managerToken = jwt.sign({ id: String(mgr._id), role: 'manager' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const { app } = require('./server');
  const http = require('http');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(5098, '127.0.0.1', resolve));

  console.log('\nAdd Delivery Staff (Cafeteria Manager Dashboard)\n');

  // --- the Delivery Staff list starts empty ---------------------------------
  await check('GET /deliveries/staff is empty before any staff is added', async () => {
    const { status, body } = await apiGet('/deliveries/staff', managerToken);
    if (status !== 200) throw new Error(`got HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    if ((body.staff || []).length !== 0) throw new Error('expected an empty staff list');
  });

  // --- the "Create Delivery Staff" form submit ------------------------------
  await check('POST /deliveries/staff creates the staff member (201)', async () => {
    const { status, body } = await apiSend('POST', '/deliveries/staff', managerToken, {
      name: 'Abebe Bekele',
      phone: PHONE,
      email: EMAIL,
      username: USERNAME,
      password: PLAIN_PASSWORD,
      // A hostile client cannot smuggle in another role: it is ignored and
      // forced server-side to `delivery`.
      role: 'admin',
    });
    if (status !== 201) throw new Error(`got HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
    if (!body.staff || !body.staff.id) throw new Error('response did not include the created staff');
    createdStaffId = body.staff.id;
    if (body.staff.name !== 'Abebe Bekele') throw new Error(`name=${body.staff.name}`);
    if (body.staff.role !== 'delivery') throw new Error(`role=${body.staff.role} (must be delivery)`);
  });

  // --- it is a real User in MongoDB, with a hashed password -----------------
  await check('MongoDB holds a User with role `delivery` in the manager cafeteria', async () => {
    const u = await User.findById(createdStaffId);
    if (!u) throw new Error('no user document was created');
    if (u.role !== 'delivery') throw new Error(`stored role=${u.role}`);
    if (String(u.cafeteriaId) !== String(cafeteriaId)) throw new Error('not attached to the manager cafeteria');
    if (u.name !== 'Abebe Bekele') throw new Error(`stored name=${u.name}`);
    if (u.phone !== PHONE) throw new Error(`stored phone=${u.phone}`);
    if (u.email !== EMAIL) throw new Error(`stored email=${u.email}`);
    if (u.username !== USERNAME) throw new Error(`stored username=${u.username}`);
    if (u.status !== 'ACTIVE' || u.isActive === false) throw new Error('account should be active');
  });

  await check('the password is bcrypt-hashed, never stored in plain text', async () => {
    const raw = await mongoose.connection.collection('users').findOne({ _id: new mongoose.Types.ObjectId(String(createdStaffId)) });
    const stored = raw.password;
    if (!stored) throw new Error('no password stored');
    if (stored === PLAIN_PASSWORD) throw new Error('THE PLAINTEXT PASSWORD WAS STORED');
    if (!/^\$2[aby]\$\d{2}\$/.test(stored)) throw new Error(`not a bcrypt hash: ${stored.slice(0, 12)}...`);
    if (!(await bcrypt.compare(PLAIN_PASSWORD, stored))) throw new Error('the hash does not match the password');
  });

  await check('the response never leaks the password', async () => {
    const { body } = await apiGet('/deliveries/staff', managerToken);
    const list = JSON.stringify(body);
    if (list.includes(PLAIN_PASSWORD)) throw new Error('the staff list exposed a password');
    if (/"password"/.test(list)) throw new Error('a password field was returned to the client');
  });

  // --- the new rider logs in through the EXISTING auth system ---------------
  await check('the new rider can log in via the existing auth endpoint', async () => {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: EMAIL, password: PLAIN_PASSWORD }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 200) throw new Error(`login -> HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    const role = body?.user?.role;
    if (role !== 'delivery') throw new Error(`logged-in role=${role}`);
    if (!body.token) throw new Error('no token issued');
    bodyTokenOfDelivery = body.token;
  });

  await check('the new rider can log in with their phone number too', async () => {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: PHONE, password: PLAIN_PASSWORD }),
    });
    if (res.status !== 200) throw new Error(`login by phone -> HTTP ${res.status}`);
  });

  await check('the rider lands on the Delivery dashboard (no privilege escalation)', async () => {
    // A delivery account must not reach manager-only surfaces.
    const { status } = await apiGet('/deliveries/staff', bodyTokenOfDelivery);
    if (status !== 403) throw new Error(`rider reached the staff list (HTTP ${status})`);
  });

  // --- the Delivery Staff list on the dashboard refreshes -------------------
  await check('GET /deliveries/staff now returns the new rider', async () => {
    const { status, body } = await apiGet('/deliveries/staff', managerToken);
    if (status !== 200) throw new Error(`got HTTP ${status}`);
    const found = (body.staff || []).find((s) => String(s.id) === String(createdStaffId));
    if (!found) throw new Error('the new rider is missing from the Delivery Staff list');
    if (found.username !== USERNAME) throw new Error(`list row is missing username (${found.username})`);
    if (found.isActive !== true) throw new Error(`isActive=${found.isActive} (must be selectable)`);
    if (!found.createdAt) throw new Error('list row is missing createdAt');
  });

  // --- the Delivery Orders selector -----------------------------------------
  await check('the new rider is immediately selectable in Delivery Orders', async () => {
    // The Delivery Orders page filters the same list with isActive
    // (admin-deliveries.js / dashboard-deliveries.js).
    const { body } = await apiGet('/deliveries/staff', managerToken);
    const selectable = (body.staff || []).filter(
      (s) => (typeof s.isActive === 'boolean' ? s.isActive : String(s.status).toUpperCase() === 'ACTIVE')
    );
    if (!selectable.some((s) => String(s.id) === String(createdStaffId))) {
      throw new Error('the new rider is filtered OUT of the Delivery Staff <select>');
    }
  });

  // --- guard rails -----------------------------------------------------------
  await check('a second staff member with the same email is rejected (409)', async () => {
    const { status } = await apiSend('POST', '/deliveries/staff', managerToken, {
      name: 'Copy Cat', phone: '+251911229999', email: EMAIL, username: 'other_rider', password: PLAIN_PASSWORD,
    });
    if (status !== 409) throw new Error(`expected 409, got ${status}`);
  });

  await check('a weak password is rejected (400)', async () => {
    const { status } = await apiSend('POST', '/deliveries/staff', managerToken, {
      name: 'Weak Pass', phone: '+251911228888', email: 'weak@test.local', username: 'weak_rider', password: 'abc',
    });
    if (status !== 400) throw new Error(`expected 400, got ${status}`);
  });

  await check('a customer cannot create delivery staff (403)', async () => {
    const cust = await User.create({
      name: 'Plain Customer', email: 'plain@test.local', phone: '+251911227777',
      password: 'Customer#2026pass', role: 'customer', status: 'ACTIVE', isActive: true,
    });
    const token = jwt.sign({ id: String(cust._id), role: 'customer' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const { status } = await apiSend('POST', '/deliveries/staff', token, {
      name: 'Sneaky', phone: '+251911226666', email: 'sneaky@test.local', username: 'sneaky', password: PLAIN_PASSWORD,
    });
    if (status !== 403) throw new Error(`expected 403, got ${status}`);
  });

  await check('a role in the request body is ignored - the account is still a rider', async () => {
    // The endpoint hard-codes the canonical `delivery` role. A client trying to
    // smuggle a privileged role through the body must not get it.
    const { status, body } = await apiSend('POST', '/deliveries/staff', managerToken, {
      name: 'Not A Rider', phone: '+251911225555', email: 'nr@test.local',
      username: 'nr_rider', password: PLAIN_PASSWORD, role: 'admin',
    });
    if (status !== 201) throw new Error(`got HTTP ${status}: ${JSON.stringify(body).slice(0, 160)}`);
    if (body.staff.role !== 'delivery') throw new Error(`role=${body.staff.role} (must be delivery)`);
    const stored = await User.findById(body.staff.id);
    if (stored.role !== 'delivery') throw new Error(`stored role=${stored.role}`);
  });

  await check('a manager cannot use the admin user route to create any staff', async () => {
    // The manager role only has `delivery` in the assignment matrix, and the
    // admin user route is not open to managers at all - so this cannot be
    // bypassed to mint a kitchen/cashier/admin account.
    const { status } = await apiSend('POST', '/users', managerToken, {
      name: 'Escalation', phone: '+251911224444', email: 'esc@test.local',
      username: 'esc_user', password: PLAIN_PASSWORD, role: 'admin',
    });
    if (status !== 403) throw new Error(`expected 403 from /users, got ${status}`);
    const { canAssignRole, canManageUser } = require('./src/config/roles');
    if (canAssignRole('manager', 'admin') || canAssignRole('manager', 'kitchen') || canAssignRole('manager', 'cashier')) {
      throw new Error('the manager role can assign a role outside `delivery`');
    }
    if (!canManageUser('manager', 'delivery', 'delivery')) {
      throw new Error('the manager role should be able to manage delivery staff');
    }
  });
}

main()
  .catch((e) => { failures.push('harness'); console.error('FATAL', e); })
  .finally(async () => {
    if (server) await new Promise((r) => server.close(r));
    try { await mongoose.connection.dropDatabase(); } catch { /* ignore */ }
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    console.log(`\n${passed} passed, ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
  });
