// api/relay-status.js – /api/relay-status?key=<LOCATION_KEY>
// Health endpoint for the VPS SmartTag relay. The relay POSTs its status after
// each run: ok:true on success, ok:false (reason "jsessionid_expired") when the
// SmartThings-Find session has expired. buildLocationSpeech reads the stored
// status so Alexa can tell the user the login expired instead of reading a
// stale position. GET returns the current status (e.g. for a dashboard badge).
import { Redis } from '@upstash/redis'
import { keyOk } from '../lib/auth.js'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

const STATUS_KEY = 'relay_status:smarttag'

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!keyOk(req)) return res.status(401).end();

  if (req.method === 'GET') {
    const status = await redis.get(STATUS_KEY);
    return res.status(200).json(status || null);
  }

  // Normally Vercel parses application/json for us; fall back for a raw string
  // body so a wrong Content-Type cannot silently store {ok:false}.
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }
  if (typeof body !== 'object' || body === null) return res.status(400).json({ error: 'Invalid body' });
  const persons = Array.isArray(body.persons)
    ? body.persons.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim())
    : [];

  const status = {
    ok: !!body.ok,
    reason: typeof body.reason === 'string' ? body.reason : null,
    error: typeof body.error === 'string' ? body.error : null,
    persons,
    at: Math.floor(Date.now() / 1000),
  };

  await redis.set(STATUS_KEY, status);
  return res.status(200).json({ ok: true });
}
