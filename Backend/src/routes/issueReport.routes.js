const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  createIssueReport,
  listIssueReports,
  getIssueReport,
  reviewIssueReport,
  sendIssueSolution,
  investigateIssueReport,
  sendAdminRequest,
} = require('../controllers/issueReport.controller');

// ============================================================
// ALL ROUTES REQUIRE AUTHENTICATION
// ============================================================
router.use(protect);

// Kitchen-side roles (aliases normalize to "kitchen" in protect).
const KITCHEN_ROLES = ['kitchen', 'kitchen_staff', 'staff', 'foodmaker'];
// Management roles that may view/respond (aliases normalize to "manager").
const VIEW_ROLES = [
  ...KITCHEN_ROLES,
  'manager',
  'cafeteria_manager',
  'cafeteria_admin',
  'admin',
  'system_admin',
];
// Review actions (review / investigate notes / send admin request) stay
// available to the manager.
const REVIEW_ROLES = ['manager', 'cafeteria_manager', 'cafeteria_admin', 'admin', 'system_admin'];
// Resolution (REQUEST_SENT → RESOLVED) is restricted to cafeteria/system admins:
// the Cafeteria Manager may investigate and request fixes but never close a
// report. Enforced here so direct API calls with a manager JWT get 403.
const RESOLVER_ROLES = ['cafeteria_admin', 'admin', 'system_admin'];

/**
 * @route   POST /api/v1/issues
 * @desc    Kitchen Staff creates an issue report (OPEN)
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/issues.html → Report Issue
 * Body: { title, description, category, priority }
 * reporter + cafeteria are stamped from the authenticated JWT (never the body).
 */
router.post('/', authorize(...KITCHEN_ROLES), createIssueReport);

/**
 * @route   GET /api/v1/issues
 * @desc    List issue reports, scoped by role:
 *          kitchen → own reports; manager → own cafeteria; admin → all
 * @access  Private/Kitchen, Private/Manager, Private/Admin
 * Query Params: status (OPEN | UNDER_REVIEW | REQUEST_SENT | RESOLVED)
 */
router.get('/', authorize(...VIEW_ROLES), listIssueReports);

/**
 * @route   GET /api/v1/issues/:id
 * @desc    Get a single issue report with role/cafeteria enforcement
 * @access  Private
 */
router.get('/:id', authorize(...VIEW_ROLES), getIssueReport);

/**
 * @route   PATCH /api/v1/issues/:id/review
 * @desc    Cafeteria Manager reviews a report (OPEN → UNDER_REVIEW) and
 *          records investigation notes. Required before sending a request.
 * @access  Private/Manager, Private/Admin
 * Body: { notes, itemId? }
 */
router.patch('/:id/review', authorize(...REVIEW_ROLES), reviewIssueReport);

/**
 * @route   PATCH /api/v1/issues/:id/request-admin
 * @desc    Cafeteria Manager submits a ResolutionRequest to the Cafeteria
 *          Admin (UNDER_REVIEW → REQUEST_SENT). Creates a ResolutionRequest
 *          record with status PENDING.
 * @access  Private/Manager, Private/Admin
 * Body: { requestedAction, itemId? }
 */
router.patch('/:id/request-admin', authorize(...REVIEW_ROLES), sendAdminRequest);

/**
 * @route   PATCH /api/v1/issues/:id/solution
 * @desc    Cafeteria Admin sends a solution (REQUEST_SENT → RESOLVED).
 *          The Cafeteria Manager is deliberately NOT allowed to resolve:
 *          managers investigate and submit restock requests, admins close
 *          the report with recorded notes, admin id and timestamp.
 * @access  Private/Cafeteria Admin, Private/Admin
 * Body: { resolutionReason, resolutionSolution, ... }
 */
router.patch('/:id/solution', authorize(...RESOLVER_ROLES), sendIssueSolution);

/**
 * @route   PATCH /api/v1/issues/:id/investigate
 * @desc    Cafeteria Manager (or an admin) updates investigation notes and
 *          optionally links the affected menu item. Does not change the
 *          report status (already UNDER_REVIEW).
 * @access  Private/Manager, Private/Admin
 * Body: { notes, itemId? }
 */
router.patch('/:id/investigate', authorize(...REVIEW_ROLES), investigateIssueReport);

module.exports = router;
