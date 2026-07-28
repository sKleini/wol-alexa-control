// api/locations.js – /api/locations?key=<LOCATION_KEY>
// Read-only list of every tracked person with their current place, how old the
// fix is, battery level and the relay status badges. Used by the Actions-Hub
// Android app ("Standorte"-Tab).
//
// Deliberately NOT behind ADMIN_PASSWORD like /api/manage?type=locations: the
// app only needs to read positions, and the admin password would also unlock
// device management and wake-on-LAN. LOCATION_KEY is the key the family phones
// already carry (the OwnTracks/Standort-App uses it to POST positions), so this
// adds no new secret and no privilege the phones did not already have.
import { Redis } from '@upstash/redis'
import { buildLocationList } from '../lib/geo.js'
import { keyOk } from '../lib/auth.js'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // Fail-closed: ohne gesetzten LOCATION_KEY wird abgewiesen statt
  // durchgelassen (sonst wuerde ein vergessenes Env-Var die Standorte der
  // ganzen Familie oeffentlich machen).
  if (!keyOk(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const persons = await buildLocationList(redis);
    return res.status(200).json({
      now: Math.floor(Date.now() / 1000),
      persons,
    });
  } catch (err) {
    console.error('locations error:', err);
    return res.status(500).json({ error: 'Lookup failed' });
  }
}
