const Table = require('../models/Table');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');
const { logAction } = require('../utils/audit');
const { getDefaultCafeteriaId } = require('../utils/cafeteria');

function serialize(table) {
  return {
    id: table._id,
    tableNumber: table.tableNumber,
    seats: table.seats,
    zone: table.zone,
    status: table.status,
    isActive: table.isActive,
    notes: table.notes,
    createdAt: table.createdAt,
    updatedAt: table.updatedAt,
  };
}

/**
 * @desc    Get all tables (admin) with pagination
 * @route   GET /api/v1/admin/tables
 * @access  Private/Admin
 */
exports.getAllTables = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const filter = {};
    const { search, status } = req.query;
    if (search && String(search).trim()) {
      const term = String(search).trim();
      filter.$or = [
        { tableNumber: { $regex: term, $options: 'i' } },
        { zone: { $regex: term, $options: 'i' } },
        { notes: { $regex: term, $options: 'i' } },
      ];
    }
    if (status !== undefined && status !== '' && status !== 'all') {
      if (status === 'true' || status === 'false') {
        filter.isActive = status === 'true';
      } else {
        filter.status = status;
      }
    }

    const sortMap = {
      number: { tableNumber: 1 },
      seats: { seats: 1 },
      created: { createdAt: -1 },
      updated: { updatedAt: -1 },
    };
    const sort = sortMap[String(req.query.sort || 'number')] || sortMap.number;

    const [tables, total] = await Promise.all([
      Table.find(filter).sort(sort).skip(skip).limit(limit),
      Table.countDocuments(filter),
    ]);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: tables.length,
      total,
      page,
      pages: Math.max(Math.ceil(total / limit), 1),
      tables: tables.map(serialize),
    });
  } catch (error) {
    console.error('❌ Admin Get All Tables Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get table statistics
 * @route   GET /api/v1/admin/tables/stats
 * @access  Private/Admin
 */
exports.getTableStats = async (req, res) => {
  try {
    const [total, active, inactive, available, occupied, reserved, maintenance] = await Promise.all([
      Table.countDocuments(),
      Table.countDocuments({ isActive: true }),
      Table.countDocuments({ isActive: false }),
      Table.countDocuments({ status: 'available' }),
      Table.countDocuments({ status: 'occupied' }),
      Table.countDocuments({ status: 'reserved' }),
      Table.countDocuments({ status: 'maintenance' }),
    ]);
    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: {
        totalTables: total,
        active,
        inactive,
        available,
        occupied,
        reserved,
        maintenance,
      },
    });
  } catch (error) {
    console.error('❌ Admin Get Table Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get single table by ID
 * @route   GET /api/v1/admin/tables/:id
 * @access  Private/Admin
 */
exports.getTableById = async (req, res) => {
  try {
    const table = await Table.findById(req.params.id);
    if (!table) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Table not found' });
    }
    res.status(HTTP_STATUS.OK).json({ success: true, table: serialize(table) });
  } catch (error) {
    console.error('❌ Admin Get Table By ID Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Create table
 * @route   POST /api/v1/admin/tables
 * @access  Private/Admin
 */
exports.createTable = async (req, res) => {
  try {
    const { tableNumber, seats, zone, status, isActive, notes } = req.body || {};
    const cleanNumber = String(tableNumber || '').trim();
    if (!cleanNumber) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Table number is required' });
    }

    const cafeteriaId = req.user.cafeteriaId || (await getDefaultCafeteriaId());
    const existing = await Table.findOne({ cafeteriaId, tableNumber: cleanNumber });
    if (existing) {
      return res.status(HTTP_STATUS.CONFLICT).json({ success: false, error: 'A table with this number already exists' });
    }

    const table = await Table.create({
      cafeteriaId,
      tableNumber: cleanNumber,
      seats: Math.max(parseInt(seats, 10) || 4, 1),
      zone: String(zone || 'Main Hall').trim(),
      status: status || 'available',
      isActive: isActive !== undefined ? isActive : true,
      notes: notes || '',
    });

    await logAction({
      req,
      action: 'TABLE_CREATED',
      entityType: 'Table',
      entityId: String(table._id),
      description: `Created table "${cleanNumber}"`,
    });

    res.status(HTTP_STATUS.CREATED).json({ success: true, table: serialize(table) });
  } catch (error) {
    console.error('❌ Admin Create Table Error:', error);
    if (error.code === 11000) {
      return res.status(HTTP_STATUS.CONFLICT).json({ success: false, error: 'A table with this number already exists' });
    }
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Update table
 * @route   PUT /api/v1/admin/tables/:id
 * @access  Private/Admin
 */
exports.updateTable = async (req, res) => {
  try {
    const { tableNumber, seats, zone, status, isActive, notes } = req.body || {};
    const table = await Table.findById(req.params.id);
    if (!table) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Table not found' });
    }

    if (tableNumber !== undefined && String(tableNumber).trim() !== '') {
      const cleanNumber = String(tableNumber).trim();
      const duplicate = await Table.findOne({
        _id: { $ne: table._id },
        cafeteriaId: table.cafeteriaId,
        tableNumber: cleanNumber,
      });
      if (duplicate) {
        return res.status(HTTP_STATUS.CONFLICT).json({ success: false, error: 'A table with this number already exists' });
      }
      table.tableNumber = cleanNumber;
    }
    if (seats !== undefined) table.seats = Math.max(parseInt(seats, 10) || 1, 1);
    if (zone !== undefined) table.zone = String(zone).trim();
    if (status !== undefined) table.status = status;
    if (isActive !== undefined) table.isActive = isActive;
    if (notes !== undefined) table.notes = notes;

    await table.save();

    await logAction({
      req,
      action: 'TABLE_UPDATED',
      entityType: 'Table',
      entityId: String(table._id),
      description: `Updated table "${table.tableNumber}"`,
    });

    res.status(HTTP_STATUS.OK).json({ success: true, table: serialize(table) });
  } catch (error) {
    console.error('❌ Admin Update Table Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Toggle table active status
 * @route   PATCH /api/v1/admin/tables/:id/status
 * @access  Private/Admin
 */
exports.toggleTableStatus = async (req, res) => {
  try {
    const { isActive } = req.body;
    if (isActive === undefined) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Status is required' });
    }
    const table = await Table.findByIdAndUpdate(req.params.id, { isActive }, { new: true });
    if (!table) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Table not found' });
    }

    await logAction({
      req,
      action: 'TABLE_STATUS_CHANGED',
      entityType: 'Table',
      entityId: String(table._id),
      description: `${isActive ? 'Activated' : 'Deactivated'} table "${table.tableNumber}"`,
    });

    res.status(HTTP_STATUS.OK).json({ success: true, table: serialize(table) });
  } catch (error) {
    console.error('❌ Admin Toggle Table Status Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Delete table
 * @route   DELETE /api/v1/admin/tables/:id
 * @access  Private/Admin
 */
exports.deleteTable = async (req, res) => {
  try {
    const table = await Table.findById(req.params.id);
    if (!table) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Table not found' });
    }
    await Table.findByIdAndDelete(req.params.id);

    await logAction({
      req,
      action: 'TABLE_DELETED',
      entityType: 'Table',
      entityId: String(table._id),
      description: `Deleted table "${table.tableNumber}"`,
    });

    res.status(HTTP_STATUS.OK).json({ success: true, message: 'Table deleted successfully' });
  } catch (error) {
    console.error('❌ Admin Delete Table Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};
