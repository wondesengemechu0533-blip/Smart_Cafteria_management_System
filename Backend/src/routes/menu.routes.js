const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { validateBody } = require('../middleware/validation.middleware');
const {
  getAllMenuItems,
  getMenuItemById,
  getMenuItemsByCategory,
  getFeaturedItems,
  getRelatedItems,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  toggleAvailability,
  getMenuStats,
} = require('../controllers/menu.controller');
const {
  validateCreateMenuItem,
  validateUpdateMenuItem,
  validateToggleAvailability,
} = require('../validators/admin.validator');

router.get('/', getAllMenuItems);
router.get(
  '/stats',
  protect,
  authorize('admin', 'ADMIN', 'manager', 'staff', 'kitchen_staff', 'kitchen', 'foodmaker'),
  getMenuStats
);

router.get('/featured', getFeaturedItems);
router.get('/category/:category', getMenuItemsByCategory);
router.get('/:id', getMenuItemById);
router.get('/:id/related', getRelatedItems);

router.post(
  '/',
  protect,
  authorize('admin', 'ADMIN', 'manager', 'staff', 'kitchen_staff', 'kitchen', 'foodmaker'),
  validateBody(validateCreateMenuItem),
  createMenuItem
);
router.put(
  '/:id',
  protect,
  authorize('admin', 'ADMIN', 'manager', 'staff', 'kitchen_staff', 'kitchen', 'foodmaker'),
  validateBody(validateUpdateMenuItem),
  updateMenuItem
);
router.delete(
  '/:id',
  protect,
  authorize('admin', 'ADMIN', 'manager', 'staff', 'kitchen_staff', 'kitchen', 'foodmaker'),
  deleteMenuItem
);
router.patch(
  '/:id/availability',
  protect,
  authorize('admin', 'ADMIN', 'manager', 'staff', 'kitchen_staff', 'kitchen', 'foodmaker'),
  validateBody(validateToggleAvailability),
  toggleAvailability
);
module.exports = router;
