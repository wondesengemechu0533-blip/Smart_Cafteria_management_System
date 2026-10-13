const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getAllMenuItems,
  getMenuItemById,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  toggleAvailability,
  getMenuStats,
  updateStock,
  getStockHistory,
} = require('../controllers/admin.menu.controller');

// All routes require admin, staff, or kitchen role
router.use(protect);
router.use(authorize('admin', 'ADMIN', 'cafeteria_admin', 'manager', 'staff', 'kitchen_staff', 'kitchen', 'foodmaker'));

/**
 * @route   GET /api/v1/admin/menu
 * @desc    Get all menu items (search / filter / paginate / sort)
 * Query: search, category, availability, sort, page, limit
 */
router.get('/', getAllMenuItems);

/**
 * @route   GET /api/v1/admin/menu/stats
 * @desc    Menu statistics for metric cards
 */
router.get('/stats', getMenuStats);

/**
 * @route   POST /api/v1/admin/menu
 * @desc    Create menu item
 * Body: { name: {en, am}, category, price, description, image | imageUrl, preparationTime, available }
 */
router.post('/', createMenuItem);
router.patch('/:id/stock', updateStock);
router.get('/:id/stock-history', getStockHistory);

/**
 * @route   GET /api/v1/admin/menu/:id
 * @desc    Get single menu item
 */
router.get('/:id', getMenuItemById);

/**
 * @route   PUT /api/v1/admin/menu/:id
 * @desc    Update menu item (partial updates supported)
 */
router.put('/:id', updateMenuItem);

/**
 * @route   PATCH /api/v1/admin/menu/:id/availability
 * @desc    Toggle item availability (available / unavailable)
 * Body: { available: true | false }
 */
router.patch('/:id/availability', toggleAvailability);

/**
 * @route   DELETE /api/v1/admin/menu/:id
 * @desc    Delete menu item
 */
router.delete('/:id', deleteMenuItem);

module.exports = router;
