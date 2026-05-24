/**
 * Parse latitude/longitude from any text the user might paste:
 *  - Raw coordinates:        "17.2403, 78.4294"
 *  - Google Maps full URL:   .../@17.2403,78.4294,15z
 *  - Google Maps query URL:  ?q=17.2403,78.4294
 *  - Google Maps short URL:  maps.app.goo.gl/xxx  →  follow redirect → extract
 *  - Apple Maps short URL:   maps.apple.com/place/xxx  →  follow redirect → extract
 *  - Apple Maps direct:      maps.apple.com/?ll=17.24,78.43 or ?q=17.24,78.43
 *  - OLA / HERE / Waze URLs: ?lat=17.24&lon=78.43 variants
 *  - Any other map URL:      followed via redirect to extract coords or place name
 */

const axios = require('axios');

// ── coordinate validator ──────────────────────────────────────────────────────

function isValidCoord(lat, lon) {
  const lt = parseFloat(lat);
  const ln = parseFloat(lon);
  return (
    !isNaN(lt) && !isNaN(ln) &&
    lt >= -90  && lt <= 90   &&
    ln >= -180 && ln <= 180  &&
    !(lt === 0 && ln === 0)  // reject Null Island
  );
}

// ── extract place name from a resolved Maps URL ───────────────────────────────
// When a Maps short link points to a named place (not a pin), the resolved URL
// has ?q=Place+Name+... — no coordinates.  Extract the text so the caller can
// forward-geocode it.

function extractPlaceNameFromUrl(url) {
  // ?q=Some+Place+Name (NOT ?q=17.24,78.42 — those are coordinates)
  const m = url.match(/[?&]q=([^&]+)/);
  if (!m) return null;
  const q = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
  // Reject if it looks like coordinates: "-17.24,78.42"
  if (/^-?\d+\.?\d*[,\s]+-?\d+\.?\d*$/.test(q)) return null;
  return q || null;
}

// ── extract coords from a resolved URL ───────────────────────────────────────

function extractFromUrl(url) {
  let m;

  // @lat,lng  (Google Maps embed / share)
  m = url.match(/@(-?\d+\.?\d+),(-?\d+\.?\d+)/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };

  // ?q=lat,lng  or  &q=lat,lng  (Google, Apple, Waze)
  m = url.match(/[?&]q=(-?\d+\.?\d+),(-?\d+\.?\d+)/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };

  // ?center=lat,lng  (some map providers)
  m = url.match(/[?&]center=(-?\d+\.?\d+),(-?\d+\.?\d+)/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };

  // ?lat=X&lon=Y  or  ?lat=X&lng=Y
  m = url.match(/[?&]lat=(-?\d+\.?\d+)&lon[g]?=(-?\d+\.?\d+)/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };

  // ?ll=lat,lng  (Apple Maps direct share)
  m = url.match(/[?&]ll=(-?\d+\.?\d+),(-?\d+\.?\d+)/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };

  // ?coordinate=lat,lon (Apple Maps place links — comma URL-encoded as %2C)
  m = url.match(/[?&]coordinate=(-?\d+\.?\d+)(?:%2C|,)(-?\d+\.?\d+)/i);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };

  // /place/lat,lng  (Google Maps place links)
  m = url.match(/\/place\/(-?\d+\.?\d+),(-?\d+\.?\d+)/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };

  // /place/Name/lat,lon,zoom  (Apple Maps place links)
  m = url.match(/\/place\/[^/]+\/(-?\d+\.?\d+),(-?\d+\.?\d+)/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };

  return null;
}

// ── follow a short URL and return the final destination ───────────────────────
// Uses a mobile User-Agent so Google Maps short links resolve correctly
// (maps.app.goo.gl ?g_st=ic is the iOS share format — same destination server-side)

// Domains that use Apple's private .apple TLD — they only resolve inside Apple's
// own DNS network. Any HTTP request from an external server will timeout.
const APPLE_PRIVATE_TLD = /^https?:\/\/[a-z.]*\.apple\//i;

async function resolveShortUrl(url) {
  // Apple private TLD (maps.apple, *.apple) — unreachable from non-Apple servers.
  // Attempting an HTTP request wastes 4-8 seconds. Skip immediately.
  if (APPLE_PRIVATE_TLD.test(url)) return null;

  // Strip tracking params that can confuse the redirect chain
  const cleanUrl = url.split('?')[0];

  // Try HEAD first (lightweight — no body download)
  for (const method of ['head', 'get']) {
    try {
      const res = await axios[method](cleanUrl, {
        maxRedirects:   10,
        timeout:        4000,
        validateStatus: () => true,
        headers: {
          // Mobile UA makes maps.app.goo.gl resolve to standard Maps URL with @lat,lon
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        },
        // Don't use responseType:'stream' — it breaks redirect URL tracking in Node.js
      });

      const finalUrl = res.request?.res?.responseUrl   // Node http.IncomingMessage
                    || res.request?.responseURL         // Browser-style fallback
                    || null;

      if (finalUrl && finalUrl !== cleanUrl) return finalUrl;
    } catch (e) {
      // HEAD failed → try GET on next loop iteration
      if (method === 'get') console.error('resolveShortUrl error:', e.message);
    }
  }
  return null;
}

// ── main exported function ────────────────────────────────────────────────────

async function parseLocationFromText(text) {
  if (!text || text.length > 1000) return null;
  const t = text.trim();

  // ── 1. Raw coordinates: "17.2403, 78.4294" or "17.2403,78.4294" ──────────
  //    Require at least 3 decimal places to distinguish from phone numbers etc.
  const rawMatch = t.match(/^(-?\d{1,3}\.\d{3,})[,\s]+(-?\d{1,3}\.\d{3,})$/);
  if (rawMatch) {
    const lat = parseFloat(rawMatch[1]), lon = parseFloat(rawMatch[2]);
    if (isValidCoord(lat, lon)) return { lat, lon };
  }

  // ── 2. URL in the message ─────────────────────────────────────────────────
  const urlMatch = t.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    const url = urlMatch[0].replace(/[.,)>]+$/, ''); // strip trailing punctuation

    // 2a. Try direct extraction (no HTTP needed)
    const direct = extractFromUrl(url);
    if (direct && isValidCoord(direct.lat, direct.lon)) return direct;

    // 2b-special. Apple private-TLD short links (maps.apple/p/...) can ONLY be
    //   opened on an iOS device — they will not resolve from a server. Signal
    //   this to the caller so it can show a specific message.
    if (APPLE_PRIVATE_TLD.test(url)) return { appleShortLink: true };

    // 2b. Follow redirect for any map-related URL (short links OR full map URLs)
    //    This covers: goo.gl, maps.app.goo.gl, maps.apple.com, maps.apple, bit.ly,
    //    tinyurl, ola, here, and any URL that looks like it came from a maps app.
    const isMapUrl = /goo\.gl|maps\.app\.goo\.gl|maps\.apple|apple\.com\/maps|bit\.ly|tinyurl\.com|ola\.app|here\.com\/l|google\.com\/maps|maps\.google/i.test(url);
    if (isMapUrl) {
      const resolved = await resolveShortUrl(url);
      if (resolved) {
        // Try coordinates first
        const fromRedirect = extractFromUrl(resolved);
        if (fromRedirect && isValidCoord(fromRedirect.lat, fromRedirect.lon)) return fromRedirect;

        // Resolved URL has a place name (named-place Maps link, not a pin)
        const placeName = extractPlaceNameFromUrl(resolved);
        if (placeName) return { placeName };
      }

      // Even if redirect failed, try extracting place name from the original URL
      const directPlace = extractPlaceNameFromUrl(url);
      if (directPlace) return { placeName: directPlace };
    }
  }

  // ── 3. Coordinates embedded anywhere in the text ──────────────────────────
  //    e.g. "Meet me at 17.2403, 78.4294 outside gate 3"
  const inlineMatch = t.match(/(-?\d{1,3}\.\d{4,})[,\s]+(-?\d{1,3}\.\d{4,})/);
  if (inlineMatch) {
    const lat = parseFloat(inlineMatch[1]), lon = parseFloat(inlineMatch[2]);
    if (isValidCoord(lat, lon)) return { lat, lon };
  }

  return null;
}

module.exports = { parseLocationFromText, isValidCoord, extractPlaceNameFromUrl };
