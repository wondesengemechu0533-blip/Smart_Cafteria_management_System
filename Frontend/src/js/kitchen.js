function tr(key, fallback, vars) {
  if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
  if (typeof window.getText === 'function') { var r = window.getText(key); if (r && r !== key) return r; }
  return fallback;
}
/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - KITCHEN MODULE
 * ================================================================
 * Handles kitchen staff operations: viewing orders, updating status.
 * ================================================================
 */

import { getAllOrders, updateOrderStatus, markOrderReady, getKitchenStats } from './orders.js';
import { getCurrentUser } from './auth.js';
import { showToast } from './main.js';
const ORDER_STATUS = window.ORDER_STATUS || {};

// ===== 1. KITCHEN STATE =====
let kitchenListeners = [];

// ===== 2. KITCHEN FUNCTIONS =====

/**
 * Get kitchen dashboard data
 * @returns {Object} Kitchen dashboard data
 */
export function getKitchenDashboardData() {
    const stats = getKitchenStats();
    const allOrders = getAllOrders();

    // Get orders by status
    const pendingOrders = allOrders.filter(o => o.status === ORDER_STATUS.PENDING);
    const preparingOrders = allOrders.filter(o => o.status === ORDER_STATUS.PREPARING);
    const readyOrders = allOrders.filter(o => o.status === ORDER_STATUS.READY);
    const completedOrders = allOrders.filter(o => o.status === ORDER_STATUS.SERVED);

    // Recent activity (last 10 orders)
    const recentActivity = allOrders
        .sort((a, b) => new Date(b.orderTime) - new Date(a.orderTime))
        .slice(0, 10);

    return {
        stats: {
            pending: stats.pending,
            preparing: stats.preparing,
            ready: stats.ready,
            activeOrders: stats.activeOrders,
        },
        orders: {
            pending: pendingOrders,
            preparing: preparingOrders,
            ready: readyOrders,
            completed: completedOrders,
        },
        recentActivity: recentActivity,
    };
}

/**
 * Accept a new order (Kitchen)
 * @param {string} orderId - Order ID
 * @returns {Promise<Object>} Updated order or error
 */
export async function acceptOrder(orderId) {
    try {
        const result = await updateOrderStatus(orderId, ORDER_STATUS.PREPARING);
        if (result.success) {
            // The customer notification for "order accepted" is created by the
            // backend (kitchen.controller.js) — do not create a second one here.
            showToast(tr("kitchen_order_accepted", "Order #{id} accepted").replace("{id}", orderId).replace("#{id}", orderId), 'success');
        }
        return result;
    } catch (error) {
        console.error('Accept order error:', error);
        return { success: false, error: tr('kitchen_failed_accept_order', 'Failed to accept order') };
    }
}

/**
 * Start preparing an order (Kitchen)
 * @param {string} orderId - Order ID
 * @returns {Promise<Object>} Updated order or error
 */
export async function startPreparing(orderId) {
    return await acceptOrder(orderId);
}

/**
 * Mark order as ready (Kitchen)
 * @param {string} orderId - Order ID
 * @returns {Promise<Object>} Updated order or error
 */
export async function markReady(orderId) {
    try {
        const result = await markOrderReady(orderId);
        if (result.success) {
            // "Order ready" customer notification is created by the backend
            // (kitchen.controller.js) — do not create a second one here.
            showToast(tr("kitchen_order_marked_ready", "Order #{id} marked ready").replace("{id}", orderId).replace("#{id}", orderId), 'success');
        }
        return result;
    } catch (error) {
        console.error('Mark ready error:', error);
        return { success: false, error: tr('kitchen_failed_mark_ready', 'Failed to mark order ready') };
    }
}
/**
 * Mark order as served (Kitchen)
 * @param {string} orderId - Order ID
 * @returns {Promise<Object>} Updated order or error
 */
export async function markServed(orderId) {
    try {
const result = await updateOrderStatus(orderId, ORDER_STATUS.SERVED);
        if (result.success) {
            showToast(tr("kitchen_order_served", "Order #{id} served").replace("{id}", orderId).replace("#{id}", orderId), 'info');
        }
        return result;
    } catch (error) {
        console.error('Mark served error:', error);
        return { success: false, error: tr('kitchen_failed_mark_served', 'Failed to mark order served') };
    }
}

/**
 * Get orders that need attention (pending or preparing)
 * @returns {Array} Active orders
 */
export function getActiveOrders() {
    const allOrders = getAllOrders();
    return allOrders.filter(o =>
        o.status === ORDER_STATUS.PENDING ||
        o.status === ORDER_STATUS.PREPARING
    );
}

/**
 * Get orders by status for kitchen
 * @param {string} status - Order status
 * @returns {Array} Filtered orders
 */
export function getKitchenOrdersByStatus(status) {
    const allOrders = getAllOrders();
    return allOrders.filter(o => o.status === status);
}

/**
 * Check if kitchen staff is authenticated
 * @returns {boolean}
 */
export function isKitchenAuthenticated() {
    const user = getCurrentUser();
    return user && user.role === 'kitchen';
}

/**
 * Get kitchen summary statistics
 * @returns {Object} Kitchen summary
 */
export function getKitchenSummary() {
    const stats = getKitchenStats();
    const allOrders = getAllOrders();

    const today = new Date().toISOString().split('T')[0];
    const todayOrders = allOrders.filter(o => o.orderTime.startsWith(today));

    return {
        ...stats,
        todayOrders: todayOrders.length,
        totalOrdersToday: todayOrders.length,
        efficiency: stats.activeOrders > 0
            ? Math.round((stats.ready / (stats.activeOrders + stats.ready)) * 100)
            : 0,
    };
}

// ===== 3. KITCHEN REAL-TIME UPDATES =====

/**
 * Simulate real-time order updates (for demo)
 * @param {Function} callback - Callback for each update
 * @returns {Function} Stop function
 */
export function startKitchenSimulation(callback) {
    let running = true;
    let intervalId = null;

    const simulateUpdate = () => {
        if (!running) return;

        const data = getKitchenDashboardData();
        if (typeof callback === 'function') {
            callback(data);
        }
    };

    // Initial update
    simulateUpdate();

    // Update every 30 seconds
    intervalId = setInterval(simulateUpdate, 30000);

    // Return stop function
    return () => {
        running = false;
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }
    };
}

// ===== 4. KITCHEN LISTENERS =====

/**
 * Add kitchen change listener
 * @param {Function} listener - Callback function
 */
export function addKitchenListener(listener) {
    if (typeof listener === 'function') {
        kitchenListeners.push(listener);
    }
}

/**
 * Remove kitchen change listener
 * @param {Function} listener - Callback function
 */
export function removeKitchenListener(listener) {
    kitchenListeners = kitchenListeners.filter(l => l !== listener);
}

/**
 * Notify all kitchen listeners
 */
function notifyKitchenListeners() {
    const data = getKitchenDashboardData();
    kitchenListeners.forEach(listener => {
        try {
            listener(data);
        } catch (error) {
            console.error('Kitchen listener error:', error);
        }
    });
}

// ===== 5. EXPORTS =====
export default {
    getKitchenDashboardData,
    acceptOrder,
    startPreparing,
    markReady,
    markServed,
    getActiveOrders,
    getKitchenOrdersByStatus,
    isKitchenAuthenticated,
    getKitchenSummary,
    startKitchenSimulation,
    addKitchenListener,
    removeKitchenListener,
};