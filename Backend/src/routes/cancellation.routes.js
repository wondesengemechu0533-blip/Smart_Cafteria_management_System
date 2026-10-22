const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  requestCancellation,
  getCancellations,
  getCancellationById,
  approveCancellation,
  rejectCancellation,
  requestRefund,
  confirmRefund,
  failRefund,
  getCancellationStats,
  checkCancellationEligibility,
} = require('../controllers/cancellation.controller');

// ============================================================
//  PRIVATE ROUTES (Customer)
// ============================================================

/**
 * @route   POST /api/v1/cancellations/request
 * @desc    Request order cancellation
 * @access  Private
 * Body: { orderId, reason, details }
 */
router.post('/request', protect, requestCancellation);

/**
 * @route   GET /api/v1/cancellations/:orderId/check
 * @desc    Check cancellation eligibility
 * @access  Private
 */
router.get('/:orderId/check', protect, checkCancellationEligibility);

// ============================================================
//  ADMIN ROUTES
// ============================================================

/**
 * @route   GET /api/v1/cancellations
 * @desc    Get all cancellation requests
 * @access  Private/Admin
 * Query: search, status, paymentStatus, refundStatus, date, from, to, sort, page, limit
 */
router.get(
  '/',
  protect,
  authorize(
    'admin',
    'ADMIN',
    'system_admin',
    'manager',
    'staff',
    'kitchen_staff',
    'kitchen',
    'foodmaker'
  ),
  getCancellations
);

/**
 * @route   GET /api/v1/cancellations/stats
 * @desc    Get cancellation statistics
 * @access  Private/Admin
 */
router.get(
  '/stats',
  protect,
  authorize(
    'admin',
    'ADMIN',
    'system_admin',
    'manager',
    'staff',
    'kitchen_staff',
    'kitchen',
    'foodmaker'
  ),
  getCancellationStats
);

/**
 * @route   GET /api/v1/cancellations/:id
 * @desc    Get single cancellation (by cancellation id, number, or orderId)
 * @access  Private/Admin
 */
router.get(
  '/:id',
  protect,
  authorize(
    'admin',
    'ADMIN',
    'system_admin',
    'manager',
    'staff',
    'kitchen_staff',
    'kitchen',
    'foodmaker'
  ),
  getCancellationById
);

/**
 * @route   PATCH /api/v1/cancellations/:id/approve
 * @desc    Approve cancellation - runs full cancel/refund/stock flow
 * @access  Private/Admin
 * Body: { adminNote, allowServed }
 */
router.patch('/:id/approve', protect, authorize('admin', 'ADMIN', 'system_admin', 'manager'), approveCancellation);

/**
 * @route   PATCH /api/v1/cancellations/:id/reject
 * @desc    Reject cancellation - order stays active
 * @access  Private/Admin
 * Body: { adminNote }
 */
router.patch('/:id/reject', protect, authorize('admin', 'ADMIN', 'system_admin', 'manager'), rejectCancellation);

/**
 * @route   POST /api/v1/cancellations/:id/refund/request
 * @desc    Request a refund for an approved cancellation
 * @access  Private/Admin
 */
router.post('/:id/refund/request', protect, authorize('admin', 'ADMIN', 'system_admin', 'manager'), requestRefund);

/**
 * @route   POST /api/v1/cancellations/:id/refund/confirm
 * @desc    Confirm refund - simulated provider webhook, ONLY source of REFUNDED
 * @access  Private/Admin (provider webhook when integrated)
 * Body: { providerReference }
 */
router.post('/:id/refund/confirm', protect, authorize('admin', 'ADMIN', 'system_admin', 'manager'), confirmRefund);

/**
 * @route   POST /api/v1/cancellations/:id/refund/fail
 * @desc    Mark refund as failed
 * @access  Private/Admin
 * Body: { error }
 */
router.post('/:id/refund/fail', protect, authorize('admin', 'ADMIN', 'system_admin', 'manager'), failRefund);

module.exports = router;
