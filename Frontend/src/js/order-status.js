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
 * Update the status heading/badge/subtext based on the order status.
 */
function setStatusText(status) {
    const s = normalizeStatus(status);
    const heading = document.getElementById("status-heading");
    const subtext = document.getElementById("status-subtext");
    const icon = document.getElementById("status-badge-icon");
    if (!heading && !subtext) return;

    const refunded = normalizeStatus(currentRefundStatus) === "refunded";
    const refundPending = ["refund_requested", "refund_approved", "refund_processing"].includes(normalizeStatus(currentRefundStatus));

    const map = {
        received: ["Order Received", "We have sent your order directly to the kitchen counter."],
        pending: ["Order Received", "We have sent your order directly to the kitchen counter."],
        preparing: ["Preparing", "The kitchen is preparing your order. Please wait."],
        ready: ["Ready", "Your order is " + (currentOrderType === "delivery" ? "ready for delivery!" : "ready for pickup!")],
        picked_up: ["Picked Up", "Your order has been picked up by our delivery rider."],
        out_for_delivery: ["Out for Delivery", "Your order is out for delivery. Our delivery person is on the way!"],
        delivered: ["Delivered", "Your order has been delivered. Enjoy your meal!"],
        served: ["Served", "Your order has been served."],
        completed: ["Completed", "Your order has been completed."],
        cancelled: refunded
            ? ["Order Cancelled & Refunded", "This order was cancelled and your payment has been refunded."]
            : refundPending
                ? ["Order Cancelled — Refund Pending", "This order was cancelled. Your refund is queued and will be processed by an administrator — you'll be notified once complete."]
                : ["Order Cancelled", "This order was cancelled and will not be prepared."]
    };

    // Legacy "received" status is mapped to the first step (Order Received) so
    // the tracker always starts at step 1 rather than showing a generic state.
    const entry = map[s] || (s === "received" ? map.received : undefined) || ["Order Tracker", "We are processing your order."];

    if (heading) heading.textContent = entry[0];
    if (subtext) subtext.textContent = entry[1];

    if (icon) {
        const icons = {
            received: 'fa-circle-check',
            pending: 'fa-circle-check',
            preparing: 'fa-fire-burner',
            ready: 'fa-bell-concierge',
            picked_up: 'fa-handshake',
            out_for_delivery: 'fa-truck-fast',
            delivered: 'fa-circle-check',
            served: 'fa-circle-check',
            completed: 'fa-circle-check',
            cancelled: refunded ? 'fa-circle-check' : 'fa-circle-xmark'
        };
        const colors = {
            received: '#16a34a',
            pending: '#16a34a',
            preparing: '#16a34a',
            ready: '#16a34a',
            picked_up: '#7c3aed',
            out_for_delivery: '#ff6b00',
            delivered: '#16a34a',
            served: '#16a34a',
            completed: '#16a34a',
            cancelled: refunded ? '#16a34a' : '#dc3545'
        };
        icon.innerHTML = `<i class="fa-solid ${icons[s] || 'fa-circle-check'}" style="color: ${colors[s] || '#ff6b00'}; font-size: 2.5rem;"></i>`;
    }

    renderRefundNote();
    // Gate the cancel button (hide actions for terminal statuses)
    updateCancelButton(s);
}

/**
 * Show a small inline note under the status banner clarifying the refund state
 * when the order was cancelled (pending admin refund vs fully refunded).
 */
function renderRefundNote() {
    const banner = document.getElementById("status-banner-card");
    if (!banner) return;

    const s = normalizeStatus(currentRefundStatus);
    const refunded = s === "refunded";
    const pending = ["refund_requested", "refund_approved", "refund_processing"].includes(s);

    let el = document.getElementById("refund-status-note");
    if (!el) {
        el = document.createElement("p");
        el.id = "refund-status-note";
        el.style.margin = "10px auto 0";
        el.style.textAlign = "left";
        banner.appendChild(el);
    }

    if (refunded) {
        el.style.cssText += ";max-width:460px;padding:10px 14px;background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;border-radius:8px;font-weight:600;display:block;";
        el.innerHTML = `<i class="fa-solid fa-circle-check"></i>&nbsp; Your payment of <strong>${Number(currentRefundAmount).toFixed(0)} ETB</strong> has been <strong>refunded</strong>.`;
    } else if (pending) {
        el.style.cssText += ";max-width:460px;padding:10px 14px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:8px;font-weight:600;display:block;";
        el.innerHTML = `<i class="fa-solid fa-hourglass-half"></i>&nbsp; Refund <strong>pending</strong> — an administrator must process it. You'll be notified when the refund is complete.`;
    } else {
        el.remove();
    }
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

/**
 * The order type currently being tracked (used by status text / timeline).
 * Updated by renderOrder() and by live socket/poll updates.
 */
let currentOrderType = "dine-in";

/**
 * The live refund state of the tracked order (REFUNDED / REFUND_REQUESTED / …).
 * Populated from backend payloads so the cancelled state can show exactly where
 * the refund stands (queue until an admin processes it → REFUNDED).
 */
let currentRefundStatus = null;
let currentRefundAmount = 0;

/**
 * Tracks the highest step reached for the current delivery flow so that only
 * genuinely forward (monotonic) status changes advance the timeline. Stale or
 * older socket events can never move the tracker backwards.
 */
let latestActiveIndex = -1;

/**
 * Build the timeline steps. Pickup orders get 3 steps; delivery orders get all
 * 7 steps (Received -> Preparing -> Ready -> Picked Up -> Out for Delivery ->
 * Delivered -> Completed).
 * Returns an array of { stepId, lineId, key, strong, small, icon }.
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
        { key: "picked_up", strong: "Picked Up", small: "Driver has the order", icon: "fa-handshake" },
        { key: "out_for_delivery", strong: "Out for Delivery", small: "Rider on the way", icon: "fa-truck-fast" },
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
    currentRefundStatus = orderData.refundStatus || null;
    currentRefundAmount = Number(orderData.refundAmount) || 0;
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
    const status = orderData.status || "Pending";
    renderTimeline(status, { regressible: true });
    setStatusText(status);
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

function setupRealtime(orderId) {
    if (!orderId) return;

socketClient.on("order:status", (order) => {
        const liveId = (order?.orderId || order?.id || "").replace(/^#/, "");
        const currentId = String(orderId).replace(/^#/, "");
        if (liveId && currentId && liveId !== currentId) return; // not our order

        const newStatus = order?.status;
        if (!newStatus) return;

        if (order?.refundStatus !== undefined) {
            currentRefundStatus = order.refundStatus;
            if (order.refundAmount !== undefined) currentRefundAmount = Number(order.refundAmount) || 0;
        }

        if (order?.orderType) {
            currentOrderType = order.orderType;
            buildTimelineDOM(true);
        }

        // Only advance the timeline forward; ignore stale/older events.
        if (applyLiveStatus(newStatus)) {
            persistStatus(currentId, newStatus);
        }
        renderReceiptFromLive(order);
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

            if (live.refundStatus !== undefined) {
                currentRefundStatus = live.refundStatus;
                if (live.refundAmount !== undefined) currentRefundAmount = Number(live.refundAmount) || 0;
            }

            if (live.orderType) {
                currentOrderType = live.orderType;
                buildTimelineDOM(true);
            }

            // Only advance the timeline forward; ignore stale/older events.
            if (applyLiveStatus(s)) {
                persistStatus(orderId, live.status);
            }
            renderReceiptFromLive(live);

            const terminal = s === "served" || s === "delivered" || s === "completed" || s === "cancelled";
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
