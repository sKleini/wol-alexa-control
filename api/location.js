// api/location.js – /api/location?key=<LOCATION_KEY>&u=<person name>
// Location ingest endpoint. Source-agnostic: fields may come from a JSON
// body (POST, e.g. OwnTracks) or from query parameters (GET/POST, e.g.
// GPSLogger's custom URL with %LAT/%LON/%ACC/%BATT placeholders).
import { Redis } from '@upstash/redis'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.LOCATION_KEY || req.query.key !== process.env.LOCATION_KEY) return res.status(401).end();

  const personName = (req.query.u || process.env.DEFAULT_PERSON || '').trim();
  if (!personName) return res.status(400).json({ error: 'Missing person (u param or DEFAULT_PERSON)' });

  const persons = await redis.get('geo_persons') || [];
  const person = persons.find(p => p.name.toLowerCase() === personName.toLowerCase());
  if (!person) {
    console.warn(`Location update for unknown person: ${personName}`);
    return res.status(200).json({ ok: false, error: 'Unknown person' });
  }

  // Prefer JSON body (keeps existing behavior), fall back to query params.
  const body = req.body || {};
  const pick = (k) => (body[k] ?? req.query[k]);
  const lat = parseFloat(pick('lat'));
  const lon = parseFloat(pick('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'Missing lat/lon' });

  const tst = parseInt(pick('tst'));
  const location = {
    lat,
    lon,
    tst: Number.isFinite(tst) ? tst : Math.floor(Date.now() / 1000),
    acc: Number.isFinite(parseFloat(pick('acc'))) ? parseFloat(pick('acc')) : null,
    address: pick('address') || null,
    batt: Number.isFinite(parseFloat(pick('batt'))) ? parseFloat(pick('batt')) : null,
    receivedAt: Math.floor(Date.now() / 1000),
  };

  await redis.set('person_location:' + person.name.toLowerCase(), location);
  return res.status(200).json({ ok: true });
}
