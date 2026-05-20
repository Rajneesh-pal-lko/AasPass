function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Known airports: [lat, lon, radius_km]
const AIRPORTS = {
  HYD: { name: 'Hyderabad (RGIA)', lat: 17.2403, lon: 78.4294 },
  BLR: { name: 'Bangalore (KIA)',  lat: 13.1986, lon: 77.7066 },
  DEL: { name: 'Delhi (IGI)',      lat: 28.5562, lon: 77.1000 },
};

function detectAirport(lat, lon, radiusKm = 2) {
  for (const [code, airport] of Object.entries(AIRPORTS)) {
    const dist = getDistanceKm(lat, lon, airport.lat, airport.lon);
    if (dist <= radiusKm) return { code, ...airport, distanceKm: dist };
  }
  return null;
}

module.exports = { getDistanceKm, detectAirport, AIRPORTS };
