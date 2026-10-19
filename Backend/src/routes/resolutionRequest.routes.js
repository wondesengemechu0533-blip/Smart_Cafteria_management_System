const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  listResolutionRequests,
  getResolutionRequest,
  acceptResolutionRequest,
  rejectResolutionRequest,
  resolveResolutionRequest,
  cancelResolutionRequest,
} = require('../controllers/resolutionRequest.controller');

// ============================================================
// ALL ROUTES REQUIRE AUTHENTICATION
// ============================================================
router.use(protect);

// Roles that may view resolution requests.
const VIEW_ROLES = ['manager', 'cafeteria_manager', 'cafeteria_admin', 'admin', 'system_admin'];
// Admin-only actions (accept / reject / resolve).
const ADMIN_ROLES = ['cafeteria_admin', 'admin', 'system_admin'];
// Manager actions (cancel own PENDING request).
const MANAGER_ROLES = ['manager', 'cafeteria_manager'];

/**
 * @route   GET /api/v1/resolution-requests
 * @desc    List resolution requests, scoped by role:
 *          manager → own cafeteria; admin → own cafeteria (or all for system admin)
 * @access  Private/Manager, Private/Admin
 * Query Params: status (PENDING | IN_PROGRESS | RESOLVED | REJECTED), issueReportId
 */
router.get('/', authorize(...VIEW_ROLES), listResolutionRequests);

/**
 * @route   GET /api/v1/resolution-requests/:id
 * @desc    Get a single resolution request with cafeteria enforcement
 * @access  Private/Manager, Private/Admin
 */
router.get('/:id', authorize(...VIEW_ROLES), getResolutionRequest);

/**
 * @route   PATCH /api/v1/resolution-requests/:id/accept
 * @desc    Cafeteria Admin accepts a request (PENDING → IN_PROGRESS)
 * @access  Private/Cafeteria Admin, Private/Admin
 * Body: { note? }
 */
router.patch('/:id/accept', authorize(...ADMIN_ROLES), acceptResolutionRequest);

/**
 * @route   PATCH /api/v1/resolution-requests/:id/reject
 * @desc    Cafeteria Admin rejects a request (PENDING → REJECTED) with a reason
 * @access  Private/Cafeteria Admin, Private/Admin
 * Body: { reason } (required)
 */
router.patch('/:id/reject', authorize(...ADMIN_ROLES), rejectResolutionRequest);

/**
 * @route   PATCH /api/v1/resolution-requests/:id/resolve
 * @desc    Cafeteria Admin resolves a request (IN_PROGRESS → RESOLVED).
 *          Also marks the linked IssueReport as RESOLVED.
 * @access  Private/Cafeteria Admin, Private/Admin
 * Body: { note? }
 */
router.patch('/:id/resolve', authorize(...ADMIN_ROLES), resolveResolutionRequest);

/**
 * @route   PATCH /api/v1/resolution-requests/:id/cancel
 * @desc    Requesting manager cancels while PENDING. Linked IssueReport
 *          returns to UNDER_REVIEW.
 * @access  Private/Manager
 */
router.patch('/:id/cancel', authorize(...MANAGER_ROLES), cancelResolutionRequest);

module.exports = router;
