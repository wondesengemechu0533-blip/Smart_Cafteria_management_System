function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ==========================================================================
   SMART CAFETERIA ORDERING SYSTEM - ADMIN SHARED HELPER
   ==========================================================================
   Classic (non-module) script shared by all admin pages.
   - window.AdminAPI : minimal fetch wrapper against the backend
   - window.esc      : HTML escaping helper
   - Auto bootstrap for common admin chrome on DOMContentLoaded:
       admin auth guard, sidebar toggle, logout, name/avatar.
 *
 * Load this BEFORE the page-specific admin script, e.g.:
 *   <script src="../../js/admin-api.js"></script>
 *   <script src="/frontend/src/js/admin/users.js"></script>
 * ==========================================================================
 */
(function () {
  'use strict';

  // Ensure the shared role helpers exist before the auth guard runs below.
  if (!window.ScosRoles) {
    document.write('<script src="../../js/roles.js"><\/script>');
  }

  var API_BASE = window.__API_URL;

  function getToken() {
    return localStorage.getItem('auth_token') || '';
  }

  function getProfile() {
    try {
      var p = JSON.parse(localStorage.getItem('userProfile') || 'null');
      return p;
    } catch (e) {
      return null;
    }
  }

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function qs(map) {
    var parts = [];
    for (var key in map) {
      if (map[key] !== undefined && map[key] !== null && map[key] !== '') {
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(map[key]));
      }
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  function formatDate(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatDateTime(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatCurrency(value, currency) {
    if (value === null || value === undefined) return '0.00';
    var c = currency || 'ETB';
    return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + c;
  }

  function localize(msg, code) {
    try {
      if (typeof window.translateErrorMessage === 'function') {
        return window.translateErrorMessage(msg, code);
      }
      if (typeof window.getText === 'function') {
        // Known status/error keys pass through; unknown text returned as-is.
        const asKey = window.getText(msg);
        if (asKey && asKey !== msg) return asKey;
      }
    } catch (e) {}
    return msg;
  }

  function handleErrorStatus(status, data) {
    var message = data?.error || data?.message || (typeof tr==='function'?tr('request_failed','Request failed'):'Request failed');
    var code = data?.code || data?.errorCode;
    switch (status) {
      case 401:
        message = localize('error_session_expired') || 'Session expired. Please log in again.';
        clearAuthAndRedirect();
        break;
      case 403:
        message = localize('error_access_denied') || 'Access denied. Insufficient permissions.';
        clearAuthAndRedirect();
        break;
      case 404:
        message = localize(message, code);
        break;
      case 422:
        message = localize(message, code);
        break;
      case 429:
        message = localize('error_too_many_requests') || 'Too many requests. Please wait and try again.';
        break;
      case 500:
        message = localize('error_server') || 'Server error. Please try again later.';
        break;
      default:
        message = localize(message, code);
        if (status >= 500) message = localize('error_server') || 'Server error. Please try again later.';
    }
    return message;
  }

  function clearAuthAndRedirect() {
    // Only drop the API token; keep the local admin/customer session so the
    // page does not unexpectedly bounce back to the login screen when the
    // backend rejects/refuses a data request (e.g. 401/403).
    localStorage.removeItem('auth_token');
    try {
      var toast = document.querySelector('.toast');
      if (toast) toast.remove();
    } catch (e) {}
    var sessionMsg = localize('error_session_expired') || 'Session expired. Please log in again.';
    var toastEl = document.createElement('div');
    toastEl.className = 'toast error';
    toastEl.innerHTML =
      '<span class="toast-icon"><i class="fa-solid fa-circle-exclamation"></i></span><span class="toast-message">' + esc(sessionMsg) + '</span><button class="toast-close" aria-label="Close">&times;</button>';
    document.body.appendChild(toastEl);
    setTimeout(function () {
      if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    }, 4000);
  }

  function request(method, path, body, query) {
    var url = API_BASE + path + (query ? qs(query) : '');
    var init = {
      method: method,
      headers: { 'Content-Type': 'application/json' },
    };
    var token = getToken();
    if (token) init.headers.Authorization = 'Bearer ' + token;
    if (body !== undefined && body !== null) init.body = JSON.stringify(body);

    return fetch(url, init).then(function (res) {
      return res
        .json()
        .catch(function () {
          return { success: false, error: localize('error_invalid_response') || 'Invalid server response' };
        })
        .then(function (data) {
          data._status = res.status;
          if (!res.ok) {
            var raw = data.error || data.message || (typeof tr==='function'?tr('request_failed','Request failed'):'Request failed');
            var status = res.status;
            var errorMessage = handleErrorStatus(res.status, data) || localize(raw, data.code);
            var err = new Error(errorMessage);
            err.status = status;
            err.data = data;
            err.rawMessage = raw;
            // If session expired (401), clear invalid token and redirect to login
            if (status === 401) {
              try {
                localStorage.removeItem('auth_token');
                localStorage.removeItem('userRole');
                localStorage.removeItem('role');
                localStorage.removeItem('userProfile');
                localStorage.removeItem('current_user');
                localStorage.removeItem('isLoggedIn');
                localStorage.removeItem('adminLoggedIn');
                localStorage.removeItem('name');
                localStorage.removeItem('userName');
              } catch (e) {}
              window.location.href = '../../pages/common/login.html';
            }
            throw err;
          }
          if (!data.success) {
            var rawFail = data.error || data.message || (typeof tr==='function'?tr('request_failed','Request failed'):'Request failed');
            var errFail = new Error(localize(rawFail, data.code));
            errFail.status = data._status;
            errFail.data = data;
            errFail.rawMessage = rawFail;
            throw errFail;
          }
          return data;
        });
    });
  }

  function get(path, query) {
    return request('GET', path, undefined, query);
  }
  function post(path, body) {
    return request('POST', path, body);
  }
  function put(path, body) {
    return request('PUT', path, body);
  }
  function patch(path, body) {
    return request('PATCH', path, body);
  }
  function del(path) {
    return request('DELETE', path);
  }

  window.AdminAPI = {
    base: API_BASE,
    get: get,
    post: post,
    put: put,
    patch: patch,
    del: del,
    request: request,
    esc: esc,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    formatCurrency: formatCurrency,
    getToken: getToken,
    getProfile: getProfile,
    qs: qs,
  };
  window.esc = esc;

  function showToast(message, type) {
    var existing = document.querySelector('.toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.className = 'toast ' + (type || 'success');
    toast.innerHTML =
      '<span class="toast-icon">' +
      (type === 'error'
        ? '<i class="fa-solid fa-circle-exclamation"></i>'
        : type === 'warning'
          ? '<i class="fa-solid fa-triangle-exclamation"></i>'
          : '<i class="fa-solid fa-circle-check"></i>') +
      '</span><span class="toast-message">' +
      esc(message) +
      '</span><button class="toast-close" aria-label="Close">&times;</button>';
    document.body.appendChild(toast);
    setTimeout(function () {
      toast.classList.add('show');
    }, 10);
    var closeBtn = toast.querySelector('.toast-close');
    if (closeBtn)
      closeBtn.addEventListener('click', function () {
        toast.classList.remove('show');
        setTimeout(function () {
          toast.remove();
        }, 300);
      });
    setTimeout(function () {
      toast.classList.remove('show');
      setTimeout(function () {
        toast.remove();
      }, 300);
    }, 4000);
  }

  window.AdminToast = {
    show: showToast,
    success: function (m) {
      showToast(m, 'success');
    },
    error: function (m) {
      showToast(m, 'error');
    },
    warning: function (m) {
      showToast(m, 'warning');
    },
    info: function (m) {
      showToast(m, 'info');
    },
  };
  window.esc = esc;

  document.addEventListener('DOMContentLoaded', function () {
    // Permit any staff role (system admin, cafeteria admin, manager) to reach
    // admin-chrome pages. Backend route guards still enforce per-role access.
    var role = String(localStorage.getItem('userRole') || localStorage.getItem('role') || '');
    var normalized = (window.ScosRoles ? ScosRoles.normalizeRole(role) : '') || role;
    if (!(window.ScosRoles ? ScosRoles.isStaff(normalized) : normalized !== 'CUSTOMER' && normalized !== '')) {
      window.location.href = '../../pages/common/login.html';
      return;
    }

    var profile = getProfile();
    var nameDisplay = document.getElementById('adminNameDisplay');
    var avatar = document.getElementById('adminAvatar');
    if (profile) {
      if (nameDisplay) nameDisplay.textContent = profile.name || 'Admin';
      if (avatar) {
        if (profile.avatar) {
          avatar.innerHTML = '<img src="' + profile.avatar + '" alt="Avatar" class="navbar-avatar-img">';
        } else if (profile.name) {
          avatar.textContent = profile.name.charAt(0).toUpperCase();
        }
      }
    } else {
      if (nameDisplay) nameDisplay.textContent = (typeof tr==='function'?tr('nav_admin','Admin'):'Admin');
    }
  });
})();
