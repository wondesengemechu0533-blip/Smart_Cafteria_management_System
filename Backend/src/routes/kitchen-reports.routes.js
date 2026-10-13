const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getKitchenReport,
  generateDailyReport,
  getDetailedKitchenStats,
  getStaffPerformance,
  getOrderPreparationReport,
} = require('../controllers/kitchen-reports.controller');

// ============================================================
// KITCHEN REPORTS & ANALYTICS (Admin & Kitchen)
// ============================================================

/**
 * @route   GET /api/kitchen/reports
 * @desc    Get kitchen performance report for a date range
 * @access  Private/Kitchen or Admin
 *
 * Query Params: startDate, endDate, reportType
 */
router.use(protect);
router.get('/reports', authorize('admin', 'cafeteria_admin', 'manager', 'kitchen'), getKitchenReport);

/**
 * @route   GET /api/kitchen/stats/detailed
 * @desc    Get kitchen dashboard stats with real-time metrics
 * @access  Private/Kitchen or Admin
 */
router.get('/stats/detailed', authorize('admin', 'cafeteria_admin', 'manager', 'kitchen'), getDetailedKitchenStats);

/**
 * @route   GET /api/kitchen/reports/orders
 * @desc    Get order preparation history/report
 * @access  Private/Kitchen or Admin
 *
 * Query Params: startDate, endDate, status
 */
router.get('/reports/orders', authorize('admin', 'cafeteria_admin', 'manager', 'kitchen'), getOrderPreparationReport);

/**
 * @route   POST /api/kitchen/reports/generate
 * @desc    Generate today's kitchen performance report
 * @access  Private/Admin
 */
router.post('/reports/generate', authorize('admin', 'cafeteria_admin', 'manager'), generateDailyReport);

/**
 * @route   GET /api/kitchen/staff/:staffId/performance
 * @desc    Get individual staff performance metrics
 * @access  Private/Admin or Kitchen
 *
 * Query Params: startDate, endDate
 */
router.get(
  '/staff/:staffId/performance',
  authorize('admin', 'cafeteria_admin', 'manager', 'kitchen'),
  getStaffPerformance
);

module.exports = router;
