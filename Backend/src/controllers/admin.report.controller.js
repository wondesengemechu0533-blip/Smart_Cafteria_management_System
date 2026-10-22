const { resolveCafeteriaScope } = require('../utils/cafeteria');
const { resolveRange } = require('../utils/reportRange');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');
const operationsService = require('../services/operationsReports.service');
const financeService = require('../services/financeReports.service');

/**
 * Resolve the trusted cafeteria scope + the requested period.
 * The client never supplies the cafeteria - it is derived from the
 * authenticated user - and the period boundaries are computed on the server
 * in the reporting timezone.
 */
function resolveScopeAndRange(req) {
  const scope = resolveCafeteriaScope(req);
  const range = resolveRange({
    period: req.query.period,
    startDate: req.query.startDate,
    endDate: req.query.endDate,
  });
  return { scope, range };
}

function scopePayload(scope) {
  return { cafeteriaId: scope.cafeteriaId ? String(scope.cafeteriaId) : null, global: scope.global };
}

function fail(res, error) {
  const status = (error && error.statusCode) || HTTP_STATUS.INTERNAL_SERVER_ERROR;
  if (status >= 500) console.error('❌ Report error:', error);
  return res
    .status(status)
    .json({ success: false, error: status >= 500 ? MESSAGES.SERVER_ERROR : error.message });
}

/**
 * @desc    Operational report summary for a period
 * @route   GET /api/v1/admin/reports/summary
 * @access  Private/Admin
 *
 * Query:
 *   period      today | yesterday | last7 | last30 | month | custom   (default: month)
 *   startDate   required only when period=custom (YYYY-MM-DD)
 *   endDate     required only when period=custom (YYYY-MM-DD)
 *
 * Counts orders and payment activity from the stored Order / Payment
 * collections. No figure is hard-coded and no data comes from the client.
 */
exports.getReportSummary = async (req, res) => {
  try {
    const { scope, range } = resolveScopeAndRange(req);
    const report = await operationsService.getOperationalReport(scope, range);
    res.status(HTTP_STATUS.OK).json({ success: true, scope: scopePayload(scope), report });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * @desc    Financial report (revenue, collections, refunds, reconciliation)
 * @route   GET /api/v1/reports/finance
 * @access  Private/Admin/Manager
 *
 * Query: period | startDate | endDate (same contract as the summary report)
 */
exports.getFinanceReport = async (req, res) => {
  try {
    const { scope, range } = resolveScopeAndRange(req);
    const report = await financeService.getFinancialReport(scope, range);
    res.status(HTTP_STATUS.OK).json({ success: true, scope: scopePayload(scope), report });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * @desc    VAT / tax compliance report with transaction-level records
 * @route   GET /api/v1/reports/tax
 * @access  Private/Admin/Manager
 *
 * Query: period | startDate | endDate | limit
 */
exports.getTaxReport = async (req, res) => {
  try {
    const { scope, range } = resolveScopeAndRange(req);
    const report = await financeService.getTaxReport(scope, range, { limit: req.query.limit });
    res.status(HTTP_STATUS.OK).json({ success: true, scope: scopePayload(scope), report });
  } catch (error) {
    return fail(res, error);
  }
};
