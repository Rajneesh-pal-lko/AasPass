const supabase = require('../config/supabase');
const { getDistanceKm } = require('../utils/haversine');
const { sendText, sendButtons, sendList } = require('./whatsapp');

const MATCH_RADIUS_KM = 5;

async function findMatches(user) {
  const { data: candidates, error } = await supabase
    .from('users')
    .select('*')
    .eq('flight_number', user.flight_number)
    .eq('is_matched', false)
    .eq('is_active', true)
    .neq('user_id', user.user_id);

  if (error) throw error;

  const ranked = candidates
    .map((c) => ({
      ...c,
      distanceKm: getDistanceKm(user.drop_lat, user.drop_long, c.drop_lat, c.drop_long),
    }))
    .filter((c) => c.distanceKm <= MATCH_RADIUS_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return ranked;
}

async function sendMatchResults(user, matches) {
  if (matches.length === 0) {
    await sendText(
      user.phone,
      `You are the first one! I have saved your spot.\n\nI will notify you the moment someone matches.\n\nYour spot is held for 2 hours. ✈️`
    );
    return;
  }

  const rows = matches.slice(0, 10).map((m, i) => ({
    id: `match_${m.user_id}`,
    title: `${i === 0 ? '⭐ ' : ''}${m.distanceKm.toFixed(1)}km from your drop`,
    description: `Drop zone: ${m.drop_zone}`,
  }));

  await sendList(
    user.phone,
    `Great news! I found ${matches.length} match${matches.length > 1 ? 'es' : ''} on your flight.\n\nSelect someone to request a cab split:`,
    'View Matches',
    [{ title: 'Nearby Matches', rows }]
  );
}

async function sendMatchRequest(fromUser, toUser, distanceKm) {
  await sendButtons(
    toUser.phone,
    `Someone on flight *${fromUser.flight_number}* wants to split a cab! 🚕\n\nTheir drop zone is *${distanceKm.toFixed(1)}km* from yours.\n\nDo you want to share?`,
    [
      { id: `ACCEPT_${fromUser.user_id}`, title: '✅ Accept' },
      { id: `DECLINE_${fromUser.user_id}`, title: '❌ Decline' },
    ]
  );
}

module.exports = { findMatches, sendMatchResults, sendMatchRequest };
