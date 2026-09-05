const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getAllOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrder,
  getOrderStats,
  refundOrder
} = require('../controllers/admin.order.controller');
const OrderStatusHistory = require('../models/OrderStatusHistory');

// All routes require admin, staff, or kitchen role
router.use(protect);
router.use(authorize('admin', 'ADMIN', 'staff', 'kitchen_staff', 'kitchen', 'foodmaker'));

/**
 * @route   GET /api/v1/admin/orders
 * @desc    Get all orders (search / filter / sort / paginate)
 * Query: search, status, paymentStatus, orderType, date, from, to, sort, page, limit
 */
router.get('/', getAllOrders);

/**
 * @route   GET /api/v1/admin/orders/stats
 * @desc    Order statistics for metric cards
 */
router.get('/stats', getOrderStats);

/**
 * @route   GET /api/v1/admin/orders/:id
 * @desc    Get single order with customer + payment details
 */
router.get('/:id', getOrderById);

/**
 * @route   PATCH /api/v1/admin/orders/:id/status
 * @desc    Update order status (respects flow: PENDING->PREPARING->READY->SERVED->COMPLETED)
 * Body: { status: 'PREPARING' | 'READY' | 'SERVED' | 'COMPLETED' }
 */
router.patch('/:id/status', updateOrderStatus);

/**
 * @route   PATCH /api/v1/admin/orders/:id/cancel
 * @desc    Cancel order (allowed while PENDING or PREPARING)
 * Body: { reason, adminNote }
 */
router.patch('/:id/cancel', cancelOrder);

/**
 * @route   POST /api/v1/admin/orders/:id/refund
 * @desc    Refund a cancelled order (marks payment REFUNDED + saves reference/date-time + notifies customer)
 */
router.post('/:id/refund', refundOrder);
router.get('/:id/history', async (req, res) => {
  const Order = require('../models/Order');
  const lookup = [{ orderId: req.params.id }];
  if (mongoose.Types.ObjectId.isValid(req.params.id)) lookup.push({ _id: req.params.id });
  const order = await Order.findOne({ $or: lookup }).select('_id');
  if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
  const history = await OrderStatusHistory.find({ orderId: order._id }).sort({ createdAt: 1 }).populate('changedBy', 'name email');
  res.json({ success: true, history });
});

router.get('/:id/receipt', async (req, res) => {
  const Order = require('../models/Order');
  const User = require('../models/User');
  try {
    const lookup = [{ orderId: req.params.id }];
    if (mongoose.Types.ObjectId.isValid(req.params.id)) lookup.push({ _id: req.params.id });
    const order = await Order.findOne({ $or: lookup });
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    const customer = await User.findById(order.userId);
    res.json({ success: true, receipt: {
      orderNumber: order.orderId,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerEmail: customer?.email,
      orderType: order.orderType,
      items: (order.items || []).map(i => ({ name: i.foodNameSnapshot || i.name, qty: i.quantity, unitPrice: i.price, subtotal: i.subtotal || (i.quantity * i.price) })),
      subtotal: order.subtotal,
      serviceFee: order.serviceFee,
      total: order.totalAmount,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      orderDate: order.orderDate,
      orderTime: order.orderTime
    }});
  } catch (e) {
    res.status(500).json({ success: false, error: 'Receipt generation failed' });
  }
});

module.exports = router;