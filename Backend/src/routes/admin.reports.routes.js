const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { getReportSummary } = require('../controllers/admin.report.controller');

// All routes require admin, staff, or kitchen role
router.use(protect);
router.use(
  authorize(
    'admin',
    'ADMIN',
    'system_admin',
    'cafeteria_admin',
    'manager',
    'staff',
    'kitchen_staff',
    'kitchen',
    'foodmaker'
  )
);

/**
 * @route   GET /api/v1/admin/reports/summary
 * @desc    Admin report summary (revenue, orders, payments, popular foods)
 */
router.get('/summary', getReportSummary);

module.exports = router;
