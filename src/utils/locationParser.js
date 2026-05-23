/**
 * Parse latitude/longitude from any text the user might paste:
 *  - Raw coordinates:        "17.2403, 78.4294"
 *  - Google Maps full URL:   .../@17.2403,78.4294,15z
 *  - Google Maps query URL:  ?q=17.2403,78.4294
 *  - Shortened URLs:         goo.gl/maps/xxx  →  follow redirect → extract
 *  - Apple Maps:             maps.apple.com/?q=17.2403,78.4294
 *  - OLA / HERE / Waze URLs: ?lat=17.24&lon=78.43 variants
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

  // /place/lat,lng  (Google Maps place links)
  m = url.match(/\/place\/(-?\d+\.?\d+),(-?\d+\.?\d+)/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };

  return null;
}

// ── follow a short URL and return the final destination ───────────────────────

async function resolveShortUrl(url) {
  try {
    const res = await axios.get(url, {
      maxRedirects: 5,
      timeout:      5000,
      validateStatus: () => true,   // don't throw on non-2xx
      // Prevent actually downloading a full page
      responseType: 'stream',
    });
    res.data.destroy?.();           // immediately close the stream
    // axios stores the final URL after redirects here
    return res.request?.res?.responseUrl
        || res.config?.url
        || null;
  } catch (e) {
    console.error('resolveShortUrl error:', e.message);
    return null;
  }
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

    // 2b. Shortened URL — follow redirect and try again
    const isShort = /goo\.gl|maps\.app\.goo\.gl|bit\.ly|tinyurl\.com|ola\.app|here\.com\/l/i.test(url);
    if (isShort) {
      const resolved = await resolveShortUrl(url);
      if (resolved) {
        const fromRedirect = extractFromUrl(resolved);
        if (fromRedirect && isValidCoord(fromRedirect.lat, fromRedirect.lon)) return fromRedirect;
      }
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

module.exports = { parseLocationFromText, isValidCoord };
