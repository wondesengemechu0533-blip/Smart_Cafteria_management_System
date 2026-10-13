const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getKitchenShifts,
  createKitchenShift,
  clockInShift,
  clockOutShift,
  startBreak,
  endBreak,
  getCurrentShift,
  getKitchenStaffMembers,
} = require('../controllers/kitchen-staff.controller');

// ============================================================
// SHIFT MANAGEMENT (Admin & Kitchen Staff)
// ============================================================

/**
 * @route   GET /api/kitchen-staff/shifts
 * @desc    Get all kitchen shifts with filters
 * @access  Private/Admin or Kitchen
 *
 * Query Params: status, staffId, date
 */
router.use(protect);
router.get('/shifts', authorize('admin', 'cafeteria_admin', 'manager', 'kitchen'), getKitchenShifts);

/**
 * @route   GET /api/kitchen-staff/members
 * @desc    Get all kitchen staff members
 * @access  Private/Admin
 */
router.get('/members', authorize('admin', 'cafeteria_admin', 'manager'), getKitchenStaffMembers);

/**
 * @route   POST /api/kitchen-staff/shifts
 * @desc    Create a new kitchen shift
 * @access  Private/Admin
 *
 * Body: { staffId, shiftType, startTime, endTime }
 */
router.post('/shifts', authorize('admin', 'cafeteria_admin', 'manager'), createKitchenShift);

/**
 * @route   GET /api/kitchen-staff/shifts/current
 * @desc    Get current shift for logged-in kitchen staff
 * @access  Private/Kitchen
 */
router.get('/shifts/current', authorize('kitchen'), getCurrentShift);

/**
 * @route   PATCH /api/kitchen-staff/shifts/:shiftId/clock-in
 * @desc    Clock in for a shift
 * @access  Private/Kitchen
 */
router.patch('/shifts/:shiftId/clock-in', authorize('kitchen'), clockInShift);

/**
 * @route   PATCH /api/kitchen-staff/shifts/:shiftId/clock-out
 * @desc    Clock out from a shift
 * @access  Private/Kitchen
 */
router.patch('/shifts/:shiftId/clock-out', authorize('kitchen'), clockOutShift);

/**
 * @route   PATCH /api/kitchen-staff/shifts/:shiftId/break/start
 * @desc    Start a break during shift
 * @access  Private/Kitchen
 *
 * Body: { reason }
 */
router.patch('/shifts/:shiftId/break/start', authorize('kitchen'), startBreak);

/**
 * @route   PATCH /api/kitchen-staff/shifts/:shiftId/break/end
 * @desc    End a break during shift
 * @access  Private/Kitchen
 */
router.patch('/shifts/:shiftId/break/end', authorize('kitchen'), endBreak);

module.exports = router;
