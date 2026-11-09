// lib/boxweg.js – welcher Weg gerade zur FRITZ!Box fuehrt.
//
// **Der Anlass.** Am 9. November fiel in Weinsheim das DSL aus, und die
// FRITZ!Box ging ueber ihre Mobilfunk-Ausweichverbindung ins Netz. Dort bekommt
// sie nur eine Adresse aus dem privaten Netz des Anbieters; ihr MyFRITZ!-Name
// zeigte danach auf eine private Adresse. Von aussen kam niemand mehr zur Box:
// `zielErlaubt` lehnte jeden Abruf ab ("zeigt auf eine private Adresse"), und
// Alexa wies die Play-Direktive einer Datei-Freigabe mit "The URL specified in
// the Play directive is invalid" zurueck.
//
// **Was dabei weiter stand, war der Tunnel.** Die Box baut ihren WireGuard-
// Tunnel zum VPS von sich aus auf, auch ueber Mobilfunk. Auf dem VPS laeuft
// dafuer der Musik-Durchgang (Repo wireguard-vps-strato, Workflow 42): Er nimmt
// Abrufe dieser App an und reicht sie durch den Tunnel an die Box. Dieses
// Modul entscheidet, wann ein Abruf diesen Weg nimmt - und nur dann.
//
// **Die Regel.** Ein Abruf geht ueber den VPS, wenn alles davon zutrifft:
//
//   - er zielt auf eine NAS-Seite der Box (`/nas/…`, Host siehe `istBoxAdresse`),
//   - der Durchgang ist eingerichtet (`MUSIK_VPS_URL`, `_KEY`, `_CERT`),
//   - und die Box ist direkt nicht zu erreichen: Ihr Name zeigt auf eine
//     private Adresse oder ist nicht aufloesbar, oder ein Verbindungsaufbau
//     ist eben gescheitert.
//
// Im Normalfall aendert sich also nichts. Fehlt eine der drei Variablen, gibt
// es den Weg gar nicht, und alles verhaelt sich wie vor diesem Modul.
//
// **Was der VPS nicht bekommt:** fremde Adressen. Eine MP3 von einem anderen
// Server geht nie ueber ihn - der Durchgang reicht ohnehin nur an genau eine
// Box weiter, und ein fremder Abruf kaeme dort an der falschen an.

import { zielErlaubt } from './netz.js'

/** So lange gilt "die Box ist direkt nicht erreichbar", bevor neu gefragt wird. */
export const WEG_GILT_MS = 5 * 60 * 1000;

/** Die Kopfzeile, an der der Durchgang den Aufrufer erkennt. */
export const SCHLUESSEL_KOPF = 'X-Musik-Schluessel';

/**
 * Die Einstellungen des Durchgangs - oder `null`, wenn er nicht eingerichtet ist.
 *
 * Alle drei kommen von Workflow 42 (`aktivieren`). Eine halbe Einrichtung zaehlt
 * als keine: ohne Zertifikat kein Vertrauen, ohne Schluessel kein Durchlass.
 */
export function vpsKonfig(env = process.env) {
  const url = String(env.MUSIK_VPS_URL || '').trim().replace(/\/+$/, '');
  const key = String(env.MUSIK_VPS_KEY || '').trim();
  const cert = String(env.MUSIK_VPS_CERT || '').trim();
  if (!url || !key || !cert) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.pathname !== '/' || u.search) return null;
  return { url: u.origin, key, cert };
}

/**
 * Darf dieser Abruf ueberhaupt ueber den VPS?
 *
 * Nur NAS-Seiten (`/nas/…`) - genau die laesst der Durchgang durch. Und nur
 * der Host der Box: `MUSIK_VPS_BOX`, wenn gesetzt, sonst jeder MyFRITZ!-Name.
 * Der Durchgang kennt nur die Box in Weinsheim; wer eine zweite FRITZ!Box mit
 * eigener Freigabe hat, setzt `MUSIK_VPS_BOX`, damit deren Abrufe nicht dort
 * landen.
 */
export function istBoxAdresse(url, env = process.env) {
  let u;
  try { u = url instanceof URL ? url : new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (!u.pathname.startsWith('/nas/')) return false;
  const box = String(env.MUSIK_VPS_BOX || '').trim().toLowerCase();
  const host = u.hostname.toLowerCase();
  return box ? host === box : host.endsWith('.myfritz.net');
}

/**
 * Was ein Grund von `zielErlaubt` fuer den Weg bedeutet.
 *
 * Nur die beiden Gruende, die ein DSL-Ausfall erzeugt, schicken zum VPS. "Kein
 * https" oder "lokaler Host" sind Fehler in der Adresse - die behebt kein
 * anderer Weg.
 */
export function wegUrteil(grund) {
  return grund === 'zeigt auf eine private Adresse' || grund === 'Hostname nicht aufloesbar'
    ? 'vps'
    : 'direkt';
}

// Gemerkt wird je Instanz und nur im Speicher. Die Entscheidung kostet eine
// Namensaufloesung und ist damit billig genug, um sie in jeder neuen Instanz
// frisch zu treffen.
let gemerktBis = 0;

/** Ab jetzt fuer `WEG_GILT_MS` ueber den VPS - ohne erneut zu fragen. */
export function wegMerken(jetzt = Date.now()) {
  gemerktBis = jetzt + WEG_GILT_MS;
}

/** Fuer die Tests: den gemerkten Weg vergessen. */
export function wegVergessen() {
  gemerktBis = 0;
}

/** Austauschbar fuer die Tests - so wie `netz` in lib/sender.js. */
export const boxnetz = {
  jetzt: () => Date.now(),
  pruefe: (url) => zielErlaubt(url),
  direkt: (url, init) => globalThis.fetch(url, init),
  /** Ein Abruf beim Durchgang, mit genau dem einen hinterlegten Zertifikat. */
  async vps(url, init, konfig) {
    const undici = await import('undici');
    return undici.fetch(url, { ...init, dispatcher: agentFuer(undici, konfig.cert) });
  },
};

// Ein Agent je Zertifikat: Verbindungen zum Durchgang duerfen offen bleiben,
// und ein neues Zertifikat (nach `aktivieren`) bekommt einen eigenen.
let agent = null;
let agentCert = null;
function agentFuer(undici, cert) {
  if (agent && agentCert === cert) return agent;
  agent = new undici.Agent({ connect: { ca: cert } });
  agentCert = cert;
  return agent;
}

/**
 * Der Weg fuer diesen Abruf: `{ name: 'direkt' | 'vps', grund }`.
 *
 * `grund` ist, was `zielErlaubt` gegen den direkten Weg einzuwenden hat - beim
 * VPS-Weg `null`, denn dort ist das kein Einwand mehr.
 */
export async function boxWeg(url, { konfig = vpsKonfig(), env = process.env } = {}) {
  const u = url instanceof URL ? url : new URL(url);
  if (!konfig || !istBoxAdresse(u, env)) {
    return { name: 'direkt', grund: await boxnetz.pruefe(u) };
  }
  if (gemerktBis > boxnetz.jetzt()) return { name: 'vps', grund: null };
  const grund = await boxnetz.pruefe(u);
  if (wegUrteil(grund) === 'vps') {
    wegMerken(boxnetz.jetzt());
    return { name: 'vps', grund: null };
  }
  return { name: 'direkt', grund };
}

/**
 * Ersatz fuer `zielErlaubt` an den Stellen, die zur Box gehen.
 *
 * Liefert den Grund gegen den Abruf - oder `null`, wenn er gehen darf, sei es
 * direkt oder ueber den VPS.
 */
export async function boxPruefen(url, optionen) {
  return (await boxWeg(url, optionen)).grund;
}

/** Die Adresse beim Durchgang: seine Herkunft, Pfad und Abfrage der Box. */
export function aufVps(url, konfig) {
  const u = url instanceof URL ? url : new URL(url);
  return `${konfig.url}${u.pathname}${u.search}`;
}

// Welche Antworten ueber den VPS kamen - fuer den Verlauf im Dashboard.
const ueberVpsGekommen = new WeakSet();

/** Kam diese Antwort ueber den VPS? */
export function ueberVps(antwort) {
  return Boolean(antwort) && ueberVpsGekommen.has(antwort);
}

/**
 * Fehler beim Verbindungsaufbau, nach denen die Box direkt als weg gilt.
 *
 * **Eine Zeitueberschreitung gehoert ausdruecklich nicht dazu.** Sie ist bei
 * dieser Box der Normalfall, wenn ihre Platte anlaeuft (siehe `weckeStream` in
 * lib/fritznas.js) - daraus einen Ausfall zu machen hiesse, nach jeder
 * laengeren Pause fuenf Minuten ueber den Tunnel zu spielen.
 */
const VERBINDUNG_WEG = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND']);

export function verbindungWeg(err) {
  const code = err?.cause?.code || err?.code;
  return VERBINDUNG_WEG.has(code);
}

/**
 * `fetch` fuer Abrufe bei der Box: direkt, oder ueber den Durchgang.
 *
 * Fuer den Aufrufer sieht beides gleich aus. Er gibt die Adresse der Box an
 * (`https://…myfritz.net:456/nas/…`) und bekommt eine Antwort, deren
 * Umleitungen wieder auf diese Adresse zeigen - so funktionieren Cookies,
 * Sitzungsnummern und `new URL(location, url)` ohne einen eigenen Zweig.
 */
export async function boxFetch(url, init = {}, optionen = {}) {
  const konfig = optionen.konfig === undefined ? vpsKonfig() : optionen.konfig;
  const u = url instanceof URL ? url : new URL(url);
  const weg = await boxWeg(u, { ...optionen, konfig });
  if (weg.name === 'vps') return vpsAbruf(u, init, konfig);
  try {
    return await boxnetz.direkt(u, init);
  } catch (err) {
    // Beim naechsten Abruf gleich den Tunnel nehmen - aber nicht diesen
    // wiederholen: Seine Frist gehoert dem Aufrufer, und der ist gerade dabei,
    // sie zu verbrauchen.
    if (konfig && istBoxAdresse(u, optionen.env) && verbindungWeg(err)) {
      wegMerken(boxnetz.jetzt());
    }
    throw err;
  }
}

async function vpsAbruf(u, init, konfig) {
  const kopf = new Headers(init.headers || {});
  kopf.set(SCHLUESSEL_KOPF, konfig.key);
  const antwort = await boxnetz.vps(aufVps(u, konfig), { ...init, headers: kopf }, konfig);
  const zurueck = mitUrsprung(antwort, u, konfig);
  ueberVpsGekommen.add(zurueck);
  return zurueck;
}

/**
 * Eine Umleitung der Box zurueck auf ihre oeffentliche Adresse.
 *
 * Im Tunnel kennt sich die Box als `192.168.188.1`, und so steht sie dann auch
 * in einer Umleitung. Folgte der Aufrufer dem, ginge der naechste Abruf direkt
 * an eine private Adresse - von Vercel aus ein Abruf ins Leere. Uebernommen
 * werden deshalb nur Pfad und Abfrage; der Weg bleibt der Tunnel.
 *
 * Rein und exportiert, damit die Regel ohne Netz pruefbar ist.
 */
export function mitUrsprung(antwort, u, konfig) {
  const ort = antwort.headers.get('location');
  if (!ort || antwort.status < 300 || antwort.status > 399) return antwort;
  let ziel;
  try { ziel = new URL(ort, u); } catch { return antwort; }
  if (ziel.origin === u.origin || !ziel.pathname.startsWith('/nas/')) return antwort;
  const intern = /^\d{1,3}(\.\d{1,3}){3}$/.test(ziel.hostname) || ziel.origin === konfig.url;
  if (!intern) return antwort;
  const kopf = new Headers(antwort.headers);
  kopf.set('location', `${u.origin}${ziel.pathname}${ziel.search}`);
  return new Response(antwort.body, { status: antwort.status, statusText: antwort.statusText, headers: kopf });
}
