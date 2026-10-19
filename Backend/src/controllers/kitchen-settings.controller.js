const KitchenSetting = require('../models/KitchenSetting');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');

/**
 * The canonical persisted fields. These are the schema's names and stay that
 * way - they are the stored truth and changing them would need a migration.
 */
const ALLOWED_FIELDS = [
  'station',
  'notificationSound',
  'orderAlertSound',
  'preparationTimerAlert',
  'autoRefresh',
  'refreshInterval',
  'showCompletedOrders',
];

/**
 * Why this table exists: the kitchen settings page
 * (Frontend/src/pages/kitchen/settings.js) collects the form as
 * stationName / generalNotificationSound / autoRefreshEnabled /
 * autoRefreshInterval, but the schema stores station / notificationSound /
 * autoRefresh / refreshInterval.
 *
 * The four names never lined up, and the old allow-list silently dropped
 * whatever did not match. So the page answered 200 and toasted "Settings saved
 * successfully" while persisting nothing - type a station name, reload, and
 * "Station 1" is back. That is a silent data loss with a success message on
 * top of it, which is the worst possible shape for a bug report.
 *
 * The schema names stay canonical; these aliases are the translation layer, so
 * both the old and the new client keep working.
 */
const FIELD_ALIASES = {
  stationName: 'station',
  generalNotificationSound: 'notificationSound',
  autoRefreshEnabled: 'autoRefresh',
  autoRefreshInterval: 'refreshInterval',
};

/**
 * Resolve an incoming key to the field it actually sets.
 * Returns null for a key that maps to nothing, so it can be REPORTED rather
 * than dropped without a word.
 */
function resolveField(key) {
  if (ALLOWED_FIELDS.includes(key)) return key;
  return FIELD_ALIASES[key] || null;
}

/**
 * @desc    Get the current user's kitchen settings
 * @route   GET /api/v1/kitchen/settings
 * @access  Private/Kitchen or Admin
 *
 * Creates a settings document with defaults if none exists.
 * Response: { success, settings }
 */
exports.getKitchenSettings = async (req, res) => {
  try {
    let settings = await KitchenSetting.findOne({ userId: req.user.id });

    if (!settings) {
      settings = await KitchenSetting.create({ userId: req.user.id });
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      settings,
    });
  } catch (error) {
    console.error('❌ Get Kitchen Settings Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Update the current user's kitchen settings
 * @route   PUT /api/v1/kitchen/settings
 * @access  Private/Kitchen or Admin
 *
 * Creates a settings document with defaults if none exists, then
 * merges the provided body fields into it.
 * Response: { success, settings }
 */
exports.updateKitchenSettings = async (req, res) => {
  try {
    let settings = await KitchenSetting.findOne({ userId: req.user.id });

    if (!settings) {
      settings = new KitchenSetting({ userId: req.user.id });
    }

    const applied = [];
    const ignored = [];

    Object.keys(req.body || {}).forEach((key) => {
      const field = resolveField(key);
      if (!field) {
        ignored.push(key);
        return;
      }
      if (req.body[key] === undefined) return;
      settings[field] = req.body[key];
      if (field !== key) applied.push(`${key} -> ${field}`);
    });

    // Never discard a field silently again. A mismatched name now shows up in
    // the response and the log instead of quietly reverting the user's input.
    if (ignored.length) {
      console.warn(
        `⚠️ /kitchen/settings ignored unknown field(s) [${ignored.join(', ')}] ` +
          `for user=${req.user.id}. Known: ${[...ALLOWED_FIELDS, ...Object.keys(FIELD_ALIASES)].join(', ')}`
      );
    }

    await settings.save();

    res.status(HTTP_STATUS.OK).json({
      success: true,
      settings,
      // Echo the mapping so a client can tell what actually landed.
      appliedFields: applied,
      ...(ignored.length ? { ignoredFields: ignored } : {}),
    });
  } catch (error) {
    console.error('❌ Update Kitchen Settings Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};
