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
const { getFinanceReport, getTaxReport } = require('../controllers/admin.report.controller');
const { validateReportQuery } = require('../validators/report.validator');

router.use(protect);

// Financial dashboard (Revenue / System Analytics).
//
// These two endpoints back the dedicated financial page: revenue + collection
// reconciliation, and the VAT / tax compliance view with transaction-level
// records. The cafeteria scope is resolved from the authenticated user, so a
// manager only ever sees their own cafeteria while a system admin sees all.
router.get(
  '/finance',
  authorize('admin', 'ADMIN', 'system_admin', 'manager'),
  getFinanceReport
);
router.get('/tax', authorize('admin', 'ADMIN', 'system_admin', 'manager'), getTaxReport);

// Government / tax authority - restricted to VAT compliance figures only.
// System admins may also view for reconciliation.
router.get(
  '/tax-compliance',
  authorize('admin', 'ADMIN', 'system_admin'),
  getTaxComplianceReport
);

// Revenue/tax report is available to finance-adjacent roles: administration,
// management, cashiers (for the daily cash-up) and tax authority (VAT remittance).
router.get(
  '/revenue',
  authorize('admin', 'ADMIN', 'system_admin', 'manager', 'cashier'),
  getRevenueReport
);

router.use(
  authorize(
    'admin',
    'ADMIN',
    'system_admin',
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
