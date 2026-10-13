const mongoose = require('mongoose');

/**
 * OrderItem Schema - Embedded in Order
 *
 * Frontend Usage:
 * - checkout.js: Individual items in order
 * - order-status.js: Display items in receipt
 */
const OrderItemSchema = new mongoose.Schema(
  {
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    notes: {
      type: String,
      default: '',
    },
  },
  {
    _id: true,
  }
);

// Calculate subtotal for this item
OrderItemSchema.methods.getSubtotal = function () {
  return this.quantity * this.price;
};

module.exports = OrderItemSchema;
