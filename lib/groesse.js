// lib/groesse.js – wie gross eine Datei ist und wie lange sie spielt.
//
// **Warum ein eigenes Modul.** Diese Funktionen brauchen zwei Seiten: die
// Pruefung in lib/musik.js und die Stichprobe beim Import in lib/fritznas.js.
// musik.js importiert fritznas.js bereits - haette fritznas.js sie von dort
// geholt, waere daraus ein Kreis geworden, der heute zufaellig traegt und beim
// naechsten Umbau bricht. Dasselbe Muster wie lib/netz.js.

// ---------------------------------------------------------------------------
// Wie gross ist die Datei, und reicht die Sitzung fuer ihre Spieldauer?
// ---------------------------------------------------------------------------

/**
 * Wie lange eine FRITZ!NAS-Sitzung traegt.
 *
 * AVM gewaehrt zehn Minuten, verlaengert durch jeden aktiven Zugriff. Ob ein
 * laufender Stream als solcher zaehlt, ist nicht zugesichert - deshalb ist das
 * hier die Zahl, gegen die gewarnt wird, und nicht die zwanzig Minuten, nach
 * denen die Box eine *ruhende* Sitzung vergisst.
 */
const SITZUNG_MINUTEN = 10;

/** Womit gerechnet wird, wenn die echte Bitrate unbekannt ist. */
const ANNAHME_KBIT = 128;

/**
 * Die Gesamtgroesse aus dem `Content-Range`-Kopf.
 *
 * **Sie kostet nichts.** Auf `Range: bytes=0-0` antwortet ein Server mit
 * `Content-Range: bytes 0-0/52428800` - die Zahl hinter dem Schraegstrich ist
 * die ganze Datei. Bisher wurde dieser Kopf weggeworfen, und damit die einzige
 * Angabe, an der sich ein Hoerspiel von einem Kinderlied unterscheiden laesst.
 *
 * `null` heisst "nicht genannt", und das ist selbst ein Befund: Ein
 * Abspielgeraet, das die Laenge nicht kennt, tut sich schwer.
 */
export function groesseAusContentRange(wert) {
  const treffer = /^bytes\s+\d+\s*-\s*\d+\s*\/\s*(\d+)$/i.exec(String(wert ?? '').trim());
  if (!treffer) return null;
  const bytes = Number(treffer[1]);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

/** "48,2 MB" - zum Lesen, nicht zum Rechnen. */
export function lesbareGroesse(bytes) {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1).replace('.', ',') : Math.round(mb)} MB`;
}

/**
 * Wie lange die Datei ungefaehr spielt.
 *
 * **Eine Schaetzung, und sie sagt das auch.** Die echte Bitrate steht nur in
 * der Datei selbst, und die dafuer zu laden waere teurer als die Auskunft wert
 * ist. Gerechnet wird mit 128 kbit/s; bei einem hoeher kodierten Stueck faellt
 * die Zahl zu gross aus, bei einem Hoerspiel mit 64 kbit/s zu klein.
 */
export function spieldauerSekunden(bytes, kbit = ANNAHME_KBIT) {
  const genau = spieldauerGenau(bytes, kbit);
  return genau === null ? null : Math.round(genau);
}

/**
 * Dieselbe Rechnung, ungerundet.
 *
 * **Die Rundung gehoert in die Anzeige, nicht in einen Vergleich.** Sonst
 * entscheidet sie ueber die Warnung: Eine Datei knapp ueber der Grenze ergaebe
 * gerundet genau die Grenze, und "groesser als" waere falsch.
 */
function spieldauerGenau(bytes, kbit = ANNAHME_KBIT) {
  if (!bytes || !kbit) return null;
  return (bytes * 8) / (kbit * 1000);
}

/** "etwa 52 Minuten" */
export function lesbareDauer(sekunden) {
  if (sekunden === null || sekunden === undefined) return null;
  if (sekunden < 90) return `${sekunden} Sekunden`;
  const minuten = Math.round(sekunden / 60);
  if (minuten < 90) return `${minuten} Minuten`;
  const stunden = Math.floor(minuten / 60);
  const rest = minuten % 60;
  return rest ? `${stunden} Std. ${rest} Min.` : `${stunden} Stunden`;
}

/**
 * Laeuft die Datei laenger, als die Sitzungsnummer gilt?
 *
 * **Das ist die Frage, die bei kurzen Liedern nie aufkommt.** Der Echo laedt
 * eine grosse Datei ueber ihre ganze Spieldauer in Bereichen nach, und jede
 * dieser Anfragen traegt dieselbe Sitzungsnummer. Haelt die nicht durch, bricht
 * die Wiedergabe mittendrin ab - oder beginnt gar nicht erst.
 *
 * Gewarnt wird nur, wenn es selbst bei **hoher** Bitrate (320 kbit/s, also der
 * kuerzesten plausiblen Spieldauer) nicht reicht. So steht hinter der Warnung
 * eine Gewissheit und keine Annahme; eine Datei knapp darunter bleibt
 * unauffaellig, obwohl sie es vielleicht auch nicht schafft.
 */
export function laengerAlsSitzung(bytes) {
  const kuerzesteDauer = spieldauerGenau(bytes, 320);
  return kuerzesteDauer !== null && kuerzesteDauer > SITZUNG_MINUTEN * 60;
}

/**
 * Eine Adresse fuers Log - ohne den Schluessel, der darin steckt.
 *
 * Die Sitzungsnummer ist ein Zugangsrecht zur FRITZ!Box und gehoert nicht
 * vollstaendig in ein Protokoll, das andere lesen koennen. Die letzten vier
 * Stellen reichen, um zwei Laeufe auseinanderzuhalten, und verraten nichts.
 */
export function adresseKurz(url) {
  let u;
  try { u = new URL(url); } catch { return '(keine gueltige Adresse)'; }
  const sid = u.searchParams.get('sid');
  return `${u.host}${u.pathname} ${sid ? `sid…${sid.slice(-4)}` : 'ohne sid'}`;
}

/** Die Ladegeschwindigkeit einer Leseprobe, in Kilobyte je Sekunde. */
export function datenrateKbs(bytes, dauerMs) {
  if (!bytes || !dauerMs || dauerMs <= 0) return null;
  return Math.round(bytes / 1024 / (dauerMs / 1000));
}
