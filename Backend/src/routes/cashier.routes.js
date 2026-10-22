const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getCashierDashboard,
  confirmPayment,
  getDailyCashup,
  getOrders,
  getPayments,
  getReceipts,
  getReceipt,
} = require('../controllers/cashier.controller');

// Cashier dashboard is restricted to cashier + management roles.
router.use(protect);
router.use(authorize('cashier', 'admin', 'ADMIN', 'manager'));

/**
 * @route   GET /api/v1/cashier/dashboard
 * @desc    Today's payment / refund / cash summary
 */
router.get('/dashboard', getCashierDashboard);

/**
 * @route   GET /api/v1/cashier/cashup
 * @desc    Daily cash-up reconciliation report
 */
router.get('/cashup', getDailyCashup);

/**
 * @route   GET /api/v1/cashier/sales
 * @desc    Daily sales / cash-up summary (sidebar Sales page)
 */
router.get('/sales', getDailyCashup);

/**
 * @route   GET /api/v1/cashier/orders
 * @desc    Order list for the cashier
 */
router.get('/orders', getOrders);

/**
 * @route   GET /api/v1/cashier/payments
 * @desc    Payment list (read-only)
 */
router.get('/payments', getPayments);

/**
 * @route   GET /api/v1/cashier/receipts
 * @desc    Paid orders available as receipts
 */
router.get('/receipts', getReceipts);

/**
 * @route   GET /api/v1/cashier/receipts/:id
 * @desc    Single receipt by order id or order number
 */
router.get('/receipts/:id', getReceipt);

/**
 * @route   PATCH /api/v1/cashier/orders/:id/mark-paid
 * @desc    Record payment for an order (cash collection)
 */
router.patch('/orders/:id/mark-paid', confirmPayment);

module.exports = router;
