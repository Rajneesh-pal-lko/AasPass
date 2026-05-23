const supabase = require('../config/supabase');
const { sendText, sendButtons, sendList, sendCTAButton, sendLocationRequest } = require('../services/whatsapp');
const { getDistanceKm } = require('../utils/haversine');
const { findMatches, sendMatchResults, sendMatchRequest } = require('../services/matching');
const { createVerificationPaymentLink } = require('../services/razorpay');

const PICKUP_RADIUS_KM = 2; // users must be within 2km of each other at pickup

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

// Detect a human-readable venue name from coordinates
function detectVenue(lat, lon) {
  const VENUES = [
    { name: 'Hyderabad Airport (RGIA)', lat: 17.2403, lon: 78.4294 },
    { name: 'Bangalore Airport (KIA)',  lat: 13.1986, lon: 77.7066 },
    { name: 'Delhi Airport (IGI)',      lat: 28.5562, lon: 77.1000 },
  ];
  for (const v of VENUES) {
    if (getDistanceKm(lat, lon, v.lat, v.lon) <= 3) return v.name;
  }
  return null; // unknown venue — still allowed
}

// ── onboarding messages ───────────────────────────────────────────────────────

async function sendWelcome(phone) {
  await sendText(
    phone,
    `Welcome to *AasPass* ✈️🚕\n\nStop paying solo cab prices! Share a ride with someone heading the same way.\n\nLet's find you a match in 2 steps.`
  );
  await sendLocationRequest(phone, `*Step 1 of 2* — Share your *current location* 📍\n\nWe'll find others nearby.`);
  await setState(phone, 'ONBOARDING_PICKUP');
}

async function sendDropPrompt(phone, venueName) {
  const venueText = venueName ? `📍 You're at *${venueName}*\n\n` : `📍 Location confirmed!\n\n`;
  await sendLocationRequest(
    phone,
    `${venueText}*Step 2 of 2* — Now share your *drop destination* 📍\n\nWhere do you need to go?`
  );
  await setState(phone, 'ONBOARDING_DROP');
}

async function sendConfirmation(phone, user) {
  const venue = user.departure_airport || `${parseFloat(user.departure_lat).toFixed(4)}, ${parseFloat(user.departure_long).toFixed(4)}`;
  const drop = user.drop_zone || `${parseFloat(user.drop_lat).toFixed(4)}, ${parseFloat(user.drop_long).toFixed(4)}`;

  await sendButtons(
    phone,
    `Here's your trip summary:\n\n📍 *Pickup:* ${venue}\n🎯 *Drop:* ${drop}\n\nShall I find you a cab-split partner?`,
    [
      { id: 'CONFIRM_YES', title: '✅ Yes, Find Match!' },
      { id: 'CONFIRM_NO',  title: '❌ No, Restart' },
    ]
  );
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

  // ── Global commands ──
  if (text === 'STOP') {
    await upsertUser(phone, { is_active: false, state: 'IDLE' });
    return sendText(phone, `You've been unsubscribed from AasPass. Send "hi" anytime to rejoin. 👋`);
  }
  if (text === 'HELP') return sendHelp(phone);
  if (text === 'STATUS') return sendStatus(phone);
  if (text === 'RESTART' || text === 'HI' || text === 'START') return sendWelcome(phone);

  const user = await getUser(phone);
  const state = user?.state || 'IDLE';

  switch (state) {

    case 'IDLE':
    case 'COMPLETED':
      return sendWelcome(phone);

    // ── Step 1: Pickup location ──
    case 'ONBOARDING_PICKUP': {
      if (!locationLat) {
        return sendLocationRequest(phone, `Please share your *current location* using the button above 📍`);
      }
      const venueName = detectVenue(locationLat, locationLon);
      await setState(phone, 'ONBOARDING_DROP', {
        departure_lat: locationLat,
        departure_long: locationLon,
        departure_airport: venueName || `${locationLat.toFixed(4)},${locationLon.toFixed(4)}`,
      });
      return sendDropPrompt(phone, venueName);
    }

    // ── Step 2: Drop location ──
    case 'ONBOARDING_DROP': {
      if (!locationLat) {
        return sendLocationRequest(phone, `Please share your *drop destination* using the button above 📍`);
      }
      const updatedUser = await setState(phone, 'ONBOARDING_CONFIRM', {
        drop_lat: locationLat,
        drop_long: locationLon,
        drop_zone: `${locationLat.toFixed(4)}, ${locationLon.toFixed(4)}`,
      });
      return sendConfirmation(phone, updatedUser);
    }

    // ── Confirm ──
    case 'ONBOARDING_CONFIRM': {
      if (buttonId === 'CONFIRM_NO') return sendWelcome(phone);
      if (buttonId !== 'CONFIRM_YES') return sendText(phone, 'Please tap one of the buttons above.');

      const activeUser = await setState(phone, 'WAITING', {
        is_active: true,
        is_matched: false,
        payment_verified: false,
        flight_number: null,
        arrival_time: null,
      });

      const matches = await findMatches(activeUser);
      await sendMatchResults(activeUser, matches);
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
      return sendText(phone, `You're in the matching pool! 🔍\n\nType *MATCHES* to view available matches or *STATUS* to check your status.`);
    }

    // ── MATCH_SENT ──
    case 'MATCH_SENT': {
      if (text === 'CANCEL') return handleCancelSentRequest(phone, user);
      return sendText(phone, `Your request is pending. They'll respond shortly.\n\nType *CANCEL* to withdraw.`);
    }

    // ── MATCH_RECEIVED ──
    case 'MATCH_RECEIVED': {
      if (buttonId.startsWith('ACCEPT_')) return handleAcceptMatch(phone, buttonId.replace('ACCEPT_', ''), user);
      if (buttonId.startsWith('DECLINE_')) return handleDeclineMatch(phone, buttonId.replace('DECLINE_', ''), user);
      return sendText(phone, 'Please tap Accept or Decline on the match request above.');
    }

    // ── MATCHED ──
    case 'MATCHED': {
      if (text === 'CANCEL') return initiateCancelAfterMatch(phone, user);
      if (text === 'CONFIRM CANCEL') return handleCancelAfterMatch(phone, user);
      if (text === 'BACK') return sendText(phone, `Great! Your match is still active. Safe travels! ✈️`);
      if (text === 'DONE') return handleTripDone(phone, user);
      if (text === 'ISSUE') return handleIssue(phone, user);
      return sendText(phone, `You're matched! 🎉\n\nType *DONE* when your cab split is complete, or *ISSUE* to report a problem.`);
    }

    default:
      return sendWelcome(phone);
  }
}

// ── Match request flow ────────────────────────────────────────────────────────

async function handleMatchRequest(fromPhone, toUserId, fromUser) {
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

  await sendText(fromPhone, `Request sent! ✅\n\nWaiting for them to respond. I'll notify you right away.\n\nType *CANCEL* to withdraw.`);
  await sendMatchRequest(fromUser, toUser, dist);

  setTimeout(() => expireRequest(req.request_id, fromUser, toUser), 10 * 60 * 1000);
}

async function handleAcceptMatch(toPhone, fromUserId, toUser) {
  const { data: fromUser } = await supabase.from('users').select('*').eq('user_id', fromUserId).single();
  if (!fromUser) return sendText(toPhone, `Something went wrong. Type STATUS to check.`);

  const { data: req } = await supabase
    .from('match_requests').select('*')
    .eq('from_user', fromUserId).eq('to_user', toUser.user_id).eq('status', 'pending').single();

  if (!req) return sendText(toPhone, `This request has already expired or been cancelled.`);

  await supabase.from('match_requests').update({ status: 'accepted', responded_at: new Date().toISOString() }).eq('request_id', req.request_id);
  await setState(fromUser.phone, 'MATCHED', { is_matched: true, matched_with: toUser.user_id });
  await setState(toPhone, 'MATCHED', { is_matched: true, matched_with: fromUser.user_id });

  await supabase.from('confirmed_matches').insert({
    user_a: fromUser.user_id, user_b: toUser.user_id,
    distance_km: req.distance_km, confirmed_at: new Date().toISOString(),
  });

  await sendText(toPhone, `You accepted! 🎉\n\nContact details will be shared once payment is verified.`);

  const payUrl = await createVerificationPaymentLink(fromUser, req.request_id);
  await sendCTAButton(
    fromUser.phone,
    `Your match accepted! 🎉\n\nPay ₹1 to verify your identity and unlock each other's WhatsApp numbers.\n\n(This activates your free 3-month AasPass membership.)`,
    'Pay ₹1 Now', payUrl
  );
}

async function handleDeclineMatch(toPhone, fromUserId, toUser) {
  const { data: fromUser } = await supabase.from('users').select('*').eq('user_id', fromUserId).single();

  await supabase.from('match_requests')
    .update({ status: 'declined', responded_at: new Date().toISOString() })
    .eq('from_user', fromUserId).eq('to_user', toUser.user_id).eq('status', 'pending');

  await setState(toPhone, 'WAITING');
  await setState(fromUser.phone, 'WAITING', { is_matched: false });

  await sendText(toPhone, `No problem! You're back in the pool. ✌️`);
  const matches = await findMatches(fromUser);
  await sendText(fromUser.phone, `They declined. Let me show you the next best option.`);
  await sendMatchResults(fromUser, matches);
}

async function expireRequest(requestId, fromUser, toUser) {
  const { data: req } = await supabase.from('match_requests').select('status').eq('request_id', requestId).single();
  if (!req || req.status !== 'pending') return;

  await supabase.from('match_requests').update({ status: 'expired' }).eq('request_id', requestId);
  await setState(fromUser.phone, 'WAITING');
  await setState(toUser.phone, 'WAITING');

  await sendText(fromUser.phone, `Your request timed out after 10 minutes. Showing next match...`);
  await sendText(toUser.phone, `A match request expired. You're back in the pool!`);

  const matches = await findMatches(fromUser);
  await sendMatchResults(fromUser, matches);
}

// ── Cancel flows ──────────────────────────────────────────────────────────────

async function handleCancelSentRequest(phone, user) {
  if (user.pending_request_id) {
    const { data: req } = await supabase.from('match_requests').select('*').eq('request_id', user.pending_request_id).single();
    if (req) {
      await supabase.from('match_requests').update({ status: 'cancelled_by_sender', cancelled_by: user.user_id, cancelled_at: new Date().toISOString() }).eq('request_id', req.request_id);
      const { data: toUser } = await supabase.from('users').select('*').eq('user_id', req.to_user).single();
      if (toUser) {
        await setState(toUser.phone, 'WAITING');
        await sendText(toUser.phone, `The cab split request was withdrawn. You're back in the pool!`);
      }
    }
  }
  await setState(phone, 'WAITING');
  return sendText(phone, `Request cancelled. You're back in the pool. Type *MATCHES* to view options.`);
}

async function initiateCancelAfterMatch(phone) {
  return sendButtons(phone, `Are you sure you want to cancel this match? The other person will be notified.`, [
    { id: 'CONFIRM_CANCEL', title: '✅ Confirm Cancel' },
    { id: 'BACK_TO_MATCH',  title: '⬅️ Keep Match' },
  ]);
}

async function handleCancelAfterMatch(phone, user) {
  const { data: matchedUser } = await supabase.from('users').select('*').eq('user_id', user.matched_with).single();

  await setState(phone, 'WAITING', { is_matched: false, matched_with: null });
  if (matchedUser) {
    await setState(matchedUser.phone, 'WAITING', { is_matched: false, matched_with: null });
    await sendText(matchedUser.phone, `Your cab split partner cancelled. You're back in the pool!`);
    const matches = await findMatches(matchedUser);
    await sendMatchResults(matchedUser, matches);
  }

  return sendText(phone, `Match cancelled. You're back in the pool. Type *MATCHES* to search again.`);
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
    user_id: user.user_id, issue_type: 'trip_issue',
    description: 'User reported issue via ISSUE command',
    created_at: new Date().toISOString(), resolved: false,
  });
  return sendText(phone, `Sorry to hear that! 😟\n\nWe've logged your issue and our team will look into it shortly.`);
}

// ── Notify waiting users ──────────────────────────────────────────────────────

async function notifyWaitingUsers(newUser, matchesForNewUser) {
  for (const match of matchesForNewUser.slice(0, 3)) {
    if (match.state === 'WAITING') {
      await sendText(match.phone, `Good news! A new match just appeared near you. Type *MATCHES* to view. 🚕`);
    }
  }
}

// ── Utility commands ──────────────────────────────────────────────────────────

async function sendHelp(phone) {
  return sendText(phone,
    `*AasPass Commands* ✈️\n\n` +
    `*hi / start* — Begin matching\n` +
    `*MATCHES* — View available matches\n` +
    `*CANCEL* — Cancel your request or match\n` +
    `*DONE* — Confirm trip completed\n` +
    `*ISSUE* — Report a problem\n` +
    `*STATUS* — Check your current status\n` +
    `*RESTART* — Start fresh\n` +
    `*STOP* — Unsubscribe\n` +
    `*HELP* — Show this list`
  );
}

async function sendStatus(phone) {
  const user = await getUser(phone);
  if (!user) return sendText(phone, `No active session. Send "hi" to get started!`);
  return sendText(phone,
    `*Your Status*\n\n` +
    `State: ${user.state}\n` +
    `Pickup: ${user.departure_airport || 'Not set'}\n` +
    `Drop: ${user.drop_zone || 'Not set'}\n` +
    `Active: ${user.is_active ? 'Yes' : 'No'}\n` +
    `Matched: ${user.is_matched ? 'Yes' : 'No'}`
  );
}

module.exports = { handleMessage };
