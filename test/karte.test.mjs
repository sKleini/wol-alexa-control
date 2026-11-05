// test/karte.test.mjs – die Karte auf dem Echo Show, ohne Netz und ohne Echo.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  KACHEL, kannKarte, weltPixel, zoomFuer, kachelRaster, kartenDirektive, meterProPixel, kartenDauerMs,
} from '../lib/karte.js'
import { kartenOrt } from '../lib/geo.js'
import { speak } from '../lib/alexa.js'

const mitApl = { context: { System: { device: { supportedInterfaces: { 'Alexa.Presentation.APL': { runtime: { maxVersion: '2024.1' } } } } } } };
const ohneApl = { context: { System: { device: { supportedInterfaces: { AudioPlayer: {} } } } } };

test('Karte nur fuer Geraete, die APL melden', () => {
  assert.equal(kannKarte(mitApl), true);
  assert.equal(kannKarte(ohneApl), false);
  assert.equal(kannKarte({}), false);
  assert.equal(kannKarte(null), false);
});

test('Weltpixel: Nullmeridian/Aequator liegt in der Kartenmitte', () => {
  const p = weltPixel(0, 0, 1);
  assert.ok(Math.abs(p.x - 256) < 1e-9);
  assert.ok(Math.abs(p.y - 256) < 1e-9);
});

test('Weltpixel: Dortmund liegt in der bekannten Kachel', () => {
  // Dortmund Hbf, Zoom 16 - gegengerechnet mit der Standardformel (asinh).
  const p = weltPixel(51.5178, 7.4593, 16);
  assert.equal(Math.floor(p.x / KACHEL), 34125);
  assert.equal(Math.floor(p.y / KACHEL), 21789);
});

test('Zoom folgt der Genauigkeit', () => {
  assert.equal(zoomFuer(undefined), 16);
  assert.equal(zoomFuer(8), 16);
  assert.equal(zoomFuer(300), 15);
  assert.equal(zoomFuer(900), 14);
  assert.equal(zoomFuer(2000), 13);
  assert.equal(zoomFuer(10000), 12);
});

test('Raster: 9 x 7 Kacheln, die Mitte liegt auf der Position', () => {
  const k = kachelRaster(51.5178, 7.4593, 16);
  assert.equal(k.length, 63);
  // Genau eine Kachel enthaelt den Bildschirmmittelpunkt (0,0).
  const mitte = k.filter(t => t.links <= 0 && t.links + KACHEL > 0 && t.oben <= 0 && t.oben + KACHEL > 0);
  assert.equal(mitte.length, 1);
  assert.match(mitte[0].url, /^https:\/\/basemaps\.cartocdn\.com\/rastertiles\/voyager\/16\/34125\/21789\.png$/);
});

test('Raster: ueber die Datumsgrenze hinweg bleiben die Kachelnummern gueltig', () => {
  const k = kachelRaster(0, 179.99, 3);
  for (const t of k) {
    const x = t.url.match(/\/(\d+)\/(\d+)\.png$/)[1];
    assert.ok(Number(x) >= 0 && Number(x) < 8, t.url);
  }
});

test('Direktive: RenderDocument mit Pin, Kreis und Quellenangabe', () => {
  const d = kartenDirektive({ name: 'Julia', lat: 51.5178, lon: 7.4593, acc: 120, ort: 'Schule', alter: 'vor 3 Minuten' });
  assert.equal(d.type, 'Alexa.Presentation.APL.RenderDocument');
  assert.equal(d.datasources.karte.name, 'Julia');
  assert.equal(d.datasources.karte.zeile, 'Schule · vor 3 Minuten');
  const json = JSON.stringify(d);
  assert.match(json, /OpenStreetMap-Mitwirkende © CARTO/);
  assert.doesNotMatch(json, /tile\.openstreetmap\.org/);
  // 120 m bei Zoom 16 in Dortmund sind gut 80 Pixel Radius.
  const r = Math.round(120 / meterProPixel(51.5178, 16));
  assert.ok(json.includes(`"borderRadius":${r}`), `Kreis mit Radius ${r} fehlt`);
  // Jede Kachel prueft ihre Sichtbarkeit selbst.
  const bilder = d.document.mainTemplate.items[0].item[0].item[0].items.filter(e => e.type === 'Image');
  assert.equal(bilder.length, 63);
  assert.ok(bilder.every(b => b.when.startsWith('${') && b.left.startsWith('${viewport.width / 2')));
});

test('Direktive: veraltete Position ist als solche beschriftet', () => {
  const d = kartenDirektive({ name: 'Amelia', lat: 51, lon: 7, ort: 'zu Hause', alter: 'vor 3 Stunden', veraltet: true });
  assert.equal(d.datasources.karte.zeile, 'zu Hause · zuletzt vor 3 Stunden');
});

test('Direktive: ohne Koordinaten keine Karte', () => {
  assert.equal(kartenDirektive({ name: 'X', lat: NaN, lon: 7, ort: '', alter: '' }), null);
});

test('Kachelquelle laesst sich umstellen', () => {
  process.env.KARTE_KACHELN = 'https://kacheln.example/{z}/{x}/{y}.png';
  try {
    const d = kartenDirektive({ name: 'J', lat: 51, lon: 7, ort: 'x', alter: 'y' });
    assert.match(JSON.stringify(d), /kacheln\.example\/16\//);
  } finally {
    delete process.env.KARTE_KACHELN;
  }
});

test('Ortszeile ohne gesprochene Praepositionen', () => {
  const loc = { lat: 51.5, lon: 7.45 };
  assert.equal(kartenOrt('in der Schillerstraße in Dortmund', loc), 'Schillerstraße, Dortmund');
  assert.equal(kartenOrt('in Dortmund', loc), 'Dortmund');
  assert.equal(kartenOrt('in der Nähe von Marktplatz 1', loc), 'nahe Marktplatz 1');
  assert.equal(kartenOrt('zu Hause', loc), 'zu Hause');
  assert.equal(kartenOrt(null, loc), '51.5000, 7.4500');
  assert.equal(kartenOrt('an einem unbekannten Ort', loc), '51.5000, 7.4500');
});

test('Anzeigedauer: Vorgabe, Einstellung und Grenzen', () => {
  assert.equal(kartenDauerMs(undefined), 25000);
  assert.equal(kartenDauerMs('300'), 300000);
  assert.equal(kartenDauerMs('abc'), 25000);
  assert.equal(kartenDauerMs('2'), 10000);
  assert.equal(kartenDauerMs('99999'), 600000);
  const d = kartenDirektive({ name: 'J', lat: 51, lon: 7, ort: 'x', alter: 'y' });
  assert.equal(d.document.settings.idleTimeout, 25000);
});

test('speak mit null: Sitzung offen, ohne Mikrofon und ohne Reprompt', () => {
  let gesendet;
  const res = { status: () => ({ json: b => { gesendet = b; } }) };
  speak(res, 'Julia ist zu Hause.', null, [{ type: 'X' }]);
  assert.equal('shouldEndSession' in gesendet.response, false);
  assert.equal(gesendet.response.reprompt, undefined);
  speak(res, 'Wen?', false);
  assert.equal(gesendet.response.shouldEndSession, false);
  assert.ok(gesendet.response.reprompt);
  speak(res, 'Bis bald.');
  assert.equal(gesendet.response.shouldEndSession, true);
  assert.equal(gesendet.response.reprompt, undefined);
});
