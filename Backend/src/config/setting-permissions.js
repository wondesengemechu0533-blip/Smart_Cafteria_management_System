/**
 * ============================================================================
 * SMART CAFETERIA ORDERING SYSTEM - SETTING PERMISSION MATRIX
 * ============================================================================
 * Single source of truth for WHO may change WHICH setting.
 *
 * The product defines two management roles:
 *
 *   Cafeteria Manager (`manager`)   - runs one cafeteria: opening hours, its
 *                                     menu/stock operations, and the fees when
 *                                     the System Admin has authorized it.
 *   System Admin (`admin`,
 *                 `system_admin`)   - owns the whole platform: global currency,
 *                                     global order limits, tax policy,
 *                                     system-wide security and access.
 *
 * Everything is enforced on the BACKEND (see admin.controller.js
 * `updateSetting`). The frontend only mirrors this matrix so it can grey out
 * the fields a role may not touch - it is never the security boundary.
 *
 * Two scopes exist:
 *   SYSTEM   - System Admin only.
 *   CAFETERIA - the Cafeteria Manager may change it (fees are the exception:
 *               they need the explicit fee-management authorization).
 * ============================================================================
 */

const { normalizeRole, isAdminRole } = require('./roles');

const SCOPE = {
  SYSTEM: 'system',
  CAFETERIA: 'cafeteria',
};

/**
 * Settings the System Admin owns. A Cafeteria Manager may READ them (so the
 * UI can explain the rule) but never write them.
 *
 * - currency + the order limits are the "global" knobs
 * - tax / platform revenue share are the platform's financial policy
 * - the whole security group is system-wide access policy
 * - the global notify_* flags are the platform default; each user's own
 *   preferences live on the User document (see notification.controller.js)
 */
const SYSTEM_ADMIN_ONLY_KEYS = [
  // Global money + order limits
  'currency',
  'max_daily_orders',
  'max_order_quantity',
  'minimum_order_amount',
  'maintenance_mode',

  // Tax / platform revenue policy
  'vat_enabled',
  'vat_rate',
  'vat_number',
  'tax_authority_name',
  'platform_fee_rate',

  // Payment provider configuration
  'payment_chapa_enabled',
  'payment_provider',
  'payment_status_mode',

  // System-wide language + appearance
  'default_language',
  'allow_language_switch',
  'theme',
  'favicon_url',
  'appearance_logo_url',
  'dashboard_layout',

  // System-wide security & access
  'session_timeout_minutes',
  'login_max_attempts',
  'admin_account_enabled',
  'two_factor_enabled',
  'otp_verification_enabled',
  'registration_captcha_enabled',
  'otp_expiry_minutes',

  // Platform-wide notification defaults
  'notify_new_orders',
  'notify_payments',
  'notify_low_stock',
  'notify_user_accounts',
  'notify_daily_sales',
  'notify_security_login',
];

/**
 * Fees a Cafeteria Manager may change ONLY when the System Admin has
 * authorized fee management for managers.
 *
 * Delivery Fee and Service Fee stay SEPARATE settings - they are never folded
 * into one another and never share a record.
 */
const FEE_KEYS = [
  'delivery_fee',
  'service_fee',
  'delivery_fee_per_km',
  'delivery_free_over_amount',
];

/**
 * The setting the System Admin uses to authorize (or revoke) Cafeteria
 * Manager fee management. Managers can never change it themselves.
 */
const MANAGER_FEE_AUTHORIZATION_KEY = 'manager_fee_management_enabled';

/**
 * The settings a Cafeteria Manager owns - the cafeteria's own operating rules.
 *
 * Opening hours are here (the manager sets when the cafeteria opens and
 * closes), together with the operational rules of the menu/stock/order flow.
 */
const CAFETERIA_MANAGED_KEYS = [
  // Cafeteria identity + contact
  'cafeteria_name',
  'cafeteria_description',
  'cafeteria_phone',
  'cafeteria_email',
  'cafeteria_address',
  'cafeteria_logo_url',
  'support_email',
  'support_phone',

  // Opening hours
  'cafeteria_opening_time',
  'cafeteria_closing_time',

  // Cafeteria operations
  'order_availability',
  'order_cancellation_enabled',
  'cancellation_window_minutes',
  'default_preparation_time',

  // Delivery operations (the FEES themselves are gated separately)
  'delivery_enabled',
  'delivery_max_distance_km',
  'delivery_speed_kmh',
  'delivery_prep_time_minutes',
  'delivery_eta_buffer_minutes',
  'delivery_max_active_per_staff',
  'delivery_allow_customer_cancel',
];

/**
 * Keys the System Admin can authorize managers for.
 */
const MANAGER_AUTHORIZABLE_KEYS = [MANAGER_FEE_AUTHORIZATION_KEY];

const SYSTEM_ADMIN_ONLY_SET = new Set(SYSTEM_ADMIN_ONLY_KEYS);
const FEE_KEY_SET = new Set(FEE_KEYS);
const CAFETERIA_MANAGED_SET = new Set(CAFETERIA_MANAGED_KEYS);
const MANAGER_AUTHORIZABLE_SET = new Set(MANAGER_AUTHORIZABLE_KEYS);

const ALL_KEYS = new Set([
  ...SYSTEM_ADMIN_ONLY_KEYS,
  ...CAFETERIA_MANAGED_KEYS,
  ...FEE_KEYS,
  ...MANAGER_AUTHORIZABLE_KEYS,
]);

/**
 * Which scope does a setting belong to?
 *
 * @param {string} key
 * @returns {'system'|'cafeteria'|'fee'|'unknown'}
 */
function getSettingScope(key) {
  const k = String(key || '').trim();
  if (MANAGER_AUTHORIZABLE_SET.has(k)) return SCOPE.SYSTEM;
  if (SYSTEM_ADMIN_ONLY_SET.has(k)) return SCOPE.SYSTEM;
  if (FEE_KEY_SET.has(k)) return 'fee';
  if (CAFETERIA_MANAGED_SET.has(k)) return SCOPE.CAFETERIA;
  return 'unknown';
}

/**
 * Is this a setting key the platform knows about?
 *
 * @param {string} key
 * @returns {boolean}
 */
function isKnownSettingKey(key) {
  return ALL_KEYS.has(String(key || '').trim());
}

/**
 * Is the manager allowed to manage the fees right now?
 *
 * @param {object} settingsMap Current settings (key -> value).
 * @returns {boolean}
 */
function isManagerFeeManagementAuthorized(settingsMap = {}) {
  const raw = settingsMap ? settingsMap[MANAGER_FEE_AUTHORIZATION_KEY] : undefined;
  // Default to authorized: a fresh install lets the manager run the cafeteria
  // until the System Admin explicitly revokes it.
  if (raw === undefined || raw === null || raw === '') return true;
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

/**
 * Decide whether a role may update a setting.
 *
 * @param {object} options
 * @param {string} options.key            Setting key being written.
 * @param {string} options.role            Role of the actor.
 * @param {object} [options.settingsMap]  Current settings (for the fee gate).
 * @returns {{allowed: boolean, scope: string, reason: string}}
 */
function evaluateSettingUpdate({ key, role, settingsMap = {} }) {
  const k = String(key || '').trim();
  const normalized = normalizeRole(role);
  const scope = getSettingScope(k);

  if (!isKnownSettingKey(k)) {
    return {
      allowed: false,
      scope: 'unknown',
      reason: `Unknown setting "${k}"`,
    };
  }

  // The System Admin may configure and override everything.
  if (isAdminRole(normalized)) {
    return { allowed: true, scope, reason: '' };
  }

  if (scope === SCOPE.SYSTEM) {
    return {
      allowed: false,
      scope,
      reason: `Only the system administrator can update the "${k}" setting`,
    };
  }

  if (scope === 'fee') {
    if (!isManagerFeeManagementAuthorized(settingsMap)) {
      return {
        allowed: false,
        scope,
        reason:
          'Fee management has not been authorized for cafeteria managers. ' +
          'Ask the system administrator to enable it.',
      };
    }
    return { allowed: true, scope, reason: '' };
  }

  if (scope === SCOPE.CAFETERIA) {
    // Only a cafeteria manager (and the admin, handled above) reaches here.
    if (normalized === 'manager') {
      return { allowed: true, scope, reason: '' };
    }
    return {
      allowed: false,
      scope,
      reason: 'Only the cafeteria manager can update this setting',
    };
  }

  return {
    allowed: false,
    scope,
    reason: `Only the system administrator can update the "${k}" setting`,
  };
}

/**
 * Build the permission map the frontend uses to render the settings page.
 * The backend remains the authority - this only avoids showing a manager a
 * button that is guaranteed to answer 403.
 *
 * @param {object} options
 * @param {string} options.role
 * @param {object} [options.settingsMap]
 * @returns {object}
 */
function describeSettingPermissions({ role, settingsMap = {} }) {
  const normalized = normalizeRole(role);
  const admin = isAdminRole(normalized);
  const feeAuthorized = isManagerFeeManagementAuthorized(settingsMap);

  const editable = {};
  const restricted = {};

  for (const key of ALL_KEYS) {
    const verdict = evaluateSettingUpdate({ key, role: normalized, settingsMap });
    if (verdict.allowed) {
      editable[key] = true;
    } else {
      editable[key] = false;
      restricted[key] = verdict.reason;
    }
  }

  return {
    role: normalized,
    isSystemAdmin: admin,
    feeManagementAuthorized: feeAuthorized,
    editable,
    restricted,
  };
}

module.exports = {
  SCOPE,
  SYSTEM_ADMIN_ONLY_KEYS,
  CAFETERIA_MANAGED_KEYS,
  FEE_KEYS,
  MANAGER_FEE_AUTHORIZATION_KEY,
  MANAGER_AUTHORIZABLE_KEYS,
  getSettingScope,
  isKnownSettingKey,
  isManagerFeeManagementAuthorized,
  evaluateSettingUpdate,
  describeSettingPermissions,
};
