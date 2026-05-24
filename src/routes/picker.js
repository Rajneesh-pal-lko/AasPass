/**
 * AasPass — Mappls Web Map Picker
 *
 * GET  /pick?t=TOKEN&label=drop+location
 *   Serves a full-screen Mappls map with Place Picker.
 *   Token is HMAC-signed (30-min TTL) so we know which phone to resume.
 *
 * POST /pick/confirm
 *   Receives { token, lat, lon, label } from the browser.
 *   Validates token → injects a synthetic location message into processMessage.
 *   The existing state machine handles it identically to a WhatsApp pin share.
 */

const express = require('express');
const router  = express.Router();

const { verifyPickerToken }  = require('../utils/pickerToken');
const { processMessage }     = require('../services/processor');

// ── GET /pick — serve the picker page ────────────────────────────────────────

router.get('/', (req, res) => {
  const { t: token, label = 'drop location' } = req.query;

  if (!token || !verifyPickerToken(token)) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;padding:32px;text-align:center">
        <h2>⏰ This link has expired</h2>
        <p>Please go back to WhatsApp and request a new picker link.</p>
      </body></html>
    `);
  }

  const mapKey = process.env.MAPPLS_API_KEY;
  if (!mapKey) {
    return res.status(500).send('<h2>Map not configured.</h2>');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(pickerHTML(mapKey, token, label));
});

// ── POST /pick/confirm — receive selected coordinates ─────────────────────────

router.post('/confirm', async (req, res) => {
  const { token, lat, lon } = req.body;

  const phone = verifyPickerToken(token);
  if (!phone) {
    return res.status(400).json({ ok: false, error: 'Link expired. Please request a new one.' });
  }

  const latitude  = parseFloat(lat);
  const longitude = parseFloat(lon);

  if (isNaN(latitude) || isNaN(longitude)) {
    return res.status(400).json({ ok: false, error: 'Invalid coordinates.' });
  }

  // Respond to the browser immediately — don't wait for state machine
  res.json({ ok: true });

  // Inject as a synthetic location message. The state machine (handleMessage)
  // processes it identically to a WhatsApp location pin, advancing the state
  // for whichever location step the user is currently on (drop, pickup, edit…).
  const syntheticMsg = {
    id:       `pick_${phone}_${Date.now()}`,
    from:     phone,
    type:     'location',
    location: { latitude, longitude },
  };

  await processMessage(syntheticMsg, null).catch(err =>
    console.error(`❌ Picker confirm error for ${phone}:`, err.message)
  );
});

// ── HTML template ─────────────────────────────────────────────────────────────

function pickerHTML(mapKey, token, label) {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>AasPass — Pick Location</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f0f0; height: 100dvh; overflow: hidden }

    #header {
      position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
      background: #075E54; color: #fff;
      padding: 12px 16px 10px;
    }
    #header h1 { font-size: 16px; font-weight: 700; letter-spacing: 0.2px }
    #header p  { font-size: 12px; opacity: 0.85; margin-top: 2px }

    #map { position: fixed; top: 60px; bottom: 130px; left: 0; right: 0 }

    #bottom {
      position: fixed; bottom: 0; left: 0; right: 0;
      background: #fff; padding: 12px 16px 20px;
      box-shadow: 0 -2px 12px rgba(0,0,0,0.12);
    }
    #place-name {
      font-size: 14px; font-weight: 600; color: #111;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      min-height: 20px; margin-bottom: 2px;
    }
    #place-addr {
      font-size: 12px; color: #777;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      min-height: 16px; margin-bottom: 10px;
    }
    #confirm-btn {
      width: 100%; padding: 14px;
      background: #25D366; color: #fff;
      border: none; border-radius: 10px;
      font-size: 16px; font-weight: 700;
      cursor: pointer; transition: background 0.15s;
      -webkit-tap-highlight-color: transparent;
    }
    #confirm-btn:disabled { background: #b2dfcb; cursor: not-allowed }
    #confirm-btn:not(:disabled):active { background: #1da851 }

    /* Success overlay */
    #success {
      display: none; position: fixed; inset: 0;
      background: #fff; flex-direction: column;
      align-items: center; justify-content: center;
      text-align: center; padding: 32px;
    }
    #success.show { display: flex }
    #success h2 { color: #25D366; font-size: 24px; margin-bottom: 8px }
    #success p  { color: #555; font-size: 15px; line-height: 1.5 }
  </style>
</head>
<body>

  <div id="header">
    <h1>📍 Pick your ${label}</h1>
    <p>Search or drag the map to your destination</p>
  </div>

  <div id="map"></div>

  <div id="bottom">
    <div id="place-name">Searching…</div>
    <div id="place-addr">Use the search box or drag the map</div>
    <button id="confirm-btn" disabled onclick="confirmLocation()">
      ✅ Confirm This Location
    </button>
  </div>

  <div id="success">
    <h2>✅ Location Confirmed!</h2>
    <p>Go back to WhatsApp —<br>the bot will continue automatically.</p>
  </div>

  <!-- Mappls Map SDK (key embedded in URL — standard Mappls Web pattern) -->
  <script src="https://apis.mappls.com/advancedmaps/api/${mapKey}/map_sdk?layer=vector&v=3.0&callback=initMap"></script>
  <script src="https://apis.mappls.com/advancedmaps/api/${mapKey}/map_sdk_plugins?v=3.0"></script>

  <script>
    var selLat = null, selLon = null, selLabel = '';

    function initMap() {
      var map = new mappls.Map('map', {
        center: [20.5937, 78.9629], // India
        zoom:   5,
        zoomControl: true,
      });

      map.addListener('load', function () {
        mappls.placePicker(
          {
            map:         map,
            search:      true,
            topText:     'Search your destination',
            geolocation: true,   // "Use my location" button
            closeBtn:    false,
          },
          function (data) {
            if (!data || !data.data) return;
            var d = data.data;

            // Handle all known Mappls SDK response shapes
            var lat  = d?.location?.lat  ?? d?.location?.latitude  ?? d?.lat  ?? d?.latitude  ?? null;
            var lon  = d?.location?.lng  ?? d?.location?.lon ?? d?.location?.longitude ?? d?.lng ?? d?.lon ?? d?.longitude ?? null;
            var name = d?.place?.placeName ?? d?.placeName ?? d?.formatted_address ?? 'Selected Location';
            var addr = d?.place?.placeAddress ?? d?.placeAddress ?? '';

            if (lat == null || lon == null) return;

            selLat   = parseFloat(lat);
            selLon   = parseFloat(lon);
            selLabel = name;

            document.getElementById('place-name').textContent = name;
            document.getElementById('place-addr').textContent = addr || 'Tap Confirm to use this location';
            document.getElementById('confirm-btn').disabled   = false;
          }
        );
      });
    }

    function confirmLocation() {
      if (selLat == null || selLon == null) return;

      var btn = document.getElementById('confirm-btn');
      btn.disabled    = true;
      btn.textContent = 'Confirming…';

      fetch('/pick/confirm', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token: '${token}', lat: selLat, lon: selLon, label: selLabel }),
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          document.getElementById('success').classList.add('show');
        } else {
          btn.disabled    = false;
          btn.textContent = '✅ Confirm This Location';
          alert(data.error || 'Something went wrong. Please try again.');
        }
      })
      .catch(function () {
        btn.disabled    = false;
        btn.textContent = '✅ Confirm This Location';
        alert('Network error. Please check your connection and try again.');
      });
    }
  </script>
</body>
</html>`;
}

module.exports = router;
