/**
 * Routes Index File
 * Export all routes for easy 

importing
 */

const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const menuRoutes = require('./menu.routes');
const cartRoutes = require('./cart.routes');
const orderRoutes = require('./order.routes');
const paymentRoutes = require('./payment.routes');
const notificationRoutes = require('./notification.routes');
const reportRoutes = require('./report.routes');
const feedbackRoutes = require('./feedback.routes');
const cancellationRoutes = require('./cancellation.routes');
const kitchenRoutes = require('./kitchen.routes');
const kitchenSettingsRoutes = require('./kitchen-settings.routes');

module.exports = {
  authRoutes,
  userRoutes,
  menuRoutes,
  cartRoutes,
  orderRoutes,
  paymentRoutes,
  notificationRoutes,
  reportRoutes,
  feedbackRoutes,

  cancellationRoutes,
  kitchenRoutes,
  kitchenSettingsRoutes,
};
