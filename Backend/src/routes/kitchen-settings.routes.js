const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { getKitchenSettings, updateKitchenSettings } = require('../controllers/kitchen-settings.controller');

// ============================================================
// ALL ROUTES REQUIRE KITCHEN OR ADMIN ROLE
// ============================================================
router.use(protect);
router.use(authorize('kitchen', 'admin', 'manager'));

/**
 * @route   GET /api/v1/kitchen/settings
 * @desc    Get the current user's kitchen settings
 * @access  Private/Kitchen or Admin
 */
router.get('/', getKitchenSettings);

/**
 * @route   PUT /api/v1/kitchen/settings
 * @desc    Update the current user's kitchen settings
 * @access  Private/Kitchen or Admin
 */
router.put('/', updateKitchenSettings);

module.exports = router;
