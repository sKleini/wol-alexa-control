// api/presence.js – /api/presence?key=<LOCATION_KEY>&persons=Julia,Stefan&zone=zu%20Hause
// Read-only presence check for automations (e.g. the "auf Wiedersehen" relay on
// the VPS): for each requested person it reports whether their last known fix
// lies inside the named home zone, plus how old the fix is. The caller decides
// what "away" means (typically: home=false AND a fresh fix). Reuses the same
// person_location / geo_zones data as the "wo ist X" skill.
import { Redis } from '@upstash/redis'
import { haversineMeters } from '../lib/geo.js'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.LOCATION_KEY || req.query.key !== process.env.LOCATION_KEY) return res.status(401).end();

  const names = String(req.query.persons || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const zoneName = String(req.query.zone || '').trim();
  if (!names.length) return res.status(400).json({ error: 'Missing persons' });
  if (!zoneName) return res.status(400).json({ error: 'Missing zone' });

  const zones = await redis.get('geo_zones') || [];
  const zone = zones.find(z => z.name.toLowerCase() === zoneName.toLowerCase());
  // Without a matching home zone we cannot decide presence – say so explicitly
  // so the caller stays conservative and does not act on bad data.
  if (!zone) {
    return res.status(200).json({ zoneFound: false, zone: zoneName, now: Math.floor(Date.now() / 1000), persons: [] });
  }

  const now = Math.floor(Date.now() / 1000);
  const persons = await Promise.all(names.map(async name => {
    const loc = await redis.get('person_location:' + name.toLowerCase());
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) {
      return { name, hasFix: false, home: null, ageSec: null };
    }
    const dist = haversineMeters(loc.lat, loc.lon, zone.lat, zone.lng);
    return {
      name,
      hasFix: true,
      home: dist <= zone.radius,
      distanceMeters: Math.round(dist),
      tst: loc.tst,
      ageSec: Number.isFinite(loc.tst) ? Math.max(0, now - loc.tst) : null,
    };
  }));

  return res.status(200).json({ zoneFound: true, zone: zone.name, now, persons });
}
