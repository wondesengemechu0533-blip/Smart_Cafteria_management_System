const { resolveCafeteriaScope } = require('../utils/cafeteria');
const { resolveRange } = require('../utils/reportRange');
const { HTTP_STATUS, MESSAGES } = require('../config/constants');
const service = require('../services/cafeteriaReports.service');

/**
 * Shared wrapper: resolve the TRUSTED cafeteria scope and the requested period,
 * then delegate to the service. The client can never influence the cafeteria -
 * it is always derived from the authenticated user's own record.
 */
async function run(req, res, fn) {
  try {
    const scope = resolveCafeteriaScope(req);
    const range = resolveRange({
      period: req.query.period,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    const report = await fn(scope, range, req.query);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      scope: { cafeteriaId: scope.cafeteriaId ? String(scope.cafeteriaId) : null, global: scope.global },
      report,
    });
  } catch (error) {
    const status = (error && error.statusCode) || HTTP_STATUS.INTERNAL_SERVER_ERROR;
    if (status >= 500) console.error('❌ Cafeteria report error:', error);
    res.status(status).json({
      success: false,
      error: status >= 500 ? MESSAGES.SERVER_ERROR : error.message,
    });
  }
}

/**
 * @route   GET /api/v1/cafeteria/reports/summary
 * @desc    Cafeteria dashboard summary cards for the selected period
 * @access  Private/Cafeteria admin + manager (+ system admin sees all)
 */
exports.getSummary = (req, res) => run(req, res, (scope, range) => service.getSummary(scope, range));

/**
 * @route   GET /api/v1/cafeteria/reports/sales
 * @desc    Sales report for the assigned cafeteria
 */
exports.getSales = (req, res) => run(req, res, (scope, range) => service.getSales(scope, range));

/**
 * @route   GET /api/v1/cafeteria/reports/orders
 * @desc    Orders report (status/payment filters + detail)
 */
exports.getOrders = (req, res) => run(req, res, (scope, range, q) => service.getOrders(scope, range, q));

/**
 * @route   GET /api/v1/cafeteria/reports/payments
 * @desc    Payments report (status/method filters + transaction history)
 */
exports.getPayments = (req, res) => run(req, res, (scope, range, q) => service.getPayments(scope, range, q));

/**
 * @route   GET /api/v1/cafeteria/reports/refunds
 * @desc    Refunds report (status filter + detail)
 */
exports.getRefunds = (req, res) => run(req, res, (scope, range, q) => service.getRefunds(scope, range, q));

/**
 * @route   GET /api/v1/cafeteria/reports/menu-performance
 * @desc    Menu performance report (most/least ordered, revenue, categories)
 */
exports.getMenuPerformance = (req, res) =>
  run(req, res, (scope, range, q) => service.getMenuPerformance(scope, range, q));

/**
 * @route   GET /api/v1/cafeteria/reports/inventory
 * @desc    Inventory / stock report (stock levels, low stock, out of stock)
 */
exports.getInventory = (req, res) => run(req, res, (scope) => service.getInventory(scope));
