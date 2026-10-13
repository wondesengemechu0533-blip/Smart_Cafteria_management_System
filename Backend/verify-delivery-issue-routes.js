/**
 * Delivery Issue HTTP wiring verification (no database needed).
 *
 * Mounts the real router in a real Express app and drives it with real HTTP
 * requests over a loopback socket. The real `protect`/`authorize` middleware,
 * the real `multer` multipart parser and the real socket fan-out all run; only
 * the Mongoose model layer and the notification/audit side effects are
 * stubbed. So this exercises route matching, JWT auth, role authorization,
 * multipart parsing, controller validation, tenant scoping, the customer-safe
 * projection and the exact JSON the UI consumes.
 *
 * It proves the endpoints are wired correctly. It is NOT a substitute for an
 * end-to-end test against a live database.
 *
 * Run: node Backend/verify-delivery-issue-routes.js
 */

const assert = require('assert');
const Module = require('module');
const http = require('http');

const ROOT = __dirname;

// --- stub the optional native deps that are not installed in this checkout --
//
// NOTE: `multer` is deliberately NOT stubbed. It is a declared dependency, so
// the real parser runs here and the multipart check proves the route works with
// the same code path production uses.

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'aws-sdk') {
    // S3 is optional; the lazy loader in cloudUpload tolerates its absence.
    throw new Error('Cannot find module aws-sdk');
  }
  return originalLoad.apply(this, arguments);
};

// --- in-memory model layer --------------------------------------------------

const DeliveryIssue = require(`${ROOT}/src/models/DeliveryIssue`);
const Delivery = require(`${ROOT}/src/models/Delivery`);
const User = require(`${ROOT}/src/models/User`);
const Order = require(`${ROOT}/src/models/Order`);

const db = {
  issues: [],
  deliveries: new Map(),
  users: new Map(),
  orders: new Map(),
  saves: 0,
};

// The canonical id the seeded delivery/order fixtures are assigned to. Declared
// here because the delivery fixture's status history references it.
const COURIER_ID = '507f1f77bcf86cd799439041';

function queryObj(result) {
  // Thenable + chainable, like a real Mongoose Query. The order matters:
  // resolve the value lazily so `.sort()` can still reorder the list.
  let value = result;
  const q = {
    select: () => q,
    populate: () => q,
    sort: (spec) => {
      if (Array.isArray(value) && spec && typeof spec === 'object') {
        const [[field, dir]] = Object.entries(spec);
        if (field) {
          value = [...value].sort((a, b) => {
            const av = a ? a[field] : undefined;
            const bv = b ? b[field] : undefined;
            if (av === bv) return 0;
            return (av > bv ? 1 : -1) * (dir === -1 ? -1 : 1);
          });
        }
      }
      return q;
    },
    limit: () => q,
    lean: () => q,
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return q;
}

function matchIssue(query, issue) {
  for (const [field, cond] of Object.entries(query || {})) {
    if (field === '$or') {
      if (!cond.some((c) => matchIssue(c, issue))) return false;
      continue;
    }
    if (cond && typeof cond === 'object' && '$in' in cond) {
      if (!cond.$in.includes(issue[field])) return false;
    } else if (String(issue[field] ?? '') !== String(cond ?? '')) {
      return false;
    }
  }
  return true;
}

function matchUser(query, user) {
  for (const [field, cond] of Object.entries(query || {})) {
    if (field === '$or') {
      if (!cond.some((c) => matchUser(c, user))) return false;
      continue;
    }
    if (cond && typeof cond === 'object' && '$in' in cond) {
      if (!cond.$in.map(String).includes(String(user[field]))) return false;
    } else if (String(user[field] ?? '') !== String(cond ?? '')) {
      return false;
    }
  }
  return true;
}

function issueDoc(over = {}) {
  return Object.assign(
    {
      _id: '507f1f77bcf86cd799439011',
      order: '507f1f77bcf86cd799439021',
      orderId: 'ORD-1001',
      delivery: '507f1f77bcf86cd799439031',
      reportedBy: '507f1f77bcf86cd799439041',
      reportedByName: 'Abebe',
      reportedByPhone: '0911000000',
      cafeteriaId: '507f1f77bcf86cd799439051',
      customer: '507f1f77bcf86cd799439061',
      issueType: 'HEAVY_TRAFFIC',
      description: 'Gridlock on the main road',
      photo: null,
      latitude: 9.0192,
      longitude: 38.7525,
      accuracy: 12,
      locationAvailable: true,
      deliveryStatusAtReport: 'OUT_FOR_DELIVERY',
      reportedAt: new Date('2026-01-01T10:00:00Z'),
      status: 'OPEN',
      delaysDelivery: true,
      deliveryOnHold: false,
      customerNotified: false,
      customerNotifiedAt: null,
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
      reassignedTo: null,
      reassignedAt: null,
      reassignedBy: null,
      statusHistory: [{ status: 'OPEN', at: new Date('2026-01-01T10:00:00Z'), note: '' }],
      createdAt: new Date('2026-01-01T10:00:00Z'),
      isTerminal() {
        return ['RESOLVED', 'CANCELLED'].includes(this.status);
      },
      isOpen() {
        return ['OPEN', 'IN_PROGRESS'].includes(this.status);
      },
      async save() {
        db.saves += 1;
        return this;
      },
      toIssuePayload() {
        return {
          id: String(this._id),
          orderId: this.orderId,
          deliveryId: String(this.delivery),
          issueType: this.issueType,
          description: this.description,
          status: this.status,
          photo: this.photo || null,
          locationAvailable: this.locationAvailable,
          latitude: this.locationAvailable ? this.latitude : null,
          longitude: this.locationAvailable ? this.longitude : null,
          accuracy: this.locationAvailable ? this.accuracy : null,
          reportedBy: String(this.reportedBy),
          reportedByName: this.reportedByName,
          cafeteriaId: this.cafeteriaId,
          deliveryStatusAtReport: this.deliveryStatusAtReport,
          delaysDelivery: this.delaysDelivery,
          deliveryOnHold: this.deliveryOnHold,
          reportedAt: this.reportedAt,
          resolvedAt: this.resolvedAt,
          resolutionNote: this.resolutionNote,
          reassignedTo: this.reassignedTo,
          reassignedAt: this.reassignedAt,
        };
      },
    },
    over
  );
}

function deliveryDoc(over = {}) {
  return Object.assign(
    {
      _id: '507f1f77bcf86cd799439031',
      orderId: 'ORD-1001',
      status: 'OUT_FOR_DELIVERY',
      cafeteriaId: '507f1f77bcf86cd799439051',
      deliveryPerson: '507f1f77bcf86cd799439041',
      customer: '507f1f77bcf86cd799439061',
      onHold: false,
      holdReason: null,
      heldAt: null,
      heldBy: null,
      resumedAt: null,
      openIssueCount: 0,
      statusHistory: [
        { status: 'PICKED_UP', at: new Date('2026-01-01T09:55:00Z'), by: COURIER_ID, note: '' },
        { status: 'OUT_FOR_DELIVERY', at: new Date('2026-01-01T10:00:00Z'), by: COURIER_ID, note: '' },
      ],
      currentLocation: { latitude: 9.0192, longitude: 38.7525, accuracy: 12 },
      destination: { latitude: 9.0292, longitude: 38.7525 },
      pickup: { latitude: 9.0, longitude: 38.74 },
      distanceKm: 1.2,
      etaMinutes: 8,
      toTrackingPayload() {
        return {
          id: String(this._id),
          orderId: this.orderId,
          customerId: String(this.customer),
          deliveryPersonId: this.deliveryPerson ? String(this.deliveryPerson) : null,
          destination: this.destination,
          status: this.status,
          currentLocation: this.currentLocation,
          onHold: Boolean(this.onHold),
          holdReason: this.holdReason || null,
          openIssueCount: this.openIssueCount || 0,
          distanceKm: this.distanceKm,
          etaMinutes: this.etaMinutes,
        };
      },
      async save() {
        return this;
      },
    },
    over
  );
}

function orderDoc(over = {}) {
  return Object.assign(
    {
      _id: '507f1f77bcf86cd799439021',
      orderId: 'ORD-1001',
      orderType: 'delivery',
      userId: '507f1f77bcf86cd799439061',
      cafeteriaId: '507f1f77bcf86cd799439051',
      customerName: 'Sara',
      customerPhone: '0922000000',
      status: 'OUT_FOR_DELIVERY',
      orderStatus: 'OUT_FOR_DELIVERY',
      deliveryInfo: { deliveryAddress: 'Bole, Addis Ababa', latitude: 9.0292, longitude: 38.7525 },
      deliveryStaffAssigned: { _id: '507f1f77bcf86cd799439041', name: 'Abebe', phone: '0911000000', role: 'delivery' },
      delivery: '507f1f77bcf86cd799439031',
      deliveryAcceptanceStatus: 'ACCEPTED',
      async save() {
        return this;
      },
      populate: async () => orderDoc(),
    },
    over
  );
}

// --- install stubs ---------------------------------------------------------

Object.assign(DeliveryIssue, {
  findOne(q) {
    const list = db.issues.filter((i) => matchIssue(q, i));
    return queryObj(list.length ? list[0] : null);
  },
  find(q) {
    return queryObj(db.issues.filter((i) => matchIssue(q, i)));
  },
  countDocuments: async (q) => db.issues.filter((i) => matchIssue(q, i)).length,
  async create(doc) {
    const created = issueDoc(doc);
    created._id = `507f1f77bcf86cd7994390${String(db.issues.length + 11).padStart(2, '0')}`;
    db.issues.push(created);
    return created;
  },
});

Object.assign(Delivery, {
  findById(id) {
    return queryObj(db.deliveries.get(String(id)) || null);
  },
  find(q) {
    return queryObj(Array.from(db.deliveries.values()));
  },
  findOne(q) {
    const list = Array.from(db.deliveries.values()).filter(
      (d) => (!q || !q.orderId || d.orderId === q.orderId) && (!q || !q._id || String(d._id) === String(q._id))
    );
    return queryObj(list.length ? list[0] : null);
  },
  countDocuments: async () => db.deliveries.size,
});

Object.assign(User, {
  find(q) {
    return queryObj(Array.from(db.users.values()).filter((u) => matchUser(q, u)));
  },
  // The real `protect` middleware does `User.findById(id).select(...)`, so the
  // stub must be chainable as well as thenable.
  findById(id) {
    const user = db.users.get(String(id));
    return queryObj(user ? Object.assign({}, user, { isActive: user.isActive !== false }) : null);
  },
  create: async () => ({}),
  // The assignment/reassignment path flips `isAvailable` (and the availability
  // endpoint stamps `lastActiveAt`) with User.updateOne. Without this stub the
  // real mongoose call buffers against the (absent) live connection and times
  // out after 10s, so the reassign assertions below never even run.
  updateOne: async (q, update) => {
    const user = db.users.get(String(q && q._id));
    if (!user) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    Object.assign(user, update && update.$set ? update.$set : update || {});
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  },
});

Object.assign(Order, {
  findById(id) {
    return queryObj(db.orders.get(String(id)) || null);
  },
  findOne(q) {
    const list = Array.from(db.orders.values()).filter(
      (o) => (!q || !q.orderId || o.orderId === q.orderId) && (!q || !q._id || String(o._id) === String(q._id))
    );
    return queryObj(list.length ? list[0] : null);
  },
  find(q) {
    return queryObj(Array.from(db.orders.values()));
  },
  countDocuments: async () => 0,
  async create() {
    return orderDoc();
  },
});

// --- silent collaborators (no notifications/audit in this harness) ----------

// `Setting` is stubbed to an empty store so the real `getSettingsMap()` runs
// and falls back to the real DEFAULT_SETTINGS (capacity guard, cancel policy).
// Without this, `assignCourier` would buffer against a non-existent database.
const Setting = require(`${ROOT}/src/models/Setting`);
Setting.find = () => queryObj([]);
Setting.create = async () => ({});

// `moveDelivery` writes an audit row per transition; without a stub it buffers
// against a non-existent database.
const OrderStatusHistory = require(`${ROOT}/src/models/OrderStatusHistory`);
OrderStatusHistory.create = async (doc) => Object.assign({ _id: 'osh-1' }, doc);
OrderStatusHistory.find = () => queryObj([]);
OrderStatusHistory.findOne = () => queryObj(null);

require.cache[require.resolve(`${ROOT}/src/controllers/notification.controller`)] = {
  id: require.resolve(`${ROOT}/src/controllers/notification.controller`),
  filename: require.resolve(`${ROOT}/src/controllers/notification.controller`),
  loaded: true,
  exports: { notifyUser: async () => ({ _id: 'n' }) },
};
require.cache[require.resolve(`${ROOT}/src/utils/audit`)] = {
  id: require.resolve(`${ROOT}/src/utils/audit`),
  filename: require.resolve(`${ROOT}/src/utils/audit`),
  loaded: true,
  exports: { logAction: async () => null },
};

// Every `delivery:issue` emit, recorded so the customer-reachable rooms can be
// asserted rather than assumed. The controller destructures
// `emitSocketEvent` at require time, so this must be installed BEFORE the
// router (and therefore the controller) is loaded.
const emitted = [];
require.cache[require.resolve(`${ROOT}/src/utils/socket`)] = {
  id: require.resolve(`${ROOT}/src/utils/socket`),
  filename: require.resolve(`${ROOT}/src/utils/socket`),
  loaded: true,
  exports: {
    emitSocketEvent: (room, event, payload) => {
      emitted.push({ room: String(room), event: String(event), payload });
    },
    setSocketIO: () => {},
    getSocketIO: () => null,
    emitToUser: () => {},
  },
};

// --- build the app ---------------------------------------------------------

const express = require('express');
const jwt = require('jsonwebtoken');

// The real `protect` middleware verifies against process.env.JWT_SECRET, so the
// harness must use the very same secret - otherwise every request 401s and the
// tests would prove nothing.
const JWT_SECRET = 'verify-only-secret';
process.env.JWT_SECRET = JWT_SECRET;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// The real router brings its own `protect` + `authorize`; nothing is stubbed
// here, so role handling is exercised exactly as it runs in production.
app.use('/api/v1/delivery-issues', require(`${ROOT}/src/routes/deliveryIssue.routes`));

const server = http.createServer(app);

/** Issue a real HTTP request against the in-memory server. */
function request(method, path, { token, body, contentType } = {}) {
  return new Promise((resolve, reject) => {
    // Buffers are sent verbatim; strings are JSON-encoded. Binary payloads must
    // be Buffers or UTF-8 encoding would corrupt them.
    const payload =
      body === undefined
        ? null
        : Buffer.isBuffer(body)
          ? body
          : contentType && contentType.includes('multipart')
            ? body
            : JSON.stringify(body);
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = contentType || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ method, path, headers, host: '127.0.0.1', port: server.address().port }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch (e) {
          json = null;
        }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// --- fixtures --------------------------------------------------------------

const CAF_A = '507f1f77bcf86cd799439051';
const CAF_B = '507f1f77bcf86cd799439052';
const COURIER = '507f1f77bcf86cd799439041';
const CUSTOMER = '507f1f77bcf86cd799439061';
const ISSUE_ID = '507f1f77bcf86cd799439011';

const courier = { _id: COURIER, name: 'Abebe', phone: '0911000000', role: 'delivery', status: 'ACTIVE' };
// Manager/customer ids must be real ObjectId-shaped strings: the models cast
// `changedBy` to ObjectId, and a short id would fail validation for reasons
// that have nothing to do with the behaviour under test.
const MANAGER_A = '507f1f77bcf86cd799439081';
const MANAGER_B = '507f1f77bcf86cd799439082';
const managerA = { _id: MANAGER_A, name: 'Mgr A', role: 'manager', cafeteriaId: CAF_A, status: 'ACTIVE' };
const managerB = { _id: MANAGER_B, name: 'Mgr B', role: 'manager', cafeteriaId: CAF_B, status: 'ACTIVE' };
const customer = { _id: CUSTOMER, name: 'Sara', role: 'customer', status: 'ACTIVE' };
const newCourier = { _id: 'c-2', name: 'Dawit', phone: '0933000000', role: 'delivery', status: 'ACTIVE' };
// `assignCourier` rejects anything that is not a valid ObjectId, so the
// successful reassign path needs a real-looking id.
const RELIEF_COURIER = '507f1f77bcf86cd799439071';
const reliefCourier = {
  _id: RELIEF_COURIER,
  name: 'Dawit',
  phone: '0933000000',
  role: 'delivery',
  status: 'ACTIVE',
  cafeteriaId: CAF_A,
};

function reset() {
  db.issues = [];
  db.saves = 0;
  db.users = new Map(
    [courier, managerA, managerB, customer, newCourier, reliefCourier].map((u) => [String(u._id), Object.assign({}, u)])
  );
  db.deliveries = new Map([['507f1f77bcf86cd799439031', deliveryDoc()]]);
  db.orders = new Map([['507f1f77bcf86cd799439021', orderDoc()]]);
  db.issues.push(issueDoc());
}

const token = (user) => jwt.sign({ id: user._id, role: user.role, cafeteriaId: user.cafeteriaId }, JWT_SECRET);

// --- checks ----------------------------------------------------------------

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('the issue list is refused without a token', async () => {
  reset();
  const res = await request('GET', '/api/v1/delivery-issues');
  assert.strictEqual(res.status, 401);
});

check('a courier is refused the manager issue list', async () => {
  reset();
  const res = await request('GET', '/api/v1/delivery-issues', { token: token(courier) });
  assert.strictEqual(res.status, 403, 'the list is management-only');
});

check('a manager gets their cafeteria issues, not another cafeterias', async () => {
  reset();
  // Same order, but the issue now belongs to cafeteria B.
  db.issues[0].cafeteriaId = CAF_B;

  const resA = await request('GET', '/api/v1/delivery-issues', { token: token(managerA) });
  assert.strictEqual(resA.status, 200);
  assert.strictEqual(resA.body.count, 0, 'cafeteria A must not see cafeteria B issues');
  assert.deepStrictEqual(resA.body.issues, []);

  const resB = await request('GET', '/api/v1/delivery-issues', { token: token(managerB) });
  assert.strictEqual(resB.status, 200);
  assert.strictEqual(resB.body.count, 1, 'cafeteria B sees its own issue');
  assert.strictEqual(resB.body.issues[0].orderId, 'ORD-1001');
});

check('the courier can load the issue type list', async () => {
  reset();
  const res = await request('GET', '/api/v1/delivery-issues/meta/types', { token: token(courier) });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.types), 'types must be an array for the form');
  assert.ok(res.body.types.length >= 13, 'all agreed problem types must be offered');
  assert.ok(res.body.types.every((t) => t.value && t.label), 'each type needs a value and a label');
  assert.ok(res.body.types.some((t) => t.value === 'HEAVY_TRAFFIC'));
  assert.ok(res.body.types.some((t) => t.value === 'CUSTOMER_NOT_ANSWERING'));
});

check('reporting a problem is refused for a delivery the courier does not own', async () => {
  reset();
  // The Delivery record is the authoritative source for who is carrying the
  // order, so reassign there as well as on the order.
  db.deliveries.get('507f1f77bcf86cd799439031').deliveryPerson = 'someone-else';
  db.orders.get('507f1f77bcf86cd799439021').deliveryStaffAssigned = {
    _id: 'someone-else',
    name: 'Other',
    phone: '0900',
    role: 'delivery',
  };
  const res = await request('POST', '/api/v1/delivery-issues', {
    token: token(courier),
    body: { orderId: 'ORD-1001', issueType: 'HEAVY_TRAFFIC', description: 'not my delivery' },
  });
  assert.ok(res.status === 403, `expected 403 for a delivery the courier does not own, got ${res.status}`);
  assert.strictEqual(db.issues.length, 1, 'no issue may be created');
});

check('reporting a problem is refused for a terminal delivery', async () => {
  reset();
  db.deliveries.get('507f1f77bcf86cd799439031').status = 'DELIVERED';
  const res = await request('POST', '/api/v1/delivery-issues', {
    token: token(courier),
    body: { orderId: 'ORD-1001', issueType: 'HEAVY_TRAFFIC', description: 'too late' },
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /in progress/i);
  assert.strictEqual(db.issues.length, 1, 'no issue may be created for a finished delivery');
});

check('a courier can report a problem on their own active delivery', async () => {
  reset();
  db.issues = [];
  const res = await request('POST', '/api/v1/delivery-issues', {
    token: token(courier),
    body: {
      orderId: 'ORD-1001',
      issueType: 'VEHICLE_PROBLEM',
      description: 'The motorbike tyre burst',
      latitude: 9.03,
      longitude: 38.74,
      accuracy: 8,
    },
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.issue.issueType, 'VEHICLE_PROBLEM');
  assert.strictEqual(res.body.issue.status, 'OPEN');
  assert.strictEqual(res.body.issue.locationAvailable, true);
  // The delivery must NOT have become delivered.
  assert.strictEqual(res.body.deliveryStatus, 'OUT_FOR_DELIVERY');
  assert.strictEqual(db.deliveries.get('507f1f77bcf86cd799439031').status, 'OUT_FOR_DELIVERY');
  assert.strictEqual(db.issues.length, 1);
  assert.strictEqual(db.issues[0].reportedBy, COURIER, 'the reporter comes from the JWT, not the body');
  // The audit trail must carry the same id, or the manager cannot see who
  // reported the problem.
  assert.strictEqual(db.issues[0].statusHistory[0].by, COURIER, 'status history must record the reporter');
  assert.strictEqual(db.issues[0].reportedByName, 'Abebe');
});

check('a report with a partial GPS pair is rejected outright', async () => {
  reset();
  db.issues = [];
  const res = await request('POST', '/api/v1/delivery-issues', {
    token: token(courier),
    body: { orderId: 'ORD-1001', issueType: 'ROAD_BLOCKED', description: 'bridge closed', latitude: 9.03 },
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /latitude and longitude/i);
  assert.strictEqual(db.issues.length, 0);
});

check('a report with no GPS is accepted and flagged as location-unavailable', async () => {
  reset();
  db.issues = [];
  db.deliveries.get('507f1f77bcf86cd799439031').currentLocation = { latitude: null, longitude: null, accuracy: null };
  const res = await request('POST', '/api/v1/delivery-issues', {
    token: token(courier),
    body: { orderId: 'ORD-1001', issueType: 'CANNOT_FIND_LOCATION', description: 'Cannot find the address' },
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.locationAvailable, false);
  assert.strictEqual(res.body.issue.latitude, null, 'never a fabricated 0');
  assert.strictEqual(res.body.issue.longitude, null);
});

check('a multipart report with a photo is accepted', async () => {
  reset();
  db.issues = [];
  const boundary = '----verifyboundary';
  // A real 1x1 JPEG, so the upload utility's magic-byte check genuinely passes
  // and the photo path is exercised rather than swallowed by the fallback.
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64'
  );
  const part = (name, value, filename, type) => {
    const disposition = filename
      ? `Content-Disposition: form-data; name="${name}"; filename="${filename}"`
      : `Content-Disposition: form-data; name="${name}"`;
    return Buffer.concat([
      Buffer.from(`--${boundary}\r\n${disposition}\r\n`),
      type ? Buffer.from(`Content-Type: ${type}\r\n`) : Buffer.alloc(0),
      Buffer.from('\r\n'),
      Buffer.isBuffer(value) ? value : Buffer.from(String(value)),
      Buffer.from('\r\n'),
    ]);
  };
  const parts = Buffer.concat([
    part('orderId', 'ORD-1001'),
    part('issueType', 'BAD_WEATHER'),
    part('description', 'Heavy rain, road flooded'),
    part('photo', jpeg, 'proof.jpg', 'image/jpeg'),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const res = await request('POST', '/api/v1/delivery-issues', {
    token: token(courier),
    body: parts,
    contentType: `multipart/form-data; boundary=${boundary}`,
  });
  assert.strictEqual(res.status, 201, res.raw.slice(0, 300));
  assert.strictEqual(res.body.issue.issueType, 'BAD_WEATHER');
  // The photo must actually have been stored, not silently dropped.
  assert.ok(
    typeof res.body.issue.photo === 'string' && res.body.issue.photo.length > 0,
    `the photo must be attached (got ${JSON.stringify(res.body.issue.photo)})`
  );
});

check('a duplicate open problem of the same type is refused', async () => {
  reset();
  // db.issues already holds one OPEN HEAVY_TRAFFIC issue on this delivery.
  const res = await request('POST', '/api/v1/delivery-issues', {
    token: token(courier),
    body: { orderId: 'ORD-1001', issueType: 'HEAVY_TRAFFIC', description: 'still stuck' },
  });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(db.issues.length, 1);
});

check('a customer is refused the management list', async () => {
  reset();
  const res = await request('GET', '/api/v1/delivery-issues', { token: token(customer) });
  assert.strictEqual(res.status, 403);
});

check('the customer delay endpoint returns a boolean, safe to render', async () => {
  reset();
  const res = await request('GET', '/api/v1/delivery-issues/order/ORD-1001', { token: token(customer) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof res.body.delayed, 'boolean', 'the UI reads a boolean');
  assert.strictEqual(res.body.delayed, true);
  // Nothing internal may be in the payload the customer can reach.
  const serialised = JSON.stringify(res.body);
  assert.ok(!/HEAVY_TRAFFIC/.test(serialised), 'the customer must not see the issue type');
  assert.ok(!/Gridlock/.test(serialised), 'the customer must not see the description');
});

check('the customer delay clears once the issue is resolved', async () => {
  reset();
  db.issues[0].status = 'RESOLVED';
  db.issues[0].resolvedAt = new Date();
  const res = await request('GET', '/api/v1/delivery-issues/order/ORD-1001', { token: token(customer) });
  assert.strictEqual(res.body.delayed, false);
});

check('a customer cannot read another customers order issues', async () => {
  reset();
  const stranger = { _id: 'stranger', name: 'No', role: 'customer', status: 'ACTIVE' };
  db.users.set('stranger', stranger);
  const res = await request('GET', '/api/v1/delivery-issues/order/ORD-1001', { token: token(stranger) });
  assert.ok(res.status === 403, `expected 403, got ${res.status}`);
});

check('an invalid issue id is a clean 404, not a 500 CastError', async () => {
  reset();
  const res = await request('GET', '/api/v1/delivery-issues/not-an-object-id', { token: token(managerA) });
  assert.ok(res.status === 404, `expected 404, got ${res.status}: ${res.raw.slice(0, 160)}`);
  assert.strictEqual(res.status, 404);
});

check('a manager can look an issue up by human order id', async () => {
  reset();
  const res = await request('GET', '/api/v1/delivery-issues/ORD-1001', { token: token(managerA) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.issue.orderId, 'ORD-1001');
});

check('a foreign manager is refused an issue detail by id', async () => {
  reset();
  const res = await request('GET', `/api/v1/delivery-issues/${ISSUE_ID}`, { token: token(managerB) });
  assert.ok(res.status === 403, `expected 403, got ${res.status}`);
});

check('a manager can resolve an issue', async () => {
  reset();
  const res = await request('PATCH', `/api/v1/delivery-issues/${ISSUE_ID}/resolve`, {
    token: token(managerA),
    body: { resolutionNote: 'Road cleared' },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.issue.status, 'RESOLVED');
  assert.strictEqual(res.body.issue.resolutionNote, 'Road cleared');
  // The hold is released once the last open issue is closed.
  assert.strictEqual(db.deliveries.get('507f1f77bcf86cd799439031').onHold, false);
});

check('a foreign manager cannot resolve the issue', async () => {
  reset();
  const res = await request('PATCH', `/api/v1/delivery-issues/${ISSUE_ID}/resolve`, {
    token: token(managerB),
    body: { resolutionNote: 'not my cafeteria' },
  });
  assert.ok(res.status === 403, `expected 403, got ${res.status}`);
  assert.strictEqual(db.issues[0].status, 'OPEN', 'the issue must be untouched');
});

check('a courier cannot resolve their own issue', async () => {
  reset();
  const res = await request('PATCH', `/api/v1/delivery-issues/${ISSUE_ID}/resolve`, {
    token: token(courier),
    body: { resolutionNote: 'I fixed it myself' },
  });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(db.issues[0].status, 'OPEN');
});

check('a manager can hold a delivery, and the flag is set', async () => {
  reset();
  const res = await request('PATCH', `/api/v1/delivery-issues/${ISSUE_ID}/hold`, {
    token: token(managerA),
    body: { reason: 'Waiting for a second rider' },
  });
  assert.strictEqual(res.status, 200);
  const delivery = db.deliveries.get('507f1f77bcf86cd799439031');
  assert.strictEqual(delivery.onHold, true);
  assert.strictEqual(delivery.holdReason, 'Waiting for a second rider');
  // The delivery status itself must not move.
  assert.strictEqual(delivery.status, 'OUT_FOR_DELIVERY');
});

check('a manager can continue a held delivery', async () => {
  reset();
  const delivery = db.deliveries.get('507f1f77bcf86cd799439031');
  delivery.onHold = true;
  const res = await request('PATCH', `/api/v1/delivery-issues/${ISSUE_ID}/continue`, { token: token(managerA) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(delivery.onHold, false);
  assert.strictEqual(delivery.status, 'OUT_FOR_DELIVERY', 'continuing must not change the status');
});

check('holding an already resolved issue is refused', async () => {
  reset();
  db.issues[0].status = 'RESOLVED';
  const res = await request('PATCH', `/api/v1/delivery-issues/${ISSUE_ID}/hold`, { token: token(managerA) });
  assert.strictEqual(res.status, 409, 'a closed issue must not be able to freeze a delivery');
  assert.strictEqual(db.deliveries.get('507f1f77bcf86cd799439031').onHold, false);
});

check('reassignment requires a valid courier id', async () => {
  reset();
  const bad = await request('PATCH', `/api/v1/delivery-issues/${ISSUE_ID}/reassign`, {
    token: token(managerA),
    body: { deliveryStaffId: 'nope' },
  });
  assert.strictEqual(bad.status, 400);

  const missing = await request('PATCH', `/api/v1/delivery-issues/${ISSUE_ID}/reassign`, {
    token: token(managerA),
    body: {},
  });
  assert.strictEqual(missing.status, 400);
});

check('a manager can reassign the delivery to a relief courier', async () => {
  reset();
  emitted.length = 0;
  const res = await request('PATCH', `/api/v1/delivery-issues/${ISSUE_ID}/reassign`, {
    token: token(managerA),
    body: { deliveryStaffId: RELIEF_COURIER },
  });
  assert.strictEqual(res.status, 200, res.raw.slice(0, 300));

  // The delivery must now be carried by the new rider.
  const delivery = db.deliveries.get('507f1f77bcf86cd799439031');
  assert.strictEqual(String(delivery.deliveryPerson), RELIEF_COURIER, 'the delivery record must be reassigned');
  const order = db.orders.get('507f1f77bcf86cd799439021');
  const assigned = order.deliveryStaffAssigned;
  const assignedId = assigned && typeof assigned === 'object' ? assigned._id : assigned;
  assert.strictEqual(String(assignedId), RELIEF_COURIER, 'the order must follow the delivery');

  // The issue records who moved it and who decided - the audit trail the
  // previous actor-id bug used to wipe out.
  const issue = db.issues[0];
  assert.strictEqual(issue.reassignedTo, RELIEF_COURIER);
  assert.ok(issue.reassignedAt, 'reassignedAt must be stamped');
  assert.strictEqual(issue.reassignedBy, MANAGER_A, 'reassignedBy must come from the JWT, not be undefined');
  assert.strictEqual(issue.status, 'OPEN', 'the issue stays open for the new rider to resolve');
});

check('a courier from another cafeteria cannot be assigned to the delivery', async () => {
  reset();
  const foreign = { _id: '507f1f77bcf86cd799439072', name: 'Foreign', role: 'delivery', status: 'ACTIVE', cafeteriaId: CAF_B };
  db.users.set(String(foreign._id), foreign);
  const res = await request('PATCH', `/api/v1/delivery-issues/${ISSUE_ID}/reassign`, {
    token: token(managerA),
    body: { deliveryStaffId: foreign._id },
  });
  assert.strictEqual(res.status, 403, 'cross-cafeteria reassignment must be refused');
  assert.notStrictEqual(
    String(db.deliveries.get('507f1f77bcf86cd799439031').deliveryPerson),
    foreign._id,
    'the delivery must not have moved'
  );
});

check('a manager can cancel the delivery because of the issue', async () => {
  reset();
  emitted.length = 0;
  const res = await request('PATCH', `/api/v1/delivery-issues/${ISSUE_ID}/cancel-delivery`, {
    token: token(managerA),
    body: { reason: 'Rider vehicle broke down, customer refunded' },
  });
  assert.strictEqual(res.status, 200, res.raw.slice(0, 300));
  const delivery = db.deliveries.get('507f1f77bcf86cd799439031');
  assert.strictEqual(delivery.status, 'CANCELLED', 'the delivery must actually be cancelled');
  assert.ok(delivery.cancelledAt, 'the cancellation must be timestamped');
  const order = db.orders.get('507f1f77bcf86cd799439021');
  assert.ok(order.cancellationReason, 'the reason must be recorded on the order');
  // The customer-reachable rooms must not learn why internally.
  const shared = emitted.filter((e) => e.room.startsWith('order:') || e.room.startsWith('delivery:'));
  for (const entry of shared) {
    assert.ok(
      !JSON.stringify(entry.payload).includes('Rider vehicle broke down'),
      `shared room ${entry.room} leaked the internal cancellation reason`
    );
  }
});

check('a customer cannot use any manager issue action', async () => {
  reset();
  for (const action of ['start', 'resolve', 'cancel', 'hold', 'continue', 'reassign', 'cancel-delivery']) {
    const res = await request('PATCH', `/api/v1/delivery-issues/${ISSUE_ID}/${action}`, {
      token: token(customer),
      body: {},
    });
    assert.strictEqual(res.status, 403, `${action} must be refused for a customer`);
  }
  assert.strictEqual(db.issues[0].status, 'OPEN');
});

check('the stats endpoint is management-only and returns counts', async () => {
  reset();
  const denied = await request('GET', '/api/v1/delivery-issues/stats', { token: token(courier) });
  assert.strictEqual(denied.status, 403);

  const res = await request('GET', '/api/v1/delivery-issues/stats', { token: token(managerA) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof res.body.stats.open, 'number');
  assert.strictEqual(res.body.stats.open, 1);
});

check('every route the UI calls exists and is not 404', async () => {
  reset();
  const probes = [
    ['GET', '/api/v1/delivery-issues', token(managerA)],
    ['GET', '/api/v1/delivery-issues/stats', token(managerA)],
    ['GET', '/api/v1/delivery-issues/meta/types', token(courier)],
    ['GET', '/api/v1/delivery-issues/order/ORD-1001', token(customer)],
    ['GET', `/api/v1/delivery-issues/${ISSUE_ID}`, token(managerA)],
  ];
  for (const [method, path, tok] of probes) {
    const res = await request(method, path, { token: tok });
    assert.notStrictEqual(res.status, 404, `${method} ${path} must be routed (got 404)`);
    assert.ok(res.status < 500, `${method} ${path} must not 500 (got ${res.status}: ${res.raw.slice(0, 200)})`);
  }
});

check('no customer-facing response leaks the issue id or GPS', async () => {
  reset();
  const res = await request('GET', '/api/v1/delivery-issues/order/ORD-1001', { token: token(customer) });
  const serialised = JSON.stringify(res.body);
  for (const secret of [ISSUE_ID, '9.0192', '38.7525', 'Gridlock', 'HEAVY_TRAFFIC', COURIER]) {
    assert.ok(!serialised.includes(secret), `customer response leaked ${secret}`);
  }
});

// --- socket fan-out -------------------------------------------------------
//
// The customer who owns the order passes `canAccessOrder`, so they are allowed
// into BOTH `order:<id>` and `delivery:<id>`. A full staff payload on either
// room would hand the customer the courier's description, the internal GPS
// position and the reporter's identity. The emits are recorded in `emitted`
// (see the require.cache stub near the top) so the rule is enforced, not assumed.

check('the shared rooms never receive the internal issue payload', async () => {
  reset();
  db.issues = [];
  emitted.length = 0;

  const res = await request('POST', '/api/v1/delivery-issues', {
    token: token(courier),
    body: {
      orderId: 'ORD-1001',
      issueType: 'SAFETY_PROBLEM',
      description: 'Rear brake light is smashed',
      latitude: 9.03,
      longitude: 38.74,
    },
  });
  assert.strictEqual(res.status, 201);

  const shared = emitted.filter((e) => e.event === 'delivery:issue' && e.room.startsWith('order:'));
  assert.ok(shared.length > 0, 'the order room must be notified');
  const deliveryRoom = emitted.filter((e) => e.event === 'delivery:issue' && e.room.startsWith('delivery:'));
  assert.ok(deliveryRoom.length > 0, 'the delivery room must be notified');

  // Anything reachable by the customer must be the safe projection only.
  const forbidden = [String(db.issues[0]._id), '9.03', '38.74', 'Rear brake', 'SAFETY_PROBLEM', COURIER];
  for (const entry of [...shared, ...deliveryRoom]) {
    const serialised = JSON.stringify(entry.payload);
    for (const secret of forbidden) {
      assert.ok(!serialised.includes(secret), `shared room ${entry.room} leaked ${secret}`);
    }
    assert.strictEqual(entry.payload.delayed, true, 'the customer still needs the delay flag');
  }

  // Staff still get the detail, but only on their own authenticated room.
  const staff = emitted.filter((e) => e.event === 'delivery:issue' && e.room.startsWith('user:'));
  assert.ok(staff.length > 0, 'staff must still be notified');
  const staffBody = JSON.stringify(staff[0].payload);
  assert.ok(staffBody.includes('Rear brake'), 'staff rooms must carry the real description');
  assert.ok(!staff.some((e) => e.room === 'admin' || e.room === 'delivery'), 'no global room fan-out');
});

// --- run -------------------------------------------------------------------

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let passed = 0;
  const failures = [];
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failures.push(`${name}\n      ${error.message}`);
    }
  }
  server.close();
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    console.log('');
    process.exit(1);
  }
  console.log('Delivery issue HTTP wiring verified.');
  // Keep-alive sockets and the Mongoose model layer can hold the loop open.
  process.exit(0);
})();
