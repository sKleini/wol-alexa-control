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
  const cacheKey = `geocode:${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = await redis.get(cacheKey);
  if (cached && cached.text) return cached.text;

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=17&accept-language=de`;
    // Nominatim rejects requests without a descriptive User-Agent
    const res = await fetch(url, {
      headers: { 'User-Agent': 'wol-alexa-control (https://github.com/sKleini/wol-alexa-control)' }
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

export async function buildLocationSpeech(redis, person) {
  const loc = await redis.get('person_location:' + person.name.toLowerCase());
  if (!loc) return `Ich habe noch keinen Standort für ${person.name} empfangen.`;

  const zones = await redis.get('geo_zones') || [];
  const zone = findZone(zones, loc.lat, loc.lon);

  let place;
  if (zone) place = zone.name;
  else if (loc.address) place = `in der Nähe von ${loc.address}`;
  else place = await reverseGeocodeDe(redis, loc.lat, loc.lon);

  const age = relativeTimeDe(loc.tst);
  const stale = Math.floor(Date.now() / 1000) - loc.tst > 3600;
  if (stale) return `Der letzte bekannte Standort von ${person.name} ist ${place}, zuletzt aktualisiert ${age}.`;
  return `${person.name} ist ${place}, zuletzt aktualisiert ${age}.`;
}
