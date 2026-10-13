// API base URL:
// - localhost/127.0.0.1 dev: backend is on :5000.
// - LAN dev (e.g. http://192.168.x.x:5500 on a phone): backend is on the SAME
//   host but port :5000. Using location.origin here would wrongly point API
//   calls at the frontend port (:5500) and break menu/table/order calls.
// - Production (single origin: backend serves the frontend): use location.origin.
var __isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
var __isFrontendDevPort = location.port === '5500' || location.port === '5501';
var API_BASE_URL;
if (__isLocalHost) {
    API_BASE_URL = 'http://localhost:5000';
} else if (__isFrontendDevPort) {
    API_BASE_URL = location.protocol + '//' + location.hostname + ':5000';
} else {
    API_BASE_URL = location.origin;
}

window.__API_BASE = API_BASE_URL;
window.__API_URL = API_BASE_URL + '/api/v1';

// Named constants used by ES module files that previously tried to import
// from this file.  Because this script is loaded as a classic <script> (not
// type="module") it cannot use export; consumers read from window instead.

// Socket.IO is served from the backend ROOT (http://host:5000/socket.io/...),
// never from the /api/v1 prefix - hitting /api/v1/socket.io returns 404 and the
// client never connects. It has to be derived from __API_BASE BEFORE
// window.API_BASE_URL is repointed at /api/v1: `var API_BASE_URL` and
// window.API_BASE_URL are the SAME binding, so assigning the prefix to
// window.API_BASE_URL would otherwise silently repoint the socket origin too.
window.SOCKET_URL   = window.__API_BASE;
window.API_BASE_URL = window.__API_URL;

window.STORAGE_KEYS = { cart: 'smart_cafeteria_cart' };

window.ORDER_STATUS = {
    PENDING:    'pending',
    PREPARING:  'preparing',
    READY:      'ready',
    PICKED_UP:  'picked_up',
    SERVED:     'served',
    OUT_FOR_DELIVERY: 'out_for_delivery',
    ARRIVED:    'arrived',
    DELIVERED:  'delivered',
    COMPLETED:  'completed',
    CANCELLED:  'cancelled'
};

window.ORDER_STATUS_LABELS = {
    pending: 'Pending',
    preparing: 'Preparing',
    ready: 'Ready',
    picked_up: 'Picked Up',
    served: 'Served',
    out_for_delivery: 'Out for Delivery',
    arrived: 'Arrived',
    delivered: 'Delivered',
    completed: 'Completed',
    cancelled: 'Cancelled'
};

window.PAYMENT_STATUS = {
    PENDING:    'PENDING',
    PAID:       'PAID',
    FAILED:     'FAILED',
    CANCELLED:  'CANCELLED',
    REFUNDED:   'REFUNDED',
    SIMULATED:  'SIMULATED'
};

window.PAYMENT_METHODS = { CHAPA: 'CHAPA' };

window.MENU_CATEGORIES = [
    { id: 'breakfast',  name: { en: 'Breakfast',  am: '\u1361\u1273\u1235\u134D' } },
    { id: 'main-meals', name: { en: 'Main Meals',  am: '\u1260\u1233\u1262 \u1348\u1295\u1293' } },
    { id: 'fasting',    name: { en: 'Fasting Meals', am: '\u1331\u1262\u1293\u1295 \u1348\u1295\u1293' } },
    { id: 'beverages',  name: { en: 'Beverages',   am: '\u1270\u130D\u1293\u134D' } },
    { id: 'snacks',     name: { en: 'Snacks',      am: '\u1260\u1295\u134D\u1293\u1295' } }
];

window.PATTERNS = {
    email: /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/,
    name:  /^[a-zA-Z\u1200-\u137F\u1380-\u139F\u13A0-\u13FF\u2D80-\u2DDF\uAB00-\uAB2F\s'-]+$/,
    phone: /^(\+?251|0)?[97]\d{8}$/
};

// Global logout safety net — installed once even if config.js is included
// multiple times on a page. Capture-phase so it runs before per-page handlers
// and still works when a layout failed to bind #logoutBtn / #headerLogoutBtn.
(function () {
    if (typeof document === 'undefined' || window.__scosLogoutNetInstalled) return;
    window.__scosLogoutNetInstalled = true;

    var LOGOUT_SEL = [
        '#logoutBtn',
        '#headerLogoutBtn',
        '.kds-logout-btn',
        '.btn-logout',
        '.btn-logout-icon',
        'button.logout',
        'button[data-logout]'
    ].join(',');

    var SESSION_KEYS = [
        'auth_token', 'userRole', 'role', 'userProfile', 'current_user',
        'user', 'loggedUser', 'token', 'isLoggedIn', 'userName', 'name',
        'adminLoggedIn', 'cafeteriaAdminLoggedIn', 'managerLoggedIn',
        'kitchenLoggedIn', 'deliveryLoggedIn', 'cashierLoggedIn',
        'customerLoggedIn', 'taxAuthorityLoggedIn', 'redirect_after_auth',
        'latestOrder'
    ];

    function loginHref() {
        // Pages live under /src/pages/<area>/ — sibling of common/.
        return '../common/login.html';
    }

    function clearSession() {
        SESSION_KEYS.forEach(function (k) {
            try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
        });
    }

    function confirmLogout() {
        var msg = 'Are you sure you want to log out?';
        try {
            if (typeof window.tr === 'function') {
                msg = window.tr('logout_confirm', msg) || msg;
            }
        } catch (e) { /* keep default */ }
        return window.confirm(msg);
    }

    function performLogout() {
        try {
            if (window.ScosSession && typeof window.ScosSession.logout === 'function') {
                window.ScosSession.logout();
                return;
            }
        } catch (e) { /* fall through to local logout */ }
        try {
            var token = localStorage.getItem('auth_token');
            if (token) {
                fetch((window.__API_URL || 'http://localhost:5000/api/v1') + '/auth/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
                }).catch(function () { /* backend may be down */ });
            }
        } catch (e) { /* ignore */ }
        clearSession();
        window.location.href = loginHref();
    }

    document.addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest(LOGOUT_SEL) : null;
        if (!el) return;
        // Kitchen pages (and any page) with inline onclick manage themselves.
        if (el.getAttribute && el.getAttribute('onclick')) return;

        e.preventDefault();
        e.stopImmediatePropagation();

        if (el.id === 'headerLogoutBtn' && typeof window.__scosHeaderOnLogout === 'function') {
            try { window.__scosHeaderOnLogout(e); } catch (err) { /* ignore */ }
            return;
        }

        if (confirmLogout()) performLogout();
    }, true);
})();
