/**
 * Finance service - single source of truth for order money calculations.
 *
 * Keeps VAT/tax, platform service fee, delivery fee and revenue sharing
 * transparent and configurable through the Settings model (utils/settings.js).
 * No value that a cafeteria operator may need to change is hard-coded here.
 */

const { getSettingsMap } = require('../utils/settings');

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/**
 * Compute the full monetary breakdown for an order/cart.
 *
 * @param {object}  options
 * @param {number}  options.subtotal   Product subtotal (sum of line items)
 * @param {boolean} options.isDelivery Whether delivery is selected
 * @param {object}  [options.settings] Pre-loaded settings map (optional)
 * @param {number}  [options.deliveryFee] Authoritative delivery fee override.
 *   Pass this when the fee was already priced for the real destination
 *   (services/delivery.service.js `calculateDeliveryFee`). The VAT base and the
 *   total are then derived from that exact fee, so the amount the customer was
 *   quoted is the amount they are charged. Never pass a client-supplied value.
 * @returns {Promise<object>} breakdown with rounded amounts
 */
async function computeOrderCharges({
  subtotal = 0,
  isDelivery = false,
  settings = null,
  deliveryFee: deliveryFeeOverride = null,
} = {}) {
  const map = settings || (await getSettingsMap());

  const base = round2(Math.max(0, Number(subtotal) || 0));

  const vatEnabled = map.vat_enabled !== false && map.vat_enabled !== 'false';
  const vatRate = Math.max(0, Number(map.vat_rate) || 0);
  const platformFeeRate = Math.max(0, Number(map.platform_fee_rate) || 0);

  // Flat platform service fee only applies when there is a product subtotal.
  const serviceFee = base > 0 ? round2(Number(map.service_fee) || 0) : 0;

  // An explicit override wins over the flat setting. `undefined`/`null` means
  // "not priced yet", so the configured flat fee applies. A zero override is a
  // deliberate free-delivery discount and is respected.
  const hasOverride = deliveryFeeOverride !== null && deliveryFeeOverride !== undefined;
  const overrideAmount = hasOverride ? Number(deliveryFeeOverride) : NaN;
  const deliveryFee = !isDelivery
    ? 0
    : hasOverride && Number.isFinite(overrideAmount)
      ? round2(Math.max(0, overrideAmount))
      : round2(Number(map.delivery_fee) || 0);

  const taxableAmount = round2(base + serviceFee + deliveryFee);
  const vatAmount = vatEnabled ? round2((taxableAmount * vatRate) / 100) : 0;

  // Revenue sharing (percentage based, optional and configurable).
  const platformFee = round2((base * platformFeeRate) / 100);
  const platformShare = round2(serviceFee + platformFee);
  const cafeteriaShare = round2(base - platformFee);

  const totalAmount = round2(base + serviceFee + deliveryFee + vatAmount);

  return {
    subtotal: base,
    serviceFee,
    deliveryFee,
    taxableAmount,
    vatEnabled,
    vatRate,
    vatAmount,
    platformFeeRate,
    platformFee,
    cafeteriaShare,
    platformShare,
    taxAmount: vatAmount,
    totalAmount,
    currency: map.currency || 'ETB',
  };
}

module.exports = { computeOrderCharges, round2 };
