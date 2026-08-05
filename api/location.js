// api/location.js – /api/location?key=<LOCATION_KEY>&u=<person name>
// Location ingest endpoint. Source-agnostic: fields may come from a JSON
// body (POST, e.g. OwnTracks) or from query parameters (GET/POST, e.g.
// GPSLogger's custom URL with %LAT/%LON/%ACC/%BATT placeholders).
import { Redis } from '@upstash/redis'
import { keyOk } from '../lib/auth.js'

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
      return res.status(200).json({ ok: true, status: true });
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

  if (isOwnTracks) return ackOwnTracks();
  return res.status(200).json({ ok: true });
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
