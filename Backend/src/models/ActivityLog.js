const mongoose = require('mongoose');

/**
 * ActivityLog Schema - Audit trail of admin/system activity.
 *
 * Frontend Usage:
 * - admin dashboard / activity views: show audit trail.
 */
const ActivityLogSchema = new mongoose.Schema(
  {
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    actorName: {
      type: String,
      default: 'System',
    },
    actorRole: {
      type: String,
      default: '',
    },
    // Cafeteria the actor belongs to (null for system-level/system-admin events).
    cafeteriaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafeteria',
      default: null,
    },
    action: {
      type: String,
      required: true,
    },
    entity: {
      type: String,
      default: '',
    },
    entityId: {
      type: String,
      default: '',
    },
    description: {
      type: String,
      default: '',
    },
    result: {
      type: String,
      enum: ['SUCCESS', 'FAILED', 'PENDING'],
      default: 'SUCCESS',
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    ip: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

ActivityLogSchema.index({ actorId: 1 });
ActivityLogSchema.index({ actorRole: 1 });
ActivityLogSchema.index({ cafeteriaId: 1, createdAt: -1 });
ActivityLogSchema.index({ action: 1 });
ActivityLogSchema.index({ entity: 1 });
ActivityLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ActivityLog', ActivityLogSchema);
