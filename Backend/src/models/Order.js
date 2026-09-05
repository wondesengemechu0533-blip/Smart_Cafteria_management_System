const mongoose = require("mongoose");

/**
 * Order Schema - Matches Frontend Requirements
 *
 * Frontend Usage:
 * - checkout.js: Place order with items, customer info, payment
 * - order-status.js: Track order status (Pending → Preparing → Ready → Served)
 * - order-history.js: View past orders
 * - admin/orders.html: Manage all orders
 */
const OrderSchema = new mongoose.Schema(
  {
    orderId: {
      type: String,
      unique: true,
      required: true,
      // Generate a unique order id as a synchronous default.
      // (A pre('save') hook cannot be used here because in Mongoose 9
      //  pre-save middleware runs after validation, so it can never fill
      //  in a required field that is missing.)
      default: function () {
        const seq = OrderSchema.statics.nextOrderSeq
          ? OrderSchema.statics.nextOrderSeq()
          : Math.floor(1000 + Math.random() * 9000);
        return `ET-${seq}${Date.now().toString(36).toUpperCase()}`;
      },
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    customerName: {
      type: String,
      required: [true, "Customer name is required"],
    },
    customerPhone: {
      type: String,
      required: [true, "Customer phone is required"],
    },
    orderType: {
      type: String,
      enum: ["dine-in", "takeaway", "delivery"],
      default: "dine-in",
    },
    tableNumber: {
      type: String,
      default: "N/A",
    },
    deliveryInfo: {
      subCity: { type: String, trim: true, default: "" },
      location: { type: String, trim: true, default: "" },
      note: { type: String, trim: true, default: "" },
      phone: { type: String, trim: true, default: "" },
    },
    deliveryFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    deliveryStaffAssigned: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    deliveryAssignedAt: {
      type: Date,
      default: null,
    },
    deliveryNotifiedAt: {
      type: Date,
      default: null,
    },
    deliveryStartedAt: {
      type: Date,
      default: null,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    items: [
      {
        itemId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "MenuItem",
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
        foodNameSnapshot: { type: String, default: '' },
        foodDescriptionSnapshot: { type: String, default: '' },
        categoryNameSnapshot: { type: String, default: '' },
        foodImageSnapshot: { type: String, default: null },
        subtotal: { type: Number, min: 0, default: 0 },
        notes: {
          type: String,
          default: "",
        },
        itemStatus: {
          type: String,
          enum: ["pending", "preparing", "ready", "served"],
          default: "pending",
        },
        preparationStartedAt: {
          type: Date,
          default: null,
        },
        preparationCompletedAt: {
          type: Date,
          default: null,
        },
      },
    ],
    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },
    serviceFee: {
      type: Number,
      default: 20,
      min: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: [
        "pending",
        "preparing",
        "ready",
        "picked_up",
        "served",
        "out_for_delivery",
        "delivered",
        "cancelled",
        "Received",
        "Completed",
      ],
      default: "pending",
    },
    paymentMethod: {
      type: String,
      enum: ["CHAPA"],
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ["PENDING", "PAID", "FAILED", "CANCELLED", "REFUNDED"],
      default: "PENDING",
    },
    orderStatus: {
      type: String,
      enum: ["PENDING", "PREPARING", "READY", "PICKED_UP", "SERVED", "OUT_FOR_DELIVERY", "DELIVERED", "COMPLETED", "CANCELLED"],
      default: "PENDING",
    },
    transactionId: {
      type: String,
      default: null,
    },
    payment: {
      method: {
        type: String,
        enum: ["CHAPA"],
      },
      status: {
        type: String,
        enum: ["PENDING", "PAID", "FAILED", "CANCELLED"],
        default: "PENDING",
      },
      transactionId: { type: String, default: null },
      providerReference: { type: String, default: null },
      amount: { type: Number, min: 0 },
      currency: { type: String, default: "ETB" },
      paidAt: { type: Date, default: null },
    },
    orderDate: {
      type: String,
      default: () => new Date().toLocaleString(),
    },
    orderTime: {
      type: Date,
      default: Date.now,
    },
    readyTime: {
      type: Date,
      default: null,
    },
    pickedUpTime: {
      type: Date,
      default: null,
    },
    pickedUpBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    completedTime: {
      type: Date,
      default: null,
    },
    cancellationReason: {
      type: String,
      default: null,
    },
    cancellationRequested: {
      type: Boolean,
      default: false,
    },
    cancellationDetails: {
      type: String,
      default: "",
    },
    cancellationStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: null,
    },
    cancellationRequestedAt: {
      type: Date,
      default: null,
    },
    cancellationAdminNote: {
      type: String,
      default: "",
    },
    cancellationProcessedAt: {
      type: Date,
      default: null,
    },
    cancellationProcessedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    inventoryRestored: { type: Boolean, default: false },
    refundStatus: {
      type: String,
      enum: ["NOT_REQUIRED", "REFUND_REQUESTED", "REFUND_APPROVED", "REFUND_PROCESSING", "REFUNDED", "REFUND_FAILED"],
      default: "NOT_REQUIRED",
    },
    refundAmount: { type: Number, default: 0, min: 0 },
    refundReference: { type: String, default: null },
    refundedAt: { type: Date, default: null },
    notes: {
      type: String,
      default: "",
    },
    estimatedCompletionTime: {
      type: Date,
      default: null,
    },
    preparationDelayReason: {
      type: String,
      default: null,
    },
    kitchenStaffAssigned: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    priority: {
      type: String,
      enum: ["normal", "rush", "vip"],
      default: "normal",
    },
    qualityCheckStatus: {
      type: String,
      enum: ["pending", "passed", "failed"],
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Get order summary
OrderSchema.methods.getSummary = function () {
  return {
    orderId: this.orderId,
    customerName: this.customerName,
    customerPhone: this.customerPhone,
    orderType: this.orderType,
    tableNumber: this.tableNumber,
    deliveryInfo: this.deliveryInfo || null,
    deliveryFee: this.deliveryFee || 0,
    deliveryStaffAssigned: this.deliveryStaffAssigned || null,
    items: this.items,
    subtotal: this.subtotal,
    serviceFee: this.serviceFee,
    totalAmount: this.totalAmount,
    status: this.status,
    paymentMethod: this.paymentMethod,
    paymentStatus: this.paymentStatus,
    refundStatus: this.refundStatus,
    refundReference: this.refundReference,
    refundedAt: this.refundedAt,
    orderDate: this.orderDate,
    orderTime: this.orderTime,
  };
};

OrderSchema.index({ status: 1 });
OrderSchema.index({ orderStatus: 1 });
OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ userId: 1 });
OrderSchema.index({ paymentStatus: 1 });

// Monotonic sequence for human-friendly ET-XXXX order ids.
// Falls back to a random value if not initialized (safety net).
let orderSeqCounter = 1000;
OrderSchema.statics.nextOrderSeq = function () {
  return orderSeqCounter++;
};

module.exports = mongoose.model("Order", OrderSchema);
