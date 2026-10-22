const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { getReportSummary } = require('../controllers/admin.report.controller');

// All routes require admin, staff, or kitchen role
router.use(protect);
router.use(authorize('admin', 'ADMIN', 'system_admin'));

/**
 * @route   GET /api/v1/admin/reports/summary
 * @desc    OPERATIONAL report summary for a period: order counts and status
 *          distribution, order types, payment activity, food popularity and
 *          order trends.
 *
 *          The financial report (revenue, collections, VAT) is served by
 *          GET /api/v1/reports/finance and GET /api/v1/reports/tax.
 *
 * @query   period    today | yesterday | last7 | last30 | month | custom
 * @query   startDate YYYY-MM-DD (period=custom only)
 * @query   endDate   YYYY-MM-DD (period=custom only)
 */
router.get('/summary', getReportSummary);

module.exports = router;
