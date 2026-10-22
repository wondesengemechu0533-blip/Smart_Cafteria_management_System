/**
 * ==========================================================================
   SMART CAFETERIA ORDERING SYSTEM - SHARED ROLE HELPERS
   ==========================================================================
   Single source of truth on the frontend for role normalization, dashboard
   redirect targets, and page-level access (mirrors Backend/src/config/roles.js).

   Classic (non-module) script. Load it BEFORE login/auth/layout scripts:
     <script src="../../js/roles.js"></script>
   Exposes window.ScosRoles for classic pages and for ES modules (auth.js).
   ========================================================================== */
(function (global) {
  'use strict';

  var ROLE_ALIASES = {
    customer: 'customer',
    admin: 'admin',
    systemadmin: 'admin',
    'system admin': 'system_admin',
    manager: 'manager',
    cafeteria_manager: 'manager',
    'cafeteria manager': 'manager',
    cashier: 'cashier',
    kitchen: 'kitchen',
    kitchen_staff: 'kitchen',
    'kitchen staff': 'kitchen',
    foodmaker: 'kitchen',
    staff: 'kitchen',
    delivery: 'delivery',
    delivery_staff: 'delivery',
    'delivery staff': 'delivery',
    delivery_person: 'delivery',
    'delivery person': 'delivery',
    driver: 'delivery',
    rider: 'delivery',
  };

  var CANONICAL_ROLES = [
    'customer',
    'kitchen',
    'admin',
    'system_admin',
    'manager',
    'cashier',
    'delivery',
  ];

  var STAFF_ROLES = [
    'admin',
    'system_admin',
    'manager',
    'cashier',
    'kitchen',
    'delivery',
  ];

  // Dashboard landing page per canonical role. Paths are relative to
  // src/pages/common/ (login.html & auth.js live there / resolve to it).
  var DASHBOARD_REDIRECTS = {
    admin: '../admin/dashboard.html',
    system_admin: '../admin/dashboard.html',
    manager: '../manager/dashboard.html',
    cashier: '../cashier/dashboard.html',
    kitchen: '../kitchen/dashboard.html',
    delivery: '../delivery/history.html',
    customer: '../customer/menu.html',
  };

  // Admin-chrome sidebar page ids visible per staff role, matching backend
  // route guards (see Backend/src/routes/*.js).
  // System Admin (admin/system_admin): system-level management only.
  var PAGE_ACCESS = {
    admin: [
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
    system_admin: [
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
    manager: [
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
      'settings',
      'profile',
    ],
    cashier: ['dashboard', 'notifications', 'orders', 'payments', 'sales', 'receipts'],
    // Roles that never use the admin chrome. An empty list means "no admin
    // page at all" - it must NOT fall back to the admin list, which used to
    // hand a kitchen or delivery account the full system-admin sidebar.
    kitchen: [],
    delivery: [],
    customer: [],
  };

  function normalizeRole(role) {
    var v = String(role === null || role === undefined ? '' : role).trim();
    if (!v) return '';
    var key = v.toLowerCase();
    if (CANONICAL_ROLES.indexOf(key) !== -1) return key;
    return ROLE_ALIASES[key] || v;
  }

  function getCurrentRole() {
    // Prefer the parsed session user for a canonical, lower-case role.
    try {
      var cu = JSON.parse(localStorage.getItem('current_user') || 'null');
      if (cu && cu.role) return normalizeRole(cu.role);
    } catch (e) {
      /* ignore */
    }
    return normalizeRole(localStorage.getItem('userRole') || localStorage.getItem('role') || '');
  }

  function isStaff(role) {
    return STAFF_ROLES.indexOf(normalizeRole(role)) !== -1;
  }

  function dashboardForRole(role) {
    return DASHBOARD_REDIRECTS[normalizeRole(role)] || DASHBOARD_REDIRECTS.customer;
  }

  function visiblePages(role) {
    var r = normalizeRole(role);
    // NO fallback to the admin list: an unknown role has no admin page.
    // (It used to fall back to PAGE_ACCESS.admin, which handed kitchen and
    // delivery accounts the full system-admin sidebar.)
    return (PAGE_ACCESS[r] || []).slice();
  }

  global.ScosRoles = {
    CANONICAL_ROLES: CANONICAL_ROLES,
    STAFF_ROLES: STAFF_ROLES,
    ROLE_ALIASES: ROLE_ALIASES,
    DASHBOARD_REDIRECTS: DASHBOARD_REDIRECTS,
    PAGE_ACCESS: PAGE_ACCESS,
    normalizeRole: normalizeRole,
    getCurrentRole: getCurrentRole,
    isStaff: isStaff,
    dashboardForRole: dashboardForRole,
    visiblePages: visiblePages,
  };
})(typeof window !== 'undefined' ? window : globalThis);
