const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  createIssueReport,
  listIssueReports,
  getIssueReport,
  acceptIssueReport,
  sendIssueSolution,
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

/**
 * @route   POST /api/v1/issues
 * @desc    Kitchen Staff creates an issue report (PENDING)
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
 * Query Params: status (PENDING | ACCEPTED | RESOLVED)
 */
router.get('/', authorize(...VIEW_ROLES), listIssueReports);

/**
 * @route   GET /api/v1/issues/:id
 * @desc    Get a single issue report with role/cafeteria enforcement
 * @access  Private
 */
router.get('/:id', authorize(...VIEW_ROLES), getIssueReport);

/**
 * @route   PATCH /api/v1/issues/:id/accept
 * @desc    Cafeteria Manager accepts a report (PENDING → ACCEPTED)
 * @access  Private/Manager
 */
router.patch('/:id/accept', authorize('manager', 'cafeteria_manager'), acceptIssueReport);

/**
 * @route   PATCH /api/v1/issues/:id/solution
 * @desc    Cafeteria Manager sends a solution (ACCEPTED → RESOLVED)
 * @access  Private/Manager
 * Body: { solution }
 */
router.patch('/:id/solution', authorize('manager', 'cafeteria_manager'), sendIssueSolution);

module.exports = router;
