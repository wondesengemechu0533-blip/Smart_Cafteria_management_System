const mongoose = require('mongoose');
const { PAYMENT_METHOD_VALUES } = require('../config/constants');

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
    // Indexed by schema level, NOT as path options: `sparse` written on the path
    // is silently dropped, and a plain sparse index still indexes an explicit
    // null - so keyless orders would collide with each other on E11000. A
    // partial index on string values keeps every keyless order storable while
    // still rejecting two orders that replay the same checkout key.
    clientOrderId: {
      type: String,
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Owning cafeteria (tenant). Stamped server-side on creation.
    cafeteriaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafeteria',
      default: null,
    },
    customerName: {
      type: String,
      required: [true, 'Customer name is required'],
    },
    customerPhone: {
      type: String,
      required: [true, 'Customer phone is required'],
    },
    orderType: {
      type: String,
      enum: ['dine-in', 'takeaway', 'delivery'],
      default: 'dine-in',
    },
    tableId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Table',
      default: null,
    },
    tableNumber: {
      type: String,
      default: 'N/A',
    },
    deliveryInfo: {
      // Structured Ethiopian delivery location: every value stays separate
      // (city / area / kebele / street / landmark) for ANY Ethiopian city -
      // never a Debre Berhan-only or combined string.
      city: { type: String, trim: true, default: '' },
      area: { type: String, trim: true, default: '' },
      kebele: { type: String, trim: true, default: '' },
      streetArea: { type: String, trim: true, default: '' },
      landmark: { type: String, trim: true, default: '' },
      houseNumber: { type: String, trim: true, default: '' },
      subCity: { type: String, trim: true, default: '' },
      location: { type: String, trim: true, default: '' },
      // Human-readable full delivery address (sub-city + house/street).
      deliveryAddress: { type: String, trim: true, default: '' },
      note: { type: String, trim: true, default: '' },
      phone: { type: String, trim: true, default: '' },
      // Destination coordinates explicitly provided/confirmed by the customer
      // at checkout. Never collected silently; may be absent when the customer
      // prefers a manual address-only entry.
      latitude: { type: Number, default: null, min: -90, max: 90 },
      longitude: { type: Number, default: null, min: -180, max: 180 },
    },
    deliveryFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    // First-class Delivery record for this order (set when orderType is
    // 'delivery'). The Order stays the source of truth for money and for the
    // kitchen-facing status; the Delivery record owns the courier, the route
    // and the delivery state machine. See services/delivery.service.js.
    delivery: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Delivery',
      default: null,
    },
    // Why a delivery failed (populated by the delivery system; see
    // Delivery.failureReason for the canonical list).
    deliveryFailureReason: {
      type: String,
      default: null,
    },
    deliveryStaffAssigned: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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
    // First time the kitchen sent this order to delivery (status became
    // READY_FOR_DELIVERY). A re-send never rewrites it - first send wins, so
    // the Delivery Staff Dashboard always shows the true ready time.
    readyForDeliveryAt: {
      type: Date,
      default: null,
    },
    deliveryAcceptanceStatus: {
      type: String,
      enum: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'DECLINED'],
      default: 'PENDING_ACCEPTANCE',
    },
    deliveryAcceptedAt: {
      type: Date,
      default: null,
    },
    deliveryAcceptedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    deliveryStartedAt: {
      type: Date,
      default: null,
    },
    deliveryArrivedAt: {
      type: Date,
      default: null,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    // Latest known location of the delivery person for this order. Only written
    // while the delivery is active (PICKED_UP / OUT_FOR_DELIVERY). Kept on the
    // main order so the customer can see the last known fix after completion.
    currentLocation: {
      latitude: { type: Number, default: null, min: -90, max: 90 },
      longitude: { type: Number, default: null, min: -180, max: 180 },
      accuracy: { type: Number, default: null, min: 0 },
      // Device-reported travel heading (degrees, 0-360) and speed (m/s), when
      // the GPS provides them. Null otherwise - never invented server-side.
      heading: { type: Number, default: null, min: -360, max: 360 },
      speed: { type: Number, default: null, min: 0 },
      timestamp: { type: Date, default: null },
    },
    items: [
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
        foodNameSnapshot: { type: String, default: '' },
        foodDescriptionSnapshot: { type: String, default: '' },
        categoryNameSnapshot: { type: String, default: '' },
        foodImageSnapshot: { type: String, default: null },
        subtotal: { type: Number, min: 0, default: 0 },
        notes: {
          type: String,
          default: '',
        },
        itemStatus: {
          type: String,
          enum: ['pending', 'preparing', 'ready', 'served'],
          default: 'pending',
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
    // --- Tax / VAT -------------------------------------------------------
    vatEnabled: { type: Boolean, default: true },
    vatRate: { type: Number, default: 0, min: 0 },
    vatAmount: { type: Number, default: 0, min: 0 },
    taxAmount: { type: Number, default: 0, min: 0 },
    // --- Revenue sharing ------------------------------------------------
    platformFeeRate: { type: Number, default: 0, min: 0 },
    platformFee: { type: Number, default: 0, min: 0 },
    cafeteriaShare: { type: Number, default: 0, min: 0 },
    platformShare: { type: Number, default: 0, min: 0 },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: [
        'pending',
        'preparing',
        'ready',
        'ready_for_delivery',
        'picked_up',
        'served',
        'out_for_delivery',
        'arrived',
        'delivered',
        'failed',
        'cancelled',
        'Received',
        'Completed',
      ],
      default: 'pending',
    },
    paymentMethod: {
      type: String,
      // Shared with the Payment schema and with every writer. See
      // constants.PAYMENT_METHOD_VALUES for why this must be a superset of the
      // values already stored, not just of the ones new code produces.
      enum: PAYMENT_METHOD_VALUES,
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED'],
      default: 'PENDING',
    },
    orderStatus: {
      type: String,
      enum: [
        'PENDING',
        'PREPARING',
        'READY',
        'READY_FOR_DELIVERY',
        'PICKED_UP',
        'SERVED',
        'OUT_FOR_DELIVERY',
        'ARRIVED',
        'DELIVERED',
        'COMPLETED',
        'FAILED',
        'CANCELLED',
      ],
      default: 'PENDING',
    },
    // Set the first time a confirmed payment releases this order into the
    // kitchen queue (see services/order-queue.service.js). The kitchen board
    // only lists PAID orders, so this stamp is what keeps a repeat payment
    // callback from re-queuing (and re-notifying about) the same order.
    queuedForKitchenAt: {
      type: Date,
      default: null,
    },
    transactionId: {
      type: String,
      default: null,
    },
    payment: {
      method: {
        type: String,
        // Same canonical list as `paymentMethod` above: the two must never be
        // able to disagree about what a legal method is.
        enum: PAYMENT_METHOD_VALUES,
      },
      status: {
        type: String,
        enum: ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED'],
        default: 'PENDING',
      },
      transactionId: { type: String, default: null },
      providerReference: { type: String, default: null },
      amount: { type: Number, min: 0 },
      currency: { type: String, default: 'ETB' },
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
      default: '',
    },
    cancellationStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: null,
    },
    cancellationRequestedAt: {
      type: Date,
      default: null,
    },
    cancellationAdminNote: {
      type: String,
      default: '',
    },
    cancellationProcessedAt: {
      type: Date,
      default: null,
    },
    cancellationProcessedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    inventoryRestored: { type: Boolean, default: false },
    refundStatus: {
      type: String,
      enum: ['NOT_REQUIRED', 'REFUND_REQUESTED', 'REFUND_APPROVED', 'REFUND_PROCESSING', 'REFUNDED', 'REFUND_FAILED'],
      default: 'NOT_REQUIRED',
    },
    refundAmount: { type: Number, default: 0, min: 0 },
    refundReference: { type: String, default: null },
    refundedAt: { type: Date, default: null },
    notes: {
      type: String,
      default: '',
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
      ref: 'User',
      default: null,
    },
    priority: {
      type: String,
      enum: ['normal', 'rush', 'vip'],
      default: 'normal',
    },
    qualityCheckStatus: {
      type: String,
      enum: ['pending', 'passed', 'failed'],
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Get order summary
OrderSchema.methods.getSummary = function () {
  return {
    orderId: this.orderId,
    customerName: this.customerName,
    customerPhone: this.customerPhone,
    orderType: this.orderType,
    tableId: this.tableId,
    tableNumber: this.tableNumber,
    deliveryInfo: this.deliveryInfo || null,
    deliveryFee: this.deliveryFee || 0,
    deliveryStaffAssigned: this.deliveryStaffAssigned || null,
    items: this.items,
    itemCount: (this.items || []).reduce((n, it) => n + (it.quantity || 0), 0),
    subtotal: this.subtotal,
    serviceFee: this.serviceFee,
    vatEnabled: this.vatEnabled,
    vatRate: this.vatRate,
    vatAmount: this.vatAmount,
    taxAmount: this.taxAmount,
    platformFeeRate: this.platformFeeRate,
    platformFee: this.platformFee,
    cafeteriaShare: this.cafeteriaShare,
    platformShare: this.platformShare,
    totalAmount: this.totalAmount,
    status: this.status,
    paymentMethod: this.paymentMethod,
    paymentStatus: this.paymentStatus,
    refundStatus: this.refundStatus,
    refundAmount: this.refundAmount || 0,
    refundReference: this.refundReference,
    refundedAt: this.refundedAt,
    orderDate: this.orderDate,
    orderTime: this.orderTime,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

OrderSchema.index({ status: 1 });
OrderSchema.index({ orderStatus: 1 });
OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ userId: 1 });
OrderSchema.index({ paymentStatus: 1 });
OrderSchema.index({ cafeteriaId: 1, createdAt: -1 });
OrderSchema.index({ deliveryStaffAssigned: 1, orderStatus: 1 });
// Keyless orders (clientOrderId null) must never collide with each other, while
// a replayed checkout key must still be rejected by the DB. A partial index on
// string values is the only shape that achieves both - `sparse: true` still
// indexes an explicit null. See the note on the clientOrderId path above.
OrderSchema.index(
  { clientOrderId: 1 },
  {
    unique: true,
    name: 'clientOrderId_1_partial',
    partialFilterExpression: { clientOrderId: { $type: 'string' } },
  }
);

// Monotonic sequence for human-friendly ET-XXXX order ids.
// Falls back to a random value if not initialized (safety net).
let orderSeqCounter = 1000;
OrderSchema.statics.nextOrderSeq = function () {
  return orderSeqCounter++;
};

module.exports = mongoose.model('Order', OrderSchema);
