const OrderStatusHistory = require('../models/OrderStatusHistory');

/**
 * Order lifecycle step 2 -> 3: "Payment successful -> Order = PENDING ->
 * Kitchen Dashboard".
 *
 * An order is created PENDING but is NOT part of the kitchen's work queue until
 * its payment is confirmed: the kitchen board, the orders list and the stats
 * all filter on `paymentStatus: 'PAID'` (see kitchen.controller.js), and the
 * `order:new` frame + the durable kitchen notification are only fanned out from
 * here. This module is the single place that moves a paid order into that
 * queue, so Chapa verification, the simulated checkout and the cashier's
 * counter collection all behave identically.
 */

/** Kitchen stages that mean the order has already entered (or left) the queue. */
const PAST_KITCHEN_QUEUE = [
  'preparing',
  'ready',
  'served',
  'picked_up',
  'out_for_delivery',
  'arrived',
  'delivered',
  'completed',
  'cancelled',
  'failed',
];

function isAwaitingKitchenQueue(order) {
  const stage = String(order?.orderStatus || order?.status || 'pending').toLowerCase();
  return !PAST_KITCHEN_QUEUE.includes(stage);
}

/**
 * Release a paid order to the kitchen.
 *
 * @param {object} order           Order document (already marked PAID).
 * @param {object} [options]
 * @param {string|null} [options.actorId] Who confirmed the payment. Falls back
 *                                         to the ordering customer, because
 *                                         OrderStatusHistory.changedBy is
 *                                         required and a gateway callback has
 *                                         no logged-in user.
 * @param {string} [options.reason]        Audit reason for the history row.
 * @returns {Promise<object|null>} the order
 */
async function releaseOrderToKitchen(order, { actorId = null, reason = 'Payment confirmed' } = {}) {
  if (!order) return null;

  // First release only: writes the audit row and the durable kitchen
  // notification. A retried callback / a second payment record must not
  // produce a second "new order" alert.
  const firstRelease = !order.queuedForKitchenAt;
  const previousStatus = order.orderStatus || order.status || 'NONE';

  if (isAwaitingKitchenQueue(order)) {
    // The flow's canonical state once payment succeeded: PENDING in both the
    // legacy lowercase field and the uppercase one every other consumer reads.
    order.status = 'pending';
    order.orderStatus = 'PENDING';
  }
  if (firstRelease) order.queuedForKitchenAt = new Date();
  await order.save();

  if (firstRelease) {
    try {
      await OrderStatusHistory.create({
        orderId: order._id,
        previousStatus,
        newStatus: 'PENDING',
        changedBy: actorId || order.userId,
        reason,
      });
    } catch (historyError) {
      console.warn('⚠️ Could not write OrderStatusHistory:', historyError.message);
    }
  }

  // Live board update: the order becomes visible on the Kitchen Dashboard at
  // exactly this moment, so push it there rather than at placement time.
  const { emitSocketEvent } = require('../utils/socket');
  const summary = order.getSummary();
  emitSocketEvent('kitchen', 'order:new', summary);
  emitSocketEvent('kitchen', 'order:payment', summary);
  emitSocketEvent(`order:${order.orderId}`, 'order:payment', summary);

  if (firstRelease) {
    try {
      // Durable, acknowledgeable notification for the kitchen + management.
      // Idempotent on eventKey (kitchen:new:<orderId>), so a repeated release
      // can never ring twice or store a second row.
      const { notifyRolesOfNewOrder } = require('../controllers/notification.controller');
      const notified = await notifyRolesOfNewOrder(
        { ...summary, cafeteriaId: order.cafeteriaId },
        ['kitchen', 'manager', 'cafeteria_admin', 'admin', 'system_admin'],
        { cafeteriaScoped: true }
      );
      if (!notified) {
        console.warn(`⚠️ No new-order notification stored for order #${order.orderId} (no active staff recipients)`);
      }
    } catch (notifError) {
      console.warn(`⚠️ New order notification failed for #${order.orderId}:`, notifError.message);
    }
  }

  return order;
}

module.exports = { releaseOrderToKitchen, isAwaitingKitchenQueue };
