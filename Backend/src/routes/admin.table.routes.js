const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getAllTables,
  getTableById,
  createTable,
  updateTable,
  toggleTableStatus,
  deleteTable,
  getTableStats,
} = require('../controllers/admin.table.controller');

router.use(protect);
router.use(authorize('cafeteria_admin', 'manager'));

router.get('/', getAllTables);
router.get('/stats', getTableStats);
router.post('/', createTable);
router.get('/:id', getTableById);
router.put('/:id', updateTable);
router.patch('/:id/status', toggleTableStatus);
router.delete('/:id', deleteTable);

module.exports = router;
