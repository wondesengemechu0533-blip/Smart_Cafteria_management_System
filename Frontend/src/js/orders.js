function tr(key, fallback, vars) {
  if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
  if (typeof window.getText === 'function') { var r = window.getText(key); if (r && r !== key) return r; }
  return fallback;
}
/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - ORDERS MODULE
 * ================================================================
 * Handles order creation, tracking, history, and status updates.
 * ================================================================
 */

import { MOCK_ORDERS } from './mock-orders-data.js';
const ORDER_STATUS = window.ORDER_STATUS || {};
import { getCurrentUser } from './auth.js';
import { getCartItems, getCartTotal, clearCart } from './cart.js';
import { showToast } from './main.js';
import { formatDate } from './utils/formatters.js';

// ===== 1. ORDERS STATE =====
let orders = [...MOCK_ORDERS];
let orderIdCounter = MOCK_ORDERS.length + 1;
let orderListeners = [];

// ===== 2. ORDER FUNCTIONS =====

/**
 * Get all orders (Admin only)
 * @param {Object} filters - Filter options
 * @param {string} filters.status - Order status
 * @param {string} filters.date - Date filter
 * @param {string} filters.userId - User ID filter
 * @returns {Array} Orders
 */
export function getAllOrders(filters = {}) {
    let result = [...orders];

    if (filters.status) {
        result = result.filter(order => order.status === filters.status);
    }

    if (filters.userId) {
        result = result.filter(order => order.userId === filters.userId);
    }

    if (filters.date) {
        const dateStr = filters.date;
        result = result.filter(order =>
            order.orderTime.startsWith(dateStr)
        );
    }

    // Sort by most recent first
    result.sort((a, b) => new Date(b.orderTime) - new Date(a.orderTime));

    return result;
}

/**
 * Get user's orders
 * @param {string} userId - User ID
 * @param {Object} filters - Filter options
 * @returns {Array} User orders
 */
export function getUserOrders(userId, filters = {}) {
    return getAllOrders({ ...filters, userId });
}

/**
 * Get current user's orders
 * @param {Object} filters - Filter options
 * @returns {Array} Current user's orders
 */
export function getMyOrders(filters = {}) {
    const user = getCurrentUser();
    if (!user) return [];
    return getUserOrders(user.id, filters);
}

/**
 * Get order by ID
 * @param {string} orderId - Order ID
 * @returns {Object|null} Order or null
 */
export function getOrderById(orderId) {
    return orders.find(order => order.id === orderId) || null;
}

/**
 * Place a new order
 * @param {Object} orderData - Order data
 * @param {Array} orderData.items - Order items
 * @param {number} orderData.totalAmount - Total amount
 * @param {string} orderData.paymentMethod - Payment method
 * @param {string} orderData.notes - Additional notes
 * @returns {Promise<Object>} Created order or error
 */
export async function placeOrder(orderData) {
    try {
        const user = getCurrentUser();
        if (!user) {
            return { success: false, error: 'Please login to place an order' };
        }

        // If no items provided, get from cart
        let items = orderData.items || getCartItems();
        if (!items || items.length === 0) {
            return { success: false, error: 'Cart is empty' };
        }

        // Calculate total if not provided
        let totalAmount = orderData.totalAmount || getCartTotal();
        if (totalAmount <= 0) {
            return { success: false, error: 'Invalid total amount' };
        }

        // Create order
        const order = {
            id: 'o' + orderIdCounter++,
            userId: user.id,
            items: items.map(item => ({
                itemId: item.itemId,
                name: item.name,
                quantity: item.quantity,
                price: item.price,
                notes: item.notes || '',
            })),
            totalAmount: totalAmount,
            status: ORDER_STATUS.PENDING,
            paymentStatus: 'pending',
            orderTime: new Date().toISOString(),
            readyTime: null,
            completedTime: null,
            paymentMethod: orderData.paymentMethod || 'chapa',
            notes: orderData.notes || '',
        };
        orders.push(order);

        // Clear cart after order placed
        clearCart(false);

        showToast(tr('order_placed_success', 'Order placed successfully!'), 'success');

        return { success: true, order };

    } catch (error) {
        console.error('Place order error:', error);
        return { success: false, error: 'Failed to place order' };
    }
}

/**
 * Update order status (Kitchen/Admin)
 * @param {string} orderId - Order ID
 * @param {string} status - New status
 * @returns {Promise<Object>} Updated order or error
 */
export async function updateOrderStatus(orderId, status) {
    try {
        const order = getOrderById(orderId);
        if (!order) {
            return { success: false, error: 'Order not found' };
        }

        // Validate status
        const validStatuses = Object.values(ORDER_STATUS);
        if (!validStatuses.includes(status)) {
            return { success: false, error: 'Invalid status' };
        }

        // Prevent invalid transitions
        const current = order.status;
        if (current === ORDER_STATUS.SERVED && status !== ORDER_STATUS.SERVED) {
            return { success: false, error: 'Cannot change status of served order' };
        }

        if (current === ORDER_STATUS.CANCELLED) {
            return { success: false, error: 'Cannot update cancelled order' };
        }

        // Update status
        order.status = status;

        // Set timestamps
        if (status === ORDER_STATUS.READY) {
            order.readyTime = new Date().toISOString();
        }
        if (status === ORDER_STATUS.SERVED) {
            order.completedTime = new Date().toISOString();
        }

        // Notify listeners
        notifyOrderListeners();

const statusLabels = {
            [ORDER_STATUS.PENDING]: 'pending',
            [ORDER_STATUS.PREPARING]: 'being prepared',
            [ORDER_STATUS.READY]: 'ready for pickup',
            [ORDER_STATUS.SERVED]: 'served',
        };

        const am = typeof window.getCurrentLanguage === "function" && window.getCurrentLanguage() === "am";
        const labelsAm = {
            [ORDER_STATUS.PENDING]: 'በመጠባበቅ ላይ',
            [ORDER_STATUS.PREPARING]: 'በዝግጅት ላይ',
            [ORDER_STATUS.READY]: 'ለመውሰድ ዝግጁ',
            [ORDER_STATUS.SERVED]: 'ተላልፏል',
        };
        const statusWord = am ? (labelsAm[status] || status) : (statusLabels[status] || status);
        showToast(tr("order_now_status", "Order #{id} is now {status}").replace("{id}", orderId).replace("{status}", statusWord), 'info');

        return { success: true, order };

    } catch (error) {
        console.error('Update order status error:', error);
        return { success: false, error: 'Failed to update order status' };
    }
}

/**
 * Mark order as ready (Kitchen)
 * @param {string} orderId - Order ID
 * @returns {Promise<Object>} Updated order or error
 */
export async function markOrderReady(orderId) {
    return await updateOrderStatus(orderId, ORDER_STATUS.READY);
}

/**
 * Mark order as served (Kitchen/Admin)
 * @param {string} orderId - Order ID
 * @returns {Promise<Object>} Updated order or error
 */
export async function markOrderServed(orderId) {
    return await updateOrderStatus(orderId, ORDER_STATUS.SERVED);
}

/**
 * Cancel order (Customer)
 * @param {string} orderId - Order ID
 * @param {string} reason - Cancellation reason
 * @returns {Promise<Object>} Success or error
 */
export async function cancelOrder(orderId, reason = '') {
    try {
        const order = getOrderById(orderId);
        if (!order) {
            return { success: false, error: 'Order not found' };
        }

        // Check if order can be cancelled
        if (order.status === ORDER_STATUS.SERVED) {
            return { success: false, error: 'Cannot cancel served order' };
        }

        if (order.status === ORDER_STATUS.CANCELLED) {
            return { success: false, error: 'Order already cancelled' };
        }

        // Update status
        order.status = ORDER_STATUS.CANCELLED;
        order.cancellationReason = reason || 'Cancelled by customer';

        notifyOrderListeners();
        showToast(tr('order_cancelled_success', 'Order cancelled successfully'), 'info');

        return { success: true, order };

    } catch (error) {
        console.error('Cancel order error:', error);
        return { success: false, error: 'Failed to cancel order' };
    }
}
/**
 * Get order status
 * @param {string} orderId - Order ID
 * @returns {string|null} Status or null
 */
export function getOrderStatus(orderId) {
    const order = getOrderById(orderId);
    return order ? order.status : null;
}

/**
 * Check if order can be cancelled
 * @param {string} orderId - Order ID
 * @returns {boolean}
 */
export function canCancelOrder(orderId) {
    const order = getOrderById(orderId);
    if (!order) return false;
    return order.status === ORDER_STATUS.PENDING ||
           order.status === ORDER_STATUS.PREPARING;
}

/**
 * Get order status history (mock)
 * @param {string} orderId - Order ID
 * @returns {Array} Status history
 */
export function getOrderStatusHistory(orderId) {
    const order = getOrderById(orderId);
    if (!order) return [];

    // Mock status history
    const history = [
        { status: ORDER_STATUS.PENDING, time: order.orderTime, label: 'Order placed' },
    ];

    if (order.status === ORDER_STATUS.PREPARING || order.readyTime) {
        history.push({
            status: ORDER_STATUS.PREPARING,
            time: new Date(new Date(order.orderTime).getTime() + 300000).toISOString(),
            label: 'Order accepted'
        });
    }

    if (order.readyTime) {
        history.push({
            status: ORDER_STATUS.READY,
            time: order.readyTime,
            label: 'Order ready for pickup'
        });
    }

    if (order.completedTime) {
        history.push({
            status: ORDER_STATUS.SERVED,
            time: order.completedTime,
            label: 'Order served'
        });
    }

    return history;
}

// ===== 3. ORDER STATISTICS =====

/**
 * Get order statistics for admin dashboard
 * @returns {Object} Statistics
 */
export function getOrderStats() {
    const total = orders.length;
    const pending = orders.filter(o => o.status === ORDER_STATUS.PENDING).length;
    const preparing = orders.filter(o => o.status === ORDER_STATUS.PREPARING).length;
    const ready = orders.filter(o => o.status === ORDER_STATUS.READY).length;
    const served = orders.filter(o => o.status === ORDER_STATUS.SERVED).length;
    const cancelled = orders.filter(o => o.status === ORDER_STATUS.CANCELLED).length;

    const totalRevenue = orders
        .filter(o => o.status !== ORDER_STATUS.CANCELLED)
        .reduce((sum, o) => sum + o.totalAmount, 0);

    const today = new Date().toISOString().split('T')[0];
    const todayOrders = orders.filter(o => o.orderTime.startsWith(today));

    return {
        total,
        pending,
        preparing,
        ready,
        served,
        cancelled,
        totalRevenue,
        todayOrders: todayOrders.length,
        todayRevenue: todayOrders.reduce((sum, o) => sum + o.totalAmount, 0),
    };
}

/**
 * Get kitchen order statistics
 * @returns {Object} Kitchen stats
 */
export function getKitchenStats() {
    const pending = orders.filter(o => o.status === ORDER_STATUS.PENDING).length;
    const preparing = orders.filter(o => o.status === ORDER_STATUS.PREPARING).length;
    const ready = orders.filter(o => o.status === ORDER_STATUS.READY).length;

    const activeOrders = orders.filter(o =>
        o.status === ORDER_STATUS.PENDING ||
        o.status === ORDER_STATUS.PREPARING
    );

    return {
        pending,
        preparing,
        ready,
        activeOrders: activeOrders.length,
        activeOrdersList: activeOrders,
    };
}

// ===== 4. ORDER LISTENERS =====

/**
 * Add order change listener
 * @param {Function} listener - Callback function
 */
export function addOrderListener(listener) {
    if (typeof listener === 'function') {
        orderListeners.push(listener);
    }
}

/**
 * Remove order change listener
 * @param {Function} listener - Callback function
 */
export function removeOrderListener(listener) {
    orderListeners = orderListeners.filter(l => l !== listener);
}
 /**
 * Notify all order listeners
 */
function notifyOrderListeners() {
    orderListeners.forEach(listener => {
        try {
            listener(orders);
        } catch (error) {
            console.error('Order listener error:', error);
        }
    });
}

// ===== 5. EXPORTS =====
export default {
    getAllOrders,
    getUserOrders,
    getMyOrders,
    getOrderById,
    placeOrder,
    updateOrderStatus,
    markOrderReady,
    markOrderServed,
    cancelOrder,
    getOrderStatus,
    canCancelOrder,
    getOrderStatusHistory,
    getOrderStats,
    getKitchenStats,
    addOrderListener,
    removeOrderListener,
};