/**
 * Smart Cafeteria Ordering System
 * File: frontend/src/js/delivery/overpass-poi.js
 *
 * POI search using OpenStreetMap Overpass API.
 * Works for ALL Ethiopian cities - no hardcoded locations.
 *
 * Categories map to Overpass tags:
 *   hotels      -> tourism=hotel
 *   schools     -> amenity=school
 *   universities-> amenity=university
 *   hospitals   -> amenity=hospital
 *   clinics     -> amenity=clinic
 *   markets     -> shop=market|supermarket|mall
 *   transport   -> amenity=bus_station|taxi|airport
 *   restaurants -> amenity=restaurant|cafe|fast_food
 *   banks       -> amenity=bank|atm
 *   fuel        -> amenity=fuel
 *   landmarks   -> tourism=attraction|museum|monument|viewpoint
 *   worship     -> amenity=place_of_worship
 *   parks       -> leisure=park
 *   stadiums    -> leisure=stadium|sports_centre
 */

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const OVERPASS_TIMEOUT = 25;
const MAX_POIS = 200;

const CATEGORY_TAGS = {
  hotels: ['["tourism"="hotel"]'],
  schools: ['["amenity"="school"]'],
  universities: ['["amenity"="university"]'],
  hospitals: ['["amenity"="hospital"]', '["amenity"="clinic"]'],
  markets: ['["shop"="market"]', '["shop"="supermarket"]', '["shop"="mall"]'],
  transport: ['["amenity"="bus_station"]', '["amenity"="taxi"]', '["aeroway"="aerodrome"]'],
  restaurants: ['["amenity"="restaurant"]', '["amenity"="cafe"]', '["amenity"="fast_food"]'],
  banks: ['["amenity"="bank"]', '["amenity"="atm"]'],
  fuel: ['["amenity"="fuel"]'],
  landmarks: ['["tourism"="attraction"]', '["tourism"="museum"]', '["tourism"="monument"]', '["tourism"="viewpoint"]'],
  worship: ['["amenity"="place_of_worship"]'],
  parks: ['["leisure"="park"]'],
  stadiums: ['["leisure"="stadium"]', '["leisure"="sports_centre"]'],
};

const CATEGORY_ICON = {
  hotels: 'fa-hotel',
  schools: 'fa-school',
  universities: 'fa-university',
  hospitals: 'fa-hospital',
  markets: 'fa-store',
  transport: 'fa-bus',
  restaurants: 'fa-utensils',
  banks: 'fa-university',
  fuel: 'fa-gas-pump',
  landmarks: 'fa-landmark',
  worship: 'fa-mosque',
  parks: 'fa-tree',
  stadiums: 'fa-futbol',
};

const CATEGORY_LABEL = {
  hotels: 'Hotels',
  schools: 'Schools',
  universities: 'Universities',
  hospitals: 'Hospitals & Clinics',
  markets: 'Markets & Malls',
  transport: 'Transport',
  restaurants: 'Restaurants & Cafes',
  banks: 'Banks & ATMs',
  fuel: 'Fuel Stations',
  landmarks: 'Landmarks',
  worship: 'Churches & Mosques',
  parks: 'Parks',
  stadiums: 'Stadiums & Sports',
};

const ALL_CATEGORIES = Object.keys(CATEGORY_TAGS);

function normalizeCoord(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function buildOverpassQuery(bbox, categories) {
  const [minLat, minLon, maxLat, maxLon] = bbox;
  const parts = [];
  for (const cat of categories) {
    const tags = CATEGORY_TAGS[cat] || [];
    for (const tag of tags) {
      parts.push(
        `node${tag}(${minLat},${minLon},${maxLat},${maxLon});`,
        `way${tag}(${minLat},${minLon},${maxLat},${maxLon});`,
        `relation${tag}(${minLat},${minLon},${maxLat},${maxLon});`
      );
    }
  }
  return `
    [out:json][timeout:${OVERPASS_TIMEOUT}];
    (
      ${parts.join('\n')}
    );
    out center ${MAX_POIS};
  `;
}

function parseOverpassResponse(data, centerLat, centerLon) {
  if (!data || !data.elements) return [];
  const pois = [];
  for (const el of data.elements) {
    let lat = el.lat;
    let lon = el.lon;
    if (el.center) {
      lat = el.center.lat;
      lon = el.center.lon;
    }
    const coord = normalizeCoord(lat, lon);
    if (!coord) continue;
    const tags = el.tags || {};
    const name = tags.name || tags['name:en'] || tags['name:am'] || 'Unnamed';
    const category = inferCategory(tags);
    if (!category) continue;
    const distance = haversineMeters(centerLat, centerLon, coord.latitude, coord.longitude);
    pois.push({
      id: `${el.type}/${el.id}`,
      name,
      category,
      latitude: coord.latitude,
      longitude: coord.longitude,
      distanceMeters: Math.round(distance),
      tags: {
        addr: [tags['addr:street'], tags['addr:housenumber'], tags['addr:city'], tags['addr:suburb']].filter(Boolean).join(', '),
        phone: tags.phone || tags['contact:phone'] || '',
        website: tags.website || tags['contact:website'] || '',
        opening_hours: tags.opening_hours || '',
      },
    });
  }
  pois.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return pois.slice(0, MAX_POIS);
}

function inferCategory(tags) {
  if (tags.tourism === 'hotel') return 'hotels';
  if (tags.amenity === 'school') return 'schools';
  if (tags.amenity === 'university') return 'universities';
  if (tags.amenity === 'hospital') return 'hospitals';
  if (tags.amenity === 'clinic') return 'hospitals';
  if (tags.shop === 'market' || tags.shop === 'supermarket' || tags.shop === 'mall') return 'markets';
  if (tags.amenity === 'bus_station' || tags.amenity === 'taxi' || tags.aeroway === 'aerodrome') return 'transport';
  if (tags.amenity === 'restaurant' || tags.amenity === 'cafe' || tags.amenity === 'fast_food') return 'restaurants';
  if (tags.amenity === 'bank' || tags.amenity === 'atm') return 'banks';
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.tourism === 'attraction' || tags.tourism === 'museum' || tags.tourism === 'monument' || tags.tourism === 'viewpoint') return 'landmarks';
  if (tags.amenity === 'place_of_worship') return 'worship';
  if (tags.leisure === 'park') return 'parks';
  if (tags.leisure === 'stadium' || tags.leisure === 'sports_centre') return 'stadiums';
  return null;
}

let requestController = null;

export async function searchPOIs(centerLat, centerLon, radiusKm = 5, categories = ALL_CATEGORIES) {
  const center = normalizeCoord(centerLat, centerLon);
  if (!center) return { pois: [], error: 'Invalid center coordinates' };
  const minLat = center.latitude - radiusKm / 111;
  const maxLat = center.latitude + radiusKm / 111;
  const minLon = center.longitude - radiusKm / (111 * Math.cos(center.latitude * Math.PI / 180));
  const maxLon = center.longitude + radiusKm / (111 * Math.cos(center.latitude * Math.PI / 180));
  const query = buildOverpassQuery([minLat, minLon, maxLat, maxLon], categories);
  if (requestController) requestController.abort();
  requestController = new AbortController();
  try {
    const res = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: requestController.signal,
    });
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    const data = await res.json();
    const pois = parseOverpassResponse(data, center.latitude, center.longitude);
    return { pois, error: null };
  } catch (e) {
    if (e.name === 'AbortError') return { pois: [], error: 'aborted' };
    return { pois: [], error: e.message };
  }
}

export function getCategoryIcon(category) {
  return CATEGORY_ICON[category] || 'fa-map-marker-alt';
}

export function getCategoryLabel(category) {
  return CATEGORY_LABEL[category] || category;
}

export function getAllCategories() {
  return ALL_CATEGORIES.slice();
}

export function cancelPending() {
  if (requestController) requestController.abort();
}