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
import { istFritzFreigabe, importiereFritzOrdner, frischeSid, sitzungGilt, mitSid, textAuszug, weckeStream } from './fritznas.js'

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
import { queryOf } from './query.js'
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
 * **Eine Einstellung fehlt im Body: bisheriger Wert, sonst die Vorgabe.**
 * Dasselbe Muster wie `home` bei den Zonen in api/manage.js, und aus demselben
 * Grund: Ein Aufrufer, der ein Feld nicht kennt (ein Skript, eine aeltere
 * Oberflaeche), soll eine Titelliste korrigieren koennen, ohne nebenbei die
 * Wiederholung oder die Ansage umzulegen. Die Kehrseite ist, dass ein
 * Abwaehlen ausdruecklich als `false` ankommen muss - das Dashboard schickt
 * alle Felder deshalb immer mit. Bei einer neuen Playlist gilt, was der Skill
 * vor der jeweiligen Einstellung tat: Wiederholung und Ansage an, Mischung und
 * Fortsetzen aus.
 *
 * @param {object} body
 * @param {object|null} [bisher] die gespeicherte Playlist gleichen Namens
 * @returns {{ playlist: {name: string, titel: {url: string, name: string}[], wiederholen: boolean, ansage: boolean, zufall: boolean, fortsetzen: false|'titel'|'sekunde'} } | { fehler: string }}
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

  const fortsetzen = fortsetzenUebernommen(body, bisher);
  if (fortsetzen.fehler) return { fehler: fortsetzen.fehler };

  const playlist = {
    name,
    titel,
    wiederholen: uebernommen(body, bisher, 'wiederholen', true),
    ansage: uebernommen(body, bisher, 'ansage', true),
    zufall: uebernommen(body, bisher, 'zufall', false),
    fortsetzen: fortsetzen.wert,
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

/**
 * Wie diese Playlist fortgesetzt wird: 'aus', 'titel' oder 'sekunde'.
 *
 * **Warum das kein Schalter mehr ist.** Ein Hoerbuch will die Sekunde, ein Album
 * den Titelanfang: Wer bei Lied fuenf aufhoert, will Lied fuenf ganz hoeren und
 * nicht ab Sekunde siebenundvierzig. Das sind drei Zustaende, die einander
 * ausschliessen - also ein Wert und nicht zwei Haekchen, von denen das zweite
 * ohne das erste nichts bedeutet.
 *
 * `true` ist der Wert von frueher und heisst weiter 'sekunde'. So bleibt jede
 * gespeicherte Playlist, wie sie ist, und es braucht keinen Wanderungsschritt
 * ueber die Datenbank. Vorgabe ist 'aus', wie beim Schalter zuvor: Playlists,
 * die vor ihm angelegt wurden, setzten nie fort.
 */
export function fortsetzArt(playlist) {
  const wert = playlist?.fortsetzen;
  if (wert === true || wert === 'sekunde') return 'sekunde';
  if (wert === 'titel') return 'titel';
  return 'aus';
}

/** Merkt sich diese Playlist ueberhaupt, wo sie aufhoerte? Vorgabe: nein. */
export function setztFort(playlist) {
  return fortsetzArt(playlist) !== 'aus';
}

/** Der Wert eines Schalters aus dem Body, sonst der gespeicherte, sonst die Vorgabe. */
function uebernommen(body, bisher, feld, vorgabe) {
  return body && feld in body ? !!body[feld] : schalter(bisher, feld, vorgabe);
}

/**
 * Der Fortsetz-Modus aus dem Body, sonst der gespeicherte - das Gegenstueck
 * zu `uebernommen` fuer einen Wert, der kein Schalter ist.
 *
 * Dieselbe Regel wie bei den Schaltern - ein fehlendes Feld laesst den
 * gespeicherten Wert stehen -, nur laesst `uebernommen` sich hier nicht
 * benutzen: Sein `!!` machte aus 'titel' ein `true` und damit heimlich ein
 * Hoerbuch aus dem Album.
 *
 * `true` nimmt ein aelteres Dashboard oder ein Skript mit und heisst 'sekunde',
 * also genau das Verhalten, das es kannte. Alles andere ist ein Tippfehler und
 * wird gesagt, statt still auf 'aus' zu fallen: Ein Album, das sich ploetzlich
 * nichts mehr merkt, sucht man im falschen Eck.
 *
 * Gespeichert wird `false` statt 'aus' - so liest ein Aufrufer, der den Wert
 * noch fuer einen Schalter haelt, wenigstens das Richtige.
 */
function fortsetzenUebernommen(body, bisher) {
  if (!body || !('fortsetzen' in body)) {
    const art = fortsetzArt(bisher);
    return { wert: art === 'aus' ? false : art };
  }
  const wert = body.fortsetzen;
  if (wert === false || wert === 'aus') return { wert: false };
  if (wert === true || wert === 'sekunde') return { wert: 'sekunde' };
  if (wert === 'titel') return { wert: 'titel' };
  return { fehler: 'fortsetzen: erlaubt sind aus, titel oder sekunde' };
}

/** Vergleichsform eines Namens: klein, ohne Umlaute, nur Buchstaben und Ziffern. */
/**
 * Zahlwoerter als Ziffern - der Unterschied, an dem der Ein-Satz-Aufruf haengt.
 *
 * **Warum das noetig ist.** "Alexa, oeffne meine Plattenkiste und spiele Udo
 * CD eins" laeuft ueber SuchePlaylistIntent, und dessen Slot ist ein
 * AMAZON.SearchQuery: **ohne Entity Resolution**, es kommt nur der gehoerte
 * Text. Ob Alexa daraus "Udo CD eins" oder "Udo CD 1" macht, entscheidet die
 * Spracherkennung von Mal zu Mal anders - und "udocd1" traf "udocdeins"
 * nirgends, weder gleich noch als Anfang noch als Teil. Der Skill sagte dann
 * "Ich habe keine Playlist namens Udo CD 1 gefunden", und es kam keine Musik.
 *
 * Beim zweistufigen Aufruf faellt das nicht auf: Die Antwort auf "oeffne meine
 * Plattenkiste" traegt die Playlistnamen als dynamische Werte mit, und Alexa
 * loest den zweiten Satz dagegen auf. Der Ein-Satz-Aufruf hat diese Liste nie
 * bekommen - dort ist dieser Vergleich die einzige Instanz.
 *
 * Ersetzt wird nur ein ganzes Wort, nicht eine Buchstabenfolge: Sonst wuerde
 * aus "Kleinstadt" ein "kl1tadt". Die Artikel "ein" und "eine" bleiben aussen
 * vor - sie sind fast immer Artikel und fast nie eine Eins.
 */
const ZAHLWORT = {
  null: '0', eins: '1', zwei: '2', zwo: '2', drei: '3', vier: '4', fuenf: '5',
  sechs: '6', sieben: '7', acht: '8', neun: '9', zehn: '10', elf: '11',
  zwoelf: '12', dreizehn: '13', vierzehn: '14', fuenfzehn: '15', sechzehn: '16',
  siebzehn: '17', achtzehn: '18', neunzehn: '19', zwanzig: '20',
};

export function normalisiere(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .map(wort => ZAHLWORT[wort] ?? wort)
    .join('');
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
 * Token eines Streams: `<playlist>|<position>|<runde>|<seed>[|<versuch>]`.
 *
 * **`position` ist die Stelle in der Abspielfolge, nicht die Nummer des
 * Titels.** Ohne Mischung sind beide gleich; mit Mischung sagt erst der Seed,
 * welcher Titel an dieser Stelle steht (siehe [reihenfolge]). Dadurch bleibt
 * der Zustand vollstaendig im Token: Alexa schickt ihn bei jedem Ereignis mit,
 * und die Mischung laesst sich daraus jederzeit neu berechnen, statt sie
 * irgendwo zu speichern.
 *
 * **`versuch` ist das Wiederholungsbudget** und steht aus demselben Grund hier
 * und nicht in Redis: Es gehoert zu genau diesem Stream, Alexa bringt es bei
 * jedem Ereignis mit, und mit dem Titel ist es von selbst wieder weg. Eine 0
 * wird weggelassen, damit ein Token, bei dem nichts schiefging, aussieht wie
 * immer - das haelt jeden laufenden Stream ueber einen Deploy hinweg gueltig.
 */
export function tokenBauen(name, position, runde, seed = 0, versuch = 0) {
  const teile = [name, position, runde, seed];
  if (versuch) teile.push(versuch);
  return teile.join(TRENNER);
}

/**
 * Der Token zurueck in seine Teile - oder null, wenn er nicht von hier stammt.
 *
 * **Drei und vier Teile werden weiter gelesen.** Ein Stream, der vor dem Seed
 * oder vor dem Versuchszaehler gestartet wurde, laeuft beim Deploy noch; sein
 * Token darf nicht ploetzlich fremd aussehen, sonst braeche die Wiedergabe
 * mitten im Titel ab. Er gilt als ungemischt und unversucht - was er ja auch
 * war.
 */
export function tokenLesen(token) {
  if (typeof token !== 'string') return null;
  const teile = token.split(TRENNER);
  if (teile.length < 3 || teile.length > 5) return null;
  const [name, p, r, s, v] = teile;
  const position = Number(p);
  const runde = Number(r);
  const seed = teile.length >= 4 ? Number(s) : 0;
  const versuch = teile.length === 5 ? Number(v) : 0;
  if (!name || !Number.isInteger(position) || position < 0) return null;
  if (!Number.isInteger(runde) || runde < 0) return null;
  if (!Number.isInteger(seed) || seed < 0) return null;
  if (!Number.isInteger(versuch) || versuch < 0) return null;
  return { name, position, runde, seed, versuch };
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
export function playDirektive(playlist, position, runde, { seed = 0, verhalten = 'REPLACE_ALL', offset = 0, vorherigerToken, versuch = 0 } = {}) {
  const { titel, nummer } = titelAn(playlist, position, seed);
  const stream = {
    url: titel.url,
    token: tokenBauen(playlist.name, position, runde, seed, versuch),
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
  const query = queryOf(req);
  let playlists = await redis.get(REDIS_KEY) || [];

  if (req.method === 'GET') {
    // Der Import liest nur eine fremde Seite und aendert nichts - er steht
    // trotzdem hinter derselben Passwortpruefung wie der Rest von
    // /api/manage, weil er sonst ein offener Abruf-Dienst waere.
    if (query.import) return handleImport(req, res, redis);
    if (query.pruefen) {
      const name = String(query.name || '').trim().toLowerCase();
      const playlist = playlists.find(p => p.name.toLowerCase() === name);
      if (!playlist) return res.status(404).json({ error: 'Unknown playlist' });
      const ab = Math.max(0, parseInt(query.ab, 10) || 0);
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
    if (query.sortieren) {
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
  const start = String(queryOf(req).url || '').trim();
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
 * Die Warteschlange des Geraets leeren, bevor eine Wiedergabe anfaengt.
 *
 * **Der bekannte Kniff gegen einen Echo, der stumm auf altem Zustand sitzt.**
 * `REPLACE_ALL` ersetzt die Warteschlange ohnehin; `ClearQueue` davor raeumt
 * sie ausdruecklich ab, und in Berichten ueber still bleibende Geraete ist das
 * die uebliche Abhilfe.
 *
 * **Die These dahinter ist schwach, und das gehoert hierhin.** Gemessen ist,
 * dass derselbe Echo nach derselben langen Pause eine Playlist von einem
 * anderen Server beim ersten Versuch spielt - ein haengender Warteschlangen-
 * Zustand waere dort genauso im Weg gewesen. Der Kniff kostet nichts und
 * schadet nichts, aber er behebt vermutlich nicht das, was hier stumm bleibt.
 * Deshalb steht er hinter einem Schalter: `MUSIK_CLEAR_QUEUE=0` nimmt ihn
 * wieder heraus, ohne Deploy.
 *
 * **Nur vor einem Start, nie beim Titelwechsel.** Der naechste Titel wird mit
 * `ENQUEUE` angehaengt - eine geleerte Warteschlange davor wuerde genau das
 * abraeumen, was gerade entsteht.
 */
const LEEREN = { type: 'AudioPlayer.ClearQueue', clearBehavior: 'CLEAR_ALL' };
const vorspann = () => (process.env.MUSIK_CLEAR_QUEUE === '0' ? [] : [LEEREN]);

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

/**
 * Der Rueckfall ist ein Zeichen, kein leeres Objekt.
 *
 * Alle Staende stehen unter einem Schluessel. Wer bei einer abgelaufenen Frist
 * mit `{}` weiterrechnet, schreibt anschliessend genau einen Stand zurueck und
 * loescht die aller anderen Playlists mit - ein stiller Datenverlust dort, wo
 * gerade nur die Datenbank langsam war. Ein fehlender Schluessel ist dagegen
 * der erste Stand ueberhaupt und voellig in Ordnung.
 */
const AUSGEFALLEN = Symbol('Stand nicht gelesen');

async function standSchreiben(redis, name, stand, frist = Infinity) {
  try {
    const gelesen = await mitFrist(redis.get(STAND_KEY), AUSGEFALLEN, STAND_KEY, frist);
    if (gelesen === AUSGEFALLEN) return;
    const alle = gelesen || {};
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
 * Was ein gemerkter Stand fuer den naechsten Start bedeutet.
 *
 * Eine Stelle statt zweier Kopien: "spiele das Hoerspiel" und "Alexa, weiter"
 * ohne laufenden Stream muessen dieselbe Rechnung anstellen, und sie ist nicht
 * trivial genug, um sie zweimal zu schreiben.
 *
 * Ein Stand jenseits der Liste (die Playlist wurde seither gekuerzt) faellt auf
 * den Anfang zurueck, statt ins Leere zu greifen. Der gespeicherte Seed gilt
 * dagegen weiter: Nur mit ihm steht an dieser Stelle wieder derselbe Titel.
 * Eine frische Mischung waere ein neuer Anfang, und genau den will
 * "weiterhoeren" nicht.
 */
function standAnwenden(playlist, stand) {
  const anfang = { position: 0, runde: 0, seed: mischt(playlist) ? neuerSeed() : 0, offset: 0, weiter: false };
  // `fertig` heisst: durchgelaufen. Der Eintrag bleibt trotzdem stehen, damit
  // ein nachklappender Stopp aus denselben Sekunden nicht doch noch eine
  // Stelle am Ende anlegt - gespielt wird von vorn, mit frischer Mischung.
  if (!stand || stand.fertig || !Number.isInteger(stand.position)) return anfang;
  if (stand.position < 0 || stand.position >= playlist.titel.length) return anfang;
  // **Album oder Hoerbuch.** Titelgenau heisst: der gemerkte Titel, aber von
  // seinem Anfang. Die Sekunde steht trotzdem in der Datenbank - sie kostet
  // nichts, und wer spaeter auf Hoerbuch umstellt, findet sie dann vor, statt
  // erst beim naechsten Stopp wieder eine zu bekommen.
  const offset = fortsetzArt(playlist) === 'titel' ? 0 : einstieg(stand.offset);
  return {
    position: stand.position,
    runde: Number.isInteger(stand.runde) ? stand.runde : 0,
    seed: Number.isInteger(stand.seed) ? stand.seed : 0,
    offset,
    // Der Vorlauf entscheidet mit: Drei Sekunden minus Vorlauf sind null, und
    // bei null am ersten Titel ist "weiter" eine Uebertreibung.
    weiter: stand.position > 0 || offset > 0,
  };
}

/**
 * Die Playlist, die zuletzt gestoppt wurde - fuer "Alexa, weiter" ohne
 * laufenden Stream.
 *
 * **Warum es diesen Rueckfall braucht.** `context.AudioPlayer` traegt die
 * Stelle nur, solange auf dem Geraet nichts anderes lief. Lief zwischendurch
 * Radio oder ist ein Tag vergangen, ist sie weg, und der Skill antwortete
 * "Es laeuft gerade nichts" - obwohl die Stelle in der Datenbank steht. Genau
 * dort, wo jemand "weiter" sagt, ist das die falsche Auskunft.
 *
 * `zeit` schreibt `standSchreiben` ohnehin bei jedem Stand mit; hier wird sie
 * zum ersten Mal gelesen. Playlists ohne den Schalter und solche, die es nicht
 * mehr gibt, kommen nicht in Frage.
 */
async function juengsterStand(redis, playlists, frist = Infinity) {
  let alle;
  try {
    alle = await mitFrist(redis.get(STAND_KEY), {}, STAND_KEY, frist) || {};
  } catch (err) {
    console.warn('Stand nicht lesbar:', err);
    return null;
  }
  let beste = null;
  for (const playlist of playlists) {
    if (!setztFort(playlist) || playlist.titel.length === 0) continue;
    const stand = alle[playlist.name.toLowerCase()];
    if (!stand) continue;
    const zeit = Number(stand.zeit) || 0;
    if (!beste || zeit > beste.zeit) beste = { playlist, stand, zeit };
  }
  return beste;
}

/** Zeigen Stand und Token auf denselben Titel desselben Durchlaufs? */
function selberTitel(stand, token) {
  return !!stand
    && stand.position === token.position
    && (Number(stand.runde) || 0) === token.runde
    && (Number(stand.seed) || 0) === token.seed;
}

/**
 * Haelt fest, wo die Wiedergabe gerade steht.
 *
 * Aufgerufen bei PlaybackStarted (Anfang eines Titels) und PlaybackStopped
 * (Pause, Stop, Wechsel) - letzteres bringt den Offset mit und ist damit der
 * genaue Punkt. Nur fuer Playlists, die fortgesetzt werden sollen: Sonst
 * schriebe jeder Titelwechsel jeder Playlist in die Datenbank, fuer nichts.
 *
 * **Der Stand geht dabei nie zurueck.** Bei einem Titelwechsel schickt der Echo
 * beides, und in welcher Reihenfolge die beiden Ereignisse hier ankommen, ist
 * nicht zugesichert: Ein PlaybackStopped des alten Titels kann dem
 * PlaybackStarted des neuen hinterherlaufen. Ein PlaybackStopped schreibt
 * deshalb nur, solange der Stand noch auf seinen eigenen Titel zeigt; steht er
 * schon weiter oder ist er fort (Playlist durchgelaufen), bleibt es dabei.
 *
 * **Was hier ausdruecklich nicht mehr vorgeschoben wird.** Frueher schob schon
 * `PlaybackNearlyFinished` den Stand auf den angehaengten Titel vor, in der
 * Annahme, dieses Ereignis komme kurz vor Schluss. Der Echo schickt es aber
 * gleich nach dem Titelanfang, sobald in seiner Warteschlange Platz ist. Der
 * Stand zeigte damit fast den ganzen Titel lang schon auf den naechsten, und
 * ein Stopp mitten im Stueck lief in die Sperre oben: Er schrieb nichts, und
 * "weiter" begann beim naechsten Lied statt bei dem, das gerade lief - bei
 * 'titel' die ganze Zusage der Einstellung verfehlt. Dass ein Titel wirklich
 * durch ist, sagt allein `PlaybackFinished` (siehe `titelZuEnde`).
 *
 * Steht ueberhaupt kein Stand, wird geschrieben: Dann ist dies der erste, etwa
 * weil der Schalter waehrend der Wiedergabe angegangen ist.
 *
 * PlaybackStarted schreibt dagegen bedingungslos: Es ist der Anfang eines
 * Titels, der gerade wirklich laeuft, und damit die verlaesslichste Auskunft,
 * die es gibt.
 */
async function standMerken(body, playlists, redis, rest = () => Infinity) {
  const lage = laufendes(body, playlists);
  if (!lage || !setztFort(lage.playlist)) return;
  const offset = body.request?.offsetInMilliseconds || 0;
  if (body.request?.type === 'AudioPlayer.PlaybackStopped') {
    const stand = await standLesen(redis, lage.playlist.name, rest());
    if (stand && (stand.fertig || !selberTitel(stand, lage.token))) return;
  }
  await standSchreiben(redis, lage.playlist.name, {
    position: lage.token.position,
    runde: lage.token.runde,
    seed: lage.token.seed,
    offset,
  }, rest());
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
//
// **Und warum eine abgelaufene Frist noch keine Anmeldung ist.** Hier war der
// Fehler, der als "MEDIA_ERROR_INTERNAL_SERVER_ERROR, Device playback error"
// mitten in einem Album ankam: Lief die gemerkte Nummer aus ihrem Fenster,
// wurde angemeldet - und eine Anmeldung beginnt mit `filelink.lua` ohne
// Sitzung, was auf der Box **alle** Sitzungen beendet, die des gerade
// laufenden Titels eingeschlossen. Der Echo verlor die Datei unter den
// Haenden, meldete einen Serverfehler, und der Skill sprang zum naechsten
// Titel. Bei Titeln von vier, fuenf Minuten traf das jeden zweiten: Das
// Fenster ist fuenf Minuten lang, und der Titelwechsel ist der Moment, in dem
// es abgelaufen ist.
//
// Deshalb steht vor der Anmeldung jetzt die Nachfrage (`sitzungGilt`): ein
// einziger Abruf mit der gemerkten Nummer, der nichts beendet und die Sitzung
// bei der Box sogar verlaengert. Solange gespielt wird, haelt sie sich damit
// von selbst; angemeldet wird nur noch, wenn sie wirklich tot ist.

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
 * Was die Nachfrage kosten darf, und was fuer sie uebrig sein muss.
 *
 * Sie ist ein einzelner Abruf, also billiger als die Anmeldung - und sie ist
 * der Regelfall, seit die Anmeldung die Ausnahme ist. Scheitert sie, folgt die
 * Anmeldung im selben Request; die zwei Sekunden hier sind deshalb bewusst
 * knapp, damit der teure Weg dahinter noch sein Budget vorfindet.
 */
const SID_PRUEF_MS = 2000;
const SID_PRUEF_MINDESTBUDGET_MS = 1300;

/**
 * Restbudget fuer das Log. "Infinity ms Budget uebrig" hat schon einmal
 * jemanden suchen lassen, wo nichts war: Ausserhalb des Skills gibt es kein
 * Alexa-Fenster, und das ist keine Zahl, sondern eine Ansage.
 */
const budgetText = (ms) => (Number.isFinite(ms) ? `${ms} ms Budget uebrig` : 'ohne Frist');

/**
 * Was der Weckruf an die Datei kosten darf, und was fuer ihn dasein muss.
 *
 * **Warum er ueberhaupt Zeit bekommt.** Die Sitzungsnummer war nie das ganze
 * Problem: Gemeldet war ein stummer erster Versuch, bei dem der Login glatt
 * durchlief, die Nummer galt - und der zweite Versuch dieselbe Adresse mit
 * derselben Nummer anstandslos spielte. Was dazwischen anders wurde, war die
 * Platte der FRITZ!Box: Der erste, in Alexas Ladefrist verhungerte Abruf des
 * Echos hat sie aufgeweckt. Also weckt sie jetzt der Skill, bevor er etwas
 * verspricht (siehe `weckeStream` in lib/fritznas.js).
 *
 * Zweieinhalb Sekunden sind dafuer bemessen, nicht gemessen: Eine schlafende
 * Platte braucht laenger, und das ist in Ordnung - der Weckruf muss nicht
 * fertig werden, er muss nur angekommen sein. Fertig werden muss die Antwort
 * an Alexa, und deshalb steht darunter eine Schwelle: Wo so wenig Budget uebrig
 * ist, dass der Weckruf die Antwort gefaehrdet, unterbleibt er.
 */
const WECKRUF_MS = 2500;
const WECKRUF_MINDESTBUDGET_MS = 900;

/**
 * Die Datei antippen, die der Echo als naechstes laden soll.
 *
 * Liefert `true`, wenn losgespielt werden darf. `false` heisst: Die Box hat
 * ausdruecklich etwas anderes als Ton geschickt - eine Fehlerseite, eine
 * Umleitung auf die Anmeldung -, und der Echo bekaeme gleich dasselbe. Dann
 * ist ein Satz besser als ein Versprechen, das nicht haelt.
 *
 * **Eine Zeitueberschreitung ist kein `false`.** Sie ist der Regelfall, wenn
 * die Platte gerade anlaeuft, und genau der Fall, fuer den es den Weckruf
 * gibt: Wer hier absagt, sagt immer dann ab, wenn er gerade geholfen hat.
 */
/**
 * Wie weit der Abruf des Echos vom Login wegrueckt.
 *
 * **Woher die Zahl kommt: aus dem Ausschlussverfahren, nicht aus der Box.**
 * Gemessen ist, dass der stumme Versuch ausnahmslos der mit dem Login ist -
 * und dass an ihm sonst nichts anders ist. Die Antwort kam mit 4,3 Sekunden
 * Luft an ("Alexa wartet seit 3683 ms"), Alexa sprach den Satz, der Echo
 * meldete AudioPlayer, und derselbe Echo spielt nach derselben Pause eine
 * Playlist von einem anderen Server ohne Zoegern. Der Weckruf des Skills kommt
 * 668 ms nach dem Login noch durch, der Abruf des Echos ein bis zwei Sekunden
 * spaeter nicht mehr, und eine Minute danach geht dieselbe Nummer wieder.
 *
 * `filelink.lua` ohne Sitzung beendet laut AVM **alle** Sitzungen der Box. Was
 * sie in den Sekunden danach genau tut, ist von aussen nicht zu sehen - dass
 * sie in dieser Zeit fuer einen zweiten Abrufer nicht taugt, ist durch
 * Ausschluss belegt.
 *
 * **Anderthalb Sekunden sind deshalb eine Wette, keine Messung**, und sie
 * steht in einer Umgebungsvariablen statt im Code: Wenn die Box laenger
 * braucht, ist das eine Zahl im Dashboard von Vercel und kein Deploy.
 */
const WECKRUF_ABSTAND_MS = () => {
  const gesetzt = Number(process.env.MUSIK_WECK_ABSTAND_MS);
  return gesetzt >= 0 ? gesetzt : 1500;
};

/**
 * Was die zweite Runde zurueckhalten muss - und warum es weniger ist als sonst.
 *
 * **Hier stand 600, und damit lief der zweite Weckruf nie.** `einWeckruf`
 * verlangt WECKRUF_MINDESTBUDGET_MS, also 900; zurueckgelegt wurden 600. Die
 * Pause nahm sich alles bis auf diese 600, und der Abruf danach fand 300 zu
 * wenig vor und liess sich aus. Gemeldet hat es genau die Zeile, die das
 * haette verhindern sollen:
 *
 *   musik-box Datei angetippt: HTTP 206, audio/mpeg nach 644 ms, 2258 ms Budget
 *   musik-box Weckruf ausgelassen, nur noch 1300 ms Budget
 *
 * 2258 - (2258 - 700 - 600) = 1300. Zwei Konstanten, die dasselbe meinten und
 * verschieden gross waren - der zweite Weckruf konnte gar nicht stattfinden,
 * ausgerechnet im Fall, fuer den es ihn gibt.
 *
 * **Und die Reserve dahinter ist kleiner als SID_ANTWORT_RESERVE_MS.** Die 700
 * dort schuetzen vor einem Netzabruf, der ueberzieht. Nach dem zweiten Weckruf
 * kommt kein Abruf mehr, nur noch `res.json()` - und das aeussere Budget haelt
 * ohnehin schon anderthalb Sekunden fuer Antwort und Rueckweg zurueck. Diese
 * Reserve doppelt zu nehmen hiess, die Pause auf die Haelfte zu kuerzen.
 */
const WECKRUF_SPAET_RESERVE_MS = 300;

/**
 * Schlupf fuer die Pause selbst.
 *
 * `setTimeout` schlaeft nie genau so lange, wie man ihm sagt - ein paar
 * Millisekunden zu lang sind der Normalfall. Rechnet man die Pause so aus,
 * dass danach **exakt** das Mindestbudget uebrig ist, entscheidet diese
 * Ungenauigkeit ueber den zweiten Weckruf: zwei Millisekunden daneben, und er
 * faellt aus. Genau so ist er beim ersten Versuch ausgefallen, nur mit einer
 * anderen Zahl. Eine Rechnung ohne Luft ist hier schon zweimal umgekippt.
 */
const WECKRUF_SCHLUPF_MS = 60;

/** Warten, ohne dabei etwas zu tun. */
const warte = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Die Datei antippen, die der Echo als naechstes laden soll.
 *
 * Liefert `true`, wenn losgespielt werden darf. `false` heisst: Die Box hat
 * ausdruecklich etwas anderes als Ton geschickt - eine Fehlerseite, eine
 * Umleitung auf die Anmeldung -, und der Echo bekaeme gleich dasselbe. Dann
 * ist ein Satz besser als ein Versprechen, das nicht haelt.
 *
 * **Eine Zeitueberschreitung ist kein `false`.** Sie ist der Regelfall, wenn
 * die Platte gerade anlaeuft, und genau der Fall, fuer den es den Weckruf
 * gibt: Wer hier absagt, sagt immer dann ab, wenn er gerade geholfen hat.
 *
 * **Nach einer Anmeldung kommt ein zweiter Weckruf, und davor eine Pause.**
 * Siehe WECKRUF_ABSTAND_MS: Der Abruf des Echos soll nicht im selben Atemzug
 * wie der Login bei der Box ankommen. Die Pause schiebt ihn weg, und der
 * zweite Weckruf sagt im Log, **ob die Box zu diesem spaeteren Zeitpunkt noch
 * liefert** - die Beobachtung ueber die Box, die bisher fehlte. Ohne
 * Anmeldung passiert nichts davon: Dort gibt es kein Problem, und zwei
 * Sekunden Ansage vor jedem Titel waeren ein hoher Preis fuer nichts.
 */
async function weckeErstenTitel(playlist, direktive, rest, restEil = () => Infinity, nachLogin = false) {
  if (playlist?.quelle?.typ !== 'fritz' || !direktive) return true;
  const url = direktive.audioItem.stream.url;

  // **Vor dem ersten Ton zaehlt Schnelligkeit mehr als Gewissheit.** Der
  // Weckruf war fuer die Platten-These gebaut, und die ist widerlegt: acht von
  // acht Proben kamen mit HTTP 206 und Audio zurueck. Uebrig bleibt eine halbe
  // Sekunde auf genau dem Weg, auf dem eine halbe Sekunde ueber Ton oder
  // Stille entscheidet. Ist das Eilziel aufgebraucht, unterbleibt er.
  // **Gemessen wird an dem, was der Weckruf kostet, nicht an der Null.** Ein
  // Eilziel mit noch 200 ms darin traegt keinen Abruf von 600 - er wuerde ihn
  // um 400 ms ueberziehen. Die Schwelle ist deshalb dieselbe wie sein
  // Mindestbudget: Wer ihn nicht bezahlen kann, laesst ihn.
  if (restEil() < WECKRUF_MINDESTBUDGET_MS) {
    console.warn(`musik-box Weckruf ausgelassen, nur noch ${restEil()} ms Eilziel`);
    return true;
  }

  const erste = await einWeckruf(url, rest, 'Datei angetippt');
  if (erste === null) return true;                       // kein Budget
  if (erste.endgueltig && !erste.ok) return false;
  if (!nachLogin || restEil() < WECKRUF_MINDESTBUDGET_MS) return true;

  // Was vom Budget uebrig bleibt, wenn der zweite Weckruf und die Antwort
  // selbst noch hineinpassen sollen - mehr als den Zielabstand nie.
  const abstand = Math.max(0, Math.min(
    WECKRUF_ABSTAND_MS(),
    rest() - WECKRUF_SPAET_RESERVE_MS - WECKRUF_MINDESTBUDGET_MS - WECKRUF_SCHLUPF_MS,
  ));
  if (abstand <= 0) {
    console.warn(`musik-box kein Abstand nach der Anmeldung moeglich, ${budgetText(rest())}`);
    return true;
  }
  await warte(abstand);

  const zweite = await einWeckruf(url, rest, `Datei nach ${abstand} ms Abstand noch einmal angetippt`,
    WECKRUF_SPAET_RESERVE_MS);
  if (zweite === null) return true;
  return !(zweite.endgueltig && !zweite.ok);
}

/**
 * Ein einzelner Weckruf samt Logzeile. `null` heisst: Dafuer war keine Zeit.
 *
 * **Diese Zeile ist die Gegenprobe zur Vermutung.** Steht dort "HTTP 206,
 * audio/mpeg nach 140 ms" und der Echo bleibt trotzdem stumm, lag es nicht an
 * der Datei - dann war sie zur Antwortzeit abrufbar, und die naechste Suche
 * faengt woanders an.
 */
async function einWeckruf(url, rest, was, reserve = SID_ANTWORT_RESERVE_MS) {
  const frei = rest() - reserve;
  if (frei < WECKRUF_MINDESTBUDGET_MS) {
    console.warn(`musik-box Weckruf ausgelassen, nur noch ${rest()} ms Budget`);
    return null;
  }
  const antwort = await weckeStream(url, Math.min(WECKRUF_MS, frei));
  console.log(`musik-box ${was}: ${antwort.kurz} nach ${antwort.ms} ms, ${budgetText(rest())}`);
  return antwort;
}

/**
 * Tauscht in den Adressen der gemeinten Playlist die Sitzungsnummer aus.
 *
 * Gibt immer eine brauchbare Liste zurueck: Scheitert das Auffrischen, bleiben
 * die alten Adressen stehen. Sie sind dann vielleicht abgelaufen - aber eine
 * Playlist mit vielleicht toten Adressen ist besser als gar keine, und der
 * Fehlerweg des Skills (PlaybackFailed) fasst das ohnehin ab.
 */
/**
 * Faengt dieser Request eine Wiedergabe an, statt eine laufende fortzufuehren?
 *
 * Der Unterschied ist die Sitzung: Waehrend gespielt wird, haelt der Echo sie
 * mit jedem Bereichsabruf am Leben, und die gemerkte Nummer ist so gut wie
 * sicher noch gut. Vor dem ersten Ton haelt sie niemand - und genau dort
 * kostet eine tote Nummer nicht einen Titel, sondern die ganze Antwort: Alexa
 * sagt "Ich spiele ...", und es bleibt still.
 *
 * "Naechster Titel", "voriger", Mischen und das Anhaengen am Titelende stehen
 * deshalb nicht hier - die passieren mitten in einer laufenden Wiedergabe.
 */
const START_INTENTS = new Set([
  'PlayPlaylistIntent',
  'SuchePlaylistIntent',
  'AMAZON.ResumeIntent',
  'AMAZON.StartOverIntent',
]);

function faengtAn(body) {
  const typ = body?.request?.type;
  if (typ === 'PlaybackController.PlayCommandIssued') return true;
  return typ === 'IntentRequest' && START_INTENTS.has(body?.request?.intent?.name);
}

async function fritzAufgefrischt(playlists, body, redis, rest = () => Infinity, restEil = () => Infinity) {
  if (!playlists.some(p => p.quelle?.typ === 'fritz')) return { playlists, fritz: OHNE_FRITZ };

  const gemeint = gemeintePlaylist(playlists, body);
  if (gemeint?.quelle?.typ !== 'fritz') return { playlists, fritz: OHNE_FRITZ };

  // **Ein gescheiterter Titel ueberholt die Frist.** Konnte der Echo eine
  // Datei nicht laden, ist die abgelaufene Sitzungsnummer der bei weitem
  // haeufigste Grund - und der naechste Titel traegt dieselbe. Die Frist wird
  // hier deshalb uebergangen, statt sie auszusitzen.
  //
  // **Uebergangen heisst seit der Nachfrage nicht mehr "angemeldet".** Sonst
  // waere ausgerechnet der Fehlerweg die Stelle, die bei jedem Stolperer alle
  // Sitzungen der Box beendet - auch wenn die Nummer gar nicht schuld war.
  // Jetzt wird zuerst gefragt; gilt sie noch, lag es an etwas anderem, und die
  // Wiedergabe laeuft unbeschadet weiter.
  //
  // **Und ein Start ueberholt sie ebenso.** Gemeldet war ein stummer Start bei
  // gemerkter, keine Minute alter Nummer - der Skill fragte nicht nach, weil
  // die Frist ja noch lief, und war nach 34 ms fertig. Die Frist misst aber
  // Zeit, und auf dieser Box stirbt eine Sitzung nicht an Zeit, sondern an
  // Ereignissen: eine Anmeldung fuer die zweite Freigabe, ein Import, die
  // FRITZ!NAS-Oberflaeche. Waehrend gespielt wird, faellt das nicht ins
  // Gewicht - der Echo haelt die Sitzung selbst am Leben, und ein Fehler
  // kostet einen Titel. Vor dem ersten Ton haelt sie niemand, und ein Fehler
  // kostet die ganze Antwort: "Ich spiele ...", dann Stille. Die Nachfrage
  // kostet eine halbe Sekunde von sechseinhalb und beendet nichts.
  const erzwingen = body?.request?.type === 'AudioPlayer.PlaybackFailed' || faengtAn(body);

  // **"Eine Nummer da" ist zu wenig fuer ein Versprechen.** Hier stand vorher
  // nur, ob ueberhaupt eine eingesetzt wurde - und eine gemerkte, laengst
  // abgelaufene ist eine. Genau das war der gemeldete Fall: Alexa sagte "Ich
  // spiele das doppelte Lottchen", der Echo bekam eine tote Nummer, und es
  // blieb still. Jetzt zaehlt, ob die Nummer gerade von der Box kommt oder
  // innerhalb ihres Fensters liegt.
  // **Die Eile gilt nur vor dem ersten Ton.** Dort wartet jemand auf einen
  // gesprochenen Satz und ein Geraet, das gleich losspielen soll. Mitten in
  // der Wiedergabe wartet niemand: Der Echo haengt den naechsten Titel selbst
  // an, und dort ist die Nachfrage ihre 740 ms wert, weil sie eine Anmeldung
  // verhindert, die den laufenden Titel aus der Box wirft. Ein Eilziel auch
  // dorthin zu reichen hiesse, ausgerechnet die Stelle zu beschleunigen, an
  // der Geschwindigkeit nichts nuetzt und Schaden kostet.
  const eile = faengtAn(body) ? restEil : () => Infinity;
  const { playlist: frisch, verlaesslich, erneuert, ungeprueft, angemeldet } = await mitFrischerSid(gemeint, redis, erzwingen, rest, eile);
  return {
    playlists: playlists.map(p => (p === gemeint ? frisch : p)),
    fritz: { ok: verlaesslich, erneuert, ungeprueft, angemeldet },
  };
}

/** Nichts mit FRITZ!NAS zu tun - dann gibt es auch nichts zu bedenken. */
const OHNE_FRITZ = { ok: true, erneuert: false, ungeprueft: false, angemeldet: false };

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
async function mitFrischerSid(playlist, redis, erzwingen = false, rest = () => Infinity, restEil = () => Infinity) {
  if (playlist?.quelle?.typ !== 'fritz') return { playlist, verlaesslich: true, erneuert: false, ungeprueft: false, angemeldet: false };
  const { sid, verlaesslich, erneuert, ungeprueft, angemeldet } = await fritzSid(playlist.quelle.link, redis, erzwingen, rest, restEil);
  // **Gar keine Nummer ist kein Fall von "ungeprueft".** Dann stehen in der
  // Playlist noch die Adressen aus der Importzeit, und die sind mit Sicherheit
  // abgelaufen - da gibt es nichts, worauf sich ein Versuch stuetzen koennte.
  if (!sid) return { playlist, verlaesslich: false, erneuert: false, ungeprueft: false, angemeldet };
  return {
    playlist: { ...playlist, titel: playlist.titel.map(t => ({ ...t, url: mitSid(t.url, sid) })) },
    verlaesslich,
    erneuert,
    ungeprueft,
    angemeldet,
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

/**
 * Eine gueltige Sitzungsnummer - aus Redis, nachgefragt, sonst frisch von der Box.
 *
 * Drei Stufen, von der billigsten zur teuersten:
 *
 *   1. **Innerhalb der Frist**: die gemerkte, ohne jeden Abruf.
 *   2. **Ausserhalb der Frist**: ein Abruf, der fragt, ob sie noch gilt - und
 *      sie bei der Box im selben Zug verlaengert.
 *   3. **Erst wenn sie tot ist**: die Anmeldung, die alle Sitzungen der Box
 *      beendet, den laufenden Titel eingeschlossen.
 *
 * `erneuert` sagt dem Aufrufer, ob Stufe 3 gelaufen ist. Nur dann hat sich die
 * Nummer wirklich geaendert, und nur dann lohnt es, einen gescheiterten Titel
 * noch einmal zu versuchen (siehe nachFehler).
 */
async function fritzSid(link, redis, erzwingen = false, rest = () => Infinity, restEil = () => Infinity) {
  const freigabe = istFritzFreigabe(link);
  if (!freigabe) return { sid: null, verlaesslich: false, erneuert: false, ungeprueft: false, angemeldet: false };

  // **Die Unterscheidung, an der alles haengt: Wurde die Box ueberhaupt
  // gefragt?** "Sie hat nein gesagt" und "sie war nicht erreichbar" sind
  // Auskuenfte - auf beide gehoert ein Satz statt eines Versprechens, und
  // genau das hat der Betrieb schon einmal bestaetigt. "Es war keine Zeit zu
  // fragen" ist dagegen gar keine Auskunft ueber die Nummer, sondern nur eine
  // ueber die Uhr. Nur dieser dritte Fall spielt gleich trotzdem los.
  let gefragt = false;

  const gemerkt = await fritzSidGemerkt(redis, rest());
  // Die gemerkte Nummer taugt nur fuer die Freigabe, zu der sie gehoert:
  // Wurde zwischendurch eine andere geoeffnet, hat die Box diese hier beendet.
  const eigene = gemerkt?.sid && gemerkt.link === link ? gemerkt.sid : null;
  const passt = eigene && Date.now() - (gemerkt.zeit || 0) < FRITZ_SID_MINUTEN * 60_000;
  if (!erzwingen && passt) return { sid: eigene, verlaesslich: true, erneuert: false, ungeprueft: false, angemeldet: false };

  // **Stufe 2: nachfragen, bevor angemeldet wird.** Der Unterschied ist nicht
  // die Ersparnis, sondern der Schaden: Die Anmeldung wirft den laufenden
  // Titel aus der Box, die Nachfrage nicht. Und sie ist fast immer erfolgreich
  // - solange gespielt wird, haelt der Echo die Sitzung mit jedem Abruf am
  // Leben, und dieser eine kommt oben drauf.
  // **Und wenn die Frist ohnehin abgelaufen ist, faellt die Nachfrage der
  // Eile zum Opfer.** Sie kostet gemessen rund 740 ms und hat genau eine
  // Aufgabe: eine Anmeldung zu vermeiden, die einen **laufenden** Titel aus
  // der Box wirft. Vor dem ersten Ton laeuft nichts, das sie schuetzen
  // koennte - dort ist ihr einziger Effekt, dass die Antwort spaeter kommt.
  // Und genau darauf reagiert der Echo.
  //
  // Innerhalb der Frist bleibt sie: Dort ist sie fast immer erfolgreich und
  // erspart die Anmeldung wirklich. Mitten in der Wiedergabe bleibt sie
  // ebenso - `restEil` ist dort laengst aufgebraucht, aber dieser Zweig wird
  // nur bei einem Start ueberhaupt mit einem Eilziel aufgerufen.
  const eiligOhneFrist = !passt && restEil() < SID_PRUEF_MS;
  if (eiligOhneFrist && eigene) {
    console.log(`musik-box Nachfrage ausgelassen, Frist abgelaufen und ${restEil()} ms Eilziel`);
  }
  if (eigene && !eiligOhneFrist && rest() >= SID_PRUEF_MINDESTBUDGET_MS) {
    gefragt = true;
    const begonnen = Date.now();
    const { gilt, kurz } = await sitzungGilt(
      freigabe, eigene, Math.min(SID_PRUEF_MS, rest() - SID_ANTWORT_RESERVE_MS),
    );
    // **"ohne Antwort" allein hat schon eine Runde gekostet.** Gemeldet war
    // genau das - nach 839 ms, also ohne Zeitueberschreitung -, und woran es
    // lag, stand nirgends: nicht erreichbar, kein JSON, ein HTTP-Fehler? Die
    // Box sagt es, der Skill hat es weggeworfen. Jetzt steht es dabei.
    const wort = gilt === null ? `ohne Antwort (${kurz})` : gilt ? 'gilt noch' : 'ist tot';
    console.log(`musik-box FRITZ!NAS-Sitzung nachgefragt: ${wort}`
      + ` nach ${Date.now() - begonnen} ms, ${budgetText(rest())}`);
    if (gilt === true) {
      // Die Frist beginnt von vorn: Die Box hat die Sitzung gerade durch
      // diesen Abruf verlaengert, also ist die Nummer wieder so frisch wie
      // nach einer Anmeldung.
      await fritzSidMerken(redis, link, eigene);
      return { sid: eigene, verlaesslich: true, erneuert: false, ungeprueft: false, angemeldet: false };
    }
    // **Schweigen ist kein Nein.** Wer nicht antwortet, nimmt auch keine
    // Anmeldung entgegen - die waere nur eine zweite verlorene Sekunde. Liegt
    // die gemerkte Nummer in ihrer Frist, bleibt sie das beste Wort, das es
    // gibt, und die Wiedergabe faengt damit an.
    if (gilt === null && passt) return { sid: eigene, verlaesslich: true, erneuert: false, ungeprueft: false, angemeldet: false };
  } else if (passt) {
    // **Keine Zeit zum Nachfragen, aber die Frist laeuft noch.** Dann gilt
    // weiter, was vor der Nachfrage galt: Die Frist ist das schwaechere Wort,
    // aber sie ist eines - und stumm zu bleiben, obwohl die Nummer sehr
    // wahrscheinlich gut ist, waere die schlechtere Wahl.
    return { sid: eigene, verlaesslich: true, erneuert: false, ungeprueft: false, angemeldet: false };
  }

  // **Reicht die Zeit nicht fuer den Login, wird er ausgelassen.** Die Box ist
  // langsam, und ein Login, der die Antwort ueber Alexas Fenster hebt, kostet
  // die ganze Wiedergabe statt nur einen Titel.
  if (rest() < SID_MINDESTBUDGET_MS) {
    console.warn(`musik-box FRITZ!NAS-Login ausgelassen, nur noch ${rest()} ms Budget`);
    return { sid: eigene, verlaesslich: false, erneuert: false, ungeprueft: !gefragt, angemeldet: false };
  }

  // Der Login bekommt, was das Budget hergibt - nicht seine alten vier
  // Sekunden. Die Zeile ins Log sagt beim naechsten Mal in einer Minute, ob es
  // an ihm lag: gemerkt (kein Login), wie lange er brauchte, ob er reichte.
  const begonnen = Date.now();
  const ergebnis = await frischeSid(freigabe, rest() - SID_ANTWORT_RESERVE_MS);
  console.log(`musik-box FRITZ!NAS-Login ${ergebnis.sid ? 'ok' : `gescheitert (${ergebnis.fehler})`}`
    + ` nach ${Date.now() - begonnen} ms, ${budgetText(rest())}`);
  if (!ergebnis.sid) {
    // Die gemerkte kommt noch mit, aber ohne Empfehlung: Sie ist aelter als
    // ihr Fenster, sonst waeren wir oben schon zurueck. Der Skill spielt
    // damit nicht los: Die Box war erreichbar genug, um gefragt zu werden,
    // und hat trotzdem keine gueltige Nummer hergegeben.
    return { sid: eigene, verlaesslich: false, erneuert: false, ungeprueft: false, angemeldet: false };
  }
  await fritzSidMerken(redis, link, ergebnis.sid);
  // **`angemeldet` ist nicht dasselbe wie `erneuert`.** Erneuert heisst "die
  // Nummer hat sich geaendert"; angemeldet heisst "`filelink.lua` ohne Sitzung
  // ist gelaufen, und die Box hat gerade alle Sitzungen beendet". Nur das
  // zweite ist der Zustand, vor dem der Abstand schuetzen soll - und er gilt
  // auch dann, wenn zufaellig dieselbe Nummer herauskam.
  return { sid: ergebnis.sid, verlaesslich: true, erneuert: ergebnis.sid !== eigene, ungeprueft: false, angemeldet: true };
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
/** Was Alexa zugesteht, bevor sie abbricht. */
const ALEXA_FENSTER_MS = 8000;
/** Fuer die Antwort selbst und den Rueckweg. */
const ANTWORT_RESERVE_MS = 1500;
/**
 * Weniger als das anzusetzen hat keinen Sinn - aber mehr anzusetzen, als da
 * ist, waere eine Luege. Unter diesem Boden wird nichts mehr abgerufen, und
 * der Skill sagt mit dem, was er hat, einen Satz. Ein Satz, der ankommt,
 * schlaegt eine Auskunft, die es nicht mehr rechtzeitig schafft.
 */
const BUDGET_BODEN_MS = 1200;

/**
 * Was eine Antwort hoechstens dauern darf, damit der Echo sie **ausfuehrt**.
 *
 * **Das ist nicht Alexas Fenster, und darin lag der Denkfehler.** Die acht
 * Sekunden entscheiden, ob Alexa die Antwort annimmt - und das tat sie jedes
 * Mal: Sie sprach den Satz. Ob das Geraet die Play-Direktive danach auch
 * ausfuehrt, ist offenbar eine andere Frage mit einer viel engeren Grenze.
 * Gemessen an einem Echo, der laenger untaetig war:
 *
 *   stumm:   3683, 3846, 4537, 5204, 5771 ms
 *   spielt:  1868, 2524 ms
 *
 * Dazwischen liegt eine Luecke, und auf der stummen Seite kam **nie ein
 * einziges AudioPlayer-Ereignis** - kein PlaybackStarted, kein PlaybackFailed.
 * Der Echo hat es nicht einmal versucht. Auf der spielenden Seite meldete er
 * sich nach 18 ms. Was dazwischen anders war, ist nichts als die Zeit.
 *
 * Zweieinhalb Sekunden sind deshalb ein **Ziel**, kein Limit: Alles
 * Entbehrliche weicht ihm, und was uebrig bleibt, dauert eben so lange wie es
 * dauert. `MUSIK_EILZIEL_MS` dreht daran ohne Deploy; 0 schaltet die Eile ab
 * und stellt das alte Verhalten her.
 */
function eilzielMs() {
  // Ausdruecklich `0` heisst "keine Eile" - dann gilt nur noch das
  // Antwortbudget, also das Verhalten von vor dieser Aenderung. Eine `0` als
  // Frist zu lesen waere das Gegenteil: Dann waere sofort alles aufgebraucht.
  if (process.env.MUSIK_EILZIEL_MS === '0') return Infinity;
  const gesetzt = Number(process.env.MUSIK_EILZIEL_MS);
  return Number.isFinite(gesetzt) && gesetzt > 0 ? gesetzt : 2500;
}

/**
 * Wie lange Alexa auf diese Anfrage schon wartet, bevor der Skill anfaengt.
 *
 * **Die Zahl, die im Log bisher fehlte.** Jede Anfrage traegt Alexas eigenen
 * Zeitstempel - api/skill.js liest ihn ohnehin, um alte Anfragen abzuweisen.
 * Der Abstand zu jetzt ist alles, was vor dem Skill lag: Alexas Weg nach
 * Frankfurt, der TLS-Aufbau und vor allem der **Kaltstart** der Function. Die
 * Vercel-Logs zeigen ihn nicht getrennt, und `musik-box … in <n> ms` misst ihn
 * ausdruecklich nicht mit.
 *
 * **Unfug faellt heraus.** Zwei Uhren, die nicht genau gleich gehen, ergeben
 * einen negativen oder absurden Vorlauf; daraus ein Budget zu rechnen waere
 * schlimmer als gar keines. In dem Fall gilt weiter das volle Fenster.
 *
 * Rein und exportiert, damit die Rechnung ohne Alexa pruefbar ist.
 */
export function alexaVorlaufMs(body, jetzt = Date.now()) {
  const ts = Date.parse(body?.request?.timestamp);
  if (!Number.isFinite(ts)) return null;
  const vorlauf = jetzt - ts;
  if (vorlauf < 0 || vorlauf > 30_000) return null;
  return vorlauf;
}

/**
 * Was der Skill insgesamt brauchen darf - gerechnet ab Alexa, nicht ab hier.
 *
 * **Hier stand eine feste Zahl, und die war der blinde Fleck.** Das Budget
 * begann beim ersten Befehl dieser Funktion und wusste nichts von der Zeit
 * davor. Auf einer warmen Function ist das fast dasselbe; beim ersten Aufruf
 * nach einer Pause ist es das nicht, denn dann liegt der Kaltstart dazwischen.
 * Der Skill rechnete also mit sechseinhalb Sekunden, die er gar nicht mehr
 * hatte, liess den Login (rund zwei Sekunden) dafuer noch durchgehen - und
 * seine Antwort kam an, als Alexa schon aufgelegt hatte. Der zweite Versuch
 * traf die Function warm und die Nummer gemerkt, und alles ging.
 *
 * Genau das Muster, das gemeldet ist: stumm beim ersten Versuch, gut beim
 * zweiten - und zwar **ohne** dass an der Antwort selbst etwas falsch war.
 *
 * Jetzt zieht das Budget den Vorlauf ab. Ist viel Zeit vergangen, bleibt der
 * Boden: Dann unterbleibt der Login, und statt Stille kommt der Satz "Ich
 * komme gerade nicht an die FRITZ!Box" - mit einer Zeile im Log, die sagt,
 * warum.
 */
function antwortBudgetMs(body) {
  const gesetzt = Number(process.env.MUSIK_BUDGET_MS);
  const voll = gesetzt > 0 ? gesetzt : ALEXA_FENSTER_MS - ANTWORT_RESERVE_MS;
  const vorlauf = alexaVorlaufMs(body);
  if (vorlauf === null) return voll;
  return Math.max(BUDGET_BODEN_MS, voll - vorlauf);
}

/**
 * Wie weit der Wiedereinstieg hinter die gemerkte Stelle zurueckgeht.
 *
 * **Warum ueberhaupt zurueck.** Wer ein Hoerspiel mitten im Satz stoppt, will
 * den Satz hoeren und nicht seine zweite Haelfte. Jeder Hoerbuchspieler macht
 * das so, und fuenf Sekunden sind der Wert, der sich dort durchgesetzt hat.
 *
 * Nebenbei erledigt der Vorlauf den anderen Rand: Wer nach vier Sekunden
 * stoppt, faengt wieder von vorn an, statt diese vier Sekunden zu
 * ueberspringen - eine Stelle, die noch keine ist, ist keine wert.
 *
 * Wie das Antwortbudget bei jedem Request neu gelesen, damit `MUSIK_VORLAUF_MS`
 * ohne neues Deployment wirkt und die Tests ihn setzen koennen.
 */
function vorlaufMs() {
  const gesetzt = Number(process.env.MUSIK_VORLAUF_MS);
  return Number.isFinite(gesetzt) && gesetzt >= 0 ? gesetzt : 5000;
}

/** Die Stelle, an der wieder eingestiegen wird: der Stand minus Vorlauf, nie unter null. */
export function einstieg(offset) {
  return Math.max(0, (Number(offset) || 0) - vorlaufMs());
}

/**
 * Eine Zusage mit Frist - laeuft sie ab, gilt der Rueckfall.
 *
 * Dasselbe Muster wie `AbortSignal.timeout` in lib/geo.js, nur mit
 * `Promise.race`: Der Upstash-Client reicht kein Signal durch.
 *
 * Das `clearTimeout` im `finally` ist nicht kosmetisch - ein offener Timer
 * haelt die Instanz wach und kann die naechste Antwort verzoegern.
 *
 * **`Infinity` heisst "ohne Frist" und darf nicht in `setTimeout`.** Die
 * Aufrufer ausserhalb des Skills - "Check URLs" voran - haben kein
 * Alexa-Fenster und reichen darum `rest = () => Infinity` durch. `setTimeout`
 * macht daraus **eine Millisekunde**, warnt einmal mit
 * `TimeoutOverflowWarning` und laesst danach jede Zusage in ihre Frist laufen.
 * Im Log stand dann `musik_fritz_sid nicht rechtzeitig: nach Infinity ms`, die
 * gemerkte Sitzungsnummer galt als nicht vorhanden - und "Check URLs" meldete
 * sich jedes Mal neu an, was auf der Box alle Sitzungen beendet. Also die
 * Wiedergabe abwuergte, die es gerade pruefen sollte.
 */
async function mitFrist(zusage, rueckfall, was, frist) {
  if (frist <= 0) {
    console.warn(`${was}: kein Zeitbudget mehr`);
    return rueckfall;
  }
  let uhr;
  try {
    if (!Number.isFinite(frist)) return await zusage;
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

/**
 * Welche Intents am Ende Musik ausgeben wollen.
 *
 * Alles andere - die Liste vorlesen, die Hilfe, Pause und Stopp - geht auf
 * jedem Geraet, und deshalb steht es nicht hier. Ein Gegenstueck zur Liste im
 * switch weiter unten: Wer dort einen Intent ergaenzt, der eine Play-Direktive
 * schickt, gehoert auch hierher.
 */
const WIEDERGABE_INTENTS = new Set([
  'PlayPlaylistIntent',
  'SuchePlaylistIntent',
  'AMAZON.ResumeIntent',
  'AMAZON.NextIntent',
  'AMAZON.PreviousIntent',
  'AMAZON.StartOverIntent',
  'AMAZON.ShuffleOnIntent',
  'AMAZON.ShuffleOffIntent',
]);

/**
 * Kann dieses Geraet ueberhaupt Musik abspielen?
 *
 * **Gemeldet vom Fire TV:** Alexa sagte "Ich spiele Udo CD eins weiter", und
 * dann kam nichts. Der Skill hatte alles richtig gemacht - Playlist gefunden,
 * Stand gelesen, Direktive geschickt -, nur nimmt ein Geraet ohne AudioPlayer
 * eine `AudioPlayer.Play`-Direktive wortlos nicht an. Uebrig bleibt der Satz,
 * und der verspricht etwas, das nicht kommt.
 *
 * Was ein Geraet kann, steht in jeder Anfrage: `supportedInterfaces`. Damit
 * beantwortet die Anfrage selbst die Frage, statt dass irgendwo eine Liste von
 * Geraetetypen gepflegt werden muesste, die mit jeder Amazon-Generation
 * veraltet.
 *
 * **Fehlt die Auskunft, wird gespielt.** Ein Geraet, das nichts ueber sich
 * sagt, ist kein Grund, ihm die Musik zu verweigern - der Rueckfall ist das
 * bisherige Verhalten. Verweigert wird nur, wenn ausdruecklich dasteht, was
 * das Geraet kann, und AudioPlayer nicht dabei ist.
 */
function audioGeraet(body) {
  const koennen = body?.context?.System?.device?.supportedInterfaces;
  if (!koennen || typeof koennen !== 'object') return { kann: true, liste: 'ohne Auskunft' };
  const namen = Object.keys(koennen);
  return { kann: namen.includes('AudioPlayer'), liste: namen.join(', ') || 'keine' };
}

export async function handleSkill(body, res, redis) {
  const beginn = Date.now();
  /** Was vor dem Skill lag - Kaltstart inbegriffen. `null`: nicht zu ermitteln. */
  const vorlauf = alexaVorlaufMs(body, beginn);
  /** Wie viele Millisekunden bleiben, bis Alexa aufgibt. */
  const budget = antwortBudgetMs(body);
  const rest = () => budget - (Date.now() - beginn);
  /**
   * Wie viel vom Eilziel noch uebrig ist - gerechnet ab Alexas Zeitstempel,
   * denn der Echo wartet ab dort. Negativ heisst: Alles Entbehrliche
   * unterbleibt jetzt.
   */
  const restEil = () => eilzielMs() - (vorlauf ?? 0) - (Date.now() - beginn);
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
  const aufgefrischt = await fritzAufgefrischt(playlists, body, redis, rest, restEil);
  playlists = aufgefrischt.playlists;
  const fritz = aufgefrischt.fritz;
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

      // **Kein Versprechen an ein Geraet, das nicht abspielen kann.** Dasselbe
      // Prinzip wie bei der fehlenden Sitzungsnummer weiter unten in
      // handlePlay: Ein Satz, der erklaert, ist besser als Stille, die es
      // nicht tut. Die Zeile ins Log nennt, was das Geraet gemeldet hat - beim
      // naechsten Zweifel steht dort, woran es lag.
      if (WIEDERGABE_INTENTS.has(intent.name)) {
        const geraet = audioGeraet(body);
        console.log(`musik-box Geraet kann: ${geraet.liste}`);
        if (!geraet.kann) {
          return speak(res, 'Dieses Gerät kann meine Musik leider nicht abspielen. '
            + 'Versuch es auf einem Echo.', true);
        }
      }

      switch (intent.name) {
        case 'PlayPlaylistIntent':
        case 'SuchePlaylistIntent':
          return await handlePlay(intent, res, playlists, direktiven, redis, rest, restEil, fritz);
        case 'ListPlaylistsIntent':
          return handleList(res, playlists, direktiven);
        case 'AMAZON.PauseIntent':
        case 'AMAZON.StopIntent':
        case 'AMAZON.CancelIntent':
          return still(res, [STOP], true);
        case 'AMAZON.ResumeIntent':
          return await weiter(body, res, playlists, direktiven, false, redis, rest, restEil, fritz);
        case 'AMAZON.NextIntent':
          return springe(body, res, playlists, +1);
        case 'AMAZON.PreviousIntent':
          return springe(body, res, playlists, -1);
        case 'AMAZON.StartOverIntent':
          return await vonVorn(body, res, playlists, redis, direktiven, rest, restEil, fritz);
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

    if (typ === 'AudioPlayer.PlaybackNearlyFinished') return naechsterTitel(body, res, playlists);
    if (typ === 'AudioPlayer.PlaybackFinished') return await titelZuEnde(body, res, playlists, redis, rest);
    if (typ === 'AudioPlayer.PlaybackFailed') return await nachFehler(body, res, playlists, fritz.erneuert, rest);

    // Die beiden Ereignisse, die den Stand innerhalb der Playlist fuehren
    // (das dritte, PlaybackFinished, vermerkt oben nur den Schluss).
    // PlaybackStopped bringt den Offset mit und ist der genaue Punkt;
    // PlaybackStarted sichert wenigstens den Titelanfang, falls danach nichts
    // mehr kommt (Stromausfall, Absturz).
    if (typ === 'AudioPlayer.PlaybackStarted' || typ === 'AudioPlayer.PlaybackStopped') {
      await standMerken(body, playlists, redis, rest);
      return still(res);
    }

    if (typ === 'PlaybackController.NextCommandIssued') return springe(body, res, playlists, +1);
    if (typ === 'PlaybackController.PreviousCommandIssued') return springe(body, res, playlists, -1);
    if (typ === 'PlaybackController.PlayCommandIssued') return await weiter(body, res, playlists, [], true, redis, rest, restEil, fritz);
    if (typ === 'PlaybackController.PauseCommandIssued') return still(res, [STOP]);

    if (typ === 'System.ExceptionEncountered') {
      console.error('Alexa meldet:', JSON.stringify(body.request.error), JSON.stringify(body.request.cause));
    }
    // SessionEndedRequest und alles andere: leere Antwort, Sprache ist hier
    // nicht erlaubt
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
    //
    // **Und daneben die Zahl, auf die es ankommt.** "Alexa wartet seit" zaehlt
    // ab ihrem eigenen Zeitstempel, enthaelt also den Kaltstart und den Weg
    // hin und zurueck. Steht dort etwas ueber achttausend, hat Alexa laengst
    // aufgelegt - dann war nicht die Antwort falsch, sondern zu spaet, und
    // keine Zeile darueber haette das je verraten.
    const gebraucht = Date.now() - beginn;
    console.log(`musik-box ${typ} in ${gebraucht} ms`
      + (vorlauf === null ? '' : `, Alexa wartet seit ${gebraucht + vorlauf} ms (Vorlauf ${vorlauf} ms)`));
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
async function handlePlay(intent, res, playlists, direktiven, redis, rest = () => Infinity, restEil = () => Infinity, fritz = OHNE_FRITZ) {
  if (playlists.length === 0) {
    return speak(res, 'Es ist noch keine Playlist angelegt. Bitte lege im Dashboard eine an.', true);
  }
  const { playlist, gesagt } = findePlaylist(playlists, intent.slots?.playlist || intent.slots?.suche);
  if (!gesagt) return frageWelche(res, 'Welche Playlist soll ich spielen?', playlists, direktiven);
  if (!playlist) {
    // **Der haeufigste Fehlschlag stand bisher in keinem Log.** Ohne ihn ist
    // von aussen nicht zu unterscheiden, ob die Box stumm blieb oder ob der
    // Name gar nicht ankam - und genau das hat eine Fehlersuche gekostet.
    console.warn(`musik-box kennt "${gesagt}" nicht (normalisiert: ${normalisiere(gesagt)});`
      + ` bekannt: ${playlists.map(p => `${p.name}=${normalisiere(p.name)}`).join(', ')}`);
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
  //
  // **Eine Ausnahme, und nur eine: Es war keine Zeit zu fragen.** Nach einem
  // Kaltstart bleibt vom Budget der Boden, und darin passt weder Nachfrage
  // noch Anmeldung - die Box wurde in diesem Request also **gar nicht
  // angefasst**. Dann liegt ueber die gemerkte Nummer keine schlechte
  // Auskunft vor, sondern gar keine. "Veraltet" heisst dabei bloss *aelter
  // als fuenf Minuten*, und die Box verlaengert eine Sitzung bei jedem
  // Zugriff; sie ist mit einiger Wahrscheinlichkeit noch gut.
  //
  // Der Fehlschlag traegt sich hier selbst: Kommt der Echo nicht an die
  // Datei, meldet er `PlaybackFailed` - eine **neue Anfrage mit frischen acht
  // Sekunden und warmer Function**. Dort wird die Sitzung erzwungen geprueft
  // und derselbe Titel wiederholt (siehe nachFehler). Aus "Versuch es gleich
  // noch einmal" werden ein, zwei Sekunden Verzoegerung - und im guten Fall
  // gar keine.
  //
  // **Hat die Box dagegen geantwortet - mit nein oder gar nicht -, bleibt es
  // beim Satz.** Genau dort hat der Betrieb schon einmal gezeigt, dass das
  // Wetten auf die alte Nummer nichts einbringt ausser Stille.
  if (playlist.quelle?.typ === 'fritz' && !fritz.ok) {
    if (!fritz.ungeprueft) {
      console.warn(`FRITZ!NAS-Sitzung fehlt, ${playlist.name} nicht gestartet`);
      return speak(res, 'Ich komme gerade nicht an die FRITZ!Box. Versuch es gleich noch einmal.', true, direktiven);
    }
    console.warn(`FRITZ!NAS-Sitzung ungeprueft (keine Zeit zu fragen),`
      + ` ${playlist.name} startet trotzdem – ein Fehlschlag kommt als PlaybackFailed zurueck`);
  }
  // **Wo fangen wir an?** Steht "Weiterhoeren" an und liegt ein Stand vor, dort
  // - ein paar Sekunden davor, damit der angefangene Satz noch kommt; sonst am
  // Anfang. Die Rechnung dazu steht in `standAnwenden`.
  const stand = setztFort(playlist) ? await standLesen(redis, playlist.name, rest()) : null;
  const { position, runde, seed, offset, weiter } = standAnwenden(playlist, stand);

  const spiel = playDirektive(playlist, position, runde, { seed, offset });
  const start = [...vorspann(), spiel];

  // **Diese Zeile stand bisher nur im Zweig mit Ansage.** Eine Playlist, die
  // still startet, hinterliess damit keine Spur - und was gehoert wurde, stand
  // ohnehin nirgends. Mit ihr ist in einer Minute zu klaeren, was sonst eine
  // Untersuchung kostet: was ankam, worauf es passte, welche Nummer der Echo
  // bekam und von welchem Host.
  // **Der Offset gehoert dazu.** Ein Start bei 0 und ein Wiedereinstieg bei
  // 3:12 sind fuer den Echo zwei verschiedene Abrufe: Der zweite verlangt vom
  // Server einen Bereich aus der Mitte der Datei. Wenn eine Playlist "weiter"
  // nicht spielt und von vorn schon, steht der Unterschied in dieser Zahl.
  console.log(`musik-box spielt ${playlist.name} (gehoert: "${gesagt}")`
    + ` ab ${position + 1}/${playlist.titel.length}`
    + ` bei ${offset} ms: ${adresseKurz(spiel.audioItem.stream.url)}`);

  // **Und jetzt die Datei selbst** - siehe weckeErstenTitel. Bis hierher war
  // nur die Sitzungsnummer geprueft, und die beantwortet die Box aus dem Kopf.
  if (!await weckeErstenTitel(playlist, spiel, rest, restEil, fritz.angemeldet)) {
    console.warn(`FRITZ!NAS liefert keinen Ton, ${playlist.name} nicht gestartet`);
    return speak(res, 'Ich komme gerade nicht an die FRITZ!Box. Versuch es gleich noch einmal.', true, direktiven);
  }

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

/**
 * Losspielen - oder absagen, weil die Box zur Datei nein gesagt hat.
 *
 * Die drei Wege, die eine Wiedergabe **anfangen** ohne selbst einen Namen
 * gehoert zu haben ("weiter", der Play-Knopf, "von vorn"), enden alle hier,
 * damit der Weckruf an die Datei nicht dreimal leicht verschieden dasteht.
 *
 * **Wer den Knopf am Geraet drueckt, bekommt keinen Satz.** Ein
 * PlaybackController-Ereignis ist kein Gespraech; Sprache ist in der Antwort
 * darauf nicht erlaubt, und es bleibt bei der leeren Antwort - dieselbe, die
 * es ohne diese Pruefung auch gegeben haette, nur ohne stummes Versprechen.
 */
async function losOderAbsage(body, res, playlist, start, direktiven = [], rest = () => Infinity, restEil = () => Infinity, nachLogin = false) {
  if (await weckeErstenTitel(playlist, start, rest, restEil, nachLogin)) return still(res, [...vorspann(), start], ausSprache(body));
  console.warn(`FRITZ!NAS liefert keinen Ton, ${playlist.name} nicht fortgesetzt`);
  if (!ausSprache(body)) return still(res);
  return speak(res, 'Ich komme gerade nicht an die FRITZ!Box. Versuch es gleich noch einmal.', true, direktiven);
}

/**
 * Weiter an der Stelle, an der pausiert wurde.
 *
 * **Zwei Quellen, in dieser Reihenfolge.** Weiss der Echo den Stream noch, gilt
 * er: `context.AudioPlayer` ist genauer als alles Gemerkte, weil er den
 * laufenden Titel meint. Weiss er ihn nicht mehr, kommt der gemerkte Stand der
 * zuletzt gestoppten Playlist zum Zug - sonst hoerte jemand, der einen Tag
 * spaeter "weiter" sagt, die Rueckfrage nach der Playlist, obwohl die Antwort
 * gespeichert ist.
 *
 * Beide Wege gehen den Vorlauf zurueck: Eine Pause dauert selten zwei Sekunden,
 * und nach einer laengeren fehlt sonst der Satzanfang.
 */
async function weiter(body, res, playlists, direktiven = [], stumm = false, redis = null, rest = () => Infinity, restEil = () => Infinity, fritz = OHNE_FRITZ) {
  const lage = laufendes(body, playlists);
  if (lage) {
    const position = lage.token.position < lage.playlist.titel.length ? lage.token.position : 0;
    const start = playDirektive(lage.playlist, position, lage.token.runde, { seed: lage.token.seed, offset: einstieg(lage.offset) });
    return await losOderAbsage(body, res, lage.playlist, start, direktiven, rest, restEil, fritz.angemeldet);
  }
  const juengste = redis ? await juengsterStand(redis, playlists, rest()) : null;
  if (juengste) {
    const ab = standAnwenden(juengste.playlist, juengste.stand);
    const start = playDirektive(juengste.playlist, ab.position, ab.runde, { seed: ab.seed, offset: ab.offset });
    return await losOderAbsage(body, res, juengste.playlist, start, direktiven, rest, restEil, fritz.angemeldet);
  }
  if (stumm) return still(res, [], ausSprache(body));
  return frageWelche(res, 'Es laeuft gerade nichts. Welche Playlist soll ich spielen?', playlists, direktiven);
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

async function vonVorn(body, res, playlists, redis, direktiven = [], rest = () => Infinity, restEil = () => Infinity, fritz = OHNE_FRITZ) {
  const lage = laufendes(body, playlists);
  if (!lage) return still(res, [], ausSprache(body));
  // "Von vorn" heisst auch: den gemerkten Stand vergessen. Sonst faengt der
  // naechste Start wieder in der Mitte an, obwohl gerade ausdruecklich das
  // Gegenteil verlangt wurde.
  if (setztFort(lage.playlist)) await standLoeschen(redis, lage.playlist.name);
  const start = playDirektive(lage.playlist, 0, lage.token.runde + 1, { seed: lage.token.seed });
  return await losOderAbsage(body, res, lage.playlist, start, direktiven, rest, restEil, fritz.angemeldet);
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
 *
 * **Und der gemerkte Stand bleibt hier unberuehrt.** Das Ereignis heisst
 * "nearly finished", kommt aber nicht kurz vor Schluss: Der Echo fragt den
 * naechsten Titel an, sobald seine Warteschlange Platz hat - in der Regel
 * Sekunden nach dem Titelanfang. Wer den Stand hier vorschoebe, liesse ihn
 * fast den ganzen Titel lang auf das naechste Lied zeigen, und genau das
 * spielte "weiter" dann ab. Was laeuft, sagt `PlaybackStarted`; was durch ist,
 * sagt `PlaybackFinished`.
 */
function naechsterTitel(body, res, playlists) {
  const lage = laufendes(body, playlists);
  if (!lage) return still(res);
  const ziel = schritt(lage.playlist, lage.token, +1);
  if (ziel.umbruch && !wiederholtSich(lage.playlist)) return still(res);
  const bisher = body.request.token;
  return still(res, [playDirektive(lage.playlist, ziel.position, ziel.runde, { seed: ziel.seed, verhalten: 'ENQUEUE', vorherigerToken: bisher })]);
}

/**
 * Ein Titel ist zu Ende gespielt - und beim letzten heisst das: die Playlist
 * ist durch.
 *
 * `PlaybackFinished` ist das einzige Ereignis, das einen abgespielten Titel
 * wirklich bezeugt; es kommt, wenn der Strom zu Ende ist, und nicht, wenn der
 * Echo Platz in der Warteschlange hat.
 *
 * **Geschrieben wird hier nur der Schluss.** Geht es weiter, meldet sich der
 * angehaengte Titel Sekundenbruchteile spaeter mit `PlaybackStarted`, und der
 * traegt den Stand mit seinem eigenen Token ein - dem einzigen, der Runde und
 * Mischung dieses Durchlaufs wirklich wiedergibt. Hier noch einmal zu rechnen,
 * hiesse raten und beim Umbruch einer gemischten Playlist sogar falsch raten:
 * `schritt` wuerfelt dort einen neuen Seed.
 *
 * Durchgelaufen wird als `fertig` vermerkt statt geloescht: Ein nachklappendes
 * PlaybackStopped aus denselben Sekunden legte sonst die Stelle am Ende wieder
 * an, und der naechste Start begaenne mit dem letzten Titel statt von vorn.
 */
async function titelZuEnde(body, res, playlists, redis, rest = () => Infinity) {
  const lage = laufendes(body, playlists);
  if (!lage || !setztFort(lage.playlist)) return still(res);
  const ziel = schritt(lage.playlist, lage.token, +1);
  if (!ziel.umbruch || wiederholtSich(lage.playlist)) return still(res);
  await standSchreiben(redis, lage.playlist.name, { position: 0, runde: 0, seed: 0, offset: 0, fertig: true }, rest());
  return still(res);
}

/**
 * Der gescheiterte Titel fuer das Log: Nummer, Name und Adresse ohne Sitzungsnummer.
 *
 * Getrennt, weil `nachFehler` sonst mehr Zeilen fuer die Meldung braeuchte als
 * fuer die Entscheidung. Gibt nichts zurueck, wenn die Playlist inzwischen
 * gekuerzt wurde - dann gibt es den Titel nicht mehr, ueber den zu berichten
 * waere.
 */
function titelZumToken(lage) {
  if (!lage || lage.token.position >= lage.playlist.titel.length) return '';
  const { titel, nummer } = titelAn(lage.playlist, lage.token.position, lage.token.seed);
  return `${nummer + 1}. ${titel.name || '(ohne Namen)'} – ${adresseKurz(titel.url)}`;
}

/**
 * Ein Titel, den der Echo nicht laden konnte, blockiert nicht die Playlist:
 * er wird **einmal** wiederholt, und erst dann geht es mit dem naechsten
 * weiter. **Aber nur bis zum Ende der Runde** - scheitern alle, endet die
 * Wiedergabe, statt endlos um die Liste zu kreisen.
 *
 * **Warum ueberhaupt wiederholt wird.** Gemeldet war
 * `MEDIA_ERROR_INTERNAL_SERVER_ERROR` mitten in einem Album, bei gerade
 * geprueft gueltiger Sitzungsnummer und `Offset: 1` - der Titel war nie
 * angelaufen. Die Dateien selbst waren in Ordnung, *Check URLs* meldete die
 * ganze Playlist gruen. Es bleibt die Box: Sie liefert jede Datei durch ein
 * Lua-Skript, und beim Titelwechsel laedt der Echo den naechsten schon vor,
 * waehrend der laufende noch streamt. Zwei Abrufe gleichzeitig sind fuer diese
 * Hardware viel - dieselbe Enge, wegen der die URL-Pruefung fuer eine
 * FRITZ!Box auf einen Abruf gleichzeitig gedrosselt ist.
 *
 * Ein Fehler, der von der Last kommt, ist beim naechsten Versuch weg. Einen
 * Titel deswegen zu ueberspringen heisst, den Hoerenden fuer eine Sekunde
 * schlechter Laune der Box zu bestrafen.
 *
 * Wiederholt wird dort, wo er abbrach (abzueglich des ueblichen Vorlaufs).
 * Beim ueblichen Fall - nie angelaufen - ist das der Anfang; riss er mitten
 * im Stueck ab, weil ihm die Sitzung unter den Haenden starb, geht es an
 * genau der Stelle weiter.
 *
 * **Und genau einmal.** Das Budget steht im Token (`versuch`), also beim
 * Stream selbst: Der wiederholte traegt eine 1, ein Fehler mit einer 1 laesst
 * das Ueberspringen zu, und der naechste Titel faengt wieder bei 0 an. Kein
 * Zaehler, der irgendwo veralten koennte, und eine Schleife kann daraus nicht
 * werden.
 */
async function nachFehler(body, res, playlists, fritzErneuert = false, rest = () => Infinity) {
  const fehler = body.request.error || {};
  const lage = laufendes(body, playlists);
  // **Welcher Titel es war, steht nicht im Token.** Mit Mischung ist Stelle 23
  // nicht Titel 24 - ohne die Nummer laesst sich die Zeile im Dashboard nicht
  // nachschlagen, und ohne die Adresse nicht sagen, welche Sitzungsnummer der
  // gescheiterte Abruf ueberhaupt getragen hat. An beidem hat eine Fehlersuche
  // schon mehrere Runden gehangen.
  const wer = titelZumToken(lage);
  console.warn('Alexa konnte nicht abspielen:', fehler.type, fehler.message,
    'Token:', body.request.token,
    'Offset:', body.context?.AudioPlayer?.offsetInMilliseconds ?? 0,
    wer ? `Titel: ${wer}` : '',
    lage?.token.versuch === 0 ? '- zweiter Versuch' : '- weiter mit dem naechsten Titel',
    fritzErneuert ? '(mit neuer Sitzungsnummer)' : '');
  if (!lage) return still(res);
  // Eine inzwischen gekuerzte Playlist hat die Stelle vielleicht nicht mehr;
  // dann gibt es nichts zu wiederholen, und `schritt` unten faengt das ab.
  const naechste = lage.token.versuch === 0 && lage.token.position < lage.playlist.titel.length
    ? playDirektive(lage.playlist, lage.token.position, lage.token.runde, {
      seed: lage.token.seed, offset: einstieg(lage.offset), versuch: 1,
    })
    : null;
  if (naechste) {
    await atemHolen(lage.playlist, naechste, rest);
    return still(res, [naechste]);
  }
  const ziel = schritt(lage.playlist, lage.token, +1);
  if (ziel.umbruch) return still(res, [STOP]);
  const weiterMit = playDirektive(lage.playlist, ziel.position, ziel.runde, { seed: ziel.seed });
  await atemHolen(lage.playlist, weiterMit, rest);
  return still(res, [weiterMit]);
}

/**
 * Eine Atempause, bevor derselbe Titel noch einmal verlangt wird.
 *
 * **Der Wiederholversuch lief bisher sofort los - und damit in denselben
 * Moment.** Gemeldet:
 *
 *   MEDIA_ERROR_INTERNAL_SERVER_ERROR, Offset: 1, Titel 4 von "Udo CD eins",
 *   Sitzung gerade geprueft: gilt noch - und danach spielte die Musik nicht
 *   mehr.
 *
 * Die Sitzung war in Ordnung, die Datei auch. Was fehlt, ist Luft: Beim
 * Titelwechsel laedt der Echo den naechsten Titel schon vor, waehrend der
 * laufende noch streamt, und zwei gleichzeitige Abrufe durch ein Lua-Skript
 * sind fuer diese Hardware viel. Ein Wiederholversuch, der in derselben
 * Sekunde ankommt, trifft dieselbe ueberlastete Box - und der naechste Titel
 * danach wieder, bis die Runde herum und die Wiedergabe zu Ende ist.
 *
 * Der Weckruf ist hier beides: die halbe Sekunde Abstand, die gefehlt hat, und
 * die Auskunft, ob die Box **jetzt** liefert. Gespielt wird in jedem Fall - was
 * hier gemessen wird, ist der Zustand von einer Sekunde her, und den Titel
 * deswegen zu ueberspringen waere schlechter als ihn zu versuchen.
 */
async function atemHolen(playlist, direktive, rest) {
  if (playlist?.quelle?.typ !== 'fritz' || !direktive) return;
  await einWeckruf(direktive.audioItem.stream.url, rest, 'Datei vor dem naechsten Anlauf angetippt');
}
