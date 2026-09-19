// lib/fritznas.js – eine FRITZ!NAS-Ordnerfreigabe als Titelliste.
//
// **Warum ein eigener Weg und nicht der HTML-Parser aus lib/musik.js.** Die
// Seite hinter einem Freigabe-Link ist leer: ein `<div id="app">` und zwei
// Skripte. Kein Dateiname, kein Verweis - die Liste holt sich die Oberflaeche
// im Browser nach. Wer dort nach Links sucht, findet nichts und kann auch
// nichts finden.
//
// **Wie es der Browser macht** (beobachtet an FRITZ!OS mit der NAS-Oberflaesche
// von 2026):
//
//   1. `GET /nas/filelink.lua?id=<Freigabe>`  → setzt eine Sitzung und liefert
//      das Geruest. Die Sitzungsnummer (`sid`) ist von da an der Schluessel.
//   2. `POST /nas/api/data.lua` mit `sid=…&c=user&a=check_nas_rights`
//      → `{ root: "/Musik/Schlaflieder", rights: { read: true } }`
//   3. ein weiterer `data.lua`-Aufruf → `{ files: [ { path, filename, type } ] }`
//   4. je Titel `GET /nas/cgi-bin/luacgi_notimeout?script=/api/data.lua&sid=…
//      &c=music&a=get&path=<Pfad>` → die MP3, mit Range-Unterstuetzung.
//
// Schritt 4 ist der Grund, warum sich der Aufwand lohnt: ein **GET ohne
// Cookie**, genau die Form, die der Echo laden kann. Alles andere daran ist
// Beiwerk.
//
// **Warum die Aufrufe durchprobiert werden.** Von Schritt 3 ist der
// Controller-Name nicht bekannt, und AVM dokumentiert diese Schnittstelle
// nirgends; sie kann sich mit jedem FRITZ!OS aendern. Statt eine Variante zu
// raten und beim naechsten Update stumm zu scheitern, werden die plausiblen
// der Reihe nach versucht, bis eine eine Dateiliste liefert - und was
// dabei herauskam, steht im Bericht. Ein Update, das die Namen aendert,
// erzeugt dann eine Meldung, mit der man weiterarbeiten kann, statt eines
// leeren Ergebnisses.
//
// **Und die Sitzungsnummer laeuft ab.** Eine FRITZ!Box vergisst eine Sitzung
// nach etwa zwanzig Minuten Ruhe. Die Adressen, die hier herauskommen, tragen
// sie - haltbar sind sie trotzdem, weil die Playlist sich den Freigabe-Link
// merkt und der Skill vor jeder Antwort eine frische Nummer einsetzt (siehe
// `frischeSid` und `mitSid` weiter unten, aufgerufen aus lib/musik.js).

import { zielErlaubt } from './netz.js'
import { groesseAusContentRange, lesbareGroesse, genaueDauer, laengerAlsSitzung } from './groesse.js'
import { mp3Kopf, mp3Dauer, LESEPROBE_BYTES } from './mp3.js'

/** Ein Aufruf soll schnell scheitern - es folgen noch mehrere. */
const SCHRITT_MS = 3500;
/** Nur die Sitzung holen - knapper bemessen als der Import: Der Skill wartet,
 *  und Alexa gibt ihm acht Sekunden fuer die ganze Antwort. Das ist der
 *  Rueckfall; der Skill reicht durch, was von seinem Budget wirklich uebrig
 *  ist, und das ist im Regelfall mehr. */
const SID_MS = 4000;
/** Nur nachfragen, ob eine Nummer noch gilt: ein einziger Abruf, und einer, der
 *  schnell scheitern darf - er ist der billige Weg, und der teure steht noch
 *  dahinter. */
const PRUEF_MS = 2000;
/** Vercel gibt der Function zehn Sekunden; darunter muss alles passen. */
const GESAMT_MS = 8500;
const UMLEITUNGEN = 3;

/**
 * Die Kandidaten fuer Schritt 3, in der Reihenfolge ihrer Wahrscheinlichkeit.
 *
 * `music` steht vorn, weil der beobachtete Abruf einer Datei `c=music&a=get`
 * verwendet: Die Oberflaeche behandelt einen Musikordner als eigene Ansicht,
 * und deren Liste wird beim selben Controller liegen.
 */
const LISTE_VERSUCHE = [
  { c: 'music', a: 'browse' },
  { c: 'files', a: 'browse' },
  { c: 'music', a: 'get' },
  { c: 'files', a: 'get' },
  { c: 'music', a: 'list' },
];

const AUDIO_ENDUNG = /\.(?:mp3|m4a|m4b|mp4|aac|mpga)$/i;

/**
 * Ist das ein FRITZ!NAS-Freigabe-Link? Liefert Herkunft und Freigabenummer.
 *
 * Rein und exportiert: Die Erkennung entscheidet, welcher der beiden
 * Import-Wege laeuft, und soll ohne Netz pruefbar sein.
 */
export function istFritzFreigabe(url) {
  let u;
  try { u = url instanceof URL ? url : new URL(url); } catch { return null; }
  if (!/\/nas\/filelink\.lua$/i.test(u.pathname)) return null;
  const id = u.searchParams.get('id');
  if (!id) return null;
  return { herkunft: u.origin, id };
}

/**
 * Die Adresse, unter der der Echo einen Titel laedt.
 *
 * Getrennt und exportiert, weil sie zweimal gebraucht wird: heute vom Import,
 * und spaeter vom Skill, der sie mit frischer `sid` neu baut, statt eine alte
 * gespeicherte zu verwenden.
 */
export function streamUrl(herkunft, sid, pfad) {
  const abfrage = new URLSearchParams({
    script: '/api/data.lua',
    sid,
    c: 'music',
    a: 'get',
    path: pfad,
  });
  return `${herkunft}/nas/cgi-bin/luacgi_notimeout?${abfrage}`;
}

/**
 * Sammelt Sitzungsnummern aus allem, was Schritt 1 hergibt.
 *
 * Wo die `sid` steht, ist nicht garantiert: im Cookie, in der Adresse nach
 * einer Umleitung, im Geruest selbst. Gesucht wird deshalb ueberall nach dem
 * Muster, das eine FRITZ!Box verwendet - sechzehn Hexziffern -, und
 * anschliessend wird jeder Fund an der Box selbst geprueft (Schritt 2). Raten
 * mit Gegenprobe statt Raten.
 */
export function sidKandidaten({ kekse = '', schlussUrl = '', html = '' } = {}) {
  const gefunden = [];
  const merke = (wert) => {
    if (/^[0-9a-f]{16}$/i.test(wert) && wert !== '0000000000000000' && !gefunden.includes(wert)) {
      gefunden.push(wert);
    }
  };
  // Ausdrueckliche sid=-Angaben zuerst: sie sind die wahrscheinlichsten.
  for (const quelle of [schlussUrl, kekse, html]) {
    for (const m of String(quelle).matchAll(/sid["'\s:=]+([0-9a-f]{16})/gi)) merke(m[1]);
  }
  // Danach alles, was wie eine Sitzungsnummer aussieht - ein Cookie heisst
  // nicht zwingend "sid".
  for (const quelle of [kekse, schlussUrl, html]) {
    for (const m of String(quelle).matchAll(/\b([0-9a-f]{16})\b/gi)) merke(m[1]);
  }
  return gefunden;
}

/**
 * Nimmt die Antwort von `data.lua` und macht Titel daraus.
 *
 * Gesucht wird ein Feld mit Eintraegen, die einen `path` tragen - wie es
 * heisst, ist zweitrangig, und `files` ist nur der beobachtete Name. Behalten
 * wird, was die Box als `type: "audio"` fuehrt oder was nach einer Audiodatei
 * heisst; ein Ordner im selben Verzeichnis faellt damit heraus.
 */
export function titelAusListe(daten) {
  const listen = [];
  if (Array.isArray(daten)) listen.push(daten);
  else if (daten && typeof daten === 'object') {
    for (const wert of Object.values(daten)) if (Array.isArray(wert)) listen.push(wert);
  }

  for (const liste of listen) {
    const titel = liste
      .filter(e => e && typeof e === 'object' && typeof e.path === 'string')
      .filter(e => e.type === 'audio' || AUDIO_ENDUNG.test(e.filename || e.path))
      .map(e => ({
        pfad: e.path,
        name: dateiname(e.filename || e.path),
      }));
    if (titel.length) return titel;
  }
  return [];
}

/** "/01 - La-Le-Lu.mp3" -> "01 - La-Le-Lu" (nur fuer die Anzeige). */
function dateiname(pfad) {
  const datei = String(pfad).split('/').filter(Boolean).pop() || '';
  return datei.replace(AUDIO_ENDUNG, '').trim();
}

/**
 * Der ganze Weg: Freigabe-Link hinein, Titel heraus.
 *
 * Liefert `{ titel, hinweise }` oder `{ fehler, bericht }`. Der Bericht sagt
 * Schritt fuer Schritt, was versucht wurde und was zurueckkam - bei einer
 * Schnittstelle ohne Dokumentation ist er die einzige Handhabe, wenn ein
 * FRITZ!OS-Update etwas verschiebt.
 */
export async function importiereFritzOrdner(freigabe, maxTitel) {
  const bericht = [];
  const frist = Date.now() + GESAMT_MS;
  const rest = () => Math.max(400, Math.min(SCHRITT_MS, frist - Date.now()));

  const grund = await zielErlaubt(new URL(freigabe.herkunft));
  if (grund) return { fehler: `Ordner-Link: ${grund}`, bericht };

  // Schritt 1: Sitzung eroeffnen.
  const start = await holeGeruest(freigabe, rest, bericht);
  if (start.fehler) return { fehler: start.fehler, bericht };

  const kandidaten = sidKandidaten(start);
  bericht.push(`Sitzungsnummern gefunden: ${kandidaten.length || 'keine'}`);
  if (!kandidaten.length) {
    return {
      fehler: 'Die Freigabe hat keine Sitzungsnummer herausgegeben. Zeigt der Link auf eine Ordner-Freigabe (nicht auf eine einzelne Datei) und ist sie noch gueltig?',
      bericht,
    };
  }

  // Schritt 2: welche Nummer gilt? Die Box weiss es.
  let sid = null;
  let wurzel = null;
  for (const kandidat of kandidaten.slice(0, 4)) {
    if (Date.now() > frist) break;
    const antwort = await dataLua(freigabe.herkunft, { sid: kandidat, c: 'user', a: 'check_nas_rights' }, rest);
    bericht.push(`check_nas_rights mit …${kandidat.slice(-4)}: ${antwort.kurz}`);
    if (antwort.daten && (antwort.daten.root || antwort.daten.rights)) {
      sid = kandidat;
      wurzel = antwort.daten.root || null;
      break;
    }
  }
  if (!sid) return { fehler: 'Keine der Sitzungsnummern wurde von der FRITZ!Box angenommen.', bericht };
  if (wurzel) bericht.push(`Freigegebener Ordner: ${wurzel}`);

  // Schritt 3: die Dateiliste - Name des Aufrufs unbekannt, also der Reihe nach.
  let titel = [];
  for (const versuch of LISTE_VERSUCHE) {
    if (Date.now() > frist) { bericht.push('Zeit aufgebraucht, bevor alle Aufrufe versucht waren'); break; }
    const antwort = await dataLua(freigabe.herkunft, { sid, ...versuch, path: '/' }, rest);
    titel = antwort.daten ? titelAusListe(antwort.daten) : [];
    bericht.push(`c=${versuch.c}&a=${versuch.a}: ${antwort.kurz}${titel.length ? ` → ${titel.length} Titel` : ''}`);
    if (titel.length) break;
  }
  if (!titel.length) {
    return {
      fehler: 'Die FRITZ!Box hat keine Dateiliste herausgegeben. Der Aufruf dafuer heisst in dieser FRITZ!OS-Version offenbar anders.',
      bericht,
    };
  }

  const gekappt = titel.slice(0, maxTitel);
  const adressen = gekappt.map(t => ({ url: streamUrl(freigabe.herkunft, sid, t.pfad), name: t.name, pfad: t.pfad }));

  // Schritt 4: die erste Adresse so abrufen, wie der Echo es tut - ohne
  // Cookie, mit Range. Ohne diese Gegenprobe waere die Titelliste eine
  // Behauptung.
  const probe = await pruefeStream(adressen[0].url, rest);
  // Der Pfad gehoert in den Bericht: Stimmt an ihm etwas nicht - ein
  // Unterordner, ein Zeichen, das die Box anders schreibt -, sieht man es nur,
  // wenn man ihn sieht.
  bericht.push(`Probe auf "${adressen[0].pfad}": ${probe.kurz}`);
  if (probe.zuLang) {
    bericht.push(
      'Achtung: Diese Datei spielt laenger, als eine FRITZ!NAS-Sitzung gilt. '
      + 'Der Echo laedt sie ueber ihre ganze Dauer nach, und die Sitzungsnummer '
      + 'haelt das moeglicherweise nicht durch. In Kapitel geteilt ist sie auf '
      + 'der sicheren Seite - und "Weiterhoeren" setzt dann an einer sinnvollen '
      + 'Stelle ein statt mitten in einer Stunde.',
    );
  }
  if (!probe.ok) {
    return {
      fehler: `Die Titel wurden gefunden, aber der erste liess sich nicht abrufen (${probe.kurz}). Ohne das wuerde der Echo stumm bleiben.`,
      bericht,
    };
  }

  const hinweise = [
    `${titel.length} Titel im Ordner${wurzel ? ` "${wurzel}"` : ''} gefunden.`,
    'Die Adressen tragen eine Sitzungsnummer der FRITZ!Box. Die laeuft zwar ab, aber der Skill holt sich beim Abspielen selbst eine frische – dafuer muss die Playlist mit "Save Playlist" gespeichert werden, damit der Ordner-Link bei ihr bleibt. Ein erneuter Import ist dann nicht noetig.',
  ];
  if (gekappt.length < titel.length) {
    hinweise.push(`Uebernommen werden die ersten ${maxTitel} – mehr traegt eine Playlist nicht.`);
  }
  if (!probe.range) {
    hinweise.push('Die FRITZ!Box liefert keine Bereichsabrufe – "Alexa, weiter" beginnt den Titel dann von vorn.');
  }
  return { titel: adressen, hinweise, bericht, sid, wurzel };
}

/** Schritt 1: den Freigabe-Link aufrufen und alles einsammeln, was er hergibt. */
async function holeGeruest(freigabe, rest, bericht) {
  let url = new URL(`${freigabe.herkunft}/nas/filelink.lua?id=${encodeURIComponent(freigabe.id)}`);
  let kekse = '';
  for (let hop = 0; hop <= UMLEITUNGEN; hop++) {
    let antwort;
    try {
      antwort = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'User-Agent': 'musik-box-import/1.0',
          ...(kekse ? { Cookie: kekse } : {}),
        },
        signal: AbortSignal.timeout(rest()),
      });
    } catch (err) {
      return { fehler: err?.name === 'TimeoutError' ? 'Die FRITZ!Box antwortet nicht' : 'Die FRITZ!Box ist nicht erreichbar' };
    }

    for (const keks of antwort.headers.getSetCookie?.() || []) {
      kekse = [kekse, keks.split(';')[0]].filter(Boolean).join('; ');
    }

    if ([301, 302, 303, 307, 308].includes(antwort.status)) {
      const ziel = antwort.headers.get('location');
      try { await antwort.body?.cancel(); } catch { /* egal */ }
      if (!ziel) return { fehler: 'Die Freigabe leitet ins Leere um' };
      try { url = new URL(ziel, url); } catch { return { fehler: 'Die Freigabe leitet auf eine ungueltige Adresse um' }; }
      continue;
    }

    if (!antwort.ok) {
      try { await antwort.body?.cancel(); } catch { /* egal */ }
      return { fehler: `Die Freigabe antwortet mit HTTP ${antwort.status}` };
    }
    const html = (await antwort.text()).slice(0, 200000);
    bericht.push(`Freigabe geoeffnet (HTTP ${antwort.status}, ${kekse ? 'Sitzung gesetzt' : 'kein Cookie'})`);
    return { kekse, schlussUrl: url.href, html };
  }
  return { fehler: `Mehr als ${UMLEITUNGEN} Umleitungen` };
}

/**
 * Ein Aufruf an `data.lua`, als Formular wie im Browser.
 *
 * Die Antwort kommt als JSON, manchmal aber mit `text/html` beschriftet -
 * deshalb wird sie geparst und nicht am Inhaltstyp gemessen.
 */
async function dataLua(herkunft, felder, rest) {
  let antwort;
  try {
    antwort = await fetch(`${herkunft}/nas/api/data.lua`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'musik-box-import/1.0',
      },
      body: new URLSearchParams({ xhr: '1', ...felder }).toString(),
      signal: AbortSignal.timeout(rest()),
    });
  } catch (err) {
    return { daten: null, kurz: err?.name === 'TimeoutError' ? 'keine Antwort' : 'nicht erreichbar' };
  }

  let text;
  try { text = (await antwort.text()).slice(0, 300000); } catch { return { daten: null, kurz: 'Antwort unlesbar' }; }
  if (!antwort.ok) return { daten: null, kurz: `HTTP ${antwort.status}` };
  try {
    return { daten: JSON.parse(text), kurz: `HTTP ${antwort.status}, JSON` };
  } catch {
    return { daten: null, kurz: `HTTP ${antwort.status}, kein JSON (${text.slice(0, 60).replace(/\s+/g, ' ')}…)` };
  }
}

/**
 * Schritt 4: derselbe Abruf, den der Echo macht - ohne Cookie, mit Range.
 *
 * **Kommt keine Audiodatei, wird die Antwort mitgelesen.** "HTTP 200,
 * text/html" sagt nur, dass die Box etwas anderes geschickt hat, nicht was:
 * ihre Oberflaeche (dann gilt die Sitzungsnummer nicht), eine Fehlerseite
 * (dann stimmt der Pfad nicht), oder etwas Drittes. Diese eine Zeile spart
 * die Runde, in der jemand den Quelltext von Hand besorgen muss - und ohne
 * sie wird die naechste Vermutung wieder auf eine Vermutung gebaut.
 */
async function pruefeStream(url, rest) {
  let antwort;
  try {
    antwort = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { Range: `bytes=0-${LESEPROBE_BYTES - 1}`, 'User-Agent': 'musik-box-check/1.0' },
      signal: AbortSignal.timeout(rest()),
    });
  } catch (err) {
    return { ok: false, range: false, kurz: err?.name === 'TimeoutError' ? 'keine Antwort' : 'nicht erreichbar' };
  }

  const typ = (antwort.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const range = antwort.status === 206 || (antwort.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');
  const ok = antwort.ok && (/^audio\//.test(typ) || typ === 'application/octet-stream' || typ === '');

  // Die Groesse steht im selben Kopf und kostet nichts. Sie ist beim Import die
  // wertvollste Auskunft ueberhaupt: Eine Datei, die laenger spielt als eine
  // Sitzung gilt, laesst sich hier noch mit einem Satz verhindern - spaeter
  // nur noch mit einer Untersuchung.
  const bytes = groesseAusContentRange(antwort.headers.get('content-range'));

  // Die Leseprobe hat zwei Aufgaben: Bei einer Fehlerseite ist sie der Text,
  // der sagt, was los ist; bei einer Audiodatei steht in ihr der Kopf mit der
  // echten Bitrate. Die Dauer aus der Groesse zu schaetzen hiess frueher, eine
  // mit 320 kbit/s kodierte Datei fuer zweieinhalbmal so lang zu halten, wie
  // sie ist - und genau daran haengt die Warnung weiter unten.
  let auszug = '';
  let sekunden = null;
  if (!ok) {
    try { auszug = textAuszug(await antwort.text()); } catch { /* dann eben ohne */ }
  } else if (kleineAntwort(antwort)) {
    // Nur eine angekuendigt kleine Antwort wird eingelesen: Ein Server, der
    // `Range` ignoriert, schickt die ganze Datei, und die fuer eine Angabe zur
    // Spieldauer zu ziehen waere kein Handel.
    try {
      const kopf = mp3Kopf(new Uint8Array(await antwort.arrayBuffer()));
      sekunden = mp3Dauer(kopf, bytes);
    } catch { /* dann eben ohne Dauer */ }
  } else {
    try { await antwort.body?.cancel(); } catch { /* egal */ }
  }

  return {
    ok,
    range,
    bytes,
    sekunden,
    zuLang: laengerAlsSitzung(bytes, sekunden),
    kurz: `HTTP ${antwort.status}, ${typ || 'ohne Inhaltstyp'}${range ? ', Bereiche' : ''}`
      + (bytes ? `, ${lesbareGroesse(bytes)}` : '')
      + (sekunden !== null ? `, ${genaueDauer(sekunden)}` : '')
      + (auszug ? ` – die Box antwortet: "${auszug}"` : ''),
  };
}

/** Laesst sich diese Antwort gefahrlos ganz einlesen? */
function kleineAntwort(antwort) {
  const laenge = Number(antwort.headers.get('content-length'));
  return Number.isFinite(laenge) && laenge > 0 && laenge <= LESEPROBE_BYTES * 2;
}

/**
 * Der lesbare Kern einer HTML-Antwort: Titel und Text, ohne Markup.
 *
 * Es geht um die Aussage, nicht um die Seite - "Datei nicht gefunden" oder
 * "FRITZ!NAS" genuegt, um zu wissen, woran man ist.
 */
export function textAuszug(html, grenze = 400) {
  const titel = (String(html).match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i)?.[1] || '').trim();
  const text = String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const zusammen = [titel, text].filter(Boolean).join(' – ');
  return zusammen.length > grenze ? `${zusammen.slice(0, grenze)}…` : zusammen;
}

// ---------------------------------------------------------------------------
// Die Sitzungsnummer frisch halten
// ---------------------------------------------------------------------------
//
// **Warum das noetig ist.** Die Adressen oben tragen die `sid`, und eine
// FRITZ!Box vergisst eine Sitzung nach etwa zwanzig Minuten Ruhe. Eine
// Playlist, die sie gespeichert haelt, spielt am Abend des Imports und ist am
// naechsten Morgen stumm - ohne Fehlermeldung, denn aus Sicht des Echos hat
// die Datei einfach nicht geantwortet.
//
// **Warum die gespeicherten Adressen trotzdem bleiben duerfen.** Der Weg zur
// Datei aendert sich nie, nur die Nummer darin. Es genuegt also, beim
// Abspielen `sid=` auszutauschen, statt ein eigenes Datenmodell fuer
// FRITZ!NAS-Titel zu fuehren. Die Playlist bleibt eine Liste von URLs - das
// Formular, die Pruefung und der ganze Rest merken nichts davon.

/**
 * Dieselbe Adresse mit einer anderen Sitzungsnummer.
 *
 * Alles andere bleibt unangetastet: Der Pfad steckt in der Abfrage und traegt
 * Leerzeichen, Kommata und Umlaute, die eine Neukodierung verderben koennte.
 */
export function mitSid(url, sid) {
  let u;
  try { u = new URL(url); } catch { return url; }
  if (!u.searchParams.has('sid')) return url;
  u.searchParams.set('sid', sid);
  return u.href;
}

/**
 * Gilt diese Sitzungsnummer noch? Ein Abruf, der sie nebenbei verlaengert.
 *
 * **Warum das die wichtigere Haelfte ist.** `frischeSid` unten beginnt mit
 * `filelink.lua` ohne Sitzung, und das beendet laut AVM alle bestehenden -
 * auch die, mit der der Echo in diesem Moment einen Titel laedt. Wer nur
 * wissen will, ob die gemerkte Nummer noch taugt, darf diesen Weg deshalb
 * nicht gehen: Er zerstoert genau das, was er pruefen soll.
 *
 * Schritt 2 des Imports kann es ohne diesen Schaden. `check_nas_rights` nimmt
 * die Nummer entgegen, antwortet mit den Rechten - und zaehlt fuer die Box als
 * Zugriff, der die Sitzung um ihre volle Lebensdauer verlaengert. Eine
 * Sitzung, die so alle paar Minuten angefasst wird, laeuft nicht ab, und die
 * Anmeldung, die alles abraeumt, wird zur Ausnahme statt zur Regel.
 *
 * **Drei Antworten, nicht zwei.** "Die Box sagt nein" und "die Box sagt
 * nichts" sind verschiedene Dinge, und der Aufrufer muss sie
 * auseinanderhalten: Auf ein Nein folgt die Anmeldung, auf ein Schweigen nicht
 * - wer nicht erreichbar ist, nimmt auch keine Anmeldung entgegen, und dann
 * ist die gemerkte Nummer das Einzige, was es gibt.
 *
 * @returns {Promise<true|false|null>} gilt / gilt nicht / nicht zu erfahren
 */
export async function sitzungGilt(freigabe, sid, budgetMs = PRUEF_MS) {
  if (!freigabe?.herkunft || !sid) return false;

  const grund = await zielErlaubt(new URL(freigabe.herkunft));
  if (grund) return null;

  const frist = Date.now() + Math.max(600, budgetMs);
  const rest = () => Math.max(300, Math.min(SCHRITT_MS, frist - Date.now()));
  const antwort = await dataLua(freigabe.herkunft, { sid, c: 'user', a: 'check_nas_rights' }, rest);
  // Keine Daten heisst: nicht erreichbar, Zeit abgelaufen oder kein JSON. Die
  // Box hat dann nichts ueber die Nummer gesagt - weder so noch so.
  if (!antwort.daten) return null;
  return Boolean(antwort.daten.root || antwort.daten.rights);
}

/**
 * Eine Sitzungsnummer, die die FRITZ!Box gerade annimmt.
 *
 * Dieselben zwei Schritte wie beim Import - Freigabe oeffnen, Nummer an der
 * Box gegenpruefen -, nur ohne die Dateiliste. Zwei Abrufe, zusammen unter
 * einer Sekunde; der Skill hat acht.
 *
 * **Dieser Aufruf hat einen Preis, und er ist hoeher, als er aussieht.** Der
 * erste Schritt oeffnet `filelink.lua` ohne Sitzung, und AVM schreibt in der
 * Technical Note zu Session-IDs: Ein Zugriff ohne gueltige Sitzung beendet aus
 * Sicherheitsgruenden **alle** bestehenden. Jede Auffrischung wirft also jede
 * andere Wiedergabe aus der Box. Deshalb merkt sich lib/musik.js genau eine
 * Sitzung je Box - mehr gibt es dort nicht - und ruft hier nur, wenn die
 * gemerkte zu einer anderen Freigabe gehoert oder alt ist.
 */
export async function frischeSid(freigabe, budgetMs = SID_MS) {
  const bericht = [];
  // **Die Frist kommt von aussen, weil nur der Aufrufer sie kennt.** Vier
  // Sekunden waren fest verdrahtet und reichten auf einer warmen Function
  // bequem - beim ersten Aufruf nach einer Pause aber nicht: Dann kommen
  // Namensaufloesung und TLS zur langsamen Box noch dazu, der Login lief in
  // sein Limit, und der Skill sagte "Ich komme gerade nicht an die
  // FRITZ!Box". Erst der zweite Versuch klappte - genau das Muster, das
  // gemeldet wurde. Mit dem echten Restbudget sind es rund fuenfeinhalb.
  const frist = Date.now() + Math.max(1200, budgetMs);
  const rest = () => Math.max(400, Math.min(SCHRITT_MS, frist - Date.now()));

  const grund = await zielErlaubt(new URL(freigabe.herkunft));
  if (grund) return { fehler: `Ordner-Link: ${grund}` };

  const start = await holeGeruest(freigabe, rest, bericht);
  if (start.fehler) return { fehler: start.fehler };

  for (const kandidat of sidKandidaten(start).slice(0, 3)) {
    if (Date.now() > frist) break;
    const antwort = await dataLua(freigabe.herkunft, { sid: kandidat, c: 'user', a: 'check_nas_rights' }, rest);
    if (antwort.daten && (antwort.daten.root || antwort.daten.rights)) return { sid: kandidat };
  }
  return { fehler: 'Die FRITZ!Box hat keine gueltige Sitzungsnummer herausgegeben' };
}
