/**
 * Admin / manager notification panel bootstrap.
 *
 * The panel engine lives in ../../js/notification-center.js and is shared with
 * the kitchen page; this file only wires this page's toolbar, filters and
 * order deep-links.
 */
(function (window, document) {
  'use strict';

  function tr(key, fallback) {
    if (typeof window.tr === 'function') return window.tr(key, fallback);
    return fallback;
  }

  function toast(message) {
    if (typeof window.AdminToast === 'function' && window.AdminToast.success) {
      window.AdminToast.success(message);
      return;
    }
    if (window.AdminToast && typeof window.AdminToast.info === 'function') {
      window.AdminToast.info(message);
    }
  }

  function start() {
    var NC = window.ScosNotifications;
    if (!NC) {
      // admin-layout.js loads notification-center.js asynchronously (so it can
      // reuse the shared socket) — wait for it instead of bailing out.
      var wait =
        window.AdminLayout && typeof window.AdminLayout.whenNotificationCentreReady === 'function'
          ? window.AdminLayout.whenNotificationCentreReady
          : null;
      if (wait) {
        wait(start);
        return;
      }
      console.error('notification-center.js failed to load');
      return;
    }

    var panel = NC.mount({
      list: 'notifList',
      empty: 'emptyState',
      filter: 'notifFilterTabs',
      count: 'unreadCount',
      onToast: toast,
      // Opening the panel never changes read state; only clicking a single
      // notification marks that one as read.
      markViewedAsRead: false,
      realtime: true,
      poll: true,
      pollMs: 30000,
      ordersUrl: '/src/pages/kitchen/orders.html',
      onOpen: function (id) {
        var item = null;
        for (var i = 0; i < panel.items.length; i += 1) {
          if (panel.items[i].id === id) item = panel.items[i];
        }
        if (!item) return;
        // Always stay inside the admin/manager app. The stored `link` is built by
        // the backend for the kitchen surface, so it must not be followed here.
        var base = window.AdminLayout && typeof window.AdminLayout.getAdminBase === 'function'
          ? window.AdminLayout.getAdminBase()
          : '';
        var ordersUrl = base ? base + 'orders.html' : '/src/pages/admin/orders.html';
        window.location.href = item.orderId
          ? ordersUrl + '?orderId=' + encodeURIComponent(item.orderId)
          : ordersUrl;
      },
    });

    var markAllBtn = document.getElementById('markAllBtn');
    if (markAllBtn) {
      markAllBtn.addEventListener('click', function () {
        panel.markAllRead();
      });
    }

    var clearAllBtn = document.getElementById('clearAllBtn');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', function () {
        if (!window.confirm(tr('notif_clear_confirm', 'Clear all notifications?'))) return;
        panel.clearAll();
      });
    }

    var tabs = document.getElementById('notifFilterTabs');
    if (tabs) {
      tabs.addEventListener('click', function (e) {
        var tab = e.target.closest('[data-filter]');
        if (!tab || !tabs.contains(tab)) return;
        panel.setFilter(tab.getAttribute('data-filter'));
      });
    }

    // Keep relative timestamps fresh.
    window.setInterval(function () {
      panel.render();
    }, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window, document);
