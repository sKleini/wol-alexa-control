// lib/ring.js – einen Befehl an das Handy einer Person schicken.
//
// Herausgeloest aus api/ring.js, weil es seit dem Alexa-Skill zwei Absender
// gibt: den Actions Hub ueber /api/ring und die Sprachbefehle in api/skill.js.
// Zwei Kopien derselben Zustellung waeren zwei Stellen, an denen ein neues
// Verb oder ein geaenderter Redis-Schluessel vergessen werden kann.
//
// **Nach lib/ und nicht in eine eigene api/-Datei**, wie schon beim Bild:
// Vercel macht aus jeder Datei unter api/ eine Serverless Function, und der
// Hobby-Tarif erlaubt zwoelf. Dateien unter lib/ zaehlen nicht mit.
import crypto from 'crypto'
import { fcmKonfiguriert, sendeDaten } from './fcm.js'

export const FCM_KEY_PREFIX = 'person_fcm:';

/**
 * Wo ein Befehl liegt, den der Push nicht zustellen konnte.
 *
 * **Der Rueckfall, der keinen eigenen Request kostet.** Mylo meldet ohnehin
 * regelmaessig an /api/location; seit dieser Ablage traegt dessen *Antwort*
 * den wartenden Befehl mit (siehe api/location.js). Bis hierher musste die App
 * dafuer ntfy.sh abfragen - ein zweiter Host, eigener TLS-Handschlag, rund 24
 * Mal am Tag auf einem gerade erst geweckten Funkmodul, und im Normalbetrieb
 * fand keine dieser Abfragen etwas.
 */
export const CMD_KEY_PREFIX = 'person_cmd:';

/**
 * Wie lange ein hinterlegter Befehl gilt - in Sekunden.
 *
 * Eine halbe Stunde, und das ist kein runder Wert, sondern derselbe wie
 * `Ring.MAX_ALTER_MS` in Mylo: Die App verwirft ohnehin alles, was aelter ist.
 * Ein Befehl, den der Empfaenger nicht mehr ausfuehren wuerde, soll gar nicht
 * erst liegen bleiben und beim naechsten Lauf umsonst mitreisen.
 */
export const CMD_TTL_SEK = 30 * 60;

/**
 * Legt die Nutzlast fuer den naechsten Standort-Lauf ab. Fehler werden
 * geschluckt - wie bei [ueberNtfy] ist das eine Zugabe, kein Verlass.
 *
 * **Ohne Loeschen beim Lesen**, siehe api/location.js: Die TTL raeumt auf.
 * Wuerde die Antwort den Schluessel entfernen, waere ein Befehl verloren,
 * sobald genau diese Antwort unterwegs abreisst - und das ist der Fall, in dem
 * ein Rueckfall ueberhaupt gebraucht wird. Dass er dadurch zweimal ankommen
 * kann, faengt Mylos Dublettenschutz (`Prefs.lastRingTst`) ab; genau denselben
 * Dienst tut er seit jeher fuer den ntfy-Weg.
 */
async function hinterlege(redis, personName, nutzlast) {
  try {
    await redis.set(CMD_KEY_PREFIX + personName.toLowerCase(), nutzlast, { ex: CMD_TTL_SEK });
    return true;
  } catch (err) {
    console.warn('Befehl konnte nicht hinterlegt werden:', err);
    return false;
  }
}

/**
 * Die Verben, die die Apps kennen. Alles andere wird abgewiesen.
 *
 * Muss zu `BefehlsArt` in beiden Apps passen. Ein hier fehlendes Verb faellt
 * sofort auf (400 statt Zustellung); ein hier zusaetzliches Verb liefe dagegen
 * still ins Leere, weil aeltere Mylo-Fassungen Unbekanntes verwerfen.
 */
export const BEFEHLE = [
  'ring', 'unmute', 'vibrate', 'locate', 'silence', 'torch', 'torch-off',
  'dnd-off', 'dnd-on', 'say', 'volume', 'buzz', 'buzz-off', 'show',
  'interval', 'zones',
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

/**
 * Das ntfy-Topic aus dem `LOCATION_KEY` - der langsame Weg.
 *
 * **Wortgleich abgeleitet wie `RingTopic.forKey` in beiden Apps**: `mylo-`
 * plus die ersten 16 Hex-Zeichen des SHA-256. Kein neues Geheimnis, keine
 * neue Einstellung - wer den Schluessel nicht hat, kann das Topic nicht
 * erraten.
 *
 * Dass alle drei Seiten dasselbe rechnen, haelt ein gemeinsamer
 * Erwartungswert fest: `LOC_TEST_KEY` ergibt `mylo-9d7ba29caf807a00`, und
 * genau der steht auch in `RingApiTest` der Hub-App.
 *
 * Reine Funktion und exportiert, damit sie ohne Netz pruefbar bleibt.
 */
export function topicFuerSchluessel(key) {
  const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
  return 'mylo-' + hash.slice(0, 16);
}

/**
 * Schickt die Nutzlast zusaetzlich ueber ntfy. Fehler werden geschluckt.
 *
 * **Warum zusaetzlich und nicht ersatzweise:** Ein Handy, dessen APK ohne
 * Firebase-Werte gebaut wurde, hoert nur hier - und welches das ist, weiss
 * dieser Server nicht.
 *
 * **Und warum nur auf Verlangen:** Der Actions Hub schickt seine ntfy-Zeile
 * seit jeher selbst, gleich nach dem Aufruf von /api/ring. Wuerde dieser
 * Server dort ebenfalls veroeffentlichen, laegen zwei Zeilen mit leicht
 * verschiedenen Zeitstempeln im Topic - und Mylos Dublettenschutz
 * (`Prefs.lastRingTst`) haelt die zweite fuer neuer und fuehrt sie noch einmal
 * aus. Der Rueckfall gehoert deshalb genau dorthin, wo es keinen zweiten
 * Absender gibt: zum Sprachbefehl.
 */
async function ueberNtfy(nutzlast) {
  const key = process.env.LOCATION_KEY;
  if (!key) return false;
  try {
    const antwort = await fetch(`https://ntfy.sh/${topicFuerSchluessel(key)}`, {
      method: 'POST',
      body: nutzlast,
    });
    return antwort.ok;
  } catch (err) {
    console.warn('ntfy-Rueckfall fehlgeschlagen:', err);
    return false;
  }
}

/**
 * Schickt [verb] an das Handy von [personName].
 *
 * @returns {{ok: boolean, grund: string|null, person: string|null, ntfy: boolean}}
 *   `ok` heisst **per Push zugestellt** - also in Sekunden da. `ntfy` heisst
 *   *auch* ueber den langsamen Weg abgeschickt; der kommt beim naechsten
 *   Standort-Lauf an, bis zu eine Viertelstunde spaeter.
 *
 * Die beiden auseinanderzuhalten ist der ganze Zweck dieses Rueckgabewerts:
 * Der Aufrufer soll "klingelt" nur sagen koennen, wenn es auch klingelt. Ein
 * pauschales true haette Alexa etwas behaupten lassen, das noch gar nicht
 * eingetreten ist - dieselbe Sorte Auskunft wie die 50 %, die einmal als
 * Lautstaerke dastanden.
 *
 * Moegliche Gruende: `unbekanntes_verb`, `unbekannte_person`, `kein_fcm`,
 * `kein_token`, `push_fehlgeschlagen`.
 *
 * **Ein gescheiterter Push wird immer hinterlegt** ([hinterlege]), unabhaengig
 * von `rueckfall`: Die Antwort auf die naechste Standortmeldung traegt den
 * Befehl dann mit, und das kostet keinen eigenen Request. `rueckfall` steuert
 * nur noch den *zusaetzlichen* ntfy-Weg - den braucht ein Handy mit einer
 * Mylo-Fassung, die den Rueckfall in der Antwort noch nicht liest.
 *
 * @param extras `{ text, bild, rueckfall, hinterlegen }` - `rueckfall: true`
 *   schickt die Zeile bei einem gescheiterten Push zusaetzlich ueber ntfy
 *   (siehe [ueberNtfy]). `hinterlegen: false` verzichtet auf die Ablage.
 *
 * **Wann `hinterlegen: false` richtig ist.** Die Ablage hat pro Person genau
 * EINEN Platz (`person_cmd:<name>`), ein neuer Befehl ueberschreibt also den
 * warten den alten. Das ist fuer angeforderte Befehle in Ordnung - wer zweimal
 * klingeln laesst, meint das zweite Mal. Es ist es nicht fuer Befehle, die
 * *von selbst* entstehen: Der Zonen-Fan-out (`api/manage.js`) trifft alle
 * Personen auf einmal, und ein Handy mit gescheitertem Push verloere dabei
 * einen wartenden Klingel-Wunsch - ausgerechnet den, auf den gerade jemand
 * wartet. `zones` hat mit dem Sechs-Stunden-Zyklus in Mylo ein eigenes Netz und
 * braucht die Ablage nicht.
 */
export async function befehlAnPerson(redis, personName, verb, extras = {}) {
  const rueckfall = extras.rueckfall === true;
  const hinterlegen = extras.hinterlegen !== false;
  const name = (personName || '').trim();
  const befehl = (verb || 'ring').trim().toLowerCase();
  if (!BEFEHLE.includes(befehl)) {
    return { ok: false, grund: 'unbekanntes_verb', person: null, ntfy: false };
  }

  // Gleiche Aufloesung wie in api/location.js: Der Name ist der Schluessel
  // ueber alle Stationen hinweg, Gross-/Kleinschreibung egal.
  const persons = await redis.get('geo_persons') || [];
  const person = persons.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (!person) return { ok: false, grund: 'unbekannte_person', person: null, ntfy: false };

  // Dieselbe Nutzlast wie ueber ntfy, damit die App nur ein Format kennt.
  // Der Ansagetext haengt als optionales viertes Feld hinten dran; ohne ihn
  // bleibt es bei der dreiteiligen Form, die jedes aeltere Mylo liest.
  const tst = Math.floor(Date.now() / 1000);
  const nutzlast = mitBild(mitText(`${befehl}:${person.name}:${tst}`, extras.text), extras.bild);

  if (!fcmKonfiguriert()) {
    // Kein Fehler, sondern ein Zustand: Ohne die drei FCM_*-Variablen gibt es
    // den schnellen Weg schlicht nicht. Der langsame bleibt.
    if (hinterlegen) await hinterlege(redis, person.name, nutzlast);
    const ntfy = rueckfall && await ueberNtfy(nutzlast);
    return { ok: false, grund: 'kein_fcm', person: person.name, ntfy };
  }

  const token = await redis.get(FCM_KEY_PREFIX + person.name.toLowerCase());
  if (!token) {
    // Der haeufigste Fall beim ersten Einrichten: Die App hat noch nie
    // gemeldet. Eigener Grund statt eines nichtssagenden Fehlers, damit man
    // weiss, dass man in Mylo einmal "Jetzt senden" druecken muss.
    if (hinterlegen) await hinterlege(redis, person.name, nutzlast);
    const ntfy = rueckfall && await ueberNtfy(nutzlast);
    return { ok: false, grund: 'kein_token', person: person.name, ntfy };
  }

  // Zwei Felder, und das ist Absicht: "cmd" ist das neue, "ring" liest Mylo
  // 2.2.0. Nicht alle Familien-Handys werden gleichzeitig aktualisiert - ohne
  // das zweite Feld haette ein aelteres Handy nach diesem Deploy aufgehoert zu
  // klingeln, ohne dass irgendwo ein Fehler erschienen waere. "ring" geht nur
  // beim Klingeln mit; die neuen Verben kennt die alte Fassung ohnehin nicht.
  const daten = { cmd: nutzlast };
  if (befehl === 'ring') daten.ring = nutzlast;

  const ergebnis = await sendeDaten(token, daten);
  if (ergebnis.ok) return { ok: true, grund: null, person: person.name, ntfy: false };

  // Ein abgemeldetes oder ersetztes Geraet meldet UNREGISTERED bzw. 404. Den
  // toten Token wegwerfen: Sonst scheitert jeder weitere Versuch an derselben
  // Leiche, und die naechste Standortmeldung legt ohnehin einen frischen ab.
  if (ergebnis.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(ergebnis.body)) {
    await redis.del(FCM_KEY_PREFIX + person.name.toLowerCase());
  }
  console.warn(`FCM-Push an ${person.name} fehlgeschlagen (HTTP ${ergebnis.status}): ${ergebnis.body}`);
  if (hinterlegen) await hinterlege(redis, person.name, nutzlast);
  const ntfy = rueckfall && await ueberNtfy(nutzlast);
  return {
    ok: false,
    grund: 'push_fehlgeschlagen',
    person: person.name,
    ntfy,
    status: ergebnis.status,
  };
}
