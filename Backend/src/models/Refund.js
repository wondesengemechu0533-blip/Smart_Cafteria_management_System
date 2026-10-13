const mongoose = require('mongoose');

/**
 * Refund Schema - Standalone refund workflow records.
 *
 * Workflow:
 *   REFUND_REQUESTED -> APPROVED | REJECTED -> REFUNDED (after provider confirm)
 *
 * Stored information (per advisor requirement #11):
 *   - Order/payment reference
 *   - Refund amount
 *   - Reason
 *   - Requested by
 *   - Processed by
 *   - Date/time
 *   - Status
 *
 * NOTE: This record does NOT replace the existing cancellation pipeline. It is
 * linked to the Order.refundStatus / Payment.refundStatus fields so both stay
 * in sync. A refund is only marked REFUNDED when the payment provider confirms
 * the transfer; if the provider does not support real refunds the status
 * remains APPROVED and the record reflects that no money moved yet.
 */
const RefundSchema = new mongoose.Schema(
  {
    refundNumber: {
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
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
      default: null,
    },
    // Owning cafeteria (tenant). Inherited from the order server-side.
    cafeteriaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafeteria',
      default: null,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    reason: {
      type: String,
      required: [true, 'Refund reason is required'],
      maxlength: 500,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    status: {
      type: String,
      enum: ['REFUND_REQUESTED', 'APPROVED', 'REJECTED', 'REFUNDED', 'REFUND_FAILED'],
      default: 'REFUND_REQUESTED',
      index: true,
    },
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
    refundedAt: {
      type: Date,
      default: null,
    },
    providerReference: {
      type: String,
      default: null,
    },
    adminNote: {
      type: String,
      maxlength: 500,
      default: '',
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

RefundSchema.pre('save', async function () {
  if (!this.refundNumber) {
    const timestamp = Date.now().toString().slice(-6);
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.refundNumber = `REF-${timestamp}-${random}`;
  }
});

RefundSchema.index({ status: 1, createdAt: -1 });
RefundSchema.index({ requestedBy: 1 });
RefundSchema.index({ processedBy: 1 });
RefundSchema.index({ cafeteriaId: 1, createdAt: -1 });

module.exports = mongoose.model('Refund', RefundSchema);
