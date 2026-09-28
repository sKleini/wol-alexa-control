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
//
// **Und auch das Rechenzentrum erwischt veraltete Server.** Mit dem Umweg
// kamen die aktuellen Nachrichten - meistens. Die Anzeige im Dashboard sprang
// bei wiederholtem Antippen zwischen 21:05 und 09:05, und mit 09:05 kam auch
// wieder die alte Sendung. Das Verteilnetz hat also auch hier mehrere
// Server, und einige davon halten die Datei von heute frueh; welcher antwortet,
// entscheidet sich je Verbindung. Deshalb fragt jeder Abruf `VERSUCHE` Server
// gleichzeitig nach einem einzigen Byte - jeder ueber eine eigene Verbindung
// und, wo der Name mehrere Adressen hat, an eine andere -, vergleicht die
// Sendezeiten und holt die Sendung dann ueber die Verbindung, die die neueste
// hatte (siehe `waehleServer`).
//
// **Die Server haengen an der Adresse, nicht an der Verbindung.** Gemeldet um
// 22 Uhr: beim Laden `22:05 ×4`, kurz darauf `21:05 ×12`, und *Listen*
// spielte immer 21 Uhr. Innerhalb eines Abrufs hatten alle Server dasselbe -
// welche Gruppe antwortet, entscheidet die Adresse, die die Namensaufloesung
// der Function gerade liefert. Mehr Runden gegen dieselben Adressen helfen da
// nicht. Deshalb (siehe `adressenFuer`) kommen die Adressen auch von
// oeffentlichen Namensdiensten - das Verteilnetz verteilt nach dem fragenden
// Namensdienst, jeder liefert eine andere Gruppe -, und die Adresse, die
// zuletzt die neueste Sendung hatte, wird gemerkt und zuerst gefragt: im
// Speicher der Function und in Redis, damit der Anhoer-Knopf und der Echo
// dort weitermachen, wo die Anzeige die neue Sendung gefunden hat.
import crypto from 'node:crypto'
import dns from 'node:dns'
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

/** Oeffentliche Namensdienste, die zusaetzlich nach Adressen gefragt werden. */
const NAMENSDIENSTE = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];
/** So lange darf die Frage nach Adressen dauern, und so lange gilt die Antwort. */
const DNS_MS = 1200;
const ADRESSEN_GUELTIG_MS = 5 * 60 * 1000;
/** Redis-Schluessel fuer die Adresse, die zuletzt die neueste Sendung hatte. */
export const GEMERKT_KEY = 'musik:sender:adresse';
/** Redis-Liste der letzten Serverwahlen: welche Adresse was hatte. */
export const SERVERLOG_KEY = 'musik:sender:log';
const SERVERLOG_LAENGE = 20;

/** Wie viele Server je Runde gefragt werden, und wie lange je Frage. */
const VERSUCHE = 4;
const PROBE_MS = 4000;

/**
 * Hoechstens so viele Runden, und hoechstens so lange insgesamt.
 *
 * **Vier Server haben nicht gereicht.** Gemeldet nach 21 Uhr:
 * `20:05 ×1, 09:05 ×3` - keiner der vier hatte die Sendung von 21:05. Also
 * wird weitergefragt, Runde um Runde mit neuen Verbindungen, bis eine
 * Sendung der laufenden Stunde dabei ist (`frisch`), oder die Runden
 * oder die Zeit aufgebraucht sind. Dann gilt die neueste, die gefunden wurde.
 */
const RUNDEN = 3;
const WAHL_MS = 6000;

/**
 * Bis zu dieser Minute der Stunde gilt noch die Sendung der vorigen Stunde.
 *
 * Jede Stunde kommt gegen xx:05 eine neue. Bis xx:08 ist die vom vorigen
 * Mal die richtige; danach muss es die der laufenden Stunde sein. Ein
 * blosses Hoechstalter taugt dafuer nicht: Mit "65 Minuten" galt um 21:10
 * die Sendung von 20:05 noch als aktuell - genau die, die gemeldet wurde.
 */
const NEUE_SENDUNG_MIN = 8;

/**
 * Gilt eine Sendung mit dieser Zeit (ms) jetzt als aktuell?
 *
 * Gerechnet in ganzen Stunden seit 1970; das geht auch in UTC auf, denn
 * deutsche Zeit liegt um volle Stunden daneben.
 */
export function frisch(zeit, jetzt = netz.jetzt()) {
  const stunde = 60 * 60 * 1000;
  const ab = Math.floor((jetzt - NEUE_SENDUNG_MIN * 60 * 1000) / stunde) * stunde;
  return zeit > 0 && zeit >= ab;
}

/**
 * Die Verbindungen zum Sender - austauschbar, damit die Tests ohne Netz laufen.
 *
 * **Eine eigene Verbindung je Versuch.** Das eingebaute `fetch` teilt sich
 * einen Pool: Vier Fragen hintereinander gingen ueber dieselbe offene
 * Verbindung zum selben Server und bekaemen viermal dieselbe Antwort. Ein
 * eigener `Agent` aus undici je Versuch oeffnet eine eigene Verbindung, und
 * sein `lookup` nimmt die k-te Adresse des Namens statt immer der ersten.
 * Die Sendung selbst laeuft dann ueber genau die Verbindung, deren Probe die
 * neueste Sendezeit hatte - sie ist noch offen, derselbe Server antwortet.
 *
 * undici wird erst hier geladen und nicht oben importiert: Die Tests ersetzen
 * `verbindung` und brauchen das Paket nicht, und die CI installiert keine
 * Pakete. Fehlt es doch einmal, geht es mit dem eingebauten `fetch` weiter -
 * wie vor dieser Aenderung.
 */
export const netz = {
  /** Die Uhr, gegen die `frisch` misst - austauschbar, damit Tests nicht an der Wanduhr haengen. */
  jetzt: () => Date.now(),
  /** Das eingebaute `fetch` - der Rueckfall, wenn keine eigene Verbindung zustande kommt. */
  einfach() {
    return { fetch: (...a) => globalThis.fetch(...a), close: async () => {} };
  },
  /**
   * Die IPv4-Adressen eines Namens: vom System und von den oeffentlichen
   * Namensdiensten, ohne Doppelte. Wer nicht rechtzeitig antwortet, fehlt.
   */
  async adressen(hostname) {
    const frage = (aufloesen) => new Promise((fertig) => {
      const wecker = setTimeout(() => fertig([]), DNS_MS);
      aufloesen((err, liste) => { clearTimeout(wecker); fertig(err ? [] : (liste || [])); });
    });
    const system = frage(f => dns.lookup(hostname, { all: true, family: 4 },
      (err, alle) => f(err, (alle || []).map(a => a.address))));
    const oeffentlich = NAMENSDIENSTE.map((server) => frage((f) => {
      const r = new dns.Resolver({ timeout: DNS_MS, tries: 1 });
      r.setServers([server]);
      r.resolve4(hostname, f);
    }));
    // Dazu, welcher Namensdienst welche Adresse nannte - fuers Server-Log.
    const antworten = await Promise.all([system, ...oeffentlich]);
    const quellen = {};
    ['System', ...NAMENSDIENSTE].forEach((dienst, i) => {
      for (const a of antworten[i]) (quellen[a] ||= []).push(dienst);
    });
    return mitQuellen([...new Set(antworten.flat())], quellen);
  },
  async verbindung(k, feste = null) {
    let undici;
    try {
      undici = await import('undici');
    } catch {
      return netz.einfach();
    }
    const agent = new undici.Agent({
      connect: {
        lookup(hostname, optionen, fertig) {
          // Eine vorgegebene Adresse (aus `adressenFuer`) gilt ohne Frage.
          if (feste) {
            if (optionen?.all) return fertig(null, [{ address: feste, family: 4 }]);
            return fertig(null, feste, 4);
          }
          // **Nur IPv4, wenn es welche gibt.** In der Anzeige standen neben
          // den Sendezeiten auch "Fehler ×2": Die Function erreicht keine
          // IPv6-Adressen, und jede zweite Verbindung ging dorthin.
          dns.lookup(hostname, { all: true }, (err, alle) => {
            const v4 = (alle || []).filter(a => a.family === 4);
            const adressen = v4.length ? v4 : alle;
            if (err || !adressen?.length) return fertig(err || new Error(`keine Adresse fuer ${hostname}`));
            const adresse = adressen[k % adressen.length];
            // Mit `all` erwartet der Aufrufer eine Liste (Happy Eyeballs),
            // ohne sie Adresse und Familie einzeln.
            if (optionen?.all) return fertig(null, [adresse]);
            return fertig(null, adresse.address, adresse.family);
          });
        },
      },
    });
    return {
      adresse: feste,
      fetch: (url, optionen) => undici.fetch(url, { ...optionen, dispatcher: agent }),
      close: () => agent.destroy().catch(() => {}),
    };
  },
};

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
        // Der Sendername bleibt am Titel haengen: Die Zeitansage braucht ihn,
        // und aus der umgeschriebenen Adresse liest ihn sonst niemand mehr.
        return url ? { ...t, url, sender: name } : t;
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

/**
 * Die Sendezeit zum Sprechen: nur die volle Stunde, "20 Uhr".
 *
 * Die Nachrichten heissen nach ihrer Stunde - die Sendung von 20:05 sind die
 * Nachrichten von 20 Uhr, und so sollen sie auch angesagt werden. Die Minute
 * ist nur, wann die Datei hochgeladen wurde.
 */
export function sendezeitGesprochen(lastModified) {
  const zeit = Date.parse(String(lastModified || ''));
  if (!Number.isFinite(zeit)) return null;
  const teile = Object.fromEntries(new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', hour: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(zeit)).map(t => [t.type, t.value]));
  return `${Number(teile.hour)} Uhr`;
}

/** Ein Abruf beim Sender, am Zwischenspeicher vorbei, soweit der es zulaesst. */
async function holeVomSender(verbindung, name, bereichKopf, frist = KOPF_MS) {
  const steuerung = new AbortController();
  const wecker = setTimeout(() => steuerung.abort(), frist);
  try {
    const antwort = await verbindung.fetch(`${SENDER[name]}?t=${Date.now()}`, {
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
    return { fehler: err?.name === 'AbortError' ? `keine Antwort in ${frist} ms` : `nicht erreichbar (${err?.message || err})` };
  } finally {
    clearTimeout(wecker);
  }
}

/**
 * Ein Byte von einem Server: seine Sendezeit, ohne die Sendung zu laden.
 *
 * Der Rumpf wird gelesen statt verworfen, solange er klein ist - so bleibt
 * die Verbindung offen und kann gleich danach die Sendung tragen. Ein Server,
 * der den Bereich nicht beachtet und die ganze Datei schickt, wird verworfen.
 */
async function probe(verbindung, name, k, frist = PROBE_MS) {
  const versuch = await holeVomSender(verbindung, name, 'bytes=0-0', frist);
  const adresse = verbindung.adresse || null;
  if (versuch.fehler) return { k, verbindung, adresse, fehler: versuch.fehler, zeit: -1 };
  const { antwort } = versuch;
  try {
    if (Number(antwort.headers.get('content-length')) <= 1024) await antwort.arrayBuffer();
    else await antwort.body?.cancel();
  } catch { /* egal */ }
  const lastModified = antwort.headers.get('last-modified');
  return {
    k, verbindung, adresse, ok: antwort.ok, status: antwort.status, lastModified,
    zeit: antwort.ok ? (Date.parse(lastModified || '') || 0) : -1,
    alter: antwort.headers.get('age'),
  };
}

/** Eine Adressliste, die (unsichtbar fuer Vergleiche) mitfuehrt, woher jede Adresse kam. */
function mitQuellen(liste, quellen = {}) {
  return Object.defineProperty(liste, 'quellen', { value: quellen, enumerable: false });
}

/** Das Ergebnis oder, nach `ms`, den Ersatz. */
function mitFristOder(versprechen, ersatz, ms) {
  let wecker;
  return Promise.race([
    versprechen.catch(() => ersatz),
    new Promise((fertig) => { wecker = setTimeout(() => fertig(ersatz), ms); }),
  ]).finally(() => clearTimeout(wecker));
}

/** Je Sender: die Adressen (mit Zeitpunkt) und die zuletzt beste Adresse. */
const adressSpeicher = new Map();
const gemerkt = new Map();

/** Die gemerkte Adresse lesen - aus dem Speicher, sonst aus Redis. */
async function gemerktLesen(name, redis) {
  if (gemerkt.has(name)) return gemerkt.get(name);
  if (!redis) return null;
  try {
    const alle = await redis.get(GEMERKT_KEY);
    const eintrag = alle?.[name];
    if (eintrag?.adresse) gemerkt.set(name, eintrag);
    return eintrag?.adresse ? eintrag : null;
  } catch { return null; }
}

/** Die Adresse merken, die die neueste Sendung hatte - wenn sie neuer ist als die gemerkte. */
async function gemerktSchreiben(name, probe, redis) {
  if (!probe?.adresse || !(probe.zeit > 0)) return;
  const alt = gemerkt.get(name);
  if (alt && alt.adresse === probe.adresse && alt.zeit >= probe.zeit) return;
  const eintrag = { adresse: probe.adresse, zeit: probe.zeit };
  gemerkt.set(name, eintrag);
  if (!redis) return;
  try {
    const alle = (await redis.get(GEMERKT_KEY)) || {};
    await redis.set(GEMERKT_KEY, { ...alle, [name]: eintrag });
  } catch { /* nur ein Merkzettel */ }
}

/**
 * Die Adressen, an die die Proben gehen: die gemerkte zuerst, dann alle,
 * die System und oeffentliche Namensdienste liefern. Fuenf Minuten lang
 * wiederverwendet, damit nicht jeder Abruf erst die Namensdienste fragt.
 */
export async function adressenFuer(name, redis = null) {
  const host = new URL(SENDER[name]).hostname;
  let eintrag = adressSpeicher.get(name);
  if (!eintrag || netz.jetzt() - eintrag.wann > ADRESSEN_GUELTIG_MS || !eintrag.liste.length) {
    let liste = [];
    try { liste = await netz.adressen(host); } catch { /* dann ohne */ }
    eintrag = { wann: netz.jetzt(), liste, quellen: liste.quellen || {} };
    if (liste.length) adressSpeicher.set(name, eintrag);
  }
  const vorn = (await gemerktLesen(name, redis))?.adresse;
  const quellen = { ...eintrag.quellen };
  if (vorn) quellen[vorn] = [...(quellen[vorn] || []), 'gemerkt'];
  return mitQuellen(vorn ? [vorn, ...eintrag.liste.filter(a => a !== vorn)] : [...eintrag.liste], quellen);
}

/**
 * Eine Serverwahl ins Log: wann, wofuer, und je Probe Adresse und Sendezeit.
 * Die erste Probe ist die gewaehlte. Ein Fehler hier kostet nie die Wiedergabe.
 */
async function serverLogSchreiben(redis, name, anlass, proben, quellen = {}) {
  if (!redis) return;
  const eintrag = {
    zeit: Date.now(), sender: name, anlass,
    proben: proben.map(p => ({
      adresse: p.adresse,
      // Ohne feste Adresse fragte die Verbindung selbst das System.
      dns: p.adresse ? (quellen[p.adresse] || []) : ['System'],
      stand: p.fehler || sendezeit(p.lastModified) || (p.ok ? '?' : `HTTP ${p.status}`),
    })),
  };
  try {
    await redis.lpush(SERVERLOG_KEY, eintrag);
    await redis.ltrim(SERVERLOG_KEY, 0, SERVERLOG_LAENGE - 1);
  } catch { /* nur eine Auskunft */ }
}

/** Das Server-Log, neueste Wahl zuerst. */
export async function serverLogLesen(redis) {
  try {
    const roh = await redis.lrange(SERVERLOG_KEY, 0, SERVERLOG_LAENGE - 1);
    return (roh || []).map((e) => {
      if (e && typeof e === 'object') return e;
      try { return JSON.parse(String(e)); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** Nur fuer die Tests: das Gemerkte vergessen. */
export function vergiss() { adressSpeicher.clear(); gemerkt.clear(); }

/**
 * Server fragen, Runde um Runde, bis eine aktuelle Sendung dabei ist.
 *
 * Je Runde `VERSUCHE` Server gleichzeitig, jede Runde mit neuen Verbindungen
 * (und der naechsten Adresse des Namens). Schluss ist, sobald die neueste
 * Probe `frisch` ist, nach `runden` Runden oder wenn `frist` um ist.
 *
 * Zurueck kommen alle Proben, sortiert nach Sendezeit (Fehler zuletzt), und
 * `schliessen`, das alle Verbindungen wieder zumacht. Der Aufrufer ruft es,
 * wenn er fertig ist - auch die, ueber die er die Sendung geholt hat.
 */
export async function waehleServer(name, { runden = RUNDEN, frist = WAHL_MS, redis = null, anlass = null } = {}) {
  const beginn = Date.now();
  const verbindungen = [];
  const proben = [];
  // Die Adressen zaehlen zur Frist: Wer nur drei Sekunden hat, soll nicht
  // die Haelfte davon auf Namensdienste warten.
  const adressen = await mitFristOder(adressenFuer(name, redis), [], Math.min(DNS_MS, frist / 2));
  const adresseFuer = k => (adressen.length ? adressen[k % adressen.length] : null);
  for (let runde = 0; runde < runden; runde++) {
    const uebrig = frist - (Date.now() - beginn);
    if (uebrig <= 0) break;
    const ab = runde * VERSUCHE;
    const neu = await Promise.all(Array.from({ length: VERSUCHE }, (_, i) => netz.verbindung(ab + i, adresseFuer(ab + i))));
    verbindungen.push(...neu);
    proben.push(...await Promise.all(neu.map((v, i) => probe(v, name, ab + i, Math.min(PROBE_MS, uebrig)))));
    if (frisch(Math.max(...proben.map(p => p.zeit)))) break;
  }
  proben.sort((a, b) => b.zeit - a.zeit);
  if (proben[0] && !proben[0].fehler && proben[0].ok) await gemerktSchreiben(name, proben[0], redis);
  if (anlass) await serverLogSchreiben(redis, name, anlass, proben, adressen.quellen);
  return {
    proben,
    schliessen: () => Promise.all(verbindungen.map(v => v.close?.())).catch(() => {}),
  };
}

/** "21:05 ×3, 09:05 ×1" - welcher Server was hatte, fuer Anzeige und Verlauf. */
export function serverBild(proben) {
  const zaehler = new Map();
  for (const p of proben) {
    const wort = p.fehler ? 'Fehler' : (sendezeit(p.lastModified) || (p.ok ? '?' : `HTTP ${p.status}`));
    zaehler.set(wort, (zaehler.get(wort) || 0) + 1);
  }
  return [...zaehler].map(([wort, n]) => `${wort} ×${n}`).join(', ');
}

/**
 * Was die App beim Sender gerade bekommt - fuer die Anzeige im Dashboard.
 *
 * Dieselbe Wahl wie beim Abspielen: die neueste Sendezeit unter allen
 * gefragten Servern, und daneben, was die einzelnen hatten. Ohne Schluessel
 * und ohne Budget, denn es fliesst nichts, was zu zaehlen waere.
 */
export async function senderStand(name, frist = WAHL_MS, redis = null, anlass = null) {
  if (!SENDER[name]) return { error: 'Unknown station' };
  const { proben, schliessen } = await waehleServer(name, { frist, redis, anlass });
  await schliessen();
  const beste = proben[0];
  if (!beste || beste.fehler) return { ok: false, grund: beste?.fehler || 'keine Antwort', server: serverBild(proben) };
  return {
    ok: beste.ok,
    status: beste.status,
    lastModified: beste.lastModified,
    sendezeit: sendezeit(beste.lastModified),
    // Dieselbe Stunde, die Alexa ansagt - das Dashboard zeigt sie im
    // Beispielsatz der Zeitansage.
    gesprochen: sendezeitGesprochen(beste.lastModified),
    alter: beste.alter,
    server: serverBild(proben),
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
  const eintrag = (felder) => verlaufSchreiben(redis, {
    was: 'ton', bereich: teil.kopfzeile, dauer: Date.now() - begonnen, ...felder,
  });

  const { proben, schliessen } = await waehleServer(name, { redis, anlass: nurKopf ? null : 'Echo' });
  try {
    return await liefereVomBesten(res, name, teil, nurKopf, proben, eintrag, redis, begonnen);
  } finally {
    await schliessen();
  }
}

/**
 * Die Sendung ueber die Verbindung mit der neuesten Probe - oder die naechste.
 *
 * **Warum noch einmal verglichen wird.** Die Verbindung ist dieselbe, der
 * Server dahinter meistens auch. Garantiert ist das nicht: Ein Lastverteiler
 * kann die zweite Anfrage woanders hinschicken. Bringt sie eine aeltere
 * Sendung als die neueste Probe, wird sie verworfen und die naechste
 * Verbindung gefragt - der Echo bekommt keine Kopfzeilen, bevor feststeht,
 * dass es die richtige Sendung ist.
 */
async function liefereVomBesten(res, name, teil, nurKopf, proben, eintrag, redis, begonnen) {
  const kandidaten = proben.filter(p => !p.fehler && p.ok);
  // Keine einzige Verbindung zustande gekommen: ein einfacher Abruf wie vor
  // der Wahl, statt gleich aufzugeben - eine Sendung, deren Stand man nicht
  // kennt, ist besser als Stille. Hat der Sender dagegen geantwortet, nur mit
  // einem Fehler, bleibt es dabei.
  if (!kandidaten.length && proben.every(p => p.fehler)) kandidaten.push({ verbindung: netz.einfach(), zeit: 0 });
  const ziel = kandidaten[0]?.zeit || 0;
  const bild = serverBild(proben);
  let versuch = null;
  let letzter = proben[0]?.fehler || `HTTP ${proben[0]?.status ?? '?'}`;
  for (const kandidat of kandidaten) {
    const antwortVersuch = await holeVomSender(kandidat.verbindung, name, teil.kopfzeile);
    if (antwortVersuch.fehler) { letzter = antwortVersuch.fehler; continue; }
    const zeit = Date.parse(antwortVersuch.antwort.headers.get('last-modified') || '') || 0;
    if (antwortVersuch.antwort.ok && zeit < ziel) {
      try { await antwortVersuch.antwort.body?.cancel(); } catch { /* egal */ }
      letzter = `veraltet (${sendezeit(antwortVersuch.antwort.headers.get('last-modified')) || '?'})`;
      continue;
    }
    versuch = antwortVersuch;
    break;
  }

  if (!versuch) {
    console.warn(`musik-box ${name} nicht lieferbar: ${letzter} (Server: ${bild})`);
    await eintrag({ datei: `${name.toUpperCase()} (Server: ${bild})`, status: 502, bytes: 0, soll: null, grund: letzter });
    return res.status(502).end();
  }
  const { antwort } = versuch;
  const datei = `${name.toUpperCase()} (Stand ${sendezeit(antwort.headers.get('last-modified')) || '?'}; Server: ${bild})`;

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
