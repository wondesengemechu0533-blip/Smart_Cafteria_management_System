const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { validateBody } = require('../middleware/validation.middleware');
const {
  register,
  login,
  getMe,
  updateMe,
  changePassword,
  resetPassword,
  logout,
  getCaptcha,
  sendOtp,
  verifyOtpHandler,
} = require('../controllers/auth.controller');
const {
  validateRegisterInput,
  validateLoginInput,
  validateUpdateProfileInput,
} = require('../validators/auth.validator');

router.get('/captcha', getCaptcha);
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtpHandler);
router.post('/register', validateBody(validateRegisterInput), register);
router.post('/login', validateBody(validateLoginInput), login);
router.post('/reset-password', resetPassword);

router.get('/me', protect, getMe);
router.get('/profile', protect, getMe); // Alias for Frontend compatibility
router.put('/me', protect, validateBody(validateUpdateProfileInput), updateMe);
router.put('/profile', protect, validateBody(validateUpdateProfileInput), updateMe); // Alias for Frontend compatibility
router.put('/password', protect, changePassword);
router.put('/change-password', protect, changePassword); // Alias for Frontend compatibility
router.post('/logout', protect, logout);

module.exports = router;
