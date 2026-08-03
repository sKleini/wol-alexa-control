// api/zones.js – /api/zones (Header X-Location-Key, ersatzweise ?key=)
// Read-only list of the configured geo zones, including which one is the home
// zone. Used by the Mylo Android app to place its geofence.
//
// Deliberately NOT behind ADMIN_PASSWORD like /api/manage?type=zones: the phone
// only needs to read the fence it should watch, and the admin password would
// also unlock device management and wake-on-LAN. LOCATION_KEY is the key the
// family phones already carry (they use it to POST positions to /api/location),
// so this adds no new secret and no privilege the phones did not already have.
// Same reasoning, same shape as /api/locations.
//
// Why this endpoint exists at all: the home coordinates used to be compiled
// into the Mylo APK as BuildConfig constants. That APK is mirrored to a public
// repository so the app can self-update without a token — which put a home
// address on the open internet, while the very same values were masked out of
// the CI logs. The backend already knows the zones (workflow 18 seeds them), so
// the phone asks instead of carrying them.
import { Redis } from '@upstash/redis'
import { keyOk } from '../lib/auth.js'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // Fail-closed: ohne gesetzten LOCATION_KEY wird abgewiesen statt
  // durchgelassen (sonst gaebe ein vergessenes Env-Var die Wohnadresse heraus).
  if (!keyOk(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const zones = await redis.get('geo_zones') || [];
    // Feste Form statt der rohen Redis-Werte: Mylo liest lat/lng/radius/home,
    // und ein Altbestand ohne home-Feld soll dort als `false` ankommen und
    // nicht als `undefined`.
    return res.status(200).json({
      zones: zones.map(z => ({
        name: z.name,
        lat: z.lat,
        lng: z.lng,
        radius: z.radius,
        home: !!z.home,
      })),
    });
  } catch (err) {
    console.error('zones error:', err);
    return res.status(500).json({ error: 'Lookup failed' });
  }
}
