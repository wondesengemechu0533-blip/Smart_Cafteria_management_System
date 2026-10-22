function ohTr(key, fallback) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback);
  return fallback;
}
import { requestCancellation } from "./order-cancellation.js";
import { syncMyOrders } from "./customer-orders-sync.js";
import api from "./api.js";

const HIDDEN_ORDER_IDS_KEY = "orderHistoryHidden";

function getHiddenOrderIds() {
    try {
        return new Set(JSON.parse(localStorage.getItem(HIDDEN_ORDER_IDS_KEY)) || []);
    } catch (e) {
        return new Set();
    }
}

function saveHiddenOrderIds(ids) {
    try {
        localStorage.setItem(HIDDEN_ORDER_IDS_KEY, JSON.stringify(Array.from(ids)));
    } catch (e) { /* best-effort */ }
}

function orderRecordId(order) {
    return String(order.orderId || order.id || "").replace(/^#/, "").trim();
}

function filterOrdersLocally(orders, filterStatus) {
    const bucket = String(filterStatus || "all").trim().toLowerCase();
    if (bucket === "all") return orders;
    return orders.filter(order => {
        // `status` is the primary vocabulary; `orderStatus` is its
        // SCREAMING_SNAKE twin and the only one present on some legacy rows.
        const currentStatus = String(order.status || order.orderStatus || "pending").trim().toLowerCase();
        if (bucket === "completed") return currentStatus === "completed";
        if (bucket === "pending") return ["pending", "preparing", "ready", "arrived", "out_for_delivery", "delivered"].includes(currentStatus);
        if (bucket === "cancelled") return currentStatus === "cancelled";
        if (bucket === "refunded") {
            return String(order.paymentStatus || "").toUpperCase() === "REFUNDED" ||
                String(order.refundStatus || "").toUpperCase() === "REFUNDED" ||
                String(order.refundStatus || "").toUpperCase() === "REFUND_REQUESTED" ||
                String(order.refundStatus || "").toUpperCase() === "REFUND_PROCESSING";
        }
        return true;
    });
}

function __registerLangChange(fn) {
  var reg = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
  if (typeof reg === 'function') reg(fn);
  window.addEventListener('language:changed', fn);
  window.addEventListener('languageChanged', fn);
}


function isAmharic() {
    return typeof window.getCurrentLanguage === "function" && window.getCurrentLanguage() === "am";
}

/**
 * Attached to window so that HTML onclick="cancelOrder('ID')" works without scope issues.
 * Submits a real cancellation request to the backend; only updates localStorage on success.
 */
window.cancelOrder = async function(orderId) {
    const am = isAmharic();
    if (!confirm(am ? `ትዕዛዙን #${orderId} መሰረዝ ይፈልጋሉ?` : `Are you sure you want to cancel order #${orderId}?`)) {
        return;
    }

    try {
        const result = await requestCancellation(orderId, "CUSTOMER_CHANGED_MIND", "Cancelled by customer from order history");

        if (!result || result.success !== true) {
            alert((result && result.error) || ohTr("cancel_request_failed", am ? "የስረዛ ጥያቄ ማስገባት አልተሳካም።" : "Cancellation request could not be submitted."));
            return;
        }

        let historyData = JSON.parse(localStorage.getItem("orderHistory")) || [];
        let latestOrder = JSON.parse(localStorage.getItem("latestOrder"));
        let isUpdated = false;

        historyData = historyData.map(order => {
            const id = order.orderId || order.id;
            if (String(id) === String(orderId)) {
                order.status = "Cancelled";
                isUpdated = true;
            }
            return order;
        });

        if (latestOrder) {
            const latestId = latestOrder.orderId || latestOrder.id;
            if (String(latestId) === String(orderId)) {
                latestOrder.status = "Cancelled";
                localStorage.setItem("latestOrder", JSON.stringify(latestOrder));
                isUpdated = true;
            }
        }

        if (isUpdated) {
            localStorage.setItem("orderHistory", JSON.stringify(historyData));
        }

        alert(ohTr("cancel_request_submitted", am ? "የስረዛ ጥያቄ በተሳካ ሁኔታ ቀርቧል። በአስተዳዳሪው ይገመገማል።" : "Cancellation request submitted successfully. It will be reviewed by an administrator."));
        location.reload();
    } catch (error) {
        alert(error.message || ohTr("cancel_request_failed", am ? "የስረዛ ጥያቄ ማስገባት አልተሳካም።" : "Failed to submit the cancellation request."));
    }
};

document.addEventListener("DOMContentLoaded", async () => {
    const historyListContainer = document.getElementById("orders-history-list");
    const filterTabs = document.querySelectorAll(".history-tab");
    const clearHistoryBtn = document.getElementById("clear-history-btn");

    // This module is also imported by pages that have no history list (menu,
    // order-tracking); nothing to bind there.
    if (!historyListContainer) return;

    function getOrdersArray() {
        let historyData = JSON.parse(localStorage.getItem("orderHistory")) || [];
        const singleOrder = JSON.parse(localStorage.getItem("latestOrder"));

        if (singleOrder) {
            const singleId = singleOrder.orderId || singleOrder.id;
            const exists = historyData.some(o => (o.orderId || o.id) === singleId);
            if (!exists) {
                historyData.unshift(singleOrder);
            } else {
                historyData = historyData.map(o => {
                    if ((o.orderId || o.id) === singleId) {
                        return singleOrder;
                    }
                    return o;
                });
            }
        }

        // Show the customer's full order history (all dates), not just today.
        return historyData;
    }

    function statusText(status) {
        const localized = window.translateStatus ? window.translateStatus(status) : "";
        if (localized && String(localized).toUpperCase() !== String(status || "").toUpperCase()) return localized;
        return status;
    }

    let lastRenderedOrders = [];
    let renderSeq = 0;
    let activeFilter = "all";

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function bindRetry() {
        const retryBtn = document.getElementById("history-retry-btn");
        if (retryBtn) retryBtn.addEventListener("click", () => renderOrders(activeFilter));
    }

    function errorStatus(error) {
        const n = Number(error && error.status);
        return Number.isFinite(n) ? n : 0;
    }

    function renderErrorCard(error) {
        const am = isAmharic();
        const status = errorStatus(error);

        // 401 is the ONLY status that means the login itself is bad (token
        // missing, expired or rejected). Signing in again is the sole fix, so
        // that is the honest message.
        if (status === 401) {
            historyListContainer.innerHTML = `
                <div class="empty-history-card" style="text-align: center; padding: 40px; background: #fff; border-radius: 8px;">
                    <i class="fa-solid fa-lock" style="font-size: 3rem; color: #9ca3af; margin-bottom: 12px;"></i>
                    <h3>${am ? "ክፍለ ጊዜዎ አልፏል" : "Your session has expired"}</h3>
                    <p>${am ? "እባክዎ ትዕዛዞችዎን ለማየት እንደገና ይግቡ።" : "Please sign in again to view your orders."}</p>
                    <a href="../common/login.html" class="btn btn-primary" style="margin-top: 12px; display: inline-block;">${am ? "ግባ" : "Sign In"}</a>
                </div>
            `;
            return;
        }

        // 403 means the session is FINE but the account is not allowed to read
        // order history (blocked/suspended, or not a customer account). Saying
        // "your session has expired" here would be a lie and would send a
        // perfectly signed-in user back to the login page for nothing.
        if (status === 403) {
            historyListContainer.innerHTML = `
                <div class="empty-history-card" style="text-align: center; padding: 40px; background: #fff; border-radius: 8px;">
                    <i class="fa-solid fa-ban" style="font-size: 3rem; color: #ef4444; margin-bottom: 12px;"></i>
                    <h3>${am ? "ወደ ትዕዛዞች ታሪክ መግባት አይቻልም" : "Can't access order history"}</h3>
                    <p>${escapeHtml((error && error.message) || (am ? "መለያዎ ትዕዛዞችን የማየት ፈቃድ የለውም።" : "Your account isn't allowed to view order history."))}</p>
                    <button id="history-retry-btn" class="btn btn-primary" type="button" style="margin-top: 12px;">
                        <i class="fa-solid fa-rotate-right"></i> ${am ? "እንደገና ሞክር" : "Retry"}
                    </button>
                </div>
            `;
            bindRetry();
            return;
        }

        // Everything else - a dropped connection, a timeout, a 5xx, or an
        // unreachable/incorrect API URL - is NOT an authentication failure.
        // Never claim the session expired; offer a retry instead.
        historyListContainer.innerHTML = `
            <div class="empty-history-card" style="text-align: center; padding: 40px; background: #fff; border-radius: 8px;">
                <i class="fa-solid fa-triangle-exclamation" style="font-size: 3rem; color: #f59e0b; margin-bottom: 12px;"></i>
                <h3>${am ? "ትዕዛዞችዎን መጫን አልተሳካም" : "Couldn't load your orders"}</h3>
                <p>${escapeHtml((error && error.message) || (am ? "እባክዎ ግንኙነትዎን ያረጋግጡ እና እንደገና ይሞክሩ።" : "Please check your connection and try again."))}</p>
                <button id="history-retry-btn" class="btn btn-primary" type="button" style="margin-top: 12px;">
                    <i class="fa-solid fa-rotate-right"></i> ${am ? "እንደገና ሞክር" : "Retry"}
                </button>
            </div>
        `;
        bindRetry();
    }

    function renderEmptyCard(isFiltered, filterStatus) {
        if (isFiltered) {
            historyListContainer.innerHTML = `
                <div class="empty-history-card" style="text-align: center; padding: 30px; background: #fff; border-radius: 8px;">
                    <p>No orders found under "${escapeHtml(filterStatus)}".</p>
                </div>
            `;
            return;
        }
        historyListContainer.innerHTML = `
            <div class="empty-history-card" style="text-align: center; padding: 40px; background: #fff; border-radius: 8px;">
                <i class="fa-solid fa-receipt" style="font-size: 3rem; color: #9ca3af; margin-bottom: 12px;"></i>
                <h3>No Past Orders Found</h3>
                <p>You haven't placed any food orders yet.</p>
                <a href="menu.html" class="btn btn-primary" style="margin-top: 12px; display: inline-block;">Browse Menu</a>
            </div>
        `;
    }

    async function fetchServerOrders() {
        try {
            const res = await api.get("/orders/my-orders?scope=all");
            const payload = res && res.data ? res.data : (res || {});
            const list = Array.isArray(payload.orders)
                ? payload.orders
                : Array.isArray(payload) ? payload : [];
            return { ok: true, orders: list };
        } catch (error) {
            return { ok: false, error };
        }
    }

    async function renderOrders(filterStatus = "all") {
        if (!historyListContainer) return;

        activeFilter = filterStatus;
        const seq = ++renderSeq;
        historyListContainer.innerHTML = `
            <div class="empty-history-card" style="text-align: center; padding: 30px; background: #fff; border-radius: 8px;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: #9ca3af;"></i>
                <p style="margin-top: 10px;">${ohTr("loading_history", "Loading history...")}</p>
            </div>
        `;

        // Fetch the customer's real orders from the backend.
        const result = await fetchServerOrders();

        // A newer tab click / refresh may have superseded this request.
        if (seq !== renderSeq) return;

        // The backend is the source of truth. Locally saved orders are used
        // ONLY as a fallback when the API request failed, never to fabricate
        // history or to override what the server returns.
        let merged = result.ok
            ? (result.orders || []).slice()
            : getOrdersArray();

        merged = merged
            .sort((a, b) => {
                const ta = new Date(a.createdAt || a.orderTime || a.orderDate || 0).getTime() || 0;
                const tb = new Date(b.createdAt || b.orderTime || b.orderDate || 0).getTime() || 0;
                return tb - ta;
            });

        // Hide orders the customer explicitly cleared from their local history.
        const hidden = getHiddenOrderIds();
        const orders = filterOrdersLocally(merged, filterStatus)
            .filter(o => !hidden.has(orderRecordId(o)));

        if (seq !== renderSeq) return;
        lastRenderedOrders = orders;

        if (orders.length === 0) {
            if (result.ok) {
                // Only a SUCCESSFUL request may claim the customer has no orders.
                renderEmptyCard(String(filterStatus || "all").toLowerCase() !== "all", filterStatus);
            } else {
                renderErrorCard(result.error);
            }
            return;
        }

        // The API failed but there are saved orders to show: keep them visible
        // and be transparent that live data could not be loaded.
        const warning = result.ok ? "" : `
            <div class="history-warning" style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px; padding: 10px 14px; background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; color: #92400e; font-size: 0.9rem;">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span style="flex: 1;">Showing saved orders — live data could not be loaded.</span>
                <button id="history-retry-btn" type="button" class="btn btn-sm" style="background: #92400e; color: #fff; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer;">
                    <i class="fa-solid fa-rotate-right"></i> Retry
                </button>
            </div>`;

        const filteredOrders = orders;

        let html = "";
        filteredOrders.forEach((order) => {
            const id = order.orderId || order.id || "ET-0000";
            const status = order.status || order.orderStatus || "Pending";
            
            let statusClass = "status-tag-progress";
            const statusKey = String(status).trim().toLowerCase();
            if (statusKey === "completed" || statusKey === "served") statusClass = "status-tag-completed";
            if (statusKey === "cancelled" || statusKey === "canceled") statusClass = "status-tag-cancelled";

            const refunded = String(order.paymentStatus || "").toUpperCase() === "REFUNDED";
            const refundRequested = String(order.refundStatus || "").toUpperCase() === "REFUND_REQUESTED" ||
                                    String(order.refundStatus || "").toUpperCase() === "REFUND_PROCESSING";
            const showRefundTag = refunded || refundRequested;
            const refundTag = showRefundTag
                ? `<span class="status-tag" style="margin-left: 6px; padding: 4px 10px; border-radius: 20px; font-weight: 600; font-size: 0.85rem; ${refunded ? 'background: #e0e7ff; color: #4338ca;' : 'background: #fef3c7; color: #92400e;'}"><i class="fa-solid fa-rotate-left"></i> ${refunded ? 'Refunded' : 'Refund Pending'}</span>`
                : "";
            const refundInfoLine = showRefundTag
                ? `<div class="refund-line" style="margin-top: 6px; font-size: 0.85rem; ${refunded ? 'color: #4338ca;' : 'color: #92400e;'}"><i class="fa-solid fa-rotate-left"></i> ${refunded ? 'Refunded' : 'Refund Pending — processing by admin'}${order.refundReference ? " · Ref " + order.refundReference : ""}${order.refundedAt ? " · " + new Date(order.refundedAt).toLocaleString() : ""}</div>`
                : "";

            const items = order.items || [];
            const itemPills = items.map(item => `
                <span class="history-item-pill" style="background: #f3f4f6; padding: 4px 8px; border-radius: 4px; font-size: 0.85rem; margin-right: 6px; display: inline-block; margin-bottom: 4px;">
                    <strong>${item.quantity}x</strong> ${item.name}
                </span>
            `).join("");

            // Show Cancel Button ONLY for active orders
            const canCancel = !["completed", "served", "cancelled", "canceled", "failed"].includes(String(status).trim().toLowerCase());
            const cancelButton = canCancel ? `
                <button class="btn btn-outline-danger btn-sm" onclick="cancelOrder('${id}')" style="color: #dc3545; border: 1px solid #dc3545; background: transparent; padding: 6px 12px; border-radius: 6px; cursor: pointer;">
                    <i class="fa-solid fa-ban"></i> Cancel Order
                </button>
            ` : "";

            html += `
                <div class="order-history-card" style="background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; margin-bottom: 16px;">
                    <div class="card-top-row" style="display: flex; justify-content: space-between; align-items: center;">
                        <div class="order-id-date">
                            <strong class="order-number" style="font-size: 1.1rem;">#${id}</strong>
                            <small class="order-date" style="margin-left: 10px; color: #6b7280;"><i class="fa-solid fa-calendar-day"></i> ${order.orderDate || "Today"}</small>
                        </div>
                        <span class="status-tag ${statusClass}" style="padding: 4px 10px; border-radius: 20px; font-weight: 600; font-size: 0.85rem; ${String(status).trim().toLowerCase() === 'cancelled' ? 'background: #fde8e8; color: #f05252;' : ''}">${statusText(status)}</span>${refundTag}
                    </div>

                    <div class="card-middle-row" style="margin: 12px 0;">
                        <div class="order-items-preview">
                            ${itemPills}
                        </div>
                        <div class="order-total-price" style="margin-top: 8px; font-size: 1rem;">
                            <small style="color: #6b7280;">Total:</small>
                            <strong>${order.totalAmount || 0} ETB</strong>
                        </div>
                        ${refundInfoLine}
                    </div>

                    <div class="card-bottom-row" style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #f3f4f6; padding-top: 12px;">
                        <span class="table-info" style="color: #4b5563;">
                            <i class="fa-solid fa-utensils"></i> ${order.orderType === "dine-in" ? `Table ${order.tableNumber || '-'}` : "Takeaway"}
                        </span>
                        <div class="action-buttons" style="display: flex; gap: 8px;">
                            <a href="order-tracking.html?orderId=${id}" class="btn btn-secondary btn-sm" style="background: #f3f4f6; color: #374151; padding: 6px 12px; border-radius: 6px; text-decoration: none;">
                                <i class="fa-solid fa-eye"></i> Details
                            </a>
                            ${cancelButton}
                        </div>
                    </div>
                </div>
            `;
        });

        historyListContainer.innerHTML = warning + html;
        if (!result.ok) bindRetry();
    }

    // Filter Buttons Listener
    filterTabs.forEach(tab => {
        tab.addEventListener("click", (e) => {
            filterTabs.forEach(t => t.classList.remove("active"));
            e.target.classList.add("active");
            activeFilter = e.target.getAttribute("data-filter") || "all";
            renderOrders(activeFilter);
        });
    });

    // Clear History Listener
    if (clearHistoryBtn) {
        clearHistoryBtn.addEventListener("click", () => {
            const am = isAmharic();
            const msg = ohTr("cancel_clear_history", am ? "ሁሉንም የትዕዛዝ ታሪክ ማጽዳት ይፈልጋሉ?" : "Are you sure you want to clear your entire order history?");
            if (!confirm(msg)) return;

            // Remember the currently shown orders so the backend list cannot
            // immediately bring them back, then drop the local cache too.
            const hidden = getHiddenOrderIds();
            lastRenderedOrders.forEach(o => {
                const id = orderRecordId(o);
                if (id) hidden.add(id);
            });
            saveHiddenOrderIds(hidden);
            localStorage.removeItem("orderHistory");
            localStorage.removeItem("latestOrder");
            renderOrders(activeFilter);
        });
    }

    // Keep localStorage in sync for other pages, but do not block the first
    // render on it - renderOrders() reads the backend directly.
    syncMyOrders().catch(() => { /* best-effort */ });
    renderOrders(activeFilter);

    // Re-render when the backend sync finishes populating localStorage, so the
    // page does not stay empty due to a render/sync race.
    window.addEventListener("customer:orders-synced", () => {
        try { renderOrders(activeFilter); } catch (e) { /* best-effort */ }
    });

    // Keep the list current without a full reload or a new login: refresh when
    // the tab regains focus and whenever the customer's order state changes
    // (real-time socket events dispatched by customer-realtime.js).
    let refreshTimer = null;
    const scheduleRefresh = () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            try { renderOrders(activeFilter); } catch (e) { /* best-effort */ }
        }, 300);
    };
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) scheduleRefresh();
    });
    window.addEventListener("focus", scheduleRefresh);
    window.addEventListener("order:status:update", scheduleRefresh);
    window.addEventListener("customer:notification", scheduleRefresh);

    __registerLangChange(() => {
        try {
            if (!document.getElementById("orders-history-list")) return;
            renderOrders(activeFilter);
        } catch (e) { /* best-effort re-render */ }
    });
});