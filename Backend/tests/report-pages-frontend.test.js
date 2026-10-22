/**
 * The two report pages, driven as the browser drives them.
 *
 * WHY this test exists:
 *
 *   The operational page (Reports & Analytics) and the financial page
 *   (Revenue / System Analytics) must work INDEPENDENTLY: their own tabs,
 *   their own period filter, their own Refresh button and their own
 *   Export CSV button. When they shared one file they also shared one
 *   handler, so a change to one silently changed the other.
 *
 * This test loads the REAL driver scripts (admin-reports.js / admin-revenue.js)
 * against a minimal DOM - the same technique as tests/admin-dashboard-date-range.test.js -
 * with the network layer stubbed, and asserts:
 *   - each page calls its OWN endpoints;
 *   - the tabs switch the sections of that page only;
 *   - the period filter of one page does not drive the other;
 *   - Refresh reloads the active tab of that page;
 *   - Export CSV downloads that page's report.
 *
 * Run: node tests/report-pages-frontend.test.js
 */
process.env.NODE_ENV = 'test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPORTS_SCRIPT = path.join(__dirname, '..', '..', 'Frontend', 'src', 'js', 'admin-reports.js');
const REVENUE_SCRIPT = path.join(__dirname, '..', '..', 'Frontend', 'src', 'js', 'admin-revenue.js');
const TAX_SCRIPT = path.join(__dirname, '..', '..', 'Frontend', 'src', 'js', 'admin-tax.js');
const PERIOD_SCRIPT = path.join(__dirname, '..', '..', 'Frontend', 'src', 'js', 'utils', 'report-period.js');

let passed = 0;
const failures = [];
let chain = Promise.resolve();
function check(name, fn) {
  chain = chain.then(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok  ${name}`);
    } catch (e) {
      failures.push(name);
      console.log(`  FAIL ${name}`);
      console.log(`       ${e.message}`);
    }
  });
  return chain;
}

/* ------------------------------------------------------------------ */
/* Minimal DOM                                                         */
/* ------------------------------------------------------------------ */
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
    this.children = [];
    const classes = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    };
  }
  set innerHTML(html) {
    this._html = String(html);
  }
  get innerHTML() {
    return this._html;
  }
  set textContent(v) {
    this._html = String(v);
  }
  get textContent() {
    return this._html;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener() {}
  setAttribute(name, v) {
    this.attrs[name] = String(v);
  }
  getAttribute(name) {
    return this.attrs[name] !== undefined ? this.attrs[name] : null;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  getContext() {
    return {};
  }
  focus() {}
  dispatch(type, event) {
    const ev = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {} }, event);
    for (const fn of (this.listeners[type] || []).slice()) fn(ev);
    return ev;
  }
  click() {
    this.dispatch('click');
  }
}

/**
 * Build a page: an element registry, the tab buttons and a stubbed AdminAPI.
 */
function buildPage({ ids, tabs, getImpl, role, hash }) {
  const registry = new Map();
  const gets = [];
  const downloads = [];
  const domReady = [];

  for (const id of ids) {
    registry.set(id, new El(id, id.toLowerCase().includes('chart') ? 'canvas' : 'div'));
  }

  const tabButtons = tabs.map((tab) => {
    const b = new El('', 'button');
    b.setAttribute('data-report-tab', tab);
    b.className = 'report-tab-btn';
    return b;
  });

  const cafeteriaOnly = tabButtons.filter((b) => ['sales', 'refunds', 'menu', 'inventory'].includes(b.getAttribute('data-report-tab')));

  const body = new El('body', 'body');
  body.appendChild = (node) => {
    downloads.push(node.download);
    node.click();
  };
  body.removeChild = () => {};

  const documentStub = {
    readyState: 'complete',
    getElementById: (id) => registry.get(id) || null,
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel === '#reportTabs .report-tab-btn' || sel === '#financeTabs .report-tab-btn') return tabButtons.slice();
      if (sel === '#reportTabs .cafeteria-only') return cafeteriaOnly.slice();
      if (sel === '#finTrendGranularity [data-granularity]') return [];
      return [];
    },
    addEventListener: (type, fn) => {
      if (type === 'DOMContentLoaded') domReady.push(fn);
    },
    createElement: (t) => new El('', t),
    head: new El('head', 'head'),
    body,
  };

  const localStorageStub = {
    _m: { userRole: role, role },
    getItem(k) {
      return this._m[k] !== undefined ? this._m[k] : null;
    },
    setItem(k, v) {
      this._m[k] = String(v);
    },
    removeItem(k) {
      delete this._m[k];
    },
  };

  const esc = (v) =>
    String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const windowStub = {
    location: { pathname: '/src/pages/admin/reports.html', hash: hash || '', href: '', search: '' },
    addEventListener() {},
    removeEventListener() {},
    esc,
    AdminToast: { show() {}, success() {}, error() {}, warning() {}, info() {} },
    AdminAPI: {
      esc,
      formatDateTime: (v) => (v ? String(v) : '—'),
      formatDate: (v) => (v ? String(v) : '—'),
      get(p, query) {
        gets.push({ path: p, query: query || {} });
        return Promise.resolve().then(() => getImpl(p, query || {}));
      },
    },
  };

  return { registry, gets, downloads, domReady, tabButtons, window: windowStub, document: documentStub, localStorage: localStorageStub };
}

function loadScript(src, page) {
  const code = fs.readFileSync(src, 'utf8');
  const factory = new Function(
    'window',
    'document',
    'localStorage',
    'Blob',
    'URL',
    'console',
    'Chart',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    code
  );
  factory(
    page.window,
    page.document,
    page.localStorage,
    Blob,
    URL,
    console,
    function ChartStub() {
      this.destroy = () => {};
    },
    setTimeout,
    clearTimeout,
    () => 0,
    () => {}
  );
  for (const fn of page.domReady.slice()) fn();
}

/* ------------------------------------------------------------------ */
/* Payloads                                                            */
/* ------------------------------------------------------------------ */
const OPERATIONAL_PAYLOAD = {
  success: true,
  report: {
    period: 'month',
    range: { startDate: '2026-10-01', endDate: '2026-10-22' },
    currency: 'ETB',
    orders: { total: 42, completed: 30, cancelled: 4, pending: 5, inProgress: 3 },
    payments: { total: 40, successful: 30, failed: 2, pending: 6, refunded: 2 },
    statusDistribution: [{ status: 'COMPLETED', count: 30, share: 71.43 }],
    orderTypes: [{ type: 'dine-in', label: 'Dine-in', orders: 20, revenue: 500, share: 47.62 }],
    mostOrderedFoods: [{ name: 'Shiro', category: 'Main Meals', totalQuantity: 60, orderCount: 40, totalRevenue: 1200 }],
    foodPopularity: [{ name: 'Shiro', category: 'Main Meals', totalQuantity: 60, orderCount: 40, revenue: 1200 }],
    trends: [{ date: '2026-10-22', orders: 5, completed: 3, cancelled: 0, pending: 2 }],
  },
};

const FINANCE_PAYLOAD = {
  success: true,
  report: {
    period: 'month',
    range: { startDate: '2026-10-01', endDate: '2026-10-22' },
    currency: 'ETB',
    tax: {
      vatEnabled: true,
      configuredVatRate: 12,
      taxAuthorityName: 'MoR',
      vatNumber: 'TIN-1',
      taxableSales: 892,
      vatCollected: 108,
      vatRefunded: 0,
      netVatRetained: 108,
      taxableTransactions: 2,
    },
    summary: {
      grossSales: 1000,
      foodSubtotal: 800,
      discounts: 0,
      serviceFees: 100,
      deliveryFees: 30,
      successfulCollections: 1000,
      successfulRefunds: 40,
      netCollectedRevenue: 960,
      averageOrderValue: 50,
      orderCount: 20,
      unpaidValue: 0,
    },
    payments: {
      total: 20,
      successful: { count: 19, amount: 1000 },
      refunded: { count: 1, amount: 40 },
      pending: { count: 0, amount: 0 },
      failed: { count: 0, amount: 0 },
      cancelled: { count: 0, amount: 0 },
      byMethod: [{ method: 'CHAPA', label: 'Chapa', count: 20, amount: 1040, share: 100 }],
    },
    reconciliation: {
      orderValue: 1000,
      componentTotal: 1000,
      componentDifference: 0,
      collections: 1000,
      collectionVariance: 0,
      unpaidValue: 0,
      successfulRefunds: 40,
      netCollectedRevenue: 960,
      expectedNet: 960,
      netDifference: 0,
      balanced: true,
    },
    comparison: {
      period: 'previous-month',
      range: { startDate: '2026-09-01', endDate: '2026-09-22' },
      grossSales: 900,
      collections: 900,
      successfulRefunds: 0,
      netCollectedRevenue: 900,
      orderCount: 18,
      averageOrderValue: 50,
      change: { grossSales: 11.11, collections: 11.11, netCollectedRevenue: 6.67, orderCount: 11.11, averageOrderValue: 0 },
    },
    trends: {
      daily: [{ date: '2026-10-22', label: '2026-10-22', orders: 5, grossSales: 200, collections: 200, refunds: 0, vat: 20 }],
      weekly: [],
      monthly: [],
    },
    revenueByFoodItem: [{ name: 'Shiro', category: 'Main Meals', quantity: 10, revenue: 400 }],
    revenueByOrderType: [{ type: 'dine-in', label: 'Dine-in', orders: 20, revenue: 1000, share: 100 }],
  },
};

const TAX_PAYLOAD = {
  success: true,
  report: {
    period: 'month',
    range: { startDate: '2026-10-01', endDate: '2026-10-22' },
    currency: 'ETB',
    tax: { vatEnabled: true, configuredVatRate: 12, taxAuthorityName: 'MoR', vatNumber: 'TIN-1' },
    transactionCount: 2,
    taxableSales: 892,
    vatCollected: 108,
    vatRefunded: 0,
    netVatRetained: 108,
    vatInclusiveOrders: 2,
    vatExemptOrders: 0,
    monthlyBreakdown: [
      { month: '2026-10', taxableSales: 892, vatCollected: 108, vatRefunded: 0, netVatRetained: 108, transactions: 2 },
    ],
    trends: {
      daily: [
        {
          date: '2026-10-22',
          label: '2026-10-22',
          taxableSales: 892,
          vatCollected: 108,
          vatRefunded: 0,
          transactions: 2,
        },
      ],
      weekly: [],
      monthly: [],
    },
    transactions: [
      {
        orderId: 'ET-1',
        orderRef: 'x',
        date: '2026-10-20',
        orderType: 'dine-in',
        gross: 54,
        foodSubtotal: 40,
        serviceFee: 20,
        deliveryFee: 0,
        taxableBase: 60,
        vatRate: 12,
        vatAmount: 7.2,
        vatRefunded: 0,
        netVat: 7.2,
        paymentStatus: 'PAID',
        refundStatus: 'NONE',
        refundedAmount: 0,
        refundedAt: null,
      },
    ],
    transactionsTruncated: false,
    totalTransactions: 2,
  },
};

const REPORTS_IDS = [
  'reportContent',
  'reportScopeName',
  'reportPeriodSelect',
  'reportStartDate',
  'reportEndDate',
  'reportApplyBtn',
  'reportUpdatedAt',
  'refreshReportsBtn',
  'exportCsvBtn',
  'opTotalOrders',
  'opCompletedOrders',
  'opCancelledOrders',
  'opPendingOrders',
  'opInProgressOrders',
  'opSuccessfulPayments',
  'opFailedPayments',
  'opPendingPayments',
  'opRefundedPayments',
  'opStatusBody',
  'opOrderTypesBody',
  'opMostFoodsBody',
  'opFoodPopularityBody',
  'opStatusChart',
  'opStatusChartEmpty',
  'opTrendsChart',
  'opTrendsChartEmpty',
  'cfOrderStatus',
  'cfOrderPaymentStatus',
  'cfPayStatus',
  'cfPayMethod',
  'cfRefStatus',
  'cfMenuCategory',
  'cfOrdersBody',
  'cfOrdersPager',
  'cfPaymentsBody',
  'cfPaymentsPager',
  'cfRefundsBody',
  'cfRefundsPager',
  'cfSalesMethodBody',
  'cfMenuMostBody',
  'cfMenuLeastBody',
  'cfMenuCatsBody',
  'cfInvBody',
  'cfTotalSales',
  'cfTodaySales',
  'cfWeekSales',
  'cfMonthSales',
  'cfAvgOrder',
  'cfCompletedOrders',
  'cfPaidRevenue',
  'cfPayPaidAmount',
  'cfRefAmount',
  'cfMenuTotal',
  'cfMenuQty',
  'cfMenuRevenue',
  'cfInvTotalItems',
  'cfInvTotalValue',
];

const REVENUE_IDS = [
  'financeUpdatedAt',
  'finPeriodSelect',
  'finStartDate',
  'finEndDate',
  'finApplyBtn',
  'refreshRevenueBtn',
  'exportRevenueBtn',
  'finGrossSales',
  'finFoodSubtotal',
  'finDiscounts',
  'finVatRate',
  'finVatCollected',
  'finNetVatRetained',
  'finServiceFees',
  'finDeliveryFees',
  'finCollections',
  'finRefunds',
  'finNetCollected',
  'finAvgOrder',
  'finReconciliationBody',
  'finCurrentGross',
  'finPreviousGross',
  'finGrossChange',
  'finNetChange',
  'finTrendChart',
  'finTrendChartEmpty',
  'finFoodRevenueBody',
  'finOrderTypeRevenueBody',
  'finPaymentMethodsBody',
  'finPaySuccessful',
  'finPayPending',
  'finPayFailed',
  'finPayRefunded',
  'reconciliationStatus',
];

const TAX_IDS = [
  'taxUpdatedAt',
  'taxPeriodSelect',
  'taxStartDate',
  'taxEndDate',
  'taxApplyBtn',
  'refreshTaxBtn',
  'exportTaxBtn',
  'exportTaxCsvBtn',
  'taxConfiguredRate',
  'taxTaxableSales',
  'taxVatCollected',
  'taxVatRefunded',
  'taxNetVatRetained',
  'taxTransactionCount',
  'taxTrendChart',
  'taxTrendChartEmpty',
  'taxMonthlyBody',
  'taxTransactionsBody',
  'taxTransactionsNote',
  'taxAuthorityName',
];

const REPORT_TABS = ['summary', 'orders', 'payments', 'sales', 'refunds', 'menu', 'inventory'];
const FINANCE_TABS = ['financial', 'analytics'];

function reportsGet(p) {
  if (p === '/admin/reports/summary') return OPERATIONAL_PAYLOAD;
  if (p === '/cafeteria/reports/summary') return OPERATIONAL_PAYLOAD;
  if (p === '/cafeteria/reports/orders') {
    return { success: true, report: { range: { startDate: '2026-10-01', endDate: '2026-10-22' }, period: 'month', counts: { total: 0 }, orders: [], pagination: { page: 1, pages: 1, total: 0 } } };
  }
  if (p === '/cafeteria/reports/payments') {
    return { success: true, report: { range: { startDate: '2026-10-01', endDate: '2026-10-22' }, period: 'month', counts: { total: 0 }, paymentMethods: [], transactions: [], pagination: { page: 1, pages: 1, total: 0 } } };
  }
  if (p === '/cafeteria/reports/sales') {
    return { success: true, report: { range: { startDate: '2026-10-01', endDate: '2026-10-22' }, period: 'month', salesByDate: [], salesByPaymentMethod: [] } };
  }
  if (p === '/cafeteria/reports/refunds') {
    return { success: true, report: { range: { startDate: '2026-10-01', endDate: '2026-10-22' }, period: 'month', counts: { total: 0 }, refunds: [], pagination: { page: 1, pages: 1, total: 0 } } };
  }
  if (p === '/cafeteria/reports/menu-performance') {
    return { success: true, report: { range: { startDate: '2026-10-01', endDate: '2026-10-22' }, period: 'month', summary: {}, mostOrdered: [], leastOrdered: [], bestCategories: [], items: [] } };
  }
  if (p === '/cafeteria/reports/inventory') {
    return { success: true, report: { summary: {}, items: [] } };
  }
  if (p === '/cafeterias/mine') return { success: true, cafeteria: { name: 'Test Cafeteria' } };
  throw new Error('unexpected GET ' + p);
}

function revenueGet(p) {
  if (p === '/reports/finance') return FINANCE_PAYLOAD;
  if (p === '/reports/tax') return TAX_PAYLOAD;
  throw new Error('unexpected GET ' + p);
}

(async () => {
  /* ================================================================== */
  console.log('\nA. Reports & Analytics (operational page)');
  /* ================================================================== */

  let reports;
  await check('the operational page loads the operational endpoint and renders the metrics', async () => {
    reports = buildPage({
      ids: REPORT_TABS.map((t) => 'reportView-' + t).concat(REPORTS_IDS),
      tabs: REPORT_TABS,
      role: 'admin',
      getImpl: reportsGet,
    });
    loadScript(PERIOD_SCRIPT, reports);
    loadScript(REPORTS_SCRIPT, reports);
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(reports.gets.length >= 1, 'a request was made');
    assert.strictEqual(reports.gets[0].path, '/admin/reports/summary', 'the operational endpoint');
    assert.strictEqual(reports.gets[0].query.period, 'month', 'the period is sent');
    assert.strictEqual(reports.registry.get('opTotalOrders').textContent, '42');
    assert.strictEqual(reports.registry.get('opCompletedOrders').textContent, '30');
    assert.strictEqual(reports.registry.get('opPendingOrders').textContent, '5');
    assert.strictEqual(reports.registry.get('opSuccessfulPayments').textContent, '30');
    assert.strictEqual(reports.registry.get('opFailedPayments').textContent, '2');
  });

  await check('the operational page never calls the financial endpoints', async () => {
    const paths = reports.gets.map((g) => g.path);
    assert.strictEqual(paths.includes('/reports/finance'), false);
    assert.strictEqual(paths.includes('/reports/tax'), false);
  });

  await check('the operational page renders the resolved period', async () => {
    const text = reports.registry.get('reportUpdatedAt').textContent;
    assert.ok(/2026/.test(text), `the range is shown, got "${text}"`);
  });

  await check('switching tabs on the operational page calls that tab endpoint', async () => {
    reports.gets.length = 0;
    const ordersTab = reports.tabButtons.find((b) => b.getAttribute('data-report-tab') === 'orders');
    ordersTab.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(reports.gets.length, 1);
    assert.strictEqual(reports.gets[0].path, '/cafeteria/reports/orders');
  });

  await check('the Refresh button reloads the active tab only', async () => {
    reports.gets.length = 0;
    reports.registry.get('refreshReportsBtn').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(reports.gets.length, 1);
    assert.strictEqual(reports.gets[0].path, '/cafeteria/reports/orders', 'the active tab');
  });

  await check('the operational Export CSV button exports the active tab of this page', async () => {
    // Back to the operational summary tab first.
    const summaryTab = reports.tabButtons.find((b) => b.getAttribute('data-report-tab') === 'summary');
    summaryTab.click();
    await new Promise((r) => setTimeout(r, 30));

    reports.downloads.length = 0;
    reports.registry.get('exportCsvBtn').click();
    assert.strictEqual(reports.downloads.length, 1, 'a file was downloaded');
    assert.ok(/^reports-operational-summary-/.test(reports.downloads[0]), reports.downloads[0]);
  });

  await check('the operational period filter drives the request', async () => {
    reports.gets.length = 0;
    const select = reports.registry.get('reportPeriodSelect');
    select.value = 'last7';
    select.dispatch('change');
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(reports.gets[0].query.period, 'last7');
  });

  await check('a custom range sends both dates', async () => {
    reports.gets.length = 0;
    const select = reports.registry.get('reportPeriodSelect');
    select.value = 'custom';
    select.dispatch('change');
    await new Promise((r) => setTimeout(r, 30));
    reports.gets.length = 0;
    reports.registry.get('reportStartDate').value = '2026-09-30';
    reports.registry.get('reportEndDate').value = '2026-10-30';
    reports.registry.get('reportApplyBtn').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(reports.gets[0].query.startDate, '2026-09-30');
    assert.strictEqual(reports.gets[0].query.endDate, '2026-10-30');
  });

  await check('the cafeteria-only tabs are hidden from a system admin', async () => {
    const hidden = reports.tabButtons
      .filter((b) => ['sales', 'refunds', 'menu', 'inventory'].includes(b.getAttribute('data-report-tab')))
      .every((b) => b.classList.contains('d-none'));
    assert.strictEqual(hidden, true, 'the cafeteria tabs are hidden');
  });

  await check('a manager gets the cafeteria endpoint and the cafeteria tabs', async () => {
    const managerPage = buildPage({
      ids: REPORT_TABS.map((t) => 'reportView-' + t).concat(REPORTS_IDS),
      tabs: REPORT_TABS,
      role: 'manager',
      getImpl: reportsGet,
    });
    loadScript(PERIOD_SCRIPT, managerPage);
    loadScript(REPORTS_SCRIPT, managerPage);
    await new Promise((r) => setTimeout(r, 30));
    const paths = managerPage.gets.map((g) => g.path);
    assert.ok(paths.includes('/cafeteria/reports/summary'), `got ${paths.join(', ')}`);
    assert.strictEqual(paths.includes('/admin/reports/summary'), false, 'a manager never uses the global endpoint');
    const hidden = managerPage.tabButtons
      .filter((b) => ['sales', 'refunds', 'menu', 'inventory'].includes(b.getAttribute('data-report-tab')))
      .every((b) => b.classList.contains('d-none'));
    assert.strictEqual(hidden, false, 'the cafeteria tabs are visible for a manager');
  });

  /* ================================================================== */
  console.log('\nB. Revenue / System Analytics (financial page)');
  /* ================================================================== */

  let revenue;
  await check('the financial page loads the financial endpoint and renders the cards', async () => {
    revenue = buildPage({
      ids: FINANCE_TABS.map((t) => 'financeView-' + t).concat(REVENUE_IDS),
      tabs: FINANCE_TABS,
      role: 'admin',
      getImpl: revenueGet,
    });
    loadScript(PERIOD_SCRIPT, revenue);
    loadScript(REVENUE_SCRIPT, revenue);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(revenue.gets[0].path, '/reports/finance');
    assert.ok(/1,000\.00/.test(revenue.registry.get('finGrossSales').textContent), revenue.registry.get('finGrossSales').textContent);
    assert.ok(/960\.00/.test(revenue.registry.get('finNetCollected').textContent));
    assert.ok(/40\.00/.test(revenue.registry.get('finRefunds').textContent));
  });

  await check('the financial page never calls the operational or the tax endpoint', async () => {
    const paths = revenue.gets.map((g) => g.path);
    assert.strictEqual(paths.includes('/admin/reports/summary'), false);
    assert.strictEqual(paths.includes('/cafeteria/reports/summary'), false);
    assert.strictEqual(paths.includes('/reports/tax'), false, 'the tax report has its own page');
  });

  await check('the financial page shows the short VAT pointer of the tax report', async () => {
    assert.strictEqual(revenue.registry.get('finVatRate').textContent, '12%');
    assert.ok(/108\.00/.test(revenue.registry.get('finVatCollected').textContent));
    assert.ok(/108\.00/.test(revenue.registry.get('finNetVatRetained').textContent));
  });

  await check('the financial Export CSV button exports the active tab of this page', async () => {
    // Back to the financial summary tab first.
    const financialTab = revenue.tabButtons.find((b) => b.getAttribute('data-report-tab') === 'financial');
    financialTab.click();
    await new Promise((r) => setTimeout(r, 30));

    revenue.downloads.length = 0;
    revenue.registry.get('exportRevenueBtn').click();
    assert.strictEqual(revenue.downloads.length, 1);
    assert.ok(/^smart-cafeteria-financial-report-/.test(revenue.downloads[0]), revenue.downloads[0]);
  });

  await check('the financial period filter is independent of the operational one', async () => {
    revenue.gets.length = 0;
    const select = revenue.registry.get('finPeriodSelect');
    select.value = 'yesterday';
    select.dispatch('change');
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(revenue.gets[0].query.period, 'yesterday');
    // The operational page keeps its own selection.
    assert.strictEqual(reports.registry.get('reportPeriodSelect').value, 'custom');
  });

  await check('the financial Refresh button reloads the financial report only', async () => {
    revenue.gets.length = 0;
    revenue.registry.get('refreshRevenueBtn').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(revenue.gets.length, 1);
    assert.strictEqual(revenue.gets[0].path, '/reports/finance', 'the active tab of THIS page');
    assert.strictEqual(
      reports.gets.some((g) => g.path.startsWith('/reports/')),
      false,
      'the operational page was not reloaded'
    );
  });

  /* ================================================================== */
  console.log('\nC. Tax/VAT (tax compliance page)');
  /* ================================================================== */

  let taxPage;
  await check('the tax page loads the tax endpoint and renders the tax metrics', async () => {
    taxPage = buildPage({
      ids: TAX_IDS,
      tabs: [],
      role: 'admin',
      getImpl: revenueGet,
    });
    loadScript(PERIOD_SCRIPT, taxPage);
    loadScript(TAX_SCRIPT, taxPage);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(taxPage.gets[0].path, '/reports/tax');
    assert.strictEqual(taxPage.registry.get('taxConfiguredRate').textContent, '12%');
    assert.ok(/892\.00/.test(taxPage.registry.get('taxTaxableSales').textContent));
    assert.ok(/108\.00/.test(taxPage.registry.get('taxVatCollected').textContent));
    assert.ok(/108\.00/.test(taxPage.registry.get('taxNetVatRetained').textContent));
    assert.strictEqual(taxPage.registry.get('taxTransactionCount').textContent, '2');
  });

  await check('the tax page never calls the financial or operational endpoints', async () => {
    const paths = taxPage.gets.map((g) => g.path);
    assert.strictEqual(paths.includes('/reports/finance'), false);
    assert.strictEqual(paths.includes('/admin/reports/summary'), false);
    assert.strictEqual(paths.includes('/cafeteria/reports/summary'), false);
  });

  await check('the tax page has its own period filter', async () => {
    taxPage.gets.length = 0;
    const select = taxPage.registry.get('taxPeriodSelect');
    select.value = 'last7';
    select.dispatch('change');
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(taxPage.gets[0].query.period, 'last7');
    // The other pages keep their own selection.
    assert.strictEqual(revenue.registry.get('finPeriodSelect').value, 'yesterday');
    assert.strictEqual(reports.registry.get('reportPeriodSelect').value, 'custom');
  });

  await check('the tax Refresh button reloads the tax report only', async () => {
    taxPage.gets.length = 0;
    revenue.gets.length = 0;
    taxPage.registry.get('refreshTaxBtn').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(taxPage.gets.length, 1);
    assert.strictEqual(taxPage.gets[0].path, '/reports/tax');
    assert.strictEqual(revenue.gets.length, 0, 'the financial page was not reloaded');
  });

  await check('the tax Export CSV button exports the tax report', async () => {
    taxPage.downloads.length = 0;
    taxPage.registry.get('exportTaxBtn').click();
    assert.strictEqual(taxPage.downloads.length, 1);
    assert.ok(/^smart-cafeteria-tax-report-/.test(taxPage.downloads[0]), taxPage.downloads[0]);
  });

  await check('the tax report table carries the transaction detail', async () => {
    const body = taxPage.registry.get('taxTransactionsBody').innerHTML;
    assert.ok(/ET-1/.test(body), 'the order is listed');
    assert.ok(/60\.00/.test(body), 'the taxable amount is shown');
    assert.ok(/12%/.test(body), 'the applied VAT rate is shown');
    assert.ok(/7\.20/.test(body), 'the VAT amount is shown');
    assert.ok(/PAID/.test(body), 'the payment status is shown');
  });

  await chain;

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log('Failed: ' + failures.join(', '));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
