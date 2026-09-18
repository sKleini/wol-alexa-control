// lib/musik.js – Meine Plattenkiste: Playlists aus MP3-URLs, abgespielt per Alexa.
//
// Zwei Haelften in einer Datei, weil beide dieselben Regeln teilen:
//
//   handleManage  Verwaltung aus dem Dashboard (/api/manage?type=playlists):
//                 Playlists anlegen, aendern, loeschen, URLs pruefen
//   handleSkill   der Alexa Custom Skill "Meine Plattenkiste" (/api/skill, verzweigt
//                 dort nach der Skill-ID; aufgerufen wird er mit
//                 "meine plattenkiste")
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
import { istFritzFreigabe, importiereFritzOrdner, frischeSid, mitSid, textAuszug } from './fritznas.js'

// Weiterhin von hier zu haben: test/musik.test.mjs prueft die Grenzen ueber
// diesen Namen, und die Regel selbst steht jetzt in lib/netz.js.
export { istPrivateAdresse }

// Dasselbe fuer die Groessen-Rechnung: geprueft ueber diese Namen, zuhause in
// lib/groesse.js, damit lib/fritznas.js sie ohne Kreis mitbenutzen kann.
import {
  groesseAusContentRange, lesbareGroesse, spieldauerSekunden,
  lesbareDauer, genaueDauer, laengerAlsSitzung, adresseKurz, datenrateKbs,
} from './groesse.js'
export {
  groesseAusContentRange, lesbareGroesse, spieldauerSekunden,
  lesbareDauer, genaueDauer, laengerAlsSitzung, adresseKurz, datenrateKbs,
}

// Und die Dauer, die nicht geschaetzt ist, sondern in der Datei steht.
import { mp3Kopf, mp3Dauer, tondatenAb, LESEPROBE_BYTES } from './mp3.js'
export { mp3Kopf, mp3Dauer, tondatenAb }

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
 * Bringt die Playlists in die uebergebene Reihenfolge.
 *
 * **Warum die Reihenfolge ueberhaupt zaehlt.** Sie ist nicht nur Kosmetik im
 * Dashboard: In ihr zaehlt der Skill die Playlists auf, wenn er fragt, welche
 * er spielen soll. Wer vier Hoerspiele und eine Einschlafliste hat, will die
 * Einschlafliste nicht als letzte hoeren.
 *
 * **Was mit Unbekanntem geschieht.** Namen, die es nicht gibt, werden
 * uebergangen; Playlists, die in der Liste fehlen, behalten ihre Reihenfolge
 * und haengen sich hinten an. Beides ist kein Fehlerfall, sondern der ganz
 * normale Lauf der Dinge: Zwischen dem Laden der Liste im Browser und dem
 * Speichern kann eine Playlist dazugekommen oder geloescht worden sein, und
 * eine Umsortierung darf sie weder verlieren noch daran scheitern.
 *
 * @param {object[]} playlists der Bestand
 * @param {string[]} namen die gewuenschte Reihenfolge
 */
export function sortierePlaylists(playlists, namen) {
  const gewuenscht = Array.isArray(namen) ? namen : [];
  const offen = [...playlists];
  const sortiert = [];

  for (const roh of gewuenscht) {
    const name = String(roh ?? '').trim().toLowerCase();
    if (!name) continue;
    const i = offen.findIndex(p => p.name.toLowerCase() === name);
    if (i > -1) sortiert.push(...offen.splice(i, 1));
  }
  return [...sortiert, ...offen];
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
    if (req.query.import) return handleImport(req, res, redis);
    if (req.query.pruefen) {
      const name = String(req.query.name || '').trim().toLowerCase();
      const playlist = playlists.find(p => p.name.toLowerCase() === name);
      if (!playlist) return res.status(404).json({ error: 'Unknown playlist' });
      const ab = Math.max(0, parseInt(req.query.ab, 10) || 0);
      // Dieselbe Sitzungsnummer, die der Skill gleich verwenden wuerde -
      // sonst prueft dieser Knopf die gespeicherte, laengst abgelaufene
      // Adresse und meldet eine Playlist als kaputt, die gerade spielt.
      const { playlist: frisch } = await mitFrischerSid(playlist, redis);
      return res.status(200).json({
        ...await pruefePlaylist(frisch, ab),
        aufgefrischt: frisch !== playlist,
      });
    }
    return res.status(200).json(playlists);
  }

  if (req.method === 'POST') {
    // Umsortieren ist kein Upsert: Es kommt kein Playlist-Inhalt mit, nur die
    // gewuenschte Reihenfolge der Namen. Deshalb ein eigener Weg, statt
    // validierePlaylist mit einem zweiten Zweck zu belasten.
    if (req.query.sortieren) {
      playlists = sortierePlaylists(playlists, req.body?.namen);
      await redis.set(REDIS_KEY, playlists);
      return res.status(200).json({ success: true, playlists });
    }

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

/**
 * Eine FRITZ!Box ist kein Webspace und vertraegt die vier nicht.
 *
 * Sie liefert jeden Titel ueber ein Lua-Skript aus ihrem eigenen Speicher und
 * ueber die Uplink-Leitung eines Haushalts. Vier gleichzeitige Abrufe bringen
 * sie dazu, keinen davon binnen vier Sekunden zu beantworten - der Import,
 * der nur einen einzigen Titel probiert, kam dagegen immer durch. Fuer sie
 * also einer nach dem anderen, mit mehr Zeit und dafuer weniger Titeln je
 * Aufruf, damit die zehn Sekunden der Vercel-Function reichen. Das Dashboard
 * holt den Rest mit `ab=` nach, wie bisher.
 */
const FRITZ_PRUEF_SCHRITT = 6;
const FRITZ_PRUEF_PARALLEL = 1;
const FRITZ_PRUEF_FRIST_MS = 7000;

async function pruefePlaylist(playlist, ab) {
  const fritz = playlist?.quelle?.typ === 'fritz';
  const schritt = fritz ? FRITZ_PRUEF_SCHRITT : PRUEF_SCHRITT;
  const gleichzeitig = fritz ? FRITZ_PRUEF_PARALLEL : PRUEF_PARALLEL;
  const frist = fritz ? FRITZ_PRUEF_FRIST_MS : PRUEF_FRIST_MS;

  const teil = playlist.titel.slice(ab, ab + schritt);
  const ergebnisse = [];
  for (let i = 0; i < teil.length; i += gleichzeitig) {
    const gruppe = teil.slice(i, i + gleichzeitig);
    ergebnisse.push(...await Promise.all(gruppe.map(t => pruefeUrl(t.url, frist))));
  }
  const weiter = ab + teil.length < playlist.titel.length ? ab + teil.length : null;
  return { name: playlist.name, ab, gesamt: playlist.titel.length, ergebnisse, weiter };
}

/**
 * Ein Abruf je URL, so wie ihn der Echo macht - nur kuerzer: die ersten
 * 32 KB.
 *
 * Aus der einen Antwort folgt alles, woran es in der Praxis scheitert: der
 * Status (404, 403), der Content-Type (eine HTML-Vorschauseite statt der
 * Datei) und ob der Server Bereiche liefert (206) - ohne Bereiche beginnt
 * "Alexa, weiter" nach einer Pause wieder von vorn.
 *
 * **Und die Groesse, die bisher weggeworfen wurde.** Sie steht im
 * `Content-Range`-Kopf derselben Antwort und kostet also nichts. Ohne sie sah
 * ein einstuendiges Hoerspiel genauso aus wie ein dreiminuetiges Kinderlied -
 * ein Byte kommt bei beiden gleich schnell, und die Pruefung meldete beide
 * gruen, obwohl nur eines davon spielte.
 *
 * **Warum es jetzt 32 KB sind und nicht ein Byte.** In diesem Anfang steht der
 * Kopf der Datei, und darin die echte Bitrate. Aus der Groesse allein liess
 * sich die Dauer nur schaetzen, und die Schaetzung lag bei hoch kodierten
 * Dateien um das Zweieinhalbfache daneben - 14 MB galten als eine
 * Viertelstunde und waren knapp sechs Minuten. Der Aufpreis ist eine
 * Leseprobe, die in denselben Abruf passt.
 */
async function pruefeUrl(start, frist = PRUEF_FRIST_MS) {
  const ergebnis = {
    url: start, status: null, contentType: null, range: false, fehler: null,
    bytes: null, groesse: null, dauer: null, zuLang: false,
    kbit: null, sekunden: null, geschaetzt: false,
  };
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
        headers: { Range: `bytes=0-${LESEPROBE_BYTES - 1}`, 'User-Agent': 'musik-box-check/1.0' },
        signal: AbortSignal.timeout(frist),
      });
    } catch (err) {
      ergebnis.fehler = err?.name === 'TimeoutError' ? `keine Antwort binnen ${frist / 1000} s` : 'nicht erreichbar';
      return ergebnis;
    }
    // Der Rumpf wird erst unten verworfen: Kommt keine Audiodatei, steht in
    // ihm, warum - und "liefert text/html" allein hat schon eine Runde
    // gekostet, in der geraten statt gelesen wurde.
    if ([301, 302, 303, 307, 308].includes(antwort.status)) {
      try { await antwort.body?.cancel(); } catch { /* egal */ }
      const ziel = antwort.headers.get('location');
      if (!ziel) { ergebnis.fehler = 'Umleitung ohne Ziel'; return ergebnis; }
      try { url = new URL(ziel, url); } catch { ergebnis.fehler = 'Umleitung auf ungueltige URL'; return ergebnis; }
      continue;
    }

    ergebnis.status = antwort.status;
    ergebnis.contentType = (antwort.headers.get('content-type') || '').split(';')[0].trim() || null;
    ergebnis.range = antwort.status === 206
      || (antwort.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');

    ergebnis.bytes = groesseAusContentRange(antwort.headers.get('content-range'));
    ergebnis.groesse = lesbareGroesse(ergebnis.bytes);

    const audio = ergebnis.contentType === null
      || /^audio\//.test(ergebnis.contentType)
      || ergebnis.contentType === 'application/octet-stream';
    if (antwort.ok && audio) {
      await dauerDazu(ergebnis, antwort, url, frist);
      return ergebnis;
    }

    let gesagt = '';
    try { gesagt = textAuszug((await antwort.text()).slice(0, 8000), 200); } catch { /* dann eben ohne */ }
    ergebnis.fehler = antwort.ok
      ? `liefert ${ergebnis.contentType}, keine Audiodatei`
      : `HTTP ${antwort.status}`;
    if (gesagt) ergebnis.fehler += ` – die Antwort sagt: "${gesagt}"`;
    return ergebnis;
  }
  ergebnis.fehler = `mehr als ${PRUEF_UMLEITUNGEN} Umleitungen`;
  return ergebnis;
}

/**
 * Traegt Bitrate und Spieldauer nach - aus der Datei, nicht aus einer Annahme.
 *
 * Drei Faelle, und alle drei enden mit einer Aussage:
 *   - Der Kopf steht in der Leseprobe: Die Dauer ist gerechnet und exakt.
 *   - Ein eingebettetes Titelbild hat ihn dahinter geschoben: Ein zweiter,
 *     gezielter Abruf holt ihn. Wo er anfaengt, steht in den ersten zehn Bytes.
 *   - Es ist kein MP3 (m4a, aac) oder der Kopf ist unlesbar: die alte
 *     Schaetzung, ausdruecklich als solche gekennzeichnet.
 */
async function dauerDazu(ergebnis, antwort, url, frist) {
  const probe = await anfangLesen(antwort);
  let kopf = probe ? mp3Kopf(probe) : null;

  if (!kopf && probe) {
    const ab = tondatenAb(probe);
    if (ab >= probe.length) {
      // Kuerzer als der erste Abruf: Er kommt oben drauf, und die ganze
      // Pruefung muss in die zehn Sekunden der Function passen.
      const zweite = await nachlesen(url, ab, Math.min(frist, 3000));
      // Die Stelle im Fenster ist nicht die Stelle in der Datei - fuer die
      // Rechnung "Rest durch Bitrate" zaehlt die zweite.
      if (zweite) {
        kopf = mp3Kopf(zweite, 0);
        if (kopf) kopf.ab += ab;
      }
    }
  }

  const sekunden = kopf ? mp3Dauer(kopf, ergebnis.bytes) : null;
  if (kopf) ergebnis.kbit = kopf.kbit;
  if (sekunden !== null) {
    ergebnis.sekunden = Math.round(sekunden);
    ergebnis.dauer = genaueDauer(sekunden);
    ergebnis.zuLang = laengerAlsSitzung(ergebnis.bytes, sekunden);
    return;
  }
  ergebnis.dauer = lesbareDauer(spieldauerSekunden(ergebnis.bytes));
  ergebnis.geschaetzt = ergebnis.dauer !== null;
  ergebnis.zuLang = laengerAlsSitzung(ergebnis.bytes);
}

/**
 * Der Anfang der Antwort - aber nur, wenn er auch einer ist.
 *
 * **Ein Server darf `Range` ignorieren.** Dann steht in der Antwort die ganze
 * Datei, und sie einzulesen hiesse, fuer eine Auskunft ueber die Spieldauer
 * vierzehn Megabyte zu ziehen. In dem Fall lieber keine Auskunft.
 */
async function anfangLesen(antwort) {
  // Gelesen wird nur, was der Server vorher als klein angekuendigt hat. Ohne
  // Laengenangabe lieber nicht: Die Auskunft ist eine Zeile im Dashboard wert,
  // keine vierzehn Megabyte.
  const laenge = Number(antwort.headers.get('content-length'));
  if (!Number.isFinite(laenge) || laenge <= 0 || laenge > LESEPROBE_BYTES * 2) {
    try { await antwort.body?.cancel(); } catch { /* egal */ }
    return null;
  }
  try { return new Uint8Array(await antwort.arrayBuffer()); } catch { return null; }
}

/** Ein zweites, kleines Fenster an einer bestimmten Stelle der Datei. */
async function nachlesen(url, ab, frist) {
  try {
    const antwort = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { Range: `bytes=${ab}-${ab + 8191}`, 'User-Agent': 'musik-box-check/1.0' },
      signal: AbortSignal.timeout(frist),
    });
    if (antwort.status !== 206) {
      try { await antwort.body?.cancel(); } catch { /* egal */ }
      return null;
    }
    return new Uint8Array(await antwort.arrayBuffer());
  } catch {
    return null;
  }
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
export async function handleImport(req, res, redis = null) {
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
    // Die Sitzung, die der Import gerade besorgt hat, gilt noch - sie hier
    // abzulegen erspart dem naechsten Schritt zwei Abrufe bei der Box.
    if (redis && ergebnis.sid) await fritzSidMerken(redis, url.href, ergebnis.sid);
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

async function standLesen(redis, name, frist = Infinity) {
  try {
    const alle = await mitFrist(redis.get(STAND_KEY), {}, STAND_KEY, frist) || {};
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

/**
 * Antwort ohne Sprache - fuer AudioPlayer- und PlaybackController-Ereignisse
 * und fuer Sprachbefehle, die ausser einer Direktive nichts brauchen.
 *
 * **`schluss` macht das Mikrofon zu.** Ein fehlendes `shouldEndSession` heisst
 * fuer Alexa nicht "beenden", sondern "lass es, wie es ist" - und nach dem
 * zweistufigen Aufruf ("oeffne meine Plattenkiste" … "spiele Kinderlieder")
 * ist es offen. Der Echo horchte deshalb nach jedem erledigten Befehl noch
 * einmal, als erwarte er eine Fortsetzung. Bei einem IntentRequest gehoert die
 * Sitzung also geschlossen; bei AudioPlayer- und PlaybackController-
 * Ereignissen gibt es gar keine, und das Feld hat dort nichts verloren.
 *
 * Neben einer Play-Direktive ist `true` erlaubt und ueblich - ungueltig waere
 * allein `false`.
 */
function still(res, direktiven = [], schluss = false) {
  const response = {};
  if (schluss) response.shouldEndSession = true;
  if (direktiven.length) response.directives = direktiven;
  return res.status(200).json({ version: '1.0', response });
}

/**
 * Geht diese Antwort auf einen gesprochenen Befehl zurueck?
 *
 * Dieselben Helfer beantworten Sprachbefehle und die Knoepfe der Alexa-App
 * (PlaybackController). Nur im ersten Fall gibt es eine Sitzung zu schliessen,
 * und die Frage steht deshalb hier einmal statt an fuenf Stellen.
 */
function ausSprache(body) {
  return body?.request?.type === 'IntentRequest';
}

function namenListe(playlists) {
  return aufzaehlung(playlists.map(p => p.name));
}

/**
 * Die Rueckfrage, welche Playlist es sein soll.
 *
 * **Warum die Namen nicht immer mitkommen.** Sie helfen genau dort, wo jemand
 * nicht weiterkommt - nach einem Namen, den es nicht gibt, ist die Liste die
 * eigentliche Antwort. Beim blossen Oeffnen sind sie im Weg: Wer den Skill
 * aufruft, weiss meist schon, was er hoeren will, und muss sich erst durch
 * fuenf Namen hoeren, bevor er etwas sagen darf.
 *
 * Die dynamischen Entitaeten in `direktiven` gehen in beiden Faellen mit -
 * sie sind der Grund, warum Alexa die Antwort auf diese Frage ueberhaupt
 * versteht, und haben mit dem gesprochenen Satz nichts zu tun.
 */
function frageWelche(res, satz, playlists, direktiven, mitNamen = true) {
  const namen = mitNamen ? namenListe(playlists) : '';
  // Das Nachfragen bleibt kurz: Wer die Namen gerade gehoert hat, braucht sie
  // nicht noch einmal, und jede Sekunde Ansage ist eine Sekunde mit
  // geschlossenem Mikrofon.
  return speak(res, namen ? `${satz} Ich kenne ${namen}.` : satz, false, direktiven, satz);
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

/**
 * Die eine Sitzung, die es zu dieser FRITZ!Box gibt.
 *
 * **Warum eine und nicht eine je Freigabe.** AVM schreibt es in der Technical
 * Note zu Session-IDs selbst: Die Zahl der Sitzungen ist begrenzt, ein
 * Programm soll nur eine je Box verwenden - und ein Zugriff **ohne** gueltige
 * Sitzung beendet aus Sicherheitsgruenden **alle** bestehenden. Genau das ist
 * der Abruf von `filelink.lua`, mit dem jede Auffrischung beginnt. Wer sich je
 * Freigabe eine Nummer merkt, merkt sich also lauter Nummern, die die naechste
 * Auffrischung laengst beendet hat: Bei einer Playlist faellt das nie auf, bei
 * dreien spielt keine mehr.
 *
 * Deshalb ein einziger Datensatz `{ link, sid, zeit }`. Gehoert er zu einer
 * anderen Freigabe als der gefragten, ist die Nummer tot, und es wird sofort
 * eine neue geholt.
 */
const FRITZ_SID_KEY = 'musik_fritz_sid';
/**
 * Wie lange eine geholte Nummer weiterverwendet wird.
 *
 * AVM nennt zehn Minuten, verlaengert um jeden aktiven Zugriff. Fuenf sind der
 * Sicherheitsabstand: Auf die Verlaengerung sollte sich niemand verlassen,
 * wenn der Preis Stille am Echo ist, und ein Album laeuft ohnehin mit einem
 * Titelwechsel alle paar Minuten - jeder davon frischt nach.
 */
const FRITZ_SID_MINUTEN = 5;

/**
 * Was vom Antwortbudget uebrig sein muss, damit sich ein Login noch lohnt.
 *
 * **Hier stand 4800, und das war zu viel verlangt.** `frischeSid` rechnete mit
 * festen vier Sekunden, also musste so viel frei sein. Inzwischen bekommt der
 * Login mit, was wirklich uebrig ist, und passt sich an - dann genuegt als
 * Schwelle, was ein Login mindestens braucht. Darunter wird er ausgelassen,
 * denn ein abgebrochener kostet die ganze Antwort und nicht nur einen Titel.
 */
const SID_MINDESTBUDGET_MS = 2500;

/**
 * Was nach dem Login noch fuer die Antwort selbst bleiben muss.
 *
 * Die Direktive bauen, das JSON schreiben, den Weg zurueck zu Alexa - das ist
 * wenig, aber nicht nichts, und ohne diese Reserve endete ein langsamer Login
 * im Schweigen statt in einem Satz.
 */
const SID_ANTWORT_RESERVE_MS = 700;

/**
 * Tauscht in den Adressen der gemeinten Playlist die Sitzungsnummer aus.
 *
 * Gibt immer eine brauchbare Liste zurueck: Scheitert das Auffrischen, bleiben
 * die alten Adressen stehen. Sie sind dann vielleicht abgelaufen - aber eine
 * Playlist mit vielleicht toten Adressen ist besser als gar keine, und der
 * Fehlerweg des Skills (PlaybackFailed) fasst das ohnehin ab.
 */
async function fritzAufgefrischt(playlists, body, redis, rest = () => Infinity) {
  if (!playlists.some(p => p.quelle?.typ === 'fritz')) return { playlists, fritzOk: true };

  const gemeint = gemeintePlaylist(playlists, body);
  if (gemeint?.quelle?.typ !== 'fritz') return { playlists, fritzOk: true };

  // **Ein gescheiterter Titel ueberholt die Frist.** Konnte der Echo eine
  // Datei nicht laden, ist die abgelaufene Sitzungsnummer der bei weitem
  // haeufigste Grund - und der naechste Titel traegt dieselbe. Hier wird
  // deshalb sofort eine neue geholt, statt die gemerkte ihre acht Minuten
  // auszusitzen: Der Skill spielt dann mit dem naechsten Titel weiter, statt
  // eine ganze Runde lang an derselben toten Nummer zu scheitern.
  const erzwingen = body?.request?.type === 'AudioPlayer.PlaybackFailed';

  // **"Eine Nummer da" ist zu wenig fuer ein Versprechen.** Hier stand vorher
  // nur, ob ueberhaupt eine eingesetzt wurde - und eine gemerkte, laengst
  // abgelaufene ist eine. Genau das war der gemeldete Fall: Alexa sagte "Ich
  // spiele das doppelte Lottchen", der Echo bekam eine tote Nummer, und es
  // blieb still. Jetzt zaehlt, ob die Nummer gerade von der Box kommt oder
  // innerhalb ihres Fensters liegt.
  const { playlist: frisch, verlaesslich } = await mitFrischerSid(gemeint, redis, erzwingen, rest);
  return {
    playlists: playlists.map(p => (p === gemeint ? frisch : p)),
    fritzOk: verlaesslich,
  };
}

/**
 * Holt die Sitzungsnummer schon beim Oeffnen des Skills.
 *
 * **Warum das der eigentliche Hebel ist.** Der Aufruf hat zwei Schritte -
 * "oeffne meine Plattenkiste", dann "spiele das doppelte Lottchen" -, und der
 * ganze FRITZ!Box-Login lag bisher im zweiten. Der ist der enge: Dort haengen
 * Namenssuche, Stand lesen, Direktive bauen und Alexas acht Sekunden am selben
 * Budget. Der erste Schritt dagegen liest eine Liste und stellt eine Frage;
 * seine Zeit lag brach.
 *
 * Jetzt faellt der Login dorthin. Zwischen Frage und Antwort des Sprechenden
 * liegen ein paar Sekunden - genug, dass der zweite Schritt die Nummer fertig
 * im Zwischenspeicher vorfindet und sofort losspielt. Und schlaegt der Login
 * hier fehl, hat der zweite Schritt trotzdem noch seinen eigenen Versuch, dann
 * mit warmen Verbindungen. Aus einem Versuch werden zwei.
 *
 * **Nur bei genau einer Freigabe.** Jeder Login beendet laut AVM alle
 * bestehenden Sitzungen der Box. Bei mehreren Ordner-Links waere hier nicht zu
 * entscheiden, welcher gemeint ist, und die falsche Wahl wuerde der richtigen
 * gerade die Sitzung nehmen. Dann bleibt es beim bisherigen Weg.
 */
async function sitzungVorwaermen(playlists, redis, rest) {
  const links = [...new Set(
    playlists.filter(p => p.quelle?.typ === 'fritz').map(p => p.quelle.link),
  )];
  if (links.length !== 1) return;
  // Die Frage soll nicht auf einen Login warten, fuer den die Zeit ohnehin
  // nicht reicht - dann lieber gleich fragen und im zweiten Schritt anmelden.
  if (rest() < SID_MINDESTBUDGET_MS + SID_ANTWORT_RESERVE_MS) {
    console.warn(`musik-box Vorwaermen ausgelassen, nur noch ${rest()} ms Budget`);
    return;
  }
  const { verlaesslich } = await fritzSid(links[0], redis, false, rest);
  console.log(`musik-box Sitzung vorgewaermt: ${verlaesslich ? 'ja' : 'nein'}`);
}

/**
 * Eine Playlist, deren Adressen eine Sitzungsnummer tragen, die gerade gilt.
 *
 * **Zwei Aufrufer, und das ist der Sinn.** Der Skill braucht sie, damit der
 * Echo laedt; "Check URLs" braucht sie, damit die Pruefung misst, was der Echo
 * bekommt, und nicht, was gespeichert dasteht. Ohne diese Stelle zeigte die
 * Pruefung jede FRITZ!NAS-Playlist rot, waehrend sie tadellos spielt - und
 * dann glaubt niemand mehr, was sie sagt.
 *
 * Scheitert das Auffrischen, bleibt die Playlist, wie sie ist: Die alten
 * Adressen sind vielleicht noch gut, und die Pruefung sagt es dann.
 */
async function mitFrischerSid(playlist, redis, erzwingen = false, rest = () => Infinity) {
  if (playlist?.quelle?.typ !== 'fritz') return { playlist, verlaesslich: true };
  const { sid, verlaesslich } = await fritzSid(playlist.quelle.link, redis, erzwingen, rest);
  if (!sid) return { playlist, verlaesslich: false };
  return {
    playlist: { ...playlist, titel: playlist.titel.map(t => ({ ...t, url: mitSid(t.url, sid) })) },
    verlaesslich,
  };
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
async function fritzSid(link, redis, erzwingen = false, rest = () => Infinity) {
  const freigabe = istFritzFreigabe(link);
  if (!freigabe) return { sid: null, verlaesslich: false };

  const gemerkt = await fritzSidGemerkt(redis, rest());
  // Die gemerkte Nummer taugt nur fuer die Freigabe, zu der sie gehoert:
  // Wurde zwischendurch eine andere geoeffnet, hat die Box diese hier beendet.
  const passt = gemerkt?.sid
    && gemerkt.link === link
    && Date.now() - (gemerkt.zeit || 0) < FRITZ_SID_MINUTEN * 60_000;
  if (!erzwingen && passt) return { sid: gemerkt.sid, verlaesslich: true };

  // **Reicht die Zeit nicht fuer den Login, wird er ausgelassen.** Die Box ist
  // langsam, und ein Login, der die Antwort ueber Alexas Fenster hebt, kostet
  // die ganze Wiedergabe statt nur einen Titel.
  if (rest() < SID_MINDESTBUDGET_MS) {
    console.warn(`musik-box FRITZ!NAS-Login ausgelassen, nur noch ${rest()} ms Budget`);
    return { sid: gemerkt?.link === link ? gemerkt.sid : null, verlaesslich: false };
  }

  // Der Login bekommt, was das Budget hergibt - nicht seine alten vier
  // Sekunden. Die Zeile ins Log sagt beim naechsten Mal in einer Minute, ob es
  // an ihm lag: gemerkt (kein Login), wie lange er brauchte, ob er reichte.
  const begonnen = Date.now();
  const ergebnis = await frischeSid(freigabe, rest() - SID_ANTWORT_RESERVE_MS);
  console.log(`musik-box FRITZ!NAS-Login ${ergebnis.sid ? 'ok' : `gescheitert (${ergebnis.fehler})`}`
    + ` nach ${Date.now() - begonnen} ms, ${rest()} ms Budget uebrig`);
  if (!ergebnis.sid) {
    // Die gemerkte kommt noch mit, aber ohne Empfehlung: Sie ist aelter als
    // ihr Fenster, sonst waeren wir oben schon zurueck. Was daraus wird,
    // entscheidet der Aufrufer - der Skill spielt damit nicht mehr los.
    return { sid: gemerkt?.link === link ? gemerkt.sid : null, verlaesslich: false };
  }
  await fritzSidMerken(redis, link, ergebnis.sid);
  return { sid: ergebnis.sid, verlaesslich: true };
}

/**
 * Der gemerkte Datensatz, oder nichts.
 *
 * Vor dieser Fassung stand unter demselben Schluessel eine Zuordnung
 * `{ [link]: … }` - eine Nummer je Freigabe. Die wird hier als "nichts
 * gemerkt" gelesen und vom ersten Schreiben ueberschrieben; ein eigener
 * Migrationsschritt waere fuer einen Zwischenspeicher, den man jederzeit
 * wegwerfen kann, zu viel Aufwand.
 */
async function fritzSidGemerkt(redis, frist = Infinity) {
  const bestand = await mitFrist(redis.get(FRITZ_SID_KEY), null, FRITZ_SID_KEY, frist);
  return typeof bestand?.link === 'string' ? bestand : null;
}

/**
 * Haelt die Sitzung fest, damit der naechste Schritt sie nicht neu holen muss.
 *
 * Zwei Aufrufer: die Auffrischung und der Import. Der Import hat gerade eine
 * gueltige Nummer besorgt, und wer importiert hat, drueckt als Naechstes
 * "Check URLs" oder startet die Playlist - ohne diese Zeile beginnt das mit
 * zwei weiteren Abrufen bei einer Box, die wir als langsam kennen, und beendet
 * dabei erneut alle Sitzungen.
 */
export async function fritzSidMerken(redis, link, sid) {
  try {
    await redis.set(FRITZ_SID_KEY, { link, sid, zeit: Date.now() });
  } catch (err) {
    // Nicht schlimm: Ohne Zwischenspeicher wird sie beim naechsten Mal erneut
    // geholt. Die Wiedergabe jetzt haengt nicht daran.
    console.error(`${FRITZ_SID_KEY} nicht schreibbar:`, err);
  }
}

/**
 * Was der Skill insgesamt brauchen darf, mit Reserve.
 *
 * **Alexa gibt acht Sekunden**, danach bricht sie ab und der Sprechende hoert
 * gar nichts - die schlechteste aller Antworten, weil niemand weiss, ob
 * zugehoert wurde. Die Reserve von anderthalb Sekunden deckt die Antwort
 * selbst und den Rueckweg.
 *
 * Auf dem Weg hierher lagen bis zu vier Datenbankrunden und ein Login bei der
 * FRITZ!Box, alle ohne Frist gegenueber diesem Fenster. Wer laenger als
 * FRITZ_SID_MINUTEN pausiert hatte, geriet zuverlaessig in den Login - und
 * damit ins Schweigen. Der zweite Versuch klappte dann, weil die Nummer
 * inzwischen gemerkt war. Genau dieses "geht nur manchmal beim ersten
 * Versuch".
 */
function antwortBudgetMs() {
  return Number(process.env.MUSIK_BUDGET_MS) || 6500;
}

/**
 * Eine Zusage mit Frist - laeuft sie ab, gilt der Rueckfall.
 *
 * Dasselbe Muster wie `AbortSignal.timeout` in lib/geo.js, nur mit
 * `Promise.race`: Der Upstash-Client reicht kein Signal durch.
 *
 * Das `clearTimeout` im `finally` ist nicht kosmetisch - ein offener Timer
 * haelt die Instanz wach und kann die naechste Antwort verzoegern.
 */
async function mitFrist(zusage, rueckfall, was, frist) {
  if (frist <= 0) {
    console.warn(`${was}: kein Zeitbudget mehr`);
    return rueckfall;
  }
  let uhr;
  try {
    return await Promise.race([
      zusage,
      new Promise((_, ab) => { uhr = setTimeout(() => ab(new Error(`nach ${frist} ms`)), frist); }),
    ]);
  } catch (err) {
    console.warn(`${was} nicht rechtzeitig:`, err?.message);
    return rueckfall;
  } finally {
    clearTimeout(uhr);
  }
}

export async function handleSkill(body, res, redis) {
  const beginn = Date.now();
  /** Wie viele Millisekunden bleiben, bis Alexa aufgibt. */
  const budget = antwortBudgetMs();
  const rest = () => budget - (Date.now() - beginn);
  const typ = body.request.type;

  // `null` heisst "nicht ladbar" und ist von einer leeren Liste zu
  // unterscheiden: Sonst hoert jemand mit fuenf Playlists "es ist noch keine
  // angelegt" und sucht den Fehler im Dashboard, wo keiner ist.
  const gelesen = await mitFrist(redis.get(REDIS_KEY), null, REDIS_KEY, rest());
  if (gelesen === null && typ !== 'LaunchRequest' && typ !== 'IntentRequest') return still(res);
  if (gelesen === null) {
    return speak(res, 'Ich komme gerade nicht an deine Playlists. Versuch es gleich noch einmal.', true);
  }

  let playlists = gelesen || [];
  const aufgefrischt = await fritzAufgefrischt(playlists, body, redis, rest);
  playlists = aufgefrischt.playlists;
  const { fritzOk } = aufgefrischt;
  const direktiven = dynamischeEntitaeten(SLOT_TYP, playlists.map(p => p.name));

  // **Die `await` vor den async-Zweigen sind nicht ueberfluessig.** Ein
  // `return f()` gibt die Promise heraus, bevor sie sich entscheidet - der
  // catch unten saehe einen Fehler daraus nie, und Alexa bekaeme eine
  // abgebrochene Antwort statt eines Satzes.
  try {
    if (typ === 'LaunchRequest') {
      if (playlists.length === 0) {
        return speak(res, 'Es ist noch keine Playlist angelegt. Bitte lege im Dashboard eine an.', true);
      }
      // **Die Sitzungsnummer jetzt, nicht gleich.** Siehe sitzungVorwaermen:
      // Der Login gehoert in diesen Schritt, weil hier Zeit ist. Er darf die
      // Frage aber unter keinen Umstaenden verhindern - schlaegt er fehl,
      // wird trotzdem gefragt, und der zweite Schritt versucht es erneut.
      try {
        await sitzungVorwaermen(playlists, redis, rest);
      } catch (err) {
        console.warn('musik-box Vorwaermen fehlgeschlagen:', err?.message);
      }
      // Ohne Namensliste: siehe frageWelche. Die Entitaeten gehen trotzdem mit.
      return frageWelche(res, 'Welche Playlist soll ich spielen?', playlists, direktiven, false);
    }

    if (typ === 'IntentRequest') {
      const intent = body.request.intent || {};
      switch (intent.name) {
        case 'PlayPlaylistIntent':
        case 'SuchePlaylistIntent':
          return await handlePlay(intent, res, playlists, direktiven, redis, rest, fritzOk);
        case 'ListPlaylistsIntent':
          return handleList(res, playlists, direktiven);
        case 'AMAZON.PauseIntent':
        case 'AMAZON.StopIntent':
        case 'AMAZON.CancelIntent':
          return still(res, [STOP], true);
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
  } finally {
    // Die Vercel-Logs zeigen nur die Dauer der ganzen Funktion, und die
    // enthaelt den Kaltstart. Diese Zeile trennt beides: Was hier steht, ist
    // die Arbeit des Skills. Liegt sie nahe am Budget, ist der naechste Hebel
    // die Entfernung zur Datenbank, nicht der Code.
    console.log(`musik-box ${typ} in ${Date.now() - beginn} ms`);
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
async function handlePlay(intent, res, playlists, direktiven, redis, rest = () => Infinity, fritzOk = true) {
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

  // **Ohne frische Sitzungsnummer wird nichts versprochen.** Die gespeicherten
  // Adressen tragen dann eine Nummer aus der Importzeit, die fast sicher tot
  // ist: Die Box antwortet darauf mit ihrer Oberflaeche statt mit der Datei,
  // und der Echo verstummt wortlos. Frueher sagte Alexa trotzdem "Ich spiele
  // …" - ein Versprechen, das der Skill nicht halten konnte, und niemand
  // erfuhr, woran es lag.
  if (playlist.quelle?.typ === 'fritz' && !fritzOk) {
    console.warn(`FRITZ!NAS-Sitzung fehlt, ${playlist.name} nicht gestartet`);
    return speak(res, 'Ich komme gerade nicht an die FRITZ!Box. Versuch es gleich noch einmal.', true, direktiven);
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
    const stand = await standLesen(redis, playlist.name, rest());
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
  // outputSpeech ist zulaessig, solange sie eine Direktive traegt. Die Sitzung
  // endet dabei - `true` ist neben einer Play-Direktive erlaubt, nur `false`
  // waere es nicht -, sonst horchte der Echo nach dem stillen Start weiter.
  if (!sagtAn(playlist)) return still(res, start, true);

  // **Ohne Titelzahl.** Hier steht die Ansage vor der Musik, und alles, was
  // vor der Musik steht, ist Wartezeit - eine Zahl, die man nicht erfragt hat,
  // besonders. Wer wissen will, wie lang eine Playlist ist, fragt danach, und
  // dann sagt es handleList.
  //
  // Ohne die dynamischen Werte: Die Session endet mit dieser Antwort ohnehin,
  // und ob sich Dialog- und AudioPlayer-Direktiven vertragen, ist nicht
  // zugesichert. Die naechste Rueckfrage schiebt die Liste wieder nach.
  // Die Adresse ins Log: Mit ihr ist in einer Minute zu klaeren, was sonst eine
  // Untersuchung kostet - welche Nummer der Echo bekam und von welchem Host.
  console.log(`musik-box spielt ${playlist.name}: ${adresseKurz(start[0].audioItem.stream.url)}`);

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
  return still(res, [playDirektive(lage.playlist, 0, lage.token.runde + 1, { seed })], ausSprache(body));
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
    if (stumm) return still(res, [], ausSprache(body));
    return frageWelche(res, 'Es laeuft gerade nichts. Welche Playlist soll ich spielen?', playlists, direktiven);
  }
  const position = lage.token.position < lage.playlist.titel.length ? lage.token.position : 0;
  return still(res, [playDirektive(lage.playlist, position, lage.token.runde, { seed: lage.token.seed, offset: lage.offset })], ausSprache(body));
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
  const schluss = ausSprache(body);
  const lage = laufendes(body, playlists);
  if (!lage) return still(res, [], schluss);
  const ziel = schritt(lage.playlist, lage.token, richtung);
  if (ziel.umbruch && !wiederholtSich(lage.playlist)) {
    if (richtung > 0) return still(res, [STOP], schluss);
    return still(res, [playDirektive(lage.playlist, 0, lage.token.runde, { seed: lage.token.seed })], schluss);
  }
  return still(res, [playDirektive(lage.playlist, ziel.position, ziel.runde, { seed: ziel.seed })], schluss);
}

async function vonVorn(body, res, playlists, redis) {
  const lage = laufendes(body, playlists);
  if (!lage) return still(res, [], ausSprache(body));
  // "Von vorn" heisst auch: den gemerkten Stand vergessen. Sonst faengt der
  // naechste Start wieder in der Mitte an, obwohl gerade ausdruecklich das
  // Gegenteil verlangt wurde.
  if (setztFort(lage.playlist)) await standLoeschen(redis, lage.playlist.name);
  return still(res, [playDirektive(lage.playlist, 0, lage.token.runde + 1, { seed: lage.token.seed })], ausSprache(body));
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
