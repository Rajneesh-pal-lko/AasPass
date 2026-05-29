const supabase = require('../config/supabase');
const { getDistanceKm } = require('../utils/haversine');
const { sendText, sendButtons, sendList } = require('./whatsapp');

const DROP_RADIUS_KM   = 7;     // drop destinations within 7 km → direct match
const ON_THE_WAY_KM    = 7;     // max extra detour allowed for "on the way" matches
const PICKUP_RADIUS_KM = 0.5;   // pickup must be within 500 m (allows for urban GPS drift)

/**
 * Check if dropping User A first adds an acceptable detour before reaching User B's drop.
 *
 * Extra detour = (Airport→A) + (A→B) − (Airport→B)
 * If that extra distance ≤ ON_THE_WAY_KM, A is roughly on the route to B.
 * We check both orderings (A first, then B) and (B first, then A).
 *
 * Returns: { onTheWay: bool, detourKm: number, totalRouteKm: number, dropFirstUser: 'me'|'them' }
 */
function checkOnTheWay(user, candidate) {
  const airportLat = user.departure_lat
  const airportLon = user.departure_long

  const airportToMe   = getDistanceKm(airportLat, airportLon, user.drop_lat,      user.drop_long)
  const airportToThem = getDistanceKm(airportLat, airportLon, candidate.drop_lat, candidate.drop_long)
  const meTothem      = getDistanceKm(user.drop_lat, user.drop_long, candidate.drop_lat, candidate.drop_long)

  // Option 1: drop ME first, then THEM
  // Route: Airport → my drop → their drop
  const detourIfMeFirst   = (airportToMe + meTothem) - airportToThem
  const totalIfMeFirst    = airportToMe + meTothem

  // Option 2: drop THEM first, then ME
  // Route: Airport → their drop → my drop
  const detourIfThemFirst = (airportToThem + meTothem) - airportToMe
  const totalIfThemFirst  = airportToThem + meTothem

  // Pick the option with the smaller detour
  if (detourIfMeFirst <= detourIfThemFirst && detourIfMeFirst <= ON_THE_WAY_KM) {
    return { onTheWay: true, detourKm: detourIfMeFirst, totalRouteKm: totalIfMeFirst, dropFirst: 'me' }
  }
  if (detourIfThemFirst <= ON_THE_WAY_KM) {
    return { onTheWay: true, detourKm: detourIfThemFirst, totalRouteKm: totalIfThemFirst, dropFirst: 'them' }
  }
  return { onTheWay: false, detourKm: Math.min(detourIfMeFirst, detourIfThemFirst), totalRouteKm: 0, dropFirst: null }
}

/**
 * Find ranked match candidates for a given user.
 * Applies: distance filter, on-the-way filter, gender preference filter, block filter.
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
      const myGender    = user.gender || 'NS';
      const theirGender = c.gender    || 'NS';
      const theyMatchMe = !c.preferred_gender || c.preferred_gender === 'ANY'
        || c.preferred_gender === myGender || myGender === 'NS' || theirGender === 'NS';
      const iMatchThem  = !user.preferred_gender || user.preferred_gender === 'ANY'
        || user.preferred_gender === theirGender || myGender === 'NS' || theirGender === 'NS';
      return theyMatchMe && iMatchThem;
    })
    .map(c => {
      const dropDist   = getDistanceKm(user.drop_lat, user.drop_long, c.drop_lat, c.drop_long);
      const pickupDist = getDistanceKm(user.departure_lat, user.departure_long, c.departure_lat, c.departure_long);
      const onTheWayInfo = dropDist > DROP_RADIUS_KM ? checkOnTheWay(user, c) : null;
      // matchType: 'nearby' = within 7km, 'on_the_way' = route detour within limit
      const matchType  = dropDist <= DROP_RADIUS_KM ? 'nearby' : (onTheWayInfo?.onTheWay ? 'on_the_way' : null);
      return { ...c, dropDist, pickupDist, matchType, onTheWayInfo }
    })
    .filter(c => c.matchType !== null && c.pickupDist <= PICKUP_RADIUS_KM)
    .sort((a, b) => {
      // nearby matches ranked above on_the_way matches
      if (a.matchType !== b.matchType) {
        return a.matchType === 'nearby' ? -1 : 1;
      }
      // Same gender shown first within each tier
      const myGender = user.gender;
      const aScore = (myGender && myGender !== 'NS' && a.gender === myGender) ? 0 : 1;
      const bScore = (myGender && myGender !== 'NS' && b.gender === myGender) ? 0 : 1;
      if (aScore !== bScore) return aScore - bScore;
      return a.dropDist - b.dropDist; // then by drop distance
    });

  return ranked;
}

/**
 * Rough cab fare estimate for RGIA → anywhere in Hyderabad (₹ per full cab).
 * Based on typical Ola/Uber pricing: ~₹15/km base + ₹150 minimum.
 */
function estimateSavings(dropDistKm) {
  // Use 25 km as a rough average distance from RGIA to Hyderabad city
  const avgFare = Math.round(150 + 25 * 15); // ₹525
  const perPerson = Math.round(avgFare / 2);
  return perPerson; // ₹262 — round numbers feel more trustworthy
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

  const savings = estimateSavings();
  const rows = matches.slice(0, 10).map((m, i) => {
    const star  = i === 0 ? '⭐ ' : '';
    const place = (m.drop_label || m.drop_zone || 'Nearby').slice(0, 40);
    const name  = (m.name || 'Anonymous').slice(0, 15);

    let title, description

    if (m.matchType === 'on_the_way') {
      // Show total route km and extra detour so user knows what to expect
      const total  = m.onTheWayInfo.totalRouteKm.toFixed(1);
      const detour = m.onTheWayInfo.detourKm.toFixed(1);
      const order  = m.onTheWayInfo.dropFirst === 'me'
        ? 'you drop first'
        : 'they drop first';
      title       = `${star}🛣 ${total} km route`.slice(0, 24);
      description = `${name} • +${detour} km detour (${order}) • ${place}`.slice(0, 72);
    } else {
      // nearby match — simple distance display
      const dist  = m.dropDist.toFixed(1);
      title       = `${star}${dist} km away`.slice(0, 24);
      description = `${name} • ${place}`.slice(0, 72);
    }

    return { id: `match_${m.user_id}`, title, description };
  });

  // Split into sections so nearby and on-the-way matches are visually grouped
  const nearbyRows   = rows.filter((_, i) => matches[i].matchType === 'nearby');
  const onTheWayRows = rows.filter((_, i) => matches[i].matchType === 'on_the_way');

  const sections = [];
  if (nearbyRows.length)   sections.push({ title: '📍 Nearby Drops',    rows: nearbyRows });
  if (onTheWayRows.length) sections.push({ title: '🛣 On The Way',       rows: onTheWayRows });

  await sendList(
    user.phone,
    `🎉 *${matches.length} partner${matches.length > 1 ? 's' : ''} found!*\n\n` +
    `💰 Split the cab and save *~₹${savings} each*!\n\n` +
    `Tap a name to send them a cab-split request:`,
    'View Matches',
    sections
  );
}

/**
 * Notify User B that User A wants to split.
 * matchInfo is optional — passed when the match is "on_the_way" type.
 */
async function sendMatchRequest(fromUser, toUser, distanceKm, matchInfo = null) {
  const gLabel = fromUser.gender === 'M' ? 'Male' : fromUser.gender === 'F' ? 'Female' : fromUser.gender === 'NB' ? 'Non-binary' : '';
  const genderPart = gLabel ? ` (${gLabel})` : '';

  let routeLine
  if (matchInfo?.onTheWay) {
    const total  = matchInfo.totalRouteKm.toFixed(1);
    const detour = matchInfo.detourKm.toFixed(1);
    const order  = matchInfo.dropFirst === 'them'
      ? `your drop is first, then theirs`
      : `their drop is first, then yours`;
    routeLine = `🛣 Total cab route: *${total} km* (+${detour} km detour — ${order})`
  } else {
    routeLine = `📍 Their drop is *${distanceKm.toFixed(1)} km* from yours`
  }

  await sendButtons(
    toUser.phone,
    `🚕 *Cab-split request!*\n\n*${fromUser.name || 'Someone'}*${genderPart} wants to share a cab.\n\n${routeLine}\n\nInterested?`,
    [
      { id: `ACCEPT_${fromUser.user_id}`,  title: '✅ Accept'  },
      { id: `DECLINE_${fromUser.user_id}`, title: '❌ Decline' },
    ]
  );
}

module.exports = { findMatches, sendMatchResults, sendMatchRequest };
