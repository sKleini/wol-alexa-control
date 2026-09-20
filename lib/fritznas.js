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
 * Leerzeichen als `%20`, nicht als `+`.
 *
 * **Warum das ueberhaupt eine Frage ist.** `URLSearchParams` schreibt ein
 * Leerzeichen als `+` - so will es das Formular-Format, und die FRITZ!Box
 * versteht es auch: Der Echo spielt damit tadellos. Ein anderer Abspieler
 * muss es aber nicht verstehen. `+` heisst nur im Formular-Format
 * "Leerzeichen"; in einer Adresse ist es sonst ein ganz gewoehnliches
 * Zeichen, und wer die Abfrage nach eigenen Regeln neu zusammensetzt, macht
 * daraus schnell ein `%2B` und sucht anschliessend eine Datei, die
 * `01.+Die+Buehne.mp3` heisst.
 *
 * `%20` ist in beiden Lesarten dasselbe und dekodiert zum identischen Pfad -
 * die engere Wahl, und sie kostet nichts.
 *
 * Ein `+`, das wirklich im Dateinamen steht, hat `URLSearchParams` vorher
 * schon zu `%2B` gemacht. Jedes verbliebene `+` ist also ein Leerzeichen.
 */
const alsProzent = (abfrage) => String(abfrage).replace(/\+/g, '%20');

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
  return `${herkunft}/nas/cgi-bin/luacgi_notimeout?${alsProzent(abfrage)}`;
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
    // Ohne `status`: Es gab keine Antwort, ueber die sich etwas sagen liesse.
    return { daten: null, status: null, kurz: err?.name === 'TimeoutError' ? 'keine Antwort' : 'nicht erreichbar' };
  }

  let text;
  try { text = (await antwort.text()).slice(0, 300000); } catch { return { daten: null, status: null, kurz: 'Antwort unlesbar' }; }
  if (!antwort.ok) return { daten: null, status: antwort.status, kurz: `HTTP ${antwort.status}` };
  try {
    return { daten: JSON.parse(text), status: antwort.status, kurz: `HTTP ${antwort.status}, JSON` };
  } catch {
    return { daten: null, status: antwort.status, kurz: `HTTP ${antwort.status}, kein JSON (${text.slice(0, 60).replace(/\s+/g, ' ')}…)` };
  }
}

/**
 * Was eine Antwort auf `check_nas_rights` ueber die Sitzungsnummer aussagt.
 *
 * **Drei Ausgaenge, und der mittlere ist neu.** Gemeldet war diese Zeile:
 *
 *   musik-box FRITZ!NAS-Sitzung nachgefragt: ohne Antwort (HTTP 303) nach 753 ms
 *
 * Eine Umleitung ist kein Schweigen. Sie ist die Box, die sagt "diese Nummer
 * kenne ich nicht, geh zur Anmeldung" - also ein Nein. Als "nicht zu erfahren"
 * verbucht, konnte der Skill innerhalb seiner Frist damit losspielen, und der
 * Echo bekam die Anmeldeseite statt der Datei: genau das gemeldete "Ich spiele
 * …", dann Stille.
 *
 * **Ein 5xx bleibt trotzdem "unklar".** Dort ist die Box ueberlastet oder
 * kaputt, und das sagt nichts ueber die Nummer. Sie deswegen fuer tot zu
 * erklaeren hiesse, sich mitten in einer laufenden Wiedergabe anzumelden - und
 * eine Anmeldung beendet alle Sitzungen der Box. Der Schutz, um den es bei
 * "Schweigen ist kein Nein" ging, bleibt damit genau dort erhalten, wo er
 * gemeint war.
 *
 * Rein und exportiert, damit die Unterscheidung ohne FRITZ!Box pruefbar ist.
 *
 * @returns {true|false|null} gilt / ist tot / nicht zu erfahren
 */
export function sitzungsUrteil(status, daten) {
  if (daten) return Boolean(daten.root || daten.rights);
  // Keine Antwort, kein Status: Die Box hat nichts gesagt.
  if (!Number.isFinite(status)) return null;
  // Die Box ist unwohl - eine Auskunft ueber die Nummer ist das nicht.
  if (status >= 500) return null;
  // Alles andere ist die Box, die diese Nummer nicht annimmt: eine Umleitung
  // auf die Anmeldung, ein Fehlerstatus, oder ihre Oberflaeche als HTML.
  return false;
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
 * **Hier stand, alles andere bleibe unangetastet. Das stimmte nicht.**
 * `searchParams.set` markiert die Abfrage als geaendert, und `href` setzt sie
 * danach vollstaendig neu zusammen - jeder Wert wird neu kodiert. Beim Pfad
 * hiess das: Ein `%20` aus dem Import kam als `+` wieder heraus. Genau die
 * Schreibweise, die der Import seit `alsProzent` vermeidet, hat diese Funktion
 * also hinterher wieder eingesetzt, und zwar bei jedem Abspielen.
 *
 * Die Neukodierung selbst ist harmlos - sie ist verlustfrei, der Pfad
 * dekodiert zum selben Text. Nur die Schreibweise der Leerzeichen wird danach
 * wieder geradegezogen, damit beide Wege dieselbe Adresse ergeben.
 */
export function mitSid(url, sid) {
  let u;
  try { u = new URL(url); } catch { return url; }
  if (!u.searchParams.has('sid')) return url;
  u.searchParams.set('sid', sid);
  u.search = alsProzent(u.searchParams.toString());
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
 * **Und der Grund kommt mit.** "Nicht zu erfahren" hat drei Ursachen - nicht
 * erreichbar, Zeit abgelaufen, keine lesbare Antwort -, und sie sind
 * verschieden viel wert. `dataLua` kennt den Unterschied ohnehin; ihn hier
 * wegzuwerfen hat eine Fehlersuche eine Runde gekostet, weil im Log nur
 * "ohne Antwort" stand.
 *
 * **Und wozu die Nummer gehoert, kommt mit.** `check_nas_rights` antwortet
 * mit `root` - dem Ordner, den die Freigabe dieser Sitzung freigibt. Diese
 * Auskunft wurde hier weggeworfen, und sie ist die Haelfte der Frage: Eine
 * Sitzung, die zu einer **anderen** Freigabe gehoert, lebt genauso und
 * antwortet genauso freundlich - nur gibt sie die Datei nicht heraus, deren
 * Pfad in der Adresse steht. Genau dieses Muster ist gemeldet: `data.lua`
 * sagt "gilt noch", und der Echo bekommt die Datei trotzdem nicht.
 *
 * @returns {Promise<{gilt: true|false|null, kurz: string, wurzel: string|null}>}
 *   gilt / gilt nicht / nicht zu erfahren, dazu in einem Wort, was die Box
 *   gesagt hat, und der Ordner, auf den die Nummer Zugriff gibt
 */
export async function sitzungGilt(freigabe, sid, budgetMs = PRUEF_MS) {
  if (!freigabe?.herkunft || !sid) return { gilt: false, kurz: 'keine Nummer', wurzel: null };

  const grund = await zielErlaubt(new URL(freigabe.herkunft));
  if (grund) return { gilt: null, kurz: grund, wurzel: null };

  const frist = Date.now() + Math.max(600, budgetMs);
  const rest = () => Math.max(300, Math.min(SCHRITT_MS, frist - Date.now()));
  const antwort = await dataLua(freigabe.herkunft, { sid, c: 'user', a: 'check_nas_rights' }, rest);
  return {
    gilt: sitzungsUrteil(antwort.status, antwort.daten),
    kurz: antwort.kurz,
    wurzel: typeof antwort.daten?.root === 'string' ? antwort.daten.root : null,
  };
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
export async function frischeSid(freigabe, budgetMs = SID_MS, ohneGegenprobe = false) {
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

  const kandidaten = sidKandidaten(start);

  // **Ohne Gegenprobe: die erste Nummer nehmen und losspielen.**
  //
  // Die Anmeldung sind zwei Wege zur Box - das Geruest holen und die Nummer
  // gegenpruefen -, und gemessen kostet sie zusammen 1400 bis 2600 ms. Vor
  // dem ersten Ton ist das der groesste Posten ueberhaupt, und die Zeit
  // entscheidet dort daruber, ob der Echo die Direktive ueberhaupt ausfuehrt:
  //
  //   spielt:  1519, 1868, 2039, 2447, 2524 ms
  //   stumm:   3271, 3683, 3846, 4537, 5204, 5771 ms
  //
  // Die Gegenprobe ist dabei die entbehrlichere Haelfte. `sidKandidaten`
  // stellt die ausdruecklichen `sid=`-Angaben nach vorn, und die stammen aus
  // der Antwort, die die Box **gerade** auf diese Anmeldung gegeben hat - sie
  // ist der wahrscheinlichste Kandidat, nicht ein geratener.
  //
  // **Und ein Irrtum traegt sich selbst.** Ist die Nummer doch falsch, bekommt
  // der Echo die Anmeldeseite, meldet `PlaybackFailed`, und dieser Request hat
  // frische acht Sekunden und eine warme Function: Dort wird die Sitzung
  // erzwungen geprueft und derselbe Titel wiederholt. Derselbe Weg, der im
  // Betrieb schon einen `MEDIA_ERROR_SERVICE_UNAVAILABLE` aufgefangen hat -
  // PlaybackStarted 18 ms nach dem zweiten Anlauf.
  if (ohneGegenprobe && kandidaten.length) {
    return { sid: kandidaten[0], ohneGegenprobe: true };
  }

  for (const kandidat of kandidaten.slice(0, 3)) {
    if (Date.now() > frist) break;
    const antwort = await dataLua(freigabe.herkunft, { sid: kandidat, c: 'user', a: 'check_nas_rights' }, rest);
    if (antwort.daten && (antwort.daten.root || antwort.daten.rights)) {
      return { sid: kandidat, wurzel: typeof antwort.daten.root === 'string' ? antwort.daten.root : null };
    }
  }
  return { fehler: 'Die FRITZ!Box hat keine gueltige Sitzungsnummer herausgegeben' };
}

// ---------------------------------------------------------------------------
// Die Datei antippen, bevor der Echo sie verlangt
// ---------------------------------------------------------------------------
//
// **Was der Skill bisher nie angefasst hat: die Datei selbst.** Der ganze Weg
// oben beschafft eine Sitzungsnummer und prueft sie mit `check_nas_rights` -
// ein Aufruf, den die Box aus dem Kopf beantwortet. Die MP3 liegt aber auf
// ihrer Platte, und eine Platte an einer FRITZ!Box schlaeft nach ein paar
// Minuten Ruhe ein. Der erste Abruf danach wartet, bis sie wieder dreht.
//
// Genau das ist das gemeldete Muster: Nach einer laengeren Pause bleibt der
// erste Versuch stumm, der zweite spielt - mit **derselben** Sitzungsnummer,
// derselben Adresse und demselben Offset. Am Skill kann es dann nicht liegen;
// die Antwort ist in beiden Faellen Byte fuer Byte dieselbe. Was der erste
// Versuch geaendert hat, ist die Platte: Der Abruf des Echos hat sie
// aufgeweckt, ist dabei selbst in Alexas Ladefrist gelaufen - und der zweite
// fand sie wach vor.
//
// Also tippt der Skill die Datei vor der Antwort einmal selbst an: ein
// Bereichsabruf ueber die ersten zweiunddreissig Kilobyte, genau die Adresse,
// die gleich in der Direktive steht. Er dauert, was er dauert, wird nach ein
// paar Sekunden abgebrochen - und lange bevor er fertig ist, dreht die Platte.
// Der Echo findet sie dann wach vor, so wie es sonst erst der zweite Versuch
// tat.
//
// **Warum es nicht bei dem einen Byte von frueher bleibt.** Gemeldet war ein
// Abend, an dem der Weckruf siebzehnmal "HTTP 206, audio/mpeg" meldete und
// der Echo siebzehnmal an derselben Adresse scheiterte. Geprueft war damit
// nur, dass die Box einen Kopf schickt - fuer ein einziges Byte muss sie die
// Platte kaum anfassen. Ob danach Tondaten kommen, stand nirgends. Jetzt wird
// gelesen, was gelesen werden kann, und die Zahl steht im Log.
//
// **Abgebrochen heisst nicht umsonst.** Das Aufwecken passiert im Betriebs-
// system der Box, nicht in dieser Verbindung; sie darf zumachen, sobald der
// Weckruf unten ist. Wichtiger ist, dass er *vor* der Antwort zumacht: Zwei
// gleichzeitige Abrufe auf `luacgi_notimeout` sind fuer diese Hardware viel
// (siehe die Drosselung der URL-Pruefung), und der zweite waere ausgerechnet
// der des Echos.

/** Der Weckruf darf spuerbar dauern - aber nicht Alexas Fenster aufbrauchen. */
const WECK_MS = 2500;

/**
 * Was die Antwort auf den Weckruf ueber die Datei aussagt.
 *
 * Zwei Fragen, und sie sind nicht dieselbe: **Kam Ton?** und **war es eine
 * Absage?** Eine Zeitueberschreitung ist keine Absage - sie ist der Normalfall
 * bei einer Platte, die gerade anlaeuft, und sie ist der Grund, warum es den
 * Weckruf ueberhaupt gibt. Eine Fehlerseite, eine Umleitung auf die Anmeldung
 * oder HTML statt Audio ist dagegen eine: Dann bekommt der Echo gleich
 * dasselbe, und ein "Ich spiele …" waere ein Versprechen ins Leere.
 *
 * Rein und exportiert, damit diese Unterscheidung ohne FRITZ!Box pruefbar ist.
 */
export function weckUrteil(status, contentType) {
  const typ = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ok = status >= 200 && status < 300
    && (/^audio\//.test(typ) || typ === 'application/octet-stream' || typ === '');
  return { ok, typ };
}

/**
 * Die Datei antippen - und nachsehen, ob wirklich Ton kommt.
 *
 * Liefert `{ ok, endgueltig, ms, bytes, kurz }`. `endgueltig: false` heisst
 * "die Box hat nichts gesagt" - keine Antwort in der Frist, nicht erreichbar,
 * Ziel nicht erlaubt, oder ein Kopf, auf den in der Frist keine Tondaten
 * folgten. Der Aufrufer spielt dann trotzdem los: Der Weckruf hat seine
 * Arbeit getan, und die Platte dreht, wenn der Echo fragt.
 *
 * `endgueltig: true` bei `ok: false` ist dagegen ein Nein der Box - eine
 * Fehlerseite, die Anmeldeseite, ein Status, der keine Datei ankuendigt. Dann
 * bekommt der Echo gleich dasselbe, und ein "Ich spiele ..." waere ein
 * Versprechen ins Leere.
 */
export async function weckeStream(url, budgetMs = WECK_MS) {
  const begonnen = Date.now();
  const seit = () => Date.now() - begonnen;

  // Dieselbe Grenze wie fuer jeden anderen Abruf, den der Server im Auftrag
  // des Dashboards macht - die Adresse kommt aus einer gespeicherten Playlist.
  let ziel;
  try { ziel = new URL(url); } catch { return { ok: false, endgueltig: false, ms: 0, bytes: 0, kurz: 'keine Adresse' }; }
  const grund = await zielErlaubt(ziel);
  if (grund) return { ok: false, endgueltig: false, ms: seit(), bytes: 0, kurz: grund };

  const frist = Math.max(400, Math.min(WECK_MS, budgetMs));
  let antwort;
  try {
    antwort = await fetch(ziel, {
      method: 'GET',
      // **Derselbe Bereich, den ein Abspieler zuerst holt** - nicht mehr das
      // eine Byte von frueher. Der Unterschied ist die Platte: Ein Byte kann
      // die Box aus dem Kopf beantworten, sobald sie die Datei geoeffnet hat;
      // fuer zweiunddreissig Kilobyte muss sie wirklich lesen.
      headers: { Range: `bytes=0-${LESEPROBE_BYTES - 1}`, 'User-Agent': 'musik-box-weckruf/1.0' },
      signal: AbortSignal.timeout(frist),
    });
  } catch (err) {
    return {
      ok: false,
      endgueltig: false,
      ms: seit(),
      bytes: 0,
      kurz: err?.name === 'TimeoutError' ? `keine Antwort in ${frist} ms – die Platte laeuft an` : 'nicht erreichbar',
    };
  }

  const kopfMs = seit();
  const { ok: kopfOk, typ } = weckUrteil(antwort.status, antwort.headers.get('content-type'));

  // Schickt die Box etwas anderes als Ton, steht die Auskunft im Text - eine
  // Fehlerseite sagt, was sie nicht mag, und die Anmeldeseite sagt ihren Namen.
  if (!kopfOk) {
    let auszug = '';
    try { auszug = textAuszug(await antwort.text(), 160); } catch { /* dann eben ohne */ }
    return {
      ok: false,
      endgueltig: true,
      ms: seit(),
      bytes: 0,
      kurz: `HTTP ${antwort.status}, ${typ || 'ohne Inhaltstyp'}${auszug ? ` – die Box antwortet: "${auszug}"` : ''}`,
    };
  }

  const gelesen = await erstesStueck(antwort, frist - kopfMs);
  return {
    // **Ein Kopf ohne Tondaten ist kein Ja.** Genau daran hing eine
    // Fehlersuche: Der Weckruf meldete siebzehnmal "HTTP 206, audio/mpeg",
    // und der Echo scheiterte jedes Mal an derselben Adresse. Gemessen war
    // aber nur, dass die Box den Kopf schickt - ob danach etwas kommt, hat
    // niemand nachgesehen.
    ok: gelesen.bytes > 0,
    // Keine Daten in der Frist ist keine Absage: Das ist die Platte, die
    // anlaeuft - der Fall, fuer den es den Weckruf gibt.
    endgueltig: gelesen.bytes > 0,
    ms: seit(),
    bytes: gelesen.bytes,
    kurz: `HTTP ${antwort.status}, ${typ || 'ohne Inhaltstyp'}, Kopf nach ${kopfMs} ms`
      + (gelesen.bytes > 0
        ? `, ${Math.round(gelesen.bytes / 1024)} KB Ton`
        : `, aber keine Tondaten${gelesen.abgebrochen ? ' in der Frist' : ' – die Box schliesst nach dem Kopf'}`),
  };
}

/**
 * Das erste Stueck der Antwort wirklich lesen - und dann Schluss.
 *
 * Gelesen wird bis `LESEPROBE_BYTES` oder bis die Frist um ist, je nachdem,
 * was zuerst kommt; der Rest wird verworfen. Zwei gleichzeitige Abrufe auf
 * `luacgi_notimeout` sind fuer diese Hardware viel, und der zweite waere
 * gleich der des Echos - die Leitung wird deshalb so frueh wie moeglich
 * wieder frei.
 */
async function erstesStueck(antwort, budgetMs) {
  const leser = antwort.body?.getReader?.();
  if (!leser) return { bytes: 0, abgebrochen: false };
  // **Die Frist gehoert an das Lesen, nicht nur an den Abruf.** Ein Stream,
  // auf dem nichts mehr kommt, laesst `read()` warten, solange ihn niemand
  // abbricht - und der Weckruf haette Alexas Fenster verbraucht, ohne je eine
  // Zeile zu schreiben. Ein Wecker fuer die ganze Schleife, nicht einer je
  // Stueck: Was hier zaehlt, ist die Zeit bis zum letzten gelesenen Byte.
  const wecker = nachFrist(Math.max(100, budgetMs));
  let bytes = 0;
  let abgebrochen = false;
  try {
    while (bytes < LESEPROBE_BYTES) {
      const stueck = await Promise.race([leser.read(), wecker]);
      if (stueck === ZEIT_AUS) { abgebrochen = true; break; }
      if (stueck.done) break;
      bytes += stueck.value?.length || 0;
    }
  } catch {
    // Zeitueberschreitung oder abgebrochene Verbindung: Was gelesen wurde,
    // zaehlt trotzdem - es ist die Auskunft, dass die Box liefert.
    abgebrochen = true;
  }
  try { await leser.cancel(); } catch { /* egal */ }
  return { bytes, abgebrochen };
}

/** Das Zeichen dafuer, dass die Frist vor den Daten da war. */
const ZEIT_AUS = Symbol('Zeit aus');

/** Ein Versprechen, das nach `ms` mit `ZEIT_AUS` faellig wird - und den Timer
 *  nicht als Grund nimmt, die Function am Leben zu halten. */
function nachFrist(ms) {
  return new Promise((fertig) => {
    const uhr = setTimeout(() => fertig(ZEIT_AUS), ms);
    uhr.unref?.();
  });
}
