const supabase = require('../config/supabase');
const { sendText, sendButtons, sendList, sendLocationRequest, sendCTAButton } = require('../services/whatsapp');
const { logError } = require('../utils/errorLogger');
// Payment disabled — import kept for future use
// const { createVerificationPaymentLink } = require('../services/razorpay');
const { getDistanceKm, detectAirport } = require('../utils/haversine');

// WhatsApp number for share links (actual phone number, not PHONE_NUMBER_ID)
const WA_NUMBER   = process.env.WHATSAPP_NUMBER || '';
const WEBSITE_URL = process.env.SERVER_URL      || '';
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
const FREE_TEXT_STATES = new Set(['ONBOARDING_NAME', 'EDITING_NAME', 'RATING_FEEDBACK', 'PROFILE_EDIT_NAME', 'USER_FEEDBACK', 'ONBOARDING_REFERRAL', 'REWARD_TICKET', 'REWARD_UPI']);

// Exact-match keywords (UPPERCASED) that the state switch already handles directly.
// Text matching these goes straight to the switch — no LLM needed.
const HARD_KEYWORDS = new Set([
  'MATCHES', 'CANCEL', 'EDIT', 'DONE', 'ISSUE', 'BLOCK',
  'CONFIRM CANCEL', 'BACK', 'SKIP',
  'MY CODE', 'MYCODE', 'CLAIM',
  'DELETE', 'DELETE ACCOUNT', 'CONFIRM DELETE',
]);

// LLM actions that can cause irreversible state changes.
// When LLM classifies one of these from NATURAL LANGUAGE (not a hard button),
// we ask the user to explicitly confirm before executing.
const DESTRUCTIVE_ACTIONS = new Set(['CANCEL', 'TRIP_DONE', 'REPORT_ISSUE']);

// ── helpers ───────────────────────────────────────────────────────────────────

// Payment disabled — always returns true so no gates fire
function isSubscriptionActive(_user) {
  return true;
}

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
    if (parsed) return parsed.appleShortLink ? parsed : { ...parsed, fromText: true };
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
  if (loc?.appleShortLink) return 'APPLE_SHORT_LINK'; // caller shows specific message
  if (loc?.lat !== undefined) return loc; // direct coordinates found

  // ── 3. Free-text place name → forward geocode ──
  // Use extracted place name from Maps URL if available; otherwise use rawText.
  // Skip entirely when rawText is a URL we already tried (and failed) to resolve.
  const geocodeQuery = loc?.placeName                              // extracted from Maps link
    || (msgType === 'text' && !rawText.startsWith('http') && rawText.length >= 3 ? rawText : null);

  if (geocodeQuery) {
    let hits = [];
    try {
      hits = await forwardGeocode(geocodeQuery, 5);
    } catch (e) {
      // Geocoding error (timeout, API issue) — treat as 0 results so caller re-prompts
      console.error('resolveOrSearch geocoding error:', e.message);
    }
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
        `📍 Found *${hits.length}* result${hits.length > 1 ? 's' : ''} for "*${geocodeQuery.slice(0, 40)}*":\n\nSelect the correct location, or share a 📎 pin directly.`,
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
  const websiteLine = WEBSITE_URL ? `\n🌐 Learn more: ${WEBSITE_URL}\n` : '';
  const intro =
    `🚕 *Welcome to AasPass!*\n\n` +
    `We're building *Hyderabad's first* community of airport cab-splitters.\n\n` +
    `The idea is simple — when you land at RGIA, find someone heading the same way. ` +
    `Split the cab, save ₹300-700+ every trip. No app needed — everything on WhatsApp.\n` +
    `${websiteLine}\n` +
    `🌱 *Our community is brand new and growing.* The more people join, the faster everyone finds a match. ` +
    `We need your help to spread the word — more details once you're set up!\n\n` +
    `You're one of our *early members* 🎉 What should we call you?`;

  if (waName) {
    const displayName = truncate(waName, 20);
    await sendButtons(phone, intro, [
      { id: 'USE_WA_NAME', title: displayName      },
      { id: 'ENTER_NAME',  title: '✏️ Type my name' },
    ]);
  } else {
    await sendText(phone, `${intro}\n\nReply with your *first name* to get started.`);
  }
  await setState(phone, 'ONBOARDING_NAME');
}

async function sendGenderPrompt(phone) {
  await sendList(
    phone,
    `Nice to meet you! 👋\n\nOne quick question — what's your gender?\n\n_This helps us show you compatible matches and keep rides comfortable for everyone._`,
    'Select Gender',
    [{
      title: 'Gender',
      rows: [
        { id: 'GENDER_M',  title: '👨 Male',              description: '' },
        { id: 'GENDER_F',  title: '👩 Female',            description: '' },
        { id: 'GENDER_NB', title: '🏳️ Non-binary',       description: '' },
        { id: 'GENDER_NS', title: '🤐 Prefer not to say', description: 'Will match with anyone' },
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

async function sendPreferredGenderPromptForProfileEdit(phone) {
  await sendButtons(
    phone,
    `Who would you prefer to share a cab with?`,
    [
      { id: 'PREF_ANY', title: '🤝 Anyone'     },
      { id: 'PREF_F',   title: '👩 Only Female' },
      { id: 'PREF_M',   title: '👨 Only Male'   },
    ]
  );
  await setState(phone, 'PROFILE_EDIT_PREF');
}

// ── share nudge ───────────────────────────────────────────────────────────────

async function sendShareNudge(phone) {
  const number = WA_NUMBER ? String(WA_NUMBER).trim().replace(/\D/g, '') : null;
  if (!number) return;
  const link = `https://wa.me/${number}`;

  const user = await getUser(phone);
  const code = user?.referral_code || null;

  await sendText(phone,
    `🤝 *Enjoyed saving on your cab? Help others do the same!*\n\n` +
    `The bigger the community, the faster everyone finds a match.\n\n` +
    (code ? `💰 *Bonus:* When someone joins using your code *${code}*, you earn *₹50* automatically!\n\n` : '') +
    `👇 *Long press the next message → tap Forward:*`
  );

  await sendText(phone,
    `🚕 *Tired of paying full cab fare from the airport alone?*\n\n` +
    `AasPass matches you with someone heading the same way — share one cab, split the fare.\n\n` +
    `✅ No app download needed\n` +
    `✅ Works at Hyderabad airport (RGIA)\n` +
    `✅ Everything on WhatsApp\n` +
    (code ? `✅ Use code *${code}* and get *₹100* on first search!\n` : '') +
    `\nSend *Hi* to get started 👇\n${link}`
  );
}

// Clean up raw geocode labels — removes admin terms that leak into user-facing text
function cleanLocationLabel(label) {
  if (!label) return label;
  return label
    .replace(/\s*(mandal|district|taluk|tehsil|block|division|zone)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── other-city message ────────────────────────────────────────────────────────

async function sendOtherCityMessage(phone, cityName, user) {
  const link = WA_NUMBER ? `https://wa.me/${WA_NUMBER}` : 'wa.me/AasPassNumber';
  const name = user?.name ? `, *${user.name}*` : '';
  await sendText(
    phone,
    `👋 Hey${name}!\n\n` +
    `AasPass is currently live only in *Hyderabad* (RGIA) 🌱\n\n` +
    `We're expanding to *${cityName}* very soon — we'll notify you the moment we launch there!\n\n` +
    `📢 Meanwhile, if you know anyone who flies from Hyderabad, share AasPass with them — it's completely free:\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `_AasPass 🚕 — Split airport cabs for free in Hyderabad. No app needed, just WhatsApp:_\n` +
    `*${link}*\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `Thank you for your support! We'll be in your city soon 🙏`
  );
}

// ── onboarding: location ─────────────────────────────────────────────────────

async function sendPickupPrompt(phone, isReturning = false) {
  const prefix = isReturning
    ? `Welcome back! 🚕 Let's find you a match.\n\n`
    : `Perfect! Almost there — just 2 quick steps.\n\n`;
  await sendLocationRequest(
    phone,
    `${prefix}*Step 1 of 2* — Share your *pickup location* 📍\n\n` +
    `Tap the 📎 button → Location, or type coordinates e.g. 17.4239, 78.4738`
  );
  await setState(phone, 'ONBOARDING_PICKUP');
}

async function sendDropPrompt(phone, pickupLabel) {
  await sendLocationRequest(
    phone,
    `📍 *Pickup:* ${pickupLabel}\n\n*Step 2 of 2* — Where should we drop you? 🎯\n\nTap the button to pick your destination, or type coordinates e.g. 17.4239, 78.4738`
  );
  await setState(phone, 'ONBOARDING_DROP');
}

// ── welcome back screen ───────────────────────────────────────────────────────

async function sendWelcomeBack(phone, user) {
  await sendButtons(
    phone,
    `Welcome back, *${user.name}*! 🚕\n\nWhat would you like to do?`,
    [
      { id: 'FIND_PARTNER', title: '🔍 Find a Partner' },
      { id: 'VIEW_PROFILE', title: '👤 My Profile'     },
    ]
  );
  await setState(phone, 'HOME');
}

// ── profile view ──────────────────────────────────────────────────────────────

async function sendProfileView(phone, user) {
  await sendButtons(
    phone,
    `*Your Profile* 👤\n\n` +
    `👤 Name: ${user.name || 'Not set'}\n` +
    `🧬 Gender: ${genderLabel(user.gender)}\n` +
    `🤝 Prefers: ${prefLabel(user.preferred_gender)}`,
    [
      { id: 'EDIT_PROFILE', title: '✏️ Edit Profile' },
      { id: 'BACK_TO_HOME', title: '⬅️ Back'         },
    ]
  );
  await setState(phone, 'PROFILE_VIEW');
}

// ── profile edit menu (name/gender/pref only — no locations) ─────────────────

async function sendEditProfileMenu(phone) {
  await sendList(
    phone,
    `Which detail would you like to update?`,
    'Choose Field',
    [{
      title: 'Edit Profile',
      rows: [
        { id: 'PEDIT_NAME',   title: '👤 Name',             description: 'Change your display name'   },
        { id: 'PEDIT_GENDER', title: '🧬 Gender',           description: 'Update your gender'          },
        { id: 'PEDIT_PREF',   title: '🤝 Match preference', description: 'Who you want to share with'  },
      ],
    }]
  );
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

// ── referral & reward helpers ─────────────────────────────────────────────────

const DAILY_REWARD_CAP = 10;

async function generateReferralCode(name) {
  const letters = (name || 'USR').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 3).padEnd(3, 'X');
  for (let i = 0; i < 5; i++) {
    const digits = String(Math.floor(1000 + Math.random() * 9000));
    const code = letters + digits;
    const { data } = await supabase.from('users').select('user_id').eq('referral_code', code).maybeSingle();
    if (!data) return code;
  }
  return letters + String(Math.floor(10000 + Math.random() * 90000));
}

async function sendReferralPrompt(phone) {
  await sendButtons(
    phone,
    `🎁 *Were you invited by a friend?*\n\nEnter their referral code to get ₹100 on your first cab search — or tap Skip to continue.`,
    [{ id: 'SKIP_REFERRAL', title: '⏭️ Skip' }]
  );
}

async function sendMyReferralCode(phone, user) {
  if (!user) return sendText(phone, `Please send *Hi* to get started first!`);
  let code = user.referral_code;
  if (!code) {
    code = await generateReferralCode(user.name || 'USR');
    await upsertUser(phone, { referral_code: code });
  }
  const number = WA_NUMBER ? String(WA_NUMBER).trim().replace(/\D/g, '') : '';
  const link   = number ? `https://wa.me/${number}` : '';
  await sendText(phone,
    `🎟️ *Your Referral Code: ${code}*\n\n` +
    `Share this with friends who fly from Hyderabad airport.\n` +
    `When they join and claim their first reward, *you get ₹50!*\n\n` +
    `👇 *Long press the next message → Forward:*`
  );
  await sendText(phone,
    `Hey! I use AasPass to split airport cabs in Hyderabad — saves ₹400 every trip 🚕\n\n` +
    `Join with my code *${code}* and get *₹100* on your first cab search at RGIA — whether you find a match or not! 💰\n\n` +
    `Send *Hi* to get started 👇\n` +
    `${link}`
  );
}

async function sendReferralInfo(phone, user) {
  let code = user?.referral_code;
  if (!code && user) {
    code = await generateReferralCode(user.name || 'USR');
    await upsertUser(phone, { referral_code: code });
  }

  const codeSection = code
    ? `\n\n🎟️ *Your referral code: ${code}*\nShare this with friends. Type *MY CODE* to get a ready-to-forward invite message.`
    : `\n\nType *MY CODE* to get your referral code and a ready-to-forward invite message.`;

  return sendText(phone,
    `*AasPass Referral Program* 🎁\n\n` +
    `*How to refer:*\n` +
    `1. Share your referral code with a friend who flies from RGIA\n` +
    `2. They join AasPass and enter your code during signup\n` +
    `3. They get *₹100* on their first cab search — win or not!\n` +
    `4. Once they claim their reward, *you earn ₹50* 💰\n\n` +
    `*How rewards are paid:*\n` +
    `• We transfer directly to your UPI ID\n` +
    `• Payouts processed within 24 hours of verification\n\n` +
    `*Already waiting at the airport?* Type *CLAIM* to claim your own ₹100 reward if no match was found.` +
    codeSection
  );
}

async function getDailyClaimCount() {
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase
    .from('daily_reward_claims').select('airport_claims').eq('claim_date', today).maybeSingle();
  return data?.airport_claims || 0;
}

async function incrementDailyClaimCount() {
  const today   = new Date().toISOString().split('T')[0];
  const current = await getDailyClaimCount();
  await supabase.from('daily_reward_claims').upsert(
    { claim_date: today, airport_claims: current + 1, updated_at: new Date().toISOString() },
    { onConflict: 'claim_date' }
  );
}

async function handleRewardClaimStart(phone, user) {
  if (!user) return sendText(phone, `Please send *Hi* to get started first!`);
  const validStates = new Set(['WAITING', 'WAITING_RETRY', 'MATCH_SENT', 'MATCH_RECEIVED']);
  if (!validStates.has(user.state)) {
    return sendText(phone,
      `To claim ₹100, first search for a cab from RGIA airport.\n\n` +
      `Send *Hi* to start your search! 🚕`
    );
  }
  if (user.last_reward_claimed_at) {
    const daysSince = (Date.now() - new Date(user.last_reward_claimed_at)) / (1000 * 60 * 60 * 24);
    if (daysSince < 30) {
      const daysLeft = Math.ceil(30 - daysSince);
      return sendText(phone,
        `You claimed your reward recently 🙏\n\n` +
        `Next claim available in *${daysLeft} day${daysLeft !== 1 ? 's' : ''}*.`
      );
    }
  }
  const count = await getDailyClaimCount();
  if (count >= DAILY_REWARD_CAP) {
    return sendText(phone,
      `Today's reward slots are full 😢\n\n` +
      `We have ${DAILY_REWARD_CAP} slots/day — this number will grow as our community does! 😄\n\n` +
      `Try again tomorrow — slots reset at midnight.`
    );
  }
  await setState(phone, 'REWARD_TICKET');
  return sendButtons(phone,
    `🎉 *You're eligible for ₹100 off your cab!*\n\n` +
    `*Last step:* Send a photo of your flight ticket for validation 📸\n\n` +
    `_Reward will be processed within 24 hours via UPI._`,
    [{ id: 'SKIP_CLAIM', title: '❌ Cancel' }]
  );
}

async function triggerReferralBonus(referredPhone, referralCode, referredName) {
  try {
    const { data: referrer } = await supabase
      .from('users').select('*').eq('referral_code', referralCode).single();
    if (!referrer) return;
    await supabase.from('reward_claims').insert({
      phone:           referrer.phone,
      referred_by:     referredPhone,
      claim_type:      'referral_bonus',
      amount:          50,
      ticket_received: true,
      upi_id:          referrer.reward_upi || null,
      status:          'pending',
      created_at:      new Date().toISOString(),
    });
    const upiLine = referrer.reward_upi
      ? `We'll send it to *${referrer.reward_upi}* within 24 hours. 💰`
      : `Reply with *UPI yourname@bank* to receive it!\n_(e.g., UPI raj@paytm)_`;
    await sendText(referrer.phone,
      `🎉 *Referral bonus earned, ${referrer.name || 'friend'}!*\n\n` +
      `*${referredName || 'Someone'}* you referred just completed their first cab search at RGIA! 🚕\n\n` +
      `You've earned *₹50* as a thank you bonus.\n\n` +
      upiLine
    );
  } catch (e) {
    console.error('triggerReferralBonus error:', e.message);
  }
}

async function sendNoMatchRewardOffer(phone, user) {
  if (user.last_reward_claimed_at) {
    const daysSince = (Date.now() - new Date(user.last_reward_claimed_at)) / (1000 * 60 * 60 * 24);
    if (daysSince < 30) return; // already claimed recently — don't show offer
  }
  const count = await getDailyClaimCount();
  if (count >= DAILY_REWARD_CAP) return; // slots full — don't tease
  await sendText(phone,
    `💡 *No match yet — but you won't go empty-handed!*\n\n` +
    `As an early community member: type *CLAIM* to get *₹100 off your cab* via UPI — even without a match! 🎁\n\n` +
    `_Valid once per 30 days. First ${DAILY_REWARD_CAP} claims per day only._`
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
  if (text === 'HELP')     return sendHelp(phone);
  if (text === 'STATUS')   return sendStatus(phone);
  if (text === 'FEEDBACK') return sendFeedbackPrompt(phone);

  const user  = await getUser(phone);
  const state = user?.state || 'IDLE';

  // Restart — always fresh start
  if (text === 'RESTART' || text === 'START') return startOrResume(phone, user, waName, true);
  if (text === 'HI' || text === '' && state === 'IDLE') return startOrResume(phone, user, waName, false);

  // ── Referral & reward global commands ────────────────────────────────────
  if (text === 'MY CODE' || text === 'MYCODE') return sendMyReferralCode(phone, user);
  if (text === 'CLAIM')                         return handleRewardClaimStart(phone, user);
  // UPI capture from any state (for referral bonus recipients)
  if (rawText.toUpperCase().startsWith('UPI ') && state !== 'REWARD_UPI') {
    const upiId = rawText.slice(4).trim();
    if (upiId.length >= 3) {
      await upsertUser(phone, { reward_upi: upiId });
      await supabase.from('reward_claims')
        .update({ upi_id: upiId })
        .eq('phone', phone).eq('status', 'pending');
      return sendText(phone,
        `✅ UPI saved: *${upiId}*\n\nWe'll process your reward within 24 hours. 🙏`
      );
    }
  }

  // ── Account delete commands ───────────────────────────────────────────────
  if (text === 'DELETE' || text === 'DELETE ACCOUNT' || text === 'CONFIRM DELETE') {
    return sendDeleteConfirmation(phone);
  }
  if (buttonId === 'CONFIRM_DELETE') {
    const deleteUser = await getUser(phone);
    return handleAccountDelete(phone, deleteUser);
  }
  if (buttonId === 'CANCEL_DELETE') {
    return sendText(phone, `No problem! Your account is safe. 👍`);
  }

  // ── LLM destructive action confirmation ──────────────────────────────────
  // Handles Yes/No taps on confirmation buttons that were sent when the LLM
  // classified a destructive action (CANCEL, TRIP_DONE, REPORT_ISSUE).
  // These button IDs are only ever produced by sendConfirmationPrompt() below,
  // so they're safe to intercept globally before the state switch.
  if (buttonId === 'CONFIRM_LLM_YES' || buttonId === 'CONFIRM_LLM_NO') {
    const pendingAction = user?.pending_llm_action;
    // Clear the pending action regardless of what the user chose
    await upsertUser(phone, { pending_llm_action: null });

    if (buttonId === 'CONFIRM_LLM_NO' || !pendingAction) {
      return sendText(phone, `No problem! Continuing as before. 👍`);
    }
    // Execute the confirmed action
    console.log(`✅ Confirmed LLM action ${pendingAction} for ${phone}`);
    return handleLLMIntent({ action: pendingAction, followup: null }, phone, user, waName, state);
  }

  // ── Queue conflict buttons ────────────────────────────────────────────────
  // Shown when user says "hi" while already in an active search state.
  if (buttonId === 'QUEUE_EDIT') {
    return sendPoolEditMenu(phone);
  }
  if (buttonId === 'QUEUE_START_NEW') {
    await resetForNewSearch(phone, user);
    return sendPickupPrompt(phone, true);
  }

  // ── Profile / home buttons ────────────────────────────────────────────────
  if (buttonId === 'FIND_PARTNER') {
    return sendPickupPrompt(phone, true);
  }
  if (buttonId === 'VIEW_PROFILE') {
    return sendProfileView(phone, user);
  }
  if (buttonId === 'EDIT_PROFILE') {
    await sendEditProfileMenu(phone);
    return setState(phone, 'PROFILE_VIEW');
  }
  if (buttonId === 'BACK_TO_HOME') {
    return sendWelcomeBack(phone, user);
  }

  // ── Universal LLM gate ────────────────────────────────────────────────────
  // Fires for EVERY text message that isn't:
  //   • A hard keyword the switch already handles (CANCEL, MATCHES, DONE…)
  //   • A location state (geocoding runs first; LLM fires as fallback inside the case)
  //   • A free-text capture state (ONBOARDING_NAME, RATING_FEEDBACK…)
  //
  // Destructive LLM actions (CANCEL, TRIP_DONE, REPORT_ISSUE) are confirmed
  // before execution. Non-destructive actions execute immediately.
  // UNKNOWN → fall through to the state switch for a context-specific hint.
  if (msgType === 'text' && rawText.length > 0
      && !LOCATION_STATES.has(state)
      && !FREE_TEXT_STATES.has(state)
      && !HARD_KEYWORDS.has(text)) {
    const intent = await detectIntent(rawText, state);
    console.log(`🤖 LLM [${state}] "${rawText}" → ${intent.action}`);

    if (intent.action !== 'UNKNOWN') {
      if (DESTRUCTIVE_ACTIONS.has(intent.action)) {
        // Store action and ask user to confirm before executing
        return sendConfirmationPrompt(phone, intent.action, user);
      }
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
      const gender = genderMap[listId] || 'NS';
      await upsertUser(phone, { gender, preferred_gender: 'ANY', updated_at: new Date().toISOString() });
      // Generate referral code if not already set
      if (!user?.referral_code) {
        const freshUser = await getUser(phone);
        const code = await generateReferralCode(freshUser?.name || 'USR');
        await upsertUser(phone, { referral_code: code });
      }
      // Ask if they were referred before starting cab search
      await setState(phone, 'ONBOARDING_REFERRAL');
      return sendReferralPrompt(phone);
    }

    // ── ONBOARDING: PREFERRED GENDER ─────────────────────────────────────────
    case 'ONBOARDING_PREFERRED_GENDER': {
      const prefMap = { PREF_ANY: 'ANY', PREF_M: 'M', PREF_F: 'F' };
      const preferred_gender = prefMap[buttonId] || 'ANY';
      await upsertUser(phone, { preferred_gender, updated_at: new Date().toISOString() });
      await setState(phone, 'ONBOARDING_PICKUP');
      return sendPickupPrompt(phone, false);
    }

    // ── ONBOARDING: REFERRAL CODE ─────────────────────────────────────────────
    case 'ONBOARDING_REFERRAL': {
      if (buttonId === 'SKIP_REFERRAL' || text === 'SKIP') {
        await setState(phone, 'ONBOARDING_PICKUP');
        return sendPickupPrompt(phone, false);
      }
      const code = rawText.trim().toUpperCase();
      if (code.length >= 4) {
        // Don't allow self-referral
        if (code === user?.referral_code) {
          await sendText(phone, `That's your own code! 😄 Enter a friend's code or tap Skip.`);
          return sendReferralPrompt(phone);
        }
        const { data: referrer } = await supabase
          .from('users').select('user_id, name').eq('referral_code', code).maybeSingle();
        if (referrer) {
          await upsertUser(phone, { referred_by: code });
          await sendText(phone,
            `🎉 You were invited by *${referrer.name || 'a friend'}*!\n\n` +
            `You'll get *₹100* on your first cab search at RGIA — whether you find a match or not! 💰`
          );
        } else {
          await sendText(phone, `Hmm, that code doesn't seem right. No worries — continuing without it!`);
        }
      }
      await setState(phone, 'ONBOARDING_PICKUP');
      return sendPickupPrompt(phone, false);
    }

    // ── ONBOARDING: PICKUP LOCATION ───────────────────────────────────────────
    case 'ONBOARDING_PICKUP': {
      const loc = await resolveOrSearch(phone, msgType, locationLat, locationLon, rawText, listId);
      if (loc === 'SEARCHING') return;
      if (loc === 'APPLE_SHORT_LINK') return sendText(phone,
        `Apple Maps short links can't be read from our servers 😕\n\n` +
        `Please share your location using one of these instead:\n` +
        `• 📍 Tap 📎 → Location → share pin *(easiest)*\n` +
        `• 🔗 Open Apple Maps → Share → *Copy Link* (use the full maps.apple.com link)\n` +
        `• 🔢 Or type coordinates e.g. 17.4239, 78.4738`
      );
      if (!loc) {
        if (msgType === 'text' && rawText.length > 0) {
          const intent = await detectIntent(rawText, state);
          console.log(`🤖 LLM [${state}] "${rawText}" → ${intent.action}`);
          if (intent.action !== 'UNKNOWN') return handleLLMIntent(intent, phone, user, waName, state);
          if (intent.followup) return sendText(phone, intent.followup);
        }
        return sendLocationRequest(phone, `Couldn't find that location 😕\n\nShare your *pickup location* using the button below, or type coordinates e.g. 17.4239, 78.4738`);
      }

      // ── Other-city soft block ──────────────────────────────────────────────
      // If user is near BLR or DEL, tell them we're Hyderabad-only for now.
      // They stay in ONBOARDING_PICKUP so they can share a different location.
      const detectedAirport = detectAirport(loc.lat, loc.lon, 5); // 5km radius
      if (detectedAirport && detectedAirport.code !== 'HYD') {
        const cityNames = { BLR: 'Bangalore', DEL: 'Delhi' };
        const cityName  = cityNames[detectedAirport.code] || detectedAirport.name;
        await sendOtherCityMessage(phone, cityName, user);
        return; // stay in ONBOARDING_PICKUP — let them try again or leave
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
      if (loc === 'APPLE_SHORT_LINK') return sendText(phone,
        `Apple Maps short links can't be read from our servers 😕\n\nPlease share a 📍 pin (tap 📎 → Location), or type coordinates e.g. 17.4239, 78.4738`
      );
      if (!loc) {
        if (msgType === 'text' && rawText.length > 0) {
          const intent = await detectIntent(rawText, state);
          console.log(`🤖 LLM [${state}] "${rawText}" → ${intent.action}`);
          if (intent.action !== 'UNKNOWN') return handleLLMIntent(intent, phone, user, waName, state);
          if (intent.followup) return sendText(phone, intent.followup);
        }
        return sendLocationRequest(phone, `Couldn't find that location 😕\n\nShare your *drop destination* using the button below, or type coordinates e.g. 17.4239, 78.4738`);
      }
      const drop_label = cleanLocationLabel(await reverseGeocode(loc.lat, loc.lon));

      // Skip confirmation screen — go straight into the pool
      await syncProfileFields(phone, user);
      const now = new Date().toISOString();
      const activeUser = await upsertUser(phone, {
        drop_lat:          loc.lat,
        drop_long:         loc.lon,
        drop_label,
        drop_zone:         drop_label,
        state:             'WAITING',
        is_active:         true,
        is_matched:        false,
        search_started_at: now,
        expires_at:        new Date(Date.now() + SEARCH_WINDOW_MS).toISOString(),
        updated_at:        now,
      });

      await sendText(phone,
        `✅ *You're in!* Searching for a cab-split partner near *${drop_label}*... 🔍\n\n` +
        `I'll ping you the moment someone nearby joins.\n\n` +
        `Type *EDIT* to update your trip or *CANCEL* to leave the pool.`
      );

      // Match search only — nudge is sent after trip completion, not while user is searching
      const matches = await findMatches(activeUser);
      await sendMatchResults(activeUser, matches);
      await notifyWaitingUsers(activeUser, matches);
      // Offer ₹100 reward if no match found and user is eligible
      if (matches.length === 0) sendNoMatchRewardOffer(phone, activeUser).catch(() => {});
      return;
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
        return sendLocationRequest(phone, `Where's your new drop destination? 🎯\n\nTap the button to search or share a pin, or type coordinates e.g. 17.4239, 78.4738`);
      }

      if (buttonId === 'CONFIRM_NO')   return startOrResume(phone, user, waName, true);
      if (buttonId === 'EDIT_DETAILS') return sendEditMenu(phone);
      if (buttonId !== 'CONFIRM_YES')  return sendConfirmation(phone, user);

      await syncProfileFields(phone, user);

      const now = new Date().toISOString();
      const activeUser = await setState(phone, 'WAITING', {
        is_active:         true,
        is_matched:        false,
        search_started_at: now,
        expires_at:        new Date(Date.now() + SEARCH_WINDOW_MS).toISOString(),
      });
      await sendText(phone, `✅ *You're in!* Searching for a cab-split partner near you... 🔍`);
      const matches = await findMatches(activeUser);
      await sendMatchResults(activeUser, matches);
      await notifyWaitingUsers(activeUser, matches);
      if (matches.length === 0) sendNoMatchRewardOffer(phone, activeUser).catch(() => {});
      return;
    }

    // ── PAYMENT PENDING ───────────────────────────────────────────────────────
    // Payment disabled — move users stuck in this state straight to pickup.
    case 'PAYMENT_PENDING': {
      await setState(phone, 'ONBOARDING_PICKUP');
      return sendPickupPrompt(phone, false);
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
      if (loc === 'APPLE_SHORT_LINK') return sendText(phone,
        `Apple Maps short links can't be read from our servers 😕\n\nPlease share a 📍 pin (tap 📎 → Location), or type coordinates e.g. 17.4239, 78.4738`
      );
      if (!loc) {
        if (msgType === 'text' && rawText.length > 0) {
          const intent = await detectIntent(rawText, state);
          console.log(`🤖 LLM [${state}] "${rawText}" → ${intent.action}`);
          if (intent.action !== 'UNKNOWN') return handleLLMIntent(intent, phone, user, waName, state);
        }
        return sendLocationRequest(phone, `Couldn't find that location 😕\n\nShare your *pickup location* using the button below, or type coordinates e.g. 17.4239, 78.4738`);
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
      if (loc === 'APPLE_SHORT_LINK') return sendText(phone,
        `Apple Maps short links can't be read from our servers 😕\n\nPlease share a 📍 pin (tap 📎 → Location), or type coordinates e.g. 17.4239, 78.4738`
      );
      if (!loc) {
        if (msgType === 'text' && rawText.length > 0) {
          const intent = await detectIntent(rawText, state);
          console.log(`🤖 LLM [${state}] "${rawText}" → ${intent.action}`);
          if (intent.action !== 'UNKNOWN') return handleLLMIntent(intent, phone, user, waName, state);
        }
        return sendLocationRequest(phone, `Share your new *drop destination* 🎯\n\nTap the button to search or share a pin, or type coordinates e.g. 17.4239, 78.4738`);
      }
      const drop_label = cleanLocationLabel(await reverseGeocode(loc.lat, loc.lon));
      const updated = await setState(phone, 'ONBOARDING_CONFIRM', {
        drop_lat: loc.lat, drop_long: loc.lon, drop_label, drop_zone: drop_label,
      });
      return sendConfirmation(phone, updated);
    }

    // ── POOL EDIT: PICKUP (while in WAITING pool) ─────────────────────────────
    case 'POOL_EDIT_PICKUP': {
      const loc = await resolveOrSearch(phone, msgType, locationLat, locationLon, rawText, listId);
      if (loc === 'SEARCHING') return;
      if (loc === 'APPLE_SHORT_LINK') return sendText(phone,
        `Apple Maps short links can't be read from our servers 😕\n\nPlease share a 📍 pin (tap 📎 → Location), or type coordinates e.g. 17.4239, 78.4738`
      );
      if (!loc) {
        if (msgType === 'text' && rawText.length > 0) {
          const intent = await detectIntent(rawText, state);
          console.log(`🤖 LLM [${state}] "${rawText}" → ${intent.action}`);
          if (intent.action !== 'UNKNOWN') return handleLLMIntent(intent, phone, user, waName, state);
          if (intent.followup) return sendText(phone, intent.followup);
        }
        return sendLocationRequest(phone, `Couldn't find that location 😕\n\nShare your *pickup location* using the button below, or type coordinates e.g. 17.4239, 78.4738`);
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
      if (loc === 'APPLE_SHORT_LINK') return sendText(phone,
        `Apple Maps short links can't be read from our servers 😕\n\nPlease share a 📍 pin (tap 📎 → Location), or type coordinates e.g. 17.4239, 78.4738`
      );
      if (!loc) {
        if (msgType === 'text' && rawText.length > 0) {
          const intent = await detectIntent(rawText, state);
          console.log(`🤖 LLM [${state}] "${rawText}" → ${intent.action}`);
          if (intent.action !== 'UNKNOWN') return handleLLMIntent(intent, phone, user, waName, state);
          if (intent.followup) return sendText(phone, intent.followup);
        }
        return sendLocationRequest(phone, `Couldn't find that location 😕\n\nShare your *drop destination* using the button below, or type coordinates e.g. 17.4239, 78.4738`);
      }
      const drop_label = cleanLocationLabel(await reverseGeocode(loc.lat, loc.lon));
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
        return sendLocationRequest(phone, `Where's your new drop destination? 🎯\n\nTap the button to search or share a pin, or type coordinates e.g. 17.4239, 78.4738`);
      }

      if (listId.startsWith('match_')) {
        return handleMatchRequest(phone, listId.replace('match_', ''), user);
      }
      return sendText(phone, `You're in the pool 🔍 I'll notify you when a match arrives.\n\nType *MATCHES* to check now, *EDIT* to update your trip, or *CANCEL* to withdraw.`);
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
        return sendText(phone, `No problem! Send "hi" whenever you're ready to search again. 🚕`);
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
        return sendLocationRequest(phone, `Where's your new drop destination? 🎯\n\nTap the button to search or share a pin, or type coordinates e.g. 17.4239, 78.4738`);
      }
      return sendText(phone, `Your request is pending ⏳\n\nType *CANCEL* to withdraw, or *EDIT* to update your trip.`);
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
      if (text === 'BACK')   return sendText(phone, `Your match is still active! Safe travels. 🚕`);
      if (text === 'BLOCK')  return handleBlock(phone, user);

      if (buttonId === 'SHARE_CONTACT') return handleShareContact(phone, user);
      if (text === 'DONE' || buttonId === 'TRIP_DONE')  return handleTripDone(phone, user);
      if (text === 'ISSUE' || buttonId === 'TRIP_ISSUE') return sendIssueMenu(phone);

      return sendText(phone, `You're matched! 🎉 Tap *Share Contact* to exchange numbers, *DONE* once your trip is complete, or *CANCEL* to withdraw.`);
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
      const websiteEnd = WEBSITE_URL ? `\n\n🌐 ${WEBSITE_URL}` : '';
      await sendText(phone,
        `All done! 🎉 Thanks for using AasPass.\n\n` +
        `💬 Have suggestions? Type *FEEDBACK* anytime.\n\n` +
        `See you on the next trip! 🚕${websiteEnd}`
      );
      // Send share nudge after trip is complete — user is relaxed and happy, best moment to share
      sendShareNudge(phone).catch(() => {});
    }

    // ── USER_FEEDBACK ─────────────────────────────────────────────────────────
    // User typed FEEDBACK command from any state — we collect their message,
    // save it to support_queue, then restore them to their previous state.
    case 'USER_FEEDBACK': {
      const feedbackText = rawText;
      if (!feedbackText || feedbackText.length < 2) {
        return sendText(phone, `Please type your feedback message and send it. 😊`);
      }
      await supabase.from('support_queue').insert({
        user_id:     user.user_id,
        issue_type:  'USER_FEEDBACK',
        description: feedbackText,
        created_at:  new Date().toISOString(),
        resolved:    false,
      });
      // Restore user to their previous state
      const restoreState = user.pre_feedback_state || 'IDLE';
      await setState(phone, restoreState, { pre_feedback_state: null });
      const websiteLine = WEBSITE_URL ? `\n\n🌐 ${WEBSITE_URL}` : '';
      return sendText(phone,
        `Thank you! 🙏 Your feedback has been noted.\n\n` +
        `We read every message and use it to improve AasPass.${websiteLine}`
      );
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
      const contactUs = WA_NUMBER ? `\n\nIf it's urgent, message us directly: wa.me/${WA_NUMBER}?text=Support` : '';
      return sendText(phone, `We've logged your report: *${category}*.\n\nOur team will review it shortly. Thank you for keeping AasPass safe. 🙏${contactUs}`);
    }

    // ── HOME (welcome back screen) ────────────────────────────────────────────
    case 'HOME': {
      if (buttonId === 'FIND_PARTNER') return sendPickupPrompt(phone, true);
      if (buttonId === 'VIEW_PROFILE') return sendProfileView(phone, user);
      return sendWelcomeBack(phone, user);
    }

    // ── PROFILE_VIEW ──────────────────────────────────────────────────────────
    case 'PROFILE_VIEW': {
      if (buttonId === 'EDIT_PROFILE') {
        await sendEditProfileMenu(phone);
        return; // state stays PROFILE_VIEW while edit menu is shown
      }
      if (buttonId === 'BACK_TO_HOME') return sendWelcomeBack(phone, user);
      // Handle edit selections from the profile edit menu
      if (listId === 'PEDIT_NAME') {
        await sendText(phone, `What name would you like to use? Reply with your *first name*.`);
        return setState(phone, 'PROFILE_EDIT_NAME');
      }
      if (listId === 'PEDIT_GENDER') {
        await setState(phone, 'PROFILE_EDIT_GENDER');
        return sendGenderPrompt(phone);
      }
      if (listId === 'PEDIT_PREF') {
        await setState(phone, 'PROFILE_EDIT_PREF');
        return sendPreferredGenderPromptForProfileEdit(phone);
      }
      return sendProfileView(phone, user);
    }

    // ── PROFILE EDIT: NAME ────────────────────────────────────────────────────
    case 'PROFILE_EDIT_NAME': {
      if (rawText.length < 2 || rawText.length > 30) {
        return sendText(phone, `Name must be between 2 and 30 characters. Try again.`);
      }
      await upsertUser(phone, { name: rawText, updated_at: new Date().toISOString() });
      const updated = await getUser(phone);
      await setState(phone, 'PROFILE_VIEW');
      return sendProfileView(phone, updated);
    }

    // ── PROFILE EDIT: GENDER ──────────────────────────────────────────────────
    case 'PROFILE_EDIT_GENDER': {
      const genderMap = { GENDER_M: 'M', GENDER_F: 'F', GENDER_NB: 'NB', GENDER_NS: 'NS' };
      const gender = genderMap[listId];
      if (!gender) return sendGenderPrompt(phone);
      await upsertUser(phone, { gender, updated_at: new Date().toISOString() });
      const updated = await getUser(phone);
      await setState(phone, 'PROFILE_VIEW');
      return sendProfileView(phone, updated);
    }

    // ── PROFILE EDIT: PREFERRED GENDER ───────────────────────────────────────
    case 'PROFILE_EDIT_PREF': {
      const prefMap = { PREF_ANY: 'ANY', PREF_M: 'M', PREF_F: 'F' };
      const preferred_gender = prefMap[buttonId];
      if (!preferred_gender) return sendPreferredGenderPromptForProfileEdit(phone);
      await upsertUser(phone, { preferred_gender, updated_at: new Date().toISOString() });
      const updated = await getUser(phone);
      await setState(phone, 'PROFILE_VIEW');
      return sendProfileView(phone, updated);
    }

    // ── REWARD_TICKET ─────────────────────────────────────────────────────────
    // Waiting for user to send flight ticket photo to validate ₹100 claim
    case 'REWARD_TICKET': {
      if (buttonId === 'SKIP_CLAIM' || text === 'CANCEL') {
        await setState(phone, 'WAITING');
        return sendText(phone, `No problem! You're still in the search pool. 🚕`);
      }
      if (msgType === 'image') {
        // Final cap check before committing
        const count = await getDailyClaimCount();
        if (count >= DAILY_REWARD_CAP) {
          await setState(phone, 'WAITING');
          return sendText(phone,
            `Sorry, today's reward slots just filled up 😢\n\n` +
            `You're still in the match pool! Try *CLAIM* again tomorrow.`
          );
        }
        await incrementDailyClaimCount();
        const isFirstClaim = !user.last_reward_claimed_at;
        await supabase.from('reward_claims').insert({
          phone,
          referred_by:     user.referred_by || null,
          claim_type:      'airport_reward',
          amount:          100,
          ticket_received: true,
          status:          'pending',
          created_at:      new Date().toISOString(),
        });
        await upsertUser(phone, { last_reward_claimed_at: new Date().toISOString() });
        // Fire referral bonus for referrer on first claim
        if (isFirstClaim && user.referred_by) {
          triggerReferralBonus(phone, user.referred_by, user.name).catch(() => {});
        }
        await setState(phone, 'REWARD_UPI');
        return sendText(phone,
          `✅ *Ticket received!*\n\n` +
          `What's your UPI ID so we can send ₹100?\n\n` +
          `Just type it here:\n` +
          `_(e.g., rajneesh@paytm or 9876543210@upi)_`
        );
      }
      return sendButtons(phone,
        `📸 Please send a *photo of your flight ticket* to claim ₹100.\n\n` +
        `Just screenshot your ticket/boarding pass and send it here.`,
        [{ id: 'SKIP_CLAIM', title: '❌ Cancel' }]
      );
    }

    // ── REWARD_UPI ────────────────────────────────────────────────────────────
    // Capture UPI ID after ticket photo received
    case 'REWARD_UPI': {
      if (!rawText || rawText.length < 3) {
        return sendText(phone,
          `Please type your UPI ID to receive ₹100.\n\n` +
          `_(e.g., rajneesh@paytm or 9876543210@upi)_`
        );
      }
      const upiId = rawText.trim();
      await upsertUser(phone, { reward_upi: upiId });
      await supabase.from('reward_claims')
        .update({ upi_id: upiId })
        .eq('phone', phone).eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1);
      await setState(phone, 'WAITING');
      const freshUser = await getUser(phone);
      const code = freshUser?.referral_code || '';
      await sendText(phone,
        `🎉 *All done, ${user.name || 'friend'}!*\n\n` +
        `We'll UPI *₹100* to *${upiId}* within 24 hours 💰\n\n` +
        `You're still in the search pool — I'll ping you if a match arrives! 🚕\n\n` +
        `─────────────────\n` +
        `💡 *Earn ₹50 more:* Your referral code is *${code}*\n` +
        `When a friend you invite claims their first reward, you get ₹50 automatically!\n\n` +
        `Type *MY CODE* to get your shareable message.`
      );
      return;
    }

    default:
      // Unknown/corrupted state — restart gracefully
      return startOrResume(phone, user, waName, false);
  }
}

// ── Entry point: determine if new or returning user ───────────────────────────

// States where user already has an active search — block a second request
const ACTIVE_SEARCH_STATES = new Set(['WAITING', 'WAITING_RETRY', 'MATCH_SENT', 'MATCH_RECEIVED', 'MATCHED']);

async function sendAlreadyInQueueMsg(phone, user) {
  const pickup = user.pickup_label || 'Not set';
  const drop   = user.drop_label   || 'Not set';

  await sendButtons(
    phone,
    `You're already searching for a cab partner! 🔍\n\n` +
    `📍 *Pickup:* ${pickup}\n` +
    `🎯 *Drop:* ${drop}\n\n` +
    `You can only have one active request at a time.\n` +
    `What would you like to do?`,
    [
      { id: 'QUEUE_EDIT',      title: '✏️ Edit Request' },
      { id: 'QUEUE_START_NEW', title: '🔄 Start New'    },
    ]
  );
}

// Cancel everything and clear the user's active session so they can start fresh
async function resetForNewSearch(phone, user) {
  // Cancel pending requests sent by this user
  await cancelPendingRequestsFrom(user);

  // If matched, notify partner they're back in the pool
  if (user.is_matched && user.matched_with) {
    try {
      const { data: partner } = await supabase.from('users').select('*').eq('user_id', user.matched_with).single();
      if (partner) {
        await setState(partner.phone, 'WAITING', { is_matched: false, matched_with: null });
        await sendText(partner.phone, `Your cab-split partner started a new search. You're back in the pool! 🔄`).catch(() => {});
      }
    } catch (e) {
      console.error('resetForNewSearch partner error:', e.message);
      logError({ severity: 'WARNING', type: 'MATCHING', operation: 'resetForNewSearch_partner', message: e.message, phone, error: e }).catch(() => {});
    }
  }

  // If user received a request they haven't responded to, cancel it and notify sender
  if (user.state === 'MATCH_RECEIVED' && user.pending_request_id) {
    try {
      await supabase.from('match_requests')
        .update({ status: 'cancelled_by_receiver', cancelled_at: new Date().toISOString() })
        .eq('request_id', user.pending_request_id)
        .eq('status', 'pending');

      const { data: req } = await supabase.from('match_requests')
        .select('from_user').eq('request_id', user.pending_request_id).single();
      if (req) {
        const { data: sender } = await supabase.from('users').select('phone').eq('user_id', req.from_user).single();
        if (sender) {
          await setState(sender.phone, 'WAITING', { pending_request_id: null });
          await sendText(sender.phone, `The person you requested started a new search. You're back in the pool! 🔄`).catch(() => {});
        }
      }
    } catch (e) {
      console.error('resetForNewSearch MATCH_RECEIVED error:', e.message);
      logError({ severity: 'WARNING', type: 'MATCHING', operation: 'resetForNewSearch_received', message: e.message, phone, error: e }).catch(() => {});
    }
  }

  // Clear the user's active session flags
  await upsertUser(phone, {
    is_active:           false,
    is_matched:          false,
    matched_with:        null,
    pending_request_id:  null,
    updated_at:          new Date().toISOString(),
  });
}

async function startOrResume(phone, user, waName, forceRestart) {
  // If already in an active search and this is NOT a force-restart → block and show options
  if (!forceRestart && user?.state && ACTIVE_SEARCH_STATES.has(user.state)) {
    return sendAlreadyInQueueMsg(phone, user);
  }

  // Previously deleted user coming back — update state to IDLE so they can restart cleanly
  if (!forceRestart && user?.state === 'DELETED') {
    await upsertUser(phone, { state: 'IDLE', updated_at: new Date().toISOString() });
    if (user.name && user.gender) {
      return sendWelcomeBack(phone, { ...user, state: 'IDLE' });
    }
    return sendNamePrompt(phone, waName);
  }

  // Returning user with name + gender already set → welcome back screen
  if (!forceRestart && user?.name && user?.gender) {
    return sendWelcomeBack(phone, user);
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
    logError({ severity: 'WARNING', type: 'SUPABASE', operation: 'syncProfileFields', message: e.message, phone, error: e }).catch(() => {});
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
    `Your partner:\n` +
    `👤 *${partnerUser.name || 'Anonymous'}* (${genderLabel(partnerUser.gender)})\n` +
    `📍 Drop: ${partnerDrop}\n` +
    `${ratingStr}\n\n` +
    `Tap *Share Contact* — both of you must agree before numbers are exchanged.`,
    [
      { id: 'SHARE_CONTACT', title: '📱 Share Contact' },
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
      await revealContact(freshUser.phone, partnerUser, freshUser);
      await revealContact(partnerUser.phone, freshUser, partnerUser);
    }
  } else {
    await sendText(phone, `✅ Your number is ready to share!\n\nWaiting for *${isA ? 'them' : 'them'}* to also tap Share Contact... I'll notify you the moment they do.`);
  }
}

async function revealContact(phone, partnerUser, selfUser) {
  const myDrop      = selfUser?.drop_label || selfUser?.drop_zone || 'my destination';
  const prefilledMsg = encodeURIComponent(
    `Hi ${partnerUser.name || 'there'}! I found you on AasPass 🚕 I'm heading to ${myDrop}. Let's share a cab — can we coordinate?`
  );
  const waLink = `https://wa.me/${partnerUser.phone}?text=${prefilledMsg}`;

  await sendButtons(
    phone,
    `🎊 *Contact exchanged!*\n\n` +
    `👤 *${partnerUser.name || 'Your match'}*\n` +
    `📍 Their drop: ${partnerUser.drop_label || partnerUser.drop_zone || 'Nearby'}\n\n` +
    `Message them to coordinate your cab 🚕\n\nTap *Done* once your trip is complete.`,
    [
      { id: 'TRIP_DONE',  title: '✅ Done'    },
      { id: 'TRIP_ISSUE', title: '⚠️ Issue'   },
    ]
  );

  // CTA button — opens WhatsApp chat with a pre-filled intro message ready to send
  await sendCTAButton(
    phone,
    `💬 A message is ready for you to send:`,
    'Message on WhatsApp',
    waLink
  ).catch(e => logError({
    severity: 'WARNING', type: 'WHATSAPP', operation: 'revealContact_cta',
    message: e.message, phone, error: e,
  }).catch(() => {}));
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

// ── LLM destructive action confirmation ──────────────────────────────────────
// Called when LLM predicts a destructive action from natural language.
// Saves the action to DB and sends an explicit Yes/No prompt.
// Only CONFIRM_LLM_YES actually executes the action.

const CONFIRMATION_MESSAGES = {
  CANCEL:       `Are you sure you want to *cancel* and leave the matching pool?`,
  TRIP_DONE:    `Confirm that your trip is *complete*?`,
  REPORT_ISSUE: `Do you want to *report an issue* with your match?`,
};

async function sendConfirmationPrompt(phone, action, user) {
  const question = CONFIRMATION_MESSAGES[action]
    || `Are you sure you want to *${action.toLowerCase().replace('_', ' ')}*?`;

  // Save the pending action so we can execute it after confirmation
  await upsertUser(phone, { pending_llm_action: action });

  return sendButtons(phone, question, [
    { id: 'CONFIRM_LLM_YES', title: '✅ Yes, proceed'   },
    { id: 'CONFIRM_LLM_NO',  title: '❌ No, go back'    },
  ]);
}

// ── Notify waiting users ──────────────────────────────────────────────────────

// Push a fresh match list to waiting users so they don't have to type MATCHES.
// Slice to top 5 — only notify users who are genuinely close matches.
async function notifyWaitingUsers(newUser, matchesForNewUser) {
  for (const match of matchesForNewUser.slice(0, 5)) {
    if (match.state !== 'WAITING') continue;
    try {
      // Re-fetch in case their state changed between match-finding and now
      const { data: fresh } = await supabase.from('users').select('*').eq('user_id', match.user_id).single();
      if (!fresh || !fresh.is_active || fresh.state !== 'WAITING') continue;

      // Run a fresh match search from their perspective so their list is up to date
      const theirMatches = await findMatches(fresh);
      await sendText(fresh.phone, `🚕 A new cab-split partner just joined nearby!`);
      await sendMatchResults(fresh, theirMatches);
    } catch (e) {
      console.error(`notifyWaitingUsers error for ${match.phone}:`, e.message);
      logError({ severity: 'WARNING', type: 'MATCHING', operation: 'notifyWaitingUsers', message: e.message, phone: match.phone, error: e }).catch(() => {});
    }
  }
}

// ── Utility commands ──────────────────────────────────────────────────────────

async function sendHelp(phone) {
  const websiteLine  = WEBSITE_URL ? `\n🌐 *Website:* ${WEBSITE_URL}` : '';
  const contactLine  = WA_NUMBER   ? `\n💬 *Contact us:* wa.me/${WA_NUMBER}?text=Hi` : '';
  return sendText(phone,
    `*AasPass Help* 🚕\n\n` +
    `*Commands:*\n` +
    `*hi / start* — Begin or resume\n` +
    `*MATCHES* — View available matches\n` +
    `*CANCEL* — Cancel request or match\n` +
    `*DONE* — Confirm trip completed\n` +
    `*ISSUE* — Report a problem\n` +
    `*FEEDBACK* — Share your thoughts with us\n` +
    `*BLOCK* — Block current match (silent)\n` +
    `*STATUS* — Check your current status\n` +
    `*CLAIM* — Claim ₹100 reward (if no match found)\n` +
    `*MY CODE* — Get your referral code + shareable message\n` +
    `*RESTART* — Start fresh\n` +
    `*DELETE* — Deactivate your account\n` +
    `*STOP* — Unsubscribe\n` +
    `*HELP* — Show this list\n` +
    `\n─────────────────\n` +
    `*Need help or have a suggestion?*${contactLine}${websiteLine}`
  );
}

async function sendDeleteConfirmation(phone) {
  return sendButtons(phone,
    `⚠️ *Delete your AasPass profile?*\n\n` +
    `This will:\n` +
    `• Remove you from the matching pool\n` +
    `• Cancel any active requests\n` +
    `• Deactivate your account\n\n` +
    `Your data is kept securely. You can come back anytime by sending *hi*.`,
    [
      { id: 'CONFIRM_DELETE', title: '🗑 Yes, Delete' },
      { id: 'CANCEL_DELETE',  title: '⬅️ Keep Account' },
    ]
  );
}

async function handleAccountDelete(phone, user) {
  // Cancel any pending outbound match requests
  if (user) await cancelPendingRequestsFrom(user);

  // If currently matched, notify partner and return them to the pool
  if (user?.is_matched && user?.matched_with) {
    const { data: partner } = await supabase
      .from('users').select('phone').eq('user_id', user.matched_with).single();
    if (partner) {
      await setState(partner.phone, 'WAITING', { is_matched: false, matched_with: null, pending_request_id: null });
      await sendText(partner.phone,
        `Your cab-split partner has left AasPass. You've been returned to the match pool! 🔄`
      ).catch(() => {});
    }
  }

  // Soft-delete: mark inactive, preserve all data
  await upsertUser(phone, {
    is_active:          false,
    is_matched:         false,
    matched_with:       null,
    pending_request_id: null,
    state:              'DELETED',
    deleted_at:         new Date().toISOString(),
    updated_at:         new Date().toISOString(),
  });

  return sendText(phone,
    `✅ *Your profile has been deactivated.*\n\n` +
    `You've been removed from the matching pool and any active requests have been cancelled.\n\n` +
    `Miss us? Send *hi* anytime to come back. 👋`
  );
}

async function sendFeedbackPrompt(phone) {
  await sendText(phone,
    `💬 *We'd love to hear from you!*\n\n` +
    `What do you think of AasPass? Any suggestions, issues, or ideas?\n\n` +
    `Just type your message and we'll read it personally. 🙏`
  );
  const user = await getUser(phone);
  await setState(phone, 'USER_FEEDBACK', { pre_feedback_state: user?.state || 'IDLE' });
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
        `• Or type coordinates e.g. *17.4239, 78.4738*`
      );
    }

    case 'EDIT_DROP': {
      await cancelPendingRequestsFrom(user);
      await setState(phone, 'POOL_EDIT_DROP');
      return sendLocationRequest(phone, `Where's your new drop destination? 🎯\n\nTap the button to search or share a pin, or type coordinates e.g. 17.4239, 78.4738`);
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
      return sendText(phone, `No problem! Send *hi* whenever you're ready to search again. 🚕`);
    }

    // ACCEPT / DECLINE require a specific user ID — can't resolve from plain text alone.
    // Prompt them to use the button in the original request message.
    case 'ACCEPT':
    case 'DECLINE':
      return sendText(phone, `Please use the *Accept* / *Decline* buttons in the request message above.`);

    case 'REFERRAL_INFO': {
      const freshUser = await getUser(phone);
      return sendReferralInfo(phone, freshUser);
    }

    default: {
      // LLM returned UNKNOWN (off-topic, greeting, etc.) or unrecognised action.
      // If the model supplied a followup hint, send it; otherwise generic nudge.
      if (followup) return sendText(phone, followup);
      return sendText(phone, `Not sure what you mean. Type *HELP* to see available commands.`);
    }
  }
}

module.exports = { handleMessage };
