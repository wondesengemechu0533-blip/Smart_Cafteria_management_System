/**
 * Smart Cafeteria Ordering System
 * File: frontend/src/js/order-cancellation.js
 *
 * Customer-facing cancellation helpers.
 *   - requestCancellation(orderId, reason, details)
 *   - getCancellationReasons(lang)
 *   - delegated [data-cancel-order] click handling
 *
 * Policy: a customer may only cancel while the order is still PENDING /
 * RECEIVED (before the kitchen starts preparing). A pending cancellation is
 * applied immediately; if the order was paid, the refund is queued for admin
 * review and processing (PENDING → CANCELLED → Admin Refund → REFUNDED).
 */

import api from "../js/api.js";

const CANCELLATION_REASONS_EN = [
    { value: "CUSTOMER_CHANGED_MIND", label: "I changed my mind" },
    { value: "ORDERED_BY_MISTAKE", label: "I ordered by mistake" },
    { value: "LONG_PREPARATION_TIME", label: "Preparation is taking too long" },
    { value: "FOOD_UNAVAILABLE", label: "The food is unavailable" },
    { value: "PAYMENT_ISSUE", label: "Payment issue" },
    { value: "DUPLICATE_ORDER", label: "Duplicate order" },
    { value: "CAFETERIA_ISSUE", label: "Cafeteria issue" },
    { value: "OTHER", label: "Other" }
];

const CANCELLATION_REASONS_AM = [
    { value: "CUSTOMER_CHANGED_MIND", label: "ሀሳቤ ተቀየረ" },
    { value: "ORDERED_BY_MISTAKE", label: "በስህተት አዘዝኩ" },
    { value: "LONG_PREPARATION_TIME", label: "ዝግጅቱ ጊዜ ወስዷል" },
    { value: "FOOD_UNAVAILABLE", label: "ምግቡ አልተገኘም" },
    { value: "PAYMENT_ISSUE", label: "የክፍያ ችግር" },
    { value: "DUPLICATE_ORDER", label: "ደጋግሞ የታዘዘ ትዕዛዝ" },
    { value: "CAFETERIA_ISSUE", label: "የካፍቴሪያ ችግር" },
    { value: "OTHER", label: "ሌላ" }
];

/**
 * Return the list of selectable cancellation reasons for a locale.
 * @param {string} [lang='en'] 'en' | 'am'
 * @returns {Array<{value: string, label: string}>}
 */
export function getCancellationReasons(lang = "en") {
    return lang === "am" ? CANCELLATION_REASONS_AM : CANCELLATION_REASONS_EN;
}

/**
 * Submit a cancellation request for an order. For a pending order this is a
 * self-service action: the order is cancelled immediately and, if paid, a
 * full refund is processed automatically.
 * @param {string} orderId  - human-friendly order id (e.g. ET-xxxx)
 * @param {string} reason   - one of the CANCELLATION_REASONS values
 * @param {string} [details] - optional explanation
 * @returns {Promise<object>} { success, message, refunded, cancellation }
 */
export async function requestCancellation(orderId, reason, details = "") {
    if (!orderId) throw new Error("Order ID is required.");
    if (!reason) throw new Error("A cancellation reason is required.");
    return api.post("/cancellations/request", {
        orderId,
        reason,
        details
    });
}

document.addEventListener("DOMContentLoaded", () => {
    initializeCancellation();
});

function initializeCancellation() {
    document.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-cancel-order]");
        if (!button) return;
        if (button.dataset.processing === "true" || button.disabled) return;

        const orderId = button.dataset.cancelOrder;
        if (!orderId) return;

        const confirmed = confirm("Are you sure you want to cancel this order?");
        if (!confirmed) return;

        const originalText = button.textContent || "Cancel Order";
        try {
            button.dataset.processing = "true";
            button.disabled = true;
            button.textContent = "Cancelling...";

            await requestCancellation(orderId, "CUSTOMER_CHANGED_MIND", "Cancelled by customer");

            alert("Order cancelled successfully. If you paid, your refund will be processed by an administrator and you will be notified.");
            window.location.reload();
        } catch (error) {
            alert(error.message || "Failed to submit cancellation request");
            button.dataset.processing = "false";
            button.disabled = false;
            button.textContent = originalText;
        }
    });
}