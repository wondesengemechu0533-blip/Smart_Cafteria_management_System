const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { getAvailableTables } = require('../controllers/table.controller');

// Customer-facing read-only list of tables that can be picked at checkout.
// Authenticated so table data stays out of the public API surface, and it only
// ever exposes currently available tables.
router.get('/available', protect, getAvailableTables);

module.exports = router;
