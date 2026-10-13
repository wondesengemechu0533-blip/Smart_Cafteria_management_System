const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getAllCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  toggleCategoryStatus,
  deleteCategory,
  getCategoryStats,
} = require('../controllers/admin.category.controller');

router.use(protect);
router.use(authorize('admin', 'ADMIN', 'cafeteria_admin', 'manager', 'staff', 'kitchen_staff', 'kitchen', 'foodmaker'));

router.get('/', getAllCategories);
router.get('/stats', getCategoryStats);
router.post('/', createCategory);
router.get('/:id', getCategoryById);
router.put('/:id', updateCategory);
router.patch('/:id/status', toggleCategoryStatus);
router.delete('/:id', deleteCategory);

module.exports = router;
