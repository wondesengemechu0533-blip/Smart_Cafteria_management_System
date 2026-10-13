const mongoose = require('mongoose');

/**
 * Setting Schema - Store cafeteria settings as key/value pairs.
 *
 * Frontend Usage:
 * - admin/settings.html: View & update cafeteria settings
 */
const SettingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    type: {
      type: String,
      enum: ['string', 'number', 'boolean', 'object', 'array'],
      default: 'string',
    },
    group: {
      type: String,
      default: 'general',
    },
    label: {
      type: String,
      default: '',
    },
    protected: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Setting', SettingSchema);
