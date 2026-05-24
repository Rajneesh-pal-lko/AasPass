const supabase = require('../config/supabase');
const { sendText, sendButtons, sendList, sendCTAButton, sendLocationRequest } = require('../services/whatsapp');
const { getDistanceKm } = require('../utils/haversine');
const { findMatches, sendMatchResults, sendMatchRequest } = require('../services/matching');
const { reverseGeocode, forwardGeocode } = require('../services/geocoding');
const { parseLocationFromText, isValidCoord } = require('../utils/locationParser');
const { detectIntent } = require('../services/llm');

// Search window: 10 min initial, 5 min extension
const SEARCH_WINDOW_MS  = 10 * 60 * 1000;
const RETRY_WINDOW_MS   =  5 * 60 * 1000;

// ── Universal LLM gate config ─────────────────────────────────────────────────

// States where the user's text IS a location query — geocoding handles it first,
// with LLM as a fallback for commands like "cancel".
const LOCATION_STATES = new Set([
  'ONBOARDING_PICKUP', 'ONBOARDING_DROP',
  'EDITING_PICKUP',    'EDITING_DROP',
  'POOL_EDIT_PICKUP',  'POOL_EDIT_DROP',
]);

// States where the user's text IS free-form data input, not a command.
// e.g. typing their name or rating feedback — bypass LLM entirely.
const FREE_TEXT_STATES = new Set(['ONBOARDING_NAME', 'EDITING_NAME', 'RATING_FEEDBACK']);

// Exact-match keywords (UPPERCASED) that the state switch already handles directly.
// Text matching these goes straight to the switch — no LLM needed.
const HARD_KEYWORDS = new Set([
  'MATCHES', 'CANCEL', 'EDIT', 'DONE', 'ISSUE', 'BLOCK',
  'CONFIRM CANCEL', 'BACK', 'SKIP',
]);

// ── helpers ───────────────────────────────────────────────────────────────────

async function getUser(phone) {
  const { data } = await supabase.from('users').select('*').eq('phone', phone).single();
  return data;
}

async function upsertUser(phone, fields) {
  const { data, error } = await supabase
    .from('users')
    .upsert({ phone, ...fields }, { onConflict: 'phone' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function setState(phone, state, extra = {}) {
  return upsertUser(phone, { state, updated_at: new Date().toISOString(), ...extra });
}

// Truncate name to fit WhatsApp button label limit (20 chars)
function truncate(str, max = 20) {
  if (!str) return '';
  return str.length <= max ? str : str.substring(0, max - 1) + '…';
}

function genderLabel(g) {
  if (g === 'M')  return 'Male';
  if (g === 'F')  return 'Female';
  if (g === 'NB') return 'Non-binary';
  if (g === 'NS') return 'Not disclosed';
  return 'Not set';
}

function prefLabel(p) {
  if (p === 'ANY') return 'Anyone';
  if (p === 'M')   return 'Only Male';
  if (p === 'F')   return 'Only Female';
  return p || 'Anyone';
}

// Resolve lat/lon from WhatsApp location message OR pasted text (Maps link / coords)
async function resolveLocation(locationLat, locationLon, rawText) {
  if (locationLat && locationLon && isValidCoord(locationLat, locationLon)) {
    return { lat: locationLat, lon: locationLon, fromText: false };
  }
  if (rawText) {
    const parsed = await parseLocationFromText(rawText);
    if (parsed) return { ...parsed, fromText: true };
  }
  return null;
}

// Tries to resolve a location from 4 sources (in priority order):
//   1. User tapped a geocode result from a previous search list
//   2. WhatsApp location pin / Maps link / raw coordinates
//   3. Free-text place name → forward geocode → show selection list → 'SEARCHING'
//   4. Nothing found → returns null (caller should show error)
//
// Returns: { lat, lon } | 'SEARCHING' | null
async function resolveOrSearch(phone, msgType, locationLat, locationLon, rawText, listId) {
  // ── 1. User selected from our forward-geocode list ──
  if (listId?.startsWith('loc_')) {
    // ID format: "loc_{lat}_{lon}"  (negative values keep their minus sign)
    const parts = listId.slice(4).split('_');   // strip "loc_", then split by "_"
    // Handle negative lat/lon: "-17.423658_78.340644" → ["-17.423658", "78.340644"]
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    if (isValidCoord(lat, lon)) return { lat, lon };
  }

  // ── 2. Pin / Maps link / raw coordinates ──
  const loc = await resolveLocation(locationLat, locationLon, rawText);
  if (loc) return loc;

  // ── 3. Free-text place name → forward geocode ──
  if (msgType === 'text' && rawText.length >= 3) {
    const hits = await forwardGeocode(rawText, 5);
    if (hits.length > 0) {
      const rows = hits.map(h => {
        // Title: first segment before comma, capped at 24 chars
        const title = h.label.split(',')[0].trim().slice(0, 24);
        // Description: full address, capped at 72 chars
        const description = h.label.slice(0, 72);
        // Encode coords in the row ID so we can recover them on selection
        const id = `loc_${h.lat.toFixed(6)}_${h.lon.toFixed(6)}`;
        return { id, title, description };
      });

      await sendList(
        phone,
        `📍 Found *${hits.length}* result${hits.length > 1 ? 's' : ''} for "*${rawText.slice(0, 40)}*":\n\nSelect the correct location, or share a 📎 pin directly.`,
        'Choose Location',
        [{ title: 'Search Results', rows }]
      );
      return 'SEARCHING'; // list shown — wait for the user's list_reply
    }
  }

  // ── 4. Nothing worked ──
  return null;
}

// ── onboarding: name ─────────────────────────────────────────────────────────

async function sendNamePrompt(phone, waName) {
  if (waName) {
    const displayName = truncate(waName, 20);
    await sendButtons(
      phone,
      `Welcome to *AasPass* ✈️🚕\n\nWhat should we call you?`,
      [
        { id: 'USE_WA_NAME', title: displayName },
        { id: 'ENTER_NAME',  title: '✏️ Type my name' },
      ]
    );
  } else {
    await sendText(
      phone,
      `Welcome to *AasPass* ✈️🚕\n\nWhat should we call you? Reply with your *first name*.`
    );
  }
  await setState(phone, 'ONBOARDING_NAME');
}

async function sendGenderPrompt(phone) {
  await sendList(
    phone,
    `Nice to meet you! 👋\n\nWhat's your gender? This helps us show compatible matches.`,
    'Select Gender',
    [{
      title: 'Gender',
      rows: [
        { id: 'GENDER_M',  title: '👨 Male',               description: '' },
        { id: 'GENDER_F',  title: '👩 Female',             description: '' },
        { id: 'GENDER_NB', title: '🏳️ Non-binary',        description: '' },
        { id: 'GENDER_NS', title: '🤐 Prefer not to say',  description: 'Will match with anyone' },
      ],
    }]
  );
  await setState(phone, 'ONBOARDING_GENDER');
}

async function sendPreferredGenderPrompt(phone) {
  await sendButtons(
    phone,
    `Almost there! Who would you prefer to share a cab with?`,
    [
      { id: 'PREF_ANY', title: '🤝 Anyone'     },
      { id: 'PREF_F',   title: '👩 Only Female' },
      { id: 'PREF_M',   title: '👨 Only Male'   },
    ]
  );
  await setState(phone, 'ONBOARDING_PREFERRED_GENDER');
}

// ── onboarding: location ─────────────────────────────────────────────────────

async function sendPickupPrompt(phone, isReturning = false) {
  const prefix = isReturning
    ? `Welcome back to *AasPass* ✈️🚕\n\nLet's find you a match!\n\n`
    : `Great! Let's find you a match.\n\n`;
  await sendText(
    phone,
    `${prefix}*Step 1 of 2* — Share your *pickup location* 📍\n\nTap 📎 → Location → search any place or use current location.`
  );
  await setState(phone, 'ONBOARDING_PICKUP');
}

async function sendDropPrompt(phone, pickupLabel) {
  await sendText(
    phone,
    `📍 *Pickup:* ${pickupLabel}\n\n*Step 2 of 2* — Share your *drop destination* 📍\n\nTap 📎 → Location → search for your destination (any city).`
  );
  await setState(phone, 'ONBOARDING_DROP');
}

// ── onboarding: confirmation screen ──────────────────────────────────────────

async function sendConfirmation(phone, user) {
  const pickup = user.pickup_label || `${parseFloat(user.departure_lat).toFixed(4)}, ${parseFloat(user.departure_long).toFixed(4)}`;
  const drop   = user.drop_label   || `${parseFloat(user.drop_lat).toFixed(4)}, ${parseFloat(user.drop_long).toFixed(4)}`;

  await sendButtons(
    phone,
    `Here's your trip summary:\n\n` +
    `📍 *Pickup:*  ${pickup}\n` +
    `🎯 *Drop:*    ${drop}\n\n` +
    `👤 *Name:*    ${user.name || 'Not set'}\n` +
    `🧬 *Gender:*  ${genderLabel(user.gender)}\n` +
    `🤝 *Match:*   ${prefLabel(user.preferred_gender)}\n\n` +
    `Shall I find you a cab-split partner?`,
    [
      { id: 'CONFIRM_YES',  title: '✅ Confirm'      },
      { id: 'EDIT_DETAILS', title: '✏️ Edit Details' },
      { id: 'CONFIRM_NO',   title: '❌ Cancel'       },
    ]
  );
  await setState(phone, 'ONBOARDING_CONFIRM');
}

// ── edit menu ─────────────────────────────────────────────────────────────────

async function sendEditMenu(phone) {
  await sendList(
    phone,
    `Which detail would you like to change?`,
    'Choose Field',
    [{
      title: 'Edit Trip Details',
      rows: [
        { id: 'EDIT_NAME',     title: '👤 Name',             description: 'Change your display name'         },
        { id: 'EDIT_GENDER',   title: '🧬 Gender',           description: 'Update your gender'               },
        { id: 'EDIT_PREF',     title: '🤝 Match preference', description: 'Who you want to share with'       },
        { id: 'EDIT_PICKUP',   title: '📍 Pickup location',  description: 'Re-share your current location'   },
        { id: 'EDIT_DROP',     title: '🎯 Drop destination', description: 'Re-share your drop-off location'  },
      ],
    }]
  );
}

// ── main dispatcher ───────────────────────────────────────────────────────────

async function handleMessage(msg, waName) {
  const phone   = msg.from;
  const msgType = msg.type;

  let text      = '';
  let buttonId  = '';
  let listId    = '';
  let locationLat  = null;
  let locationLon  = null;

  if (msgType === 'text') text = (msg.text?.body || '').trim().toUpperCase();
  if (msgType === 'interactive') {
    const iType = msg.interactive?.type;
    if (iType === 'button_reply') buttonId = msg.interactive.button_reply.id;
    if (iType === 'list_reply')   listId   = msg.interactive.list_reply.id;
  }
  if (msgType === 'location') {
    locationLat = msg.location?.latitude;
    locationLon = msg.location?.longitude;
  }

  // Raw text (mixed case) for name capture
  const rawText = (msg.text?.body || '').trim();

  // ── Global commands (work from any state) ──
  if (text === 'STOP') {
    await upsertUser(phone, { is_active: false, state: 'IDLE' });
    return sendText(phone, `You've been removed from AasPass. Send "hi" anytime to come back. 👋`);
  }
  if (text === 'HELP')    return sendHelp(phone);
  if (text === 'STATUS')  return sendStatus(phone);

  const user  = await getUser(phone);
  const state = user?.state || 'IDLE';

  // Restart — always fresh start
  if (text === 'RESTART' || text === 'START') return startOrResume(phone, user, waName, true);
  if (text === 'HI' || text === '' && state === 'IDLE') return startOrResume(phone, user, waName, false);

  // ── Universal LLM gate ────────────────────────────────────────────────────
  // Fires for EVERY text message that isn't:
  //   • A hard keyword the switch already handles (CANCEL, MATCHES, DONE…)
  //   • A location state (geocoding runs first; LLM fires as fallback inside the case)
  //   • A free-text capture state (ONBOARDING_NAME, RATING_FEEDBACK…)
  //
  // If LLM returns a known action → execute it immediately.
  // If LLM returns UNKNOWN → fall through to the state switch for a
  //   context-specific hint (e.g. "please share your pickup pin").
  if (msgType === 'text' && rawText.length > 0
      && !LOCATION_STATES.has(state)
      && !FREE_TEXT_STATES.has(state)
      && !HARD_KEYWORDS.has(text)) {
    const intent = await detectIntent(rawText, state);
    console.log(`🤖 LLM [${state}] "${rawText}" → ${intent.action}`);
    if (intent.action !== 'UNKNOWN') {
      return handleLLMIntent(intent, phone, user, waName, state);
    }
    // UNKNOWN → fall through so the state switch can give a context-aware hint
  }

  switch (state) {

    // ── IDLE / COMPLETED ──────────────────────────────────────────────────────
    case 'IDLE':
    case 'COMPLETED':
      return startOrResume(phone, user, waName, false);

    // ── ONBOARDING: NAME ──────────────────────────────────────────────────────
    case 'ONBOARDING_NAME': {
      let name = null;

      if (buttonId === 'USE_WA_NAME') {
        // Use their WhatsApp display name (comes from webhook contacts array)
        name = waName || 'Friend';
      } else if (buttonId === 'ENTER_NAME') {
        // They tapped "Type my name" — prompt again with text instruction
        await sendText(phone, `Sure! Just reply with your *first name* and we'll use that.`);
        return;
      } else if (rawText.length >= 2 && rawText.length <= 30) {
        name = rawText;
      } else if (rawText.length > 0) {
        return sendText(phone, `Please enter a name between 2 and 30 characters.`);
      } else {
        return sendText(phone, `Please reply with your *first name* to continue.`);
      }

      await setState(phone, 'ONBOARDING_GENDER', { name });
      return sendGenderPrompt(phone);
    }

    // ── ONBOARDING: GENDER ────────────────────────────────────────────────────
    case 'ONBOARDING_GENDER': {
      const genderMap = { GENDER_M: 'M', GENDER_F: 'F', GENDER_NB: 'NB', GENDER_NS: 'NS' };
      const gender = genderMap[listId] || 'NS'; // default to NS if somehow skipped
      await setState(phone, 'ONBOARDING_PREFERRED_GENDER', { gender });
      return sendPreferredGenderPrompt(phone);
    }

    // ── ONBOARDING: PREFERRED GENDER ─────────────────────────────────────────
    case 'ONBOARDING_PREFERRED_GENDER': {
      const prefMap = { PREF_ANY: 'ANY', PREF_M: 'M', PREF_F: 'F' };
      const preferred_gender = prefMap[buttonId] || 'ANY'; // default to ANY if skipped
      await setState(phone, 'ONBOARDING_PICKUP', { preferred_gender });
      return sendPickupPrompt(phone, false);
    }

    // ── ONBOARDING: PICKUP LOCATION ───────────────────────────────────────────
    case 'ONBOARDING_PICKUP': {
      const loc = await resolveOrSearch(phone, msgType, locationLat, locationLon, rawText, listId);
      if (loc === 'SEARCHING') return; // geocode list sent, waiting for selection
      if (!loc) {
        // No location found — try LLM for commands like "cancel", "go back"
        if (msgType === 'text' && rawText.length > 0) {
          const intent = await detectIntent(rawText, state);
          console.log(`🤖 LLM [${state}] "${rawText}" → ${intent.action}`);
          if (intent.action !== 'UNKNOWN') return handleLLMIntent(intent, phone, user, waName, state);
        }
        return sendText(phone,
          `Please share your *pickup location* 📍\n\n` +
          `• Tap 📎 → Location → search or use current location\n` +
          `• Or type a place name: *Mantri Celestia Hyderabad*\n` +
          `• Or paste a Google Maps link\n` +
          `• Or type coordinates: *17.2403, 78.4294*`
        );
      }
      const pickup_label = await reverseGeocode(loc.lat, loc.lon);
      await setState(phone, 'ONBOARDING_DROP', {
        departure_lat: loc.lat, departure_long: loc.lon, pickup_label,
      });
      return sendDropPrompt(phone, pickup_label);
    }

    // ── ONBOARDING: DROP LOCATION ─────────────────────────────────────────────
    case 'ONBOARDING_DROP': {
      const loc = await resolveOrSearch(phone, msgType, locationLat, locationLon, rawText, listId);
      if (loc === 'SEARCHING') return;
      if (!loc) {
        if (msgType === 'text' && rawText.length > 0) {
          const intent = await detectIntent(rawText, state);
          console.log(`🤖 LLM [${state}] "${rawText}" → ${intent.action}`);
          if (intent.action !== 'UNKNOWN') return handleLLMIntent(intent, phone, user, waName, state);
        }
        return sendText(phone,
          `Please share your *drop destination* 📍\n\n` +
          `• Tap 📎 → Location → search any city\n` +
          `• Or type a place name: *Connaught Place Delhi*\n` +
          `• Or paste a Google Maps link\n` +
          `• Or type coordinates: *28.6139, 77.2090*`
        );
      }
      const drop_label = await reverseGeocode(loc.lat, loc.lon);
      const updatedUser = await setState(phone, 'ONBOARDING_CONFIRM', {
        drop_lat: loc.lat, drop_long: loc.lon, drop_label, drop_zone: drop_label,
      });
      return sendConfirmation(phone, updatedUser);
    }

    // ── ONBOARDING: CONFIRM ───────────────────────────────────────────────────
    case 'ONBOARDING_CONFIRM': {
      // Edit field selections arrive here since state stays ONBOARDING_CONFIRM after sendEditMenu
      if (listId === 'EDIT_NAME') {
        await sendText(phone, `What name would you like to use? Reply with your *first name*.`);
        return setState(phone, 'EDITING_NAME');
      }
      if (listId === 'EDIT_GENDER') {
        await setState(phone, 'EDITING_GENDER');
        return sendGenderPrompt(phone);
      }
      if (listId === 'EDIT_PREF') {
        await setState(phone, 'EDITING_PREFERRED_GENDER');
        return sendPreferredGenderPrompt(phone);
      }
      if (listId === 'EDIT_PICKUP') {
        await setState(phone, 'EDITING_PICKUP');
        return sendLocationRequest(phone, `Share your new *pickup location* 📍`);
      }
      if (listId === 'EDIT_DROP') {
        await setState(phone, 'EDITING_DROP');
        return sendLocationRequest(phone, `Share your new *drop destination* 📍`);
      }

      if (buttonId === 'CONFIRM_NO')   return startOrResume(phone, user, waName, true);
      if (buttonId === 'EDIT_DETAILS') return sendEditMenu(phone);
      if (buttonId !== 'CONFIRM_YES')  return sendConfirmation(phone, user);

      const now = new Date().toISOString();
      const activeUser = await setState(phone, 'WAITING', {
        is_active:         true,
        is_matched:        false,
        search_started_at: now,
        expires_at:        new Date(Date.now() + SEARCH_WINDOW_MS).toISOString(),
      });

      await syncProfileFields(phone, activeUser);

      const matches = await findMatches(activeUser);
      await sendMatchResults(activeUser, matches);
      await notifyWaitingUsers(activeUser, matches);
      return;
    }

    // ── EDITING: NAME ─────────────────────────────────────────────────────────
    case 'EDITING_NAME': {
      if (rawText.length < 2 || rawText.length > 30) {
        return sendText(phone, `Name must be between 2 and 30 characters. Try again.`);
      }
      const updated = await setState(phone, 'ONBOARDING_CONFIRM', { name: rawText });
      return sendConfirmation(phone, updated);
    }

    // ── EDITING: GENDER ───────────────────────────────────────────────────────
    case 'EDITING_GENDER': {
      const genderMap = { GENDER_M: 'M', GENDER_F: 'F', GENDER_NB: 'NB', GENDER_NS: 'NS' };
      const gender = genderMap[listId];
      if (!gender) return sendGenderPrompt(phone);
      const updated = await setState(phone, 'ONBOARDING_CONFIRM', { gender });
      return sendConfirmation(phone, updated);
    }

    // ── EDITING: PREFERRED GENDER ─────────────────────────────────────────────
    case 'EDITING_PREFERRED_GENDER': {
      const prefMap = { PREF_ANY: 'ANY', PREF_M: 'M', PREF_F: 'F' };
      const preferred_gender = prefMap[buttonId];
      if (!preferred_gender) return sendPreferredGenderPrompt(phone);
      const updated = await setState(phone, 'ONBOARDING_CONFIRM', { preferred_gender });
      return sendConfirmation(phone, updated);
    }

    // ── EDITING: PICKUP ───────────────────────────────────────────────────────
    case 'EDITING_PICKUP': {
      const loc = await resolveOrSearch(phone, msgType, locationLat, locationLon, rawText, listId);
      if (loc === 'SEARCHING') return;
      if (!loc) {
        if (msgType === 'text' && rawText.length > 0) {
          const intent = await detectIntent(rawText, state);
          console.log(`🤖 LLM [${state}] "${rawText}" → ${intent.action}`);
          if (intent.action !== 'UNKNOWN') return handleLLMIntent(intent, phone, user, waName, state);
        }
        return sendText(phone, `Share your new *pickup location* 📍\n\nTap 📎 → Location, type a place name, paste a Maps link, or type coordinates.`);
      }
      const pickup_label = await reverseGeocode(loc.lat, loc.lon);
      const updated = await setState(phone, 'ONBOARDING_CONFIRM', {
        departure_lat: loc.lat, departure_long: loc.lon, pickup_label,
      });
      return sendConfirmation(phone, updated);
    }

    // ── EDITING: DROP ─────────────────────────────────────────────────────────
    case 'EDITING_DROP': {
      const loc = await resolveOrSearch(phone, msgType, locationLat, locationLon, rawText, listId);
      if (loc === 'SEARCHING') return;
      if (!loc) {
        if (msgType === 'text' && rawText.length > 0) {
          const intent = await detectIntent(rawText, state);
          console.log(`🤖 LLM [${state}] "${rawText}" → ${intent.action}`);
          if (intent.action !== 'UNKNOWN') return handleLLMIntent(intent, phone, user, waName, state);
        }
        return sendText(phone, `Share your new *drop destination* 📍\n\nTap 📎 → Location, type a place name, paste a Maps link, or type coordinates.`);
      }
      const drop_label = await reverseGeocode(loc.lat, loc.lon);
      const updated = await setState(phone, 'ONBOARDING_CONFIRM', {
        drop_lat: loc.lat, drop_long: loc.lon, drop_label, drop_zone: drop_label,
      });
      return sendConfirmation(phone, updated);
    }

    // ── POOL EDIT: PICKUP (while in WAITING pool) ─────────────────────────────
    case 'POOL_EDIT_PICKUP': {
      const loc = await resolveOrSearch(phone, msgType, locationLat, locationLon, rawText, listId);
      if (loc === 'SEARCHING') return;
      if (!loc) {
        if (msgType === 'text' && rawText.length > 0) {
          const intent = await detectIntent(rawText, state);
          console.log(`🤖 LLM [${state}] "${rawText}" → ${intent.action}`);
          if (intent.action !== 'UNKNOWN') return handleLLMIntent(intent, phone, user, waName, state);
        }
        return sendText(phone, `Share your new *pickup location* 📍\n\nTap 📎 → Location, type a place name, paste a Maps link, or type coordinates.`);
      }
      const pickup_label = await reverseGeocode(loc.lat, loc.lon);
      const updatedUser = await setState(phone, 'WAITING', {
        departure_lat: loc.lat, departure_long: loc.lon, pickup_label,
        search_started_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + SEARCH_WINDOW_MS).toISOString(),
      });
      await sendText(phone, `✅ Pickup updated to: *${pickup_label}*\n\nSearching for new matches...`);
      const matchesP = await findMatches(updatedUser);
      return sendMatchResults(updatedUser, matchesP);
    }

    // ── POOL EDIT: DROP (while in WAITING pool) ───────────────────────────────
    case 'POOL_EDIT_DROP': {
      const loc = await resolveOrSearch(phone, msgType, locationLat, locationLon, rawText, listId);
      if (loc === 'SEARCHING') return;
      if (!loc) {
        if (msgType === 'text' && rawText.length > 0) {
          const intent = await detectIntent(rawText, state);
          console.log(`🤖 LLM [${state}] "${rawText}" → ${intent.action}`);
          if (intent.action !== 'UNKNOWN') return handleLLMIntent(intent, phone, user, waName, state);
        }
        return sendText(phone, `Share your new *drop destination* 📍\n\nTap 📎 → Location, type a place name, paste a Maps link, or type coordinates.`);
      }
      const drop_label = await reverseGeocode(loc.lat, loc.lon);
      const updatedUser = await setState(phone, 'WAITING', {
        drop_lat: loc.lat, drop_long: loc.lon, drop_label, drop_zone: drop_label,
        search_started_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + SEARCH_WINDOW_MS).toISOString(),
      });
      await sendText(phone, `✅ Drop updated to: *${drop_label}*\n\nSearching for new matches...`);
      const matchesD = await findMatches(updatedUser);
      return sendMatchResults(updatedUser, matchesD);
    }

    // ── WAITING ───────────────────────────────────────────────────────────────
    case 'WAITING': {
      if (text === 'MATCHES') {
        const freshUser = await getUser(phone);
        const matches   = await findMatches(freshUser);
        return sendMatchResults(freshUser, matches);
      }
      if (text === 'CANCEL') return handleCancelInWaiting(phone, user);
      if (text === 'EDIT')   return sendPoolEditMenu(phone);

      // Edit buttons from pool edit menu
      if (buttonId === 'POOL_EDIT_PICKUP') {
        await cancelPendingRequestsFrom(user);
        await setState(phone, 'POOL_EDIT_PICKUP');
        return sendLocationRequest(phone, `Share your new *pickup location* 📍`);
      }
      if (buttonId === 'POOL_EDIT_DROP') {
        await cancelPendingRequestsFrom(user);
        await setState(phone, 'POOL_EDIT_DROP');
        return sendLocationRequest(phone, `Share your new *drop destination* 📍`);
      }

      if (listId.startsWith('match_')) {
        return handleMatchRequest(phone, listId.replace('match_', ''), user);
      }
      return sendText(phone, `You're in the matching pool! 🔍\n\nType *MATCHES* to view matches, *EDIT* to update your pickup/drop, or *CANCEL* to withdraw.`);
    }

    // ── WAITING_RETRY (shown "extend?" question) ──────────────────────────────
    case 'WAITING_RETRY': {
      if (buttonId === 'RETRY_YES') {
        const extended = await setState(phone, 'WAITING', {
          search_started_at: new Date().toISOString(),
          is_active:  true,
          expires_at: new Date(Date.now() + RETRY_WINDOW_MS).toISOString(),
        });
        const matches = await findMatches(extended);
        if (matches.length) return sendMatchResults(extended, matches);
        return sendText(phone, `Still looking! ⏳ I'll alert you the moment a match appears nearby.`);
      }
      if (buttonId === 'RETRY_NO') {
        await setState(phone, 'IDLE', { is_active: false });
        return sendText(phone, `No problem! Send "hi" whenever you're ready to search again. ✈️`);
      }
      return sendText(phone, `Please tap *Yes* or *No* on the message above to continue.`);
    }

    // ── MATCH_SENT ────────────────────────────────────────────────────────────
    case 'MATCH_SENT': {
      if (text === 'CANCEL') return handleCancelSentRequest(phone, user);
      if (text === 'EDIT')   return sendPoolEditMenu(phone);
      if (buttonId === 'POOL_EDIT_PICKUP') {
        await handleCancelSentRequest(phone, user);
        await setState(phone, 'POOL_EDIT_PICKUP');
        return sendLocationRequest(phone, `Share your new *pickup location* 📍`);
      }
      if (buttonId === 'POOL_EDIT_DROP') {
        await handleCancelSentRequest(phone, user);
        await setState(phone, 'POOL_EDIT_DROP');
        return sendLocationRequest(phone, `Share your new *drop destination* 📍`);
      }
      return sendText(phone, `Your request is pending. They'll respond shortly.\n\nType *CANCEL* to withdraw, or *EDIT* to update your trip details.`);
    }

    // ── MATCH_RECEIVED ────────────────────────────────────────────────────────
    case 'MATCH_RECEIVED': {
      if (buttonId.startsWith('ACCEPT_'))  return handleAcceptMatch(phone, buttonId.replace('ACCEPT_', ''),  user);
      if (buttonId.startsWith('DECLINE_')) return handleDeclineMatch(phone, buttonId.replace('DECLINE_', ''), user);
      return sendText(phone, `Please tap *Accept* or *Decline* on the request above.`);
    }

    // ── MATCHED ───────────────────────────────────────────────────────────────
    case 'MATCHED': {
      if (text === 'CANCEL') return initiateCancelAfterMatch(phone, user);
      if (text === 'CONFIRM CANCEL') return handleCancelAfterMatch(phone, user);
      if (text === 'BACK')   return sendText(phone, `Your match is still active! Safe travels. ✈️`);
      if (text === 'BLOCK')  return handleBlock(phone, user);

      if (buttonId === 'SHARE_CONTACT') return handleShareContact(phone, user);
      if (text === 'DONE' || buttonId === 'TRIP_DONE')  return handleTripDone(phone, user);
      if (text === 'ISSUE' || buttonId === 'TRIP_ISSUE') return sendIssueMenu(phone);

      return sendText(phone, `You're matched! 🎉\n\nTap *Share Contact* to exchange numbers, *DONE* when complete, or *ISSUE* to report a problem.\nType *CANCEL* to cancel this match.`);
    }

    // ── RATING ────────────────────────────────────────────────────────────────
    case 'RATING': {
      const ratingMap = { RATE_1: 1, RATE_2: 2, RATE_3: 3, RATE_4: 4, RATE_5: 5 };
      const rating = ratingMap[listId];
      if (!rating) return sendRatingPrompt(phone);

      await setState(phone, 'RATING_FEEDBACK', { pending_rating: rating });
      const stars = '⭐'.repeat(rating);
      return sendText(phone, `Thanks for the ${stars}!\n\nAny feedback for your partner? (or type *skip* to finish)`);
    }

    // ── RATING_FEEDBACK ───────────────────────────────────────────────────────
    case 'RATING_FEEDBACK': {
      const feedback = text === 'SKIP' ? null : rawText;
      await saveRating(phone, user, feedback);
      await setState(phone, 'COMPLETED', { is_active: false, is_matched: false });
      return sendText(phone, `All done! 🎉 Thanks for using AasPass.\n\nSee you on the next trip! ✈️`);
    }

    // ── REPORTING ─────────────────────────────────────────────────────────────
    case 'REPORTING': {
      const categoryMap = {
        ISSUE_NOSHOW:     'No-show',
        ISSUE_MONEY:      'Extra money demanded',
        ISSUE_HARASSMENT: 'Harassment',
        ISSUE_SPAM:       'Spam / fake profile',
        ISSUE_OTHER:      'Other',
      };
      const category = categoryMap[listId];
      if (!category) return sendIssueMenu(phone);

      await supabase.from('support_queue').insert({
        user_id:      user.user_id,
        issue_type:   listId,
        description:  category,
        created_at:   new Date().toISOString(),
        resolved:     false,
      });

      await setState(phone, 'COMPLETED', { is_active: false, is_matched: false });
      return sendText(phone, `We've logged your report: *${category}*.\n\nOur team will review it shortly. Thank you for keeping AasPass safe. 🙏`);
    }

    default:
      // Unknown/corrupted state — restart gracefully
      return startOrResume(phone, user, waName, false);
  }
}

// ── Entry point: determine if new or returning user ───────────────────────────

async function startOrResume(phone, user, waName, forceRestart) {
  // Returning user with name + gender already set — skip profile steps
  if (!forceRestart && user?.name && user?.gender) {
    await sendText(phone, `Welcome back, *${user.name}*! 👋\n\nLet's find you a ride-share partner.`);
    return sendPickupPrompt(phone, true);
  }

  // New user (or forced restart) — full onboarding
  return sendNamePrompt(phone, waName);
}

// ── Sync profile fields to user_profiles table ───────────────────────────────

async function syncProfileFields(phone, user) {
  try {
    await supabase.from('user_profiles').upsert({
      phone,
      name:             user.name,
      gender:           user.gender,
      preferred_gender: user.preferred_gender,
      last_seen_at:     new Date().toISOString(),
    }, { onConflict: 'phone' });
  } catch (e) {
    console.error('Profile sync error:', e.message);
  }
}

// ── Pool edit helpers ─────────────────────────────────────────────────────────

async function sendPoolEditMenu(phone) {
  await sendButtons(
    phone,
    `What would you like to update?`,
    [
      { id: 'POOL_EDIT_PICKUP', title: '📍 Pickup location'  },
      { id: 'POOL_EDIT_DROP',   title: '🎯 Drop destination' },
    ]
  );
}

// Cancel all pending sent requests and notify receivers
async function cancelPendingRequestsFrom(user) {
  const { data: reqs } = await supabase
    .from('match_requests')
    .select('*')
    .eq('from_user', user.user_id)
    .eq('status', 'pending');

  if (!reqs?.length) return;

  for (const req of reqs) {
    await supabase.from('match_requests')
      .update({ status: 'cancelled_by_sender', cancelled_by: user.user_id, cancelled_at: new Date().toISOString() })
      .eq('request_id', req.request_id);

    // Notify the person who received the now-invalid request
    const { data: toUser } = await supabase.from('users').select('*').eq('user_id', req.to_user).single();
    if (toUser && toUser.state === 'MATCH_RECEIVED') {
      await setState(toUser.phone, 'WAITING', { pending_request_id: null });
      await sendText(toUser.phone,
        `The match request you received is no longer available — the sender updated their trip. You're back in the pool! 🔄`
      ).catch(() => {});
    }
  }
}

async function handleCancelInWaiting(phone, user) {
  await cancelPendingRequestsFrom(user);
  await setState(phone, 'IDLE', { is_active: false });
  return sendText(phone, `You've left the matching pool. Send *hi* to search again anytime. 👋`);
}

// ── Match request flow ────────────────────────────────────────────────────────

async function handleMatchRequest(fromPhone, toUserId, fromUser) {
  // Block duplicate pending requests
  const { data: existing } = await supabase
    .from('match_requests')
    .select('request_id')
    .eq('from_user', fromUser.user_id)
    .eq('status', 'pending')
    .maybeSingle();

  if (existing) {
    return sendText(fromPhone, `You already have a pending request out.\n\nType *CANCEL* to withdraw it first, then pick a new match.`);
  }

  const { data: toUser } = await supabase.from('users').select('*').eq('user_id', toUserId).single();
  if (!toUser || !toUser.is_active || toUser.is_matched) {
    return sendText(fromPhone, `That match is no longer available. Type *MATCHES* to see current options.`);
  }

  const dist = getDistanceKm(fromUser.drop_lat, fromUser.drop_long, toUser.drop_lat, toUser.drop_long);

  const { data: req } = await supabase
    .from('match_requests')
    .insert({ from_user: fromUser.user_id, to_user: toUser.user_id, distance_km: dist, status: 'pending' })
    .select().single();

  await setState(fromPhone, 'MATCH_SENT', { pending_request_id: req.request_id });
  await setState(toUser.phone, 'MATCH_RECEIVED', { pending_request_id: req.request_id });

  await sendText(fromPhone, `Request sent to *${toUser.name || 'them'}*! ✅\n\nWaiting for their reply. I'll notify you right away.\n\nType *CANCEL* to withdraw.`);
  await sendMatchRequest(fromUser, toUser, dist);

  // Auto-expire request after 10 minutes
  setTimeout(() => expireRequest(req.request_id, fromUser, toUser), 10 * 60 * 1000);
}

async function handleAcceptMatch(toPhone, fromUserId, toUser) {
  const { data: fromUser } = await supabase.from('users').select('*').eq('user_id', fromUserId).single();
  if (!fromUser) return sendText(toPhone, `Something went wrong. Type STATUS to check.`);

  // Find the pending request
  const { data: req } = await supabase
    .from('match_requests').select('*')
    .eq('from_user', fromUserId).eq('to_user', toUser.user_id).eq('status', 'pending').single();

  if (!req) return sendText(toPhone, `This request has already expired or been cancelled.`);

  // Use SELECT FOR UPDATE via RPC to prevent double-acceptance race condition
  const { data: result, error: rpcError } = await supabase
    .rpc('accept_match_request', {
      p_request_id:  req.request_id,
      p_to_user_id:  toUser.user_id,
    });

  if (rpcError || !result?.success) {
    const reason = result?.error || rpcError?.message || 'unknown';
    console.error('accept_match_request RPC error:', reason);
    return sendText(toPhone, `This request is no longer available. You're back in the pool!`);
  }

  // Store pending_request_id on both user rows for contact sharing
  await supabase.from('users').update({ pending_request_id: req.request_id }).eq('user_id', toUser.user_id);
  await supabase.from('users').update({ pending_request_id: req.request_id }).eq('user_id', fromUser.user_id);

  // Send trust signals + Share Contact button to BOTH users
  await sendTrustSignals(fromUser.phone, fromUser, toUser, req);
  await sendTrustSignals(toPhone, toUser, fromUser, req);
}

async function sendTrustSignals(phone, selfUser, partnerUser, req) {
  // Fetch partner's rating from user_profiles
  const { data: profile } = await supabase.from('user_profiles').select('avg_rating, total_ratings').eq('phone', partnerUser.phone).single();
  const ratingStr = profile?.total_ratings > 0
    ? `⭐ ${parseFloat(profile.avg_rating).toFixed(1)} (${profile.total_ratings} rating${profile.total_ratings > 1 ? 's' : ''})`
    : `⭐ New user`;

  const partnerDrop = partnerUser.drop_label || partnerUser.drop_zone || 'Nearby';

  await sendButtons(
    phone,
    `🎉 *Match confirmed!*\n\n` +
    `Your match:\n` +
    `👤 *${partnerUser.name || 'Anonymous'}* (${genderLabel(partnerUser.gender)})\n` +
    `📍 Drop: ${partnerDrop}\n` +
    `${ratingStr}\n\n` +
    `Tap *Share Contact* below to exchange WhatsApp numbers.`,
    [
      { id: 'SHARE_CONTACT', title: '📱 Share Contact' },
      { id: 'TRIP_DONE',     title: '✅ Done'          },
    ]
  );
}

async function handleShareContact(phone, user) {
  const freshUser = await getUser(phone);
  const { data: req } = await supabase
    .from('match_requests').select('*')
    .eq('request_id', freshUser.pending_request_id).single();

  if (!req) return sendText(phone, `Match request not found. Type STATUS to check.`);

  // Determine if this user is 'a' (from_user) or 'b' (to_user)
  const isA = req.from_user === freshUser.user_id;
  const updateField = isA ? { a_shared_contact: true } : { b_shared_contact: true };

  const { data: updatedReq } = await supabase
    .from('match_requests')
    .update(updateField)
    .eq('request_id', req.request_id)
    .select().single();

  const bothShared = updatedReq.a_shared_contact && updatedReq.b_shared_contact;

  if (bothShared) {
    // Reveal numbers to both
    const { data: partnerUser } = await supabase
      .from('users').select('*').eq('user_id', freshUser.matched_with).single();
    if (partnerUser) {
      await revealContact(freshUser.phone, partnerUser);
      await revealContact(partnerUser.phone, freshUser);
    }
  } else {
    await sendText(phone, `✅ Your number is ready to share!\n\nWaiting for *${isA ? 'them' : 'them'}* to also tap Share Contact... I'll notify you the moment they do.`);
  }
}

async function revealContact(phone, partnerUser) {
  const partnerPhone = partnerUser.phone.startsWith('+') ? partnerUser.phone : `+${partnerUser.phone}`;
  await sendButtons(
    phone,
    `🎊 *Both of you agreed!* Numbers exchanged.\n\n` +
    `*${partnerUser.name || 'Your match'}*: https://wa.me/${partnerUser.phone}\n\n` +
    `Book a cab together and split the fare! 🚕\n\nTap *Done* once your trip is complete.`,
    [
      { id: 'TRIP_DONE',  title: '✅ Done'    },
      { id: 'TRIP_ISSUE', title: '⚠️ Issue'   },
    ]
  );
}

async function handleDeclineMatch(toPhone, fromUserId, toUser) {
  const { data: fromUser } = await supabase.from('users').select('*').eq('user_id', fromUserId).single();

  await supabase.from('match_requests')
    .update({ status: 'declined', responded_at: new Date().toISOString() })
    .eq('from_user', fromUserId).eq('to_user', toUser.user_id).eq('status', 'pending');

  await setState(toPhone, 'WAITING');
  if (fromUser) {
    await setState(fromUser.phone, 'WAITING', { is_matched: false });
    const matches = await findMatches(fromUser);
    await sendText(fromUser.phone, `They declined. Let me show you the next best options.`);
    await sendMatchResults(fromUser, matches);
  }

  await sendText(toPhone, `No problem! You're back in the pool. ✌️`);
}

async function expireRequest(requestId, fromUser, toUser) {
  const { data: req } = await supabase.from('match_requests').select('status').eq('request_id', requestId).single();
  if (!req || req.status !== 'pending') return;

  await supabase.from('match_requests').update({ status: 'expired' }).eq('request_id', requestId);
  await setState(fromUser.phone, 'WAITING');
  await setState(toUser.phone,   'WAITING');

  await sendText(fromUser.phone, `Your request timed out after 10 minutes. Showing next matches...`);
  await sendText(toUser.phone,   `A match request expired. You're back in the pool!`);

  const matches = await findMatches(fromUser);
  await sendMatchResults(fromUser, matches);
}

// ── Cancel flows ──────────────────────────────────────────────────────────────

async function handleCancelSentRequest(phone, user) {
  if (user.pending_request_id) {
    const { data: req } = await supabase.from('match_requests').select('*').eq('request_id', user.pending_request_id).single();
    if (req) {
      await supabase.from('match_requests')
        .update({ status: 'cancelled_by_sender', cancelled_by: user.user_id, cancelled_at: new Date().toISOString() })
        .eq('request_id', req.request_id);
      const { data: toUser } = await supabase.from('users').select('*').eq('user_id', req.to_user).single();
      if (toUser) {
        await setState(toUser.phone, 'WAITING');
        await sendText(toUser.phone, `The cab-split request was withdrawn. You're back in the pool!`);
      }
    }
  }
  await setState(phone, 'WAITING');
  return sendText(phone, `Request cancelled. You're back in the pool. Type *MATCHES* to see options.`);
}

async function initiateCancelAfterMatch(phone) {
  return sendButtons(phone, `Are you sure you want to cancel this match?`, [
    { id: 'CONFIRM_CANCEL', title: '✅ Yes, Cancel' },
    { id: 'BACK_TO_MATCH',  title: '⬅️ Keep Match'  },
  ]);
}

async function handleCancelAfterMatch(phone, user) {
  const { data: matchedUser } = await supabase.from('users').select('*').eq('user_id', user.matched_with).single();

  await setState(phone, 'WAITING', { is_matched: false, matched_with: null });
  if (matchedUser) {
    await setState(matchedUser.phone, 'WAITING', { is_matched: false, matched_with: null });
    await sendText(matchedUser.phone, `Your cab-split partner cancelled. You're back in the pool!`);
    const matches = await findMatches(matchedUser);
    await sendMatchResults(matchedUser, matches);
  }

  return sendText(phone, `Match cancelled. Back in the pool. Type *MATCHES* to search again.`);
}

// ── Block ─────────────────────────────────────────────────────────────────────

async function handleBlock(phone, user) {
  if (!user.matched_with) {
    return sendText(phone, `Nothing to block. Type HELP for commands.`);
  }

  // Silent block — insert into blocked_users, clean up match, no notification to blocked party
  await supabase.from('blocked_users').upsert(
    { blocker_id: user.user_id, blocked_id: user.matched_with },
    { onConflict: 'blocker_id,blocked_id', ignoreDuplicates: true }
  );

  // Also cancel the active match request
  if (user.pending_request_id) {
    await supabase.from('match_requests')
      .update({ status: 'cancelled_by_sender', cancelled_by: user.user_id, cancelled_at: new Date().toISOString() })
      .eq('request_id', user.pending_request_id);
  }

  // Silently return the other person to WAITING
  const { data: blocked } = await supabase.from('users').select('*').eq('user_id', user.matched_with).single();
  if (blocked) {
    await setState(blocked.phone, 'WAITING', { is_matched: false, matched_with: null });
    // No notification sent to blocked user — silent
  }

  await setState(phone, 'WAITING', { is_matched: false, matched_with: null });
  return sendText(phone, `Done. You're back in the pool. 🔄`);
}

// ── Trip completion ───────────────────────────────────────────────────────────

async function handleTripDone(phone, user) {
  await supabase.from('match_requests')
    .update({ status: 'completed', confirmed_by: user.user_id, confirmed_at: new Date().toISOString() })
    .or(`from_user.eq.${user.user_id},to_user.eq.${user.user_id}`)
    .eq('status', 'accepted');

  await setState(phone, 'RATING', { is_active: false });
  return sendRatingPrompt(phone);
}

async function sendRatingPrompt(phone) {
  await sendList(
    phone,
    `Glad it worked out! 🎉\n\nHow would you rate your cab-split experience?`,
    'Rate Experience',
    [{
      title: 'Your Rating',
      rows: [
        { id: 'RATE_5', title: '⭐⭐⭐⭐⭐ Excellent',  description: 'Had a great time!'     },
        { id: 'RATE_4', title: '⭐⭐⭐⭐ Good',         description: 'Went smoothly'         },
        { id: 'RATE_3', title: '⭐⭐⭐ Average',        description: 'It was okay'           },
        { id: 'RATE_2', title: '⭐⭐ Below average',   description: 'Had some issues'       },
        { id: 'RATE_1', title: '⭐ Poor',              description: 'Significant problems'  },
      ],
    }]
  );
}

async function saveRating(phone, user, feedbackText) {
  try {
    const freshUser = await getUser(phone);
    if (!freshUser?.matched_with || !freshUser?.pending_request_id) return;

    const rating = freshUser.pending_rating;
    if (!rating) return;

    await supabase.from('reviews').insert({
      reviewer_id: freshUser.user_id,
      reviewee_id: freshUser.matched_with,
      match_id:    freshUser.pending_request_id,
      rating,
      feedback:    feedbackText || null,
      created_at:  new Date().toISOString(),
    });
  } catch (e) {
    console.error('Save rating error:', e.message);
  }
}

// ── Issue / report ────────────────────────────────────────────────────────────

async function sendIssueMenu(phone) {
  await sendList(
    phone,
    `Sorry to hear that! 😟\n\nWhat happened? Please select the category that best describes your issue:`,
    'Report Issue',
    [{
      title: 'Issue Type',
      rows: [
        { id: 'ISSUE_NOSHOW',     title: '🚫 No-show',             description: 'Match didn\'t show up'       },
        { id: 'ISSUE_MONEY',      title: '💸 Extra money',         description: 'Asked for more than agreed'  },
        { id: 'ISSUE_HARASSMENT', title: '⚠️ Harassment',          description: 'Inappropriate behaviour'     },
        { id: 'ISSUE_SPAM',       title: '🤖 Spam / fake profile', description: 'Suspected fake or bot'       },
        { id: 'ISSUE_OTHER',      title: '❓ Other',               description: 'Something else happened'     },
      ],
    }]
  );
  await setState(phone, 'REPORTING');
}

// ── Notify waiting users ──────────────────────────────────────────────────────

async function notifyWaitingUsers(newUser, matchesForNewUser) {
  for (const match of matchesForNewUser.slice(0, 3)) {
    if (match.state === 'WAITING') {
      await sendText(match.phone, `A new match just appeared near you! 🚕\n\nType *MATCHES* to view.`).catch(() => {});
    }
  }
}

// ── Utility commands ──────────────────────────────────────────────────────────

async function sendHelp(phone) {
  return sendText(phone,
    `*AasPass Commands* ✈️\n\n` +
    `*hi / start* — Begin or resume\n` +
    `*MATCHES* — View available matches\n` +
    `*CANCEL* — Cancel request or match\n` +
    `*DONE* — Confirm trip completed\n` +
    `*ISSUE* — Report a problem\n` +
    `*BLOCK* — Block current match (silent)\n` +
    `*STATUS* — Check your current status\n` +
    `*RESTART* — Start fresh\n` +
    `*STOP* — Unsubscribe\n` +
    `*HELP* — Show this list`
  );
}

async function sendStatus(phone) {
  const user = await getUser(phone);
  if (!user) return sendText(phone, `No active session. Send "hi" to get started!`);

  const pickup = user.pickup_label || user.departure_airport || 'Not set';
  const drop   = user.drop_label   || user.drop_zone          || 'Not set';

  return sendText(phone,
    `*Your Status*\n\n` +
    `👤 Name: ${user.name || 'Not set'}\n` +
    `🧬 Gender: ${genderLabel(user.gender)}\n` +
    `🤝 Prefers: ${prefLabel(user.preferred_gender)}\n` +
    `📍 Pickup: ${pickup}\n` +
    `🎯 Drop: ${drop}\n` +
    `🔄 State: ${user.state}\n` +
    `✅ Active: ${user.is_active ? 'Yes' : 'No'}\n` +
    `💑 Matched: ${user.is_matched ? 'Yes' : 'No'}`
  );
}

// ── LLM intent dispatcher ─────────────────────────────────────────────────────
// Called from the default case when raw text doesn't match any known command.
// Maps LLM action strings → existing handler functions.

async function handleLLMIntent(intent, phone, user, waName, state) {
  const { action, followup } = intent;

  switch (action) {

    case 'MATCHES': {
      const freshUser = await getUser(phone);
      const matches   = await findMatches(freshUser);
      return sendMatchResults(freshUser, matches);
    }

    case 'CANCEL': {
      if (state === 'MATCHED')     return initiateCancelAfterMatch(phone, user);
      if (state === 'MATCH_SENT')  return handleCancelSentRequest(phone, user);
      return handleCancelInWaiting(phone, user);
    }

    case 'EDIT_PICKUP': {
      // Cancel any pending outbound requests before switching to edit mode
      await cancelPendingRequestsFrom(user);
      await setState(phone, 'POOL_EDIT_PICKUP');
      return sendText(phone,
        `Share your new *pickup location* 📍\n\n` +
        `• Tap 📎 → Location → search or use current location\n` +
        `• Or paste a Google Maps / Apple Maps link\n` +
        `• Or type coordinates: *17.2403, 78.4294*`
      );
    }

    case 'EDIT_DROP': {
      await cancelPendingRequestsFrom(user);
      await setState(phone, 'POOL_EDIT_DROP');
      return sendText(phone,
        `Share your new *drop destination* 📍\n\n` +
        `• Tap 📎 → Location → search any city\n` +
        `• Or paste a Google Maps / Apple Maps link\n` +
        `• Or type coordinates: *28.6139, 77.2090*`
      );
    }

    case 'STATUS':  return sendStatus(phone);
    case 'HELP':    return sendHelp(phone);

    case 'START':   return startOrResume(phone, user, waName, false);
    case 'RESTART': return startOrResume(phone, user, waName, true);

    case 'TRIP_DONE':    return handleTripDone(phone, user);
    case 'REPORT_ISSUE': return sendIssueMenu(phone);

    case 'EXTEND_YES': {
      const extended = await setState(phone, 'WAITING', {
        is_active:  true,
        expires_at: new Date(Date.now() + RETRY_WINDOW_MS).toISOString(),
      });
      const matches = await findMatches(extended);
      if (matches.length) return sendMatchResults(extended, matches);
      return sendText(phone, `Still looking! ⏳ I'll alert you the moment a match appears nearby.`);
    }

    case 'EXTEND_NO': {
      await setState(phone, 'IDLE', { is_active: false });
      return sendText(phone, `No problem! Send *hi* whenever you're ready to search again. ✈️`);
    }

    // ACCEPT / DECLINE require a specific user ID — can't resolve from plain text alone.
    // Prompt them to use the button in the original request message.
    case 'ACCEPT':
    case 'DECLINE':
      return sendText(phone, `Please use the *Accept* / *Decline* buttons in the request message above.`);

    default: {
      // LLM returned UNKNOWN (off-topic, greeting, etc.) or unrecognised action.
      // If the model supplied a followup hint, send it; otherwise generic nudge.
      if (followup) return sendText(phone, followup);
      return sendText(phone, `Not sure what you mean. Type *HELP* to see available commands.`);
    }
  }
}

module.exports = { handleMessage };
