const mongoose = require('mongoose');

/**
 * OtpVerification Schema
 *
 * Stores time-limited, hashed verification codes. Plain-text codes are NEVER
 * persisted - only a SHA-256 digest (salted with a per-record random salt).
 *
 * Purposes:
 *   - REGISTER        : email/phone verification during registration
 *   - PASSWORD_RESET  : verify the account owner before resetting a password
 */
const OtpVerificationSchema = new mongoose.Schema(
  {
    email: { type: String, lowercase: true, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    codeHash: { type: String, required: true },
    salt: { type: String, required: true },
    purpose: {
      type: String,
      enum: ['REGISTER', 'PASSWORD_RESET'],
      default: 'REGISTER',
    },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: null },
    consumed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

OtpVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
OtpVerificationSchema.index({ email: 1, purpose: 1 });
OtpVerificationSchema.index({ phone: 1, purpose: 1 });

module.exports = mongoose.model('OtpVerification', OtpVerificationSchema);
