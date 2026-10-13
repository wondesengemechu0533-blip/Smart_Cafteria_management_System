const mongoose = require('mongoose');

const cancellationSchema = new mongoose.Schema(
  {
    cancellationNumber: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Reason for cancellation (predefined + optional explanation)
    reason: {
      type: String,
      enum: [
        'CUSTOMER_CHANGED_MIND',
        'ORDERED_BY_MISTAKE',
        'LONG_PREPARATION_TIME',
        'FOOD_UNAVAILABLE',
        'PAYMENT_ISSUE',
        'DUPLICATE_ORDER',
        'CAFETERIA_ISSUE',
        'OTHER',
      ],
      required: true,
    },
    description: {
      type: String,
      maxlength: 500,
      default: null,
    },
    // Cancellation workflow status
    status: {
      type: String,
      enum: ['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'PROCESSING', 'COMPLETED'],
      default: 'REQUESTED',
      index: true,
    },
    // Timestamps for workflow
    requestedAt: {
      type: Date,
      default: Date.now,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    rejectedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    // Admin who processed the request
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Admin's note/reason for approval/rejection
    adminNote: {
      type: String,
      maxlength: 500,
      default: null,
    },
    // Payment-related fields
    paymentStatus: {
      type: String,
      enum: ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED'],
      default: 'PENDING',
    },
    // Refund tracking
    refundStatus: {
      type: String,
      enum: ['NOT_REQUIRED', 'REFUND_REQUESTED', 'REFUND_APPROVED', 'REFUND_PROCESSING', 'REFUNDED', 'REFUND_FAILED'],
      default: 'NOT_REQUIRED',
      index: true,
    },
    refundAmount: {
      type: Number,
      default: 0,
    },
    refundReference: {
      type: String,
      default: null,
    },
    // Inventory restoration tracking (idempotency protection)
    inventoryRestored: {
      type: Boolean,
      default: false,
    },
    // Link to Payment if refund was processed
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
      default: null,
    },
    // For deduplication and safety checks
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    collection: 'cancellations',
  }
);

// Auto-generate cancellationNumber before saving
cancellationSchema.pre('save', async function () {
  if (!this.cancellationNumber) {
    const timestamp = Date.now().toString().slice(-6);
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    this.cancellationNumber = `CAN-${timestamp}-${random}`;
  }
});

// Indexes for queries
cancellationSchema.index({ orderId: 1, customerId: 1 });
cancellationSchema.index({ status: 1, createdAt: -1 });
cancellationSchema.index({ requestedAt: -1 });
cancellationSchema.index({ paymentStatus: 1 });

module.exports = mongoose.model('Cancellation', cancellationSchema);
