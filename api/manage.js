import { Redis } from '@upstash/redis'
import { findZone, relativeTimeDe } from '../lib/geo.js'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export default async function handler(req, res) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const providedPassword = req.headers['x-admin-password'];

  if (!adminPassword || providedPassword !== adminPassword) {
    return res.status(401).json({ error: 'Unauthorized: Incorrect password or not configured on Vercel' });
  }

  if (req.query.type === 'persons') return handlePersons(req, res);
  if (req.query.type === 'zones') return handleZones(req, res);
  if (req.query.type === 'locations') return handleLocations(req, res);

  if (req.method === 'POST') {
    const { mac, name } = req.body;
    if (!mac || !name) return res.status(400).json({ error: 'Missing data' });
    let devices = await redis.get('wol_devices') || [];

    const index = devices.findIndex(d => d.mac === mac);
    if (index > -1) devices[index] = { mac, name };
    else devices.push({ mac, name });

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

  const result = await Promise.all(persons.map(async p => {
    const loc = await redis.get('person_location:' + p.name.toLowerCase());
    if (!loc) return { name: p.name, default: !!p.default, location: null };

    const zone = findZone(zones, loc.lat, loc.lon);
    return {
      name: p.name,
      default: !!p.default,
      location: {
        lat: loc.lat,
        lon: loc.lon,
        place: zone ? zone.name : (loc.address || `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`),
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
