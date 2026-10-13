const mongoose = require('mongoose');
const Cafeteria = require('../models/Cafeteria');
const User = require('../models/User');
const { HTTP_STATUS, MESSAGES } = require('../config/constants');
const { isAdminRole } = require('../config/roles');
const { getDefaultCafeteriaId } = require('../utils/cafeteria');
const { logAction } = require('../utils/audit');

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

function sanitizeCafeteria(c) {
  return {
    id: c._id,
    name: c.name,
    code: c.code,
    address: c.address,
    phone: c.phone,
    email: c.email,
    status: c.status,
    isDefault: c.isDefault,
    openingTime: c.openingTime,
    closingTime: c.closingTime,
    createdAt: c.createdAt,
  };
}

/**
 * @desc    List cafeterias
 *          - system/admin: all cafeterias (for assignment dropdowns)
 *          - cafeteria-scoped roles: only their own cafeteria
 * @route   GET /api/v1/cafeterias
 * @access  Private (admin-oriented roles)
 */
exports.getCafeterias = async (req, res) => {
  try {
    const isGlobalAdmin = isAdminRole(req.user.role);
    const filter = isGlobalAdmin ? {} : { _id: req.user.cafeteriaId || null };

    const cafeterias = await Cafeteria.find(filter).sort({ isDefault: -1, name: 1 });
    res
      .status(HTTP_STATUS.OK)
      .json({ success: true, count: cafeterias.length, cafeterias: cafeterias.map(sanitizeCafeteria) });
  } catch (error) {
    console.error('❌ Get Cafeterias Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get the cafeteria assigned to the authenticated user
 * @route   GET /api/v1/cafeterias/mine
 * @access  Private
 */
exports.getMyCafeteria = async (req, res) => {
  try {
    if (!req.user.cafeteriaId) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'No cafeteria assigned to your account' });
    }
    const cafeteria = await Cafeteria.findById(req.user.cafeteriaId);
    if (!cafeteria) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Cafeteria not found' });
    }
    res.status(HTTP_STATUS.OK).json({ success: true, cafeteria: sanitizeCafeteria(cafeteria) });
  } catch (error) {
    console.error('❌ Get My Cafeteria Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Create a cafeteria
 * @route   POST /api/v1/cafeterias
 * @access  Private/System Admin
 * Body: { name, code, address, phone, email, openingTime, closingTime }
 */
exports.createCafeteria = async (req, res) => {
  try {
    if (!isAdminRole(req.user.role)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'Only system administrators can create cafeterias' });
    }

    const { name, code, address, phone, email, openingTime, closingTime } = req.body;
    if (!name || String(name).trim().length < 2) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Cafeteria name is required' });
    }

    const normalizedCode = code ? String(code).trim().toUpperCase() : undefined;
    if (normalizedCode) {
      const existing = await Cafeteria.findOne({ code: normalizedCode });
      if (existing) {
        return res
          .status(HTTP_STATUS.CONFLICT)
          .json({ success: false, error: 'A cafeteria with this code already exists' });
      }
    }

    const cafeteria = await Cafeteria.create({
      name: String(name).trim(),
      code: normalizedCode,
      address,
      phone,
      email: email ? String(email).toLowerCase() : undefined,
      openingTime,
      closingTime,
      createdBy: req.user.id,
    });

    await logAction({
      req,
      action: 'CAFETERIA_CREATED',
      entityType: 'Cafeteria',
      entityId: String(cafeteria._id),
      description: `Created cafeteria "${cafeteria.name}"${cafeteria.code ? ` (${cafeteria.code})` : ''}`,
      cafeteriaId: cafeteria._id,
    });

    res.status(HTTP_STATUS.CREATED).json({ success: true, cafeteria: sanitizeCafeteria(cafeteria) });
  } catch (error) {
    console.error('❌ Create Cafeteria Error:', error);
    if (error.code === 11000) {
      return res
        .status(HTTP_STATUS.CONFLICT)
        .json({ success: false, error: 'A cafeteria with this code already exists' });
    }
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Update a cafeteria
 * @route   PUT /api/v1/cafeterias/:id
 * @access  Private/System Admin
 */
exports.updateCafeteria = async (req, res) => {
  try {
    if (!isAdminRole(req.user.role)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'Only system administrators can update cafeterias' });
    }
    if (!isValidObjectId(req.params.id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid cafeteria id' });
    }

    const cafeteria = await Cafeteria.findById(req.params.id);
    if (!cafeteria) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Cafeteria not found' });
    }

    const { name, code, address, phone, email, status, openingTime, closingTime } = req.body;

    if (name !== undefined) {
      if (String(name).trim().length < 2) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Cafeteria name is required' });
      }
      cafeteria.name = String(name).trim();
    }
    if (code !== undefined) {
      const normalizedCode = code ? String(code).trim().toUpperCase() : undefined;
      if (normalizedCode) {
        const existing = await Cafeteria.findOne({ code: normalizedCode, _id: { $ne: cafeteria._id } });
        if (existing) {
          return res
            .status(HTTP_STATUS.CONFLICT)
            .json({ success: false, error: 'A cafeteria with this code already exists' });
        }
      }
      cafeteria.code = normalizedCode;
    }
    if (address !== undefined) cafeteria.address = address;
    if (phone !== undefined) cafeteria.phone = phone;
    if (email !== undefined) cafeteria.email = email ? String(email).toLowerCase() : undefined;
    if (openingTime !== undefined) cafeteria.openingTime = openingTime;
    if (closingTime !== undefined) cafeteria.closingTime = closingTime;
    if (status !== undefined) {
      if (!['ACTIVE', 'INACTIVE'].includes(status)) {
        return res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json({ success: false, error: 'Invalid status. Allowed: ACTIVE, INACTIVE' });
      }
      cafeteria.status = status;
    }

    await cafeteria.save();

    await logAction({
      req,
      action: 'CAFETERIA_UPDATED',
      entityType: 'Cafeteria',
      entityId: String(cafeteria._id),
      description: `Updated cafeteria "${cafeteria.name}"`,
      cafeteriaId: cafeteria._id,
    });

    res.status(HTTP_STATUS.OK).json({ success: true, cafeteria: sanitizeCafeteria(cafeteria) });
  } catch (error) {
    console.error('❌ Update Cafeteria Error:', error);
    if (error.code === 11000) {
      return res
        .status(HTTP_STATUS.CONFLICT)
        .json({ success: false, error: 'A cafeteria with this code already exists' });
    }
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Staff count per cafeteria (system admin overview)
 * @route   GET /api/v1/cafeterias/:id/stats
 * @access  Private/System Admin
 */
exports.getCafeteriaStats = async (req, res) => {
  try {
    if (!isAdminRole(req.user.role)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'Only system administrators can view cafeteria stats' });
    }
    if (!isValidObjectId(req.params.id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid cafeteria id' });
    }

    const staffUsers = await User.countDocuments({ cafeteriaId: req.params.id });
    res.status(HTTP_STATUS.OK).json({ success: true, stats: { staffUsers } });
  } catch (error) {
    console.error('❌ Get Cafeteria Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Ensure a default cafeteria exists (idempotent bootstrap)
 * @route   POST /api/v1/cafeterias/bootstrap
 * @access  Private/System Admin
 */
exports.bootstrapDefaultCafeteria = async (req, res) => {
  try {
    if (!isAdminRole(req.user.role)) {
      return res
        .status(HTTP_STATUS.FORBIDDEN)
        .json({ success: false, error: 'Only system administrators can bootstrap cafeterias' });
    }
    const id = await getDefaultCafeteriaId();
    const cafeteria = await Cafeteria.findById(id);
    res.status(HTTP_STATUS.OK).json({ success: true, cafeteria: cafeteria ? sanitizeCafeteria(cafeteria) : null });
  } catch (error) {
    console.error('❌ Bootstrap Cafeteria Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};
