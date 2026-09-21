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
import { istPrivateAdresse, zielErlaubt, wegZurBox } from './netz.js'
import { istFritzFreigabe, importiereFritzOrdner, frischeSid, sitzungGilt, textAuszug } from './fritznas.js'
import {
  tonUrl, alsTonUrl, eigeneBasis, tonSchluessel, monatsStand, budgetBytes, lesbareMenge,
  verlaufSchreiben, verlaufLesen, verlaufLoeschen,
} from './naston.js'

// Weiterhin von hier zu haben: test/musik.test.mjs prueft die Grenzen ueber
// diesen Namen, und die Regel selbst steht jetzt in lib/netz.js.
export { istPrivateAdresse }

// Dasselbe fuer die Groessen-Rechnung: geprueft ueber diese Namen, zuhause in
// lib/groesse.js, damit lib/fritznas.js sie ohne Kreis mitbenutzen kann.
import {
  groesseAusContentRange, lesbareGroesse, spieldauerSekunden,
  lesbareDauer, genaueDauer, laengerAlsSitzung, datenrateKbs,
} from './groesse.js'
export {
  groesseAusContentRange, lesbareGroesse, spieldauerSekunden,
  lesbareDauer, genaueDauer, laengerAlsSitzung, datenrateKbs,
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
export function validierePlaylist(body, bisher = null, basis = '') {
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

  // **Alte Adressen mit Sitzungsnummer werden hier umgeschrieben.** Sie
  // koennen beim Echo nicht funktionieren - die Sitzung gehoert der IP, die
  // sie geholt hat, und das ist nie die des Echos (siehe lib/naston.js).
  // Gebraucht wird dafuer nur der Pfad aus der alten Adresse und der
  // Freigabe-Link aus der Herkunft; beides ist hier beisammen. Ein Klick auf
  // "Save Playlist" genuegt damit, ein erneuter Import ist nicht noetig.
  if (quelle && basis) {
    const umgeschrieben = [];
    const schonDa = new Set();
    for (const t of playlist.titel) {
      const url = alsTonUrl(t.url, quelle, basis);
      if (schonDa.has(url)) continue;
      schonDa.add(url);
      umgeschrieben.push(url === t.url ? t : { ...t, url });
    }
    playlist.titel = umgeschrieben;
  }

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
export function tokenBauen(name, position, runde, seed = 0, versuch = 0, pech = 0) {
  const teile = [name, position, runde, seed];
  if (versuch || pech) teile.push(versuch);
  if (pech) teile.push(pech);
  return teile.join(TRENNER);
}

/**
 * Der Token zurueck in seine Teile - oder null, wenn er nicht von hier stammt.
 *
 * **Drei bis fuenf Teile werden weiter gelesen.** Ein Stream, der vor dem
 * Seed, vor dem Versuchszaehler oder vor der Pechstraehne gestartet wurde,
 * laeuft beim Deploy noch; sein Token darf nicht ploetzlich fremd aussehen,
 * sonst braeche die Wiedergabe mitten im Titel ab. Er gilt als ungemischt,
 * unversucht und ohne Pech - was er ja auch war.
 */
export function tokenLesen(token) {
  if (typeof token !== 'string') return null;
  const teile = token.split(TRENNER);
  if (teile.length < 3 || teile.length > 6) return null;
  const [name, p, r, s, v, q] = teile;
  const position = Number(p);
  const runde = Number(r);
  const seed = teile.length >= 4 ? Number(s) : 0;
  const versuch = teile.length >= 5 ? Number(v) : 0;
  const pech = teile.length === 6 ? Number(q) : 0;
  if (!name || !Number.isInteger(position) || position < 0) return null;
  if (!Number.isInteger(runde) || runde < 0) return null;
  if (!Number.isInteger(seed) || seed < 0) return null;
  if (!Number.isInteger(versuch) || versuch < 0) return null;
  if (!Number.isInteger(pech) || pech < 0) return null;
  return { name, position, runde, seed, versuch, pech };
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
export function playDirektive(playlist, position, runde, { seed = 0, verhalten = 'REPLACE_ALL', offset = 0, vorherigerToken, versuch = 0, pech = 0 } = {}) {
  const { titel, nummer } = titelAn(playlist, position, seed);
  const stream = {
    url: titel.url,
    token: tokenBauen(playlist.name, position, runde, seed, versuch, pech),
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
    // Was in diesem Monat durch die App gelaufen ist - die Zahl, die die
    // Frage "kostet mich das den Tarif?" beantwortet, statt sie zu schaetzen.
    if (query.ton) {
      const bytes = await monatsStand(redis);
      const budget = budgetBytes();
      return res.status(200).json({
        bytes,
        budget,
        lesbar: lesbareMenge(bytes),
        budgetLesbar: budget ? lesbareMenge(budget) : null,
      });
    }
    // Die letzten Abrufe und Abspieler-Ereignisse - die Zeilen, die eine
    // Stoerung erklaeren, ohne dass jemand das Log von Vercel exportieren
    // muss. Siehe `verlaufSchreiben` in lib/naston.js.
    if (query.verlauf) {
      return res.status(200).json({ eintraege: await verlaufLesen(redis) });
    }
    if (query.pruefen) {
      const name = String(query.name || '').trim().toLowerCase();
      const playlist = playlists.find(p => p.name.toLowerCase() === name);
      if (!playlist) return res.status(404).json({ error: 'Unknown playlist' });
      const ab = Math.max(0, parseInt(query.ab, 10) || 0);
      // Geprueft wird genau das, was der Echo bekommt: die gespeicherte
      // Adresse. Bei einer FRITZ!NAS-Playlist fuehrt sie durch diese App
      // hindurch bis zur Box - dieser Knopf laeuft damit denselben Weg wie
      // die Wiedergabe und nicht mehr einen zweiten daneben.
      return res.status(200).json(await pruefePlaylist(playlist, ab));
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

    const ergebnis = validierePlaylist(req.body || {}, bisher, eigeneBasis(req));
    if (ergebnis.fehler) return res.status(400).json({ error: ergebnis.fehler });
    const { playlist } = ergebnis;
    const index = playlists.findIndex(p => p.name.toLowerCase() === playlist.name.toLowerCase());
    if (index > -1) playlists[index] = playlist;
    else playlists.push(playlist);
    await redis.set(REDIS_KEY, playlists);
    return res.status(200).json({ success: true, playlists });
  }

  if (req.method === 'DELETE') {
    // Der Verlauf haengt an derselben Route wie das Loeschen einer Playlist,
    // deshalb zuerst abgefragt: sonst waere "verlauf" ein Playlist-Name, den
    // niemand vergeben hat, und der Filter unten liefe leer ins Leere.
    if (query.verlauf) {
      const ok = await verlaufLoeschen(redis);
      return res.status(200).json({ success: ok });
    }
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
    // abzulegen erspart dem naechsten Schritt zwei Abrufe bei der Box. Und er
    // hat sich dafuer angemeldet: Die Nummern der anderen Freigaben verlieren
    // damit ihren Zeitstempel, denn eine Anmeldung beendet alle Sitzungen.
    if (redis && ergebnis.sid) await fritzSidMerken(redis, url.href, ergebnis.sid, { nachAnmeldung: true });
    if (ergebnis.fehler) {
      return res.status(200).json({
        url: url.href,
        titel: [],
        hinweise: [],
        error: ergebnis.fehler,
        bericht: ergebnis.bericht,
      });
    }
    // **Was in die Playlist kommt, ist nicht die Adresse der Box.** Die traegt
    // eine Sitzungsnummer, und die gehoert der IP, die sie geholt hat - nie
    // der des Echos (siehe lib/naston.js). Gespeichert wird deshalb eine
    // Adresse dieser App; den Pfad dahinter traegt das unterschriebene Token.
    const basis = eigeneBasis(req);
    const quelle = { typ: 'fritz', link: url.href, ...(ergebnis.wurzel ? { ordner: ergebnis.wurzel } : {}) };
    const titel = ergebnis.titel.map(t => ({ url: tonUrl(basis, quelle.link, t.pfad) || t.url, name: t.name }));
    // Eine Adresse ohne Token waere eine, die spaeter stumm bleibt - lieber
    // hier sagen, woran es liegt, als am Echo raetseln lassen.
    if (!tonSchluessel()) {
      ergebnis.hinweise.unshift('Achtung: Es ist kein Schluessel gesetzt (MUSIK_TON_KEY, BRIDGE_KEY oder ADMIN_PASSWORD) - ohne ihn kann der Echo den Ton nicht abholen.');
    } else if (!basis) {
      ergebnis.hinweise.unshift('Achtung: Der eigene Hostname liess sich nicht bestimmen - die Adressen zeigen noch auf die FRITZ!Box und werden nicht spielen.');
    }
    return res.status(200).json({
      url: url.href,
      titel,
      hinweise: ergebnis.hinweise,
      bericht: ergebnis.bericht,
      // Der Freigabe-Link geht mit zurueck, damit das Dashboard ihn beim
      // Speichern mitschickt: Aus ihm holt der Skill spaeter eine frische
      // Sitzungsnummer, statt die eingebaute veralten zu lassen. Der Pfad
      // dazu, weil "/Musik/Schlaflieder" in der Liste etwas sagt und eine
      // Freigabenummer nicht.
      quelle,
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

/**
 * `streng` unterscheidet "nicht vorhanden" von "nicht gelesen".
 *
 * **Fuer den Start ist beides dasselbe** - ohne Stand faengt die Playlist von
 * vorn an; das ist die schlechtere Auskunft, aber kein Grund, die Wiedergabe
 * scheitern zu lassen. **Fuer das Merken ist es das Gegenteil:** Wer bei
 * abgelaufener Frist "kein Stand" annimmt, hebt die Sperre gegen
 * zurueckspringende Staende genau dann auf, wenn die Datenbank langsam ist -
 * also genau dann, wenn zwei Ereignisse sich ueberholen. Derselbe Gedanke wie
 * bei `AUSGEFALLEN` eine Funktion weiter unten, nur von der Leseseite.
 */
async function standLesen(redis, name, frist = Infinity, { streng = false } = {}) {
  try {
    const gelesen = await mitFrist(redis.get(STAND_KEY), streng ? AUSGEFALLEN : {}, STAND_KEY, frist);
    if (gelesen === AUSGEFALLEN) return AUSGEFALLEN;
    return (gelesen || {})[name.toLowerCase()] || null;
  } catch (err) {
    console.warn('Stand nicht lesbar:', err);
    return streng ? AUSGEFALLEN : null;
  }
}

/**
 * Schreibt den Stand - und sagt, ob es geklappt hat.
 *
 * **Der Rueckgabewert ist die Reparatur eines stillen Fehlers.** Bei
 * abgelaufener Frist kehrte diese Funktion wortlos um, und `standMerken`
 * meldete trotzdem "gemerkt": Im Vercel-Log stand `musik_stand nicht
 * rechtzeitig` unmittelbar vor `113130 ms gemerkt (stopp)`, im Verlauf des
 * Dashboards dasselbe. Wer die Sekunde suchte, las also an genau der Stelle
 * eine Erfolgsmeldung, an der nichts gespeichert wurde - und suchte den
 * Fehler beim Fortsetzen statt beim Schreiben.
 */
async function standSchreiben(redis, name, stand, frist = Infinity) {
  try {
    const gelesen = await mitFrist(redis.get(STAND_KEY), AUSGEFALLEN, STAND_KEY, frist);
    if (gelesen === AUSGEFALLEN) return false;
    const alle = gelesen || {};
    alle[name.toLowerCase()] = { ...stand, zeit: Date.now() };
    await redis.set(STAND_KEY, alle);
    return true;
  } catch (err) {
    console.warn('Stand nicht speicherbar:', err);
    return false;
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
 * Die Stelle, an der ein Wiedereinstieg anfaengt - in der Gangart der
 * Playlist.
 *
 * **Warum das ein eigener Helfer ist.** Dieselbe Rechnung stand in
 * `standAnwenden` und fehlte in `weiter`, und genau diese Luecke war der
 * gemeldete Fehler: Der eine Weg kannte die Gangart, der andere nicht. Eine
 * Stelle, zwei Aufrufer.
 */
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
export function einstiegNachGangart(playlist, offset) {
  return fortsetzArt(playlist) === 'titel' ? 0 : einstieg(offset);
}

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
  const offset = einstiegNachGangart(playlist, stand.offset);
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
 * Was unter dem Vorlauf liegt, ist keine Stelle, sondern eine fehlende
 * Auskunft.
 *
 * **Die Regel, die dem Hoerbuch gefehlt hat.** Innerhalb desselben Titels
 * wird der Stand nicht ueberschrieben, wenn der neue Wert gar keine Stelle
 * benennt: Ein Titelanfang sagt nichts darueber, dass die zehnte Minute nicht
 * mehr gilt. Genau daran ist das sekundengenaue Fortsetzen gescheitert - ein
 * Wiedereinstieg, der einmal am Titelanfang landete, loeschte mit seinem
 * eigenen `PlaybackStarted` die Stelle, die ihn beim naechsten Mal gerettet
 * haette. Danach hatte kein Versuch mehr etwas Besseres zu lesen, und aus
 * einem einmaligen Fehlgriff wurde ein "faengt immer von vorn an", das sich
 * selbst festhielt.
 *
 * **Hier stand "die exakte Null", und das war zu eng.** Der gemeldete Fall
 * hatte `@1093 ms` in der Datenbank - keine Null, also ging sie durch und
 * deckte die echte Stelle zu. Im selben Log traegt das `PlaybackStarted`
 * dieses Echos einen Vorlauf von 1036 ms: Das Geraet meldet offenbar seine
 * *aktuelle* Position, nicht die, an der es eingestiegen ist. Ein Titelanfang
 * kommt bei ihm also nie als Null an, und eine Zusage, die nur die Null
 * abwehrt, greift bei ihm nie.
 *
 * Die Schwelle ist der Vorlauf selbst, und zwar ohne Rest an Willkuer:
 * `einstieg()` zieht ihn ohnehin ab, jeder Wert darunter ergibt am Ende 0.
 * Was nach der Rechnung den Titelanfang bedeutet, darf eine echte Stelle nicht
 * loeschen. Bei `MUSIK_VORLAUF_MS=0` bleibt es bei genau der Null - dort ist
 * jede Millisekunde eine Stelle, und das ist der Sinn dieser Einstellung.
 *
 * **Der Preis, benannt statt versteckt:** Wer bei 0:02 eines Titels stoppt,
 * dessen zehnte Minute noch gemerkt ist, bleibt bei 10:00 stehen. Die zwei
 * Sekunden waeren nach `einstieg()` ohnehin der Titelanfang gewesen, und
 * absichtlich loswerden laesst sich eine Stelle mit "von vorn".
 *
 * **Sonst keine Monotonie.** Oberhalb des Vorlaufs wird jeder Wert
 * geschrieben, auch ein kleinerer: Der Vorlauf knabbert bei jedem
 * Weiterhoeren fuenf Sekunden ab, und wer nach einem Sprung zurueck bei 0:30
 * stoppt, ist dort und nicht bei 10:00. Eine Sperre "nie kleiner" waere eine
 * Wette darauf, dass Position, Runde und Mischung je Strom nur einmal
 * vorkommen - sie kommen nach jedem Wiedereinstieg wieder.
 */
export function standNichtZurueck(stand, token, offset) {
  if (!stand) return false;
  // Mindestens 1: Ohne Vorlauf bleibt die alte Regel stehen, statt die Sperre
  // ganz abzuschalten - `offset >= 0` waere immer wahr.
  const schwelle = Math.max(1, vorlaufMs());
  if (offset >= schwelle) return false;
  if (!selberTitel(stand, token)) return false;
  return (Number(stand.offset) || 0) > offset;
}

/**
 * Haelt fest, wo die Wiedergabe gerade steht.
 *
 * Aufgerufen bei PlaybackStarted (Anfang eines Titels), bei PlaybackStopped
 * (Pause, Stop, Wechsel) und beim gesprochenen "Stopp"/"Pause" selbst - die
 * letzten beiden bringen den Offset mit und sind damit der genaue Punkt. Nur
 * fuer Playlists, die fortgesetzt werden sollen: Sonst schriebe jeder
 * Titelwechsel jeder Playlist in die Datenbank, fuer nichts.
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
 * **Innerhalb eines Titels geht die Stelle nie zurueck, und das ist die
 * Reparatur des gemeldeten Fehlers.** PlaybackStarted schrieb bisher
 * bedingungslos, also mit `offset: 0` - der Anfang eines Titels ist ja die
 * verlaesslichste Auskunft, die es gibt. Nur sagt er nichts darueber, wo
 * jemand zuletzt aufgehoert hat, und genau das stand an derselben Stelle in
 * der Datenbank. Ein einziger Start am Titelanfang hat die gemerkte Sekunde
 * damit geloescht, und danach hatte kein weiterer Versuch mehr etwas Besseres
 * zu lesen: aus einem einmaligen Fehlgriff wurde ein "faengt immer von vorn
 * an", das sich selbst festhielt. Ein Titelanfang traegt jetzt den Titel ein,
 * aber er dreht die Sekunde desselben Titels nicht mehr zurueck. Absichtlich
 * loswerden laesst sich eine Stelle weiter mit "von vorn" (`standLoeschen`).
 *
 * **Und die Quelle sagt der Aufrufer.** Die Sekunde kommt nicht mehr nur aus
 * `request.offsetInMilliseconds`: Ein gesprochenes "Stopp" ist ein
 * IntentRequest und traegt sie im `context` - siehe `haltUndMerken`. `quelle`
 * unterscheidet die drei Faelle, weil nur der Titelanfang auf einen anderen
 * Titel umschreiben darf.
 *
 * Gibt zurueck, was passiert ist - eine Zeile fuer Log und Verlauf, damit beim
 * naechsten Zweifel nicht wieder geraten werden muss.
 */
async function standMerken(body, playlists, redis, rest = () => Infinity, { offset = null, quelle = 'ereignis' } = {}) {
  const lage = laufendes(body, playlists);
  if (!lage) return 'kein laufender Titel';
  if (!setztFort(lage.playlist)) return null;
  const stelle = Math.max(0, Number(offset ?? body.request?.offsetInMilliseconds) || 0);
  const anfang = quelle === 'anfang';

  // Ein Lesevorgang mehr als vorher, und er ist es wert: Ohne den Stand ist
  // nicht zu entscheiden, ob diese Meldung die Stelle voranbringt oder sie
  // mit einem Titelanfang zudeckt.
  const stand = await standLesen(redis, lage.playlist.name, rest(), { streng: true });
  if (stand === AUSGEFALLEN) return 'nicht gelesen, nichts geschrieben';
  if (standNichtZurueck(stand, lage.token, stelle)) {
    return `${stelle} ms verworfen, ${stand.offset} ms stehen schon`;
  }
  if (stand && !anfang && (stand.fertig || !selberTitel(stand, lage.token))) {
    // Der Nachklapper: ein Stopp des alten Titels, der dem Anfang des neuen
    // hinterherlaeuft - oder einer, der eine durchgelaufene Playlist wieder
    // an ihrem Ende anlegen wuerde.
    return 'nichts gemerkt, der Stand steht weiter';
  }
  const ok = await standSchreiben(redis, lage.playlist.name, {
    position: lage.token.position,
    runde: lage.token.runde,
    seed: lage.token.seed,
    offset: stelle,
  }, rest());
  return ok ? `${stelle} ms gemerkt (${quelle})` : `${stelle} ms NICHT gespeichert (${quelle})`;
}

/**
 * Stopp und Pause - und die Sekunde, die dabei bisher verlorenging.
 *
 * **Der gemeldete Fehler hat hier angefangen.** Gestoppt wird gesprochen, und
 * dieser Zweig antwortete nur mit der Stop-Direktive. Die genaue Stelle steht
 * aber in genau dieser Anfrage (`context.AudioPlayer.offsetInMilliseconds`) -
 * sie wurde weggeworfen und allein von dem `PlaybackStopped` erwartet, das
 * Alexa hinterherschickt. Bleibt das aus (ein Geraet ohne AudioPlayer-
 * Ereignisse, siehe README), kommt es zu spaet oder traegt es eine Null, gab
 * es keine zweite Quelle - und "weiter" fing am Titelanfang an. Jetzt merkt
 * sich der Befehl selbst, was er weiss.
 *
 * **Geschrieben wird vor der Antwort, und das ist die zweite Reparatur.**
 * Vorher lag dieser Schreibvorgang im Nachspiel, hinter `res.json()` - mit der
 * Begruendung, dass Alexa dort nicht mehr wartet. Das stimmt fuer Alexa und
 * nicht fuer Vercel: Die Invocation endet mit der Antwort, die Instanz friert
 * ein, und der Rest laeuft erst, wenn dieselbe Instanz das naechste Mal
 * drankommt - im gemeldeten Fall 4 Minuten 27 Sekunden spaeter, mit laengst
 * abgelaufener Frist, und beim dritten Schreibvorgang gar nicht mehr, weil die
 * Instanz vorher recycelt wurde. Siehe `handleSkill`.
 *
 * Der Preis ist ein Datenbankgang, bevor die Stille kommt. Er ist bezahlbar:
 * Ein Stopp-Befehl hat nur eine Direktive zu liefern, und im gemeldeten Fall
 * standen dafuer 6463 ms Budget zur Verfuegung, gebraucht wurden 10 ms.
 */
async function haltUndMerken(body, res, playlists, redis, schluss, notiz, rest = () => Infinity) {
  const lage = laufendes(body, playlists);
  notiz.stelle = body.context?.AudioPlayer?.offsetInMilliseconds || 0;
  notiz.woher = 'geraet';
  // Die Gangart gehoert in die WORT-Zeile des Verlaufs: "faengt von vorn an"
  // hat mit *Album* eine voellig harmlose Ursache, und ohne diese drei
  // Buchstaben ist sie von einer verlorenen Stelle nicht zu unterscheiden.
  notiz.gangart = lage ? fortsetzArt(lage.playlist) : null;
  // **Die Stille steht ueber dem Vermerk.** `standMerken` faengt jeden
  // Datenbankfehler selbst ab, aber seit es hier *vor* der Antwort laeuft,
  // wuerde eine Ausnahme aus ihm im grossen catch landen - und aus "Alexa,
  // Stopp" wuerde "Es ist leider ein Fehler aufgetreten", waehrend die Musik
  // weiterlaeuft. Ein verlorener Vermerk ist aergerlich, ein Stopp, der nicht
  // stoppt, ist schlimmer.
  try {
    notiz.stand = await standMerken(body, playlists, redis, rest, {
      offset: notiz.stelle,
      quelle: 'wort',
    });
  } catch (err) {
    notiz.stand = `nicht gemerkt: ${err?.message || err}`;
    console.warn('musik-box Stand nicht gemerkt:', err);
  }
  return still(res, [STOP], schluss);
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
/**
 * Traegt diese Anfrage eine Sitzung?
 *
 * **Die Frage, die hier gefehlt hat - und den Fehler erklaert.** Ein
 * AudioPlayer-Skill bekommt "Stopp", "Pause" und "weiter" auch **ohne**
 * Sitzung: Wer Musik laufen hat und einen dieser Befehle sagt, fuehrt keinen
 * Dialog, und Alexa schickt dann kein `session` mit. Eine Antwort darauf darf
 * weder `shouldEndSession` noch `outputSpeech` oder einen `reprompt` tragen -
 * sonst verwirft Alexa sie ganz und sagt "Der angeforderte Skill hat keine
 * gueltige Antwort uebermittelt". Genau das war gemeldet, und zwar fuer genau
 * die drei Befehle, die man ohne offenen Dialog sagt.
 *
 * `body.session` ist die Auskunft darueber, und api/skill.js kennt sie laengst:
 * Es liest die Skill-ID aus `context.System.application` **oder** aus
 * `session.application`, weil eben nicht jede Anfrage eine Sitzung hat.
 */
function hatSitzung(body) {
  return !!body?.session;
}

/**
 * Darf diese Antwort die Sitzung schliessen?
 *
 * **Hier stand nur der Request-Typ, und das war zu wenig.** Ein Sprachbefehl
 * ist nicht dasselbe wie ein Dialog: Es gibt nur etwas zu schliessen, wenn
 * auch etwas offen ist. Die Zusage "jeder Sprachbefehl schliesst die Sitzung"
 * gilt weiter - fuer jeden, der eine hat.
 */
function ausSprache(body) {
  return body?.request?.type === 'IntentRequest' && hatSitzung(body);
}

/**
 * Ein Satz - wenn er gesagt werden darf.
 *
 * Ohne Sitzung ist Sprache in der Antwort nicht erlaubt (siehe `hatSitzung`).
 * Der Satz ginge dann nicht nur verloren, er riss die ganze Antwort mit: Statt
 * eines Hinweises hoerte man Alexas Fehlermeldung, und der Befehl verpuffte.
 * Also geht ohne Sitzung eine stille Antwort hinaus - und der Satz, der nicht
 * gesagt werden durfte, ins Log, damit er nicht spurlos verschwindet.
 *
 * **Die Musik geht trotzdem hinaus.** Was an Direktiven mitkommt, bleibt in
 * der Antwort - nur die fuer den Dialog (`Dialog.*`, die dynamischen Werte
 * fuer eine Rueckfrage) nicht, denn ohne Sitzung gibt es niemanden zu fragen.
 * Ein "spiele das Hoerspiel" ohne Sitzung spielt damit, statt an seinem
 * eigenen Ansagesatz zu scheitern.
 */
function sage(res, body, text, schluss = true, direktiven = [], reprompt = null) {
  if (hatSitzung(body)) return speak(res, text, schluss, direktiven, reprompt);
  console.log(`musik-box ohne Sitzung nicht gesagt: ${text}`);
  return still(res, direktiven.filter(d => !String(d?.type || '').startsWith('Dialog.')));
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
function frageWelche(res, body, satz, playlists, direktiven, mitNamen = true) {
  const namen = mitNamen ? namenListe(playlists) : '';
  // Das Nachfragen bleibt kurz: Wer die Namen gerade gehoert hat, braucht sie
  // nicht noch einmal, und jede Sekunde Ansage ist eine Sekunde mit
  // geschlossenem Mikrofon.
  return sage(res, body, namen ? `${satz} Ich kenne ${namen}.` : satz, false, direktiven, satz);
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
 * Die gemerkten Sitzungen - eine je Freigabe.
 *
 * **Hier stand eine einzige, und das war der Fehler.** Die Ueberlegung war:
 * AVM schreibt in der Technical Note zu Session-IDs, ein Zugriff **ohne**
 * gueltige Sitzung beende alle bestehenden - also seien gemerkte Nummern
 * anderer Freigaben ohnehin tot, und ein einziger Datensatz `{link, sid,
 * zeit}` genuege. Was daraus folgte, war aber nicht "die tote Nummer wird
 * nicht verwendet", sondern: **Sie wird gar nicht erst gefragt.** Gehoerte
 * der Datensatz zu einer anderen Freigabe, ging es ohne Umweg in die
 * Anmeldung - und die ist genau der Zugriff, der alle Sitzungen der Box
 * beendet, den gerade laufenden Titel eingeschlossen.
 *
 * Bei zwei Ordner-Playlists heisst das: Jeder Wechsel zwischen ihnen meldet
 * sich neu an, und wer eine zweite startet, waehrend die erste noch spielt,
 * wirft sie aus der Box.
 *
 * Gemerkt wird deshalb `{ [link]: { sid, zeit } }` - eine Nummer je Freigabe.
 * Eine tote Nummer erkennt man, indem man fragt (`sitzungGilt`, ein Abruf,
 * der nichts beendet), nicht indem man sie wegwirft. Und was eine Anmeldung
 * anrichtet, steht ebenfalls im Speicher: Sie entwertet die Zeitstempel aller
 * anderen Freigaben, damit deren Nummern nicht mehr blind verwendet, sondern
 * vor dem Gebrauch nachgefragt werden.
 */
const FRITZ_SID_KEY = 'musik_fritz_sid';
/** So viele Freigaben behaelt die Tafel - mehr Ordner-Playlists hat niemand. */
const FRITZ_SID_PLAETZE = 8;
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
/**
 * Was vom Zeitbudget noch uebrig ist, fuer die Logzeile.
 *
 * Ohne Frist (der Regelfall, seit der Durchleiter fragt und nicht mehr der
 * Antwortweg) steht dort ein Wort statt `Infinity ms Budget uebrig`.
 */
const budgetText = (ms) => (Number.isFinite(ms) ? `${ms} ms Budget uebrig` : 'ohne Frist');

/**
 * **Das Eilziel ist mit dem Durchleiter verschwunden.** Diese Funktion lief
 * frueher im Antwortfenster von Alexa, und jeder Schritt musste sich fragen,
 * ob er noch hineinpasst. Heute ruft sie nur noch lib/naston.js, waehrend der
 * Echo auf Bytes wartet - dort zaehlt, dass die Nummer stimmt, nicht dass die
 * Antwort in acht Sekunden steht. Die Reihenfolge bleibt: gemerkt, nachfragen,
 * und erst zuletzt anmelden, denn eine Anmeldung beendet alle Sitzungen der
 * Box - auch die, mit der gerade ein anderer Titel laeuft.
 */
export async function fritzSid(link, redis, erzwingen = false, rest = () => Infinity, ordner = null,
  ohneAnmeldung = false) {
  const freigabe = istFritzFreigabe(link);
  if (!freigabe) return { sid: null, verlaesslich: false, erneuert: false, ungeprueft: false, angemeldet: false };

  // **Die Unterscheidung, an der alles haengt: Wurde die Box ueberhaupt
  // gefragt?** "Sie hat nein gesagt" und "sie war nicht erreichbar" sind
  // Auskuenfte - auf beide gehoert ein Satz statt eines Versprechens, und
  // genau das hat der Betrieb schon einmal bestaetigt. "Es war keine Zeit zu
  // fragen" ist dagegen gar keine Auskunft ueber die Nummer, sondern nur eine
  // ueber die Uhr. Nur dieser dritte Fall spielt gleich trotzdem los.
  let gefragt = false;

  const tafel = await fritzSidGemerkt(redis, rest());
  // **Die Nummer dieser Freigabe, und nur die.** Jede Freigabe hat ihre
  // eigene Sitzung mit ihren eigenen Rechten; die einer anderen lebt zwar
  // vielleicht, gibt diese Dateien aber nicht heraus.
  const gemerkt = tafel[link] || null;
  const eigene = gemerkt?.sid || null;
  // Ein Zeitstempel von 0 heisst: Seit dem Merken hat sich jemand anderes
  // angemeldet, und die Anmeldung beendet alle Sitzungen der Box. Die Nummer
  // bleibt einen Versuch wert - aber nur einen gefragten.
  const passt = eigene && gemerkt.zeit > 0 && Date.now() - gemerkt.zeit < FRITZ_SID_MINUTEN * 60_000;
  if (!erzwingen && passt) return { sid: eigene, verlaesslich: true, erneuert: false, ungeprueft: false, angemeldet: false };

  // **Stufe 2: nachfragen, bevor angemeldet wird.** Der Unterschied ist nicht
  // die Ersparnis, sondern der Schaden: Die Anmeldung wirft den laufenden
  // Titel aus der Box, die Nachfrage nicht. Und sie ist fast immer erfolgreich
  // - solange gespielt wird, haelt der Echo die Sitzung mit jedem Abruf am
  // Leben, und dieser eine kommt oben drauf.
  if (eigene && rest() >= SID_PRUEF_MINDESTBUDGET_MS) {
    gefragt = true;
    const begonnen = Date.now();
    const { gilt, kurz, wurzel } = await sitzungGilt(
      freigabe, eigene, Math.min(SID_PRUEF_MS, rest() - SID_ANTWORT_RESERVE_MS),
    );
    // **"ohne Antwort" allein hat schon eine Runde gekostet.** Gemeldet war
    // genau das - nach 839 ms, also ohne Zeitueberschreitung -, und woran es
    // lag, stand nirgends: nicht erreichbar, kein JSON, ein HTTP-Fehler? Die
    // Box sagt es, der Skill hat es weggeworfen. Jetzt steht es dabei.
    // **Gilt die Nummer fuer diese Freigabe?** Die Box antwortet mit dem
    // Ordner, den ihre Sitzung freigibt. Steht in der Playlist ein anderer,
    // ist die Nummer zwar am Leben, aber fuer diese Titel wertlos - und genau
    // so sah der gemeldete Fehler aus: `data.lua` sagt "gilt noch", und der
    // Echo bekommt die Datei trotzdem nicht. Bekannt ist der Ordner nur, wenn
    // ihn der Import mitgebracht hat; fehlt er, bleibt es beim alten Urteil.
    const fremd = gilt === true && fremderOrdner(wurzel, ordner);
    const wort = gilt === null ? `ohne Antwort (${kurz})` : gilt ? 'gilt noch' : 'ist tot';
    console.log(`musik-box FRITZ!NAS-Sitzung nachgefragt: ${wort}`
      + `${wurzel ? ` (Ordner "${wurzel}")` : ''}`
      + ` nach ${Date.now() - begonnen} ms, ${budgetText(rest())}`);
    if (fremd) {
      console.warn(`musik-box Sitzung gehoert zu "${wurzel}", die Playlist zu "${ordner}"`
        + ' – sie lebt, gibt diese Titel aber nicht heraus. Es wird eine eigene geholt.');
    }
    if (gilt === true && !fremd) {
      // Die Frist beginnt von vorn: Die Box hat die Sitzung gerade durch
      // diesen Abruf verlaengert, also ist die Nummer wieder so frisch wie
      // nach einer Anmeldung.
      await fritzSidMerken(redis, link, eigene, { bestand: tafel });
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

  // **Waehrend geliefert wird, wird nicht angemeldet.** Der Durchleiter setzt
  // diesen Schalter, solange ein Abruf Bytes an den Echo schreibt (siehe
  // lib/naston.js). Eine Anmeldung beendet alle Sitzungen der Box - sie
  // brauechte also den laufenden Titel auf, um dem naechsten eine Nummer zu
  // besorgen. Die gemerkte ist dann das bessere Wort: Sie ist nur aelter als
  // ihr Fenster, und die Box verlaengert eine Sitzung mit jedem Abruf, der
  // gerade laeuft. Geht sie doch nicht mehr, antwortet die Box mit ihrer
  // Anmeldeseite - und der Durchleiter setzt den Schalter fuer seinen zweiten
  // Anlauf nicht mehr, dann wird angemeldet.
  if (ohneAnmeldung && eigene) {
    console.log('musik-box FRITZ!NAS-Anmeldung ausgelassen, es laeuft gerade eine Lieferung'
      + ' – die gemerkte Nummer muss reichen');
    return { sid: eigene, verlaesslich: false, erneuert: false, ungeprueft: !gefragt, angemeldet: false };
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
    + `${ergebnis.ohneGegenprobe ? ' (ohne Gegenprobe)' : ''}`
    + `${ergebnis.wurzel ? ` (Ordner "${ergebnis.wurzel}")` : ''}`
    + ` nach ${Date.now() - begonnen} ms, ${budgetText(rest())}`);
  // Auch eine frisch geholte Nummer kann zum falschen Ordner gehoeren - dann
  // hat die Anmeldung eine andere Freigabe geoeffnet als die gemeinte, und
  // der Echo bekaeme wieder nichts. Gespielt wird trotzdem: Etwas Besseres
  // gibt es an dieser Stelle nicht, aber im Log steht, woran es lag.
  if (fremderOrdner(ergebnis.wurzel, ordner)) {
    console.warn(`musik-box die neue Nummer gehoert zu "${ergebnis.wurzel}", die Playlist zu "${ordner}"`);
  }
  if (!ergebnis.sid) {
    // Die gemerkte kommt noch mit, aber ohne Empfehlung: Sie ist aelter als
    // ihr Fenster, sonst waeren wir oben schon zurueck. Der Skill spielt
    // damit nicht los: Die Box war erreichbar genug, um gefragt zu werden,
    // und hat trotzdem keine gueltige Nummer hergegeben.
    return { sid: eigene, verlaesslich: false, erneuert: false, ungeprueft: false, angemeldet: false };
  }
  await fritzSidMerken(redis, link, ergebnis.sid, { nachAnmeldung: true, bestand: tafel });
  // **`angemeldet` ist nicht dasselbe wie `erneuert`.** Erneuert heisst "die
  // Nummer hat sich geaendert"; angemeldet heisst "`filelink.lua` ohne Sitzung
  // ist gelaufen, und die Box hat gerade alle Sitzungen beendet". Nur das
  // zweite ist der Zustand, vor dem der Abstand schuetzen soll - und er gilt
  // auch dann, wenn zufaellig dieselbe Nummer herauskam.
  return { sid: ergebnis.sid, verlaesslich: true, erneuert: ergebnis.sid !== eigene, ungeprueft: false, angemeldet: true };
}

/**
 * Gehoert diese Sitzung zu einer anderen Freigabe als die Playlist?
 *
 * Nur ein Nein aus zwei bekannten Werten zaehlt: Fehlt einer - eine Playlist
 * aus der Zeit vor `quelle.ordner`, eine Box, die kein `root` schickt -, ist
 * das keine Auskunft, und die Nummer bleibt so gut oder schlecht wie vorher.
 * Der Vergleich sieht ueber einen Schraegstrich am Ende hinweg, sonst ist er
 * genau: Die Box schreibt den Pfad, wie sie ihn fuehrt.
 *
 * Rein und exportiert, damit die Entscheidung ohne FRITZ!Box pruefbar ist.
 */
export function fremderOrdner(wurzel, ordner) {
  if (typeof wurzel !== 'string' || typeof ordner !== 'string') return false;
  const knapp = (pfad) => pfad.trim().replace(/\/+$/, '');
  if (!knapp(wurzel) || !knapp(ordner)) return false;
  return knapp(wurzel) !== knapp(ordner);
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
  return alsSidTafel(bestand);
}

/**
 * Was auch immer unter dem Schluessel liegt, als `{ [link]: {sid, zeit} }`.
 *
 * Der Speicher hat zwei fruehere Formen: eine Zuordnung je Freigabe (so wie
 * heute wieder) und den einen Datensatz `{link, sid, zeit}` dazwischen. Beide
 * werden gelesen - ein Deploy mitten in einer Wiedergabe soll nicht zur
 * Anmeldung fuehren, und der Umweg kostet hier drei Zeilen statt eines
 * Migrationsschritts.
 *
 * Rein und exportiert, damit die Umdeutung ohne Redis pruefbar ist.
 */
export function alsSidTafel(bestand) {
  if (!bestand || typeof bestand !== 'object') return {};
  // Die alte Einzelform: ein Datensatz mit `link` neben `sid`.
  if (typeof bestand.link === 'string' && typeof bestand.sid === 'string') {
    return { [bestand.link]: { sid: bestand.sid, zeit: Number(bestand.zeit) || 0 } };
  }
  const tafel = {};
  for (const [link, eintrag] of Object.entries(bestand)) {
    if (typeof eintrag?.sid === 'string' && eintrag.sid) {
      tafel[link] = { sid: eintrag.sid, zeit: Number(eintrag.zeit) || 0 };
    }
  }
  return tafel;
}

/**
 * Haelt die Sitzung fest, damit der naechste Schritt sie nicht neu holen muss.
 *
 * Zwei Aufrufer: die Auffrischung und der Import. Der Import hat gerade eine
 * gueltige Nummer besorgt, und wer importiert hat, drueckt als Naechstes
 * "Check URLs" oder startet die Playlist - ohne diese Zeile beginnt das mit
 * zwei weiteren Abrufen bei einer Box, die wir als langsam kennen, und beendet
 * dabei erneut alle Sitzungen.
 *
 * **`nachAnmeldung` sagt, was mit den anderen Freigaben geschieht.** Eine
 * Anmeldung beendet laut AVM alle Sitzungen der Box; deren Nummern bleiben
 * gemerkt, verlieren aber ihren Zeitstempel. Sie werden damit nicht mehr
 * blind verwendet - wohl aber gefragt, und eine Nachfrage ist billiger und
 * harmloser als die Anmeldung, die sonst an ihrer Stelle stuende.
 *
 * `bestand` ist die bereits gelesene Tafel, wo es eine gibt: Der Aufrufer im
 * heissen Pfad hat sie ohnehin in der Hand, und eine zweite Redis-Runde vor
 * der Antwort an Alexa ist kein Preis fuer Bequemlichkeit.
 */
export async function fritzSidMerken(redis, link, sid, { nachAnmeldung = false, bestand = null } = {}) {
  try {
    const tafel = bestand || await fritzSidGemerkt(redis);
    const andere = Object.entries(tafel)
      .filter(([anderer]) => anderer !== link)
      // **Die Tafel darf nicht unbegrenzt wachsen.** Jeder Import mit einem
      // neuen Freigabe-Link legt einen Eintrag an, und ein Zwischenspeicher,
      // den man jederzeit wegwerfen kann, ist kein Archiv. Die juengsten
      // bleiben - die aelteste Nummer ist ohnehin die mit der geringsten
      // Aussicht, noch zu gelten.
      .sort(([, a], [, b]) => (b.zeit || 0) - (a.zeit || 0))
      .slice(0, FRITZ_SID_PLAETZE - 1);
    const neu = {};
    for (const [anderer, eintrag] of andere) {
      neu[anderer] = nachAnmeldung ? { ...eintrag, zeit: 0 } : eintrag;
    }
    neu[link] = { sid, zeit: Date.now() };
    await redis.set(FRITZ_SID_KEY, neu);
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
 * Die Frist, die ein Abspieler-Ereignis dem gemerkten Stand mindestens
 * einraeumt.
 *
 * **Warum die hier ueber dem Antwortbudget stehen darf.** Ein
 * `PlaybackStarted`, `PlaybackStopped` oder `PlaybackFinished` hat nichts zu
 * beantworten: Die Antwort ist leer, und ob sie nach 40 oder nach 1500 ms
 * hinausgeht, hoert niemand. Auf einer kalten Function bleibt von Alexas
 * Fenster dagegen nur `BUDGET_BODEN_MS`, und genau dann kaeme der
 * Schreibvorgang gar nicht mehr zum Zug - also bekommt er dort eine eigene
 * Untergrenze statt des Restbudgets.
 *
 * **Fuer einen gesprochenen Stopp gilt sie nicht.** Dort haengt eine
 * Direktive an der Antwort, und die darf nicht warten, bis Alexa aufgibt.
 *
 * Lang genug fuer zwei Redis-Abrufe, kurz genug, dass eine haengende Datenbank
 * die Function nicht bis `maxDuration` wachhaelt.
 */
const EREIGNIS_FRIST_MS = 2000;

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
 * Welche Sprachbefehle eine Zeile im Verlauf hinterlassen.
 *
 * **Warum nicht alle.** Der Verlauf ist vierzig Eintraege lang und ein Zeuge
 * fuer die letzte Stoerung, kein Archiv (siehe `VERLAUF_KEY` in
 * lib/naston.js). Eine Handvoll missverstandener Saetze schoebe sonst genau
 * die Abspieler-Ereignisse aus dem Fenster, die die Stoerung erklaeren. Drin
 * ist, was Wiedergabe anfaengt, beendet oder fortsetzt - also alles, was den
 * gemerkten Stand beruehrt.
 */
const VERLAUF_INTENTS = new Set([
  ...WIEDERGABE_INTENTS,
  'AMAZON.StopIntent',
  'AMAZON.PauseIntent',
  'AMAZON.CancelIntent',
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
  /**
   * Der Zettel, auf dem dieser Request hinterlaesst, was er entschieden hat.
   *
   * **`stand` hiess frueher `nachspiel` und war eine Zusage auf spaeter.** Der
   * gemerkte Stand wurde hinter `res.json()` geschrieben, weil Alexa dort
   * nicht mehr wartet. Nur endet mit der Antwort auch die Vercel-Invocation:
   * Die Instanz friert ein, und der Rest laeuft erst, wenn sie das naechste
   * Mal drankommt.
   *
   * Im gemeldeten Fall stand das im Log: Die `finally`-Bloecke zweier
   * Requests von 18:45:34 liefen um 18:50:01, angehaengt an eine fremde
   * Invocation - 4 Minuten 27 Sekunden spaeter, mit einer Frist, die waehrend
   * des Einfrierens abgelaufen war. Beide Schreibvorgaenge scheiterten, ein
   * dritter lief nie, weil die Instanz vorher recycelt wurde. Von drei
   * gemerkten Sekunden kam keine in der Datenbank an.
   *
   * Jetzt schreibt jeder Zweig selbst, bevor er antwortet, und legt hier nur
   * noch ab, *was dabei herauskam* - fuer Log und Verlauf.
   *
   * `stelle`, `woher` und `gangart` beantworten die Frage, die im gemeldeten
   * Fall niemand beantworten konnte: welche Sekunde hinausging und aus welcher
   * Quelle.
   */
  const notiz = { stand: null, stelle: null, woher: null, gangart: null };
  /** Was vor dem Skill lag - Kaltstart inbegriffen. `null`: nicht zu ermitteln. */
  const vorlauf = alexaVorlaufMs(body, beginn);
  /** Wie viele Millisekunden bleiben, bis Alexa aufgibt. */
  const budget = antwortBudgetMs(body);
  const rest = () => budget - (Date.now() - beginn);
  /**
   * Die Frist fuer einen Schreibvorgang, an dem keine Antwort haengt.
   *
   * Mindestens `EREIGNIS_FRIST_MS`, auch wenn Alexas Fenster laengst knapp
   * ist: Ein Abspieler-Ereignis hat nichts zu liefern, eine verspaetete leere
   * Antwort darauf kostet niemanden etwas - eine verlorene Sekunde schon.
   */
  const ereignisFrist = () => Math.max(EREIGNIS_FRIST_MS, rest());
  const typ = body.request.type;

  // `null` heisst "nicht ladbar" und ist von einer leeren Liste zu
  // unterscheiden: Sonst hoert jemand mit fuenf Playlists "es ist noch keine
  // angelegt" und sucht den Fehler im Dashboard, wo keiner ist.
  const gelesen = await mitFrist(redis.get(REDIS_KEY), null, REDIS_KEY, rest());
  if (gelesen === null && typ !== 'LaunchRequest' && typ !== 'IntentRequest') return still(res);
  if (gelesen === null) {
    return sage(res, body, 'Ich komme gerade nicht an deine Playlists. Versuch es gleich noch einmal.');
  }

  const playlists = gelesen || [];
  const direktiven = dynamischeEntitaeten(SLOT_TYP, playlists.map(p => p.name));

  // **Was hinausging, wird mitgeschrieben.** Fuenf Runden lang war unsichtbar,
  // ob der Skill beim Titelwechsel keine Direktive geschickt hat oder ob
  // Alexa sie abgelehnt hat - beides sieht am Echo gleich aus: Stille. Der
  // Umweg ueber `res.json` ist die billigste Stelle, an der beides
  // feststeht, und er haelt niemanden auf.
  let hinaus = null;
  const echtesJson = typeof res.json === 'function' ? res.json.bind(res) : null;
  if (echtesJson) res.json = (koerper) => { hinaus = koerper; return echtesJson(koerper); };
  let geplatzt = null;

  // **Die `await` vor den async-Zweigen sind nicht ueberfluessig.** Ein
  // `return f()` gibt die Promise heraus, bevor sie sich entscheidet - der
  // catch unten saehe einen Fehler daraus nie, und Alexa bekaeme eine
  // abgebrochene Antwort statt eines Satzes.
  try {
    if (typ === 'LaunchRequest') {
      if (playlists.length === 0) {
        return sage(res, body, 'Es ist noch keine Playlist angelegt. Bitte lege im Dashboard eine an.');
      }
      // Ohne Namensliste: siehe frageWelche. Die Entitaeten gehen trotzdem mit.
      return frageWelche(res, body, 'Welche Playlist soll ich spielen?', playlists, direktiven, false);
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
          return sage(res, body, 'Dieses Gerät kann meine Musik leider nicht abspielen. '
            + 'Versuch es auf einem Echo.');
        }
      }

      switch (intent.name) {
        case 'PlayPlaylistIntent':
        case 'SuchePlaylistIntent':
          return await handlePlay(intent, res, body, playlists, direktiven, redis, rest, notiz);
        case 'ListPlaylistsIntent':
          return handleList(res, body, playlists, direktiven);
        case 'AMAZON.PauseIntent':
        case 'AMAZON.StopIntent':
        case 'AMAZON.CancelIntent':
          // Zwei Reparaturen treffen sich hier. Die Stelle wird gemerkt
          // (`haltUndMerken`), und die Sitzung wird nur geschlossen, wenn es
          // eine gibt: Hier stand `true` verdrahtet, und genau daran ist der
          // Befehl gescheitert - diese drei sagt man, waehrend Musik laeuft,
          // also ohne Dialog. Siehe `hatSitzung`.
          return await haltUndMerken(body, res, playlists, redis, ausSprache(body), notiz, rest);
        case 'AMAZON.ResumeIntent':
          return await weiter(body, res, playlists, direktiven, false, redis, rest, notiz);
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
            body,
            'Sag zum Beispiel: spiele Kinderlieder. Oder: welche Playlists gibt es. '
            + 'Waehrend der Wiedergabe gehen naechster Titel, voriger Titel, Pause und weiter.',
            playlists,
            direktiven,
          );
        case 'AMAZON.NavigateHomeIntent':
          return sage(res, body, 'Bis bald.');
        case 'AMAZON.FallbackIntent':
        default:
          return frageWelche(res, body, 'Das habe ich leider nicht verstanden. Welche Playlist soll ich spielen?', playlists, direktiven);
      }
    }

    if (typ === 'AudioPlayer.PlaybackNearlyFinished') return naechsterTitel(body, res, playlists);
    if (typ === 'AudioPlayer.PlaybackFinished') return await titelZuEnde(body, res, playlists, redis, notiz, ereignisFrist);
    if (typ === 'AudioPlayer.PlaybackFailed') return await nachFehler(body, res, playlists, rest);

    // Die beiden Ereignisse, die den Stand innerhalb der Playlist fuehren
    // (das dritte, PlaybackFinished, vermerkt oben nur den Schluss).
    // PlaybackStopped bringt den Offset mit und ist der genaue Punkt;
    // PlaybackStarted sichert wenigstens den Titelanfang, falls danach nichts
    // mehr kommt (Stromausfall, Absturz).
    if (typ === 'AudioPlayer.PlaybackStarted' || typ === 'AudioPlayer.PlaybackStopped') {
      const lage = laufendes(body, playlists);
      notiz.stelle = body.request?.offsetInMilliseconds ?? null;
      notiz.gangart = lage ? fortsetzArt(lage.playlist) : null;
      // Vor der Antwort, nicht dahinter - siehe `notiz` oben. Die Antwort ist
      // leer, sie kann warten; die Sekunde kann es nicht.
      notiz.stand = await standMerken(body, playlists, redis, ereignisFrist, {
        quelle: typ === 'AudioPlayer.PlaybackStarted' ? 'anfang' : 'stopp',
      });
      return still(res);
    }

    if (typ === 'PlaybackController.NextCommandIssued') return springe(body, res, playlists, +1);
    if (typ === 'PlaybackController.PreviousCommandIssued') return springe(body, res, playlists, -1);
    if (typ === 'PlaybackController.PlayCommandIssued') return await weiter(body, res, playlists, [], true, redis, rest, notiz);
    // Der Knopf in der App und am Echo Show: derselbe Befehl, dieselbe Stelle.
    if (typ === 'PlaybackController.PauseCommandIssued') return await haltUndMerken(body, res, playlists, redis, ausSprache(body), notiz, rest);

    if (typ === 'System.ExceptionEncountered') {
      console.error('Alexa meldet:', JSON.stringify(body.request.error), JSON.stringify(body.request.cause));
    }
    // SessionEndedRequest und alles andere: leere Antwort, Sprache ist hier
    // nicht erlaubt
    return still(res);
  } catch (err) {
    console.error('Musik-Skill-Fehler:', err);
    // Sonst wird daraus stumm eine leere Antwort - und am Echo ist das von
    // "es war nichts zu bestellen" nicht zu unterscheiden.
    geplatzt = err?.message || String(err);
    if (typ === 'LaunchRequest' || typ === 'IntentRequest') {
      return sage(res, body, 'Es ist leider ein Fehler aufgetreten.');
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
    // **Die Sitzung gehoert in diese Zeile.** Ob eine Anfrage eine hatte,
    // entscheidet, welche Felder die Antwort tragen durfte - und war beim
    // gemeldeten "keine gueltige Antwort" von aussen nirgends zu sehen.
    console.log(`musik-box ${typ}${typ === 'IntentRequest' ? ` ${body.request.intent?.name || '?'}` : ''}`
      + ` ${hatSitzung(body) ? 'mit' : 'ohne'} Sitzung in ${gebraucht} ms`
      + (vorlauf === null ? '' : `, Alexa wartet seit ${gebraucht + vorlauf} ms (Vorlauf ${vorlauf} ms)`));

    // **Der gemerkte Stand steht hier nur noch im Protokoll.** Geschrieben
    // hat ihn der Zweig selbst, vor der Antwort - siehe `notiz` oben. Was
    // hier herauskommt, ist sein Ergebnis, und seit `standSchreiben` einen
    // Rueckgabewert hat, ist es auch ein ehrliches: `NICHT gespeichert` statt
    // eines `gemerkt`, hinter dem nichts steht.
    const gemerkt = notiz.stand;
    if (gemerkt) console.log(`musik-box Stand: ${gemerkt}`);

    // **Der Verlauf bleibt hinter der Antwort, und das ist eine bewusste
    // Abwaegung, keine Zusage.** Er traegt, was hinausging (`antwortKurz`),
    // und das steht erst fest, wenn die Antwort heraus ist. Der Preis ist
    // derselbe, an dem der Stand gescheitert war: Friert die Instanz ein, ist
    // dieser Eintrag erst da, wenn sie das naechste Mal drankommt - im
    // gemeldeten Fall lagen zwischen einem Stopp und seiner Zeile im
    // Dashboard 4 Minuten 27 Sekunden, und das Log sah in der Zwischenzeit so
    // aus, als waere nichts passiert. Fuer eine Auskunft ist das hinnehmbar,
    // fuer die Sekunde selbst war es das nicht.

    const befehl = typ === 'IntentRequest' ? body.request.intent?.name : null;
    const wortLinie = (befehl && VERLAUF_INTENTS.has(befehl)) || typ.startsWith('PlaybackController.');
    const echoLinie = typ.startsWith('AudioPlayer.') || typ === 'System.ExceptionEncountered';
    if (echoLinie || wortLinie) {
      await verlaufSchreiben(redis, {
        was: echoLinie ? 'echo' : 'wort',
        ereignis: echoLinie
          ? (typ.startsWith('AudioPlayer.') ? typ.slice('AudioPlayer.'.length) : 'ExceptionEncountered')
          : (befehl ? befehl.replace(/^AMAZON\./, '') : typ.slice('PlaybackController.'.length)),
        // **Die Zahl, auf die es ankommt, und bisher stand die falsche da.**
        // Bei einem Abspieler-Ereignis ist `request.offsetInMilliseconds` die
        // genaue Stelle - der Kontext traegt dort gern eine Null. Bei einem
        // Befehl ist es die Stelle, die der Skill hinausgeschickt oder
        // gemerkt hat: genau die, die im gemeldeten Fall niemand sehen konnte.
        offset: notiz.stelle ?? body.request?.offsetInMilliseconds ?? body.context?.AudioPlayer?.offsetInMilliseconds ?? null,
        woher: notiz.woher,
        gangart: notiz.gangart,
        // Protokolliert, nie verzweigt: Eine Verzweigung darauf waere eine
        // Wette auf eine Aufzaehlung, die Amazon je Geraetegeneration anders
        // fuellt. Zum Erklaeren ist sie Gold, zum Entscheiden zu wackelig.
        aktivitaet: body.context?.AudioPlayer?.playerActivity || null,
        stand: gemerkt,
        titel: titelZumToken(laufendes(body, playlists)) || null,
        fehler: body.request?.error?.type || body.request?.error?.message || null,
        ursache: body.request?.cause ? JSON.stringify(body.request.cause).slice(0, 200) : null,
        antwort: geplatzt ? `Fehler: ${geplatzt}` : antwortKurz(hinaus),
      });
    }
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
async function handlePlay(intent, res, body, playlists, direktiven, redis, rest = () => Infinity, notiz = {}) {
  if (playlists.length === 0) {
    return sage(res, body, 'Es ist noch keine Playlist angelegt. Bitte lege im Dashboard eine an.');
  }
  const { playlist, gesagt } = findePlaylist(playlists, intent.slots?.playlist || intent.slots?.suche);
  if (!gesagt) return frageWelche(res, body, 'Welche Playlist soll ich spielen?', playlists, direktiven);
  if (!playlist) {
    // **Der haeufigste Fehlschlag stand bisher in keinem Log.** Ohne ihn ist
    // von aussen nicht zu unterscheiden, ob die Box stumm blieb oder ob der
    // Name gar nicht ankam - und genau das hat eine Fehlersuche gekostet.
    console.warn(`musik-box kennt "${gesagt}" nicht (normalisiert: ${normalisiere(gesagt)});`
      + ` bekannt: ${playlists.map(p => `${p.name}=${normalisiere(p.name)}`).join(', ')}`);
    return frageWelche(res, body, `Ich habe keine Playlist namens ${gesagt} gefunden.`, playlists, direktiven);
  }
  if (playlist.titel.length === 0) {
    return sage(res, body, `Die Playlist ${playlist.name} hat noch keine Titel.`, true, direktiven);
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
  // bekam und welcher Titel dahinter steht.
  // **Der Offset gehoert dazu.** Ein Start bei 0 und ein Wiedereinstieg bei
  // 3:12 sind fuer den Echo zwei verschiedene Abrufe: Der zweite verlangt vom
  // Server einen Bereich aus der Mitte der Datei. Wenn eine Playlist "weiter"
  // nicht spielt und von vorn schon, steht der Unterschied in dieser Zahl.
  // **Die Gangart gehoert dazu.** "Faengt von vorn an" hat zwei ganz
  // verschiedene Ursachen - die Einstellung *Album*, die das so zusagt, und
  // eine verlorene Stelle -, und ohne diese drei Buchstaben sind sie von
  // aussen nicht zu unterscheiden.
  notiz.stelle = offset;
  notiz.gangart = fortsetzArt(playlist);
  notiz.woher = offset > 0 ? 'stand' : 'anfang';
  console.log(`musik-box spielt ${playlist.name} (gehoert: "${gesagt}")`
    + ` ab ${position + 1}/${playlist.titel.length}`
    + ` bei ${offset} ms (${notiz.gangart}, gemerkt @${stand?.offset ?? '-'} ms):`
    + ` ${spiel.audioItem.metadata.title}`);

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
  return sage(res, body, satz, true, start);
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
    return sage(res, body, an
      ? 'Es laeuft gerade nichts. Die Zufallswiedergabe stellst du je Playlist im Dashboard ein.'
      : 'Es laeuft gerade nichts.');
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
    return sage(res, body, 'Ob sich eine Playlist wiederholt, stellst du im Dashboard ein.');
  }
  const zustand = wiederholtSich(lage.playlist) ? 'wiederholt sich' : 'wiederholt sich nicht';
  return sage(res, body, `${lage.playlist.name} ${zustand}. Ändern kannst du das im Dashboard.`);
}

function handleList(res, body, playlists, direktiven) {
  if (playlists.length === 0) {
    return sage(res, body, 'Es ist noch keine Playlist angelegt. Bitte lege im Dashboard eine an.');
  }
  const liste = aufzaehlung(playlists.map(p => {
    const n = p.titel.length;
    return `${p.name} mit ${n === 1 ? 'einem Titel' : `${n} Titeln`}`;
  }));
  return sage(res, body, `Ich kenne ${liste}. Welche soll ich spielen?`, false, direktiven);
}

/**
 * Unter so viel Budget sieht "weiter" nicht mehr in der Datenbank nach.
 *
 * Ein Wiedereinstieg an der Stelle, die das Geraet kennt, schlaegt einen
 * genaueren, der zu spaet kommt: Wer die Antwort verpasst, spielt gar nichts.
 */
const STAND_MINDESTBUDGET_MS = 600;

/**
 * Weiter an der Stelle, an der pausiert wurde.
 *
 * **Zwei Quellen, und die weitere gewinnt - nicht die erste.** Hier stand
 * "`context.AudioPlayer` ist genauer als alles Gemerkte, weil er den laufenden
 * Titel meint", und das war der gemeldete Fehler. Der Echo traegt den Token
 * seines letzten Stroms oft noch, wenn er die Stelle darin laengst vergessen
 * hat: nach einem Neustart, nach dem Radio dazwischen, am naechsten Tag.
 * `offsetInMilliseconds` fehlt dann oder ist null, `|| 0` machte daraus
 * stillschweigend "Anfang" - und "Alexa, weiter" fing den erinnerten Titel von
 * vorn an, obwohl die Sekunde in der Datenbank stand. Genau das Muster im
 * Bericht: Titel erinnert, Sekunde verloren.
 *
 * Verglichen wird nur innerhalb **desselben** Titels (`selberTitel`, Seed
 * eingeschlossen): Zeigt der Stand woanders hin, gilt allein das Geraet, sonst
 * finge Titel acht bei der Stelle von Titel drei an.
 *
 * **Die Gangart gilt nur fuer die gemerkte Stelle.** Was das Geraet noch weiss,
 * ist eine Pause, und eine Pause ist in beiden Gangarten sekundengenau - das
 * ist im README zugesagt. Kommt die Stelle aus der Datenbank, ist es "spaeter
 * wieder aufnehmen", und ein Album faengt seinen Titel dann von vorn an, wie
 * `standAnwenden` es beim "spiele ..." auch tut.
 *
 * **`playerActivity` entscheidet hier ausdruecklich nichts.** Der Wert geht
 * ins Log und in den Verlauf, weil er den naechsten Bericht beantwortet. Eine
 * Verzweigung darauf waere eine Wette auf eine Aufzaehlung, die Amazon je
 * Geraetegeneration anders fuellt - und sie ist nicht noetig: Die groessere der
 * beiden Stellen ist ohne sie schon die richtige.
 *
 * Beide Wege gehen den Vorlauf zurueck: Eine Pause dauert selten zwei Sekunden,
 * und nach einer laengeren fehlt sonst der Satzanfang.
 */
async function weiter(body, res, playlists, direktiven = [], stumm = false, redis = null, rest = () => Infinity, notiz = {}) {
  const lage = laufendes(body, playlists);
  if (lage) {
    // Eine geklammerte Position ist ein anderer Titel als der, dessen Stelle
    // das Geraet meldet: Die Playlist wurde seither gekuerzt, und der Offset
    // von Titel neun hat auf Titel eins nichts zu suchen.
    const passt = lage.token.position < lage.playlist.titel.length;
    const position = passt ? lage.token.position : 0;
    const vomGeraet = passt ? lage.offset : 0;

    const gangart = fortsetzArt(lage.playlist);
    const stand = redis && gangart !== 'aus' && passt && rest() >= STAND_MINDESTBUDGET_MS
      ? await standLesen(redis, lage.playlist.name, rest())
      : null;
    const brauchbar = stand && !stand.fertig && selberTitel(stand, lage.token);
    const vomStand = brauchbar ? Number(stand.offset) || 0 : 0;

    const ausDerBank = vomStand > vomGeraet;
    const offset = ausDerBank ? einstiegNachGangart(lage.playlist, vomStand) : einstieg(vomGeraet);
    const start = playDirektive(lage.playlist, position, lage.token.runde, { seed: lage.token.seed, offset });

    notiz.stelle = offset;
    notiz.gangart = gangart;
    notiz.woher = ausDerBank ? 'stand' : (vomGeraet > 0 ? 'geraet' : 'anfang');
    // **Diese Zeile gab es nicht, und sie hat die Fehlersuche gekostet.** Ob
    // "weiter" die Stelle des Geraets oder die gemerkte genommen hat, war von
    // aussen nicht zu sehen - beides sieht am Echo gleich aus.
    console.log(`musik-box weiter ${lage.playlist.name} ab ${position + 1}/${lage.playlist.titel.length}`
      + ` bei ${offset} ms (${notiz.woher}, ${gangart});`
      + ` Geraet ${body.context?.AudioPlayer?.playerActivity || 'ohne Auskunft'} @${vomGeraet} ms,`
      + ` Stand @${vomStand} ms: ${start.audioItem.metadata.title}`);
    return still(res, [...vorspann(), start], ausSprache(body));
  }
  const juengste = redis ? await juengsterStand(redis, playlists, rest()) : null;
  if (juengste) {
    const ab = standAnwenden(juengste.playlist, juengste.stand);
    const start = playDirektive(juengste.playlist, ab.position, ab.runde, { seed: ab.seed, offset: ab.offset });
    notiz.stelle = ab.offset;
    notiz.gangart = fortsetzArt(juengste.playlist);
    notiz.woher = 'stand';
    console.log(`musik-box weiter ${juengste.playlist.name} ab ${ab.position + 1}/${juengste.playlist.titel.length}`
      + ` bei ${ab.offset} ms (stand, ${notiz.gangart}); das Geraet wusste nichts mehr:`
      + ` ${start.audioItem.metadata.title}`);
    return still(res, [...vorspann(), start], ausSprache(body));
  }
  // Ohne Sitzung gibt es niemanden zu fragen: Die Rueckfrage braucht ein
  // offenes Mikrofon, und das gibt es nur im Dialog. Ein stilles "nichts zu
  // tun" ist dort die einzige gueltige Antwort.
  if (stumm || !hatSitzung(body)) return still(res, [], ausSprache(body));
  return frageWelche(res, body, 'Es laeuft gerade nichts. Welche Playlist soll ich spielen?', playlists, direktiven);
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
  const start = playDirektive(lage.playlist, 0, lage.token.runde + 1, { seed: lage.token.seed });
  return still(res, [...vorspann(), start], ausSprache(body));
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
async function titelZuEnde(body, res, playlists, redis, notiz = {}, frist = () => Infinity) {
  const lage = laufendes(body, playlists);
  if (!lage) return still(res);
  const ziel = schritt(lage.playlist, lage.token, +1);
  const gehtWeiter = !ziel.umbruch || wiederholtSich(lage.playlist);

  // **Hier wird nichts mehr bestellt.** Der naechste Titel haengt laengst in
  // der Warteschlange - `PlaybackNearlyFinished` hat ihn angehaengt, und das
  // ist der Moment, den Alexa dafuer vorsieht.
  //
  // **#121 hat es hierher verlegt, und das war der Fehler**, an dem diese
  // Playlist fuenf Runden lang haengengeblieben ist: Ein `Play` auf
  // `PlaybackFinished` hat in keiner einzigen Messung einen naechsten Titel
  // hervorgebracht. Die Datei lief sauber zu Ende (`7594648 von 7594648 B`),
  // und danach kam nichts. Was die Fehlertabelle im README seit Monaten
  // sagt, gilt eben doch: "First track plays, then silence -
  // PlaybackNearlyFinished got no ENQUEUE".
  if (!gehtWeiter && setztFort(lage.playlist)) {
    // Vor der Antwort: `PlaybackFinished` hat nichts zu beantworten, und
    // hinter der Antwort friert die Instanz ein, bevor der Vermerk steht.
    // Die Frist ist deshalb `ereignisFrist`, nicht das Restbudget.
    const ok = await standSchreiben(
      redis,
      lage.playlist.name,
      { position: 0, runde: 0, seed: 0, offset: 0, fertig: true },
      frist(),
    );
    notiz.stand = ok ? 'Durchlauf vermerkt' : 'Durchlauf NICHT gespeichert';
  }
  return still(res);
}

/**
 * Was der Skill geantwortet hat, in einer Zeile.
 *
 * `Play ENQUEUE -> 5. Die Buehne` oder `keine Direktive`. Genau diese
 * Unterscheidung fehlte, als die Wiedergabe nach jedem Titel stehenblieb:
 * Am Echo sieht beides gleich aus, und ohne sie bleibt nur Raten.
 */
function antwortKurz(koerper) {
  const liste = koerper?.response?.directives;
  if (!Array.isArray(liste) || liste.length === 0) return 'keine Direktive';
  return liste.map((d) => {
    if (d?.type !== 'AudioPlayer.Play') return String(d?.type || '?');
    const titel = d.audioItem?.metadata?.title;
    return `Play ${d.playBehavior}${titel ? ` -> ${titel}` : ''}`;
  }).join(', ');
}

/**
 * Der gescheiterte Titel fuer das Log: Nummer und Name.
 *
 * **Hier stand einmal die Adresse dazu**, gekuerzt um die Sitzungsnummer der
 * FRITZ!Box. Seit die Playlist auf den eigenen Ton-Endpunkt zeigt
 * (`/api/skill?ton=…`, siehe lib/naston.js), ist sie fuer jeden Titel
 * dieselbe Zeichenkette und sagt nichts mehr - der Titel steckt im Token.
 *
 * Getrennt, weil `nachFehler` sonst mehr Zeilen fuer die Meldung braeuchte als
 * fuer die Entscheidung. Gibt nichts zurueck, wenn die Playlist inzwischen
 * gekuerzt wurde - dann gibt es den Titel nicht mehr, ueber den zu berichten
 * waere.
 */
function titelZumToken(lage) {
  if (!lage || lage.token.position >= lage.playlist.titel.length) return '';
  const { titel, nummer } = titelAn(lage.playlist, lage.token.position, lage.token.seed);
  return `${nummer + 1}. ${titel.name || '(ohne Namen)'}`;
}

/**
 * Ab wann ein Titel als angelaufen gilt.
 *
 * Der gemeldete Fehlschlag traegt `Offset: 0` oder `Offset: 1` - der Titel war
 * nie zu hoeren. Eine Sekunde ist grosszuegig genug, dass ein Abbruch kurz
 * nach dem Anfang noch als "lief" zaehlt, und knapp genug, dass die Straehne
 * unten nicht von einem einzigen Knacken zurueckgesetzt wird.
 */
const ANGELAUFEN_MS = 1000;

/**
 * Wie viele Titel hintereinander nicht anlaufen duerfen, bevor Schluss ist.
 *
 * **Warum es diese Grenze gibt.** Gemeldet war ein Log ueber fuenfundsechzig
 * Sekunden: neun Titel, jeder zweimal versucht, jeder mit
 * `MEDIA_ERROR_INTERNAL_SERVER_ERROR` - und dazwischen siebzehnmal die Probe
 * des Skills mit "HTTP 206, audio/mpeg". Die ganze Playlist war durch, ohne
 * dass ein einziger Ton kam.
 *
 * Wenn drei Titel nacheinander nicht anlaufen, liegt es nicht an den Titeln.
 * Dann ist der Weg zur Box zu, und die restlichen sechs Anlaeufe sind
 * siebzehn weitere Abrufe an eine Box, die ohnehin nicht liefert - und
 * hinterher steht der gemerkte Stand am Ende der Liste statt dort, wo
 * jemand weiterhoeren wollte.
 *
 * **Drei, nicht zwei.** Zwei kaputte Dateien nebeneinander gibt es; drei
 * Titel, die nacheinander nicht einmal anfangen, sind kein Zufall mehr.
 */
const PECH_GRENZE = 3;

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
 *
 * **Das Ueberspringen hat seit einem Log vom September eine Grenze.** Dort
 * scheiterten neun von neun Titeln, jeder zweimal, und die Wiedergabe war
 * nach fuenfundsechzig Sekunden am Ende der Liste angekommen, ohne dass ein
 * Ton kam. Wiederholen und Ueberspringen sind fuer den einzelnen Stolperer
 * gebaut; laeuft **gar nichts** mehr an, machen sie aus einem stummen Titel
 * eine stumme Playlist und aus einem Abruf siebzehn. Die Straehne steht
 * neben dem Versuch im Token (`pech`) und zaehlt die Titel, die
 * hintereinander nicht angelaufen sind - siehe `PECH_GRENZE`.
 */
async function nachFehler(body, res, playlists, rest = () => Infinity) {
  const fehler = body.request.error || {};
  const lage = laufendes(body, playlists);
  const offsetMs = body.context?.AudioPlayer?.offsetInMilliseconds ?? 0;
  // **Welcher Titel es war, steht nicht im Token.** Mit Mischung ist Stelle 23
  // nicht Titel 24 - ohne die Nummer laesst sich die Zeile im Dashboard nicht
  // nachschlagen. Daran hat eine Fehlersuche schon mehrere Runden gehangen.
  const wer = titelZumToken(lage);
  console.warn('Alexa konnte nicht abspielen:', fehler.type, fehler.message,
    'Token:', body.request.token,
    'Offset:', offsetMs,
    wer ? `Titel: ${wer}` : '',
    lage?.token.versuch === 0 ? '- zweiter Versuch' : '- weiter mit dem naechsten Titel');
  if (!lage) return still(res);

  // **Ein Titel, der wirklich lief, faengt die Zaehlung von vorn an.** Die
  // Straehne unten meint "nichts laeuft mehr an"; ein Stueck, das eine Sekunde
  // gespielt hat, gehoert nicht dazu - dort ist die Kette Box, Leitung, Echo
  // ja gerade noch gegangen.
  const straehneBisher = offsetMs >= ANGELAUFEN_MS ? 0 : lage.token.pech;

  // Beim ersten Titel einer Straehne einmal nachsehen, welche Wege es zu
  // dieser Box ueberhaupt gibt - siehe `wegZurBox`.
  if (straehneBisher === 0 && lage.token.versuch === 0) await wegZurBoxMelden(lage.playlist, rest);

  // Eine inzwischen gekuerzte Playlist hat die Stelle vielleicht nicht mehr;
  // dann gibt es nichts zu wiederholen, und `schritt` unten faengt das ab.
  const naechste = lage.token.versuch === 0 && lage.token.position < lage.playlist.titel.length
    ? playDirektive(lage.playlist, lage.token.position, lage.token.runde, {
      seed: lage.token.seed, offset: einstieg(lage.offset), versuch: 1, pech: straehneBisher,
    })
    : null;
  if (naechste) {
    return still(res, [naechste]);
  }

  // Der Titel ist verloren - er zaehlt jetzt zur Straehne.
  const straehne = straehneBisher + 1;
  if (straehne >= PECH_GRENZE) {
    console.warn(`musik-box aufgegeben: ${straehne} Titel nacheinander sind nicht angelaufen`
      + ' – der naechste wuerde es auch nicht, und die Box bekommt keine weiteren Abrufe.'
      + ' Der Stand bleibt hier stehen, "weiter" setzt spaeter an dieser Stelle an.');
    return still(res, [STOP]);
  }
  const ziel = schritt(lage.playlist, lage.token, +1);
  if (ziel.umbruch) return still(res, [STOP]);
  const weiterMit = playDirektive(lage.playlist, ziel.position, ziel.runde, { seed: ziel.seed, pech: straehne });
  return still(res, [weiterMit]);
}

/** Unter so viel Budget wird nicht mehr nach Adressen gefragt. */
const WEG_MINDESTBUDGET_MS = 1500;

/**
 * Welche Wege es zu dieser Box gibt - eine Zeile, einmal je Pechstraehne.
 *
 * Die Auskunft kostet einen Namensabruf und steht nur im Fehlerfall; sie ist
 * der Unterschied zwischen "der Echo kam nicht an die Box" und "der Echo kam
 * ueber einen Weg nicht an die Box, den der Skill nie benutzt". Siehe
 * `wegZurBox` in lib/netz.js.
 */
async function wegZurBoxMelden(playlist, rest = () => Infinity) {
  if (playlist?.quelle?.typ !== 'fritz' || !playlist.quelle.link) return;
  // Die Auskunft ist nie so viel wert wie der naechste Titel: Reicht das
  // Budget nicht bequem, unterbleibt sie.
  if (rest() < WEG_MINDESTBUDGET_MS) return;
  try {
    const text = await wegZurBox(new URL(playlist.quelle.link).hostname);
    if (text) console.warn(`musik-box Weg zur Box: ${text}`);
  } catch { /* eine Auskunft, kein Auftrag */ }
}

