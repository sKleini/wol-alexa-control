// api/location.js – POST /api/location?key=<LOCATION_KEY>&u=<person name>
// Location ingest endpoint, fed by google_location_relay.py on the VPS
// (or any other source that can POST { lat, lon, tst, acc, address, batt }).
import { Redis } from '@upstash/redis'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.LOCATION_KEY || req.query.key !== process.env.LOCATION_KEY) return res.status(401).end();

  const personName = (req.query.u || process.env.DEFAULT_PERSON || '').trim();
  if (!personName) return res.status(400).json({ error: 'Missing person (u param or DEFAULT_PERSON)' });

  const persons = await redis.get('geo_persons') || [];
  const person = persons.find(p => p.name.toLowerCase() === personName.toLowerCase());
  if (!person) {
    console.warn(`Location update for unknown person: ${personName}`);
    return res.status(200).json({ ok: false, error: 'Unknown person' });
  }

  const body = req.body || {};
  const lat = parseFloat(body.lat);
  const lon = parseFloat(body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'Missing lat/lon' });

  const tst = parseInt(body.tst);
  const location = {
    lat,
    lon,
    tst: Number.isFinite(tst) ? tst : Math.floor(Date.now() / 1000),
    acc: Number.isFinite(parseFloat(body.acc)) ? parseFloat(body.acc) : null,
    address: body.address || null,
    batt: Number.isFinite(parseFloat(body.batt)) ? parseFloat(body.batt) : null,
    receivedAt: Math.floor(Date.now() / 1000),
  };

  await redis.set('person_location:' + person.name.toLowerCase(), location);
  return res.status(200).json({ ok: true });
}
