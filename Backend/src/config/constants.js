const PAYMENT_STATUS = {
	PENDING: 'PENDING',
	PAID: 'PAID',
	FAILED: 'FAILED',
	CANCELLED: 'CANCELLED',
	REFUNDED: 'REFUNDED'
};

const ORDER_STATUS = {
	PENDING: 'pending',
	PREPARING: 'preparing',
	READY: 'ready',
	PICKED_UP: 'picked_up',
	SERVED: 'served',
	OUT_FOR_DELIVERY: 'out_for_delivery',
	DELIVERED: 'delivered',
	COMPLETED: 'completed',
	CANCELLED: 'cancelled'
};

const PAYMENT_METHODS = { CHAPA: 'CHAPA' };

// Role values mirror the User schema enum (src/models/User.js) so that
// auth.controller.js and any other module can use a single source of truth.
const ROLES = {
    CUSTOMER: 'customer',
    KITCHEN: 'kitchen',
    ADMIN: 'admin',
    DELIVERY: 'delivery',
    STAFF: 'kitchen',
    ADMIN_UPPER: 'admin',
    KITCHEN_STAFF: 'kitchen',
    DELIVERY_STAFF: 'delivery'
};
const HTTP_STATUS = {
    OK: 200,
    CREATED: 201,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    INTERNAL_SERVER_ERROR: 500
};
const MESSAGES = { ORDER_PLACED: 'Order placed successfully', SERVER_ERROR: 'Server error' };

const FEEDBACK_STATUS = {
    PENDING: 'PENDING',
    APPROVED: 'RESOLVED',
    REJECTED: 'ARCHIVED'
};

const CANCELLATION_STATUS = {
    // Stored on Order.cancellationStatus (lowercase, backward-compatible)
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected'
};

// Cancellation workflow statuses stored on the standalone Cancellation model.
const CANCELLATION_FLOW_STATUS = {
    REQUESTED: 'REQUESTED',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    CANCELLED: 'CANCELLED',
    PROCESSING: 'PROCESSING',
    COMPLETED: 'COMPLETED'
};

// Refund lifecycle (stored on Cancellation + Order.refundStatus)
const REFUND_STATUS = {
    NOT_REQUIRED: 'NOT_REQUIRED',
    REFUND_REQUESTED: 'REFUND_REQUESTED',
    REFUND_APPROVED: 'REFUND_APPROVED',
    REFUND_PROCESSING: 'REFUND_PROCESSING',
    REFUNDED: 'REFUNDED',
    REFUND_FAILED: 'REFUND_FAILED'
};

module.exports = {
    PAYMENT_STATUS,
    ORDER_STATUS,
    PAYMENT_METHODS,
    ROLES,
    HTTP_STATUS,
    MESSAGES,
    FEEDBACK_STATUS,
    CANCELLATION_STATUS,
    CANCELLATION_FLOW_STATUS,
    REFUND_STATUS
};
