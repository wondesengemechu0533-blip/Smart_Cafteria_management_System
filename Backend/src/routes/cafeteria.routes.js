const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getCafeterias,
  getMyCafeteria,
  createCafeteria,
  updateCafeteria,
  getCafeteriaStats,
  bootstrapDefaultCafeteria,
} = require('../controllers/cafeteria.controller');

router.use(protect);

router.get('/mine', getMyCafeteria);
router.get('/', authorize('admin', 'ADMIN', 'system_admin'), getCafeterias);
router.post('/', authorize('admin', 'ADMIN', 'system_admin'), createCafeteria);
router.post('/bootstrap', authorize('admin', 'ADMIN', 'system_admin'), bootstrapDefaultCafeteria);
router.get('/:id/stats', authorize('admin', 'ADMIN', 'system_admin'), getCafeteriaStats);
router.put('/:id', authorize('admin', 'ADMIN', 'system_admin'), updateCafeteria);

module.exports = router;
