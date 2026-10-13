const express = require('express');
const router = express.Router();

const { protect, authorize } = require('../middleware/auth');
const deliveryController = require('../controllers/delivery.controller');

/**
 * GPS tracking alias routes.
 *
 * Mounted at `/api/v1/delivery/orders`, so the documented tracking contract
 *      PUT /api/v1/delivery/orders/:orderId/location
 *      GET /api/v1/delivery/orders/:orderId/location
 * resolves to exactly the same handler, middleware and authorization as the
 * canonical delivery router (`/api/v1/deliveries/:id/location`). It exists so
 * the order-scoped URL works for clients that key tracking by order id - it is
 * deliberately a thin alias, NOT a second GPS system: no separate validation, no
 * separate socket rooms, no second place where coordinates can be written.
 *
 * Everything that matters is inherited unchanged from the canonical path:
 *   - `protect`              -> 401 for an unauthenticated caller
 *   - `authorize(...roles)`  -> 403 for anyone who is not delivery staff
 *   - controller ownership   -> 403 unless the caller is the ASSIGNED courier
 *   - controller state gate  -> 409 once the delivery is cancelled/delivered
 *
 * The courier identity is read from the verified JWT only; a deliveryStaffId in
 * the path or body is never trusted.
 */
const DELIVERY_ROLES = ['delivery', 'DELIVERY_STAFF', 'delivery_staff', 'delivery_person'];

router.use(protect);

/**
 * @route   PUT /api/v1/delivery/orders/:orderId/location
 * @desc    Report the courier's real GPS fix for an order
 * @body    { latitude, longitude, accuracy?, timestamp? }
 * @returns The updated location + distance to the customer
 */
router.put('/:orderId/location', authorize(...DELIVERY_ROLES), deliveryController.updateDeliveryLocation);

/**
 * @route   GET /api/v1/delivery/orders/:orderId/location
 * @desc    Last known GPS fix (order owner, assigned courier, or management)
 */
router.get('/:orderId/location', deliveryController.getLastDeliveryLocation);

module.exports = router;
