const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getAllPayments,
  getPaymentStats,
  getPaymentById,
  getPaymentHistory,
  getOrderPayment,
  refundPayment,
} = require('../controllers/admin.payment.controller');

// All routes require admin, staff, or kitchen role
router.use(protect);
router.use(authorize('admin', 'ADMIN', 'manager', 'staff', 'kitchen_staff', 'kitchen', 'foodmaker'));

/**
 * Security note (Requirement 24):
 * These routes are READ-ONLY. An admin can monitor payment details but
 * can never manually set paymentStatus = PAID. Only backend verification
 * through the Chapa / Telebirr flows may do that.
 */

/**
 * @route   GET /api/v1/admin/payments
 * @desc    List payments (method / status / date / search / pagination)
 */
router.get('/', getAllPayments);

/**
 * @route   GET /api/v1/admin/payments/stats
 * @desc    Payment statistics for metric cards
 */
router.get('/stats', getPaymentStats);

/**
 * @route   GET /api/v1/admin/payments/:id
 * @desc    Payment detail (read-only)
 */
router.get('/:id', getPaymentById);

/**
 * @route   GET /api/v1/admin/payments/:id/history
 * @desc    Payment event history/audit log
 */
router.get('/:id/history', getPaymentHistory);

/**
 * @route   POST /api/v1/admin/payments/:id/refund
 * @desc    Process a refund for a payment
 */
router.post('/:id/refund', refundPayment);

/**
 * @route   GET /api/v1/admin/orders/:orderId/payment
 * @desc    Get payment for a specific order
 */
router.get('/orders/:orderId/payment', getOrderPayment);

module.exports = router;
