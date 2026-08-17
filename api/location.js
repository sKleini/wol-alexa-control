// api/location.js – /api/location?key=<LOCATION_KEY>&u=<person name>
// Location ingest endpoint. Source-agnostic: fields may come from a JSON
// body (POST, e.g. OwnTracks) or from query parameters (GET/POST, e.g.
// GPSLogger's custom URL with %LAT/%LON/%ACC/%BATT placeholders).
import { Redis } from '@upstash/redis'
import { keyOk } from '../lib/auth.js'
import { zonenWechsel, sendeZonenwechsel } from '../lib/hub-push.js'
import { CMD_KEY_PREFIX } from '../lib/ring.js'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

/**
 * Die erlaubten Werte von `ring` - eine feste Liste, kein Durchreichen.
 *
 * Der Wert landet in Redis und von dort in der Oberflaeche der Actions-App.
 * Ein Tippfehler auf der Handy-Seite soll dort als "unbekannt" ankommen und
 * nicht als eigener, stiller dritter Zustand.
 */
const RINGER_MODES = ['normal', 'vibrate', 'silent'];

/**
 * Die erlaubten Werte von `net` - feste Liste, gleiche Ueberlegung wie
 * [RINGER_MODES] daneben.
 *
 * `none` kommt in der Praxis kaum vor: Mylo sendet ueber WorkManager mit der
 * Bedingung "Netz vorhanden", ohne Netz laeuft der Lauf also gar nicht erst.
 * Der Wert steht trotzdem hier, weil die Ausschaltmeldung an WorkManager
 * vorbeigeht und ihn theoretisch tragen kann.
 */
const NETZ_ARTEN = ['wifi', 'mobile', 'other', 'none'];

/** Laenge eines WLAN-Namens nach IEEE 802.11. Alles darueber ist kaputt. */
const SSID_MAX = 32;

/**
 * Ein Ja/Nein-Feld als echtes Tri-State lesen: true, false oder unbekannt.
 *
 * Bewusst NICHT `pick(x) === '1'`: Das machte aus einem fehlenden Feld ein
 * "nein" - und die App wuerde bei jedem OwnTracks-Nutzer behaupten, das
 * Lautstellen ginge dort nicht.
 *
 * Wird von `dnd` und `zen` benutzt. **Die zwei bedeuten Verschiedenes**, und
 * die Namen verraten es nicht von selbst:
 *
 *   dnd  Darf Mylo den Klingelmodus AENDERN? (Richtlinienzugriff erteilt)
 *   zen  Laeuft "Nicht stoeren" auf dem Geraet gerade?
 *
 * Das zweite ist der Grund, warum ein Handy `silent` meldet, obwohl im
 * Tonprofil "Ton" steht: Viele Geraete legen bei aktivem "Nicht stoeren" den
 * internen Klingelmodus auf stumm.
 */
function jaNeinFlag(raw) {
  if (raw === '1' || raw === 1 || raw === true) return true;
  if (raw === '0' || raw === 0 || raw === false) return false;
  return null;
}

/** WLAN-Name saeubern. Leer, zu lang oder Androids Platzhalter -> unbekannt. */
function ssidOderNull(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v === '<unknown ssid>' || v.length > SSID_MAX) return null;
  return v;
}

/**
 * Laenge, ab der eine Lautstaerke-Angabe nicht mehr plausibel ist.
 *
 * Fuenf Kanaele ergeben knapp 60 Zeichen ("media=70,ring=100,notif=50,
 * alarm=80,system=60"). Das Doppelte laesst Luft fuer Kanaele, die es heute
 * noch nicht gibt, und zieht trotzdem eine Grenze - der Wert landet in Redis.
 */
const VOL_MAX = 120;
const VOL_FORM = /^[a-z]+=\d{1,3}(,[a-z]+=\d{1,3})*$/;

/**
 * Die Lautstaerken der Tonkanaele - `media=70,ring=100`, Prozent je Kanal.
 *
 * Eine Zeichenkette und nicht fuenf Felder: Sie kommt so von Mylo, geht so an
 * die Actions-App, und beide lesen sie mit derselben Funktion
 * (`Lautstaerken.kt`, wortgleich in beiden Apps). Hier wird sie deshalb nur auf
 * ihre Form geprueft und sonst unveraendert durchgereicht.
 *
 * **Unbekannte Kanalnamen duerfen durch** - anders als bei [RINGER_MODES], und
 * das ist Absicht: Die Apps ueberspringen still, was sie nicht kennen. Eine
 * feste Kanalliste hier zwaenge dazu, den Server vor den Apps zu aktualisieren,
 * und genau diese Reihenfolge kann niemand erzwingen.
 */
function volOderNull(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > VOL_MAX || !VOL_FORM.test(v)) return null;
  return v;
}

/**
 * Laenge und Form einer Fassungsnummer.
 *
 * "3.14.0" sind sechs Zeichen; 20 lassen Luft fuer Zusaetze wie "3.14.0-rc1",
 * ohne dass hier ein ganzer Satz durchkaeme. Erlaubt sind Ziffern, Buchstaben,
 * Punkt, Bindestrich und Plus - genau das, was in einem versionName steht.
 */
const VER_MAX = 20;
const VER_FORM = /^[0-9A-Za-z.+-]+$/;

/**
 * Die Fassung der Mylo-App auf dem meldenden Geraet - "3.14.0".
 *
 * **Warum das geprueft wird, obwohl es vom eigenen Handy kommt:** Der Wert
 * landet in Redis und von dort unveraendert in einer Oberflaeche. Was in eine
 * Anzeige wandert, wird hier geprueft und nicht dort - dieselbe Linie wie beim
 * WLAN-Namen, der aus demselben Grund [ssidOderNull] durchlaeuft.
 *
 * Ohne Inhaltsurteil: Ob "3.14.0" neuer ist als "3.9.0", entscheidet niemand
 * hier. Der Server gibt weiter, was gemeldet wurde; die Oberflaeche zeigt es.
 * Ein Vergleich waere eine Behauptung, und Behauptungen sind in diesem Projekt
 * schon zweimal teuer gewesen.
 *
 * Rein und exportiert, damit die Form ohne Netz pruefbar bleibt.
 */
export function versionOderNull(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > VER_MAX || !VER_FORM.test(v)) return null;
  return v;
}

/**
 * Der gemeldete Sendetakt in Minuten - oder `null`.
 *
 * Geprueft aus demselben Grund wie [versionOderNull]: Der Wert landet in Redis
 * und von dort unveraendert in einer Oberflaeche.
 *
 * Die Grenzen sind Mylos eigene (`Prefs.MIN_INTERVAL`/`MAX_INTERVAL`, 15 bis
 * 720), und hier stehen sie ein zweites Mal - nicht um zu klemmen, sondern um
 * Unsinn abzuweisen. Der Unterschied ist wichtig: Mylo rueckt eine 5 auf 15
 * zurecht und meldet dann 15; kaeme hier trotzdem eine 5 an, stammt sie nicht
 * von Mylo, und dann ist `null` ("dazu weiss ich nichts") die ehrliche Antwort
 * statt einer Zahl, die niemand gesetzt hat.
 *
 * Rein und exportiert, damit die Form ohne Netz pruefbar bleibt.
 */
export function taktOderNull(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 15 || n > 720) return null;
  return n;
}

/**
 * Die Zustandsfelder einer Meldung - vollstaendig, also mit `null` fuer
 * alles, was nicht mitkam.
 *
 * Das ist die Form fuer die **Positionsmeldung**, die den Datensatz ersetzt:
 * Dort heisst ein fehlendes Feld ausdruecklich "unbekannt", und genau das
 * soll gespeichert werden. Ein OwnTracks-Nutzer oder ein SmartTag-Traeger
 * meldet nichts davon, und darueber darf die Oberflaeche nichts behaupten.
 */
function zustandVoll(pick) {
  return {
    ring: RINGER_MODES.includes(pick('ring')) ? pick('ring') : null,
    dnd: jaNeinFlag(pick('dnd')),
    zen: jaNeinFlag(pick('zen')),
    torch: jaNeinFlag(pick('torch')),
    // Die Lautstaerken aller Tonkanaele. Ohne sie muesste der Regler-Dialog
    // der Actions-App raten, und ein geratener Regler stellt beim Absenden
    // Kanaele um, die niemand angefasst hat.
    vol: volOderNull(pick('vol')),
    chg: jaNeinFlag(pick('chg')),
    // Verbindungsart und WLAN-Name: erklaeren eine alternde Position
    // ("war im Funkloch") und sind zugleich ein von GPS unabhaengiger
    // Hinweis darauf, dass jemand zu Hause ist.
    net: NETZ_ARTEN.includes(pick('net')) ? pick('net') : null,
    ssid: ssidOderNull(pick('ssid')),
    // Flugmodus und Standortdienste beantworten die Frage, die eine
    // stehengebliebene Position sonst offen laesst: warum kommt nichts Neues?
    air: jaNeinFlag(pick('air')),
    gps: jaNeinFlag(pick('gps')),
    // Darf Mylo eine sichtbare Meldung aufziehen ("Ueber anderen Apps
    // anzeigen")? Die Voraussetzung des show-Befehls, nicht sein Ergebnis -
    // dieselbe Rolle wie dnd beim Lautstellen. Ohne die Freigabe laeuft show
    // am Handy ins Leere, und der Hub soll das sagen koennen, BEVOR jemand
    // ihn schickt.
    ovl: jaNeinFlag(pick('ovl')),
    // Die Fassung der App auf dem Geraet. Kein Zustand im engeren Sinn - sie
    // aendert sich nur beim Update -, aber sie reist auf demselben Weg, gilt
    // fuer dieselbe Meldung und faellt derselben Verfallsregel anheim. Ein
    // eigener Kanal dafuer waere eine zweite Buchhaltung fuer eine Zeile.
    ver: versionOderNull(pick('ver')),
    // Wie oft das Geraet von selbst meldet. Aus demselben Grund dabei wie ovl
    // weiter oben: "Sendetakt aendern" ist der einzige Fernbefehl, der drueben
    // eine Einstellung verstellt, und ohne diese Zahl sieht ein ausgefuehrter
    // Befehl genauso aus wie ein verschluckter.
    takt: taktOderNull(pick('takt')),
  };
}

/**
 * Dieselben Felder, aber **nur die tatsaechlich mitgeschickten**.
 *
 * Das ist die Form fuer die **Statusmeldung**, die in den bestehenden
 * Datensatz hineingemischt wird. Der Unterschied ist bedeutungstragend: Ein
 * Feld, das eine Statusmeldung nicht mitbringt, heisst dort "dazu sage ich
 * gerade nichts" - und darf einen vorher bekannten Wert nicht loeschen. Mit
 * [zustandVoll] wuerde die Ausschaltmeldung nebenbei den Klingelmodus
 * vergessen, nur weil sie ihn nicht wiederholt hat.
 */
function zustandTeil(pick) {
  const voll = zustandVoll(pick);
  const out = {};
  for (const k of Object.keys(voll)) {
    if (pick(k) !== undefined) out[k] = voll[k];
  }
  // Ausnahme von der Regel darueber: `ssid` haengt an `net` und wird
  // mitgeschrieben, sobald `net` mitkam - notfalls als null.
  //
  // Sonst ueberlebt ein WLAN-Name den Wechsel des Netzes: Mylo fragt den
  // Namen nur im WLAN ab, laesst ihn am Mobilfunk also weg, und der alte
  // stuende weiter im Datensatz. Schlimmer noch im zweiten Fall - im NEUEN
  // WLAN, dessen Namen Android nicht herausrueckt, faellt das Feld ebenfalls
  // weg, und die Liste behauptete den Namen des vorigen Netzes. Ein Name, den
  // wir nicht mehr kennen, ist keine Auskunft.
  if (pick('net') !== undefined) out.ssid = voll.ssid;
  return out;
}

/**
 * Die Antwort an Mylo - und der Rueckfall, der darin mitreist.
 *
 * **`q: 1` steht immer da, auch ohne wartenden Befehl.** Es ist keine Zierde,
 * sondern die Auskunft „dieses Backend kann den Rueckfall": Mylo schaltet
 * genau daran seinen ntfy-Poll ab (siehe `Sendetakt.pollNoetig` dort). Ein
 * Backend ohne dieses Feld ist ein aelteres, und dann pollt die App weiter wie
 * bisher - der Zustand wird nachgewiesen, nicht eingestellt.
 *
 * **Der Schluessel wird nicht geloescht.** Die TTL raeumt ihn weg (siehe
 * `CMD_TTL_SEK`). Loeschte diese Antwort ihn, waere der Befehl verloren, sobald
 * genau sie unterwegs abreisst - und das ist der Fall, fuer den es einen
 * Rueckfall gibt. Zweimal ankommen kann er dadurch schon; das faengt Mylos
 * Dublettenschutz ab, der denselben Dienst seit jeher fuer ntfy tut.
 *
 * Fehler beim Lesen werden geschluckt: Eine Standortmeldung darf nicht daran
 * scheitern, dass die Zugabe nicht zu haben war.
 */
async function mitBefehl(personName, rumpf) {
  try {
    const cmd = await redis.get(CMD_KEY_PREFIX + personName.toLowerCase());
    return cmd ? { ...rumpf, q: 1, cmd } : { ...rumpf, q: 1 };
  } catch (err) {
    console.warn('Hinterlegten Befehl konnte nicht gelesen werden:', err);
    return { ...rumpf, q: 1 };
  }
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!keyOk(req)) return res.status(401).end();

  // Prefer JSON body (keeps existing behavior), fall back to query params.
  const body = req.body || {};

  // OwnTracks posts a JSON body carrying a "_type" discriminator and expects the
  // HTTP response to be a JSON array of OwnTracks messages ([] = "received, no
  // commands"). Our default {ok:true} reply has no _type, so OwnTracks fails to
  // parse it, treats delivery as failed and re-queues the message forever. When
  // the caller is OwnTracks, answer in its own dialect. GPSLogger ignores the
  // body and keeps the {ok:true} reply.
  const isOwnTracks = typeof body._type === 'string';
  const ackOwnTracks = () => res.status(200).json([]);

  const personName = (req.query.u || process.env.DEFAULT_PERSON || '').trim();
  if (!personName) {
    if (isOwnTracks) return ackOwnTracks();
    return res.status(400).json({ error: 'Missing person (u param or DEFAULT_PERSON)' });
  }

  const persons = await redis.get('geo_persons') || [];
  const person = persons.find(p => p.name.toLowerCase() === personName.toLowerCase());
  if (!person) {
    console.warn(`Location update for unknown person: ${personName}`);
    if (isOwnTracks) return ackOwnTracks();
    return res.status(200).json({ ok: false, error: 'Unknown person' });
  }

  const pick = (k) => (body[k] ?? req.query[k]);
  const lat = parseFloat(pick('lat'));
  const lon = parseFloat(pick('lon'));
  const jetzt = Math.floor(Date.now() / 1000);
  const redisKey = 'person_location:' + person.name.toLowerCase();

  /**
   * Neustart und Ausschalten sind **Ereignisse**, keine Momentaufnahmen.
   * Deshalb als Zeitpunkt gespeichert und nicht als Flag: Ein Flag beantwortet
   * nur "ist gerade passiert" und waere eine Meldung spaeter wertlos, waehrend
   * der Zeitpunkt die Aussage "war ab 21:14 aus" bis zum naechsten Ereignis
   * traegt.
   */
  const ereignisse = {};
  if (jaNeinFlag(pick('boot')) === true) ereignisse.bootedAt = jetzt;
  if (jaNeinFlag(pick('off')) === true) ereignisse.offAt = jetzt;

  // Der bisherige Datensatz wird auf BEIDEN Wegen gebraucht: die Statusmeldung
  // mischt sich hinein, und die Positionsmeldung muss bootedAt/offAt daraus
  // uebernehmen - sonst waere die Aussage "war ab 21:14 aus" beim naechsten
  // Takt fuenfzehn Minuten spaeter wieder verschwunden.
  const vorher = (await redis.get(redisKey)) || {};

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    // Statusmeldung: eine Meldung ohne Position, die nur den Geraetezustand
    // nachtraegt. Sie entsteht genau dort, wo Mylo frueher stumm ausstieg -
    // kein Fix, keine Standortberechtigung, Geraet faehrt herunter. Das ist
    // der Fall, in dem die Liste eine Erklaerung braucht statt einer
    // Position, die einfach immer aelter wird.
    //
    // `st` ist ein ausdruecklicher Schalter und keine Ableitung aus "lat/lon
    // fehlen": Der Endpunkt bedient auch GPSLogger, und dort soll eine
    // vergessene Koordinate weiter den 400er bekommen, statt still als
    // Statusmeldung durchzurutschen.
    if (jaNeinFlag(pick('st')) === true) {
      await redis.set(redisKey, {
        ...vorher,
        ...zustandTeil(pick),
        ...ereignisse,
        // Nur receivedAt wandert mit, tst nicht: Die Position ist nicht
        // neuer geworden, der Zustand schon. Genau diese Trennung liest
        // buildLocationList als ageSec und statusAgeSec wieder aus.
        receivedAt: jetzt,
      });
      await merkeFcmToken(req, person);
      return res.status(200).json(await mitBefehl(person.name, { ok: true, status: true }));
    }
    // OwnTracks legitimately sends messages without coordinates (lwt, status,
    // waypoints, transitions). Acknowledge them without storing so they are not
    // re-queued; other sources still get an explicit error.
    if (isOwnTracks) return ackOwnTracks();
    return res.status(400).json({ error: 'Missing lat/lon' });
  }

  const tst = parseInt(pick('tst'));
  const location = {
    lat,
    lon,
    tst: Number.isFinite(tst) ? tst : jetzt,
    acc: Number.isFinite(parseFloat(pick('acc'))) ? parseFloat(pick('acc')) : null,
    address: pick('address') || null,
    batt: Number.isFinite(parseFloat(pick('batt'))) ? parseFloat(pick('batt')) : null,
    // Klingelmodus, "Nicht stoeren", Taschenlampe, Kabel, Netz, Flugmodus,
    // Standortdienste. Nur die Mylo-App schickt das; OwnTracks und der
    // SmartTag-Relay kennen die Felder nicht.
    //
    // Deshalb ist null hier NICHT "normal", sondern "unbekannt" - und muss es
    // bis in die Oberflaeche bleiben. Ein Standardwert waere eine Behauptung
    // ueber ein Geraet, von dem wir nichts gehoert haben. Die Liste selbst
    // steht in zustandVoll.
    ...zustandVoll(pick),
    // Die zwei Ereignisse ueberdauern die Positionsmeldung: Ein Neustart ist
    // vor zehn Minuten passiert und bleibt wahr, auch wenn seitdem drei
    // Positionen hereinkamen. Ohne das Uebernehmen aus `vorher` loeschte der
    // naechste regulaere Takt die Angabe, die der Neustart selbst gerade
    // gesetzt hat - er ist ja ebenfalls eine Positionsmeldung.
    bootedAt: ereignisse.bootedAt ?? vorher.bootedAt ?? null,
    offAt: ereignisse.offAt ?? vorher.offAt ?? null,
    receivedAt: jetzt,
  };

  await redis.set(redisKey, location);
  await merkeFcmToken(req, person);
  await meldeZonenwechsel(person, vorher, lat, lon, location.tst);

  // ackOwnTracks bleibt aussen vor: OwnTracks erwartet ein Array in seiner
  // eigenen Sprache, und ein Feld mehr im falschen Dialekt liesse es die
  // Zustellung fuer gescheitert halten und die Nachricht ewig neu einstellen.
  // Dieselbe Ruecksicht, aus der `st` ein ausdruecklicher Schalter ist.
  if (isOwnTracks) return ackOwnTracks();
  return res.status(200).json(await mitBefehl(person.name, { ok: true }));
}

/**
 * Hat die Person eine Zone betreten oder verlassen? Dann die Actions-Hubs wecken.
 *
 * **Warum hier und nicht in der App.** Der Hub verglich das bis 3.15.x selbst,
 * beim Abruf im Viertelstundentakt. Das war die optimistische Rechnung: Android
 * schiebt die Hintergrundaufgabe einer selten geoeffneten App um acht bis
 * vierundzwanzig Stunden, und die Meldung kam dann einen halben Tag zu spaet.
 * Hier ist die Stelle, an der der Uebertritt zuerst bekannt ist.
 *
 * **Nur auf dem Positions-Weg.** Die Statusmeldung (`st=1`) traegt keine
 * Koordinaten und veraendert den Aufenthaltsort nicht - dort gibt es nichts zu
 * vergleichen.
 *
 * Verglichen wird gegen `vorher`, also den Datensatz VOR dem Schreiben. Der
 * Aufruf steht deshalb nach `redis.set`, arbeitet aber mit dem alten Stand:
 * Die Position gehoert gespeichert, auch wenn der Push scheitert.
 *
 * Faengt alles ab. Ein Push, der nicht rausgeht, darf die Standortmeldung
 * nicht scheitern lassen - Mylo versuchte sie sonst erneut, obwohl die
 * Position laengst in Redis steht.
 */
async function meldeZonenwechsel(person, vorher, lat, lon, tst) {
  try {
    const zones = await redis.get('geo_zones') || [];
    const wechsel = zonenWechsel(zones, vorher, lat, lon);
    if (!wechsel) return;
    await sendeZonenwechsel(redis, person.name, wechsel, tst);
  } catch (err) {
    console.warn('Zonenwechsel-Push fehlgeschlagen:', err);
  }
}

/**
 * Das FCM-Geraetetoken aus der Kopfzeile mitnehmen, falls eines dabei ist.
 *
 * Die Mylo-App haengt es an jede Standortmeldung - so braucht es keinen
 * eigenen Registrierungs-Endpunkt, und ein nach einer Neuinstallation
 * gewechseltes Token erneuert sich von selbst. Das gilt fuer die
 * Statusmeldung genauso: Ein Handy ohne Standortberechtigung soll trotzdem
 * klingeln koennen, und genau dann ist es das Einzige, was noch hereinkommt.
 *
 * Als Kopfzeile und NICHT als Query-Parameter, aus demselben Grund, aus dem
 * der LOCATION_KEY dort nicht steht (siehe lib/auth.js): Query-Strings landen
 * in den Request-Logs. Ein FCM-Token ist eine Zugangsberechtigung - wer es
 * hat, kann dem Geraet Pushes dieses Projekts schicken.
 */
async function merkeFcmToken(req, person) {
  const fcmToken = req.headers?.['x-fcm-token'];
  if (typeof fcmToken === 'string' && fcmToken.trim()) {
    await redis.set('person_fcm:' + person.name.toLowerCase(), fcmToken.trim());
  }
}
