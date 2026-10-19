const mongoose = require('mongoose');
const Order = require('../models/Order');
const Notification = require('../models/Notification');
const OrderStatusHistory = require('../models/OrderStatusHistory');
const { emitSocketEvent } = require('../utils/socket');
const { notifyUser, findCafeteriaManagers } = require('../utils/notification');
const { ORDER_STATUS, MESSAGES, HTTP_STATUS } = require('../config/constants');

const KITCHEN_STATUSES = ['pending', 'preparing', 'ready', 'ready_for_delivery'];
const KITCHEN_STATUS_VALUES = [...KITCHEN_STATUSES, 'PENDING', 'PREPARING', 'READY', 'READY_FOR_DELIVERY', 'Received', 'RECEIVED'];
const KITCHEN_CANCELLED_VALUES = ['cancelled', 'CANCELLED'];

/**
 * Exactly the fields formatKitchenOrder() reads, and nothing more.
 *
 * WHY: the kitchen board polls this endpoint every 15s, and a full Order
 * document is ~1.1 KB (the items array plus the embedded payment object plus a
 * dozen timestamps). The board routinely holds 100+ rows, so one response was
 * ~140 KB. Over a slow database link (~8 KB/s, which is what the Atlas route
 * measured) that is 15-30s - LONGER than the client's 15s timeout - so the page
 * rendered "Could not load the kitchen queue / Request timed out" while the
 * database itself was answering the same query in 1ms.
 *
 * Projecting to these fields drops a row to ~400 B (~50 KB for the whole board),
 * which is the difference between the board loading and never loading.
 *
 * RULE: if formatKitchenOrder() starts reading a new field, add it here - a
 * missing field silently renders as an empty cell, not as an error.
 */
const KITCHEN_ORDER_FIELDS = [
  'orderId',
  'customerName',
  'customerPhone',
  'items.name',
  'items.quantity',
  'items.notes',
  'items.itemStatus',
  'status',
  'orderStatus',
  'paymentStatus',
  'priority',
  'totalAmount',
  'orderType',
  'tableNumber',
  'createdAt',
  'estimatedCompletionTime',
  'readyTime',
  'completedTime',
  'kitchenStaffAssigned',
  'preparationDelayReason',
].join(' ');

/**
 * Safety cap on the cancelled list. It is deliberately a LIMIT and not a date
 * filter: cancellations must stay visible no matter how old they are (that is
 * what the Cancelled tab is for), but the query is unbounded, so without a cap
 * every cancellation the café has ever had is shipped on every 15s poll.
 */
const KITCHEN_CANCELLED_LIMIT = 500;

/**
 * Safety cap on the list endpoint (/kitchen/orders). It is already windowed to
 * today, so this only guards a pathological day - and it stops the endpoint
 * silently regenerating the unbounded, whole-document response it used to send.
 */
const KITCHEN_ORDERS_LIMIT = 500;

/**
 * The kitchen only ever sees orders whose payment is confirmed: the lifecycle
 * is "customer places order -> payment successful -> order = PENDING ->
 * kitchen dashboard". Unpaid / failed orders stay off the board, out of the
 * orders list and out of the stats until a payment path (Chapa, simulated
 * checkout or the cashier) releases them via services/order-queue.service.js.
 */
const KITCHEN_PAID_FILTER = { paymentStatus: 'PAID' };

/**
 * Every kitchen transition leaves an audit row. The delivery and admin paths
 * already write OrderStatusHistory; without this the kitchen half of the
 * lifecycle (PENDING -> PREPARING -> READY / SERVED / CANCELLED) left no trail.
 */
async function recordKitchenStatusChange(order, previousStatus, newStatus, changedBy, reason) {
  try {
    await OrderStatusHistory.create({
      orderId: order._id,
      previousStatus,
      newStatus,
      changedBy,
      reason: reason || '',
    });
  } catch (historyError) {
    console.warn('⚠️ Could not write OrderStatusHistory:', historyError.message);
  }
}

function getKitchenStatus(order) {
  const status = String(order.status || '').toLowerCase();
  if (KITCHEN_STATUSES.includes(status)) return status;
  if (status === 'received') return 'pending';
  if (status === 'cancelled') return 'cancelled';

  const legacyStatus = String(order.orderStatus || '').toLowerCase();
  if (legacyStatus === 'received') return 'pending';
  if (legacyStatus === 'cancelled') return 'cancelled';
  if (legacyStatus === 'ready_for_delivery') return 'ready_for_delivery';
  return KITCHEN_STATUSES.includes(legacyStatus) ? legacyStatus : status;
}

/**
 * @desc    Get kitchen dashboard data
 * @route   GET /api/kitchen/dashboard
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Load dashboard
 * Response: { success, stats, orders }
 */
exports.getKitchenDashboard = async (req, res) => {
  try {
    // ✅ Show active orders (pending / preparing / ready) from the last 14 days so
    //    the board always has content while excluding very old / stale orders.
    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - 14);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const kitchenStageOr = [
      { status: { $in: KITCHEN_STATUS_VALUES } },
      { orderStatus: { $in: ['PENDING', 'PREPARING', 'READY', 'READY_FOR_DELIVERY', 'RECEIVED'] } },
    ];

    // Optional triage view: orders that exist in a kitchen stage but are not
    // PAID. OFF by default - the kitchen must not work an unconfirmed payment
    // - but reachable explicitly so a manager can see why the board is empty.
    const includeUnpaid = ['1', 'true', 'yes'].includes(
      String((req.query && req.query.includeUnpaid) || '').toLowerCase()
    );

    /**
     * WHY everything below is issued in ONE Promise.all.
     *
     * This endpoint used to await four queries in sequence: active, then
     * cancelled, then a count, then two counts. Each await is its own network
     * round trip to Atlas, and from this machine that round trip measures
     * 0.4s-2.7s. Sequential, the fixed overhead alone was 1.5s-10s before a
     * single row was read - i.e. most of the budget was spent waiting for
     * requests that had no data dependency on each other.
     *
     * In parallel they overlap into roughly one round trip. The byte cost is
     * unchanged; only the idle waits disappear.
     */
    const [activeOrders, cancelledOrders, ordersInWindow, unpaidInWindow, completedToday, unpaidRows] =
      await Promise.all([
        // ✅ Active: paid orders in a kitchen stage, windowed.
        Order.find({
          ...KITCHEN_PAID_FILTER,
          $or: [
            { status: { $in: KITCHEN_STATUS_VALUES } },
            { orderStatus: { $in: ['PENDING', 'PREPARING', 'READY', 'READY_FOR_DELIVERY', 'RECEIVED'] } },
          ],
          createdAt: { $gte: windowStart },
        })
          // No .populate('userId'): formatKitchenOrder() never reads it, and on
          // this link every populate is another round trip for data nobody uses.
          .select(KITCHEN_ORDER_FIELDS)
          .sort({ createdAt: 1 }),

        // ✅ Cancelled orders are fetched without the "today only" limit so past
        //    cancellations still show up in the Cancelled filter.
        //
        //    Deliberately NOT filtered by paymentStatus. The active list is
        //    KITCHEN_PAID_FILTER'd because an unpaid order must never reach the
        //    board, but that rule was also being applied here - and a customer who
        //    cancels BEFORE paying leaves exactly that combination
        //    (`status: cancelled` + `paymentStatus: PENDING`). Those cancellations
        //    were silently dropped, so the kitchen's "Cancelled" tab could render
        //    "no cancelled orders" while cancellations were sitting in the database.
        //    A cancellation is worth seeing either way - it is the one record that
        //    tells the kitchen food for this ticket must NOT be started.
        //    Only a FAILED payment is dropped: that is an abandoned checkout, not a
        //    cancellation.
        Order.find({
          paymentStatus: { $ne: 'FAILED' },
          $or: [{ status: { $in: KITCHEN_CANCELLED_VALUES } }, { orderStatus: 'CANCELLED' }],
        })
          .select(KITCHEN_ORDER_FIELDS)
          .sort({ createdAt: -1 })
          .limit(KITCHEN_CANCELLED_LIMIT),

        // The three counts below - all tiny payloads, all independent.
        Order.countDocuments({ createdAt: { $gte: windowStart } }),

        // WHY is the board empty?
        //
        // "No orders" has two very different causes and the kitchen could not
        // tell them apart: genuinely nothing to cook, or orders that exist but
        // are not PAID yet and therefore (by design) never join the queue. The
        // second case used to look identical to the first, which is why a
        // full-looking database produced a board of zeros with no explanation.
        Order.countDocuments({
          paymentStatus: { $ne: 'PAID' },
          $or: kitchenStageOr,
          createdAt: { $gte: windowStart },
        }),

        Order.countDocuments({
          ...KITCHEN_PAID_FILTER,
          status: 'served',
          completedTime: { $gte: today },
        }),

        // The triage query. When includeUnpaid is off this resolves immediately
        // and costs no round trip at all.
        includeUnpaid
          ? Order.find({
              paymentStatus: { $ne: 'PAID' },
              $or: kitchenStageOr,
              createdAt: { $gte: windowStart },
            })
              .select(KITCHEN_ORDER_FIELDS)
              .sort({ createdAt: 1 })
          : Promise.resolve([]),
      ]);

    // ✅ Group by status
    const pendingOrders = activeOrders.filter((o) => getKitchenStatus(o) === 'pending');
    const preparingOrders = activeOrders.filter((o) => getKitchenStatus(o) === 'preparing');
    const readyOrders = activeOrders.filter((o) => getKitchenStatus(o) === 'ready');

    const unpaidOrders = (unpaidRows || [])
      .filter((o) => String(o.paymentStatus || '').toUpperCase() !== 'FAILED')
      .map((o) => formatKitchenOrder(o));

    // ✅ Stats for dashboard
    const stats = {
      pending: pendingOrders.length,
      preparing: preparingOrders.length,
      ready: readyOrders.length,
      cancelled: cancelledOrders.length,

      activeOrders: activeOrders.length,
      completedToday: completedToday,
      totalActive: activeOrders.length,
    };

    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats,
      // Why the board looks the way it does. `unpaidInWindow` > 0 with an empty
      // queue means the orders exist but are waiting on payment confirmation.
      diagnostics: {
        ordersInWindow,
        unpaidInWindow,
        unpaidIncluded: includeUnpaid,
      },
      orders: {
        pending: pendingOrders.map((o) => formatKitchenOrder(o)),
        preparing: preparingOrders.map((o) => formatKitchenOrder(o)),
        ready: readyOrders.map((o) => formatKitchenOrder(o)),
        cancelled: cancelledOrders.map((o) => formatKitchenOrder(o)),
        // Only populated when ?includeUnpaid=1 (see above).
        unpaid: unpaidOrders,
      },
    });
  } catch (error) {
    console.error('❌ Get Kitchen Dashboard Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get kitchen orders (list view)
 * @route   GET /api/kitchen/orders
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/orders.html → Load orders list
 * Query Params: status
 * Response: { success, count, orders: [...] }
 */
exports.getKitchenOrders = async (req, res) => {
  try {
    const { status } = req.query;

    // ✅ Only show orders created today (past orders are hidden from the board)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    // ✅ ...and only once the payment is confirmed (the lifecycle is
    //    payment successful -> PENDING -> kitchen). Applied to every branch so
    //    a status filter can never surface an unpaid order.
    let filter = { createdAt: { $gte: todayStart }, ...KITCHEN_PAID_FILTER };
    if (status && status !== 'all') {
      const normalizedStatus = String(status).toLowerCase();
      filter.$or = [
        { status: normalizedStatus },
        { status: normalizedStatus.toUpperCase() },
        { orderStatus: normalizedStatus.toUpperCase() },
      ];
    } else {
      filter.$or = [
        {
          status: {
            $in: [
              'pending',
              'preparing',
              'ready',
              'ready_for_delivery',
              'served',
              'cancelled',
              'PENDING',
              'PREPARING',
              'READY',
              'READY_FOR_DELIVERY',
              'SERVED',
              'CANCELLED',
              'Received',
              'RECEIVED',
            ],
          },
        },
        { orderStatus: { $in: ['PENDING', 'PREPARING', 'READY', 'READY_FOR_DELIVERY', 'SERVED', 'RECEIVED', 'CANCELLED'] } },
      ];
    }

    // No .populate('userId'): formatKitchenOrder() never reads it, so each
    // populate was a second round trip returning data the response discards -
    // and whole documents are shipped otherwise. On the Atlas link (measured
    // ~8 KB/s) the projection is the difference between a page and a stall.
    const orders = await Order.find(filter)
      .select(KITCHEN_ORDER_FIELDS)
      .sort({ createdAt: -1 })
      // Today-only filter, but a single busy day must not be allowed to
      // regenerate the unbounded response this endpoint used to produce.
      .limit(KITCHEN_ORDERS_LIMIT);
    res.status(HTTP_STATUS.OK).json({
      success: true,

      count: orders.length,
      orders: orders.map((o) => formatKitchenOrder(o)),
    });
  } catch (error) {
    console.error('❌ Get Kitchen Orders Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Accept order (Kitchen)
 * @route   PATCH /api/kitchen/orders/:orderId/accept
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Accept order
 * Response: { success, message, order }
 */
exports.acceptOrder = async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({ orderId: orderId });

    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    // ✅ Lifecycle gate: an order only reaches the kitchen once its payment is
    //    confirmed ("payment successful -> order = PENDING -> kitchen ->
    //    PREPARING"). The board already hides unpaid orders; this stops a
    //    direct API call from starting food the customer has not paid for.
    if (String(order.paymentStatus || '').toUpperCase() !== 'PAID') {
      return res.status(HTTP_STATUS.CONFLICT).json({
        success: false,
        error: 'Payment has not been confirmed for this order yet',
        code: 'PAYMENT_REQUIRED',
      });
    }

    // ✅ Check if order can be accepted
    if (getKitchenStatus(order) !== 'pending') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Order cannot be accepted (status: ${order.status})`,
      });
    }

    // ✅ Update status to preparing - BOTH status fields, so the admin,
    //    delivery and reporting consumers that read `orderStatus` agree with
    //    the kitchen board (they used to still see PENDING while the kitchen
    //    was already cooking).
    const previousStatus = order.orderStatus || order.status || 'NONE';
    order.status = ORDER_STATUS.PREPARING;
    order.orderStatus = 'PREPARING';

    // ✅ Calculate and set estimated completion time
    const MenuItem = require('../models/MenuItem');
    let maxPrepTime = 0;

    for (const item of order.items) {
      const menuItem = await MenuItem.findById(item.itemId);
      if (menuItem) {
        maxPrepTime = Math.max(maxPrepTime, menuItem.preparationTime || 10);
      }
    }

    // Add buffer for multiple items (2 minutes per additional item)
    const itemBuffer = Math.ceil((order.items.length - 1) * 2);
    const estimatedMinutes = maxPrepTime + itemBuffer;
    order.estimatedCompletionTime = new Date(Date.now() + estimatedMinutes * 60000);

    // Assign to current staff member
    order.kitchenStaffAssigned = req.user.id;

    // Initialize item statuses
    order.items.forEach((item) => {
      if (!item.itemStatus) {
        item.itemStatus = 'preparing';
      }
    });

    await order.save();

    // ✅ Audit the PENDING -> PREPARING step of the order lifecycle.
    await recordKitchenStatusChange(order, previousStatus, 'PREPARING', req.user.id, 'Kitchen accepted the order');

    // ✅ Emit socket event for order status update
    const { emitSocketEvent } = require('../utils/socket');
    const orderSummary = formatKitchenOrder(order);
    emitSocketEvent('kitchen', 'order:status', orderSummary);
    emitSocketEvent(`order:${orderId}`, 'order:status', orderSummary);

    // ✅ Notify customer - saved for offline, emitted for online (only to correct customer)
    const notification = await Notification.create({
      userId: order.userId,
      title: 'Order Accepted!',
      message: `Your order #${orderId} has been accepted and is being prepared by the kitchen. Estimated time: ${estimatedMinutes} minutes`,
      type: 'status_update',
      orderId: orderId,
      link: `/src/pages/customer/order-tracking.html?orderId=${orderId}`,
      isRead: false,
    });

    // ✅ Send real-time notification to correct customer only (user room)
    emitSocketEvent(`user:${order.userId}`, 'notification:new', {
      id: notification._id,
      title: notification.title,
      message: notification.message,
      type: notification.type,
      orderId: notification.orderId,
      link: notification.link,
      isRead: notification.isRead,
      createdAt: notification.createdAt,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${orderId} accepted and is now being prepared`,
      order: formatKitchenOrder(order),
    });
  } catch (error) {
    console.error('❌ Accept Order Error:', error);

    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
* @desc    Mark order as ready (Kitchen)
* @route   PATCH /api/kitchen/orders/:orderId/ready
* @access  Private/Kitchen
*
* Frontend: kitchen/dashboard.html → Mark ready

* Response: { success, message, order }
*/
/**
 * Nudge the courier who owns a delivery order that the kitchen has finished.
 *
 * The Pick Up button on their dashboard only unlocks once the order is READY, so
 * this is what makes the handoff visible without a manual page reload. Both
 * kitchen entry points share it: "Mark Ready" (the button the kitchen UI
 * actually presses) and the explicit "Ready for Pickup" endpoint.
 *
 * Persists the notification as well as emitting it, so a rider who was offline
 * still finds it in their notification list.
 */
async function notifyCourierReadyForPickup(order, orderId) {
  if (!order || !order.deliveryStaffAssigned) return null;
  const { emitSocketEvent } = require('../utils/socket');
  const notification = await Notification.create({
    userId: order.deliveryStaffAssigned,
    title: 'Order Ready for Pickup!',
    message: `Order #${orderId} is ready. Please pick it up from the kitchen.`,
    type: 'status_update',
    orderId,
    // Deep link: the rider's queue scrolls to and highlights this card.
    link: `/src/pages/delivery/deliveries.html?orderId=${encodeURIComponent(orderId)}`,
    isRead: false,
  });

  emitSocketEvent(`user:${order.deliveryStaffAssigned}`, 'notification:new', {
    id: notification._id,
    title: notification.title,
    message: notification.message,
    type: notification.type,
    orderId: notification.orderId,
    link: notification.link,
    isRead: notification.isRead,
    createdAt: notification.createdAt,
  });

  // The courier's dashboard listens for this and re-renders, so the pickup
  // stage button appears without a page reload.
  emitSocketEvent('delivery', 'delivery:ready-for-pickup', formatKitchenOrder(order));
  return notification;
}

exports.markOrderReady = async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({ orderId: orderId });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    // ✅ Check if order can be marked ready
    if (order.status !== 'preparing') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Order cannot be marked ready (status: ${order.status})`,
      });
    }

    // ✅ Update status to ready
    const previousStatus = order.orderStatus || order.status || 'NONE';
    order.status = ORDER_STATUS.READY;
    order.orderStatus = 'READY';
    order.readyTime = new Date();
    const isDelivery = String(order.orderType || '').toLowerCase() === 'delivery';

    await order.save();

    // ✅ Audit the PREPARING -> READY step of the order lifecycle.
    await recordKitchenStatusChange(order, previousStatus, 'READY', req.user.id, 'Kitchen marked the order ready');

    // ✅ Emit socket event for order status update
    const { emitSocketEvent } = require('../utils/socket');
    const orderSummary = formatKitchenOrder(order);
    emitSocketEvent('kitchen', 'order:status', orderSummary);
    emitSocketEvent(`order:${orderId}`, 'order:status', orderSummary);
    if (isDelivery) {
      emitSocketEvent('delivery', 'order:status', orderSummary);
      // The courier's Pick Up button unlocks on READY, so tell the rider who owns
      // it. Marking ready used to notify only the customer, which left the rider
      // staring at a stale list until they happened to refresh.
      await notifyCourierReadyForPickup(order, orderId);
    }

    // ✅ Notify customer - saved for offline, emitted for online (only to correct customer)
    const notification = await Notification.create({
      userId: order.userId,
      title: isDelivery ? 'Order Ready for Delivery!' : 'Order Ready!',
      message: isDelivery
        ? `Your order #${orderId} is ready for delivery.`
        : `Your order #${orderId} is ready for pickup.`,
      type: 'ready',
      orderId: orderId,
      link: `/src/pages/customer/order-tracking.html?orderId=${orderId}`,
      isRead: false,
    });

    // ✅ Send real-time notification to correct customer only (user room)
    emitSocketEvent(`user:${order.userId}`, 'notification:new', {
      id: notification._id,
      title: notification.title,
      message: notification.message,
      type: notification.type,
      orderId: notification.orderId,
      link: notification.link,
      isRead: notification.isRead,
      createdAt: notification.createdAt,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,

      message: isDelivery ? `Order #${orderId} is now ready for delivery` : `Order #${orderId} is now ready for pickup`,
      order: formatKitchenOrder(order),
    });
  } catch (error) {
    console.error('❌ Mark Order Ready Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Send order to delivery staff (Kitchen)
 * @route   POST /api/kitchen/orders/:orderId/send-to-delivery
 * @access  Private/Kitchen/Admin
 *
 * Frontend: kitchen/dashboard.html → Send to Delivery button
 * Notifies ALL active delivery staff in real time (socket + notification)
 * that the order is ready for delivery.
 * Response: { success, message, order, notified }
 */
exports.sendOrderToDelivery = async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({ orderId: orderId });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    // ✅ Only delivery orders can be sent to delivery
    if (String(order.orderType || '').toLowerCase() !== 'delivery') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Order is not a delivery order',
      });
    }

    // ✅ Must be in the kitchen phase: PREPARING (food being made), READY
    // (finished), or READY_FOR_DELIVERY (an idempotent re-send after a first
    // send - the kitchen button can be tapped twice, the state must not jump).
    // Anything else (unpaid/pending, already picked up, delivered, cancelled)
    // is rejected, so no invalid transition can ever be created from here.
    const sendState = String(order.orderStatus || order.status || '').toUpperCase();
    if (!['PREPARING', 'READY', 'READY_FOR_DELIVERY'].includes(sendState)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Order can only be sent to delivery from PREPARING or READY (status: ${order.status}/${order.orderStatus})`,
        code: 'INVALID_STATUS_TRANSITION',
      });
    }

    const { emitSocketEvent } = require('../utils/socket');
    const deliveryService = require('../services/delivery.service');
    const deliveryController = require('./delivery.controller');
    const Delivery = require('../models/Delivery');
    const User = require('../models/User');

    // ✅ Create/initialize the Delivery record for this order.
    // ensureDeliveryForOrder() is idempotent AND repairs a stale Order.delivery
    // back-link, so re-sending an order never produces a duplicate delivery.
    // REQUESTED is the "awaiting assignment" state - no courier is attached here.
    let delivery = order.delivery ? await Delivery.findById(order.delivery) : null;
    if (!delivery || !delivery.order) {
      // A dangling Order.delivery id must not shadow a missing Delivery row.
      delivery = await deliveryService.ensureDeliveryForOrder(order, {
        requestedStatus: deliveryService.DELIVERY_STATUS.REQUESTED,
        actor: { id: req.user?.id },
        reason: 'Order sent to delivery by kitchen',
      });
    } else if (!order.delivery || String(order.delivery) !== String(delivery._id)) {
      // Delivery exists but the order was not pointing at it - repair the link.
      order.delivery = delivery._id;
      await order.save();
    }

    if (!delivery) {
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: 'Could not create a delivery record for this order.',
      });
    }

    // Capture the "was this already announced to staff?" answer BEFORE any write
    // touches the field, otherwise re-sends would always look like a first send.
    const alreadyNotified = Boolean(order.deliveryNotifiedAt);
    const alreadySent = String(order.orderStatus || '').toUpperCase() === 'READY_FOR_DELIVERY';
    const previousOrderStatus = order.orderStatus || null;

    // ✅ The send IS a persisted state change, not just a notification:
    // READY_FOR_DELIVERY + readyForDeliveryAt + an audit row. A re-send keeps
    // the original readyForDeliveryAt (first send wins) and writes no second
    // history row, so refresh/retry can never duplicate the transition.
    order.delivery = delivery._id;
    order.status = 'ready_for_delivery';
    order.orderStatus = 'READY_FOR_DELIVERY';
    if (!order.readyForDeliveryAt) order.readyForDeliveryAt = new Date();
    await order.save();

    if (!alreadySent) {
      try {
        await OrderStatusHistory.create({
          orderId: order._id,
          previousStatus: previousOrderStatus,
          newStatus: 'READY_FOR_DELIVERY',
          changedBy: req.user?.id || null,
          reason: 'Kitchen sent the order to delivery',
        });
      } catch (historyError) {
        console.warn('⚠️ Could not write OrderStatusHistory:', historyError.message);
      }
    }

    // ✅ Auto-dispatch: "Send to Delivery" must leave the order in a delivery
    // staff member's hands, not in a queue nobody owns. The rider list only ever
    // shows orders assigned to THEM (`GET /deliveries/mine`), so a delivery that
    // stays REQUESTED is invisible to every courier no matter how many
    // notifications are fanned out. When nothing is attached yet, hand it to the
    // least-busy active rider of this cafeteria through the very same assignment
    // core the manager route uses - same guards, same state machine, same audit.
    let assignedRider = null;
    let justAssigned = false;
    const alreadyAssignedId = order.deliveryStaffAssigned ? String(order.deliveryStaffAssigned) : null;
    if (alreadyAssignedId) {
      assignedRider = await User.findById(alreadyAssignedId).select('name email');
    } else if (deliveryService.isAssignable(delivery.status)) {
      const candidates = await deliveryController.pickFreeRiders({ order });
      for (const candidate of candidates) {
        const outcome = await deliveryController.assignStaffToDelivery({
          order,
          delivery,
          staff: candidate,
          actor: req.user,
          reason: 'Kitchen sent the order to delivery',
          source: 'kitchen_send_to_delivery',
        });
        if (outcome.ok) {
          assignedRider = candidate;
          justAssigned = true;
          break;
        }
        // A guard refused (capacity, state, cafeteria). Try the next rider; if
        // none of them can take it, the announcement below still goes out so
        // the order is never silently dropped.
        console.warn(`⚠️ Auto-dispatch skipped ${candidate.name} for order #${orderId}: ${outcome.error}`);
      }
    }

    const deliverySummary = formatDeliveryOrder(order);

    // ✅ Broadcast to the delivery room (delivery staff queue) AND the admin
    // room (Cafeteria Manager → Delivery Orders). The manager page listens for
    // these events, so a freshly sent order appears there without a manual
    // refresh (requirement: manager page shows it immediately).
    emitSocketEvent('delivery', 'delivery:new', deliverySummary);
    emitSocketEvent('admin', 'delivery:new', deliverySummary);
    emitSocketEvent('delivery', 'order:status', deliverySummary);
    emitSocketEvent(`order:${order.orderId}`, 'order:status', deliverySummary);
    emitSocketEvent(`delivery:${order.orderId}`, 'order:status', deliverySummary);

    // ✅ Canonical ready-for-delivery frame. The dispatch rooms get the full
    // summary; the order room (customer tracking) gets the customer-safe
    // frame; and the owning courier - when one is already attached - gets it
    // in their personal `delivery:<staffId>` room. No private payload is ever
    // broadcast beyond these scoped rooms.
    const readyFrame = {
      orderId: order.orderId,
      status: 'READY_FOR_DELIVERY',
      orderStatus: 'READY_FOR_DELIVERY',
      customer: {
        id: order.userId ? String(order.userId._id || order.userId) : null,
        name: order.customerName || '',
        phone: order.customerPhone || '',
      },
      readyAt: order.readyForDeliveryAt,
      deliveryStaffAssigned: order.deliveryStaffAssigned
        ? String(order.deliveryStaffAssigned._id || order.deliveryStaffAssigned)
        : null,
      readyForDeliveryAt: order.readyForDeliveryAt,
    };
    emitSocketEvent('delivery', 'order:ready-for-delivery', deliverySummary);
    emitSocketEvent('admin', 'order:ready-for-delivery', deliverySummary);
    emitSocketEvent(`order:${order.orderId}`, 'order:ready-for-delivery', readyFrame);
    emitSocketEvent(`delivery:${order.orderId}`, 'order:ready-for-delivery', readyFrame);
    if (readyFrame.deliveryStaffAssigned) {
      emitSocketEvent(`delivery:${readyFrame.deliveryStaffAssigned}`, 'order:ready-for-delivery', deliverySummary);
    }

    // ✅ Announce the finished food to the ONE rider who now owns it. The link
    // deep-links into their queue (?orderId=), which scrolls to and highlights
    // the card - a bare link would drop them on a list that may look empty.
    // When no rider could be attached at all, fall back to every active rider of
    // the cafeteria so the job still reaches a human who can ask dispatch to
    // assign it (the "nobody owns this order" case must never go quiet).
    const riderLink = `/src/pages/delivery/deliveries.html?orderId=${encodeURIComponent(orderId)}`;
    const recipients = [];
    if (assignedRider && (justAssigned || !alreadyNotified)) {
      recipients.push(assignedRider);
    } else if (!assignedRider && !alreadyNotified) {
      recipients.push(
        ...(await User.find({
          role: { $in: ['delivery', 'DELIVERY_STAFF', 'delivery_staff', 'driver', 'rider'] },
          status: 'ACTIVE',
          isActive: { $ne: false },
          ...(order.cafeteriaId ? { $or: [{ cafeteriaId: null }, { cafeteriaId: order.cafeteriaId }] } : {}),
        }).select('_id name'))
      );
    }

    order.deliveryNotifiedAt = new Date();
    await order.save();

    const title = 'Order Ready for Delivery!';
    const message = assignedRider
      ? `Order #${orderId} is ready for delivery and has been assigned to ${assignedRider.name}. Please pick it up from the kitchen.`
      : `Order #${orderId} is ready for delivery. Please arrange pickup and deliver it to the customer.`;
    for (const staff of recipients) {
      const notification = await Notification.create({
        userId: staff._id,
        title: title,
        message: message,
        type: 'status_update',
        orderId: order.orderId,
        link: riderLink,
        isRead: false,
      });

      emitSocketEvent(`user:${staff._id}`, 'notification:new', {
        id: notification._id,
        title: notification.title,
        message: notification.message,
        type: notification.type,
        orderId: notification.orderId,
        link: notification.link,
        isRead: notification.isRead,
        createdAt: notification.createdAt,
      });
    }

    const head = assignedRider
      ? justAssigned
        ? `Order #${orderId} is ready for delivery and assigned to ${assignedRider.name}`
        : `Order #${orderId} is ready for delivery with ${assignedRider.name}`
      : alreadyNotified
        ? `Order #${orderId} was already sent to delivery staff`
        : recipients.length
          ? `No free rider for order #${orderId} — ${recipients.length} delivery staff notified`
          : `Order #${orderId} sent to delivery staff`;

    // Trace of exactly what became visible and to whom. "I sent it to delivery and
    // the riders never saw it" is impossible to diagnose without this line: the
    // order state, the dispatch outcome and the broadcast rooms are all recorded
    // together, in the one request that performed the transition.
    console.log(
      `[kitchen/send-to-delivery] order=${orderId} ` +
      `orderStatus=${order.orderStatus}/${order.status} deliveryStatus=${delivery.status} ` +
      `deliveryRecord=${delivery._id} assignedTo=${assignedRider ? assignedRider.name : 'NONE'} ` +
      `autoAssigned=${justAssigned} notified=${recipients.length} readyAt=${order.readyForDeliveryAt}`
    );

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: head,
      order: deliverySummary,
      notified: recipients.length,
      alreadyNotified: alreadyNotified,
      assignedTo: assignedRider ? assignedRider.name : null,
      autoAssigned: justAssigned,
      // Lets the kitchen UI say "nobody was available, all riders were notified"
      // instead of implying the order was handed to someone.
      awaitingClaim: !assignedRider,
    });
  } catch (error) {
    console.error('❌ Send Order To Delivery Error:', error);
    // Surface the real reason. A swallowed "Server error" previously hid the
    // most common failure of this endpoint - Delivery.create() rejecting the
    // payload - which left the order with no delivery record and no visible
    // explanation for the kitchen.
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: `Could not send order to delivery: ${error.message}`,
    });
  }
};

/**
 * @desc    Mark order as ready for the courier to collect (kitchen stops here)
 * @route   POST /api/v1/kitchen/orders/:orderId/ready-for-pickup
 * @access  Private/Kitchen/Admin
 *
 * This is the LAST thing the kitchen does with a delivery order: mark it ready
 * and tell the assigned courier it is waiting.
 *
 * Kitchen deliberately CANNOT move an order to PICKED_UP. Pickup onward belongs
 * to Delivery Staff alone (PATCH /api/v1/deliveries/:orderId/pickup), because
 * only the courier can confirm the handover physically happened. The old
 * "Hand to Driver" write was removed because it let the kitchen advance the
 * delivery state machine and it notified the customer of a pickup that had not
 * been confirmed by the rider.
 *
 * Note: markOrderReady() (Kitchen → READY) and sendOrderToDelivery() (dispatch
 * to the courier queue) remain the kitchen's responsibilities.
 */
exports.markOrderReadyForPickup = async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    if (String(order.orderType || '').toLowerCase() !== 'delivery') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Order is not a delivery order',
      });
    }

    if (order.status !== 'ready') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Order is only ready for pickup when READY (status: ${order.status})`,
      });
    }

    // Nudge the assigned courier. The pickup button only unlocks for them once
    // the kitchen has marked the order READY. Same helper "Mark Ready" uses, so
    // the two entry points can never drift apart.
    await notifyCourierReadyForPickup(order, orderId);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${orderId} is ready for the courier to pick up`,
      order: formatKitchenOrder(order),
    });
  } catch (error) {
    console.error('❌ Mark Order Ready For Pickup Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Mark order as served (Kitchen)
 * @route   PATCH /api/kitchen/orders/:orderId/serve
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Mark served
 * Response: { success, message, order }
 */
exports.markOrderServed = async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findOne({ orderId: orderId });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    // ✅ Check if order can be marked served
    if (String(order.orderType || '').toLowerCase() === 'delivery') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Delivery orders are not served in the kitchen. Use the delivery dashboard to deliver.',
      });
    }
    if (order.status !== 'ready') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,

        error: `Order cannot be marked served (status: ${order.status})`,
      });
    }

    // ✅ Update status to served (both fields - see acceptOrder)
    const previousStatus = order.orderStatus || order.status || 'NONE';
    order.status = ORDER_STATUS.SERVED;
    order.orderStatus = 'SERVED';
    order.completedTime = new Date();
    await order.save();

    // ✅ Audit the READY -> SERVED step of the order lifecycle.
    await recordKitchenStatusChange(order, previousStatus, 'SERVED', req.user.id, 'Kitchen served the order');

    // ✅ Emit socket event for order status update
    const { emitSocketEvent } = require('../utils/socket');
    const orderSummary = formatKitchenOrder(order);
    emitSocketEvent('kitchen', 'order:status', orderSummary);
    emitSocketEvent(`order:${orderId}`, 'order:status', orderSummary);

    // ✅ Notify customer
    const notification = await Notification.create({
      userId: order.userId,
      title: 'Order Served!',
      message: `Your order #${orderId} has been served. Please pick it up.`,
      type: 'status_update',
      orderId: orderId,
      link: `/src/pages/customer/order-tracking.html?orderId=${orderId}`,
      isRead: false,
    });

    // ✅ Send real-time notification to customer
    emitSocketEvent(`user:${order.userId}`, 'notification:new', {
      id: notification._id,
      title: notification.title,
      message: notification.message,
      type: notification.type,
      orderId: notification.orderId,
      link: notification.link,
      isRead: notification.isRead,
      createdAt: notification.createdAt,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${orderId} has been served`,
      order: formatKitchenOrder(order),
    });
  } catch (error) {
    console.error('❌ Mark Order Served Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**

* @desc    Reject/cancel order from kitchen
* @route   PATCH /api/kitchen/orders/:orderId/reject
* @access  Private/Kitchen
*
* Frontend: kitchen/dashboard.html → Reject order
* Expected Body: { reason }
* Response: { success, message }
*/
exports.rejectOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await Order.findOne({ orderId: orderId });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    // ✅ Check if order can be rejected
    if (order.status !== 'pending' && order.status !== 'preparing') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,

        error: `Order cannot be rejected (status: ${order.status})`,
      });
    }

    // ✅ Update status to cancelled (both fields - see acceptOrder)
    const previousStatus = order.orderStatus || order.status || 'NONE';
    order.status = ORDER_STATUS.CANCELLED;
    order.orderStatus = 'CANCELLED';
    order.cancellationReason = reason || 'Rejected by kitchen';
    await order.save();

    // ✅ Audit the kitchen rejection in the order lifecycle.
    await recordKitchenStatusChange(
      order,
      previousStatus,
      'CANCELLED',
      req.user.id,
      `Rejected by kitchen${reason ? `: ${reason}` : ''}`
    );

    // ✅ Emit socket event for order status update
    const { emitSocketEvent } = require('../utils/socket');
    const orderSummary = formatKitchenOrder(order);
    emitSocketEvent('kitchen', 'order:status', orderSummary);
    emitSocketEvent(`order:${orderId}`, 'order:status', orderSummary);

    // ✅ Notify customer
    const notification = await Notification.create({
      userId: order.userId,
      title: 'Order Rejected',
      message: `Your order #${orderId} has been rejected by the

kitchen. ${reason || ''}`,
      type: 'system',
      orderId: orderId,
      isRead: false,
    });

    // ✅ Send real-time notification to customer
    emitSocketEvent(`user:${order.userId}`, 'notification:new', {
      id: notification._id,
      title: notification.title,
      message: notification.message,
      type: notification.type,
      orderId: notification.orderId,
      link: `/src/pages/customer/order-tracking.html?orderId=${orderId}`,
      isRead: notification.isRead,
      createdAt: notification.createdAt,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${orderId} has been rejected`,
    });
  } catch (error) {
    console.error('❌ Reject Order Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get kitchen stats only
 * @route   GET /api/kitchen/stats
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Live stats update
 * Response: { success, stats }
 */
exports.getKitchenStats = async (req, res) => {
  try {
    const pending = await Order.countDocuments({ ...KITCHEN_PAID_FILTER, status: 'pending' });
    const preparing = await Order.countDocuments({ ...KITCHEN_PAID_FILTER, status: 'preparing' });
    const ready = await Order.countDocuments({ ...KITCHEN_PAID_FILTER, status: 'ready' });
    const activeOrders = pending + preparing;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const completedToday = await Order.countDocuments({
      ...KITCHEN_PAID_FILTER,
      status: 'served',
      completedTime: { $gte: today },
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: {
        pending,
        preparing,
        ready,
        activeOrders,
        completedToday,
      },
    });
  } catch (error) {
    console.error('❌ Get Kitchen Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * Helper: Format order for delivery display (socket broadcast)
 */
function formatDeliveryOrder(order) {
  return {
    id: order._id,
    orderId: order.orderId,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    orderType: order.orderType,
    items: (order.items || []).map((item) => ({
      itemId: item.itemId,
      name: item.name,
      quantity: item.quantity,
      price: item.price,
      notes: item.notes || '',
      subtotal: item.subtotal || (Number(item.price) || 0) * (Number(item.quantity) || 0),
    })),
    itemCount: (order.items || []).reduce((sum, i) => sum + (Number(i.quantity) || 0), 0),
    subtotal: order.subtotal,
    serviceFee: order.serviceFee,
    deliveryFee: order.deliveryFee || 0,
    totalAmount: order.totalAmount,
    status: getKitchenStatus(order),
    deliveryInfo: order.deliveryInfo || null,
    deliveryStaffAssigned: order.deliveryStaffAssigned || null,
    deliveryStartedAt: order.deliveryStartedAt || null,
    readyForDeliveryAt: order.readyForDeliveryAt || null,
    deliveredAt: order.deliveredAt || null,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    orderDate: order.orderDate,
    orderTime: order.orderTime,
    createdAt: order.createdAt,
  };
}

/**
 * Helper: Format order for kitchen display
 */
function formatKitchenOrder(order) {
  const elapsed = order.createdAt ? getElapsedTime(order.createdAt) : '0 mins';

  const estimatedRemaining = order.estimatedCompletionTime
    ? Math.max(0, Math.round((order.estimatedCompletionTime - Date.now()) / 60000))
    : null;

  return {
    id: order._id,
    orderId: order.orderId,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    items: order.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      notes: item.notes || '',
      itemStatus: item.itemStatus || 'pending',
    })),
    status: order.status,
    orderStatus: order.orderStatus,
    // The board only ever receives PAID orders; the field is included so the
    // client can re-check on live `order:new` frames instead of trusting the
    // server filter alone.
    paymentStatus: order.paymentStatus,
    priority: order.priority,
    totalAmount: order.totalAmount,
    orderType: order.orderType,

    tableNumber: order.tableNumber,
    createdAt: order.createdAt,
    elapsedTime: elapsed,
    estimatedCompletionTime: order.estimatedCompletionTime,
    estimatedRemainingTime: estimatedRemaining,
    readyTime: order.readyTime,
    completedTime: order.completedTime,
    kitchenStaffAssigned: order.kitchenStaffAssigned,
    preparationDelayReason: order.preparationDelayReason,
  };
}

/**
 * Helper: Get elapsed time
 */
function getElapsedTime(date) {
  const diffMs = Date.now() - new Date(date).getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} mins`;
  const diffHours = Math.floor(diffMins / 60);
  return `${diffHours}h ${diffMins % 60}m`;
}

// ============================================================
// FOOD AVAILABILITY MANAGEMENT
// ============================================================

/**
 * @desc    Get all menu items with availability status
 * @route   GET /api/kitchen/menu-availability
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/availability.html → Display menu items
 * Response: { success, count, items: [...] }
 */
exports.getMenuAvailability = async (req, res) => {
  try {
    const MenuItem = require('../models/MenuItem');
    const menuItems = await MenuItem.find().sort({ category: 1, 'name.en': 1 });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: menuItems.length,
      items: menuItems.map((item) => ({
        id: item._id,
        name: item.name,
        category: item.category,
        price: item.price,
        isAvailable: item.isAvailable,
        preparationTime: item.preparationTime,
        outOfStockReason: item.outOfStockReason,
        lastUpdate: item.lastAvailabilityUpdate,
      })),
    });
  } catch (error) {
    console.error('❌ Get Menu Availability Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Toggle item availability (mark as out of stock or available)
 * @route   PATCH /api/kitchen/menu/:itemId/availability
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/availability.html → Toggle item
 * Body: { isAvailable, reason }
 * Response: { success, message, item }
 */
exports.updateItemAvailability = async (req, res) => {
  try {
    const { itemId } = req.params;
    const { isAvailable, reason } = req.body;
    const MenuItem = require('../models/MenuItem');

    const menuItem = await MenuItem.findById(itemId);
    if (!menuItem) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Menu item not found',
      });
    }

    // ✅ Quality hold: an item with an open quality issue (or an active hold)
    //    must be inspected and approved before it can become available again.
    if (isAvailable === true) {
      const StockAlert = require('../models/StockAlert');
      const openQuality = await StockAlert.countDocuments({
        itemId: menuItem._id,
        alertType: 'quality_issue',
        status: { $in: ['active', 'acknowledged'] },
      });
      if (openQuality > 0 || menuItem.qualityHold === true) {
        return res.status(HTTP_STATUS.CONFLICT).json({
          success: false,
          error: 'This item has a pending quality issue. Resolve the quality alert (inspection approval) before marking it available again.',
        });
      }
    }

    // ✅ Update availability
    const wasAvailable = menuItem.isAvailable;
    menuItem.isAvailable = isAvailable;
    menuItem.availability = isAvailable; // keep the two availability flags in sync
    menuItem.outOfStockReason = isAvailable ? null : reason || 'Out of stock';
    menuItem.lastAvailabilityUpdate = new Date();
    menuItem.updatedBy = req.user.id;
    const { recalculateAvailability, syncStockAlertsForItem } = require('../services/stock-alert.service');
    if (isAvailable === true && (menuItem.stockQuantity || 0) === 0) {
      // Never mark an item AVAILABLE while it has zero stock.
      menuItem.availabilityStatus = 'OUT_OF_STOCK';
    } else {
      recalculateAvailability(menuItem);
    }

    await menuItem.save();

    // ✅ If item became unavailable, notify affected orders
    if (wasAvailable && !isAvailable) {
      // Find orders containing this item that are still pending/preparing
      const Order = require('../models/Order');
      const affectedOrders = await Order.find({
        'items.itemId': itemId,
        status: { $in: ['pending', 'preparing'] },
      });

      // Create stock alert - unless an open alert for the same condition
      // already exists (no duplicate active alerts for the same item+type).
      const StockAlert = require('../models/StockAlert');
      const { getDefaultCafeteriaId } = require('../utils/cafeteria');
      const { normalizeRole } = require('../config/roles');
      const existingAlert = await StockAlert.findOne({
        itemId: menuItem._id,
        alertType: 'out_of_stock',
        status: { $in: ['active', 'acknowledged'] },
      });
      if (existingAlert) {
        existingAlert.reason = reason || existingAlert.reason;
        existingAlert.severity = affectedOrders.length > 0 ? 'high' : 'medium';
        try { await existingAlert.save(); } catch (e) { /* best-effort */ }
      } else {
        await StockAlert.create({
          itemId: menuItem._id,
          itemName: menuItem.name.en,
          alertType: 'out_of_stock',
          alertSource: 'manual',
          severity: affectedOrders.length > 0 ? 'high' : 'medium',
          reason: reason || 'Item marked unavailable by staff',
          reportedBy: req.user.id,
          reportedByRole: ['manager', 'cafeteria_admin'].includes(normalizeRole(req.user.role)) ? 'manager' : 'kitchen',
          cafeteriaId: menuItem.cafeteriaId || req.user.cafeteriaId || (await getDefaultCafeteriaId()) || null,
          affectedOrders: affectedOrders.map((o) => ({
            orderId: o._id,
            orderNumber: o.orderId,
          })),
        });
      }

      // Notify affected customers
      for (const order of affectedOrders) {
        const notification = await Notification.create({
          userId: order.userId,
          title: 'Item Unavailable',
          message: `The item "${menuItem.name.en}" in your order #${order.orderId} is currently unavailable.`,
          type: 'alert',
          orderId: order._id,
          isRead: false,
        });

        // Emit real-time notification to the customer
        emitSocketEvent(`user:${order.userId}`, 'notification:new', {
          id: notification._id,
          title: notification.title,
          message: notification.message,
          type: notification.type,
          orderId: notification.orderId,
          link: `/src/pages/customer/order-tracking.html?orderId=${order.orderId}`,
          isRead: notification.isRead,
          createdAt: notification.createdAt,
        });
      }

      // Emit socket event
      emitSocketEvent('kitchen', 'item:unavailable', {
        itemId: menuItem._id,
        itemName: menuItem.name.en,
        reason: menuItem.outOfStockReason,
      });
    }

    // Re-run the threshold lifecycle (e.g. availability restored while stock
    // is still low keeps the Low Stock alert active).
    await syncStockAlertsForItem(menuItem);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Item availability updated: ${isAvailable ? 'Available' : 'Out of stock'}`,
      item: {
        id: menuItem._id,
        name: menuItem.name,
        isAvailable: menuItem.isAvailable,
        outOfStockReason: menuItem.outOfStockReason,
        lastUpdate: menuItem.lastAvailabilityUpdate,
      },
    });
  } catch (error) {
    console.error('❌ Update Item Availability Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Report a stock/ingredient issue
 * @route   POST /api/kitchen/stock-alerts
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/stock-alerts.html → Report issue
 * Body: { itemId, itemName, alertType, severity, reason }
 * Response: { success, message, alert }
 */
exports.reportStockIssue = async (req, res) => {
  try {
    const { itemId, itemName, alertType, severity, reason } = req.body;
    const StockAlert = require('../models/StockAlert');

    // Validate request
    if (!itemName || !alertType || !reason) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Item name, alert type, and reason are required',
      });
    }

    const allowedSeverities = ['low', 'medium', 'high', 'critical'];
    if (!severity) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Severity is required',
      });
    }
    if (!allowedSeverities.includes(severity)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Invalid severity. Allowed: ${allowedSeverities.join(', ')}`,
      });
    }

    // Duplicate guard: never create a second open alert for the same item +
    // condition. Return the existing one so the caller can act on it.
    if (itemId && mongoose.isValidObjectId(String(itemId))) {
      const existing = await StockAlert.findOne({
        itemId,
        alertType,
        status: { $in: ['active', 'acknowledged'] },
      });
      if (existing) {
        return res.status(HTTP_STATUS.OK).json({
          success: true,
          existing: true,
          message: `An open ${alertType.replace(/_/g, ' ')} alert already exists for this item`,
          alert: {
            id: existing._id,
            itemName: existing.itemName,
            alertType: existing.alertType,
            severity: existing.severity,
            status: existing.status,
            createdAt: existing.createdAt,
          },
        });
      }
    }

    const { normalizeRole } = require('../config/roles');
    const actorRole = normalizeRole(req.user.role);
    const reportedByRole = actorRole === 'manager' || actorRole === 'cafeteria_admin' ? 'manager' : 'kitchen';

    // Create stock alert
    const { getDefaultCafeteriaId } = require('../utils/cafeteria');
    const alert = await StockAlert.create({
      itemId: itemId || null,
      itemName: itemName,
      alertType: alertType,
      alertSource: 'manual',
      severity: severity,
      reason: reason,
      reportedBy: req.user.id,
      reportedByRole: reportedByRole,
      cafeteriaId: req.user.cafeteriaId || (await getDefaultCafeteriaId()) || null,
      status: 'active',
    });

    // Quality issues put the item on quality hold: it must be inspected and
    // approved (quality alert resolved) before it can become AVAILABLE again.
    if (alertType === 'quality_issue' && itemId && mongoose.isValidObjectId(String(itemId))) {
      try {
        const { recalculateAvailability } = require('../services/stock-alert.service');
        const MenuItem = require('../models/MenuItem');
        const qualityItem = await MenuItem.findById(itemId);
        if (qualityItem) {
          qualityItem.qualityHold = true;
          recalculateAvailability(qualityItem);
          qualityItem.lastAvailabilityUpdate = new Date();
          qualityItem.updatedBy = req.user.id;
          await qualityItem.save({ validateBeforeSave: false });
        }
      } catch (e) {
        console.warn('⚠️ Could not apply quality hold:', e.message);
      }
    }

    await alert.populate('reportedBy', 'name role');

    // Notify this cafeteria's managers (persisted in-app notifications +
    // live socket fan-out so the manager dashboard badge/toast updates without
    // a manual refresh).
    const managerIds = await findCafeteriaManagers(alert.cafeteriaId);
    const notifyPromises = managerIds.map((manager) =>
      notifyUser(manager._id, {
        title: 'New Stock Issue Report',
        message: `${itemName} (${severity}) — ${reason}`,
        type: 'stock_alert',
        link: '/src/pages/manager/stock-alerts.html',
      })
    );
    await Promise.allSettled(notifyPromises);

    // Emit socket event to notify admin/manager dashboards
    const { emitSocketEvent } = require('../utils/socket');
    emitSocketEvent('admin', 'stock:alert', {
      alertId: alert._id,
      itemName: itemName,
      alertType: alertType,
      severity: severity,
      reason: reason,
      reporterName: alert.reportedBy?.name || null,
      cafeteriaId: alert.cafeteriaId,
      status: alert.status,
      createdAt: alert.createdAt,
    });

    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      message: 'Stock issue reported successfully',
      alert: {
        id: alert._id,
        itemName: alert.itemName,
        alertType: alert.alertType,
        severity: alert.severity,
        status: alert.status,
        reportedBy: alert.reportedBy?.name || null,
        createdAt: alert.createdAt,
      },
    });
  } catch (error) {
    console.error('❌ Report Stock Issue Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get stock alerts: persisted inventory threshold alerts (Low Stock /
 *          Out of Stock, maintained by the stock-alert lifecycle service) plus
 *          manual kitchen/manager reports.
 * @route   GET /api/v1/kitchen/stock-alerts
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/stock-alerts.html + manager/stock-alerts.html
 * Query Params: status (active | acknowledged | resolved | cancelled)
 * Response: { success, count, lowStockCount, outOfStockCount, alerts: [...] }
 */
/**
 * Shared StockAlert → API serializer (used by the list and the single-alert
 * details endpoint) so kitchen, manager and admin all receive identical
 * resolution fields (resolvedBy / resolvedAt / resolutionNote / ...).
 */
function serializeStockAlert(alert) {
  const item = alert.itemId && typeof alert.itemId === 'object' ? alert.itemId : null;
  const isSystem = alert.alertSource === 'system';
  const quantity = item ? item.stockQuantity : null;
  return {
    id: alert._id,
    source: isSystem ? 'inventory' : 'report',
    alertSource: alert.alertSource || 'manual',
    itemName: alert.itemName,
    itemId: item ? item._id : alert.itemId || null,
    currentQuantity: quantity,
    minimumQuantity: item ? item.lowStockThreshold : null,
    currentStockQuantity: quantity,
    lowStockThreshold: item ? item.lowStockThreshold : null,
    stockStatus: isSystem ? (Number(quantity) === 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK') : null,
    alertType: alert.alertType,
    severity: alert.severity,
    reason: alert.reason,
    status: alert.status,
    qualityHold: item ? item.qualityHold === true : false,
    reportedBy: isSystem ? 'System' : alert.reportedBy?.name || null,
    acknowledgedBy: alert.acknowledgedBy?.name || null,
    assignedTo: alert.assignedTo?.name || null,
    assignedNote: alert.assignedNote || null,
    assignedAt: alert.assignedAt,
    resolutionNote: alert.resolutionNote || null,
    resolutionReason: alert.resolutionReason || null,
    resolutionSolution: alert.resolutionSolution || null,
    resolutionQuantity: alert.resolutionQuantity ?? null,
    resolvedBy: alert.resolvedBy?.name || null,
    resolvedAt: alert.resolvedAt,
    affectedOrders: alert.affectedOrders?.length || 0,
    createdAt: alert.createdAt,
    updatedAt: alert.updatedAt,
  };
}

exports.getStockAlerts = async (req, res) => {
  try {
    const { status } = req.query;
    const MenuItem = require('../models/MenuItem');
    const StockAlert = require('../models/StockAlert');
    const mongoose = require('mongoose');
    const { resolveCafeteriaScope, cafeteriaFilter, getDefaultCafeteriaId } = require('../utils/cafeteria');
    const stockAlertService = require('../services/stock-alert.service');

    // ✅ Cafeteria scope from trusted server-side data (admins see all;
    //    kitchen/manager are scoped to their assigned cafeteria).
    let scope;
    try {
      scope = resolveCafeteriaScope(req);
    } catch (scopeError) {
      // Kitchen user without an assignment: fall back to the default cafeteria
      // (matches ensureDefaultCafeteria's backfill) instead of failing the page.
      scope = { cafeteriaId: await getDefaultCafeteriaId(), global: false };
    }

    // ✅ 1) Lifecycle sync pass: every threshold-breaching MenuItem gets (and
    //    keeps) exactly one open system alert; alerts whose condition cleared
    //    are resolved. This makes the list self-healing after order
    //    decrements, cancellation restores, admin edits and restocks.
    try {
      const openSystemAlerts = await StockAlert.find({
        ...cafeteriaFilter(scope),
        alertSource: 'system',
        status: { $in: stockAlertService.OPEN_STATUSES },
      })
        .select('itemId')
        .lean();
      const openItemIds = [...new Set(openSystemAlerts.map((a) => (a.itemId ? String(a.itemId) : null)).filter(Boolean))]
        .filter((id) => mongoose.isValidObjectId(id));

      const itemsToSync = new Map();
      const breachItems = await MenuItem.find({
        ...cafeteriaFilter(scope),
        isActive: true,
        $expr: { $lte: ['$stockQuantity', '$lowStockThreshold'] },
      });
      breachItems.forEach((i) => itemsToSync.set(String(i._id), i));
      if (openItemIds.length) {
        const openItems = await MenuItem.find({ _id: { $in: openItemIds } });
        openItems.forEach((i) => itemsToSync.set(String(i._id), i));
      }
      await stockAlertService.syncItems([...itemsToSync.values()], { emit: true });
    } catch (syncError) {
      console.warn('⚠️ Stock alert sync pass failed:', syncError.message);
    }

    // ✅ 2) Persisted alerts (system threshold alerts + manual reports).
    const alertFilter = { ...cafeteriaFilter(scope) };
    if (status) {
      alertFilter.status = status;
    }
    const alertDocs = await StockAlert.find(alertFilter)
      .populate('reportedBy', 'name role')
      .populate('resolvedBy', 'name role')
      .populate('itemId', 'stockQuantity lowStockThreshold name availabilityStatus qualityHold')
      .populate('acknowledgedBy', 'name role')
      .populate('assignedTo', 'name role')
      .sort({ createdAt: -1 });

    const serialized = alertDocs.map((alert) => serializeStockAlert(alert));

    // Reports stay newest-first at the top; system threshold alerts follow,
    // out-of-stock first and lowest quantity first.
    const reportsSorted = serialized
      .filter((a) => a.source === 'report')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const inventorySorted = serialized
      .filter((a) => a.source === 'inventory')
      .sort((a, b) => {
        if (a.stockStatus !== b.stockStatus) return a.stockStatus === 'OUT_OF_STOCK' ? -1 : 1;
        return (a.currentQuantity || 0) - (b.currentQuantity || 0);
      });

    const activeSystem = inventorySorted.filter((a) => a.status === 'active' || a.status === 'acknowledged');

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: reportsSorted.length + inventorySorted.length,
      lowStockCount: activeSystem.filter((a) => a.stockStatus === 'LOW_STOCK').length,
      outOfStockCount: activeSystem.filter((a) => a.stockStatus === 'OUT_OF_STOCK').length,
      alerts: [...reportsSorted, ...inventorySorted],
    });
  } catch (error) {
    console.error('❌ Get Stock Alerts Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Single stock-alert details (read-only). Returns the authoritative
 *          MongoDB record by id — including resolution fields when the alert
 *          has been resolved — so kitchen staff can review resolution history.
 *          Viewing NEVER mutates the alert (an active alert stays active).
 * @route   GET /api/v1/kitchen/stock-alerts/:id
 * @access  Private/Kitchen, Manager, Admin
 */
exports.getStockAlertDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const mongoose = require('mongoose');
    const StockAlert = require('../models/StockAlert');
    const { resolveCafeteriaScope, cafeteriaFilter, getDefaultCafeteriaId } = require('../utils/cafeteria');

    if (!mongoose.isValidObjectId(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Invalid stock alert id',
      });
    }

    // Same trusted server-side scoping as the list endpoint: admins see all;
    // kitchen/manager users are limited to their assigned cafeteria.
    let scope;
    try {
      scope = resolveCafeteriaScope(req);
    } catch (scopeError) {
      scope = { cafeteriaId: await getDefaultCafeteriaId(), global: false };
    }

    const query = { _id: id };
    if (!scope.global) {
      Object.assign(query, cafeteriaFilter(scope));
    }

    const alert = await StockAlert.findOne(query)
      .populate('reportedBy', 'name role')
      .populate('resolvedBy', 'name role')
      .populate('itemId', 'stockQuantity lowStockThreshold name availabilityStatus qualityHold')
      .populate('acknowledgedBy', 'name role')
      .populate('assignedTo', 'name role');

    if (!alert) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Stock alert not found',
      });
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      alert: serializeStockAlert(alert),
    });
  } catch (error) {
    console.error('❌ Get Stock Alert Details Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Acknowledge a stock alert (manager recognizes the issue and takes
 *          responsibility: the alert is assigned to the requesting admin and
 *          moves to `acknowledged` / IN_PROGRESS - it is NEVER resolved here).
 * @route   PATCH /api/kitchen/stock-alerts/:id/acknowledge
 * @access  Private/Kitchen
 * Body:    { assignedTo?, note? }
 * Response: { success, message, alert }
 */
exports.acknowledgeStockAlert = async (req, res) => {
  try {
    const { id } = req.params;
    const { assignedTo, note } = req.body || {};
    const mongoose = require('mongoose');
    const StockAlert = require('../models/StockAlert');

    const alert = await StockAlert.findById(id);
    if (!alert) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Stock alert not found' });
    }

    if (alert.status === 'resolved' || alert.status === 'cancelled') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'This alert is already closed' });
    }

    // ✅ Take Responsibility: persist the assignment to the admin who clicked
    //    the button (unless a different assignee was explicitly chosen). The
    //    frontend never knows other users' ids, so self-assignment is the
    //    default - this used to stay `null` because the body never carried one.
    let assigneeId = req.user.id;
    if (assignedTo !== undefined && assignedTo !== null && String(assignedTo).trim() !== '') {
      if (!mongoose.isValidObjectId(String(assignedTo))) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Invalid assignee id' });
      }
      assigneeId = String(assignedTo);
    }

    const firstAcknowledgement = alert.status !== 'acknowledged';
    const assigneeChanged = String(alert.assignedTo || '') !== String(assigneeId);

    alert.status = 'acknowledged';
    alert.acknowledgedBy = req.user.id;
    alert.assignedTo = assigneeId;
    alert.assignedAt = new Date();
    if (note !== undefined) {
      alert.assignedNote = note || null;
    }
    await alert.save();

    await alert.populate('acknowledgedBy', 'name role');
    await alert.populate('assignedTo', 'name role');

    // Notify the reporting kitchen staff once, when the alert is first taken -
    // a duplicate/replayed acknowledge must not spam the reporter.
    if (firstAcknowledgement) {
      const reporterId = alert.reportedBy;
      await notifyUser(reporterId, {
        title: 'Stock Issue Acknowledged',
        message: `A manager acknowledged your report for ${alert.itemName}.`,
        type: 'stock_alert',
      });
    }

    // Push the updated row to every open dashboard (manager + kitchen rooms)
    // so both sides update without a manual refresh.
    if (firstAcknowledgement || assigneeChanged) {
      const { emitSocketEvent } = require('../utils/socket');
      emitSocketEvent('admin', 'stock:alert:updated', {
        alertId: alert._id,
        itemName: alert.itemName,
        severity: alert.severity,
        status: alert.status,
        acknowledgedBy: alert.acknowledgedBy?.name || req.user.name || null,
        assignedTo: alert.assignedTo?.name || null,
        assignedNote: alert.assignedNote || null,
        assignedAt: alert.assignedAt,
        updatedAt: alert.updatedAt,
      });
      emitSocketEvent('kitchen', 'stock:alert:updated', {
        alertId: alert._id,
        itemName: alert.itemName,
        status: alert.status,
        updatedAt: alert.updatedAt,
      });
    }

    // Display-ready payload: lets the dashboard flip to IN_PROGRESS and swap
    // "Take Responsibility" for "Mark Solved" straight from this response,
    // without waiting for a follow-up list refetch.
    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Alert acknowledged',
      alert: {
        id: alert._id,
        status: alert.status,
        acknowledgedBy: alert.acknowledgedBy?.name || req.user.name || null,
        assignedTo: alert.assignedTo?.name || null,
        assignedAt: alert.assignedAt,
        assignedNote: alert.assignedNote || null,
        updatedAt: alert.updatedAt,
      },
    });
  } catch (error) {
    console.error('❌ Acknowledge Stock Alert Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Resolve a stock alert (record resolution note + who resolved it).
 *          A threshold alert (low_stock / out_of_stock) linked to an item is
 *          only genuinely resolved when the ACTUAL stock condition is
 *          satisfied - or when the manager records the real counted quantity
 *          (which is applied atomically and audited). Submitting a restock
 *          REQUEST never resolves an alert.
 * @route   PATCH /api/kitchen/stock-alerts/:id/resolve
 * @access  Private/Kitchen
 * Body:    { resolutionReason, resolutionSolution, resolutionNote?, newStockQuantity? }
 * Response: { success, resolved, message, alert }
 */
exports.resolveStockAlert = async (req, res) => {
  try {
    const { id } = req.params;
    const StockAlert = require('../models/StockAlert');
    const stockAlertService = require('../services/stock-alert.service');
    const { normalizeRole } = require('../config/roles');

    const alert = await StockAlert.findById(id);
    if (!alert) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Stock alert not found' });
    }

    if (alert.status === 'resolved' || alert.status === 'cancelled') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'This alert is already closed' });
    }

    const resolutionReason = String((req.body && (req.body.resolutionReason || req.body.reason)) || '').trim();
    const resolutionSolution = String((req.body && (req.body.resolutionSolution || req.body.correctiveAction || req.body.solutionOption)) || '').trim();
    const details = String((req.body && (req.body.resolutionNote || req.body.resolutionDetails || req.body.details || req.body.note)) || '').trim();

    if (!resolutionReason || !resolutionSolution) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Resolution reason and solution are required',
      });
    }
    if ((resolutionReason === 'Other' || resolutionSolution === 'Other') && !details) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Please explain the selected Other option',
      });
    }

    const rawQty = (req.body && (req.body.newStockQuantity ?? req.body.newQuantity ?? req.body.stockQuantity ?? req.body.updatedStockQuantity));
    let resolvedQty = null;
    const hasQty = rawQty !== undefined && rawQty !== null && String(rawQty).trim() !== '';
    if (hasQty) {
      const qty = Number(rawQty);
      if (!Number.isInteger(qty) || qty < 0) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Stock quantity must be a non-negative integer' });
      }
    }
    const qtyValue = hasQty ? Number(rawQty) : null;

    const MenuItem = require('../models/MenuItem');
    let item = null;
    if (alert.itemId) {
      try { item = await MenuItem.findById(alert.itemId); } catch (e) { item = null; }
    }
    if (!item && alert.itemName) {
      const normalized = String(alert.itemName || '').trim();
      const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameMatches = await MenuItem.find({
        cafeteriaId: alert.cafeteriaId,
        $or: [
          { 'name.en': { $regex: '^' + escaped + '$', $options: 'i' } },
          { 'name.am': { $regex: '^' + escaped + '$', $options: 'i' } },
        ],
      });
      if (nameMatches.length > 1) {
        console.warn('Resolve stock alert ambiguous item', { reportId: String(alert._id), itemName: alert.itemName, matches: nameMatches.length });
        return res.status(HTTP_STATUS.CONFLICT).json({ success: false, error: 'Multiple inventory items match this name; please update stock from the menu first.' });
      }
      if (nameMatches.length === 1) item = nameMatches[0];
    }

    // ✅ Optional counted-quantity update: applied atomically to the item's
    //    authoritative stock, with a StockTransaction audit record. The value
    //    is the REAL counted/received quantity - never a fabricated increase.
    if (hasQty && item) {
      const previous = Math.max(0, Number(item.stockQuantity) || 0);
      const updatedItem = await MenuItem.findOneAndUpdate(
        { _id: item._id },
        { $set: { stockQuantity: qtyValue } },
        { new: true }
      );
      if (updatedItem) {
        stockAlertService.recalculateAvailability(updatedItem);
        updatedItem.lastAvailabilityUpdate = new Date();
        updatedItem.updatedBy = req.user.id;
        try { await updatedItem.save({ validateBeforeSave: false }); } catch (e) { /* best-effort */ }
        try {
          const StockTransaction = require('../models/StockTransaction');
          await StockTransaction.create({
            foodId: updatedItem._id,
            previousQuantity: previous,
            quantityChanged: qtyValue - previous,
            newQuantity: qtyValue,
            action: 'SET',
            performedBy: req.user.id,
            performedByRole: normalizeRole(req.user.role),
            cafeteriaId: updatedItem.cafeteriaId || alert.cafeteriaId || null,
          });
        } catch (e) { /* transaction log best-effort */ }
        const { logAction } = require('../utils/audit');
        await logAction({
          req,
          action: 'STOCK_QUANTITY_SET',
          entityType: 'MenuItem',
          entityId: String(updatedItem._id),
          description: `${req.user.name || 'Staff'} set ${updatedItem.name?.en || 'item'} stock to ${qtyValue} while resolving an alert`,
          cafeteriaId: updatedItem.cafeteriaId || alert.cafeteriaId,
          metadata: {
            itemId: String(updatedItem._id),
            previousQuantity: previous,
            newQuantity: qtyValue,
            stockAlertId: String(alert._id),
          },
        });
        item = updatedItem;
        resolvedQty = qtyValue;
        alert.itemId = updatedItem._id;
      }
    } else if (hasQty && !item) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Inventory item not found for this alert' });
    }

    // ✅ Genuine-resolution guard: a threshold alert linked to a real item can
    //    only be resolved when the CURRENT database quantity actually satisfies
    //    the configured rule (quantity above the minimum threshold). The
    //    resolving admin cannot clear an unresolved physical stock problem just
    //    to remove the alert - they record the real quantity or the item is
    //    marked unavailable first.
    let stillBreached = false;
    let condition = null;
    if (item && ['low_stock', 'out_of_stock'].includes(alert.alertType)) {
      condition = stockAlertService.getThresholdCondition(item);
      stillBreached = condition.breached;
    }

    if (stillBreached) {
      if (!hasQty) {
        return res.status(HTTP_STATUS.CONFLICT).json({
          success: false,
          error: `Stock for ${alert.itemName} is still ${condition.alertType === 'out_of_stock' ? 'out of stock' : 'below the minimum threshold'} (current ${condition.quantity}, minimum ${condition.threshold}). Record the actual quantity received, or mark the item unavailable.`,
          currentQuantity: condition.quantity,
          minimumQuantity: condition.threshold,
        });
      }
      // A real quantity was recorded but the condition persists (partial
      // restock) → keep the alert open; the lifecycle sync refreshes it.
      await stockAlertService.syncStockAlertsForItem(item);
      if (resolvedQty !== null) {
        // Persist the counted quantity on the still-open alert so the manager
        // list can show what was physically counted, not just the response.
        try {
          await StockAlert.updateOne({ _id: alert._id }, { $set: { resolutionQuantity: resolvedQty } });
        } catch (e) { /* best-effort */ }
      }
      // Report the status that is ACTUALLY stored right now (the sync pass may
      // have re-created a system alert, while a manual/acknowledged alert keeps
      // its state) - the frontend must never be told a status that is not in
      // MongoDB.
      const stillOpen = await StockAlert.findById(alert._id).select('status').lean();
      return res.status(HTTP_STATUS.OK).json({
        success: true,
        resolved: false,
        message: `Stock quantity updated to ${qtyValue}, but ${alert.itemName} is still below its minimum threshold (${condition.threshold}). The alert remains active.`,
        alert: {
          id: alert._id,
          status: (stillOpen && stillOpen.status) || alert.status,
          resolutionQuantity: resolvedQty,
        },
      });
    }

    // ✅ Condition satisfied (or not a verifiable threshold alert) → resolve.
    alert.status = 'resolved';
    alert.resolvedBy = req.user.id;
    alert.resolvedAt = new Date();
    alert.resolutionNote = details || null;
    alert.resolutionReason = resolutionReason;
    alert.resolutionSolution = resolutionSolution;
    alert.resolutionQuantity = resolvedQty;
    await alert.save();

    // Quality issue resolved (inspection approved): lift the quality hold so
    // the item can become AVAILABLE again (recalculate respects stock level).
    if (alert.alertType === 'quality_issue' && item) {
      try {
        const otherOpenQuality = await StockAlert.countDocuments({
          itemId: item._id,
          alertType: 'quality_issue',
          status: { $in: ['active', 'acknowledged'] },
          _id: { $ne: alert._id },
        });
        if (otherOpenQuality === 0 && item.qualityHold === true) {
          item.qualityHold = false;
          stockAlertService.recalculateAvailability(item);
          item.lastAvailabilityUpdate = new Date();
          await item.save({ validateBeforeSave: false });
        }
      } catch (e) {
        console.warn('⚠️ Could not lift quality hold:', e.message);
      }
    }

    // Keep the threshold lifecycle in sync (resolves/creates any sibling
    // system alerts according to the latest quantity).
    if (item) {
      await stockAlertService.syncStockAlertsForItem(item);
    }

    // Notify the reporting kitchen staff that the issue was resolved.
    const reporterId = alert.reportedBy;
    await notifyUser(reporterId, {
      title: 'Stock Issue Resolved',
      message: `Your report for ${alert.itemName} was resolved${alert.resolutionNote ? `: ${alert.resolutionNote}` : ''}.`,
      type: 'stock_alert',
    });

    // Push the updated row to every open dashboard (manager + kitchen rooms).
    const { emitSocketEvent } = require('../utils/socket');
    emitSocketEvent('admin', 'stock:alert:updated', {
      alertId: alert._id,
      itemName: alert.itemName,
      severity: alert.severity,
      status: alert.status,
      resolutionNote: alert.resolutionNote || null,
      resolvedBy: req.user.name || null,
      resolvedAt: alert.resolvedAt,
      updatedAt: alert.updatedAt,
    });
    emitSocketEvent('kitchen', 'stock:alert:updated', {
      alertId: alert._id,
      itemName: alert.itemName,
      status: alert.status,
      resolutionNote: alert.resolutionNote || null,
      updatedAt: alert.updatedAt,
    });

    res
      .status(HTTP_STATUS.OK)
      .json({ success: true, resolved: true, message: 'Alert marked as resolved', alert: {
        id: alert._id,
        status: alert.status,
        resolutionReason: alert.resolutionReason,
        resolutionSolution: alert.resolutionSolution,
        resolutionNote: alert.resolutionNote,
        resolutionQuantity: alert.resolutionQuantity,
        // Display-ready resolver (name), so the dashboard can render the final
        // Resolved state straight from this response without a refetch.
        resolvedBy: req.user.name || null,
        resolvedAt: alert.resolvedAt,
        updatedAt: alert.updatedAt,
      } });
  } catch (error) {
    console.error('❌ Resolve Stock Alert Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

// ============================================================
// ORDER HISTORY & DETAILED VIEW
// ============================================================

/**
 * @desc    Get detailed order view with item-level status
 * @route   GET /api/kitchen/orders/:orderId/details
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/order-details.html → Show full order
 * Response: { success, order }
 */
exports.getOrderDetails = async (req, res) => {
  try {
    const { orderId } = req.params;

    // `userId` is never read: the customer block below is built from the stored
    // customerName/customerPhone. Only `kitchenStaffAssigned` is populated,
    // because the response does read .name off it. Every populate here is its
    // own round trip to Atlas.
    const order = await Order.findOne({ orderId: orderId })
      .populate('kitchenStaffAssigned', 'name');

    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    const elapsed = getElapsedTime(order.createdAt);
    const estimate = calculateEstimatedCompletionTime(order);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      order: {
        id: order._id,
        orderId: order.orderId,
        customer: {
          name: order.customerName,
          phone: order.customerPhone,
        },
        orderType: order.orderType,
        tableNumber: order.tableNumber,
        status: order.status,
        priority: order.priority,
        items: order.items.map((item) => ({
          id: item._id,
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          notes: item.notes,
          itemStatus: item.itemStatus,
          preparationStartedAt: item.preparationStartedAt,
          preparationCompletedAt: item.preparationCompletedAt,
        })),
        subtotal: order.subtotal,
        serviceFee: order.serviceFee,
        totalAmount: order.totalAmount,
        createdAt: order.createdAt,
        elapsedTime: elapsed,
        estimatedCompletionTime: estimate,
        preparationDelayReason: order.preparationDelayReason,
        kitchenStaffAssigned: order.kitchenStaffAssigned?.name,
        readyTime: order.readyTime,
        completedTime: order.completedTime,
      },
    });
  } catch (error) {
    console.error('❌ Get Order Details Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Update item-level preparation status
 * @route   PATCH /api/kitchen/orders/:orderId/items/:itemId/status
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/order-details.html → Update item status
 * Body: { itemStatus }
 * Response: { success, message, order }
 */
exports.updateItemPreparationStatus = async (req, res) => {
  try {
    const { orderId, itemId } = req.params;
    const { itemStatus } = req.body;

    const order = await Order.findOne({ orderId: orderId });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    // Find the item in the order
    const item = order.items.id(itemId);
    if (!item) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Item not found in order',
      });
    }

    // Update item status
    item.itemStatus = itemStatus;
    if (itemStatus === 'preparing') {
      item.preparationStartedAt = new Date();
    } else if (itemStatus === 'ready') {
      item.preparationCompletedAt = new Date();
    }

    await order.save();

    // Emit socket event
    const { emitSocketEvent } = require('../utils/socket');
    emitSocketEvent(`order:${orderId}`, 'item:status:updated', {
      itemId: itemId,
      itemStatus: itemStatus,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Item status updated to ${itemStatus}`,
      order: formatKitchenOrder(order),
    });
  } catch (error) {
    console.error('❌ Update Item Preparation Status Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Add preparation delay reason
 * @route   PATCH /api/kitchen/orders/:orderId/delay
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Report delay
 * Body: { reason }
 * Response: { success, message }
 */
exports.addPreparationDelay = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Delay reason is required',
      });
    }

    const order = await Order.findOne({ orderId: orderId });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    order.preparationDelayReason = reason;
    await order.save();

    // Notify customer
    await Notification.create({
      userId: order.userId,
      title: 'Order Delay',
      message: `Your order #${orderId} is taking longer than expected. Reason: ${reason}`,
      type: 'delay',
      orderId: orderId,
      isRead: false,
    });

    // Emit socket event
    const { emitSocketEvent } = require('../utils/socket');
    emitSocketEvent(`order:${orderId}`, 'order:delayed', {
      reason: reason,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Delay reason recorded and customer notified',
    });
  } catch (error) {
    console.error('❌ Add Preparation Delay Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Calculate estimated completion time based on menu items
 */
function calculateEstimatedCompletionTime(order) {
  if (!order.items || order.items.length === 0) return null;

  // Get max preparation time from all items
  const MenuItem = require('../models/MenuItem');
  let maxPrepTime = 0;
  let itemCount = 0;

  order.items.forEach((item) => {
    const prepTime = item.preparationTime || 10;
    maxPrepTime = Math.max(maxPrepTime, prepTime);
    itemCount++;
  });

  // Add buffer for multiple items
  const buffer = Math.ceil((itemCount - 1) * 2);
  const estimatedMinutes = maxPrepTime + buffer;
  const estimatedTime = new Date(Date.now() + estimatedMinutes * 60000);

  return estimatedTime;
}
// ============================================================
// ORDER HISTORY & DETAILED VIEW
// ============================================================

/**
 * @desc    Get detailed order view with item-level status
 * @route   GET /api/kitchen/orders/:orderId/details
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/order-details.html → Show full order
 * Response: { success, order }
 */
exports.getOrderDetails = async (req, res) => {
  try {
    const { orderId } = req.params;

    // `userId` is never read: the customer block below is built from the stored
    // customerName/customerPhone. Only `kitchenStaffAssigned` is populated,
    // because the response does read .name off it. Every populate here is its
    // own round trip to Atlas.
    const order = await Order.findOne({ orderId: orderId })
      .populate('kitchenStaffAssigned', 'name');

    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    const elapsed = getElapsedTime(order.createdAt);
    const estimate = calculateEstimatedCompletionTime(order);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      order: {
        id: order._id,
        orderId: order.orderId,
        customer: {
          name: order.customerName,
          phone: order.customerPhone,
        },
        orderType: order.orderType,
        tableNumber: order.tableNumber,
        status: order.status,
        priority: order.priority,
        items: order.items.map((item) => ({
          id: item._id,
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          notes: item.notes,
          itemStatus: item.itemStatus,
          preparationStartedAt: item.preparationStartedAt,
          preparationCompletedAt: item.preparationCompletedAt,
        })),
        subtotal: order.subtotal,
        serviceFee: order.serviceFee,
        totalAmount: order.totalAmount,
        createdAt: order.createdAt,
        elapsedTime: elapsed,
        estimatedCompletionTime: estimate,
        preparationDelayReason: order.preparationDelayReason,
        kitchenStaffAssigned: order.kitchenStaffAssigned?.name,
        readyTime: order.readyTime,
        completedTime: order.completedTime,
      },
    });
  } catch (error) {
    console.error('❌ Get Order Details Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Update item-level preparation status
 * @route   PATCH /api/kitchen/orders/:orderId/items/:itemId/status
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/order-details.html → Update item status
 * Body: { itemStatus }
 * Response: { success, message, order }
 */
exports.updateItemPreparationStatus = async (req, res) => {
  try {
    const { orderId, itemId } = req.params;
    const { itemStatus } = req.body;

    const order = await Order.findOne({ orderId: orderId });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    // Find the item in the order
    const item = order.items.id(itemId);
    if (!item) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Item not found in order',
      });
    }

    // Update item status
    item.itemStatus = itemStatus;
    if (itemStatus === 'preparing') {
      item.preparationStartedAt = new Date();
    } else if (itemStatus === 'ready') {
      item.preparationCompletedAt = new Date();
    }

    await order.save();

    // Emit socket event
    const { emitSocketEvent } = require('../utils/socket');
    emitSocketEvent(`order:${orderId}`, 'item:status:updated', {
      itemId: itemId,
      itemStatus: itemStatus,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Item status updated to ${itemStatus}`,
      order: formatKitchenOrder(order),
    });
  } catch (error) {
    console.error('❌ Update Item Preparation Status Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Add preparation delay reason
 * @route   PATCH /api/kitchen/orders/:orderId/delay
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Report delay
 * Body: { reason }
 * Response: { success, message }
 */
exports.addPreparationDelay = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Delay reason is required',
      });
    }

    const order = await Order.findOne({ orderId: orderId });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    order.preparationDelayReason = reason;
    await order.save();

    // Notify customer
    await Notification.create({
      userId: order.userId,
      title: 'Order Delay',
      message: `Your order #${orderId} is taking longer than expected. Reason: ${reason}`,
      type: 'delay',
      orderId: orderId,
      isRead: false,
    });

    // Emit socket event
    const { emitSocketEvent } = require('../utils/socket');
    emitSocketEvent(`order:${orderId}`, 'order:delayed', {
      reason: reason,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Delay reason recorded and customer notified',
    });
  } catch (error) {
    console.error('❌ Add Preparation Delay Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Calculate estimated completion time based on menu items
 */
function calculateEstimatedCompletionTime(order) {
  if (!order.items || order.items.length === 0) return null;

  // Get max preparation time from all items
  const MenuItem = require('../models/MenuItem');
  let maxPrepTime = 0;
  let itemCount = 0;

  order.items.forEach((item) => {
    const prepTime = item.preparationTime || 10;
    maxPrepTime = Math.max(maxPrepTime, prepTime);
    itemCount++;
  });

  // Add buffer for multiple items
  const buffer = Math.ceil((itemCount - 1) * 2);
  const estimatedMinutes = maxPrepTime + buffer;
  const estimatedTime = new Date(Date.now() + estimatedMinutes * 60000);

  return estimatedTime;
}
// ============================================================
// ORDER HISTORY & DETAILED VIEW
// ============================================================

/**
 * @desc    Get detailed order view with item-level status
 * @route   GET /api/kitchen/orders/:orderId/details
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/order-details.html → Show full order
 * Response: { success, order }
 */
exports.getOrderDetails = async (req, res) => {
  try {
    const { orderId } = req.params;

    // `userId` is never read: the customer block below is built from the stored
    // customerName/customerPhone. Only `kitchenStaffAssigned` is populated,
    // because the response does read .name off it. Every populate here is its
    // own round trip to Atlas.
    const order = await Order.findOne({ orderId: orderId })
      .populate('kitchenStaffAssigned', 'name');

    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    const elapsed = getElapsedTime(order.createdAt);
    const estimate = calculateEstimatedCompletionTime(order);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      order: {
        id: order._id,
        orderId: order.orderId,
        customer: {
          name: order.customerName,
          phone: order.customerPhone,
        },
        orderType: order.orderType,
        tableNumber: order.tableNumber,
        status: order.status,
        priority: order.priority,
        items: order.items.map((item) => ({
          id: item._id,
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          notes: item.notes,
          itemStatus: item.itemStatus,
          preparationStartedAt: item.preparationStartedAt,
          preparationCompletedAt: item.preparationCompletedAt,
        })),
        subtotal: order.subtotal,
        serviceFee: order.serviceFee,
        totalAmount: order.totalAmount,
        createdAt: order.createdAt,
        elapsedTime: elapsed,
        estimatedCompletionTime: estimate,
        preparationDelayReason: order.preparationDelayReason,
        kitchenStaffAssigned: order.kitchenStaffAssigned?.name,
        readyTime: order.readyTime,
        completedTime: order.completedTime,
      },
    });
  } catch (error) {
    console.error('❌ Get Order Details Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Update item-level preparation status
 * @route   PATCH /api/kitchen/orders/:orderId/items/:itemId/status
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/order-details.html → Update item status
 * Body: { itemStatus }
 * Response: { success, message, order }
 */
exports.updateItemPreparationStatus = async (req, res) => {
  try {
    const { orderId, itemId } = req.params;
    const { itemStatus } = req.body;

    const order = await Order.findOne({ orderId: orderId });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    // Find the item in the order
    const item = order.items.id(itemId);
    if (!item) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Item not found in order',
      });
    }

    // Update item status
    item.itemStatus = itemStatus;
    if (itemStatus === 'preparing') {
      item.preparationStartedAt = new Date();
    } else if (itemStatus === 'ready') {
      item.preparationCompletedAt = new Date();
    }

    await order.save();

    // Emit socket event
    const { emitSocketEvent } = require('../utils/socket');
    emitSocketEvent(`order:${orderId}`, 'item:status:updated', {
      itemId: itemId,
      itemStatus: itemStatus,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Item status updated to ${itemStatus}`,
      order: formatKitchenOrder(order),
    });
  } catch (error) {
    console.error('❌ Update Item Preparation Status Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Add preparation delay reason
 * @route   PATCH /api/kitchen/orders/:orderId/delay
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Report delay
 * Body: { reason }
 * Response: { success, message }
 */
exports.addPreparationDelay = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Delay reason is required',
      });
    }

    const order = await Order.findOne({ orderId: orderId });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    order.preparationDelayReason = reason;
    await order.save();

    // Notify customer
    await Notification.create({
      userId: order.userId,
      title: 'Order Delay',
      message: `Your order #${orderId} is taking longer than expected. Reason: ${reason}`,
      type: 'delay',
      orderId: orderId,
      isRead: false,
    });

    // Emit socket event
    const { emitSocketEvent } = require('../utils/socket');
    emitSocketEvent(`order:${orderId}`, 'order:delayed', {
      reason: reason,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: 'Delay reason recorded and customer notified',
    });
  } catch (error) {
    console.error('❌ Add Preparation Delay Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Calculate estimated completion time based on menu items
 */
function calculateEstimatedCompletionTime(order) {
  if (!order.items || order.items.length === 0) return null;

  // Get max preparation time from all items
  const MenuItem = require('../models/MenuItem');
  let maxPrepTime = 0;
  let itemCount = 0;

  order.items.forEach((item) => {
    const prepTime = item.preparationTime || 10;
    maxPrepTime = Math.max(maxPrepTime, prepTime);
    itemCount++;
  });

  // Add buffer for multiple items
  const buffer = Math.ceil((itemCount - 1) * 2);
  const estimatedMinutes = maxPrepTime + buffer;
  const estimatedTime = new Date(Date.now() + estimatedMinutes * 60000);

  return estimatedTime;
}
