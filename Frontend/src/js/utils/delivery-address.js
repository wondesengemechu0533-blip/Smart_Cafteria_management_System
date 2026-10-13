/**
 * Smart Cafeteria Ordering System
 * File: frontend/src/js/utils/delivery-address.js
 *
 * The delivery address is stored twice: as parts (subCity, location) that
 * every card, ticket and status page joins for display, and as the single
 * deliveryAddress string the Google Maps navigation falls back to when the
 * customer shared no GPS fix.
 *
 * Both used to be built in checkout.js without a city, so a rider tapping
 * Navigate sent Google Maps "House 12, Main Road" - a nameless street that
 * resolves to Addis Ababa no matter where the customer actually is. These two
 * helpers are the one place an address is assembled, and both always carry the
 * city:
 *
 *   composeSubCity("Bole", "Addis Ababa")              -> "Bole, Addis Ababa"
 *   composeDeliveryAddress({houseNumber: "12", ...})    -> "12, Main Road,
 *                                                          Bole, Addis Ababa,
 *                                                          Ethiopia"
 *
 * The trailing "Ethiopia" exists for the same reason: it is what makes a
 * destination unambiguous in a country-ambiguous geocoder.
 *
 * Kept dependency-free so Node tests can import it directly.
 */

function clean(value) {
  return String(value == null ? "" : value).trim();
}

/**
 * The value stored in deliveryInfo.subCity: the area the customer picked,
 * qualified by the city it lives in. Either half may be missing (older forms
 * only had an area) - the present parts are simply joined.
 *
 * @param {string} area  subcity / kebele / typed area
 * @param {string} city  city name
 * @returns {string}
 */
export function composeSubCity(area, city) {
  const a = clean(area);
  const c = clean(city);
  if (a && c && a.toLowerCase() === c.toLowerCase()) return a;
  return [a, c].filter(Boolean).join(", ");
}

/**
 * True when an area string looks like a kebele (numbered or Amharic label).
 * Used only to split the single Area/Subcity/Kebele picker into the
 * separate `area` + `kebele` values the backend stores.
 */
export function isKebeleLike(value) {
  const text = clean(value);
  if (!text) return false;
  if (/ቀበሌ/i.test(text)) return true;
  if (/kebele/i.test(text)) return true;
  if (/^\d{1,2}$/.test(text)) return true;
  return false;
}

/**
 * Reusable Ethiopian delivery-location builder.
 *
 * Keeps every location value SEPARATE (never one combined string):
 *   { city, area, kebele, streetArea, landmark, houseNumber }
 * plus the two legacy display strings (`subCity`, `location`,
 * `deliveryAddress`) every existing card, ticket, tracker and Google Maps
 * fallback already reads - so old screens keep working unchanged.
 *
 * @param {object} parts { city, area, kebele?, streetArea?, location?, landmark?, houseNumber? }
 * @returns {{city, area, kebele, streetArea, landmark, houseNumber, subCity, location, deliveryAddress}}
 */
export function buildStructuredDeliveryAddress(parts) {
  const p = parts || {};
  const city = clean(p.city);
  const area = clean(p.area);
  const streetArea = clean(p.streetArea || p.location);
  const landmark = clean(p.landmark);
  const houseNumber = clean(p.houseNumber);
  const explicitKebele = clean(p.kebele);
  const kebele = explicitKebele || (isKebeleLike(area) ? area : "");
  const subCity = composeSubCity(area, city);
  const location = [
    houseNumber ? "House Number: " + houseNumber : "",
    [streetArea, landmark].filter(Boolean).join(" (") + (streetArea && landmark ? ")" : ""),
  ]
    .filter(Boolean)
    .join(", ");
  const deliveryAddress = composeDeliveryAddress({
    houseNumber: houseNumber ? "House Number: " + houseNumber : "",
    location: [streetArea, landmark].filter(Boolean).join(", "),
    area,
    city,
  });
  return { city, area, kebele, streetArea, landmark, houseNumber, subCity, location, deliveryAddress };
}
export function composeDeliveryAddress(parts) {
  const p = parts || {};
  const line = [clean(p.houseNumber), clean(p.location), clean(p.area), clean(p.city)]
    .filter(Boolean)
    .join(", ");
  return line ? line + ", Ethiopia" : "";
}
