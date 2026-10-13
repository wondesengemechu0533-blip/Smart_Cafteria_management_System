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
      btn.innerHTML = btn.dataset.originalText || 'Update Password';
      delete btn.dataset.originalText;
    }
  }

  function loadProfile() {
    const profile = window.AdminAPI.getProfile();
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
    loadProfile();
  }

  document.addEventListener('DOMContentLoaded', init);
})();