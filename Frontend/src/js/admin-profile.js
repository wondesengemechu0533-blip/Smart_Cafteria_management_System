function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - ADMIN PROFILE
 * ================================================================
 * Loads admin profile and handles password change
 * ================================================================
 */
(function () {
  "use strict";

  function showAlert(message, type) {
    const el = document.getElementById('profileAlert');
    if (!el) return;
    el.textContent = message;
    el.className = 'alert-banner ' + (type || 'success');
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
  }

  function setLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.dataset.originalText = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Updating...';
    } else {
      btn.disabled = false;
      if (btn.dataset.originalText) {
        btn.innerHTML = btn.dataset.originalText;
        delete btn.dataset.originalText;
      }
    }
  }

  /**
   * Role-aware page title.
   *
   * The page is shared by the Cafeteria Manager and the System Admin, so it is
   * named after the role that is signed in: "Manager Profile" for a cafeteria
   * manager, "Admin Profile" for a system administrator.
   */
  function applyRoleLabels() {
    let role = '';
    try {
      if (window.ScosRoles && typeof window.ScosRoles.getCurrentRole === 'function') {
        role = window.ScosRoles.getCurrentRole();
      }
    } catch (e) { /* ignore */ }
    if (!role) {
      role = String(localStorage.getItem('userRole') || localStorage.getItem('role') || '').toLowerCase();
    }
    const isManager = role === 'manager';
    const title = document.getElementById('profilePageTitle');
    if (title) {
      title.textContent = isManager ? 'Manager Profile' : 'Admin Profile';
      title.setAttribute('data-i18n', isManager ? 'manager_profile_title' : 'admin_profile_title');
    }
    document.title = isManager ? 'Manager Profile - Smart Cafeteria' : 'Admin Profile - Smart Cafeteria';
    if (typeof window.applyTranslations === 'function') {
      setTimeout(() => window.applyTranslations(), 0);
    }
  }

  /**
   * Load the OWN profile from the backend.
   *
   * It used to be read from localStorage only, which meant the page could
   * show a stale name/email/avatar after the account had been changed
   * elsewhere (for example in Settings). GET /auth/me always answers with
   * the caller's own account - never anybody else's.
   */
  async function loadProfile() {
    let profile = window.AdminAPI.getProfile();
    try {
      const data = await window.AdminAPI.get('/auth/me');
      if (data && data.user) profile = Object.assign({}, profile || {}, data.user);
    } catch (e) {
      // Fall back to the cached profile so the page still renders.
    }
    if (profile) {
      document.getElementById('profileName').textContent = profile.name || 'Admin User';
      document.getElementById('profileEmail').textContent = profile.email || 'admin@example.com';
      document.getElementById('profileRole').textContent = profile.role || 'ADMIN';
      const avatar = document.getElementById('profileAvatar');
      const avatarNav = document.getElementById('adminAvatar');
      const nameNav = document.getElementById('adminNameDisplay');
      if (avatar) {
        if (profile.avatar) {
          avatar.innerHTML = '<img src="' + profile.avatar + '" alt="Avatar" class="navbar-avatar-img">';
        } else if (profile.name) {
          avatar.textContent = profile.name.charAt(0).toUpperCase();
        }
      }
      if (avatarNav) {
        if (profile.avatar) {
          avatarNav.innerHTML = '<img src="' + profile.avatar + '" alt="Avatar" class="navbar-avatar-img">';
        } else if (profile.name) {
          avatarNav.textContent = profile.name.charAt(0).toUpperCase();
        }
      }
      if (nameNav) nameNav.textContent = profile.name || 'Admin User';

      // Editable fields - the caller's own account only.
      const name = document.getElementById('accountName');
      const email = document.getElementById('accountEmail');
      const phone = document.getElementById('accountPhone');
      const avatarUrl = document.getElementById('accountAvatar');
      const twoFa = document.getElementById('accountTwoFactor');
      if (name) name.value = profile.name || '';
      if (email) email.value = profile.email || '';
      if (phone) phone.value = profile.phone || '';
      if (avatarUrl) avatarUrl.value = profile.avatar || '';
      if (twoFa) twoFa.checked = profile.twoFactorEnabled === true;
    }
  }

  /**
   * Save the caller's own account details.
   * The backend writes only the authenticated user's document.
   */
  async function saveAccount() {
    const btn = document.getElementById('saveAccountBtn');
    const name = document.getElementById('accountName');
    const email = document.getElementById('accountEmail');
    const phone = document.getElementById('accountPhone');
    const avatarUrl = document.getElementById('accountAvatar');
    const twoFa = document.getElementById('accountTwoFactor');
    if (!name || !name.value.trim()) {
      showAlert(tr('all_fields_required', 'All fields are required'), 'error');
      return;
    }
    setLoading(btn, true);
    try {
      const data = await window.AdminAPI.put('/auth/me', {
        name: name.value.trim(),
        email: email ? email.value.trim() : undefined,
        phone: phone ? phone.value.trim() : undefined,
        avatar: avatarUrl ? avatarUrl.value.trim() : undefined,
        twoFactorEnabled: twoFa ? twoFa.checked : undefined,
      });
      const updated = Object.assign({}, window.AdminAPI.getProfile() || {}, (data && data.user) || {});
      localStorage.setItem('userProfile', JSON.stringify(updated));
      try {
        const cur = JSON.parse(localStorage.getItem('current_user') || '{}');
        Object.assign(cur, {
          name: updated.name,
          email: updated.email,
          phone: updated.phone,
          avatar: updated.avatar,
        });
        localStorage.setItem('current_user', JSON.stringify(cur));
        localStorage.setItem('userName', updated.name || '');
      } catch (_) {}
      showAlert(tr('profile_saved', 'Profile saved successfully'));
      await loadProfile();
    } catch (error) {
      showAlert(tr('failed_save_profile', 'Failed to save profile: ') + (error.message || error), 'error');
    } finally {
      setLoading(btn, false);
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    const btn = document.getElementById('changePasswordBtn');
    const current = document.getElementById('currentPassword').value;
    const newPass = document.getElementById('newPassword').value;
    const confirm = document.getElementById('confirmPassword').value;

    if (!current || !newPass || !confirm) {
      showAlert(tr('all_fields_required', 'All fields are required'), 'error');
      return;
    }
    if (newPass.length < 6) {
      showAlert(tr('password_min_length', 'New password must be at least 6 characters'), 'error');
      return;
    }
    if (newPass !== confirm) {
      showAlert(tr('password_mismatch', 'Passwords do not match'), 'error');
      return;
    }

    setLoading(btn, true);
    try {
      const data = await window.AdminAPI.put('/admin/password', { currentPassword: current, newPassword: newPass, confirmPassword: confirm });
      // Store the new token returned by backend after password change
      if (data.token) {
        localStorage.setItem('auth_token', data.token);
      }
      showAlert(tr('password_updated', 'Password updated successfully. Please sign out and sign back in with your new password.'));
      document.getElementById('passwordForm').reset();
    } catch (error) {
      showAlert(tr('failed_update_password', 'Failed to update password: ') + (error.message || error), 'error');
    } finally {
      setLoading(btn, false);
    }
  }

  function bindEvents() {
    const form = document.getElementById('passwordForm');
    if (form) form.addEventListener('submit', changePassword);

    const saveBtn = document.getElementById('saveAccountBtn');
    if (saveBtn) saveBtn.addEventListener('click', saveAccount);

    // Password show/hide toggle
    document.querySelectorAll('.toggle-password-icon').forEach(function (icon) {
      icon.addEventListener('click', function () {
        const targetId = icon.getAttribute('data-target');
        const input = document.getElementById(targetId);
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        icon.classList.toggle('fa-eye', !isPassword);
        icon.classList.toggle('fa-eye-slash', isPassword);
        icon.title = isPassword ? tr('hide_password', 'Hide password') : tr('show_password', 'Show password');
      });
    });
  }

  function init() {
    bindEvents();
    applyRoleLabels();
    loadProfile();
  }

  document.addEventListener('DOMContentLoaded', init);
})();