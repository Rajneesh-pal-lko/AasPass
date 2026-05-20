const supabase = require('../config/supabase');
const { sendText, sendButtons, sendList, sendCTAButton, sendLocationRequest } = require('../services/whatsapp');
const { detectAirport } = require('../utils/haversine');
const { findMatches, sendMatchResults, sendMatchRequest } = require('../services/matching');
const { createVerificationPaymentLink } = require('../services/razorpay');

// ── helpers ──────────────────────────────────────────────────────────────────

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

// ── onboarding messages ───────────────────────────────────────────────────────

async function sendWelcome(phone) {
  await sendButtons(
    phone,
    `Welcome to *AasPass* ✈️🚕\n\nStop paying solo cab prices! We match you with fellow passengers so you can split the ride.\n\nWhich airport are you at right now?`,
    [
      { id: 'CITY_HYD', title: 'Hyderabad' },
      { id: 'CITY_BLR', title: 'Bangalore' },
      { id: 'CITY_DEL', title: 'Delhi' },
    ]
  );
  await setState(phone, 'ONBOARDING_CITY');
}

async function sendLocationPrompt(phone) {
  await sendLocationRequest(phone, `Great! Now share your *current location* 📍\n\nThis confirms which airport you are at.`);
  await setState(phone, 'ONBOARDING_LOCATION');
}

async function sendFlightPrompt(phone) {
  await sendText(phone, `✅ Airport confirmed!\n\nWhat is your *flight number*? (e.g. 6E-204)`);
  await setState(phone, 'ONBOARDING_FLIGHT');
}

async function sendArrivalPrompt(phone) {
  await sendText(phone, `Got it! What time does your flight *land*? (24-hr format, e.g. 16:45)`);
  await setState(phone, 'ONBOARDING_ARRIVAL');
}

async function sendDropPrompt(phone) {
  await sendLocationRequest(
    phone,
    `Almost done! Drop a pin 📍 of *where you need to be dropped off* so I can find nearby matches.`
  );
  await setState(phone, 'ONBOARDING_DROP');
}

async function sendConfirmation(phone, user) {
  const summary =
    `Here's your trip summary:\n\n` +
    `✈️ Flight: *${user.flight_number}*\n` +
    `🕐 Arrival: *${user.arrival_time}*\n` +
    `🏢 Airport: *${user.departure_airport}*\n` +
    `📍 Drop zone: *${user.drop_zone || 'Confirmed'}*\n\n` +
    `Shall I search for cab-split partners?`;

  await sendButtons(phone, summary, [
    { id: 'CONFIRM_YES', title: '✅ Yes, Search!' },
    { id: 'CONFIRM_NO',  title: '❌ No, Restart' },
  ]);
  await setState(phone, 'ONBOARDING_CONFIRM');
}

// ── main dispatcher ───────────────────────────────────────────────────────────

async function handleMessage(msg) {
  const phone = msg.from;
  const msgType = msg.type;

  let text = '';
  let buttonId = '';
  let listId = '';
  let locationLat = null;
  let locationLon = null;

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

  // ── Global commands (work from any state) ──
  if (text === 'STOP') {
    await upsertUser(phone, { is_active: false, state: 'IDLE' });
    return sendText(phone, `You have been unsubscribed from AasPass. Send "hi" anytime to rejoin. 👋`);
  }
  if (text === 'HELP') return sendHelp(phone);
  if (text === 'STATUS') return sendStatus(phone);
  if (text === 'RESTART' || text === 'HI' || text === 'START') return sendWelcome(phone);

  const user = await getUser(phone);
  const state = user?.state || 'IDLE';

  // ── State machine ──
  switch (state) {
    case 'IDLE':
    case 'COMPLETED':
      return sendWelcome(phone);

    // ── ONBOARDING ──
    case 'ONBOARDING_CITY': {
      if (!buttonId.startsWith('CITY_')) return sendText(phone, 'Please tap one of the city buttons above.');
      const cityCode = buttonId.replace('CITY_', '');
      await setState(phone, 'ONBOARDING_LOCATION', { city_preference: cityCode });
      return sendLocationPrompt(phone);
    }

    case 'ONBOARDING_LOCATION': {
      if (!locationLat) return sendText(phone, 'Please share your location using the button above 📍');
      const airport = detectAirport(locationLat, locationLon);
      if (!airport) {
        return sendText(
          phone,
          `We couldn't confirm an airport within 2km of your location.\n\nAre you at the airport yet? Only use AasPass when you have landed. ✈️`
        );
      }
      await setState(phone, 'ONBOARDING_FLIGHT', {
        departure_airport: airport.code,
        departure_lat: locationLat,
        departure_long: locationLon,
      });
      return sendFlightPrompt(phone);
    }

    case 'ONBOARDING_FLIGHT': {
      if (!text) return sendText(phone, 'Please type your flight number (e.g. 6E-204)');
      const raw = msg.text?.body?.trim() || '';
      await setState(phone, 'ONBOARDING_ARRIVAL', { flight_number: raw });
      return sendArrivalPrompt(phone);
    }

    case 'ONBOARDING_ARRIVAL': {
      const raw = msg.text?.body?.trim() || '';
      if (!raw.match(/^\d{1,2}:\d{2}$/)) {
        return sendText(phone, 'Please enter time in HH:MM format (e.g. 16:45)');
      }
      await setState(phone, 'ONBOARDING_DROP', { arrival_time: raw });
      return sendDropPrompt(phone);
    }

    case 'ONBOARDING_DROP': {
      if (!locationLat) return sendText(phone, 'Please share your drop-off location using the button above 📍');
      const updatedUser = await setState(phone, 'ONBOARDING_CONFIRM', {
        drop_lat: locationLat,
        drop_long: locationLon,
        drop_zone: `${locationLat.toFixed(4)}, ${locationLon.toFixed(4)}`,
      });
      return sendConfirmation(phone, updatedUser);
    }

    case 'ONBOARDING_CONFIRM': {
      if (buttonId === 'CONFIRM_NO') return sendWelcome(phone);
      if (buttonId !== 'CONFIRM_YES') return sendText(phone, 'Please tap one of the buttons above.');

      const activeUser = await setState(phone, 'WAITING', {
        is_active: true,
        is_matched: false,
        payment_verified: false,
      });
      const matches = await findMatches(activeUser);
      await sendMatchResults(activeUser, matches);

      // Notify waiting users whose flight now has a new match
      await notifyWaitingUsers(activeUser, matches);
      return;
    }

    // ── WAITING ──
    case 'WAITING': {
      if (text === 'MATCHES') {
        const freshUser = await getUser(phone);
        const matches = await findMatches(freshUser);
        return sendMatchResults(freshUser, matches);
      }
      if (listId.startsWith('match_')) {
        return handleMatchRequest(phone, listId.replace('match_', ''), user);
      }
      return sendText(phone, 'You are in the waiting pool. Type MATCHES to view available matches, or STATUS to check your status.');
    }

    // ── MATCH_SENT ──
    case 'MATCH_SENT': {
      if (text === 'CANCEL') return handleCancelSentRequest(phone, user);
      return sendText(phone, 'Your request is pending. The other passenger will respond shortly.\n\nType CANCEL to withdraw your request.');
    }

    // ── MATCH_RECEIVED ──
    case 'MATCH_RECEIVED': {
      if (buttonId.startsWith('ACCEPT_')) {
        const fromUserId = buttonId.replace('ACCEPT_', '');
        return handleAcceptMatch(phone, fromUserId, user);
      }
      if (buttonId.startsWith('DECLINE_')) {
        const fromUserId = buttonId.replace('DECLINE_', '');
        return handleDeclineMatch(phone, fromUserId, user);
      }
      return sendText(phone, 'Please tap Accept or Decline on the match request above.');
    }

    // ── MATCHED ──
    case 'MATCHED': {
      if (text === 'CANCEL') return initiateCancelAfterMatch(phone, user);
      if (text === 'CONFIRM CANCEL') return handleCancelAfterMatch(phone, user);
      if (text === 'BACK') return sendText(phone, 'Great! Your match is still active. Safe travels! ✈️');
      if (text === 'DONE') return handleTripDone(phone, user);
      if (text === 'ISSUE') return handleIssue(phone, user);
      return sendText(phone, 'You are matched! Type DONE when your cab split is complete, or ISSUE to report a problem.');
    }

    default:
      return sendWelcome(phone);
  }
}

// ── Match request flow ────────────────────────────────────────────────────────

async function handleMatchRequest(fromPhone, toUserId, fromUser) {
  const { data: toUser } = await supabase.from('users').select('*').eq('user_id', toUserId).single();
  if (!toUser || !toUser.is_active || toUser.is_matched) {
    return sendText(fromPhone, 'That match is no longer available. Type MATCHES to see current options.');
  }

  const { getDistanceKm } = require('../utils/haversine');
  const dist = getDistanceKm(fromUser.drop_lat, fromUser.drop_long, toUser.drop_lat, toUser.drop_long);

  // Create match request record
  const { data: req } = await supabase
    .from('match_requests')
    .insert({
      from_user: fromUser.user_id,
      to_user: toUser.user_id,
      distance_km: dist,
      status: 'pending',
    })
    .select()
    .single();

  await setState(fromPhone, 'MATCH_SENT', { pending_request_id: req.request_id });
  await setState(toUser.phone, 'MATCH_RECEIVED', { pending_request_id: req.request_id });

  await sendText(fromPhone, `Request sent! ✅\n\nWaiting for them to respond. I'll notify you right away.\n\nType CANCEL to withdraw.`);
  await sendMatchRequest(fromUser, toUser, dist);

  // Auto-expire in 10 minutes
  setTimeout(() => expireRequest(req.request_id, fromUser, toUser), 10 * 60 * 1000);
}

async function handleAcceptMatch(toPhone, fromUserId, toUser) {
  const { data: fromUser } = await supabase.from('users').select('*').eq('user_id', fromUserId).single();
  if (!fromUser) return sendText(toPhone, 'Something went wrong. Type STATUS to check.');

  const { data: req } = await supabase
    .from('match_requests')
    .select('*')
    .eq('from_user', fromUserId)
    .eq('to_user', toUser.user_id)
    .eq('status', 'pending')
    .single();

  if (!req) return sendText(toPhone, 'This request has already expired or been cancelled.');

  // Update statuses
  await supabase.from('match_requests').update({ status: 'accepted', responded_at: new Date().toISOString() }).eq('request_id', req.request_id);
  await setState(fromUser.phone, 'MATCHED', { is_matched: true, matched_with: toUser.user_id });
  await setState(toPhone, 'MATCHED', { is_matched: true, matched_with: fromUser.user_id });

  await supabase.from('confirmed_matches').insert({
    user_a: fromUser.user_id,
    user_b: toUser.user_id,
    flight_number: fromUser.flight_number,
    distance_km: req.distance_km,
    confirmed_at: new Date().toISOString(),
  });

  await sendText(toPhone, `You accepted! 🎉 Great choice.\n\nI'll send you both each other's contact details once payment is verified.`);

  // Send payment link to the requester (User A)
  const matchId = req.request_id;
  const payUrl = await createVerificationPaymentLink(fromUser, matchId);
  await sendCTAButton(
    fromUser.phone,
    `Your match accepted! 🎉\n\nPay ₹1 to verify your identity and unlock each other's WhatsApp numbers.\n\n(This activates your free 3-month AasPass membership.)`,
    'Pay ₹1 Now',
    payUrl
  );
}

async function handleDeclineMatch(toPhone, fromUserId, toUser) {
  const { data: fromUser } = await supabase.from('users').select('*').eq('user_id', fromUserId).single();

  await supabase
    .from('match_requests')
    .update({ status: 'declined', responded_at: new Date().toISOString() })
    .eq('from_user', fromUserId)
    .eq('to_user', toUser.user_id)
    .eq('status', 'pending');

  await setState(toPhone, 'WAITING');
  await setState(fromUser.phone, 'WAITING', { is_matched: false });

  await sendText(toPhone, `No problem! You're back in the pool. ✌️`);
  const matches = await findMatches(fromUser);
  await sendText(fromUser.phone, `They declined. No worries — let me show you the next best option.`);
  await sendMatchResults(fromUser, matches);
}

async function expireRequest(requestId, fromUser, toUser) {
  const { data: req } = await supabase.from('match_requests').select('status').eq('request_id', requestId).single();
  if (!req || req.status !== 'pending') return; // already handled

  await supabase.from('match_requests').update({ status: 'expired' }).eq('request_id', requestId);
  await setState(fromUser.phone, 'WAITING');
  await setState(toUser.phone, 'WAITING');

  await sendText(fromUser.phone, `Your request timed out after 10 minutes. Showing you the next match...`);
  await sendText(toUser.phone, `A match request expired. You're back in the pool!`);

  const matches = await findMatches(fromUser);
  await sendMatchResults(fromUser, matches);
}

// ── Cancel flows ──────────────────────────────────────────────────────────────

async function handleCancelSentRequest(phone, user) {
  if (!user.pending_request_id) {
    await setState(phone, 'WAITING');
    return sendText(phone, `No active request found. You're back in the pool.`);
  }

  const { data: req } = await supabase.from('match_requests').select('*').eq('request_id', user.pending_request_id).single();
  if (req) {
    await supabase.from('match_requests').update({ status: 'cancelled_by_sender', cancelled_by: user.user_id, cancelled_at: new Date().toISOString() }).eq('request_id', req.request_id);
    const { data: toUser } = await supabase.from('users').select('*').eq('user_id', req.to_user).single();
    if (toUser) {
      await setState(toUser.phone, 'WAITING');
      await sendText(toUser.phone, `The cab split request was withdrawn. You're back in the pool!`);
    }
  }

  await setState(phone, 'WAITING');
  return sendText(phone, `Request cancelled. You're back in the matching pool. Type MATCHES to view options.`);
}

async function initiateCancelAfterMatch(phone, user) {
  await sendButtons(
    phone,
    `Are you sure you want to cancel this match? The other person will be notified.`,
    [
      { id: 'CONFIRM_CANCEL', title: '✅ Confirm Cancel' },
      { id: 'BACK_TO_MATCH',  title: '⬅️ Keep Match' },
    ]
  );
}

async function handleCancelAfterMatch(phone, user) {
  const { data: matchedUser } = await supabase.from('users').select('*').eq('user_id', user.matched_with).single();

  await setState(phone, 'WAITING', { is_matched: false, matched_with: null });
  if (matchedUser) {
    await setState(matchedUser.phone, 'WAITING', { is_matched: false, matched_with: null });
    await sendText(matchedUser.phone, `Your cab split partner cancelled. You're back in the pool — I'll find you another match!`);
    const matches = await findMatches(matchedUser);
    await sendMatchResults(matchedUser, matches);
  }

  await sendText(phone, `Match cancelled. You're back in the pool. Type MATCHES to search again.`);
}

// ── Trip completion ───────────────────────────────────────────────────────────

async function handleTripDone(phone, user) {
  await setState(phone, 'COMPLETED', { is_active: false, is_matched: false });
  await supabase.from('match_requests')
    .update({ status: 'completed', confirmed_by: user.user_id, confirmed_at: new Date().toISOString() })
    .or(`from_user.eq.${user.user_id},to_user.eq.${user.user_id}`)
    .eq('status', 'accepted');

  return sendText(phone, `Awesome! Glad it worked out! 🎉\n\nYou just saved money and helped someone else too.\n\nSee you next time on AasPass! ✈️`);
}

async function handleIssue(phone, user) {
  await supabase.from('support_queue').insert({
    user_id: user.user_id,
    issue_type: 'trip_issue',
    description: 'User reported an issue via ISSUE command',
    created_at: new Date().toISOString(),
    resolved: false,
  });

  return sendText(phone, `Sorry to hear that! 😟\n\nWe've logged your issue and our team will look into it.\n\nFor urgent help, please contact support directly.`);
}

// ── Notify waiting users when a new user joins ────────────────────────────────

async function notifyWaitingUsers(newUser, matchesForNewUser) {
  // For each match found, also check if that waiting user should be notified
  for (const match of matchesForNewUser.slice(0, 3)) {
    if (match.state === 'WAITING') {
      const freshMatches = await findMatches(match);
      if (freshMatches.length > 0) {
        await sendText(match.phone, `Good news! A new match just appeared for your flight. Type MATCHES to view. 🚕`);
      }
    }
  }
}

// ── Utility commands ──────────────────────────────────────────────────────────

async function sendHelp(phone) {
  const help =
    `*AasPass Commands* ✈️\n\n` +
    `*hi / start* — Begin onboarding\n` +
    `*MATCHES* — View available matches\n` +
    `*CANCEL* — Cancel your request or match\n` +
    `*DONE* — Confirm trip completed\n` +
    `*ISSUE* — Report a problem\n` +
    `*STATUS* — Check your current status\n` +
    `*RESTART* — Start fresh\n` +
    `*STOP* — Unsubscribe\n` +
    `*HELP* — Show this list`;
  return sendText(phone, help);
}

async function sendStatus(phone) {
  const user = await getUser(phone);
  if (!user) return sendText(phone, `No active session. Send "hi" to get started!`);
  const msg =
    `*Your Status*\n\n` +
    `State: ${user.state}\n` +
    `Flight: ${user.flight_number || 'Not set'}\n` +
    `Arrival: ${user.arrival_time || 'Not set'}\n` +
    `Active: ${user.is_active ? 'Yes' : 'No'}\n` +
    `Matched: ${user.is_matched ? 'Yes' : 'No'}`;
  return sendText(phone, msg);
}

module.exports = { handleMessage };
