// api/ring.js – /api/ring?u=<person name>&do=<verb>
//
// Schickt der Mylo-App einen Befehl. Ausgelöst wird das aus der
// Actions-Hub-App per langem Tipp auf eine Zeile der Standort-Liste:
//
//   ring       Alarmton spielen, auch im Lautlos-Modus (Vorgabe)
//   silence    laufendes Klingeln UND Licht beenden
//   torch      Taschenlampe an (Dauerlicht, max. 5 Minuten)
//   torch-off  nur die Taschenlampe wieder aus
//   unmute     Klingelmodus wieder auf "normal" und Lautstärke hoch
//   vibrate    Klingelmodus auf Vibration
//   dnd-off    "Nicht stören" aufheben
//   dnd-on     "Nicht stören" einschalten (Filter "Prioritär", nicht "Totenstille")
//   locate     sofort eine frische Position melden
//   say        einen Text vorlesen (Parameter t=<Text>, sonst Mylos Standardsatz)
//   volume     Tonkanaele auf einen Prozentwert stellen
//              (Parameter t=media=70,ring=100 - ohne ihn passiert nichts)
//   buzz       ruettelt bis zu 30 Sekunden im Muster, ohne jeden Ton
//   buzz-off   nur das Ruetteln wieder aus
//   show       zeigt einen Text gross auf dem Bildschirm, auch im gesperrten
//              Zustand (Parameter t=<Text> wie bei say). Der sichtbare
//              Zwilling zu say: Er bleibt stehen, statt vorbei zu sein.
//              Dazu optional ein Bild: i=<id> aus dem Zwischenlager. Das Bild
//              selbst passt in keine Push-Nutzlast, deshalb nur die Kennung.
//
// Mit dem Parameter `bild` ist dieselbe Adresse ausserdem das Zwischenlager
// fuer genau dieses Bild (POST legt ab, GET holt; siehe lib/bild.js). Das ist
// keine Eleganz, sondern eine Auflage: Vercel macht aus jeder Datei unter
// `api/` eine Serverless Function, und der Hobby-Tarif erlaubt zwoelf. Ein
// eigenes `api/bild.js` waere die dreizehnte gewesen und liess den Deploy
// scheitern. Der Zusammenhang stimmt trotzdem - das Bild gehoert zum Befehl.
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
import { bildHandler, istBildAnfrage } from '../lib/bild.js'

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
  'dnd-off', 'dnd-on', 'say', 'volume', 'buzz', 'buzz-off', 'show',
];

/**
 * Laenge, ab der ein Ansagetext gekuerzt wird.
 *
 * Derselbe Wert wie `RingCommand.MAX_TEXT` in der Actions-Hub-App. Die kuerzt
 * schon selbst; diese Grenze gilt jedem anderen Aufrufer - eine FCM-Nachricht
 * darf 4 KB gross sein, ein vorgelesener Satz nicht.
 */
export const MAX_TEXT = 200;

/**
 * Haengt den Ansagetext an die Nutzlast - oder gibt sie unveraendert zurueck.
 *
 * Format: `<verb>:<Person>:<tst>:=<percent-kodiert>`. Die Marke `=` vor dem
 * Text ist nicht Zierrat: Ohne sie waere `say:Julia:1700000000:112` zweideutig
 * - das letzte Feld koennte der Text "112" sein oder der Zeitstempel eines
 * Namens "Julia:1700000000". `encodeURIComponent` erzeugt niemals ein `=`,
 * also entscheidet es den Fall.
 *
 * **Neu kodieren ist Pflicht, nicht Kosmetik.** `req.query.t` kommt bereits
 * dekodiert an (`Bitte+melde+dich` -> `Bitte melde dich`); unverandert
 * angehaengt zerlegte ein Doppelpunkt im Text die Nutzlast. Ob dabei `%20`
 * oder `+` entsteht, ist gleich - Mylos `URLDecoder` liest beides.
 *
 * Reine Funktion und exportiert, damit sie ohne Netz pruefbar bleibt.
 */
export function mitText(nutzlast, roh) {
  const text = (roh || '').trim().slice(0, MAX_TEXT);
  if (!text) return nutzlast;
  return `${nutzlast}:=${encodeURIComponent(text)}`;
}

/**
 * Haengt die Bild-Kennung an - oder gibt die Nutzlast unveraendert zurueck.
 *
 * Format: `<verb>:<Person>:<tst>[:=<Text>]:#<id>`. Die Marke `#` traegt aus
 * demselben Grund wie das `=` vor dem Text: `encodeURIComponent` erzeugt
 * niemals ein `#`, das Zeichen kann also nicht aus dem kodierten Text stammen
 * und entscheidet den Fall eindeutig.
 *
 * **Kommt NACH mitText**, nie davor - die Apps schaelen die Felder von rechts
 * ab und erwarten die Kennung zuletzt.
 *
 * Nur Hex wird durchgelassen: Was hier hineinkommt, stammt aus dem
 * Zwischenlager (lib/bild.js) und hat genau diese Form. Alles andere zerlegte
 * im schlimmsten Fall die Nutzlast.
 *
 * Reine Funktion und exportiert, damit sie ohne Netz pruefbar bleibt.
 */
export function mitBild(nutzlast, roh) {
  const id = (roh || '').trim();
  if (!/^[0-9a-f]{16}$/.test(id)) return nutzlast;
  return `${nutzlast}:#${id}`;
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!keyOk(req)) return res.status(401).end();

  // Vor allem anderen abzweigen: Die Bild-Anfrage hat weder eine Person noch
  // ein Verb, und sie braucht auch kein Firebase - sie legt nur ab oder holt.
  if (istBildAnfrage(req.query)) return bildHandler(req, res);

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
  // Der Ansagetext haengt als optionales viertes Feld hinten dran; ohne ihn
  // bleibt es bei der dreiteiligen Form, die jedes aeltere Mylo liest.
  const tst = Math.floor(Date.now() / 1000);
  const nutzlast = mitBild(mitText(`${befehl}:${person.name}:${tst}`, req.query.t), req.query.i);

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
