const User = require('../models/User');
const jwt = require('jsonwebtoken');
const { logAction } = require('../utils/audit');
const { storeProfileImage, deleteUploadedImage } = require('../utils/imageUpload');

const { ROLES, MESSAGES, HTTP_STATUS } = require('../config/constants');

/**
 * Generate JWT Token
 */
const generateToken = (id, role) => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || process.env.JWT_EXPIRE || '30d',
  });
};

/**
* @desc    Register new user
* @route   POST /api/auth/register

* @access  Public
*
* Frontend: register.html
* Expected Body: { name, email, phone, password, confirmPassword }
* Response: { success, token, user: { id, name, email, role, phone } }
*/
exports.register = async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      confirmPassword,
      username,
      address,
      agreedToTerms,
      captchaId,
      captchaAnswer,
    } = req.body;

    // ✅ Validate required fields (matches register.html validation)

    if (!name || !email || !phone || !password) {
      const missingFields = {};
      if (!name) missingFields.name = 'Full name is required';
      if (!email) missingFields.email = 'Email is required';
      if (!phone) missingFields.phone = 'Phone number is required';
      if (!password) missingFields.password = 'Password is required';
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'All fields are required',
        errors: missingFields,
      });
    }

    // ✅ Validate terms agreement
    if (!agreedToTerms) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'You must agree to the Terms & Conditions',
        errors: { agreedToTerms: 'You must agree to the Terms & Conditions' },
      });
    }

    // ✅ Validate name (matches register.html)
    if (name.length < 2 || name.length > 100) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Name must be between 2 and 100 characters',
        errors: { name: 'Name must be between 2 and 100 characters' },
      });
    }

    if (!/^[a-zA-Z\s]+$/.test(name.trim())) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Name can only contain letters and spaces',
        errors: { name: 'Name can only contain letters and spaces' },
      });
    }

    // ✅ Validate email format (matches register.html regex)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Please enter a valid email address',
        errors: { email: 'Please enter a valid email address' },
      });
    }

    // ✅ Validate phone (Ethiopian format: 09XXXXXXXX, 07XXXXXXXX, or +2519XXXXXXXX)
    const phoneRegex = /^(\+251[0-9]{9}|(09|07)[0-9]{8})$/;
    if (!phoneRegex.test(phone)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Enter a valid Ethiopian phone number (e.g. 09XXXXXXXX or +2519XXXXXXXX)',
        errors: { phone: 'Enter a valid Ethiopian phone number (e.g. 09XXXXXXXX or +2519XXXXXXXX)' },
      });
    }

    // Validate password length.
    if (password.length < 8) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Password must be at least 8 characters',
        errors: { password: 'Password must be at least 8 characters' },
      });
    }

    // ✅ Validate password complexity
    if (
      !/[A-Z]/.test(password) ||
      !/[a-z]/.test(password) ||
      !/[0-9]/.test(password) ||
      !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)
    ) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Password must contain uppercase, lowercase, number, and special character',
        errors: { password: 'Password must contain uppercase, lowercase, number, and special character' },
      });
    }

    // ✅ Check password confirmation (matches register.html)
    if (password !== confirmPassword) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Passwords do not match',
        errors: { confirmPassword: 'Passwords do not match' },
      });
    }

    // ✅ Check if user exists (email or phone)
    const existingUser = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { phone: phone }],
    });

    if (existingUser) {
      const isEmailTaken = existingUser.email === email.toLowerCase();

      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: isEmailTaken ? 'This email is already registered' : 'This phone number is already registered',
        errors: isEmailTaken
          ? { email: 'This email is already registered' }
          : { phone: 'This phone number is already registered' },
        errorField: isEmailTaken ? 'email' : 'phone',
      });
    }

    // ✅ Check username uniqueness if provided
    if (username && username.trim()) {
      const existingUsername = await User.findOne({ username: username.trim() });
      if (existingUsername) {
        return res.status(HTTP_STATUS.CONFLICT).json({
          success: false,
          error: 'This username is already taken',
          errors: { username: 'This username is already taken' },
          errorField: 'username',
        });
      }
    }

    // ✅ Create user
    // Public registration ALWAYS creates a customer. Any `role` sent by the
    // client is deliberately ignored here so users cannot register as ADMIN,
    // kitchen staff, or any other privileged role.
    const { getSettingsMap } = require('../utils/settings');
    const settings = await getSettingsMap();
    const otpRequired = settings.otp_verification_enabled === true || settings.otp_verification_enabled === 'true';

    // ✅ CAPTCHA (if enabled): verify BEFORE creating the account.
    const captchaEnabled =
      settings.registration_captcha_enabled === true || settings.registration_captcha_enabled === 'true';
    if (captchaEnabled) {
      const { verifyCaptcha } = require('../services/captcha.service');
      if (!verifyCaptcha(captchaId, captchaAnswer)) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'CAPTCHA verification failed. Please try again.',
          errors: { captcha: 'CAPTCHA verification failed. Please try again.' },
        });
      }
    }

    const userData = {
      name: name.trim(),
      email: email.toLowerCase(),
      phone: phone,
      password: password,
      role: ROLES.CUSTOMER,
      // Only set username when provided. Setting it to `null` would clash with
      // the sparse unique index on `username` if another user also has null
      // (MongoDB indexes explicit null values even for sparse indexes), causing
      // a false "already exists" 409 during registration.
      ...(username && username.trim() ? { username: username.trim() } : {}),
      address: address && address.trim() ? address.trim() : null,
      agreedToTerms: agreedToTerms === true,
      ...(otpRequired ? { otpVerifiedAt: null } : { otpVerifiedAt: new Date() }),
    };
    const user = await User.create(userData);

    // ✅ Audit new registrations (never logs credentials/token)
    await logAction({
      req,
      action: 'REGISTRATION',
      entityType: 'User',
      entityId: String(user._id),
      description: `New customer "${user.name}" registered (${user.email})`,
      result: 'SUCCESS',
    });

    // ✅ Generate token
    const token = generateToken(user._id, user.role);

    // ✅ Response matches frontend expectations
    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      token,
      otpRequired,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        username: user.username,
        role: user.role,

        avatar: user.avatar,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    console.error('❌ Registration Error:', error);

    // ✅ Mongoose schema validation -> return the real field errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((e) => e.message);
      const errorsObj = {};
      Object.keys(error.errors).forEach((key) => {
        errorsObj[key] = error.errors[key].message;
      });
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: messages[0] || 'Validation failed',
        errors: errorsObj,
      });
    }

    // ✅ Duplicate key (unique email/phone) e.g. a race between the check
    // above and the create. Safe to tell the client which field collided.
    if (error.code === 11000) {
      const field = Object.keys(error.keyValue)[0];
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error:
          field === 'email' || field === 'phone'
            ? `This ${field} is already registered`
            : 'User with this information already exists',
        errors: { [field]: `This ${field} is already registered` },
        errorField: field,
      });
    }

    // ✅ Unknown error: keep it generic so no internal details leak.
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get CAPTCHA challenge (public)
 * @route   GET /api/v1/auth/captcha
 * @access  Public
 * Response: { success, captcha: { id, image, question } }
 */
exports.getCaptcha = async (req, res) => {
  try {
    const { createCaptcha } = require('../services/captcha.service');
    const captcha = createCaptcha();
    res.status(HTTP_STATUS.OK).json({ success: true, captcha });
  } catch (error) {
    console.error('❌ Get Captcha Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Send OTP (public) - used for registration & password reset
 * @route   POST /api/v1/auth/send-otp
 * @access  Public
 * Expected Body: { email?, phone?, purpose }
 * Response: { success, code?, simulated?, message }
 */
exports.sendOtp = async (req, res) => {
  try {
    const { email, phone, purpose = 'REGISTER' } = req.body;
    if (!email && !phone) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Email or phone is required' });
    }
    const { generateOtp } = require('../services/otp.service');
    const result = await generateOtp({ email, phone, purpose });
    if (!result.ok) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ success: false, error: result.error || 'Could not send the verification code' });
    }

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Verification code sent',
      // In simulated/dev mode the code is returned so the flow is testable.
      ...(result.code !== undefined ? { code: result.code, simulated: true } : { simulated: false }),
      recordedFor: result.recordedFor,
    });
  } catch (error) {
    console.error('❌ Send OTP Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Verify OTP (public) - completes registration email/phone verification
 * @route   POST /api/v1/auth/verify-otp
 * @access  Public
 * Expected Body: { email?, phone?, purpose, code }
 * Response: { success, verified, message }
 */
exports.verifyOtpHandler = async (req, res) => {
  try {
    const { email, phone, purpose = 'REGISTER', code } = req.body;
    if (!code) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Verification code is required' });
    }
    const { verifyOtp } = require('../services/otp.service');
    const result = await verifyOtp({ email, phone, purpose, code });
    if (!result.ok) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: result.error || 'Verification failed' });
    }

    // Mark the user record verified so the account is fully activated.
    if (email) {
      await User.updateOne({ email: String(email).toLowerCase() }, { $set: { otpVerifiedAt: new Date() } });
    } else if (phone) {
      await User.updateOne({ phone }, { $set: { otpVerifiedAt: new Date() } });
    }

    return res.status(HTTP_STATUS.OK).json({ success: true, verified: true, message: 'Verification successful' });
  } catch (error) {
    console.error('❌ Verify OTP Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 * @access  Public
 *
 * Frontend: login.html
 * Expected Body: { identifier, password }
 * Response: { success, token, user: { id, name, email, role, phone } }
 */
exports.login = async (req, res) => {
  try {
    const { identifier, password } = req.body;

    // ✅ Validate input (matches login.html)

    if (!identifier || !password) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Phone/Email and password are required',
      });
    }

    // ✅ Check if identifier is email or phone
    const isEmail = identifier.includes('@');
    const query = isEmail ? { email: identifier.toLowerCase() } : { phone: identifier };

    // ✅ Find user
    const user = await User.findOne(query).select('+password');

    if (!user) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: 'Invalid credentials',
      });
    }

    // ✅ Check if account is blocked
    if (user.status === 'BLOCKED' || user.isActive === false) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'Account is blocked. Please contact admin.',
      });
    }

    // ✅ Check password
    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      await logAction({
        req,
        action: 'LOGIN_FAILED',
        entityType: 'User',
        entityId: String(user._id),
        description: `Failed sign-in attempt for ${user.email}`,
        result: 'FAILED',
      });
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,

        error: 'Invalid credentials',
      });
    }

    // ✅ Generate token
    const token = generateToken(user._id, user.role);

    // ✅ Audit: record successful login for every role (never logs credentials/token)
    await logAction({
      req,
      action: 'LOGIN',
      entityType: 'User',
      entityId: String(user._id),
      description: `${user.name} (${user.email}) signed in as ${user.role}`,
      result: 'SUCCESS',
    });

    // ✅ Response matches frontend expectations
    // Frontend stores: isLoggedIn, userRole, userProfile
    res.status(HTTP_STATUS.OK).json({
      success: true,
      token,
      user: {
        id: user._id,

        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        avatar: user.avatar,
        status: user.status,
        balance: user.balance,
      },
    });
  } catch (error) {
    console.error('❌ Login Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get current user profile
 * @route   GET /api/auth/me
 * @access  Private
 *
 * Frontend: profile.js
 * Response: { success, user: { id, name, email, phone, role, avatar } }
 */
exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');

    if (!user) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'User not found',
      });
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,

        phone: user.phone,
        role: user.role,
        avatar: user.avatar,
        status: user.status,
        balance: user.balance,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    console.error('❌ Get Profile Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Update user profile
 * @route   PUT /api/auth/me
 * @access  Private
 *
 * Frontend: profile.js
 * Expected Body: { name, phone, email, avatar, language, diningType, tableNumber }
 * Response: { success, user }
 */
exports.updateMe = async (req, res) => {
  try {
    const { name, phone, email, avatar, language, diningType, tableNumber } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'User not found',
      });
    }

    // ✅ Update fields (matches profile.js form)
    if (name) user.name = name.trim();
    if (phone) {
      const phoneRegex = /^(\+251[0-9]{9}|(09|07)[0-9]{8})$/;
      if (!phoneRegex.test(phone)) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'Enter a valid Ethiopian phone number (e.g. 09XXXXXXXX or +2519XXXXXXXX)',
        });
      }
      user.phone = phone;
    }
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'Please enter a valid email address',
        });
      }
      user.email = email.toLowerCase();
    }
    if (avatar) {
      // Persist the uploaded photo as a real file so it can be served at a
      // stable /uploads/profile/... URL (fixes 404 from dead placeholder paths).
      const previousAvatar = user.avatar;
      if (typeof avatar === 'string' && avatar.startsWith('data:')) {
        try {
          user.avatar = storeProfileImage(avatar);
        } catch (imgErr) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            error: imgErr.message || 'Invalid profile image',
          });
        }
      } else {
        // Already a http(s) or /uploads path - store as-is.
        user.avatar = avatar;
      }
      // Remove the old stored avatar file (best effort) when it's a served file.
      if (previousAvatar && previousAvatar !== user.avatar) {
        deleteUploadedImage(previousAvatar);
      }
    }

    // ✅ Save preferences (profile.js stores these in localStorage)

    // These are stored in frontend, not necessarily in DB
    // But we can store them if needed
    if (language) user.language = language;
    if (diningType) user.diningType = diningType;
    if (tableNumber) user.tableNumber = tableNumber;

    await user.save();

    res.status(HTTP_STATUS.OK).json({
      success: true,
      user: {
        id: user._id,

        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        avatar: user.avatar,
        status: user.status,
        balance: user.balance,
      },
    });
  } catch (error) {
    console.error('❌ Update Profile Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Change password
 * @route   PUT /api/auth/password
 * @access  Private
 *
 * Frontend: profile.js (password change section)
 * Expected Body: { currentPassword, newPassword, confirmPassword }
 * Response: { success, message }
 */
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    // ✅ Validate input
    if (!currentPassword || !newPassword) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Current password and new password are required',
      });
    }

    if (newPassword.length < 6) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'New password must be at least 6 characters',
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'New passwords do not match',
      });
    }

    const user = await User.findById(req.user.id).select('+password');
    if (!user) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'User not found',
      });
    }

    // ✅ Check current password
    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: 'Current password is incorrect',
      });
    }

    // ✅ Update password
    user.password = newPassword;
    await user.save();

    // ✅ Generate new token
    const token = generateToken(user._id, user.role);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      token,
      message: 'Password changed successfully',
    });
  } catch (error) {
    console.error('❌ Change Password Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Reset password (forgot password)
 * @route   POST /api/auth/reset-password
 * @access  Public
 *
 * Frontend: login.html (Forgot password link)
 * Expected Body: { email }
 * Response: { success, message }
 */
exports.resetPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Email is required',
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'No account found with this email',
      });
    }

    // ✅ In production, send reset link via email
    // For now, just return success

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Password reset link sent to your email',
    });
  } catch (error) {
    console.error('❌ Reset Password Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
* @desc    Logout user
* @route   POST /api/auth/logout
* @access  Private
*

* Frontend: profile.js (Logout button)
* Response: { success, message }
*/
exports.logout = async (req, res) => {
  try {
    // ✅ Audit: record sign-out
    await logAction({
      req,
      action: 'LOGOUT',
      entityType: 'User',
      entityId: String(req.user.id),
      description: `${req.user.name || 'User'} signed out (${req.user.role})`,
      result: 'SUCCESS',
    });

    // ✅ Frontend handles localStorage cleanup
    // Backend just acknowledges logout
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    console.error('❌ Logout Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};
