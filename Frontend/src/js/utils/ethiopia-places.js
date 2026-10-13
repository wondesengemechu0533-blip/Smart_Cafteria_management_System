/**
 * Smart Cafeteria Ordering System
 * File: frontend/src/js/utils/ethiopia-places.js
 *
 * Where can a customer actually be? The answer used to be hardcoded into a
 * single <select> (Debre Berhan kebeles) while the maps and the delivery range
 * assumed Addis Ababa - so every other Ethiopian city was unreachable.
 *
 * This module is the one geography fact for the whole frontend:
 *   - ETHIOPIA_REGIONS / ETHIOPIA_CITIES: every region with its major cities
 *     (name, region, centre coordinate, optional subcities);
 *   - Addis Ababa ships its official 11 subcities, Debre Berhan its kebeles,
 *     so the two addresses the app has ever used keep working;
 *   - citySubcities() powers the checkout area picker;
 *   - searchEthiopiaPlaces() is the offline-safe local layer of the map search
 *     box (delivery/geocode-search.js): every city and subcity below is
 *     suggestable even when Nominatim is rate-limited or unreachable.
 *
 * Coordinates are Nominatim (OpenStreetMap) centre points for the named place,
 * collected once when this file was written - the same service the search box
 * queries live, so the local layer and the remote layer agree. Entries without
 * a coordinate (the Debre Berhan kebeles) stay usable for address forms but are
 * NEVER returned as search results: this project does not invent a position.
 */

/** Regions in menu order (the two chartered cities first, then by name). */
export const ETHIOPIA_REGIONS = [
  "Addis Ababa",
  "Dire Dawa",
  "Amhara",
  "Oromia",
  "Tigray",
  "Sidama",
  "Somali",
  "Harari",
  "Afar",
  "Benishangul-Gumuz",
  "Gambela",
  "Central Ethiopia",
  "South Ethiopia",
  "South West Ethiopia",
];

/**
 * Cities grouped by region.
 *
 * shape: { name, region, latitude, longitude, aliases?: string[],
 *          subcities?: [{ name, latitude?, longitude?, aliases?: string[] }] }
 */
export const ETHIOPIA_CITIES = [
  // --- Addis Ababa (chartered city) ---------------------------------------
  {
    name: "Addis Ababa",
    region: "Addis Ababa",
    latitude: 9.0,
    longitude: 38.75,
    aliases: ["Adis Abeba", "Addis"],
    subcities: [
      { name: "Addis Ketema", latitude: 9.0367127, longitude: 38.7275668, aliases: ["Addis Ketema"] },
      { name: "Akaki Kaliti", latitude: 8.8985522, longitude: 38.8103421, aliases: ["Akaki-Kality", "Akaki Kality"] },
      { name: "Arada", latitude: 9.0358119, longitude: 38.7524315, aliases: ["Arada"] },
      { name: "Bole", latitude: 8.9822541, longitude: 38.8383871, aliases: ["Bole"] },
      { name: "Gullele", latitude: 9.072071, longitude: 38.7328969, aliases: ["Gulele"] },
      { name: "Kirkos", latitude: 9.0026308, longitude: 38.7579708, aliases: ["Kerkos"] },
      { name: "Kolfe Keranio", latitude: 9.0181869, longitude: 38.6897829, aliases: ["Kolfe Keraniyo", "Kolfe Keranio"] },
      { name: "Lideta", latitude: 9.0114751, longitude: 38.7288996, aliases: ["Lideta"] },
      { name: "Nifas Silk-Lafto", latitude: 8.9779209, longitude: 38.751575, aliases: ["Nifas Slik Lafto", "Nifas Silk Lafto"] },
      { name: "Yeka", latitude: 9.0488191, longitude: 38.8283055, aliases: ["Yeka"] },
      { name: "Lemi Kura", latitude: 9.0271462, longitude: 38.8782805, aliases: ["Lemi kura", "Lemi-Kura"] },
    ],
  },

  // --- Dire Dawa (chartered city) -----------------------------------------
  {
    name: "Dire Dawa",
    region: "Dire Dawa",
    latitude: 9.5913368,
    longitude: 41.8566126,
    aliases: ["Dire Dewa"],
    // Named local areas used by the address form (no coordinates invented).
    subcities: [
      { name: "Kezira" },
      { name: "Sabian" },
      { name: "Melka Jebdu" },
      { name: "Gende Kore" },
      { name: "Addis Ketema" },
      { name: "Dechatu" },
      { name: "Goro" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ],
  },

  // --- Amhara --------------------------------------------------------------
  { name: "Bahir Dar", region: "Amhara", latitude: 11.5949663, longitude: 37.3882251, aliases: ["Bahirdar"],
    subcities: [
      { name: "Abay Mado" },
      { name: "Belay Zeleke" },
      { name: "Fasilo" },
      { name: "Gish Abay" },
      { name: "Tana" },
      { name: "Shimbit" },
      { name: "Hidar 11" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ] },
  { name: "Gondar", region: "Amhara", latitude: 12.610368, longitude: 37.466766, aliases: ["Gonder"],
    subcities: [
      { name: "Arada" },
      { name: "Azezo" },
      { name: "Fasiledes" },
      { name: "Maraki" },
      { name: "Piassa" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ] },
  { name: "Dessie", region: "Amhara", latitude: 11.122604, longitude: 39.634982, aliases: ["Dese"],
    subcities: [
      { name: "Arada" },
      { name: "Hote" },
      { name: "Menafesha" },
      { name: "Segno Gebeya" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ] },
  {
    name: "Debre Berhan",
    region: "Amhara",
    latitude: 9.6752117,
    longitude: 39.5324899,
    aliases: ["Debre Birhan"],
    // The kebeles the address form shipped with - kept so old addresses and
    // new orders use the same names. No coordinates: never shown on the map.
    subcities: [
      { name: "Kebele 01" },
      { name: "Kebele 02" },
      { name: "Kebele 03" },
      { name: "Kebele 04" },
      { name: "Kebele 05" },
      { name: "Kebele 06" },
      { name: "Kebele 07" },
      { name: "Kebele 08" },
      { name: "Kebele 09" },
    ],
  },
  { name: "Debre Markos", region: "Amhara", latitude: 10.3358665, longitude: 37.7285604, aliases: ["Debre Marqos"],
    subcities: [
      { name: "Abma Mariam" },
      { name: "Hospital Area" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
      { name: "Kebele 03" },
    ] },
  { name: "Kombolcha", region: "Amhara", latitude: 11.0813583, longitude: 39.7408732,
    subcities: [
      { name: "Kebele 01" },
      { name: "Kebele 02" },
      { name: "Kebele 03" },
      { name: "Kebele 04" },
      { name: "Industrial Area" },
    ] },
  { name: "Debre Tabor", region: "Amhara", latitude: 11.856591, longitude: 38.008309,
    subcities: [
      { name: "Hospital Area" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
      { name: "Kebele 03" },
    ] },
  { name: "Weldiya", region: "Amhara", latitude: 11.828852, longitude: 39.596326, aliases: ["Woldia"] },
  { name: "Finote Selam", region: "Amhara", latitude: 10.6800221, longitude: 37.2601268 },
  { name: "Mota", region: "Amhara", latitude: 11.081414, longitude: 37.880986 },
  { name: "Kobo", region: "Amhara", latitude: 12.15063, longitude: 39.628837 },
  { name: "Lalibela", region: "Amhara", latitude: 12.0360639, longitude: 39.0456845 },
  { name: "Debre Sina", region: "Amhara", latitude: 9.8504801, longitude: 39.7634761 },

  // --- Oromia --------------------------------------------------------------
  { name: "Adama", region: "Oromia", latitude: 8.5440099, longitude: 39.2704532, aliases: ["Nazret"],
    subcities: [
      { name: "Abba Geda" },
      { name: "Bole" },
      { name: "Dembela" },
      { name: "Geda" },
      { name: "Melka Adama" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ] },
  { name: "Bishoftu", region: "Oromia", latitude: 8.750004, longitude: 38.981734, aliases: ["Debre Zeyit"],
    subcities: [
      { name: "Kuriftu" },
      { name: "Chelekleka" },
      { name: "Hora" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
      { name: "Kebele 03" },
    ] },
  { name: "Jimma", region: "Oromia", latitude: 7.6756152, longitude: 36.8478779,
    subcities: [
      { name: "Ginjo" },
      { name: "Hermata" },
      { name: "Mendera Kochi" },
      { name: "Bosa Kitto" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ] },
  { name: "Shashamene", region: "Oromia", latitude: 7.2039064, longitude: 38.6089641, aliases: ["Shashemene"],
    subcities: [
      { name: "Abosto" },
      { name: "Kuyera" },
      { name: "Burka Daka" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ] },
  { name: "Nekemte", region: "Oromia", latitude: 9.0905237, longitude: 36.5481573, aliases: ["Naqamte"],
    subcities: [
      { name: "Bake Jama" },
      { name: "Burka Jato" },
      { name: "Kaso" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ] },
  { name: "Assela", region: "Oromia", latitude: 7.9541746, longitude: 39.1319745, aliases: ["Asella"] },
  { name: "Ambo", region: "Oromia", latitude: 8.982104, longitude: 37.8554406 },
  { name: "Robe", region: "Oromia", latitude: 7.1242676, longitude: 40.0080973, aliases: ["Bale Robe"] },
  { name: "Waliso", region: "Oromia", latitude: 8.5388595, longitude: 37.9761854 },
  { name: "Chiro", region: "Oromia", latitude: 9.087481, longitude: 40.8663309, aliases: ["Chiro"] },
  { name: "Goba", region: "Oromia", latitude: 7.0073251, longitude: 39.9694204 },
  { name: "Gimbi", region: "Oromia", latitude: 8.8061916, longitude: 37.7881259 },
  { name: "Haramaya", region: "Oromia", latitude: 9.3946187, longitude: 42.0133864, aliases: ["Haramaya"] },
  { name: "Mojo", region: "Oromia", latitude: 8.5869874, longitude: 39.125 },
  { name: "Batu", region: "Oromia", latitude: 7.9358063, longitude: 38.7164929, aliases: ["Ziway"] },
  { name: "Metu", region: "Oromia", latitude: 8.2956473, longitude: 35.5834319 },
  { name: "Fiche", region: "Oromia", latitude: 9.771962, longitude: 38.73886 },
  { name: "Gelemso", region: "Oromia", latitude: 8.812709, longitude: 40.522048 },
  { name: "Moyale", region: "Oromia", latitude: 3.5241898, longitude: 39.0512683 },
  { name: "Negele Borana", region: "Oromia", latitude: 5.3332879, longitude: 39.5690747 },

  // --- Tigray --------------------------------------------------------------
  { name: "Mekelle", region: "Tigray", latitude: 13.4966644, longitude: 39.4768259, aliases: ["Mekele", "Mek'ele"],
    subcities: [
      { name: "Adi Haqi" },
      { name: "Ayder" },
      { name: "Hawelti" },
      { name: "Kedamay Weyane" },
      { name: "Quiha" },
      { name: "Semien" },
      { name: "Kebele 01" },
    ] },
  { name: "Adigrat", region: "Tigray", latitude: 14.2774132, longitude: 39.4614983 },
  { name: "Shire", region: "Tigray", latitude: 14.102432, longitude: 38.282521, aliases: ["Shire Inda Selassie"] },
  { name: "Aksum", region: "Tigray", latitude: 14.1220982, longitude: 38.7321749, aliases: ["Axum"],
    subcities: [
      { name: "Hawelti" },
      { name: "Kindya" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ] },
  { name: "Wukro", region: "Tigray", latitude: 13.7862549, longitude: 39.601525 },
  { name: "Alamata", region: "Tigray", latitude: 12.4175995, longitude: 39.5603233 },
  { name: "Adwa", region: "Tigray", latitude: 14.1670675, longitude: 38.8911617, aliases: ["Aduwa"] },

  // --- Sidama --------------------------------------------------------------
  { name: "Hawassa", region: "Sidama", latitude: 7.0481029, longitude: 38.47861, aliases: ["Awasa"],
    subcities: [
      { name: "Tabor" },
      { name: "Addis Ketema" },
      { name: "Haik Dar" },
      { name: "Piassa" },
      { name: "Tulla" },
      { name: "Lake Side" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ] },
  { name: "Yirgalem", region: "Sidama", latitude: 6.746936, longitude: 38.405763, aliases: ["Irgalem"] },

  // --- Somali --------------------------------------------------------------
  { name: "Jijiga", region: "Somali", latitude: 9.3508526, longitude: 42.8003788,
    subcities: [
      { name: "Kebele 01" },
      { name: "Kebele 02" },
      { name: "Kebele 03" },
      { name: "Kebele 04" },
      { name: "Kebele 05" },
    ] },
  { name: "Gode", region: "Somali", latitude: 5.9526975, longitude: 43.5522312 },

  // --- Harari --------------------------------------------------------------
  { name: "Harar", region: "Harari", latitude: 9.3118304, longitude: 42.1284009, aliases: ["Harar"],
    subcities: [
      { name: "Harar Jugol" },
      { name: "Sofi" },
      { name: "Aboker" },
      { name: "Jenela" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ] },

  // --- Afar ----------------------------------------------------------------
  { name: "Semera", region: "Afar", latitude: 11.7923098, longitude: 41.0089155 },
  { name: "Asaita", region: "Afar", latitude: 11.5653325, longitude: 41.4385892 },

  // --- Benishangul-Gumuz ---------------------------------------------------
  { name: "Assosa", region: "Benishangul-Gumuz", latitude: 10.0646352, longitude: 34.5437024, aliases: ["Asosa"],
    subcities: [
      { name: "Kebele 01" },
      { name: "Kebele 02" },
      { name: "Kebele 03" },
    ] },

  // --- Gambela -------------------------------------------------------------
  { name: "Gambela", region: "Gambela", latitude: 8.2503656, longitude: 34.5877344,
    subcities: [
      { name: "Kebele 01" },
      { name: "Kebele 02" },
      { name: "Kebele 03" },
    ] },

  // --- Central Ethiopia ----------------------------------------------------
  { name: "Hosaina", region: "Central Ethiopia", latitude: 7.5731316, longitude: 37.8566261, aliases: ["Hosaena", "Hossana"],
    subcities: [
      { name: "Sech Duna" },
      { name: "Gofa" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ] },
  { name: "Butajira", region: "Central Ethiopia", latitude: 8.120617, longitude: 38.37771 },
  { name: "Welkite", region: "Central Ethiopia", latitude: 8.286087, longitude: 37.781844, aliases: ["Wolkite"] },
  { name: "Durame", region: "Central Ethiopia", latitude: 7.2438769, longitude: 37.9049922 },

  // --- South Ethiopia ------------------------------------------------------
  { name: "Wolaita Sodo", region: "South Ethiopia", latitude: 6.8577533, longitude: 37.7578499, aliases: ["Sodo", "Wolaita"],
    subcities: [
      { name: "Mehal" },
      { name: "Merkato" },
      { name: "Otona" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ] },
  { name: "Arba Minch", region: "South Ethiopia", latitude: 6.0215142, longitude: 37.5539809,
    subcities: [
      { name: "Sikela" },
      { name: "Secha" },
      { name: "Nech Sar" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ] },
  { name: "Dilla", region: "South Ethiopia", latitude: 6.4107, longitude: 38.31, aliases: ["Dila"],
    subcities: [
      { name: "Haro Wowu" },
      { name: "Chichu" },
      { name: "Kebele 01" },
      { name: "Kebele 02" },
    ] },
  { name: "Areka", region: "South Ethiopia", latitude: 7.0732372, longitude: 37.707838 },
  { name: "Boditi", region: "South Ethiopia", latitude: 6.9549018, longitude: 37.8575339 },
  { name: "Sawla", region: "South Ethiopia", latitude: 6.3, longitude: 36.88333 },
  { name: "Jinka", region: "South Ethiopia", latitude: 5.786181, longitude: 36.5654425 },

  // --- South West Ethiopia -------------------------------------------------
  { name: "Tepi", region: "South West Ethiopia", latitude: 7.1970721, longitude: 35.4218171, aliases: ["Teppi"] },
  { name: "Mizan Teferi", region: "South West Ethiopia", latitude: 6.9568642, longitude: 35.5544431 },
  { name: "Bonga", region: "South West Ethiopia", latitude: 7.2645383, longitude: 36.2460526 },
];

/** How many local suggestions a single lookup may contribute. */
export const ETHIOPIA_SEARCH_LIMIT = 5;

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/** Split text into comparable tokens ("Debre Berhan" -> ["debre","berhan"]). */
function tokenize(text) {
  return lower(text).split(/[^a-z0-9]+/).filter(Boolean);
}

/** Finite coordinate inside Ethiopia's bounding box (or absent = null). */
function validCoord(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < 3 || lat > 15.5 || lon < 32.5 || lon > 48) return null;
  return { latitude: lat, longitude: lon };
}

/** Case-insensitive lookup by name or alias. */
export function findCity(name) {
  const q = lower(name);
  if (!q) return null;
  return (
    ETHIOPIA_CITIES.find(
      (city) =>
        lower(city.name) === q ||
        (city.aliases || []).some((alias) => lower(alias) === q)
    ) || null
  );
}

/** The city's subcity/kebele names (may be empty; order is the dataset's). */
export function citySubcities(cityName) {
  const city = typeof cityName === "object" && cityName ? cityName : findCity(cityName);
  if (!city || !Array.isArray(city.subcities)) return [];
  return city.subcities.map((subcity) => clean(subcity.name)).filter(Boolean);
}

/** Cities grouped for <optgroup> rendering, in ETHIOPIA_REGIONS order. */
export function groupCitiesByRegion() {
  return ETHIOPIA_REGIONS.map((region) => ({
    region,
    cities: ETHIOPIA_CITIES.filter((city) => city.region === region).slice().sort((a, b) =>
      clean(a.name).localeCompare(clean(b.name))
    ),
  })).filter((group) => group.cities.length > 0);
}

/**
 * Every searchable place below: a city entry, then its subcities.
 * Internal - shared by searchEthiopiaPlaces() only.
 */
function localEntries() {
  const entries = [];
  ETHIOPIA_CITIES.forEach((city) => {
    const cityRegionSame = lower(city.region) === lower(city.name);
    entries.push({
      kind: "city",
      title: clean(city.name),
      address: clean(city.name) + (cityRegionSame ? "" : ", " + clean(city.region)) + ", Ethiopia",
      latitude: city.latitude,
      longitude: city.longitude,
      haystack: tokenize([city.name, (city.aliases || []).join(" "), city.region].join(" ")),
      nameTokens: tokenize(city.name),
      aliasTokens: tokenize((city.aliases || []).join(" ")),
      queryName: lower(city.name),
      aliasStarts: (city.aliases || []).map((alias) => lower(alias)),
    });
    (city.subcities || []).forEach((subcity) => {
      entries.push({
        kind: "subcity",
        title: clean(subcity.name),
        address:
          clean(subcity.name) + ", " + clean(city.name) +
          (cityRegionSame ? "" : ", " + clean(city.region)) + ", Ethiopia",
        latitude: subcity.latitude,
        longitude: subcity.longitude,
        haystack: tokenize(
          [subcity.name, (subcity.aliases || []).join(" "), city.name, (city.aliases || []).join(" "), city.region].join(" ")
        ),
        nameTokens: tokenize(subcity.name),
        aliasTokens: tokenize((subcity.aliases || []).join(" ")),
        queryName: lower(subcity.name),
        aliasStarts: (subcity.aliases || []).map((alias) => lower(alias)),
      });
    });
  });
  return entries;
}

// Built once: the dataset is static, the search runs on every keystroke.
const ALL_ENTRIES = localEntries();

/** True when every query token prefixes some token of the haystack. */
function matches(entry, query, tokens) {
  if (!tokens.length) return false;
  if (entry.queryName === query) return true;
  return tokens.every((token) => entry.haystack.some((word) => word.startsWith(token)));
}

/** Exact name > name prefix > alias prefix > token match; name asc within. */
function rank(entry, query) {
  if (entry.queryName === query) return 0;
  if (entry.queryName.startsWith(query)) return 1;
  if (entry.aliasStarts.some((alias) => alias.startsWith(query))) return 2;
  return 3;
}

/**
 * Famous / searchable street-area suggestions per city.
 *
 * Reusable delivery-location layer: universities, hospitals, hotels, markets,
 * bus stations, stadiums, main roads, government offices and popular
 * neighborhoods customers actually type. The checkout street input offers
 * these as suggestions but NEVER forces a selection - any custom text stays
 * valid.
 *
 * Keyed by canonical city name (see ETHIOPIA_CITIES). Add new cities by
 * appending a key; unknown cities simply get no suggestions.
 */
export const ETHIOPIA_LANDMARKS = {
  "Addis Ababa": [
    "Bole", "Bole Medhanialem", "Bole International Airport", "Bole Road", "Bole Atlas", "Bole Rwanda",
    "Meskel Square", "Piassa", "Mexico", "Megenagna", "Kazanchis", "Merkato", "Saris", "Gerji", "CMC",
    "22 Mazoria", "Summit", "Lebu", "Jemo", "Kaliti", "Gotera",
    "Addis Ababa University", "Tikur Anbessa Hospital", "St. Paul's Hospital",
    "National Museum", "Unity Park", "Friendship Mall", "Friendship Shopping Center",
    "Sheraton Hotel", "Hilton Hotel", "Autobus Terra Bus Station", "Megenagna Bus Station",
    "Addis Ababa Stadium", "Churchill Avenue", "Africa Avenue",
    "Signal Market", "Shola Market", "City Hall", "Federal Parliament",
  ],
  "Dire Dawa": [
    "Kezira", "Sabian Main Market", "Dire Dawa University", "Dire Dawa Bus Station",
    "Dire Dawa Stadium", "Melka Jebdu Road", "Taiwan Market", "Railway Station Area",
  ],
  "Bahir Dar": [
    "Lake Tana", "Bahir Dar University", "Bahir Dar Bus Station", "Stadium Area",
    "Main Market", "Abay Bridge", "Bezawit Palace", "Blue Nile Road", "Tana Mall",
    "Felege Hiwot Hospital", "Regional Government Offices",
  ],
  "Gondar": [
    "Gondar University", "Fasil Castle", "Piassa", "Azezo Bus Station", "Main Market",
    "Gondar Stadium", "University Hospital", "Arada Main Road",
  ],
  "Mekelle": [
    "Mekelle University", "Ayder Hospital", "Hawelti Monument", "Quiha Bus Station",
    "Main Market", "Mekelle Stadium", "Kedamay Weyane Main Road",
  ],
  "Hawassa": [
    "Hawassa University", "Hawassa Lake", "Hawassa Bus Station", "Piazza",
    "Main Market", "Hawassa Referral Hospital", "Hawassa Stadium", "Atote",
    "Gudumale", "Lake Side Road",
  ],
  "Adama": [
    "Adama University", "Adama Bus Station", "Main Market", "Stadium Area",
    "Adama Hospital", "Abba Geda Mall", "Bole Road", "Franka Area",
  ],
  "Jimma": [
    "Jimma University", "Jimma Bus Station", "Main Market", "Stadium Area",
    "Jimma Hospital", "Ginjo Main Road", "Kochi Market",
  ],
  "Dessie": [
    "Dessie University", "Main Market", "Bus Station", "Stadium Area",
    "Dessie Hospital", "Hote Main Road",
  ],
  "Debre Berhan": [
    "Debre Berhan University", "Main Market", "Bus Station", "Stadium Area",
    "Debre Berhan Hospital", "Chacha Road", "Ankara Area", "Kebele 04 Main Road",
  ],
  "Bishoftu": [
    "Kuriftu Lake", "Bishoftu Bus Station", "Main Market", "Hora Lake",
    "Bishoftu Stadium", "Chelekleka Main Road",
  ],
  "Harar": [
    "Harar Jugol Gate", "Harar University area", "Main Market", "Bus Station",
    "Harar Stadium", "Sofi Road", "Ras Hotel Area",
  ],
  "Shashamene": [
    "Kuyera Market", "Bus Station", "Main Market", "Stadium Area", "Hospital Road",
  ],
  "Arba Minch": [
    "Arba Minch University", "Sikela Market", "Bus Station", "Nech Sar Road",
    "Main Market", "Hospital Area",
  ],
  "Wolaita Sodo": [
    "Wolaita Sodo University", "Merkato", "Bus Station", "Main Market",
    "Sodo Stadium", "Otona Main Road",
  ],
  "Nekemte": [
    "Wollega University", "Main Market", "Bus Station", "Stadium Area", "Hospital Road",
  ],
  "Debre Markos": [
    "Debre Markos University", "Main Market", "Bus Station", "Hospital Area",
  ],
  "Kombolcha": [
    "Main Market", "Bus Station", "Industrial Area", "Dessie Road",
  ],
  "Hosaina": [
    "Hosaina University area", "Main Market", "Bus Station", "Stadium Area",
  ],
  "Dilla": [
    "Dilla University", "Main Market", "Bus Station", "Haro Wowu Road", "Chichu Area",
  ],
  "Aksum": [
    "Aksum Obelisks", "Aksum University", "Main Market", "Bus Station", "Hawelti Road",
  ],
  "Jijiga": [
    "Main Market", "Bus Station", "Stadium Area", "Hospital Road", "Palace Area",
  ],
  "Gambela": [
    "Main Market", "Bus Station", "Baro River Road", "Hospital Area",
  ],
  "Assosa": [
    "Main Market", "Bus Station", "Hospital Road", "University Area",
  ],
  "Debre Tabor": [
    "Main Market", "Bus Station", "Hospital Area", "Lake Tana Road",
  ],
};

/**
 * Street/landmark suggestions for one city, filtered by free text.
 * Always returns plain strings; empty query returns the city's top places.
 * Never throws for unknown cities (returns []).
 */
export function getCityLandmarks(cityName) {
  const city = typeof cityName === "object" && cityName ? cityName : findCity(cityName);
  const key = city ? city.name : clean(cityName);
  const list = ETHIOPIA_LANDMARKS[key] || [];
  return list.slice();
}

export function searchStreetSuggestions(cityName, query, limit) {
  const all = getCityLandmarks(cityName);
  if (!all.length) return [];
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 8;
  const tokens = tokenize(query);
  if (!tokens.length) return all.slice(0, max);
  const scored = all
    .map((name) => {
      const hay = tokenize(name);
      const exact = lower(name) === lower(query);
      const prefix = lower(name).startsWith(lower(query).trim());
      const hit = tokens.every((t) => hay.some((w) => w.startsWith(t)));
      return { name, exact, prefix, hit };
    })
    .filter((s) => s.exact || s.prefix || s.hit)
    .sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      if (a.prefix !== b.prefix) return a.prefix ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, max)
    .map((s) => s.name);
  return scored;
}

/**
 * Landmark suggestions for one city, filtered by free text.
 *
 * Same famous-places dataset as the street picker, exposed under its own
 * name so the Landmark dropdown reads as its own choice list. Empty query
 * returns the city's top places; unknown cities return [] so the caller can
 * fall back to "Other / Enter manually".
 */
export function searchLandmarkSuggestions(cityName, query, limit) {
  return searchStreetSuggestions(cityName, query, limit);
}

/**
 * Searchable city lookup for the checkout city combobox.
 * Matches name/alias/region prefixes; custom text simply yields no rows
 * (the caller keeps the typed value via "Other city").
 */
export function searchCities(query, limit) {
  const tokens = tokenize(query);
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 8;
  if (!tokens.length) return ETHIOPIA_CITIES.map((c) => c.name).slice(0, max);
  const q = lower(query);
  return ETHIOPIA_CITIES
    .filter((city) => {
      const hay = tokenize([city.name, (city.aliases || []).join(" "), city.region].join(" "));
      if (lower(city.name) === q) return true;
      return tokens.every((t) => hay.some((w) => w.startsWith(t)));
    })
    .sort((a, b) => {
      const ra = lower(a.name) === q ? 0 : lower(a.name).startsWith(q) ? 1 : 2;
      const rb = lower(b.name) === q ? 0 : lower(b.name).startsWith(q) ? 1 : 2;
      return ra - rb || a.name.localeCompare(b.name);
    })
    .slice(0, max)
    .map((c) => c.name);
}
export function searchEthiopiaPlaces(query, limit) {
  // The offline layer of the map search: cities and subcities of Ethiopia.
  // Every result carries a real, in-range coordinate taken from the dataset -
  // entries without one (kebeles / named local areas) are skipped, because a
  // suggestion the map cannot open is worse than no suggestion at all.
  const text = lower(query);
  const tokens = tokenize(query);
  if (!text || !tokens.length) return [];
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : ETHIOPIA_SEARCH_LIMIT;

  return ALL_ENTRIES
    .filter((entry) => {
      if (!matches(entry, text, tokens)) return false;
      return validCoord(entry.latitude, entry.longitude) !== null;
    })
    .sort((a, b) => {
      const byRank = rank(a, text) - rank(b, text);
      if (byRank !== 0) return byRank;
      return a.title.localeCompare(b.title);
    })
    .slice(0, max)
    .map((entry) => {
      const coord = validCoord(entry.latitude, entry.longitude);
      return {
        title: entry.title,
        address: entry.address,
        latitude: coord.latitude,
        longitude: coord.longitude,
        source: "local",
        kind: entry.kind,
      };
    });
}
