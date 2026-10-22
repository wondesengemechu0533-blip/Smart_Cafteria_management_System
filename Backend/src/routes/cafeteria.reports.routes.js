const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getSummary,
  getSales,
  getOrders,
  getPayments,
  getRefunds,
  getMenuPerformance,
  getInventory,
} = require('../controllers/cafeteria.report.controller');

/**
 * Cafeteria-scoped reports.
 *
 * Every route is restricted to cafeteria management (plus system
 * admins, who see all cafeterias). The cafeteria id is resolved on the backend
 * from the authenticated user - query/body/param cafeteriaId values are ignored.
 *
 * `/summary` is the OPERATIONAL report (order counts, status distribution,
 * order types, food popularity, order trends) - the same report the system
 * admins read from /admin/reports/summary. The financial report lives on
 * /api/v1/reports/finance and /api/v1/reports/tax.
 */
router.use(protect);
router.use(authorize('manager', 'admin', 'ADMIN', 'system_admin'));

router.get('/summary', getSummary);
router.get('/sales', getSales);
router.get('/orders', getOrders);
router.get('/payments', getPayments);
router.get('/refunds', getRefunds);
router.get('/menu-performance', getMenuPerformance);
router.get('/inventory', getInventory);

module.exports = router;
