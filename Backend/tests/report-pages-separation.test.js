/**
 * Reports & Analytics  vs  Revenue / System Analytics
 *
 * WHY this test exists:
 *
 *   Both dashboard pages used to be the SAME file (pages/admin/reports.html)
 *   with the financial content behind a hash, so "Reports" and
 *   "Revenue / System Analytics" rendered the same report. The financial
 *   numbers were also wrong in two ways:
 *
 *     1. the VAT rate was hard-coded to 15% instead of the CONFIGURED rate;
 *     2. refunds were not subtracted from the money that was collected.
 *
 * This test drives the real backend (Express + MongoDB) over HTTP and asserts:
 *   - the operational endpoint returns operational metrics and NO financial
 *     summary;
 *   - the financial endpoint returns the financial metrics and reconciles
 *     exactly with the stored Payment / Refund records;
 *   - only PROCESSED refunds are counted as money returned;
 *   - the VAT figures use the configured tax rate;
 *   - the two frontend pages are separate files with their own content,
 *     navigation entries and buttons.
 *
 * Run: node tests/report-pages-separation.test.js
 */
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scs_report_pages';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'report-pages-secret';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');

const PORT = 5112;
const API = `http://127.0.0.1:${PORT}/api/v1`;
const FRONTEND = path.join(__dirname, '..', '..', 'Frontend');

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

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const { app } = require('../server.js');
  const httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(PORT, r));

  const jwt = require('jsonwebtoken');
  const User = require('../src/models/User');
  const Order = require('../src/models/Order');
  const Payment = require('../src/models/Payment');
  const Refund = require('../src/models/Refund');
  const Cafeteria = require('../src/models/Cafeteria');
  const Setting = require('../src/models/Setting');

  /* ------------------------------------------------------------------ */
  /* Seed                                                                */
  /* ------------------------------------------------------------------ */
  const cafeteria = await Cafeteria.create({
    name: 'Report Test Cafeteria',
    code: 'RPT',
    isDefault: true,
    status: 'ACTIVE',
  });

  let phoneSeq = 0;
  const mkUser = (name, role, withCafeteria) =>
    User.create({
      name,
      email: `${name.toLowerCase().replace(/[^a-z]/g, '')}@report.test`,
      phone: '0966' + String(++phoneSeq).padStart(6, '0'),
      password: 'password123',
      role,
      cafeteriaId: withCafeteria ? cafeteria._id : null,
      status: 'ACTIVE',
    });

  const admin = await mkUser('ReportAdmin', 'admin', false);
  const manager = await mkUser('ReportManager', 'manager', true);
  const customer = await mkUser('ReportCustomer', 'customer', false);

  const tokenFor = (user) =>
    jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const adminTok = tokenFor(admin);
  const managerTok = tokenFor(manager);
  const customerTok = tokenFor(customer);

  const call = async (path, token) => {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // A configured VAT rate that is NOT the old hard-coded 15%.
  await Setting.create({ key: 'vat_rate', value: 12, type: 'number', group: 'tax', label: 'VAT Rate' });
  await Setting.create({ key: 'vat_enabled', value: true, type: 'boolean', group: 'tax', label: 'VAT' });
  await Setting.create({ key: 'service_fee', value: 20, type: 'number', group: 'payments', label: 'Service fee' });

  const today = new Date();
  const todayAt = (hour) => {
    const d = new Date();
    d.setHours(hour, 30, 0, 0);
    return d;
  };

  let orderSeq = 0;
  const mkOrder = async (opts) => {
    const order = new Order({
      orderId: 'ET-RPT-' + String(++orderSeq).padStart(3, '0'),
      userId: customer._id,
      cafeteriaId: cafeteria._id,
      customerName: 'Report Customer',
      customerPhone: '0911000000',
      orderType: opts.orderType || 'dine-in',
      orderStatus: opts.orderStatus,
      status: opts.orderStatus.toLowerCase(),
      paymentMethod: opts.paymentMethod,
      paymentStatus: opts.paymentStatus,
      subtotal: opts.subtotal,
      serviceFee: opts.serviceFee === undefined ? 20 : opts.serviceFee,
      deliveryFee: opts.deliveryFee || 0,
      vatEnabled: true,
      vatRate: opts.vatRate === undefined ? 12 : opts.vatRate,
      vatAmount: opts.vatAmount || 0,
      totalAmount: opts.totalAmount,
      items: opts.items || [],
    });
    order.createdAt = opts.createdAt || todayAt(9);
    await order.save({ validateBeforeSave: false });
    return order;
  };

  const mkPayment = async (order, amount, method, status, when) => {
    const payment = new Payment({
      orderId: order._id,
      userId: customer._id,
      cafeteriaId: cafeteria._id,
      amount,
      method,
      provider: method,
      status,
      currency: 'ETB',
      paymentDate: when || todayAt(10),
    });
    payment.createdAt = when || todayAt(10);
    await payment.save({ validateBeforeSave: false });
    return payment;
  };

  // A: legacy order WITHOUT a stored VAT amount -> the configured rate applies.
  const orderA = await mkOrder({
    orderStatus: 'COMPLETED',
    paymentMethod: 'CHAPA',
    paymentStatus: 'PAID',
    subtotal: 100,
    totalAmount: 134.4,
    vatRate: 0,
    vatAmount: 0,
    items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Shiro', quantity: 2, price: 50, subtotal: 100 }],
  });
  const paymentA = await mkPayment(orderA, 134.4, 'CHAPA', 'PAID');

  // B: takeaway paid in cash.
  const orderB = await mkOrder({
    orderType: 'takeaway',
    orderStatus: 'COMPLETED',
    paymentMethod: 'CASH',
    paymentStatus: 'PAID',
    subtotal: 50,
    totalAmount: 78.4,
    vatAmount: 8.4,
    items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Shiro', quantity: 1, price: 50, subtotal: 50 }],
  });
  await mkPayment(orderB, 78.4, 'CASH', 'PAID');

  // C: delivery order whose payment is still pending.
  const orderC = await mkOrder({
    orderType: 'delivery',
    orderStatus: 'PENDING',
    paymentMethod: 'CHAPA',
    paymentStatus: 'PENDING',
    subtotal: 200,
    deliveryFee: 30,
    totalAmount: 280,
    vatAmount: 30,
    items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Kitfo', quantity: 2, price: 100, subtotal: 200 }],
  });
  await mkPayment(orderC, 280, 'CHAPA', 'PENDING');

  // D: cancelled order - never revenue.
  const orderD = await mkOrder({
    orderStatus: 'CANCELLED',
    paymentMethod: 'CHAPA',
    paymentStatus: 'CANCELLED',
    subtotal: 500,
    totalAmount: 500,
    vatAmount: 60,
  });

  // E: paid and then refunded - the money came in and went back out.
  const orderE = await mkOrder({
    orderStatus: 'COMPLETED',
    paymentMethod: 'CHAPA',
    paymentStatus: 'REFUNDED',
    subtotal: 40,
    totalAmount: 67.2,
    vatAmount: 7.2,
  });
  await mkPayment(orderE, 67.2, 'CHAPA', 'REFUNDED');
  const refundE = await Refund.create({
    orderId: orderE._id,
    paymentId: null,
    cafeteriaId: cafeteria._id,
    amount: 40,
    reason: 'Food was cold',
    requestedBy: manager._id,
    status: 'REFUNDED',
    refundedAt: todayAt(11),
  });

  // F: paid, but the refund was only REQUESTED - the money is still there.
  const orderF = await mkOrder({
    orderStatus: 'COMPLETED',
    paymentMethod: 'TELEBIRR',
    paymentStatus: 'PAID',
    subtotal: 25,
    totalAmount: 50.4,
    vatAmount: 5.4,
  });
  await mkPayment(orderF, 50.4, 'TELEBIRR', 'PAID');
  const refundF = await Refund.create({
    orderId: orderF._id,
    paymentId: null,
    cafeteriaId: cafeteria._id,
    amount: 25,
    reason: 'Customer changed their mind',
    requestedBy: manager._id,
    status: 'REFUND_REQUESTED',
  });

  // A failed payment somewhere in the period.
  await mkPayment(orderD, 500, 'CHAPA', 'FAILED');

  /* ================================================================== */
  console.log('\nA. The operational report (Reports & Analytics)');
  /* ================================================================== */

  let operational;
  await check('GET /admin/reports/summary returns the operational report', async () => {
    const r = await call('/admin/reports/summary?period=month', adminTok);
    assert.strictEqual(r.status, 200, `status=${r.status}`);
    operational = r.body.report;
    assert.ok(operational, 'a report was returned');
  });

  await check('the operational report counts orders and payments', async () => {
    assert.strictEqual(operational.orders.total, 6, 'all six orders of the period');
    assert.strictEqual(operational.orders.completed, 4);
    assert.strictEqual(operational.orders.cancelled, 1);
    assert.strictEqual(operational.orders.pending, 1);
    assert.strictEqual(operational.payments.successful, 3);
    assert.strictEqual(operational.payments.pending, 1);
    assert.strictEqual(operational.payments.failed, 1);
    assert.strictEqual(operational.payments.refunded, 1);
  });

  await check('the operational report has the status distribution, order types and food popularity', async () => {
    assert.ok(Array.isArray(operational.statusDistribution) && operational.statusDistribution.length > 0);
    assert.ok(operational.statusDistribution.some((r) => r.status === 'CANCELLED' && r.count === 1));

    const types = operational.orderTypes.map((t) => t.type);
    assert.ok(types.includes('dine-in'), 'dine-in is reported');
    assert.ok(types.includes('takeaway'), 'takeaway is reported');
    assert.ok(types.includes('delivery'), 'delivery is reported');

    assert.ok(Array.isArray(operational.mostOrderedFoods) && operational.mostOrderedFoods.length > 0);
    assert.strictEqual(operational.mostOrderedFoods[0].name, 'Shiro', 'Shiro is the most ordered food');
    assert.strictEqual(operational.mostOrderedFoods[0].totalQuantity, 3, '2 + 1 portions of Shiro');
    assert.ok(Array.isArray(operational.foodPopularity) && operational.foodPopularity.length >= 2);
    assert.ok(Array.isArray(operational.trends) && operational.trends.length > 0, 'an order trend series');
  });

  await check('the operational report carries NO financial summary', async () => {
    assert.strictEqual(operational.revenue, undefined, 'no revenue card on the operational page');
    assert.strictEqual(operational.grossSales, undefined);
    assert.strictEqual(operational.summary, undefined);
    assert.strictEqual(operational.reconciliation, undefined);
    assert.strictEqual(operational.vatCollected, undefined);
  });

  await check('the operational period is the reporting-local month', async () => {
    const expected = new Date();
    const y = expected.getFullYear();
    const m = String(expected.getMonth() + 1).padStart(2, '0');
    assert.strictEqual(operational.range.startDate, `${y}-${m}-01`, 'starts on the 1st');
    assert.ok(operational.range.endDate <= `${y}-${m}-${String(expected.getDate()).padStart(2, '0')}`);
    assert.ok(!operational.range.startDate.endsWith('-30') && operational.range.startDate !== `${y}-${m}-30`);
  });

  await check('a customer cannot read the operational report', async () => {
    const r = await call('/admin/reports/summary?period=month', customerTok);
    assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
  });

  await check('a manager reads the operational report of their own cafeteria', async () => {
    const r = await call('/cafeteria/reports/summary?period=month', managerTok);
    assert.strictEqual(r.status, 200, `status=${r.status}`);
    assert.strictEqual(r.body.report.orders.total, 6, 'same cafeteria, same orders');
    assert.strictEqual(r.body.scope.global, false, 'the scope is the manager cafeteria');
  });

  await check('a system admin reads every cafeteria', async () => {
    const r = await call('/admin/reports/summary?period=month', adminTok);
    assert.strictEqual(r.body.scope.global, true, 'system admins see all cafeterias');
  });

  /* ================================================================== */
  console.log('\nB. The financial report (Revenue / System Analytics)');
  /* ================================================================== */

  let finance;
  await check('GET /reports/finance returns the financial report', async () => {
    const r = await call('/reports/finance?period=month', adminTok);
    assert.strictEqual(r.status, 200, `status=${r.status}`);
    finance = r.body.report;
    assert.ok(finance, 'a report was returned');
  });

  await check('the financial summary holds the financial metrics', async () => {
    const s = finance.summary;
    assert.strictEqual(s.grossSales, round2(134.4 + 78.4 + 280 + 67.2 + 50.4), 'gross sales exclude cancelled orders');
    assert.strictEqual(s.foodSubtotal, 415);
    assert.strictEqual(s.serviceFees, 100);
    assert.strictEqual(s.deliveryFees, 30);
    assert.strictEqual(s.successfulCollections, round2(134.4 + 78.4 + 50.4 + 67.2), 'collected money');
    assert.strictEqual(s.successfulRefunds, 40, 'only the PROCESSED refund counts');
    assert.strictEqual(s.netCollectedRevenue, round2(330.4 - 40), 'collections - refunds');
    assert.strictEqual(s.orderCount, 5);
    assert.strictEqual(s.averageOrderValue, round2(610.4 / 5));
    assert.strictEqual(typeof s.discounts, 'number', 'discounts are reported');
  });

  await check('the financial summary carries NO tax-only metric (the tax page owns it)', async () => {
    assert.strictEqual(finance.summary.vatCollected, undefined, 'VAT is not a financial summary card');
    assert.strictEqual(finance.summary.taxableSales, undefined);
    assert.strictEqual(finance.summary.netVatRetained, undefined);
  });

  await check('the financial report exposes a SHORT vat pointer (no transactions)', async () => {
    assert.ok(finance.tax, 'a vat block exists');
    assert.strictEqual(finance.tax.configuredVatRate, 12);
    assert.strictEqual(typeof finance.tax.vatCollected, 'number');
    assert.strictEqual(typeof finance.tax.netVatRetained, 'number');
    assert.strictEqual(finance.tax.transactions, undefined, 'the transaction table is not duplicated');
  });

  await check('the financial totals reconcile with the payment and refund records', async () => {
    const rec = finance.reconciliation;
    assert.strictEqual(rec.orderValue, 610.4);
    assert.strictEqual(rec.componentTotal, 610.4, 'food + fees + VAT = gross');
    assert.strictEqual(rec.componentDifference, 0);
    assert.strictEqual(rec.collections, 330.4);
    assert.strictEqual(rec.unpaidValue, 280, 'the pending order was never collected');
    assert.strictEqual(rec.successfulRefunds, 40);
    assert.strictEqual(rec.netCollectedRevenue, 290.4);
    assert.strictEqual(rec.expectedNet, round2(610.4 - 280 - 40));
    assert.strictEqual(rec.netDifference, 0);
    assert.strictEqual(rec.balanced, true, 'the report reconciles');
  });

  await check('a refund that was only REQUESTED is not counted as money returned', async () => {
    const stored = await Refund.findById(refundF._id).lean();
    assert.strictEqual(stored.status, 'REFUND_REQUESTED');
    assert.ok(
      finance.summary.successfulRefunds < 40 + 25,
      'the requested refund is not part of the returned money'
    );
    assert.strictEqual(finance.summary.successfulRefunds, 40);
  });

  await check('the payment breakdown separates successful, pending, failed and refunded', async () => {
    const p = finance.payments;
    assert.strictEqual(p.successful.count, 3);
    assert.strictEqual(p.pending.count, 1);
    assert.strictEqual(p.failed.count, 1);
    assert.strictEqual(p.refunded.count, 1);
    const methods = p.byMethod.map((m) => m.method);
    assert.ok(methods.includes('CHAPA'), 'Chapa is broken out');
    assert.ok(methods.includes('CASH'), 'Cash is broken out');
    assert.ok(methods.includes('TELEBIRR'), 'Telebirr is broken out');
  });

  await check('revenue is reported per food item and per order type', async () => {
    assert.ok(finance.revenueByFoodItem.length >= 2);
    const shiro = finance.revenueByFoodItem.find((f) => f.name === 'Shiro');
    assert.ok(shiro, 'Shiro is listed');
    assert.strictEqual(shiro.quantity, 3, '2 + 1 portions of Shiro');
    assert.strictEqual(shiro.revenue, 150, '100 + 50');
    assert.ok(finance.revenueByOrderType.length >= 3);
    const types = finance.revenueByOrderType.map((t) => t.type);
    assert.ok(types.includes('dine-in') && types.includes('takeaway') && types.includes('delivery'));
  });

  await check('the period is compared with the previous period', async () => {
    assert.ok(finance.comparison, 'a comparison block exists');
    assert.ok(typeof finance.comparison.change.grossSales === 'number');
    assert.ok(finance.comparison.range.startDate, 'the previous range is reported');
  });

  await check('revenue trends exist for day, week and month', async () => {
    assert.ok(Array.isArray(finance.trends.daily) && finance.trends.daily.length > 0);
    assert.ok(Array.isArray(finance.trends.weekly) && finance.trends.weekly.length > 0);
    assert.ok(Array.isArray(finance.trends.monthly) && finance.trends.monthly.length > 0);
  });

  await check('the financial report carries NO operational metrics', async () => {
    assert.strictEqual(finance.orders, undefined, 'no operational order cards');
    assert.strictEqual(finance.statusDistribution, undefined);
    assert.strictEqual(finance.mostOrderedFoods, undefined);
    assert.strictEqual(finance.foodPopularity, undefined);
    assert.strictEqual(finance.trends.daily[0].completed, undefined);
  });

  await check('a customer cannot read the financial report', async () => {
    const r = await call('/reports/finance?period=month', customerTok);
    assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
  });

  await check('a manager reads the financial report of their own cafeteria', async () => {
    const r = await call('/reports/finance?period=month', managerTok);
    assert.strictEqual(r.status, 200, `status=${r.status}`);
    assert.strictEqual(r.body.scope.global, false);
  });

  /* ================================================================== */
  console.log('\nC. The VAT / tax compliance report');
  /* ================================================================== */

  let tax;
  await check('GET /reports/tax returns the compliance report', async () => {
    const r = await call('/reports/tax?period=month', adminTok);
    assert.strictEqual(r.status, 200, `status=${r.status}`);
    tax = r.body.report;
    assert.ok(tax, 'a report was returned');
  });

  await check('the configured VAT rate is used (not a hard-coded 15%)', async () => {
    assert.strictEqual(tax.tax.configuredVatRate, 12, 'the rate comes from the settings');
    // Legacy order A stores no VAT at all: 120 base * 12% = 14.4
    assert.strictEqual(tax.vatCollected, round2(14.4 + 8.4 + 7.2 + 5.4), 'VAT from the configured rate');
    assert.notStrictEqual(tax.vatCollected, round2(120 * 0.15 + 70 * 0.15 + 60 * 0.15 + 45 * 0.15));
  });

  await check('only collected sales are taxable', async () => {
    assert.strictEqual(tax.transactionCount, 4, 'the pending order is not a taxable sale');
    assert.strictEqual(tax.taxableSales, round2(120 + 70 + 60 + 45));
  });

  await check('the net VAT retained is the collected VAT minus the refunded VAT', async () => {
    assert.strictEqual(tax.vatRefunded, 0, 'a refund of the food subtotal carries no VAT');
    assert.strictEqual(tax.netVatRetained, tax.vatCollected - tax.vatRefunded);
  });

  await check('transaction-level VAT records are exported', async () => {
    assert.ok(Array.isArray(tax.transactions) && tax.transactions.length === 4);
    const row = tax.transactions.find((t) => t.orderId === orderA.orderId);
    assert.ok(row, 'the legacy order is listed');
    assert.strictEqual(row.vatRate, 12);
    assert.strictEqual(row.vatAmount, 14.4);
    assert.strictEqual(row.taxableBase, 120);
  });

  await check('a customer cannot read the tax report', async () => {
    const r = await call('/reports/tax?period=month', customerTok);
    assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
  });

  await check('the financial page and the Tax/VAT page report the SAME VAT figures', async () => {
    assert.strictEqual(finance.tax.vatCollected, tax.vatCollected, 'VAT collected agrees');
    assert.strictEqual(finance.tax.vatRefunded, tax.vatRefunded, 'VAT refunded agrees');
    assert.strictEqual(finance.tax.netVatRetained, tax.netVatRetained, 'net VAT retained agrees');
    assert.strictEqual(finance.tax.taxableSales, tax.taxableSales, 'taxable sales agree');
    assert.strictEqual(finance.tax.taxableTransactions, tax.transactionCount, 'the transaction count agrees');
    assert.strictEqual(finance.tax.configuredVatRate, tax.tax.configuredVatRate, 'the same rate');
  });

  await check('the tax report carries taxable sales and VAT trends', async () => {
    assert.ok(Array.isArray(tax.trends.daily) && tax.trends.daily.length > 0, 'a daily trend series');
    assert.ok(Array.isArray(tax.trends.weekly) && tax.trends.weekly.length > 0, 'a weekly trend series');
    assert.ok(Array.isArray(tax.trends.monthly) && tax.trends.monthly.length > 0, 'a monthly trend series');
    const day = tax.trends.daily.find((d) => d.transactions > 0);
    assert.ok(day, 'a day carries taxable sales');
    assert.ok(day.taxableSales > 0, 'taxable sales are bucketed');
    assert.ok(day.vatCollected > 0, 'VAT is bucketed');
  });

  /* ================================================================== */
  console.log('\nD. The three frontend pages');
  /* ================================================================== */

  const read = (p) => fs.readFileSync(path.join(FRONTEND, p), 'utf8');
  const reportsHtml = read('src/pages/admin/reports.html');
  const revenueHtml = read('src/pages/admin/revenue.html');
  const taxHtml = read('src/pages/admin/tax.html');
  const layoutJs = read('src/js/admin-layout.js');

  await check('the three pages are separate files', async () => {
    assert.ok(fs.existsSync(path.join(FRONTEND, 'src/pages/admin/reports.html')));
    assert.ok(fs.existsSync(path.join(FRONTEND, 'src/pages/admin/revenue.html')));
    assert.ok(fs.existsSync(path.join(FRONTEND, 'src/pages/admin/tax.html')));
    assert.notStrictEqual(reportsHtml, revenueHtml);
    assert.notStrictEqual(revenueHtml, taxHtml);
    assert.notStrictEqual(reportsHtml, taxHtml);
  });

  await check('the operational page renders operational metrics only', async () => {
    assert.ok(reportsHtml.includes('id="opTotalOrders"'), 'total orders');
    assert.ok(reportsHtml.includes('id="opCompletedOrders"'));
    assert.ok(reportsHtml.includes('id="opCancelledOrders"'));
    assert.ok(reportsHtml.includes('id="opPendingOrders"'));
    assert.ok(reportsHtml.includes('id="opSuccessfulPayments"'));
    assert.ok(reportsHtml.includes('id="opFailedPayments"'));
    assert.ok(reportsHtml.includes('id="opPendingPayments"'));
    assert.ok(reportsHtml.includes('id="opStatusBody"'), 'order status distribution');
    assert.ok(reportsHtml.includes('id="opOrderTypesBody"'), 'orders by type');
    assert.ok(reportsHtml.includes('id="opMostFoodsBody"'), 'most ordered foods');
    assert.ok(reportsHtml.includes('id="opFoodPopularityBody"'), 'food popularity');
    assert.ok(reportsHtml.includes('id="opTrendsChart"'), 'operational order trends');

    assert.strictEqual(reportsHtml.includes('id="finGrossSales"'), false, 'no financial cards');
    assert.strictEqual(reportsHtml.includes('id="finVatCollected"'), false);
    assert.strictEqual(reportsHtml.includes('id="taxVatCollected"'), false);
    assert.strictEqual(reportsHtml.includes('id="finReconciliationBody"'), false);
  });

  await check('the financial page renders financial metrics only', async () => {
    assert.ok(revenueHtml.includes('id="finGrossSales"'), 'gross sales');
    assert.ok(revenueHtml.includes('id="finFoodSubtotal"'));
    assert.ok(revenueHtml.includes('id="finDiscounts"'));
    assert.ok(revenueHtml.includes('id="finServiceFees"'));
    assert.ok(revenueHtml.includes('id="finDeliveryFees"'));
    assert.ok(revenueHtml.includes('id="finCollections"'));
    assert.ok(revenueHtml.includes('id="finRefunds"'));
    assert.ok(revenueHtml.includes('id="finNetCollected"'));
    assert.ok(revenueHtml.includes('id="finAvgOrder"'));
    assert.ok(revenueHtml.includes('id="finReconciliationBody"'), 'reconciliation');
    assert.ok(revenueHtml.includes('id="finPaymentMethodsBody"'), 'payment method breakdown');
    assert.ok(revenueHtml.includes('id="finFoodRevenueBody"'), 'revenue by food item');
    assert.ok(revenueHtml.includes('id="finOrderTypeRevenueBody"'), 'revenue by order type');
    assert.ok(revenueHtml.includes('id="finTrendChart"'), 'revenue trends');

    assert.strictEqual(revenueHtml.includes('id="opTotalOrders"'), false, 'no operational cards');
    assert.strictEqual(revenueHtml.includes('id="opMostFoodsBody"'), false, 'no most ordered foods');
    assert.strictEqual(revenueHtml.includes('id="opStatusBody"'), false);
    assert.strictEqual(revenueHtml.includes('id="opTrendsChart"'), false);
  });

  await check('the financial page does NOT carry the tax compliance interface', async () => {
    // No tax tab, no tax transaction table, no tax monthly breakdown.
    assert.strictEqual(revenueHtml.includes('id="financeView-tax"'), false, 'no tax section');
    assert.strictEqual(revenueHtml.includes('data-report-tab="tax"'), false, 'no tax tab');
    assert.strictEqual(revenueHtml.includes('id="taxTransactionsBody"'), false, 'no VAT transaction table');
    assert.strictEqual(revenueHtml.includes('id="taxMonthlyBody"'), false, 'no monthly VAT breakdown');
    assert.strictEqual(revenueHtml.includes('id="taxConfiguredRate"'), false);
    assert.strictEqual(revenueHtml.includes('id="taxTaxableSales"'), false);
    assert.strictEqual(revenueHtml.includes('id="taxVatRefunded"'), false);
    assert.strictEqual(revenueHtml.includes('id="taxNetVatRetained"'), false);
    assert.strictEqual(revenueHtml.includes('id="taxTransactionCount"'), false);
    // The only VAT on this page is the short pointer to the Tax/VAT page.
    assert.ok(revenueHtml.includes('id="finVatCollected"'), 'a short VAT pointer is allowed');
    assert.ok(revenueHtml.includes('href="tax.html"'), 'the pointer links to the Tax/VAT page');
  });

  await check('the Tax/VAT page renders tax metrics only', async () => {
    assert.ok(taxHtml.includes('id="taxConfiguredRate"'), 'configured VAT rate');
    assert.ok(taxHtml.includes('id="taxTaxableSales"'), 'taxable sales');
    assert.ok(taxHtml.includes('id="taxVatCollected"'), 'VAT collected');
    assert.ok(taxHtml.includes('id="taxVatRefunded"'), 'VAT refunded');
    assert.ok(taxHtml.includes('id="taxNetVatRetained"'), 'net VAT retained');
    assert.ok(taxHtml.includes('id="taxTransactionCount"'), 'taxable transactions');
    assert.ok(taxHtml.includes('id="taxTrendChart"'), 'taxable sales and VAT trends');
    assert.ok(taxHtml.includes('id="taxMonthlyBody"'), 'monthly VAT breakdown');
    assert.ok(taxHtml.includes('id="taxTransactionsBody"'), 'VAT transaction details');

    // No financial dashboard figures on the tax page.
    assert.strictEqual(taxHtml.includes('id="finGrossSales"'), false, 'no gross sales');
    assert.strictEqual(taxHtml.includes('id="finFoodSubtotal"'), false, 'no food subtotal');
    assert.strictEqual(taxHtml.includes('id="finServiceFees"'), false, 'no service fees');
    assert.strictEqual(taxHtml.includes('id="finDeliveryFees"'), false, 'no delivery fees');
    assert.strictEqual(taxHtml.includes('id="finCollections"'), false, 'no payment collections');
    assert.strictEqual(taxHtml.includes('id="finAvgOrder"'), false, 'no average order value');
    assert.strictEqual(taxHtml.includes('id="finNetCollected"'), false, 'no net collected revenue');
    assert.strictEqual(taxHtml.includes('id="finReconciliationBody"'), false, 'no reconciliation');
    assert.strictEqual(taxHtml.includes('id="opTotalOrders"'), false, 'no operational cards');
  });

  await check('the Tax/VAT page shows the transaction detail columns', async () => {
    assert.ok(taxHtml.includes('data-i18n="tax_col_taxable"'), 'taxable amount per transaction');
    assert.ok(taxHtml.includes('data-i18n="tax_col_vat_rate"'), 'applied VAT rate');
    assert.ok(taxHtml.includes('data-i18n="tax_col_vat"'), 'VAT amount');
    assert.ok(taxHtml.includes('data-i18n="tax_col_payment_status"'), 'payment status');
    assert.ok(taxHtml.includes('data-i18n="tax_col_refund_status"'), 'refund status');
  });

  await check('each page has its own title, description, filter, refresh and export', async () => {
    assert.ok(reportsHtml.includes('data-i18n="report_title"'));
    assert.ok(reportsHtml.includes('data-i18n="report_subtitle"'));
    assert.ok(reportsHtml.includes('id="reportPeriodSelect"'));
    assert.ok(reportsHtml.includes('id="reportApplyBtn"'));
    assert.ok(reportsHtml.includes('id="refreshReportsBtn"'));
    assert.ok(reportsHtml.includes('id="exportCsvBtn"'));

    assert.ok(revenueHtml.includes('data-i18n="revenue_page_title"'));
    assert.ok(revenueHtml.includes('data-i18n="revenue_page_subtitle"'));
    assert.ok(revenueHtml.includes('id="finPeriodSelect"'));
    assert.ok(revenueHtml.includes('id="finApplyBtn"'));
    assert.ok(revenueHtml.includes('id="refreshRevenueBtn"'));
    assert.ok(revenueHtml.includes('id="exportRevenueBtn"'));

    assert.ok(taxHtml.includes('data-i18n="tax_page_title"'));
    assert.ok(taxHtml.includes('data-i18n="tax_page_subtitle"'));
    assert.ok(taxHtml.includes('id="taxPeriodSelect"'));
    assert.ok(taxHtml.includes('id="taxApplyBtn"'));
    assert.ok(taxHtml.includes('id="refreshTaxBtn"'));
    assert.ok(taxHtml.includes('id="exportTaxBtn"'));
    assert.ok(taxHtml.includes('id="exportTaxCsvBtn"'), 'the tax report has its own export');

    // No report element id is shared between the pages (the shared layout
    // chrome - the sidebar container - is of course the same everywhere).
    const layoutChrome = ['adminSidebar', 'adminNavbar'];
    const idsOf = (html) =>
      (html.match(/id="([A-Za-z0-9_-]+)"/g) || [])
        .map((s) => s.slice(4, -1))
        .filter((id) => layoutChrome.indexOf(id) === -1);
    const overlap = idsOf(revenueHtml).filter((id) => idsOf(taxHtml).indexOf(id) !== -1);
    assert.deepStrictEqual(overlap, [], 'the financial and tax pages share no element id');
  });

  await check('the navigation opens a different page for every entry', async () => {
    assert.ok(
      /id: 'reports', path: 'reports\.html'/.test(layoutJs),
      'Reports & Analytics -> reports.html'
    );
    assert.ok(
      /id: 'revenue-report',[\s\S]{0,120}path: 'revenue\.html'/.test(layoutJs),
      'Revenue / System Analytics -> revenue.html'
    );
    assert.ok(
      /id: 'tax-report', path: 'tax\.html'/.test(layoutJs),
      'Tax / VAT -> tax.html'
    );
    assert.strictEqual(
      /id: 'tax-report', path: 'revenue\.html/.test(layoutJs),
      false,
      'the tax entry must not point at the financial page'
    );
    assert.strictEqual(
      /id: 'revenue-report',[\s\S]{0,120}path: 'reports\.html/.test(layoutJs),
      false,
      'the financial page must not point back at the operational page'
    );
  });

  await check('both entries are in the sidebar of a system admin', async () => {
    const groupBlock = /SYSTEM_ADMIN_GROUPS = \[([\s\S]*?)\n  \];/.exec(layoutJs);
    assert.ok(groupBlock, 'the system admin group was found');
    const block = groupBlock[1];
    assert.ok(/'reports'/.test(block), 'Reports & Analytics is listed');
    assert.ok(/'revenue-report'/.test(block), 'Revenue / System Analytics is listed');
    assert.ok(/'tax-report'/.test(block), 'Tax / VAT is listed');
  });

  await check('each page resolves to its own sidebar page id', async () => {
    assert.ok(
      /path === 'revenue'\) return 'revenue-report';/.test(layoutJs),
      "revenue.html is tracked as the 'revenue-report' page"
    );
    assert.ok(
      /path === 'tax'\) return 'tax-report';/.test(layoutJs),
      "tax.html is tracked as the 'tax-report' page"
    );
    assert.ok(
      /var role = \(localStorage\.getItem\('userRole'\)[\s\S]*?;/,
      'the page access check still reads the role'
    );
    const rolesJs = read('src/js/roles.js');
    assert.ok(
      /'revenue-report'/.test(rolesJs),
      'the revenue page is listed in the role page access map'
    );
  });

  await check('the pages load their own driver scripts', async () => {
    assert.ok(reportsHtml.includes('admin-reports.js'));
    assert.ok(reportsHtml.includes('utils/report-period.js'));
    assert.ok(revenueHtml.includes('admin-revenue.js'));
    assert.ok(revenueHtml.includes('utils/report-period.js'));
    assert.ok(taxHtml.includes('admin-tax.js'));
    assert.ok(taxHtml.includes('utils/report-period.js'));
    assert.strictEqual(reportsHtml.includes('admin-revenue.js'), false);
    assert.strictEqual(revenueHtml.includes('admin-reports.js'), false);
    assert.strictEqual(revenueHtml.includes('admin-tax.js'), false);
    assert.strictEqual(taxHtml.includes('admin-revenue.js'), false);
    assert.strictEqual(taxHtml.includes('admin-reports.js'), false);
  });

  await check('the tax page is allowed for the roles that may see tax data', async () => {
    const rolesJs = read('src/js/roles.js');
    assert.ok(/'tax-report'/.test(rolesJs), "'tax-report' is listed in the role page access map");
    assert.ok(/'revenue-report'/.test(rolesJs), "'revenue-report' is listed in the role page access map");
  });

  await chain;

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log('Failed: ' + failures.join(', '));

  httpServer.close();
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
