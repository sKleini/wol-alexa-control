import { Redis } from '@upstash/redis'
import { buildLocationList } from '../lib/geo.js'
import { befehlAnPerson } from '../lib/ring.js'

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
  // Gemeinsame Implementierung mit /api/locations - siehe lib/geo.js.
  return res.status(200).json(await buildLocationList(redis));
}

/**
 * Sagt allen Handys, dass sie die Zonen neu holen sollen.
 *
 * **Der Anlass.** Mylo fragt `/api/zones` von sich aus nur alle sechs Stunden
 * ab (`Zonen.GUELTIG_MS`), und gemerkt wird die Faelligkeit erst beim naechsten
 * Standort-Lauf - bei einem Sendetakt von 90 Minuten also nach bis zu
 * siebeneinhalb Stunden, bei 720 nach bis zu achtzehn. So lange stand ein
 * frisch angelegter Zaun auf keinem einzigen Geraet, und im Dashboard sah es
 * aus, als sei er in Betrieb.
 *
 * **Ohne Ablage** (`hinterlegen: false`, siehe [befehlAnPerson]): Dieser Befehl
 * entsteht von selbst und trifft alle Personen auf einmal. Wuerde er sich in
 * den einen Rueckfall-Platz je Person legen, verdraengte er dort einen
 * wartenden Klingel-Wunsch - und auf den wartet jemand, waehrend auf den
 * Zonen-Abruf niemand wartet. Verpasst ein Handy den Push, holt der
 * Sechs-Stunden-Zyklus die Zonen ohnehin nach.
 *
 * **Fehler brechen nichts ab.** Die Zonen sind zu diesem Zeitpunkt gespeichert;
 * der Push ist die Abkuerzung, nicht der Weg - dieselbe Haltung wie beim
 * Zonenwechsel-Push in api/location.js.
 */
async function verteileZonen() {
  try {
    const persons = await redis.get('geo_persons') || [];
    await Promise.all(persons.map(p =>
      befehlAnPerson(redis, p.name, 'zones', { hinterlegen: false })
        .catch(err => console.warn(`Zonen-Push an ${p.name} fehlgeschlagen:`, err))
    ));
  } catch (err) {
    console.warn('Zonen-Verteilung fehlgeschlagen:', err);
  }
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

    // Die Heimzone: Mylo legt seinen Geofence um genau diese Zone (/api/zones).
    //
    // Fehlt das Feld im Body, bleibt der bisherige Wert stehen, statt auf false
    // zu fallen. Ein Aufrufer, der das Feld nicht kennt, soll eine Zone
    // korrigieren koennen, ohne nebenbei den Geofence auf dem Handy abzuraeumen -
    // ein Ausfall, den niemand mit der Radius-Aenderung in Verbindung braechte.
    //
    // Die Kehrseite: Ein Abwaehlen muss ausdruecklich als `home: false` kommen.
    // Das Dashboard schickt das Feld deshalb immer mit, und Workflow 18 schreibt
    // es per `.home = (.home // false)` aus, bevor er die Zonen hochlaedt.
    const home = 'home' in req.body
      ? !!req.body.home
      : (index > -1 ? !!zones[index].home : false);

    const entry = { name, lat, lng, radius, home };
    if (index > -1) zones[index] = entry;
    else zones.push(entry);

    // Genau eine Heimzone - dasselbe Muster wie `default` bei den Personen
    // oben. Mylo naehme sonst irgendeine der markierten, und ein Zaun um die
    // falsche Adresse sieht in der App aus wie einer um die richtige.
    if (home) {
      zones = zones.map(z =>
        z.name.toLowerCase() === name.toLowerCase() ? z : { ...z, home: false }
      );
    }

    await redis.set('geo_zones', zones);
    await verteileZonen();
    return res.status(200).json({ success: true, zones });
  }

  if (req.method === 'DELETE') {
    const name = (req.body.name || '').trim();
    zones = zones.filter(z => z.name.toLowerCase() !== name.toLowerCase());
    await redis.set('geo_zones', zones);
    // Auch beim Loeschen, und hier zaehlt es doppelt: Ein Zaun, den niemand
    // mehr will, umschliesst sonst stundenlang weiter eine Adresse.
    await verteileZonen();
    return res.status(200).json({ success: true, zones });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
