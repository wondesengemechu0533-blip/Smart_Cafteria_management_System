const Table = require('../models/Table');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');
const { getDefaultCafeteriaId } = require('../utils/cafeteria');

/**
 * @desc    List tables a customer may currently dine at
 * @route   GET /api/v1/tables/available
 * @access  Private (any authenticated customer)
 *
 * Only tables that are BOTH enabled (isActive !== false) and still in the
 * 'available' status are returned, so occupied / reserved / maintenance tables
 * never appear in the checkout picker. The list is scoped to the default
 * cafeteria, and legacy rows with no cafeteriaId are kept for backward
 * compatibility (they predate multi-cafeteria support).
 */
exports.getAvailableTables = async (req, res) => {
  try {
    const cafeteriaId = await getDefaultCafeteriaId();

    const filter = { isActive: { $ne: false }, status: 'available' };
    if (cafeteriaId) {
      // { field: null } also matches documents where the field is missing, so
      // this includes legacy tables that were created before cafeteriaId existed.
      filter.$or = [{ cafeteriaId }, { cafeteriaId: null }];
    }

    const tables = await Table.find(filter).sort({ tableNumber: 1 });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: tables.length,
      tables: tables.map((table) => ({
        id: table._id,
        tableNumber: table.tableNumber,
        seats: table.seats,
        zone: table.zone,
        status: table.status,
      })),
    });
  } catch (error) {
    console.error('❌ Get Available Tables Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};
