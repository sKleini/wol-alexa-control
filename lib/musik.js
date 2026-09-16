// lib/musik.js – die Musik-Box: Playlists aus MP3-URLs, abgespielt per Alexa.
//
// Zwei Haelften in einer Datei, weil beide dieselben Regeln teilen:
//
//   handleManage  Verwaltung aus dem Dashboard (/api/manage?type=playlists):
//                 Playlists anlegen, aendern, loeschen, URLs pruefen
//   handleSkill   der Alexa Custom Skill "musik box" (/api/skill, verzweigt
//                 dort nach der Skill-ID)
//
// **Warum hier und nicht in api/musik.js.** Der Vercel-Hobby-Tarif erlaubt
// zwoelf Serverless Functions, und api/ hat genau zwoelf. Neue Logik gehoert
// nach lib/ und wird aus einer bestehenden Funktion aufgerufen - so steht es in
// .github/workflows/api-funktionen.yml, und so ist es hier.
//
// **Der Playlistname kommt ueber zwei Intents herein.** SuchePlaylistIntent
// nimmt freien Text (AMAZON.SearchQuery) und traegt den Ein-Satz-Aufruf;
// PlayPlaylistIntent nimmt den eigenen Slot-Typ und traegt die Antwort auf die
// Rueckfrage. Warum beide noetig sind, steht bei handlePlay.
//
// **Der Zustand steckt im Token, nicht in Redis.** Alexa schickt bei jedem
// AudioPlayer-Ereignis den Token des laufenden Streams mit. Er traegt
// Playlist, Titelnummer und Runde - alles, was "naechster Titel" braucht.
// Kein Schreibzugriff je Titel, kein Zustand, der veralten kann.
//
// **Die Wiederholung steht je Playlist im Dashboard.** Ist sie an, folgt nach
// dem letzten Titel wieder der erste, und die Runde zaehlt dabei hoch, damit
// der neue Token nie dem laufenden gleicht (Alexa lehnt ein ENQUEUE mit
// identischem Token ab - bei einer Playlist mit einem einzigen Titel waere
// sonst nach dem ersten Durchlauf Stille). Ist sie aus, wird hinter dem letzten
// Titel schlicht nichts mehr angehaengt.
import { speak, resolvedSlotValue, aufzaehlung, dynamischeEntitaeten } from './alexa.js'
import { istPrivateAdresse, zielErlaubt } from './netz.js'
import { istFritzFreigabe, importiereFritzOrdner, frischeSid, mitSid } from './fritznas.js'

// Weiterhin von hier zu haben: test/musik.test.mjs prueft die Grenzen ueber
// diesen Namen, und die Regel selbst steht jetzt in lib/netz.js.
export { istPrivateAdresse }

export const REDIS_KEY = 'musik_playlists';
export const SLOT_TYP = 'PLAYLIST_NAME';

const MAX_NAME = 64;
const MAX_TITEL = 200;
const MAX_URL = 2048;
const MAX_ORDNER = 256;
const TRENNER = '|';

// ---------------------------------------------------------------------------
// Reine Funktionen - ohne Netz und ohne Redis pruefbar (test/musik.test.mjs)
// ---------------------------------------------------------------------------

/**
 * Ein Anzeigename aus dem Dateinamen der URL: "01_Hallo-Welt.mp3" -> "01 Hallo Welt".
 *
 * Nur fuer die Anzeige am Echo Show und in der Alexa-App; gesprochen wird er
 * nie. Deshalb bleibt die fuehrende Nummer stehen - in der Liste ist sie die
 * Reihenfolge.
 */
export function titelnameAusUrl(url) {
  let pfad;
  try { pfad = new URL(url).pathname; } catch { return ''; }
  let datei = pfad.split('/').filter(Boolean).pop() || '';
  try { datei = decodeURIComponent(datei); } catch { /* bleibt roh */ }
  return datei
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Prueft eine Playlist aus dem Dashboard und bringt sie in die gespeicherte Form.
 *
 * `urls` kommt als Text (eine URL je Zeile, wahlweise `URL | Titelname`) oder
 * als Array derselben Zeilen. Leerzeilen sind erlaubt und werden uebergangen;
 * alles andere, was keine https-URL ist, ist ein Fehler **mit Zeilennummer** -
 * bei zwanzig kopierten Links ist "eine URL ist ungueltig" keine Hilfe.
 *
 * **Die beiden Schalter fehlen im Body: bisheriger Wert, sonst an.** Dasselbe
 * Muster wie `home` bei den Zonen in api/manage.js, und aus demselben Grund:
 * Ein Aufrufer, der ein Feld nicht kennt (ein Skript, eine aeltere
 * Oberflaeche), soll eine Titelliste korrigieren koennen, ohne nebenbei die
 * Wiederholung oder die Ansage umzulegen. Die Kehrseite ist, dass ein
 * Abwaehlen ausdruecklich als `false` ankommen muss - das Dashboard schickt
 * beide Felder deshalb immer mit. Bei einer neuen Playlist ist "an" die
 * Vorgabe, weil es das Verhalten vor diesen Einstellungen war.
 *
 * @param {object} body
 * @param {object|null} [bisher] die gespeicherte Playlist gleichen Namens
 * @returns {{ playlist: {name: string, titel: {url: string, name: string}[], wiederholen: boolean, ansage: boolean, zufall: boolean, fortsetzen: boolean} } | { fehler: string }}
 */
export function validierePlaylist(body, bisher = null) {
  const name = String(body?.name ?? '').trim();
  if (!name) return { fehler: 'Name fehlt' };
  if (name.length > MAX_NAME) return { fehler: `Name laenger als ${MAX_NAME} Zeichen` };
  if (name.includes(TRENNER)) return { fehler: `Name darf kein "${TRENNER}" enthalten` };

  let zeilen = body?.urls;
  if (typeof zeilen === 'string') zeilen = zeilen.split(/\r?\n/);
  if (!Array.isArray(zeilen)) return { fehler: 'URLs fehlen' };

  const titel = [];
  const gesehen = new Set();
  const fehler = [];
  zeilen.forEach((roh, i) => {
    const zeile = String(roh ?? '').trim();
    if (!zeile) return;
    const nr = `Zeile ${i + 1}`;
    const trennerAn = zeile.indexOf(TRENNER);
    const urlTeil = (trennerAn === -1 ? zeile : zeile.slice(0, trennerAn)).trim();
    const nameTeil = (trennerAn === -1 ? '' : zeile.slice(trennerAn + 1)).trim().slice(0, MAX_NAME);

    if (urlTeil.length > MAX_URL) { fehler.push(`${nr}: URL laenger als ${MAX_URL} Zeichen`); return; }
    let url;
    try { url = new URL(urlTeil); } catch { fehler.push(`${nr}: keine gueltige URL`); return; }
    if (url.protocol !== 'https:') { fehler.push(`${nr}: Alexa spielt nur https-URLs`); return; }
    if (url.username || url.password) { fehler.push(`${nr}: Zugangsdaten in der URL kann Alexa nicht mitschicken`); return; }
    if (gesehen.has(url.href)) { fehler.push(`${nr}: URL kommt doppelt vor`); return; }
    gesehen.add(url.href);
    titel.push({ url: url.href, name: nameTeil || titelnameAusUrl(url.href) });
  });

  if (fehler.length) return { fehler: fehler.slice(0, 5).join('; ') };
  if (titel.length === 0) return { fehler: 'Keine URL angegeben' };
  if (titel.length > MAX_TITEL) return { fehler: `Hoechstens ${MAX_TITEL} Titel je Playlist` };

  const playlist = {
    name,
    titel,
    wiederholen: uebernommen(body, bisher, 'wiederholen', true),
    ansage: uebernommen(body, bisher, 'ansage', true),
    zufall: uebernommen(body, bisher, 'zufall', false),
    fortsetzen: uebernommen(body, bisher, 'fortsetzen', false),
  };

  // Die Herkunft einer FRITZ!NAS-Freigabe, falls der Import sie mitgegeben
  // hat. Sie bleibt beim Speichern erhalten, solange niemand sie ausdruecklich
  // mit `quelle: null` entfernt - dasselbe Muster wie bei den Schaltern, und
  // aus demselben Grund: Wer nur eine Titelzeile korrigiert, soll der Playlist
  // nicht nebenbei die Auffrischung nehmen.
  const quelle = body?.quelle === null ? null : (fritzQuelle(body?.quelle) || bisher?.quelle || null);
  if (quelle) playlist.quelle = quelle;

  return { playlist };
}

/**
 * Nimmt eine Herkunftsangabe nur an, wenn sie eine FRITZ!NAS-Freigabe ist.
 *
 * Sie kommt aus dem Formular und wandert spaeter in einen Abruf des Servers -
 * ungeprueft waere sie eine Adresse, die sich jeder mit dem Admin-Passwort vom
 * Server holen lassen koennte. `istFritzFreigabe` laesst nur einen
 * `filelink.lua?id=…`-Link durch, und `zielErlaubt` prueft beim Abruf erneut.
 */
function fritzQuelle(roh) {
  if (!roh || typeof roh !== 'object') return null;
  if (roh.typ !== 'fritz' || typeof roh.link !== 'string') return null;
  if (roh.link.length > MAX_URL) return null;
  if (!istFritzFreigabe(roh.link)) return null;

  const quelle = { typ: 'fritz', link: roh.link };
  // Der Pfad kommt von der FRITZ!Box und dient nur der Anzeige. Er wird
  // gekappt und sonst nicht angefasst - das Dashboard setzt ihn ueber
  // textContent, nie als Markup.
  if (typeof roh.ordner === 'string' && roh.ordner.trim()) {
    quelle.ordner = roh.ordner.trim().slice(0, MAX_ORDNER);
  }
  return quelle;
}

/**
 * Steht dieser Schalter der Playlist auf "an"?
 *
 * **Ein fehlendes Feld bekommt die Vorgabe, und die ist je Schalter das
 * bisherige Verhalten.** Playlists, die vor einem Schalter angelegt wurden,
 * tragen ihn nicht und muessen sich unveraendert verhalten: Wiederholung und
 * Ansage liefen immer, also ist dort "an" die Vorgabe; gemischt und
 * fortgesetzt wurde nie, also ist dort "aus" die Vorgabe. `null` (gar keine
 * Playlist) ist der Fall "neu angelegt" und bekommt dasselbe.
 *
 * Die Vorgaben stehen deshalb an genau einer Stelle: in den vier Funktionen
 * unten. Wer einen Schalter hinzufuegt, entscheidet dort einmal und nirgends
 * sonst.
 */
function schalter(playlist, feld, vorgabe) {
  const wert = playlist?.[feld];
  return typeof wert === 'boolean' ? wert : vorgabe;
}

/** Wiederholt sich diese Playlist nach dem letzten Titel? Vorgabe: ja. */
export function wiederholtSich(playlist) {
  return schalter(playlist, 'wiederholen', true);
}

/** Sagt Alexa vor dem ersten Titel an, was sie spielt? Vorgabe: ja. */
export function sagtAn(playlist) {
  return schalter(playlist, 'ansage', true);
}

/** Spielt diese Playlist in zufaelliger Reihenfolge? Vorgabe: nein. */
export function mischt(playlist) {
  return schalter(playlist, 'zufall', false);
}

/** Setzt diese Playlist beim naechsten Mal dort fort, wo sie aufhoerte? Vorgabe: nein. */
export function setztFort(playlist) {
  return schalter(playlist, 'fortsetzen', false);
}

/** Der Wert eines Schalters aus dem Body, sonst der gespeicherte, sonst die Vorgabe. */
function uebernommen(body, bisher, feld, vorgabe) {
  return body && feld in body ? !!body[feld] : schalter(bisher, feld, vorgabe);
}

/** Vergleichsform eines Namens: klein, ohne Umlaute, nur Buchstaben und Ziffern. */
export function normalisiere(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Welche Playlist gemeint ist.
 *
 * Erst der aufgeloeste Slot-Wert (statische oder dynamische Autoritaet), dann
 * das, was Alexa gehoert hat: gleich, dann Anfang, dann enthalten. Die Kulanz
 * ist hier gewollt - bei "spiele Kinder" soll "Kinderlieder" laufen und nicht
 * eine Rueckfrage kommen.
 *
 * @returns {{ playlist: object|null, gesagt: string|null }}
 */
export function findePlaylist(playlists, slot) {
  const gesagt = resolvedSlotValue(slot);
  if (!gesagt) return { playlist: null, gesagt: null };
  const liste = playlists || [];
  const ziel = normalisiere(gesagt);
  const treffer = liste.find(p => p.name.toLowerCase() === gesagt.toLowerCase())
    || (ziel && liste.find(p => normalisiere(p.name) === ziel))
    || (ziel && liste.find(p => normalisiere(p.name).startsWith(ziel)))
    || (ziel && liste.find(p => normalisiere(p.name).includes(ziel) || ziel.includes(normalisiere(p.name))))
    || null;
  return { playlist: treffer, gesagt };
}

/**
 * Token eines Streams: `<playlist>|<position>|<runde>|<seed>`.
 *
 * **`position` ist die Stelle in der Abspielfolge, nicht die Nummer des
 * Titels.** Ohne Mischung sind beide gleich; mit Mischung sagt erst der Seed,
 * welcher Titel an dieser Stelle steht (siehe [reihenfolge]). Dadurch bleibt
 * der Zustand vollstaendig im Token: Alexa schickt ihn bei jedem Ereignis mit,
 * und die Mischung laesst sich daraus jederzeit neu berechnen, statt sie
 * irgendwo zu speichern.
 */
export function tokenBauen(name, position, runde, seed = 0) {
  return [name, position, runde, seed].join(TRENNER);
}

/**
 * Der Token zurueck in seine Teile - oder null, wenn er nicht von hier stammt.
 *
 * **Drei Teile werden weiter gelesen.** Ein Stream, der vor dem Seed gestartet
 * wurde, laeuft beim Deploy noch; sein Token darf nicht ploetzlich fremd
 * aussehen, sonst braeche die Wiedergabe mitten im Titel ab. Er gilt als
 * ungemischt, was er ja auch war.
 */
export function tokenLesen(token) {
  if (typeof token !== 'string') return null;
  const teile = token.split(TRENNER);
  if (teile.length !== 3 && teile.length !== 4) return null;
  const [name, p, r, s] = teile;
  const position = Number(p);
  const runde = Number(r);
  const seed = teile.length === 4 ? Number(s) : 0;
  if (!name || !Number.isInteger(position) || position < 0) return null;
  if (!Number.isInteger(runde) || runde < 0) return null;
  if (!Number.isInteger(seed) || seed < 0) return null;
  return { name, position, runde, seed };
}

/**
 * Die Abspielfolge: welche Titelnummer an welcher Stelle steht.
 *
 * Seed 0 heisst "nicht gemischt" und gibt die Reihenfolge der Liste zurueck.
 * Jeder andere Seed erzeugt **immer dieselbe** Mischung - das ist der Punkt:
 * Die Folge muss sich aus dem Token allein wiederherstellen lassen, bei jedem
 * Ereignis neu, ohne Speicher. Gemischt wird mit Fisher-Yates ueber einem
 * kleinen deterministischen Zufallsgenerator (mulberry32).
 *
 * Rein und exportiert, damit sich die Mischung ohne Netz pruefen laesst.
 */
export function reihenfolge(anzahl, seed) {
  const folge = Array.from({ length: Math.max(0, anzahl) }, (_, i) => i);
  if (!seed || folge.length < 2) return folge;
  let a = seed >>> 0;
  const zufall = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = folge.length - 1; i > 0; i--) {
    const j = Math.floor(zufall() * (i + 1));
    [folge[i], folge[j]] = [folge[j], folge[i]];
  }
  return folge;
}

/** Der Titel an dieser Stelle der Abspielfolge, samt seiner Nummer in der Liste. */
export function titelAn(playlist, position, seed) {
  const folge = reihenfolge(playlist.titel.length, seed);
  const nummer = folge[position] ?? 0;
  return { titel: playlist.titel[nummer], nummer };
}

/** Ein neuer Seed fuer eine frische Mischung. Nie 0, denn 0 heisst "ungemischt". */
export function neuerSeed() {
  return 1 + Math.floor(Math.random() * 0xFFFFFFE);
}

/**
 * Der naechste (richtung +1) oder vorige (-1) Titel - mit Umbruch.
 *
 * Die Runde zaehlt bei jedem Umbruch hoch. Bei einer Playlist mit einem
 * einzigen Titel ist jeder Schritt ein Umbruch - genau dann braucht der Token
 * die Runde, um sich vom laufenden zu unterscheiden.
 *
 * Ein Index jenseits der Liste (die Playlist wurde inzwischen gekuerzt) faellt
 * auf den Anfang zurueck statt auf einen Fehler.
 */
export function schritt(playlist, token, richtung) {
  const n = playlist?.titel?.length || 0;
  if (n === 0) return null;
  const von = token.position < n ? token.position : n - 1;
  const position = (((von + richtung) % n) + n) % n;
  const umbruch = richtung > 0 ? position <= von : position >= von;
  // **Beim Umbruch wird neu gemischt.** Sonst liefe in der zweiten Runde
  // genau dieselbe Folge wie in der ersten, und bei einer Playlist, die
  // stundenlang laeuft, faellt das auf. Ungemischt bleibt ungemischt.
  const seed = umbruch && token.seed ? neuerSeed() : token.seed;
  return { position, runde: token.runde + (umbruch ? 1 : 0), seed, umbruch };
}

/** Die Play-Direktive fuer die Stelle `position` der Abspielfolge. */
export function playDirektive(playlist, position, runde, { seed = 0, verhalten = 'REPLACE_ALL', offset = 0, vorherigerToken } = {}) {
  const { titel, nummer } = titelAn(playlist, position, seed);
  const stream = {
    url: titel.url,
    token: tokenBauen(playlist.name, position, runde, seed),
    offsetInMilliseconds: Math.max(0, Number(offset) || 0),
  };
  if (verhalten === 'ENQUEUE' && vorherigerToken) stream.expectedPreviousToken = vorherigerToken;
  return {
    type: 'AudioPlayer.Play',
    playBehavior: verhalten,
    audioItem: {
      stream,
      metadata: {
        title: titel.name || `Titel ${nummer + 1}`,
        // Gezaehlt wird die Stelle in der Folge, nicht die Nummer in der Liste:
        // Gemischt ist "3 von 12" die Auskunft, die jemand erwartet, der
        // gerade den dritten Titel hoert.
        subtitle: `${playlist.name} · ${position + 1} von ${playlist.titel.length}`,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Verwaltung: /api/manage?type=playlists
// ---------------------------------------------------------------------------

export async function handleManage(req, res, redis) {
  let playlists = await redis.get(REDIS_KEY) || [];

  if (req.method === 'GET') {
    // Der Import liest nur eine fremde Seite und aendert nichts - er steht
    // trotzdem hinter derselben Passwortpruefung wie der Rest von
    // /api/manage, weil er sonst ein offener Abruf-Dienst waere.
    if (req.query.import) return handleImport(req, res);
    if (req.query.pruefen) {
      const name = String(req.query.name || '').trim().toLowerCase();
      const playlist = playlists.find(p => p.name.toLowerCase() === name);
      if (!playlist) return res.status(404).json({ error: 'Unknown playlist' });
      const ab = Math.max(0, parseInt(req.query.ab, 10) || 0);
      return res.status(200).json(await pruefePlaylist(playlist, ab));
    }
    return res.status(200).json(playlists);
  }

  if (req.method === 'POST') {
    // Der Bestand VOR der Pruefung: validierePlaylist braucht ihn, um ein
    // fehlendes `wiederholen` auf den bisherigen Wert zu setzen statt auf die
    // Vorgabe. Gesucht wird ueber den rohen Namen aus dem Body - derselbe
    // Vergleich wie beim Upsert unten, nur eine Zeile frueher.
    const rohname = String(req.body?.name ?? '').trim().toLowerCase();
    const bisher = playlists.find(p => p.name.toLowerCase() === rohname) || null;

    const ergebnis = validierePlaylist(req.body || {}, bisher);
    if (ergebnis.fehler) return res.status(400).json({ error: ergebnis.fehler });
    const { playlist } = ergebnis;
    const index = playlists.findIndex(p => p.name.toLowerCase() === playlist.name.toLowerCase());
    if (index > -1) playlists[index] = playlist;
    else playlists.push(playlist);
    await redis.set(REDIS_KEY, playlists);
    return res.status(200).json({ success: true, playlists });
  }

  if (req.method === 'DELETE') {
    const name = String(req.body?.name || '').trim();
    playlists = playlists.filter(p => p.name.toLowerCase() !== name.toLowerCase());
    await redis.set(REDIS_KEY, playlists);
    return res.status(200).json({ success: true, playlists });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Vercel gibt einer Function zehn Sekunden. Vier parallele Abrufe mit je vier
// Sekunden Frist und zwanzig Titel je Aufruf bleiben darunter; das Dashboard
// holt den Rest mit `ab=` nach.
const PRUEF_SCHRITT = 20;
const PRUEF_PARALLEL = 4;
const PRUEF_FRIST_MS = 4000;
const PRUEF_UMLEITUNGEN = 3;

async function pruefePlaylist(playlist, ab) {
  const teil = playlist.titel.slice(ab, ab + PRUEF_SCHRITT);
  const ergebnisse = [];
  for (let i = 0; i < teil.length; i += PRUEF_PARALLEL) {
    const gruppe = teil.slice(i, i + PRUEF_PARALLEL);
    ergebnisse.push(...await Promise.all(gruppe.map(t => pruefeUrl(t.url))));
  }
  const weiter = ab + teil.length < playlist.titel.length ? ab + teil.length : null;
  return { name: playlist.name, ab, gesamt: playlist.titel.length, ergebnisse, weiter };
}

/**
 * Ein Abruf je URL, so wie ihn der Echo macht - nur kuerzer: `Range: bytes=0-0`.
 *
 * Aus der einen Antwort folgt alles, woran es in der Praxis scheitert: der
 * Status (404, 403), der Content-Type (eine HTML-Vorschauseite statt der
 * Datei) und ob der Server Bereiche liefert (206) - ohne Bereiche beginnt
 * "Alexa, weiter" nach einer Pause wieder von vorn.
 */
async function pruefeUrl(start) {
  const ergebnis = { url: start, status: null, contentType: null, range: false, fehler: null };
  let url;
  try { url = new URL(start); } catch { ergebnis.fehler = 'keine gueltige URL'; return ergebnis; }

  for (let hop = 0; hop <= PRUEF_UMLEITUNGEN; hop++) {
    const grund = await zielErlaubt(url);
    if (grund) { ergebnis.fehler = grund; return ergebnis; }

    let antwort;
    try {
      antwort = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { Range: 'bytes=0-0', 'User-Agent': 'musik-box-check/1.0' },
        signal: AbortSignal.timeout(PRUEF_FRIST_MS),
      });
    } catch (err) {
      ergebnis.fehler = err?.name === 'TimeoutError' ? 'keine Antwort binnen 4 s' : 'nicht erreichbar';
      return ergebnis;
    }
    try { await antwort.body?.cancel(); } catch { /* egal */ }

    if ([301, 302, 303, 307, 308].includes(antwort.status)) {
      const ziel = antwort.headers.get('location');
      if (!ziel) { ergebnis.fehler = 'Umleitung ohne Ziel'; return ergebnis; }
      try { url = new URL(ziel, url); } catch { ergebnis.fehler = 'Umleitung auf ungueltige URL'; return ergebnis; }
      continue;
    }

    ergebnis.status = antwort.status;
    ergebnis.contentType = (antwort.headers.get('content-type') || '').split(';')[0].trim() || null;
    ergebnis.range = antwort.status === 206
      || (antwort.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');
    if (!antwort.ok) ergebnis.fehler = `HTTP ${antwort.status}`;
    else if (ergebnis.contentType && !/^audio\//.test(ergebnis.contentType) && ergebnis.contentType !== 'application/octet-stream') {
      ergebnis.fehler = `liefert ${ergebnis.contentType}, keine Audiodatei`;
    }
    return ergebnis;
  }
  ergebnis.fehler = `mehr als ${PRUEF_UMLEITUNGEN} Umleitungen`;
  return ergebnis;
}

// ---------------------------------------------------------------------------
// Import: eine ganze Ordner-Freigabe als Titelliste
// ---------------------------------------------------------------------------
//
// **Das Problem.** Zwanzig Kinderlieder liegen in einem Ordner auf dem
// FRITZ!NAS. Die FRITZ!Box gibt dafuer *einen* Freigabe-Link
// (`.../nas/filelink.lua?id=…`), der im Browser die Dateiliste zeigt. Wer
// daraus eine Playlist machen will, muesste jeden Titel einzeln aufrufen und
// die Adresse abschreiben. Das ist der Grund fuer diesen Abschnitt: einmal den
// Ordner-Link eintragen, und die MP3s darin stehen als Zeilen im Formular.
//
// **Warum es der Server holt und nicht der Browser.** Die Seite ist eine
// fremde Herkunft; die CSP des Dashboards (`connect-src 'self'`) verbietet den
// Abruf, und selbst ohne sie fehlten die CORS-Kopfzeilen. Derselbe Weg wie bei
// "Check URLs" also - mit demselben SSRF-Schutz (`zielErlaubt`).
//
// **Warum ohne Kenntnis des HTML-Aufbaus.** Ein Parser, der auf die Klassen
// und Tabellenspalten *einer* FRITZ!OS-Version zugeschnitten ist, geht beim
// naechsten Update kaputt und taugt nirgends sonst. Gesucht wird deshalb nur,
// was alle Verzeichnisseiten gemeinsam haben: irgendwo im Dokument steht die
// Adresse der Datei in Anfuehrungszeichen - als `href`, als `src`, als Wert in
// einem JSON-Block. Alles in Anfuehrungszeichen wird eingesammelt, gegen den
// Ordner-Link absolut gemacht und behalten, wenn es nach einer Audiodatei
// aussieht. Damit funktioniert derselbe Knopf fuer den FRITZ!NAS-Link, einen
// Apache-Verzeichnisindex und eine Nextcloud-Ordnerfreigabe.
//
// **Und wenn nichts gefunden wird.** Dann sagt die Antwort, was die Seite
// stattdessen enthielt (Status, Inhaltstyp, ob ueberhaupt Dateinamen mit
// Audio-Endung vorkamen). Eine Seite, die ihre Liste erst per JavaScript
// nachlaedt, ist damit als solche erkennbar, statt als leeres Ergebnis zu
// erscheinen.

/** Endungen, die der Alexa-AudioPlayer abspielen kann. */
const AUDIO_ENDUNGEN = ['mp3', 'm4a', 'm4b', 'mp4', 'aac', 'mpga'];
const AUDIO_MUSTER = new RegExp(`\\.(?:${AUDIO_ENDUNGEN.join('|')})$`, 'i');

// Eine Frist fuer den ganzen Import, nicht je Abruf: Vercel gibt der Function
// zehn Sekunden, und drei Umleitungen mit je eigener Frist waeren laengst
// darueber - der Aufrufer saehe dann nicht den eigenen Fehler, sondern den
// Abbruch der Plattform.
const IMPORT_FRIST_MS = 8000;
const IMPORT_UMLEITUNGEN = 3;
// Eine Verzeichnisseite mit zweihundert Dateien bleibt weit darunter; mehr
// gelesen wird nur, wenn hinter dem Link etwas ganz anderes liegt.
const IMPORT_MAX_BYTES = 4 * 1024 * 1024;
// So viel Quelltext geht im Fehlerfall an das Dashboard zurueck. Eine
// Geruest-Seite bleibt darunter und kommt vollstaendig an; alles Groessere
// wird an beiden Enden genommen (siehe seitenDiagnose).
const DIAGNOSE_ZEICHEN = 12000;

/**
 * Sieht diese Adresse nach einer Audiodatei aus?
 *
 * Geprueft wird der Pfad **und** jeder Wert in der Abfrage: die FRITZ!Box und
 * Nextcloud haengen den Dateinamen an einen immer gleichen Pfad
 * (`…/filelink.lua?id=…&path=/Musik/01.mp3`), da endet der Pfad selbst nie auf
 * `.mp3`.
 */
export function istAudioUrl(url) {
  let u;
  try { u = url instanceof URL ? url : new URL(url); } catch { return false; }
  let pfad = u.pathname;
  try { pfad = decodeURIComponent(pfad); } catch { /* bleibt roh */ }
  if (AUDIO_MUSTER.test(pfad)) return true;
  for (const wert of u.searchParams.values()) {
    if (AUDIO_MUSTER.test(wert.trim())) return true;
  }
  return false;
}

/**
 * Loest die Maskierungen auf, die eine Adresse im Quelltext tragen kann.
 *
 * Drei Herkuenfte, drei Schreibweisen desselben Zeichens: HTML-Attribute
 * maskieren `&` als `&amp;`, JSON maskiert `/` als `\/` und `&` gern als
 * `&`. Wer das nicht aufloest, baut aus `?id=1&amp;path=x` eine Adresse
 * mit dem Abfragewert `amp;path` - und laedt eine Fehlerseite statt der Datei.
 */
function stringEntschaerfen(roh) {
  return roh
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, z) => String.fromCharCode(Number(z)))
    .replace(/&#x([0-9a-f]+);/gi, (_, z) => String.fromCharCode(parseInt(z, 16)));
}

/**
 * Alle Audio-Adressen aus dem Quelltext einer Verzeichnisseite, in der
 * Reihenfolge, in der sie dort stehen.
 *
 * Die Reihenfolge ist die Reihenfolge der Playlist, deshalb wird das Dokument
 * von vorn nach hinten gelesen und nichts nachsortiert.
 *
 * **Zwei Durchlaeufe, und der zweite nur bei Bedarf.** Zuerst zaehlen nur die
 * Adressattribute (`href`, `src`, `data-…`); dort ist auch ein blosser
 * Dateiname eine Adresse, wie im Verzeichnisindex eines Apache. Findet das
 * nichts, liegt die Liste in einem JSON-Block - dann wird jede Zeichenkette im
 * Dokument geprueft, aber nur noch, was wie ein Pfad aussieht (`/`, `?` oder
 * `:`). Der Unterschied ist nicht kosmetisch: JSON traegt neben der Adresse
 * auch den Anzeigenamen, und `"01 Hallo.mp3"` als relative Adresse gelesen
 * ergaebe eine Datei, die es nicht gibt - eine Zeile, die im Formular
 * plausibel aussieht und am Echo ins Leere laeuft.
 *
 * @param {string} html der Quelltext
 * @param {string} basis die Adresse, unter der er geholt wurde
 * @returns {string[]} absolute Adressen, ohne Dubletten
 */
export function audioLinksAusHtml(html, basis) {
  const quelltext = String(html);
  const ausAttributen = sammleAudioLinks(
    quelltext.matchAll(/\b(?:href|src|data-[a-z-]+)\s*=\s*(?:"([^"\r\n]{1,2048})"|'([^'\r\n]{1,2048})')/gi),
    basis,
    () => true,
  );
  if (ausAttributen.length) return ausAttributen;

  return sammleAudioLinks(
    quelltext.matchAll(/"([^"\r\n]{3,2048})"|'([^'\r\n]{3,2048})'/g),
    basis,
    kandidat => /[/?:]/.test(kandidat),
  );
}

/** Der gemeinsame Rumpf beider Durchlaeufe: entschaerfen, aufloesen, filtern. */
function sammleAudioLinks(treffer, basis, taugtAlsAdresse) {
  const links = [];
  const gesehen = new Set();
  for (const m of treffer) {
    const kandidat = stringEntschaerfen(m[1] ?? m[2]).trim();
    // Leerzeichen bleiben erlaubt - ein `href="Mein Lied.mp3"` ist gueltiges
    // HTML, und `new URL()` macht %20 daraus. Tabulatoren und Umbrueche nicht:
    // was die traegt, ist Fliesstext und keine Adresse.
    if (!kandidat || /[\t\n\r]/.test(kandidat)) continue;
    if (!taugtAlsAdresse(kandidat)) continue;
    if (!AUDIO_MUSTER.test(kandidat.split(/[?#]/)[0]) && !kandidat.includes('?')) continue;
    let url;
    try { url = new URL(kandidat, basis); } catch { continue; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (!istAudioUrl(url)) continue;
    if (gesehen.has(url.href)) continue;
    gesehen.add(url.href);
    links.push(url.href);
  }
  return links;
}

/**
 * Dateinamen mit Audio-Endung im sichtbaren Text - nur fuer die Diagnose.
 *
 * Findet der Link-Parser nichts, dieser aber schon, dann listet die Seite die
 * Dateien, ohne sie zu verlinken: sie baut die Adressen erst im Browser. Das
 * ist der einzige Fall, in dem "keine MP3s gefunden" in die Irre fuehren
 * wuerde, und deshalb steht er als eigener Hinweis in der Antwort.
 */
export function audioNamenImText(html) {
  const namen = [];
  const gesehen = new Set();
  const muster = new RegExp(`>\\s*([^<>"'\r\n]{1,200}\\.(?:${AUDIO_ENDUNGEN.join('|')}))\\s*<`, 'gi');
  for (const m of String(html).matchAll(muster)) {
    const name = m[1].trim();
    if (gesehen.has(name)) continue;
    gesehen.add(name);
    namen.push(name);
  }
  return namen;
}

/**
 * Was hinter dem Link wirklich steht - fuer den Fall, dass der Import nichts
 * findet.
 *
 * **Warum die Seite mitgeschickt wird.** "Keine Dateiliste mit Audiodateien"
 * ist eine ehrliche Meldung und trotzdem eine Sackgasse: Sie sagt nicht, ob
 * der Link auf den falschen Ordner zeigt, ob die Anmeldung dazwischensteht
 * oder ob die Liste erst im Browser entsteht. Das steht alles im Quelltext,
 * und den kann nur abrufen, wer die Box erreicht - der Server also, nicht
 * zwingend der Mensch am Dashboard. Statt ihn durch die Entwicklerwerkzeuge
 * seines Browsers zu schicken, liefert die Antwort den Quelltext gleich mit.
 *
 * **Nur im Fehlerfall, und nur hinter dem Passwort.** Findet der Import
 * Titel, taucht die Diagnose nicht auf; ohne `ADMIN_PASSWORD` kommt niemand
 * an diesen Aufruf. Der Auszug ist fremder HTML-Code und gehoert im Dashboard
 * in ein Textfeld, nie in `innerHTML`.
 */
export function seitenDiagnose(html, grenze = DIAGNOSE_ZEICHEN) {
  const quelltext = String(html);
  const titel = (quelltext.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1] || '').trim() || null;
  const skripte = [...quelltext.matchAll(/<script[^>]+src\s*=\s*["']([^"']{1,512})["']/gi)]
    .map(m => m[1])
    .slice(0, 20);

  // Passt die Seite ganz hinein, geht sie ganz mit - eine Geruest-Seite, die
  // ihre Liste nachlaedt, ist klein. Sonst zaehlen Anfang und Ende: vorn
  // stehen die Skripte und die Anmeldung, hinten oft die Daten.
  let auszug = quelltext;
  if (quelltext.length > grenze) {
    const vorn = Math.floor(grenze * 0.75);
    const hinten = grenze - vorn;
    auszug = `${quelltext.slice(0, vorn)}\n\n… [${quelltext.length - grenze} Zeichen ausgelassen] …\n\n${quelltext.slice(-hinten)}`;
  }
  return { titel, laenge: quelltext.length, skripte, auszug };
}

/**
 * Holt die Seite hinter dem Ordner-Link und macht Zeilen fuer das Formular
 * daraus: `GET /api/manage?type=playlists&import=1&url=<Ordner-Link>`.
 *
 * Geliefert wird **nicht gespeichert, sondern vorgeschlagen**: Die Antwort
 * traegt die Titel, das Dashboard schreibt sie in die Textarea, und was dort
 * steht, sieht man vor dem Speichern. Bei zwanzig Dateien, von denen zwei
 * nicht in die Playlist sollen, ist das der Unterschied zwischen einem
 * Loeschen von zwei Zeilen und einem Import, den man wieder auseinandernimmt.
 */
export async function handleImport(req, res) {
  const start = String(req.query.url || '').trim();
  if (!start) return res.status(400).json({ error: 'Kein Ordner-Link angegeben' });
  if (start.length > MAX_URL) return res.status(400).json({ error: `Link laenger als ${MAX_URL} Zeichen` });

  let url;
  try { url = new URL(start); } catch { return res.status(400).json({ error: 'Keine gueltige URL' }); }

  // Eine FRITZ!NAS-Ordnerfreigabe geht einen eigenen Weg: Ihre Seite ist leer
  // und die Liste steckt hinter einer Schnittstelle, nicht im Quelltext. Wer
  // hier nach Links sucht, findet nichts - siehe lib/fritznas.js.
  const freigabe = istFritzFreigabe(url);
  if (freigabe) {
    const ergebnis = await importiereFritzOrdner(freigabe, MAX_TITEL);
    if (ergebnis.fehler) {
      return res.status(200).json({
        url: url.href,
        titel: [],
        hinweise: [],
        error: ergebnis.fehler,
        bericht: ergebnis.bericht,
      });
    }
    return res.status(200).json({
      url: url.href,
      titel: ergebnis.titel.map(t => ({ url: t.url, name: t.name })),
      hinweise: ergebnis.hinweise,
      bericht: ergebnis.bericht,
      // Der Freigabe-Link geht mit zurueck, damit das Dashboard ihn beim
      // Speichern mitschickt: Aus ihm holt der Skill spaeter eine frische
      // Sitzungsnummer, statt die eingebaute veralten zu lassen. Der Pfad
      // dazu, weil "/Musik/Schlaflieder" in der Liste etwas sagt und eine
      // Freigabenummer nicht.
      quelle: { typ: 'fritz', link: url.href, ...(ergebnis.wurzel ? { ordner: ergebnis.wurzel } : {}) },
    });
  }

  // Die Cookies der Antwort gehen in den naechsten Aufruf: Verzeichnisseiten
  // setzen oft beim ersten Abruf eine Sitzung und leiten dann auf sich selbst
  // um. Ohne das Cookie landet der zweite Abruf wieder am Anfang.
  let kekse = '';
  let antwort = null;
  const frist = Date.now() + IMPORT_FRIST_MS;
  for (let hop = 0; hop <= IMPORT_UMLEITUNGEN; hop++) {
    const grund = await zielErlaubt(url);
    if (grund) return res.status(400).json({ error: `Ordner-Link: ${grund}` });

    try {
      antwort = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'User-Agent': 'musik-box-import/1.0',
          ...(kekse ? { Cookie: kekse } : {}),
        },
        signal: AbortSignal.timeout(Math.max(500, frist - Date.now())),
      });
    } catch (err) {
      const fehler = err?.name === 'TimeoutError'
        ? `Der Ordner-Link antwortet nicht binnen ${IMPORT_FRIST_MS / 1000} Sekunden`
        : 'Der Ordner-Link ist nicht erreichbar';
      return res.status(502).json({ error: fehler });
    }

    const gesetzt = antwort.headers.getSetCookie?.() || [];
    if (gesetzt.length) {
      kekse = [kekse, ...gesetzt.map(c => c.split(';')[0])].filter(Boolean).join('; ');
    }

    if ([301, 302, 303, 307, 308].includes(antwort.status)) {
      const ziel = antwort.headers.get('location');
      try { await antwort.body?.cancel(); } catch { /* egal */ }
      if (!ziel) return res.status(502).json({ error: 'Der Ordner-Link leitet ins Leere um' });
      try { url = new URL(ziel, url); } catch { return res.status(502).json({ error: 'Der Ordner-Link leitet auf eine ungueltige Adresse um' }); }
      antwort = null;
      continue;
    }
    break;
  }
  if (!antwort) return res.status(502).json({ error: `Mehr als ${IMPORT_UMLEITUNGEN} Umleitungen` });

  if (!antwort.ok) {
    try { await antwort.body?.cancel(); } catch { /* egal */ }
    return res.status(502).json({ error: `Der Ordner-Link antwortet mit HTTP ${antwort.status}` });
  }

  const inhaltstyp = (antwort.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  // Zeigt der Link direkt auf eine Datei, ist das kein Fehler des Nutzers,
  // sondern die haeufigste Verwechslung: Datei-Freigabe statt Ordner-Freigabe.
  if (/^audio\//.test(inhaltstyp)) {
    return res.status(200).json({
      url: url.href,
      titel: [{ url: url.href, name: titelnameAusUrl(url.href) }],
      hinweise: ['Der Link zeigt auf eine einzelne Audiodatei, nicht auf einen Ordner.'],
    });
  }

  let html;
  try { html = await leseGekappt(antwort, IMPORT_MAX_BYTES, zeichensatz(antwort), frist); } catch {
    return res.status(502).json({ error: 'Die Seite hinter dem Ordner-Link liess sich nicht lesen' });
  }

  const gefunden = audioLinksAusHtml(html, url.href);
  const httpsNur = gefunden.filter(u => u.startsWith('https://'));
  const hinweise = [];
  if (httpsNur.length < gefunden.length) {
    hinweise.push(`${gefunden.length - httpsNur.length} Adresse(n) uebergangen, weil sie nur ueber http erreichbar sind – Alexa spielt ausschliesslich https.`);
  }

  // Nichts gefunden ist kein Serverfehler - der Abruf hat geklappt, die Seite
  // gibt nur nichts her. Deshalb 200 mit `error`: Das Dashboard zeigt den Satz
  // als Fehler an und bekommt die Hinweise trotzdem mit.
  if (!httpsNur.length) {
    const namen = audioNamenImText(html);
    const fehler = namen.length
      ? `Die Seite nennt ${namen.length} Audiodatei(en) (z. B. "${namen[0]}"), verlinkt sie aber nicht direkt – sie baut die Adressen erst im Browser. Dieser Ordner-Link laesst sich nicht importieren.`
      : `Hinter dem Link steht keine Dateiliste mit Audiodateien (HTTP ${antwort.status}, ${inhaltstyp || 'ohne Inhaltstyp'}).`;
    return res.status(200).json({ url: url.href, titel: [], hinweise, error: fehler, diagnose: seitenDiagnose(html) });
  }

  const gekappt = httpsNur.slice(0, MAX_TITEL);
  if (gekappt.length < httpsNur.length) {
    hinweise.push(`${httpsNur.length} Dateien gefunden, uebernommen werden die ersten ${MAX_TITEL} – mehr traegt eine Playlist nicht.`);
  }

  return res.status(200).json({
    url: url.href,
    titel: gekappt.map(u => ({ url: u, name: titelnameAusUrl(u) })),
    hinweise,
  });
}

/**
 * Der Zeichensatz aus der Kopfzeile, sonst UTF-8.
 *
 * Aeltere FRITZ!OS-Oberflaechen liefern ISO-8859-1. Fuer die Adressen selbst
 * ist das gleich - die sind prozentkodiert und damit reines ASCII -, aber ein
 * Ordnername mit Umlaut im sichtbaren Text wuerde sonst als Ersatzzeichen in
 * der Diagnosemeldung landen.
 */
function zeichensatz(antwort) {
  const treffer = (antwort.headers.get('content-type') || '').match(/charset=\s*"?([\w-]+)"?/i);
  return treffer ? treffer[1].toLowerCase() : 'utf-8';
}

/**
 * Liest den Rumpf einer Antwort, hoert aber nach `grenze` Bytes auf.
 *
 * `antwort.text()` haette kein Limit: ein Link, hinter dem statt einer
 * Dateiliste ein Film liegt, zoege ihn vollstaendig in den Speicher der
 * Function. Gelesen wird deshalb stueckweise, und beim Ueberschreiten wird
 * abgebrochen - was bis dahin da ist, reicht fuer jede Verzeichnisseite.
 */
async function leseGekappt(antwort, grenze, kodierung = 'utf-8', frist = Infinity) {
  if (!antwort.body) return await antwort.text();
  const leser = antwort.body.getReader();
  let decoder;
  try { decoder = new TextDecoder(kodierung); } catch { decoder = new TextDecoder('utf-8'); }
  let text = '';
  let gelesen = 0;
  try {
    while (gelesen < grenze && Date.now() < frist) {
      const { done, value } = await leser.read();
      if (done) break;
      gelesen += value.length;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    try { await leser.cancel(); } catch { /* egal */ }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Der Skill: /api/skill mit applicationId == MUSIK_SKILL_ID
// ---------------------------------------------------------------------------

const STOP = { type: 'AudioPlayer.Stop' };

/**
 * Wo eine Playlist zuletzt stand - fuer "Weiterhoeren".
 *
 * **Warum ueberhaupt gespeichert.** Alexa merkt sich die Stelle selbst, aber
 * nur so lange auf dem Geraet nichts anderes lief: `context.AudioPlayer` traegt
 * dann Token und Offset, und `AMAZON.ResumeIntent` genuegt. Sobald jemand
 * dazwischen Radio hoert oder ein zweiter Echo im Spiel ist, ist die Stelle
 * weg - bei einem Hoerspiel genau dann, wenn man sie braucht.
 *
 * **Ein Eintrag je Playlist, nicht je Person.** Der Skill bedient einen
 * Haushalt mit einem Amazon-Konto; wer im Kinderzimmer weiterhoert, soll dort
 * weitermachen, wo im Wohnzimmer aufgehoert wurde. Das ist hier das gewuenschte
 * Verhalten und nicht der Mangel, als der es in einem oeffentlichen Skill
 * gaelte.
 */
const STAND_KEY = 'musik_stand';

async function standLesen(redis, name) {
  try {
    const alle = await redis.get(STAND_KEY) || {};
    return alle[name.toLowerCase()] || null;
  } catch (err) {
    // Ohne Stand faengt die Playlist von vorn an. Das ist die schlechtere
    // Auskunft, aber kein Grund, die Wiedergabe scheitern zu lassen.
    console.warn('Stand nicht lesbar:', err);
    return null;
  }
}

async function standSchreiben(redis, name, stand) {
  try {
    const alle = await redis.get(STAND_KEY) || {};
    alle[name.toLowerCase()] = { ...stand, zeit: Date.now() };
    await redis.set(STAND_KEY, alle);
  } catch (err) {
    console.warn('Stand nicht speicherbar:', err);
  }
}

async function standLoeschen(redis, name) {
  try {
    const alle = await redis.get(STAND_KEY) || {};
    if (!(name.toLowerCase() in alle)) return;
    delete alle[name.toLowerCase()];
    await redis.set(STAND_KEY, alle);
  } catch (err) {
    console.warn('Stand nicht loeschbar:', err);
  }
}

/**
 * Haelt fest, wo die Wiedergabe gerade steht.
 *
 * Aufgerufen bei PlaybackStarted (Anfang eines Titels) und PlaybackStopped
 * (Pause, Stop, Wechsel) - letzteres bringt den Offset mit und ist damit der
 * genaue Punkt. Nur fuer Playlists, die fortgesetzt werden sollen: Sonst
 * schriebe jeder Titelwechsel jeder Playlist in die Datenbank, fuer nichts.
 */
async function standMerken(body, playlists, redis) {
  const lage = laufendes(body, playlists);
  if (!lage || !setztFort(lage.playlist)) return;
  await standSchreiben(redis, lage.playlist.name, {
    position: lage.token.position,
    runde: lage.token.runde,
    seed: lage.token.seed,
    offset: body.request?.offsetInMilliseconds || 0,
  });
}

/** Antwort ohne Sprache - fuer AudioPlayer- und PlaybackController-Ereignisse. */
function still(res, direktiven = []) {
  const response = {};
  if (direktiven.length) response.directives = direktiven;
  return res.status(200).json({ version: '1.0', response });
}

function namenListe(playlists) {
  return aufzaehlung(playlists.map(p => p.name));
}

function frageWelche(res, satz, playlists, direktiven) {
  const namen = namenListe(playlists);
  return speak(res, namen ? `${satz} Ich kenne ${namen}.` : `${satz}`, false, direktiven);
}

/** Playlist und Titel zum laufenden Stream - oder null, wenn nichts (mehr) laeuft. */
function laufendes(body, playlists) {
  // Bei AudioPlayer-Ereignissen steht der betroffene Stream in request.token
  // (bei PlaybackFailed der gescheiterte, nicht der gerade laufende).
  const token = tokenLesen(body.request?.token ?? body.context?.AudioPlayer?.token);
  if (!token) return null;
  const playlist = playlists.find(p => p.name === token.name);
  if (!playlist || playlist.titel.length === 0) return null;
  return { token, playlist, offset: body.context?.AudioPlayer?.offsetInMilliseconds || 0 };
}

// ---------------------------------------------------------------------------
// FRITZ!NAS: die Sitzungsnummer zur Abspielzeit
// ---------------------------------------------------------------------------
//
// **Das Problem.** Eine Adresse aus einer FRITZ!NAS-Ordnerfreigabe traegt eine
// Sitzungsnummer, und die Box vergisst eine Sitzung nach etwa zwanzig Minuten
// Ruhe. Gespeichert bleibt sie also nur einen Abend gueltig; danach bleibt der
// Echo stumm, ohne dass irgendwo ein Fehler auftaucht.
//
// **Die Loesung.** Der Weg zur Datei aendert sich nie, nur die Nummer darin.
// Vor jeder Antwort wird `sid=` in den Adressen der Playlist durch eine
// ausgetauscht, die die Box gerade annimmt. Die Playlist bleibt eine ganz
// gewoehnliche Liste von URLs; nur diese eine Stelle weiss von FRITZ!NAS.
//
// **Warum nur eine Playlist.** Die Nummer zu holen kostet zwei Abrufe bei der
// Box. Alexa gibt dem Skill acht Sekunden, also wird nur die Playlist
// aufgefrischt, um die es in diesem Request geht - erkannt am Token des
// laufenden Streams oder am Slot des Intents. Wer keine FRITZ!NAS-Playlist
// hat, merkt von alldem nichts: Die Funktion steigt vorher aus.
//
// **Warum zwischengespeichert.** Zwei Abrufe bei jedem Titelwechsel waeren
// Verschwendung und Latenz; eine Nummer bleibt Minuten gueltig. Sie liegt
// deshalb in Redis, knapp unter der Lebensdauer, die eine FRITZ!Box zugesteht.

const FRITZ_SID_KEY = 'musik_fritz_sid';
/**
 * Wie lange eine geholte Nummer weiterverwendet wird.
 *
 * Eine FRITZ!Box laesst eine Sitzung etwa zwanzig Minuten ruhen. Acht Minuten
 * sind der Sicherheitsabstand dazu: lang genug, dass ein Album ohne
 * Zwischenfrage durchlaeuft, kurz genug, dass eine Nummer nicht abgelaufen
 * ist, waehrend Alexa sie noch benutzt.
 */
const FRITZ_SID_MINUTEN = 8;

/**
 * Tauscht in den Adressen der gemeinten Playlist die Sitzungsnummer aus.
 *
 * Gibt immer eine brauchbare Liste zurueck: Scheitert das Auffrischen, bleiben
 * die alten Adressen stehen. Sie sind dann vielleicht abgelaufen - aber eine
 * Playlist mit vielleicht toten Adressen ist besser als gar keine, und der
 * Fehlerweg des Skills (PlaybackFailed) fasst das ohnehin ab.
 */
async function fritzAufgefrischt(playlists, body, redis) {
  if (!playlists.some(p => p.quelle?.typ === 'fritz')) return playlists;

  const gemeint = gemeintePlaylist(playlists, body);
  if (gemeint?.quelle?.typ !== 'fritz') return playlists;

  // **Ein gescheiterter Titel ueberholt die Frist.** Konnte der Echo eine
  // Datei nicht laden, ist die abgelaufene Sitzungsnummer der bei weitem
  // haeufigste Grund - und der naechste Titel traegt dieselbe. Hier wird
  // deshalb sofort eine neue geholt, statt die gemerkte ihre acht Minuten
  // auszusitzen: Der Skill spielt dann mit dem naechsten Titel weiter, statt
  // eine ganze Runde lang an derselben toten Nummer zu scheitern.
  const erzwingen = body?.request?.type === 'AudioPlayer.PlaybackFailed';

  const sid = await fritzSid(gemeint.quelle.link, redis, erzwingen);
  if (!sid) return playlists;

  return playlists.map(p => (p === gemeint
    ? { ...p, titel: p.titel.map(t => ({ ...t, url: mitSid(t.url, sid) })) }
    : p));
}

/**
 * Um welche Playlist geht es in diesem Request?
 *
 * **Der gesprochene Wunsch steht ueber dem laufenden Stream.** Sagt jemand
 * "spiele Schlaflieder", waehrend noch die Kinderlieder laufen, traegt der
 * Context weiter deren Token - wer den zuerst nimmt, frischt die falsche
 * Playlist auf und laesst die gewuenschte mit einer alten Nummer los. Erst
 * wenn kein Slot da ist (jedes AudioPlayer-Ereignis, "weiter", "naechster
 * Titel"), entscheidet der Token.
 *
 * Beide Wege nehmen dieselben Funktionen wie die Handler danach, damit hier
 * nicht eine zweite, leicht abweichende Suche entsteht.
 */
function gemeintePlaylist(playlists, body) {
  const slot = body?.request?.intent?.slots?.playlist || body?.request?.intent?.slots?.suche;
  if (slot) {
    const { playlist } = findePlaylist(playlists, slot);
    if (playlist) return playlist;
  }
  return laufendes(body, playlists)?.playlist || null;
}

/** Eine gueltige Sitzungsnummer - aus Redis, sonst frisch von der Box. */
async function fritzSid(link, redis, erzwingen = false) {
  const freigabe = istFritzFreigabe(link);
  if (!freigabe) return null;

  let bestand = null;
  try { bestand = await redis.get(FRITZ_SID_KEY) || {}; } catch { bestand = {}; }
  const gemerkt = bestand?.[link];
  if (!erzwingen && gemerkt?.sid && Date.now() - (gemerkt.zeit || 0) < FRITZ_SID_MINUTEN * 60_000) {
    return gemerkt.sid;
  }

  const ergebnis = await frischeSid(freigabe);
  if (!ergebnis.sid) {
    console.error(`FRITZ!NAS-Sitzung fuer ${link}: ${ergebnis.fehler}`);
    return gemerkt?.sid || null;
  }
  try {
    await redis.set(FRITZ_SID_KEY, { ...bestand, [link]: { sid: ergebnis.sid, zeit: Date.now() } });
  } catch (err) {
    // Nicht schlimm: Ohne Zwischenspeicher wird sie beim naechsten Mal erneut
    // geholt. Die Wiedergabe jetzt haengt nicht daran.
    console.error(`${FRITZ_SID_KEY} nicht schreibbar:`, err);
  }
  return ergebnis.sid;
}

export async function handleSkill(body, res, redis) {
  let playlists = [];
  try {
    playlists = await redis.get(REDIS_KEY) || [];
  } catch (err) {
    // Kein Abbruch: Ohne Liste kann der Skill immer noch sagen, dass er keine
    // Playlist kennt. Ein 500 waere hier "Es gab ein Problem mit dem Skill".
    console.error(`${REDIS_KEY} nicht lesbar:`, err);
  }
  playlists = await fritzAufgefrischt(playlists, body, redis);
  const direktiven = dynamischeEntitaeten(SLOT_TYP, playlists.map(p => p.name));
  const typ = body.request.type;

  // **Die `await` vor den async-Zweigen sind nicht ueberfluessig.** Ein
  // `return f()` gibt die Promise heraus, bevor sie sich entscheidet - der
  // catch unten saehe einen Fehler daraus nie, und Alexa bekaeme eine
  // abgebrochene Antwort statt eines Satzes.
  try {
    if (typ === 'LaunchRequest') {
      if (playlists.length === 0) {
        return speak(res, 'Es ist noch keine Playlist angelegt. Bitte lege im Dashboard eine an.', true);
      }
      return frageWelche(res, 'Welche Playlist soll ich spielen?', playlists, direktiven);
    }

    if (typ === 'IntentRequest') {
      const intent = body.request.intent || {};
      switch (intent.name) {
        case 'PlayPlaylistIntent':
        case 'SuchePlaylistIntent':
          return await handlePlay(intent, res, playlists, direktiven, redis);
        case 'ListPlaylistsIntent':
          return handleList(res, playlists, direktiven);
        case 'AMAZON.PauseIntent':
        case 'AMAZON.StopIntent':
        case 'AMAZON.CancelIntent':
          return still(res, [STOP]);
        case 'AMAZON.ResumeIntent':
          return weiter(body, res, playlists, direktiven);
        case 'AMAZON.NextIntent':
          return springe(body, res, playlists, +1);
        case 'AMAZON.PreviousIntent':
          return springe(body, res, playlists, -1);
        case 'AMAZON.StartOverIntent':
          return await vonVorn(body, res, playlists, redis);
        case 'AMAZON.LoopOnIntent':
        case 'AMAZON.LoopOffIntent':
        case 'AMAZON.RepeatIntent':
          return loopAuskunft(body, res, playlists);
        case 'AMAZON.ShuffleOnIntent':
          return mischen(body, res, playlists, true);
        case 'AMAZON.ShuffleOffIntent':
          return mischen(body, res, playlists, false);
        case 'AMAZON.HelpIntent':
          return frageWelche(
            res,
            'Sag zum Beispiel: spiele Kinderlieder. Oder: welche Playlists gibt es. '
            + 'Waehrend der Wiedergabe gehen naechster Titel, voriger Titel, Pause und weiter.',
            playlists,
            direktiven,
          );
        case 'AMAZON.NavigateHomeIntent':
          return speak(res, 'Bis bald.', true);
        case 'AMAZON.FallbackIntent':
        default:
          return frageWelche(res, 'Das habe ich leider nicht verstanden. Welche Playlist soll ich spielen?', playlists, direktiven);
      }
    }

    if (typ === 'AudioPlayer.PlaybackNearlyFinished') return await naechsterTitel(body, res, playlists, redis);
    if (typ === 'AudioPlayer.PlaybackFailed') return nachFehler(body, res, playlists);

    // Die beiden Ereignisse, die den Stand fuehren. PlaybackStopped bringt den
    // Offset mit und ist der genaue Punkt; PlaybackStarted sichert wenigstens
    // den Titelanfang, falls danach nichts mehr kommt (Stromausfall, Absturz).
    if (typ === 'AudioPlayer.PlaybackStarted' || typ === 'AudioPlayer.PlaybackStopped') {
      await standMerken(body, playlists, redis);
      return still(res);
    }

    if (typ === 'PlaybackController.NextCommandIssued') return springe(body, res, playlists, +1);
    if (typ === 'PlaybackController.PreviousCommandIssued') return springe(body, res, playlists, -1);
    if (typ === 'PlaybackController.PlayCommandIssued') return weiter(body, res, playlists, [], true);
    if (typ === 'PlaybackController.PauseCommandIssued') return still(res, [STOP]);

    if (typ === 'System.ExceptionEncountered') {
      console.error('Alexa meldet:', JSON.stringify(body.request.error), JSON.stringify(body.request.cause));
    }
    // PlaybackStarted/Finished/Stopped, SessionEndedRequest und alles andere:
    // leere Antwort, Sprache ist hier nicht erlaubt
    return still(res);
  } catch (err) {
    console.error('Musik-Skill-Fehler:', err);
    if (typ === 'LaunchRequest' || typ === 'IntentRequest') {
      return speak(res, 'Es ist leider ein Fehler aufgetreten.');
    }
    return still(res);
  }
}

/**
 * Zwei Intents landen hier, und das ist der Kern der Namenserkennung.
 *
 * **`SuchePlaylistIntent` traegt einen `AMAZON.SearchQuery`-Slot**, also freien
 * Text: Er erkennt jeden Playlistnamen, auch einen, der nirgends im Modell
 * steht. Das ist der Ein-Satz-Aufruf ("spiele Taschenlampe"), und dafuer gibt
 * es ihn - ein eigener Slot-Typ erkennt Unbekanntes nur, wenn es den
 * eingetragenen Werten aehnelt, und daran sind "Zaehne putzen" und
 * "Taschenlampe" nacheinander gescheitert.
 *
 * **`PlayPlaylistIntent` traegt weiter den eigenen Slot-Typ** und beantwortet
 * die Rueckfrage ("Welche Playlist?" - "Taschenlampe"). Dort muss ein Sample
 * aus dem Slot allein bestehen duerfen, was SearchQuery verbietet, und dort
 * wirken die dynamischen Werte aus dem Dashboard.
 *
 * Beide zusammen decken damit ab, was einer allein nicht kann. Der Slot heisst
 * je nach Intent anders; welcher ankommt, ist dem Rest egal.
 */
async function handlePlay(intent, res, playlists, direktiven, redis) {
  if (playlists.length === 0) {
    return speak(res, 'Es ist noch keine Playlist angelegt. Bitte lege im Dashboard eine an.', true);
  }
  const { playlist, gesagt } = findePlaylist(playlists, intent.slots?.playlist || intent.slots?.suche);
  if (!gesagt) return frageWelche(res, 'Welche Playlist soll ich spielen?', playlists, direktiven);
  if (!playlist) {
    return frageWelche(res, `Ich habe keine Playlist namens ${gesagt} gefunden.`, playlists, direktiven);
  }
  if (playlist.titel.length === 0) {
    return speak(res, `Die Playlist ${playlist.name} hat noch keine Titel.`, true, direktiven);
  }
  // **Wo fangen wir an?** Steht "Weiterhoeren" an und liegt ein Stand vor, dort;
  // sonst am Anfang. Ein Stand jenseits der Liste (die Playlist wurde seither
  // gekuerzt) faellt auf den Anfang zurueck, statt ins Leere zu greifen.
  let position = 0;
  let runde = 0;
  let seed = mischt(playlist) ? neuerSeed() : 0;
  let offset = 0;
  let weiter = false;

  if (setztFort(playlist)) {
    const stand = await standLesen(redis, playlist.name);
    if (stand && Number.isInteger(stand.position) && stand.position < playlist.titel.length) {
      position = stand.position;
      runde = Number.isInteger(stand.runde) ? stand.runde : 0;
      // Der gespeicherte Seed gilt weiter: Nur mit ihm steht an dieser Stelle
      // wieder derselbe Titel. Eine frische Mischung waere ein neuer Anfang,
      // und genau den will "weiterhoeren" nicht.
      seed = Number.isInteger(stand.seed) ? stand.seed : 0;
      offset = Number(stand.offset) || 0;
      weiter = position > 0 || offset > 0;
    }
  }

  const start = [playDirektive(playlist, position, runde, { seed, offset })];

  // **Ohne Ansage faengt die Musik sofort an.** Der Schalter steht im
  // Dashboard, und je nach Playlist ist beides richtig: Wer "spiele
  // Kinderlieder" sagt, hoert die Bestaetigung gern; wer die Musik als Teil
  // eines Ablaufs startet, will keine Stimme davor. Eine Antwort ohne
  // outputSpeech ist zulaessig, solange sie eine Direktive traegt - und sie
  // darf kein `shouldEndSession: false` setzen, was still() auch nicht tut.
  if (!sagtAn(playlist)) return still(res, start);

  // **Ohne Titelzahl.** Hier steht die Ansage vor der Musik, und alles, was
  // vor der Musik steht, ist Wartezeit - eine Zahl, die man nicht erfragt hat,
  // besonders. Wer wissen will, wie lang eine Playlist ist, fragt danach, und
  // dann sagt es handleList.
  //
  // Ohne die dynamischen Werte: Die Session endet mit dieser Antwort ohnehin,
  // und ob sich Dialog- und AudioPlayer-Direktiven vertragen, ist nicht
  // zugesichert. Die naechste Rueckfrage schiebt die Liste wieder nach.
  const satz = weiter ? `Ich spiele ${playlist.name} weiter.` : `Ich spiele ${playlist.name}.`;
  return speak(res, satz, true, start);
}

/**
 * Mischung fuer die laufende Wiedergabe an- oder abschalten.
 *
 * **Hier darf der Sprachbefehl wirken, anders als bei der Wiederholung.** Der
 * Unterschied ist die Reichweite: Die Mischung steckt im Token, also aendert
 * "misch die Titel" nur diesen einen Stream. Die Playlist im Dashboard bleibt,
 * wie sie ist, und beim naechsten Start gilt wieder ihr Schalter. Ein
 * Loop-Befehl haette dagegen die gespeicherte Playlist umlegen muessen.
 *
 * Gemischt wird ab der aktuellen Stelle, die Runde zaehlt hoch: So bekommt der
 * neue Stream einen anderen Token als der laufende, und die Wiedergabe springt
 * hoerbar auf einen anderen Titel - die Rueckmeldung, dass etwas passiert ist.
 */
function mischen(body, res, playlists, an) {
  const lage = laufendes(body, playlists);
  if (!lage) {
    return speak(res, an
      ? 'Es laeuft gerade nichts. Die Zufallswiedergabe stellst du je Playlist im Dashboard ein.'
      : 'Es laeuft gerade nichts.', true);
  }
  const seed = an ? neuerSeed() : 0;
  return still(res, [playDirektive(lage.playlist, 0, lage.token.runde + 1, { seed })]);
}

/**
 * Was der Skill auf "wiederhole das" antwortet.
 *
 * **Er schaltet nichts um.** Die Einstellung gehoert zur Playlist und liegt im
 * Dashboard; ein Sprachbefehl wuerde sie fuer alle und dauerhaft aendern, und
 * das ist zu viel Wirkung fuer einen Satz, den man nebenbei sagt. Also sagt er,
 * wie es steht und wo man es dreht - eine Auskunft, die stimmt, statt einer
 * Behauptung ("wiederholt immer"), die es seit dieser Einstellung nicht mehr
 * tut.
 */
function loopAuskunft(body, res, playlists) {
  const lage = laufendes(body, playlists);
  if (!lage) {
    return speak(res, 'Ob sich eine Playlist wiederholt, stellst du im Dashboard ein.', true);
  }
  const zustand = wiederholtSich(lage.playlist) ? 'wiederholt sich' : 'wiederholt sich nicht';
  return speak(res, `${lage.playlist.name} ${zustand}. Ändern kannst du das im Dashboard.`, true);
}

function handleList(res, playlists, direktiven) {
  if (playlists.length === 0) {
    return speak(res, 'Es ist noch keine Playlist angelegt. Bitte lege im Dashboard eine an.', true);
  }
  const liste = aufzaehlung(playlists.map(p => {
    const n = p.titel.length;
    return `${p.name} mit ${n === 1 ? 'einem Titel' : `${n} Titeln`}`;
  }));
  return speak(res, `Ich kenne ${liste}. Welche soll ich spielen?`, false, direktiven);
}

/** Weiter an der Stelle, an der pausiert wurde. */
function weiter(body, res, playlists, direktiven = [], stumm = false) {
  const lage = laufendes(body, playlists);
  if (!lage) {
    if (stumm) return still(res);
    return frageWelche(res, 'Es laeuft gerade nichts. Welche Playlist soll ich spielen?', playlists, direktiven);
  }
  const position = lage.token.position < lage.playlist.titel.length ? lage.token.position : 0;
  return still(res, [playDirektive(lage.playlist, position, lage.token.runde, { seed: lage.token.seed, offset: lage.offset })]);
}

/** Naechster oder voriger Titel - vom Sprachbefehl wie vom Knopf. */
/**
 * Naechster oder voriger Titel - und ohne Wiederholung nicht ueber die Raender.
 *
 * Die beiden Raender sind nicht symmetrisch, weil die Erwartung es nicht ist:
 * Hinter dem letzten Titel ist die Playlist zu Ende, also hoert sie auf.
 * Vor dem ersten ist man am Anfang, und "zurueck" heisst dort, ihn noch einmal
 * zu hoeren - ans Ende zu springen waere genau die Wiederholung, die
 * abgeschaltet ist.
 */
function springe(body, res, playlists, richtung) {
  const lage = laufendes(body, playlists);
  if (!lage) return still(res);
  const ziel = schritt(lage.playlist, lage.token, richtung);
  if (ziel.umbruch && !wiederholtSich(lage.playlist)) {
    if (richtung > 0) return still(res, [STOP]);
    return still(res, [playDirektive(lage.playlist, 0, lage.token.runde, { seed: lage.token.seed })]);
  }
  return still(res, [playDirektive(lage.playlist, ziel.position, ziel.runde, { seed: ziel.seed })]);
}

async function vonVorn(body, res, playlists, redis) {
  const lage = laufendes(body, playlists);
  if (!lage) return still(res);
  // "Von vorn" heisst auch: den gemerkten Stand vergessen. Sonst faengt der
  // naechste Start wieder in der Mitte an, obwohl gerade ausdruecklich das
  // Gegenteil verlangt wurde.
  if (setztFort(lage.playlist)) await standLoeschen(redis, lage.playlist.name);
  return still(res, [playDirektive(lage.playlist, 0, lage.token.runde + 1, { seed: lage.token.seed })]);
}

/**
 * Der Kern der Playlist: Kurz vor dem Ende eines Titels haengt Alexa den
 * naechsten an - und, wenn die Wiederholung an ist, nach dem letzten wieder
 * den ersten.
 *
 * **Ohne Wiederholung wird hier NICHTS geschickt, insbesondere kein Stop.**
 * Der letzte Titel laeuft ja noch; ein Stop wuerde ihn mitten im Stueck
 * abwuergen. Haengt man nichts an, spielt er zu Ende und die Wiedergabe endet
 * von selbst - das ist die einzige Art, eine Playlist sauber ausklingen zu
 * lassen.
 */
async function naechsterTitel(body, res, playlists, redis) {
  const lage = laufendes(body, playlists);
  if (!lage) return still(res);
  const ziel = schritt(lage.playlist, lage.token, +1);
  if (ziel.umbruch && !wiederholtSich(lage.playlist)) {
    // Durchgelaufen: Der Stand darf nicht am Ende stehen bleiben, sonst
    // begaenne der naechste Start mit dem letzten Titel statt von vorn.
    if (setztFort(lage.playlist)) await standLoeschen(redis, lage.playlist.name);
    return still(res);
  }
  const bisher = body.request.token;
  return still(res, [playDirektive(lage.playlist, ziel.position, ziel.runde, { seed: ziel.seed, verhalten: 'ENQUEUE', vorherigerToken: bisher })]);
}

/**
 * Ein Titel, den der Echo nicht laden konnte, blockiert nicht die Playlist:
 * es geht mit dem naechsten weiter. **Aber nur bis zum Ende der Runde** -
 * scheitern alle, endet die Wiedergabe, statt endlos um die Liste zu kreisen.
 */
function nachFehler(body, res, playlists) {
  const fehler = body.request.error || {};
  console.warn('Alexa konnte nicht abspielen:', fehler.type, fehler.message, 'Token:', body.request.token);
  const lage = laufendes(body, playlists);
  if (!lage) return still(res);
  const ziel = schritt(lage.playlist, lage.token, +1);
  if (ziel.umbruch) return still(res, [STOP]);
  return still(res, [playDirektive(lage.playlist, ziel.position, ziel.runde, { seed: ziel.seed })]);
}
