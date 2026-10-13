const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { normalizeRole } = require('../validators/common.validator');
const { idleSessionGuard } = require('./idleSession.middleware');
const { isTransientDbError } = require('../config/database');
const { HTTP_STATUS } = require('../config/constants');

const protect = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });

  try {
    const tokenUser = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(tokenUser.id).select('name email phone role status isActive cafeteriaId');
    if (!user) {
      return res.status(401).json({ success: false, error: 'User account not found' });
    }
    if (user.status !== 'ACTIVE' || user.isActive === false) {
      return res.status(403).json({ success: false, error: 'Account is inactive or suspended' });
    }
    req.user = {
      ...tokenUser,
      id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: normalizeRole(user.role),
      cafeteriaId: user.cafeteriaId || null,
    };
    idleSessionGuard(req, res, next);
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
    console.error('❌ Authentication lookup error:', error);
    // A malformed id in the token is a bad credential, not a broken service.
    if (error.name === 'CastError') {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
    // This lookup is the one database round-trip every authenticated route
    // depends on, so when Mongo is unreachable it fails every endpoint at once.
    // Answer 503 + retryable rather than 500: the request and the route are
    // both fine, and telling the client so stops a momentary Atlas blip from
    // surfacing as dozens of bogus server errors.
    if (isTransientDbError(error)) {
      return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
        success: false,
        error: 'Database temporarily unavailable, please retry',
        retryable: true,
      });
    }
    return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: 'Authentication service unavailable',
    });
  }
};

const authorize =
  (...roles) =>
  (req, res, next) => {
    // Normalize roles for comparison (case-insensitive)
    const userRole = req.user.role.toLowerCase();
    const allowedRoles = roles.map((r) => r.toLowerCase());

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  };

module.exports = { protect, authorize };
