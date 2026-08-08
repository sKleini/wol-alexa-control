// api/bild.js – Zwischenlager für das Bild einer „Meldung anzeigen"
//
//   POST /api/bild   Rumpf = JPEG als base64 (JSON {"b64":"..."} oder roher
//                    Text). Antwort: {"id":"<16 Hex>"}
//   GET  /api/bild?id=<id>   liefert die Bytes als image/jpeg zurück
//
// Warum es diesen Umweg gibt: Der show-Befehl reist als kurze Zeichenkette –
// über Firebase in einer Data-Nachricht (max. 4 KB) oder als ntfy-Zeile. Ein
// Bild passt in keinen von beiden. Es liegt deshalb hier, und der Befehl trägt
// nur die Kennung (`i=` in api/ring.js, `:#<id>` in der Nutzlast).
//
// Warum base64 in Redis und kein Blob-Speicher: Upstash ist das Einzige, was
// dieses Projekt an Speicher hat. Der Actions Hub verkleinert vorher auf 1024
// Pixel längste Kante, damit landet ein Foto bei 100-250 KB und base64 bei
// rund 330 KB - das passt bequem. Ein Blob-Store hiesse neue Abhaengigkeit,
// neuer Dienst, neues Token und eine URL ohne Schluesselpruefung.
//
// Der LOCATION_KEY schuetzt BEIDE Richtungen: Hochladen darf nur, wer ihn hat,
// und abholen ebenso. Deshalb ist die Kennung auch kein Geheimnis - sie allein
// nuetzt niemandem.
import { Redis } from '@upstash/redis'
import { keyOk } from '../lib/auth.js'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export const BILD_PREFIX = 'bild:';

/**
 * Wie lange ein Bild abrufbar bleibt (Sekunden).
 *
 * **Grosszuegiger als der schnelle Weg braucht.** Ueber Firebase ist der Befehl
 * in Sekunden da. Faellt er aber auf ntfy zurueck, holt Mylo ihn erst beim
 * naechsten Standort-Lauf ab - und der ist bis zu eine Viertelstunde entfernt.
 * Eine knappe Frist liesse ausgerechnet den langsamen Weg ins Leere laufen.
 *
 * Nach oben begrenzt bleibt sie trotzdem: Das Bild ist fuer einen Moment
 * gedacht, nicht fuer ein Archiv.
 */
export const FRIST_SEK = 30 * 60;

/**
 * Groesste zulaessige base64-Laenge.
 *
 * Rund 700 KB base64, also gut 500 KB Bild - das Doppelte dessen, was der Hub
 * nach dem Verkleinern liefert. Die Grenze ist keine Schikane, sondern das
 * Gegenstueck zu Upstashs eigener Grenze fuer die Anfragegroesse: Ohne sie
 * scheiterte der Upload dort mit einem Fehler, den niemand deuten kann.
 */
export const MAX_B64 = 700 * 1024;

/** 16 Hex-Zeichen. Kein Geheimnis - der Schluessel schuetzt, nicht die Kennung. */
function neueId() {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

/**
 * Holt die base64-Daten aus dem Rumpf.
 *
 * Zwei Formen, weil Vercel je nach Content-Type parst: `application/json`
 * kommt als Objekt an, `text/plain` als Zeichenkette. Beides zuzulassen kostet
 * drei Zeilen und erspart einen Fehler, der wie ein leeres Bild aussieht.
 *
 * Rein und exportiert, damit die Form ohne Netz pruefbar bleibt.
 */
export function b64AusRumpf(body) {
  if (typeof body === 'string') {
    const roh = body.trim();
    if (roh.startsWith('{')) {
      try { return String(JSON.parse(roh).b64 || '').trim(); } catch { return ''; }
    }
    return roh;
  }
  if (body && typeof body === 'object') return String(body.b64 || '').trim();
  return '';
}

export default async function handler(req, res) {
  if (!keyOk(req)) return res.status(401).end();

  if (req.method === 'POST' || req.method === 'PUT') {
    const b64 = b64AusRumpf(req.body);
    if (!b64) return res.status(400).json({ error: 'Missing image data' });
    if (b64.length > MAX_B64) {
      return res.status(413).json({ error: 'Image too large', max: MAX_B64, got: b64.length });
    }
    const id = neueId();
    await redis.set(BILD_PREFIX + id, b64, { ex: FRIST_SEK });
    return res.status(200).json({ id, ttl: FRIST_SEK });
  }

  if (req.method === 'GET') {
    const id = (req.query.id || '').trim();
    // Nur Hex durchlassen: Die Kennung wandert in einen Redis-Schluessel, und
    // ein Fremdformat hat dort nichts zu suchen.
    if (!/^[0-9a-f]{16}$/.test(id)) return res.status(400).json({ error: 'Bad id' });
    const b64 = await redis.get(BILD_PREFIX + id);
    // 404 ist hier der Normalfall und kein Stoerfall: Nach FRIST_SEK ist das
    // Bild weg, und Mylo zeigt dann die Meldung mit Text allein.
    if (!b64) return res.status(404).json({ error: 'Not found or expired' });
    const bytes = Buffer.from(String(b64), 'base64');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', String(bytes.length));
    // Kein Zwischenspeichern: Das Bild gilt einmal, und es steht hinter dem
    // Schluessel - eine Kopie in irgendeinem Cache waere beides nicht.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(bytes);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
