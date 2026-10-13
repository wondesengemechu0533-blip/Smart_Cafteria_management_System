const mongoose = require('mongoose');

const OrderStatusHistorySchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    previousStatus: { type: String, required: true },
    newStatus: { type: String, required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, default: '' },
  },
  { timestamps: true }
);

OrderStatusHistorySchema.index({ orderId: 1, createdAt: 1 });
module.exports = mongoose.model('OrderStatusHistory', OrderStatusHistorySchema);
