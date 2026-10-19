/**
 * Money helpers - dependency-free so they can be required from models,
 * services and controllers alike without creating a require cycle.
 */

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/**
 * Build the refund summary for an order.
 *
 * This is the ONE definition of "how much was paid" and "how much comes
 * back", used by every backend refund path and echoed to the frontend so both
 * sides render identical numbers. VAT is deliberately absent from the result:
 *
 *   Subtotal      = the food subtotal that was originally charged
 *   Service Fee   = the platform service fee, shown on its own line
 *   Total Paid    = Subtotal + Service Fee        (VAT is NOT included)
 *   Refund Amount = Subtotal
 *
 * The stored `totalAmount` / `vatAmount` / `taxAmount` on the order are left
 * untouched: they are the immutable record of what the gateway actually
 * charged and are still used for receipts and tax reporting.
 *
 * @param {object} [order] Order document or plain object carrying the money fields.
 * @returns {{subtotal:number, serviceFee:number, totalPaid:number, refundAmount:number, currency:string}}
 */
function computeRefundSummary(order) {
  const src = order || {};

  const serviceFee = Math.max(0, Number(src.serviceFee) || 0);

  const storedSubtotal = Number(src.subtotal) || 0;
  let subtotal = storedSubtotal;

  if (subtotal <= 0) {
    // Legacy orders created before `subtotal` was persisted. Recover it from the
    // stored total by removing everything that is NOT food: the service fee,
    // the delivery fee and the VAT. VAT has to be subtracted here too, otherwise
    // the recovered subtotal would silently include tax and over-refund.
    const vatAmount = Math.max(0, Number(src.vatAmount) || Number(src.taxAmount) || 0);
    const deliveryFee = Math.max(0, Number(src.deliveryFee) || 0);
    subtotal = Math.max(0, (Number(src.totalAmount) || 0) - serviceFee - deliveryFee - vatAmount);
  }
  subtotal = Math.max(0, round2(subtotal));

  const totalPaid = round2(subtotal + serviceFee);

  return {
    subtotal,
    serviceFee: round2(serviceFee),
    totalPaid,
    refundAmount: subtotal,
    currency: 'ETB',
  };
}

/**
 * Resolve the refund amount to use for an order.
 *
 * An explicitly supplied (admin-entered) amount always wins; otherwise the
 * food subtotal is used. The result is clamped to the subtotal so no path can
 * refund more than the food the customer actually paid for.
 *
 * @param {object} order Order document or plain object.
 * @param {number} [requested] Explicitly requested amount, if any.
 */
function resolveRefundAmount(order, requested) {
  const summary = computeRefundSummary(order);
  const explicit = Number(requested);

  if (!Number.isFinite(explicit) || explicit < 0) return summary.refundAmount;
  if (summary.refundAmount <= 0) return 0;
  return round2(Math.min(explicit, summary.refundAmount));
}

module.exports = { round2, computeRefundSummary, resolveRefundAmount };
