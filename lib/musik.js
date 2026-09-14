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
import { lookup } from 'dns/promises'
import { speak, resolvedSlotValue, aufzaehlung, dynamischeEntitaeten } from './alexa.js'

export const REDIS_KEY = 'musik_playlists';
export const SLOT_TYP = 'PLAYLIST_NAME';

const MAX_NAME = 64;
const MAX_TITEL = 200;
const MAX_URL = 2048;
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
 * @returns {{ playlist: {name: string, titel: {url: string, name: string}[], wiederholen: boolean, ansage: boolean} } | { fehler: string }}
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

  return {
    playlist: {
      name,
      titel,
      wiederholen: uebernommen(body, bisher, 'wiederholen'),
      ansage: uebernommen(body, bisher, 'ansage'),
    },
  };
}

/**
 * Steht dieser Schalter der Playlist auf "an"?
 *
 * **Ein fehlendes Feld heisst "ja".** Die Playlists, die vor einem Schalter
 * angelegt wurden, tragen ihn nicht - und sie liefen endlos und mit Ansage,
 * genau das muessen sie weiter tun, ohne dass jemand sie anfasst. `null` (gar
 * keine Playlist) ergibt ebenfalls "ja", denn das ist der Fall "neu angelegt".
 *
 * Die Vorgabe steht deshalb an genau einer Stelle: hier. Jeder weitere
 * Schalter erbt sie, ohne dass jemand sie noch einmal formulieren muss.
 */
function schalter(playlist, feld) {
  return playlist?.[feld] !== false;
}

/** Wiederholt sich diese Playlist nach dem letzten Titel? */
export function wiederholtSich(playlist) {
  return schalter(playlist, 'wiederholen');
}

/** Sagt Alexa vor dem ersten Titel an, was sie spielt? */
export function sagtAn(playlist) {
  return schalter(playlist, 'ansage');
}

/** Der Wert eines Schalters aus dem Body, sonst der gespeicherte, sonst an. */
function uebernommen(body, bisher, feld) {
  return body && feld in body ? !!body[feld] : schalter(bisher, feld);
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

/** Token eines Streams: `<playlist>|<titel>|<runde>`. */
export function tokenBauen(name, index, runde) {
  return [name, index, runde].join(TRENNER);
}

/** Der Token zurueck in seine Teile - oder null, wenn er nicht von hier stammt. */
export function tokenLesen(token) {
  if (typeof token !== 'string') return null;
  const teile = token.split(TRENNER);
  if (teile.length !== 3) return null;
  const [name, i, r] = teile;
  const index = Number(i);
  const runde = Number(r);
  if (!name || !Number.isInteger(index) || index < 0 || !Number.isInteger(runde) || runde < 0) return null;
  return { name, index, runde };
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
  const von = token.index < n ? token.index : n - 1;
  const index = (((von + richtung) % n) + n) % n;
  const umbruch = richtung > 0 ? index <= von : index >= von;
  return { index, runde: token.runde + (umbruch ? 1 : 0), umbruch };
}

/** Die Play-Direktive fuer einen Titel der Playlist. */
export function playDirektive(playlist, index, runde, { verhalten = 'REPLACE_ALL', offset = 0, vorherigerToken } = {}) {
  const t = playlist.titel[index];
  const stream = {
    url: t.url,
    token: tokenBauen(playlist.name, index, runde),
    offsetInMilliseconds: Math.max(0, Number(offset) || 0),
  };
  if (verhalten === 'ENQUEUE' && vorherigerToken) stream.expectedPreviousToken = vorherigerToken;
  return {
    type: 'AudioPlayer.Play',
    playBehavior: verhalten,
    audioItem: {
      stream,
      metadata: {
        title: t.name || `Titel ${index + 1}`,
        subtitle: `${playlist.name} · ${index + 1} von ${playlist.titel.length}`,
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
 * Ist eine IP-Adresse privat, lokal oder sonst keine Adresse im Internet?
 *
 * Der Pruef-Abruf laeuft auf dem Server und mit dem Admin-Passwort - er darf
 * trotzdem nicht als Sonde ins Vercel-Netz oder auf 127.0.0.1 taugen.
 * Rein und exportiert, damit die Grenzen ohne Netz pruefbar sind.
 */
export function istPrivateAdresse(ip) {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return istPrivateAdresse(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function zielErlaubt(url) {
  if (url.protocol !== 'https:') return `kein https (${url.protocol})`;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local')) return 'lokaler Host';
  if (istPrivateAdresse(host)) return 'private Adresse';
  try {
    const { address } = await lookup(host);
    if (istPrivateAdresse(address)) return 'zeigt auf eine private Adresse';
  } catch {
    return 'Hostname nicht aufloesbar';
  }
  return null;
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
// Der Skill: /api/skill mit applicationId == MUSIK_SKILL_ID
// ---------------------------------------------------------------------------

const STOP = { type: 'AudioPlayer.Stop' };

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

export async function handleSkill(body, res, redis) {
  let playlists = [];
  try {
    playlists = await redis.get(REDIS_KEY) || [];
  } catch (err) {
    // Kein Abbruch: Ohne Liste kann der Skill immer noch sagen, dass er keine
    // Playlist kennt. Ein 500 waere hier "Es gab ein Problem mit dem Skill".
    console.error(`${REDIS_KEY} nicht lesbar:`, err);
  }
  const direktiven = dynamischeEntitaeten(SLOT_TYP, playlists.map(p => p.name));
  const typ = body.request.type;

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
          return handlePlay(intent, res, playlists, direktiven);
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
          return vonVorn(body, res, playlists);
        case 'AMAZON.LoopOnIntent':
        case 'AMAZON.LoopOffIntent':
        case 'AMAZON.RepeatIntent':
          return loopAuskunft(body, res, playlists);
        case 'AMAZON.ShuffleOnIntent':
        case 'AMAZON.ShuffleOffIntent':
          return speak(res, 'Zufallswiedergabe kann ich noch nicht. Ich spiele die Titel in der Reihenfolge der Playlist.', true);
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
    if (typ === 'AudioPlayer.PlaybackFailed') return nachFehler(body, res, playlists);

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
function handlePlay(intent, res, playlists, direktiven) {
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
  const start = [playDirektive(playlist, 0, 0)];

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
  return speak(res, `Ich spiele ${playlist.name}.`, true, start);
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
  const index = lage.token.index < lage.playlist.titel.length ? lage.token.index : 0;
  return still(res, [playDirektive(lage.playlist, index, lage.token.runde, { offset: lage.offset })]);
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
    return still(res, [playDirektive(lage.playlist, 0, lage.token.runde)]);
  }
  return still(res, [playDirektive(lage.playlist, ziel.index, ziel.runde)]);
}

function vonVorn(body, res, playlists) {
  const lage = laufendes(body, playlists);
  if (!lage) return still(res);
  return still(res, [playDirektive(lage.playlist, 0, lage.token.runde + 1)]);
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
function naechsterTitel(body, res, playlists) {
  const lage = laufendes(body, playlists);
  if (!lage) return still(res);
  const ziel = schritt(lage.playlist, lage.token, +1);
  if (ziel.umbruch && !wiederholtSich(lage.playlist)) return still(res);
  const bisher = body.request.token;
  return still(res, [playDirektive(lage.playlist, ziel.index, ziel.runde, { verhalten: 'ENQUEUE', vorherigerToken: bisher })]);
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
  return still(res, [playDirektive(lage.playlist, ziel.index, ziel.runde)]);
}
