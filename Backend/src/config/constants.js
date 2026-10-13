const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED',
};

const ORDER_STATUS = {
  PENDING: 'pending',
  PREPARING: 'preparing',
  READY: 'ready',
  PICKED_UP: 'picked_up',
  SERVED: 'served',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  ARRIVED: 'arrived',
  DELIVERED: 'delivered',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

const PAYMENT_METHODS = { CHAPA: 'CHAPA' };

/**
 * Every payment method value that may be STORED, as a single source of truth
 * for the Order and Payment schemas and for anything that writes one.
 *
 * This must be a superset of what is already in the database, not just of what
 * new code happens to produce. The mobile-money entries are real: orders and
 * payments were written with TELEBIRR / CBE_BIRR by the Chapa Telebirr and CBE
 * Birr flows, but those values were missing from the schema enums. The stored
 * documents were therefore invalid against their own schema, and because
 * recording a payment did a whole-document save (which re-validates every
 * field), the cashier's "mark paid" returned 500 for exactly those orders.
 *
 * Keeping one shared list also stops the three schemas from drifting apart
 * again - they previously declared three different sets.
 */
const PAYMENT_METHOD_VALUES = [
  'CHAPA',
  'CASH',
  'CARD',
  'BANK_TRANSFER',
  'WALLET',
  'TELEBIRR',
  'CBE_BIRR',
];

// Role values/groups are sourced from the central RBAC module
// (src/config/roles.js) so every consumer sees a single source of truth.
const {
  ROLE_VALUES: ROLES,
  SYSTEM_ADMIN_ROLES,
  CAFETERIA_ADMIN_ROLES,
  MANAGEMENT_ROLES,
  CASHIER_ROLES,
  OPERATIONS_ROLES,
  TAX_AUTHORITY_ROLES,
  ALL_STAFF_ROLES,
} = require('./roles');
const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_SERVER_ERROR: 500,
};
const MESSAGES = { ORDER_PLACED: 'Order placed successfully', SERVER_ERROR: 'Server error' };

const FEEDBACK_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'RESOLVED',
  REJECTED: 'ARCHIVED',
};

const CANCELLATION_STATUS = {
  // Stored on Order.cancellationStatus (lowercase, backward-compatible)
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

// Cancellation workflow statuses stored on the standalone Cancellation model.
const CANCELLATION_FLOW_STATUS = {
  REQUESTED: 'REQUESTED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
};

// Refund lifecycle (stored on Cancellation + Order.refundStatus)
const REFUND_STATUS = {
  NOT_REQUIRED: 'NOT_REQUIRED',
  REFUND_REQUESTED: 'REFUND_REQUESTED',
  REFUND_APPROVED: 'REFUND_APPROVED',
  REFUND_PROCESSING: 'REFUND_PROCESSING',
  REFUNDED: 'REFUNDED',
  REFUND_FAILED: 'REFUND_FAILED',
};

module.exports = {
  PAYMENT_STATUS,
  ORDER_STATUS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_VALUES,
  ROLES,
  SYSTEM_ADMIN_ROLES,
  CAFETERIA_ADMIN_ROLES,
  MANAGEMENT_ROLES,
  CASHIER_ROLES,
  OPERATIONS_ROLES,
  TAX_AUTHORITY_ROLES,
  ALL_STAFF_ROLES,
  HTTP_STATUS,
  MESSAGES,
  FEEDBACK_STATUS,
  CANCELLATION_STATUS,
  CANCELLATION_FLOW_STATUS,
  REFUND_STATUS,
};
