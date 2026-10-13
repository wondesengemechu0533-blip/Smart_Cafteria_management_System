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
 * Every route is restricted to cafeteria administration/management (plus system
 * admins, who see all cafeterias). The cafeteria id is resolved on the backend
 * from the authenticated user - query/body/param cafeteriaId values are ignored.
 */
router.use(protect);
router.use(authorize('cafeteria_admin', 'manager', 'admin', 'ADMIN', 'system_admin'));

router.get('/summary', getSummary);
router.get('/sales', getSales);
router.get('/orders', getOrders);
router.get('/payments', getPayments);
router.get('/refunds', getRefunds);
router.get('/menu-performance', getMenuPerformance);
router.get('/inventory', getInventory);

module.exports = router;
