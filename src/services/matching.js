const supabase = require('../config/supabase');
const { getDistanceKm } = require('../utils/haversine');
const { sendText, sendButtons, sendList } = require('./whatsapp');

const DROP_RADIUS_KM   = 5;     // drop destinations within 5 km
const PICKUP_RADIUS_KM = 0.5;   // pickup must be within 500 m (allows for urban GPS drift)

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
      // NS (not disclosed) users match with everyone regardless of preference
      const myGender   = user.gender || 'NS';
      const theirGender = c.gender   || 'NS';
      const theyMatchMe = !c.preferred_gender || c.preferred_gender === 'ANY'
        || c.preferred_gender === myGender || myGender === 'NS' || theirGender === 'NS';
      const iMatchThem  = !user.preferred_gender || user.preferred_gender === 'ANY'
        || user.preferred_gender === theirGender || myGender === 'NS' || theirGender === 'NS';
      return theyMatchMe && iMatchThem;
    })
    .map(c => {
      const dropDist   = getDistanceKm(user.drop_lat, user.drop_long, c.drop_lat, c.drop_long);
      const pickupDist = getDistanceKm(user.departure_lat, user.departure_long, c.departure_lat, c.departure_long);
      return { ...c, dropDist, pickupDist };
    })
    .filter(c => c.dropDist <= DROP_RADIUS_KM && c.pickupDist <= PICKUP_RADIUS_KM)
    .sort((a, b) => {
      // Same gender shown first (NS matches both, so doesn't get priority boost)
      const myGender = user.gender;
      const aScore = (myGender && myGender !== 'NS' && a.gender === myGender) ? 0 : 1;
      const bScore = (myGender && myGender !== 'NS' && b.gender === myGender) ? 0 : 1;
      if (aScore !== bScore) return aScore - bScore;
      return a.dropDist - b.dropDist; // then by distance
    });

  return ranked;
}

/**
 * Send match results to the user — either "you're first!" or a list of matches.
 */
async function sendMatchResults(user, matches) {
  if (matches.length === 0) {
    await sendText(
      user.phone,
      `No partners found yet 🕐\n\nYou're saved in the pool — I'll ping you the moment someone nearby joins.\n\nType *CANCEL* to leave or *EDIT* to update your trip.`
    );
    return;
  }

  const rows = matches.slice(0, 10).map((m, i) => {
    const dist  = m.dropDist.toFixed(1);
    const star  = i === 0 ? '⭐ ' : '';
    const title = `${star}${dist} km away`.slice(0, 24);
    const place = (m.drop_label || m.drop_zone || 'Nearby').slice(0, 40);
    const name  = (m.name || 'Anonymous').slice(0, 15);
    const description = `${name} • ${place}`.slice(0, 72);
    return { id: `match_${m.user_id}`, title, description };
  });

  await sendList(
    user.phone,
    `🎉 *${matches.length} partner${matches.length > 1 ? 's' : ''} found nearby!*\n\nTap a name to send them a cab-split request:`,
    'View Matches',
    [{ title: 'Nearby Partners', rows }]
  );
}

/**
 * Notify User B that User A wants to split.
 */
async function sendMatchRequest(fromUser, toUser, distanceKm) {
  const gLabel = fromUser.gender === 'M' ? 'Male' : fromUser.gender === 'F' ? 'Female' : fromUser.gender === 'NB' ? 'Non-binary' : '';
  const genderPart = gLabel ? ` (${gLabel})` : '';
  await sendButtons(
    toUser.phone,
    `🚕 *Cab-split request!*\n\n*${fromUser.name || 'Someone'}*${genderPart} wants to share a cab — their drop is *${distanceKm.toFixed(1)} km* from yours.\n\nInterested?`,
    [
      { id: `ACCEPT_${fromUser.user_id}`,  title: '✅ Accept'  },
      { id: `DECLINE_${fromUser.user_id}`, title: '❌ Decline' },
    ]
  );
}

module.exports = { findMatches, sendMatchResults, sendMatchRequest };
