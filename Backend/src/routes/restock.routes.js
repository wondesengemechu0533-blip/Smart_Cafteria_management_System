const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  submitRestockRequest,
  listRestockRequests,
  getRestockRequest,
  cancelRestockRequest,
  reviewRestockRequest,
  recordRestock,
  getOpenRequestForItem,
} = require('../controllers/restock.controller');

// ============================================================
// ALL ROUTES REQUIRE AUTHENTICATION
// ============================================================
router.use(protect);

// Roles that may submit / monitor / cancel restock requests.
const REQUEST_ROLES = ['manager', 'cafeteria_manager'];
// Roles that review requests and record the actual received stock.
const REVIEW_ROLES = ['cafeteria_admin', 'admin', 'system_admin'];

/**
 * @route   POST /api/v1/restocks
 * @desc    Cafeteria Manager submits a restock request to the Cafeteria Admin
 * @access  Private/Manager
 * Body:    { itemId, requestedQuantity, reason, alertId?, issueReportId? }
 */
router.post('/', authorize(...REQUEST_ROLES), submitRestockRequest);

/**
 * @route   GET /api/v1/restocks
 * @desc    List restock requests (manager/admin scoped to their cafeteria)
 * @access  Private/Manager, Private/CafeteriaAdmin
 * Query:   status (PENDING|APPROVED|REJECTED|RESTOCKED|CANCELLED), itemId
 */
router.get('/', authorize(...REQUEST_ROLES, ...REVIEW_ROLES), listRestockRequests);

/**
 * @route   GET /api/v1/restocks/item/:itemId/open
 * @desc    Latest (optionally open) restock request for a menu item
 * @access  Private/Manager, Private/CafeteriaAdmin
 * Query:   open=true → only PENDING/APPROVED
 */
router.get('/item/:itemId/open', authorize(...REQUEST_ROLES, ...REVIEW_ROLES), getOpenRequestForItem);

/**
 * @route   GET /api/v1/restocks/:id
 * @desc    Restock request details
 * @access  Private/Manager, Private/CafeteriaAdmin
 */
router.get('/:id', authorize(...REQUEST_ROLES, ...REVIEW_ROLES), getRestockRequest);

/**
 * @route   POST /api/v1/restocks/:id/cancel
 * @desc    Requesting manager cancels a PENDING restock request
 * @access  Private/Manager
 */
router.post('/:id/cancel', authorize(...REQUEST_ROLES), cancelRestockRequest);

/**
 * @route   PATCH /api/v1/restocks/:id/review
 * @desc    Cafeteria Admin approves or rejects a request (with explanation)
 * @access  Private/CafeteriaAdmin
 * Body:    { decision: 'APPROVED'|'REJECTED', explanation? }
 */
router.patch('/:id/review', authorize(...REVIEW_ROLES), reviewRestockRequest);

/**
 * @route   PATCH /api/v1/restocks/:id/restock
 * @desc    Cafeteria Admin records the ACTUAL quantity received and updates
 *          the item's authoritative stock (atomic $inc + StockTransaction)
 * @access  Private/CafeteriaAdmin
 * Body:    { receivedQuantity, note? }
 */
router.patch('/:id/restock', authorize(...REVIEW_ROLES), recordRestock);

module.exports = router;
