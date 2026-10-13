/**
 * Live Order Tracker
 * - Renders the order receipt + status timeline
 * - Fetches LIVE status from the backend (GET /api/orders/:orderId)
 * - Joins the Socket.io order room and updates the timeline in real-time
 *   when the kitchen marks the order preparing/ready/served
 * - Persists status changes back to localStorage for consistency on refresh
 */
import api from "./api.js";
import { socketClient } from "./socket.js";

/**
 * Find an order by its ID from localStorage (orderHistory / latestOrder)
 * @param {string} orderId - Order ID (may include a leading #)
 * @returns {Object|null} Order object or null
 */
export function getOrderById(orderId) {
    if (!orderId) return null;
    const normalized = String(orderId).replace(/^#/, "");

    const historyData = JSON.parse(localStorage.getItem("orderHistory")) || [];
    let found = historyData.find(o => (o.orderId || o.id || "").replace(/^#/, "") === normalized);
    if (found) {
        return found;
    }

    const latestOrder = JSON.parse(localStorage.getItem("latestOrder"));
    if (latestOrder) {
        const latestId = (latestOrder.orderId || latestOrder.id || "").replace(/^#/, "");
        if (latestId === normalized) {
            return latestOrder;
        }
    }

    return null;
}

/**
 * Attached to window object for live cancellation from status receipt page.
 * Submits a real backend cancellation request (re-used for safety if wired up).
 */
window.cancelOrderFromStatusPage = async function(orderId) {
    if (!confirm(`Are you sure you want to cancel order #${orderId}?`)) {
        return;
    }

    try {
        const { requestCancellation } = await import("./order-cancellation.js");
        const result = await requestCancellation(orderId, "CUSTOMER_CHANGED_MIND", "Cancelled by customer from tracker");

        if (!result || result.success !== true) {
            alert((result && result.error) || "Cancellation request could not be submitted.");
            return;
        }

        let latestOrder = JSON.parse(localStorage.getItem("latestOrder"));
        let historyData = JSON.parse(localStorage.getItem("orderHistory")) || [];

        // 1. Update latest order if ID matches
        if (latestOrder) {
            const latestId = latestOrder.orderId || latestOrder.id;
            if (!latestId || String(latestId) === String(orderId)) {
                latestOrder.status = "Cancelled";
                localStorage.setItem("latestOrder", JSON.stringify(latestOrder));
            }
        }

        // 2. Update history array
        historyData = historyData.map(order => {
            const id = order.orderId || order.id;
            if (String(id) === String(orderId)) {
                order.status = "Cancelled";
            }
            return order;
        });

        localStorage.setItem("orderHistory", JSON.stringify(historyData));
        alert("Order cancelled successfully. If you paid, your refund will be processed shortly and you will be notified.");
        location.reload();
    } catch (error) {
        alert(error.message || "Failed to submit the cancellation request.");
    }
};

function normalizeStatus(status) {
    return (status || "").toString().trim().toLowerCase();
}

/**
 * Persist a status update back into localStorage so a refresh shows the truth.
 */
function persistStatus(orderId, status) {
    const id = String(orderId).replace(/^#/, "");
    let historyData = JSON.parse(localStorage.getItem("orderHistory")) || [];
    let changed = false;

    historyData = historyData.map(order => {
        if ((order.orderId || order.id || "").replace(/^#/, "") === id) {
            if (normalizeStatus(order.status) !== normalizeStatus(status)) {
                order.status = status;
                changed = true;
            }
        }
        return order;
    });

    const latestOrder = JSON.parse(localStorage.getItem("latestOrder"));
    if (latestOrder) {
        const latestId = (latestOrder.orderId || latestOrder.id || "").replace(/^#/, "");
        if (latestId === id && normalizeStatus(latestOrder.status) !== normalizeStatus(status)) {
            latestOrder.status = status;
            changed = true;
        }
    }

    if (changed) {
        localStorage.setItem("orderHistory", JSON.stringify(historyData));
        localStorage.setItem("latestOrder", JSON.stringify(latestOrder));
    }
}

/**
 * Localized customer-facing delivery message with the exact spec wording as
 * the fallback, so the tracker is correct in both languages even before the
 * i18n bundle loads the new keys.
 */
function trackText(key, fallback) {
    try {
        if (typeof window.getText === "function") {
            const s = window.getText(key);
            if (s && s !== key) return s;
        }
    } catch (e) {}
    return fallback;
}

function trackReadyForDeliveryMsg() {
    return trackText("track_ready_for_delivery", "🚚 Your order is ready and has been sent for delivery.");
}

function trackAssignedMsg() {
    return trackText("track_assigned_rider", "🚚 Delivery staff has been assigned to your order.");
}

function trackOutForDeliveryMsg() {
    return trackText("track_out_for_delivery", "🛵 Your order is out for delivery.");
}

/**
 * Name of the rider currently assigned to the tracked order (if any).
 * Fed by full order snapshots and by assignment socket frames; it lets the
 * tracker show "delivery staff assigned" after a refresh too, not just on
 * the live event.
 */
let assignedRiderName = null;

function rememberAssignee(order) {
    if (!order) return;
    const staff = order.deliveryStaffAssigned;
    const name = staff && (staff.name || staff.id || staff);
    const id = typeof staff === "string" ? staff : (staff && (staff.id || staff._id));
    if (name && typeof name === "string") assignedRiderName = name;
    else if (id) assignedRiderName = assignedRiderName || "assigned";
}

/**
 * Update the status heading/badge/subtext based on the order status.
 */
function setStatusText(status) {
    const s = normalizeStatus(status);
    const heading = document.getElementById("status-heading");
    const subtext = document.getElementById("status-subtext");
    const icon = document.getElementById("status-badge-icon");
    if (!heading && !subtext) return;

    const map = {
        received: ["Order Received", "We have sent your order directly to the kitchen counter."],
        pending: ["Order Received", "We have sent your order directly to the kitchen counter."],
        preparing: ["Preparing", "The kitchen is preparing your order. Please wait."],
        ready: ["Ready", "Your order is " + (currentOrderType === "delivery" ? "ready for delivery!" : "ready for pickup!")],
        ready_for_delivery: ["Sent for Delivery", trackReadyForDeliveryMsg()],
        picked_up: ["Picked Up", "🚚 Your order has been picked up and is on its way to you."],
        out_for_delivery: ["Out for Delivery", trackOutForDeliveryMsg()],
        arrived: ["Arrived", "Driver has arrived near your location."],
        delivered: ["Delivered", "Your order has been delivered. Enjoy your meal!"],
        served: ["Served", "Your order has been served."],
        completed: ["Completed", "Your order has been completed."],
        cancelled: ["Order Cancelled", "This order was cancelled and will not be prepared."]
    };

    // Legacy "received" status is mapped to the first step (Order Received) so
    // the tracker always starts at step 1 rather than showing a generic state.
    const entry = map[s] || (s === "received" ? map.received : undefined) || ["Order Tracker", "We are processing your order."];

    if (heading) heading.textContent = entry[0];
    if (subtext) {
        // Once a rider owns the job, the tracker says so alongside the stage
        // message - from the live assignment event AND after a refresh (the
        // assignee is remembered from the last full snapshot).
        const prePickup = s === "ready" || s === "ready_for_delivery";
        subtext.textContent = (prePickup && assignedRiderName)
            ? entry[1] + " " + trackAssignedMsg()
            : entry[1];
    }

    if (icon) {
        const icons = {
            received: 'fa-circle-check',
            pending: 'fa-circle-check',
            preparing: 'fa-fire-burner',
            ready: 'fa-bell-concierge',
            ready_for_delivery: 'fa-truck-pickup',
            picked_up: 'fa-handshake',
            out_for_delivery: 'fa-truck-fast',
            arrived: 'fa-location-dot',
            delivered: 'fa-house-circle-check',
            served: 'fa-circle-check',
            completed: 'fa-circle-check',
            cancelled: 'fa-circle-xmark'
        };
        const colors = {
            received: '#16a34a',
            pending: '#16a34a',
            preparing: '#16a34a',
            ready: '#16a34a',
            ready_for_delivery: '#ff6b00',
            picked_up: '#7c3aed',
            out_for_delivery: '#ff6b00',
            arrived: '#16a34a',
            delivered: '#16a34a',
            served: '#16a34a',
            completed: '#16a34a',
            cancelled: '#dc3545'
        };
        icon.innerHTML = `<i class="fa-solid ${icons[s] || 'fa-circle-check'}" style="color: ${colors[s] || '#ff6b00'}; font-size: 2.5rem;"></i>`;
    }

    // Gate the cancel button (hide actions for terminal statuses)
    updateCancelButton(s);
}

function updateCancelButton(s) {
    const cancelWrapper = document.getElementById("cancel-btn-wrapper");
    if (!cancelWrapper) return;
    const timelineSection = document.getElementById("timeline-section");

    if (s === "cancelled") {
        if (timelineSection) {
            timelineSection.style.opacity = "0.4";
            timelineSection.style.pointerEvents = "none";
        }
        cancelWrapper.innerHTML = `
            <button class="btn btn-outline-danger" disabled style="width: 100%; color: #dc3545; border: 1px solid #dc3545; padding: 10px; border-radius: 6px; background: #fde8e8; cursor: not-allowed;">
                <i class="fa-solid fa-ban"></i> Cancelled
            </button>
        `;
    } else if (s === "pending" || s === "received") {
        // Cancellation is only allowed BEFORE preparation begins (status
        // pending/received). Cancelling immediately grants a full refund
        // because the order has not been cooked yet.
        const url = new URL(window.location.href);
        const id = url.searchParams.get("orderId") || url.searchParams.get("id");
        cancelWrapper.innerHTML = `
            <a href="cancel-order.html?id=${encodeURIComponent(id || "")}"
                class="btn btn-outline-danger"
                style="width: 100%; display: inline-block; text-align: center; color: #dc3545; border: 1px solid #dc3545; padding: 10px; border-radius: 6px; background: transparent; cursor: pointer; font-weight: 600; text-decoration: none; box-sizing: border-box;">
                <i class="fa-solid fa-ban"></i> Cancel Order (Full Refund)
            </a>
        `;
    } else {
        // Preparing / Ready / Served / Completed → cannot cancel anymore.
        const isPrepped = s === "preparing" || s === "ready";
        cancelWrapper.innerHTML = `
            <button class="btn btn-secondary" disabled title="${isPrepped ? 'The kitchen has already started preparing this order and it can no longer be cancelled.' : ''}" style="width: 100%; color: #6b7280; border: 1px solid #d1d5db; padding: 10px; border-radius: 6px; background: #f3f4f6; cursor: not-allowed;">
                <i class="fa-solid fa-ban"></i> ${isPrepped ? 'Cannot Cancel (Preparing)' : statusLabel(s)}
            </button>
        `;
    }
}

function statusLabel(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ================================================================
 * REFUND STATE
 *
 * Rendered straight from the backend's refund fields. The manager/admin
 * workflow is: customer cancels a PAID order -> CANCELLED ->
 * REFUND_REQUESTED ("Refund Required" on the dashboard) -> Manager/Admin
 * processes it -> REFUNDED. The tracker has to show each of those states,
 * live, without ever caching them locally.
 * ================================================================ */

const REFUND_COPY = {
    REFUND_REQUESTED: {
        title: "Refund requested",
        message: "Your order was cancelled and your refund is waiting for approval by our team. We will notify you as soon as it is processed."
    },
    REFUND_APPROVED: {
        title: "Refund approved",
        message: "Your refund has been approved and is being processed."
    },
    REFUND_PROCESSING: {
        title: "Refund in progress",
        message: "Your refund is being processed. This usually takes a short while."
    },
    REFUNDED: {
        title: "Refund complete",
        message: "Your payment has been refunded successfully."
    },
    REFUND_FAILED: {
        title: "Refund failed",
        message: "We could not complete your refund. Our team has been notified and will follow up with you."
    }
};

/**
 * Paint the refund banner from the server's refund fields.
 * Hides itself entirely when the order has no refund workflow attached, so an
 * active order never shows a refund message.
 */
function renderRefundNotice(orderData) {
    const notice = document.getElementById("refund-notice");
    if (!notice || !orderData) return;

    const refundStatus = String(orderData.refundStatus || "").toUpperCase();
    const copy = REFUND_COPY[refundStatus];
    if (!copy) {
        notice.style.display = "none";
        return;
    }

    const titleEl = document.getElementById("refund-notice-title");
    const messageEl = document.getElementById("refund-notice-message");
    const metaEl = document.getElementById("refund-notice-meta");
    if (titleEl) titleEl.textContent = copy.title;
    if (messageEl) messageEl.textContent = copy.message;

    const metaParts = [];
    const amount = Number(orderData.refundAmount) || 0;
    if (amount > 0) metaParts.push(`${amount.toFixed(0)} ETB`);
    if (orderData.refundReference) metaParts.push(`Reference: ${orderData.refundReference}`);
    if (refundStatus === "REFUNDED" && orderData.refundedAt) {
        const when = new Date(orderData.refundedAt);
        if (!Number.isNaN(when.getTime())) metaParts.push(when.toLocaleString());
    }
    if (metaEl) {
        metaEl.textContent = metaParts.join(" · ");
        metaEl.style.display = metaParts.length ? "block" : "none";
    }

    notice.style.display = "flex";
    notice.classList.toggle("is-refunded", refundStatus === "REFUNDED");
}

/**
 * The order type currently being tracked (used by status text / timeline).
 * Updated by renderOrder() and by live socket/poll updates.
 */
let currentOrderType = "dine-in";

/**
 * Tracks the highest step reached for the current delivery flow so that only
 * genuinely forward (monotonic) status changes advance the timeline. Stale or
 * older socket events can never move the tracker backwards.
 */
let latestActiveIndex = -1;

/**
 * Build the timeline steps. Pickup orders get 3 steps; delivery orders get all
 * 8 steps (Received -> Preparing -> Ready -> Picked Up -> Out for Delivery ->
 * Arrived -> Delivered -> Completed).
 * Returns an array of { stepId, lineId, key, strong, small, icon }.
 *
 * ARRIVED matters here: the backend delivery state machine has a real ARRIVED
 * stage (courier is at the door), and it was missing from this list. renderTimeline
 * resolves a status by `stepKeys.indexOf(status)`, so an "arrived" frame scored -1
 * and the tracker reset every step to neutral - the customer saw the whole
 * timeline blank out exactly when the rider reached them.
 */
function getTimelineConfig() {
    const pickup = [
        { key: "pending", strong: "Order Received", small: "Kitchen notified", icon: "fa-clipboard-check" },
        { key: "preparing", strong: "Preparing", small: "Chef is cooking", icon: "fa-fire-burner" },
        { key: "ready", strong: "Ready", small: "Ready for pickup", icon: "fa-bell-concierge" }
    ];
    const delivery = [
        { key: "pending", strong: "Order Received", small: "Kitchen notified", icon: "fa-clipboard-check" },
        { key: "preparing", strong: "Preparing", small: "Chef is cooking", icon: "fa-fire-burner" },
        { key: "ready", strong: "Ready", small: "Handing to rider", icon: "fa-bell-concierge" },
        { key: "ready_for_delivery", strong: "Sent for Delivery", small: "Rider notified", icon: "fa-truck-pickup" },
        { key: "picked_up", strong: "Picked Up", small: "Driver has the order", icon: "fa-handshake" },
        { key: "out_for_delivery", strong: "Out for Delivery", small: "Rider on the way", icon: "fa-truck-fast" },
        { key: "arrived", strong: "Arrived", small: "Driver at your location", icon: "fa-location-dot" },
        { key: "delivered", strong: "Delivered", small: "At your doorstep", icon: "fa-house-circle-check" },
        { key: "completed", strong: "Completed", small: "Enjoy your meal", icon: "fa-circle-check" }
    ];
    return currentOrderType === "delivery" ? delivery : pickup;
}

let timelineBuiltForType = null;

/**
 * (Re)build the timeline DOM when the type changes.
 */
function buildTimelineDOM(force) {
    const container = document.getElementById("status-timeline");
    if (!container) return;
    if (!force && timelineBuiltForType === currentOrderType) return;
    const typeChanged = timelineBuiltForType !== currentOrderType;
    timelineBuiltForType = currentOrderType;
    // Only reset the monotonic progress when the flow type actually changes
    // (e.g. delivery vs pickup). Rebuilding the same type on a live update must
    // NOT reset progress, or out-of-order events could regress the timeline.
    if (typeChanged) latestActiveIndex = -1;

    const config = getTimelineConfig();
    let html = "";
    config.forEach((step, index) => {
        if (index > 0) {
            html += `<div class="timeline-line" id="line-${index}"></div>`;
        }
        html += `
            <div class="timeline-step" id="step-${index + 1}">
                <div class="step-icon"><i class="fa-solid ${step.icon}"></i></div>
                <div class="step-label">
                    <strong>${step.strong}</strong>
                    <small>${step.small}</small>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
}

/**
 * Mark the correct timeline steps/lines active based on the order status.
 *
 * Steps advance forward-only in a monotonic fashion. For live / realtime
 * updates the tracker can only advance — stale or older events are ignored so
 * the customer never sees the tracker regress.
 *
 * opts.regressible — when true (used by the initial page render after a
 * backend fetch), the timeline may be repositioned freely to match the
 * authoritative backend status.
 */
function renderTimeline(status, opts = {}) {
    let s = normalizeStatus(status);
    // Legacy / kitchen-mapped "received" status should land on the first step.
    if (s === "received") s = "pending";

    buildTimelineDOM(false);
    const config = getTimelineConfig();
    const stepKeys = config.map(c => c.key);
    const total = config.length;

    const steps = [];
    const lines = [];
    for (let i = 1; i <= total; i++) steps.push(document.getElementById(`step-${i}`));
    for (let i = 1; i < total; i++) lines.push(document.getElementById(`line-${i}`));

    const reset = () => [...steps, ...lines].forEach(el => {
        if (el) {
            el.classList.remove("active");
            el.style.opacity = "1";
        }
    });

    let activeIndex;
    if (s === "cancelled") {
        // Keep only the first step visible; the order was stopped.
        activeIndex = 0;
    } else if (s === "served") {
        // Served (pickup) is functionally the same as "ready".
        activeIndex = stepKeys.indexOf("ready");
    } else if (s === "completed") {
        activeIndex = stepKeys.indexOf(currentOrderType === "delivery" ? "completed" : "ready");
    } else {
        activeIndex = stepKeys.indexOf(s);
    }

    if (activeIndex === -1) {
        // Unknown status: keep all steps neutral.
        reset();
        return true;
    }

    // Allow cancellation events to always render (dims the timeline back to
    // step 1) even if the tracker had already advanced further.  Every other
    // realtime / poll update can only move forward.
    if (opts.regressible !== true && s !== "cancelled" && activeIndex < latestActiveIndex) {
        return false;
    }
    latestActiveIndex = Math.max(latestActiveIndex, activeIndex);

    reset();
    activateSteps(steps, lines, activeIndex);
    return true;
}

function activateSteps(steps, lines, activeIndex) {
    for (let i = 0; i <= activeIndex; i++) {
        if (steps[i]) steps[i].classList.add("active");
    }
    for (let i = 0; i < activeIndex; i++) {
        if (lines[i]) lines[i].classList.add("active");
    }
}

/**
 * Apply a live status update (socket or poll).  Advances the timeline forward
 * only; returns true when the tracker was updated, false if the event was stale.
 */
function applyLiveStatus(status) {
    const applied = renderTimeline(status);
    if (!applied) return false;
    setStatusText(status);
    return true;
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
}

function populateReceipt(orderData) {
    const currentId = orderData.orderId || orderData.id || "ET-0000";
    currentOrderType = orderData.orderType || currentOrderType;
    if (document.getElementById("display-order-id")) document.getElementById("display-order-id").textContent = `#${currentId}`;
    if (document.getElementById("receipt-name")) document.getElementById("receipt-name").textContent = orderData.customerName || orderData.name || "Customer";
    if (document.getElementById("receipt-phone")) document.getElementById("receipt-phone").textContent = orderData.customerPhone || orderData.phone || "-";
    if (document.getElementById("receipt-dining-type")) document.getElementById("receipt-dining-type").textContent =
        orderData.orderType === "delivery" ? "Delivery" :
        orderData.orderType === "dine-in" ? "Dine-In" : "Takeaway";
    if (document.getElementById("receipt-table")) document.getElementById("receipt-table").textContent = orderData.orderType === "delivery" ? "-" : (orderData.tableNumber || orderData.table || "-");
    if (document.getElementById("receipt-payment")) document.getElementById("receipt-payment").textContent = orderData.paymentMethod || "Telebirr";
    if (document.getElementById("receipt-time")) document.getElementById("receipt-time").textContent = orderData.orderDate || new Date().toLocaleString();

    // Delivery address block
    const deliveryInfo = orderData.deliveryInfo || null;
    const addressRow = document.getElementById("delivery-address-row");
    if (addressRow) {
        const isDel = currentOrderType === "delivery";
        addressRow.style.display = isDel ? "block" : "none";
        if (isDel && (deliveryInfo || orderData.customerPhone)) {
            const address = deliveryInfo
                ? `${deliveryInfo.subCity || ""}, ${deliveryInfo.location || ""}`.replace(/^,\s*/, "").trim()
                : (orderData.customerAddress || "");
            document.getElementById("receipt-delivery-address").textContent = address || "Please call customer for address";
            const note = document.getElementById("receipt-delivery-note");
            if (note) note.textContent = deliveryInfo && deliveryInfo.note ? `Note: ${deliveryInfo.note}` : "";
        }
    }

    // Items
    const itemsListContainer = document.getElementById("receipt-items-list");
    if (itemsListContainer && Array.isArray(orderData.items)) {
        let itemsHTML = "";
        orderData.items.forEach((item) => {
            const price = parseFloat(item.price) || 0;
            const qty = parseInt(item.quantity) || 1;
            const itemTotal = (price * qty).toFixed(0);
            itemsHTML += `
                <div class="receipt-item-row" style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <div>
                        <span class="qty-badge" style="font-weight: bold; color: #ff6b00; margin-right: 6px;">${qty}x</span>
                        <span class="item-title">${escapeHtml(item.name)}</span>
                    </div>
                    <span class="item-price">${itemTotal} ETB</span>
                </div>
            `;
        });
        itemsListContainer.innerHTML = itemsHTML;
    }

    // Totals
    const subtotalVal = parseFloat(orderData.subtotal) || parseFloat(orderData.totalAmount) || 0;
    const serviceFeeVal = parseFloat(orderData.serviceFee) || 20;
    const deliveryFeeVal = parseFloat(orderData.deliveryFee) || 0;
    const totalVal = parseFloat(orderData.totalAmount) || (subtotalVal + serviceFeeVal + deliveryFeeVal);

    if (document.getElementById("receipt-subtotal")) document.getElementById("receipt-subtotal").textContent = subtotalVal.toFixed(0);
    if (document.getElementById("receipt-service-fee")) document.getElementById("receipt-service-fee").textContent = serviceFeeVal.toFixed(0);
    const deliveryFeeRow = document.getElementById("receipt-delivery-fee-row");
    if (deliveryFeeRow) {
        deliveryFeeRow.style.display = currentOrderType === "delivery" ? "flex" : "none";
        if (document.getElementById("receipt-delivery-fee")) document.getElementById("receipt-delivery-fee").textContent = deliveryFeeVal.toFixed(0);
    }
    if (document.getElementById("receipt-total")) document.getElementById("receipt-total").textContent = totalVal.toFixed(0);
}

function renderEmptyState() {
    const mainContent = document.querySelector("main");
    if (mainContent) {
        mainContent.innerHTML = `
            <section class="status-banner" style="max-width: 500px; margin: 40px auto; text-align: center; background: #fff; padding: 30px; border-radius: 10px;">
                <i class="fa-solid fa-magnifying-glass" style="font-size: 3rem; color: #ff6b00; margin-bottom: 12px;"></i>
                <h2>No Active Order Found</h2>
                <p style="color: #6b7280; margin-bottom: 16px;">You don't have an active order tracking session right now.</p>
                <a href="menu.html" class="btn btn-primary" style="display: inline-block; padding: 10px 20px; background: #ff6b00; color: #fff; border-radius: 6px; text-decoration: none;">View Menu</a>
            </section>
        `;
    }
}

function renderOrder(orderData) {
    populateReceipt(orderData);
    rememberAssignee(orderData);
    const status = orderData.status || "Pending";
    renderTimeline(status, { regressible: true });
    setStatusText(status);
    renderRefundNotice(orderData);
    announceLiveOrder(orderData);
}

/**
 * Announce the authoritative order snapshot to the rest of the page.
 *
 * This module owns the order's live state (initial backend fetch, `order:status`
 * frames and the 5s polling fallback all converge here), so the live GPS map
 * (customer-tracking-map.js) listens to this one announcement instead of running
 * a second fetch + poll of its own. That is what keeps the map, the timeline and
 * the receipt showing the SAME status and the same coordinates - they cannot
 * drift because there is only one source.
 */
function announceLiveOrder(orderData) {
    if (!orderData) return;
    try {
        window.dispatchEvent(new CustomEvent("scos:order-live", { detail: { order: orderData } }));
    } catch (e) {
        /* non-browser context */
    }
}

async function loadLiveOrder(orderId, fallbackOrderData) {
    // If customer is logged in, fetch the authoritative live status.
    const token = localStorage.getItem("auth_token");
    if (token && orderId) {
        try {
            const live = await fetchLiveStatus(orderId);
            if (live && live.status) {
                const merged = { ...(fallbackOrderData || {}), ...live };
                renderOrder(merged);
                persistStatus(orderId, live.status);
                return merged;
            }
        } catch (err) {
            // Fall back to local data if the fetch fails (e.g. not logged in / offline).
            console.log("Could not fetch live order (using local data):", err?.message);
        }
    }
    if (fallbackOrderData) {
        renderOrder(fallbackOrderData);
    }
    return fallbackOrderData;
}

/**
 * Fetch only the live status for an order from the backend.
 * Returns the order object (or null) without touching the UI, so it can be
 * used both for the initial render and for background polling.
 */
async function fetchLiveStatus(orderId) {
    const token = localStorage.getItem("auth_token");
    if (!token || !orderId) return null;
    const res = await api.get(`/orders/${encodeURIComponent(orderId)}`);
    return res?.data?.order || res?.order || null;
}

/**
 * Merge live delivery info / fees into the receipt without a full re-render.
 */
function renderReceiptFromLive(order) {
    if (order?.orderType) {
        const diningLabel = document.getElementById("receipt-dining-type");
        if (diningLabel) {
            diningLabel.textContent = order.orderType === "delivery" ? "Delivery" :
                order.orderType === "dine-in" ? "Dine-In" : "Takeaway";
        }
    }
    const deliveryInfo = order?.deliveryInfo;
    const addressRow = document.getElementById("delivery-address-row");
    if (addressRow && deliveryInfo) {
        addressRow.style.display = "block";
        const address = `${deliveryInfo.subCity || ""}, ${deliveryInfo.location || ""}`.replace(/^,\s*/, "").trim();
        if (document.getElementById("receipt-delivery-address")) {
            document.getElementById("receipt-delivery-address").textContent = address || "Please call customer for address";
        }
        const note = document.getElementById("receipt-delivery-note");
        if (note) note.textContent = deliveryInfo.note ? `Note: ${deliveryInfo.note}` : "";
    }
    if (order?.deliveryFee !== undefined) {
        const row = document.getElementById("receipt-delivery-fee-row");
        if (row && currentOrderType === "delivery") {
            row.style.display = "flex";
            if (document.getElementById("receipt-delivery-fee")) {
                document.getElementById("receipt-delivery-fee").textContent = Number(order.deliveryFee || 0).toFixed(0);
            }
        }
    }
}

/**
 * Shared handler for every live status frame (generic `order:status` plus the
 * named `order:ready-for-delivery` / `delivery:*` lifecycle events).
 */
function handleStatusFrame(order, orderId) {
    const liveId = (order?.orderId || order?.id || "").replace(/^#/, "");
    const currentId = String(orderId).replace(/^#/, "");
    if (liveId && currentId && liveId !== currentId) return; // not our order

    // The assignee travels on assignment frames; remembering it here is what
    // puts "delivery staff assigned" on screen even when the status itself
    // has not advanced past ready-for-delivery.
    rememberAssignee(order);

    // Refund frames (REFUND_REQUESTED -> REFUNDED) must render even if a
    // payload carries no `status`, so paint the banner first.
    renderRefundNotice(order);

    // A delivery frame carries the order-facing status in `status`; some
    // legacy payloads only have `orderStatus` / `deliveryStatus`. Read them
    // in that order of preference instead of treating the frame as statusless,
    // which used to blank the timeline.
    const newStatus = order?.status || order?.orderStatus || order?.deliveryStatus;
    if (!newStatus) return;

    if (order?.orderType) {
        currentOrderType = order.orderType;
        buildTimelineDOM(true);
    }

    // Only advance the timeline forward; ignore stale/older events.
    if (applyLiveStatus(newStatus)) {
        persistStatus(currentId, newStatus);
    }
    renderReceiptFromLive(order);
    announceLiveOrder({ ...order, orderType: order.orderType || currentOrderType });
}

function setupRealtime(orderId) {
    if (!orderId) return;

// Render a live update from a `order:status` / `delivery:status` frame.
    socketClient.on("order:status", (order) => {
        handleStatusFrame(order, orderId);
    });

    // Named lifecycle frames carry the same payload shape. They arrive on the
    // order room (scoped, never broadcast), and each one re-renders through
    // the exact same forward-only path as `order:status` - so the tracker
    // cannot show a stage the backend did not persist, and duplicates collapse
    // into the same idempotent repaint.
    ["order:ready-for-delivery", "delivery:assigned", "delivery:accepted", "delivery:started",
     "delivery:completed", "delivery:status"].forEach((event) => {
        socketClient.on(event, (order) => {
            handleStatusFrame(order, orderId);
        });
    });

    // Fallback: poll the backend periodically so the timeline advances even if
    // the socket is unreachable/disconnected. Stop once the order is terminal.
    startStatusPolling(orderId);

    // Join this order's room on the socket server (guarantees targeted events).
    // The socket connects even without an auth token so a tracking session always
    // gets live step-by-step updates when the kitchen / delivery staff act.
    socketClient.on("connect", () => {
        socketClient.joinOrderRoom(orderId);
    });
    try {
        const token = localStorage.getItem("auth_token");
        socketClient.connect(token);
        socketClient.joinOrderRoom(orderId);
    } catch (e) {
        console.log("Socket connect skipped:", e?.message);
    }
}

let statusPollTimer = null;

/**
 * Poll the backend for the live order status every few seconds and advance the
 * timeline as the kitchen / delivery staff update it.  This is a reliability
 * fallback for the socket: even if realtime fails, the tracker still reflects
 * the actual backend status.  Polling continues through all active steps
 * (including picked_up / out_for_delivery for delivery orders) and stops only
 * at a truly terminal state (served / delivered / completed / cancelled).
 */
function startStatusPolling(orderId) {
    if (!orderId) return;
    // Polling hits the authenticated backend endpoint, so only poll when the
    // customer has a token. Guests still get live updates through the socket.
    if (!localStorage.getItem("auth_token")) return;
    try { clearInterval(statusPollTimer); } catch (e) {}
    statusPollTimer = setInterval(async () => {
        try {
            const live = await fetchLiveStatus(orderId);
            if (!live || !live.status) return;
            const s = normalizeStatus(live.status);

            if (live.orderType) {
                currentOrderType = live.orderType;
                buildTimelineDOM(true);
            }

            // Only advance the timeline forward; ignore stale/older events.
            if (applyLiveStatus(s)) {
                persistStatus(orderId, live.status);
            }
            renderReceiptFromLive(live);
            renderRefundNotice(live);
            // Same single announcement the initial render makes, so the live GPS
            // map follows the poll too (it must not need its own polling loop).
            announceLiveOrder(live);

            // Terminal for the timeline, but a cancelled PAID order still has
            // the refund to follow (REFUND_REQUESTED -> REFUNDED): keep polling
            // until the refund settles too, so a refresh-less tracker still
            // shows the refund landing.
            const refundState = String(live.refundStatus || "").toUpperCase();
            const refundSettled =
                !refundState ||
                refundState === "REFUNDED" ||
                refundState === "REFUND_FAILED" ||
                refundState === "NOT_REQUIRED";
            const terminal =
                (s === "served" || s === "delivered" || s === "completed" || s === "cancelled") && refundSettled;
            if (terminal) {
                try { clearInterval(statusPollTimer); statusPollTimer = null; } catch (e) {}
            }
        } catch (err) {
            // Backend unreachable or not logged in; keep local state as-is.
        }
    }, 5000);
}

document.addEventListener("DOMContentLoaded", () => {
    const urlParams = new URLSearchParams(window.location.search);
    const requestedId = urlParams.get("orderId") || urlParams.get("id") || urlParams.get("ticket");

    function bootstrap() {
        let orderData = null;
        let historyData = JSON.parse(localStorage.getItem("orderHistory")) || [];
        let latestOrder = JSON.parse(localStorage.getItem("latestOrder"));

        if (requestedId) {
            orderData = historyData.find(o => (o.orderId || o.id) === requestedId);
        }

        if (!orderData) {
            orderData = latestOrder;
        }

        if (!orderData && !requestedId) {
            renderEmptyState();
            return;
        }

        // Resolve the authoritative orderId (local ticket number e.g. "ET-1234")
        const orderId = orderData?.orderId || orderData?.id || requestedId;

        // Dashboards may pass an id that includes a leading # - normalize for API call
        const normalizedId = String(orderId || "").replace(/^#/, "");

        // Kick off live status fetch + socket subscription.
        loadLiveOrder(normalizedId, orderData);
        setupRealtime(normalizedId);
    }

    bootstrap();

    // A customer who just logged in may not have localStorage order data yet
    // (customer-orders-sync.js rebuilds it asynchronously from the backend).
    // Re-check once the sync completes so the tracking page populates.
    if (!requestedId) {
        const onSynced = () => {
            if (JSON.parse(localStorage.getItem("latestOrder"))) {
                window.removeEventListener("customer:orders-synced", onSynced);
                bootstrap();
            }
        };
        window.addEventListener("customer:orders-synced", onSynced);
        // Safety net: also re-check after a short delay in case the event missed.
        setTimeout(onSynced, 2000);
    }
});
