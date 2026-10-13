const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { validateBody } = require('../middleware/validation.middleware');
const {
  submitFeedback,
  getMyFeedback,
  getAllFeedback,
  getFeedbackById,
  updateFeedbackStatus,
  markFeedbackRead,
  deleteFeedback,
  getFeedbackStats,
  replyToFeedback,
} = require('../controllers/feedback.controller');
const { validateFeedbackInput } = require('../validators/feedback.validator');

router.post('/', protect, validateBody(validateFeedbackInput), submitFeedback);
router.get('/my', protect, getMyFeedback);

router.get(
  '/',
  protect,
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
  ),
  getAllFeedback
);
router.get(
  '/stats',
  protect,
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
  ),
  getFeedbackStats
);
router.get(
  '/:id',
  protect,
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
  ),
  getFeedbackById
);
router.patch(
  '/:id/status',
  protect,
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
  ),
  updateFeedbackStatus
);
router.patch(
  '/:id/reply',
  protect,
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
  ),
  replyToFeedback
);
router.patch(
  '/:id/read',
  protect,
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
  ),
  markFeedbackRead
);
router.delete(
  '/:id',
  protect,
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
  ),
  deleteFeedback
);

module.exports = router;
