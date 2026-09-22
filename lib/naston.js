// lib/naston.js – der Ton einer FRITZ!NAS-Ordnerfreigabe, durch die eigene App.
//
// **Warum es diesen Umweg gibt.** Die Adresse, unter der eine Ordnerfreigabe
// eine Datei herausgibt, traegt eine Sitzungsnummer - und die FRITZ!Box bindet
// eine Sitzung an die IP-Adresse, die sie geholt hat. Ihre Ereignisanzeige
// sagt es selbst:
//
//   Abruf der freigegebenen Datei "/Musik/Zahnputzsong.mp3" von IP-Adresse
//   79.253.153.126.
//   Anmeldung an der FRITZ!Box-Benutzeroberflaeche von IP-Adresse
//   79.253.153.126 gescheitert (ungueltige Sitzungskennung). Zur Sicherheit
//   werden alle noch gueltigen Sitzungen zur IP-Adresse 79.253.153.126
//   beendet.
//
// 79.253.153.126 ist die externe IPv4 der Box selbst - so sieht sie den Echo,
// der den MyFRITZ!-Namen aufloest und per NAT-Loopback von aussen
// hereinkommt. Der Skill laeuft bei Vercel und holt die Nummer von einer
// anderen Adresse; fuer den Echo ist sie damit ungueltig, wie frisch auch
// immer. Das erklaert, was sich durch alle Logs zog: Der Skill fragt nach und
// bekommt "gilt noch", tippt die Datei an und bekommt HTTP 206 mit Tondaten -
// beides von *seiner* IP -, und der Echo bekommt mit derselben Adresse
// `MEDIA_ERROR_INTERNAL_SERVER_ERROR`. Eine **Datei**freigabe spielt dagegen
// tadellos: Sie traegt keine Sitzung.
//
// Die Folge fuer diese Datei: **Der Echo bekommt nie wieder eine Adresse mit
// Sitzungsnummer.** Er bekommt eine Adresse dieser App, und wer die Datei bei
// der Box holt, ist die Function - also genau die IP, der die Sitzung gehoert.
// Die Bytes laufen durch, es wird nichts gespeichert, und die Playlist traegt
// eine Adresse, die nicht verdirbt.
//
// **Was dadurch wegfallen kann** (siehe lib/musik.js): das Auffrischen vor
// jeder Antwort, der Weckruf vor dem ersten Ton, der Verzicht auf `ENQUEUE`
// bei einem Titelwechsel. Eine Adresse, die nicht abläuft, braucht nichts
// davon.
//
// **Und was es kostet:** Der Ton laeuft ueber den Vercel-Tarif. Deshalb wird
// hier gezaehlt, was wirklich durchgelaufen ist, und bei einer Grenze
// abgeschaltet - lieber ein Satz am Echo als eine Ueberraschung in der
// Abrechnung. 64-128 kbit/s sind 30-60 MB je Stunde; ein ganzes Hoerspiel
// liegt bei rund 200 MB.
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { istFritzFreigabe, streamUrl, weckUrteil } from './fritznas.js'
import { zielErlaubt } from './netz.js'
import { queryOf } from './query.js'

/** Redis: was in diesem Monat durchgelaufen ist, in Bytes. */
const TON_MONAT_PREFIX = 'musik_ton_monat:';

/** Zwei Monate plus Puffer - der Zaehler soll die Anzeige ueberleben, nicht das Jahr. */
const MONAT_TTL_S = 70 * 24 * 60 * 60;

/**
 * Wie lange auf den **Kopf** der Antwort gewartet wird.
 *
 * Nur auf den Kopf: Die Frist wird abgeraeumt, sobald die Box antwortet -
 * sonst wuerde sie mitten im Titel zuschlagen, und genau das soll dieser
 * Durchleiter ja verhindern. Grosszuegig bemessen, weil an der Box eine
 * Platte haengt, die nach ein paar Minuten Ruhe erst wieder anlaufen muss;
 * das ist der Vorgang, an dem frueher der erste Titel eines Abends starb.
 */
const KOPF_MS = 15000;

/**
 * Vorgaben, beide als Env-Variable ueberschreibbar (und je Aufruf gelesen).
 *
 * **Keine Kappung - und das ist eine Korrektur.** Hier standen erst sechzehn,
 * dann sechs, dann vier Megabyte, eingefuehrt gegen ein
 * `500 FUNCTION_INVOCATION_FAILED` und in der Annahme, Vercel begrenze den
 * Rumpf einer Antwort auf 4,5 MB. Die wirkliche Ursache stand spaeter im
 * Klartext: `budgetText is not defined`, ein ReferenceError bei **jedem**
 * Abruf, unabhaengig von jeder Groesse. Die Annahme wurde also nie geprueft,
 * und die Kappung hat nur einen neuen Fehler gebracht:
 *
 *   Ein Titel bricht nach gut einer Minute ab, und der naechste beginnt.
 *
 * So sieht sie von aussen aus. Der Echo bekommt vier Megabyte als `206`,
 * spielt sie, meldet den Titel als beendet - und fordert den Rest **nicht**
 * nach. Ein Stueck ist fuer ihn ein ganzer Titel.
 *
 * Deshalb geht der `Range` des Abspielers jetzt unveraendert an die Box, und
 * was sie liefert, wird gestroemt. `MUSIK_TON_MAX_MB` bleibt als Notausgang
 * fuer eine Laufzeit, die nicht stroemen kann - mit dem Preis, der oben
 * steht.
 */
const KAPPUNG_MB_VORGABE = 0;
const BUDGET_GB_VORGABE = 50;

/**
 * Ab wann ein Abruf im Log als langsam vermerkt wird.
 *
 * Die Uhr der Function laeuft bei 60 Sekunden ab; zwanzig sind die Schwelle,
 * an der es eng zu werden beginnt. Im gemeldeten Fall standen dort dreimal
 * `Vercel Runtime Timeout Error` - und bis dahin gab es keine einzige Zeile,
 * die gewarnt haette.
 */
const LANGSAM_MS = () => Math.max(1000, Number(process.env.MUSIK_TON_LANGSAM_MS) || 20000);

/**
 * Wie lange eine Lieferung ohne ein einziges Byte weiterlaufen darf.
 *
 * **Was im Log stand.** Nach einer Pause schiebt der Durchleiter weiter: 9,4
 * MB in 61 Sekunden und 7,5 MB in 90 Sekunden, wo dieselben Dateien sonst in
 * 7 bis 13 durch sind. Ein pausierter Echo schliesst die Verbindung naemlich
 * nicht, er hoert nur auf zu lesen - `res.on('close')` kommt also nie, und
 * die Lieferung haengt an genau der Instanz, die Alexa in acht Sekunden
 * antworten muss (im Log ist es durchgehend dieselbe). Bezahlt wird sie auch.
 *
 * **Was diese Frist kann und was nicht.** Sie greift, wenn wirklich nichts
 * mehr fliesst - eine tote Leitung, ein Abspieler, der weg ist, ohne
 * aufzulegen. Die beiden Faelle oben waren *langsam, aber nicht stehen
 * geblieben*; die faengt sie nicht, und das soll sie auch nicht: Solange
 * Bytes abgenommen werden, hoert jemand zu, und ein Abbruch waere ein Fehler
 * statt einer Aufraeumaktion.
 *
 * Grosszuegig bemessen, weil ein Echo mit vollem Puffer in Schueben liest und
 * dazwischen lange schweigen darf. `MUSIK_TON_STILLSTAND_MS=0` schaltet sie
 * ab, ohne Deploy.
 */
const STILLSTAND_MS = () => {
  const roh = process.env.MUSIK_TON_STILLSTAND_MS;
  const ms = roh === undefined || roh === '' ? 60000 : Number(roh);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  // Eine Sekunde als Boden - nicht als Empfehlung, sondern damit die Wache
  // ohne eine Minute Wartezeit pruefbar ist. Die Vorgabe bleibt eine Minute.
  return Math.max(1000, ms);
};


/**
 * Der Merkzettel "hier laufen gerade Bytes" - und warum es ihn braucht.
 *
 * Eine Anmeldung bei der Box beendet **alle** ihre Sitzungen, den gerade
 * spielenden Titel eingeschlossen (siehe lib/musik.js, `fritzSid`). Die
 * gemerkte Nummer gilt nur fuenf Minuten; holt der Echo mitten in einem
 * langen Kapitel Nachschub, laeuft der naechste Abruf danach in Nachfrage
 * und gegebenenfalls Anmeldung - und die kappt genau den Strom, der gerade
 * spielt. Das ist der einzige der drei Abrissgruende, den dieser Code selbst
 * verursacht, und deshalb der einzige, den er ganz abstellen kann.
 *
 * Solange geschrieben wird, steht dieser Schluessel - die Lieferung frischt
 * ihn jede Minute auf (`laeuftAuffrischen`). Wer ihn sieht, nimmt die
 * gemerkte Nummer, auch wenn ihr Fenster abgelaufen ist, und meldet sich
 * nicht an. Die Frist ist die Sicherung fuer den Fall, dass eine Function
 * mitten im Schreiben stirbt: Dann steht der Merkzettel hoechstens zwei
 * Minuten laenger, als er sollte.
 */
const LAEUFT_KEY = 'musik_ton_laeuft';
const LAEUFT_TTL_S = 120;
/** So oft frischt eine laufende Lieferung ihren Merkzettel auf - gut unter der Frist. */
const LAEUFT_FRISCH_MS = 60_000;

/**
 * Der Verlauf - damit die naechste Stoerung sich selbst erklaert.
 *
 * **Warum es ihn gibt.** Die Wiedergabe bricht mitten im Kapitel ab, und die
 * Zeile, die sagt *warum*, steht im Log von Vercel: geliefert gegen
 * angekuendigt, die Dauer, und ob unmittelbar davor eine Anmeldung lief. Wer
 * die Musik hoert, sieht dieses Log nicht - und wer es exportiert, tut das
 * mitten am Abend. Also schreibt die App dieselben Zahlen dorthin, wo ohnehin
 * schon der Monatszaehler steht.
 *
 * Kurz gehalten (vierzig Eintraege, ein paar Tage Frist): Der Verlauf ist ein
 * Zeuge fuer die letzte Stoerung, kein Archiv.
 */
export const VERLAUF_KEY = 'musik_ton_verlauf';
const VERLAUF_LAENGE = 40;
const VERLAUF_TTL_S = 7 * 24 * 60 * 60;

/**
 * Einen Eintrag vormerken. Wie beim Zaehler gilt: Ein Fehler hier darf die
 * Wiedergabe nie kosten - der Verlauf ist eine Auskunft, kein Auftrag.
 */
export async function verlaufSchreiben(redis, eintrag) {
  try {
    await redis.lpush(VERLAUF_KEY, { zeit: Date.now(), ...eintrag });
    await redis.ltrim(VERLAUF_KEY, 0, VERLAUF_LAENGE - 1);
    await redis.expire(VERLAUF_KEY, VERLAUF_TTL_S);
  } catch (err) {
    console.warn('musik-box Verlauf nicht geschrieben:', err?.message || err);
  }
}

/**
 * Der Verlauf, neueste zuerst.
 *
 * Upstash gibt Objekte zurueck, die es selbst serialisiert hat - aber ein
 * Eintrag aus einer anderen Fassung kann als Zeichenkette dort liegen.
 * Beides wird gelesen; was sich nicht lesen laesst, faellt weg.
 */
export async function verlaufLesen(redis) {
  try {
    const roh = await redis.lrange(VERLAUF_KEY, 0, VERLAUF_LAENGE - 1);
    return (roh || []).map((e) => {
      if (e && typeof e === 'object') return e;
      try { return JSON.parse(String(e)); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    console.warn('musik-box Verlauf nicht lesbar:', err?.message || err);
    return [];
  }
}

/** Den Verlauf vollstaendig leeren. Ein Fehler hier ist kein Wiedergabefehler. */
export async function verlaufLoeschen(redis) {
  try {
    await redis.del(VERLAUF_KEY);
    return true;
  } catch (err) {
    console.warn('musik-box Verlauf nicht loeschbar:', err?.message || err);
    return false;
  }
}

/** Laeuft gerade eine Lieferung? Ein Fehler hier kostet nie die Wiedergabe. */
async function tonLaeuft(redis) {
  try {
    return Boolean(await redis.get(LAEUFT_KEY));
  } catch (err) {
    console.warn('musik-box Ton-Merkzettel nicht lesbar:', err?.message || err);
    return false;
  }
}

async function laeuftMerken(redis) {
  const marke = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try { await redis.set(LAEUFT_KEY, marke, { ex: LAEUFT_TTL_S }); } catch { /* egal */ }
  return marke;
}

/**
 * Die Frist des eigenen Merkzettels verlaengern, solange noch geliefert wird.
 *
 * Nur, wenn er noch der eigene ist - hat ein zweiter Abruf ihn inzwischen
 * ueberschrieben, frischt der seinen selbst auf.
 */
export async function laeuftAuffrischen(redis, marke) {
  try {
    if (String(await redis.get(LAEUFT_KEY)) === marke) await redis.set(LAEUFT_KEY, marke, { ex: LAEUFT_TTL_S });
  } catch { /* egal */ }
}

/**
 * Abgeraeumt wird nur der eigene Merkzettel.
 *
 * Liefert nebenan noch ein zweiter Abruf, hat er den Schluessel inzwischen mit
 * seiner eigenen Marke ueberschrieben - ihn wegzuraeumen hiesse, genau den
 * Strom ungeschuetzt zu lassen, um dessentwillen es den Merkzettel gibt.
 */
async function laeuftVergessen(redis, marke) {
  try {
    if (String(await redis.get(LAEUFT_KEY)) === marke) await redis.del(LAEUFT_KEY);
  } catch { /* egal */ }
}

/**
 * Der Schluessel, mit dem eine Ton-Adresse unterschrieben wird.
 *
 * Dieselbe Reihenfolge wie beim Bruecken-Schluessel der Lambda: ein eigener,
 * sonst der der Bruecke, sonst das Admin-Passwort. Fehlt alles, gibt es keine
 * Adressen und der Endpunkt antwortet 401 - fail closed wie api/led.js.
 */
export function tonSchluessel() {
  return process.env.MUSIK_TON_KEY || process.env.BRIDGE_KEY || process.env.ADMIN_PASSWORD || '';
}

/** Hoechstens so viel wird je Antwort bei der Box geholt; 0 schaltet die Kappung ab. */
export function kappungBytes() {
  const mb = Number(process.env.MUSIK_TON_MAX_MB ?? KAPPUNG_MB_VORGABE);
  if (!Number.isFinite(mb) || mb < 0) return KAPPUNG_MB_VORGABE * 1024 * 1024;
  return Math.floor(mb * 1024 * 1024);
}

/** Das Monatsbudget in Bytes; 0 heisst "kein Budget". */
export function budgetBytes() {
  const gb = Number(process.env.MUSIK_TON_BUDGET_GB ?? BUDGET_GB_VORGABE);
  if (!Number.isFinite(gb) || gb < 0) return BUDGET_GB_VORGABE * 1024 ** 3;
  return Math.floor(gb * 1024 ** 3);
}

/** "musik_ton_monat:2026-09" - der Zaehler laeuft mit dem Kalender weiter. */
export function monatsSchluessel(jetzt = new Date()) {
  const monat = `${jetzt.getUTCFullYear()}-${String(jetzt.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${TON_MONAT_PREFIX}${monat}`;
}

const b64u = (roh) => Buffer.from(roh).toString('base64url');

function unterschrift(nutzlast, schluessel) {
  return crypto.createHmac('sha256', schluessel).update(nutzlast).digest('base64url');
}

/**
 * Das Token, das in der Adresse steht: Freigabe-Link und Pfad, unterschrieben.
 *
 * **Warum unterschrieben und nicht einfach hingeschrieben.** Der Endpunkt ist
 * oeffentlich - der Echo schickt keinen Schluessel mit, er kann es gar nicht.
 * Ohne Unterschrift waere er ein Abruf-Dienst, dem jeder eine beliebige
 * Adresse unterschieben koennte. Mit ihr gibt ein Token genau eine Datei
 * heraus, und das ist nicht mehr, als ein Freigabe-Link selbst auch hergibt.
 *
 * **Und warum ohne Ablauf.** Die Adresse steht in der Playlist und soll dort
 * stehen bleiben; der Echo darf sie in einem halben Jahr um zehn Uhr abends
 * abrufen. Etwas, das ablaeuft, ist genau das Problem, das hier geloest wird.
 */
export function tonToken(link, pfad, schluessel = tonSchluessel()) {
  if (!schluessel) return null;
  if (!istFritzFreigabe(link)) return null;
  const nutzlast = b64u(JSON.stringify({ l: String(link), p: String(pfad) }));
  return `${nutzlast}.${unterschrift(nutzlast, schluessel)}`;
}

/**
 * Das Token wieder auseinander - oder `null`, wenn etwas daran nicht stimmt.
 *
 * Der Vergleich laeuft ueber `timingSafeEqual`: Eine Unterschrift Zeichen fuer
 * Zeichen zu vergleichen verraet ueber die Laufzeit, wie weit man gekommen
 * ist.
 */
export function tonTokenLesen(token, schluessel = tonSchluessel()) {
  if (!schluessel || typeof token !== 'string') return null;
  const trenner = token.lastIndexOf('.');
  if (trenner < 1) return null;
  const nutzlast = token.slice(0, trenner);
  const gesehen = Buffer.from(token.slice(trenner + 1));
  const erwartet = Buffer.from(unterschrift(nutzlast, schluessel));
  if (gesehen.length !== erwartet.length || !crypto.timingSafeEqual(gesehen, erwartet)) return null;

  let daten;
  try { daten = JSON.parse(Buffer.from(nutzlast, 'base64url').toString('utf8')); } catch { return null; }
  if (!daten || typeof daten.l !== 'string' || typeof daten.p !== 'string') return null;
  if (!istFritzFreigabe(daten.l)) return null;
  return { link: daten.l, pfad: daten.p };
}

/**
 * Die Adresse, die in der Playlist steht und die der Echo abruft.
 *
 * Absolut, weil Alexa nichts anderes annimmt - und mit dem Host der Anfrage,
 * die sie erzeugt hat: Dashboard und Skill liegen auf derselben Domain.
 * `VERCEL_URL` waere die Adresse *dieses* Deployments und veraltete mit dem
 * naechsten; darum nur als Rueckfall die Produktionsdomain.
 */
export function tonUrl(basis, link, pfad, schluessel = tonSchluessel()) {
  const token = tonToken(link, pfad, schluessel);
  if (!token || !basis) return null;
  return `${String(basis).replace(/\/+$/, '')}/api/skill?ton=${encodeURIComponent(token)}`;
}

/**
 * Dieselbe Datei, aber eine Adresse, die der Abspieler noch nicht kennt.
 *
 * **Warum das noetig wurde.** Gemeldet und zweimal im Log vom 21. September
 * belegt: Eine Playlist starten, kurz darauf stoppen, wieder starten - und es
 * bleibt still. Der Skill antwortet richtig und in Millisekunden, der Echo
 * holt die Datei auch wirklich ab und bekommt alle 9,4 MB - und spielt sie
 * nicht. Stumm blieben ueber zwei Logs hinweg genau die Starts, bei denen der
 * Echo auf eben diesem Stueck pausiert war und **dieselbe Adresse** noch
 * einmal bekam; jeder Start mit einer anderen Adresse lief (ein Titelsprung,
 * eine andere Playlist, ein Neustart nach einem gescheiterten Versuch).
 *
 * Ein anderer Token allein hat nicht gereicht - das war #137, und danach war
 * es immer noch still. Also bekommt der Echo jetzt auch eine andere Adresse:
 * `&n=` haengt hinten dran, der Endpunkt liest nur `ton`, und die Signatur
 * deckt allein den Token ab. Dieselbe Datei, dieselbe Freigabe, nichts an der
 * gespeicherten Playlist geaendert - nur nichts mehr, was der Abspieler mit
 * dem Stueck verwechseln koennte, das er gerade angehalten hat.
 *
 * **Nur die eigenen Adressen.** Eine fremde MP3-URL bleibt, wie sie ist: Was
 * ein anderer Server mit einem unbekannten Parameter macht, weiss hier
 * niemand, und ein Cache-Treffer weniger waere dort der geringste Schaden.
 *
 * Rein und exportiert, damit die Regel ohne Netz pruefbar ist; ein bereits
 * angehaengtes `n` wird ersetzt und nicht gestapelt.
 */
export function frischeAdresse(url, stempel = Date.now(), neu = false) {
  const roh = String(url ?? '');
  if (!/\/api\/skill\?ton=/.test(roh)) return url;
  const sauber = roh.replace(/&n=[^&]*/g, '').replace(/&g=[^&]*/g, '');
  return `${sauber}&n=${stempel}${neu ? '&g=1' : ''}`;
}

/**
 * Welche Wiedergabe laeuft gerade - und warum eine aeltere aufhoeren soll.
 *
 * **Was im Verlauf stand.** In zweieinhalb Minuten 180 MB, 17 Abrufe fuer
 * sechs Dateien: `Lottchen_003` viermal, `No Future` viermal, `Gegen Die
 * Stroemung` viermal, dazu 49 MB fuer zwei Titel, die nie zu hoeren waren.
 * Der Grund steht in der Mechanik: Jeder Start laedt den Titel ganz, und das
 * `PlaybackNearlyFinished` kommt eine Sekunde spaeter und laedt den naechsten
 * gleich mit. Wer stoppt und neu startet, bestellt beides noch einmal - und
 * die alten Lieferungen liefen bisher trotzdem zu Ende. Sie kosten nicht nur
 * Budget: Sie belegen dieselbe Instanz und dieselbe Leitung zur Box, die der
 * neue Start gerade braucht.
 *
 * **Der Zaehler.** Eine Adresse mit `g=1` ist ein `REPLACE_ALL`, also eine
 * neue Wiedergabe; sie schreibt ihren Stempel hierher. Eine ohne (ein
 * `ENQUEUE`, der Titel danach) gehoert zu der Wiedergabe, die gerade steht,
 * und liest den Stempel nur. Wechselt er, ist die Lieferung ueberholt und
 * hoert auf.
 *
 * **Warum das Vorreihen dabei heil bleibt** - und das ist der Punkt, an dem
 * ein einfacherer Zaehler falsch waere: Waehrend Titel A spielt, holt der
 * Echo Titel B. Beide tragen denselben Stempel, weil nur ein `REPLACE_ALL`
 * einen neuen ausruft. Ein Abbruch von A, waehrend es gerade laeuft, waere
 * genau der Fehler, den dieser Code an anderer Stelle seit Monaten vermeidet.
 *
 * **Und was er nicht kann:** Er ist fuer die ganze App einer, nicht je Geraet
 * - der Echo schickt beim Abruf der Tondatei nichts mit, woran sich eines
 * erkennen liesse. Zwei Echos, die gleichzeitig verschiedene Playlists
 * spielen, wuerden sich gegenseitig abraeumen. Fuer einen Haushalt an einer
 * Box, die ohnehin nur eine Leitung hat, ist das die richtige Abwaegung;
 * `MUSIK_TON_LAUF=0` nimmt sie zurueck, ohne Deploy.
 */
const LAUF_KEY = 'musik_ton_lauf';
const LAUF_TTL_S = 3600;

/** Wie oft eine laufende Lieferung nachsieht, ob sie ueberholt ist. */
const LAUF_PRUEF_MS = 5000;

/** Der Zaehler ist abschaltbar - wie jede Sicherung, die auch mal falsch liegt. */
const laufAn = () => process.env.MUSIK_TON_LAUF !== '0';

/**
 * Den eigenen Lauf feststellen: ausrufen (`g=1`) oder nachsehen.
 *
 * Ein Fehler kostet hier nie die Wiedergabe - ohne Auskunft laeuft die
 * Lieferung wie vor diesem Zaehler, also bis zum Schluss.
 */
export async function laufMarke(redis, stempel, neu) {
  if (!laufAn()) return null;
  try {
    const steht = await redis.get(LAUF_KEY);
    const stand = steht == null ? null : String(steht);
    if (!neu || !stempel) return stand;
    // **Die Marke geht nie zurueck.** Ein `Range`-Nachschlag holt dieselbe
    // Adresse noch einmal, `g=1` eingeschlossen - im Verlauf stehen solche
    // 206er direkt neben den 200ern. Kaeme er nach einem neueren Start an,
    // wuerde er die Wiedergabe auf sich zurueckstellen und genau die
    // Lieferung abraeumen, die gerade gebraucht wird. Ist die stehende Marke
    // juenger, ist dieser Abruf der ueberholte - er bekommt sie und hoert
    // von selbst auf.
    if (stand !== null && Number(stand) >= Number(stempel)) return stand;
    await redis.set(LAUF_KEY, String(stempel), { ex: LAUF_TTL_S });
    return String(stempel);
  } catch (err) {
    console.warn('musik-box Lauf-Marke nicht lesbar:', err?.message || err);
    return null;
  }
}

/** Ist diese Lieferung ueberholt? Ohne Auskunft: nein. */
export async function laufUeberholt(redis, eigene) {
  if (!laufAn() || eigene == null) return false;
  try {
    const steht = await redis.get(LAUF_KEY);
    return steht != null && String(steht) !== eigene;
  } catch {
    return false;
  }
}

/** Der eigene Host, so wie ihn der Echo erreicht. */
export function eigeneBasis(req) {
  const kopf = req?.headers || {};
  const host = String(kopf['x-forwarded-host'] || kopf.host || '').split(',')[0].trim()
    || String(process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
  if (!host) return '';
  return host.startsWith('http') ? host : `https://${host}`;
}

/**
 * Eine alte Adresse mit Sitzungsnummer in eine Ton-Adresse umschreiben.
 *
 * Damit muss niemand neu importieren: Der Pfad steht in der alten Adresse
 * (`path=`), der Freigabe-Link in der Playlist (`quelle.link`) - mehr braucht
 * das Token nicht. Alles andere (eine Datei-Freigabe, eine fremde URL, eine
 * Playlist ohne Herkunft) bleibt unangetastet.
 */
export function alsTonUrl(url, quelle, basis, schluessel = tonSchluessel()) {
  if (quelle?.typ !== 'fritz' || !quelle.link || !basis) return url;
  let u;
  try { u = new URL(url); } catch { return url; }
  if (!/\/nas\/cgi-bin\/luacgi_notimeout$/i.test(u.pathname)) return url;
  const pfad = u.searchParams.get('path');
  if (!pfad) return url;
  return tonUrl(basis, quelle.link, pfad, schluessel) || url;
}

/**
 * Welchen Bereich der Datei holt dieser Aufruf bei der Box?
 *
 * Im Regelfall (`MUSIK_TON_MAX_MB=0`) geht der `Range` des Abspielers
 * unveraendert an die Box. Nur mit gesetzter Kappung wird hoechstens so viel
 * angefordert - mit dem Preis, der bei `KAPPUNG_MB_VORGABE` steht: Der Echo
 * nimmt das Stueck fuer den ganzen Titel und holt den Rest nicht nach.
 *
 * Rein und exportiert: Diese Rechnung soll ohne FRITZ!Box pruefbar sein.
 */
export function bereich(kopfzeile, kappung = kappungBytes()) {
  const treffer = /^\s*bytes=(\d*)-(\d*)\s*$/i.exec(String(kopfzeile || ''));
  const gewuenschtVon = treffer && treffer[1] ? Number(treffer[1]) : 0;
  const gewuenschtBis = treffer && treffer[2] ? Number(treffer[2]) : null;
  // Ein Bereich der Form "bytes=-500" (die letzten 500 Bytes) kommt von
  // Abspielern nicht vor und wird wie "ab dem Anfang" behandelt: raten waere
  // hier schlechter als schlicht von vorn zu liefern.
  const von = Number.isFinite(gewuenschtVon) && gewuenschtVon >= 0 ? gewuenschtVon : 0;
  let bis = Number.isFinite(gewuenschtBis) && gewuenschtBis >= von ? gewuenschtBis : null;
  if (kappung > 0) {
    const grenze = von + kappung - 1;
    bis = bis === null ? grenze : Math.min(bis, grenze);
  }
  return {
    von,
    bis,
    // Hat der Aufrufer selbst einen Bereich verlangt? Davon haengt ab, ob aus
    // einer Antwort der Box am Ende ein 200 oder ein 206 wird.
    gefragt: Boolean(treffer),
    kopfzeile: bis === null ? `bytes=${von}-` : `bytes=${von}-${bis}`,
  };
}

/**
 * Was der Echo als Kopf bekommt.
 *
 * Durchgereicht wird, was die Box sagt - mit einer Ausnahme: Wer **keinen**
 * Bereich verlangt hat und die ganze Datei bekommt, soll auch `200` und
 * `Content-Length` sehen und kein `206` ueber die volle Laenge. Das ist
 * zulaessig, aber ungewoehnlich, und ein Abspieler muss es nicht moegen.
 */
export function antwortKopf(status, boxKopf, gefragt) {
  const nimm = (name) => boxKopf.get(name) || null;
  const bereichKopf = nimm('content-range');
  const ganz = /^bytes 0-(\d+)\/(\d+)$/i.exec(String(bereichKopf || ''));
  const vollstaendig = Boolean(ganz && Number(ganz[1]) + 1 === Number(ganz[2]));

  const kopf = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const typ = nimm('content-type');
  if (typ) kopf['Content-Type'] = typ;
  const laenge = nimm('content-length');
  if (laenge) kopf['Content-Length'] = laenge;

  if (status === 206 && !(vollstaendig && !gefragt)) {
    if (bereichKopf) kopf['Content-Range'] = bereichKopf;
    return { status: 206, kopf };
  }
  if (vollstaendig && !laenge && ganz) kopf['Content-Length'] = ganz[2];
  return { status: 200, kopf };
}

/** Der Stand des Monatszaehlers, in Bytes. Fehler kosten nie die Wiedergabe. */
export async function monatsStand(redis, jetzt = new Date()) {
  try {
    return Number(await redis.get(monatsSchluessel(jetzt))) || 0;
  } catch (err) {
    console.warn('musik-box Ton-Zaehler nicht lesbar:', err);
    return 0;
  }
}

/** Gezaehlt wird, was wirklich geflossen ist - nicht, was angekuendigt war. */
async function zaehle(redis, bytes, jetzt = new Date()) {
  if (!bytes) return;
  try {
    const schluessel = monatsSchluessel(jetzt);
    await redis.incrby(schluessel, bytes);
    await redis.expire(schluessel, MONAT_TTL_S);
  } catch (err) {
    console.warn('musik-box Ton-Zaehler nicht fortgeschrieben:', err);
  }
}

/** Menschenlesbar fuer Log und Dashboard. */
export function lesbareMenge(bytes) {
  const z = Number(bytes) || 0;
  if (z >= 1024 ** 3) return `${(z / 1024 ** 3).toFixed(2)} GB`;
  if (z >= 1024 ** 2) return `${(z / 1024 ** 2).toFixed(1)} MB`;
  if (z >= 1024) return `${Math.round(z / 1024)} KB`;
  return `${z} B`;
}

/**
 * Ein Abruf bei der Box.
 *
 * Die Frist gilt nur bis zum Kopf; danach wird sie abgeraeumt, sonst risse
 * sie den laufenden Titel mitten entzwei.
 */
async function holeVonBox(herkunft, sid, pfad, bereichKopf) {
  const ziel = streamUrl(herkunft, sid, pfad);
  const steuerung = new AbortController();
  const wecker = setTimeout(() => steuerung.abort(), KOPF_MS);
  try {
    const antwort = await fetch(ziel, {
      method: 'GET',
      headers: { Range: bereichKopf, 'User-Agent': 'musik-box-durchleiter/1.0' },
      redirect: 'manual',
      signal: steuerung.signal,
    });
    return { antwort };
  } catch (err) {
    return { fehler: err?.name === 'AbortError' ? `keine Antwort in ${KOPF_MS} ms` : `nicht erreichbar (${err?.message || err})` };
  } finally {
    clearTimeout(wecker);
  }
}

/**
 * Wie viele Bytes diese Antwort ankuendigt - oder `null`, wenn sie schweigt.
 *
 * Erst `Content-Length`, sonst aus `Content-Range` gerechnet. Sie steht im
 * Verlauf neben den wirklich geflossenen Bytes - das Paar "geliefert von
 * angekuendigt" ist die Zeile, an der sich eine Stoerung entscheidet.
 */
export function angekuendigt(kopfzeilen) {
  const laenge = Number(kopfzeilen.get('content-length'));
  if (Number.isFinite(laenge) && laenge > 0) return laenge;
  const teile = /^bytes (\d+)-(\d+)\//i.exec(String(kopfzeilen.get('content-range') || ''));
  if (!teile) return null;
  return Number(teile[2]) - Number(teile[1]) + 1;
}

/**
 * Der Endpunkt selbst: `GET /api/skill?ton=<Token>`.
 *
 * `holeSid(link, erzwingen)` kommt von aussen herein, damit diese Datei nichts
 * aus lib/musik.js importieren muss - dort haengt der ganze Skill dran, und
 * ein Ringschluss zwischen zwei Modulen ist eine Falle fuer den naechsten,
 * der eine Zeile verschiebt.
 */
export async function nasTon(req, res, redis, rohToken, holeSid) {
  // **Ein Absturz soll sagen, woran er lag.** Was hier hochkommt, sieht sonst
  // niemand: Der Echo schweigt, und wer die Adresse im Browser oeffnet, bekommt
  // Vercels Standardseite ("FUNCTION_INVOCATION_FAILED") - eine Meldung, die
  // ueber die Ursache nichts sagt und eine Fehlersuche kostet. Also wird der
  // Grund protokolliert *und* hinausgeschrieben, solange die Kopfzeilen noch
  // nicht draussen sind.
  try {
    return await tonLiefern(req, res, redis, rohToken, holeSid);
  } catch (err) {
    console.error('musik-box Ton-Endpunkt abgestuerzt:', err?.stack || err);
    if (res.headersSent) return res.end();
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`Ton konnte nicht geliefert werden: ${err?.message || err}\n`);
  }
}

async function tonLiefern(req, res, redis, rohToken, holeSid) {
  const schluessel = tonSchluessel();
  if (!schluessel) {
    console.error('musik-box Ton-Endpunkt ohne Schluessel - MUSIK_TON_KEY/BRIDGE_KEY/ADMIN_PASSWORD fehlt');
    return res.status(401).end();
  }
  const auftrag = tonTokenLesen(rohToken, schluessel);
  if (!auftrag) return res.status(401).end();

  const freigabe = istFritzFreigabe(auftrag.link);
  const grund = await zielErlaubt(new URL(freigabe.herkunft));
  if (grund) {
    console.warn(`musik-box Ton abgelehnt: ${grund}`);
    return res.status(400).end();
  }

  // **Das Budget zuerst.** Es kostet einen Redis-Abruf und beantwortet die
  // einzige Frage, die diesen Weg ueberhaupt in Frage gestellt hat.
  const budget = budgetBytes();
  if (budget) {
    const stand = await monatsStand(redis);
    if (stand >= budget) {
      console.warn(`musik-box Monatsbudget aufgebraucht: ${lesbareMenge(stand)} von ${lesbareMenge(budget)}`);
      return res.status(503).end();
    }
  }

  const begonnen = Date.now();
  // `n` und `g` stehen neben dem Token in der Adresse und sind nicht
  // unterschrieben - sie muessen es nicht sein: Das Schlimmste, was ein
  // erfundenes `g=1` anrichtet, ist ein Abbruch der eigenen Wiedergabe, und
  // die Adresse dafuer muesste man ohnehin schon haben.
  const anfrage = queryOf(req);
  const stempel = String(anfrage.n || '') || null;
  const neueWiedergabe = String(anfrage.g || '') === '1';
  const nurKopf = req.method === 'HEAD';
  // Fuer HEAD reicht ein einziges Byte: Gebraucht wird die Gesamtgroesse aus
  // `Content-Range`, nicht die Datei.
  const teil = nurKopf ? bereich('bytes=0-0', 0) : bereich(req.headers?.range);

  // Zwei Anlaeufe, und der zweite nur mit einer erzwungen frischen Nummer:
  // Eine Sitzung stirbt an Ereignissen, nicht an der Uhr - eine Anmeldung fuer
  // eine andere Freigabe genuegt. Was die Box dann liefert, ist die
  // Anmeldeseite, und die unterscheidet `weckUrteil` von Tondaten.
  // **Laeuft nebenan schon eine Lieferung? Dann wird nicht angemeldet -
  // ausnahmslos.** Eine Anmeldung beendet alle Sitzungen der Box (siehe
  // lib/musik.js, `fritzSid`), also auch die, mit der gerade ein Kapitel
  // spielt. Genau das ist der Abbruch mitten im Kapitel, und es ist der
  // einzige der moeglichen Gruende, den dieser Code selbst verursacht.
  //
  // **#122 hat den Schalter nur halb gesetzt** (`laeuft && !erzwingen`): Der
  // erzwungene zweite Anlauf meldete sich trotzdem an - und der ist genau der
  // Fall, der eintritt, wenn die Box die gemerkte Nummer ablehnt. Der halbe
  // Schutz war damit keiner.
  //
  // Der Preis ist ausgesprochen: Lehnt die Box ab, waehrend nebenan geliefert
  // wird, scheitert *dieser* Titel. Ein Titel statt eines Abends.
  const laeuft = await tonLaeuft(redis);

  let letzter = 'kein Versuch';
  let angemeldet = false;
  for (const erzwingen of [false, true]) {
    // `holeSid` darf eine Nummer oder eine Auskunft zurueckgeben. Die
    // Auskunft sagt zusaetzlich, ob eine Anmeldung gelaufen ist - ohne sie
    // waere im Verlauf nicht zu unterscheiden, ob die Box abriss oder ob wir
    // ihr selbst die Sitzung unter dem Kapitel weggezogen haben.
    const auskunft = await holeSid(auftrag.link, erzwingen, laeuft);
    const sid = typeof auskunft === 'string' ? auskunft : auskunft?.sid;
    if (auskunft && typeof auskunft === 'object' && auskunft.angemeldet) angemeldet = true;
    if (!sid) { letzter = 'keine Sitzungsnummer'; continue; }

    const versuch = await holeVonBox(freigabe.herkunft, sid, auftrag.pfad, teil.kopfzeile);
    if (versuch.fehler) { letzter = versuch.fehler; continue; }
    const antwort = versuch.antwort;

    // **Ein 416 ist eine Auskunft, keine kaputte Sitzung.** Der Abspieler hat
    // hinter dem Ende der Datei gefragt; das beantwortet die Box richtig, und
    // eine frische Sitzungsnummer wuerde daran nichts aendern. Durchgereicht
    // weiss der Abspieler, woran er ist - als 502 wuesste er es nicht.
    if (antwort.status === 416) {
      try { await antwort.body?.cancel(); } catch { /* egal */ }
      const bereichKopf = antwort.headers.get('content-range');
      res.writeHead(416, bereichKopf ? { 'Content-Range': bereichKopf, 'Accept-Ranges': 'bytes' } : { 'Accept-Ranges': 'bytes' });
      return res.end();
    }

    const urteil = weckUrteil(antwort.status, antwort.headers.get('content-type'));
    if (!urteil.ok) {
      // Kein Ton: die Anmeldeseite, eine Umleitung, ein Fehler. Der Koerper
      // wird weggeworfen, sonst bleibt die Verbindung offen.
      try { await antwort.body?.cancel(); } catch { /* egal */ }
      letzter = `HTTP ${antwort.status}${urteil.typ ? `, ${urteil.typ}` : ''}`;
      continue;
    }

    if (nurKopf) {
      try { await antwort.body?.cancel(); } catch { /* egal */ }
      res.writeHead(200, kopfFuerHead(antwort.headers));
      return res.end();
    }

    const { status, kopf } = antwortKopf(antwort.status, antwort.headers, teil.gefragt);

    if (!antwort.body) {
      letzter = `HTTP ${antwort.status} ohne Koerper`;
      continue;
    }

    // **Ein gekapptes Stueck wird am Stueck ausgeliefert, nicht gestroemt.**
    // Vier Megabyte passen in jede Grenze, und `res.end` mit einem fertigen
    // Puffer braucht vom Streamen nichts. Ohne Kappung (der Regelfall) wird
    // gestroemt - und dort kann der Strom abreissen, siehe unten.
    if (kappungBytes() > 0) {
      const puffer = Buffer.from(await antwort.arrayBuffer());
      res.writeHead(status, { ...kopf, 'Content-Length': String(puffer.length) });
      res.end(puffer);
      await zaehle(redis, puffer.length);
      melde(auftrag.pfad, teil, status, puffer.length, Date.now() - begonnen, erzwingen, 'geliefert');
      await verlaufSchreiben(redis, {
        was: 'ton', datei: adresseKurz(auftrag.pfad), bereich: teil.kopfzeile, status,
        bytes: puffer.length, soll: puffer.length, dauer: Date.now() - begonnen, angemeldet,
      });
      return undefined;
    }

    const soll = angekuendigt(antwort.headers);
    res.writeHead(status, kopf);
    // Ab hier fliessen Bytes: Der Merkzettel steht, bis die letzten durch sind.
    const marke = await laeuftMerken(redis);
    // Und daneben, zu welcher Wiedergabe diese Lieferung gehoert: Ein
    // `REPLACE_ALL` (`g=1`) ruft eine neue aus, alles andere haengt sich an
    // die laufende. Siehe `laufMarke`.
    const lauf = await laufMarke(redis, stempel, neueWiedergabe);
    // **Der Merkzettel lebt so lange wie die Lieferung, nicht nur 120 s.**
    // Gemessen sind Lieferungen von 205 s; ohne Nachfrischen verfiel er
    // mittendrin, und ab da durfte eine Anmeldung genau diesen Strom kappen.
    const frischhalten = setInterval(() => { laeuftAuffrischen(redis, marke); }, LAEUFT_FRISCH_MS);
    let bytes;
    try {
      bytes = await durchleiten(antwort.body, res, () => laufUeberholt(redis, lauf));
    } finally {
      clearInterval(frischhalten);
      await laeuftVergessen(redis, marke);
    }
    await zaehle(redis, bytes);
    melde(auftrag.pfad, teil, status, bytes, Date.now() - begonnen, erzwingen, 'gestroemt');
    // **Der Eintrag, der eine Stoerung erklaert.** `bytes` gegen `soll` sagt,
    // ob der Strom vollstaendig war; `angemeldet`, ob wir der Box selbst die
    // Sitzung unter dem Titel weggezogen haben.
    await verlaufSchreiben(redis, {
      was: 'ton', datei: adresseKurz(auftrag.pfad), bereich: teil.kopfzeile, status,
      bytes, soll, dauer: Date.now() - begonnen, angemeldet,
    });
    if (soll && bytes < soll) {
      console.warn(`musik-box Strom abgerissen: ${lesbareMenge(bytes)} von ${lesbareMenge(soll)}`
        + ` nach ${Date.now() - begonnen} ms`);
    }
    return undefined;
  }

  console.warn(`musik-box Ton nicht lieferbar (${letzter}): ${adresseKurz(auftrag.pfad)}`);
  await verlaufSchreiben(redis, {
    was: 'ton', datei: adresseKurz(auftrag.pfad), bereich: teil.kopfzeile, status: 502,
    bytes: 0, soll: null, dauer: Date.now() - begonnen, grund: letzter, angemeldet,
  });
  return res.status(502).end();
}

/**
 * Die Antwort auf ein HEAD: keine Bytes, aber die Groesse der ganzen Datei.
 *
 * Sie steht im `Content-Range` des einen Bytes, das dafuer geholt wurde -
 * `Content-Length` waere hier die 1 und damit eine Luege ueber die Datei.
 */
export function kopfFuerHead(boxKopf) {
  const kopf = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const typ = boxKopf.get('content-type');
  if (typ) kopf['Content-Type'] = typ;
  const ganz = /\/(\d+)$/.exec(String(boxKopf.get('content-range') || ''));
  if (ganz) kopf['Content-Length'] = ganz[1];
  return kopf;
}

/**
 * Was dieser Abruf war - in einer Zeile, und mit allem, was beim naechsten
 * Stolperer zaehlt.
 *
 * **Warum so ausfuehrlich.** Der gemeldete Abbruch eines Hoerbuchs war aus dem
 * Log nur zu rekonstruieren, weil Vercel selbst Dauer und Status je Anfrage
 * mitschreibt; die eigene Zeile nannte Datei und Menge und sonst nichts.
 * Welcher Bereich verlangt war, wie lange es dauerte und ob es ein 200 oder
 * ein 206 wurde, ist genau das, was die Frage "lief da noch ein zweiter
 * Abruf?" beantwortet.
 */
function melde(pfad, teil, status, bytes, dauer, erzwingen, wort) {
  const zeile = `musik-box Ton ${wort}: ${adresseKurz(pfad)}`
    + ` ${teil.gefragt ? teil.kopfzeile : 'ohne Bereich'} → ${status}`
    + `, ${lesbareMenge(bytes)} in ${dauer} ms`
    + `${erzwingen ? ' (nach frischer Sitzung)' : ''}`;
  if (dauer >= LANGSAM_MS()) {
    console.warn(`${zeile} – langsam; laeuft an der Box noch ein zweiter Abruf?`);
    return;
  }
  console.log(zeile);
}

/** "/Musik/Lottchen/01 - Die Buehne.mp3" -> "01 - Die Buehne.mp3" fuers Log. */
function adresseKurz(pfad) {
  return String(pfad).split('/').filter(Boolean).pop() || pfad;
}

/**
 * Die Bytes weiterreichen und dabei zaehlen.
 *
 * **Hier stand einmal eine Wiederaufnahme abgerissener Stroeme** (#122). Sie
 * hat in keiner einzigen Messung gefeuert: In jeder Zeile des Verlaufs steht
 * geliefert gleich angekuendigt. Abgerissen ist nie etwas - der Abbruch lag
 * am Titelwechsel, nicht an der Lieferung. Ungenutzter Code auf dem heissen
 * Weg ist teurer als er aussieht, also ist er wieder weg.
 *
 * Gezaehlt wird am Strom und nicht an `Content-Length`: Wer einen Titel nach
 * dreissig Sekunden abbricht, hat dreissig Sekunden verbraucht.
 */
function durchleiten(koerper, res, ueberholt = null) {
  return new Promise((fertig) => {
    let bytes = 0;
    let schon = false;
    let zuletzt = Date.now();
    // Vorab deklariert: `fertigEinmal` fasst sie an, und das darf nicht von
    // der Reihenfolge der Zeilen abhaengen.
    let wache = null;
    // **Gewartet wird auf die Antwort, nicht auf den Zufluss.** Das `end` des
    // lesenden Stroms kommt, bevor das letzte Stueck hinausgeschrieben ist;
    // wer dort aufhoert zu warten, gibt die Function frei, waehrend der Echo
    // noch auf Bytes wartet - und der bekommt dann Kopfzeilen mit
    // Content-Length und danach zu wenig. Genau so ist in #122 jede
    // Ordnerfreigabe verstummt; der Satz hier ist die Lehre daraus und steht
    // unter Test.
    const fertigEinmal = () => {
      if (wache) clearInterval(wache);
      if (!schon) { schon = true; fertig(bytes); }
    };
    const strom = Readable.fromWeb(koerper);
    strom.on('data', (stueck) => { bytes += stueck.length; zuletzt = Date.now(); });
    strom.on('error', (err) => {
      console.warn('musik-box Ton abgebrochen:', err?.message || err);
      res.end();
      fertigEinmal();
    });
    res.on('finish', fertigEinmal);
    // Legt der Echo auf, wird der Abruf bei der Box beendet - sonst laedt die
    // Function eine Datei zu Ende, die niemand mehr hoert, und zahlt sie.
    res.on('close', () => { strom.destroy(); fertigEinmal(); });

    // **Und wenn er nicht auflegt, sondern nur verstummt?** Dann kommt kein
    // `close`, und ohne diese Wache liefe die Lieferung bis zur Uhr der
    // Function weiter. Geprueft wird selten - die Frist ist eine Minute, eine
    // Sekunde Takt reicht dafuer und kostet nichts.
    const frist = STILLSTAND_MS();
    // Dieselbe Wache erledigt beides: den Stillstand jede Sekunde, die Frage
    // nach einer neueren Wiedergabe alle fuenf. `fragtGerade` verhindert,
    // dass sich die Redis-Abrufe stapeln, wenn einer haengt.
    let seitPruefung = 0;
    let fragtGerade = false;
    const beenden = (grund) => {
      console.warn(`musik-box Ton beendet (${grund}): ${lesbareMenge(bytes)} sind durch.`);
      strom.destroy();
      res.end();
      fertigEinmal();
    };
    wache = (frist || ueberholt) ? setInterval(() => {
      if (frist && Date.now() - zuletzt >= frist) {
        beenden(`seit ${Date.now() - zuletzt} ms kein Byte abgenommen`);
        return;
      }
      if (!ueberholt || fragtGerade) return;
      seitPruefung += 1000;
      if (seitPruefung < LAUF_PRUEF_MS) return;
      seitPruefung = 0;
      fragtGerade = true;
      Promise.resolve(ueberholt())
        .then((ja) => { if (ja && !schon) beenden('eine neuere Wiedergabe hat angefangen'); })
        .catch(() => { /* eine Auskunft, kein Auftrag */ })
        .finally(() => { fragtGerade = false; });
    }, 1000) : null;
    // **Bewusst nicht `unref`.** Eine unref'te Wache kann genau dann nicht
    // mehr feuern, wenn sie gebraucht wird - naemlich dann, wenn sonst
    // nichts mehr am Ereignis-Kreis haengt. Am Leben haelt sie nichts:
    // `fertigEinmal` raeumt sie ab, und das laeuft auf jedem Weg hinaus.

    strom.pipe(res);
  });
}
