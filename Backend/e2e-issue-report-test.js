/**
 * Kitchen Issue Report -> Manager Accept/Solution End-to-End Test
 *
 * Real workflow against the LIVE backend (port 5000) and LIVE MongoDB:
 *   create (PENDING) -> accept (ACCEPTED) -> solution (RESOLVED)
 *
 * Accounts are provisioned through real authenticated APIs (admin user
 * creation) - nothing is mocked. Socket.IO events are captured from real
 * authenticated connections. Persistence is verified by reading MongoDB
 * directly (IssueReport, Notification, ActivityLog collections).
 *
 * Run:  node e2e-issue-report-test.js   (from Backend/)
 */
require('dotenv').config();
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io: ioc } = require('socket.io-client');

const PORT = Number(process.env.PORT || 5000);
const HOST = '127.0.0.1';
const JWT_SECRET = process.env.JWT_SECRET;

const IssueReport = require('./src/models/IssueReport');
const Notification = require('./src/models/Notification');
const ActivityLog = require('./src/models/ActivityLog');
const User = require('./src/models/User');

const runId = Date.now();
const results = [];
let pass = 0;
let fail = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(fn, timeout = 3000, interval = 50) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(interval);
  }
  return Boolean(fn());
}

function api(method, reqPath, token, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HOST, port: PORT, path: reqPath, method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    };
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(d); } catch (e) { json = { raw: d }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body !== undefined && body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

async function login(identifier, password) {
  const r = await api('POST', '/api/v1/auth/login', null, { identifier, password });
  if (r.status !== 200 || !r.body.token) {
    throw new Error(`login failed for ${identifier}: HTTP ${r.status} ${r.body.error || ''}`);
  }
  return { token: r.body.token, user: r.body.user };
}

/**
 * Same approach as gps-e2e-test.js: sign a real JWT for an existing DB user
 * (seeded accounts on this environment do not use the seeder's default password).
 */
function signToken(user) {
  return jwt.sign(
    { id: String(user._id), role: user.role, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/** Real login when the password is known; signed JWT fallback for seed accounts. */
async function authFor(identifier, password, dbUser) {
  try {
    return await login(identifier, password);
  } catch (e) {
    if (!dbUser) throw e;
    console.log(`  (login failed for ${identifier}, using signed JWT for real DB user - gps-e2e pattern)`);
    return {
      token: signToken(dbUser),
      user: { id: String(dbUser._id), name: dbUser.name, email: dbUser.email, role: dbUser.role },
    };
  }
}

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const socket = ioc('http://' + HOST + ':' + PORT, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    const to = setTimeout(() => { socket.disconnect(); reject(new Error('socket connect timeout')); }, 5000);
    socket.on('connect', () => { clearTimeout(to); resolve(socket); });
    socket.on('connect_error', err => { clearTimeout(to); socket.disconnect(); reject(err); });
  });
}

function capture(socket, event) {
  const events = [];
  socket.on(event, payload => events.push(payload));
  return events;
}

let phoneSeq = 1000;
function uniquePhone() {
  phoneSeq += 1;
  return '09' + String((runId % 1e7) * 10 + (phoneSeq % 10)).slice(0, 8).padStart(8, '0');
}

/** Find by email via the admin users API; create when missing. Returns the user. */
async function ensureUser(adminToken, { name, email, password, role, cafeteriaId }) {
  const search = await api('GET', `/api/v1/users?search=${encodeURIComponent(email)}&limit=5`, adminToken);
  const existing = (search.body.users || []).find(u => u.email === email);
  if (existing) {
    // Keep the account usable for this run even if it was created previously.
    await api('PATCH', `/api/v1/users/${existing.id}/password`, adminToken, { password });
    if (cafeteriaId && String(existing.cafeteriaId) !== String(cafeteriaId)) {
      await api('PUT', `/api/v1/users/${existing.id}`, adminToken, { cafeteriaId });
      existing.cafeteriaId = cafeteriaId;
    }
    return existing;
  }
  const created = await api('POST', '/api/v1/users', adminToken, {
    name, email, phone: uniquePhone(), role, password, cafeteriaId,
  });
  if (created.status !== 201) {
    throw new Error(`create user ${email} failed: HTTP ${created.status} ${created.body.error || ''}`);
  }
  return created.body.user;
}

function notificationsList(body) {
  return body.notifications || body.data || [];
}

async function main() {
  console.log('=== Issue Report E2E Test ===\n');

  // ---------------------------------------------------------------
  // 0. Connect to MongoDB (same DB the live server uses)
  // ---------------------------------------------------------------
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB\n');

  // ---------------------------------------------------------------
  // 1. Provision real accounts through the admin API
  // ---------------------------------------------------------------
  console.log('[setup] locating real admin + kitchen users in MongoDB');
  if (!JWT_SECRET) throw new Error('JWT_SECRET missing');
  const adminDoc = await User.findOne({
    role: 'admin', status: 'ACTIVE', isActive: { $ne: false },
  }).sort({ createdAt: 1 });
  const kitchenDoc = await User.findOne({
    role: 'kitchen', status: 'ACTIVE', isActive: { $ne: false },
  }).sort({ createdAt: 1 });
  if (!adminDoc || !kitchenDoc) throw new Error('need at least one active admin and kitchen user in DB');

  const admin = await authFor(adminDoc.email, 'password123', adminDoc);
  record('Admin authenticated (real DB admin account)', admin.token && admin.user.id === String(adminDoc._id));

  let cafRes = await api('GET', '/api/v1/cafeterias', admin.token);
  let cafeterias = cafRes.body.cafeterias || [];
  if (cafeterias.length < 2) {
    const code = 'E2E' + String(runId % 1e6);
    const created = await api('POST', '/api/v1/cafeterias', admin.token, {
      name: 'E2E Test Cafeteria ' + code,
      code,
    });
    if (created.status === 201 || created.status === 200) {
      cafeterias = (await api('GET', '/api/v1/cafeterias', admin.token)).body.cafeterias || [];
    } else {
      record('Second cafeteria created for cross-cafeteria test', false,
        `HTTP ${created.status} ${created.body.error || ''}`);
    }
  }
  record('At least two cafeterias available', cafeterias.length >= 2,
    `found ${cafeterias.length}`);

  const kitchenSeed = kitchenDoc;
  const defaultCaf = cafeterias.find(c => c.isDefault) || cafeterias[0];
  if (!kitchenSeed.cafeteriaId) {
    const upd = await api('PUT', `/api/v1/users/${kitchenSeed.id || kitchenSeed._id}`, admin.token, { cafeteriaId: defaultCaf.id });
    if (upd.status === 200) kitchenSeed.cafeteriaId = defaultCaf.id;
    record('Backfilled cafeteriaId on seeded kitchen user', Boolean(kitchenSeed.cafeteriaId));
  }
  const cafA = String(kitchenSeed.cafeteriaId);
  const cafB = (cafeterias.find(c => String(c.id) !== cafA) || {}).id;
  record('Cafeteria A (kitchen) and B (other) resolved and distinct',
    Boolean(cafA && cafB) && String(cafA) !== String(cafB), `A=${cafA} B=${cafB}`);

  const pw = 'E2ePass@' + (runId % 100000);
  const kitchen2 = await ensureUser(admin.token, {
    name: 'E2E Kitchen Two', email: 'e2e.kitchen2@scos.test',
    password: pw, role: 'kitchen', cafeteriaId: cafA,
  });
  const manager1 = await ensureUser(admin.token, {
    name: 'E2E Manager One', email: 'e2e.mgr1@scos.test',
    password: pw, role: 'manager', cafeteriaId: cafA,
  });
  const manager2 = await ensureUser(admin.token, {
    name: 'E2E Manager Two', email: 'e2e.mgr2@scos.test',
    password: pw, role: 'manager', cafeteriaId: cafB,
  });
  const cafAdmin1 = await ensureUser(admin.token, {
    name: 'E2E Cafeteria Admin', email: 'e2e.cafadmin@scos.test',
    password: pw, role: 'cafeteria_admin', cafeteriaId: cafA,
  });
  record('Provisioned kitchen2, manager1, manager2, cafeteria_admin via API',
    Boolean(kitchen2 && manager1 && manager2 && cafAdmin1));
  record('manager1 in cafeteria A, manager2 in cafeteria B (distinct)',
    String(manager1.cafeteriaId) === String(cafA) && String(manager2.cafeteriaId) === String(cafB),
    `mgr1=${manager1.cafeteriaId} mgr2=${manager2.cafeteriaId}`);

  // ---------------------------------------------------------------
  // 2. Authenticate everyone + connect real sockets
  // ---------------------------------------------------------------
  console.log('\n[setup] logging in and connecting sockets');
  const kitchen = await authFor(kitchenDoc.email, 'password123', kitchenDoc);
  record('Kitchen authenticated (real DB kitchen account)',
    kitchen.token && kitchen.user.id === String(kitchenDoc._id));
  const kitchen2Auth = await login(kitchen2.email, pw);
  const mgr1Auth = await login(manager1.email, pw);
  const mgr2Auth = await login(manager2.email, pw);
  const cafAdminAuth = await login(cafAdmin1.email, pw);
  record('All provisioned roles logged in via API (kitchen2, manager1, manager2, cafeteria_admin)', true);

  const kitchenSock = await connectSocket(kitchen.token);
  const mgrSock = await connectSocket(mgr1Auth.token);
  await sleep(300); // allow room joins (kitchen / admin / user:<id>)

  const kitchenNotifs = capture(kitchenSock, 'notification:new');
  const kitchenUpdates = capture(kitchenSock, 'issue:updated');
  const mgrCreated = capture(mgrSock, 'issue:created');
  const mgrNotifs = capture(mgrSock, 'notification:new');

  // ---------------------------------------------------------------
  // 3. Kitchen creates issue report (PENDING)
  // ---------------------------------------------------------------
  console.log('\n[flow] create -> accept -> solution');
  const issue1Body = {
    title: `E2E Broken Oven ${runId}`,
    description: 'The industrial oven in the west kitchen is not heating past 120C. Tickets for baked items are backing up.',
    category: 'equipment',
    priority: 'critical',
  };
  const create1 = await api('POST', '/api/v1/issues', kitchen.token, issue1Body);
  record('Kitchen creates issue -> 201 PENDING',
    create1.status === 201 && create1.body.issue && create1.body.issue.status === 'PENDING',
    `HTTP ${create1.status} status=${create1.body.issue && create1.body.issue.status}`);
  const issue1 = create1.body.issue;
  const issue1Id = issue1 && issue1.id;

  record('Reporter stamped from JWT (kitchen user)',
    issue1 && issue1.reportedBy && issue1.reportedBy.id === String(kitchenDoc._id),
    JSON.stringify(issue1 && issue1.reportedBy));
  record('cafeteriaId stamped (cafeteria A)',
    issue1 && String(issue1.cafeteriaId) === String(cafA),
    `issue=${issue1 && issue1.cafeteriaId} expected=${cafA}`);

  // Real-time: manager socket receives issue:created + notification:new
  const gotCreated = await waitFor(() => mgrCreated.some(e => String(e.id) === String(issue1Id)));
  record('Socket issue:created received by manager (admin room)', gotCreated);
  const gotMgrNotif = await waitFor(() =>
    mgrNotifs.some(e => e.title === 'New Issue Report'));
  record('Socket notification:new received by manager on create', gotMgrNotif);

  // MongoDB persistence (direct read)
  const dbIssue1 = await IssueReport.findById(issue1Id).lean();
  record('IssueReport persisted in MongoDB with status PENDING',
    dbIssue1 && dbIssue1.status === 'PENDING' &&
    dbIssue1.title === issue1Body.title &&
    String(dbIssue1.reportedBy) === String(kitchenDoc._id) &&
    String(dbIssue1.cafeteriaId) === String(cafA),
    dbIssue1 ? `status=${dbIssue1.status}` : 'not found');

  // ---------------------------------------------------------------
  // 4. Role-scoped listing + viewing
  // ---------------------------------------------------------------
  console.log('\n[rbac] lists and single-view scoping');
  const k1List = await api('GET', '/api/v1/issues', kitchen.token);
  const k2List = await api('GET', '/api/v1/issues', kitchen2Auth.token);
  const m1List = await api('GET', '/api/v1/issues', mgr1Auth.token);
  const m2List = await api('GET', '/api/v1/issues', mgr2Auth.token);
  const caList = await api('GET', '/api/v1/issues', cafAdminAuth.token);
  const adList = await api('GET', '/api/v1/issues', admin.token);

  const has = (r) => (r.body.issues || []).some(i => String(i.id) === String(issue1Id));
  record('Kitchen1 list contains own report', k1List.status === 200 && has(k1List));
  record('Kitchen2 list does NOT contain kitchen1 report (own-only)',
    k2List.status === 200 && !has(k2List));
  record('Manager1 (cafeteria A) list contains report',
    m1List.status === 200 && has(m1List));
  record('Manager2 (cafeteria B) list does NOT contain report (cross-cafeteria)',
    m2List.status === 200 && !has(m2List));
  record('Cafeteria Admin list contains report (view allowed)',
    caList.status === 200 && has(caList));
  record('System Admin list contains report (global view)',
    adList.status === 200 && has(adList));

  const vKitchen = await api('GET', `/api/v1/issues/${issue1Id}`, kitchen.token);
  const vKitchen2 = await api('GET', `/api/v1/issues/${issue1Id}`, kitchen2Auth.token);
  const vMgr1 = await api('GET', `/api/v1/issues/${issue1Id}`, mgr1Auth.token);
  const vMgr2 = await api('GET', `/api/v1/issues/${issue1Id}`, mgr2Auth.token);
  record('Kitchen1 GET own report -> 200', vKitchen.status === 200);
  record('Kitchen2 GET other kitchen report -> 403', vKitchen2.status === 403,
    `HTTP ${vKitchen2.status}`);
  record('Manager1 GET same-cafeteria report -> 200', vMgr1.status === 200);
  record('Manager2 GET cross-cafeteria report -> 403', vMgr2.status === 403,
    `HTTP ${vMgr2.status}`);

  // ---------------------------------------------------------------
  // 5. RBAC: who may NOT create / accept / solve
  // ---------------------------------------------------------------
  console.log('\n[rbac] write actions');
  const mgrCreate = await api('POST', '/api/v1/issues', mgr1Auth.token, {
    title: 'Manager should not create', description: 'Testing create RBAC.', category: 'other',
  });
  record('Manager cannot create issue -> 403', mgrCreate.status === 403, `HTTP ${mgrCreate.status}`);

  const kAccept = await api('PATCH', `/api/v1/issues/${issue1Id}/accept`, kitchen.token, {});
  record('Kitchen cannot accept issue -> 403', kAccept.status === 403, `HTTP ${kAccept.status}`);

  const kSolve = await api('PATCH', `/api/v1/issues/${issue1Id}/solution`, kitchen.token, { solution: 'nope' });
  record('Kitchen cannot send solution -> 403', kSolve.status === 403, `HTTP ${kSolve.status}`);

  const caAccept = await api('PATCH', `/api/v1/issues/${issue1Id}/accept`, cafAdminAuth.token, {});
  record('Cafeteria Admin cannot accept (view only) -> 403', caAccept.status === 403,
    `HTTP ${caAccept.status}`);

  const m2Accept = await api('PATCH', `/api/v1/issues/${issue1Id}/accept`, mgr2Auth.token, {});
  record('Manager2 cannot accept cross-cafeteria report -> 403', m2Accept.status === 403,
    `HTTP ${m2Accept.status}`);

  const noAuth = await api('GET', '/api/v1/issues', null);
  record('Unauthenticated list -> 401', noAuth.status === 401, `HTTP ${noAuth.status}`);

  const badStatus = await api('GET', '/api/v1/issues?status=BOGUS', kitchen.token);
  record('Invalid status query -> 400', badStatus.status === 400, `HTTP ${badStatus.status}`);

  // ---------------------------------------------------------------
  // 6. Second issue: solution-before-accept, duplicate guard, validation
  // ---------------------------------------------------------------
  console.log('\n[validation] transitions and guards');
  const issue2Body = {
    title: `E2E Missing Cutlery ${runId}`,
    description: 'Cutlery drawer for counter 2 is empty during lunch rush.',
    category: 'stock',
    priority: 'high',
  };
  const create2 = await api('POST', '/api/v1/issues', kitchen.token, issue2Body);
  const issue2Id = create2.body.issue && create2.body.issue.id;
  record('Second issue created (PENDING)',
    create2.status === 201 && create2.body.issue.status === 'PENDING');

  const earlySolution = await api('PATCH', `/api/v1/issues/${issue2Id}/solution`, mgr1Auth.token,
    { solution: 'Jumping the gun' });
  record('Solution on PENDING issue -> 400 (must accept first)',
    earlySolution.status === 400, `HTTP ${earlySolution.status} ${earlySolution.body.error || ''}`);

  const dup = await api('POST', '/api/v1/issues', kitchen.token, issue2Body);
  record('Identical open duplicate -> 409', dup.status === 409, `HTTP ${dup.status}`);

  const emptyTitle = await api('POST', '/api/v1/issues', kitchen.token,
    { title: '   ', description: 'x' });
  record('Empty title -> 400', emptyTitle.status === 400, `HTTP ${emptyTitle.status}`);

  const badCat = await api('POST', '/api/v1/issues', kitchen.token,
    { title: 'Cat test ' + runId, description: 'x', category: 'nonsense' });
  record('Invalid category -> 400', badCat.status === 400, `HTTP ${badCat.status}`);

  const invalidId = await api('GET', '/api/v1/issues/not-an-id', kitchen.token);
  record('Invalid issue id -> 400', invalidId.status === 400, `HTTP ${invalidId.status}`);

  const missingId = await api('GET', '/api/v1/issues/aaaaaaaaaaaaaaaaaaaaaaaa', manager1 ? mgr1Auth.token : null);
  record('Non-existent valid id -> 404', missingId.status === 404, `HTTP ${missingId.status}`);

  const emptySolution = await api('PATCH', `/api/v1/issues/${issue1Id}/solution`, mgr1Auth.token,
    { solution: '   ' });
  record('Empty solution -> 400', emptySolution.status === 400, `HTTP ${emptySolution.status}`);

  // ---------------------------------------------------------------
  // 7. Manager accepts (PENDING -> ACCEPTED)
  // ---------------------------------------------------------------
  const accept1 = await api('PATCH', `/api/v1/issues/${issue1Id}/accept`, mgr1Auth.token, {});
  record('Manager accepts issue -> 200 ACCEPTED',
    accept1.status === 200 && accept1.body.issue.status === 'ACCEPTED',
    `HTTP ${accept1.status} status=${accept1.body.issue && accept1.body.issue.status}`);
  const accepted = accept1.body.issue || {};
  record('acceptedBy set to manager1',
    accepted.acceptedBy && accepted.acceptedBy.id === manager1.id,
    JSON.stringify(accepted.acceptedBy));
  record('acceptedAt timestamp set', Boolean(accepted.acceptedAt));

  const gotKitchenNotifAccept = await waitFor(() =>
    kitchenNotifs.some(e => e.title === 'Issue Report Accepted'));
  record('Socket notification:new -> kitchen on accept', gotKitchenNotifAccept);
  const gotKitchenUpdateAccept = await waitFor(() =>
    kitchenUpdates.some(e => String(e.id) === String(issue1Id) && e.status === 'ACCEPTED'));
  record('Socket issue:updated (ACCEPTED) -> kitchen room', gotKitchenUpdateAccept);

  const acceptAgain = await api('PATCH', `/api/v1/issues/${issue1Id}/accept`, mgr1Auth.token, {});
  record('Accept twice -> 400', acceptAgain.status === 400, `HTTP ${acceptAgain.status}`);

  const dbNotifAccept = await Notification.findOne({
    userId: kitchenDoc._id, title: 'Issue Report Accepted',
  }).sort({ createdAt: -1 }).lean();
  record('"Issue Report Accepted" notification persisted in MongoDB for kitchen',
    Boolean(dbNotifAccept), dbNotifAccept ? '' : 'not found');

  // ---------------------------------------------------------------
  // 8. Manager sends solution (ACCEPTED -> RESOLVED)
  // ---------------------------------------------------------------
  const solutionText = 'Replacement heating element delivered and installed; oven calibrated to 220C and test-baked successfully.';
  const solve1 = await api('PATCH', `/api/v1/issues/${issue1Id}/solution`, mgr1Auth.token,
    { solution: solutionText });
  record('Manager sends solution -> 200 RESOLVED',
    solve1.status === 200 && solve1.body.issue.status === 'RESOLVED',
    `HTTP ${solve1.status} status=${solve1.body.issue && solve1.body.issue.status}`);
  const solved = solve1.body.issue || {};
  record('solution text saved', solved.solution === solutionText);
  record('repliedBy set to manager1',
    solved.repliedBy && solved.repliedBy.id === manager1.id, JSON.stringify(solved.repliedBy));
  record('repliedAt + resolvedAt timestamps set',
    Boolean(solved.repliedAt) && Boolean(solved.resolvedAt));

  const gotKitchenNotifSolve = await waitFor(() =>
    kitchenNotifs.some(e => e.title === 'Solution Provided'));
  record('Socket notification:new -> kitchen on solution', gotKitchenNotifSolve);
  const gotKitchenUpdateSolve = await waitFor(() =>
    kitchenUpdates.some(e => String(e.id) === String(issue1Id) && e.status === 'RESOLVED'));
  record('Socket issue:updated (RESOLVED) -> kitchen room', gotKitchenUpdateSolve);

  // Kitchen now sees the manager's solution on the report
  const finalView = await api('GET', `/api/v1/issues/${issue1Id}`, kitchen.token);
  record('Kitchen sees solution + manager name + repliedAt',
    finalView.status === 200 &&
    finalView.body.issue.solution === solutionText &&
    finalView.body.issue.repliedBy && finalView.body.issue.repliedBy.name === manager1.name &&
    Boolean(finalView.body.issue.repliedAt),
    JSON.stringify(finalView.body.issue && finalView.body.issue.repliedBy));

  // Terminal-state guards
  const solveAgain = await api('PATCH', `/api/v1/issues/${issue1Id}/solution`, mgr1Auth.token,
    { solution: 'again' });
  record('Solution on RESOLVED issue -> 400', solveAgain.status === 400, `HTTP ${solveAgain.status}`);
  const acceptResolved = await api('PATCH', `/api/v1/issues/${issue1Id}/accept`, mgr1Auth.token, {});
  record('Accept on RESOLVED issue -> 400', acceptResolved.status === 400, `HTTP ${acceptResolved.status}`);

  // Close out the second issue so nothing is left half-done
  await api('PATCH', `/api/v1/issues/${issue2Id}/accept`, mgr1Auth.token, {});
  const solve2 = await api('PATCH', `/api/v1/issues/${issue2Id}/solution`, mgr1Auth.token,
    { solution: 'Restocked cutlery from central store; par level alarm added.' });
  record('Second issue also driven to RESOLVED',
    solve2.status === 200 && solve2.body.issue.status === 'RESOLVED',
    `HTTP ${solve2.status}`);

  // ---------------------------------------------------------------
  // 9. Direct MongoDB verification
  // ---------------------------------------------------------------
  console.log('\n[mongodb] direct collection reads');
  const finalDb = await IssueReport.findById(issue1Id).lean();
  record('IssueReport final doc status=RESOLVED',
    finalDb && finalDb.status === 'RESOLVED');
  record('IssueReport final doc has solution/acceptedBy/repliedBy/resolvedAt',
    finalDb && finalDb.solution === solutionText &&
    finalDb.acceptedBy && finalDb.repliedBy && finalDb.resolvedAt &&
    String(finalDb.cafeteriaId) === String(cafA),
    JSON.stringify({
      status: finalDb && finalDb.status,
      acceptedBy: finalDb && String(finalDb.acceptedBy),
      repliedBy: finalDb && String(finalDb.repliedBy),
      cafeteriaId: finalDb && String(finalDb.cafeteriaId),
    }));

  const dbNotifSolve = await Notification.findOne({
    userId: kitchenDoc._id, title: 'Solution Provided',
  }).sort({ createdAt: -1 }).lean();
  record('"Solution Provided" notification persisted for kitchen', Boolean(dbNotifSolve));

  const dbNotifMgr = await Notification.findOne({
    userId: manager1.id, title: 'New Issue Report',
  }).sort({ createdAt: -1 }).lean();
  record('"New Issue Report" notification persisted for manager1', Boolean(dbNotifMgr));

  const auditCreated = await ActivityLog.findOne({ action: 'ISSUE_REPORT_CREATED', entityId: String(issue1Id) }).lean();
  const auditAccepted = await ActivityLog.findOne({ action: 'ISSUE_REPORT_ACCEPTED', entityId: String(issue1Id) }).lean();
  const auditResolved = await ActivityLog.findOne({ action: 'ISSUE_REPORT_RESOLVED', entityId: String(issue1Id) }).lean();
  record('Audit: ISSUE_REPORT_CREATED logged', Boolean(auditCreated));
  record('Audit: ISSUE_REPORT_ACCEPTED logged', Boolean(auditAccepted));
  record('Audit: ISSUE_REPORT_RESOLVED logged', Boolean(auditResolved));

  const apiNotifications = await api('GET', '/api/v1/notifications?unread=true', kitchen.token);
  const list = notificationsList(apiNotifications.body);
  record('Kitchen notifications API returns the accept/solution notifications',
    apiNotifications.status === 200 &&
    list.some(n => n.title === 'Issue Report Accepted') &&
    list.some(n => n.title === 'Solution Provided'),
    `count=${list.length}`);

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  kitchenSock.disconnect();
  mgrSock.disconnect();
  await mongoose.disconnect();

  console.log('\n=== SUMMARY ===');
  console.log(`PASS: ${pass}  FAIL: ${fail}  TOTAL: ${results.length}`);
  if (fail > 0) {
    console.log('\nFailed checks:');
    results.filter(r => !r.ok).forEach(r => console.log('  - ' + r.name + (r.detail ? ' -- ' + r.detail : '')));
  }
  console.log(`\nIssue report id (left in MongoDB as evidence): ${issue1Id}`);
  console.log(`Second issue id: ${issue2Id}`);
  console.log(`Provisioned users: ${kitchen2.email}, ${manager1.email}, ${manager2.email}, ${cafAdmin1.email}`);
  console.log(`Provisioned password (all new users): ${pw}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nE2E test aborted:', err);
  process.exit(1);
});
