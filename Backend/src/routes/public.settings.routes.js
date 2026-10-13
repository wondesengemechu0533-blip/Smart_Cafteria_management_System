const express = require('express');
const router = express.Router();
const { getPublicSettings } = require('../utils/settings');

/**
 * @route   GET /api/v1/settings/public
 * @desc    Get public (non-sensitive) settings
 * @access  Public
 */
router.get('/public', async (req, res) => {
  try {
    const settings = await getPublicSettings();
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Get Public Settings Error:', error);
    res.status(500).json({ success: false, error: 'Failed to load settings' });
  }
});

module.exports = router;
