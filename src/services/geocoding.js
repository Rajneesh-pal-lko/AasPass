const axios    = require('axios');
const supabase = require('../config/supabase');

// ── In-memory L1 cache (hot path, per process) ────────────────────────────────
// Survives for the life of the process. DB cache (L2) survives restarts.
const memCache    = new Map();
const MEM_TTL_MS  = 60 * 60 * 1000; // 1 hour in memory

// ── Cache key helpers ─────────────────────────────────────────────────────────

function coordKey(lat, lon) {
  return `rev:${parseFloat(lat).toFixed(4)},${parseFloat(lon).toFixed(4)}`;
}

function queryKey(q) {
  // Normalise: lowercase, collapse spaces, remove punctuation noise
  return `fwd:${q.toLowerCase().trim().replace(/\s+/g, ' ')}`;
}

// ── Memory cache helpers ──────────────────────────────────────────────────────

function memGet(key) {
  const hit = memCache.get(key);
  if (hit && Date.now() - hit.ts < MEM_TTL_MS) return hit.value;
  memCache.delete(key);
  return null;
}

function memSet(key, value) {
  memCache.set(key, { value, ts: Date.now() });
}

// ── Persistent DB cache helpers ───────────────────────────────────────────────
// Uses the geocode_cache table created in supabase_v4_production.sql
// TTL: 7 days (coordinates don't change meaning)

const DB_TTL_DAYS = 7;

async function dbGet(key) {
  try {
    const cutoff = new Date(Date.now() - DB_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('geocode_cache')
      .select('results')
      .eq('query_key', key)
      .gt('cached_at', cutoff)
      .maybeSingle();
    return data?.results || null;
  } catch {
    return null; // DB cache miss is never fatal
  }
}

async function dbSet(key, queryText, results) {
  try {
    await supabase.from('geocode_cache').upsert(
      { query_key: key, query_text: queryText, results, cached_at: new Date().toISOString() },
      { onConflict: 'query_key' }
    );
  } catch {
    // Cache write failure is never fatal
  }
}

// ── Reverse geocoding ─────────────────────────────────────────────────────────
/**
 * Convert lat/lon → short human-readable label.
 * Checks memory cache → DB cache → OpenCage API.
 * Falls back to "lat, lon" string if API is unavailable.
 */
async function reverseGeocode(lat, lon) {
  const key = coordKey(lat, lon);

  // L1: memory
  const memHit = memGet(key);
  if (memHit) return memHit;

  // L2: persistent DB
  const dbHit = await dbGet(key);
  if (dbHit) {
    memSet(key, dbHit);
    return dbHit;
  }

  const apiKey = process.env.OPENCAGE_API_KEY;
  const fallback = `${parseFloat(lat).toFixed(4)}, ${parseFloat(lon).toFixed(4)}`;
  if (!apiKey) return fallback;

  try {
    const url = `https://api.opencagedata.com/geocode/v1/json` +
                `?q=${lat}+${lon}&key=${apiKey}&limit=1&no_annotations=1&language=en`;

    const res    = await axios.get(url, { timeout: 2500 });
    const result = res.data?.results?.[0];
    if (!result) throw new Error('No geocoding result');

    const c = result.components || {};
    const parts = [
      c.neighbourhood || c.suburb || c.quarter || c.hamlet,
      c.city_district  || c.town_area,
      c.city || c.town || c.village || c.county || c.state_district,
    ].filter(Boolean);

    let label = parts.length
      ? parts.slice(0, 2).join(', ')
      : result.formatted?.split(',').slice(0, 2).join(',').trim() || fallback;

    if (label.length > 60) label = label.substring(0, 57) + '…';

    memSet(key, label);
    await dbSet(key, key, label);
    return label;

  } catch (err) {
    console.error('Reverse geocoding error:', err.message);
    return fallback;
  }
}

// ── Forward geocoding ─────────────────────────────────────────────────────────
/**
 * Convert place name → up to `limit` candidate results.
 * Checks memory cache → DB cache → OpenCage API.
 *
 * @param {string} query  - free-text place name, e.g. "Mantri Celestia Hyderabad"
 * @param {number} limit  - max results (1–5)
 * @returns {Promise<Array<{ lat: number, lon: number, label: string }>>}
 */
async function forwardGeocode(query, limit = 5) {
  const apiKey = process.env.OPENCAGE_API_KEY;
  if (!apiKey || !query?.trim()) return [];

  const key = queryKey(query);

  // L1: memory
  const memHit = memGet(key);
  if (memHit) return memHit;

  // L2: persistent DB
  const dbHit = await dbGet(key);
  if (dbHit) {
    memSet(key, dbHit);
    return dbHit;
  }

  try {
    const q   = encodeURIComponent(query.trim());
    const url = `https://api.opencagedata.com/geocode/v1/json` +
                `?q=${q}&key=${apiKey}&limit=${limit}&no_annotations=1&language=en&countrycode=in`;

    const res  = await axios.get(url, { timeout: 2500 });
    const hits = res.data?.results || [];

    const results = hits.map(r => ({
      lat:   r.geometry.lat,
      lon:   r.geometry.lng,
      label: r.formatted || `${r.geometry.lat}, ${r.geometry.lng}`,
    }));

    memSet(key, results);
    await dbSet(key, query.trim(), results);
    return results;

  } catch (err) {
    console.error('Forward geocoding error:', err.message);
    return [];
  }
}

// ── Pre-warm known airports (L1 only — fast startup) ─────────────────────────
function primeCache(entries) {
  for (const { lat, lon, label } of entries) {
    memSet(coordKey(lat, lon), label);
  }
}

primeCache([
  { lat: 17.2403, lon: 78.4294, label: 'Hyderabad Airport (RGIA)' },
  { lat: 13.1986, lon: 77.7066, label: 'Bangalore Airport (KIA)'  },
  { lat: 28.5562, lon: 77.1000, label: 'Delhi Airport (IGI)'      },
  { lat: 19.0896, lon: 72.8656, label: 'Mumbai Airport (CSIA)'    },
  { lat: 12.9941, lon: 80.1709, label: 'Chennai Airport (MAA)'    },
]);

module.exports = { reverseGeocode, forwardGeocode };
