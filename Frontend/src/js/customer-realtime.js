/**
 * Customer Real-time Notifications
 * - Connects to WebSocket if customer is logged in
 * - Listens for notification:new (only for correct customer via user:${userId} room)
 * - Shows toast: "Your order #ORDER_ID is ready for pickup."
 * - Updates notification badge / area
 * - Offline: notification is saved in DB and shown when customer returns to notifications.html via GET /api/notifications
 */
import { socketClient } from "./socket.js";

function getToken() {
    return localStorage.getItem("auth_token");
}

function isCustomer() {
    // Role is stored inside the JSON "current_user" object (canonical). Fall
    // back to top-level role/userRole keys if present for robustness.
    let role = "";
    try {
        const cu = JSON.parse(localStorage.getItem("current_user"));
        role = cu?.role || "";
    } catch (e) {
        /* ignore */
    }
    if (!role) {
        role = localStorage.getItem("role") || localStorage.getItem("userRole") || "";
    }
    return String(role).toLowerCase() === "customer";
}

function ensureToastContainer() {
    let container = document.getElementById("customer-toast-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "customer-toast-container";
        container.style.cssText = "position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:12px;pointer-events:none;";
        document.body.appendChild(container);
    }
    return container;
}

function crTr(key, fallback) {
    if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback);
    return fallback;
}

function showToast(notification) {
    const container = ensureToastContainer();
    const toast = document.createElement("div");
    const isReady = notification.type === "ready" || (notification.message && notification.message.includes("ready for pickup"));
    // A completed refund reads as a money event, so it gets its own colour +
    // icon instead of the generic blue "bell" used for everything else.
    const isRefund = notification.type === "refund";
    const am = typeof window.getCurrentLanguage === "function" && window.getCurrentLanguage() === "am";
    const title = notification.title || crTr('notif_order_ready', am ? "ትዕዛዝ ዝግጁ!" : "Order Ready!");
    const message = notification.message || crTr('notif_ready_for_pickup', am ? "ትዕዛዝዎ ለመውሰድ ዝግጁ ነው።" : "Your order is ready for pickup.");

    const accent = isRefund ? "#15803d" : isReady ? "#16a34a" : "#2563eb";
    const iconBg = isRefund ? "#dcfce7" : isReady ? "#dcfce7" : "#dbeafe";

    toast.style.cssText = `
        background:#ffffff;
        border-left:4px solid ${accent};
        border-radius:10px;
        box-shadow:0 10px 25px rgba(0,0,0,0.15);
        padding:16px 20px;
        min-width:320px;
        max-width:400px;
        display:flex;
        gap:12px;
        align-items:flex-start;
        pointer-events:auto;
        animation: slideIn 0.3s ease;
        font-family: inherit;
    `;
    const icon = isRefund ? "fa-arrow-rotate-left" : isReady ? "fa-utensils" : "fa-bell";
    const iconColor = isRefund ? "#15803d" : isReady ? "#16a34a" : "#2563eb";
    toast.innerHTML = `
        <div style="width:40px;height:40px;border-radius:50%;background:${iconBg};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <i class="fa-solid ${icon}" style="color:${iconColor};font-size:18px;"></i>
        </div>
        <div style="flex:1;">
            <div style="font-weight:700;font-size:14px;color:#0f172a;margin-bottom:4px;">${escapeHtml(title)}</div>
            <div style="font-size:13px;color:#475569;line-height:1.4;">${escapeHtml(message)}</div>
            ${notification.link ? `<a href="${escapeHtml(notification.link)}" style="display:inline-block;margin-top:8px;font-size:12px;color:${iconColor};font-weight:600;text-decoration:none;">${crTr('view_order', am ? "ትዕዛዝ አሳይ →" : "View Order →")}</a>` : ""}
        </div>
        <button aria-label="Close" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px;line-height:1;padding:4px;">×</button>
    `;

    const closeBtn = toast.querySelector("button");
    const remove = () => {
        toast.style.animation = "slideOut 0.3s ease forwards";
        setTimeout(() => toast.remove(), 300);
    };
    closeBtn.addEventListener("click", remove);
    toast.addEventListener("click", (e) => {
        if (e.target.tagName === "A") return;
        if (notification.link) window.location.href = notification.link;
    });

    container.appendChild(toast);

    // Auto remove after 6 seconds
    setTimeout(remove, 6000);

    // Also update document title briefly
    const originalTitle = document.title;
    if (isReady || isRefund) {
        document.title = "🔔 " + notification.title + " - " + originalTitle;
        setTimeout(() => { document.title = originalTitle; }, 6000);
    }
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
}

// Hosts (in order) where the notification bell should be placed on each page.
// We try to slot the bell into an existing action/links group; if none match we
// fall back to a fixed-position bell pinned to the top-right of the viewport so
// it shows on every customer page ("fix for all").
const BELL_HOST_SELECTORS = [
    ".header-actions",
    ".user-nav-links",
    ".nav-links",
    ".nav-right",
    ".nav-actions"
];

let __bellInjected = false;

function findBellHost() {
    // Prefer a header action group; otherwise fall back to a fixed position.
    let host = null;
    for (let i = 0; i < BELL_HOST_SELECTORS.length; i++) {
        host = document.querySelector(BELL_HOST_SELECTORS[i]);
        // Only slot inline if it already lives inside a header/nav bar.
        if (host && host.closest("header, .navbar, .navbar-header")) {
            break;
        }
        host = null;
    }
    return host;
}

function ensureNotificationBell() {
    if (__bellInjected || !isCustomer()) return null;
    if (document.querySelector("#customerNotificationBell")) {
        __bellInjected = true;
        return document.querySelector("#customerNotificationBell");
    }

    const host = findBellHost();

    // If the header host already has a visible notifications link, don't add a
    // second bell - just ensure the existing one carries an updatable badge.
    // (Skip links buried inside drop-down menus, e.g. the profile drop-down.)
    let existing = null;
    if (host) {
        existing = Array.prototype.slice.call(host.querySelectorAll("a[href='notifications.html']")).find(
            (a) => (a.querySelector(".fa-bell") || a.querySelector(".fa-regular.fa-bell")) &&
                   !a.closest(".dropdown-menu, .user-profile-menu, .dropdown")
        );
    }
    if (existing) {
        existing.classList.add("customer-notification-bell");
        existing.setAttribute("id", "customerNotificationBell");
        if (!existing.querySelector(".notification-badge")) {
            const b = document.createElement("span");
            b.className = "notification-badge";
            b.id = "customerNotificationBadge";
            b.style.display = "none";
            b.textContent = "";
            existing.appendChild(b);
        }
        __bellInjected = true;
        return existing;
    }

    const bell = document.createElement("a");
    bell.id = "customerNotificationBell";
    bell.className = "customer-notification-bell";
    bell.href = "notifications.html";
    bell.setAttribute("aria-label", "Notifications");
    bell.title = "Notifications";
    bell.innerHTML =
        '<i class="fa-solid fa-bell"></i>' +
        '<span class="notification-badge" id="customerNotificationBadge" style="display:none;"></span>';

    if (host) {
        host.appendChild(bell);
    } else {
        // Pin to top-right for pages without a matching header action group.
        document.body.appendChild(bell);
        bell.classList.add("fixed");
    }

    __bellInjected = true;
    return bell;
}

function updateBadge() {
    const token = getToken();
    if (!token) return;

    ensureNotificationBell();

    // Try to update notification badge if exists (customer header)
    const badge =
        document.getElementById("customerNotificationBadge") ||
        document.getElementById("notification-badge") ||
        document.querySelector(".notification-badge") ||
        document.getElementById("notifBadge");
    if (!badge) return;

    fetch(window.__API_URL + "/notifications/unread", {
        headers: { Authorization: `Bearer ${token}` }
    })
    .then(r => r.json())
    .then(data => {
        if (data.success && typeof data.count === "number") {
            badge.textContent = data.count > 0 ? data.count : "";
            badge.style.display = data.count > 0 ? "inline-flex" : "none";
            if (data.count > 0) {
                badge.classList.add("has-unread");
                const bell = document.getElementById("customerNotificationBell");
                if (bell) bell.classList.add("has-unread");
            } else {
                badge.classList.remove("has-unread");
                const bell = document.getElementById("customerNotificationBell");
                if (bell) bell.classList.remove("has-unread");
            }
        }
    })
    .catch(() => {});
}

function initCustomerRealtime() {
    const token = getToken();
    if (!token || !isCustomer()) return;

    // Ensure socket.io is loaded
    if (typeof io === "undefined") {
        // Dynamically load socket.io if not present
        const script = document.createElement("script");
        script.src = "/public/assets/vendor/js/socket.io-4.7.5.min.js";
        script.onload = () => {
            socketClient.connect(token);
            bindEvents();
        };
        document.head.appendChild(script);
    } else {
        socketClient.connect(token);
        bindEvents();
    }

    function bindEvents() {
        socketClient.on("notification:new", (notification) => {
            console.log("Real-time notification received:", notification);
            showToast(notification);
            updateBadge();
            // Dispatch global event for other handlers (e.g., order-tracking)
            window.dispatchEvent(new CustomEvent("customer:notification", { detail: notification }));
            // If on notifications page, trigger re-render
            if (document.getElementById("notifications-container")) {
                window.dispatchEvent(new CustomEvent("notification:refresh"));
            }
        });

        socketClient.on("order:status", (order) => {
            if (order && order.status) {
                // Notify about status changes for all delivery statuses
                const status = order.status.toLowerCase();
                const orderId = order.orderId || order.id || '';
                const refundStatus = String(order.refundStatus || "").toUpperCase();

                // Emit custom event for order-status pages to react. The refund
                // fields travel with it so the tracker can repaint its refund
                // banner without a second request.
                try {
                    window.dispatchEvent(new CustomEvent("order:status:update", {
                        detail: {
                            orderId: String(orderId),
                            status: order.status,
                            refundStatus: refundStatus,
                            refundAmount: order.refundAmount || 0,
                            refundReference: order.refundReference || null,
                            refundedAt: order.refundedAt || null,
                            paymentStatus: order.paymentStatus || null
                        }
                    }));
                } catch (e) { /* non-browser context */ }

                // A completed refund is the loudest thing that can happen to a
                // cancelled paid order - tell the customer immediately.
                if (refundStatus === "REFUNDED") {
                    showToast({
                        title: "Refund",
                        message: "Your payment has been refunded successfully.",
                        type: "success",
                        link: `/order-tracking.html?orderId=${orderId}`
                    });
                    return;
                }

                // Show toast for terminal statuses (completed, delivered, etc.)
                const terminalStatuses = ["completed", "delivered", "cancelled", "canceled", "failed"];
                if (terminalStatuses.includes(status)) {
                    const am = typeof window.getCurrentLanguage === "function" && window.getCurrentLanguage() === "am";
                    const title = order.status.charAt(0).toUpperCase() + order.status.slice(1);
                    const message = order.status === "completed"
                        ? (am ? "ትዕዛዙን ተጠናቋል።" : `Order #${orderId} is completed.`)
                        : (order.status === "delivered"
                            ? (am ? "ትዕዛዙን ተላልፋል።" : `Order #${orderId} has been delivered.`)
                            : (order.status === "cancelled"
                                ? (am ? "ትዕዛዙ ተሰርዟል።" : `Order #${orderId} has been cancelled.`)
                                : ""));
                    if (message) {
                        showToast({
                            title: title,
                            message: message,
                            type: "info",
                            link: `/order-tracking.html?orderId=${orderId}`
                        });
                    }
                }
            }
        });
    }

    // Initial badge update
    updateBadge();
}

// Add animation styles
if (!document.getElementById("customer-toast-styles")) {
    const style = document.createElement("style");
    style.id = "customer-toast-styles";
    style.textContent = `
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
        #customer-toast-container { font-family: inherit; }

        /* Notification bell injected into every customer header */
        .customer-notification-bell {
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 38px;
            height: 38px;
            border-radius: 50%;
            color: #475569;
            text-decoration: none;
            font-size: 17px;
            transition: background 0.2s ease, color 0.2s ease;
            flex-shrink: 0;
        }
        .customer-notification-bell:hover { color: #2563eb; background: rgba(37,99,235,0.08); }
        .customer-notification-bell.has-unread i { color: #2563eb; }
        .customer-notification-bell.fixed {
            position: fixed;
            top: 14px;
            right: 18px;
            z-index: 9990;
            background: #ffffff;
            box-shadow: 0 2px 10px rgba(15,23,42,0.15);
            border: 1px solid rgba(148,163,184,0.35);
        }
        .customer-notification-bell .notification-badge {
            position: absolute;
            top: 2px;
            right: 2px;
            min-width: 16px;
            height: 16px;
            padding: 0 4px;
            border-radius: 8px;
            background: #dc2626;
            color: #ffffff;
            font-size: 10px;
            font-weight: 700;
            line-height: 16px;
            text-align: center;
            box-shadow: 0 0 0 2px #ffffff;
        }
        .customer-notification-bell .notification-badge.has-unread { background: #dc2626; }
        [data-theme="dark"] .customer-notification-bell.fixed {
            background: #1e293b;
            border-color: rgba(148,163,184,0.4);
            color: #e2e8f0;
        }
        [data-theme="dark"] .customer-notification-bell.fixed:hover { color: #93c5fd; }
    `;
    document.head.appendChild(style);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCustomerRealtime);
} else {
    initCustomerRealtime();
}

// Also listen for storage changes (if notification arrived while offline, handled via DB fetch on next visit)
// Export for testing
export { showToast, initCustomerRealtime };

// Expose the badge updater so other scripts (e.g. notification.js "Clear All")
// can refresh the notification bell count after changes.
try {
    window.refreshNotificationBadge = updateBadge;
} catch (e) { /* ignore */ }
