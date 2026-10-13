/**
 * Delivery Staff - Active Deliveries
 *
 * Delivery staff only ever see the deliveries assigned to THEM. Managers keep the
 * cafeteria-wide queue so they can dispatch. Both come from the same server
 * endpoints (`/deliveries/mine` vs `/deliveries`), which enforce that split
 * against the JWT - this page never filters by hand and hopes for the best.
 *
 * A delivery stays on this list until the courier completes it: DELIVERED means
 * the handover is proven, not that the job is closed.
 *
 * Real-time updates via the 'delivery' socket room.
 */
import api from "../api.js";
import { socketClient } from "../socket.js";
import { gpsTracker } from "./gps.js";
import { syncGpsPanels, gpsControlsHtml, gpsMapHtml } from "./gps-ui.js";
import {
  syncDashboardMaps,
  applyServerFixToMap,
  rememberServerFix,
  destroyDashboardMaps,
  syncOverviewMap,
} from "./dashboard-map.js";
import { openReportIssue, issueBadge } from "./report-issue.js";
import { sosButtonHtml, openProofModal, bindSos } from "./delivery-safety.js";
import {
    normalizeStatus,
    deliveryState,
    statusLabel,
    money,
    esc,
    tr,
    itemsChips,
    deliveryAddress,
    deliveryPhone,
    deliveryCoords,
    getMyUserId,
    isAssignedToMe,
    statusClass,
    navUrl,
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

function isAmharic() {
    return typeof window.getCurrentLanguage === "function" && window.getCurrentLanguage() === "am";
}

let orders = [];
// Finished work is deliberately absent from the active queue above, so it is
// fetched separately and rendered read-only under the "past" filter. Keeping it
// in its own array is what stops completed rows from ever reaching the GPS
// tracker, the stage buttons, or the "Assigned to Me" count.
let pastOrders = [];
// Unassigned, kitchen-ready orders awaiting dispatch (GET /deliveries/available,
// couriers only). Rendered read-only in their own section below the queue so an
// empty personal queue still shows real work exists instead of a dead end.
let availableOrders = [];
let currentFilter = "all";
// The `?orderId=` deep link may only reshape the filter ONCE, when the page is
// first built. It used to be re-applied on every render(), which meant the
// fallback below silently overwrote the courier's own tab clicks for the whole
// time the query string was present - the exact "the tab bar moves but the list
// never changes" symptom. Once the link has been honoured, the courier is in
// charge of the filter.
let linkedOrderReconciled = false;
// Set when the queue could not be loaded, cleared on the next success. It keeps
// the tab bar honest: an unknown count is rendered as "-", never as 0, so a
// backend that is down can never look like a cafeteria with no deliveries.
let loadFailed = false;
let myUserId = getMyUserId();
const userRole = JSON.parse(localStorage.getItem("current_user"))?.role || "";
const isManager = ["admin", "system_admin", "cafeteria_admin", "manager"].includes(userRole.toLowerCase());
// Socket.IO is the fast path; this poll is the safety net so an assignment still
// lands if the socket is down or the event was missed.
const POLL_INTERVAL_MS = 30000;

function paymentChip(order) {
    const p = String(order.paymentStatus || "").toUpperCase();
    const map = {
        PAID: ["status-delivered", "status_paid", "Paid"],
        PENDING: ["status-ready", "status_unpaid", "Unpaid"],
        FAILED: ["status-out", "status_failed", "Failed"],
        CANCELLED: ["status-out", "status_cancelled", "Cancelled"],
        REFUNDED: ["status-arrived", "status_refunded", "Refunded"],
    };
    const entry = map[p] || ["status-ready", "", p || "—"];
    const label = entry[1] ? tr(entry[1], entry[2]) : entry[2];
    return `<span class="status-chip ${entry[0]}"><i class="fa-solid fa-money-bill-wave"></i> ${esc(label)}</span>`;
}

function assignedTime(order) {
    const at = order.deliveryAssignedAt;
    if (!at) return "";
    let when = "";
    try { when = new Date(at).toLocaleString(); } catch (e) { when = String(at); }
    return `<div class="addr-coords"><i class="fa-solid fa-user-check"></i> <small><strong>${esc(tr("delivery_assigned_time", "Assigned:"))}</strong> ${esc(when)}</small></div>`;
}

function readyTime(order) {
    const at = order.readyForDeliveryAt;
    if (!at) return "";
    let when = "";
    try { when = new Date(at).toLocaleString(); } catch (e) { when = String(at); }
    return `<div class="addr-coords"><i class="fa-solid fa-bell-concierge"></i> <small><strong>${esc(tr("delivery_ready_time", "Ready:"))}</strong> ${esc(when)}</small></div>`;
}

/**
 * Structured address block: City / Area / House Number / Street / Landmark
 * as labeled rows, straight from the separate values the checkout stores.
 * Rendered only when at least one structured field exists; the joined
 * one-line address above stays untouched.
 */
function addressDetails(order) {
    const info = order.deliveryInfo || {};
    const rows = [
        [tr("delivery_city_label", "City"), info.city],
        [tr("delivery_area_label", "Area / Subcity / Kebele"), info.area || info.kebele],
        [tr("delivery_house_label", "House Number"), info.houseNumber],
        [tr("delivery_street_label", "Street / Area Name"), info.streetArea],
        [tr("delivery_landmark_label", "Landmark"), info.landmark],
    ].filter((row) => row[1] && String(row[1]).trim() !== "");
    if (!rows.length) return "";
    return `<div class="addr-details">` + rows.map((row) =>
        `<div class="addr-row"><span>${esc(row[0])}:</span> <strong>${esc(row[1])}</strong></div>`
    ).join("") + `</div>`;
}

function liveLocationLine(order) {
    const loc = order.currentLocation;
    if (!loc || !Number.isFinite(Number(loc.latitude)) || !Number.isFinite(Number(loc.longitude))) return "";
    const lat = Number(loc.latitude).toFixed(5);
    const lng = Number(loc.longitude).toFixed(5);
    let t = "";
    try { t = loc.timestamp ? new Date(loc.timestamp).toLocaleTimeString() : ""; } catch (e) { /* ignore */ }
    return `<div class="addr-coords" data-live-line="${esc(order.orderId)}"><i class="fa-solid fa-satellite-dish" style="color:#2563eb;"></i> <small><strong>${esc(tr("delivery_live_location", "Live location:"))}</strong> ${lat}, ${lng}${t ? " · " + esc(t) : ""}</small></div>`;
}

// Ordered delivery stages as enforced by the backend state machine. The card
// shows every stage so the rider always sees where the job is and what comes
// next; only the current transition is ever actionable (no skips).
const DELIVERY_STAGES = [
    { key: "assigned", labelKey: "delivery_stage_assigned", fallback: "Assigned" },
    { key: "accepted", labelKey: "delivery_stage_accepted", fallback: "Accepted" },
    { key: "picked_up", labelKey: "delivery_stage_picked_up", fallback: "Pickup" },
    { key: "out_for_delivery", labelKey: "delivery_stage_out", fallback: "Out" },
    { key: "arrived", labelKey: "delivery_stage_arrived", fallback: "Arrived" },
    { key: "delivered", labelKey: "delivery_stage_delivered", fallback: "Delivered" },
    { key: "completed", labelKey: "delivery_stage_completed", fallback: "Completed" },
];

function stageIndex(n) {
    const i = DELIVERY_STAGES.findIndex((s) => s.key === n);
    return i < 0 ? 0 : i;
}

function stageTracker(n) {
    // A cancelled/failed delivery is not on the happy path; never draw a
    // progress bar that implies it is still moving forward.
    if (n === "cancelled" || n === "failed") {
        return `<div class="d-stages halted"><span class="d-stage-label">${esc(statusLabel(n))}</span></div>`;
    }
    const cur = stageIndex(n);
    const nodes = DELIVERY_STAGES.map((s, i) => {
        const cls = i < cur ? "done" : i === cur ? "current" : "todo";
        return `<div class="d-stage ${cls}"><span class="d-stage-dot"></span><span class="d-stage-label">${esc(tr(s.labelKey, s.fallback))}</span></div>`;
    }).join("");
    return `<div class="d-stages" aria-label="${esc(tr("delivery_progress", "Delivery progress"))}">${nodes}</div>`;
}

function deliveryCard(order) {
    // The delivery state machine is authoritative: ASSIGNED / ACCEPTED are both
    // mirrored onto the Order as PENDING, so order.status alone would render a
    // brand-new assignment as "Pending".
    const n = deliveryState(order);
    const kitchenState = normalizeStatus(order.status);
    const isReady = isAwaitingPickup(order);
    const isPicked = n === "picked_up";
    const isOut = n === "out_for_delivery";
    const isArrived = n === "arrived";
    const isDelivered = n === "delivered";
    const isAssigned = n === "assigned" || n === "requested";
    const isAccepted = n === "accepted";
    const isPendingKitchen = kitchenState === "pending" || kitchenState === "preparing";
    const acceptance = normalizeStatus(order.deliveryAcceptanceStatus || "pending_acceptance");
    const mine = isAssignedToMe(order, myUserId);
    const address = deliveryAddress(order);
    const phone = deliveryPhone(order);
    const coords = deliveryCoords(order);
    const nav = navUrl(order);
    const navBtn = nav
        ? `<a class="btn-action btn-nav" href="${esc(nav)}" target="_blank" rel="noopener">
            <i class="fa-solid fa-diamond-turn-right"></i> ${esc(tr("delivery_navigate", "Navigate"))}
        </a>`
        : "";

    let actions = navBtn;
    if (isManager) {
        actions += `<button class="btn-action btn-assign" data-action="assign" data-order="${esc(order.orderId)}">
            <i class="fa-solid fa-truck-loading"></i> ${esc(tr("delivery_assign_staff", "Assign Staff"))}
        </button>`;
    }
    if (mine && acceptance === "pending_acceptance" && (isAssigned || isReady || isPendingKitchen)) {
        actions = `<button class="btn-action btn-accept" data-action="accept" data-order="${esc(order.orderId)}">
            <i class="fa-solid fa-check"></i> ${esc(tr("delivery_accept", "Accept"))}
        </button>
        <button class="btn-action btn-decline" data-action="decline" data-order="${esc(order.orderId)}">
            <i class="fa-solid fa-xmark"></i> ${esc(tr("delivery_decline", "Decline"))}
        </button>`;
    } else if (mine && acceptance === "declined") {
        actions = `<button class="btn-action btn-disabled" disabled>
            <i class="fa-solid fa-ban"></i> ${esc(tr("delivery_declined", "Declined"))}
        </button>`;
    } else if (mine && acceptance === "accepted" && isReady) {
        actions = `<button class="btn-action btn-pickup" data-action="pickup" data-order="${esc(order.orderId)}">
            <i class="fa-solid fa-box-open"></i> ${esc(tr("delivery_pick_up", "Pick Up"))}
        </button>`;
    } else if (mine && acceptance === "accepted" && isPendingKitchen) {
        actions = `<button class="btn-action btn-disabled" disabled>
            <i class="fa-solid fa-clock"></i> ${esc(tr("delivery_waiting_kitchen", "Waiting for Kitchen"))}
        </button>`;
    } else if (mine && isAccepted && isAssigned) {
        // Accepted, but the kitchen has not marked it ready yet.
        actions = `<button class="btn-action btn-disabled" disabled>
            <i class="fa-solid fa-clock"></i> ${esc(tr("delivery_waiting_kitchen", "Waiting for Kitchen"))}
        </button>`;
    } else if (isPicked && mine) {
        actions = `<button class="btn-action btn-go" data-action="out" data-order="${esc(order.orderId)}">
            <i class="fa-solid fa-truck-fast"></i> ${esc(tr("delivery_start_delivery", "Start Delivery"))}
        </button>`;
    } else if (isOut && mine) {
        actions = `<button class="btn-action btn-arrived" data-action="arrived" data-order="${esc(order.orderId)}">
            <i class="fa-solid fa-location-dot"></i> ${esc(tr("delivery_mark_arrived", "Mark Arrived"))}
        </button>`;
    } else if (isArrived && mine) {
        actions = `<button class="btn-action btn-done" data-action="delivered" data-order="${esc(order.orderId)}">
            <i class="fa-solid fa-circle-check"></i> ${esc(tr("delivery_mark_delivered", "Mark Delivered"))}
        </button>`;
    } else if (isDelivered && mine) {
        // Handover proven. This last step is what actually finalises the order,
        // so the delivery stays on this queue until the courier taps it.
        actions = `<button class="btn-action btn-done" data-action="complete" data-order="${esc(order.orderId)}">
            <i class="fa-solid fa-flag-checkered"></i> ${esc(tr("delivery_mark_completed", "Complete Delivery"))}
        </button>`;
    } else if (n === "requested" && !order.deliveryStaffAssigned) {
        actions = `<button class="btn-action btn-accept" data-action="claim" data-order="${esc(order.orderId)}">
            <i class="fa-solid fa-hand-holding-dollar"></i> ${esc(tr("delivery_claim_delivery", "Claim Delivery"))}
        </button>`;
    } else if (isReady && n !== "requested" && !mine) {
        actions = `<button class="btn-action btn-disabled" disabled>
            <i class="fa-solid fa-clock"></i> ${esc(tr("delivery_awaiting_assignment", "Awaiting Assignment"))}
        </button>`;
    } else {
        actions = `<button class="btn-action btn-disabled" disabled>${esc(statusLabel(n))}</button>`;
    }

    const assignee = order.deliveryStaffAssigned
        ? `<div style="margin-top:8px;"><small><strong>${esc(tr("delivery_assignee", "Assignee:"))}</strong> ${esc(order.deliveryStaffAssigned.name || tr("delivery_rider", "Rider"))}</small></div>`
        : "";

    // A problem can only be reported while the delivery is actually moving, and
    // only by the rider who owns it.
    const canReport = mine && (isPicked || isOut || isArrived);
    const reportBtn = canReport
        ? `<button class="btn-action btn-report" data-action="report" data-order="${esc(order.orderId)}">
            <i class="fa-solid fa-triangle-exclamation"></i> ${esc(tr("delivery_report_problem", "Report Problem"))}
        </button>`
        : "";
    // SOS is a separate, always-visible control. It is never part of the
    // Report Problem modal: a rider in danger must not have to open a form.
    const sosBtn = sosButtonHtml(order, mine);
    // Surface an open problem / manager hold straight on the card.
    const issue = canReport || order.openIssueCount
        ? { status: (order.issueStatus || (order.openIssueCount ? "OPEN" : null)), deliveryOnHold: order.deliveryOnHold, issueType: order.issueType }
        : null;
    const issueLine = issue && (issue.status || issue.deliveryOnHold) ? issueBadge(issue) : "";

    // GPS panel for MY active deliveries. Rendered from pickup onwards with
    // live tracking, and BEFORE pickup with the destination map plus an
    // honest "begins at pickup" note - never nothing at all. The backend only
    // accepts fixes once the food is moving, so an assigned-but-not-picked
    // order can have no position yet; showing why beats showing a blank card.
    const gpsLiveStage = isPicked || isOut || isArrived;
    const gpsTerminal = ["completed", "failed", "cancelled"].includes(n);
    const gpsPanel =
        mine && !gpsTerminal
            ? `<div class="d-gps" data-gps-panel="${esc(order.orderId)}"${gpsLiveStage ? "" : " data-gps-prepickup=\"1\""}>
                <div class="d-gps-row">
                    <span class="gps-state state-permission_required" data-gps-state="${esc(order.orderId)}"></span>
                    ${gpsControlsHtml(order.orderId)}
                </div>
                <div data-gps-metrics="${esc(order.orderId)}"></div>
                <div class="gps-status gps-near" data-gps-near="${esc(order.orderId)}" style="display:none;"></div>
                <div class="gps-status" data-gps-detail="${esc(order.orderId)}"></div>
                <!-- Browser site-settings instructions. Filled in only when the
                     permission was actually refused; hidden otherwise. -->
                <div data-gps-help="${esc(order.orderId)}" style="display:none;"></div>
                <div class="gps-status" data-live-gps="${esc(order.orderId)}"></div>
                ${gpsMapHtml(order.orderId)}
            </div>`
            : "";

    return `
        <div class="delivery-card ${isOut ? "out" : isPicked ? "picked" : isArrived ? "arrived" : isDelivered ? "delivered" : isReady ? "active" : ""}" data-order="${esc(order.orderId)}">
            <div class="d-card-head">
                <h4><i class="fa-solid fa-hashtag"></i> ${esc(order.orderId)}</h4>
                <span class="status-chip ${statusClass(n)}">${esc(statusLabel(n))}</span>
                ${paymentChip(order)}
            </div>
            <div class="d-card-body">
                ${stageTracker(n)}
                <div><strong>${esc(order.customerName)}</strong> — <a href="tel:${esc(phone)}">${esc(phone || "—")}</a></div>
                <div class="addr"><i class="fa-solid fa-location-dot" style="color:#f97316;"></i> ${esc(address)}
                    ${order.deliveryInfo && order.deliveryInfo.note ? "<br><small><strong>" + esc(tr("delivery_note", "Note:")) + "</strong> " + esc(order.deliveryInfo.note) + "</small>" : ""}
                </div>
                ${addressDetails(order)}
                ${coords ? `<div class="addr-coords"><i class="fa-solid fa-satellite-dish"></i> <small><strong>GPS:</strong> ${esc(coords)}</small></div>` : ""}
                ${readyTime(order)}
                ${assignedTime(order)}
                ${liveLocationLine(order)}
                ${itemsChips(order.items)}
                ${assignee}
                ${issueLine}
                <div style="margin-top:10px;"><strong>${esc(tr("delivery_total_label", "Total:"))} ${money(order.totalAmount)}</strong>
                    <small style="color:#94a3b8;"> ${esc(tr("delivery_fee_incl", "(incl. delivery fee {fee})", { fee: money(order.deliveryFee) }))}</small>
                </div>
            </div>
            <div class="d-card-actions">${actions}${reportBtn}${sosBtn}</div>
            ${gpsPanel}
        </div>
    `;
}

function matchesFilter(o) {
    const n = deliveryState(o);
    if (currentFilter === "ready") return isAwaitingPickup(o);
    if (currentFilter === "picked") return n === "picked_up";
    if (currentFilter === "out") return n === "out_for_delivery";
    if (currentFilter === "arrived") return n === "arrived";
    if (currentFilter === "delivered") return n === "delivered";
    return true;
}

/**
 * Is this order waiting at the kitchen, waiting for pickup, or already gone?
 *
 * The stage tabs group by what the COURIER still has to do, so the rule has to
 * read the same fields the card's action button reads - otherwise a tab and the
 * button on the card disagree about what stage an order is in.
 *
 * `order.status` alone is NOT enough, and reading it alone put a delivery in two
 * tabs at once. The backend deliberately leaves `order.status` at READY until the
 * courier picks the food up (see the effectiveStatus() note in
 * delivery.controller.js), so a PICKED_UP / OUT_FOR_DELIVERY / ARRIVED /
 * DELIVERED delivery STILL reports `status: "READY"`. Matching on that field
 * therefore counted it under "Ready for Delivery" while `deliveryState()` also
 * counted it under its own stage: the stage counts summed to more than "All", and
 * the same card appeared under two different tabs.
 *
 * So consult the authoritative delivery state first and only treat the order as
 * awaiting pickup when the delivery has NOT moved past ACCEPTED. `deliveryState()`
 * falls back to `status` itself, so a payload with no `deliveryStatus` (older
 * rows) still resolves correctly and cannot be double-counted.
 */
function isAwaitingPickup(o) {
    const state = deliveryState(o);
    if (state === "picked_up" || state === "out_for_delivery" ||
        state === "arrived" || state === "delivered" || state === "completed") {
        return false;
    }
    // READY (legacy, kept until pickup) and READY_FOR_DELIVERY (set by the
    // kitchen's Send to Delivery) both mean the food is waiting at the pass.
    const kitchen = normalizeStatus(o.status);
    return kitchen === "ready" || kitchen === "ready_for_delivery";
}

/**
 * Per-tab counts, read from the SAME two arrays the cards render from.
 *
 * Without this a tab whose stage currently has no deliveries renders as an empty
 * page, which is indistinguishable from a tab whose click handler is dead. The
 * count is what proves the bar is live: a stage showing 0 really is empty.
 *
 * While the queue has never loaded - or failed to load - every count is null.
 * A badge must never claim "0" it did not get from the server, because "no
 * deliveries" and "we could not ask" are the two states a courier most needs to
 * tell apart.
 */
function tabCounts() {
    const counts = {};
    const live = orders;
    counts.ready = live.filter(isAwaitingPickup).length;
    counts.picked = live.filter((o) => deliveryState(o) === "picked_up").length;
    counts.out = live.filter((o) => deliveryState(o) === "out_for_delivery").length;
    counts.arrived = live.filter((o) => deliveryState(o) === "arrived").length;
    counts.delivered = live.filter((o) => deliveryState(o) === "delivered").length;
    counts.past = pastOrders.length;
    // "All" is the live queue only - finished work has its own tab, so this
    // number always equals the number of cards under "All".
    counts.all = live.length;
    if (loadFailed) {
        // Same shape, every value unknown: the queue may well have work in it.
        Object.keys(counts).forEach((k) => { counts[k] = null; });
    }
    return counts;
}

/** Push the counts into the tab bar and mark the selected tab active. */
function renderTabs() {
    const counts = tabCounts();
    document.querySelectorAll("[data-filter]").forEach((tab) => {
        const key = tab.getAttribute("data-filter");
        tab.classList.toggle("active", key === currentFilter);
        const badge = tab.querySelector(".tab-count");
        if (!badge) return;
        const n = counts[key];
        if (n == null) {
            // Never a hardcoded 0: that reads as "nothing here" and hides a
            // failed load behind a healthy-looking tab bar.
            badge.textContent = "\u2013";
            badge.setAttribute("data-empty", "1");
            badge.setAttribute("data-unavailable", "1");
            tab.setAttribute("aria-busy", "true");
            return;
        }
        badge.removeAttribute("data-unavailable");
        tab.removeAttribute("aria-busy");
        badge.textContent = String(n);
        // Mute a tab with nothing behind it: still clickable, just visibly 0.
        badge.setAttribute("data-empty", n === 0 ? "1" : "0");
    });
}

/**
 * The list the current tab reads from.
 *
 * "past" is backed by its own request because a completed delivery is no longer
 * on the live queue; every other tab reads the live queue. Both are run through
 * matchesFilter() so the tab rules stay in one place.
 */
function viewSource() {
    return currentFilter === "past" ? pastOrders : orders;
}

// Order ids where THIS authenticated delivery person has an active delivery
// (assigned to me AND picked_up / out_for_delivery / arrived). Used to start/stop the
// real GPS watch - never tracks other riders' orders or inactive ones.
function myActiveOrderIds() {
    return orders
        .filter((o) => isAssignedToMe(o, myUserId))
        .filter((o) => ["picked_up", "out_for_delivery", "arrived"].includes(deliveryState(o)))
        .map((o) => o.orderId);
}

/**
 * The order a notification asked us to open, if any.
 *
 * The Notifications panel links here with `?orderId=...`; highlighting that card
 * (and clearing a status filter that would hide it) is what makes the alert
 * actionable instead of a dead link.
 */
function linkedOrderId() {
    try {
        const value = new URLSearchParams(window.location.search).get("orderId");
        return value ? String(value).trim() : "";
    } catch (e) {
        return "";
    }
}

/** Drop any active status filter so the linked order is guaranteed to render. */
function ensureLinkedOrderVisible(orderId) {
    if (!orderId || linkedOrderReconciled) return;
    // Reconcile at most once. After that the courier owns the filter: a later
    // click on "Completed" (which reads pastOrders and therefore cannot contain
    // a live order) must stay put instead of being bounced back to "All".
    linkedOrderReconciled = true;
    if (currentFilter === "all") return;
    // Hidden by this tab rather than genuinely gone: it may be the wrong stage,
    // or finished work while "past" is selected. Either way the notification
    // would be a dead link, so fall back to "All".
    const inView = viewSource().some((o) => String(o.orderId) === orderId);
    if (inView) return;
    currentFilter = "all";
}

/** Scroll to + briefly highlight the card for `?orderId=` (once per render). */
function highlightLinkedOrder() {
    const orderId = linkedOrderId();
    if (!orderId) return;
    const card = document.querySelector(`.delivery-card[data-order="${CSS.escape(orderId)}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("delivery-card-focus");
    // Reflow so re-adding the class restarts the animation on later renders.
    void card.offsetWidth;
    card.classList.add("delivery-card-focus");
}

/**
 * Empty-state copy per tab.
 *
 * "No delivery orders match this view" is what a DEAD tab looks like. Naming the
 * stage ("No picked-up deliveries right now") is what a working tab that simply
 * has no work looks like, so the courier can tell the two apart.
 */
const FILTER_EMPTY = {
    ready: ["delivery_empty_ready", "Nothing is ready for pickup right now."],
    picked: ["delivery_empty_picked", "No deliveries have been picked up yet."],
    out: ["delivery_empty_out", "No deliveries are out for delivery right now."],
    arrived: ["delivery_empty_arrived", "No deliveries have arrived yet."],
    delivered: ["delivery_empty_delivered", "No deliveries are waiting to be completed."],
    past: ["delivery_empty_past", "No completed deliveries yet."],
    // A rider with nothing assigned gets the plain, honest answer, plus the
    // Available section below (when unassigned ready orders exist) so the page
    // is never a dead end. Never a demo row: the queue only ever holds real,
    // assigned, database-backed orders.
    all: ["delivery_empty_none", "No deliveries assigned to you yet"],
};

/**
 * Available-for-dispatch section (couriers only).
 *
 * Rendered independently of the tabbed queue above: it answers "is there any
 * work at all?" while the queue answers "what is assigned to me?". Read-only
 * cards (no stage buttons, no GPS panel - deliveryCard already degrades to an
 * "Awaiting Assignment" note for orders that are not mine). Managers never see
 * it: their queue is already cafeteria-wide.
 */
function renderAvailable() {
    const section = $("availableSection");
    const list = $("availableList");
    if (!section || !list) return;
    if (isManager || !availableOrders.length) {
        section.style.display = "none";
        list.innerHTML = "";
        return;
    }
    section.style.display = "";
    list.innerHTML = availableOrders.map(deliveryCard).join("");
}

function render() {
    const list = $("deliveryList");
    ensureLinkedOrderVisible(linkedOrderId());
    // Independent of the queue below: the available board must still show when
    // the personal queue is empty (that is exactly when it matters most).
    renderAvailable();
    const isPast = currentFilter === "past";
    // Counts + active state are refreshed on every render so the tab bar can
    // never disagree with the list underneath it.
    renderTabs();
    // The heading follows the tab, otherwise a completed delivery would sit
    // under "Delivery Queue" and read as work still to be dispatched.
    const heading = document.querySelector(".section-title h3 span");
    if (heading) {
        heading.textContent = isPast
            ? tr("delivery_section_completed", "My Completed Deliveries")
            : tr("delivery_section_queue", "Delivery Queue");
    }
    // The queue never loaded, so nothing here can be called empty. Say that
    // instead: "no deliveries" and "we could not ask the server" are different
    // problems and the courier must not be left guessing which one they have.
    if (loadFailed) {
        list.innerHTML = `<div class="empty-state empty-state-error">
            <i class="fa-solid fa-plug-circle-xmark"></i>
            <p>${esc(tr("delivery_empty_unavailable", "Could not load your deliveries. Check your connection and press Refresh."))}</p>
            <button class="btn-action" data-action="refresh">
                <i class="fa-solid fa-rotate"></i> ${esc(tr("delivery_refresh", "Refresh"))}
            </button>
        </div>`;
        return;
    }
    const visible = viewSource().filter(matchesFilter);
    if (!visible.length) {
        const [emptyKey, fallback] = FILTER_EMPTY[currentFilter] || FILTER_EMPTY.all;
        list.innerHTML = `<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>${esc(tr(emptyKey, fallback))}</p></div>`;
        return;
    }
    list.innerHTML = visible.map(deliveryCard).join("");
    refreshGpsMaps();
    highlightLinkedOrder();
}

/**
 * Attach / refresh the live maps, then repaint the GPS panels with the distances
 * the map reconciler just measured.
 *
 * Order matters: the map reconciler owns the measurement (one Haversine per
 * order, shared with the customer's map), so the panels read their distance from
 * its result instead of measuring a second time.
 */
function refreshGpsMaps() {
    const visible = viewSource().filter(matchesFilter);
    const measures = syncDashboardMaps(visible, (orderId) => gpsTracker.getState(orderId));
    const byId = new Map();
    visible.forEach((o) => byId.set(String(o.orderId), o));
    syncGpsPanels(true, measures, byId);
    // One map for the whole queue: destination pins + rider + cafeteria.
    // Reads the same fixes as the cards, and moves live on `delivery:location`
    // because the socket handler calls back into refreshGpsMaps().
    syncOverviewMap(
        visible,
        (orderId) => gpsTracker.getState(orderId),
        (order) => statusLabel(deliveryState(order))
    );
}

let loadInFlight = false;
// Held at module scope so a session change can cancel the 30s poll.
let pollTimer = null;
// Set once the signed-in account stopped matching this dashboard. Every later
// call then becomes a no-op, so a replaced session can never keep firing
// requests the server is right to reject.
let sessionAborted = false;

/**
 * Stage writes that are already on the wire, keyed by order id.
 *
 * A courier double-tapping "Pick Up" (or a touch screen firing click twice)
 * would otherwise send two PATCHes for the same transition. The server rejects
 * the second one, but the loser still shows an error toast and can leave the
 * card in a state that does not match the server. One write per order at a time.
 */
const inFlightStages = new Set();

/** Run `fn` unless a stage write for this order is already in flight. */
function withStageLock(orderId, fn) {
    const key = String(orderId || "");
    if (inFlightStages.has(key)) return undefined;
    inFlightStages.add(key);
    return Promise.resolve()
        .then(fn)
        .finally(() => inFlightStages.delete(key));
}

/**
 * Collapse duplicate rows for the same order.
 *
 * The backend keeps one Delivery per order, but an overlapping socket refresh
 * and a poll can land in the same render; a duplicated card would show two
 * conflicting "Accept" buttons for a single delivery.
 */
function dedupeDeliveries(list) {
    const seen = new Set();
    const out = [];
    (Array.isArray(list) ? list : []).forEach((o) => {
        if (!o) return;
        const key = String(o.orderId || o.id || o._id || "");
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push(o);
    });
    return out;
}

/**
 * Is the account signed in right now still allowed on this page?
 *
 * The backend enforces the same rule server side (that is where the 403s came
 * from) - this check only exists so the page does not ASK for work it already
 * knows it cannot be given.
 */
function sessionStillValid() {
    try {
        if (window.DeliveryLayout && typeof window.DeliveryLayout.sessionRoleAllowed === "function") {
            return window.DeliveryLayout.sessionRoleAllowed();
        }
    } catch (e) { /* fall through: assume valid and let the server decide */ }
    return true;
}

/**
 * Leave because the session no longer belongs to a delivery account (another
 * tab signed in as a different role, or the account lost delivery access).
 *
 * The poll and every GPS watch are stopped first: a running tracker would
 * otherwise keep POSTing /deliveries/:id/location with a token the server
 * rejects, and the poll would keep repeating the same 403.
 */
function abortForSessionChange() {
    if (sessionAborted) return;
    sessionAborted = true;
    if (pollTimer) clearInterval(pollTimer);
    try { gpsTracker.stopAll(); } catch (e) { /* ignore */ }
    window.location.href = "../common/login.html";
}

async function loadQueues() {
    // Checked before anything else so a stale tab does not add one more 403 to
    // the console on every poll.
    if (!sessionStillValid()) {
        abortForSessionChange();
        return;
    }
    if (loadInFlight) return;
    loadInFlight = true;
    const refreshBtn = $("refreshBtn");
    setRefreshLoading(refreshBtn, true);
    try {
        // Scope comes from the server, not from the page: a courier is served
        // their own assignments only, while management keeps the full cafeteria
        // queue so they can dispatch.
        const data = isManager ? await api.get("/deliveries") : await api.get("/deliveries/mine");
        orders = dedupeDeliveries(data.orders);
        loadFailed = false;

        // Stats are computed from the SAME scoped list the cards render from,
        // so the numbers always match what is visible (no cafeteria-wide
        // leakage into a rider's personal stats, no hardcoded zeros).
        const counts = tabCounts();
        $("statReady").textContent = counts.ready;
        $("statOut").textContent = counts.out;
        if ($("statArrived")) $("statArrived").textContent = counts.arrived;
        $("statAssignedMe").textContent = orders.filter(o => isAssignedToMe(o, myUserId)).length;
        // Delivered-but-not-completed is real outstanding work for the courier,
        // so it gets its own count instead of being hidden inside "Assigned".
        if ($("statAwaitingComplete")) $("statAwaitingComplete").textContent = counts.delivered;

        // Completed deliveries are terminal, so the queue above can never return
        // them - that is exactly why this page used to look empty. Ask a
        // completed-scoped endpoint instead. Couriers use their own history
        // (server-scoped to their id); managers use the cafeteria-wide completed
        // report. Both return finished work only, and the client keeps just
        // COMPLETED so the tile can never disagree with the rows it opens.
        // Wrapped separately: a history failure must not take down the live queue.
        try {
            const pastData = isManager
                ? await api.get("/deliveries?report=completed")
                : await api.get("/deliveries/my-history?status=completed");
            pastOrders = dedupeDeliveries(pastData.orders).filter(o => deliveryState(o) === "completed");
        } catch (e) {
            pastOrders = [];
        }
        // `counts` above was taken before the history request replaced pastOrders, so
        // read the fresh array rather than the stale snapshot.
        if ($("statCompleted")) $("statCompleted").textContent = pastOrders.length;

        // Unassigned, kitchen-ready work awaiting dispatch (couriers only).
        // Wrapped separately like history: an available-board failure must not
        // take down the live queue, and managers skip it (their queue above is
        // already cafeteria-wide, so the section would duplicate it).
        if (!isManager) {
            try {
                const availData = await api.get("/deliveries/available");
                availableOrders = dedupeDeliveries(availData.orders);
            } catch (e) {
                availableOrders = [];
            }
        } else {
            availableOrders = [];
        }

        render();
        // Reconcile GPS with my active deliveries.
        //
        // This only STOPS tracking for orders that are finished, cancelled or
        // reassigned (empty list = no GPS). It deliberately does not START a
        // watch: loadQueues() runs on page load, on a 30s poll, on socket
        // events and on every tab refocus, so auto-starting here is what made
        // the browser re-ask for location over and over. The rider starts
        // tracking explicitly with "Start Delivery" / "Start GPS Tracking".
        const activeIds = myActiveOrderIds();
        gpsTracker.syncActiveDeliveries(activeIds);
        // Subscribe to server-broadcast GPS for my active orders (server
        // authorizes each join: assigned rider / owner / management only).
        activeIds.forEach((id) => socketClient.joinDeliveryRoom(id));
        hideError();
    } catch (e) {
        // GET /deliveries/mine is gated by the delivery role only, so a 403
        // means this session is no longer (or was never) a delivery account -
        // e.g. the account's role changed in the DB. Retry-ing every 30s can
        // only repeat the same rejection; leave instead. Management calls go
        // through the cafeteria scope and may 403 for other reasons, so they
        // keep the error banner below.
        if (e && e.status === 403 && !isManager) {
            abortForSessionChange();
            return;
        }
        loadFailed = true;
        const message = apiErrorMessage(e, tr("delivery_queue_failed", "Failed to load delivery queue."));
        showError(message);
        // Render the failure instead of leaving the previous markup up: a blank
        // list under a row of "0" badges is what made the tabs look dead. Now the
        // reason is on screen and every count reads "-" (unknown), not zero.
        // The available board is cleared too: on a failed load nothing here can
        // be called empty, and stale available rows would be a lie.
        orders = [];
        pastOrders = [];
        availableOrders = [];
        render();
    } finally {
        setRefreshLoading(refreshBtn, false);
        loadInFlight = false;
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

async function acceptAssignment(orderId, accept) {
    const msg = accept
        ? tr("delivery_confirm_accept", "Accept assignment for order #{id}?", { id: orderId })
        : tr("delivery_confirm_decline", "Decline assignment for order #{id}?", { id: orderId });
    if (!confirm(msg)) return;
    try {
        const res = await api.patch(`/deliveries/${encodeURIComponent(orderId)}/accept`, {
            accept,
            reason: accept ? undefined : "Declined from deliveries queue",
        });
        alert(res.message || tr("delivery_response_saved", "Response saved."));
        loadQueues();
    } catch (e) {
        alert(e.message || tr("delivery_respond_failed", "Failed to respond to assignment."));
    }
}

async function claimDelivery(orderId) {
    if (!confirm(tr("delivery_confirm_claim", "Claim and accept order #{id}?", { id: orderId }))) return;
    await withStageLock(orderId, async () => {
        try {
            // The claim creates the assignment for this rider themselves, and the
            // server answers with `delivery:assigned` - which socket.js would play
            // as the new-assignment chime. Claiming is the rider's own deliberate
            // action, so mute that echo for a few seconds; socket.js checks
            // this flag (self-expiring, and the event can arrive twice because
            // the server emits to both the delivery room and the user room).
            window.__scosMuteClaimSound = String(orderId);
            window.__scosMuteClaimSoundAt = Date.now();
            window.setTimeout(() => {
                if (window.__scosMuteClaimSound === String(orderId)) {
                    window.__scosMuteClaimSound = null;
                    window.__scosMuteClaimSoundAt = 0;
                }
            }, 10000);
            const res = await api.patch(`/deliveries/${encodeURIComponent(orderId)}/claim`, {});
            alert(res.message || tr("delivery_claimed", "Delivery claimed."));
            loadQueues();
        } catch (e) {
            window.__scosMuteClaimSound = null;
            window.__scosMuteClaimSoundAt = 0;
            alert(e.message || tr("delivery_claim_failed", "Failed to claim this delivery."));
        }
    });
}

/**
 * Begin real GPS tracking for an order the rider just moved to an active stage.
 *
 * These three handlers are all reached from a real click ("Pick Up",
 * "Start Delivery", "Mark Arrived"), so asking the browser for location here is
 * allowed and is what a rider expects. `start()` is still permission-guarded:
 *
 *   - never prompts on page load / poll / socket events (those paths call
 *     syncActiveDeliveries(), which no longer starts a watch);
 *   - if the rider already refused, it does NOT ask again - the GPS panel shows
 *     the browser site-settings notice and a Retry button instead.
 *
 * Called after the stage PATCH succeeds, so a failed transition never leaves a
 * watch running for an order that is not moving.
 */
async function startGpsForStage(orderId) {
  try {
    await gpsTracker.start(orderId, { userInitiated: true });
  } catch (e) {
    // A refused permission is a normal outcome, not a crash: the panel reports
    // it and the rider can still complete the delivery by hand.
    console.log("GPS not started for", orderId, e && e.message);
  }
}

async function pickUpOrder(orderId) {
    if (!confirm(tr("delivery_confirm_pickup", "Pick up order #{id} from the kitchen?", { id: orderId }))) return;
    await withStageLock(orderId, async () => {
        try {
            const res = await api.patch(`/deliveries/${encodeURIComponent(orderId)}/pickup`, {});
            alert(res.message || tr("delivery_order_picked_up", "Order picked up."));
            loadQueues();
            // Delivery is now active (PICKED_UP) -> start real GPS tracking.
            await startGpsForStage(orderId);
        } catch (e) {
            alert(e.message || tr("delivery_pickup_failed", "Failed to pick up order."));
        }
    });
}

async function markOutForDelivery(orderId) {
    if (!confirm(tr("delivery_confirm_out", "Start delivery for order #{id}?", { id: orderId }))) return;
    await withStageLock(orderId, async () => {
        try {
            const res = await api.patch(`/deliveries/${encodeURIComponent(orderId)}/out-for-delivery`, {});
            alert(res.message || tr("delivery_delivery_started", "Delivery started."));
            loadQueues();
            // Delivery is OUT_FOR_DELIVERY -> ensure real GPS tracking is running.
            await startGpsForStage(orderId);
        } catch (e) {
            alert(e.message || tr("delivery_start_failed", "Failed to start delivery."));
        }
    });
}

async function markArrived(orderId) {
    if (!confirm(tr("delivery_confirm_arrived", "Confirm order #{id} has arrived at the customer location?", { id: orderId }))) return;
    await withStageLock(orderId, async () => {
        try {
            const res = await api.patch(`/deliveries/${encodeURIComponent(orderId)}/arrived`, {});
            alert(res.message || tr("delivery_arrived_saved", "Order marked as arrived."));
            loadQueues();
            await startGpsForStage(orderId);
        } catch (e) {
            alert(e.message || tr("delivery_arrived_failed", "Failed to mark arrived."));
        }
    });
}

/**
 * Marking delivered now requires proof (customer OTP and/or a proof photo).
 * The backend decides whether what was supplied is enough.
 * The handover is NOT the end of the job: the delivery stays active until the
 * courier completes it, and only then does the order become COMPLETED and
 * customer tracking show the final step.
 */
async function markDelivered(orderId) {
    const order = orders.find((o) => o.orderId === orderId);
    if (!order) return;
    // Not stage-locked: openProofModal is cancellable, so the lock would never
    // be released on cancel. It already drops any existing #proof-modal, which
    // is what stops a double tap from stacking two OTP prompts.
    openProofModal(order, () => {
        gpsTracker.stop(orderId);
        loadQueues();
    });
}

/**
 * Final step: the handover is already proven, so this only closes the delivery
 * out and finalises the order. The server owns the transition and its ordering;
 * nothing here assumes the request succeeded.
 */
async function markCompleted(orderId) {
    if (!confirm(tr("delivery_confirm_complete", "Confirm order #{id} is fully completed?", { id: orderId }))) return;
    await withStageLock(orderId, async () => {
        try {
            const res = await api.patch(`/deliveries/${encodeURIComponent(orderId)}/complete`, {});
            alert(res.message || tr("delivery_completed", "Delivery completed."));
            loadQueues();
        } catch (e) {
            alert(e.message || tr("delivery_complete_failed", "Failed to complete this delivery."));
        }
    });
}

async function assignOrderStaff(orderId) {
    // Fetch the list of available delivery staff for the cafeteria
    try {
        const token = localStorage.getItem("auth_token");
        if (!token) return;

        const res = await api.get("/deliveries/staff");
        const staffList = res.staff || [];

        // Filter to available staff only
        const availableStaff = staffList.filter((s) => s.isAvailable);

        if (availableStaff.length === 0) {
            if (window.AdminToast) window.AdminToast.error("No available delivery staff members.");
            return;
        }

        // Show a simple assignment modal
        const staffNames = availableStaff.map((s) => `${s.name} (${s.phone})`).join("<br>");
        const selected = prompt(`Select a delivery staff member to assign:\n\n${staffNames}`);
        if (!selected) return;

        // Find the selected staff member
        const staff = availableStaff.find((s) => `${s.name} (${s.phone})` === selected || s.name === selected);
        if (!staff) {
            if (window.AdminToast) window.AdminToast.error("Staff member not found.");
            return;
        }

        // Assign the staff member to the order
        try {
            const assignRes = await api.patch(`/deliveries/${orderId}/assign`, {
                deliveryStaffId: staff.id
            });
            if (assignRes && assignRes.success) {
                loadQueues();
                if (window.AdminToast) window.AdminToast.success("Delivery staff assigned successfully.");
            } else {
                if (window.AdminToast) window.AdminToast.error(assignRes.error || "Failed to assign delivery staff.");
            }
        } catch (err) {
            console.error("Failed to assign delivery staff:", err);
            if (window.AdminToast) window.AdminToast.error("Failed to assign delivery staff. Please try again.");
        }
    } catch (err) {
        console.error("Failed to fetch delivery staff:", err);
        if (window.AdminToast) window.AdminToast.error("Failed to load delivery staff list.");
    }
}

function bindEvents() {
    document.addEventListener("click", (e) => {
        const gpsBtn = e.target.closest("[data-gps]");
        if (gpsBtn) {
            const orderId = gpsBtn.getAttribute("data-order");
            const mode = gpsBtn.getAttribute("data-gps");
            // Every one of these is a real click, so it is a legitimate moment to
            // ask the browser for location. start() is still permission-guarded:
            // after a refusal it will not re-prompt, it shows the site-settings
            // notice instead.
            if (orderId && mode === "stop") gpsTracker.stop(orderId);
            else if (orderId && mode === "retry") void gpsTracker.retryAfterPermissionChange(orderId);
            else if (orderId) void gpsTracker.start(orderId, { userInitiated: true });
            refreshGpsMaps();
            return;
        }
        const btn = e.target.closest("[data-action]");
        if (btn) {
            const orderId = btn.getAttribute("data-order");
            const action = btn.getAttribute("data-action");
            if (action === "accept") acceptAssignment(orderId, true);
            else if (action === "decline") acceptAssignment(orderId, false);
            else if (action === "pickup") pickUpOrder(orderId);
            else if (action === "out") markOutForDelivery(orderId);
            else if (action === "arrived") markArrived(orderId);
            else if (action === "delivered") markDelivered(orderId);
            else if (action === "complete") markCompleted(orderId);
            else if (action === "claim") claimDelivery(orderId);
            else if (action === "assign") assignOrderStaff(orderId);
            else if (action === "refresh") loadQueues();
            else if (action === "report") {
                const order = orders.find((o) => o.orderId === orderId);
                if (order) openReportIssue(order, () => loadQueues());
            }
            return;
        }
        const tab = e.target.closest("[data-filter]");
        if (tab) {
            // renderTabs() owns the active class, so it can never drift away
            // from the filter that produced the list underneath it.
            currentFilter = tab.getAttribute("data-filter");
            render();
        }
    });

    $("refreshBtn").addEventListener("click", loadQueues);

    // SOS is bound at the document level so it survives every re-render of the
    // card list.
    bindSos(document, () => loadQueues());

    // An address-only order can still get its destination pin after the map
    // reconciler geocodes the shared address; re-run the whole map pass then.
    window.addEventListener("scos:customer-geocoded", () => refreshGpsMaps());

    // Keep status pills / metrics in sync with the tracker (new fix, error, stop).
    gpsTracker.onChange(() => {
        clearTimeout(window.__gpsUiDebounceQueue);
        window.__gpsUiDebounceQueue = setTimeout(() => refreshGpsMaps(), 120);
    });
}

  function setupSocket() {
      const token = localStorage.getItem("auth_token");
      socketClient.on("connect", () => {
          if (socketClient.isDeliveryStaff && socketClient.isDeliveryStaff()) {
              socketClient.socket && socketClient.socket.emit("join:delivery", {});
          }
          // A reconnect can happen while a delivery was assigned; resync so
          // nothing that happened while the socket was down stays invisible.
          loadQueues();
      });
    // Every lifecycle frame re-reads the queue from the backend (the single
    // source of truth) instead of patching cards by hand: a refetch plus the
    // orderId dedupe in loadQueues() is what guarantees a socket event, a poll
    // tick, a refresh, a manager assignment and a kitchen re-send can never
    // produce two cards for the same order.
    ["delivery:assigned", "delivery:assignment", "delivery:accepted", "delivery:declined",
     "delivery:new", "order:status", "delivery:status", "order:ready-for-delivery",
     "delivery:picked_up", "delivery:started", "delivery:out_for_delivery",
     "delivery:arrived", "delivery:delivered", "delivery:completed",
     "delivery:failed", "delivery:cancelled", "delivery:unassigned", "delivery:retried",
     "delivery:dispatch"].forEach((event) => {
        socketClient.on(event, () => loadQueues());
    });
    // Server-confirmed GPS fix for an order on this queue
    // (payload: orderId, deliveryStaffId, latitude, longitude, accuracy,
    //  updatedAt/timestamp, distanceToCustomerKm, nearCustomer).
    socketClient.on("delivery:location", (point) => {
        if (!point || !point.orderId) return;
        // Move this order's marker immediately and remember the fix, so a page
        // refresh shows the map already in the right place.
        applyServerFixToMap(point);
        rememberServerFix(point);
        // Patch the in-memory order and repaint its Live-location line at once:
        // otherwise the card keeps showing the pre-fix snapshot until the next
        // 30s poll, which reads as "GPS not seen" right after tracking starts.
        const target = orders.find((o) => String(o.orderId) === String(point.orderId));
        if (target) {
            target.currentLocation = {
                latitude: point.latitude,
                longitude: point.longitude,
                accuracy: point.accuracy != null ? point.accuracy : null,
                timestamp: point.updatedAt || point.timestamp || null,
            };
            try {
                const fresh = liveLocationLine(target);
                const line = document.querySelector(`[data-live-line="${point.orderId}"]`);
                if (line) {
                    line.outerHTML = fresh;
                } else if (fresh) {
                    // The card rendered before any fix existed, so there is no
                    // line node to replace - insert one after the address block.
                    const card = document.querySelector(`[data-order="${point.orderId}"]`);
                    const anchor = card && card.querySelector(".d-card-body .addr");
                    if (anchor) anchor.insertAdjacentHTML("afterend", fresh);
                }
            } catch (e) { /* selector edge: full repaint on next render */ }
        }
        const el = document.querySelector(`[data-live-gps="${point.orderId}"]`);
        if (el) {
            const lat = Number(point.latitude);
            const lng = Number(point.longitude);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                let t = "";
                try { t = point.updatedAt || point.timestamp ? new Date(point.updatedAt || point.timestamp).toLocaleTimeString() : ""; } catch (e) { /* ignore */ }
                el.innerHTML = `<span class="gps-ok">📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}${t ? " · " + esc(t) : ""}</span>`;
            }
        }
        // Repaint the metrics + proximity hint from the server's own distance.
        refreshGpsMaps();
    });
    try {
        socketClient.connect(token);
    } catch (e) {
        console.log("Socket connect skipped:", e?.message);
    }

    // Polling fallback: an assignment must still reach this queue when
    // Socket.IO is disconnected, blocked, or the event was missed. loadQueues()
    // de-duplicates in-flight calls, so this never stacks requests.
    pollTimer = setInterval(() => {
        if (sessionAborted) return;     // session replaced: page is leaving
        if (document.hidden) return;    // no point polling a hidden tab
        if (loadInFlight) return;
        loadQueues();
    }, POLL_INTERVAL_MS);

    // Returning to the tab is another chance to be up to date immediately.
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) loadQueues();
    });

    window.addEventListener("pagehide", () => clearInterval(pollTimer));
}

document.addEventListener("DOMContentLoaded", () => {
    // A session that is not a delivery account has no business starting the
    // queue, the socket or a GPS watch - every one of those calls would be
    // answered with a 403. Leave before the first request goes out.
    if (!sessionStillValid()) {
        abortForSessionChange();
        return;
    }
    myUserId = getMyUserId();
    bindEvents();
    loadQueues();
    setupSocket();

    // Watch the browser's location permission (a QUERY, never a prompt) so a
    // rider who allows location in site settings sees the GPS panel's Retry
    // button become usable without reloading. Reading this on boot cannot
    // trigger a permission dialog.
    if (typeof gpsTracker.watchPermissionChanges === "function") {
        gpsTracker.watchPermissionChanges();
    }

    __registerLangChange(() => {
        try {
            if (!$("deliveryList")) return;
            render();
        } catch (e) { /* best-effort re-render */ }
    });

// Never keep a GPS watch when navigating away from the delivery pages, and
    // never leave a Leaflet instance (or its tile requests) running.
    window.addEventListener("pagehide", () => {
        gpsTracker.stopAll();
        destroyDashboardMaps();
        if (typeof gpsTracker.unwatchPermissionChanges === "function") {
            gpsTracker.unwatchPermissionChanges();
        }
    });
});
