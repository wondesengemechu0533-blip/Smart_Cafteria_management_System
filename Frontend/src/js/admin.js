function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - ADMIN SHARED SCRIPT
 * ================================================================
 * Shared by all admin pages (users, menu, orders, payments, ...).
 * Provides:
 *   - Admin authentication guard (client-side)
 *   - Sidebar toggle for mobile
 *   - Logout handler
 *
 * Dashboard stats are now handled by dashboard.js (backend data).
 * ================================================================
 */
document.addEventListener('DOMContentLoaded', () => {
  // 1. Protection Check (Client-Side)
  verifyAdminAuthentication();

  // 2. UI Event Bindings
  initSidebarToggle();
  initLogout();
});

/**
 * Verify logged in user has administrator role
 */
function verifyAdminAuthentication() {
  const userRole = localStorage.getItem('userRole') || localStorage.getItem('role');
  const roleLower = (userRole || '').toLowerCase();
  const isAdmin = userRole === 'ADMIN' || userRole === 'Admin' || userRole === 'admin' || roleLower === 'system_admin';
  if (!isAdmin) {
    return;
  }

  // Populate user UI
  const profile = getStoredProfile();
  const nameDisplay = document.getElementById('adminNameDisplay');
  const avatar = document.getElementById('adminAvatar');
  if (profile) {
    if (nameDisplay) nameDisplay.textContent = profile.name || 'Admin';
    if (avatar && profile.name) avatar.textContent = profile.name.charAt(0).toUpperCase();
  } else {
    if (nameDisplay) nameDisplay.textContent = 'Admin';
  }
}

function getStoredProfile() {
  try {
    const raw =
      localStorage.getItem('userProfile') || localStorage.getItem('user') || localStorage.getItem('loggedUser');
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

/**
 * Sidebar drawer toggle for mobile responsiveness
 */
function initSidebarToggle() {
  const toggleBtn = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('adminSidebar');

  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }
}

/**
 * Handle system logout
 */
function initLogout() {
  const logoutBtn = document.getElementById('logoutBtn');
  if (!logoutBtn || logoutBtn.dataset.logoutBound) return;
  logoutBtn.dataset.logoutBound = '1';
  logoutBtn.addEventListener('click', () => {
    if (confirm(tr('admin_logout_confirm', 'Are you sure you want to log out of the admin panel?'))) {
      ['auth_token', 'userRole', 'role', 'userProfile', 'user', 'loggedUser',
       'token', 'adminLoggedIn', 'isLoggedIn', 'current_user', 'userName', 'name'
      ].forEach((k) => localStorage.removeItem(k));
      window.location.href = '../../pages/common/login.html';
    }
  });
}
