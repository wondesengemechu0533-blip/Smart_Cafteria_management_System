/**
 * ==========================================================================
 * SMART CAFETERIA ORDERING SYSTEM - SYSTEM SECURITY POLICY
 * ==========================================================================
 * The System-Admin-only surface for the system-wide security and access
 * policy (session timeout, login attempts, 2FA requirement, OTP / CAPTCHA on
 * registration).
 *
 * These are the `security` group settings, which the backend reserves for the
 * System Admin: PUT /admin/settings/:key answers 403 for anybody else. This
 * page therefore only renders for an administrator and it never writes a key
 * the caller may not change.
 *
 * A person's OWN password and 2FA live in Settings ("My Security") - they are
 * per account and are not touched by this page.
 * ==========================================================================
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function val(id, fb) { const el = $(id); return el ? (el.value || '').trim() : (fb || ''); }
  function num(id, fb) { const n = Number(val(id, String(fb))); return Number.isFinite(n) ? n : fb; }
  function chk(id) { const el = $(id); return el ? !!el.checked : false; }

  function showAlert(msg, type) {
    const el = $('securityAlert');
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
    if (on) {
      if (btn.disabled) return;
      btn.disabled = true;
      btn._o = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Saving...';
    } else {
      btn.disabled = false;
      btn.innerHTML = btn._o || btn.innerHTML;
      btn._o = null;
    }
  }

  function isSystemAdmin() {
    try {
      if (window.ScosRoles && typeof window.ScosRoles.getCurrentRole === 'function') {
        const role = window.ScosRoles.getCurrentRole();
        return role === 'admin' || role === 'system_admin';
      }
    } catch (e) { /* ignore */ }
    const raw = String(localStorage.getItem('userRole') || localStorage.getItem('role') || '').toLowerCase();
    return raw === 'admin' || raw === 'system_admin';
  }

  function repaintToggles() {
    document.querySelectorAll('.toggle-checkbox').forEach(function (cb) {
      const label = cb.nextElementSibling;
      if (!label) return;
      if (cb.checked) {
        label.classList.remove('bg-gray-300');
        label.classList.add('bg-red-500');
        cb.classList.remove('border-gray-300');
        cb.classList.add('border-red-500');
      } else {
        label.classList.remove('bg-red-500');
        label.classList.add('bg-gray-300');
        cb.classList.remove('border-red-500');
        cb.classList.add('border-gray-300');
      }
    });
  }

  function populate(map) {
    $('sessionTimeoutMinutes').value = map.session_timeout_minutes ?? 10;
    $('loginMaxAttempts').value = map.login_max_attempts ?? 5;
    $('twoFactorPolicy').checked = map.two_factor_enabled === true;
    $('otpVerificationEnabled').checked = map.otp_verification_enabled === true;
    $('registrationCaptchaEnabled').checked = map.registration_captcha_enabled === true;
    $('adminAccountEnabled').checked = map.admin_account_enabled !== false;
    $('otpExpiryMinutes').value = map.otp_expiry_minutes ?? 10;
    repaintToggles();
  }

  async function load() {
    if (!isSystemAdmin()) {
      const denied = $('securityDenied');
      const content = $('securityContent');
      if (denied) denied.classList.remove('hidden');
      if (content) content.classList.add('hidden');
      return;
    }
    try {
      const data = await window.AdminAPI.get('/admin/settings');
      const map = {};
      if (data.success && Array.isArray(data.settings)) {
        for (const s of data.settings) map[s.key] = s.value;
      }
      populate(map);
    } catch (e) {
      showAlert('Failed to load security settings: ' + (e.message || ''), 'error');
    }
  }

  async function save() {
    if (!isSystemAdmin()) {
      showAlert('Only the system administrator can change the security policy.', 'error');
      return;
    }
    const btn = $('saveSecurityBtn');
    setLoading(btn, true);
    try {
      const entries = [
        ['session_timeout_minutes', num('sessionTimeoutMinutes', 10)],
        ['login_max_attempts', num('loginMaxAttempts', 5)],
        ['two_factor_enabled', chk('twoFactorPolicy')],
        ['otp_verification_enabled', chk('otpVerificationEnabled')],
        ['registration_captcha_enabled', chk('registrationCaptchaEnabled')],
        ['admin_account_enabled', chk('adminAccountEnabled')],
        ['otp_expiry_minutes', num('otpExpiryMinutes', 10)],
      ];
      for (const [key, value] of entries) {
        await window.AdminAPI.put('/admin/settings/' + encodeURIComponent(key), { value });
      }
      showAlert('Security policy saved');
    } catch (e) {
      showAlert('Failed to save the security policy: ' + (e.message || ''), 'error');
    } finally {
      setLoading(btn, false);
    }
  }

  async function init() {
    $('saveSecurityBtn')?.addEventListener('click', save);
    await load();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
