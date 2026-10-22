const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getKitchenDashboard,
  getKitchenOrders,
  acceptOrder,
  markOrderReady,
  markOrderServed,
  markOrderReadyForPickup,
  sendOrderToDelivery,
  rejectOrder,
  getKitchenStats,
  getMenuAvailability,
  updateItemAvailability,
  reportStockIssue,
  getStockAlerts,
  getStockAlertDetails,
  acknowledgeStockAlert,
  resolveStockAlert,
  getOrderDetails,
  updateItemPreparationStatus,
  addPreparationDelay,
} = require('../controllers/kitchen.controller');

// ============================================================
// ALL ROUTES REQUIRE KITCHEN ROLE (or admin, who can view it too)
// ============================================================
router.use(protect);
router.use(authorize('kitchen', 'admin', 'manager', 'kitchen_staff', 'staff', 'foodmaker'));

/**
 * @route   GET /api/kitchen/dashboard
 * @desc    Get kitchen dashboard data
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Load dashboard
 */
router.get('/dashboard', getKitchenDashboard);

/**
 * @route   GET /api/kitchen/orders
 * @desc    Get kitchen orders
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/orders.html → Load orders list
 * Query Params: status
 */
router.get('/orders', getKitchenOrders);

/**
 * @route   GET /api/kitchen/orders/:orderId/details
 * @desc    Get detailed order view with item-level status
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/order-details.html → Show full order
 */
router.get('/orders/:orderId/details', getOrderDetails);

/**
 * @route   GET /api/kitchen/stats
 * @desc    Get kitchen stats
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Live stats update
 */
router.get('/stats', getKitchenStats);

/**
 * @route   PATCH /api/kitchen/orders/:orderId/accept
 * @desc    Accept order
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Accept order
 */
router.patch('/orders/:orderId/accept', acceptOrder);

/**
 * @route   PATCH /api/kitchen/orders/:orderId/ready
 * @desc    Mark order as ready
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Mark ready
 */
router.patch('/orders/:orderId/ready', markOrderReady);

/**
 * @route   PATCH /api/kitchen/orders/:orderId/serve
 * @desc    Mark order as served
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Mark served
 */
router.patch('/orders/:orderId/serve', markOrderServed);

/**
 * @route   POST /api/kitchen/orders/:orderId/send-to-delivery
 * @desc    Send a ready delivery order to delivery staff
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Send to Delivery button
 */
router.post('/orders/:orderId/send-to-delivery', sendOrderToDelivery);

/**
 * @route   POST /api/v1/kitchen/orders/:orderId/ready-for-pickup
 * @desc    Kitchen stops here: order is READY and waiting for the courier
 * @access  Private/Kitchen
 *
 * The kitchen cannot move an order to PICKED_UP. That transition belongs to
 * Delivery Staff only (PATCH /api/v1/deliveries/:orderId/pickup), so the pickup
 * is always confirmed by the rider who physically collected the order. The old
 * /orders/:orderId/picked-up route was removed.
 */
router.post('/orders/:orderId/ready-for-pickup', markOrderReadyForPickup);

/**
 * @route   PATCH /api/kitchen/orders/:orderId/reject
 * @desc    Reject/cancel order
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Reject order
 * Body: { reason }
 */
router.patch('/orders/:orderId/reject', rejectOrder);

/**
 * @route   PATCH /api/kitchen/orders/:orderId/items/:itemId/status
 * @desc    Update item-level preparation status
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/order-details.html → Update item status
 * Body: { itemStatus }
 */
router.patch('/orders/:orderId/items/:itemId/status', updateItemPreparationStatus);

/**
 * @route   PATCH /api/kitchen/orders/:orderId/delay
 * @desc    Add preparation delay reason
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Report delay
 * Body: { reason }
 */
router.patch('/orders/:orderId/delay', addPreparationDelay);

// ============================================================
// FOOD AVAILABILITY MANAGEMENT
// ============================================================

/**
 * @route   GET /api/kitchen/menu-availability
 * @desc    Get all menu items with availability status
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/availability.html → Display menu items
 */
router.get('/menu-availability', getMenuAvailability);

/**
 * @route   PATCH /api/kitchen/menu/:itemId/availability
 * @desc    Toggle item availability
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/availability.html → Toggle item
 * Body: { isAvailable, reason }
 */
router.patch('/menu/:itemId/availability', updateItemAvailability);

/**
 * @route   GET /api/kitchen/stock-alerts
 * @desc    Get active stock alerts
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/stock-alerts.html → Display alerts
 * Query Params: status
 */
router.get('/stock-alerts', getStockAlerts);

/**
 * @route   GET /api/v1/kitchen/stock-alerts/:id
 * @desc    Stock alert details by MongoDB id (read-only). Includes resolution
 *          fields (resolvedBy/resolvedAt/resolutionNote/...) for resolved
 *          alerts so kitchen staff can review the admin's resolution.
 *          Viewing never mutates the alert.
 * @access  Private/Kitchen, Manager, Admin (router-wide role gate)
 */
router.get('/stock-alerts/:id', getStockAlertDetails);

/**
 * @route   POST /api/kitchen/stock-alerts
 * @desc    Report a stock/ingredient issue
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/stock-alerts.html → Report issue
 * Body: { itemId, itemName, alertType, severity, reason }
 */
router.post('/stock-alerts', reportStockIssue);

/**
 * @route   PATCH /api/kitchen/stock-alerts/:id/acknowledge
 * @desc    Acknowledge a stock alert
 * @access  Private/Kitchen
 */
router.patch('/stock-alerts/:id/acknowledge', acknowledgeStockAlert);

/**
 * @route   PATCH /api/kitchen/stock-alerts/:id/resolve
 * @desc    Resolve a stock alert (records resolution note, admin id, timestamp).
 *          Managers, Admins and System Admins can resolve stock alerts.
 * @access  Private/Admin/Manager
 */
router.patch(
  '/stock-alerts/:id/resolve',
  authorize('manager', 'admin', 'system_admin'),
  resolveStockAlert
);

module.exports = router;
