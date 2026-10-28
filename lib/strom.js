// lib/strom.js – /api/strom: Stromdaten vom VPS fuer den Actions Hub.
//
// Der VPS (Dienst strom-cloud, Repo wireguard-vps-strato) schiebt alle 5 min
// seine Stromdaten hierher, die App holt sie unterwegs ohne VPN ab. Alles, was
// hier ankommt, ist **Ende-zu-Ende verschluesselt** (AES-256-GCM, Schluessel
// nur auf dem VPS und in der App) - diese Funktion kann es nicht lesen und
// muss es auch nicht. Sie prueft nur Schluessel, Namen, Form und Groesse und
// legt jede Huelle unter `strom:<fach>` ab.
//
//   POST   (X-Strom-Push-Schluessel)  {faecher: {heute: <Huelle>, ...}}
//   GET    (X-Location-Key)           ?teile=heute,jahr:2026
//   DELETE (X-Strom-Push-Schluessel)  alle strom:*
//
// **Warum nicht api/strom.js.** Der Hobby-Tarif erlaubt zwoelf Funktionen, und
// api/ hat zwoelf. api/relay-status.js leitet hierher weiter, vercel.json
// schreibt /api/strom dorthin um.
//
// **Keine Anfrage, die abgewiesen wird, kostet einen Redis-Befehl:** Schluessel,
// Namen und Groesse werden vorher geprueft. Upstash rechnet je Befehl ab, und
// das Kontingent teilen sich Standorte, Alexa und Plattenkiste.
//
// Entwurf: docs/strom-fern-entwurf.md (Repo wireguard-vps-strato), Abschnitt 6.
import { createHash, timingSafeEqual } from 'node:crypto'
import { keyOk } from './auth.js'
import { queryOf } from './query.js'

export const FACH_MUSTER = /^(heute|jahr:\d{4}|kurve:\d{4}-\d{2}-\d{2})$/
export const KURVE_TTL_S = 5443200      // 63 Tage; die App zeigt 62
export const MAX_TEILE = 4
export const MAX_FAECHER = 70
export const MAX_BYTES = 1000000
export const MAX_C = 400000

const PRAEFIX = 'strom:';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest();

/**
 * Bringt die Anfrage den Push-Schluessel des VPS mit?
 *
 * Nur als Header: Query-Strings landen in Logs. Verglichen werden die
 * SHA-256-Werte beider Seiten mit timingSafeEqual - gleich lang, ohne
 * Zeitunterschied je nach Anzahl passender Zeichen. Fail-closed: ohne
 * gesetzte Variable immer false.
 */
export function pushSchluesselOk(req) {
  const erwartet = process.env.STROM_PUSH_SCHLUESSEL;
  const kommt = req.headers?.['x-strom-push-schluessel'];
  if (!erwartet || typeof kommt !== 'string') return false;
  return timingSafeEqual(sha256(kommt), sha256(erwartet));
}

function base64Ok(text, maxLaenge) {
  return typeof text === 'string' && text.length > 0 && text.length <= maxLaenge
    && text.length % 4 === 0 && BASE64.test(text);
}

/** Genau {v: 1, k, n, c} - mehr nimmt die Funktion nicht an. */
export function huelleOk(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return false;
  const felder = Object.keys(h).sort();
  if (felder.join(',') !== 'c,k,n,v') return false;
  if (h.v !== 1) return false;
  if (typeof h.k !== 'string' || !/^[0-9a-f]{8}$/.test(h.k)) return false;
  if (!base64Ok(h.n, 16) || Buffer.from(h.n, 'base64').length !== 12) return false;
  return base64Ok(h.c, MAX_C);
}

function rumpf(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return null; }
  }
  return body && typeof body === 'object' ? body : null;
}

async function schreibe(req, res, redis) {
  const faecher = rumpf(req)?.faecher;
  if (!faecher || typeof faecher !== 'object' || Array.isArray(faecher)) {
    return res.status(400).json({ error: 'Missing faecher' });
  }
  const namen = Object.keys(faecher);
  if (namen.length === 0 || namen.length > MAX_FAECHER) {
    return res.status(400).json({ error: 'Invalid number of faecher' });
  }
  for (const name of namen) {
    if (!FACH_MUSTER.test(name)) return res.status(400).json({ error: 'Invalid fach' });
    if (!huelleOk(faecher[name])) return res.status(400).json({ error: 'Invalid huelle' });
  }
  if (Buffer.byteLength(JSON.stringify(faecher)) > MAX_BYTES) {
    return res.status(413).json({ error: 'Too large' });
  }
  const pipeline = redis.pipeline();
  for (const name of namen) {
    if (name.startsWith('kurve:')) pipeline.set(PRAEFIX + name, faecher[name], { ex: KURVE_TTL_S });
    else pipeline.set(PRAEFIX + name, faecher[name]);
  }
  await pipeline.exec();
  return res.status(200).json({ ok: true, gespeichert: namen.length });
}

async function lies(req, res, redis) {
  const roh = queryOf(req).teile;
  if (typeof roh !== 'string' || !roh) return res.status(400).json({ error: 'Missing teile' });
  const teile = [...new Set(roh.split(','))];
  if (teile.length > MAX_TEILE || !teile.every(t => FACH_MUSTER.test(t))) {
    return res.status(400).json({ error: 'Invalid teile' });
  }
  const werte = await redis.mget(...teile.map(t => PRAEFIX + t));
  const antwort = {};
  teile.forEach((t, i) => { antwort[t] = werte[i] ?? null; });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ teile: antwort });
}

async function loesche(res, redis) {
  const schluessel = [];
  let cursor = '0';
  do {
    const [weiter, gefunden] = await redis.scan(cursor, { match: PRAEFIX + '*', count: 200 });
    schluessel.push(...gefunden);
    cursor = String(weiter);
  } while (cursor !== '0');
  const geloescht = schluessel.length ? await redis.del(...schluessel) : 0;
  return res.status(200).json({ ok: true, geloescht });
}

export async function handleStrom(req, res, redis) {
  try {
    if (req.method === 'GET') {
      if (!keyOk(req)) return res.status(401).json({ error: 'Unauthorized' });
      return await lies(req, res, redis);
    }
    if (req.method === 'POST' || req.method === 'DELETE') {
      if (!pushSchluesselOk(req)) return res.status(401).json({ error: 'Unauthorized' });
      return req.method === 'POST' ? await schreibe(req, res, redis) : await loesche(res, redis);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('strom error:', err?.message);
    return res.status(500).json({ error: 'Strom failed' });
  }
}
