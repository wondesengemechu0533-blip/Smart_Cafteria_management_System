/**
 * Cafeteria Admin Dashboard: the 7D / 30D / 90D date-range buttons.
 *
 * WHY this test exists (the bug it locks down):
 *
 *   The dashboard rendered "Last 7 Days / Last 30 Days / Last 90 Days"
 *   buttons on the Order Status Overview card, but they were purely cosmetic:
 *
 *     1. applyDateRange() stored the range and reloaded, yet loadDashboard()
 *        never sent it - every request was GET /admin/dashboard with no
 *        query, so 30D and 90D fetched identical data to 7D.
 *     2. The backend hardcoded a 7-day chart series and returned ALL-TIME
 *        order-status counts to the doughnut, so the buttons had nothing to
 *        filter even if the range had been sent.
 *
 *   Now the range is wired end to end: the buttons pass ?days=N to the API,
 *   the API scopes the revenue series AND the doughnut's order-status counts
 *   to that window, and the revenue chart title follows the selection.
 *   chart.last7Days is kept (manager-dashboard.js still renders it).
 *
 * Part A drives the real backend (Express + MongoDB) over HTTP.
 * Part B drives the real Frontend/src/js/dashboard.js against a minimal DOM
 * (same technique as tests/cancel-confirm-button.test.js).
 * Part D runs the REAL admin-api.js + dashboard.js together against the
 * real in-process server - the network layer Part B stubs - so regressions
 * in rate limiting, query serialization, or auth headers are caught too.
 *
 * Run: node tests/admin-dashboard-date-range.test.js
 */
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scs_admin_dash_range';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-dash-range-secret';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');

const PORT = 5108;
const API = `http://127.0.0.1:${PORT}/api/v1`;
const DASHBOARD_SCRIPT = path.join(__dirname, '..', '..', 'Frontend', 'src', 'js', 'dashboard.js');
const ADMIN_API_SCRIPT = path.join(__dirname, '..', '..', 'Frontend', 'src', 'js', 'admin-api.js');

let passed = 0;
const failures = [];
let chain = Promise.resolve();
function check(name, fn) {
  chain = chain.then(async () => {
    try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
    catch (e) { failures.push(name); console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); }
  });
  return chain;
}

// ===========================================================================
// Part B harness: minimal DOM + stubbed AdminAPI/Chart around dashboard.js
// ===========================================================================
function loadDashboardPage({ getImpl }) {
  const registry = new Map();
  const toasts = [];
  const gets = [];
  const chartConfigs = [];
  const domReady = [];

  class El {
    constructor(id, tag) {
      this.id = id || '';
      this.tagName = (tag || 'div').toUpperCase();
      this.className = '';
      this.style = {};
      this.value = '';
      this.disabled = false;
      this.listeners = {};
      this.attrs = {};
      this.dataset = {};
      this._html = '';
      const classes = new Set();
      this.classList = {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        toggle: (c, force) => {
          const on = force === undefined ? !classes.has(c) : !!force;
          if (on) classes.add(c); else classes.delete(c);
          return on;
        },
        contains: (c) => classes.has(c),
      };
    }
    set innerHTML(html) { this._html = String(html); }
    get innerHTML() { return this._html; }
    set textContent(v) { this._html = String(v); }
    get textContent() { return this._html; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener() {}
    setAttribute(name, v) { this.attrs[name] = String(v); }
    getAttribute(name) { return this.attrs[name] !== undefined ? this.attrs[name] : null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    focus() {}
    dispatch(type, event) {
      const ev = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {} }, event);
      for (const fn of (this.listeners[type] || []).slice()) fn(ev);
      return ev;
    }
    click() { return this.dispatch('click'); }
  }

  const rangeButtons = ['7d', '30d', '90d'].map((r) => {
    const b = new El('', 'button');
    b.className = 'date-range-btn';
    b.dataset.range = r;
    return b;
  });

  for (const id of [
    'lastUpdated', 'revenueChartTitle', 'orderStatusChart', 'revenueChart', 'feedbackRatingChart',
    'recentOrdersTableBody', 'recentPaymentsTableBody', 'refreshMetricsBtn', 'resetDashboardMetricsBtn',
    'autoRefreshBtn', 'exportDashboardBtn', 'applyCustomDateBtn', 'startDateInput', 'endDateInput',
    'statTotalUsers', 'statTotalRevenue', 'statTotalFeedback', 'statAvgRating',
  ]) {
    registry.set(id, new El(id, id.includes('Chart') ? 'canvas' : 'div'));
  }

  const documentStub = {
    readyState: 'complete',
    getElementById: (id) => registry.get(id) || null,
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel === '.date-range-btn') return rangeButtons.slice();
      return [];
    },
    addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') domReady.push(fn); },
    createElement: (t) => new El('', t),
    head: new El('head', 'head'),
    body: new El('body', 'body'),
  };

  const localStorageStub = {
    _m: {},
    getItem(k) { return this._m[k] !== undefined ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
  };

  const esc = (v) => (v === null || v === undefined ? '' : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));

  const windowStub = {
    location: { pathname: '/src/pages/admin/admin-dashboard.html', href: '' },
    addEventListener() {},
    removeEventListener() {},
    confirm: () => true,
    esc: esc,
    AdminToast: {
      show: (m) => toasts.push({ type: 'info', message: m }),
      success: (m) => toasts.push({ type: 'success', message: m }),
      error: (m) => toasts.push({ type: 'error', message: m }),
      warning: (m) => toasts.push({ type: 'warning', message: m }),
      info: (m) => toasts.push({ type: 'info', message: m }),
    },
    AdminAPI: {
      esc: esc,
      formatDateTime: (v) => (v ? String(v) : '—'),
      formatDate: (v) => (v ? String(v) : '—'),
      get(p, query) {
        gets.push({ path: p, query: query || {} });
        return Promise.resolve().then(() => getImpl(p, query || {}, gets.length));
      },
    },
  };

  // Chart stub: records every chart config so the test can assert on the
  // data each button produced. destroy() must exist (destroyCharts() calls it).
  function ChartStub(canvas, config) {
    chartConfigs.push(config);
    this.destroy = () => {};
    this.update = () => {};
  }

  const src = fs.readFileSync(DASHBOARD_SCRIPT, 'utf8');
  const factory = new Function(
    'window', 'document', 'localStorage', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'console', 'Chart',
    src
  );
  factory(windowStub, documentStub, localStorageStub, () => 0, () => {}, setTimeout, () => {}, console, ChartStub);

  // Fire DOMContentLoaded so init() runs (binds buttons + first load).
  for (const fn of domReady.slice()) fn();

  return { registry, toasts, gets, chartConfigs, rangeButtons, window: windowStub };
}

  const errWith = (status, message) => Object.assign(new Error(message), { status });

  // Local calendar-day key, matching the backend's bucketing (toISOString
  // would disagree with local midnight in positive-offset timezones).
  const dayKey = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

// ===========================================================================
// Shared payload builders for the frontend stub
// ===========================================================================
function okDashboard(days, chart) {
  return {
    success: true,
    data: {
      users: { total: 3, customers: 1 },
      menu: { total: 2, available: 2, unavailable: 0 },
      // Deliberately DIFFERENT from the range-scoped counts: the doughnut must
      // render chart.ordersInRange, not these all-time numbers.
      orders: { total: 999, pending: 500, preparing: 100, ready: 80, served: 70, completed: 200, cancelled: 49 },
      payments: { successful: 5, pending: 1, failed: 0 },
      revenue: { today: 10, total: 5000 },
      chart,
      cancellations: { pending: 0 },
    },
  };
}

const RANGE_COUNTS = {
  7: { total: 2, pending: 1, preparing: 0, ready: 0, served: 0, completed: 1, cancelled: 0 },
  30: { total: 3, pending: 1, preparing: 0, ready: 0, served: 0, completed: 2, cancelled: 0 },
  90: { total: 5, pending: 1, preparing: 0, ready: 0, served: 0, completed: 3, cancelled: 1 },
};

function seriesFor(days) {
  const out = [];
  const dayKey = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - (days - 1) + i);
    out.push({ date: dayKey(d), orders: i === days - 1 ? 1 : 0, revenue: i === days - 1 ? 100 : 0 });
  }
  return out;
}

function frontendGetImpl(p, query) {
  if (p === '/admin/dashboard') {
    const days = Number.isInteger(query.days) ? query.days : 7;
    const series = seriesFor(days);
    return okDashboard(days, {
      days,
      series,
      last7Days: series.slice(-7),
      ordersInRange: RANGE_COUNTS[days] || RANGE_COUNTS[7],
    });
  }
  if (p === '/admin/dashboard/recent-orders') return { success: true, orders: [] };
  if (p === '/admin/dashboard/recent-payments') return { success: true, payments: [] };
  if (p === '/feedback/stats') return { success: true, stats: { totalFeedback: 0, ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } } };
  throw errWith(404, 'unexpected GET ' + p);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const { app } = require('../server.js');
  const httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(PORT, r));

  const jwt = require('jsonwebtoken');
  const User = require('../src/models/User');
  const Order = require('../src/models/Order');

  let phoneSeq = 0;
  const mkUser = (name, role) =>
    User.create({
      name,
      email: `${name.toLowerCase().replace(/[^a-z]/g, '')}@dashrange.test`,
      phone: '0977' + String(++phoneSeq).padStart(6, '0'),
      password: 'password123',
      role,
      status: 'ACTIVE',
    });

  const customer = await mkUser('DashCust', 'customer');
  const cafAdmin = await mkUser('DashCafAdmin', 'manager');
  const tok = jwt.sign({ id: cafAdmin._id, role: cafAdmin.role }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const call = async (p) => {
    const res = await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${tok}` } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // Seeded order plan (age -> status/amount):
  //   today       COMPLETED 100  (in every window, today's revenue bucket)
  //   3 days ago  PENDING    50  (in 7/30/90)
  //  10 days ago  COMPLETED 200  (in 30/90, NOT in 7)
  //  40 days ago  CANCELLED 300  (in 90 only)
  //  85 days ago  COMPLETED 400  (in 90 only)
  const daysAgo = (n, h = 12) => {
    const d = new Date();
    d.setHours(h, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return d;
  };

  const mkOrder = async (createdAt, orderStatus, totalAmount) => {
    const o = new Order({
      orderId: 'ET-RANGE-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      userId: customer._id,
      customerName: 'Dash Customer',
      customerPhone: '0999',
      orderType: 'dine-in',
      orderStatus,
      status: orderStatus.toLowerCase(),
      paymentMethod: 'CASH',
      paymentStatus: 'PAID',
      subtotal: totalAmount,
      serviceFee: 0,
      totalAmount,
      items: [],
    });
    o.createdAt = createdAt;
    await o.save({ validateBeforeSave: false });
    return o;
  };

  const seed = async () => {
    await mkOrder(daysAgo(0, new Date().getHours()), 'COMPLETED', 100);
    await mkOrder(daysAgo(3), 'PENDING', 50);
    await mkOrder(daysAgo(10), 'COMPLETED', 200);
    await mkOrder(daysAgo(40), 'CANCELLED', 300);
    await mkOrder(daysAgo(85), 'COMPLETED', 400);
  };

  // =========================================================================
  console.log('\nA. Backend: GET /admin/dashboard?days=N');
  // =========================================================================

  let baselineTotal = 0;
  await check('setup: five orders seeded across 85 days', async () => {
    await seed();
    baselineTotal = await Order.countDocuments();
    assert.ok(baselineTotal >= 5, `orders stored, got ${baselineTotal}`);
  });

  await check('no ?days= → 7-day default: 7 buckets, doughnut scoped to 7 days', async () => {
    const r = await call('/admin/dashboard');
    assert.strictEqual(r.status, 200, `status=${r.status}`);
    const chart = r.body.data.chart;
    assert.strictEqual(chart.days, 7, 'days defaults to 7');
    assert.strictEqual(chart.series.length, 7, `series has 7 buckets, got ${chart.series.length}`);
    assert.strictEqual(chart.series[6].date, dayKey(new Date()), 'last bucket is today');
    // today + 3 days ago only - the 10/40/85-day-old orders are out.
    assert.strictEqual(chart.ordersInRange.total, 2, `7d total, got ${chart.ordersInRange.total}`);
    assert.strictEqual(chart.ordersInRange.pending, 1, 'the 3-day-old PENDING order is in range');
    assert.strictEqual(chart.ordersInRange.completed, 1, "today's COMPLETED order is in range");
    assert.strictEqual(chart.ordersInRange.cancelled, 0, 'the 40-day CANCELLED order is out of range');
  });

  await check('?days=30 → 30 buckets, doughnut gains the 10-day order, loses nothing else', async () => {
    const r = await call('/admin/dashboard?days=30');
    assert.strictEqual(r.status, 200, `status=${r.status}`);
    const chart = r.body.data.chart;
    assert.strictEqual(chart.days, 30);
    assert.strictEqual(chart.series.length, 30, `series has 30 buckets, got ${chart.series.length}`);
    assert.strictEqual(chart.ordersInRange.total, 3, `30d total, got ${chart.ordersInRange.total}`);
    assert.strictEqual(chart.ordersInRange.completed, 2, 'the 10-day COMPLETED order is now in range');
    assert.strictEqual(chart.ordersInRange.cancelled, 0, 'the 40-day CANCELLED order is still out');
  });

  await check('?days=90 → 90 buckets, doughnut gains the 40- and 85-day orders', async () => {
    const r = await call('/admin/dashboard?days=90');
    assert.strictEqual(r.status, 200, `status=${r.status}`);
    const chart = r.body.data.chart;
    assert.strictEqual(chart.days, 90);
    assert.strictEqual(chart.series.length, 90, `series has 90 buckets, got ${chart.series.length}`);
    assert.strictEqual(chart.ordersInRange.total, 5, `90d total, got ${chart.ordersInRange.total}`);
    assert.strictEqual(chart.ordersInRange.completed, 3, 'the 40- and 85-day COMPLETED orders are in range');
    assert.strictEqual(chart.ordersInRange.cancelled, 1, 'the 40-day CANCELLED order is now in range');
  });

  await check('the 30d series is a superset of the 7d series (same daily buckets, extended back)', async () => {
    const r7 = (await call('/admin/dashboard?days=7')).body.data.chart.series;
    const r30 = (await call('/admin/dashboard?days=30')).body.data.chart.series;
    assert.deepStrictEqual(r30.slice(-7), r7, 'the most recent 7 buckets must be identical across windows');
  });

  await check("today's PAID order lands in today's revenue bucket in every window", async () => {
    for (const days of [7, 30, 90]) {
      const series = (await call(`/admin/dashboard?days=${days}`)).body.data.chart.series;
      const todayBucket = series[series.length - 1];
      assert.strictEqual(todayBucket.date, dayKey(new Date()), `days=${days} last bucket`);
      assert.strictEqual(todayBucket.revenue, 100, `days=${days} today's revenue, got ${todayBucket.revenue}`);
      assert.ok(todayBucket.orders >= 1, `days=${days} today's order counted`);
    }
  });

  await check('bogus ?days= values fall back to the 7-day default (no unbounded scan)', async () => {
    for (const raw of ['999', '0', '-5', 'abc', '7.5']) {
      const r = await call(`/admin/dashboard?days=${encodeURIComponent(raw)}`);
      assert.strictEqual(r.status, 200, `days=${raw} status=${r.status}`);
      const chart = r.body.data.chart;
      assert.strictEqual(chart.days, 7, `days=${raw} → default 7, got ${chart.days}`);
      assert.strictEqual(chart.series.length, 7, `days=${raw} → 7 buckets`);
    }
  });

  await check('backward compat: chart.last7Days survives with 7 entries even at days=30', async () => {
    const chart = (await call('/admin/dashboard?days=30')).body.data.chart;
    assert.ok(Array.isArray(chart.last7Days), 'last7Days still present (manager-dashboard.js renders it)');
    assert.strictEqual(chart.last7Days.length, 7, `last7Days stays 7 entries, got ${chart.last7Days.length}`);
    assert.deepStrictEqual(chart.last7Days, chart.series.slice(-7), 'last7Days mirrors the newest 7 buckets');
    for (const b of chart.last7Days) {
      assert.ok(b.date && typeof b.orders === 'number' && typeof b.revenue === 'number',
        'each last7Days bucket keeps {date, orders, revenue}');
    }
  });

  await check('the doughnut counts are range-scoped but the top-level order totals stay all-time', async () => {
    const data = (await call('/admin/dashboard?days=7')).body.data;
    assert.ok(data.orders.total >= baselineTotal, `all-time total untouched by ?days (got ${data.orders.total})`);
    assert.ok(data.orders.total > data.chart.ordersInRange.total,
      'range-scoped total must be smaller than the all-time total here');
  });

  await check('revenue.today and revenue.total are unaffected by ?days (cards stay all-time)', async () => {
    const d7 = (await call('/admin/dashboard?days=7')).body.data.revenue;
    const d90 = (await call('/admin/dashboard?days=90')).body.data.revenue;
    assert.strictEqual(d7.total, d90.total, 'total revenue identical across windows');
    assert.strictEqual(d7.today, d90.today, "today's revenue identical across windows");
  });

  await check('customers still 403 on the dashboard endpoint', async () => {
    const custTok = jwt.sign({ id: customer._id, role: 'customer' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const res = await fetch(`${API}/admin/dashboard?days=30`, { headers: { Authorization: `Bearer ${custTok}` } });
    assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
  });

  // =========================================================================
  console.log('\nB. Frontend: the buttons drive the range');
  // =========================================================================

  const dashboardGets = (page) => page.gets.filter((g) => g.path === '/admin/dashboard');
  const doughnut = (page) => page.chartConfigs.find((c) => c.type === 'doughnut');
  const bar = (page) => page.chartConfigs.find((c) => c.type === 'bar');

  await check('initial load requests ?days=7 and renders 7 revenue bars + 7-day doughnut', async () => {
    const page = loadDashboardPage({ getImpl: frontendGetImpl });
    await new Promise((r) => setTimeout(r, 20));
    const dashGets = dashboardGets(page);
    assert.ok(dashGets.length >= 1, 'the dashboard stats request fired');
    assert.strictEqual(dashGets[0].query.days, 7, `initial load sends days=7, got ${JSON.stringify(dashGets[0].query)}`);

    const b = bar(page);
    assert.ok(b, 'the revenue bar chart rendered');
    assert.strictEqual(b.data.labels.length, 7, `7 bars, got ${b.data.labels.length}`);
    assert.strictEqual(b.data.datasets[0].data.length, 7);

    const d = doughnut(page);
    assert.ok(d, 'the order-status doughnut rendered');
    // keys: pending, preparing, ready, served, completed, cancelled
    assert.deepStrictEqual(d.data.datasets[0].data, [1, 0, 0, 0, 1, 0],
      `7d doughnut = range counts, got ${JSON.stringify(d.data.datasets[0].data)}`);
    assert.notDeepStrictEqual(d.data.datasets[0].data, [500, 100, 80, 70, 200, 49],
      'the doughnut must NOT render the all-time stats.orders counts');
  });

  await check('clicking 30D re-requests with days=30, 30 bars, wider doughnut, new title', async () => {
    const page = loadDashboardPage({ getImpl: frontendGetImpl });
    await new Promise((r) => setTimeout(r, 20));
    page.chartConfigs.length = 0; // isolate what the click renders

    const btn30 = page.rangeButtons.find((b) => b.dataset.range === '30d');
    btn30.click();
    await new Promise((r) => setTimeout(r, 20));

    const dashGets = dashboardGets(page);
    assert.strictEqual(dashGets.length, 2, `one more dashboard request after the click, got ${dashGets.length}`);
    assert.strictEqual(dashGets[1].query.days, 30, `click sends days=30, got ${JSON.stringify(dashGets[1].query)}`);

    const b = bar(page);
    assert.strictEqual(b.data.labels.length, 30, `30 bars, got ${b.data.labels.length}`);

    const d = doughnut(page);
    assert.deepStrictEqual(d.data.datasets[0].data, [1, 0, 0, 0, 2, 0],
      `30d doughnut includes the 10-day order, got ${JSON.stringify(d.data.datasets[0].data)}`);

    const title = page.registry.get('revenueChartTitle');
    assert.ok(/Last 30 Days/.test(title.innerHTML), `title tracks the range, got "${title.innerHTML}"`);
    assert.strictEqual(title.getAttribute('data-i18n'), 'admin_revenue_last30', 'i18n key follows the range');
    assert.ok(btn30.classList.contains('active'), '30D button marked active');
  });

  await check('clicking 90D → days=90, 90 bars, full doughnut, title updates again', async () => {
    const page = loadDashboardPage({ getImpl: frontendGetImpl });
    await new Promise((r) => setTimeout(r, 20));
    page.chartConfigs.length = 0;

    page.rangeButtons.find((b) => b.dataset.range === '90d').click();
    await new Promise((r) => setTimeout(r, 20));

    const dashGets = dashboardGets(page);
    assert.strictEqual(dashGets[dashGets.length - 1].query.days, 90, `days=90 sent, got ${JSON.stringify(dashGets[dashGets.length - 1].query)}`);

    const b = bar(page);
    assert.strictEqual(b.data.labels.length, 90, `90 bars, got ${b.data.labels.length}`);

    const d = doughnut(page);
    assert.deepStrictEqual(d.data.datasets[0].data, [1, 0, 0, 0, 3, 1],
      `90d doughnut includes the 40/85-day orders, got ${JSON.stringify(d.data.datasets[0].data)}`);

    assert.ok(/Last 90 Days/.test(page.registry.get('revenueChartTitle').innerHTML), 'title says 90 days');
  });

  await check('switching back to 7D returns to the original window (round trip)', async () => {
    const page = loadDashboardPage({ getImpl: frontendGetImpl });
    await new Promise((r) => setTimeout(r, 20));
    page.rangeButtons.find((b) => b.dataset.range === '30d').click();
    await new Promise((r) => setTimeout(r, 20));
    page.chartConfigs.length = 0;
    page.rangeButtons.find((b) => b.dataset.range === '7d').click();
    await new Promise((r) => setTimeout(r, 20));

    const dashGets = dashboardGets(page);
    assert.strictEqual(dashGets[dashGets.length - 1].query.days, 7, 'back to days=7');
    assert.strictEqual(bar(page).data.labels.length, 7, 'back to 7 bars');
    assert.ok(/Last 7 Days/.test(page.registry.get('revenueChartTitle').innerHTML), 'title back to 7 days');
  });

  await check('the legacy chart.last7Days shape still renders (old payload fallback)', async () => {
    const legacy = seriesFor(7);
    const page = loadDashboardPage({
      getImpl: (p, query) => {
        if (p === '/admin/dashboard') {
          // Old backend: no days/series/ordersInRange - only last7Days.
          return okDashboard(7, { last7Days: legacy });
        }
        return frontendGetImpl(p, query);
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    const b = bar(page);
    assert.ok(b, 'revenue chart rendered from the legacy envelope');
    assert.strictEqual(b.data.labels.length, 7, `legacy last7Days still draws 7 bars, got ${b.data.labels.length}`);
    const d = doughnut(page);
    assert.strictEqual(d.data.datasets[0].data.reduce((s, n) => s + n, 0), 999,
      'without ordersInRange the doughnut falls back to stats.orders (all-time)');
  });

  await check('a failing dashboard request shows an error toast, not a crash', async () => {
    const page = loadDashboardPage({
      getImpl: (p, query) => {
        if (p === '/admin/dashboard') throw errWith(500, 'Server error');
        return frontendGetImpl(p, query);
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(page.toasts.some((t) => t.type === 'error'), 'an error toast was shown');
    assert.ok(!page.toasts.some((t) => t.type === 'success'), 'no false success toast');
  });

  // C. Both dashboard pages keep the Date Range controls (a silent HTML
  // removal would leave the wiring intact but unreachable - the harness above
  // builds its own buttons, so it can't catch a page that lost its own).
  console.log('\nC. Both dashboards keep the Date Range controls');
  await check('manager dashboard page has 7d/30d/90d buttons and loads manager-dashboard.js', async () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(
      path.join(__dirname, '..', '..', 'Frontend', 'src', 'pages', 'manager', 'dashboard.html'),
      'utf8'
    );
    for (const range of ['7', '30', '90']) {
      assert.ok(
        new RegExp(`data-days="${range}"`).test(html),
        `manager/dashboard.html has a button[data-days="${range}"] button`
      );
    }
    assert.ok(/manager-dashboard\.js/.test(html), 'manager/dashboard.html loads manager-dashboard.js');
  });

  await check('system admin page has 7d/30d/90d buttons and loads dashboard.js', async () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(
      path.join(__dirname, '..', '..', 'Frontend', 'src', 'pages', 'admin', 'dashboard.html'),
      'utf8'
    );
    for (const range of ['7d', '30d', '90d']) {
      assert.ok(
        new RegExp(`date-range-btn[^>]*data-range="${range}"|data-range="${range}"[^>]*date-range-btn`).test(html),
        `dashboard.html has a .date-range-btn[data-range="${range}"] button`
      );
    }
    assert.ok(/dashboard\.js/.test(html), 'dashboard.html loads dashboard.js');
  });

  await chain;

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log('Failed: ' + failures.join(', '));

  httpServer.close();
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
