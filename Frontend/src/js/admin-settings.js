function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - ADMIN SETTINGS
 * ================================================================
 * Sections: Profile, Security, System Config, Notifications, Sessions
 * ================================================================
 */
(function () {
  "use strict";

  const API = () => window.AdminAPI;

  function $(id) { return document.getElementById(id); }
  function val(id, fb) { const el = $(id); return el ? (el.value || '').trim() : (fb || ''); }
  function num(id, fb) { return Number(val(id, String(fb))) || fb; }
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

  function saveSetting(key, value) {
    return API().put('/admin/settings/' + encodeURIComponent(key), { value });
  }

  async function loadSettingsMap() {
    const data = await API().get('/admin/settings');
    const map = {};
    if (data.success && Array.isArray(data.settings)) {
      for (const s of data.settings) map[s.key] = s.value;
    }
    return map;
  }

  /* =============================================
     1. ADMIN PROFILE
     ============================================= */
  async function loadProfile() {
    try {
      const data = await API().get('/auth/me');
      const u = data.user || {};
      $('adminProfileName').value = u.name || '';
      $('adminProfileEmail').value = u.email || '';
      $('adminProfilePhone').value = u.phone || '';
      $('adminProfileAvatar').value = u.avatar || '';
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
     2. SECURITY SETTINGS
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

  async function save2FA() {
    try {
      await saveSetting('two_factor_enabled', chk('twoFactorEnabled'));
      showAlert(tr('twofa_saved', 'Two-factor authentication setting saved'));
    } catch (e) { showAlert(tr('failed_save_settings', 'Failed to save 2FA: ') + e.message, 'error'); }
  }

  /* =============================================
     3. SYSTEM CONFIGURATION
     ============================================= */
  function populateSystemConfig(m) {
    $('cafeteriaOpeningTime').value = m.cafeteria_opening_time || '07:00';
    $('cafeteriaClosingTime').value = m.cafeteria_closing_time || '22:00';
    $('paymentCurrency').value = m.currency || 'ETB';
    $('maxDailyOrders').value = m.max_daily_orders || 100;
    $('orderAvailability').checked = m.order_availability !== false;
    $('deliveryFee').value = m.delivery_fee || 30;
    $('deliveryEnabled').checked = m.delivery_enabled !== false;
  }

  async function saveSystemConfig() {
    const btn = $('saveSystemConfigBtn');
    setLoading(btn, true);
    try {
      await saveSetting('cafeteria_opening_time', val('cafeteriaOpeningTime'));
      await saveSetting('cafeteria_closing_time', val('cafeteriaClosingTime'));
      await saveSetting('currency', val('paymentCurrency'));
      await saveSetting('max_daily_orders', num('maxDailyOrders', 100));
      await saveSetting('order_availability', chk('orderAvailability'));
      showAlert(tr('config_saved', 'System configuration saved'));
    } catch (e) { showAlert(tr('failed_save_settings', 'Failed to save config: ') + e.message, 'error'); }
    finally { setLoading(btn, false); }
  }

  async function saveDeliveryConfig() {
    const btn = $('saveDeliveryConfigBtn');
    setLoading(btn, true);
    try {
      await saveSetting('delivery_fee', num('deliveryFee', 30));
      await saveSetting('delivery_enabled', chk('deliveryEnabled'));
      showAlert(tr('delivery_settings_saved', 'Delivery settings saved'));
    } catch (e) { showAlert(tr('failed_save_settings', 'Failed to save delivery settings: ') + e.message, 'error'); }
    finally { setLoading(btn, false); }
  }

  /* =============================================
     4. NOTIFICATION PREFERENCES
     ============================================= */
  function populateNotifications(m) {
    $('notifyNewOrders').checked = m.notify_new_orders !== false;
    $('notifyLowStock').checked = m.notify_low_stock !== false;
    $('notifyDailySales').checked = m.notify_daily_sales === true;
    $('notifySecurityLogin').checked = m.notify_security_login !== false;
  }

  async function saveNotifications() {
    const btn = $('saveNotificationsBtn');
    setLoading(btn, true);
    try {
      await saveSetting('notify_new_orders', chk('notifyNewOrders'));
      await saveSetting('notify_low_stock', chk('notifyLowStock'));
      await saveSetting('notify_daily_sales', chk('notifyDailySales'));
      await saveSetting('notify_security_login', chk('notifySecurityLogin'));
      showAlert(tr('notifications_saved', 'Notification preferences saved'));
    } catch (e) { showAlert(tr('failed_save_settings', 'Failed to save notifications: ') + e.message, 'error'); }
    finally { setLoading(btn, false); }
  }


  /* =============================================
     SAVE ALL
     ============================================= */
  async function saveAllSettings() {
    const btn = $('saveAllSettingsBtn');
    setLoading(btn, true);
    try {
      const all = {
        cafeteria_opening_time: val('cafeteriaOpeningTime'),
        cafeteria_closing_time: val('cafeteriaClosingTime'),
        currency: val('paymentCurrency'),
        max_daily_orders: num('maxDailyOrders', 100),
        order_availability: chk('orderAvailability'),
        delivery_fee: num('deliveryFee', 30),
        delivery_enabled: chk('deliveryEnabled'),
        two_factor_enabled: chk('twoFactorEnabled'),
        notify_new_orders: chk('notifyNewOrders'),
        notify_low_stock: chk('notifyLowStock'),
        notify_daily_sales: chk('notifyDailySales'),
        notify_security_login: chk('notifySecurityLogin')
      };
      for (const [k, v] of Object.entries(all)) await saveSetting(k, v);
      showAlert(tr('all_settings_saved', 'All settings saved successfully'));
    } catch (e) { showAlert(tr('failed_save_settings', 'Failed to save all: ') + e.message, 'error'); }
    finally { setLoading(btn, false); }
  }

  /* =============================================
     INIT
     ============================================= */
  async function init() {
    $('adminProfileForm')?.addEventListener('submit', saveProfile);
    $('changePasswordBtn')?.addEventListener('click', changePassword);
    $('twoFactorEnabled')?.addEventListener('change', save2FA);
    $('saveSystemConfigBtn')?.addEventListener('click', saveSystemConfig);
    $('saveDeliveryConfigBtn')?.addEventListener('click', saveDeliveryConfig);
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
      const map = await loadSettingsMap();
      populateSystemConfig(map);
      populateNotifications(map);
    } catch (e) { showAlert(tr('failed_load_settings', 'Failed to load settings: ') + e.message, 'error'); }

    // Re-apply toggle styling after settings are loaded from backend
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
