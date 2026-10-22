const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ROLES, normalizeRole } = require('../config/roles');

/**
 * User Schema - Matches Frontend Requirements
 *
 * Frontend Usage:
 * - login.html: identifier (email or phone)
 * - register.html: name, email, phone, password
 * - users.js (Admin): role, balance, status
 * - profile.js: name, phone, email, avatar
 */
const UserSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid email address'],
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      unique: true,
      match: [
        /^(\+251[0-9]{9}|(09|07)[0-9]{8})$/,
        'Please provide a valid Ethiopian phone number (e.g. 09XXXXXXXX or +2519XXXXXXXX)',
      ],
    },
    username: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [30, 'Username cannot exceed 30 characters'],
      match: [/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores'],
      // No default: when absent, the field must be left unset so the sparse
      // unique index does not index it. A `null` value would be indexed by
      // MongoDB (sparse skips only missing fields, not null), causing false
      // duplicate-key 409s when two users both have no username.
    },
    address: {
      type: String,
      trim: true,
      maxlength: [255, 'Address cannot exceed 255 characters'],
      default: null,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,
    },
    role: {
      type: String,
      enum: ROLES,
      default: 'customer',
      lowercase: false,
      set: normalizeRole,
    },
    // Cafeteria this staff member belongs to. Customers have no cafeteria.
    // Cafeteria-scoped access is resolved from this field on the backend only.
    cafeteriaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafeteria',
      default: null,
    },
    balance: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'BLOCKED', 'SUSPENDED'],
      default: 'ACTIVE',
    },
    avatar: {
      type: String,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    agreedToTerms: {
      type: Boolean,
      required: [true, 'You must agree to the Terms & Conditions'],
      default: false,
    },
    otpVerifiedAt: {
      type: Date,
      default: null,
    },
    notificationSoundEnabled: {
      type: Boolean,
      default: true,
    },
    // --- Per-user notification preferences --------------------------------
    // Each staff member owns their own notification preferences. The platform
    // wide notify_* SETTINGs are only the default policy; the value that
    // actually decides whether THIS person gets a notification lives here, so
    // one manager can never mute (or spam) another account.
    notificationPreferences: {
      newOrders: { type: Boolean, default: true },
      lowStock: { type: Boolean, default: true },
      dailySales: { type: Boolean, default: false },
      securityLogin: { type: Boolean, default: true },
    },
    // --- Two-factor authentication for THIS account -----------------------
    // Per user, not global: the System Admin may REQUIRE 2FA system-wide
    // (Setting `two_factor_enabled`), but whether an individual account has
    // it enabled is the account owner's decision.
    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },
    // --- Delivery courier availability ---------------------------------
    // Manual on-duty toggle set by the courier from the delivery dashboard.
    // The manager's assignment dropdown reads this together with the live
    // active-delivery load so a new job is only offered to an available rider.
    isAvailable: {
      type: Boolean,
      default: true,
    },
    // Last time the courier did anything on the delivery system (API call or
    // socket connect). Used to render Available / Offline in the staff list.
    lastActiveAt: {
      type: Date,
      default: null,
    },
    // Newest real device GPS fix, mirrored while the courier is tracking an
    // active delivery. Never generated on the server.
    lastKnownLocation: {
      latitude: { type: Number, default: null, min: -90, max: 90 },
      longitude: { type: Number, default: null, min: -180, max: 180 },
      accuracy: { type: Number, default: null, min: 0 },
      heading: { type: Number, default: null, min: -360, max: 360 },
      speed: { type: Number, default: null, min: 0 },
      timestamp: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
  }
);

// Hash password before saving
UserSchema.pre('save', async function () {
  if (!this.isModified('password')) {
    return;
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Update updatedAt on save
UserSchema.pre('findOneAndUpdate', function () {
  this.set({ updatedAt: new Date() });
});

// Match password method
UserSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Get user profile without sensitive data
UserSchema.methods.getPublicProfile = function () {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    phone: this.phone,
    username: this.username,
    address: this.address,
    role: this.role,
    balance: this.balance,
    status: this.status,
    avatar: this.avatar,
    // Own security + own notification state only. A caller never receives
    // another account's preferences.
    twoFactorEnabled: this.twoFactorEnabled === true,
    notificationPreferences: {
      newOrders: this.notificationPreferences?.newOrders !== false,
      lowStock: this.notificationPreferences?.lowStock !== false,
      dailySales: this.notificationPreferences?.dailySales === true,
      securityLogin: this.notificationPreferences?.securityLogin !== false,
    },
    createdAt: this.createdAt,
  };
};

UserSchema.index({ role: 1 });
UserSchema.index({ status: 1 });
UserSchema.index({ cafeteriaId: 1 });

module.exports = mongoose.model('User', UserSchema);
