// lib/geo.js – shared helpers for the location feature (zones, geocoding, speech)

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function findZone(zones, lat, lon) {
  return zones.find(z => haversineMeters(lat, lon, z.lat, z.lng) <= z.radius) || null;
}

export function relativeTimeDe(unixSeconds) {
  // Without this guard an old record lacking `tst` produces NaN, which fails
  // every comparison below and makes Alexa literally say "vor NaN Tagen".
  if (!Number.isFinite(unixSeconds)) return "zu einem unbekannten Zeitpunkt";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (diff < 90) return "gerade eben";
  const minutes = Math.round(diff / 60);
  if (minutes < 60) return minutes === 1 ? "vor einer Minute" : `vor ${minutes} Minuten`;
  const hours = Math.round(diff / 3600);
  if (hours < 24) return hours === 1 ? "vor einer Stunde" : `vor ${hours} Stunden`;
  const days = Math.round(diff / 86400);
  return days === 1 ? "vor einem Tag" : `vor ${days} Tagen`;
}

export async function reverseGeocodeDe(redis, lat, lon) {
  // Guard before toFixed: a single malformed record would otherwise throw here
  // and take the whole request down with a 500.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "an einem unbekannten Ort";
  const cacheKey = `geocode:${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = await redis.get(cacheKey);
  if (cached && cached.text) return cached.text;

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=17&accept-language=de`;
    // Nominatim is a free service that can stall; Alexa gives up after ~8 s and
    // the function itself after 10 s, so cap the call well below that.
    const res = await fetch(url, {
      headers: { 'User-Agent': 'wol-alexa-control (https://github.com/sKleini/wol-alexa-control)' },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) throw new Error(`Nominatim status ${res.status}`);
    const data = await res.json();

    const addr = data.address || {};
    const road = addr.road || addr.pedestrian || addr.hamlet;
    const city = addr.city || addr.town || addr.village;
    let text;
    if (road && city) text = `in der ${road} in ${city}`;
    else if (city) text = `in ${city}`;
    else if (data.display_name) text = `in der Nähe von ${data.display_name.split(',').slice(0, 2).join(',')}`;
    else text = "an einem unbekannten Ort";

    await redis.set(cacheKey, { text }, { ex: 86400 });
    return text;
  } catch (err) {
    console.error("Reverse geocoding error:", err);
    return "an einem unbekannten Ort";
  }
}

// The SmartTag relay POSTs its health to /api/relay-status. When the
// SmartThings-Find session (JSESSIONID) has expired, it reports ok:false for
// the persons it serves. Returns true if THIS person is affected by an expired
// session, so the speech can name the cause instead of reading a stale fix.
async function relaySessionExpired(redis, person) {
  const relay = await redis.get('relay_status:smarttag');
  if (!relay || relay.ok !== false || relay.reason !== 'jsessionid_expired') return false;
  if (!Array.isArray(relay.persons)) return false;
  const wanted = person.name.toLowerCase();
  return relay.persons.some(p => typeof p === 'string' && p.toLowerCase() === wanted);
}

export async function buildLocationSpeech(redis, person) {
  // Both reads are independent – run them in parallel to save a round-trip on
  // Alexa's tight response budget.
  const [loc, sessionExpired] = await Promise.all([
    redis.get('person_location:' + person.name.toLowerCase()),
    relaySessionExpired(redis, person),
  ]);

  if (!loc) {
    if (sessionExpired) return `Ich kann den Standort von ${person.name} nicht abrufen, weil die Anmeldung bei Samsung abgelaufen ist und erneuert werden muss.`;
    return `Ich habe noch keinen Standort für ${person.name} empfangen.`;
  }

  const zones = await redis.get('geo_zones') || [];
  const zone = findZone(zones, loc.lat, loc.lon);

  let place;
  if (zone) place = zone.name;
  else if (loc.address) place = `in der Nähe von ${loc.address}`;
  // On the expired-session path we already know no fresh position is coming –
  // don't spend the (slow, external) geocoding call just to name a stale spot.
  else if (sessionExpired) place = null;
  else place = await reverseGeocodeDe(redis, loc.lat, loc.lon);

  const age = relativeTimeDe(loc.tst);
  if (sessionExpired) {
    const where = place ? ` Der letzte bekannte Standort war ${place}, zuletzt aktualisiert ${age}.`
                        : ` Die letzte bekannte Position ist von ${age}.`;
    return `Ich kann den aktuellen Standort von ${person.name} nicht abrufen, weil die Anmeldung bei Samsung abgelaufen ist.${where}`;
  }
  const stale = !Number.isFinite(loc.tst) || Math.floor(Date.now() / 1000) - loc.tst > 3600;
  if (stale) return `Der letzte bekannte Standort von ${person.name} ist ${place}, zuletzt aktualisiert ${age}.`;
  return `${person.name} ist ${place}, zuletzt aktualisiert ${age}.`;
}
