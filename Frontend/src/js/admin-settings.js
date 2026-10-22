function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - SETTINGS
 * ================================================================
 * Sections: My Profile, My Security, Cafeteria Operations,
 *           Fees & Delivery, Platform Permissions, My Notifications
 *
 * ROLE MODEL
 *   Cafeteria Manager : owns the cafeteria - opening hours, order flow,
 *                       delivery operations and (only when the System Admin
 *                       authorized it) the delivery fee + service fee.
 *   System Admin      : owns the platform - may configure and override
 *                       everything, including global currency, global order
 *                       limits and system-wide security & access.
 *
 * The backend (PUT /admin/settings/:key) is the authority and answers 403 for
 * a key this role may not change. This script only mirrors that matrix so the
 * page never offers a button that is guaranteed to be refused, and it reads
 * the authoritative matrix from GET /admin/settings (`permissions`).
 * ================================================================
 */
(function () {
  "use strict";

  const API = () => window.AdminAPI;

  function $(id) { return document.getElementById(id); }
  function val(id, fb) { const el = $(id); return el ? (el.value || '').trim() : (fb || ''); }
  function num(id, fb) { const n = Number(val(id, String(fb))); return Number.isFinite(n) ? n : fb; }
  function chk(id) { const el = $(id); return el ? !!el.checked : false; }

  /* ---------- alert ---------- */
  function showAlert(msg, type) {
    const el = $('settingsAlert');
    if (!el) return;
    el.textContent = msg;
    el.className = 'mb-6 p-4 rounded-xl text-sm font-medium alert-slide ' +
      (type === 'error' ? 'bg-red-50 text-red-700 border border-red-200' :
       type === 'warning' ? 'bg-amber-50 text-amber-700 border border-amber-200' :
       'bg-emerald-50 text-emerald-700 border border-emerald-200');
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 4000);
  }

  function setLoading(btn, on) {
    if (!btn) return;
    if (on) { if (btn.disabled) return; btn.disabled = true; btn._o = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Saving...'; }
    else { btn.disabled = false; btn.innerHTML = btn._o || btn.innerHTML; btn._o = null; }
  }

  /* =============================================
     0. ROLE + PERMISSION STATE
     ============================================= */
  const state = {
    role: 'customer',
    isSystemAdmin: false,
    feeManagementAuthorized: true,
    editable: {},
    restricted: {},
  };

  function currentRole() {
    try {
      if (window.ScosRoles && typeof window.ScosRoles.getCurrentRole === 'function') {
        return window.ScosRoles.getCurrentRole();
      }
    } catch (e) { /* ignore */ }
    const raw = localStorage.getItem('userRole') || localStorage.getItem('role') || '';
    return String(raw).toLowerCase();
  }

  function canEdit(key) {
    if (state.editable && typeof state.editable[key] === 'boolean') return state.editable[key];
    return state.isSystemAdmin;
  }

  function saveSetting(key, value) {
    return API().put('/admin/settings/' + encodeURIComponent(key), { value });
  }

  /**
   * Save a group of settings, skipping the keys this role may not change.
   * Returns the number of settings actually written.
   */
  async function saveGroup(entries) {
    let saved = 0;
    const skipped = [];
    for (const [key, value] of entries) {
      if (!canEdit(key)) { skipped.push(key); continue; }
      await saveSetting(key, value);
      saved += 1;
    }
    return { saved, skipped };
  }

  /**
   * Apply the server-provided permission matrix to the form:
   * restricted fields are disabled, badged and explained.
   */
  function applyPermissions(permissions) {
    state.editable = (permissions && permissions.editable) || {};
    state.restricted = (permissions && permissions.restricted) || {};
    state.isSystemAdmin = !!(permissions && permissions.isSystemAdmin);
    state.feeManagementAuthorized = !(permissions && permissions.feeManagementAuthorized === false);

    document.querySelectorAll('[data-setting-key]').forEach((el) => {
      const key = el.getAttribute('data-setting-key');
      const editable = canEdit(key);
      el.disabled = !editable;
      if (!editable) {
        el.title = state.restricted[key] || 'Only the system administrator can change this setting';
      } else {
        el.removeAttribute('title');
      }

      const wrap = el.closest('[data-restricted-field]');
      if (wrap) {
        wrap.classList.toggle('is-restricted', !editable);
        const badge = wrap.querySelector('[data-restricted-badge]');
        if (badge) {
          badge.classList.toggle('hidden', editable);
          if (!editable) {
            badge.textContent = state.isSystemAdmin
              ? 'Read only'
              : (key === 'delivery_fee' || key === 'service_fee' ? 'Not authorized' : 'System Admin only');
          }
        }
      }
    });

    // Platform permissions (authorizing managers to manage fees) is a
    // System-Admin-only surface - hide the whole card for everybody else.
    const permSection = $('platformPermissionsSection');
    if (permSection) permSection.classList.toggle('hidden', !state.isSystemAdmin);

    // A manager who is not authorized to manage the fees gets an explicit
    // explanation instead of a mysteriously disabled input.
    const feeNote = $('feeAuthorizationNote');
    if (feeNote) {
      const feeBlocked = !state.isSystemAdmin && !state.feeManagementAuthorized;
      feeNote.classList.toggle('hidden', !feeBlocked);
    }

    // "Save All" only makes sense for a role that can write several groups.
    const saveAllBtn = $('saveAllSettingsBtn');
    if (saveAllBtn) saveAllBtn.classList.toggle('hidden', !state.isSystemAdmin);
  }

  /**
   * Role-aware headings.
   *
   * This page is shared by the Cafeteria Manager and the System Admin, so the
   * profile card is titled after the role that is actually signed in:
   * "Manager Profile" for a cafeteria manager, "Admin Profile" for a system
   * administrator.
   */
  function applyRoleLabels() {
    const isManager = state.role === 'manager';
    const title = $('profileSectionTitle');
    if (title) {
      title.textContent = isManager ? 'Manager Profile' : 'Admin Profile';
      // Re-apply the active language so the heading is translated, not English.
      title.setAttribute('data-i18n', isManager ? 'manager_profile_title' : 'admin_profile_title');
    }
    if (typeof window.applyTranslations === 'function') {
      setTimeout(() => window.applyTranslations(), 0);
    }
  }

  /**
   * Hide the sections the signed-in role must not see.
   *
   * The Cafeteria Manager's settings page carries the cafeteria operations
   * only. "Fees & Delivery" (delivery fee, service fee, delivery switch) and
   * "My Notification Preferences" belong to the System Admin's settings page
   * and are removed from the manager's view.
   *
   * This is a VIEW rule only - the backend keeps enforcing the permission
   * matrix (config/setting-permissions.js), so the API stays the authority.
   */
  function applyRoleSections() {
    const isManager = state.role === 'manager';
    const fees = $('feesDeliverySection');
    if (fees) fees.classList.toggle('hidden', isManager);
    const notifications = $('notificationPreferencesSection');
    if (notifications) notifications.classList.toggle('hidden', isManager);
  }

  async function loadSettings() {
    const data = await API().get('/admin/settings');
    const map = {};
    if (data.success && Array.isArray(data.settings)) {
      for (const s of data.settings) map[s.key] = s.value;
    }
    applyPermissions(data.permissions || {});
    return map;
  }

  /* =============================================
     1. MY PROFILE
     ============================================= */
  async function loadProfile() {
    try {
      const data = await API().get('/auth/me');
      const u = data.user || {};
      $('adminProfileName').value = u.name || '';
      $('adminProfileEmail').value = u.email || '';
      $('adminProfilePhone').value = u.phone || '';
      $('adminProfileAvatar').value = u.avatar || '';
      // Per-account 2FA - this account only.
      const twoFa = $('twoFactorEnabled');
      if (twoFa) twoFa.checked = u.twoFactorEnabled === true;
      // Update avatar circle
      const circle = $('profileAvatarCircle');
      if (circle && u.name) circle.textContent = u.name.charAt(0).toUpperCase();
      if (circle && u.avatar) {
        circle.innerHTML = '<img src="' + u.avatar + '" alt="Avatar" class="w-full h-full rounded-2xl object-cover">';
      }
    } catch (e) { showAlert(tr('failed_load_profile', 'Failed to load profile: ') + e.message, 'error'); }
  }

  async function saveProfile(e) {
    e.preventDefault();
    const btn = $('saveAdminProfileBtn');
    setLoading(btn, true);
    try {
      // Handle avatar file
      let avatarUrl = val('adminProfileAvatar');
      const avatarFile = $('avatarFileInput').files[0];
      if (avatarFile) {
        avatarUrl = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = ev => res(ev.target.result);
          r.onerror = rej;
          r.readAsDataURL(avatarFile);
        });
      }
      const data = await API().put('/auth/me', {
        name: val('adminProfileName'),
        email: val('adminProfileEmail'),
        phone: val('adminProfilePhone'),
        avatar: avatarUrl
      });
      const profile = API().getProfile() || {};
      const updated = Object.assign(profile, data.user);
      localStorage.setItem('userProfile', JSON.stringify(updated));
      try {
        const cur = JSON.parse(localStorage.getItem('current_user') || '{}');
        Object.assign(cur, { name: updated.name, email: updated.email, phone: updated.phone, avatar: updated.avatar });
        localStorage.setItem('current_user', JSON.stringify(cur));
        localStorage.setItem('userName', updated.name);
      } catch (_) {}
      // Update avatar circle
      const circle = $('profileAvatarCircle');
      if (circle && updated.name) circle.textContent = updated.name.charAt(0).toUpperCase();
      if (circle && updated.avatar) {
        circle.innerHTML = '<img src="' + updated.avatar + '" alt="Avatar" class="w-full h-full rounded-2xl object-cover">';
      }
      // Sync shared navbar avatar (admin-layout.js) immediately
      const navAvatar = document.getElementById('adminAvatar');
      if (navAvatar) {
        if (updated.avatar) {
          navAvatar.innerHTML = '<img src="' + updated.avatar + '" alt="Avatar" class="navbar-avatar-img">';
        } else if (updated.name) {
          navAvatar.textContent = updated.name.charAt(0).toUpperCase();
        }
      }
      showAlert(tr('profile_saved', 'Profile saved successfully'));
    } catch (e) { showAlert(tr('failed_save_profile', 'Failed to save profile: ') + e.message, 'error'); }
    finally { setLoading(btn, false); }
  }

  /* =============================================
     2. MY SECURITY (password + per-account 2FA)
     ============================================= */
  async function changePassword() {
    const cur = val('currentPassword');
    const nw = val('newPassword');
    const cf = val('confirmPassword');
    if (!cur || !nw) { showAlert(tr('fill_passwords', 'Fill in current and new password'), 'error'); return; }
    if (nw.length < 6) { showAlert(tr('password_min_length', 'New password must be at least 6 characters'), 'error'); return; }
    if (nw !== cf) { showAlert(tr('password_mismatch', 'Passwords do not match'), 'error'); return; }
    const btn = $('changePasswordBtn');
    setLoading(btn, true);
    try {
      const data = await API().put('/auth/password', { currentPassword: cur, newPassword: nw, confirmPassword: cf });
      // Store the new token returned by backend after password change
      if (data.token) {
        localStorage.setItem('auth_token', data.token);
      }
      $('currentPassword').value = '';
      $('newPassword').value = '';
      $('confirmPassword').value = '';
      showAlert(tr('password_updated', 'Password updated successfully. Please sign out and sign back in with your new password.'));
    } catch (e) { showAlert(tr('failed_change_password', 'Failed to change password: ') + e.message, 'error'); }
    finally { setLoading(btn, false); }
  }

  /**
   * 2FA is PER ACCOUNT: it is written to the caller's own user document, not
   * to the global `two_factor_enabled` policy setting (which only the System
   * Admin may change, on the Security page).
   */
  async function save2FA() {
    const el = $('twoFactorEnabled');
    if (!el) return;
    const next = el.checked;
    try {
      const data = await API().put('/auth/me', { twoFactorEnabled: next });
      if (data && data.user && typeof data.user.twoFactorEnabled === 'boolean') {
        el.checked = data.user.twoFactorEnabled;
      }
      showAlert(tr('twofa_saved', 'Two-factor authentication setting saved'));
    } catch (e) {
      el.checked = !next;
      showAlert(tr('failed_save_settings', 'Failed to save 2FA: ') + e.message, 'error');
    }
  }

  /* =============================================
     3. CAFETERIA OPERATIONS (opening hours + order flow)
     ============================================= */
  function populateOperations(m) {
    $('cafeteriaOpeningTime').value = m.cafeteria_opening_time || '07:00';
    $('cafeteriaClosingTime').value = m.cafeteria_closing_time || '22:00';
    $('paymentCurrency').value = m.currency || 'ETB';
    $('maxDailyOrders').value = m.max_daily_orders || 100;
    $('orderAvailability').checked = m.order_availability !== false;
  }

  async function saveOperations() {
    const btn = $('saveSystemConfigBtn');
    setLoading(btn, true);
    try {
      const { skipped } = await saveGroup([
        ['cafeteria_opening_time', val('cafeteriaOpeningTime')],
        ['cafeteria_closing_time', val('cafeteriaClosingTime')],
        ['currency', val('paymentCurrency')],
        ['max_daily_orders', num('maxDailyOrders', 100)],
        ['order_availability', chk('orderAvailability')],
      ]);
      showAlert(
        skipped.length
          ? tr('config_saved_partial', 'Cafeteria operations saved. Some system-wide settings are managed by the system administrator.')
          : tr('config_saved', 'Cafeteria operations saved'),
        skipped.length ? 'warning' : undefined
      );
    } catch (e) { showAlert(tr('failed_save_settings', 'Failed to save config: ') + e.message, 'error'); }
    finally { setLoading(btn, false); }
  }

  /* =============================================
     4. FEES & DELIVERY (delivery fee and service fee are SEPARATE)
     ============================================= */
  function populateFees(m) {
    $('deliveryFee').value = m.delivery_fee ?? 30;
    $('serviceFee').value = m.service_fee ?? 20;
    $('deliveryEnabled').checked = m.delivery_enabled !== false;
  }

  async function saveFees() {
    const btn = $('saveDeliveryConfigBtn');
    setLoading(btn, true);
    try {
      const { skipped } = await saveGroup([
        ['delivery_fee', num('deliveryFee', 30)],
        ['service_fee', num('serviceFee', 20)],
        ['delivery_enabled', chk('deliveryEnabled')],
      ]);
      showAlert(
        skipped.length
          ? tr('delivery_settings_saved_partial', 'Delivery settings saved. The fees are managed by the system administrator.')
          : tr('delivery_settings_saved', 'Fees and delivery settings saved'),
        skipped.length ? 'warning' : undefined
      );
    } catch (e) { showAlert(tr('failed_save_settings', 'Failed to save delivery settings: ') + e.message, 'error'); }
    finally { setLoading(btn, false); }
  }

  /* =============================================
     5. PLATFORM PERMISSIONS (system admin only)
     ============================================= */
  function populatePermissions(m) {
    const el = $('managerFeeManagement');
    if (el) el.checked = m.manager_fee_management_enabled !== false;
  }

  async function savePermissions() {
    const btn = $('savePermissionsBtn');
    setLoading(btn, true);
    try {
      await saveGroup([['manager_fee_management_enabled', chk('managerFeeManagement')]]);
      showAlert(tr('permissions_saved', 'Platform permissions saved'));
      // Re-read the authoritative matrix so the fee fields follow the new rule.
      const map = await loadSettings();
      populateFees(map);
    } catch (e) { showAlert(tr('failed_save_settings', 'Failed to save permissions: ') + e.message, 'error'); }
    finally { setLoading(btn, false); }
  }

  /* =============================================
     6. MY NOTIFICATION PREFERENCES (per user)
     ============================================= */
  function populateNotifications(prefs) {
    $('notifyNewOrders').checked = prefs.newOrders !== false;
    $('notifyLowStock').checked = prefs.lowStock !== false;
    $('notifyDailySales').checked = prefs.dailySales === true;
    $('notifySecurityLogin').checked = prefs.securityLogin !== false;
  }

  async function loadNotificationPreferences() {
    try {
      const data = await API().get('/notifications/preferences');
      populateNotifications((data && data.preferences) || {});
    } catch (e) {
      // Fall back to the platform defaults rather than showing wrong toggles.
      populateNotifications({});
    }
  }

  async function saveNotifications() {
    const btn = $('saveNotificationsBtn');
    setLoading(btn, true);
    try {
      const data = await API().put('/notifications/preferences', {
        newOrders: chk('notifyNewOrders'),
        lowStock: chk('notifyLowStock'),
        dailySales: chk('notifyDailySales'),
        securityLogin: chk('notifySecurityLogin'),
      });
      if (data && data.preferences) populateNotifications(data.preferences);
      showAlert(tr('notifications_saved', 'Notification preferences saved'));
    } catch (e) { showAlert(tr('failed_save_settings', 'Failed to save notifications: ') + e.message, 'error'); }
    finally { setLoading(btn, false); }
  }

  /* =============================================
     SAVE ALL (system admin only)
     ============================================= */
  async function saveAllSettings() {
    const btn = $('saveAllSettingsBtn');
    setLoading(btn, true);
    try {
      const entries = [
        ['cafeteria_opening_time', val('cafeteriaOpeningTime')],
        ['cafeteria_closing_time', val('cafeteriaClosingTime')],
        ['currency', val('paymentCurrency')],
        ['max_daily_orders', num('maxDailyOrders', 100)],
        ['order_availability', chk('orderAvailability')],
        ['delivery_fee', num('deliveryFee', 30)],
        ['service_fee', num('serviceFee', 20)],
        ['delivery_enabled', chk('deliveryEnabled')],
        ['manager_fee_management_enabled', chk('managerFeeManagement')],
      ];
      const { saved } = await saveGroup(entries);
      await API().put('/notifications/preferences', {
        newOrders: chk('notifyNewOrders'),
        lowStock: chk('notifyLowStock'),
        dailySales: chk('notifyDailySales'),
        securityLogin: chk('notifySecurityLogin'),
      });
      showAlert(tr('all_settings_saved', 'All settings saved successfully') + ' (' + saved + ')');
    } catch (e) { showAlert(tr('failed_save_settings', 'Failed to save all: ') + e.message, 'error'); }
    finally { setLoading(btn, false); }
  }

  /* =============================================
     INIT
     ============================================= */
  function repaintToggles() {
    document.querySelectorAll('.toggle-checkbox').forEach(cb => {
      const label = cb.nextElementSibling;
      if (!label) return;
      if (cb.checked) {
        label.classList.remove('bg-gray-300');
        label.classList.add('bg-emerald-500');
        cb.classList.remove('border-gray-300');
        cb.classList.add('border-emerald-500');
      } else {
        label.classList.remove('bg-emerald-500');
        label.classList.add('bg-gray-300');
        cb.classList.remove('border-emerald-500');
        cb.classList.add('border-gray-300');
      }
    });
  }

  async function init() {
    state.role = currentRole();
    applyRoleLabels();
    applyRoleSections();

    $('adminProfileForm')?.addEventListener('submit', saveProfile);
    $('changePasswordBtn')?.addEventListener('click', changePassword);
    $('twoFactorEnabled')?.addEventListener('change', save2FA);
    $('saveSystemConfigBtn')?.addEventListener('click', saveOperations);
    $('saveDeliveryConfigBtn')?.addEventListener('click', saveFees);
    $('savePermissionsBtn')?.addEventListener('click', savePermissions);
    $('saveNotificationsBtn')?.addEventListener('click', saveNotifications);
    $('saveAllSettingsBtn')?.addEventListener('click', saveAllSettings);

    // Avatar file preview
    $('avatarFileInput')?.addEventListener('change', function () {
      const f = this.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = ev => {
        const circle = $('profileAvatarCircle');
        if (circle) circle.innerHTML = '<img src="' + ev.target.result + '" alt="Avatar" class="w-full h-full rounded-2xl object-cover">';
      };
      r.readAsDataURL(f);
    });

    // Load data
    await loadProfile();
    try {
      const map = await loadSettings();
      populateOperations(map);
      populateFees(map);
      populatePermissions(map);
    } catch (e) { showAlert(tr('failed_load_settings', 'Failed to load settings: ') + e.message, 'error'); }
    await loadNotificationPreferences();

    repaintToggles();

    // Password show/hide toggle
    document.querySelectorAll(".toggle-password-icon").forEach(function (icon) {
      icon.addEventListener("click", function () {
        var targetId = icon.getAttribute("data-target");
        var input = document.getElementById(targetId);
        if (!input) return;
        var isPassword = input.type === "password";
        input.type = isPassword ? "text" : "password";
        icon.classList.toggle("fa-eye", !isPassword);
        icon.classList.toggle("fa-eye-slash", isPassword);
        icon.title = isPassword ? "Hide password" : "Show password";
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  // Expose the role state so other admin scripts (e.g. the security page) can
  // reuse the same rules instead of re-deriving them.
  window.ScosSettings = {
    currentRole,
    canEdit,
    isSystemAdmin: () => state.isSystemAdmin,
    isFeeManagementAuthorized: () => state.feeManagementAuthorized,
  };

  // Fallback theme application if theme.js not loaded
  function applyThemeFallback(theme) {
    var root = document.documentElement;
    root.classList.remove("theme-light", "theme-dark", "dark", "system");
    if (theme === "dark") {
      root.classList.add("theme-dark", "dark");
    } else if (theme === "system") {
      root.classList.add("system", "dark");
      if (!window.matchMedia || !window.matchMedia("(prefers-color-scheme: dark)").matches) {
        root.classList.remove("dark");
        root.classList.add("theme-light");
      }
    } else {
      root.classList.add("theme-light");
    }
    localStorage.setItem('scos_theme', theme);
  }

  // Expose setTheme for inline script
  window.setTheme = function(theme) {
    // Coordinate with shared theme.js
    if (window.ScosTheme && window.ScosTheme.apply) {
      window.ScosTheme.apply(theme);
    } else {
      // Fallback: apply theme manually if theme.js not loaded
      applyThemeFallback(theme);
    }
    localStorage.setItem('scos_theme', theme);
  };
})();
