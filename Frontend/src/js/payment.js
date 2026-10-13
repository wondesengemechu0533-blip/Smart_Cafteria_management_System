function tr(key, fallback, vars) {
  if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
  if (typeof window.getText === 'function') { var r = window.getText(key); if (r && r !== key) return r; }
  return fallback;
}
/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - PAYMENT MODULE
 * ================================================================
 * Handles payment simulation for Chapa backend providers.
 * ================================================================
 */

const PAYMENT_STATUS = window.PAYMENT_STATUS || {};
const PAYMENT_METHODS = window.PAYMENT_METHODS || {};
import { getCurrentUser } from './auth.js';
import { getOrderById, updateOrderStatus } from './order-status.js';
import { showToast } from './main.js';

// ===== 1. PAYMENT STATE =====
let paymentHistory = [];
let paymentListeners = [];

// ===== 2. PAYMENT FUNCTIONS =====

/**
 * Simulate payment for an order
 * @param {string} orderId - Order ID
 * @param {string} method - Payment method (chapa)
 */
export async function simulatePayment(orderId, method = PAYMENT_METHODS.CHAPA, details = {}) {
    try {
        const user = getCurrentUser();
        if (!user) {
            return { success: false, error: 'Please login to make payment' };
        }

        const order = getOrderById(orderId);
        if (!order) {
            return { success: false, error: 'Order not found' };
        }

        // Check if already paid
        if (order.paymentStatus === PAYMENT_STATUS.SIMULATED) {
            return { success: false, error: 'Order already paid' };
        }

        // Validate method
        if (!Object.values(PAYMENT_METHODS).includes(method)) {
            return { success: false, error: 'Invalid payment method' };
        }

        // Simulate processing delay
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Random success (95% success rate for simulation)
        const success = Math.random() < 0.95;

        if (!success) {
            order.paymentStatus = PAYMENT_STATUS.FAILED;
            showToast(tr('payment_failed_try_again', 'Payment failed. Please try again.'), 'error');
            return {
                success: false,
                error: 'Payment failed. Please try again.',
                status: PAYMENT_STATUS.FAILED,
            };
        }

        // Generate transaction ID
        const transactionId = `${method}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`.toUpperCase();

        // Update order payment status
        order.paymentStatus = PAYMENT_STATUS.SIMULATED;

        // Create payment record
        const payment = {
            id: 'p' + Date.now(),
            orderId: order.id,
            userId: user.id,
            amount: order.totalAmount,
            method: method,
            status: PAYMENT_STATUS.SIMULATED,
            transactionId: transactionId,
            details: {
                phone: details.phone || '',
                reference: details.reference || '',
                timestamp: new Date().toISOString(),
            },
            createdAt: new Date().toISOString(),
        };

        paymentHistory.push(payment);

        // Notify listeners
        notifyPaymentListeners();

const methodLabels = {
            [PAYMENT_METHODS.CHAPA]: 'Chapa',
        };

        showToast(
            `Payment successful! ${methodLabels[method] || method} - ${transactionId}`,
            'success'
        );

        return {
            success: true,
            payment: payment,
            transactionId: transactionId,
        };

    } catch (error) {
        console.error('Payment error:', error);
        return { success: false, error: 'Payment processing failed' };
    }
}

/**
 * Get payment by order ID
 * @param {string} orderId - Order ID
 * @returns {Object|null} Payment or null
 */
export function getPaymentByOrder(orderId) {
    return paymentHistory.find(p => p.orderId === orderId) || null;
}
 /**
 * Get user's payment history
 * @param {string} userId - User ID
 * @returns {Array} Payment history
 */
export function getUserPayments(userId) {
    return paymentHistory.filter(p => p.userId === userId);
}

/**
 * Get current user's payment history
 * @returns {Array} Payment history
 */
export function getMyPayments() {
    const user = getCurrentUser();
    if (!user) return [];
    return getUserPayments(user.id);
}

/**
 * Get all payments (Admin only)
 * @param {Object} filters - Filter options
 * @param {string} filters.status - Payment status
 * @param {string} filters.method - Payment method
 * @param {string} filters.date - Date filter
 * @returns {Array} Payments
 */
export function getAllPayments(filters = {}) {
    let result = [...paymentHistory];

    if (filters.status) {
        result = result.filter(p => p.status === filters.status);
    }

    if (filters.method) {
        result = result.filter(p => p.method === filters.method);
    }

    if (filters.date) {
        const dateStr = filters.date;
        result = result.filter(p => p.createdAt.startsWith(dateStr));
    }

    result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return result;
}

/**
 * Get payment statistics
 * @returns {Object} Payment statistics
 */
export function getPaymentStats() {
    const total = paymentHistory.length;
    const simulated = paymentHistory.filter(p => p.status === PAYMENT_STATUS.SIMULATED).length;
    const failed = paymentHistory.filter(p => p.status === PAYMENT_STATUS.FAILED).length;

    const totalAmount = paymentHistory
        .filter(p => p.status === PAYMENT_STATUS.SIMULATED)
        .reduce((sum, p) => sum + p.amount, 0);

const chapa = paymentHistory.filter(p => p.method === PAYMENT_METHODS.CHAPA).length;

    return {
        total,
        simulated,
        failed,
        totalAmount,
        chapa,
    };
}

// ===== 3. PAYMENT LISTENERS =====

/**
 * Add payment change listener
 * @param {Function} listener - Callback function
 */
export function addPaymentListener(listener) {
    if (typeof listener === 'function') {
        paymentListeners.push(listener);
    }
}

/**
 * Remove payment change listener
 * @param {Function} listener - Callback function
 */
export function removePaymentListener(listener) {
    paymentListeners = paymentListeners.filter(l => l !== listener);
}

/**
 * Notify all payment listeners
 */
function notifyPaymentListeners() {
    paymentListeners.forEach(listener => {
        try {
            listener(paymentHistory);
        } catch (error) {
            console.error('Payment listener error:', error);
        }
    });
}

// ===== 4. PAYMENT VALIDATION =====

/**
 * Validate payment details
 * @param {Object} details - Payment details
 * @param {string} details.phone - Phone number
 * @param {string} details.method - Payment method
 * @returns {Object} Validation result
 */
export function validatePaymentDetails(details) {
    const errors = {};

    if (!details.method) {
        errors.method = 'Payment method is required';
    }

    if (!details.phone || details.phone.trim() === '') {
        errors.phone = 'Phone number is required';
    } else if (!/^\+?[0-9]{9,12}$/.test(details.phone.trim())) {
        errors.phone = 'Invalid phone number format';
    }

    return {
        valid: Object.keys(errors).length === 0,
        errors,
    };
}

// ===== 5. EXPORTS =====
export default {
    simulatePayment,
    getPaymentByOrder,
    getUserPayments,
    getMyPayments,
    getAllPayments,
    getPaymentStats,
    validatePaymentDetails,
    addPaymentListener,
    removePaymentListener,
};