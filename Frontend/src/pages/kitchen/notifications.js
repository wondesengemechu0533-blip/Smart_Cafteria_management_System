/**
 * Kitchen notification panel bootstrap.
 *
 * The panel itself is implemented once in ../../js/notification-center.js so the
 * kitchen, admin and manager pages cannot drift apart. This file only wires the
 * kitchen page's DOM (filters, toolbar buttons, toast) to that engine.
 *
 * The kitchen new-order alert/toast/banner/repeating-sound system is owned by
 * ./kitchen.js and is intentionally untouched here.
 */
(function (window, document) {
  'use strict';

  function tr(key, fallback) {
    if (typeof window.tr === 'function') return window.tr(key, fallback);
    return fallback;
  }

  function showToast(message) {
    var toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.setTimeout(function () {
      toast.classList.remove('show');
    }, 3000);
  }

  function start() {
    var NC = window.ScosNotifications;
    if (!NC) {
      console.error('notification-center.js failed to load');
      return;
    }

    var panel = NC.mount({
      list: 'notifList',
      empty: 'emptyState',
      filter: 'notifFilterTabs',
      count: 'unreadCount',
      onToast: showToast,
      // Requirement: opening the panel must NOT change read state. Only a click
      // on a single notification marks that one (and only that one) as read.
      markViewedAsRead: false,
      // New kitchen orders arrive over the `notification:new` socket event ...
      realtime: true,
      // ... and a 30s poll is the fallback when a socket frame is missed.
      poll: true,
      pollMs: 30000,
      // Clicking a notification that has an order id opens that kitchen ticket.
      ordersUrl: '/src/pages/kitchen/orders.html',
    });

    // Keep the sidebar badge current even outside the panel.
    window.refreshNotificationBadge = NC.refreshBadge;
    document.addEventListener('notification:refresh', NC.refreshBadge);
    NC.refreshBadge();
    NC.poll(30000);

    // Toolbar
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

    // Filter tabs (delegated so re-renders cannot drop the handlers)
    var tabs = document.getElementById('notifFilterTabs');
    if (tabs) {
      tabs.addEventListener('click', function (e) {
        var tab = e.target.closest('[data-filter]');
        if (!tab || !tabs.contains(tab)) return;
        panel.setFilter(tab.getAttribute('data-filter'));
      });
    }

    // Keep the relative timestamps ("2 min ago") fresh.
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
