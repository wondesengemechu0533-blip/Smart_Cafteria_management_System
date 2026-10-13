const mongoose = require('mongoose');

/**
 * PaymentEventLog Schema - Audit trail for payment events
 * Tracks all payment-related events for reconciliation and debugging
 */
const PaymentEventLogSchema = new mongoose.Schema(
  {
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
      required: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    eventType: {
      type: String,
      enum: [
        'PAYMENT_CREATED',
        'PAYMENT_INITIATED',
        'PAYMENT_AUTHORIZED',
        'PAYMENT_COMPLETED',
        'PAYMENT_FAILED',
        'PAYMENT_CANCELLED',
        'PAYMENT_REFUND_INITIATED',
        'PAYMENT_REFUNDED',
        'PAYMENT_REFUND_FAILED',
        'MANUAL_ACTION',
        'WEBHOOK_RECEIVED',
        'WEBHOOK_PROCESSED',
      ],
      required: true,
    },
    status: {
      type: String,
      default: 'PENDING',
    },
    previousStatus: {
      type: String,
      default: null,
    },
    newStatus: {
      type: String,
      default: null,
    },
    amount: {
      type: Number,
      default: 0,
    },
    provider: {
      type: String,
      default: null,
    },
    providerEventId: {
      type: String,
      default: null,
    },
    transactionId: {
      type: String,
      default: null,
    },
    reason: {
      type: String,
      default: null,
    },
    errorCode: {
      type: String,
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    ipAddress: {
      type: String,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

PaymentEventLogSchema.index({ paymentId: 1, createdAt: -1 });
PaymentEventLogSchema.index({ orderId: 1 });
PaymentEventLogSchema.index({ userId: 1 });
PaymentEventLogSchema.index({ eventType: 1 });
PaymentEventLogSchema.index({ providerEventId: 1 });
PaymentEventLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('PaymentEventLog', PaymentEventLogSchema);
