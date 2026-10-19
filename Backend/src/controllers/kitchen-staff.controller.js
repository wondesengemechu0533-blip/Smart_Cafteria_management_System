const KitchenShift = require('../models/KitchenShift');
const User = require('../models/User');
const Order = require('../models/Order');
const Notification = require('../models/Notification');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');

// ============================================================
// KITCHEN SHIFT MANAGEMENT (Admin & Kitchen)
// ============================================================

/**
 * @desc    Get all kitchen shifts with filters
 * @route   GET /api/kitchen-staff/shifts
 * @access  Private/Admin or Kitchen
 *
 * Query Params: status, staffId, date
 * Response: { success, count, shifts: [...] }
 */
exports.getKitchenShifts = async (req, res) => {
  try {
    const { status, staffId, date } = req.query;

    let filter = {};
    if (status) filter.status = status;
    // Kitchen staff always see only their own shifts (the schedule page only
    // offers clock-in on own shifts anyway). Managers/admins may filter by
    // staffId or see the full roster.
    if (req.user && req.user.role === 'kitchen') {
      filter.staffId = req.user.id;
    } else if (staffId) {
      filter.staffId = staffId;
    }

    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);
      filter.startTime = { $gte: startDate, $lte: endDate };
    }

    const shifts = await KitchenShift.find(filter).populate('staffId', 'name email phone').sort({ startTime: -1 });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: shifts.length,
      shifts: shifts.map((shift) => formatShift(shift)),
    });
  } catch (error) {
    console.error('❌ Get Kitchen Shifts Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Create a new kitchen shift
 * @route   POST /api/kitchen-staff/shifts
 * @access  Private/Admin
 *
 * Body: { staffId, shiftType, startTime, endTime }
 * Response: { success, message, shift }
 */
exports.createKitchenShift = async (req, res) => {
  try {
    const { staffId, shiftType, startTime, endTime } = req.body;

    // Validate staff exists and has kitchen role
    const staff = await User.findById(staffId);
    if (!staff) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Staff member not found',
      });
    }

    if (staff.role !== 'kitchen' && staff.role !== 'KITCHEN_STAFF') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'User is not a kitchen staff member',
      });
    }

    // Check for conflicting shifts
    const existingShift = await KitchenShift.findOne({
      staffId: staffId,
      status: { $in: ['scheduled', 'active'] },
      $or: [
        { startTime: { $lt: new Date(endTime), $gte: new Date(startTime) } },
        { endTime: { $lt: new Date(endTime), $gte: new Date(startTime) } },
      ],
    });

    if (existingShift) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Staff member has a conflicting shift at this time',
      });
    }

    // Create shift
    const shift = await KitchenShift.create({
      staffId: staffId,
      shiftType: shiftType || 'custom',
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      status: 'scheduled',
    });

    await shift.populate('staffId', 'name email phone');

    // Notify staff member
    await Notification.create({
      userId: staffId,
      title: 'Shift Scheduled',
      message: `Your ${shiftType} shift has been scheduled from ${new Date(startTime).toLocaleTimeString()} to ${new Date(endTime).toLocaleTimeString()}`,
      type: 'shift',
      isRead: false,
    });

    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      message: 'Kitchen shift created successfully',
      shift: formatShift(shift),
    });
  } catch (error) {
    console.error('❌ Create Kitchen Shift Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Clock in for a shift
 * @route   PATCH /api/kitchen-staff/shifts/:shiftId/clock-in
 * @access  Private/Kitchen
 *
 * Response: { success, message, shift }
 */
exports.clockInShift = async (req, res) => {
  try {
    const { shiftId } = req.params;

    const shift = await KitchenShift.findById(shiftId);
    if (!shift) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Shift not found',
      });
    }

    // Verify staff member. `protect` sets `req.user.id`; there is no `_id` here,
    // so `req.user._id` would throw and lock the staff member out of their shift.
    if (shift.staffId.toString() !== req.user.id.toString()) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'You can only clock in for your own shift',
      });
    }

    if (shift.status !== 'scheduled') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Cannot clock in for a shift with status: ${shift.status}`,
      });
    }

    shift.clockInTime = new Date();
    shift.status = 'active';
    await shift.save();

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Clocked in successfully',
      shift: formatShift(shift),
    });
  } catch (error) {
    console.error('❌ Clock In Shift Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Clock out from a shift
 * @route   PATCH /api/kitchen-staff/shifts/:shiftId/clock-out
 * @access  Private/Kitchen
 *
 * Response: { success, message, shift }
 */
exports.clockOutShift = async (req, res) => {
  try {
    const { shiftId } = req.params;

    const shift = await KitchenShift.findById(shiftId);
    if (!shift) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Shift not found',
      });
    }

    // Verify staff member. `protect` sets `req.user.id`; there is no `_id` here,
    // so `req.user._id` would throw and lock the staff member out of their shift.
    if (shift.staffId.toString() !== req.user.id.toString()) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'You can only clock out from your own shift',
      });
    }

    if (shift.status !== 'active') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Cannot clock out from an inactive shift',
      });
    }

    shift.clockOutTime = new Date();
    shift.status = 'completed';

    // Calculate performance metrics
    const ordersCompleted = await Order.countDocuments({
      kitchenStaffAssigned: shift.staffId,
      completedTime: {
        $gte: shift.clockInTime,
        $lte: shift.clockOutTime,
      },
    });

    shift.ordersCompleted = ordersCompleted;

    // Calculate average preparation time
    const completedOrders = await Order.find({
      kitchenStaffAssigned: shift.staffId,
      completedTime: {
        $gte: shift.clockInTime,
        $lte: shift.clockOutTime,
      },
    });

    if (completedOrders.length > 0) {
      const totalTime = completedOrders.reduce((sum, order) => {
        const prepTime = (order.completedTime - order.orderTime) / 60000; // in minutes
        return sum + prepTime;
      }, 0);
      shift.averagePreparationTime = Math.round(totalTime / completedOrders.length);
    }

    await shift.save();

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Clocked out successfully',
      shift: formatShift(shift),
    });
  } catch (error) {
    console.error('❌ Clock Out Shift Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Start a break during shift
 * @route   PATCH /api/kitchen-staff/shifts/:shiftId/break/start
 * @access  Private/Kitchen
 *
 * Body: { reason }
 * Response: { success, message, shift }
 */
exports.startBreak = async (req, res) => {
  try {
    const { shiftId } = req.params;
    const { reason } = req.body;

    const shift = await KitchenShift.findById(shiftId);
    if (!shift) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Shift not found',
      });
    }

    if (shift.status !== 'active') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Can only take breaks during active shifts',
      });
    }

    // Add break record
    shift.breaksStarted.push({
      startTime: new Date(),
      endTime: null,
      reason: reason || 'Break',
    });

    await shift.save();

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Break started',
      shift: formatShift(shift),
    });
  } catch (error) {
    console.error('❌ Start Break Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    End a break during shift
 * @route   PATCH /api/kitchen-staff/shifts/:shiftId/break/end
 * @access  Private/Kitchen
 *
 * Response: { success, message, shift }
 */
exports.endBreak = async (req, res) => {
  try {
    const { shiftId } = req.params;

    const shift = await KitchenShift.findById(shiftId);
    if (!shift) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Shift not found',
      });
    }

    // Find the last break without an end time
    const lastBreak = shift.breaksStarted.find((b) => !b.endTime);
    if (!lastBreak) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'No active break found',
      });
    }

    lastBreak.endTime = new Date();
    await shift.save();

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Break ended',
      shift: formatShift(shift),
    });
  } catch (error) {
    console.error('❌ End Break Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get current shift for logged-in kitchen staff
 * @route   GET /api/v1/kitchen-staff/shifts/current
 * @access  Private/Kitchen
 *
 * Response: { success, shift, reason }
 */
exports.getCurrentShift = async (req, res) => {
  try {
    const staffId = req.user.id;
    const now = new Date();
    const OPEN = ['scheduled', 'active'];

    // WHY this is a ladder and not one query:
    //
    // It used to be a bare
    //     KitchenShift.findOne({ staffId, status: { $in: ['scheduled','active'] } })
    // with NO SORT. An unsorted findOne returns whichever document the engine
    // happens to reach first, and with a full roster every cook has a MORNING,
    // an AFTERNOON and an EVENING shift each day - so the "Current Shift" card
    // rendered one arbitrary row of ~21. In this deployment it consistently came
    // back as `evening`, which is why the kitchen only ever saw the evening
    // shift and morning/afternoon appeared to be missing. The data was always
    // there; nothing selected it.
    //
    // The order below is deterministic and answers the question the card is
    // actually asking ("which shift am I on?").
    const pop = 'staffId';

    // 1. The shift being worked right now.
    const inProgress = await KitchenShift.findOne({
      staffId,
      status: { $in: OPEN },
      startTime: { $lte: now },
      $or: [{ endTime: null }, { endTime: { $gt: now } }],
    }).sort({ startTime: -1 }).populate(pop, 'name email phone');

    // 2. Clocked in without a clock-out - the window may be stale, the badge is
    //    not, so it wins over the next one due.
    const clockedIn = await KitchenShift.findOne({
      staffId,
      clockInTime: { $ne: null },
      clockOutTime: null,
    }).sort({ clockInTime: -1 }).populate(pop, 'name email phone');

    // 3. The next one due.
    const next = await KitchenShift.findOne({
      staffId,
      status: { $in: OPEN },
      startTime: { $gt: now },
    }).sort({ startTime: 1 }).populate(pop, 'name email phone');

    // 4. The most recent finished one, so the card can explain the gap instead
    //    of rendering as though no shift ever existed.
    const last = await KitchenShift.findOne({ staffId })
      .sort({ startTime: -1 }).populate(pop, 'name email phone');

    const shift = clockedIn || inProgress || next || last;
    // String comparison rather than _id.equals(): the rung that answered may be
    // a lean/plain object whose id is not an ObjectId, and `.equals` is a method
    // that only exists on one.
    const sameId = (a, b) => Boolean(a && b) && String(a._id) === String(b._id);
    const reason = shift
      ? (sameId(shift, clockedIn) ? 'clocked_in'
        : sameId(shift, inProgress) ? 'in_progress'
        : sameId(shift, next) ? 'upcoming'
        : 'last')
      : 'none';

    if (!shift) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: true,
        shift: null,
        dayShifts: [],
        reason,
        message: 'No shift scheduled',
      });
    }

    // The whole day this cook is on, not just the one row above.
    //
    // Every cook is scheduled morning + afternoon + evening, so a card that
    // renders one shift hides two thirds of the working day. This is resolved
    // HERE rather than in the browser because only the server knows which
    // account is asking - /kitchen-staff/shifts returns EVERY cook's shifts,
    // so grouping it client-side showed four of each. The day is chosen from
    // the shift selected above, falling back to today.
    const focusDay = shift.startTime
      ? new Date(shift.startTime)
      : new Date();
    const dayStart = new Date(focusDay);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(focusDay);
    dayEnd.setHours(23, 59, 59, 999);

    const SHIFT_TYPE_ORDER = ['morning', 'afternoon', 'evening', 'night', 'custom'];
    const dayRows = await KitchenShift.find({
      staffId,
      startTime: { $gte: dayStart, $lte: dayEnd },
    })
      .populate(pop, 'name email phone')
      .lean();

    dayRows.sort((a, b) => {
      const ai = SHIFT_TYPE_ORDER.indexOf(String(a.shiftType || '').toLowerCase());
      const bi = SHIFT_TYPE_ORDER.indexOf(String(b.shiftType || '').toLowerCase());
      if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      return new Date(a.startTime) - new Date(b.startTime);
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      shift: formatShift(shift),
      dayShifts: dayRows.map(formatShift),
      // Local calendar day (toISOString() would shift local midnight back a
      // day in positive-offset timezones like UTC+3).
      day: `${dayStart.getFullYear()}-${String(dayStart.getMonth() + 1).padStart(2, '0')}-${String(dayStart.getDate()).padStart(2, '0')}`,
      reason,
    });
  } catch (error) {
    console.error('❌ Get Current Shift Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get all kitchen staff members
 * @route   GET /api/kitchen-staff/members
 * @access  Private/Admin
 *
 * Response: { success, count, staff: [...] }
 */
exports.getKitchenStaffMembers = async (req, res) => {
  try {
    const staffMembers = await User.find({
      role: { $in: ['kitchen', 'KITCHEN_STAFF'] },
    }).select('-password');

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: staffMembers.length,
      staff: staffMembers,
    });
  } catch (error) {
    console.error('❌ Get Kitchen Staff Members Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function formatShift(shift) {
  return {
    // `_id` as well as `id`: the schedule page builds its Clock In / Clock Out
    // buttons from `shift._id`, so returning only `id` made every button POST to
    // /kitchen-staff/shifts/undefined/clock-in. `id` stays for existing callers.
    _id: shift._id,
    id: shift._id,
    staff: {
      id: shift.staffId?._id,
      name: shift.staffId?.name,
      email: shift.staffId?.email,
      phone: shift.staffId?.phone,
    },
    shiftType: shift.shiftType,
    startTime: shift.startTime,
    endTime: shift.endTime,
    status: shift.status,
    clockInTime: shift.clockInTime,
    clockOutTime: shift.clockOutTime,
    breaksStarted: shift.breaksStarted,
    ordersAssigned: shift.ordersAssigned,
    ordersCompleted: shift.ordersCompleted,
    averagePreparationTime: shift.averagePreparationTime,
    notes: shift.notes,
    createdAt: shift.createdAt,
  };
}

module.exports = exports;
