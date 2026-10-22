const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { validateBody } = require('../middleware/validation.middleware');
const {
  getAllCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  toggleCategoryStatus,
} = require('../controllers/category.controller');
const { validateCreateCategory, validateUpdateCategory } = require('../validators/category.validator');

router.get('/', getAllCategories);
router.get('/:id', getCategoryById);

router.post(
  '/',
  protect,
  authorize('admin', 'ADMIN', 'manager', 'staff', 'kitchen_staff', 'kitchen', 'foodmaker'),
  validateBody(validateCreateCategory),
  createCategory
);
router.put(
  '/:id',
  protect,
  authorize('admin', 'ADMIN', 'manager', 'staff', 'kitchen_staff', 'kitchen', 'foodmaker'),
  validateBody(validateUpdateCategory),
  updateCategory
);
router.patch(
  '/:id/status',
  protect,
  authorize('admin', 'ADMIN', 'manager', 'staff', 'kitchen_staff', 'kitchen', 'foodmaker'),
  toggleCategoryStatus
);
router.delete(
  '/:id',
  protect,
  authorize('admin', 'ADMIN', 'manager', 'staff', 'kitchen_staff', 'kitchen', 'foodmaker'),
  deleteCategory
);

module.exports = router;
