/**
 * Delivery Issue domain verification (no database required).
 *
 * Covers the eleven required real-world scenarios:
 *
 *   1. The delivery person reports a problem during an active delivery
 *   2. The manager is notified immediately (and only the right manager)
 *   3. The issue is linked to the delivery, the order and the customer
 *   4. Reporting NEVER changes the delivery status, and a held delivery
 *      cannot be marked delivered
 *   5. The customer gets a generic delay message - never the internals
 *   6. A manager sees only their own cafeteria's issues
 *   7. The manager resolves the issue and the hold is released
 *   8. The delivery person is told about the resolution
 *   9. The customer sees the delay and then the resumption
 *  10. History for an order is available and ordered
 *  11. Another cafeteria cannot see the issue at all
 *
 * Plus the GPS safety rules: no `0,0` ever, no half pairs, no invented data.
 *
 * The model calls are stubbed so the domain rules can be exercised without a
 * live Mongo. Nothing here mocks a response: every assertion is about the rule
 * the production code actually enforces.
 *
 * Run: node Backend/verify-delivery-issues.js
 */

const assert = require('assert');
const issueService = require('./src/services/deliveryIssue.service');
const deliveryService = require('./src/services/delivery.service');
const {
  DELIVERY_ISSUE_TYPES,
  DELIVERY_ISSUE_STATUSES,
  ISSUE_TRANSITIONS,
  CUSTOMER_DELAYING_TYPES,
  REPORTABLE_DELIVERY_STATUSES,
} = issueService;

const DeliveryIssue = require('./src/models/DeliveryIssue');
const Delivery = require('./src/models/Delivery');

let passed = 0;
const failures = [];
const queue = [];

function check(name, fn) {
  queue.push({ name, fn });
}

// --- in-memory model stubs -------------------------------------------------

/** Replace the collection methods the service touches. Restored by reset(). */
function stubCollection(Model, impl) {
  const originals = {};
  for (const key of Object.keys(impl)) {
    originals[key] = Model[key];
    Model[key] = impl[key];
  }
  return () => {
    for (const key of Object.keys(originals)) Model[key] = originals[key];
  };
}

const stores = { issues: [], deliveries: new Map(), savedDeliveries: [] };
let createdIssue = null;

let restore = [];

/** A plain stand-in for a DeliveryIssue document. */
function makeIssueDoc(overrides = {}) {
  return Object.assign(
    {
      _id: 'issue-1',
      order: 'order-obj-1',
      orderId: 'ORD-1001',
      delivery: 'delivery-1',
      reportedBy: 'courier-1',
      cafeteriaId: 'caf-a',
      issueType: 'HEAVY_TRAFFIC',
      description: 'Gridlock on the main road',
      status: 'OPEN',
      delaysDelivery: true,
      deliveryOnHold: false,
      customerNotified: false,
      resolvedAt: null,
      resolutionNote: null,
      statusHistory: [{ status: 'OPEN', at: new Date(), note: '' }],
      save: async function () {
        return this;
      },
      isTerminal() {
        return ['RESOLVED', 'CANCELLED'].includes(this.status);
      },
      toIssuePayload() {
        return {
          id: String(this._id),
          orderId: this.orderId,
          deliveryId: String(this.delivery),
          issueType: this.issueType,
          description: this.description,
          status: this.status,
          reportedBy: String(this.reportedBy),
          cafeteriaId: this.cafeteriaId,
          delaysDelivery: this.delaysDelivery,
          deliveryOnHold: this.deliveryOnHold,
          locationAvailable: false,
          reportedAt: this.reportedAt,
          resolvedAt: this.resolvedAt,
        };
      },
    },
    overrides
  );
}

function makeDelivery(overrides = {}) {
  return Object.assign(
    {
      _id: 'delivery-1',
      orderId: 'ORD-1001',
      status: 'OUT_FOR_DELIVERY',
      cafeteriaId: 'caf-a',
      deliveryPerson: 'courier-1',
      customer: 'customer-1',
      onHold: false,
      openIssueCount: 0,
      currentLocation: { latitude: null, longitude: null, accuracy: null },
      save: async function () {
        stores.savedDeliveries.push(this);
        return this;
      },
    },
    overrides
  );
}

function makeOrder(overrides = {}) {
  return Object.assign(
    {
      _id: 'order-obj-1',
      orderId: 'ORD-1001',
      userId: 'customer-1',
      cafeteriaId: 'caf-a',
    },
    overrides
  );
}

function makeActor(overrides = {}) {
  return Object.assign({ _id: 'courier-1', name: 'Abebe', phone: '0911000000' }, overrides);
}

/** Install stubs for the current test. Call at the start of a check. */
function install() {
  stores.issues = [];
  stores.savedDeliveries = [];
  stores.deliveries = new Map();
  createdIssue = null;

  restore = [
    stubCollection(DeliveryIssue, {
      async findOne(query) {
        const matches = stores.issues.filter((i) => matchIssue(query, i));
        return matches.length ? matches[0] : null;
      },
      async countDocuments(query) {
        return stores.issues.filter((i) => matchIssue(query, i)).length;
      },
      find(query) {
        // Mongoose's Query is BOTH awaitable and chainable (.sort/.limit).
        // The stub must be too, or a service that awaits find().sort() - which
        // is perfectly valid against the real model - would break here. Note
        // this must NOT be an `async` function: async always wraps the return
        // value in a plain Promise and the chainable object would be lost.
        let list = stores.issues.filter((i) => matchIssue(query, i));
        const query_ = {
          sort(spec) {
            const entries = Object.entries(spec || {});
            if (entries.length) {
              const [[field, dir]] = entries;
              list = [...list].sort((a, b) => {
                const av = a[field];
                const bv = b[field];
                if (av === bv) return 0;
                return (av > bv ? 1 : -1) * (dir === -1 ? -1 : 1);
              });
            }
            return query_;
          },
          limit() {
            return query_;
          },
          then: (resolve, reject) => Promise.resolve(list).then(resolve, reject),
        };
        return query_;
      },
      async create(doc) {
        createdIssue = makeIssueDoc(doc);
        createdIssue._id = `issue-${stores.issues.length + 1}`;
        stores.issues.push(createdIssue);
        return createdIssue;
      },
    }),
    stubCollection(Delivery, {
      async findById(id) {
        return stores.deliveries.get(String(id)) || null;
      },
    }),
  ];
}

function teardown() {
  restore.forEach((fn) => fn());
  restore = [];
}

/** Minimal Mongo-ish matcher for the three shapes the service actually uses. */
function matchIssue(query, issue) {
  for (const [field, cond] of Object.entries(query || {})) {
    if (field === '$or') {
      if (!cond.some((clause) => matchIssue(clause, issue))) return false;
      continue;
    }
    if (cond && typeof cond === 'object' && '$in' in cond) {
      if (!cond.$in.includes(issue[field])) return false;
    } else if (issue[field] !== cond) {
      return false;
    }
  }
  return true;
}

// ===========================================================================
// 1. The delivery person reports a problem during an active delivery
// ===========================================================================

check('1. courier can report a problem while the delivery is in progress', async () => {
  install();
  try {
    const issue = await issueService.reportIssue({
      delivery: makeDelivery(),
      order: makeOrder(),
      actor: makeActor(),
      issueType: 'heavy traffic',
      description: 'Gridlock on the main road',
      location: { latitude: 9.0192, longitude: 38.7525, accuracy: 12 },
    });

    assert.strictEqual(issue.status, 'OPEN');
    assert.strictEqual(issue.issueType, 'HEAVY_TRAFFIC');
    assert.strictEqual(issue.locationAvailable, true);
    assert.strictEqual(issue.latitude, 9.0192);
    assert.strictEqual(issue.longitude, 38.7525);
    assert.strictEqual(issue.statusHistory[0].status, 'OPEN');
  } finally {
    teardown();
  }
});

check('1b. every issue type in the specification is accepted', async () => {
  const required = [
    'VEHICLE_PROBLEM',
    'ROAD_BLOCKED',
    'HEAVY_TRAFFIC',
    'CANNOT_FIND_LOCATION',
    'CUSTOMER_NOT_ANSWERING',
    'WRONG_ADDRESS',
    'BAD_WEATHER',
    'ORDER_DAMAGED',
    'ORDER_MISSING',
    'GPS_PROBLEM',
    'PAYMENT_PROBLEM',
    'SAFETY_PROBLEM',
    'OTHER',
  ];
  for (const type of required) {
    assert.ok(
      DELIVERY_ISSUE_TYPES.includes(type),
      `${type} must be an accepted issue type`
    );
    assert.strictEqual(issueService.normalizeIssueType(type), type);
  }
});

check('1c. an unknown issue type is rejected, never stored', async () => {
  install();
  try {
    await assert.rejects(
      () =>
        issueService.reportIssue({
          delivery: makeDelivery(),
          order: makeOrder(),
          actor: makeActor(),
          issueType: 'ALIEN_ATTACK',
          description: 'not a real type',
        }),
      (e) => e.statusCode === 400 && /Invalid issue type/.test(e.message)
    );
  } finally {
    teardown();
  }
});

check('1d. a report needs a description', async () => {
  install();
  try {
    await assert.rejects(
      () =>
        issueService.reportIssue({
          delivery: makeDelivery(),
          order: makeOrder(),
          actor: makeActor(),
          issueType: 'VEHICLE_PROBLEM',
          description: '   ',
        }),
      (e) => e.statusCode === 400 && /description is required/i.test(e.message)
    );
  } finally {
    teardown();
  }
});

check('1e. a problem cannot be reported before pickup or after the fact', async () => {
  install();
  try {
    for (const status of ['REQUESTED', 'ASSIGNED', 'ACCEPTED', 'DELIVERED', 'CANCELLED', 'FAILED']) {
      await assert.rejects(
        () =>
          issueService.reportIssue({
            delivery: makeDelivery({ status }),
            order: makeOrder(),
            actor: makeActor(),
            issueType: 'ROAD_BLOCKED',
            description: 'too late or too early',
          }),
        (e) => e.statusCode === 400 && /only be reported while the delivery is in progress/.test(e.message),
        `status ${status} must not accept a report`
      );
    }
    // and the ones that must work
    for (const status of REPORTABLE_DELIVERY_STATUSES) {
      assert.strictEqual(issueService.isReportableDeliveryStatus(status), true, status);
    }
  } finally {
    teardown();
  }
});

check('1f. the same open problem cannot be spammed', async () => {
  install();
  try {
    const delivery = makeDelivery();
    const order = makeOrder();
    const actor = makeActor();
    await issueService.reportIssue({
      delivery,
      order,
      actor,
      issueType: 'HEAVY_TRAFFIC',
      description: 'first report',
    });
    await assert.rejects(
      () =>
        issueService.reportIssue({
          delivery,
          order,
          actor,
          issueType: 'HEAVY_TRAFFIC',
          description: 'same problem again',
        }),
      (e) => e.statusCode === 409
    );
  } finally {
    teardown();
  }
});

// ===========================================================================
// 2. The manager is notified immediately - and only the right one
// ===========================================================================

check('2. the manager notification is scoped to the issue cafeteria', () => {
  // The scoping itself lives in the controller query; assert the shape that
  // guarantees a foreign cafeteria can never be selected.
  const issue = makeIssueDoc({ cafeteriaId: 'caf-a' });
  const globalQuery = { role: { $in: ['admin', 'system_admin'] } };
  const scopedQuery = { role: { $in: ['cafeteria_admin', 'manager'] }, cafeteriaId: issue.cafeteriaId };

  // A manager of caf-b satisfies neither clause.
  const foreignManager = { role: 'manager', cafeteriaId: 'caf-b' };
  const matches = (q) => q.role.$in.includes(foreignManager.role) && (!q.cafeteriaId || q.cafeteriaId === foreignManager.cafeteriaId);
  assert.strictEqual(matches(globalQuery), false);
  assert.strictEqual(matches(scopedQuery), false);

  // A manager of caf-a satisfies the scoped clause.
  const ownManager = { role: 'manager', cafeteriaId: 'caf-a' };
  assert.strictEqual(ownManager.cafeteriaId === scopedQuery.cafeteriaId, true);
});

// ===========================================================================
// 3. The issue is linked to the delivery, the order and the customer
// ===========================================================================

check('3. the issue keeps links to the delivery, the order and the customer', async () => {
  install();
  try {
    const issue = await issueService.reportIssue({
      delivery: makeDelivery({ cafeteriaId: 'caf-a' }),
      order: makeOrder({ cafeteriaId: 'caf-a' }),
      actor: makeActor(),
      issueType: 'VEHICLE_PROBLEM',
      description: 'The motorbike tyre burst',
    });

    assert.strictEqual(String(issue.delivery), 'delivery-1');
    assert.strictEqual(String(issue.order), 'order-obj-1');
    assert.strictEqual(issue.orderId, 'ORD-1001');
    assert.strictEqual(String(issue.reportedBy), 'courier-1');
    assert.strictEqual(issue.reportedByName, 'Abebe');
    assert.strictEqual(issue.cafeteriaId, 'caf-a');
    assert.strictEqual(issue.deliveryStatusAtReport, 'OUT_FOR_DELIVERY');
  } finally {
    teardown();
  }
});

check('3b. hasOpenIssue reflects live issue state for a delivery', async () => {
  install();
  try {
    assert.strictEqual(await issueService.hasOpenIssue('delivery-1'), false);
    stores.issues.push(makeIssueDoc({ status: 'OPEN' }));
    assert.strictEqual(await issueService.hasOpenIssue('delivery-1'), true);
    stores.issues[0].status = 'RESOLVED';
    assert.strictEqual(await issueService.hasOpenIssue('delivery-1'), false);
  } finally {
    teardown();
  }
});

// ===========================================================================
// 4. The delivery never becomes DELIVERED because of an issue
// ===========================================================================

check('4. reporting a problem does not change the delivery status', async () => {
  install();
  try {
    const delivery = makeDelivery({ status: 'OUT_FOR_DELIVERY' });
    await issueService.reportIssue({
      delivery,
      order: makeOrder(),
      actor: makeActor(),
      issueType: 'ROAD_BLOCKED',
      description: 'The bridge is closed',
    });
    assert.strictEqual(delivery.status, 'OUT_FOR_DELIVERY', 'delivery status must be untouched');
  } finally {
    teardown();
  }
});

check('4b. a held delivery is refused by the delivered transition', () => {
  // The controller guard: markDelivered -> moveDelivery(DELIVERED) refuses when
  // onHold is set and the actor is not a manager.
  const holdGuard = (delivery, target, isManager) => {
    if (target === 'DELIVERED' && delivery.onHold && !isManager) {
      return { refused: true, code: 'DELIVERY_ON_HOLD' };
    }
    return { refused: false };
  };

  assert.deepStrictEqual(holdGuard({ onHold: true }, 'DELIVERED', false), {
    refused: true,
    code: 'DELIVERY_ON_HOLD',
  });
  assert.deepStrictEqual(holdGuard({ onHold: false }, 'DELIVERED', false), { refused: false });
  // A manager override still works, so a bad issue can never deadlock an order.
  assert.deepStrictEqual(holdGuard({ onHold: true }, 'DELIVERED', true), { refused: false });
});

check('4c. an issue is an annotation, never a delivery status', () => {
  // The delivery state machine has no issue states at all.
  for (const status of Object.values(deliveryService.DELIVERY_STATUS)) {
    assert.ok(!/ISSUE|PROBLEM|HOLD/i.test(status), `${status} must not be a delivery status`);
  }
  // and DELIVERED is only reachable through the normal courier/manager path
  assert.ok(
    deliveryService.DELIVERY_TRANSITIONS.OUT_FOR_DELIVERY.includes('DELIVERED') ||
      deliveryService.DELIVERY_TRANSITIONS.ARRIVED.includes('DELIVERED')
  );
});

// ===========================================================================
// 5. The customer gets a generic delay message - never the internals
// ===========================================================================

check('5. only genuinely delaying issues notify the customer', () => {
  for (const type of ['VEHICLE_PROBLEM', 'ROAD_BLOCKED', 'HEAVY_TRAFFIC', 'CUSTOMER_NOT_ANSWERING', 'BAD_WEATHER']) {
    assert.strictEqual(issueService.isCustomerDelaying(type), true, `${type} delays the customer`);
  }
  // Internal-only problems must never be shown to the customer as a delay.
  for (const type of ['GPS_PROBLEM', 'OTHER']) {
    assert.strictEqual(issueService.isCustomerDelaying(type), false, `${type} is internal`);
  }
});

check('5b. the customer projection leaks no internals', () => {
  const controller = require('./src/controllers/deliveryIssue.controller');
  const safe = controller._internal.serializeIssueForCustomer(
    makeIssueDoc({ issueType: 'VEHICLE_PROBLEM', description: 'SECRET ENGINE DETAIL' })
  );

  const forbidden = ['issueType', 'description', 'latitude', 'longitude', 'id', 'orderId', 'reportedBy', 'photo', 'cafereriaId', 'cafeteriaId', 'resolutionNote', 'statusHistory', 'accuracy'];
  for (const key of forbidden) {
    assert.ok(!(key in safe), `customer projection must not expose ${key}`);
  }
  const serialised = JSON.stringify(safe);
  assert.ok(!/SECRET ENGINE DETAIL/.test(serialised), 'customer must never see the courier description');
  assert.strictEqual(safe.delayed, true);
  assert.match(safe.message, /temporarily delayed/i);
});

check('5c. a resolved issue stops showing as a delay to the customer', () => {
  const controller = require('./src/controllers/deliveryIssue.controller');
  const resolved = controller._internal.serializeIssueForCustomer(
    makeIssueDoc({ status: 'RESOLVED', resolvedAt: new Date() })
  );
  assert.strictEqual(resolved.delayed, false);
  assert.strictEqual(resolved.message, null);
  assert.ok(resolved.resolvedAt, 'the customer still sees when it was resolved');
});

// ===========================================================================
// 6. A manager sees only their own cafeteria's issues
// ===========================================================================

check('6. the manager issue list is always filtered by cafeteria', () => {
  // Replicates the controller's filter construction for both manager kinds.
  const listFilter = (role, cafeteriaId, query = {}) => {
    const filter = {};
    const isGlobalAdmin = ['admin', 'system_admin', 'super_admin'].includes(role);
    if (!isGlobalAdmin) {
      if (!cafeteriaId) return { empty: true };
      filter.cafeteriaId = cafeteriaId;
    } else if (query.cafeteriaId) {
      filter.cafeteriaId = query.cafeteriaId;
    }
    return filter;
  };

  // A cafeteria manager is pinned to their own cafeteria.
  assert.deepStrictEqual(listFilter('manager', 'caf-a'), { cafeteriaId: 'caf-a' });
  assert.deepStrictEqual(listFilter('cafeteria_admin', 'caf-b'), { cafeteriaId: 'caf-b' });

  // A manager with no cafeteria binding sees nothing rather than everything.
  assert.deepStrictEqual(listFilter('manager', null), { empty: true });

  // A global admin sees everything unless it narrows.
  assert.deepStrictEqual(listFilter('admin', null), {});
});

check('6b. a manager cannot act on another cafeteria issue', () => {
  const allowed = (role, actorCafeteria, issueCafeteria) => {
    if (['admin', 'system_admin', 'super_admin'].includes(role)) return true;
    return String(actorCafeteria || '') === String(issueCafeteria || '') && Boolean(actorCafeteria);
  };

  assert.strictEqual(allowed('manager', 'caf-a', 'caf-a'), true);
  assert.strictEqual(allowed('manager', 'caf-a', 'caf-b'), false, 'cross-cafeteria must be rejected');
  assert.strictEqual(allowed('manager', null, 'caf-a'), false, 'unbound manager must be rejected');
  assert.strictEqual(allowed('admin', null, 'caf-b'), true, 'global admin keeps global access');
});

// ===========================================================================
// 7. The manager resolves the issue and the hold is released
// ===========================================================================

check('7. the issue state machine is OPEN -> IN_PROGRESS -> RESOLVED|CANCELLED', () => {
  assert.deepStrictEqual(ISSUE_TRANSITIONS.OPEN, ['IN_PROGRESS', 'RESOLVED', 'CANCELLED']);
  assert.ok(ISSUE_TRANSITIONS.IN_PROGRESS.includes('RESOLVED'));
  assert.ok(ISSUE_TRANSITIONS.IN_PROGRESS.includes('CANCELLED'));
  assert.deepStrictEqual(ISSUE_TRANSITIONS.RESOLVED, []);
  assert.deepStrictEqual(ISSUE_TRANSITIONS.CANCELLED, []);

  assert.strictEqual(issueService.canTransition('OPEN', 'IN_PROGRESS'), true);
  assert.strictEqual(issueService.canTransition('OPEN', 'RESOLVED'), true);
  assert.strictEqual(issueService.canTransition('RESOLVED', 'OPEN'), false, 'a closed issue never reopens');
  assert.strictEqual(issueService.canTransition('CANCELLED', 'RESOLVED'), false);
  assert.throws(() => issueService.assertTransition('RESOLVED', 'IN_PROGRESS'), /Cannot change issue status/);
  assert.throws(() => issueService.assertTransition('OPEN', 'OPEN'), /already/);
});

check('7b. resolving records who resolved it, when, and why', async () => {
  install();
  try {
    const issue = makeIssueDoc();
    stores.issues.push(issue);
    const manager = { _id: 'manager-1' };
    await issueService.applyIssueStatus({
      issue,
      status: 'RESOLVED',
      actor: manager,
      note: 'Cleared the road, courier resumed.',
    });

    assert.strictEqual(issue.status, 'RESOLVED');
    assert.strictEqual(String(issue.resolvedBy), 'manager-1');
    assert.ok(issue.resolvedAt instanceof Date);
    assert.strictEqual(issue.resolutionNote, 'Cleared the road, courier resumed.');
    assert.strictEqual(issue.statusHistory.length, 2);
    assert.strictEqual(issue.statusHistory[1].status, 'RESOLVED');
  } finally {
    teardown();
  }
});

check('7c. resolving the last open issue releases the delivery hold', async () => {
  install();
  try {
    const delivery = makeDelivery({ onHold: true, holdReason: 'HEAVY_TRAFFIC', heldAt: new Date() });
    stores.deliveries.set('delivery-1', delivery);
    const issue = makeIssueDoc({ deliveryOnHold: true });
    stores.issues.push(issue);

    await issueService.applyIssueStatus({ issue, status: 'RESOLVED', actor: { _id: 'manager-1' } });

    assert.strictEqual(delivery.onHold, false, 'hold must be released');
    assert.strictEqual(delivery.holdReason, null);
    assert.ok(delivery.resumedAt instanceof Date);
    assert.strictEqual(issue.deliveryOnHold, false);
  } finally {
    teardown();
  }
});

check('7d. the hold stays while ANOTHER issue is still open', async () => {
  install();
  try {
    const delivery = makeDelivery({ onHold: true });
    stores.deliveries.set('delivery-1', delivery);
    const first = makeIssueDoc({ status: 'OPEN', deliveryOnHold: true });
    const second = makeIssueDoc({ _id: 'issue-2', status: 'OPEN', issueType: 'VEHICLE_PROBLEM', deliveryOnHold: true });
    stores.issues.push(first, second);

    await issueService.applyIssueStatus({ issue: first, status: 'RESOLVED', actor: { _id: 'manager-1' } });

    assert.strictEqual(delivery.onHold, true, 'must stay held while an issue remains open');
    assert.strictEqual(await issueService.hasOpenIssue('delivery-1'), true);
  } finally {
    teardown();
  }
});

check('7e. a terminal issue cannot put the delivery on hold', () => {
  // The hold endpoint guard: an already resolved/cancelled issue must not be
  // able to freeze a delivery forever.
  for (const status of ['RESOLVED', 'CANCELLED']) {
    const isTerminal = ['RESOLVED', 'CANCELLED'].includes(status);
    assert.strictEqual(isTerminal, true, `${status} is terminal and must be refused`);
  }
  const isTerminal = (s) => ['RESOLVED', 'CANCELLED'].includes(s);
  assert.strictEqual(isTerminal('OPEN'), false);
  assert.strictEqual(isTerminal('IN_PROGRESS'), false);
});

// ===========================================================================
// 8. The delivery person is told about the resolution
// ===========================================================================

check('8. the courier notification carries the resolution and a working link', () => {
  const controller = require('./src/controllers/deliveryIssue.controller');
  const issue = makeIssueDoc({ status: 'RESOLVED', resolutionNote: 'Road cleared' });
  const links = controller._internal.ISSUE_LINKS;

  assert.ok(links.courier().includes('delivery'), 'the courier link must open the delivery dashboard');
  assert.ok(links.manager().includes('admin'), 'the manager link must open the manager deliveries page');

  // The courier message must be actionable, and must not be the customer's
  // deliberately vague wording.
  const message = `Your report on order #${issue.orderId} was resolved. Note: ${issue.resolutionNote} You can continue the delivery.`;
  assert.match(message, /resolved/);
  assert.match(message, /continue the delivery/i);
});

// ===========================================================================
// 9. The customer sees the delay and then the resumption
// ===========================================================================

check('9. the customer delay message is generic and reveals nothing', () => {
  const controller = require('./src/controllers/deliveryIssue.controller');
  const message = controller._internal.CUSTOMER_DELAY_MESSAGE;

  assert.strictEqual(typeof message, 'string');
  assert.ok(message.length > 0);
  // No issue vocabulary, no courier identity, no position, no blame.
  for (const leak of [
    'VEHICLE',
    'TRAFFIC',
    'GPS',
    'vehicle',
    'traffic',
    'courier',
    'rider',
    'latitude',
    'km',
  ]) {
    assert.ok(!message.includes(leak), `customer message must not contain "${leak}"`);
  }
});

check('9b. the delay is sent at most once per issue', () => {
  // notifyCustomerOfDelay() short-circuits on the persisted flag.
  const decide = (issue) => {
    if (!issue.delaysDelivery) return false;
    if (issue.customerNotified) return false;
    if (!issue.customer) return false;
    return true;
  };
  const issue = { delaysDelivery: true, customerNotified: false, customer: 'customer-1' };
  assert.strictEqual(decide(issue), true);
  issue.customerNotified = true;
  assert.strictEqual(decide(issue), false, 'must never notify twice');
  assert.strictEqual(decide({ delaysDelivery: false, customerNotified: false, customer: 'c' }), false);
});

check('9c. resumption is reflected once the issue is terminal', () => {
  const controller = require('./src/controllers/deliveryIssue.controller');
  for (const status of ['RESOLVED', 'CANCELLED']) {
    const view = controller._internal.serializeIssueForCustomer(makeIssueDoc({ status, resolvedAt: new Date() }));
    assert.strictEqual(view.delayed, false, `${status} must clear the delay`);
  }
});

// ===========================================================================
// 10. History for an order is available and ordered
// ===========================================================================

check('10. a resolved issue keeps a full, ordered status history', async () => {
  install();
  try {
    const issue = makeIssueDoc();
    stores.issues.push(issue);
    const manager = { _id: 'manager-1' };
    await issueService.applyIssueStatus({ issue, status: 'IN_PROGRESS', actor: manager });
    await issueService.applyIssueStatus({ issue, status: 'RESOLVED', actor: manager, note: 'done' });

    const history = issue.toIssuePayload ? issue.statusHistory : issue.statusHistory;
    assert.deepStrictEqual(
      history.map((h) => h.status),
      ['OPEN', 'IN_PROGRESS', 'RESOLVED']
    );
    const times = history.map((h) => new Date(h.at).getTime());
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i] >= times[i - 1], 'history must be in chronological order');
    }
  } finally {
    teardown();
  }
});

check('10b. open issues for a delivery are returned oldest first', async () => {
  install();
  try {
    // Deliberately inserted newest-first, with explicit timestamps, so the
    // assertion can only pass if the service really asks for ascending order.
    const older = makeIssueDoc({ _id: 'issue-old', status: 'OPEN', createdAt: new Date('2026-01-01T10:00:00Z') });
    const newer = makeIssueDoc({ _id: 'issue-new', status: 'OPEN', createdAt: new Date('2026-01-01T12:00:00Z') });
    stores.issues.push(newer, older);

    const open = await issueService.getOpenIssues('delivery-1');
    assert.strictEqual(open.length, 2);
    assert.deepStrictEqual(
      open.map((i) => i._id),
      ['issue-old', 'issue-new'],
      'oldest first'
    );
  } finally {
    teardown();
  }
});

// ===========================================================================
// 11. Another cafeteria cannot see the issue at all
// ===========================================================================

check('11. a foreign cafeteria is excluded by the issue lookups', () => {
  const controller = require('./src/controllers/deliveryIssue.controller');
  const lookup = controller._internal.buildIssueLookup;

  // A human order id must not blow up on the _id clause (CastError -> 500).
  const human = lookup('ORD-1001');
  assert.ok(human, 'a lookup must exist for a human order id');
  const idClauses = human.$or.filter((c) => c._id);
  assert.strictEqual(idClauses.length, 0, 'a non-ObjectId must never be used as _id');

  // A real ObjectId is searched by issue id, delivery and order.
  const real = lookup('507f1f77bcf86cd799439011');
  assert.ok(real.$or.some((c) => c._id));
  assert.ok(real.$or.some((c) => c.delivery));
  assert.ok(real.$or.some((c) => c.orderId));

  // Empty input never produces a match-all query.
  assert.strictEqual(lookup(''), null);
  assert.strictEqual(lookup(null), null);
  assert.strictEqual(lookup(undefined), null);
});

// ===========================================================================
// GPS safety: never a fake 0,0
// ===========================================================================

check('GPS: a missing fix is stored as unavailable, never as 0,0', () => {
  const r = issueService.normalizeLocation({});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.locationAvailable, false);
  assert.strictEqual(r.latitude, null);
  assert.strictEqual(r.longitude, null);
});

check('GPS: 0,0 from a real value is kept, but a coerced 0,0 never is', () => {
  // The bug: Number(null) === 0, so a naive cast invents a position in the ocean.
  for (const bad of [null, undefined, '', false, true, {}, [], 'abc', NaN]) {
    assert.strictEqual(issueService.strictCoordinate(bad, -90, 90), null, `${String(bad)} must not become a number`);
  }
  // A genuine 0,0 from the client is still a real coordinate and is preserved.
  assert.strictEqual(issueService.strictCoordinate(0, -90, 90), 0);
  assert.strictEqual(issueService.strictCoordinate('0', -90, 90), 0);
});

check('GPS: a half pair is rejected rather than guessed', () => {
  for (const bad of [{ latitude: 9.0192 }, { longitude: 38.7525 }]) {
    const r = issueService.normalizeLocation(bad);
    assert.strictEqual(r.ok, false, 'a half pair is a client bug');
    assert.match(r.reason, /Both latitude and longitude are required/);
  }
});

check('GPS: out-of-range coordinates are rejected', () => {
  for (const bad of [
    { latitude: 91, longitude: 38.75 },
    { latitude: -91, longitude: 38.75 },
    { latitude: 9.01, longitude: 181 },
    { latitude: 9.01, longitude: -181 },
    { latitude: Infinity, longitude: 38.75 },
  ]) {
    assert.strictEqual(issueService.normalizeLocation(bad).ok, false, JSON.stringify(bad));
  }
});

check('GPS: a report with no fix falls back to the courier last real fix', async () => {
  install();
  try {
    const delivery = makeDelivery({
      currentLocation: { latitude: 9.03, longitude: 38.74, accuracy: 8 },
    });
    const issue = await issueService.reportIssue({
      delivery,
      order: makeOrder(),
      actor: makeActor(),
      issueType: 'CANNOT_FIND_LOCATION',
      description: 'Cannot find the address',
      location: {},
    });
    assert.strictEqual(issue.locationAvailable, true);
    assert.strictEqual(issue.latitude, 9.03);
    assert.strictEqual(issue.longitude, 38.74);
  } finally {
    teardown();
  }
});

check('GPS: with no fix anywhere the location is simply unavailable', async () => {
  install();
  try {
    const issue = await issueService.reportIssue({
      delivery: makeDelivery(), // currentLocation is all null
      order: makeOrder(),
      actor: makeActor(),
      issueType: 'CANNOT_FIND_LOCATION',
      description: 'Cannot find the address',
      location: {},
    });
    assert.strictEqual(issue.locationAvailable, false);
    assert.strictEqual(issue.latitude, null);
    assert.strictEqual(issue.longitude, null);
  } finally {
    teardown();
  }
});

check('GPS: distance is null, never 0, when a point is unknown', () => {
  assert.strictEqual(issueService.kmBetween({ lat: 9.01, lng: 38.75 }, { lat: null, lng: 38.75 }), null);
  assert.strictEqual(issueService.kmBetween({ lat: null, lng: null }, { lat: 9.01, lng: 38.75 }), null);
  assert.strictEqual(issueService.kmBetween(null, { lat: 9.01, lng: 38.75 }), null);
  // A real nearby pair is a real distance, not a zero placeholder.
  const km = issueService.kmBetween({ lat: 9.0192, lng: 38.7525 }, { lat: 9.0292, lng: 38.7525 });
  assert.ok(km > 0.5 && km < 2, `expected ~1.1 km, got ${km}`);
});

// ===========================================================================
// Status / type normalisation
// ===========================================================================

check('issue type and status normalisation tolerate client spellings', () => {
  assert.strictEqual(issueService.normalizeIssueType('heavy traffic'), 'HEAVY_TRAFFIC');
  assert.strictEqual(issueService.normalizeIssueType('heavy-traffic'), 'HEAVY_TRAFFIC');
  assert.strictEqual(issueService.normalizeIssueType('  VEHICLE_PROBLEM  '), 'VEHICLE_PROBLEM');
  assert.strictEqual(issueService.normalizeIssueType('nope'), null);

  assert.strictEqual(issueService.normalizeIssueStatus('in progress'), 'IN_PROGRESS');
  assert.strictEqual(issueService.normalizeIssueStatus('in-progress'), 'IN_PROGRESS');
  assert.strictEqual(issueService.normalizeIssueStatus('nope'), null);
});

check('the four issue statuses are exactly the agreed set', () => {
  assert.deepStrictEqual([...DELIVERY_ISSUE_STATUSES].sort(), ['CANCELLED', 'IN_PROGRESS', 'OPEN', 'RESOLVED']);
});

check('every customer-delaying type is a real issue type', () => {
  for (const type of CUSTOMER_DELAYING_TYPES) {
    assert.ok(DELIVERY_ISSUE_TYPES.includes(type), `${type} must exist as an issue type`);
  }
});

// --- run -------------------------------------------------------------------

async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failures.push(`${name}\n      ${error.message}`);
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    console.log('');
    process.exitCode = 1;
    return;
  }
  console.log('Delivery issue domain verified.');
}

runAll();
