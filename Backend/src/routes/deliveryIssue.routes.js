const express = require('express');
const multer = require('multer');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  SYSTEM_ADMIN_ROLES,
  CAFETERIA_ADMIN_ROLES,
  MANAGEMENT_ROLES,
} = require('../config/roles');
const issueController = require('../controllers/deliveryIssue.controller');

/**
 * Delivery Issue routes - a delivery person reporting a problem in progress.
 *
 *   Delivery person : POST /  (report), GET /mine, GET /:id
 *   Management      : GET /, GET /stats, GET /:id,
 *                     PATCH /:id/start | /resolve | /cancel,
 *                     PATCH /:id/hold | /continue | /cancel-delivery
 *   Customer        : GET /order/:orderId  (safe projection only)
 *
 * Every ownership and cafeteria check is performed in the controller against
 * the verified JWT - never from a request body, query string or header. Route
 * middleware narrows the audience; the controller decides whether THIS caller
 * may touch THIS issue.
 */

// Same in-memory handling as the existing admin image upload: files go to
// cloud/local storage, never to a temp directory on the request path.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Invalid image type. Allowed: JPG, JPEG, PNG, WEBP'));
    }
    cb(null, true);
  },
});

const DELIVERY_ROLES = ['delivery', 'DELIVERY_STAFF', 'delivery_staff', 'delivery_person'];
const MANAGER_ROLES = [...new Set([...SYSTEM_ADMIN_ROLES, ...CAFETERIA_ADMIN_ROLES, ...MANAGEMENT_ROLES])];

router.use(protect);

/**
 * @route   GET /api/v1/delivery-issues/meta/types
 * @desc    Issue types + statuses for the report form (no hard-coded list)
 * @access  Private/Delivery + Management
 */
router.get('/meta/types', authorize(...DELIVERY_ROLES, ...MANAGER_ROLES), issueController.getDeliveryIssueMeta);

/**
 * @route   GET /api/v1/delivery-issues/stats
 * @desc    Open / in-progress / resolved counts + holds (dashboard badge)
 * @access  Private/Management
 */
router.get('/stats', authorize(...MANAGER_ROLES), issueController.getDeliveryIssueStats);

/**
 * @route   GET /api/v1/delivery-issues/order/:orderId
 * @desc    Customer-safe delay state for an order
 * @access  Private (owner or staff)
 */
router.get(
  '/order/:orderId',
  authorize('customer', 'CUSTOMER', ...DELIVERY_ROLES, ...MANAGER_ROLES),
  issueController.getCustomerOrderIssues
);

/**
 * @route   GET /api/v1/delivery-issues
 * @desc    List issues (manager: own cafeteria only; courier: own reports)
 * @access  Private/Management
 */
router.get('/', authorize(...MANAGER_ROLES), issueController.getDeliveryIssues);

/**
 * @route   POST /api/v1/delivery-issues
 * @desc    Report a problem on a delivery you are assigned to
 * @access  Private/Delivery
 * @body    { issueType, description, latitude?, longitude?, accuracy? }
 */
router.post(
  '/',
  authorize(...DELIVERY_ROLES, ...MANAGER_ROLES),
  // The photo is optional; a failure here must not lose the text report, so it
  // is tolerated rather than being a hard gate on the whole request.
  (req, res, next) => upload.single('photo')(req, res, (err) => (err ? next() : next())),
  issueController.reportDeliveryIssue
);

/**
 * @route   GET /api/v1/delivery-issues/:id
 * @desc    Issue detail (staff) or the safe projection (customer)
 * @access  Private
 */
router.get(
  '/:id',
  authorize('customer', 'CUSTOMER', ...DELIVERY_ROLES, ...MANAGER_ROLES),
  issueController.getDeliveryIssue
);

/**
 * @route   PATCH /api/v1/delivery-issues/:id/start
 * @desc    Manager takes ownership of the problem
 * @access  Private/Management
 */
router.patch('/:id/start', authorize(...MANAGER_ROLES), issueController.startDeliveryIssue);

/**
 * @route   PATCH /api/v1/delivery-issues/:id/resolve
 * @desc    Resolve the problem; the delivery then continues normally
 * @access  Private/Management
 * @body    { resolutionNote? }
 */
router.patch('/:id/resolve', authorize(...MANAGER_ROLES), issueController.resolveDeliveryIssue);

/**
 * @route   PATCH /api/v1/delivery-issues/:id/cancel
 * @desc    Close the issue without it being fixed
 * @access  Private/Management
 * @body    { resolutionNote? }
 */
router.patch('/:id/cancel', authorize(...MANAGER_ROLES), issueController.cancelDeliveryIssue);

/**
 * @route   PATCH /api/v1/delivery-issues/:id/hold
 * @desc    Put the delivery on hold (it cannot be completed while held)
 * @access  Private/Management
 * @body    { reason? }
 */
router.patch('/:id/hold', authorize(...MANAGER_ROLES), issueController.holdDelivery);

/**
 * @route   PATCH /api/v1/delivery-issues/:id/reassign
 * @desc    Hand the delivery to another delivery person
 * @access  Private/Management
 * @body    { deliveryStaffId }
 */
router.patch('/:id/reassign', authorize(...MANAGER_ROLES), issueController.reassignDelivery);

/**
 * @route   PATCH /api/v1/delivery-issues/:id/continue
 * @desc    Release the hold and let the courier continue
 * @access  Private/Management
 */
router.patch('/:id/continue', authorize(...MANAGER_ROLES), issueController.continueDelivery);

/**
 * @route   PATCH /api/v1/delivery-issues/:id/cancel-delivery
 * @desc    Cancel the delivery because the problem is unresolvable
 * @access  Private/Management
 * @body    { reason? }
 */
router.patch('/:id/cancel-delivery', authorize(...MANAGER_ROLES), issueController.cancelDeliveryFromIssue);

module.exports = router;
