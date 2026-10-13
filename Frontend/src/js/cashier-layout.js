function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
function __registerLangChange(fn) {
  var reg = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
  if (typeof reg === 'function') reg(fn);
  window.addEventListener('language:changed', fn);
  window.addEventListener('languageChanged', fn);
}

/**
 * ==========================================================================
   SMART CAFETERIA CASHIER — SHARED LAYOUT MODULE
   ==========================================================================
   Provides the common sidebar + top nav bar for all cashier pages and a
   minimal API wrapper (window.CashierAPI) shared by cashier page scripts.
   Load this BEFORE page-specific cashier scripts.

   Sidebar sections:
     CASHIER:    Dashboard, Orders, Payments, Sales, Receipts

   window.CashierAPI mirrors the admin helper surface (get/post/patch/...),
   but without the ADMIN-only bootstrap redirect so cashier roles are allowed.
   ========================================================================== */
(function () {
  'use strict';

  // Ensure the shared role helpers exist before access checks run below.
  if (!window.ScosRoles) {
    document.write('<script src="../../js/roles.js"><\/script>');
  }

  var CASHIER_PAGES = [
    { id: 'dashboard', path: 'dashboard.html', icon: 'fa-chart-line', label: 'Dashboard', group: 'cashier' },
    { id: 'orders', path: 'orders.html', icon: 'fa-receipt', label: 'Orders', group: 'cashier' },
    { id: 'payments', path: 'payments.html', icon: 'fa-wallet', label: 'Payments', group: 'cashier' },
    { id: 'sales', path: 'sales.html', icon: 'fa-chart-column', label: 'Sales', group: 'cashier' },
    { id: 'receipts', path: 'receipts.html', icon: 'fa-file-invoice', label: 'Receipts', group: 'cashier' }
  ];

  var SIDEBAR_GROUPS = [
    { id: 'cashier', label: 'CASHIER', labelKey: 'cashier_group', pages: ['dashboard', 'orders', 'payments', 'sales', 'receipts'] }
  ];

  var LABEL_KEYS = {
    dashboard: 'cashier_dashboard_nav',
    orders: 'cashier_orders',
    payments: 'cashier_payments',
    sales: 'cashier_sales',
    receipts: 'cashier_receipts'
  };

  // Ensure cashier role is consistently detected from localStorage
  function getCashierRole() {
    var userRole = (localStorage.getItem('userRole') || '').toLowerCase();
    var role = (localStorage.getItem('role') || '').toLowerCase();
    return { userRole, role };
  }

  // Current page detection
  function getCurrentPageId() {
    var path = window.location.pathname.split('/').pop().replace('.html', '');
    return path || 'dashboard';
  }

  // Translate helper (falls back to English label)
  function t(key, fallback) {
    try {
      var v = (window.t || window.getText) && (window.t || window.getText)(key);
      if (v && v !== key) return v;
    } catch (e) {}
    return fallback;
  }

  // Render sidebar navigation
  function renderSidebar(currentPageId) {
    var sidebar = document.getElementById('cashierSidebar');
    if (!sidebar) return;

    var brandText = t('cashier_brand', 'Smart Cafeteria');
    var html = '';

    // Brand block (top of sidebar)
    html += '<div class="sidebar-brand" style="display:flex;align-items:center;gap:10px;padding:18px 20px;font-weight:700;color:#0f172a;border-bottom:1px solid #e2e8f0;">'
      + '<i class="fa-solid fa-cash-register" style="font-size:1.3rem;color:#2563eb;"></i>'
      + '<span data-i18n="cashier_brand">' + brandText + '</span>'
      + '</div>';

    html += '<nav class="sidebar-nav">';
    SIDEBAR_GROUPS.forEach(function (group) {
      var groupTitle = t(group.labelKey, group.label);
      html += '<div class="sidebar-group">';
      html += '<div class="sidebar-group-title" data-i18n="' + group.labelKey + '">' + groupTitle + '</div>';
      group.pages.forEach(function (pageId) {
        var page = CASHIER_PAGES.find(function (p) { return p.id === pageId; });
        if (!page) return;
        var isActive = pageId === currentPageId;
        html += '<a href="' + page.path + '" class="sidebar-link' + (isActive ? ' active' : '') + '">'
          + '<i class="fa-solid ' + page.icon + '"></i>'
          + '<span data-i18n="' + (LABEL_KEYS[pageId] || pageId) + '">' + t(LABEL_KEYS[pageId] || pageId, page.label) + '</span>'
          + '</a>';
      });
      html += '</div>';
    });
    html += '</nav>';

    sidebar.innerHTML = html;
  }

  // Ensure theme + i18n helpers are available
  function ensureThemeLoaded() {
    if (document.querySelector('script[src*="theme.js"]')) return;
    var s = document.createElement('script');
    s.src = '../../js/theme.js';
    document.head.appendChild(s);
  }

  function ensureDarkThemeCssLoaded() {
    if (document.querySelector('link[href*="dark-theme.css"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '../../css/themes/dark-theme.css';
    document.head.appendChild(l);
  }

  // Ensure the shared idle-session (auto-logout) module is loaded
  function ensureSessionLoaded() {
    if (!document.querySelector('script[src*="session-timeout.js"]')) {
      var s = document.createElement('script');
      s.src = '../../js/session-timeout.js';
      document.head.appendChild(s);
    }
    if (!document.querySelector('script[src*="notification-sound.js"]')) {
      var n = document.createElement('script');
      n.src = '../../js/notification-sound.js';
      document.head.appendChild(n);
    }
  }

  // Refresh the unread notification badge on the bell button
  function refreshNotificationBadge() {
    var badge = document.getElementById('notifBadge');
    if (!badge) return;
    var token = localStorage.getItem('auth_token');
    if (!token) { badge.textContent = ''; badge.style.display = 'none'; return; }
    fetch((API_BASE || '') + '/notifications/unread', {
      headers: { Authorization: 'Bearer ' + token }
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var count = data && data.count ? Number(data.count) : 0;
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = count > 0 ? 'inline-flex' : 'none';
      })
      .catch(function () { badge.style.display = 'none'; });
  }

  // Render top navbar
  function renderNavbar() {
    var navbar = document.querySelector('.admin-navbar');
    if (!navbar) return;

    var profile = getStoredProfile();
    var avatarLetter = profile && profile.name ? profile.name.charAt(0).toUpperCase() : 'C';
    var avatarHtml = (profile && profile.avatar)
      ? '<img src="' + profile.avatar + '" alt="Avatar" class="navbar-avatar-img">'
      : avatarLetter;
    var staffName = profile && profile.name ? profile.name : 'Cashier';

    var curLang = 'en';
    try { curLang = localStorage.getItem('scos_language') || localStorage.getItem('cafeteria_language') || 'en'; if (curLang !== 'am') curLang = 'en'; } catch (e) {}

    var brandText = t('cashier_brand', 'Smart Cafeteria');
    var brandRoleText = t('cashier_brand_cashier', 'Cashier');
    var roleText = t('cashier_role', 'Cashier Staff');
    var logoutText = t('cashier_logout', 'Logout');
    var notifText = t('cashier_notifications', 'Notifications');

    navbar.innerHTML = ''
      + '<div class="nav-left">'
      + '  <button id="sidebarToggle" class="btn-icon" aria-label="Toggle Sidebar"><i class="fa-solid fa-bars"></i></button>'
      + '  <a href="dashboard.html" class="brand-logo"><i class="fa-solid fa-cash-register"></i><span>' + brandText + ' <small>' + brandRoleText + '</small></span></a>'
      + '</div>'
      + '<div class="nav-right">'
      + '  <div class="lang-switcher-widget" style="display:inline-flex;align-items:center;gap:6px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:3px 8px;box-shadow:0 2px 8px rgba(0,0,0,0.08);margin-right:8px;">'
      + '    <i class="fa-solid fa-globe" style="color:#2563eb;font-size:13px;"></i>'
      + '    <select class="scos-lang-select" aria-label="Language Selector" style="background:transparent;color:#0f172a;border:none;font-weight:700;cursor:pointer;font-size:13px;outline:none;min-width:110px;">'
      + '      <option value="en"' + (curLang === 'en' ? ' selected' : '') + '>🇬🇧 English</option>'
      + '      <option value="am"' + (curLang === 'am' ? ' selected' : '') + '>🇪🇹 አማርኛ</option>'
      + '    </select>'
      + '  </div>'
      + '  <button type="button" class="btn-icon notification-btn" id="notificationBtn" title="' + notifText + '">'
      + '    <i class="fa-solid fa-bell"></i><span class="badge-dot" id="notifBadge"></span>'
      + '  </button>'
      + '  <button type="button" class="btn-icon theme-toggle" id="themeToggle" title="' + tr('toggle_theme', 'Toggle Theme') + '">'
      + '    <i class="fa-solid fa-moon"></i>'
      + '  </button>'
      + '  <div class="user-profile-menu">'
      + '    <div class="avatar" id="cashierAvatar">' + avatarHtml + '</div>'
      + '    <div class="user-info">'
      + '      <strong id="cashierNameDisplay">' + staffName + '</strong>'
      + '      <small data-i18n="cashier_role">' + roleText + '</small>'
      + '    </div>'
      + '    <button id="logoutBtn" class="btn-logout-icon" title="' + logoutText + '"><i class="fa-solid fa-right-from-bracket"></i><span data-i18n="cashier_logout">' + logoutText + '</span></button>'
      + '  </div>'
      + '</div>';

    // Bind language switcher - immediate without refresh, persisted in localStorage
    var langSelect = navbar.querySelector('.scos-lang-select');
    if (langSelect) {
      try { langSelect.value = curLang; } catch (e) {}
      if (!langSelect.dataset.i18nBound) {
        langSelect.dataset.i18nBound = '1';
        langSelect.addEventListener('change', function (e) {
          var lang = e.target.value;
          if (window.setLanguage) window.setLanguage(lang);
          else { try { localStorage.setItem('scos_language', lang); localStorage.setItem('cafeteria_language', lang); } catch (_) {} if (window.applyTranslations) window.applyTranslations(); }
        });
      }
    }
    if (window.applyTranslations) setTimeout(function () { window.applyTranslations(); }, 0);

    // Wire theme toggle + sync its icon
    if (window.ScosTheme) {
      try { window.ScosTheme.refresh(); } catch (e) {}
    }

    // Sidebar toggle (collapse on desktop, off-canvas on mobile)
    var sidebarToggle = document.getElementById('sidebarToggle');
    var sidebar = document.getElementById('cashierSidebar');
    if (sidebarToggle && sidebar) {
      sidebarToggle.addEventListener('click', function () {
        if (window.innerWidth > 992) {
          sidebar.classList.toggle('collapsed');
          return;
        }
        sidebar.classList.toggle('open');
        var backdrop = document.querySelector('.sidebar-backdrop');
        if (!backdrop) {
          backdrop = document.createElement('div');
          backdrop.className = 'sidebar-backdrop';
          document.body.appendChild(backdrop);
        }
        backdrop.classList.toggle('open', sidebar.classList.contains('open'));
      });
    }

    // Document-level sidebar helpers — bind only once so language re-renders
    // do not stack duplicate listeners (and null-guard the sidebar nodes).
    if (!window.__scosCashierSidebarDocBound) {
      window.__scosCashierSidebarDocBound = true;
      document.addEventListener('click', function (e) {
        var side = document.getElementById('cashierSidebar');
        var toggle = document.getElementById('sidebarToggle');
        var backdrop = document.querySelector('.sidebar-backdrop');
        if (!side || !toggle || !backdrop || !backdrop.classList.contains('open')) return;
        if (!side.contains(e.target) && !toggle.contains(e.target)) {
          side.classList.remove('open');
          backdrop.classList.remove('open');
        }
      });
      document.addEventListener('click', function (e) {
        var side = document.getElementById('cashierSidebar');
        if (!side) return;
        var link = e.target.closest && e.target.closest('.sidebar-link');
        if (link && window.innerWidth < 992) {
          side.classList.remove('open');
          var backdrop = document.querySelector('.sidebar-backdrop');
          if (backdrop) backdrop.classList.remove('open');
        }
      });
    }

    // Logout handler - clears the whole session then goes to login
    var logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn && !logoutBtn.dataset.logoutBound) {
      logoutBtn.dataset.logoutBound = '1';
      logoutBtn.addEventListener('click', function () {
        if (window.confirm(tr('logout_confirm', 'Are you sure you want to log out?'))) {
          if (window.ScosSession) { window.ScosSession.logout(); return; }
          ['auth_token', 'userRole', 'role', 'userProfile', 'current_user', 'userName', 'name', 'isLoggedIn', 'cashierLoggedIn', 'adminLoggedIn', 'kitchenLoggedIn', 'deliveryLoggedIn', 'customerLoggedIn'].forEach(function (k) {
            localStorage.removeItem(k);
          });
          window.location.href = '../common/login.html';
        }
      });
    }

    // Notification button (placeholder)
    var notifBtn = document.getElementById('notificationBtn');
    if (notifBtn) {
      notifBtn.addEventListener('click', function () {
        if (window.CashierToast) window.CashierToast.info(tr('notifications_soon', 'Notifications coming soon'));
      });
    }

    refreshNotificationBadge();
    window.setInterval(refreshNotificationBadge, 30000);
  }

  // Auth guard + profile population
  function initAuthGuard() {
    var userRole = (localStorage.getItem('userRole') || '').toString().toLowerCase();
    var role = (localStorage.getItem('role') || '').toString().toLowerCase();
    var allowedRoles = ['cashier', 'admin', 'administrator', 'cafeteria_admin', 'cafeteria admin', 'manager'];
    if (!userRole && !role) {
      window.location.href = '../common/login.html';
      return false;
    }
    if (!allowedRoles.includes(userRole) && !allowedRoles.includes(role)) {
      window.location.href = '../common/login.html';
      return false;
    }

    // Page-level access check for cashier pages (mirrors admin-layout)
    if (window.ScosRoles) {
      var canonicalRole = (window.ScosRoles.normalizeRole(userRole || role) || '').toLowerCase();
      if (canonicalRole === 'cashier') {
        var checkPage = getCurrentPageId();
        if (checkPage === 'cashup') checkPage = 'sales';
        var allowedPages = ScosRoles.visiblePages('cashier');
        if (allowedPages.length > 0 && allowedPages.indexOf(checkPage) === -1) {
          window.location.href = 'dashboard.html';
          return false;
        }
      }
    }

    var profile = getStoredProfile();
    if (profile) {
      var nameDisplay = document.getElementById('cashierNameDisplay');
      var avatar = document.getElementById('cashierAvatar');
      if (nameDisplay) nameDisplay.textContent = profile.name || 'Cashier';
      if (avatar) {
        if (profile.avatar) {
          avatar.innerHTML = '<img src="' + profile.avatar + '" alt="Avatar" class="navbar-avatar-img">';
        } else if (profile.name) {
          avatar.textContent = profile.name.charAt(0).toUpperCase();
        }
      }
    }
    return true;
  }

  function getStoredProfile() {
    try {
      var raw = localStorage.getItem('userProfile') || localStorage.getItem('current_user');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  // ==========================================================================
  //  window.CashierAPI — minimal fetch wrapper (mirrors window.AdminAPI)
  //  ==========================================================================
  var API_BASE = window.__API_URL || (window.__API_BASE || 'http://localhost:5000/api/v1');

  function getToken() {
    return localStorage.getItem('auth_token') || '';
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

  function formatDateTime(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function formatCurrency(value, currency) {
    if (value === null || value === undefined) return '0.00';
    var c = currency || 'ETB';
    return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + c;
  }

  function clearAuthAndRedirect() {
    localStorage.removeItem('auth_token');
    showToast(tr('error_session_expired', 'Session expired. Please log in again.'), 'error');
  }

  function request(method, path, body, query) {
    var url = API_BASE + path + (query ? qs(query) : '');
    var init = {
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    var token = getToken();
    if (token) init.headers.Authorization = 'Bearer ' + token;
    if (body !== undefined && body !== null) init.body = JSON.stringify(body);

    return fetch(url, init).then(function (res) {
      return res.json().catch(function () {
        return { success: false, error: tr('error_invalid_response', 'Invalid server response') };
      }).then(function (data) {
        data._status = res.status;
        if (!res.ok) {
          var err = new Error(data.error || data.message || ('Request failed with status ' + res.status));
          err.status = res.status;
          err.data = data;
          if (res.status === 401 || res.status === 403) clearAuthAndRedirect();
          throw err;
        }
        if (!data.success) {
          var err2 = new Error(data.error || data.message || 'Request failed');
          err2.status = data._status;
          err2.data = data;
          throw err2;
        }
        return data;
      });
    });
  }

  function get(path, query) { return request('GET', path, undefined, query); }
  function post(path, body) { return request('POST', path, body); }
  function put(path, body) { return request('PUT', path, body); }
  function patch(path, body) { return request('PATCH', path, body); }
  function del(path) { return request('DELETE', path); }

  function showToast(message, type) {
    var existing = document.querySelector('.toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.className = 'toast ' + (type || 'success');
    toast.innerHTML = '<span class="toast-icon">' + (type === 'error' ? '<i class="fa-solid fa-circle-exclamation"></i>' : type === 'warning' ? '<i class="fa-solid fa-triangle-exclamation"></i>' : '<i class="fa-solid fa-circle-check"></i>') + '</span><span class="toast-message">' + esc(message) + '</span><button class="toast-close" aria-label="Close">&times;</button>';
    document.body.appendChild(toast);
    setTimeout(function () { toast.classList.add('show'); }, 10);
    var closeBtn = toast.querySelector('.toast-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { toast.classList.remove('show'); setTimeout(function () { toast.remove(); }, 300); });
    setTimeout(function () {
      toast.classList.remove('show');
      setTimeout(function () { toast.remove(); }, 300);
    }, 4000);
  }

  window.CashierAPI = {
    base: API_BASE,
    get: get, post: post, put: put, patch: patch, del: del, request: request,
    esc: esc, formatDateTime: formatDateTime, formatCurrency: formatCurrency,
    getToken: getToken
  };
  window.CashierToast = { show: showToast, success: function (m) { showToast(m, 'success'); }, error: function (m) { showToast(m, 'error'); }, warning: function (m) { showToast(m, 'warning'); }, info: function (m) { showToast(m, 'info'); } };
  window.esc = window.esc || esc;

  // Initialize everything on DOM ready
  document.addEventListener('DOMContentLoaded', function () {
    if (!initAuthGuard()) return;

    ensureThemeLoaded();
    ensureDarkThemeCssLoaded();
    ensureSessionLoaded();

    renderNavbar();
    renderSidebar(getCurrentPageId());

    // Re-render layout when the active language changes
    function reRenderOnLangChange() {
      renderNavbar();
      renderSidebar(getCurrentPageId());
    }
    __registerLangChange(reRenderOnLangChange);

    if (typeof initPageSpecific === 'function') {
      initPageSpecific();
    }
  });

  // Expose utilities globally
  window.CashierLayout = {
    renderSidebar: renderSidebar,
    renderNavbar: renderNavbar,
    getCurrentPageId: getCurrentPageId,
    getStoredProfile: getStoredProfile,
    refreshNotificationBadge: refreshNotificationBadge
  };
})();