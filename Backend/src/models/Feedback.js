const mongoose = require('mongoose');

/**
 * Feedback Schema - Customer feedback on orders
 *
 * Frontend Usage:
 * - customer/feedback.html: Submit & view feedback
 * - admin/feedback.html: List, reply, archive feedback
 */
const FeedbackSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      default: null,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    comment: {
      type: String,
      default: '',
    },
    category: {
      type: String,
      default: 'Food Quality',
    },
    dishName: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['PENDING', 'RESOLVED', 'ARCHIVED'],
      default: 'PENDING',
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Staff reply to the customer's feedback (customer can view it on their
    // feedback list). Previously accepted by the frontend but had no schema
    // field and no backend route, so it was silently dropped.
    reply: {
      type: String,
      default: '',
    },
    replyBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    repliedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Feedback', FeedbackSchema);
