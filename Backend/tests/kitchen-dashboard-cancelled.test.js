/**
 * Kitchen dashboard - does the CANCELLED bucket actually reach the frontend?
 *
 * The Kitchen Order Queue's "Cancelled" tab stayed empty, so this isolates the
 * backend half: getKitchenDashboard() runs against a stubbed Order model that
 * RECORDS every query and answers with fixtures, then we assert on the filter it
 * built and on the payload it returned.
 *
 * The controller issues its queries in a fixed order - active, then cancelled,
 * then a countDocuments - so the stub routes by call index.
 *
 * Run: node Backend/tests/kitchen-dashboard-cancelled.test.js
 */
const assert = require('assert');
const Module = require('module');

let pass = 0;
let fail = 0;
// Async checks must be AWAITED before the tally, or an `async` test counts as a
// PASS the instant it is registered and its assertions can never fail.
const pendingChecks = [];
function check(name, fn) {
  pendingChecks.push((async () => {
    try { await fn(); pass++; console.log('  PASS ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + ' -- ' + e.message); }
  })());
}

function orderDoc(over) {
  return Object.assign({
    _id: 'oid-' + Math.random().toString(36).slice(2),
    orderId: 'ET-X',
    customerName: 'Cust',
    customerPhone: '0900',
    items: [{ name: 'Kitfo', quantity: 1, notes: '', itemStatus: 'pending' }],
    status: 'pending',
    orderStatus: 'PENDING',
    paymentStatus: 'PAID',
    orderType: 'dine-in',
    tableNumber: '1',
    totalAmount: 100,
    priority: 'normal',
    createdAt: new Date(),
    updatedAt: new Date(),
  }, over || {});
}

function loadController(buckets) {
  const log = [];

  /**
   * Route by QUERY SHAPE, not by call index.
   *
   * The controller now issues three `find`s - active, cancelled, and (only when
   * ?includeUnpaid=1) the unpaid triage list - so an index-based stub would hand
   * the unpaid request the cancelled fixture and silently "pass" the wrong row.
   * Shape-routing also self-documents which query is which.
   */
  const routeFind = (query) => {
    const q = query || {};
    if (q.paymentStatus && q.paymentStatus.$ne === 'FAILED') return 'cancelled';
    if (q.paymentStatus && q.paymentStatus.$ne === 'PAID') return 'unpaid';
    return 'active';
  };
  const routeCount = (query) => {
    const q = query || {};
    if (q.status === 'served') return buckets.completed || 0;
    if (q.paymentStatus && q.paymentStatus.$ne === 'PAID') return buckets.unpaidCount || 0;
    return buckets.ordersInWindow !== undefined ? buckets.ordersInWindow : 0;
  };

  const originalLoad = Module._load;

  const chain = (kind, query) => {
    // Record every chain modifier so a test can assert on the SHAPE of the
    // query, not just its filter. This is how the payload reduction is pinned
    // down: an unprojected dashboard response is ~140 KB and took longer than
    // the client's 15s timeout.
    const mods = [];
    const c = {
      query, mods,
      populate(...a) { mods.push(['populate', a[0]]); return c; },
      sort(...a) { mods.push(['sort', a[0]]); return c; },
      select(...a) { mods.push(['select', a[0]]); return c; },
      limit(...a) { mods.push(['limit', a[0]]); return c; },
      skip(...a) { mods.push(['skip', a[0]]); return c; },
      lean(...a) { mods.push(['lean', a[0]]); return c; },
      then(resolve, reject) {
        log.push({ kind, query: JSON.parse(JSON.stringify(query || {})), mods: mods.slice() });
        return Promise.resolve(buckets[kind] || []).then(resolve, reject);
      },
      catch(reject) { return Promise.reject(reject); },
    };
    return c;
  };

  const OrderStub = {
    find: (query) => {
      const kind = routeFind(query);
      const c = chain(kind, query);
      return c;
    },
    countDocuments: async (query) => {
      log.push({ kind: 'count', query: JSON.parse(JSON.stringify(query || {})) });
      return routeCount(query);
    },
    findById: () => chain('active', {}),
    findOne: () => chain('active', {}),
  };

  const stubs = {
    '../models/Order': OrderStub,
    '../models/Notification': {
      find: () => chain('none', {}),
      create: async () => ({}),
      countDocuments: async () => 0,
    },
    '../models/OrderStatusHistory': { create: async () => ({}) },
  };

  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalLoad.apply(this, arguments);
  };
  const ctrlPath = require.resolve('../src/controllers/kitchen.controller.js');
  delete require.cache[ctrlPath];
  let controller;
  try {
    controller = require(ctrlPath);
  } finally {
    Module._load = originalLoad;
  }
  return { controller, log };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

(async () => {
  console.log('========== KITCHEN DASHBOARD - CANCELLED BUCKET ==========');
  console.log('');

  const buckets = {
    active: [orderDoc({ orderId: 'ET-P1', status: 'pending', orderStatus: 'PENDING' })],
    cancelled: [
      orderDoc({ orderId: 'ET-C1', status: 'cancelled', orderStatus: 'CANCELLED', paymentStatus: 'PAID' }),
      orderDoc({ orderId: 'ET-C2', status: 'cancelled', orderStatus: 'CANCELLED', paymentStatus: 'REFUNDED' }),
      orderDoc({ orderId: 'ET-C3', status: 'CANCELLED', orderStatus: 'CANCELLED', paymentStatus: 'PAID' }),
      // Cancelled while the payment was still open - must still be visible to
      // the kitchen, which is exactly the case the old $nin filter hid.
      orderDoc({ orderId: 'ET-C4', status: 'cancelled', orderStatus: 'CANCELLED', paymentStatus: 'PENDING' }),
    ],
  };

  const { controller, log } = loadController(buckets);
  const req = { user: { id: 'u1', role: 'kitchen' }, query: {}, params: {} };
  const res = fakeRes();
  await controller.getKitchenDashboard(req, res);

  check('dashboard responded 200', () => assert.strictEqual(res.statusCode, 200));
  check('payload has success:true', () => assert.strictEqual(res.body.success, true));
  check('orders.cancelled is an array', () => assert.ok(Array.isArray(res.body.orders.cancelled)));
  check('all four cancelled orders are returned', () => {
    const ids = res.body.orders.cancelled.map((o) => o.orderId).sort();
    assert.deepStrictEqual(ids, ['ET-C1', 'ET-C2', 'ET-C3', 'ET-C4'], JSON.stringify(ids));
  });
  check('stats.cancelled matches the returned rows', () =>
    assert.strictEqual(res.body.stats.cancelled, res.body.orders.cancelled.length));
  check('a cancelled row keeps the fields the table renders', () => {
    const row = res.body.orders.cancelled[0];
    ['orderId', 'customerName', 'status', 'orderStatus', 'items', 'createdAt', 'orderType']
      .forEach((f) => assert.ok(row[f] !== undefined, 'missing field: ' + f));
    assert.ok(Array.isArray(row.items) && row.items.length > 0, 'items empty');
  });
  check('cancelled orders are not folded into an active bucket', () => {
    assert.strictEqual(res.body.orders.pending.length, 1, 'pending should hold only the active order');
    const leaked = [...res.body.orders.pending, ...res.body.orders.preparing, ...res.body.orders.ready]
      .filter((o) => String(o.status).toLowerCase() === 'cancelled');
    assert.strictEqual(leaked.length, 0, 'cancelled orders leaked into an active bucket');
  });
  check('the cancelled query is NOT date-limited', () => {
    const q = log.find((e) => e.kind === 'cancelled');
    assert.ok(q, 'cancelled query was never issued');
    assert.ok(!q.query.createdAt, 'cancelled orders must not be hidden by a date window');
  });
  check('the cancelled query matches status OR orderStatus', () => {
    const q = log.find((e) => e.kind === 'cancelled').query;
    assert.ok(q.$or, 'no $or');
    const flat = JSON.stringify(q.$or);
    assert.ok(flat.includes('cancelled'), 'status branch missing lowercase cancelled');
    assert.ok(flat.includes('CANCELLED'), 'status branch missing uppercase CANCELLED');
    assert.ok(flat.includes('"orderStatus":"CANCELLED"'), 'orderStatus branch missing');
  });
  check('the cancelled list keeps every cancellation, only dropping FAILED payments', () => {
    const q = log.find((e) => e.kind === 'cancelled').query;
    // An order cancelled before payment settled is still a cancellation the
    // kitchen must see; the old $nin filter dropped `paymentStatus: PENDING`
    // and the tab rendered "no cancelled orders" while they existed.
    assert.ok(q.paymentStatus, 'no payment filter at all - FAILED would leak in');
    assert.deepStrictEqual(
      q.paymentStatus,
      { $ne: 'FAILED' },
      JSON.stringify(q.paymentStatus)
    );
  });

  /* --- end-to-end shape check -------------------------------------------
     The frontend derives its Cancelled tab purely from this payload, so the two
     halves are asserted against the SAME contract: every row must carry the
     fields kitchen.js's table row renders, and its status must normalise to
     'cancelled'. If either side drifts, the tab silently empties. */
  check('payload rows match exactly what the frontend Cancelled tab renders', () => {
    res.body.orders.cancelled.forEach((row) => {
      // statusLabel()/normalize() in kitchen.js lowercases and maps variants.
      const s = String(row.status || row.orderStatus || '').toLowerCase().trim();
      assert.ok(s === 'cancelled', `${row.orderId}: status "${row.status}" would NOT match the Cancelled tab`);
      // Table columns: Ticket #, Customer, Type, Items & Quantities, Status,
      // Time Elapsed, Actions.
      assert.ok(row.orderId, `${row.orderId}: no orderId`);
      assert.ok(row.customerName, `${row.orderId}: no customerName`);
      assert.ok(row.orderType, `${row.orderId}: no orderType`);
      assert.ok(Array.isArray(row.items) && row.items.length, `${row.orderId}: no items`);
      row.items.forEach((it, i) => {
        assert.ok(it.name, `${row.orderId}: item ${i} has no name`);
        assert.ok(Number.isFinite(Number(it.quantity)), `${row.orderId}: item ${i} has no quantity`);
      });
      assert.ok(row.createdAt, `${row.orderId}: no createdAt (Time Elapsed would read 00 mins)`);
    });
  });

  /* --- WHY is the board empty? diagnostics + the opt-in unpaid view -------- */
  {
    const DIAG = {
      active: [orderDoc({ orderId: 'ET-P1', status: 'pending', orderStatus: 'PENDING' })],
      cancelled: [],
      unpaid: [
        orderDoc({ orderId: 'ET-U1', status: 'pending', orderStatus: 'PENDING', paymentStatus: 'PENDING' }),
        orderDoc({ orderId: 'ET-U2', status: 'preparing', orderStatus: 'PREPARING', paymentStatus: 'PENDING' }),
      ],
      ordersInWindow: 7,
      unpaidCount: 3,
    };

    // (a) DEFAULT - no ?includeUnpaid. The unpaid view must stay off and the
    //     diagnostic must still be reported so the UI can explain an empty board.
    const def = await loadController(DIAG);
    const defRes = fakeRes();
    await def.controller.getKitchenDashboard(
      { user: { id: 'u1', role: 'kitchen' }, query: {}, params: {} }, defRes
    );

    check('dashboard reports a diagnostics block', () => {
      const d = defRes.body.diagnostics;
      assert.ok(d, 'no diagnostics in the payload');
      assert.strictEqual(d.ordersInWindow, 7);
      assert.strictEqual(d.unpaidInWindow, 3);
      assert.strictEqual(d.unpaidIncluded, false);
    });

    check('by default NO unpaid row is queried or returned', () => {
      assert.strictEqual(defRes.body.orders.unpaid.length, 0, 'unpaid leaked into the payload');
      assert.ok(!def.log.some((e) => e.kind === 'unpaid'),
        'the unpaid find was issued without ?includeUnpaid=1 - a default request now costs an extra query');
    });

    check('the unpaid orders hidden from the queue are still counted', () => {
      assert.strictEqual(defRes.body.diagnostics.unpaidInWindow, 3);
      assert.strictEqual(defRes.body.orders.unpaid.length, 0,
        'unpaidInWindow must be able to exceed the rows actually returned');
    });

    check('stats are built from the PAID-only query, never from the unpaid list', () => {
      const s = defRes.body.stats;
      assert.strictEqual(s.activeOrders, 1, 'activeOrders must count only the paid order');
      assert.strictEqual(s.pending, 1);
    });

    // (b) EXPLICIT opt-in.
    const inc = await loadController(DIAG);
    const incRes = fakeRes();
    await inc.controller.getKitchenDashboard(
      { user: { id: 'u1', role: 'kitchen' }, query: { includeUnpaid: '1' }, params: {} }, incRes
    );

    check('?includeUnpaid=1 returns the unpaid rows', () => {
      const ids = incRes.body.orders.unpaid.map((o) => o.orderId);
      assert.deepStrictEqual(ids, ['ET-U1', 'ET-U2'], JSON.stringify(ids));
      assert.strictEqual(incRes.body.diagnostics.unpaidIncluded, true);
    });

    check('the unpaid rows carry the fields the table renders', () => {
      incRes.body.orders.unpaid.forEach((row) => {
        ['orderId', 'customerName', 'status', 'items', 'createdAt', 'orderType', 'paymentStatus']
          .forEach((f) => assert.ok(row[f] !== undefined, `${row.orderId}: missing ${f}`));
        assert.ok(Array.isArray(row.items) && row.items.length, `${row.orderId}: items empty`);
        assert.notStrictEqual(String(row.paymentStatus).toUpperCase(), 'PAID',
          `${row.orderId}: a PAID order belongs in the normal queue, not the triage view`);
      });
    });

    check('the unpaid query is explicitly NOT the paid queue', () => {
      const q = inc.log.find((e) => e.kind === 'unpaid');
      assert.ok(q, 'unpaid find was never issued');
      assert.deepStrictEqual(q.query.paymentStatus, { $ne: 'PAID' });
      assert.ok(q.query.$or, 'unpaid query has no kitchen-stage $or');
      assert.ok(q.query.createdAt, 'unpaid query is not window-limited');
    });

    check('opting in does not disturb the kitchen stats', () => {
      assert.strictEqual(incRes.body.stats.activeOrders, 1,
        'the unpaid rows were folded into the kitchen counts');
      assert.strictEqual(incRes.body.orders.unpaid.length, 2);
      assert.strictEqual(incRes.body.stats.totalActive, 1);
    });

    check('FAILED payments stay out of the unpaid triage view', async () => {
      const b = Object.assign({}, DIAG, {
        unpaid: [
          orderDoc({ orderId: 'ET-U9', status: 'pending', orderStatus: 'PENDING', paymentStatus: 'FAILED' }),
        ],
      });
      const h = loadController(b);
      const r = fakeRes();
      await h.controller.getKitchenDashboard(
        { user: { id: 'u1', role: 'kitchen' }, query: { includeUnpaid: 'true' }, params: {} }, r
      );
      assert.strictEqual(r.body.orders.unpaid.length, 0,
        'an abandoned checkout surfaced as "not paid yet" work');
    });
  }

  await Promise.all(pendingChecks);

  /* --- payload size: the board must fit inside the client's timeout --------- */
  {
    const PAY = {
      active: [orderDoc({ orderId: 'ET-P1', status: 'pending', orderStatus: 'PENDING' })],
      cancelled: [orderDoc({ orderId: 'ET-C1', status: 'cancelled', orderStatus: 'CANCELLED', paymentStatus: 'PENDING' })],
      ordersInWindow: 4,
      unpaidCount: 0,
    };
    const h = await loadController(PAY);
    const r = fakeRes();
    await h.controller.getKitchenDashboard(
      { user: { id: 'u1', role: 'kitchen' }, query: {}, params: {} }, r
    );
    const entry = (kind) => h.log.find((e) => e.kind === kind);
    const mod = (e, name) => (e.mods || []).filter((m) => m[0] === name);

    check('the active query projects the rows instead of shipping whole documents', () => {
      const e = entry('active');
      const sel = mod(e, 'select');
      assert.ok(sel.length, 'the active query has no .select() - every field is shipped');
      const fields = String(sel[0][1]);
      // Everything formatKitchenOrder() reads must survive the projection.
      ['orderId', 'customerName', 'status', 'orderStatus', 'paymentStatus', 'orderType',
        'tableNumber', 'createdAt', 'totalAmount', 'estimatedCompletionTime', 'readyTime',
        'completedTime'].forEach((f) => {
          assert.ok(new RegExp(`(^|\\s)${f}($|\\s)`).test(fields),
            `${f} is missing from the projection - that cell would render empty`);
        });
      // The items array is the single largest field in the document.
      assert.ok(fields.includes('items.name') || fields.includes('items'),
        'items is not projected at all');
    });

    check('the cancelled query also projects its rows', () => {
      const e = entry('cancelled');
      assert.ok(mod(e, 'select').length, 'the cancelled query has no .select()');
    });

    check('no query on this endpoint populates userId (nobody reads it)', () => {
      const populated = h.log.filter((e) => mod(e, 'populate').length);
      assert.strictEqual(populated.length, 0,
        `populate() on ${populated.map((e) => e.kind).join(', ')} costs a round trip each and its result is discarded`);
    });

    check('the unbounded cancelled query is capped, not date-filtered', () => {
      const e = entry('cancelled');
      const lim = mod(e, 'limit');
      assert.ok(lim.length, 'no .limit() - every cancellation ever made ships on every poll');
      assert.ok(Number(lim[0][1]) > 0, 'limit must be a positive number');
      // Still no date window: old cancellations must stay visible.
      assert.ok(!e.query.createdAt, 'a date window was reintroduced on the cancelled list');
      assert.deepStrictEqual(e.query.paymentStatus, { $ne: 'FAILED' });
    });

    check('the projected payload still round-trips every field the board renders', () => {
      const rendered = [
        ...r.body.orders.pending, ...r.body.orders.preparing,
        ...r.body.orders.ready, ...r.body.orders.cancelled,
      ];
      assert.ok(rendered.length, 'no rows came back at all');
      rendered.forEach((row) => {
        ['orderId', 'customerName', 'status', 'orderType', 'createdAt', 'paymentStatus', 'items']
          .forEach((f) => assert.ok(row[f] !== undefined, `${row.orderId}: projection dropped ${f}`));
        assert.ok(Array.isArray(row.items) && row.items.length, `${row.orderId}: items empty`);
      });
    });
  }

  await Promise.all(pendingChecks);

  console.log('');
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
