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
    cafeteria_admin: 'cafeteria_admin',
    'cafeteria admin': 'cafeteria_admin',
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
    tax_authority: 'tax_authority',
    'tax authority': 'tax_authority',
    government: 'tax_authority',
    'government authority': 'tax_authority',
  };

  var CANONICAL_ROLES = [
    'customer',
    'kitchen',
    'admin',
    'system_admin',
    'cafeteria_admin',
    'manager',
    'cashier',
    'delivery',
    'tax_authority',
  ];

  var STAFF_ROLES = [
    'admin',
    'system_admin',
    'cafeteria_admin',
    'manager',
    'cashier',
    'kitchen',
    'delivery',
    'tax_authority',
  ];

  // Dashboard landing page per canonical role. Paths are relative to
  // src/pages/common/ (login.html & auth.js live there / resolve to it).
  var DASHBOARD_REDIRECTS = {
    admin: '../admin/dashboard.html',
    system_admin: '../admin/dashboard.html',
    cafeteria_admin: '../admin/admin-dashboard.html',
    manager: '../manager/dashboard.html',
    cashier: '../cashier/dashboard.html',
    kitchen: '../kitchen/dashboard.html',
    delivery: '../delivery/history.html',
    tax_authority: '../government/dashboard.html',
    customer: '../customer/dashboard.html',
  };

  // Admin-chrome sidebar page ids visible per staff role, matching backend
  // route guards (see Backend/src/routes/*.js).
  // System Admin (admin/system_admin): system-level management only.
  // Cafeteria Admin (cafeteria_admin): cafeteria administration only.
  var PAGE_ACCESS = {
    admin: [
      'dashboard',
      'notifications',
      'users',
      'cafeterias',
      'settings',
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
      'reports',
      'activity',
      'tax-report',
      'revenue-report',
    ],
    cafeteria_admin: [
      'dashboard',
      'admin-dashboard',
      'notifications',
      'users',
      'menu',
      'categories',
      'tables',
      'payments',
      'settings',
      'stock-alerts',
    ],
    manager: [
      'manager-overview',
      'notifications',
      'issues',
      'stock-alerts',
      'orders',
      'deliveries',
      'cancellations',
      'feedback',
      'reports',
    ],
    cashier: ['dashboard', 'notifications', 'orders', 'payments', 'sales', 'receipts'],
    tax_authority: ['reports', 'activity'],
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
    return (PAGE_ACCESS[r] || PAGE_ACCESS.admin).slice();
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
