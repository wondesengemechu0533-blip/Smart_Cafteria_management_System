const Cafeteria = require('../models/Cafeteria');
const User = require('../models/User');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const Refund = require('../models/Refund');
const MenuItem = require('../models/MenuItem');
const Category = require('../models/Category');
const ActivityLog = require('../models/ActivityLog');
const { normalizeRole, isAdminRole } = require('../config/roles');

const DEFAULT_CAFETERIA_NAME = 'Smart Cafeteria';
const DEFAULT_CAFETERIA_CODE = 'MAIN';
// Default real-world coordinates for the keyed cafeteria.
//
// These MUST be the cafeteria's actual operating city. They were previously
// set to Debre Berhan (9.6797, 39.5328) while every customer, order and the
// delivery tracking map are in Addis Ababa - so the delivery-range check
// measured ~113 km for a customer who was effectively next door and rejected
// every valid address as "beyond our 10 km delivery range".
//
// The value below is Addis Ababa, matching the centre the delivery map already
// defaults to. Correct it here (or set the cafeteria's own latitude/longitude)
// if the cafeteria moves.
const DEFAULT_CAFETERIA_LATITUDE = 9.03;
const DEFAULT_CAFETERIA_LONGITUDE = 38.74;

// Roles that belong to a cafeteria and must be scoped to it.
const CAFETERIA_STAFF_ROLES = ['cafeteria_admin', 'manager', 'cashier', 'kitchen', 'delivery'];

let cachedDefaultId = null;

/**
 * Idempotently create the default cafeteria (used for the initial single-cafeteria
 * deployment) and backfill any legacy records that predate multi-cafeteria support.
 *
 * Safe to run on every boot: each step only touches documents missing a
 * cafeteriaId.
 */
async function ensureDefaultCafeteria() {
  let cafeteria = await Cafeteria.findOne({ isDefault: true });
  if (!cafeteria) {
    cafeteria = await Cafeteria.findOne({ code: DEFAULT_CAFETERIA_CODE });
  }
  if (!cafeteria) {
    cafeteria = await Cafeteria.create({
      name: DEFAULT_CAFETERIA_NAME,
      code: DEFAULT_CAFETERIA_CODE,
      isDefault: true,
      status: 'ACTIVE',
      latitude: DEFAULT_CAFETERIA_LATITUDE,
      longitude: DEFAULT_CAFETERIA_LONGITUDE,
    });
    console.log(`✓ Created default cafeteria "${cafeteria.name}"`);
  } else if (cafeteria.latitude === null || cafeteria.latitude === undefined || cafeteria.longitude === null || cafeteria.longitude === undefined) {
    // Backfill coordinates on cafeterias created before GPS tracking existed.
    cafeteria.latitude = DEFAULT_CAFETERIA_LATITUDE;
    cafeteria.longitude = DEFAULT_CAFETERIA_LONGITUDE;
    await cafeteria.save();
  }
  cachedDefaultId = cafeteria._id;

  const unscoped = { $or: [{ cafeteriaId: null }, { cafeteriaId: { $exists: false } }] };
  const id = cafeteria._id;

  const results = await Promise.all([
    Order.updateMany(unscoped, { $set: { cafeteriaId: id } }),
    Payment.updateMany(unscoped, { $set: { cafeteriaId: id } }),
    Refund.updateMany(unscoped, { $set: { cafeteriaId: id } }),
    MenuItem.updateMany(unscoped, { $set: { cafeteriaId: id } }),
    Category.updateMany(unscoped, { $set: { cafeteriaId: id } }),
    ActivityLog.updateMany({ ...unscoped, actorRole: { $in: CAFETERIA_STAFF_ROLES } }, { $set: { cafeteriaId: id } }),
    User.updateMany({ ...unscoped, role: { $in: CAFETERIA_STAFF_ROLES } }, { $set: { cafeteriaId: id } }),
  ]);

  const backfilled = results.reduce((sum, r) => sum + (r.modifiedCount || 0), 0);
  if (backfilled > 0) {
    console.log(`✓ Backfilled cafeteriaId on ${backfilled} legacy record(s)`);
  }

  return cafeteria;
}

/** The default cafeteria id (resolved from the DB if the cache is cold). */
async function getDefaultCafeteriaId() {
  if (cachedDefaultId) return cachedDefaultId;
  const cafeteria = (await Cafeteria.findOne({ isDefault: true })) || (await Cafeteria.findOne({}));
  if (cafeteria) cachedDefaultId = cafeteria._id;
  return cachedDefaultId;
}

/**
 * Resolve the caller's cafeteria scope from TRUSTED server-side data.
 *
 * - System admins (admin/system_admin): global scope (cafeteriaId = null).
 * - Cafeteria staff: the cafeteriaId stored on their User record. A missing
 *   assignment is a hard 403 - the client can never supply or override it.
 *
 * @returns {{ cafeteriaId: import('mongoose').Types.ObjectId|null, global: boolean, role: string }}
 */
function resolveCafeteriaScope(req) {
  const role = normalizeRole(req?.user?.role);
  if (isAdminRole(role)) {
    return { cafeteriaId: null, global: true, role };
  }
  const cafeteriaId = req?.user?.cafeteriaId || null;
  if (!cafeteriaId) {
    const error = new Error('Your account is not assigned to a cafeteria. Contact a system administrator.');
    error.statusCode = 403;
    throw error;
  }
  return { cafeteriaId, global: false, role };
}

/**
 * Build a Mongo filter fragment for a scope. Global scope yields an empty
 * object (all cafeterias); otherwise a strict cafeteriaId match.
 */
function cafeteriaFilter(scope, field = 'cafeteriaId') {
  if (!scope || scope.global) return {};
  return { [field]: scope.cafeteriaId };
}

module.exports = {
  DEFAULT_CAFETERIA_NAME,
  DEFAULT_CAFETERIA_CODE,
  DEFAULT_CAFETERIA_LATITUDE,
  DEFAULT_CAFETERIA_LONGITUDE,
  CAFETERIA_STAFF_ROLES,
  ensureDefaultCafeteria,
  getDefaultCafeteriaId,
  resolveCafeteriaScope,
  cafeteriaFilter,
};
