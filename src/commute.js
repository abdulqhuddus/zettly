// On-site visits are priced with a distance-based "Anfahrt" (call-out) fee,
// banded into four zones radiating from the Munich office. This module
// turns a customer-entered German postal code into that fee: geocode the
// postal code (via Nominatim, no API key needed), measure the straight-line
// distance from Munich, and look up which band it falls in.
//
// Shared by the public GET /api/commute endpoint (used by the booking form
// to preview the fee as soon as a postal code is entered) and by
// handleBook itself (src/index.js), which never trusts a client-supplied
// fee and always recomputes it server-side before charging it.

export const MUNICH = { lat: 48.1351, lon: 11.582 };

// Upper bound of each band, in km, and the flat fee it adds on top of the
// service price. A postal code further than the last band's bound is
// outside the service area entirely.
export const COMMUTE_ZONES = [
  { maxKm: 25, fee: 0 },
  { maxKm: 50, fee: 10 },
  { maxKm: 75, fee: 20 },
  { maxKm: 100, fee: 30 },
];

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Great-circle distance in km (haversine) — accurate enough for a call-out
// fee banding; road distance would be somewhat longer but the zones already
// have generous margins.
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function zoneForDistance(km) {
  for (let i = 0; i < COMMUTE_ZONES.length; i++) {
    if (km <= COMMUTE_ZONES[i].maxKm) return { index: i, ...COMMUTE_ZONES[i] };
  }
  return null; // beyond the last band — outside the service area
}

// Nominatim (OpenStreetMap's free geocoder) is rate-limited and asks every
// caller to identify itself with a real contact — hence the explicit
// User-Agent rather than a generic fetch.
async function geocodePostalCode(plz) {
  const url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(plz)}&country=Germany&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": "ZettlyBooking/1.0 (kontakt@zettly.de)" },
  });
  if (!res.ok) return null;
  const results = await res.json();
  if (!Array.isArray(results) || !results.length) return null;
  const { lat, lon } = results[0];
  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return null;
  return { lat: latNum, lon: lonNum };
}

const PLZ_RE = /^\d{5}$/;

/**
 * Resolve a German postal code to a distance from Munich and its commute
 * fee. Returns one of:
 *   { ok: true, distanceKm, fee, zoneIndex }
 *   { ok: false, reason: "invalid_plz" | "not_found" | "out_of_area", distanceKm? }
 */
export async function computeCommute(plz) {
  const clean = (plz || "").trim();
  if (!PLZ_RE.test(clean)) return { ok: false, reason: "invalid_plz" };

  let point;
  try {
    point = await geocodePostalCode(clean);
  } catch {
    point = null;
  }
  if (!point) return { ok: false, reason: "not_found" };

  const distanceKm = haversineKm(MUNICH.lat, MUNICH.lon, point.lat, point.lon);
  const zone = zoneForDistance(distanceKm);
  if (!zone) return { ok: false, reason: "out_of_area", distanceKm };

  return { ok: true, distanceKm, fee: zone.fee, zoneIndex: zone.index };
}
