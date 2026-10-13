/**
 * Smart Cafeteria - Delivery Staff Shared Helpers
 * Used by deliveries.js and history.js
 */

export function normalizeStatus(s) {
    return (s || "").toString().trim().toLowerCase().replace(/\s+/g, "_");
}

// Lookup a key from the shared i18n system (window.getText), falling back to
// the provided English string when the key is missing. Supports {var} placeholders.
export function tr(key, fallback, vars) {
    let s = "";
    try {
        if (window.getText) s = window.getText(key);
    } catch (e) {}
    if (!s || s === key) s = fallback || key;
    if (vars) {
        Object.keys(vars).forEach(function (k) {
            s = s.split("{" + k + "}").join(String(vars[k]));
        });
    }
    return s;
}

export function statusLabel(s) {
    const n = normalizeStatus(s);
    // 1) Shared status translator (upper-cases internally, resolves status_* keys).
    if (window.translateStatus) {
        const localized = window.translateStatus(s);
        if (localized && localized !== String(s == null ? "" : s).trim()) return localized;
    }
    // 2) Direct status_* key lookup for codes not covered by translateStatus.
    const viaKey = tr("status_" + n, "");
    if (viaKey) return viaKey;
    // 3) Last-resort English fallback (never reached once i18n keys exist).
    const map = {
        assigned: "Assigned",
        accepted: "Accepted",
        picked_up: "Picked Up",
        ready: "Ready for Delivery",
        ready_for_delivery: "Ready for Delivery",
        out_for_delivery: "Out for Delivery",
        arrived: "Arrived",
        delivered: "Delivered",
        completed: "Completed",
        pending: "Pending",
        preparing: "Preparing",
        cancelled: "Cancelled",
        pending_acceptance: "Awaiting Acceptance",
        declined: "Declined"
    };
    return map[n] || s || "—";
}

/**
 * The status a delivery card should render.
 *
 * The backend mirrors ASSIGNED and ACCEPTED onto the Order as PENDING (they are
 * pre-pickup states and must not disturb the kitchen board), so `order.status`
 * alone cannot tell a rider whether their new job is Assigned or Accepted. The
 * Delivery record's own state machine is authoritative and is always sent as
 * `deliveryStatus`, so prefer it and fall back to the order status only when it
 * is absent (older payloads).
 */
export function deliveryState(order) {
    const raw = order && (order.deliveryStatus || order.status);
    return normalizeStatus(raw);
}

export function statusClass(s) {
    const n = normalizeStatus(s);
    if (n === "out_for_delivery") return "status-out";
    if (n === "arrived") return "status-arrived";
    if (n === "delivered" || n === "completed") return "status-delivered";
    if (n === "picked_up") return "status-picked";
    return "status-ready";
}

export function money(v) {
    return Number(v || 0).toFixed(2) + " ETB";
}

export function esc(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}

export function itemsChips(items) {
    if (!Array.isArray(items) || !items.length) return "";
    const fallbackItem = tr("delivery_item", "Item");
    const chips = items.slice(0, 6).map((i) =>
        `<span class="item-chip">${esc(i.name || fallbackItem)} x${Number(i.quantity) || 1}</span>`
    );
    return '<div class="items-mini">' + chips.join("") + "</div>";
}

export function deliveryAddress(order) {
    const info = order.deliveryInfo || {};
    // Prefer the stored full address line; otherwise compose one from the
    // separate structured fields the checkout sends (city / area / kebele /
    // house number / street / landmark) so the courier card shows the same
    // destination the customer typed. Legacy subCity/location stay last.
    if (info.deliveryAddress) return info.deliveryAddress;
    const street = [info.streetArea, info.landmark].filter(Boolean).join(", ");
    const house = info.houseNumber ? "House Number: " + info.houseNumber : "";
    const parts = [house, street, info.area, info.kebele && info.kebele !== info.area ? info.kebele : null,
        info.city, info.subCity, info.location].filter(Boolean);
    const deduped = parts.filter((p, i) => parts.indexOf(p) === i);
    return deduped.join(", ") || "—";
}

export function deliveryPhone(order) {
    const info = order.deliveryInfo || {};
    return info.phone || order.customerPhone || "";
}

export function deliveryCoords(order) {
    const info = order.deliveryInfo || {};
    const lat = Number(info.latitude);
    const lng = Number(info.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return "";
    return lat.toFixed(6) + ", " + lng.toFixed(6);
}

export function navDestination(order) {
    const info = order.deliveryInfo || {};
    const lat = Number(info.latitude);
    const lng = Number(info.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
        return lat + "," + lng;
    }
    return info.deliveryAddress || [info.subCity, info.location].filter(Boolean).join(", ") || "";
}

export function navUrl(order) {
    const dest = navDestination(order);
    return dest ? "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(dest) : "";
}

/**
 * Toggle the Refresh button's loading state (spinner + disabled) while a
 * real backend refresh is in flight. Safe to call with a missing button.
 */
export function setRefreshLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
        if (btn.dataset.loading === "1") return;
        btn.dataset.loading = "1";
        btn.dataset.originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + tr("admin_refreshing", "Refreshing...");
    } else {
        if (btn.dataset.loading !== "1") return;
        delete btn.dataset.loading;
        btn.disabled = false;
        if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
        delete btn.dataset.originalHtml;
    }
}

/**
 * Map an API/network failure to the user-facing delivery error message.
 * Status codes come from api.js (error.status); no status => network/timeout.
 */
export function apiErrorMessage(error, fallback) {
    const status = error && typeof error.status === "number" ? error.status : null;
    if (status === 401) return tr("delivery_err_401", "Your session has expired. Please log in again.");
    if (status === 403) return tr("delivery_err_403", "You are not authorized to access this delivery.");
    if (status === 404) return tr("delivery_err_404", "Delivery not found.");
    if (status && status >= 500) return tr("delivery_err_500", "Unable to load delivery data. Please try again.");
    if (status) return (error && error.message) || fallback;
    const msg = (error && error.message) || "";
    if (error instanceof TypeError || /fetch|network|connect|timed?\s*out/i.test(msg)) {
        return tr("delivery_err_network", "Unable to connect to the server.");
    }
    return msg || fallback;
}

export function getMyUserId() {
    try {
        const cu = JSON.parse(localStorage.getItem("current_user"));
        if (cu && cu.id) return String(cu.id);
    } catch (e) {}
    try {
        const p = JSON.parse(localStorage.getItem("userProfile"));
        if (p && p.id) return String(p.id);
    } catch (e) {}
    return null;
}

export function isAssignedToMe(order, myUserId) {
    if (!myUserId || !order) return false;
    const staff = order.deliveryStaffAssigned;
    const staffId = staff?.id || staff?._id || staff; // handle object and string
    if (staffId && String(staffId) !== "[object Object]" && String(staffId) === String(myUserId)) return true;
    // Fallback: some rows carry the assignment only as the flat deliveryPersonId
    // (legacy / partial payloads). Without this the actual owner sees
    // "Awaiting Assignment", no action buttons and no GPS panel.
    const flat = order.deliveryPersonId;
    return Boolean(flat && String(flat) === String(myUserId));
}

export function acceptanceStatus(order) {
    return normalizeStatus(order.deliveryAcceptanceStatus || "pending_acceptance");
}

export function isPendingAcceptance(order) {
    return isAssignedToMe(order, getMyUserId()) && acceptanceStatus(order) === "pending_acceptance";
}

export function orderTimestamp() {
    return new Date().toLocaleTimeString();
}