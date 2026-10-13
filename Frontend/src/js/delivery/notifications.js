/**
 * ==========================================================================
 *   DELIVERY STAFF — NOTIFICATIONS PAGE BOOTSTRAP
 * ==========================================================================
 * The panel engine is the shared `js/notification-center.js` (the same one the
 * Kitchen and Admin notification pages mount), so notifications are persisted,
 * acknowledged and broadcast exactly once for every panel in the system. This
 * file only wires this page's DOM to it.
 *
 * Behaviour required of this page:
 *   - Rows come from GET /notifications (MongoDB), never from local state.
 *   - The unread count and the navbar bell stay in sync (badge + polling).
 *   - New notifications arrive over `notification:new`; js/socket.js owns the
 *     chime, so the sound is the user's configured notification sound.
 *   - Opening the page NEVER marks anything read: only clicking one
 *     notification acknowledges that single row.
 * ==========================================================================
 */
(function (window, document) {
  'use strict';

  function tr(key, fallback, vars) {
    var s = '';
    try {
      if (typeof window.tr === 'function') s = window.tr(key, fallback);
    } catch (e) {}
    if (!s || s === key) s = fallback || key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.split('{' + k + '}').join(String(vars[k]));
      });
    }
    return s;
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

  /**
   * Delivery-specific filter groups.
   *
   * The category is read from the notification's REAL backend `type`, never from
   * its title or message. Every delivery notification used to be filed under the
   * generic `status_update`, which made an assignment notice and a "picked up"
   * notice indistinguishable, so these tabs could only be driven by ad-hoc
   * `meta` tags - and any row written without them was uncategorisable, leaving
   * "Assignments" and "Status Updates" empty while the rows sat under "All".
   * The backend now emits `delivery_assigned` / `delivery_status` /
   * `delivery_issue`, and that type is the primary signal.
   *
   * The `meta` checks are kept deliberately as a FALLBACK: rows created before
   * the new types existed still carry `assignment` / `deliveryStatus` / `orderType`,
   * so historical notifications keep appearing in the right tab instead of
   * silently vanishing from every tab but "All". This is a tag read, never a
   * substring search on human-readable text.
   */
  var ASSIGNMENT_TYPES = ['delivery_assigned', 'assignment'];
  var STATUS_TYPES = ['delivery_status', 'status_update', 'delivery_pickup', 'delivery_completed'];
  var PROBLEM_TYPES = ['delivery_issue'];
  var TERMINAL_FAILURES = ['FAILED', 'CANCELLED'];

  function upper(value) {
    return String(value == null ? '' : value).toUpperCase();
  }

  function matchFilter(filter, n) {
    switch (filter) {
      case 'all':
        return true;
      case 'unread':
        return !n.isRead;
      case 'assignments':
        return ASSIGNMENT_TYPES.indexOf(n.type) !== -1 ||
          n.assignment === true || n.unassigned === true;
      case 'updates':
        // A failure/cancellation is a problem, not a routine status step, so it
        // belongs in "Problems" only - never in both.
        if (n.failureReason) return false;
        if (STATUS_TYPES.indexOf(n.type) !== -1 && !PROBLEM_TYPES.indexOf(n.type)) {
          return !!n.deliveryStatus || n.type !== 'status_update';
        }
        return !!n.deliveryStatus;
      case 'problems':
        return PROBLEM_TYPES.indexOf(n.type) !== -1 ||
          !!n.failureReason ||
          (!!n.deliveryStatus && TERMINAL_FAILURES.indexOf(upper(n.deliveryStatus)) !== -1);
      default:
        return true;
    }
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
      matchFilter: matchFilter,
      // Name the empty state per filter: an empty "Unread" tab has to say so, or
      // it reads as a broken filter rather than a genuinely clean inbox.
      emptyMessages: {
        unread: tr('delivery_notif_empty_unread', 'No unread notifications'),
        assignments: tr('delivery_notif_empty_assignments', 'No delivery assignments yet'),
        updates: tr('delivery_notif_empty_updates', 'No delivery status updates yet'),
        problems: tr('delivery_notif_empty_problems', 'No delivery problems reported'),
      },
      // Opening this page must NOT change read state. Only a click on a single
      // notification marks that one (and only that one) as read.
      markViewedAsRead: false,
      // Realtime first (the shared socket in js/socket.js, which also plays the
      // configured notification sound), with a 30s poll as the safety net.
      realtime: true,
      poll: true,
      pollMs: 30000,
      // Clicking a notification opens the delivery it refers to.
      ordersUrl: 'deliveries.html'
    });

    // The sidebar bell badge lives in delivery-layout.js; keep it current.
    window.refreshNotificationBadge = NC.refreshBadge;
    document.addEventListener('notification:refresh', NC.refreshBadge);
    NC.refreshBadge();

    var markAllBtn = document.getElementById('markAllBtn');
    if (markAllBtn) {
      markAllBtn.addEventListener('click', function () {
        panel.markAllRead();
      });
    }

    var clearAllBtn = document.getElementById('clearAllBtn');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', function () {
        // Deleting is irreversible, so it must only happen when the rider
        // actually confirms - cancelling must leave the list untouched.
        if (!window.confirm(tr('delivery_clear_notifications_confirm', 'Are you sure you want to clear all notifications?'))) return;
        panel.clearAll();
      });
    }

    // Filter tabs (delegated so re-renders cannot drop the handlers).
    var tabs = document.getElementById('notifFilterTabs');
    if (tabs) {
      tabs.addEventListener('click', function (e) {
        var tab = e.target.closest ? e.target.closest('[data-filter]') : null;
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