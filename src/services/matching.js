const supabase = require('../config/supabase');
const { getDistanceKm } = require('../utils/haversine');
const { sendText, sendButtons, sendList } = require('./whatsapp');

const DROP_RADIUS_KM   = 5;     // drop destinations within 5 km
const PICKUP_RADIUS_KM = 0.3;   // pickup must be within 300 m

/**
 * Find ranked match candidates for a given user.
 * Applies: distance filter, gender preference filter, block filter.
 */
async function findMatches(user) {
  // Fetch all active, unmatched users except self
  const { data: candidates, error } = await supabase
    .from('users')
    .select('*')
    .eq('is_matched', false)
    .eq('is_active', true)
    .neq('user_id', user.user_id);

  if (error) throw error;

  // Fetch blocks in both directions involving this user
  const { data: blocks } = await supabase
    .from('blocked_users')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${user.user_id},blocked_id.eq.${user.user_id}`);

  const blockedIds = new Set(
    (blocks || []).map(b =>
      b.blocker_id === user.user_id ? b.blocked_id : b.blocker_id
    )
  );

  const ranked = candidates
    .filter(c => !blockedIds.has(c.user_id))
    .filter(c => {
      // Gender preference filtering (both ways must agree)
      const theyMatchMe = !c.preferred_gender || c.preferred_gender === 'ANY' || c.preferred_gender === user.gender;
      const iMatchThem  = !user.preferred_gender || user.preferred_gender === 'ANY' || user.preferred_gender === c.gender;
      return theyMatchMe && iMatchThem;
    })
    .map(c => {
      const dropDist   = getDistanceKm(user.drop_lat, user.drop_long, c.drop_lat, c.drop_long);
      const pickupDist = getDistanceKm(user.departure_lat, user.departure_long, c.departure_lat, c.departure_long);
      return { ...c, dropDist, pickupDist };
    })
    .filter(c => c.dropDist <= DROP_RADIUS_KM && c.pickupDist <= PICKUP_RADIUS_KM)
    .sort((a, b) => a.dropDist - b.dropDist);

  return ranked;
}

/**
 * Send match results to the user — either "you're first!" or a list of matches.
 */
async function sendMatchResults(user, matches) {
  if (matches.length === 0) {
    await sendText(
      user.phone,
      `You're the first one here! 🥇\n\nI've saved your spot and will notify you the moment someone nearby joins.\n\n⏰ Your spot is held for *10 minutes* and can be extended once.`
    );
    return;
  }

  const rows = matches.slice(0, 10).map((m, i) => ({
    id: `match_${m.user_id}`,
    title: `${i === 0 ? '⭐ Best Match — ' : ''}${m.dropDist.toFixed(1)} km away`,
    description: `📍 ${m.drop_label || m.drop_zone || 'Nearby destination'}  •  ${m.name || 'Anonymous'}`,
  }));

  await sendList(
    user.phone,
    `🎉 Found *${matches.length}* match${matches.length > 1 ? 'es' : ''} near you!\n\nSelect someone to send a cab-split request:`,
    'View Matches',
    [{ title: 'Nearby Matches', rows }]
  );
}

/**
 * Notify User B that User A wants to split.
 */
async function sendMatchRequest(fromUser, toUser, distanceKm) {
  const genderLabel = fromUser.gender === 'M' ? 'Male' : fromUser.gender === 'F' ? 'Female' : 'Non-binary';
  await sendButtons(
    toUser.phone,
    `Someone nearby wants to split a cab! 🚕\n\n*${fromUser.name || 'Someone'}* (${genderLabel}) wants to share to a drop *${distanceKm.toFixed(1)} km* from yours.\n\nDo you want to share?`,
    [
      { id: `ACCEPT_${fromUser.user_id}`,  title: '✅ Accept' },
      { id: `DECLINE_${fromUser.user_id}`, title: '❌ Decline' },
    ]
  );
}

module.exports = { findMatches, sendMatchResults, sendMatchRequest };
