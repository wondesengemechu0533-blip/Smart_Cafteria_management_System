var tr = (typeof window.getText === "function" && typeof window.tr === "function")
  ? window.tr
  : function trFallback(key, fallback, vars) {
      if (typeof window.getText === "function" && typeof window.tr === "function" && window.tr !== trFallback) {
        return window.tr(key, fallback, vars);
      }
      return fallback;
    };
/**
 * ==========================================================================
   SMART CAFETERIA ORDERING SYSTEM - SESSION TIMEOUT / IDLE LOGOUT
   ==========================================================================
   Classic (non-module) script for staff pages.
   - Auto-logs staff members out after N minutes of inactivity (default 10).
   - Shows a 60-second warning before logging out.
   - Parses SESSION_IDLE_TIMEOUT_MINUTES (backend) via /admin/settings for
     admin / cafeteria_admin roles; everyone else uses the default.
   - Provides window.ScosSession.logout() used by layout logout buttons and
     session expiry handling.

   Load AFTER roles.js (or let it auto-inject):
     <script src="../../js/roles.js"></script>
     <script src="../../js/session-timeout.js"></script>
   ========================================================================== */
(function (global) {
  'use strict';

  var IDLE_WARNING_MS = 60 * 1000;
  var DEFAULT_IDLE_MS = 10 * 60 * 1000;
  var storageKey = 'scos_session_idle_minutes';

  function readMinutes() {
    try {
      var m = parseInt(localStorage.getItem(storageKey) || '0', 10);
      if (m > 0 && m <= 240) return m;
    } catch (e) { /* ignore */ }
    return 10;
  }

  function isStaff() {
    var role = String(localStorage.getItem('userRole') || localStorage.getItem('role') || '');
    if (window.ScosRoles) return ScosRoles.isStaff(role);
    var upper = role.toUpperCase();
    return upper === 'ADMIN' || upper === 'CAFETERIA_ADMIN' || upper === 'MANAGER' ||
      upper === 'CASHIER' || upper === 'KITCHEN_STAFF' || upper === 'DELIVERY_STAFF' ||
      upper === 'TAX_AUTHORITY';
  }

  var idleMs = DEFAULT_IDLE_MS;
  var idleTimer = null;
  var warnTimer = null;
  var warningEl = null;
  var secondsLeft = 60;
  var lastActivity = Date.now();
  var started = false;

  function clearTimers() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (warnTimer) { clearTimeout(warnTimer); warnTimer = null; }
  }

  function removeWarning() {
    if (warningEl) { warningEl.remove(); warningEl = null; }
  }

  function doLogout(expired) {
    clearTimers();
    removeWarning();
    try {
      var token = localStorage.getItem('auth_token');
      if (token) {
        fetch((window.__API_URL || 'http://localhost:5000/api/v1') + '/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
        }).catch(function () { /* backend may be down; local logout still proceeds */ });
      }
    } catch (e) { /* ignore */ }

    var keys = ['auth_token', 'userRole', 'role', 'userProfile', 'current_user', 'isLoggedIn',
      'userName', 'name', 'adminLoggedIn', 'cafeteriaAdminLoggedIn', 'managerLoggedIn',
      'kitchenLoggedIn', 'deliveryLoggedIn', 'cashierLoggedIn', 'customerLoggedIn',
      'taxAuthorityLoggedIn', 'redirect_after_auth'];
    keys.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });

    var url = '../../pages/common/login.html';
    if (global.location) {
      var curPath = (global.location.pathname || '').replace(/\/[^/]*$/, '/');
      if (curPath.indexOf('/admin/') !== -1 || curPath.indexOf('/cashier/') !== -1 ||
          curPath.indexOf('/delivery/') !== -1 || curPath.indexOf('/kitchen/') !== -1 ||
          curPath.indexOf('/manager/') !== -1 || curPath.indexOf('/government/') !== -1) {
        url = '../../pages/common/login.html';
      }
    }
    if (expired) {
      try { sessionStorage.setItem('scos_session_expired', '1'); } catch (e) { /* ignore */ }
    }
    global.location.href = url;
  }

  function showWarning() {
    secondsLeft = Math.max(1, Math.round(IDLE_WARNING_MS / 1000));
    removeWarning();
    var overlay = document.createElement('div');
    overlay.className = 'session-warning-overlay';
    var perMinute = Math.max(1, Math.round(idleMs / 60000));
    overlay.innerHTML =
      '<div class="session-warning-card">' +
      '  <div class="session-warning-icon"><i class="fa-solid fa-hourglass-half"></i></div>' +
      '  <h3>' + tr('session_timeout', 'Session timeout') + '</h3>' +
      '  <p>' + tr('session_inactive_minutes', 'You have been inactive for {minutes} minutes. Logging out in {seconds}s...').replace('{minutes}', perMinute).replace('{seconds}', '<strong id="scosIdleCountdown">' + secondsLeft + '</strong>') + '</p>' +
      '  <div class="session-warning-actions">' +
      '    <button id="scosIdleStay" class="btn btn-primary">' + tr('session_stay_signed_in', 'Stay signed in') + '</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(overlay);
    warningEl = overlay;

    var stayBtn = overlay.querySelector('#scosIdleStay');
    if (stayBtn) stayBtn.addEventListener('click', touch);

    warnTimer = setInterval(function () {
      secondsLeft -= 1;
      var el = overlay.querySelector('#scosIdleCountdown');
      if (el) el.textContent = String(secondsLeft);
      if (secondsLeft <= 0) {
        clearInterval(warnTimer);
        doLogout(true);
      }
    }, 1000);
  }

  function startIdleTimer() {
    clearTimers();
    idleTimer = setTimeout(function () {
      if (!document.hidden) {
        showWarning();
      } else {
        // Tab was hidden: count as idle when it regains focus.
        var onVisible = function () {
          document.removeEventListener('visibilitychange', onVisible);
          showWarning();
        };
        document.addEventListener('visibilitychange', onVisible);
      }
    }, idleMs);
  }

  function touch() {
    lastActivity = Date.now();
    removeWarning();
    if (warnTimer) { clearInterval(warnTimer); warnTimer = null; }
    startIdleTimer();
  }

  function tryLoadSetting() {
    // The idle-session window is a SYSTEM-WIDE policy (Setting
    // `session_timeout_minutes`), enforced server-side for every staff role by
    // middleware/idleSession.middleware.js. The UI countdown has to follow the
    // same value, otherwise a Cafeteria Manager would be signed out by the UI
    // after the hard-coded 10 minutes while the policy says 30.
    //
    // It is read from the public settings endpoint (the value is a policy, not
    // a secret) so it applies to every staff role - the old version fetched
    // /admin/settings and only for ADMIN / CAFETERIA_ADMIN, which meant the
    // manager never received the configured timeout at all.
    var token = localStorage.getItem('auth_token');
    fetch((window.__API_URL || 'http://localhost:5000/api/v1') + '/settings/public', {
      headers: token ? { 'Authorization': 'Bearer ' + token } : {}
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (data) {
        var found = null;
        var settings = (data && data.settings) || {};
        if (typeof settings.sessionTimeoutMinutes === 'number') {
          found = { value: settings.sessionTimeoutMinutes };
        } else {
          var arr = Array.isArray(data) ? data : (data.data || data.settings || []);
          if (Array.isArray(arr)) {
            found = arr.find(function (s) { return s.key === 'session_timeout_minutes'; });
          }
        }
        if (found && found.value) {
          var m = parseInt(found.value, 10);
          if (m > 0 && m <= 240) {
            try { localStorage.setItem(storageKey, String(m)); } catch (e) { /* ignore */ }
            idleMs = m * 60 * 1000;
            startIdleTimer();
          }
        }
      }).catch(function () { /* keep the default when the policy cannot be read */ });
  }

  function init() {
    if (started) return;
    if (!isStaff()) return;
    idleMs = readMinutes() * 60 * 1000;

    var events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach(function (evt) {
      document.addEventListener(evt, touch, { passive: true });
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() - lastActivity > idleMs) showWarning();
    });

    startIdleTimer();
    tryLoadSetting();
  }

  function forceLogout() {
    doLogout(false);
  }

  global.ScosSession = {
    logout: forceLogout,
    touch: touch,
    start: init,
    active: false
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);