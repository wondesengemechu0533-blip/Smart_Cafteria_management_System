const mongoose = require('mongoose');
const User = require('../models/User');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');
const { ROLES, normalizeRole, isAdminRole, canManageUser } = require('../config/roles');
const { logAction } = require('../utils/audit');

const phoneRegex = /^(\+251[0-9]{9}|(09|07)[0-9]{8})$/;
const CAFETERIA_OPERATIONAL_ROLES = ['kitchen', 'delivery', 'cashier'];
function isSystemAdminRole(role) {
  const n = normalizeRole(role);
  return n === 'admin' || n === 'system_admin';
}

/**
 * Enforce an actor's privilege to create/manage a target user.
 * Throws an Error with .statusCode on violation.
 */
function assertManageAllowed(actorRole, currentTargetRole, newTargetRole = null) {
  if (!canManageUser(actorRole, currentTargetRole, newTargetRole)) {
    const error = new Error('You do not have permission to manage users with this role');
    error.statusCode = HTTP_STATUS.FORBIDDEN;
    throw error;
  }
}

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * Resolve which cafeteria a staff user should belong to.
 * - System admins may assign any valid cafeteria (or none for customers).
 * - Cafeteria-scoped actors can only assign users to their OWN cafeteria;
 *   any requested cafeteriaId from the client is ignored.
 * Customers never carry a cafeteria assignment.
 */
function resolveAssignableCafeteriaId(req, requestedCafeteriaId, targetRole) {
  if (normalizeRole(targetRole) === 'customer') return null;

  const isGlobalAdmin = isAdminRole(req.user.role);
  if (isGlobalAdmin) {
    if (requestedCafeteriaId && isValidObjectId(requestedCafeteriaId)) return requestedCafeteriaId;
    return null;
  }
  return req.user.cafeteriaId || null;
}

function sanitizeUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: normalizeRole(user.role) || user.role,
    cafeteriaId: user.cafeteriaId || null,
    balance: user.balance,
    status: user.status,
    isActive: user.isActive,
    avatar: user.avatar,
    createdAt: user.createdAt,
  };
}

/**
 * Count active administrators (admin role) with status ACTIVE and isActive true.
 */
const countActiveAdmins = () => User.countDocuments({ role: 'admin', status: 'ACTIVE', isActive: true });

/**
 * @desc    Get all users (Admin only) - paginated & filterable
 * @route   GET /api/v1/admin/users  (also /api/v1/users)
 * @access  Private/Admin
 * Query Params: page, limit, search, role, status
 * Response: { success, count, total, page, pages, users: [...] }
 */
exports.getAllUsers = async (req, res) => {
  try {
    const { search, role, status, page = 1, limit = 20 } = req.query;
    let filter = {};

    const actorIsSystemAdmin = isSystemAdminRole(req.user.role);
    const actorIsCafeteriaAdmin = normalizeRole(req.user.role) === 'cafeteria_admin';

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }
    if (role && role !== 'all') {
      const roles = String(role)
        .split(',')
        .map((r) => normalizeRole(r.trim()))
        .filter(Boolean);
      if (roles.length === 1) filter.role = roles[0];
      else if (roles.length > 1) filter.role = { $in: roles };
    }
    if (status && status !== 'all') filter.status = status.toUpperCase();

    if (actorIsCafeteriaAdmin) {
      // Cafeteria admins may only see operational staff in their own cafeteria.
      if (filter.role) {
        const requested = Array.isArray(filter.role.$in) ? filter.role.$in : [filter.role];
        const allowed = requested.filter((r) => CAFETERIA_OPERATIONAL_ROLES.includes(r));
        if (allowed.length === 0) {
          return res.status(HTTP_STATUS.OK).json({ success: true, count: 0, total: 0, page: 1, pages: 0, users: [] });
        }
        filter.role = allowed.length === 1 ? allowed[0] : { $in: allowed };
      } else {
        filter.role = { $in: CAFETERIA_OPERATIONAL_ROLES };
      }
      if (req.user.cafeteriaId) filter.cafeteriaId = req.user.cafeteriaId;
    }

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const users = await User.find(filter).select('-password').sort({ createdAt: -1 }).skip(skip).limit(limitNum);
    const total = await User.countDocuments(filter);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: users.length,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      users: users.map(sanitizeUser),
    });
  } catch (error) {
    console.error('❌ Get All Users Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get single user by ID (Admin only)
 * @route   GET /api/v1/admin/users/:id
 * @access  Private/Admin
 */
exports.getUserById = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid user id' });
    }
    const user = await User.findById(req.params.id).select('-password');
    if (!user) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'User not found' });
    }
    if (normalizeRole(req.user.role) === 'cafeteria_admin') {
      if (!CAFETERIA_OPERATIONAL_ROLES.includes(normalizeRole(user.role))) {
        return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'You do not have permission to view this user' });
      }
      if (req.user.cafeteriaId && String(user.cafeteriaId) !== String(req.user.cafeteriaId)) {
        return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: 'You do not have permission to view this user' });
      }
    }
    res.status(HTTP_STATUS.OK).json({ success: true, user: sanitizeUser(user) });
  } catch (error) {
    console.error('❌ Get User By ID Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * Create ONE user account. This is the single creation path in the system:
 * `POST /admin/users` and `POST /deliveries/staff` both call it, so staff
 * accounts are always built the same way and always go through the existing
 * User model (whose pre-save hook bcrypt-hashes the password).
 *
 * Rejects with an Error carrying `.statusCode` so each caller can map it to
 * the right response without duplicating the rules.
 *
 * @param {object} req            Express request (supplies the actor identity)
 * @param {object} payload
 * @param {string} payload.name
 * @param {string} payload.email
 * @param {string} payload.phone
 * @param {string} payload.password
 * @param {string} [payload.username]
 * @param {string} [payload.role]         target role; permission-checked
 * @param {string} [payload.status]       'ACTIVE' | 'BLOCKED' | 'SUSPENDED'
 * @param {number} [payload.balance]
 * @param {*}      [payload.cafeteriaId]  honoured for global admins only
 * @param {string} [payload.forcedCafeteriaId] server-resolved cafeteria that
 *        always wins (used by cafeteria-scoped actors so a client can never
 *        place a new hire in someone else's cafeteria)
 * @returns {Promise<object>} the created User document
 */
async function createUserRecord(req, payload) {
  const { name, email, phone, username, role, status, balance, password, cafeteriaId, forcedCafeteriaId } = payload;

  if (!name || !email || !phone || !role || !password) {
    const error = new Error('Name, email, phone, role, and password are required');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    const error = new Error('Please provide a valid email address');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }
  if (!phoneRegex.test(phone)) {
    const error = new Error('Enter a valid phone number (09XXXXXXXX or 07XXXXXXXX)');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }
  // The User schema requires at least 8 characters. Enforcing it here returns a
  // clear 400 instead of letting a short password fail the schema and surface
  // as a 500.
  if (typeof password !== 'string' || password.length < 8) {
    const error = new Error('Password must be at least 8 characters');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }
  const normalizedRole = normalizeRole(role);
  if (!ROLES.includes(normalizedRole)) {
    const error = new Error(`Invalid role. Allowed: ${ROLES.join(', ')}`);
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }

  if (!canManageUser(req.user.role, normalizedRole, normalizedRole)) {
    const error = new Error('You do not have permission to create users with this role');
    error.statusCode = HTTP_STATUS.FORBIDDEN;
    throw error;
  }

  const normalizedUsername = username ? String(username).trim() : null;
  const clash = { $or: [{ email: email.toLowerCase() }, { phone }] };
  if (normalizedUsername) clash.$or.push({ username: normalizedUsername });

  const existingUser = await User.findOne(clash);
  if (existingUser) {
    const error = new Error(
      existingUser.email === email.toLowerCase()
        ? 'User with this email already exists'
        : existingUser.phone === phone
          ? 'User with this phone already exists'
          : 'User with this username already exists'
    );
    error.statusCode = HTTP_STATUS.CONFLICT;
    throw error;
  }

  const resolvedCafeteriaId =
    forcedCafeteriaId !== undefined
      ? forcedCafeteriaId
      : resolveAssignableCafeteriaId(req, cafeteriaId, normalizedRole);

  const user = await User.create({
    name: name.trim(),
    email: email.toLowerCase(),
    phone,
    username: normalizedUsername || undefined,
    password,
    role: normalizedRole,
    cafeteriaId: resolvedCafeteriaId,
    balance: balance || 0,
    status: status || 'ACTIVE',
    isActive: status ? status === 'ACTIVE' : true,
  });

  await logAction({
    req,
    action: 'USER_CREATED',
    entityType: 'User',
    entityId: String(user._id),
    description: `Created ${normalizedRole} user "${name.trim()}" (${email.toLowerCase()})`,
    cafeteriaId: resolvedCafeteriaId,
  });

  return user;
}

/**
 * Map a creation failure onto an HTTP response. `validateError` is the first
 * schema-level message (e.g. a too-short password) so the form can show it.
 */
function respondToCreateUserError(res, error, logLabel) {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ success: false, error: error.message });
  }
  console.error(`❌ ${logLabel} Error:`, error);
  if (error.code === 11000) {
    return res
      .status(HTTP_STATUS.CONFLICT)
      .json({ success: false, error: 'User with this email, phone or username already exists' });
  }
  if (error.name === 'ValidationError') {
    const first = Object.values(error.errors || {})[0];
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ success: false, error: first ? first.message : MESSAGES.SERVER_ERROR });
  }
  return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
}

/**
 * @desc    Create new user (Admin only)
 * @route   POST /api/v1/admin/users
 * @access  Private/Admin
 * Body: { name, email, phone, role, balance, password }
 * Flow: validate input -> check duplicates -> hash password (bcrypt pre-save) -> save
 */
exports.createUser = async (req, res) => {
  try {
    const user = await createUserRecord(req, req.body);
    res.status(HTTP_STATUS.CREATED).json({ success: true, user: sanitizeUser(user) });
  } catch (error) {
    respondToCreateUserError(res, error, 'Create User');
  }
};

// Shared with the delivery-staff endpoint so there is exactly one way to
// create an account in this system.
exports.createUserRecord = createUserRecord;
exports.sanitizeUser = sanitizeUser;
exports.respondToCreateUserError = respondToCreateUserError;

/**
 * Validate that a role change is allowed (admin self-protection).
 * Throws an Error with .statusCode on violation.
 */
async function assertRoleChangeAllowed(user, newRole) {
  if (!ROLES.includes(newRole)) {
    const error = new Error(`Invalid role. Allowed: ${ROLES.join(', ')}`);
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }

  const wasAdmin = isAdminRole(user.role);
  const willBeAdmin = isAdminRole(newRole);

  if (wasAdmin && !willBeAdmin) {
    const activeAdminCount = await countActiveAdmins();
    if (activeAdminCount <= 1) {
      const error = new Error('Cannot remove the role of or deactivate the last active administrator');
      error.statusCode = HTTP_STATUS.BAD_REQUEST;
      throw error;
    }
  }
}

/**
 * @desc    Update user (Admin only)
 * @route   PUT /api/v1/admin/users/:id
 * @access  Private/Admin
 * Body: { name, email, phone, role, balance, password? }
 */
exports.updateUser = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid user id' });
    }

    const { name, email, phone, username, role, status, balance, password, cafeteriaId } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'User not found' });
    }

    const isSelf = String(user._id) === String(req.user.id);
    if (!isSelf) {
      try {
        assertManageAllowed(req.user.role, user.role);
      } catch (error) {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
    }

    if (name !== undefined) {
      if (String(name).trim().length < 2) {
        return res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json({ success: false, error: 'Name must be at least 2 characters' });
      }
      user.name = name.trim();
    }

    if (email !== undefined) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json({ success: false, error: 'Please provide a valid email address' });
      }
      const existing = await User.findOne({ email: email.toLowerCase(), _id: { $ne: user._id } });
      if (existing) {
        return res.status(HTTP_STATUS.CONFLICT).json({ success: false, error: 'User with this email already exists' });
      }
      user.email = email.toLowerCase();
    }

    if (phone !== undefined) {
      if (!phoneRegex.test(phone)) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'Enter a valid phone number (09XXXXXXXX or 07XXXXXXXX)',
        });
      }
      const existing = await User.findOne({ phone, _id: { $ne: user._id } });
      if (existing) {
        return res.status(HTTP_STATUS.CONFLICT).json({ success: false, error: 'User with this phone already exists' });
      }
      user.phone = phone;
    }

    if (username !== undefined) {
      user.username = username || undefined;
    }

    if (status !== undefined) {
      const validStatuses = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'BLOCKED'];
      if (!validStatuses.includes(status)) {
        return res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json({ success: false, error: `Invalid status. Allowed: ${validStatuses.join(', ')}` });
      }
      user.status = status;
      user.isActive = status === 'ACTIVE';
    }

    let previousRole = null;
    let roleChanged = false;
    if (role !== undefined) {
      if (isSelf && isAdminRole(user.role) && !isAdminRole(role)) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'Admins cannot remove their own administrator role',
        });
      }
      const normalizedRole = normalizeRole(role);
      if (!ROLES.includes(normalizedRole)) {
        return res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json({ success: false, error: `Invalid role. Allowed: ${ROLES.join(', ')}` });
      }
      try {
        assertManageAllowed(req.user.role, user.role, normalizedRole);
      } catch (error) {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
      await assertRoleChangeAllowed(user, normalizedRole);
      previousRole = String(user.role);
      roleChanged = previousRole !== String(normalizedRole);
      user.role = normalizedRole;
    }

    if (balance !== undefined) {
      const parsed = Number(balance);
      if (isNaN(parsed) || parsed < 0) {
        return res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json({ success: false, error: 'Balance must be a non-negative number' });
      }
      user.balance = parsed;
    }

    if (password !== undefined && password !== '') {
      if (typeof password !== 'string' || password.length < 6) {
        return res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json({ success: false, error: 'Password must be at least 6 characters' });
      }
      user.password = password; // hashed by User pre-save hook
    }

    if (cafeteriaId !== undefined) {
      const effectiveRole = role !== undefined ? normalizeRole(role) : user.role;
      user.cafeteriaId = resolveAssignableCafeteriaId(req, cafeteriaId, effectiveRole);
    }

    await user.save();

    const changedParts = [];
    if (name !== undefined) changedParts.push('name');
    if (email !== undefined) changedParts.push('email');
    if (phone !== undefined) changedParts.push('phone');
    if (balance !== undefined) changedParts.push('balance');
    if (password !== undefined && password !== '') changedParts.push('password');

    await logAction({
      req,
      action: 'USER_UPDATED',
      entityType: 'User',
      entityId: String(user._id),
      description: `Updated user "${user.name}" - changed: ${changedParts.length ? changedParts.join(', ') : 'details'}`,
    });

    if (roleChanged) {
      await logAction({
        req,
        action: 'ROLE_CHANGED',
        entityType: 'User',
        entityId: String(user._id),
        description: `Changed role of "${user.name}" from ${previousRole} to ${user.role}`,
      });
    }

    res.status(HTTP_STATUS.OK).json({ success: true, user: sanitizeUser(user) });
  } catch (error) {
    console.error('❌ Update User Error:', error);
    if (error.statusCode && error.message) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    if (error.code === 11000) {
      return res
        .status(HTTP_STATUS.CONFLICT)
        .json({ success: false, error: 'User with this email or phone already exists' });
    }
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Assign/change user role (Admin only)
 * @route   PATCH /api/v1/admin/users/:id/role
 * @access  Private/Admin
 * Body: { role }
 */
exports.assignUserRole = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid user id' });
    }

    const { role } = req.body;
    if (!role) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Role is required' });
    }
    const normalizedRole = normalizeRole(role);
    if (!ROLES.includes(normalizedRole)) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ success: false, error: `Invalid role. Allowed: ${ROLES.join(', ')}` });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'User not found' });
    }

    const isSelf = String(user._id) === String(req.user.id);
    if (isSelf && isAdminRole(user.role) && !isAdminRole(normalizedRole)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Admins cannot remove their own administrator role',
      });
    }
    try {
      assertManageAllowed(req.user.role, user.role, normalizedRole);
    } catch (error) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }

    const previousRole = String(user.role);
    await assertRoleChangeAllowed(user, normalizedRole);
    user.role = normalizedRole;
    await user.save();

    await logAction({
      req,
      action: 'ROLE_CHANGED',
      entityType: 'User',
      entityId: String(user._id),
      description: `Changed role of "${user.name}" from ${previousRole} to ${normalizedRole}`,
    });

    res.status(HTTP_STATUS.OK).json({ success: true, user: sanitizeUser(user) });
  } catch (error) {
    console.error('❌ Assign User Role Error:', error);
    if (error.statusCode && error.message) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Delete/deactivate user (Admin only) - soft delete by deactivating
 * @route   DELETE /api/v1/admin/users/:id
 * @access  Private/Admin
 */
exports.deleteUser = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid user id' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'User not found' });
    }

    const isSelf = String(user._id) === String(req.user.id);
    if (!isSelf) {
      try {
        assertManageAllowed(req.user.role, user.role);
      } catch (error) {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
    }

    if (isAdminRole(user.role) && user.status === 'ACTIVE' && user.isActive !== false) {
      const activeAdminCount = await countActiveAdmins();
      if (activeAdminCount <= 1) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'Cannot delete the last active administrator',
        });
      }
    }

    user.status = 'BLOCKED';
    user.isActive = false;
    await user.save();

    await logAction({
      req,
      action: 'USER_DELETED',
      entityType: 'User',
      entityId: String(user._id),
      description: `Deactivated user "${user.name}" (${user.email}) - role: ${user.role}`,
    });

    res
      .status(HTTP_STATUS.OK)
      .json({ success: true, user: sanitizeUser(user), message: 'User deactivated successfully' });
  } catch (error) {
    console.error('❌ Delete User Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Toggle user status / activate-deactivate-suspend (Admin only)
 * @route   PATCH /api/v1/admin/users/:id/status
 * @access  Private/Admin
 * Body: { status: 'ACTIVE' | 'BLOCKED' | 'SUSPENDED' }
 */
exports.toggleUserStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['ACTIVE', 'BLOCKED', 'SUSPENDED'];
    if (!status || !validStatuses.includes(String(status).toUpperCase())) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Invalid status. Must be ACTIVE, BLOCKED, or SUSPENDED',
      });
    }
    if (!isValidObjectId(req.params.id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid user id' });
    }

    const normalizedStatus = String(status).toUpperCase();
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'User not found' });
    }

    const isSelf = String(user._id) === String(req.user.id);
    if (!isSelf) {
      try {
        assertManageAllowed(req.user.role, user.role);
      } catch (error) {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
    }

    if (normalizedStatus !== 'ACTIVE' && isAdminRole(user.role)) {
      if (isSelf) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'Admins cannot deactivate or suspend their own account',
        });
      }
      if (user.status === 'ACTIVE') {
        const activeAdminCount = await countActiveAdmins();
        if (activeAdminCount <= 1) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            error: 'Cannot deactivate or suspend the last active administrator',
          });
        }
      }
    }

    user.status = normalizedStatus;
    user.isActive = normalizedStatus === 'ACTIVE';
    await user.save();

    let actionLabel = 'USER_ACTIVATED';
    let description = `Activated user "${user.name}" (${user.email})`;
    if (normalizedStatus === 'BLOCKED') {
      actionLabel = 'USER_DEACTIVATED';
      description = `Deactivated user "${user.name}" (${user.email})`;
    } else if (normalizedStatus === 'SUSPENDED') {
      actionLabel = 'USER_SUSPENDED';
      description = `Suspended user "${user.name}" (${user.email})`;
    }

    await logAction({
      req,
      action: actionLabel,
      entityType: 'User',
      entityId: String(user._id),
      description,
    });

    res.status(HTTP_STATUS.OK).json({ success: true, user: sanitizeUser(user) });
  } catch (error) {
    console.error('❌ Toggle User Status Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get user statistics (Admin only)
 * @route   GET /api/v1/admin/users/stats
 * @access  Private/Admin
 */
exports.getUserStats = async (req, res) => {
  try {
    const actorIsCafeteriaAdmin = normalizeRole(req.user.role) === 'cafeteria_admin';
    const baseFilter = actorIsCafeteriaAdmin
      ? { role: { $in: CAFETERIA_OPERATIONAL_ROLES }, ...(req.user.cafeteriaId ? { cafeteriaId: req.user.cafeteriaId } : {}) }
      : {};

    const totalUsers = await User.countDocuments(baseFilter);
    const activeCustomers = actorIsCafeteriaAdmin
      ? 0
      : await User.countDocuments({ ...baseFilter, role: 'customer', status: 'ACTIVE', isActive: true });
    const staffCount = await User.countDocuments({ ...baseFilter, role: { $in: ['kitchen', 'admin'] } });
    const blockedCount = await User.countDocuments({ ...baseFilter, status: 'BLOCKED', isActive: false });
    const suspendedCount = await User.countDocuments({ ...baseFilter, status: 'SUSPENDED' });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: { totalUsers, activeCustomers, staffCount, blockedCount, suspendedCount },
    });
  } catch (error) {
    console.error('❌ Get User Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Reset a user's password (Admin only)
 * @route   PATCH /api/v1/admin/users/:id/password
 * @access  Private/Admin
 * Body: { password }
 */
exports.resetUserPassword = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid user id' });
    }

    const { password } = req.body;
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Password must be at least 6 characters',
      });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'User not found' });
    }

    const isSelf = String(user._id) === String(req.user.id);
    if (!isSelf) {
      try {
        assertManageAllowed(req.user.role, user.role);
      } catch (error) {
        return res.status(error.statusCode).json({ success: false, error: error.message });
      }
    }

    user.password = password;
    await user.save();

    await logAction({
      req,
      action: 'PASSWORD_RESET',
      entityType: 'User',
      entityId: String(user._id),
      description: `Admin reset password for user "${user.name}" (${user.email})`,
    });

    res.status(HTTP_STATUS.OK).json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    console.error('❌ Reset User Password Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};
