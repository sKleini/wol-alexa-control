// lib/mp3.js – die Spieldauer, wie sie in der Datei steht.
//
// **Warum das sein muss.** Vorher wurde die Dauer aus der Dateigroesse
// geschaetzt, mit angenommenen 128 kbit/s. Bei einem mit 320 kbit/s
// kodierten Hoerbuch ist das um den Faktor zweieinhalb daneben: 14 MB sahen
// nach einer Viertelstunde aus und sind in Wahrheit knapp sechs Minuten. Eine
// Zahl, die so falsch sein kann, ist schlimmer als keine - man richtet sich
// danach.
//
// Die Wahrheit steht in den ersten Bytes der Datei: MP3 traegt vor jedem
// Block einen vier Byte langen Kopf mit Bitrate und Abtastrate, und
// variabel kodierte Dateien tragen im ersten Block zusaetzlich die Anzahl
// aller Bloecke (Xing/Info bzw. VBRI). Damit ist die Dauer nicht geschaetzt,
// sondern gerechnet - und die Leseprobe dafuer ist ein paar Kilobyte gross.
//
// **Warum ein eigenes Modul.** lib/groesse.js rechnet und formatiert; hier
// wird ein Dateiformat gelesen. Beides in einer Datei haette zwei sehr
// verschiedene Arten von Code vermischt, und die Bitschieberei unten will
// einzeln pruefbar sein.

/** So viel vom Dateianfang genuegt, um den ersten Block zu finden. */
export const LESEPROBE_BYTES = 32 * 1024;

// Bitraten in kbit/s, indiziert wie im Kopf (0 = frei, 15 = ungueltig).
const BITRATEN = {
  // MPEG 1
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  // MPEG 2 und 2.5
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};

/** Abtastraten je Version, indiziert wie im Kopf. */
const RATEN = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

/** Wie viele Tonproben in einem Block stecken - die halbe Miete der Rechnung. */
function probenJeBlock(version, layer) {
  if (layer === 1) return 384;
  if (layer === 2) return 1152;
  return version === 1 ? 1152 : 576; // Layer III
}

/**
 * Wo die Tondaten anfangen: hinter einem ID3v2-Etikett, falls eines davorsteht.
 *
 * **Und das kann gross sein.** Ein eingebettetes Titelbild schiebt den ersten
 * Block gern hundert Kilobyte nach hinten - mehr, als eine Leseprobe fasst.
 * Deshalb gibt diese Funktion die Stelle heraus, auch wenn die Probe gar nicht
 * so weit reicht: Der Aufrufer kann dann gezielt dort nachlesen, statt die
 * Dauer aufzugeben.
 *
 * Die Laenge steht in vier "syncsafe" Bytes - je sieben Bit, damit im Etikett
 * nie ein Muster entsteht, das wie ein Blockanfang aussieht.
 */
export function tondatenAb(daten) {
  const d = daten || [];
  if (d.length < 10) return 0;
  if (d[0] !== 0x49 || d[1] !== 0x44 || d[2] !== 0x33) return 0; // "ID3"
  const laenge = ((d[6] & 0x7f) << 21) | ((d[7] & 0x7f) << 14) | ((d[8] & 0x7f) << 7) | (d[9] & 0x7f);
  const fuss = (d[5] & 0x10) ? 10 : 0; // Flag "footer present"
  return 10 + laenge + fuss;
}

/** Der Kopf an genau dieser Stelle - oder null, wenn dort keiner steht. */
function kopfAn(d, i) {
  if (i + 4 > d.length) return null;
  if (d[i] !== 0xff || (d[i + 1] & 0xe0) !== 0xe0) return null;

  const versionBits = (d[i + 1] >> 3) & 3;
  const layerBits = (d[i + 1] >> 1) & 3;
  if (versionBits === 1 || layerBits === 0) return null; // reserviert
  const version = versionBits === 3 ? 1 : (versionBits === 2 ? 2 : 2.5);
  const layer = 4 - layerBits;

  const kbit = BITRATEN[`${version === 1 ? 1 : 2}-${layer}`][(d[i + 2] >> 4) & 0xf];
  const hz = RATEN[version][(d[i + 2] >> 2) & 3];
  if (!kbit || !hz) return null; // freie oder ungueltige Bitrate

  const polster = (d[i + 2] >> 1) & 1;
  const proben = probenJeBlock(version, layer);
  // Blocklaenge: Layer I zaehlt in Vierergruppen, alle anderen in Bytes.
  const laenge = layer === 1
    ? (Math.floor((12 * kbit * 1000) / hz) + polster) * 4
    : Math.floor((proben / 8 * kbit * 1000) / hz) + polster;

  const mono = ((d[i + 3] >> 6) & 3) === 3;
  return { version, layer, kbit, hz, proben, laenge, mono, ab: i };
}

/**
 * Der erste Block der Datei, samt Blockzahl, wenn die Datei sie nennt.
 *
 * **Ein Kopf allein genuegt nicht als Beweis.** Das Muster aus elf gesetzten
 * Bits kommt in Bilddaten und Etiketten auch zufaellig vor. Deshalb gilt ein
 * Fund erst, wenn an der errechneten Stelle des naechsten Blocks wieder einer
 * steht - oder die Probe dort zu Ende ist.
 *
 * @returns {{kbit:number,hz:number,proben:number,bloecke:number|null,ab:number,vbr:boolean}|null}
 */
export function mp3Kopf(daten, abStelle = null) {
  const d = daten || [];
  const start = abStelle === null ? tondatenAb(d) : abStelle;
  if (start >= d.length) return null;

  for (let i = start; i < d.length - 4; i++) {
    const kopf = kopfAn(d, i);
    if (!kopf) continue;
    const naechster = i + kopf.laenge;
    if (naechster + 4 <= d.length && !kopfAn(d, naechster)) continue; // Zufallstreffer

    const zaehlung = bloeckeAusKopf(d, kopf);
    return {
      kbit: kopf.kbit,
      hz: kopf.hz,
      proben: kopf.proben,
      bloecke: zaehlung.bloecke,
      vbr: zaehlung.vbr,
      ab: i,
    };
  }
  return null;
}

/**
 * Die Blockzahl aus dem Xing-, Info- oder VBRI-Eintrag des ersten Blocks.
 *
 * Nur mit ihr stimmt die Dauer einer variabel kodierten Datei: Deren erster
 * Block sagt nichts ueber die spaeteren, und die Rechnung "Groesse durch
 * Bitrate" waere Zufall. `Info` ist derselbe Eintrag in einer fest kodierten
 * Datei - dann ist die Zahl eine Bestaetigung, keine Rettung.
 */
function bloeckeAusKopf(d, kopf) {
  const lies32 = (i) => (i + 4 <= d.length ? ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0 : null);
  const tag = (i, wort) => wort.split('').every((z, n) => d[i + n] === z.charCodeAt(0));

  // Xing/Info stehen hinter den Seiteninformationen, deren Laenge von Version
  // und Kanalzahl abhaengt.
  const seite = kopf.version === 1 ? (kopf.mono ? 17 : 32) : (kopf.mono ? 9 : 17);
  const x = kopf.ab + 4 + seite;
  if (x + 12 <= d.length && (tag(x, 'Xing') || tag(x, 'Info'))) {
    const flaggen = lies32(x + 4);
    if (flaggen !== null && (flaggen & 1)) {
      const bloecke = lies32(x + 8);
      if (bloecke) return { bloecke, vbr: tag(x, 'Xing') };
    }
    return { bloecke: null, vbr: tag(x, 'Xing') };
  }

  // VBRI (Fraunhofer) steht immer an derselben Stelle.
  const v = kopf.ab + 4 + 32;
  if (v + 18 <= d.length && tag(v, 'VBRI')) {
    const bloecke = lies32(v + 14);
    if (bloecke) return { bloecke, vbr: true };
  }
  return { bloecke: null, vbr: false };
}

/**
 * Die Spieldauer in Sekunden - gerechnet, nicht geraten.
 *
 * Zwei Wege, und der erste ist der genaue: Kennt die Datei ihre Blockzahl,
 * ergibt sich die Dauer allein aus ihr und der Abtastrate. Sonst zaehlt die
 * Bitrate des ersten Blocks, was bei fest kodierten Dateien - der Regel - auf
 * die Sekunde hinkommt. Abgezogen wird das Etikett, damit ein Titelbild nicht
 * als Musik zaehlt.
 */
export function mp3Dauer(kopf, dateiBytes) {
  if (!kopf) return null;
  if (kopf.bloecke) return (kopf.bloecke * kopf.proben) / kopf.hz;
  if (!dateiBytes || dateiBytes <= kopf.ab) return null;
  return ((dateiBytes - kopf.ab) * 8) / (kopf.kbit * 1000);
}
