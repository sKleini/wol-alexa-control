import { Redis } from '@upstash/redis'
import { findZone, relativeTimeDe } from '../lib/geo.js'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

// Ohne Bremse laesst sich das Admin-Passwort unbegrenzt schnell durchprobieren.
// Zaehler pro IP im ohnehin vorhandenen Redis, Fenster 15 Minuten.
const MAX_FAILED = 10;
const WINDOW_SEC = 900;

async function tooManyFailures(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const key = `admin_fail:${ip}`;
  const count = await redis.get(key);
  return { key, blocked: Number(count) >= MAX_FAILED };
}

export default async function handler(req, res) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const providedPassword = req.headers['x-admin-password'];

  let limiter = { key: null, blocked: false };
  try {
    limiter = await tooManyFailures(req);
  } catch (err) {
    console.error('Rate-limit lookup failed:', err);
  }
  if (limiter.blocked) {
    return res.status(429).json({ error: 'Too many failed attempts, try again later' });
  }

  if (!adminPassword || providedPassword !== adminPassword) {
    if (limiter.key) {
      try {
        await redis.incr(limiter.key);
        await redis.expire(limiter.key, WINDOW_SEC);
      } catch (err) {
        console.error('Rate-limit update failed:', err);
      }
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (limiter.key) {
    try { await redis.del(limiter.key); } catch { /* nicht kritisch */ }
  }

  if (req.query.type === 'persons') return handlePersons(req, res);
  if (req.query.type === 'zones') return handleZones(req, res);
  if (req.query.type === 'locations') return handleLocations(req, res);

  if (req.method === 'POST') {
    const { mac, name } = req.body || {};
    if (!mac || !name) return res.status(400).json({ error: 'Missing data' });
    // Serverseitig validieren und normalisieren: eine krumme MAC erzeugt sonst
    // eine ungueltige endpointId, an der Alexa die GESAMTE Discovery verwirft.
    const normalized = String(mac).trim().toLowerCase().replace(/[\s-]/g, ':');
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(normalized)) {
      return res.status(400).json({ error: 'Invalid MAC address' });
    }
    const cleanName = String(name).trim().slice(0, 64);
    if (!cleanName) return res.status(400).json({ error: 'Missing data' });
    let devices = await redis.get('wol_devices') || [];

    const index = devices.findIndex(d => (d.mac || '').toLowerCase() === normalized);
    const entry = { mac: normalized, name: cleanName };
    if (index > -1) devices[index] = entry;
    else devices.push(entry);

    await redis.set('wol_devices', devices);
    return res.status(200).json({ success: true, devices });
  }

  if (req.method === 'DELETE') {
    const { mac } = req.body;
    let devices = await redis.get('wol_devices') || [];
    devices = devices.filter(d => d.mac !== mac);
    await redis.set('wol_devices', devices);
    return res.status(200).json({ success: true, devices });
  }

  if (req.method === 'GET') {
    let devices = await redis.get('wol_devices');

    if (!devices || devices.length === 0) {
      const oldConfig = await redis.get('wol_config');
      if (oldConfig && oldConfig.mac) {
        devices = [oldConfig];
        await redis.set('wol_devices', devices);
      } else {
        devices = [];
      }
    }

    return res.status(200).json(devices);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function handlePersons(req, res) {
  let persons = await redis.get('geo_persons') || [];

  if (req.method === 'GET') return res.status(200).json(persons);

  if (req.method === 'POST') {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Missing data' });
    const isDefault = !!req.body.default;

    if (isDefault) persons = persons.map(p => ({ ...p, default: false }));

    const index = persons.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    const entry = { name, default: isDefault };
    if (index > -1) persons[index] = entry;
    else persons.push(entry);

    await redis.set('geo_persons', persons);
    return res.status(200).json({ success: true, persons });
  }

  if (req.method === 'DELETE') {
    const name = (req.body.name || '').trim();
    persons = persons.filter(p => p.name.toLowerCase() !== name.toLowerCase());
    await redis.set('geo_persons', persons);
    await redis.del('person_location:' + name.toLowerCase());
    return res.status(200).json({ success: true, persons });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleLocations(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const persons = await redis.get('geo_persons') || [];
  const zones = await redis.get('geo_zones') || [];

  // Relay reports an expired SmartThings session (JSESSIONID) for the SmartTag
  // persons it serves; surface it per person so the dashboard can badge it.
  const relay = await redis.get('relay_status:smarttag');
  const expiredPersons = (relay && relay.ok === false && relay.reason === 'jsessionid_expired'
    && Array.isArray(relay.persons))
    ? relay.persons.map(n => String(n).toLowerCase())
    : [];

  // A relay that stops reporting entirely (cron removed, VPS down) would keep
  // its last ok:true forever and look healthy. Surface how old the report is so
  // the dashboard can flag silence.
  const nowSec = Math.floor(Date.now() / 1000);
  const relayAgeSec = (relay && Number.isFinite(relay.at)) ? Math.max(0, nowSec - relay.at) : null;
  const relayPersons = (relay && Array.isArray(relay.persons))
    ? relay.persons.map(n => String(n).toLowerCase())
    : [];
  const RELAY_SILENT_AFTER_SEC = 3 * 3600;

  const result = await Promise.all(persons.map(async p => {
    const key = (p.name || '').toLowerCase();
    const sessionExpired = expiredPersons.includes(key);
    // Only persons the relay actually serves can be reported as "silent".
    const relaySilent = relayPersons.includes(key)
      && relayAgeSec !== null && relayAgeSec > RELAY_SILENT_AFTER_SEC;
    const loc = await redis.get('person_location:' + key);
    if (!loc) return { name: p.name, default: !!p.default, location: null, sessionExpired, relaySilent };

    const zone = findZone(zones, loc.lat, loc.lon);
    const hasCoords = Number.isFinite(loc.lat) && Number.isFinite(loc.lon);
    return {
      name: p.name,
      default: !!p.default,
      sessionExpired,
      relaySilent,
      location: {
        lat: loc.lat,
        lon: loc.lon,
        // Guard toFixed: one malformed record would otherwise 500 the whole list.
        place: zone ? zone.name
          : (loc.address || (hasCoords ? `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}` : 'unbekannte Position')),
        age: relativeTimeDe(loc.tst),
        batt: loc.batt,
      },
    };
  }));

  return res.status(200).json(result);
}

async function handleZones(req, res) {
  let zones = await redis.get('geo_zones') || [];

  if (req.method === 'GET') return res.status(200).json(zones);

  if (req.method === 'POST') {
    const name = (req.body.name || '').trim();
    const lat = parseFloat(req.body.lat);
    const lng = parseFloat(req.body.lng);
    const radius = parseFloat(req.body.radius);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius)) {
      return res.status(400).json({ error: 'Missing data' });
    }

    const index = zones.findIndex(z => z.name.toLowerCase() === name.toLowerCase());
    const entry = { name, lat, lng, radius };
    if (index > -1) zones[index] = entry;
    else zones.push(entry);

    await redis.set('geo_zones', zones);
    return res.status(200).json({ success: true, zones });
  }

  if (req.method === 'DELETE') {
    const name = (req.body.name || '').trim();
    zones = zones.filter(z => z.name.toLowerCase() !== name.toLowerCase());
    await redis.set('geo_zones', zones);
    return res.status(200).json({ success: true, zones });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
