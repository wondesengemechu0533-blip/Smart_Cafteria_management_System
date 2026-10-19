function __registerLangChange(fn) {
  var reg = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
  if (typeof reg === 'function') reg(fn);
  window.addEventListener('language:changed', fn);
  window.addEventListener('languageChanged', fn);
}

document.addEventListener("DOMContentLoaded", () => {
    const notificationsContainer = document.getElementById("notifications-container");
    const markAllReadBtn = document.getElementById("mark-all-read-btn");
    const clearAllBtn = document.getElementById("clear-notifications-btn");

    // Text taken from the API (notification bodies, refund meta) must not be
    // able to inject markup into this page.
    function escapeHtml(value) {
        const div = document.createElement("div");
        div.textContent = value == null ? "" : String(value);
        return div.innerHTML;
    }

    function getLang() {
        try { return (window.getCurrentLanguage && window.getCurrentLanguage()) || localStorage.getItem("scos_language") || localStorage.getItem("cafeteria_language") || "en"; } catch (e) { return "en"; }
    }

    // Load notifications from backend API
    async function getNotifications() {
        try {
            const token = localStorage.getItem("auth_token");
            if (!token) {
                renderEmpty((typeof window.tr === "function" ? window.tr("notif_login_required", "Please log in to view notifications.") : "Please log in to view notifications."));
                return [];
            }
            const response = await fetch(window.__API_URL + "/notifications", {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await response.json();
            if (data.success && data.notifications) {
                return data.notifications;
            }
            return [];
        } catch (err) {
            console.error("Failed to load notifications:", err);
            renderEmpty((typeof window.tr === "function" ? window.tr("notif_load_failed", "Failed to load notifications.") : "Failed to load notifications."));
            return [];
        }
    }

    function renderEmpty(message) {
        if (!notificationsContainer) return;
        const isAm = getLang() === "am";
        notificationsContainer.innerHTML = `
            <div class="empty-state-card">
                <i class="fa-regular fa-bell-slash empty-icon"></i>
                <h3>${typeof window.tr === "function" ? window.tr("notif_none", isAm ? "ምንም ማሳወቂያ የለም" : "No Notifications") : (isAm ? "ምንም ማሳወቂያ የለም" : "No Notifications")}</h3>
                <p>${message}</p>
            </div>
        `;
    }

    // Render notifications
    async function renderNotifications() {
        const list = await getNotifications();

        if (!list || list.length === 0) {
            renderEmpty((typeof window.tr === "function" ? window.tr("notif_no_recent", "You have no recent alerts or order updates right now.") : "You have no recent alerts or order updates right now."));
            return;
        }

        let html = "";
        list.forEach(item => {
            const unreadClass = item.isRead ? "" : "unread";

            // Icon based on notification type
            let iconClass = "fa-bell";
            let iconBg = "icon-system";
            if (item.type === "order" || item.type === "status_update" || item.type === "ready") {
                iconClass = "fa-utensils";
                iconBg = "icon-order";
            } else if (item.type === "promo") {
                iconClass = "fa-tags";
                iconBg = "icon-promo";
            } else if (item.type === "refund") {
                // A completed refund is a money event, not an order status ping:
                // it gets its own icon so the customer can spot it in the list.
                iconClass = "fa-arrow-rotate-left";
                iconBg = "icon-refund";
            }

            // Refund notices carry the machine-readable details in meta, so the
            // card can show order number / amount / status / timestamp even if
            // the message is reworded later.
            const meta = item.meta || {};
            const refundDetail =
                item.type === "refund" && (meta.refundAmount || meta.refundStatus)
                    ? `<div class="notification-meta">
                           ${meta.refundStatus ? `<span class="meta-chip"><i class="fa-solid fa-circle-check"></i> ${escapeHtml(meta.refundStatus)}</span>` : ""}
                           ${meta.refundedAt ? `<span class="meta-chip"><i class="fa-regular fa-clock"></i> ${escapeHtml(new Date(meta.refundedAt).toLocaleString())}</span>` : ""}
                       </div>`
                    : "";

            html += `
                <div class="notification-item ${unreadClass}" data-id="${item.id}">
                    <div class="notification-icon ${iconBg}">
                        <i class="fa-solid ${iconClass}"></i>
                    </div>
                    <div class="notification-body">
                        <div class="notification-title-row">
                            <h4>${item.title}</h4>
                            <span class="notification-time">${item.timeAgo || ''}</span>
                        </div>
                        <p>${item.message}</p>
                        ${refundDetail}
                    </div>
                    <button class="delete-notif-btn" data-id="${item.id}" title="Remove">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            `;
        });

        notificationsContainer.innerHTML = html;
        attachEventListeners();
    }

    // Attach event listeners
    function attachEventListeners() {
        document.querySelectorAll(".notification-item").forEach(item => {
            item.addEventListener("click", (e) => {
                if (e.target.closest(".delete-notif-btn")) return;
                const id = item.getAttribute("data-id");
                markAsRead(id);
            });
        });

        document.querySelectorAll(".delete-notif-btn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const id = btn.getAttribute("data-id");
                deleteNotification(id);
            });
        });
    }

    async function markAsRead(id) {
        try {
            const token = localStorage.getItem("auth_token");
            await fetch(window.__API_URL + `/notifications/${id}/read`, {
                method: "PATCH",
                headers: { Authorization: `Bearer ${token}` }
            });
            renderNotifications();
            window.dispatchEvent(new CustomEvent("notification:refresh"));
        } catch (err) {
            console.error("Failed to mark as read:", err);
        }
    }

    async function deleteNotification(id) {
        try {
            const token = localStorage.getItem("auth_token");
            await fetch(window.__API_URL + `/notifications/${id}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` }
            });
            renderNotifications();
            window.dispatchEvent(new CustomEvent("notification:refresh"));
        } catch (err) {
            console.error("Failed to delete notification:", err);
        }
    }

    // Mark All as Read
    if (markAllReadBtn) {
        markAllReadBtn.addEventListener("click", async () => {
            try {
                const token = localStorage.getItem("auth_token");
                await fetch(window.__API_URL + "/notifications/read-all", {
                    method: "PATCH",
                    headers: { Authorization: `Bearer ${token}` }
                });
                renderNotifications();
                // The bell badge shows unread counts, so it must follow.
                window.dispatchEvent(new CustomEvent("notification:refresh"));
                if (typeof window.refreshNotificationBadge === "function") {
                    window.refreshNotificationBadge();
                }
            } catch (err) {
                console.error("Failed to mark all as read:", err);
            }
        });
    }

    // Clear All - actually delete all notifications
    if (clearAllBtn) {
        clearAllBtn.addEventListener("click", async () => {
            // Deleting is irreversible, so it must only run when the user
            // CONFIRMS. The condition used to be inverted, which wiped every
            // notification on Cancel and did nothing on OK.
            const ok = confirm((typeof window.tr === "function" ? window.tr("notif_clear_confirm", "Are you sure you want to clear all notifications?") : "Are you sure you want to clear all notifications?"));
            if (!ok) return;
            try {
                const token = localStorage.getItem("auth_token");
                await fetch(window.__API_URL + "/notifications", {
                    method: "DELETE",
                    headers: { Authorization: `Bearer ${token}` }
                });
                renderNotifications();
                // Keep the header/bell unread badge in sync.
                window.dispatchEvent(new CustomEvent("notification:refresh"));
                if (typeof window.refreshNotificationBadge === "function") {
                    window.refreshNotificationBadge();
                }
            } catch (err) {
                console.error("Failed to clear all notifications:", err);
            }
        });
    }

    // Real-time notification via Socket.IO
    function setupRealtimeListener() {
        const token = localStorage.getItem("auth_token");
        if (!token || typeof io === "undefined") return;

        const socket = io(window.__API_BASE, {
            auth: { token },
            transports: ["websocket", "polling"]
        });

        socket.on("notification:new", (notification) => {
            renderNotifications();
            // The bell badge lives outside this list, so refresh it whenever a
            // new row arrives.
            window.dispatchEvent(new CustomEvent("notification:refresh"));
            if (typeof window.refreshNotificationBadge === "function") {
                window.refreshNotificationBadge();
            }
        });
    }

    // Re-render the notifications list instantly when the language changes.
    __registerLangChange(() => {
        try { renderNotifications(); } catch (e) {}
    });

    renderNotifications();
    setupRealtimeListener();
});
