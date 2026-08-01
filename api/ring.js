// api/ring.js – /api/ring?u=<person name>&do=<ring|unmute|locate>
//
// Schickt der Mylo-App einen Befehl. Ausgelöst wird das aus der
// Actions-Hub-App per langem Tipp auf eine Zeile der Standort-Liste:
//
//   ring    Alarmton spielen, auch im Lautlos-Modus (Vorgabe)
//   unmute  Klingelmodus wieder auf "normal" und Lautstärke hoch
//   locate  sofort eine frische Position melden
//
// Warum der Umweg über den Server: Der Push braucht den privaten Schlüssel
// eines Firebase-Dienstkontos (siehe lib/fcm.js). Der darf nicht in eine APK.
//
// Der Endpunkt heisst weiterhin /api/ring, obwohl er inzwischen mehr kann:
// Actions Hub 2.1.0 ist bereits ausgeliefert und ruft genau diesen Pfad.
//
// Das Gerätetoken kommt von der App selbst – sie schickt es bei jeder
// Standortmeldung als Kopfzeile X-Fcm-Token mit (api/location.js).
import { Redis } from '@upstash/redis'
import { keyOk } from '../lib/auth.js'
import { fcmKonfiguriert, sendeDaten } from '../lib/fcm.js'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export const FCM_KEY_PREFIX = 'person_fcm:';

/**
 * Die Verben, die die App kennt. Alles andere wird abgewiesen.
 *
 * Muss zu `BefehlsArt` in beiden Apps passen. Ein hier fehlendes Verb faellt
 * sofort auf (400 statt Zustellung); ein hier zusaetzliches Verb liefe dagegen
 * still ins Leere, weil aeltere Mylo-Fassungen Unbekanntes verwerfen.
 */
export const BEFEHLE = [
  'ring', 'unmute', 'vibrate', 'locate', 'silence', 'torch', 'torch-off',
];

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!keyOk(req)) return res.status(401).end();

  if (!fcmKonfiguriert()) {
    // Kein Fehler, sondern ein Zustand: Ohne die drei FCM_*-Variablen gibt es
    // diesen Weg schlicht nicht, und die App faellt auf ntfy zurueck. Ein 500
    // wuerde dort als Stoerung erscheinen, obwohl alles wie eingerichtet ist.
    return res.status(200).json({ ok: false, reason: 'fcm_not_configured' });
  }

  const personName = (req.query.u || '').trim();
  if (!personName) return res.status(400).json({ error: 'Missing person (u param)' });

  // Unbekannte Verben werden abgewiesen statt durchgereicht: Sonst kaeme beim
  // Handy ein Befehl an, den dort niemand kennt - die App wuerde ihn stumm
  // verwerfen, und der Aufrufer haette "zugestellt" gemeldet.
  const befehl = (req.query.do || 'ring').trim().toLowerCase();
  if (!BEFEHLE.includes(befehl)) {
    return res.status(400).json({ error: `Unknown command '${befehl}' (do param)`, allowed: BEFEHLE });
  }

  // Gleiche Aufloesung wie in api/location.js: Der Name ist der Schluessel
  // ueber alle Stationen hinweg, Gross-/Kleinschreibung egal.
  const persons = await redis.get('geo_persons') || [];
  const person = persons.find(p => p.name.toLowerCase() === personName.toLowerCase());
  if (!person) return res.status(200).json({ ok: false, reason: 'unknown_person' });

  const token = await redis.get(FCM_KEY_PREFIX + person.name.toLowerCase());
  if (!token) {
    // Der haeufigste Fall beim ersten Einrichten: Die App hat noch nie
    // gemeldet. Eigener Grund statt eines nichtssagenden Fehlers, damit man
    // weiss, dass man in Mylo einmal "Jetzt senden" druecken muss.
    return res.status(200).json({ ok: false, reason: 'no_token' });
  }

  // Dieselbe Nutzlast wie ueber ntfy, damit die App nur ein Format kennt.
  const tst = Math.floor(Date.now() / 1000);
  const nutzlast = `${befehl}:${person.name}:${tst}`;

  // Zwei Felder, und das ist Absicht: "cmd" ist das neue, "ring" liest Mylo
  // 2.2.0. Nicht alle Familien-Handys werden gleichzeitig aktualisiert - ohne
  // das zweite Feld haette ein aelteres Handy nach diesem Deploy aufgehoert zu
  // klingeln, ohne dass irgendwo ein Fehler erschienen waere. "ring" geht nur
  // beim Klingeln mit; die neuen Verben kennt die alte Fassung ohnehin nicht.
  const daten = { cmd: nutzlast };
  if (befehl === 'ring') daten.ring = nutzlast;

  const ergebnis = await sendeDaten(token, daten);

  if (!ergebnis.ok) {
    // Ein abgemeldetes oder ersetztes Geraet meldet UNREGISTERED bzw. 404. Den
    // toten Token wegwerfen: Sonst scheitert jeder weitere Versuch an
    // derselben Leiche, und die naechste Standortmeldung legt ohnehin einen
    // frischen ab.
    if (ergebnis.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(ergebnis.body)) {
      await redis.del(FCM_KEY_PREFIX + person.name.toLowerCase());
    }
    console.warn(`FCM-Push an ${person.name} fehlgeschlagen (HTTP ${ergebnis.status}): ${ergebnis.body}`);
    return res.status(200).json({ ok: false, reason: 'push_failed', status: ergebnis.status });
  }

  return res.status(200).json({ ok: true, person: person.name, do: befehl, tst });
}
