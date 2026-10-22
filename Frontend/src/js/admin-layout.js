function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ==========================================================================
   SMART CAFETERIA ADMIN — SHARED LAYOUT MODULE
   ==========================================================================
   Provides common layout rendering for all admin pages.
   Load this BEFORE page-specific admin scripts.
   ========================================================================== */
(function () {
  'use strict';

  // Ensure the shared role helpers exist before rendering/guards run below.
  if (!window.ScosRoles) {
    document.write('<script src="../../js/roles.js"><\/script>');
  }

  // Admin page definitions for sidebar
  var ADMIN_PAGES = [
    { id: 'dashboard', path: 'dashboard.html', icon: 'fa-chart-line', label: 'Dashboard', group: 'system' },
    { id: 'admin-dashboard', path: 'dashboard.html', icon: 'fa-chart-line', label: 'Admin Dashboard', group: 'system' },
    { id: 'manager-overview', path: '../manager/dashboard.html', icon: 'fa-chart-line', label: 'Dashboard', group: 'system' },
    { id: 'issues', path: '../manager/issues.html', icon: 'fa-flag', label: 'Issue Reports', group: 'cafeteria' },
    { id: 'resolution-requests', path: 'resolution-requests.html', icon: 'fa-file-signature', label: 'Resolution Requests', group: 'cafeteria' },
    { id: 'stock-alerts', path: '../manager/stock-alerts.html', icon: 'fa-triangle-exclamation', label: 'Stock Alerts', group: 'cafeteria' },
    { id: 'inventory', path: '../manager/inventory.html', icon: 'fa-boxes-stacked', label: 'Inventory', group: 'cafeteria' },
    { id: 'security', path: 'security.html', icon: 'fa-shield-halved', label: 'Security', group: 'system' },
    { id: 'roles', path: 'roles.html', icon: 'fa-user-shield', label: 'Roles & Permissions', group: 'system' },
    { id: 'monitoring', path: 'monitoring.html', icon: 'fa-server', label: 'System Monitoring', group: 'system' },
    { id: 'system-logs', path: 'system-logs.html', icon: 'fa-list-ol', label: 'System Logs', group: 'system' },
    { id: 'reports', path: 'reports.html', icon: 'fa-chart-pie', label: 'Reports & Analytics', group: 'analytics' },
    { id: 'manager-reports', path: '../manager/reports.html', icon: 'fa-chart-pie', label: 'Reports & Analytics', group: 'analytics' },
    { id: 'activity', path: 'activity.html', icon: 'fa-list-check', label: 'Audit Activity', group: 'analytics' },
    {
      id: 'api-integrations',
      path: 'api-integrations.html',
      icon: 'fa-plug',
      label: 'API & Integrations',
      group: 'system',
    },
    { id: 'notifications', path: 'notifications.html', icon: 'fa-bell', label: 'Notifications', group: 'system' },
    { id: 'backup', path: 'backup.html', icon: 'fa-database', label: 'Backup & Recovery', group: 'system' },
    { id: 'maintenance', path: 'maintenance.html', icon: 'fa-wrench', label: 'System Maintenance', group: 'system' },
    { id: 'settings', path: 'settings.html', icon: 'fa-gear', label: 'Settings', group: 'system' },
    { id: 'profile', path: 'profile.html', icon: 'fa-user', label: 'My Profile', group: 'system' },
    { id: 'users', path: 'users.html', icon: 'fa-users', label: 'Users', group: 'system' },
    { id: 'staff-management', path: 'users.html', icon: 'fa-user-plus', label: 'Staff Management', group: 'cafeteria' },
    { id: 'manager-staff-management', path: '../manager/staff-management.html', icon: 'fa-user-plus', label: 'Staff Management', group: 'cafeteria' },
    { id: 'categories', path: 'categories.html', icon: 'fa-list', label: 'Categories', group: 'cafeteria' },
    { id: 'payments', path: 'payments.html', icon: 'fa-wallet', label: 'Payments', group: 'cafeteria' },
    { id: 'menu', path: 'menu.html', icon: 'fa-bowl-food', label: 'Menu / Foods', group: 'cafeteria' },
    { id: 'tables', path: 'tables.html', icon: 'fa-table-cells-large', label: 'Tables', group: 'cafeteria' },
    { id: 'orders', path: 'orders.html', icon: 'fa-receipt', label: 'Orders', group: 'cafeteria' },
    { id: 'deliveries', path: 'deliveries.html', icon: 'fa-truck-fast', label: 'Deliveries', group: 'cafeteria' },
    { id: 'delivery-staff', path: '../manager/delivery-staff.html', icon: 'fa-solid fa-users', label: 'Delivery Staff', group: 'cafeteria' },
    { id: 'manager-menu', path: '../manager/menu.html', icon: 'fa-bowl-food', label: 'Menu / Foods', group: 'cafeteria' },
    { id: 'manager-categories', path: '../manager/categories.html', icon: 'fa-list', label: 'Categories', group: 'cafeteria' },
    { id: 'manager-tables', path: '../manager/tables.html', icon: 'fa-table-cells-large', label: 'Tables', group: 'cafeteria' },
    {
      id: 'cancellations',
      path: 'cancellations.html',
      icon: 'fa-hand-holding-dollar',
      label: 'Cancellations',
      group: 'cafeteria',
    },
    { id: 'feedback', path: 'feedback.html', icon: 'fa-comment-dots', label: 'Feedback', group: 'cafeteria' },
    { id: 'sales-report', path: 'reports.html#sales', icon: 'fa-chart-line', label: 'Sales Report', group: 'analytics' },
    { id: 'order-report', path: 'reports.html#orders', icon: 'fa-receipt', label: 'Order Report', group: 'analytics' },
    { id: 'payment-report', path: 'reports.html#payments', icon: 'fa-credit-card', label: 'Payment Report', group: 'analytics' },
    { id: 'inventory-report', path: 'reports.html#inventory', icon: 'fa-boxes-stacked', label: 'Inventory / Stock Report', group: 'analytics' },
    // Tax / VAT is a page of its own (tax.html), not a tab of the financial
    // page - the two dashboards are completely separate.
    { id: 'tax-report', path: 'tax.html', icon: 'fa-file-invoice', label: 'Tax / VAT', group: 'analytics' },
    {
      id: 'revenue-report',
      path: 'revenue.html',
      icon: 'fa-sack-dollar',
      label: 'Revenue / System Analytics',
      group: 'analytics',
    },
  ];

  // Sidebar groups for system admin and cafeteria admin
  var SYSTEM_ADMIN_GROUPS = [
    {
      id: 'system',
      label: 'SYSTEM ADMIN',
      labelKey: 'admin_system_admin',
      pages: [
        'dashboard',
        'notifications',
        'users',
        'cafeterias',
        'settings',
        'profile',
        'security',
        'reports',
        'activity',
        'tax-report',
        'revenue-report',
      ],
    },
  ];

  var MANAGER_GROUPS = [
    {
      id: 'manager',
      label: 'CAFETERIA MANAGER',
      labelKey: 'admin_cafeteria_manager',
      pages: [
        'manager-overview',
        'notifications',
        'orders',
        'deliveries',
        'cancellations',
        'feedback',
        'manager-reports',
        'inventory',
        'stock-alerts',
        'manager-menu',
        'manager-categories',
        'manager-tables',
        'manager-staff-management',
        'delivery-staff',
        'settings',
        'profile',
      ],
    },
  ];

  // Current page detection
  function getCurrentPageId() {
    var path = window.location.pathname.split('/').pop().replace('.html', '');
    var isManager = window.location.pathname.indexOf('/manager/') !== -1;
    if (isManager) {
      var managerPageMap = {
        'dashboard': 'manager-overview',
        'reports': 'manager-reports',
        'staff-management': 'manager-staff-management',
        'menu': 'manager-menu',
        'categories': 'manager-categories',
        'tables': 'manager-tables',
      };
      return managerPageMap[path] || path;
    }
    if (path === 'users') {
      var r = (localStorage.getItem('userRole') || localStorage.getItem('role') || '').toLowerCase();
      if (r.indexOf('manager') !== -1) return 'staff-management';
    }
    // The financial dashboard lives on its own page (revenue.html) and the tax
    // compliance dashboard on another one (tax.html).
    if (path === 'revenue') return 'revenue-report';
    if (path === 'tax') return 'tax-report';
    return path || 'dashboard';
  }

  // Detect the active report sub-page from the URL hash (e.g. #orders -> order-report)
  function getActiveReportPageId() {
    var hash = window.location.hash.replace('#', '');
    var hashToPage = {
      sales: 'sales-report',
      orders: 'order-report',
      payments: 'payment-report',
      inventory: 'inventory-report',
    };
    return hashToPage[hash] || null;
  }

  // Layout pages (admin-layout.js) are shared between src/pages/admin/ and the
  // manager dashboard in src/pages/manager/. Sidebar/nav links are relative to
  // the admin folder, so compute a prefix when the page lives elsewhere.
  function getAdminBase() {
    var path = window.location.pathname.replace(/\\/g, '/');
    var m = path.match(/\/([^/]+)\/[^/]+\.html$/);
    var dir = m ? m[1] : 'admin';
    return dir === 'admin' ? '' : '../admin/';
  }

  // Pending-refund count behind the Cancellations sidebar link. A cancelled +
  // paid order waits here until a Manager/Admin processes its refund, so this
  // number is how staff learn refund work is outstanding without opening the
  // page. Server-sourced only - nothing is cached in localStorage.
  function refreshRefundBadge() {
    var el = document.getElementById('sidebarRefundBadge');
    if (!el) return Promise.resolve(0);
    var token = localStorage.getItem('auth_token');
    if (!token) return Promise.resolve(0);
    return fetch((window.__API_URL || '') + '/cancellations/stats', {
      headers: { Authorization: 'Bearer ' + token },
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        var count = (data && data.stats && data.stats.refundsPending) || 0;
        el.textContent = String(count);
        el.style.display = count > 0 ? 'inline-block' : 'none';
        return count;
      })
      .catch(function () {
        return 0;
      });
  }

  // Unread notification count for the sidebar link + navbar bell.
  // Delegates to the shared notification centre when it is loaded, and falls
  // back to a direct /notifications/unread call otherwise.
  function refreshNotificationBadge() {
    if (window.ScosNotifications && typeof window.ScosNotifications.refreshBadge === 'function') {
      return window.ScosNotifications.refreshBadge();
    }
    var token = localStorage.getItem('auth_token');
    if (!token) return Promise.resolve(0);
    return fetch((window.__API_URL || '') + '/notifications/unread', {
      headers: { Authorization: 'Bearer ' + token },
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var count = (data && data.count) || 0;
        document.querySelectorAll('[data-notif-badge]').forEach(function (el) {
          el.textContent = count > 99 ? '99+' : count > 0 ? String(count) : '';
          el.style.display = count > 0 ? 'inline-block' : 'none';
        });
        return count;
      })
      .catch(function () {
        return 0;
      });
  }

  // Render sidebar navigation
  function renderSidebar(currentPageId) {
    var sidebar = document.getElementById('adminSidebar');
    if (!sidebar) return;

    sidebar.innerHTML = '';

    function t(key, fallback) {
      try {
        if (window.getText) {
          var v = window.getText(key);
          if (v !== key) return v;
        }
        if (window.translations) {
          var lang = localStorage.getItem('scos_language') || localStorage.getItem('cafeteria_language') || 'en';
          if (window.translations[lang] && window.translations[lang][key]) return window.translations[lang][key];
        }
      } catch (e) {}
      return fallback;
    }

    var html = '<nav class="sidebar-nav">';

    // Sidebar links point at pages inside the admin folder (shared chrome).
    var base = getAdminBase();

    var currentRole = '';
    try {
      if (window.ScosRoles) {
        currentRole = ScosRoles.getCurrentRole();
      }
    } catch (e) {
      /* ignore */
    }

    var visible = [];
    try {
      if (window.ScosRoles) {
        visible = ScosRoles.visiblePages(currentRole);
      }
    } catch (e) {
      /* ignore */
    }

    var groups =
      currentRole === 'manager'
        ? MANAGER_GROUPS
        : SYSTEM_ADMIN_GROUPS;

    groups.forEach(function (group) {
      var pages = group.pages.filter(function (pageId) {
        return visible.indexOf(pageId) !== -1;
      });
      if (pages.length === 0) return;

      // Which report (if any) the URL hash points at, e.g. #tax -> Tax / VAT.
      var reportPageId = getActiveReportPageId();

      var groupTitle = t(group.labelKey, group.label);
      html += '<div class="sidebar-group">';
      html += '<div class="sidebar-group-title" data-i18n="' + group.labelKey + '">' + groupTitle + '</div>';

      pages.forEach(function (pageId) {
        var page = ADMIN_PAGES.find(function (p) {
          return p.id === pageId;
        });
        if (!page) return;

        var labelKeyMap = {
          dashboard: 'admin_dashboard',
          users: 'admin_users',
          'staff-management': 'admin_staff_management',
          menu: 'admin_menu',
          categories: 'admin_categories',
          orders: 'admin_orders',
          deliveries: 'admin_deliveries',
          payments: 'admin_payments',
          cancellations: 'admin_cancellations',
          feedback: 'admin_feedback',
          reports: 'admin_reports_analytics',
          'manager-reports': 'admin_reports_analytics',
          'sales-report': 'admin_sales_report',
          'order-report': 'admin_order_report',
          'payment-report': 'admin_payment_report',
          'inventory-report': 'admin_inventory_report',
          'manager-overview': 'admin_manager_overview',
          'manager-staff-management': 'admin_staff_management',
          'manager-menu': 'admin_menu',
          'manager-categories': 'admin_categories',
          'manager-tables': 'admin_tables',
          issues: 'admin_issue_reports',
          'stock-alerts': 'kitchen_nav_stock_alerts',
          inventory: 'admin_inventory',
          activity: 'admin_activity',
          tables: 'admin_tables',
          settings: 'admin_settings',
          security: 'admin_security',
          roles: 'admin_roles_permissions',
          monitoring: 'admin_system_monitoring',
          'system-logs': 'admin_system_logs',
          'api-integrations': 'admin_api_integrations',
          notifications: 'admin_notifications',
          backup: 'admin_backup_recovery',
          maintenance: 'admin_system_maintenance',
          profile: 'admin_my_profile',
          cafeterias: 'admin_cafeterias',
          'tax-report': 'admin_tax_vat',
          'revenue-report': 'admin_revenue_analytics',
        };
        var labelKey = labelKeyMap[pageId] || pageId;
        if (pageId === 'settings' && (currentRole === 'admin' || currentRole === 'system_admin')) {
          labelKey = 'admin_system_settings';
        }
        var translatedLabel = t(labelKey, page.label);
        // A hash-selected report wins over the page itself, so opening
        // reports.html#orders highlights the matching report entry and not the
        // page entry too.
        // A hash that maps to a report which is NOT part of this sidebar
        // (e.g. #orders -> "Order Report") leaves the page entry highlighted.
        var reportPageRendered = !!(reportPageId && group.pages.indexOf(reportPageId) !== -1);
        var isActive = reportPageRendered ? pageId === reportPageId : pageId === currentPageId;
        html += '<a href="' + base + page.path + '" class="sidebar-link' + (isActive ? ' active' : '') + '"';
        if (pageId === 'cancellations') {
          html += ' id="sidebarCancellationLink"';
        }
        html += '>';
        html += '        <i class="fa-solid ' + page.icon + '"></i>';
        html += '<span data-i18n="' + labelKey + '">' + translatedLabel + '</span>';
        if (pageId === 'cancellations') {
          html += '<span class="sidebar-badge" id="sidebarRefundBadge">0</span>';
        }
        if (pageId === 'notifications') {
          html +=
            '<span class="sidebar-badge" id="sidebarNotifBadge" data-notif-badge style="display:none">' +
            '</span>';
        }
        html += '</a>';
      });

      html += '</div>';
    });

    html += '</nav>';
    sidebar.innerHTML = html;

    // The sidebar is rebuilt on language change, so repaint the badges that
    // live inside it.
    refreshNotificationBadge();
  }

  // Ensure unified i18n is loaded on admin pages (auto-inject if missing)
  function ensureI18nLoaded() {
    if (document.querySelector('script[src*="i18n.js"]')) return;
    var s = document.createElement('script');
    s.type = 'module';
    s.src = '../../js/utils/i18n.js';
    document.head.appendChild(s);
  }

  // Ensure the shared idle-session (auto-logout) module is loaded
  function ensureSessionLoaded() {
    if (document.querySelector('script[src*="session-timeout.js"]')) return;
    var s = document.createElement('script');
    s.src = '../../js/session-timeout.js';
    document.head.appendChild(s);

    if (document.querySelector('script[src*="notification-sound.js"]')) return;
    var n = document.createElement('script');
    n.src = '../../js/notification-sound.js';
    document.head.appendChild(n);
  }

  // Load the shared notification stack on EVERY admin/manager page in one
  // deterministic order:
  //   1. socket.io client  (no-op if the page already loaded it)
  //   2. js/socket.js       -> exposes window.ScosSocketBridge, and forwards every
  //                            `notification:new` frame as a `notification:refresh`
  //                            DOM event, which refreshNotificationBadge() already
  //                            listens for.
  //   3. js/notification-center.js -> exposes window.ScosNotifications (the panel
  //                            engine + badge refresher). Loaded LAST and only once
  //                            the shared socket exists, so the centre reuses
  //                            ScosSocketBridge instead of opening a second
  //                            connection.
  //
  // Without this, pages such as admin/orders.html had no socket at all: new-order
  // notifications were never pushed to them and the sidebar badge only moved on
  // the 30s poll. Absolute /src/... paths keep this working for both
  // pages/admin/* and pages/manager/*.
  function ensureNotificationStackLoaded() {
    if (window.__scosAdminNotifStack) return;
    window.__scosAdminNotifStack = true;

    function loadScript(src, type, onload) {
      var s = document.createElement('script');
      s.src = src;
      if (type) s.type = type;
      if (onload) s.onload = onload;
      document.head.appendChild(s);
      return s;
    }

    function loadCentre() {
      if (window.ScosNotifications) {
        announceCentre();
        return;
      }
      loadScript('/src/js/notification-center.js', null, announceCentre);
    }

    function announceCentre() {
      try {
        window.dispatchEvent(new CustomEvent('scos:notification-centre:ready'));
      } catch (e) {
        /* ignore */
      }
    }

    function loadSharedSocket() {
      if (window.ScosSocketBridge) {
        loadCentre();
        return;
      }
      loadScript('/src/js/socket.js', 'module', loadCentre);
    }

    if (typeof window.io === 'undefined') {
      loadScript('/public/assets/vendor/js/socket.io-4.7.5.min.js', null, loadSharedSocket);
    } else {
      loadSharedSocket();
    }
  }

  // ------------------------------------------------------------------
  // Realtime notification popups
  //
  // js/socket.js re-emits every `notification:new` frame as a
  // `notification:refresh` DOM event carrying the notification in `detail`.
  // The badge (above) is driven by the same event, but a badge alone does not
  // tell an admin *what* arrived — on pages like orders.html there is no
  // notification panel, so new orders were arriving completely silently. This
  // renders a small stacked popup so the notification is actually visible,
  // and deep-links to the relevant order.
  //
  // Events dispatched WITHOUT `detail` come from the panel's own count refresh
  // and are ignored, so nothing is shown twice.
  // ------------------------------------------------------------------

  function escNotif(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function notifStack() {
    var stack = document.getElementById('scosAdminNotifStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'scosAdminNotifStack';
      stack.style.cssText =
        'position:fixed;top:16px;right:16px;z-index:10000;display:flex;' +
        'flex-direction:column;gap:10px;pointer-events:none;max-width:min(380px,calc(100vw - 32px));';
      document.body.appendChild(stack);
    }
    return stack;
  }

  function showNotificationPopup(notif) {
    if (!notif) return;
    var isOrder = notif.type === 'order' || notif.type === 'status_update' || notif.type === 'ready';
    var icon = isOrder ? 'fa-receipt' : 'fa-bell';

    var el = document.createElement('div');
    el.className = 'scos-admin-notif-toast';
    el.setAttribute('role', 'status');

    // Deep-link within the admin surface only. The backend builds `link` for the
    // role that receives the notification (e.g. the kitchen order page), so it
    // must never be followed from an admin page - route by orderId instead.
    var target = notif.orderId
      ? getAdminBase() + 'orders.html?orderId=' + encodeURIComponent(notif.orderId)
      : getAdminBase() + 'notifications.html';

    el.innerHTML =
      '<i class="fa-solid ' +
      icon +
      '" style="color:#2563eb;margin-top:2px;"></i>' +
      '<div style="flex:1;min-width:0;">' +
      '<div class="scos-admin-notif-title">' +
      escNotif(notif.title || 'Notification') +
      '</div>' +
      '<div class="scos-admin-notif-message">' +
      escNotif(notif.message || '') +
      '</div>' +
      '<a class="scos-admin-notif-link" href="' +
      escNotif(target) +
      '">View →</a>' +
      '</div>' +
      '<button type="button" class="scos-admin-notif-close" aria-label="Dismiss">&times;</button>';

    function dismiss() {
      el.classList.add('scos-admin-notif-out');
      setTimeout(function () {
        el.remove();
      }, 250);
    }

    el.querySelector('.scos-admin-notif-close').addEventListener('click', function (e) {
      e.stopPropagation();
      dismiss();
    });
    el.querySelector('.scos-admin-notif-link').addEventListener('click', function (e) {
      e.stopPropagation();
    });

    var stack = notifStack();
    stack.appendChild(el);
    // Cap the stack so a burst of orders cannot bury the page.
    while (stack.children.length > 4) stack.removeChild(stack.firstChild);
    setTimeout(dismiss, 7000);
  }

  var notifPopupBound = false;
  function bindRealtimeNotificationPopups() {
    if (notifPopupBound) return;
    notifPopupBound = true;

    if (!document.getElementById('scosNotifAnimStyles')) {
      var style = document.createElement('style');
      style.id = 'scosNotifAnimStyles';
      style.textContent = [
        '@keyframes scosNotifIn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:translateX(0)}}',
        '.scos-admin-notif-toast{pointer-events:auto;background:#fff;border:1px solid #e5e7eb;',
        'border-left:4px solid #2563eb;border-radius:10px;box-shadow:0 10px 25px rgba(15,23,42,.18);',
        'padding:12px 14px;display:flex;gap:10px;align-items:flex-start;animation:scosNotifIn .25s ease;',
        'transition:opacity .25s ease,transform .25s ease;}',
        '.scos-admin-notif-out{opacity:0;transform:translateX(16px);}',
        '.scos-admin-notif-title{font-weight:700;font-size:.85rem;margin-bottom:2px;color:#0f172a;}',
        '.scos-admin-notif-message{font-size:.78rem;color:#475569;line-height:1.35;}',
        '.scos-admin-notif-link{display:inline-block;margin-top:6px;font-size:.72rem;font-weight:600;',
        'color:#2563eb;text-decoration:none;}',
        '.scos-admin-notif-link:hover{text-decoration:underline;}',
        '.scos-admin-notif-close{background:none;border:none;color:#94a3b8;cursor:pointer;',
        'font-size:15px;line-height:1;padding:2px;}',
        '[data-theme="dark"] .scos-admin-notif-toast{background:#1e293b;border-color:#334155;',
        'box-shadow:0 10px 25px rgba(0,0,0,.45);}',
        '[data-theme="dark"] .scos-admin-notif-title{color:#f1f5f9;}',
        '[data-theme="dark"] .scos-admin-notif-message{color:#cbd5e1;}',
        '[data-theme="dark"] .scos-admin-notif-link{color:#93c5fd;}',
        '[data-theme="dark"] .scos-admin-notif-close{color:#94a3b8;}',
      ].join('');
      document.head.appendChild(style);
    }

    document.addEventListener('notification:refresh', function (e) {
      // A page that renders `notification:new` itself sets this to false.
      if (window.ScosNotifPopup === false) return;
      var notif = e && e.detail;
      // No `detail` => the panel only refreshed a count; not a new notification.
      if (!notif) return;
      if (!notif.title && !notif.message) return;
      // The notifications page already renders every frame as a card.
      if (document.getElementById('notifList')) return;
      showNotificationPopup(notif);
    });
  }

  // Ensure theme.js is loaded on all admin pages
  function ensureThemeLoaded() {
    if (document.querySelector('script[src*="theme.js"]')) return;
    var s = document.createElement('script');
    s.src = '../../js/theme.js';
    document.head.appendChild(s);
  }

  // Ensure the dark theme stylesheet is loaded so admin surfaces re-theme.
  function ensureDarkThemeCssLoaded() {
    if (document.querySelector('link[href*="dark-theme.css"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '../../css/themes/dark-theme.css';
    document.head.appendChild(l);
  }

  // Render top navbar
  function renderNavbar() {
    var navbar = document.querySelector('.admin-navbar');
    if (!navbar) return;

    ensureI18nLoaded();

    var profile = getStoredProfile();
    var avatarLetter = profile && profile.name ? profile.name.charAt(0).toUpperCase() : 'A';
    var avatarHtml =
      profile && profile.avatar
        ? '<img src="' + profile.avatar + '" alt="Avatar" class="navbar-avatar-img">'
        : avatarLetter;
    var adminName = profile && profile.name ? profile.name : 'Admin User';

    var curLang = 'en';
    try {
      curLang = localStorage.getItem('scos_language') || localStorage.getItem('cafeteria_language') || 'en';
      if (curLang !== 'am') curLang = 'en';
    } catch (e) {}
    var brandText = 'Smart Cafeteria';
    var brandAdminText = 'Admin';
    var adminRoleText = 'Administrator';
    var logoutText = 'Logout';
    var notifText = 'Notifications';
    var deliveryStaffText = 'Delivery Staff';
    var brandHref = getAdminBase() + 'dashboard.html';
    try {
      if (window.ScosRoles) {
        var brandRole = ScosRoles.getCurrentRole();
        if (brandRole === 'manager') brandHref = '../manager/dashboard.html';
      }
    } catch (e) {}
    try {
      if (window.t) {
        brandText = window.t('admin_brand');
        brandAdminText = window.t('admin_brand_admin');
        adminRoleText = window.t('admin_role_administrator');
        logoutText = window.t('admin_logout');
        notifText = window.t('admin_notifications_shortcut_title');
      }
    } catch (e) {}
    navbar.innerHTML =
      '' +
      '<div class="nav-left">' +
      '  <button id="sidebarToggle" class="btn-icon" aria-label="Toggle Sidebar"><i class="fa-solid fa-bars"></i></button>' +
      '  <a href="' +
      brandHref +
      '" class="brand-logo"><i class="fa-solid fa-utensils"></i><span>' +
      brandText +
      ' <small>' +
      brandAdminText +
      '</small></span></a>' +
      '</div>' +
      '<div class="nav-right">' +
      '  <div class="lang-switcher-widget" style="display:inline-flex;align-items:center;gap:6px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:3px 8px;box-shadow:0 2px 8px rgba(0,0,0,0.08);margin-right:8px;">' +
      '    <i class="fa-solid fa-globe" style="color:#2563eb;font-size:13px;"></i>' +
      '    <select class="scos-lang-select" aria-label="Language Selector" style="background:transparent;color:#0f172a;border:none;font-weight:700;cursor:pointer;font-size:13px;outline:none;min-width:110px;">' +
      '      <option value="en"' +
      (curLang === 'en' ? ' selected' : '') +
      '>🇬🇧 English</option>' +
      '      <option value="am"' +
      (curLang === 'am' ? ' selected' : '') +
      '>🇪🇹 አማርኛ</option>' +
      '    </select>' +
      '  </div>' +
      '  <div class="nav-item dropdown">' +
      '    <a href="' +
      getAdminBase() +
      'notifications.html" class="btn-icon notification-btn" id="notificationBtn" title="' +
      notifText +
      '"><i class="fa-solid fa-bell"></i><span class="badge-dot" id="notifBadge" data-notif-badge></span></a>' +
      '  </div>' +
      '  <button type="button" class="btn-icon theme-toggle" id="themeToggle" title="' + tr('toggle_theme', 'Toggle Theme') + '">' +
      '    <i class="fa-solid fa-moon"></i>' +
      '  </button>' +
      '  <div class="user-profile-menu">' +
      '    <div class="avatar" id="adminAvatar">' +
      avatarHtml +
      '</div>' +
      '    <div class="user-info">' +
      '      <strong id="adminNameDisplay">' +
      adminName +
      '</strong>' +
      '      <small data-i18n="admin_role_administrator">' +
      adminRoleText +
      '</small>' +
      '    </div>' +
      '    <button id="logoutBtn" class="btn-logout-icon" title="' +
      logoutText +
      '"><i class="fa-solid fa-right-from-bracket"></i><span data-i18n="admin_logout">' +
      logoutText +
      '</span></button>' +
      '  </div>' +
      '</div>';

    // Bind language switcher - immediate without refresh, persisted in localStorage
    var langSelect = navbar.querySelector('.scos-lang-select');
    if (langSelect) {
      try {
        langSelect.value = curLang;
      } catch (e) {}
      if (!langSelect.dataset.i18nBound) {
        langSelect.dataset.i18nBound = '1';
        langSelect.addEventListener('change', function (e) {
          var lang = e.target.value;
          if (window.setLanguage) window.setLanguage(lang);
          else {
            try {
              localStorage.setItem('scos_language', lang);
              localStorage.setItem('cafeteria_language', lang);
            } catch (_) {}
            if (window.applyTranslations) window.applyTranslations();
          }
        });
      }
    }
    if (window.applyTranslations)
      setTimeout(function () {
        window.applyTranslations();
      }, 0);

    // Wire theme toggle + sync its icon (theme.js owns the click handler to
    // avoid double-toggling; refresh() binds/syncs dynamically-injected headers)
    if (window.ScosTheme) {
      try {
        window.ScosTheme.refresh();
      } catch (e) {}
    }

    // Attach sidebar toggle
    var sidebarToggle = document.getElementById('sidebarToggle');
    var sidebar = document.getElementById('adminSidebar');
    if (sidebarToggle && sidebar) {
      sidebarToggle.addEventListener('click', function () {
        // Desktop: collapse/expand the sidebar (icon rail). Mobile: slide it in.
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

    // Close sidebar on backdrop / link click — bind once so language
    // re-renders of the navbar do not stack duplicate document listeners.
    if (!window.__scosAdminSidebarDocBound) {
      window.__scosAdminSidebarDocBound = true;
      document.addEventListener('click', function (e) {
        var side = document.getElementById('adminSidebar');
        var toggle = document.getElementById('sidebarToggle');
        var backdrop = document.querySelector('.sidebar-backdrop');
        if (!side || !toggle || !backdrop || !backdrop.classList.contains('open')) return;
        if (!side.contains(e.target) && !toggle.contains(e.target)) {
          side.classList.remove('open');
          backdrop.classList.remove('open');
        }
      });
      document.addEventListener('click', function (e) {
        var side = document.getElementById('adminSidebar');
        if (!side) return;
        var link = e.target.closest && e.target.closest('.sidebar-link');
        if (link && window.innerWidth < 992) {
          side.classList.remove('open');
          var backdrop = document.querySelector('.sidebar-backdrop');
          if (backdrop) backdrop.classList.remove('open');
        }
      });
    }

    // Logout handler
    var logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn && !logoutBtn.dataset.logoutBound) {
      logoutBtn.dataset.logoutBound = '1';
      logoutBtn.addEventListener('click', function () {
        if (window.confirm((typeof window.tr === 'function' ? window.tr('confirm_logout', 'Are you sure you want to log out?') : 'Are you sure you want to log out?'))) {
          if (window.ScosSession) {
            window.ScosSession.logout();
            return;
          }
          localStorage.removeItem('auth_token');
          localStorage.removeItem('userRole');
          localStorage.removeItem('role');
          localStorage.removeItem('userProfile');
          localStorage.removeItem('adminLoggedIn');
          localStorage.removeItem('isLoggedIn');
          localStorage.removeItem('current_user');
          localStorage.removeItem('userName');
          localStorage.removeItem('name');
          window.location.href = '../../pages/common/login.html';
        }
      });
    }

    // Notification button opens the notification panel (the sidebar "Notifications"
    // link points at the same page).
    var notifBtn = document.getElementById('notificationBtn');
    if (notifBtn && !notifBtn.dataset.notifBound) {
      notifBtn.dataset.notifBound = '1';
      notifBtn.addEventListener('click', function (e) {
        // Already an <a href="notifications.html">; only guard the case where a
        // page provides a plain button.
        if (notifBtn.tagName === 'BUTTON') {
          e.preventDefault();
          window.location.href = getAdminBase() + 'notifications.html';
        }
      });
    }

    refreshNotificationBadge();
  }

  // Auth guard + profile population
  // Role this page booted with, so a replacement session can be detected.
  var bootRole = null;

  function initAuthGuard() {
    var userRole = (localStorage.getItem('userRole') || '').toLowerCase();
    var role = (localStorage.getItem('role') || '').toLowerCase();
    if (!userRole && !role) {
      window.location.href = '../../pages/common/login.html';
      return false;
    }
    var allowed = false;
    if (window.ScosRoles) {
      var canonical = ScosRoles.normalizeRole(userRole || role);
      allowed = ScosRoles.isStaff(canonical);
    } else {
      var allowedRoles = [
        'admin',
        'staff',
        'kitchen_staff',
        'kitchen',
        'foodmaker',
        'cashier',
        'manager',
      ];
      allowed = allowedRoles.includes(userRole) || allowedRoles.includes(role);
    }
    if (!allowed) {
      window.location.href = '../../pages/common/login.html';
      return false;
    }
    // The session that opened this page is legitimate - remember it so the
    // watcher below can tell a genuine re-check from a replaced account.
    bootRole = userRole || role;

    // Page-level access check: redirect if role cannot access this page
    if (window.ScosRoles) {
      var canonical = ScosRoles.normalizeRole(userRole || role);
      var currentPage = getCurrentPageId();
      var allowedPages = ScosRoles.visiblePages(canonical);
      var checkPage = currentPage;
      // Manager dashboard lives at manager/dashboard.html (page id "dashboard")
      if (canonical === 'manager' && currentPage === 'dashboard') {
        checkPage = 'manager-overview';
      }
      // Page-level access check: redirect if role cannot access this page.
      // An EMPTY allowedPages list means the role has no admin page at all
      // (kitchen / delivery / customer), so it is a redirect too - the old
      // `allowedPages.length > 0` guard let those roles walk straight into the
      // system-admin dashboard.
      if (allowedPages.indexOf(checkPage) === -1) {
        window.location.href = ScosRoles.dashboardForRole(canonical);
        return false;
      }
    }

    var profile = getStoredProfile();
    if (profile) {
      var nameDisplay = document.getElementById('adminNameDisplay');
      var avatar = document.getElementById('adminAvatar');
      if (nameDisplay) nameDisplay.textContent = profile.name || 'Admin User';
      if (avatar) {
        if (profile.avatar) {
          avatar.innerHTML = '<img src="' + profile.avatar + '" alt="Avatar" class="navbar-avatar-img">';
        } else if (profile.name) {
          avatar.textContent = profile.name.charAt(0).toUpperCase();
        }
      }
    } else {
      var nameDisplay = document.getElementById('adminNameDisplay');
      if (nameDisplay) nameDisplay.textContent = tr('admin_user', 'Admin User');
    }
    return true;
  }

  /**
   * The signed-in account changed while this page was open (another tab logged
   * in or out, or the browser restored the page from the back/forward cache).
   *
   * Re-runs the guard with the NEW session: if it may no longer be on this
   * page the guard redirects it, and if it is merely a different account the
   * page reloads so every list is rebuilt for that account. Without this an
   * open tab keeps calling the API with a token that belongs to somebody else,
   * which is how the deliveries page ends up logging 403s for
   * GET /deliveries/:id/location.
   */
  function sessionChanged() {
    var prev = bootRole;
    if (!initAuthGuard()) return;
    if (prev !== null && bootRole !== prev) window.location.reload();
  }

  function watchSession() {
    var SESSION_KEYS = ['auth_token', 'userRole', 'role', 'current_user', 'userProfile'];
    window.addEventListener('storage', function (e) {
      if (!e.key || SESSION_KEYS.indexOf(e.key) === -1) return;
      sessionChanged();
    });
    // A page restored from the back/forward cache keeps its old timers but
    // reads localStorage afresh, so it can be running against a session that
    // was replaced while it sat in the history.
    window.addEventListener('pageshow', function (e) {
      if (e.persisted) sessionChanged();
    });
  }
  // Installed while the script is parsed rather than on DOMContentLoaded: the
  // page scripts below start calling the API as soon as they run, so the guard
  // has to be live before a replaced session can issue its first request.
  watchSession();

  function getStoredProfile() {
    try {
      var raw =
        localStorage.getItem('userProfile') || localStorage.getItem('user') || localStorage.getItem('loggedUser');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  // Initialize everything on DOM ready
  document.addEventListener('DOMContentLoaded', function () {
    // 1. Auth guard
    if (!initAuthGuard()) return;

    // 2. Load theme module
    ensureThemeLoaded();
    ensureDarkThemeCssLoaded();
    ensureSessionLoaded();

    // 2b. Realtime notifications. Registered before the layout is painted so the
    //     socket + notification centre are on their way while the sidebar and
    //     navbar render; refreshNotificationBadge() below re-checks
    //     window.ScosNotifications on every call, so the badge starts delegating
    //     to the shared centre as soon as it finishes loading.
    ensureNotificationStackLoaded();
    bindRealtimeNotificationPopups();

    // 3. Render layout
    renderNavbar();
    renderSidebar(getCurrentPageId());

    // 3b. Unread notification badge: initial paint, 30s safety-net poll, and an
    //     immediate repaint whenever a `notification:new` frame arrives.
    //     Exposed globally because page scripts (manager-issues.js, the
    //     notification panel, ...) call window.refreshNotificationBadge().
    window.refreshNotificationBadge = refreshNotificationBadge;
    if (!window.__scosAdminNotifBadgeBound) {
      window.__scosAdminNotifBadgeBound = true;
      document.addEventListener('notification:refresh', refreshNotificationBadge);
      window.setInterval(refreshNotificationBadge, 30000);
    }
    refreshNotificationBadge();

    // 3c. Pending-refund sidebar badge: paint it on load and repaint it the
    //     moment a refund frame lands (`order:status` carrying a refundStatus),
    //     so the count drops as soon as a Manager/Admin processes a refund and
    //     rises as soon as a customer cancels a paid order.
    window.refreshRefundBadge = refreshRefundBadge;
    if (!window.__scosAdminRefundBadgeBound) {
      window.__scosAdminRefundBadgeBound = true;
      refreshRefundBadge();
      var bindRefundBadge = function () {
        var sc = window.ScosSocketBridge;
        if (!sc || typeof sc.on !== 'function' || sc.__refundBadgeBound) return;
        sc.__refundBadgeBound = true;
        sc.on('order:status', function (payload) {
          if (payload && payload.refundStatus) refreshRefundBadge();
        });
      };
      if (window.ScosSocketBridge) bindRefundBadge();
      else window.addEventListener('scos:socket-bridge-ready', bindRefundBadge);
    }

    // 4. Re-render the shared navbar/sidebar whenever the active language
    //    changes so labels rendered via getText() follow the new language.
    function reRenderOnLangChange() {
      renderNavbar();
      renderSidebar(getCurrentPageId());
    }
    var langRegister = window.onLanguageChange || window.i18nOnLanguageChange;
    if (typeof langRegister === 'function') {
      langRegister(reRenderOnLangChange);
    } else {
      window.addEventListener('language:changed', reRenderOnLangChange);
      window.addEventListener('languageChanged', reRenderOnLangChange);
    }

    // Keep sidebar active state in sync with report hash tabs
    // (e.g. reports.html#orders ↔ Order Report).
    window.addEventListener('hashchange', function () {
      renderSidebar(getCurrentPageId());
    });

    // 5. Initialize tooltips, etc.
    if (typeof initPageSpecific === 'function') {
      initPageSpecific();
    }
  });

  // Expose utilities globally
  window.AdminLayout = {
    renderSidebar: renderSidebar,
    renderNavbar: renderNavbar,
    getCurrentPageId: getCurrentPageId,
    getAdminBase: getAdminBase,
    getStoredProfile: getStoredProfile,
    refreshNotificationBadge: refreshNotificationBadge,
    // Run `cb` once notification-center.js has finished loading. Page scripts
    // (e.g. admin/notifications.js) call this instead of assuming the centre is
    // already present, because ensureNotificationStackLoaded() loads it async.
    whenNotificationCentreReady: function (cb) {
      if (typeof cb !== 'function') return;
      if (window.ScosNotifications && typeof window.ScosNotifications.whenReady === 'function') {
        window.ScosNotifications.whenReady(cb);
        return;
      }
      var settled = false;
      function done() {
        if (settled) return;
        if (!window.ScosNotifications) return;
        settled = true;
        if (typeof window.ScosNotifications.whenReady === 'function') {
          window.ScosNotifications.whenReady(cb);
        } else {
          cb(window.ScosNotifications);
        }
      }
      window.addEventListener('scos:notification-centre:ready', done);
      var tries = 0;
      var timer = setInterval(function () {
        done();
        tries += 1;
        if (settled || tries > 60) clearInterval(timer);
      }, 100);
    },
  };
})();
