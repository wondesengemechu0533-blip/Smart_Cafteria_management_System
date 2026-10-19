/**
 * Refund Summary (shared)
 *
 * Mirrors Backend/src/utils/money.js `computeRefundSummary` exactly, so the
 * customer cancellation page and the Manager/Admin refund dashboard show the
 * same numbers the backend refunds:
 *
 *   Subtotal      = the food subtotal that was originally charged
 *   Service Fee   = the platform service fee, on its own line
 *   Total Paid    = Subtotal + Service Fee        (VAT is NOT included)
 *   Refund Amount = Subtotal
 *
 * VAT is deliberately absent: it is never shown in a refund summary and never
 * paid back. The order's stored `totalAmount` is the immutable record of what
 * the gateway charged and is left untouched by every refund calculation.
 *
 * When the API supplies `refundSummary` (it does, on both the order summary
 * and the serialized cancellation) those values are used verbatim, so the UI
 * can never drift from the server. The local calculation below is only a
 * fallback for payloads that predate the field.
 */

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * Build the refund summary for an order, cancellation or refund payload.
 *
 * @param {object} [source] Object carrying the money fields.
 * @returns {{subtotal:number, serviceFee:number, totalPaid:number, refundAmount:number, currency:string}}
 */
export function computeRefundSummary(source) {
    const src = source || {};

    // Prefer the server-computed summary when present.
    const provided = src.refundSummary;
    if (provided && typeof provided === "object") {
        const subtotal = round2(Math.max(0, num(provided.subtotal)));
        const serviceFee = round2(Math.max(0, num(provided.serviceFee)));
        return {
            subtotal,
            serviceFee,
            totalPaid: round2(subtotal + serviceFee),
            refundAmount: subtotal,
            currency: provided.currency || src.currency || "ETB"
        };
    }

    const serviceFee = Math.max(0, num(src.serviceFee));

    let subtotal = num(src.subtotal);
    if (subtotal <= 0) {
        // Legacy order with no stored subtotal: recover it from the charged
        // total by removing the service fee, the delivery fee and the VAT.
        const vatAmount = Math.max(0, num(src.vatAmount) || num(src.taxAmount));
        const deliveryFee = Math.max(0, num(src.deliveryFee));
        subtotal = Math.max(0, num(src.totalAmount) - serviceFee - deliveryFee - vatAmount);
    }
    subtotal = Math.max(0, round2(subtotal));

    return {
        subtotal,
        serviceFee: round2(serviceFee),
        totalPaid: round2(subtotal + serviceFee),
        refundAmount: subtotal,
        currency: src.currency || "ETB"
    };
}

/**
 * Format a summary line as an amount, e.g. `100.00 ETB`.
 */
export function formatRefundAmount(value, currency = "ETB") {
    return `${round2(Math.max(0, num(value))).toFixed(2)} ${currency}`;
}

/**
 * Fill a set of elements with the summary lines, in order:
 * Subtotal, Service Fee, Total Paid, Refund Amount.
 *
 * Any element that is not on the page is simply skipped, so the same helper
 * serves both the customer modal and the Manager/Admin dashboard.
 */
export function renderRefundSummary(summary, elementIds) {
    const values = [
        summary.subtotal,
        summary.serviceFee,
        summary.totalPaid,
        summary.refundAmount
    ];
    (elementIds || []).forEach((id, index) => {
        const el = document.getElementById(id);
        if (el) el.textContent = formatRefundAmount(values[index], summary.currency);
    });
    return summary;
}

// Also exposed on window for the non-module scripts that drive these pages.
if (typeof window !== "undefined") {
    window.RefundSummary = {
        computeRefundSummary,
        formatRefundAmount,
        renderRefundSummary
    };
}

export default computeRefundSummary;
