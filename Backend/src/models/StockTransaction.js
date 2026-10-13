const mongoose = require('mongoose');

const StockTransactionSchema = new mongoose.Schema(
  {
    foodId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
    previousQuantity: { type: Number, required: true, min: 0 },
    quantityChanged: { type: Number, required: true },
    newQuantity: { type: Number, required: true, min: 0 },
    action: {
      type: String,
      enum: ['ADD', 'REDUCE', 'RESTOCK', 'SET', 'ORDER', 'CANCELLATION_RESTORE'],
      required: true,
    },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  },
  { timestamps: true }
);

StockTransactionSchema.index({ foodId: 1, createdAt: -1 });
module.exports = mongoose.model('StockTransaction', StockTransactionSchema);
