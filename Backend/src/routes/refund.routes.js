const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  requestRefund,
  getRefunds,
  getRefundById,
  approveRefund,
  rejectRefund,
  completeRefund,
} = require('../controllers/refund.controller');
const { validateBody } = require('../middleware/validation.middleware');
const { validateRefundInput, validateRefundDecision } = require('../validators/refund.validator');

// Every refund route requires an authenticated user.
router.use(protect);

// Customers request refunds; staff may review/process.
router.post('/', validateBody(validateRefundInput), requestRefund);
router.get('/', getRefunds);
router.get('/:id', getRefundById);

// Decision endpoints: cashier, manager or admin only.
router.patch(
  '/:id/approve',
  authorize('cashier', 'admin', 'ADMIN', 'manager'),
  validateBody(validateRefundDecision),
  approveRefund
);
router.patch(
  '/:id/reject',
  authorize('cashier', 'admin', 'ADMIN', 'manager'),
  validateBody(validateRefundDecision),
  rejectRefund
);
router.patch('/:id/complete', authorize('cashier', 'admin', 'ADMIN', 'manager'), completeRefund);

module.exports = router;
