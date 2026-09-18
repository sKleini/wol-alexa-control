// test/mp3.test.mjs – der Kopf einer MP3-Datei, ohne Netz und ohne Datei.
//
// Die Bloecke hier sind von Hand gebaut, Bit fuer Bit. Das ist Absicht: Eine
// echte MP3 mitzuliefern hiesse, eine Binaerdatei zu pflegen, deren Inhalt
// niemand nachsehen kann - hier steht jeder Wert im Klartext daneben.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mp3Kopf, mp3Dauer, tondatenAb } from '../lib/mp3.js'
import { genaueDauer, lesbareDauer, spieldauerSekunden, laengerAlsSitzung } from '../lib/groesse.js'

const BITRATEN_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const RATEN_V1 = [44100, 48000, 32000];

/** Vier Bytes Kopf, wie sie vor jedem Block stehen (MPEG 1, Layer III). */
function kopf({ kbit = 320, hz = 44100, mono = false, polster = 0 } = {}) {
  const bi = BITRATEN_V1_L3.indexOf(kbit);
  const si = RATEN_V1.indexOf(hz);
  assert.ok(bi > 0 && si >= 0, 'Testdaten: Bitrate/Abtastrate gibt es so nicht');
  return [0xff, 0xfb, (bi << 4) | (si << 2) | (polster << 1), mono ? 0xc0 : 0x00];
}

/** Wie lang ein solcher Block ist - dieselbe Formel, die die Norm nennt. */
function blockLaenge(kbit, hz, polster = 0) {
  return Math.floor((144 * kbit * 1000) / hz) + polster;
}

/** Zwei Bloecke hintereinander: Der zweite ist der Beweis, dass der erste keiner ist. */
function zweiBloecke(opt = {}) {
  const { kbit = 320, hz = 44100 } = opt;
  const laenge = blockLaenge(kbit, hz);
  const daten = new Uint8Array(laenge + 4);
  daten.set(kopf(opt), 0);
  daten.set(kopf(opt), laenge);
  return daten;
}

test('Der Kopf nennt Bitrate und Abtastrate', () => {
  const k = mp3Kopf(zweiBloecke({ kbit: 320 }));
  assert.equal(k.kbit, 320);
  assert.equal(k.hz, 44100);
  assert.equal(k.proben, 1152);
  assert.equal(k.ab, 0);
  assert.equal(k.bloecke, null, 'ohne Xing keine Blockzahl');
});

test('Die Dauer einer fest kodierten Datei - der Fall, an dem die Schaetzung scheiterte', () => {
  // Das gemeldete Beispiel: ein Kapitel von 14 MB, mit 320 kbit/s kodiert.
  const bytes = 14 * 1024 * 1024;
  const gemessen = mp3Dauer(mp3Kopf(zweiBloecke({ kbit: 320 })), bytes);
  assert.equal(genaueDauer(gemessen), '6:07');

  // Und zum Vergleich, was frueher dastand: Die Annahme von 128 kbit/s macht
  // aus sechs Minuten eine Viertelstunde. Diese Zeile ist der Grund fuer das
  // ganze Modul.
  assert.equal(lesbareDauer(spieldauerSekunden(bytes)), '15 Minuten');
});

test('Ein ID3-Etikett wird uebersprungen, auch wenn Muell darin steht', () => {
  // Im Etikett steht absichtlich ein Muster, das wie ein Blockanfang aussieht.
  // Wer es nicht ueberspringt, liest dort eine falsche Bitrate.
  const etikett = 2000;
  const daten = new Uint8Array(10 + etikett + blockLaenge(256, 44100) + 4);
  daten.set([0x49, 0x44, 0x33, 3, 0, 0], 0); // "ID3", Version 3, keine Flaggen
  daten.set([(etikett >> 21) & 0x7f, (etikett >> 14) & 0x7f, (etikett >> 7) & 0x7f, etikett & 0x7f], 6);
  daten.set([0xff, 0xfb, 0x90, 0x00], 500); // der Koeder mitten im Etikett
  const ab = 10 + etikett;
  daten.set(kopf({ kbit: 256 }), ab);
  daten.set(kopf({ kbit: 256 }), ab + blockLaenge(256, 44100));

  assert.equal(tondatenAb(daten), ab);
  const k = mp3Kopf(daten);
  assert.equal(k.kbit, 256);
  assert.equal(k.ab, ab);

  // Und das Etikett zaehlt nicht als Musik: abgezogen werden seine Bytes.
  const bytes = 10 * 1024 * 1024;
  assert.equal(Math.round(mp3Dauer(k, bytes)), Math.round(((bytes - ab) * 8) / 256000));
});

test('Ein Titelbild schiebt den Block hinter die Leseprobe - die Stelle steht trotzdem fest', () => {
  // Der Fall, den die Pruefung mit einem zweiten, gezielten Abruf loest:
  // tondatenAb zeigt hinter das Ende der Probe, also ist hier nichts zu finden.
  const gross = 300000;
  const probe = new Uint8Array(32 * 1024);
  probe.set([0x49, 0x44, 0x33, 3, 0, 0], 0);
  probe.set([(gross >> 21) & 0x7f, (gross >> 14) & 0x7f, (gross >> 7) & 0x7f, gross & 0x7f], 6);
  assert.equal(tondatenAb(probe), 10 + gross);
  assert.ok(tondatenAb(probe) > probe.length, 'die Probe reicht nicht bis zur Musik');
  assert.equal(mp3Kopf(probe), null);
});

test('Eine variabel kodierte Datei wird ueber ihre Blockzahl gerechnet', () => {
  // Bei VBR sagt die Bitrate des ersten Blocks nichts ueber die Datei. Xing
  // zaehlt die Bloecke, und nur damit stimmt die Dauer.
  const bloecke = 15000;
  const laenge = blockLaenge(128, 44100);
  const daten = new Uint8Array(laenge + 4);
  daten.set(kopf({ kbit: 128 }), 0);
  const x = 4 + 32; // hinter den Seiteninformationen (MPEG 1, Stereo)
  daten.set([0x58, 0x69, 0x6e, 0x67], x); // "Xing"
  daten.set([0, 0, 0, 1], x + 4); // Flagge: Blockzahl vorhanden
  daten.set([(bloecke >>> 24) & 0xff, (bloecke >>> 16) & 0xff, (bloecke >>> 8) & 0xff, bloecke & 0xff], x + 8);
  daten.set(kopf({ kbit: 128 }), laenge);

  const k = mp3Kopf(daten);
  assert.equal(k.bloecke, bloecke);
  assert.equal(k.vbr, true);
  // 15000 Bloecke à 1152 Proben bei 44100 Hz.
  assert.equal(genaueDauer(mp3Dauer(k, 999999999)), '6:32');
});

test('MPEG 2 rechnet mit 576 Proben je Block', () => {
  // Halbe Abtastrate, halber Block - wer das verwechselt, liegt um das
  // Doppelte daneben.
  const daten = new Uint8Array(400);
  // Version 2 (Bits 10), Layer III: 0xF3; 64 kbit/s (Index 8), 22050 Hz (Index 0)
  const laenge = Math.floor((72 * 64 * 1000) / 22050);
  daten.set([0xff, 0xf3, 0x80, 0x00], 0);
  daten.set([0xff, 0xf3, 0x80, 0x00], laenge);
  const k = mp3Kopf(daten);
  assert.equal(k.kbit, 64);
  assert.equal(k.hz, 22050);
  assert.equal(k.proben, 576);
});

test('Ein zufaelliges Muster ist kein Block', () => {
  // Elf gesetzte Bits kommen in Bilddaten vor. Erst der Block an der
  // errechneten naechsten Stelle macht den Fund glaubwuerdig - fehlt er,
  // bleibt die Dauer lieber unbekannt als falsch.
  const daten = new Uint8Array(3000);
  daten.set([0xff, 0xfb, 0x90, 0x00], 100); // sieht aus wie ein Kopf
  daten.fill(0x42, 104); // aber danach kommt keiner
  assert.equal(mp3Kopf(daten), null);
  assert.equal(mp3Kopf(new Uint8Array(0)), null);
  assert.equal(mp3Dauer(null, 1000), null);
});

test('Die Warnung fuer lange Dateien folgt jetzt der Messung', () => {
  // Frueher wurde mit 320 kbit/s gegengerechnet, damit hinter der Warnung eine
  // Gewissheit steht. Mit der gemessenen Dauer ist das keine Annahme mehr:
  // Eine Stunde bei 64 kbit/s ist eine Stunde, auch wenn die Datei klein ist.
  const kleineStunde = 20 * 1024 * 1024; // eine Stunde bei rund 46 kbit/s
  assert.equal(laengerAlsSitzung(kleineStunde), false, 'nach der alten Rechnung unauffaellig');
  assert.equal(laengerAlsSitzung(kleineStunde, 3600), true, 'gemessen sind es sechzig Minuten');
  assert.equal(laengerAlsSitzung(kleineStunde, 400), false);
});

test('genaueDauer schreibt Stunden erst, wenn es welche gibt', () => {
  assert.equal(genaueDauer(0), '0:00');
  assert.equal(genaueDauer(59.6), '1:00');
  assert.equal(genaueDauer(367), '6:07');
  assert.equal(genaueDauer(3731), '1:02:11');
  assert.equal(genaueDauer(null), null);
});
