const axios = require('axios');

// In-memory cache: key = "lat,lon" → { label, ts }
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — coordinates don't change meaning

/**
 * Reverse-geocode a lat/lon pair into a short human-readable label.
 * Falls back to "lat, lon" string if OpenCage is unavailable.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<string>}
 */
async function reverseGeocode(lat, lon) {
  // Round to 4 decimal places for cache key (≈ 11m precision)
  const key = `${parseFloat(lat).toFixed(4)},${parseFloat(lon).toFixed(4)}`;

  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.label;
  }

  const apiKey = process.env.OPENCAGE_API_KEY;
  if (!apiKey) {
    // No API key — return coordinate string
    return `${parseFloat(lat).toFixed(4)}, ${parseFloat(lon).toFixed(4)}`;
  }

  try {
    const url =
      `https://api.opencagedata.com/geocode/v1/json` +
      `?q=${lat}+${lon}&key=${apiKey}&limit=1&no_annotations=1&language=en`;

    const res = await axios.get(url, { timeout: 5000 });
    const result = res.data?.results?.[0];

    if (!result) throw new Error('No geocoding result');

    const c = result.components || {};

    // Build a short, readable label from the most useful components
    const parts = [
      c.neighbourhood || c.suburb || c.quarter || c.hamlet,
      c.city_district || c.town_area,
      c.city || c.town || c.village || c.county || c.state_district,
    ].filter(Boolean);

    let label = parts.length
      ? parts.slice(0, 2).join(', ')
      : result.formatted?.split(',').slice(0, 2).join(',').trim() || key;

    // Cap at 60 chars so it fits in WhatsApp messages cleanly
    if (label.length > 60) label = label.substring(0, 57) + '…';

    cache.set(key, { label, ts: Date.now() });
    return label;

  } catch (err) {
    console.error('Geocoding error:', err.message);
    // Graceful fallback — never crash the bot
    return `${parseFloat(lat).toFixed(4)}, ${parseFloat(lon).toFixed(4)}`;
  }
}

/**
 * Pre-warm cache entries (optional, useful for known airports).
 * Call at startup if desired.
 */
function primeCache(entries) {
  for (const { lat, lon, label } of entries) {
    const key = `${parseFloat(lat).toFixed(4)},${parseFloat(lon).toFixed(4)}`;
    cache.set(key, { label, ts: Date.now() });
  }
}

// Pre-warm with known airports so we never hit the API for those
primeCache([
  { lat: 17.2403, lon: 78.4294, label: 'Hyderabad Airport (RGIA)' },
  { lat: 13.1986, lon: 77.7066, label: 'Bangalore Airport (KIA)' },
  { lat: 28.5562, lon: 77.1000, label: 'Delhi Airport (IGI)' },
  { lat: 19.0896, lon: 72.8656, label: 'Mumbai Airport (CSIA)' },
  { lat: 12.9941, lon: 80.1709, label: 'Chennai Airport (MAA)' },
]);

/**
 * Forward-geocode a place name / address into up to `limit` candidate results.
 * Used when a user types a place name instead of sharing a pin.
 *
 * @param {string} query  - free-text place name, e.g. "Mantri Celestia Hyderabad"
 * @param {number} limit  - max results (1–5)
 * @returns {Promise<Array<{ lat: number, lon: number, label: string }>>}
 */
async function forwardGeocode(query, limit = 5) {
  const apiKey = process.env.OPENCAGE_API_KEY;
  if (!apiKey || !query?.trim()) return [];

  try {
    const q   = encodeURIComponent(query.trim());
    const url = `https://api.opencagedata.com/geocode/v1/json` +
                `?q=${q}&key=${apiKey}&limit=${limit}&no_annotations=1&language=en&countrycode=in`;

    const res  = await axios.get(url, { timeout: 5000 });
    const hits = res.data?.results || [];

    return hits.map(r => ({
      lat:   r.geometry.lat,
      lon:   r.geometry.lng,
      label: r.formatted || `${r.geometry.lat}, ${r.geometry.lng}`,
    }));

  } catch (err) {
    console.error('Forward geocoding error:', err.message);
    return [];
  }
}

module.exports = { reverseGeocode, forwardGeocode };
