/**
 * Kitchen sidebar unread-notification badge.
 *
 * Injects a count bubble into every sidebar "Notifications" link and keeps it
 * current from the existing /notifications/unread endpoint. It reuses the
 * shared notification centre (no second API implementation) and only needs
 * `config.js` to be loaded first.
 *
 * Classic script — add to any kitchen page that shows the sidebar:
 *   <script src="../../js/kitchen-notification-badge.js"></script>
 */
(function (window, document) {
  'use strict';

  var POLL_MS = 30000;
  var injected = false;

  function ensureNotificationCentre(callback) {
    if (window.ScosNotifications) {
      callback();
      return;
    }
    if (document.querySelector('script[data-scos-notification-center]')) {
      window.addEventListener('scos:notification-centre:ready', callback, { once: true });
      return;
    }
    var s = document.createElement('script');
    s.src = '../../js/notification-center.js?v=20261013b';
    s.setAttribute('data-scos-notification-center', '1');
    s.onload = function () {
      window.dispatchEvent(new CustomEvent('scos:notification-centre:ready'));
      callback();
    };
    s.onerror = function () {
      console.error('kitchen-notification-badge: notification-center.js failed to load');
    };
    document.head.appendChild(s);
  }

  function injectBadges() {
    if (injected) return;
    injected = true;
    var links = document.querySelectorAll('a.sidebar-link[href*="notifications.html"]');
    Array.prototype.forEach.call(links, function (link) {
      if (link.querySelector('[data-notif-badge]')) return;
      var badge = document.createElement('span');
      badge.className = 'notif-sidebar-badge';
      badge.setAttribute('data-notif-badge', '');
      badge.setAttribute('aria-label', 'Unread notifications');
      badge.style.cssText =
        'margin-left:auto;background:#ef4444;color:#fff;font-size:0.7rem;padding:2px 7px;' +
        'border-radius:10px;font-weight:700;display:none;';
      link.appendChild(badge);
    });
  }

  function start() {
    injectBadges();
    ensureNotificationCentre(function () {
      var NC = window.ScosNotifications;
      // A global hook other kitchen scripts (issues.js, stock-alerts.js) call.
      window.refreshNotificationBadge = NC.refreshBadge;
      document.addEventListener('notification:refresh', NC.refreshBadge);
      NC.refreshBadge();
      NC.poll(POLL_MS);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window, document);
