/**
 * Report review + admin request workflow - acceptance test.
 *
 * Covers the end-to-end Manager-review → Admin-request → Admin-resolve flow:
 *   1. Kitchen creates a report (OPEN).
 *   2. Manager reviews (OPEN → UNDER_REVIEW) with investigation notes.
 *   3. Manager cannot resolve directly (403).
 *   4. Manager sends a ResolutionRequest (UNDER_REVIEW → REQUEST_SENT,
 *      creates a PENDING ResolutionRequest).
 *   5. Manager cannot send a request before review (400 when OPEN).
 *   6. Admin lists requests, accepts (PENDING → IN_PROGRESS),
 *      rejects (PENDING → REJECTED with required reason),
 *      resolves (IN_PROGRESS → RESOLVED) - cascading to the IssueReport.
 *   7. Backend lifecycle enforcement: cannot resolve before accept,
 *      cannot accept twice, manager resolve → 403.
 *   8. Duplicate open-request prevention (409).
 *   9. Manager cancel while PENDING works.
 *  10. Notifications sent to the requesting manager on accept / reject /
 *      resolve.
 *
 * Run: node tests/report-review-workflow.test.js
 */
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scs_report_review_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'report-review-test-secret';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');

const PORT = 5097;
const API = `http://127.0.0.1:${PORT}/api/v1`;

let passed = 0;
const failures = [];
// Workflow scenarios are strictly ordered (review → request → accept → resolve),
// so checks are chained sequentially rather than fired concurrently.
let chain = Promise.resolve();
function check(name, fn) {
  chain = chain.then(async () => {
    try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
    catch (e) { failures.push(name); console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); }
  });
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const { app } = require('../server.js');
  const httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(PORT, r));

  const jwt = require('jsonwebtoken');
  const User = require('../src/models/User');
  const MenuItem = require('../src/models/MenuItem');
  const IssueReport = require('../src/models/IssueReport');
  const ResolutionRequest = require('../src/models/ResolutionRequest');
  const Notification = require('../src/models/Notification');
  const { ensureDefaultCafeteria, getDefaultCafeteriaId } = require('../src/utils/cafeteria');

  await ensureDefaultCafeteria();
  const cafeteriaId = await getDefaultCafeteriaId();

  let phoneSeq = 0;
  const mkUser = (name, role, caf = null) =>
    User.create({
      name,
      email: `${name.toLowerCase().replace(/[^a-z]/g, '')}@review.test`,
      phone: '0912' + String(++phoneSeq).padStart(6, '0'),
      password: 'password123',
      role,
      status: 'ACTIVE',
      cafeteriaId: caf,
    });

  const kitchen = await mkUser('Kitchen', 'kitchen', cafeteriaId);
  const manager = await mkUser('Manager', 'manager', cafeteriaId);
  const manager2 = await mkUser('ManagerTwo', 'manager', cafeteriaId);
  // Accepting / rejecting / resolving a resolution request is an ADMIN action
  // (ADMIN_ROLES in routes/resolutionRequest.routes.js). The cafeteria_admin
  // role that used to hold it was folded into the admin role, so this user now
  // carries that role. It keeps the 'CafAdmin' name, which the assertions
  // below read back from the API payload.
  const cafAdmin = await mkUser('CafAdmin', 'admin', cafeteriaId);
  const sysAdmin = await mkUser('SysAdmin', 'admin');

  const tok = (u) => jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const T = {
    kitchen: tok(kitchen),
    manager: tok(manager),
    manager2: tok(manager2),
    cafAdmin: tok(cafAdmin),
    sysAdmin: tok(sysAdmin),
  };

  const mkItem = (nameEn, stock = 20, threshold = 5) =>
    MenuItem.create({
      cafeteriaId,
      name: { en: nameEn, am: nameEn },
      category: 'Beverages',
      price: 30,
      stockQuantity: stock,
      lowStockThreshold: threshold,
      availabilityStatus: stock > 0 ? 'AVAILABLE' : 'OUT_OF_STOCK',
    });

  const itemA = await mkItem('Coffee', 10, 5);   // main workflow target
  const itemB = await mkItem('Buns', 2, 5);      // duplicate-request target
  const itemC = await mkItem('Yogurt', 10, 5);   // reject flow target

  const call = async (method, path, token, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const notifCount = (userId, title) =>
    Notification.countDocuments({ userId, title });

  // ============================================================
  console.log('\n1. Kitchen creates report → OPEN');
  // ============================================================

  let issueA;
  await check('kitchen creates an issue report with status OPEN', async () => {
    const r = await call('POST', '/issues', T.kitchen, {
      title: 'Coffee machine broken',
      description: 'The espresso machine is not heating water properly.',
      category: 'equipment',
      priority: 'high',
      itemId: String(itemA._id),
    });
    assert.strictEqual(r.status, 201, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body.issue, 'response must include issue');
    issueA = r.body.issue;
    assert.strictEqual(issueA.status, 'OPEN', `expected OPEN, got ${issueA.status}`);
    assert.strictEqual(issueA.reportedBy.name, 'Kitchen');
  });

  // ============================================================
  console.log('\n2. Manager reviews report → UNDER_REVIEW');
  // ============================================================

  await check('manager reviews the report and investigation notes are recorded', async () => {
    const r = await call('PATCH', `/issues/${issueA.id}/review`, T.manager, {
      notes: 'Inspected the espresso machine. The heating element appears faulty.',
      itemId: String(itemA._id),
    });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.issue.status, 'UNDER_REVIEW');
    assert.strictEqual(r.body.issue.investigationNotes, 'Inspected the espresso machine. The heating element appears faulty.');
    assert.ok(r.body.issue.investigatedBy, 'investigatedBy must be set');
    assert.ok(r.body.issue.investigatedAt, 'investigatedAt must be set');
  });

  await check('kitchen can see the report is UNDER_REVIEW', async () => {
    const r = await call('GET', `/issues/${issueA.id}`, T.kitchen);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.issue.status, 'UNDER_REVIEW');
  });

  await check('manager cannot review the same report twice', async () => {
    const r = await call('PATCH', `/issues/${issueA.id}/review`, T.manager, {
      notes: 'Second review attempt.',
    });
    assert.strictEqual(r.status, 400);
    assert.ok(r.body.error, 'must return an error message');
  });

  // ============================================================
  console.log('\n3. Manager cannot resolve directly → 403');
  // ============================================================

  await check('manager PATCH /issues/:id/solution returns 403', async () => {
    const r = await call('PATCH', `/issues/${issueA.id}/solution`, T.manager, {
      resolutionReason: 'Equipment Failure',
      resolutionSolution: 'Repaired Equipment',
    });
    assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
  });

  await check('kitchen PATCH /issues/:id/solution returns 403', async () => {
    const r = await call('PATCH', `/issues/${issueA.id}/solution`, T.kitchen, {
      resolutionReason: 'Equipment Failure',
      resolutionSolution: 'Repaired Equipment',
    });
    assert.strictEqual(r.status, 403);
  });

  await check('manager PATCH /resolution-requests/:id/accept returns 403', async () => {
    // No request yet - but route-level authorize should 403 before lookup.
    const r = await call('PATCH', `/resolution-requests/000000000000000000000000/accept`, T.manager, {});
    assert.strictEqual(r.status, 403);
  });

  await check('manager PATCH /resolution-requests/:id/resolve returns 403', async () => {
    const r = await call('PATCH', `/resolution-requests/000000000000000000000000/resolve`, T.manager, {});
    assert.strictEqual(r.status, 403);
  });

  // ============================================================
  console.log('\n4. Manager sends request → REQUEST_SENT + PENDING ResolutionRequest');
  // ============================================================

  let reqA;
  await check('manager sends a resolution request to the Cafeteria Admin', async () => {
    const r = await call('PATCH', `/issues/${issueA.id}/request-admin`, T.manager, {
      requestedAction: 'Replace the espresso machine heating element (part #EM-220).',
    });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.issue.status, 'REQUEST_SENT');
    assert.ok(r.body.request, 'response must include request');
    assert.strictEqual(r.body.request.status, 'PENDING');
    reqA = r.body.request;
  });

  await check('the linked ResolutionRequest is persisted with correct fields', async () => {
    const doc = await ResolutionRequest.findById(reqA.id);
    assert.ok(doc, 'ResolutionRequest must exist in MongoDB');
    assert.strictEqual(doc.status, 'PENDING');
    assert.strictEqual(String(doc.issueReportId), String(issueA.id));
    assert.strictEqual(String(doc.cafeteriaId), String(cafeteriaId));
    assert.strictEqual(String(doc.requestedBy), String(manager._id));
    assert.strictEqual(doc.requestedAction, 'Replace the espresso machine heating element (part #EM-220).');
    assert.strictEqual(doc.investigationNotes, 'Inspected the espresso machine. The heating element appears faulty.');
  });

  await check('the IssueReport is linked to the ResolutionRequest', async () => {
    const doc = await IssueReport.findById(issueA.id);
    assert.strictEqual(String(doc.resolutionRequestId), String(reqA.id));
    assert.strictEqual(doc.status, 'REQUEST_SENT');
  });

  // ============================================================
  console.log('\n5. Backend rejects request before review');
  // ============================================================

  let issueB;
  await check('a second OPEN report is created', async () => {
    const r = await call('POST', '/issues', T.kitchen, {
      title: 'Out of buns',
      description: 'The buns shelf is empty.',
      category: 'stock',
      priority: 'medium',
      itemId: String(itemB._id),
    });
    assert.strictEqual(r.status, 201);
    issueB = r.body.issue;
    assert.strictEqual(issueB.status, 'OPEN');
  });

  await check('manager cannot send a request before reviewing (400)', async () => {
    const r = await call('PATCH', `/issues/${issueB.id}/request-admin`, T.manager, {
      requestedAction: 'Restock 100 buns.',
    });
    assert.strictEqual(r.status, 400);
    assert.ok(r.body.error, 'must return an error');
  });

  // ============================================================
  console.log('\n6. Duplicate open-request prevention');
  // ============================================================

  await check('manager cannot send a second open request for the same issue (409)', async () => {
    const r = await call('PATCH', `/issues/${issueA.id}/request-admin`, T.manager, {
      requestedAction: 'Second request attempt.',
    });
    assert.strictEqual(r.status, 409, `expected 409, got ${r.status}`);
  });

  // ============================================================
  console.log('\n7. Admin list + accept → IN_PROGRESS');
  // ============================================================

  await check('Cafeteria Admin lists resolution requests', async () => {
    const r = await call('GET', '/resolution-requests', T.cafAdmin);
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.requests), 'must return requests array');
    assert.strictEqual(r.body.count, 1, 'exactly one request should exist');
    assert.strictEqual(r.body.requests[0].id, reqA.id);
    assert.strictEqual(r.body.requests[0].status, 'PENDING');
    assert.strictEqual(r.body.requests[0].issueTitle, 'Coffee machine broken');
  });

  await check('Manager also lists the request (cafeteria-scoped)', async () => {
    const r = await call('GET', '/resolution-requests', T.manager);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.count, 1);
  });

  await check('Admin accepts the request → IN_PROGRESS', async () => {
    const r = await call('PATCH', `/resolution-requests/${reqA.id}/accept`, T.cafAdmin, {
      note: 'Ordered the replacement part.',
    });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.request.status, 'IN_PROGRESS');
    assert.ok(r.body.request.acceptedBy, 'acceptedBy must be set');
    assert.ok(r.body.request.acceptedAt, 'acceptedAt must be set');
    assert.strictEqual(r.body.request.acceptedBy.name, 'CafAdmin');
  });

  await check('the requesting manager is notified of the acceptance', async () => {
    const n = await notifCount(manager._id, 'Resolution Request Accepted');
    assert.ok(n >= 1, `expected >=1 acceptance notification, got ${n}`);
  });

  // ============================================================
  console.log('\n8. Lifecycle guards');
  // ============================================================

  await check('Admin cannot accept an IN_PROGRESS request again (400)', async () => {
    const r = await call('PATCH', `/resolution-requests/${reqA.id}/accept`, T.cafAdmin, {});
    assert.strictEqual(r.status, 400);
  });

  await check('Admin cannot resolve a PENDING request (400) - must accept first', async () => {
    // Create a fresh PENDING request for itemB's issue (after review).
    const r1 = await call('PATCH', `/issues/${issueB.id}/review`, T.manager, {
      notes: 'Checked the shelf. Completely empty.',
    });
    assert.strictEqual(r1.status, 200);
    const r2 = await call('PATCH', `/issues/${issueB.id}/request-admin`, T.manager, {
      requestedAction: 'Restock 100 buns from the central kitchen.',
    });
    assert.strictEqual(r2.status, 200);
    const reqB = r2.body.request;

    const r3 = await call('PATCH', `/resolution-requests/${reqB.id}/resolve`, T.cafAdmin, {
      note: 'Buns delivered.',
    });
    assert.strictEqual(r3.status, 400, `expected 400, got ${r3.status}`);

    // Now accept, then reject is no longer possible (only PENDING can be rejected).
    const r4 = await call('PATCH', `/resolution-requests/${reqB.id}/accept`, T.cafAdmin, {});
    assert.strictEqual(r4.status, 200);
    const r5 = await call('PATCH', `/resolution-requests/${reqB.id}/reject`, T.cafAdmin, { reason: 'Too late' });
    assert.strictEqual(r5.status, 400, 'reject must fail on IN_PROGRESS');
  });

  // ============================================================
  console.log('\n9. Admin reject flow (PENDING → REJECTED, reason required)');
  // ============================================================

  let issueC, reqC;
  await check('a third report is created and reviewed', async () => {
    const r1 = await call('POST', '/issues', T.kitchen, {
      title: 'Yogurt quality concern',
      description: 'The yogurt tastes sour past the expiry date.',
      category: 'quality',
      priority: 'high',
      itemId: String(itemC._id),
    });
    assert.strictEqual(r1.status, 201);
    issueC = r1.body.issue;

    const r2 = await call('PATCH', `/issues/${issueC.id}/review`, T.manager, {
      notes: 'Checked the batch. Expiry is tomorrow.',
      itemId: String(itemC._id),
    });
    assert.strictEqual(r2.status, 200);

    const r3 = await call('PATCH', `/issues/${issueC.id}/request-admin`, T.manager, {
      requestedAction: 'Remove the batch and credit the supplier.',
    });
    assert.strictEqual(r3.status, 200);
    reqC = r3.body.request;
  });

  await check('Admin reject without a reason returns 400', async () => {
    const r = await call('PATCH', `/resolution-requests/${reqC.id}/reject`, T.cafAdmin, {});
    assert.strictEqual(r.status, 400);
    assert.ok(r.body.error, 'must return an error');
  });

  await check('Admin reject with a reason → REJECTED, IssueReport returns to UNDER_REVIEW', async () => {
    const r = await call('PATCH', `/resolution-requests/${reqC.id}/reject`, T.cafAdmin, {
      reason: 'Supplier already shipped a replacement batch.',
    });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.request.status, 'REJECTED');
    assert.ok(r.body.request.rejectedBy, 'rejectedBy must be set');
    assert.ok(r.body.request.rejectedAt, 'rejectedAt must be set');
    assert.strictEqual(r.body.request.rejectionReason, 'Supplier already shipped a replacement batch.');

    const issue = await IssueReport.findById(issueC.id);
    assert.strictEqual(issue.status, 'UNDER_REVIEW', 'rejected request must return the report to UNDER_REVIEW');
    assert.ok(!issue.resolutionRequestId, 'resolutionRequestId must be cleared');
  });

  await check('the requesting manager is notified of the rejection', async () => {
    const n = await notifCount(manager._id, 'Resolution Request Rejected');
    assert.ok(n >= 1, `expected >=1 rejection notification, got ${n}`);
  });

  // ============================================================
  console.log('\n10. Admin resolve flow (IN_PROGRESS → RESOLVED, cascades to IssueReport)');
  // ============================================================

  await check('Admin resolves the request → RESOLVED, IssueReport cascades to RESOLVED', async () => {
    const r = await call('PATCH', `/resolution-requests/${reqA.id}/resolve`, T.cafAdmin, {
      note: 'Heating element replaced and tested. Machine is back online.',
    });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.request.status, 'RESOLVED');
    assert.ok(r.body.request.resolvedBy, 'resolvedBy must be set');
    assert.ok(r.body.request.resolvedAt, 'resolvedAt must be set');
    assert.strictEqual(r.body.request.resolvedBy.name, 'CafAdmin');
    assert.strictEqual(r.body.request.resolutionNote, 'Heating element replaced and tested. Machine is back online.');

    const issue = await IssueReport.findById(issueA.id);
    assert.strictEqual(issue.status, 'RESOLVED', 'IssueReport must cascade to RESOLVED');
    assert.ok(issue.resolvedAt, 'resolvedAt must be set on the issue');
    assert.ok(issue.repliedBy, 'repliedBy must be set on the issue');
    assert.strictEqual(String(issue.repliedBy), String(cafAdmin._id));
    assert.strictEqual(issue.solution, 'Heating element replaced and tested. Machine is back online.');
  });

  await check('the requesting manager is notified of the resolution', async () => {
    const n = await notifCount(manager._id, 'Resolution Request Resolved');
    assert.ok(n >= 1, `expected >=1 resolution notification, got ${n}`);
  });

  await check('the kitchen reporter is notified that the issue is resolved', async () => {
    const n = await notifCount(kitchen._id, 'Issue Resolved');
    assert.ok(n >= 1, `expected >=1 issue-resolved notification, got ${n}`);
  });

  // ============================================================
  console.log('\n11. Manager cancel while PENDING');
  // ============================================================

  let issueD, reqD;
  await check('a fourth report is created, reviewed, and a request sent', async () => {
    const r1 = await call('POST', '/issues', T.kitchen, {
      title: 'Fryer needs deep clean',
      description: 'The fryer oil is dark and smoking.',
      category: 'cleaning',
      priority: 'medium',
    });
    assert.strictEqual(r1.status, 201);
    issueD = r1.body.issue;

    const r2 = await call('PATCH', `/issues/${issueD.id}/review`, T.manager, {
      notes: 'Inspected the fryer. Oil is definitely past its usable life.',
    });
    assert.strictEqual(r2.status, 200);

    const r3 = await call('PATCH', `/issues/${issueD.id}/request-admin`, T.manager, {
      requestedAction: 'Schedule a deep-clean of the fryer station this weekend.',
    });
    assert.strictEqual(r3.status, 200);
    reqD = r3.body.request;
  });

  await check('only the requesting manager can cancel (other manager → 403)', async () => {
    const r = await call('PATCH', `/resolution-requests/${reqD.id}/cancel`, T.manager2, {});
    assert.strictEqual(r.status, 403);
  });

  await check('requesting manager cancels while PENDING → REJECTED, issue returns to UNDER_REVIEW', async () => {
    const r = await call('PATCH', `/resolution-requests/${reqD.id}/cancel`, T.manager, {});
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.request.status, 'REJECTED');
    assert.ok(String(r.body.request.rejectionReason).includes('Cancelled'), 'rejectionReason must mention cancel');

    const issue = await IssueReport.findById(issueD.id);
    assert.strictEqual(issue.status, 'UNDER_REVIEW');
  });

  // ============================================================
  console.log('\n12. Admin direct solution also cascades to an open request');
  // ============================================================

  let issueE, reqE;
  await check('a fifth report goes through review + request', async () => {
    const r1 = await call('POST', '/issues', T.kitchen, {
      title: 'Ice machine low',
      description: 'The ice machine is producing very little ice.',
      category: 'equipment',
      priority: 'low',
    });
    assert.strictEqual(r1.status, 201);
    issueE = r1.body.issue;

    const r2 = await call('PATCH', `/issues/${issueE.id}/review`, T.manager, {
      notes: 'Checked the ice machine. Filter is clogged.',
    });
    assert.strictEqual(r2.status, 200);

    const r3 = await call('PATCH', `/issues/${issueE.id}/request-admin`, T.manager, {
      requestedAction: 'Send a technician to clean the ice machine filter.',
    });
    assert.strictEqual(r3.status, 200);
    reqE = r3.body.request;
  });

  await check('Admin uses /issues/:id/solution directly → issue RESOLVED and linked request RESOLVED', async () => {
    const r = await call('PATCH', `/issues/${issueE.id}/solution`, T.cafAdmin, {
      resolutionReason: 'Maintenance Required',
      resolutionSolution: 'Cleaned and Maintained Equipment',
      resolutionNote: 'Filter cleaned and flushed.',
    });
    assert.strictEqual(r.status, 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.issue.status, 'RESOLVED');

    const req = await ResolutionRequest.findById(reqE.id);
    assert.strictEqual(req.status, 'RESOLVED', 'linked ResolutionRequest must also be RESOLVED');
    assert.ok(req.resolvedAt, 'resolvedAt must be set on the request');
    assert.strictEqual(String(req.resolvedBy), String(cafAdmin._id));
  });

  // ============================================================
  console.log('\n13. System Admin can also process requests');
  // ============================================================

  let issueF, reqF;
  await check('a sixth report goes through review + request', async () => {
    const r1 = await call('POST', '/issues', T.kitchen, {
      title: 'Water dispenser leak',
      description: 'Water is leaking from the base of the dispenser.',
      category: 'equipment',
      priority: 'critical',
    });
    assert.strictEqual(r1.status, 201);
    issueF = r1.body.issue;

    const r2 = await call('PATCH', `/issues/${issueF.id}/review`, T.manager, {
      notes: 'Confirmed a slow leak from the inlet valve.',
    });
    assert.strictEqual(r2.status, 200);

    const r3 = await call('PATCH', `/issues/${issueF.id}/request-admin`, T.manager, {
      requestedAction: 'Emergency plumber call for the water dispenser inlet valve.',
    });
    assert.strictEqual(r3.status, 200);
    reqF = r3.body.request;
  });

  await check('System Admin accepts and resolves the request', async () => {
    const r1 = await call('PATCH', `/resolution-requests/${reqF.id}/accept`, T.sysAdmin, {});
    assert.strictEqual(r1.status, 200);
    const r2 = await call('PATCH', `/resolution-requests/${reqF.id}/resolve`, T.sysAdmin, {
      note: 'Valve replaced by the on-call plumber.',
    });
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.body.request.status, 'RESOLVED');
    assert.strictEqual(r2.body.request.resolvedBy.name, 'SysAdmin');
  });

  // ============================================================
  console.log('\n14. Audit log entries');
  // ============================================================

  await check('audit log contains the review, request, and resolve actions', async () => {
    const ActivityLog = require('../src/models/ActivityLog');
    const actions = await ActivityLog.distinct('action', {});
    for (const a of ['ISSUE_REPORT_REVIEWED', 'ISSUE_REPORT_REQUEST_SENT', 'RESOLUTION_REQUEST_ACCEPTED', 'RESOLUTION_REQUEST_RESOLVED', 'RESOLUTION_REQUEST_REJECTED', 'RESOLUTION_REQUEST_CANCELLED']) {
      assert.ok(actions.includes(a), `audit action ${a} must exist`);
    }
  });

  // ============================================================
  // Summary
  // ============================================================
  await chain;
  console.log(`\n${passed} passed, ${failures.length} failed`);
  await mongoose.disconnect();
  await new Promise((r) => httpServer.close(r));
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
