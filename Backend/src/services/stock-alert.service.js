const mongoose = require('mongoose');
const MenuItem = require('../models/MenuItem');
const StockAlert = require('../models/StockAlert');
const StockTransaction = require('../models/StockTransaction');
const { emitSocketEvent } = require('../utils/socket');

/**
 * Stock alert lifecycle service.
 *
 * Single source of truth for keeping StockAlert records in sync with the
 * authoritative MenuItem.stockQuantity / lowStockThreshold configuration:
 *
 *  - quantity <= threshold (and > 0)  → maintain one active low_stock alert
 *  - quantity == 0                    → maintain one active out_of_stock alert
 *  - quantity > threshold             → resolve open low_stock/out_of_stock
 *                                       alerts (condition genuinely cleared)
 *
 * Rules enforced here:
 *  - No duplicate active alerts for the same item + condition (findOne first,
 *    unique partial index as the hard backstop).
 *  - Alerts are only auto-resolved when the ACTUAL stock condition satisfies
 *    the resolution rule - never just because a request was submitted/approved.
 *  - Items on quality hold are never flipped back to AVAILABLE.
 *
 * Every public function is safe to call repeatedly (idempotent) and tolerant
 * of failures: alert bookkeeping must never break the main stock flow.
 */

const OPEN_STATUSES = ['active', 'acknowledged'];
const THRESHOLD_ALERT_TYPES = ['low_stock', 'out_of_stock'];

function isTestEnv() {
  return process.env.NODE_ENV === 'test';
}

function logError(context, error) {
  if (isTestEnv()) return;
  console.error(`❌ stock-alert.service ${context}:`, error && error.message ? error.message : error);
}

function logWarn(context, message) {
  if (isTestEnv()) return;
  console.warn(`⚠️ stock-alert.service ${context}:`, message);
}

/**
 * Compute the threshold condition for a menu item.
 * @returns {{ breached: boolean, alertType: 'low_stock'|'out_of_stock'|null,
 *             severity: string|null, reason: string|null, quantity: number,
 *             threshold: number }}
 */
function getThresholdCondition(item) {
  const quantity = Math.max(0, Number(item && item.stockQuantity) || 0);
  const threshold = Math.max(0, Number(item && item.lowStockThreshold) || 0);

  if (quantity === 0) {
    return {
      breached: true,
      alertType: 'out_of_stock',
      severity: 'critical',
      reason: `Out of stock: current quantity is 0 (minimum ${threshold})`,
      quantity,
      threshold,
    };
  }
  if (quantity <= threshold) {
    return {
      breached: true,
      alertType: 'low_stock',
      severity: 'high',
      reason: `Low stock: current quantity ${quantity} is at or below minimum ${threshold}`,
      quantity,
      threshold,
    };
  }
  return { breached: false, alertType: null, severity: null, reason: null, quantity, threshold };
}

/**
 * Derive the stock status for an item from its quantity and minimum
 * (low-stock) threshold:
 *   quantity == 0           → OUT_OF_STOCK
 *   quantity <= threshold   → LOW_STOCK
 *   quantity > threshold    → IN_STOCK
 * Pure derivation — never persisted as a duplicate database field.
 * @returns {'IN_STOCK'|'LOW_STOCK'|'OUT_OF_STOCK'}
 */
function getStockStatus(item) {
  const quantity = Math.max(0, Number(item && item.stockQuantity) || 0);
  const threshold = Math.max(0, Number(item && item.lowStockThreshold) || 0);
  if (quantity === 0) return 'OUT_OF_STOCK';
  if (quantity <= threshold) return 'LOW_STOCK';
  return 'IN_STOCK';
}

/**
 * Recompute availabilityStatus for an item WITHOUT saving.
 * Mutates and returns the item. Quality holds block AVAILABLE.
 */
function recalculateAvailability(item) {
  if (!item) return item;
  const quantity = Math.max(0, Number(item.stockQuantity) || 0);
  if (quantity === 0) {
    item.availabilityStatus = 'OUT_OF_STOCK';
  } else if (item.qualityHold === true || item.availability === false) {
    item.availabilityStatus = 'UNAVAILABLE';
  } else {
    item.availabilityStatus = 'AVAILABLE';
  }
  return item;
}

function serializeAlertPayload(alert, extra) {
  return Object.assign(
    {
      alertId: alert._id,
      itemId: alert.itemId || null,
      itemName: alert.itemName,
      alertType: alert.alertType,
      severity: alert.severity,
      status: alert.status,
      reason: alert.reason,
      cafeteriaId: alert.cafeteriaId || null,
      updatedAt: alert.updatedAt,
    },
    extra || {}
  );
}

function emitAlertEvent(eventName, rooms, payload) {
  try {
    (rooms || ['admin', 'kitchen']).forEach((room) => emitSocketEvent(room, eventName, payload));
  } catch (e) {
    logWarn('emit', e.message);
  }
}

async function loadItem(itemIdOrDoc) {
  if (!itemIdOrDoc) return null;
  if (typeof itemIdOrDoc === 'object' && itemIdOrDoc._id) return itemIdOrDoc;
  if (!mongoose.isValidObjectId(String(itemIdOrDoc))) return null;
  return MenuItem.findById(itemIdOrDoc);
}

/**
 * Resolve every open (active/acknowledged) SYSTEM threshold alert of the given
 * types for an item. Manual (kitchen-reported) alerts are never auto-resolved.
 */
async function resolveOpenThresholdAlerts(item, types, { note, resolvedBy = null } = {}) {
  const alerts = await StockAlert.find({
    itemId: item._id,
    alertType: { $in: types && types.length ? types : THRESHOLD_ALERT_TYPES },
    alertSource: 'system',
    status: { $in: OPEN_STATUSES },
  });

  const resolved = [];
  for (const alert of alerts) {
    alert.status = 'resolved';
    alert.resolvedBy = resolvedBy;
    alert.resolvedAt = new Date();
    alert.resolutionReason = alert.resolutionReason || 'Stock recovered';
    alert.resolutionSolution = alert.resolutionSolution || 'Automatic recalculation';
    alert.resolutionNote = note || `Stock quantity ${item.stockQuantity} is above minimum threshold ${item.lowStockThreshold}`;
    try {
      await alert.save();
      resolved.push(alert);
    } catch (e) {
      logError('resolveOpenThresholdAlerts.save', e);
    }
  }
  return resolved;
}

/**
 * Ensure exactly one open SYSTEM alert matches the item's current threshold
 * condition. Creates, updates or resolves alerts as needed. Idempotent.
 *
 * @param {string|object} itemIdOrDoc MenuItem id or document
 * @param {object} [options]
 * @param {boolean} [options.emit=true]   emit socket refresh events
 * @param {object} [options.req]          express req for audit actor (optional)
 * @returns {Promise<{item, condition, created, updated, resolved, alert}|null>}
 */
async function syncStockAlertsForItem(itemIdOrDoc, options = {}) {
  const emit = options.emit !== false;
  try {
    const item = await loadItem(itemIdOrDoc);
    if (!item) return null;

    const condition = getThresholdCondition(item);
    let created = null;
    let updated = null;
    let resolvedAlerts = [];

    if (condition.breached) {
      // A different open threshold type is stale (e.g. out_of_stock open but
      // quantity is now 2 with threshold 5 → low_stock applies instead).
      const staleTypes = THRESHOLD_ALERT_TYPES.filter((t) => t !== condition.alertType);
      resolvedAlerts = await resolveOpenThresholdAlerts(item, staleTypes, {
        note: `Stock condition changed to ${condition.alertType} (quantity ${condition.quantity}, minimum ${condition.threshold})`,
      });

      let openAlert = await StockAlert.findOne({
        itemId: item._id,
        alertType: condition.alertType,
        alertSource: 'system',
        status: { $in: OPEN_STATUSES },
      });

      if (!openAlert) {
        try {
          openAlert = await StockAlert.create({
            itemId: item._id,
            itemName: item.name && item.name.en ? item.name.en : String(item._id),
            alertType: condition.alertType,
            alertSource: 'system',
            severity: condition.severity,
            reason: condition.reason,
            reportedBy: null,
            reportedByRole: 'system',
            status: 'active',
            cafeteriaId: item.cafeteriaId || null,
          });
          created = openAlert;
        } catch (e) {
          if (e && e.code === 11000) {
            // Lost a creation race - the winning alert is the one to keep.
            openAlert = await StockAlert.findOne({
              itemId: item._id,
              alertType: condition.alertType,
              alertSource: 'system',
              status: { $in: OPEN_STATUSES },
            });
          } else {
            throw e;
          }
        }
      } else {
        // Maintain the open alert: refresh the snapshot fields so the listed
        // quantity/reason match the latest database state.
        const nextReason = condition.reason;
        const nextSeverity = condition.severity;
        if (openAlert.reason !== nextReason || openAlert.severity !== nextSeverity) {
          openAlert.reason = nextReason;
          openAlert.severity = nextSeverity;
          try {
            await openAlert.save();
            updated = openAlert;
          } catch (e) {
            logError('sync.update', e);
          }
        }
      }

      if (emit && (created || updated || resolvedAlerts.length)) {
        if (created) {
          emitAlertEvent('stock:alert', ['admin', 'kitchen'], serializeAlertPayload(created, {
            currentQuantity: condition.quantity,
            minimumQuantity: condition.threshold,
            createdAt: created.createdAt,
          }));
        }
        if (updated) {
          emitAlertEvent('stock:alert:updated', ['admin', 'kitchen'], serializeAlertPayload(updated, {
            currentQuantity: condition.quantity,
            minimumQuantity: condition.threshold,
          }));
        }
        resolvedAlerts.forEach((a) => {
          emitAlertEvent('stock:alert:updated', ['admin', 'kitchen'], serializeAlertPayload(a, {
            currentQuantity: condition.quantity,
            minimumQuantity: condition.threshold,
            resolutionNote: a.resolutionNote,
          }));
        });
      }

      return { item, condition, created, updated, resolved: resolvedAlerts, alert: openAlert };
    }

    // Condition cleared → auto-resolve only when stock genuinely satisfies the
    // resolution rule (quantity above the configured minimum threshold).
    resolvedAlerts = await resolveOpenThresholdAlerts(item, THRESHOLD_ALERT_TYPES, {
      note: `Automatically resolved: stock quantity ${condition.quantity} is above minimum threshold ${condition.threshold}`,
    });
    if (emit && resolvedAlerts.length) {
      resolvedAlerts.forEach((a) => {
        emitAlertEvent('stock:alert:updated', ['admin', 'kitchen'], serializeAlertPayload(a, {
          currentQuantity: condition.quantity,
          minimumQuantity: condition.threshold,
          resolutionNote: a.resolutionNote,
        }));
      });
    }

    return { item, condition, created: null, updated: null, resolved: resolvedAlerts, alert: null };
  } catch (error) {
    logError('syncStockAlertsForItem', error);
    return null;
  }
}

/**
 * Atomically change an item's stock by `delta` (positive to add, negative to
 * reduce) using the LATEST database value, record a StockTransaction and
 * re-run the alert lifecycle. Returns null when the item is missing.
 *
 * The caller is responsible for permission checks and validation.
 */
async function applyStockDelta({
  itemId,
  delta,
  action = 'RESTOCK',
  performedBy = null,
  performedByRole = null,
  restockRequestId = null,
  issueReportId = null,
  orderId = null,
  cafeteriaId = null,
}) {
  if (!mongoose.isValidObjectId(String(itemId))) return null;
  if (!Number.isFinite(delta) || delta === 0) return null;

  const updated = await MenuItem.findOneAndUpdate(
    { _id: itemId },
    { $inc: { stockQuantity: delta } },
    { new: true }
  );
  if (!updated) return null;
  if (updated.stockQuantity < 0) {
    // Should be impossible (callers validate), but never persist negative stock.
    updated.stockQuantity = 0;
  }
  recalculateAvailability(updated);
  try {
    await updated.save({ validateBeforeSave: false });
  } catch (e) {
    logError('applyStockDelta.save', e);
  }

  const previousQuantity = updated.stockQuantity - delta;
  try {
    await StockTransaction.create({
      foodId: updated._id,
      previousQuantity: Math.max(0, previousQuantity),
      quantityChanged: delta,
      newQuantity: updated.stockQuantity,
      action,
      performedBy,
      performedByRole,
      orderId: orderId || null,
      restockRequestId: restockRequestId || null,
      issueReportId: issueReportId || null,
      cafeteriaId: cafeteriaId || updated.cafeteriaId || null,
    });
  } catch (e) {
    logError('applyStockDelta.transaction', e);
  }

  await syncStockAlertsForItem(updated);
  return updated;
}

/**
 * Bulk sync for a set of items (used by GET endpoints so the list always
 * reflects the current database condition).
 */
async function syncItems(items, options = {}) {
  const results = [];
  for (const item of items || []) {
    // Sequential on purpose: alert creation races are rare and the unique
    // index is the backstop; parallel writes would only add contention.
    // eslint-disable-next-line no-await-in-loop
    const r = await syncStockAlertsForItem(item, options);
    if (r) results.push(r);
  }
  return results;
}

module.exports = {
  OPEN_STATUSES,
  THRESHOLD_ALERT_TYPES,
  getThresholdCondition,
  getStockStatus,
  recalculateAvailability,
  resolveOpenThresholdAlerts,
  syncStockAlertsForItem,
  syncItems,
  applyStockDelta,
};
