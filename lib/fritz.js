// lib/fritz.js – FRITZ! Smart Home im Smart Home Skill: Heizkoerperregler,
// Steckdosen und Vorlagen des Routers FRITZ!Box 7590AX in Weinsheim.
//
// Der VPS (Dienst fritz-smarthome-relay, Repo wireguard-vps-strato, Workflow
// 41) liest die Box alle 60 s ueber den wg1-Tunnel und schiebt den Stand
// hierher; Alexa bekommt Discovery und ReportState aus diesem Stand, ohne dass
// jemand die Box fragt. Befehle gehen als ntfy-Nachricht an das Relay zurueck:
//
//   POST /api/fritz   (X-Fritz-Push-Schluessel)  Stand vom VPS -> Redis fritz:stand
//   api/alexa.js      Discover / ReportState / Thermostat / Schalter / Szene
//
// **Warum nicht api/fritz.js.** Der Hobby-Tarif erlaubt zwoelf Funktionen, und
// api/ hat zwoelf. api/relay-status.js leitet hierher weiter, vercel.json
// schreibt /api/fritz dorthin um.
//
// **Keine abgewiesene Anfrage kostet einen Redis-Befehl:** Schluessel, Groesse
// und Form werden vorher geprueft - Upstash rechnet je Befehl ab.
//
// Entwurf: docs/fritz-smarthome-entwurf.md (Repo wireguard-vps-strato).
import { createHash, timingSafeEqual } from 'node:crypto'

export const FRITZ_SCHLUESSEL = 'fritz:stand'
export const MAX_ALTER_S = 900          // drei verpasste Lebenszeichen (alle 5 min)
export const MAX_BYTES = 65536
export const MAX_GERAETE = 100
export const MAX_VORLAGEN = 50

const ID_MUSTER = /^[0-9a-z-]{1,40}$/;
const MODI = new Set(['HEAT', 'ECO', 'OFF']);

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest();

/** Bringt die Anfrage den Push-Schluessel des VPS mit? Fail-closed. */
export function pushSchluesselOk(req) {
  const erwartet = process.env.FRITZ_PUSH_SCHLUESSEL;
  const kommt = req.headers?.['x-fritz-push-schluessel'];
  if (!erwartet || typeof kommt !== 'string') return false;
  return timingSafeEqual(sha256(kommt), sha256(erwartet));
}

const zahlOderNull = (w) => w === null || (typeof w === 'number' && Number.isFinite(w));
const text = (w, max = 100) => typeof w === 'string' && w.length > 0 && w.length <= max;

function geraetOk(g) {
  if (!g || typeof g !== 'object') return false;
  if (!ID_MUSTER.test(g.id ?? '') || !text(g.ain, 40) || !text(g.name)) return false;
  if (typeof g.da !== 'boolean') return false;
  if (g.art === 'hkr') {
    return zahlOderNull(g.temp) && zahlOderNull(g.soll) && MODI.has(g.modus)
      && zahlOderNull(g.komfort) && zahlOderNull(g.absenk) && typeof g.boost === 'boolean'
      && zahlOderNull(g.batterie ?? null) && typeof g.batterieLeer === 'boolean';
  }
  if (g.art === 'dose') {
    return typeof g.an === 'boolean' && zahlOderNull(g.temp ?? null) && zahlOderNull(g.watt ?? null);
  }
  return false;
}

const vorlageOk = (v) => v && typeof v === 'object' && ID_MUSTER.test(v.id ?? '')
  && text(v.name) && (v.ain === undefined || text(v.ain, 40));

/** Genau die Form, die das Relay schiebt (Entwurf 4) - mehr nimmt die Funktion nicht an. */
export function standOk(stand) {
  return !!stand && typeof stand === 'object' && stand.v === 1
    && Number.isInteger(stand.zeit)
    && Array.isArray(stand.geraete) && stand.geraete.length <= MAX_GERAETE
    && Array.isArray(stand.vorlagen) && stand.vorlagen.length <= MAX_VORLAGEN
    && stand.geraete.every(geraetOk) && stand.vorlagen.every(vorlageOk);
}

/** Wert aus Redis -> Stand oder null. Upstash liefert JSON meist schon geparst. */
export function standAus(wert) {
  let stand = wert;
  if (typeof wert === 'string') {
    try { stand = JSON.parse(wert); } catch { return null; }
  }
  return standOk(stand) ? stand : null;
}

/** POST /api/fritz: Stand vom VPS annehmen. */
export async function handleFritzPush(req, res, redis) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!pushSchluesselOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    let stand = req.body;
    if (typeof stand === 'string') {
      if (Buffer.byteLength(stand) > MAX_BYTES) return res.status(413).json({ error: 'Too large' });
      try { stand = JSON.parse(stand); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    } else if (Buffer.byteLength(JSON.stringify(stand ?? null)) > MAX_BYTES) {
      return res.status(413).json({ error: 'Too large' });
    }
    if (!standOk(stand)) return res.status(400).json({ error: 'Invalid stand' });
    await redis.set(FRITZ_SCHLUESSEL, stand);
    return res.status(204).end();
  } catch (err) {
    console.error('fritz push error:', err?.message);
    return res.status(500).json({ error: 'Fritz push failed' });
  }
}
