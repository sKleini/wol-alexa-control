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

/** Redis: was in diesem Monat durchgelaufen ist, in Bytes. */
export const TON_MONAT_PREFIX = 'musik_ton_monat:';

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

/** Vorgaben, beide als Env-Variable ueberschreibbar (und je Aufruf gelesen). */
const KAPPUNG_MB_VORGABE = 16;
const BUDGET_GB_VORGABE = 50;

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
 * **Warum ueberhaupt gekappt wird.** Vercel beendet eine Function nach 300
 * Sekunden. Ein Abspieler, der eine Stunde Hoerbuch im Abspieltempo zieht,
 * liefe darueber - und mitten im Kapitel abgeschnitten zu werden ist
 * schlimmer als ein zweiter Abruf. Deshalb wird nie mehr als die Kappung
 * angefordert; der Abspieler holt den Rest mit dem naechsten Bereich nach,
 * so wie er es nach jeder Pause ohnehin tut.
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
 * Der Endpunkt selbst: `GET /api/skill?ton=<Token>`.
 *
 * `holeSid(link, erzwingen)` kommt von aussen herein, damit diese Datei nichts
 * aus lib/musik.js importieren muss - dort haengt der ganze Skill dran, und
 * ein Ringschluss zwischen zwei Modulen ist eine Falle fuer den naechsten,
 * der eine Zeile verschiebt.
 */
export async function nasTon(req, res, redis, rohToken, holeSid) {
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

  const nurKopf = req.method === 'HEAD';
  // Fuer HEAD reicht ein einziges Byte: Gebraucht wird die Gesamtgroesse aus
  // `Content-Range`, nicht die Datei.
  const teil = nurKopf ? bereich('bytes=0-0', 0) : bereich(req.headers?.range);

  // Zwei Anlaeufe, und der zweite nur mit einer erzwungen frischen Nummer:
  // Eine Sitzung stirbt an Ereignissen, nicht an der Uhr - eine Anmeldung fuer
  // eine andere Freigabe genuegt. Was die Box dann liefert, ist die
  // Anmeldeseite, und die unterscheidet `weckUrteil` von Tondaten.
  let letzter = 'kein Versuch';
  for (const erzwingen of [false, true]) {
    const sid = await holeSid(auftrag.link, erzwingen);
    if (!sid) { letzter = 'keine Sitzungsnummer'; continue; }

    const ziel = streamUrl(freigabe.herkunft, sid, auftrag.pfad);
    const steuerung = new AbortController();
    // Die Frist gilt nur bis zum Kopf - danach abgeraeumt, sonst risse sie
    // den laufenden Titel mitten entzwei.
    const wecker = setTimeout(() => steuerung.abort(), KOPF_MS);
    let antwort;
    try {
      antwort = await fetch(ziel, {
        method: 'GET',
        headers: { Range: teil.kopfzeile, 'User-Agent': 'musik-box-durchleiter/1.0' },
        redirect: 'manual',
        signal: steuerung.signal,
      });
    } catch (err) {
      clearTimeout(wecker);
      letzter = err?.name === 'AbortError' ? `keine Antwort in ${KOPF_MS} ms` : `nicht erreichbar (${err?.message || err})`;
      continue;
    }
    clearTimeout(wecker);

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

    res.writeHead(status, kopf);
    const bytes = await durchleiten(antwort.body, res);
    await zaehle(redis, bytes);
    console.log(`musik-box Ton geliefert: ${adresseKurz(auftrag.pfad)} ${lesbareMenge(bytes)}`
      + `${erzwingen ? ' (nach frischer Sitzung)' : ''}`);
    return undefined;
  }

  console.warn(`musik-box Ton nicht lieferbar (${letzter}): ${adresseKurz(auftrag.pfad)}`);
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

/** "/Musik/Lottchen/01 - Die Buehne.mp3" -> "01 - Die Buehne.mp3" fuers Log. */
function adresseKurz(pfad) {
  return String(pfad).split('/').filter(Boolean).pop() || pfad;
}

/**
 * Die Bytes weiterreichen und dabei zaehlen.
 *
 * Gezaehlt wird am Strom und nicht an `Content-Length`: Wer einen Titel nach
 * dreissig Sekunden abbricht, hat dreissig Sekunden verbraucht und nicht das
 * ganze Kapitel. Die Zahl soll den Tarif erklaeren koennen, sonst taugt sie
 * nichts.
 */
function durchleiten(koerper, res) {
  return new Promise((fertig) => {
    let bytes = 0;
    let schon = false;
    // **Gewartet wird auf die Antwort, nicht auf den Zufluss.** Das `end` des
    // lesenden Stroms kommt, bevor das letzte Stueck hinausgeschrieben ist;
    // wer dort aufhoert zu warten, gibt die Function frei, waehrend der Echo
    // noch auf Bytes wartet.
    const fertigEinmal = () => { if (!schon) { schon = true; fertig(bytes); } };
    const strom = Readable.fromWeb(koerper);
    strom.on('data', (stueck) => { bytes += stueck.length; });
    strom.on('error', (err) => {
      console.warn('musik-box Ton abgebrochen:', err?.message || err);
      res.end();
      fertigEinmal();
    });
    res.on('finish', fertigEinmal);
    // Legt der Echo auf, wird der Abruf bei der Box beendet - sonst laedt die
    // Function eine Datei zu Ende, die niemand mehr hoert, und zahlt sie.
    res.on('close', () => { strom.destroy(); fertigEinmal(); });
    strom.pipe(res);
  });
}
