const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  getNotifications,
  getUnreadCount,
  getPreferences,
  updatePreferences,
  markAsRead,
  markAllRead,
  deleteNotification,
  clearAllNotifications,
} = require('../controllers/notification.controller');

// ============================================================
//  ALL ROUTES REQUIRE AUTHENTICATION
// ============================================================
router.use(protect);

/**
 * @route   GET /api/notifications/preferences
 * @desc    Get notification sound preference
 * @access  Private
 */
router.get('/preferences', getPreferences);

/**
 * @route   PUT /api/notifications/preferences
 * @desc    Update notification sound preference
 * @access  Private
 */
router.put('/preferences', updatePreferences);

/**
 * @route   GET /api/notifications
 * @desc    Get user's notifications
 * @access  Private
 * Query Params: unread (true/false)
 */
router.get('/', getNotifications);

/**
 * @route   GET /api/notifications/unread
 * @desc    Get unread notification count
 * @access  Private
 */
router.get('/unread', getUnreadCount);

/**
 * @route   PATCH /api/notifications/read-all
 * @desc    Mark all notifications as read
 * @access  Private
 */
router.patch('/read-all', markAllRead);

/**
 * @route   PATCH /api/notifications/:id/read
 * @desc    Mark notification as read
 * @access  Private
 */
router.patch('/:id/read', markAsRead);

/**
 * @route   DELETE /api/notifications
 * @desc    Delete ALL of the user's notifications (clear all)
 * @access  Private
 */
router.delete('/', clearAllNotifications);

/**
 * @route   DELETE /api/notifications/:id
 * @desc    Delete notification
 * @access  Private
 */
router.delete('/:id', deleteNotification);

module.exports = router;
