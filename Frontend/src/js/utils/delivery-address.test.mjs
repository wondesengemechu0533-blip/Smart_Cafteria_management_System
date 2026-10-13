/**
 * Address composition tests (utils/delivery-address.js).
 *
 * The delivery address exists twice: as parts every card joins for display,
 * and as one line Google Maps navigates to. Both are built here, so these
 * tests pin the rules that keep them readable and unambiguous:
 *
 *   - the city is always inside the address (this is the whole point - a
 *     street name without a city resolves to Addis Ababa for every delivery);
 *   - the trailing country only appears when there is a line at all;
 *   - either half may be missing (legacy orders only collected an area).
 *
 * Run: node Frontend/src/js/utils/delivery-address.test.mjs
 */

let pass = 0;
let fail = 0;
function record(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " -- " + detail : "")); }
}

async function main() {
  const { composeSubCity, composeDeliveryAddress } = await import("./delivery-address.js");

  console.log("");
  console.log("--- composeSubCity (deliveryInfo.subCity) ---");

  record("area and city are joined, area first",
    composeSubCity("Bole", "Addis Ababa") === "Bole, Addis Ababa",
    composeSubCity("Bole", "Addis Ababa"));
  record("the city never lands in front of the area",
    composeSubCity("Kebele 04", "Debre Berhan").indexOf("Kebele 04") === 0);
  record("an area alone still stores (legacy forms)",
    composeSubCity("Bole", "") === "Bole" && composeSubCity("Bole", null) === "Bole");
  record("a city alone still stores",
    composeSubCity("", "Hawassa") === "Hawassa" && composeSubCity(undefined, "Hawassa") === "Hawassa");
  record("nothing in, nothing out",
    composeSubCity("", "") === "" && composeSubCity(null, undefined) === "");
  record("surrounding space is trimmed",
    composeSubCity("  Bole ", "  Addis Ababa ") === "Bole, Addis Ababa");
  record("area equal to the city is not doubled",
    composeSubCity("Addis Ababa", "Addis Ababa") === "Addis Ababa",
    composeSubCity("Addis Ababa", "Addis Ababa"));

  console.log("");
  console.log("--- composeDeliveryAddress (deliveryInfo.deliveryAddress) ---");

  const full = composeDeliveryAddress({
    houseNumber: "12",
    location: "Main Road, near DBU",
    area: "Bole",
    city: "Addis Ababa",
  });
  record("every part lands on the line, in order",
    full === "12, Main Road, near DBU, Bole, Addis Ababa, Ethiopia", full);
  record("the line names the country (Google Maps disambiguation)",
    full.endsWith(", Ethiopia") && full.includes("Addis Ababa"));
  record("missing parts leave no empty slots",
    composeDeliveryAddress({ houseNumber: "12", location: "", area: "Bole", city: "Addis Ababa" }) ===
      "12, Bole, Addis Ababa, Ethiopia");
  record("a city-only address still navigates",
    composeDeliveryAddress({ city: "Hawassa" }) === "Hawassa, Ethiopia");
  record("nothing in, empty out (never a dangling country)",
    composeDeliveryAddress({}) === "" && composeDeliveryAddress() === "" &&
      composeDeliveryAddress({ houseNumber: "  ", location: null }) === "");
  record("values are trimmed before joining",
    composeDeliveryAddress({ houseNumber: " 12 ", city: " Dire Dawa " }) === "12, Dire Dawa, Ethiopia");

  console.log("");
  console.log("========== DELIVERY ADDRESS TESTS ==========");
  console.log("PASS: " + pass + "  FAIL: " + fail + "  TOTAL: " + (pass + fail));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
