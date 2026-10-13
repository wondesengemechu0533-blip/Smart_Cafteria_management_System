const mongoose = require('mongoose');

/**
 * PaymentAttempt Schema - Track individual payment attempts
 * Used for retries and understanding payment flow history
 */
const PaymentAttemptSchema = new mongoose.Schema(
  {
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
      required: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    attemptNumber: {
      type: Number,
      required: true,
      default: 1,
    },
    provider: {
      type: String,
      required: true,
    },
    providerPaymentId: {
      type: String,
      default: null,
    },
    providerEventId: {
      type: String,
      default: null,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'ETB',
    },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'AUTHORIZED', 'PAID', 'FAILED', 'CANCELLED'],
      default: 'PENDING',
    },
    failureCode: {
      type: String,
      default: null,
    },
    failureMessage: {
      type: String,
      default: null,
    },
    method: {
      type: String,
      default: null,
    },
    transactionId: {
      type: String,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    initiatedAt: {
      type: Date,
      default: Date.now,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

PaymentAttemptSchema.index({ paymentId: 1, attemptNumber: 1 });
PaymentAttemptSchema.index({ orderId: 1 });
PaymentAttemptSchema.index({ userId: 1 });
PaymentAttemptSchema.index({ status: 1 });
PaymentAttemptSchema.index({ providerEventId: 1 });
PaymentAttemptSchema.index({ createdAt: -1 });

module.exports = mongoose.model('PaymentAttempt', PaymentAttemptSchema);
