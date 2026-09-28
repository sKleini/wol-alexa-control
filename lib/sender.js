// lib/sender.js – Nachrichten eines Senders, durch die eigene App zum Echo.
//
// **Warum es diesen Umweg gibt.** Die SWR3-Nachrichten liegen immer unter
// derselben Adresse, und jede Stunde steht dort die neue Sendung. Gemeldet am
// 28. September: Um 20 Uhr spielten der Echo und Chrome die Sendung von
// 9 Uhr frueh, der Samsung-Browser und andere die von 20 Uhr. Die zwei Tests
// danach haben es eingegrenzt:
//
//   - "Sicheres DNS" in Chrome aus: unveraendert 9 Uhr. Die Namensaufloesung
//     ist es also nicht.
//   - Chrome ueber mobile Daten statt WLAN: 20 Uhr.
//
// Es liegt am **Netzweg ueber den heimischen Anschluss**. Dort steht ein
// Zwischenspeicher des Verteilnetzes, der die Sendung von heute frueh haelt -
// und der das `?t=` aus #149 nicht beachtet, sonst haette es geholfen. Der
// Echo holt seine Datei selbst, ueber genau dieses WLAN; er bekommt also
// dasselbe wie Chrome.
//
// Also holt er sie nicht mehr selbst beim Sender. Er bekommt eine Adresse
// dieser App, und die Function holt die Datei aus dem Rechenzentrum - ein
// anderer Weg, so wie die mobilen Daten einer waren - und reicht die Bytes
// durch. Mit `Cache-Control: no-cache` und einem frischen `t`, fuer den Fall,
// dass auch auf diesem Weg ein Zwischenspeicher steht und wenigstens eines
// davon beachtet.
//
// **Kein offener Abruf-Dienst.** Welche Adresse geholt wird, steht in `SENDER`
// und nicht in der Anfrage; wer den Endpunkt aufruft, kann nur einen Namen
// aus dieser Tafel nennen. Und auch das nur mit der Kennung `k`, einer
// Unterschrift mit demselben Schluessel wie die FRITZ!NAS-Adressen - sonst
// koennte jeder, der den Namen der App kennt, das Monatsbudget leerhoeren.
//
// Gezaehlt wird wie beim FRITZ!NAS-Ton: gegen dasselbe Monatsbudget, im
// selben Verlauf. Eine Sendung sind rund 3-5 MB.
import crypto from 'node:crypto'
import {
  tonSchluessel, bereich, antwortKopf, kopfFuerHead, budgetBytes, monatsStand,
  lesbareMenge, verlaufSchreiben, angekuendigt, durchleiten, zaehle,
} from './naston.js'
import { queryOf } from './query.js'

/** Die Sender, die durchgereicht werden - Name in der Adresse, Quelle beim Sender. */
export const SENDER = {
  swr3: 'https://swr-pd.ard-mcdn.de/swr3/radionachrichten.mp3',
};

/** Wie lange auf den Kopf der Antwort gewartet wird - danach fliesst es. */
const KOPF_MS = 10000;

/**
 * Die Kennung, die ein Aufruf mitbringen muss: der Sendername, unterschrieben.
 *
 * Gekuerzt, weil sie in jeder Adresse steht, die der Echo bekommt; 128 Bit
 * reichen gegen Raten bei Weitem.
 */
export function senderKennung(name, schluessel = tonSchluessel()) {
  if (!schluessel || !SENDER[name]) return null;
  return crypto.createHmac('sha256', schluessel).update(`sender:${name}`).digest('base64url').slice(0, 22);
}

/** Welcher Sender hinter dieser Adresse steht - oder null. */
export function senderAus(url) {
  return Object.keys(SENDER).find(name => SENDER[name] === url) || null;
}

/** Die Adresse dieser App, unter der der Echo den Sender bekommt. */
export function senderUrl(basis, name, schluessel = tonSchluessel()) {
  const kennung = senderKennung(name, schluessel);
  if (!kennung || !basis) return null;
  return `${String(basis).replace(/\/+$/, '')}/api/skill?sender=${encodeURIComponent(name)}&k=${kennung}`;
}

/**
 * Die Playlists, wie der Skill sie abspielt: Sender-Adressen durch die App.
 *
 * **Beim Abspielen umgeschrieben, nicht beim Speichern.** Gespeichert bleibt
 * die Adresse des Senders - so erkennt das Dashboard die SWR3-Playlist weiter
 * an ihr, und eine Playlist, die vor diesem Umweg angelegt wurde, nimmt ihn
 * ohne erneutes Speichern. Der Skill schreibt die Playlists nie zurueck; die
 * Umschreibung lebt nur in dieser einen Anfrage.
 *
 * Ohne eigene Adresse oder ohne Schluessel bleibt alles, wie es ist: Dann
 * spielt der Echo wieder direkt vom Sender, was immerhin meistens klappt.
 *
 * Rein und exportiert, damit die Regel ohne Netz pruefbar ist.
 */
export function mitDurchleitung(playlists, basis, schluessel = tonSchluessel()) {
  if (!basis || !schluessel || !Array.isArray(playlists)) return playlists;
  return playlists.map((pl) => {
    if (!Array.isArray(pl?.titel) || !pl.titel.some(t => senderAus(t?.url))) return pl;
    return {
      ...pl,
      titel: pl.titel.map((t) => {
        const name = senderAus(t?.url);
        const url = name && senderUrl(basis, name, schluessel);
        return url ? { ...t, url } : t;
      }),
    };
  });
}

/** "20:05" aus einem Last-Modified - in deutscher Zeit, wie die Sendung heisst. */
export function sendezeit(lastModified) {
  const zeit = Date.parse(String(lastModified || ''));
  if (!Number.isFinite(zeit)) return null;
  return new Date(zeit).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
}

/** Ein Abruf beim Sender, am Zwischenspeicher vorbei, soweit der es zulaesst. */
async function holeVomSender(name, bereichKopf) {
  const steuerung = new AbortController();
  const wecker = setTimeout(() => steuerung.abort(), KOPF_MS);
  try {
    const antwort = await fetch(`${SENDER[name]}?t=${Date.now()}`, {
      method: 'GET',
      headers: {
        Range: bereichKopf,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'User-Agent': 'musik-box-durchleiter/1.0',
      },
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
 * Was die App beim Sender gerade bekommt - fuer die Anzeige im Dashboard.
 *
 * Ein Byte genuegt: Gebraucht werden die Kopfzeilen, nicht die Sendung. Ohne
 * Schluessel und ohne Budget, denn es fliesst nichts, was zu zaehlen waere.
 */
export async function senderStand(name) {
  if (!SENDER[name]) return { error: 'Unknown station' };
  const versuch = await holeVomSender(name, 'bytes=0-0');
  if (versuch.fehler) return { ok: false, grund: versuch.fehler };
  const { antwort } = versuch;
  try { await antwort.body?.cancel(); } catch { /* egal */ }
  const lastModified = antwort.headers.get('last-modified');
  return {
    ok: antwort.ok,
    status: antwort.status,
    lastModified,
    sendezeit: sendezeit(lastModified),
    alter: antwort.headers.get('age'),
  };
}

/**
 * Der Endpunkt selbst: `GET /api/skill?sender=<name>&k=<kennung>`.
 *
 * Aufbau wie `nasTon` in lib/naston.js, nur ohne FRITZ!Box: kein Token mit
 * Pfad, keine Sitzung, kein zweiter Anlauf. Der Sender antwortet oder nicht.
 */
export async function senderTon(req, res, redis) {
  try {
    return await senderLiefern(req, res, redis);
  } catch (err) {
    console.error('musik-box Sender-Endpunkt abgestuerzt:', err?.stack || err);
    if (res.headersSent) return res.end();
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`Nachrichten konnten nicht geliefert werden: ${err?.message || err}\n`);
  }
}

async function senderLiefern(req, res, redis) {
  const anfrage = queryOf(req);
  const name = String(anfrage.sender || '');
  const erwartet = senderKennung(name);
  const gesehen = String(anfrage.k || '');
  if (!erwartet || gesehen.length !== erwartet.length
    || !crypto.timingSafeEqual(Buffer.from(gesehen), Buffer.from(erwartet))) {
    return res.status(401).end();
  }

  const budget = budgetBytes();
  if (budget) {
    const stand = await monatsStand(redis);
    if (stand >= budget) {
      console.warn(`musik-box Monatsbudget aufgebraucht: ${lesbareMenge(stand)} von ${lesbareMenge(budget)}`);
      return res.status(503).end();
    }
  }

  const begonnen = Date.now();
  const nurKopf = req.method === 'HEAD';
  const teil = nurKopf ? bereich('bytes=0-0', 0) : bereich(req.headers?.range, 0);
  const versuch = await holeVomSender(name, teil.kopfzeile);
  const eintrag = (felder) => verlaufSchreiben(redis, {
    was: 'ton', bereich: teil.kopfzeile, dauer: Date.now() - begonnen, ...felder,
  });

  if (versuch.fehler) {
    console.warn(`musik-box ${name} nicht lieferbar: ${versuch.fehler}`);
    await eintrag({ datei: name.toUpperCase(), status: 502, bytes: 0, soll: null, grund: versuch.fehler });
    return res.status(502).end();
  }
  const { antwort } = versuch;
  const datei = `${name.toUpperCase()} (Stand ${sendezeit(antwort.headers.get('last-modified')) || '?'})`;

  if (antwort.status === 416) {
    try { await antwort.body?.cancel(); } catch { /* egal */ }
    const bereichKopf = antwort.headers.get('content-range');
    res.writeHead(416, bereichKopf ? { 'Content-Range': bereichKopf, 'Accept-Ranges': 'bytes' } : { 'Accept-Ranges': 'bytes' });
    return res.end();
  }
  if (!antwort.ok || !antwort.body) {
    try { await antwort.body?.cancel(); } catch { /* egal */ }
    console.warn(`musik-box ${name}: HTTP ${antwort.status} vom Sender`);
    await eintrag({ datei, status: 502, bytes: 0, soll: null, grund: `HTTP ${antwort.status}` });
    return res.status(502).end();
  }

  if (nurKopf) {
    try { await antwort.body?.cancel(); } catch { /* egal */ }
    res.writeHead(200, kopfFuerHead(antwort.headers));
    return res.end();
  }

  const { status, kopf } = antwortKopf(antwort.status, antwort.headers, teil.gefragt);
  const soll = angekuendigt(antwort.headers);
  res.writeHead(status, kopf);
  const bytes = await durchleiten(antwort.body, res);
  await zaehle(redis, bytes);
  console.log(`musik-box ${datei} gestroemt: ${teil.gefragt ? teil.kopfzeile : 'ohne Bereich'} → ${status},`
    + ` ${lesbareMenge(bytes)} in ${Date.now() - begonnen} ms`);
  await eintrag({ datei, status, bytes, soll });
  return undefined;
}
