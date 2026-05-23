const supabase = require('../config/supabase');
const { getDistanceKm } = require('../utils/haversine');
const { sendText, sendButtons, sendList } = require('./whatsapp');

const DROP_RADIUS_KM   = 5; // drop destinations within 5km
const PICKUP_RADIUS_KM = 2; // pickup locations within 2km of each other

async function findMatches(user) {
  const { data: candidates, error } = await supabase
    .from('users')
    .select('*')
    .eq('is_matched', false)
    .eq('is_active', true)
    .neq('user_id', user.user_id);

  if (error) throw error;

  const ranked = candidates
    .map((c) => {
      const dropDist    = getDistanceKm(user.drop_lat, user.drop_long, c.drop_lat, c.drop_long);
      const pickupDist  = getDistanceKm(user.departure_lat, user.departure_long, c.departure_lat, c.departure_long);
      return { ...c, dropDist, pickupDist };
    })
    .filter((c) => c.dropDist <= DROP_RADIUS_KM && c.pickupDist <= PICKUP_RADIUS_KM)
    .sort((a, b) => a.dropDist - b.dropDist);

  return ranked;
}

async function sendMatchResults(user, matches) {
  if (matches.length === 0) {
    await sendText(
      user.phone,
      `You are the first one here! 🥇\n\nI've saved your spot and will notify you the moment someone matches.\n\n⏰ Your spot is held for *2 hours*.`
    );
    return;
  }

  const rows = matches.slice(0, 10).map((m, i) => ({
    id: `match_${m.user_id}`,
    title: `${i === 0 ? '⭐ ' : ''}${m.dropDist.toFixed(1)}km from your drop`,
    description: `📍 ${m.drop_zone || 'Nearby destination'}`,
  }));

  await sendList(
    user.phone,
    `🎉 Found *${matches.length}* match${matches.length > 1 ? 'es' : ''} near you!\n\nSelect someone to request a cab split:`,
    'View Matches',
    [{ title: 'Nearby Matches', rows }]
  );
}

async function sendMatchRequest(fromUser, toUser, distanceKm) {
  await sendButtons(
    toUser.phone,
    `Someone nearby wants to split a cab! 🚕\n\nTheir drop zone is *${distanceKm.toFixed(1)}km* from yours.\n\nDo you want to share?`,
    [
      { id: `ACCEPT_${fromUser.user_id}`,  title: '✅ Accept' },
      { id: `DECLINE_${fromUser.user_id}`, title: '❌ Decline' },
    ]
  );
}

module.exports = { findMatches, sendMatchResults, sendMatchRequest };
