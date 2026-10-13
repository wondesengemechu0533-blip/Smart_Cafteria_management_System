const Setting = require('../models/Setting');

const DEFAULT_SETTINGS = [
  // general
  { key: 'cafeteria_name', value: 'Smart Cafeteria', type: 'string', group: 'general', label: 'Cafeteria Name' },
  { key: 'cafeteria_description', value: '', type: 'string', group: 'general', label: 'Cafeteria Description' },
  { key: 'cafeteria_phone', value: '', type: 'string', group: 'general', label: 'Cafeteria Phone' },
  { key: 'cafeteria_email', value: '', type: 'string', group: 'general', label: 'Cafeteria Email' },
  { key: 'cafeteria_address', value: '', type: 'string', group: 'general', label: 'Cafeteria Address' },
  { key: 'cafeteria_opening_time', value: '07:00', type: 'string', group: 'general', label: 'Opening Time' },
  { key: 'cafeteria_closing_time', value: '22:00', type: 'string', group: 'general', label: 'Closing Time' },
  { key: 'cafeteria_logo_url', value: '', type: 'string', group: 'general', label: 'Cafeteria Logo URL' },
  { key: 'currency', value: 'ETB', type: 'string', group: 'general', label: 'Currency' },
  {
    key: 'support_email',
    value: 'support@smartcafeteria.com',
    type: 'string',
    group: 'general',
    label: 'Support Email',
  },
  { key: 'support_phone', value: '+251 911 000 000', type: 'string', group: 'general', label: 'Support Phone' },

  // operations
  { key: 'order_availability', value: true, type: 'boolean', group: 'operations', label: 'Order Availability' },
  { key: 'max_order_quantity', value: 10, type: 'number', group: 'operations', label: 'Maximum Order Quantity' },
  { key: 'max_daily_orders', value: 100, type: 'number', group: 'operations', label: 'Max Daily Order Limit' },
  { key: 'maintenance_mode', value: false, type: 'boolean', group: 'operations', label: 'Maintenance Mode' },

  // orders
  { key: 'minimum_order_amount', value: 0, type: 'number', group: 'orders', label: 'Minimum Order Amount' },
  { key: 'order_cancellation_enabled', value: true, type: 'boolean', group: 'orders', label: 'Order Cancellation' },
  {
    key: 'cancellation_window_minutes',
    value: 15,
    type: 'number',
    group: 'orders',
    label: 'Cancellation Window (minutes)',
  },
  {
    key: 'default_preparation_time',
    value: 15,
    type: 'number',
    group: 'orders',
    label: 'Default Preparation Time (minutes)',
  },

  // delivery
  { key: 'delivery_enabled', value: true, type: 'boolean', group: 'delivery', label: 'Enable Delivery Orders' },
  { key: 'delivery_fee', value: 30, type: 'number', group: 'delivery', label: 'Delivery Fee (ETB)' },
  {
    key: 'delivery_max_distance_km',
    value: 10,
    type: 'number',
    group: 'delivery',
    label: 'Max Delivery Distance (km)',
  },
  // Optional distance-based fee. 0 keeps the flat `delivery_fee` above, so
  // existing pricing is unchanged until an operator turns this on.
  {
    key: 'delivery_fee_per_km',
    value: 0,
    type: 'number',
    group: 'delivery',
    label: 'Additional Fee per km (ETB)',
  },
  {
    key: 'delivery_free_over_amount',
    value: 0,
    type: 'number',
    group: 'delivery',
    label: 'Free Delivery Above Order Value (ETB)',
  },
  // Average urban delivery speed, used for the ETA shown to the customer.
  {
    key: 'delivery_speed_kmh',
    value: 25,
    type: 'number',
    group: 'delivery',
    label: 'Average Delivery Speed (km/h)',
  },
  {
    key: 'delivery_prep_time_minutes',
    value: 15,
    type: 'number',
    group: 'delivery',
    label: 'Kitchen Prep Time Added To ETA (minutes)',
  },
  {
    key: 'delivery_eta_buffer_minutes',
    value: 5,
    type: 'number',
    group: 'delivery',
    label: 'ETA Buffer (minutes)',
  },
  {
    key: 'delivery_max_active_per_staff',
    value: 5,
    type: 'number',
    group: 'delivery',
    label: 'Max Active Deliveries per Staff',
  },
  {
    key: 'delivery_allow_customer_cancel',
    value: true,
    type: 'boolean',
    group: 'delivery',
    label: 'Allow Customer to Cancel Delivery',
  },

  // payments
  { key: 'payment_chapa_enabled', value: true, type: 'boolean', group: 'payments', label: 'Chapa Payments' },
  { key: 'payment_provider', value: 'chapa', type: 'string', group: 'payments', label: 'Default Payment Provider' },
  { key: 'payment_status_mode', value: 'automatic', type: 'string', group: 'payments', label: 'Payment Status Mode' },
  { key: 'service_fee', value: 20, type: 'number', group: 'payments', label: 'Platform Service Fee (ETB)' },
  { key: 'platform_fee_rate', value: 0, type: 'number', group: 'payments', label: 'Platform Revenue Share (%)' },

  // tax
  { key: 'vat_enabled', value: true, type: 'boolean', group: 'tax', label: 'Apply VAT / Tax' },
  { key: 'vat_rate', value: 15, type: 'number', group: 'tax', label: 'VAT / Tax Rate (%)' },
  {
    key: 'tax_authority_name',
    value: 'Ethiopian Ministry of Revenues',
    type: 'string',
    group: 'tax',
    label: 'Tax Authority Name',
  },
  { key: 'vat_number', value: '', type: 'string', group: 'tax', label: 'Organization TIN / VAT Number' },

  // language
  { key: 'default_language', value: 'en', type: 'string', group: 'language', label: 'Default System Language' },
  { key: 'allow_language_switch', value: true, type: 'boolean', group: 'language', label: 'Allow Language Switching' },

  // security
  { key: 'session_timeout_minutes', value: 10, type: 'number', group: 'security', label: 'Session Timeout (minutes)' },
  { key: 'login_max_attempts', value: 5, type: 'number', group: 'security', label: 'Maximum Login Attempts' },
  { key: 'admin_account_enabled', value: true, type: 'boolean', group: 'security', label: 'Admin Account Enabled' },
  { key: 'two_factor_enabled', value: false, type: 'boolean', group: 'security', label: 'Two-Factor Authentication' },
  {
    key: 'otp_verification_enabled',
    value: false,
    type: 'boolean',
    group: 'security',
    label: 'OTP Verification on Registration',
  },
  {
    key: 'registration_captcha_enabled',
    value: false,
    type: 'boolean',
    group: 'security',
    label: 'CAPTCHA on Registration',
  },
  { key: 'otp_expiry_minutes', value: 10, type: 'number', group: 'security', label: 'OTP Expiry (minutes)' },

  // notifications
  { key: 'notify_new_orders', value: true, type: 'boolean', group: 'notifications', label: 'New Order Notifications' },
  { key: 'notify_payments', value: true, type: 'boolean', group: 'notifications', label: 'Payment Notifications' },
  { key: 'notify_low_stock', value: true, type: 'boolean', group: 'notifications', label: 'Low Stock Notifications' },
  {
    key: 'notify_user_accounts',
    value: false,
    type: 'boolean',
    group: 'notifications',
    label: 'User Account Notifications',
  },
  {
    key: 'notify_daily_sales',
    value: false,
    type: 'boolean',
    group: 'notifications',
    label: 'Daily Sales Summary Email',
  },
  {
    key: 'notify_security_login',
    value: true,
    type: 'boolean',
    group: 'notifications',
    label: 'Security Login Alerts',
  },

  // appearance
  { key: 'theme', value: 'light', type: 'string', group: 'appearance', label: 'Theme' },
  { key: 'favicon_url', value: '', type: 'string', group: 'appearance', label: 'Favicon URL' },
  { key: 'appearance_logo_url', value: '', type: 'string', group: 'appearance', label: 'Appearance Logo URL' },
  { key: 'dashboard_layout', value: 'comfortable', type: 'string', group: 'appearance', label: 'Dashboard Layout' },
];

async function ensureDefaultSettings() {
  try {
    const existingSettings = await Setting.find({}, { key: 1, type: 1, group: 1, label: 1 }).lean();
    const existingMap = {};
    for (const s of existingSettings) existingMap[s.key] = s;

    const toInsert = [];
    const toUpdate = [];

    for (const def of DEFAULT_SETTINGS) {
      const existing = existingMap[def.key];
      if (!existing) {
        toInsert.push({
          key: def.key,
          value: def.value,
          type: def.type,
          group: def.group,
          label: def.label,
          protected: false,
        });
      } else {
        // Ensure type/group/label are set
        const changes = {};
        if (!existing.type) changes.type = def.type;
        if (!existing.group) changes.group = def.group;
        if (!existing.label) changes.label = def.label;
        if (Object.keys(changes).length > 0) {
          toUpdate.push({ key: def.key, $set: changes });
        }
      }
    }

    if (toInsert.length > 0) await Setting.insertMany(toInsert);
    for (const op of toUpdate) await Setting.updateOne({ key: op.key }, op.$set);

    // One-time security migration: the legacy default session timeout was 60
    // minutes; the product requires a 10-minute inactivity timeout. This only
    // upgrades DBs still holding the old default value (admins who explicitly
    // configured a custom value are left untouched).
    const legacySession = existingMap['session_timeout_minutes'];
    if (legacySession && Number(legacySession.value) === 60) {
      await Setting.updateOne({ key: 'session_timeout_minutes' }, { $set: { value: 10 } });
      console.log('Settings: legacy session_timeout_minutes=60 migrated to 10');
    }

    if (toInsert.length > 0 || toUpdate.length > 0) {
      console.log(`Settings: ${toInsert.length} inserted, ${toUpdate.length} updated`);
    }
  } catch (error) {
    console.error('Settings initialization error:', error.message);
  }
}

function coerceValue(key, value) {
  const def = DEFAULT_SETTINGS.find((s) => s.key === key);
  if (!def) return value;
  if (def.type === 'boolean') return value === 'true' || value === true || value === 1 || value === '1';
  if (def.type === 'number') {
    const n = Number(value);
    return isNaN(n) ? def.value : n;
  }
  return String(value);
}

async function getSettingsMap({ includeProtected = false } = {}) {
  const filter = includeProtected ? {} : { protected: { $ne: true } };
  const settings = await Setting.find(filter).lean();
  const map = {};
  for (const s of settings) {
    map[s.key] = s.value;
  }
  for (const def of DEFAULT_SETTINGS) {
    if (map[def.key] === undefined) {
      map[def.key] = def.value;
    }
  }
  return map;
}

async function getPublicSettings() {
  const map = await getSettingsMap({ includeProtected: false });
  return {
    cafeteriaName: map.cafeteria_name,
    currency: map.currency,
    orderAvailability: map.order_availability,
    maintenanceMode: map.maintenance_mode,
    deliveryEnabled: map.delivery_enabled,
    deliveryFee: Number(map.delivery_fee) || 0,
    deliveryFeePerKm: Number(map.delivery_fee_per_km) || 0,
    deliveryFreeOverAmount: Number(map.delivery_free_over_amount) || 0,
    deliveryMaxDistanceKm: Number(map.delivery_max_distance_km) || 0,
    deliverySpeedKmh: Number(map.delivery_speed_kmh) || 0,
    deliveryPrepTimeMinutes: Number(map.delivery_prep_time_minutes) || 0,
    deliveryEtaBufferMinutes: Number(map.delivery_eta_buffer_minutes) || 0,
    vatEnabled: map.vat_enabled,
    vatRate: Number(map.vat_rate) || 0,
    serviceFee: Number(map.service_fee) || 0,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  ensureDefaultSettings,
  coerceValue,
  getSettingsMap,
  getPublicSettings,
};
