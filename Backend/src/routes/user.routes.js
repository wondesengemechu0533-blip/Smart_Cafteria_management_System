const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { validateBody } = require('../middleware/validation.middleware');
const {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  toggleUserStatus,
  assignUserRole,
  getUserStats,
  resetUserPassword,
} = require('../controllers/user.controller');
const {
  validateCreateUser,
  validateUpdateUser,
  validateAssignRole,
  validateToggleStatus,
} = require('../validators/admin.validator');

router.use(protect);
router.use(authorize('admin', 'ADMIN', 'system_admin', 'manager'));

router.get('/', getAllUsers);
router.get('/stats', getUserStats);
router.post('/', validateBody(validateCreateUser), createUser);
router.get('/:id', getUserById);
router.put('/:id', validateBody(validateUpdateUser), updateUser);
router.patch('/:id/status', validateBody(validateToggleStatus), toggleUserStatus);
router.patch('/:id/role', validateBody(validateAssignRole), assignUserRole);
router.patch('/:id/password', resetUserPassword);
router.delete('/:id', deleteUser);

module.exports = router;
