const express = require('express');
const multer = require('multer');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { validateBody } = require('../middleware/validation.middleware');
const { validateCreateDeliveryStaff } = require('../validators/admin.validator');
const {
  SYSTEM_ADMIN_ROLES,
  MANAGEMENT_ROLES,
} = require('../config/roles');
const deliveryController = require('../controllers/delivery.controller');

/**
 * Delivery routes.
 *
 * Two audiences share this router:
 *   - Delivery staff  (canonical role `delivery`): their own queue, accept /
 *     decline, the pickup -> delivered chain, and their own GPS reporting.
 *   - Management      (admin / system_admin / manager):
 *     dispatch, reassignment, failed/cancelled handling, reports.
 *
 * Ownership is enforced inside the controller against the JWT identity, never
 * from the request body, so a courier can only ever act on their own run.
 */

const DELIVERY_ROLES = ['delivery', 'DELIVERY_STAFF', 'delivery_staff', 'delivery_person'];
const MANAGER_ROLES = [...new Set([...SYSTEM_ADMIN_ROLES, ...MANAGEMENT_ROLES])];
// Management may also drive the courier-facing endpoints (used by the admin
// deliveries page), and couriers are allowed on the manager read endpoints
// because the courier dashboard shows totals.
const STAFF_OR_MANAGEMENT = [...DELIVERY_ROLES, ...MANAGER_ROLES];

// Proof-of-delivery photos. Same in-memory handling and same validation as the
// delivery-issue upload: files go to cloud/local storage, never to a temp
// directory on the request path.
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

router.use(protect);

/**
 * @route   GET /api/v1/deliveries
 * @desc    List deliveries (role-scoped: courier -> own, management -> cafeteria)
 */
router.get('/', authorize(...STAFF_OR_MANAGEMENT), deliveryController.getDeliveryOrders);

/**
 * @route   GET /api/v1/deliveries/emergencies
 * @desc    List emergencies for the manager dashboard (management only)
 * @query   status, cafeteriaId
 *
 * Declared BEFORE /:id - otherwise "emergencies" is captured as an :id and the
 * request hits the single-delivery lookup instead.
 */
router.get('/emergencies', authorize(...MANAGER_ROLES), deliveryController.getEmergencies);

/**
 * @route   GET /api/v1/deliveries/active
 * @desc    Active deliveries for the dispatch board
 */
router.get('/active', authorize(...STAFF_OR_MANAGEMENT), deliveryController.getActiveDeliveries);

/**
 * @route   GET /api/v1/deliveries/history
 * @desc    Completed / failed / cancelled deliveries (report + history)
 */
router.get('/history', authorize(...STAFF_OR_MANAGEMENT), deliveryController.getDeliveryHistory);

/**
 * @route   GET /api/v1/deliveries/mine
 * @desc    Deliveries currently assigned to the logged-in delivery staff
 */
router.get('/mine', authorize(...DELIVERY_ROLES), deliveryController.getMyDeliveries);

/**
 * @route   GET /api/v1/deliveries/my-history
 * @desc    Finished deliveries for the logged-in delivery staff
 */
router.get('/my-history', authorize(...DELIVERY_ROLES), deliveryController.getMyDeliveryHistory);

/**
 * @route   GET /api/v1/deliveries/available
 * @desc    Unassigned, kitchen-ready deliveries awaiting dispatch.
 *          Read-only dispatch board for couriers (their own queue stays the
 *          manager-assigned list) and for management.
 *          Declared before /:id so "available" is never swallowed by the
 *          single-delivery lookup.
 */
router.get('/available', authorize(...STAFF_OR_MANAGEMENT), deliveryController.getAvailableDeliveries);

/**
 * @route   GET /api/v1/deliveries/board
 * @desc    The courier's whole Active Deliveries board in ONE response:
 *          `assigned` (live work attached to the caller) + `available`
 *          (cafeteria-wide, unassigned, kitchen-ready, claimable by anyone).
 *          This is what the Delivery Staff Dashboard renders, so a newly
 *          dispatched order appears for every eligible rider even before it is
 *          attached to one of them, without two sequential requests that can
 *          half-fail.
 *          Declared before /:id so "board" is never swallowed by the
 *          single-delivery lookup.
 */
router.get('/board', authorize(...STAFF_OR_MANAGEMENT), deliveryController.getDeliveryBoard);

router.patch('/:id/claim', authorize(...DELIVERY_ROLES), deliveryController.claimDelivery);

/**
 * @route   GET /api/v1/deliveries/staff
 * @desc    Delivery staff list for the assignment dropdown (management only)
 */
router.get('/staff', authorize(...MANAGER_ROLES), deliveryController.getDeliveryStaff);

/**
 * @route   POST /api/v1/deliveries/staff
 * @desc    Add a delivery staff member from the Cafeteria Manager Dashboard
 * @access  Management only. Creates a normal User (role `delivery`) in the
 *          caller's cafeteria, so the new rider is immediately selectable in
 *          the Delivery Orders dropdown fed by GET /deliveries/staff.
 * @body    { name, phone, email, username, password }
 *
 * Declared next to GET /staff (and before any /:id route) so "staff" is never
 * swallowed by the single-delivery lookup.
 */
router.post(
  '/staff',
  authorize(...MANAGER_ROLES),
  validateBody(validateCreateDeliveryStaff),
  deliveryController.createDeliveryStaff
);

/**
 * @route   GET /api/v1/deliveries/staff/:staffId/orders
 * @desc    Delivery orders assigned to one courier (manager "view orders")
 * @query   status (ACTIVE | ALL | READY | ...), report, limit
 *
 * Declared with the other /staff routes and before /:id so the staff id is
 * never swallowed by the single-delivery lookup.
 */
router.get('/staff/:staffId/orders', authorize(...MANAGER_ROLES), deliveryController.getStaffDeliveryOrders);

/**
 * @route   GET /api/v1/deliveries/stats
 * @desc    Delivery statistics (role-scoped)
 */
router.get('/stats', authorize(...STAFF_OR_MANAGEMENT), deliveryController.getDeliveryStats);

/**
 * @route   GET /api/v1/deliveries/reports
 * @desc    Delivery fee / distance / failure reports (management only)
 */
router.get('/reports', authorize(...MANAGER_ROLES), deliveryController.getDeliveryReports);

/**
 * @route   PATCH /api/v1/deliveries/availability
 * @desc    Courier goes on / off shift
 * @body    { isAvailable: boolean }
 */
router.patch('/availability', authorize(...DELIVERY_ROLES), deliveryController.setAvailability);

/**
 * @route   POST /api/v1/deliveries/quote
 * @desc    Price a delivery before checkout (distance fee + ETA)
 * @access  Private
 * @body    { latitude, longitude, subtotal? }
 */
router.post('/quote', deliveryController.calculateDeliveryFee);

/**
 * @route   POST /api/v1/deliveries
 * @desc    Create / backfill the delivery record for a delivery order
 * @access  Private - the order's customer, or management
 */
router.post('/', deliveryController.createDelivery);

/**
 * @route   GET /api/v1/deliveries/:id
 * @desc    Single delivery detail (customer of the order, courier, or management)
 */
router.get('/:id', deliveryController.getDelivery);

/**
 * @route   PATCH /api/v1/deliveries/:id/assign
 * @desc    Assign / reassign / retry a courier (management only)
 * @body    { deliveryStaffId }
 */
router.patch('/:id/assign', authorize(...MANAGER_ROLES), deliveryController.assignDelivery);

/**
 * @route   PATCH /api/v1/deliveries/:id/retry
 * @desc    Retry a failed delivery (management only)
 * @body    { deliveryStaffId? }
 */
router.post('/:id/retry', authorize(...MANAGER_ROLES), deliveryController.retryDelivery);

/**
 * @route   PATCH /api/v1/deliveries/:id/accept
 * @desc    Accept / decline an assignment (assigned courier, or management)
 * @body    { accept: boolean, reason? }
 */
router.patch('/:id/accept', authorize(...STAFF_OR_MANAGEMENT), deliveryController.respondToAssignment);

/**
 * @route   PATCH /api/v1/deliveries/:id/pickup
 * @desc    Picked up from the kitchen (ACCEPTED -> PICKED_UP)
 */
router.patch('/:id/pickup', authorize(...STAFF_OR_MANAGEMENT), deliveryController.pickUpOrder);

/**
 * @route   PATCH /api/v1/deliveries/:id/out-for-delivery
 * @desc    On the way to the customer (PICKED_UP -> OUT_FOR_DELIVERY)
 */
router.patch('/:id/out-for-delivery', authorize(...STAFF_OR_MANAGEMENT), deliveryController.markOutForDelivery);

/**
 * @route   PATCH /api/v1/deliveries/:id/arrived
 * @desc    Arrived at the customer location (OUT_FOR_DELIVERY -> ARRIVED)
 */
router.patch('/:id/arrived', authorize(...STAFF_OR_MANAGEMENT), deliveryController.markArrived);

/**
 * @route   PATCH /api/v1/deliveries/:id/delivered
 * @desc    Handed over (ARRIVED -> DELIVERED). Requires proof of delivery:
 *          a proof photo, a verified customer OTP, or a manager override.
 * @body    { proofPhoto?, proofNote?, otp?, overrideReason? }
 */
router.patch('/:id/delivered', authorize(...STAFF_OR_MANAGEMENT), deliveryController.markDelivered);

/**
 * @route   PATCH /api/v1/deliveries/:id/complete
 * @desc    Close out a handed-over delivery (DELIVERED -> COMPLETED). This is
 *          the step that finalises the order. No extra proof is needed: the
 *          proof was already demanded by /:id/delivered.
 * @body    { reason? }
 */
router.patch('/:id/complete', authorize(...STAFF_OR_MANAGEMENT), deliveryController.markCompleted);

/**
 * @route   POST /api/v1/deliveries/:id/proof/photo
 * @desc    Upload a proof-of-delivery photo (assigned courier or management)
 * @multipart  field name: photo
 */
router.post(
  '/:id/proof/photo',
  authorize(...STAFF_OR_MANAGEMENT),
  upload.single('photo'),
  deliveryController.uploadProofPhoto
);

/**
 * @route   POST /api/v1/deliveries/:id/otp/generate
 * @desc    Generate the customer OTP and send it to the customer
 */
router.post('/:id/otp/generate', authorize(...STAFF_OR_MANAGEMENT), deliveryController.generateOtp);

/**
 * @route   POST /api/v1/deliveries/:id/otp/verify
 * @desc    Verify a customer OTP (marks the delivery confirmedByCustomer)
 * @body    { otp }
 */
router.post('/:id/otp/verify', authorize(...STAFF_OR_MANAGEMENT), deliveryController.verifyOtp);

/**
 * @route   GET /api/v1/deliveries/:id/proof
 * @desc    Read the proof of delivery (customer, assigned courier, management)
 */
router.get('/:id/proof', deliveryController.getProof);

/**
 * @route   POST /api/v1/deliveries/:id/emergency
 * @desc    Raise a delivery emergency / SOS (assigned courier only)
 * @body    { latitude?, longitude?, accuracy? }
 */
router.post('/:id/emergency', authorize(...DELIVERY_ROLES), deliveryController.triggerEmergency);

/**
 * @route   PATCH /api/v1/deliveries/:id/emergency/ack
 * @desc    Acknowledge an active emergency (management only)
 */
router.patch('/:id/emergency/ack', authorize(...MANAGER_ROLES), deliveryController.acknowledgeEmergency);

/**
 * @route   PATCH /api/v1/deliveries/:id/emergency/resolve
 * @desc    Resolve an emergency (management, or the assigned courier)
 * @body    { note? }
 */
router.patch('/:id/emergency/resolve', authorize(...STAFF_OR_MANAGEMENT), deliveryController.resolveEmergency);

/**
 * @route   PATCH /api/v1/deliveries/:id/status
 * @desc    Generic transition-guarded status update
 * @body    { status, reason?, failureReason?, failureNote? }
 */
router.patch('/:id/status', authorize(...STAFF_OR_MANAGEMENT), deliveryController.updateDeliveryStatus);

/**
 * @route   PATCH /api/v1/deliveries/:id/fail
 * @desc    Mark the delivery as failed (reason required)
 * @body    { reason, note? }
 */
router.patch('/:id/fail', authorize(...STAFF_OR_MANAGEMENT), deliveryController.failDelivery);

/**
 * @route   PATCH /api/v1/deliveries/:id/cancel
 * @desc    Cancel the delivery (owner before pickup, or management)
 * @body    { reason? }
 */
router.patch('/:id/cancel', deliveryController.cancelDelivery);

/**
 * @route   POST /api/v1/deliveries/:id/location
 * @route   PUT  /api/v1/deliveries/:id/location
 * @desc    Report the courier's real GPS fix. The rider identity comes from the
 *          JWT only - never from the body.
 * @body    { latitude, longitude, accuracy?, timestamp? }
 * @returns The updated location
 *          { success, location: { latitude, longitude, accuracy, updatedAt },
 *            deliveryLocation, customerLocation, distanceToCustomerKm,
 *            nearCustomer, trackingActive }
 *
 * PUT is accepted as an alias of POST so an idempotent-looking update verb works
 * without duplicating any logic. The identical handler is also mounted at
 * `PUT /api/v1/delivery/orders/:orderId/location` (delivery-tracking.routes.js).
 */
router.post('/:id/location', authorize(...DELIVERY_ROLES), deliveryController.updateDeliveryLocation);
router.put('/:id/location', authorize(...DELIVERY_ROLES), deliveryController.updateDeliveryLocation);

/**
 * @route   GET /api/v1/deliveries/:id/location
 * @desc    Last known GPS fix for a delivery (customer of the order, assigned
 *          courier, or management). Returns the final stored fix for a
 *          completed delivery - no live tracking, no history list.
 */
router.get('/:id/location', deliveryController.getLastDeliveryLocation);

/**
 * @route   GET /api/v1/deliveries/:id/locations
 * @desc    Recorded GPS history for a delivery (owner, courier, or management)
 */
router.get('/:id/locations', deliveryController.getDeliveryLocations);

module.exports = router;
