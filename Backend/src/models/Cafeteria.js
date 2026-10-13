const mongoose = require('mongoose');

/**
 * Cafeteria Schema - Tenant/ownership boundary for the ordering system.
 *
 * Every operational record (Order, Payment, Refund, MenuItem, Category,
 * ActivityLog) and every staff User belongs to exactly one Cafeteria.
 * Cafeteria-scoped reports resolve the cafeteria from the authenticated user
 * (never from the client) and filter exclusively by this id.
 */
const CafeteriaSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Cafeteria name is required'],
      trim: true,
      maxlength: [120, 'Cafeteria name cannot exceed 120 characters'],
    },
    code: {
      type: String,
      unique: true,
      sparse: true,
      uppercase: true,
      trim: true,
    },
    address: {
      type: String,
      trim: true,
      default: '',
    },
    // Optional real-world coordinates used by the customer's live delivery
    // tracking map to show where the order originated. Never derived from the
    // client - set by cafeteria admins / seeded defaults only.
    latitude: {
      type: Number,
      default: null,
      min: -90,
      max: 90,
    },
    longitude: {
      type: Number,
      default: null,
      min: -180,
      max: 180,
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE'],
      default: 'ACTIVE',
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    openingTime: {
      type: String,
      default: '07:00',
    },
    closingTime: {
      type: String,
      default: '22:00',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

CafeteriaSchema.index({ status: 1 });

module.exports = mongoose.model('Cafeteria', CafeteriaSchema);
