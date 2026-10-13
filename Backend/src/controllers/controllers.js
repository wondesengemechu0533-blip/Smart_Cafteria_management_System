/**
 * Controllers Index File
 * Export all controllers for easy importing
 */

const authController = require('./auth.controller');
const userController = require('./user.controller');
const menuController = require('./menu.controller');
const categoryController = require('./category.controller');
const cartController = require('./cart.controller');
const orderController = require('./order.controller');
const paymentController = require('./payment.controller');
const notificationController = require('./notification.controller');
const reportController = require('./report.controller');
const feedbackController = require('./feedback.controller');
const cancellationController = require('./cancellation.controller');
const kitchenController = require('./kitchen.controller'); // ✅ አስገባ!

module.exports = {
  authController,
  userController,
  menuController,
  categoryController,
  cartController,
  orderController,
  paymentController,
  notificationController,
  reportController,
  feedbackController,
  cancellationController,
  kitchenController, // ✅ አስገባ!
};
