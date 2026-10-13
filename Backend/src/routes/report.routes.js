const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { validateQuery } = require('../middleware/validation.middleware');
const {
  getDailyOrdersReport,
  getSalesReport,
  getPopularItemsReport,
  getPaymentsReport,
  getRevenueReport,
  getTaxComplianceReport,
  getAllReports,
  getReportById,
  deleteReport,
} = require('../controllers/report.controller');
const { validateReportQuery } = require('../validators/report.validator');

router.use(protect);

// Government / tax authority - restricted to VAT compliance figures only.
// System admins and cafeteria admins may also view for reconciliation.
router.get(
  '/tax-compliance',
  authorize('tax_authority', 'admin', 'ADMIN', 'system_admin', 'cafeteria_admin'),
  getTaxComplianceReport
);

// Revenue/tax report is available to finance-adjacent roles: administration,
// management, cashiers (for the daily cash-up) and tax authority (VAT remittance).
router.get(
  '/revenue',
  authorize('admin', 'ADMIN', 'system_admin', 'cafeteria_admin', 'manager', 'cashier', 'tax_authority'),
  getRevenueReport
);

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

router.get('/daily', validateQuery(validateReportQuery), getDailyOrdersReport);
router.get('/sales', validateQuery(validateReportQuery), getSalesReport);
router.get('/popular', validateQuery(validateReportQuery), getPopularItemsReport);
router.get('/payments', validateQuery(validateReportQuery), getPaymentsReport);
router.get('/', getAllReports);
router.get('/:id', getReportById);
router.delete('/:id', deleteReport);

module.exports = router;
