/**
 * Delivery Staff - Delivery History
 *
 * Reads the rider's own finished runs from GET /deliveries/my-history (terminal
 * states only: COMPLETED / FAILED / CANCELLED) and the matching totals from
 * GET /deliveries/stats. Everything rendered here comes from those two
 * authenticated, JWT-scoped responses - there is no local sample data.
 *
 * Every stage timestamp shown in a row is the value the backend stamped when
 * the transition actually happened (`serializeDelivery`):
 *   deliveryAssignedAt -> deliveryAcceptedAt -> pickedUpAt ->
 *   deliveryStartedAt -> deliveryArrivedAt -> deliveredAt -> completedAt
 * A `—` therefore means "this stage was never reached", never "unknown".
 */
import api from "../api.js";
import { socketClient } from "../socket.js";
import {
    statusLabel,
    money,
    esc,
    tr,
    deliveryAddress,
    normalizeStatus,
    apiErrorMessage,
    setRefreshLoading
} from "./shared.js";

function __registerLangChange(fn) {
    var reg = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
    if (typeof reg === 'function') reg(fn);
    window.addEventListener('language:changed', fn);
    window.addEventListener('languageChanged', fn);
}

const $ = (id) => document.getElementById(id);

let history = [];
let stats = {};

/**
 * The stage timestamps, in delivery order. `key` is the serialized field on the
 * delivery summary; `labelKey` is the i18n key for the column header.
 */
const STAGES = [
    { key: "deliveryAssignedAt", labelKey: "delivery_stage_assigned", fallback: "Assigned" },
    { key: "deliveryAcceptedAt", labelKey: "delivery_stage_accepted", fallback: "Accepted" },
    { key: "pickedUpAt", labelKey: "delivery_stage_picked_up", fallback: "Pickup" },
    { key: "deliveryStartedAt", labelKey: "delivery_stage_out", fallback: "Out for Delivery" },
    { key: "deliveryArrivedAt", labelKey: "delivery_stage_arrived", fallback: "Arrived" },
    { key: "deliveredAt", labelKey: "delivery_stage_delivered", fallback: "Delivered" },
    { key: "completedAt", labelKey: "delivery_stage_completed", fallback: "Completed" }
];

/**
 * The moment a run finished - used for filtering and for the "Delivered Today"
 * fallback. Falls back through the real stamps so a row is never undated.
 */
function finishedAt(o) {
    return o.completedAt || o.deliveredAt || o.createdAt || o.orderDate || null;
}

function dateValue(value) {
    const d = value ? new Date(value) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
}

function stageCell(value) {
    const d = dateValue(value);
    if (!d) return '<td class="stage is-empty">—</td>';
    return (
        '<td class="stage" title="' +
        esc(d.toLocaleString()) +
        '"><span class="stage-date">' +
        esc(d.toLocaleDateString()) +
        '</span><span class="stage-time">' +
        esc(d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) +
        "</span></td>"
    );
}

/** Pickup -> handover in minutes, from the two stamps the backend recorded. */
function durationLabel(o) {
    const start = dateValue(o.pickedUpAt);
    const end = dateValue(o.deliveredAt);
    if (!start || !end) return "—";
    const mins = Math.round((end.getTime() - start.getTime()) / 60000);
    if (!Number.isFinite(mins) || mins < 0) return "—";
    if (mins < 60) return mins + " min";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? h + "h " + m + "m" : h + "h";
}

function matchesFilters(o) {
    const query = ($("filterSearch").value || "").trim().toLowerCase();
    if (query) {
        const haystack = [
            o.orderId,
            o.customerName,
            o.customerPhone,
            o.deliveryAddress || deliveryAddress(o)
        ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
        if (haystack.indexOf(query) === -1) return false;
    }

    const wanted = ($("filterStatus").value || "all").toLowerCase();
    if (wanted !== "all") {
        const current = normalizeStatus(o.deliveryStatus || o.status);
        // FAILED/CANCELLED rows may still carry their last successful stage as
        // `status` on the order, so the delivery record wins; fall back to the
        // order status only when it is absent.
        const terminal = normalizeStatus(o.status);
        if (current !== wanted && terminal !== wanted) return false;
    }

    const fromRaw = $("filterFrom").value;
    const toRaw = $("filterTo").value;
    if (fromRaw || toRaw) {
        const when = dateValue(finishedAt(o));
        if (!when) return false;
        // `<input type="date">` values are local-midnight day bounds, so the
        // upper bound has to include the whole end day.
        if (fromRaw) {
            const from = new Date(fromRaw + "T00:00:00");
            if (!Number.isNaN(from.getTime()) && when < from) return false;
        }
        if (toRaw) {
            const to = new Date(toRaw + "T23:59:59.999");
            if (!Number.isNaN(to.getTime()) && when > to) return false;
        }
    }

    return true;
}

function visibleHistory() {
    return history.filter(matchesFilters);
}

function render() {
    const container = $("historyContainer");
    if (!container) return;

    const rows = visibleHistory();

    const countEl = $("historyCount");
    if (countEl) {
        countEl.textContent =
            rows.length === history.length
                ? tr("delivery_history_showing_all", "{n} record(s)").replace("{n}", rows.length)
                : tr("delivery_history_showing", "{shown} of {total} record(s)")
                      .replace("{shown}", rows.length)
                      .replace("{total}", history.length);
    }

    if (!rows.length) {
        container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-clipboard-list"></i><p>${
            history.length
                ? esc(tr("delivery_empty_filtered", "No history records match these filters."))
                : esc(tr("delivery_empty_history", "No delivered orders yet."))
        }</p></div>`;
        return;
    }

    const head = STAGES.map(
        (s) => `<th>${esc(tr(s.labelKey, s.fallback))}</th>`
    ).join("");

    const body = rows
        .map((o) => {
            const address = deliveryAddress(o);
            return `<tr>
                <td><strong>#${esc(o.orderId)}</strong></td>
                <td class="cust-cell">${esc(o.customerName)}${address && address !== "—" ? `<small>${esc(address)}</small>` : ""}</td>
                <td>${esc(statusLabel(o.deliveryStatus || o.status))}</td>
                ${STAGES.map((s) => stageCell(o[s.key])).join("")}
                <td class="dur-cell">${esc(durationLabel(o))}</td>
                <td>${money(o.totalAmount)}</td>
            </tr>`;
        })
        .join("");

    container.innerHTML = `
        <div class="table-responsive"><table class="history-table">
            <thead><tr>
                <th>${esc(tr("delivery_th_order", "Order"))}</th>
                <th>${esc(tr("delivery_th_customer", "Customer"))}</th>
                <th>${esc(tr("delivery_th_status", "Status"))}</th>
                ${head}
                <th>${esc(tr("delivery_th_duration", "Duration"))}</th>
                <th>${esc(tr("delivery_th_total", "Total"))}</th>
            </tr></thead>
            <tbody>${body}</tbody>
        </table></div>
    `;
}

function resetFilters() {
    if ($("filterSearch")) $("filterSearch").value = "";
    if ($("filterStatus")) $("filterStatus").value = "all";
    if ($("filterFrom")) $("filterFrom").value = "";
    if ($("filterTo")) $("filterTo").value = "";
    render();
}

async function loadHistory() {
    const refreshBtn = $("refreshBtn");
    setRefreshLoading(refreshBtn, true);
    try {
        const data = await api.get("/deliveries/my-history");
        history = (data && data.orders) || [];

        const statsData = await api.get("/deliveries/stats");
        stats = (statsData && statsData.stats) || {};

        // Authoritative all-time delivered count for THIS rider (JWT-scoped).
        // 0 is a valid value - do not fall through with `||`.
        $("statTotal").textContent = Number.isFinite(stats.myDelivered)
            ? stats.myDelivered
            : history.length;

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const deliveredToday = history.filter((o) => {
            const d = dateValue(o.deliveredAt);
            return d && d >= todayStart;
        });
        // Backend-computed today's count when available, local fallback otherwise.
        $("statToday").textContent = Number.isFinite(stats.myDeliveredToday)
            ? stats.myDeliveredToday
            : deliveredToday.length;

        // Collected total from the same JWT-scoped aggregates.
        const totalCollected = Number.isFinite(stats.myCollected)
            ? stats.myCollected
            : history.reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0);
        $("statCollected").textContent = money(totalCollected);

        // Failed + cancelled for this rider, from the same rows the table shows,
        // so the tile always matches what is on screen.
        $("statFailed").textContent = history.filter((o) => {
            const s = normalizeStatus(o.deliveryStatus || o.status);
            return s === "failed" || s === "cancelled";
        }).length;

        render();
        hideError();
    } catch (e) {
        showError(apiErrorMessage(e, tr("delivery_history_failed", "Failed to load history.")));
    } finally {
        setRefreshLoading(refreshBtn, false);
    }
}

function showError(message) {
    const banner = $("errorBanner");
    if (banner) {
        banner.style.display = "block";
        banner.textContent = "⚠️ " + message;
    }
}

function hideError() {
    const banner = $("errorBanner");
    if (banner) banner.style.display = "none";
}

function bindEvents() {
    const refreshBtn = $("refreshBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", loadHistory);

    const resetBtn = $("resetFiltersBtn");
    if (resetBtn) resetBtn.addEventListener("click", resetFilters);

    // Filters re-render the already-loaded rows; they never refetch.
    ["filterSearch", "filterStatus", "filterFrom", "filterTo"].forEach((id) => {
        const el = $(id);
        if (!el) return;
        const evt = el.tagName === "SELECT" || el.type === "date" ? "change" : "input";
        el.addEventListener(evt, render);
        if (evt === "input" && typeof el.addEventListener === "function") {
            // `input type=date` only emits "input" while typing; listen to both.
            el.addEventListener("change", render);
        }
    });
}

function setupSocket() {
    const token = localStorage.getItem("auth_token");
    socketClient.on("connect", () => {
        if (socketClient.isDeliveryStaff && socketClient.isDeliveryStaff()) {
            socketClient.socket && socketClient.socket.emit("join:delivery", {});
        }
    });
    // A run can reach a terminal state while this page is open (the courier
    // completes it from the Active Deliveries page in another tab), so refresh
    // the history rows rather than showing a stale list.
    ["delivery:completed", "delivery:failed", "delivery:cancelled", "order:status"].forEach((event) => {
        socketClient.on(event, () => loadHistory());
    });
    try {
        socketClient.connect(token);
    } catch (e) {
        console.log("Socket connect skipped:", e?.message);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    // Same rule as the Active Deliveries page: a session that is not a
    // delivery account has nothing to read here and would only earn a 403.
    if (window.DeliveryLayout && typeof window.DeliveryLayout.sessionRoleAllowed === "function"
        && !window.DeliveryLayout.sessionRoleAllowed()) {
        window.location.href = "../common/login.html";
        return;
    }
    bindEvents();
    loadHistory();
    setupSocket();

    __registerLangChange(() => {
        try {
            if (!$("historyContainer")) return;
            // Status labels are localized, so the whole table must repaint.
            render();
        } catch (e) { /* best-effort re-render */ }
    });
});