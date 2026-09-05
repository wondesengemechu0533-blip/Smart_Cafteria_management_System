// API base URL — in production the frontend is served from the same origin
// as the backend, so we use a relative path.  In local development the
// frontend runs on a different port (e.g. 5500) and talks to the backend
// on port 5000.
const API_BASE_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:5000'
    : location.origin;

window.__API_BASE = API_BASE_URL;
window.__API_URL = API_BASE_URL + '/api/v1';

// Named constants used by ES module files that previously tried to import
// from this file.  Because this script is loaded as a classic <script> (not
// type="module") it cannot use export; consumers read from window instead.

window.API_BASE_URL = window.__API_URL;
window.SOCKET_URL   = API_BASE_URL;

window.STORAGE_KEYS = { cart: 'smart_cafeteria_cart' };

window.ORDER_STATUS = {
    PENDING:    'pending',
    PREPARING:  'preparing',
    READY:      'ready',
    SERVED:     'served',
    OUT_FOR_DELIVERY: 'out_for_delivery',
    DELIVERED:  'delivered',
    COMPLETED:  'completed',
    CANCELLED:  'cancelled'
};

window.ORDER_STATUS_LABELS = {
    pending: 'Pending',
    preparing: 'Preparing',
    ready: 'Ready',
    served: 'Served',
    out_for_delivery: 'Out for Delivery',
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
