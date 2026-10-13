/**
 * Ethiopia dataset tests (utils/ethiopia-places.js).
 *
 * This file is the only geography fact the frontend owns, so the rules under
 * test are the ones that keep every address form and every map search honest:
 *
 *   - every city sits in a declared region with an in-Ethiopia coordinate;
 *   - the two address sets the app has ever shipped (Addis Ababa's 11
 *     official subcities, Debre Berhan's kebeles) are complete and stable;
 *   - the local search layer returns real coordinates only - the coordinateless
 *     kebeles are address-form material, never a map suggestion;
 *   - the checkout form and its JS still speak the ids this wiring expects.
 *
 * Run: node Frontend/src/js/utils/ethiopia-places.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendSrc = path.resolve(here, "..", "..");

let pass = 0;
let fail = 0;
function record(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " -- " + detail : "")); }
}

async function main() {
  const {
    ETHIOPIA_REGIONS,
    ETHIOPIA_CITIES,
    ETHIOPIA_LANDMARKS,
    findCity,
    citySubcities,
    groupCitiesByRegion,
    searchEthiopiaPlaces,
    getCityLandmarks,
    searchStreetSuggestions,
    searchLandmarkSuggestions,
  } = await import("./ethiopia-places.js");

  console.log("");
  console.log("--- dataset ---");

  const regions = new Set(ETHIOPIA_REGIONS.map((r) => r.trim().toLowerCase()));
  record("regions are declared", ETHIOPIA_REGIONS.length >= 10 && regions.size === ETHIOPIA_REGIONS.length,
    String(ETHIOPIA_REGIONS.length));
  record("the whole country is on the list",
    ["addis ababa", "dire dawa", "amhara", "oromia", "tigray", "somali", "sidama"].every((r) => regions.has(r)));

  const unknownRegions = ETHIOPIA_CITIES.filter((c) => !regions.has(String(c.region).trim().toLowerCase()));
  record("every city belongs to a declared region", unknownRegions.length === 0,
    unknownRegions.map((c) => c.name + " (" + c.region + ")").join(", "));
  record("the dataset covers a whole country, not one city", ETHIOPIA_CITIES.length >= 50,
    String(ETHIOPIA_CITIES.length));

  const names = ETHIOPIA_CITIES.map((c) => String(c.name).trim().toLowerCase());
  record("city names are unique", new Set(names).size === names.length,
    names.filter((n, i) => names.indexOf(n) !== i).join(", "));

  const badCoords = ETHIOPIA_CITIES.filter((c) =>
    !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude) ||
    c.latitude < 3 || c.latitude > 15.5 || c.longitude < 32.5 || c.longitude > 48);
  record("every city coordinate is finite and inside Ethiopia", badCoords.length === 0,
    badCoords.map((c) => c.name).join(", "));

  const capitals = ["Addis Ababa", "Bahir Dar", "Mekelle", "Hawassa", "Dire Dawa", "Adama", "Jimma"];
  record("the cities a customer is most likely to name are present",
    capitals.every((name) => names.includes(name.toLowerCase())),
    capitals.filter((name) => !names.includes(name.toLowerCase())).join(", "));

  console.log("");
  console.log("--- subcities ---");

  const addis = findCity("Addis Ababa");
  const expectedAddis = [
    "Addis Ketema", "Akaki Kaliti", "Arada", "Bole", "Gullele", "Kirkos",
    "Kolfe Keranio", "Lideta", "Nifas Silk-Lafto", "Yeka", "Lemi Kura",
  ];
  const addisSubs = citySubcities(addis);
  record("Addis Ababa ships its official 11 subcities",
    addisSubs.length === 11 && expectedAddis.every((name) => addisSubs.includes(name)),
    addisSubs.join(", "));
  record("the Addis subcities carry real coordinates",
    addis.subcities.every((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude) &&
      s.latitude >= 8.8 && s.latitude <= 9.2 && s.longitude >= 38.6 && s.longitude <= 39.0),
    JSON.stringify(addis.subcities.map((s) => [s.name, s.latitude, s.longitude])));

  const debreSubs = citySubcities("Debre Berhan");
  record("Debre Berhan keeps its nine kebeles",
    debreSubs.length === 9 && debreSubs[0] === "Kebele 01" && debreSubs[8] === "Kebele 09",
    debreSubs.join(", "));
  record("the kebeles have no invented coordinates",
    findCity("Debre Berhan").subcities.every((s) => s.latitude === undefined && s.longitude === undefined));

  const withDups = ETHIOPIA_CITIES.find((c) => {
    const subs = (c.subcities || []).map((s) => String(s.name).toLowerCase());
    return new Set(subs).size !== subs.length;
  });
  record("subcity names are unique within their city", !withDups, withDups && withDups.name);

  record("a city without a list answers with an empty array",
    citySubcities("Gode").length === 0 && citySubcities("not a city").length === 0);
  record("an empty lookup is null, not a crash", findCity("") === null && findCity(null) === null);

  console.log("");
  console.log("--- lookup / grouping ---");

  record("findCity is case-insensitive", findCity("hawassa").name === "Hawassa");
  record("findCity matches aliases (spellings drift)",
    findCity("Debre Birhan") && findCity("Debre Birhan").name === "Debre Berhan" &&
    findCity("Ziway") && findCity("Ziway").name === "Batu" &&
    findCity("Mekele").name === "Mekelle",
    [findCity("Debre Birhan"), findCity("Ziway"), findCity("Mekele")].map((c) => c && c.name).join(", "));

  const groups = groupCitiesByRegion();
  const groupedCount = groups.reduce((sum, g) => sum + g.cities.length, 0);
  record("grouping loses no city", groupedCount === ETHIOPIA_CITIES.length, groupedCount + " of " + ETHIOPIA_CITIES.length);
  const groupOrder = groups.map((g) => g.region.toLowerCase());
  record("groups follow ETHIOPIA_REGIONS order",
    groupOrder.every((region, i) => regions.has(region) && (i === 0 || groupOrder.indexOf(region) === i)),
    groupOrder.join(", "));
  record("cities inside a group are alphabetical",
    groups.every((g) => g.cities.every((c, i, arr) => i === 0 || arr[i - 1].name.localeCompare(c.name) <= 0)));
  record("no empty group survives", groups.every((g) => g.cities.length > 0));

  console.log("");
  console.log("--- local search layer ---");

  const bahir = searchEthiopiaPlaces("Bahir Dar");
  record("a city answers by name", bahir.length >= 1 && bahir[0].title === "Bahir Dar", JSON.stringify(bahir[0]));
  record("results are marked local and address the whole place",
    bahir[0].source === "local" && bahir[0].address === "Bahir Dar, Amhara, Ethiopia",
    JSON.stringify(bahir[0]));
  record("results carry numbers, not strings",
    typeof bahir[0].latitude === "number" && typeof bahir[0].longitude === "number");

  record("matching is case-insensitive",
    searchEthiopiaPlaces("bAhIr dAr")[0].title === "Bahir Dar");
  record("aliases are searchable",
    searchEthiopiaPlaces("debre birhan")[0].title === "Debre Berhan" &&
    searchEthiopiaPlaces("axum")[0].title === "Aksum");
  record("multi-token queries match against the whole address",
    searchEthiopiaPlaces("bole addis")[0].title === "Bole");
  record("a subcity result names its city",
    searchEthiopiaPlaces("bole")[0].address === "Bole, Addis Ababa, Ethiopia");

  const addisRank = searchEthiopiaPlaces("Addis");
  record("an exact city beats its subcities",
    addisRank.length > 1 && addisRank[0].title === "Addis Ababa",
    addisRank.map((r) => r.title).join(", "));

  const limited = searchEthiopiaPlaces("a", 3);
  record("the limit is honoured", limited.length > 0 && limited.length <= 3, String(limited.length));
  record("an unmatched query returns nothing", searchEthiopiaPlaces("Nowhere-village").length === 0);
  record("blank queries return nothing",
    searchEthiopiaPlaces("").length === 0 && searchEthiopiaPlaces("   ").length === 0 && searchEthiopiaPlaces(null).length === 0);

  record("coordinateless entries are never suggested",
    searchEthiopiaPlaces("Kebele 03").length === 0, JSON.stringify(searchEthiopiaPlaces("Kebele 03")));
  const inCountry = searchEthiopiaPlaces("a", 5).every((r) =>
    r.latitude >= 3 && r.latitude <= 15.5 && r.longitude >= 32.5 && r.longitude <= 48);
  record("every suggestion sits inside Ethiopia", inCountry);

  console.log("");
  console.log("--- famous places per city (street + landmark dropdowns) ---");

  const requiredPlaceCities = [
    "Addis Ababa", "Dire Dawa", "Bahir Dar", "Gondar", "Hawassa", "Adama",
    "Mekelle", "Jimma", "Dessie", "Debre Berhan", "Debre Markos", "Harar",
    "Jijiga", "Arba Minch", "Wolaita Sodo",
  ];
  const missingPlaces = requiredPlaceCities.filter((name) => getCityLandmarks(name).length === 0);
  record("every required city has famous places (never Debre Berhan-only)",
    missingPlaces.length === 0, missingPlaces.join(", "));
  const orphanKeys = Object.keys(ETHIOPIA_LANDMARKS).filter((key) => !findCity(key));
  record("every famous-place list belongs to a known city", orphanKeys.length === 0,
    orphanKeys.join(", "));

  const boleHits = searchStreetSuggestions("Addis Ababa", "Bole", 8);
  record("typing 'Bole' in Addis Ababa suggests Bole places",
    boleHits.includes("Bole Medhanialem") && boleHits.includes("Bole Road"),
    boleHits.join(", "));
  record("Addis Ababa suggestions include the requested famous places",
    ["Meskel Square", "Piassa", "Megenagna", "Merkato", "Addis Ababa University",
     "Bole International Airport", "Saris", "Gerji", "22 Mazoria",
     "Unity Park", "National Museum"].every((p) => getCityLandmarks("Addis Ababa").includes(p)));
  record("other cities suggest their own places, not Addis Ababa's",
    searchStreetSuggestions("Bahir Dar", "Tana", 8).includes("Lake Tana") &&
    !searchStreetSuggestions("Bahir Dar", "Tana", 8).includes("Meskel Square") &&
    searchStreetSuggestions("Hawassa", "Hawassa", 8).includes("Hawassa University") &&
    searchStreetSuggestions("Dire Dawa", "Kezira", 8).includes("Kezira"));
  record("the landmark picker mirrors the street dataset per city",
    searchLandmarkSuggestions("Addis Ababa", "Meskel", 8).includes("Meskel Square") &&
    searchLandmarkSuggestions("Hawassa", "", 3).length > 0);
  record("cities without predefined places answer empty (caller shows Other / manual)",
    searchStreetSuggestions("Gode", "", 8).length === 0 &&
    searchLandmarkSuggestions("Nowhere", "x", 8).length === 0 &&
    getCityLandmarks("not a city").length === 0);

  console.log("");
  console.log("--- form / wiring contract ---");

  const html = fs.readFileSync(path.join(frontendSrc, "pages", "customer", "checkout.html"), "utf8");
  record("checkout offers a city picker", html.includes('id="delivery-city"'));
  record("checkout offers a typed area for cities without a list", html.includes('id="delivery-area-text"'));
  record("the city list is injected, not hardcoded",
    html.includes('id="delivery-city"') && !html.includes("Debre Berhan Kebele 01"));
  record("the area select keeps its id for the JS and legacy tests",
    html.includes('id="delivery-subcity"'));
  record("every choice field opens a searchable dropdown",
    ["delivery-city-dropdown", "delivery-area-dropdown",
     "delivery-street-dropdown", "delivery-landmark-dropdown"].every((id) => html.includes('id="' + id + '"')));
  record("house number stays a plain text input (never a dropdown)",
    /id="delivery-house-number"[^>]*type="text"|type="text"[^>]*id="delivery-house-number"/.test(html) &&
    !html.includes('id="delivery-house-number-dropdown"'));

  const checkoutJs = fs.readFileSync(path.join(frontendSrc, "js", "checkout.js"), "utf8");
  record("checkout builds its options from this dataset",
    checkoutJs.includes('from "./utils/ethiopia-places.js"') && checkoutJs.includes("groupCitiesByRegion()"));
  record("checkout validates city and area separately",
    checkoutJs.includes("readCity()") && checkoutJs.includes("readArea()") &&
    checkoutJs.includes('"checkout_select_city"'));
  record("checkout stores the city inside both address forms",
    checkoutJs.includes("composeSubCity(deliveryArea, deliveryCity)") &&
    checkoutJs.includes("composeDeliveryAddress({"));
  record("checkout renders the fields through the reusable dropdown component",
    checkoutJs.includes("createSearchableDropdown") &&
    checkoutJs.includes("delivery-city-dropdown") &&
    checkoutJs.includes("delivery-area-dropdown") &&
    checkoutJs.includes("delivery-street-dropdown") &&
    checkoutJs.includes("delivery-landmark-dropdown"));

  const mapSearch = fs.readFileSync(path.join(frontendSrc, "js", "delivery", "geocode-search.js"), "utf8");
  record("the map search imports this dataset", mapSearch.includes("searchEthiopiaPlaces"));
  record("the map search only ever asks about Ethiopia",
    mapSearch.includes("countrycodes=et"));

  const i18n = fs.readFileSync(path.join(frontendSrc, "js", "utils", "i18n.js"), "utf8");
  const keys = ["select_city", "checkout_select_city", "checkout_other_city", "checkout_other_area"];
  // Counted with a leading non-word char so checkout_select_city never
  // inflates the count for select_city.
  const countKey = (src, key) => (src.match(new RegExp("(^|[^\\w])" + key + ":", "g")) || []).length;
  const missing = keys.filter((k) => countKey(i18n, k) !== 2);
  record("every address label exists in English AND Amharic", missing.length === 0, missing.join(", "));
  record("the Amharic values really are Amharic",
    /checkout_select_city:\s*'[^\x00-\x7F]/.test(i18n), "no non-ASCII value found");

  console.log("");
  console.log("========== ETHIOPIA PLACES TESTS ==========");
  console.log("PASS: " + pass + "  FAIL: " + fail + "  TOTAL: " + (pass + fail));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
