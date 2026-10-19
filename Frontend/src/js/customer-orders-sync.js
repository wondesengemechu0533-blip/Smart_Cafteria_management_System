/**
 * Customer Order Sync
 * -----------------------------------------------------------------
 * When a customer logs back in (or returns to the site), their
 * localStorage order records are empty or stale. Their orders actually
 * live on the backend (GET /api/orders/my-orders).
 *
 * This module fetches the customer's real orders from the server and
 * rebuilds:
 *   - localStorage["latestOrder"]  -> the most recent active order,
 *                                     so the "Track Order" banner shows again
 *   - localStorage["orderHistory"] -> the full list of the customer's orders
 *
 * It is intentionally idempotent (never crashes) and only runs for a
 * logged-in customer. Existing local-only records are preserved/merged.
 */
import api from "./api.js";

function getToken() {
    return localStorage.getItem("auth_token");
}

function isCustomer() {
    // Role is stored inside the JSON "current_user" object (canonical, set by
    // auth.service.js). Fall back to top-level role/userRole keys if present.
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

/**
 * Keep the backend's canonical status so every consumer (order-status.js
 * timeline, order-history badges, active-order banner) can match it.
 *
 * The previous mapping rewrote `preparing` to the display label "In Progress",
 * which is not a timeline key: renderTimeline() then found no matching step and
 * left the Live Order Tracker completely unhighlighted. The delivery statuses
 * (picked_up / out_for_delivery / arrived / delivered) were missing entirely,
 * so a delivery order rendered as an unknown status too.
 */
function toDisplayStatus(status) {
    const s = (status || "").toString().trim().toLowerCase();
    // Normalize the legacy capitalized variants stored by older records.
    const map = {
        received: "pending",
        completed: "completed",
        canceled: "cancelled",
        in_progress: "preparing",
        "in progress": "preparing"
    };
    return map[s] || s;
}

// `delivered` is not terminal: the courier still has to close the delivery out,
// and that is the customer's final "Completed" step, so a delivered order must
// keep syncing until it is genuinely completed.
const TERMINAL_STATUSES = ["completed", "served", "cancelled", "canceled", "failed"];

function isActive(status) {
    return !TERMINAL_STATUSES.includes(toDisplayStatus(status));
}

/**
 * Only orders created today are shown to the customer (past/demo orders are hidden).
 * Records without a usable date are kept rather than dropped.
 */
function isTodaysOrder(record) {
    const d = new Date(record.createdAt || record.orderTime || record.orderDate);
    if (isNaN(d.getTime())) return true;
    const now = new Date();
    return d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
}

/**
 * Normalize a server order into the localStorage record shape the
 * customer pages expect (orderHistory / latestOrder).
 */
function toLocalRecord(serverOrder) {
    return {
        orderId: serverOrder.orderId,
        customerName: serverOrder.customerName,
        customerPhone: serverOrder.customerPhone,
        orderType: serverOrder.orderType,
        tableNumber: serverOrder.tableNumber,
        items: Array.isArray(serverOrder.items) ? serverOrder.items : [],
        subtotal: serverOrder.subtotal,
        serviceFee: serverOrder.serviceFee,
        totalAmount: serverOrder.totalAmount,
        status: toDisplayStatus(serverOrder.status),
        paymentMethod: serverOrder.paymentMethod,
        paymentStatus: serverOrder.paymentStatus,
        refundStatus: serverOrder.refundStatus,
        refundReference: serverOrder.refundReference,
        refundedAt: serverOrder.refundedAt,
        orderDate: serverOrder.orderDate,
        orderTime: serverOrder.orderTime
    };
}

async function syncMyOrders() {
    const token = getToken();
    if (!token || !isCustomer()) return;

    let serverOrders = [];
    try {
        const res = await api.get("/orders/my-orders?scope=all");
        serverOrders = res?.data?.orders || res?.orders || [];
    } catch (err) {
        // If the network or server is unavailable, keep local data as-is.
        console.log("Order sync skipped (server unreachable):", err?.message);
        return;
    }

    if (!Array.isArray(serverOrders)) return;

    const records = serverOrders
        .map((o) => toLocalRecord(o))
        .filter((r) => r.orderId) // only keep orders that carry an id
        .sort((a, b) => {
            const ta = a.orderDate || a.orderTime || "";
            const tb = b.orderDate || b.orderTime || "";
            return String(tb).localeCompare(String(ta));
        });

    const idOf = (r) => (r.orderId || r.id || "").replace(/^#/, "").trim();

    if (records.length === 0) {
        // The server has no orders for this user, but locally saved orders (for
        // example a guest checkout) must not be wiped - the order-history page
        // still shows them.
        const localLatest = JSON.parse(localStorage.getItem("latestOrder"));
        if (localLatest && !isTodaysOrder(localLatest)) {
            localStorage.removeItem("latestOrder");
        }
        window.dispatchEvent(new CustomEvent("customer:orders-synced", {
            detail: { latestOrder: null }
        }));
        return;
    }

    // Merge the server records into the existing orderHistory (authoritative
    // wins). Local-only records are preserved so a guest order saved at checkout
    // never disappears just because it is not attached to the account.
    const existing = JSON.parse(localStorage.getItem("orderHistory")) || [];
    const byId = new Map();
    existing.forEach((r) => {
        const k = idOf(r);
        if (k) byId.set(k, r);
    });
    records.forEach((r) => byId.set(idOf(r), r));
    const mergedHistory = Array.from(byId.values());
    localStorage.setItem("orderHistory", JSON.stringify(mergedHistory));

    // Determine the latest active order for the "Track Order" banner.
    const activeOrders = records.filter((r) => isActive(r.status));
    const latest = activeOrders.length > 0 ? activeOrders[0] : records[0];

    if (latest) {
        // Only overwrite latestOrder if we have a real one from the server.
        // active-order.js shows the banner only when latestOrder.status is not
        // "Completed", so an active order will reliably show the Track button again
        // after the customer logs back in.
        localStorage.setItem("latestOrder", JSON.stringify(latest));
    } else {
        // No orders today: clear any stale stored banner order from a past day.
        const localLatest = JSON.parse(localStorage.getItem("latestOrder"));
        if (localLatest && !isTodaysOrder(localLatest)) {
            localStorage.removeItem("latestOrder");
        }
    }

    // Notify pages (e.g. order-tracking) that fresh order data is available,
    // so they can re-render even if they initially found no local order.
    window.dispatchEvent(new CustomEvent("customer:orders-synced", {
        detail: { latestOrder: latest }
    }));
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncMyOrders);
} else {
    syncMyOrders();
}

export { syncMyOrders };