// api/presence.js – /api/presence?key=<LOCATION_KEY>&persons=Julia,Stefan&zone=zu%20Hause
// Read-only presence check for automations (e.g. the "auf Wiedersehen" relay on
// the VPS): for each requested person it reports whether their last known fix
// lies inside the named home zone, plus how old the fix is. The caller decides
// what "away" means (typically: home=false AND a fresh fix). Reuses the same
// person_location / geo_zones data as the "wo ist X" skill.
import { Redis } from '@upstash/redis'
import { haversineMeters } from '../lib/geo.js'
import { keyOk } from '../lib/auth.js'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!keyOk(req)) return res.status(401).end();

  // Duplicate names (a typo like "Julia,Julia") would otherwise yield repeated
  // entries, which break the shell caller's per-person jq lookup. Dedupe
  // case-insensitively and cap the list so one request cannot fan out into
  // thousands of Redis round-trips.
  const seen = new Set();
  const names = [];
  for (const raw of String(req.query.persons || '').split(',')) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= 20) break;
  }
  const zoneName = String(req.query.zone || '').trim();
  if (!names.length) return res.status(400).json({ error: 'Missing persons' });
  if (!zoneName) return res.status(400).json({ error: 'Missing zone' });

  const zones = await redis.get('geo_zones') || [];
  const zone = zones.find(z => (z.name || '').toLowerCase() === zoneName.toLowerCase());
  // Without a usable home zone we cannot decide presence – say so explicitly so
  // the caller stays conservative and does not act on bad data. An incomplete
  // zone (missing/NaN coordinates or radius) counts as "not found": silently
  // comparing against NaN would report everyone as away and fire the routine.
  const zoneUsable = zone
    && Number.isFinite(zone.lat) && Number.isFinite(zone.lng) && Number.isFinite(zone.radius);
  if (!zoneUsable) {
    return res.status(200).json({
      zoneFound: false,
      zone: zoneName,
      reason: zone ? 'zone_incomplete' : 'zone_missing',
      now: Math.floor(Date.now() / 1000),
      persons: [],
    });
  }

  // Persons must be known; otherwise a typo in the caller's config would look
  // exactly like "no fix yet" and silently disable the automation forever.
  const knownPersons = await redis.get('geo_persons') || [];
  const knownNames = new Set(knownPersons.map(p => (p.name || '').toLowerCase()));

  const now = Math.floor(Date.now() / 1000);
  const persons = await Promise.all(names.map(async name => {
    const known = knownNames.has(name.toLowerCase());
    const loc = await redis.get('person_location:' + name.toLowerCase());
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) {
      return { name, known, hasFix: false, home: null, ageSec: null };
    }
    const dist = haversineMeters(loc.lat, loc.lon, zone.lat, zone.lng);
    // A device with a fast-running clock yields tst > now. Clamping that to 0
    // would make an arbitrarily old fix look brand new and defeat the caller's
    // freshness check, so report the skew instead of hiding it.
    const rawAge = Number.isFinite(loc.tst) ? now - loc.tst : null;
    const skewed = rawAge !== null && rawAge < -60;
    return {
      name,
      known,
      hasFix: true,
      home: dist <= zone.radius,
      distanceMeters: Math.round(dist),
      tst: loc.tst,
      // null (= unknown) on skew, so the caller treats it conservatively
      // instead of accepting a stale fix as fresh.
      ageSec: rawAge === null || skewed ? null : rawAge,
      clockSkew: skewed,
    };
  }));

  return res.status(200).json({ zoneFound: true, zone: zone.name, now, persons });
}
