// test/kachel.test.mjs – das Durchreichen der Kartenkacheln fuer den Fire TV.
import test from 'node:test'
import assert from 'node:assert/strict'
import { kachelAus, kachelDurchreichen, proxyVorlage } from '../lib/kachel.js'

function antwortAttrappe() {
  const r = { kopf: {}, code: null, rumpf: undefined };
  r.setHeader = (k, v) => { r.kopf[k.toLowerCase()] = v; };
  r.status = c => { r.code = c; return { end: () => r, send: b => { r.rumpf = b; return r; } }; };
  return r;
}

test('nur gueltige Kachelnummern', () => {
  assert.deepEqual(kachelAus({ z: '16', x: '34125', y: '21789' }), { z: 16, x: 34125, y: 21789 });
  assert.equal(kachelAus({ z: '20', x: '0', y: '0' }), null);
  assert.equal(kachelAus({ z: '2', x: '4', y: '0' }), null);
  assert.equal(kachelAus({ z: '2', x: '-1', y: '0' }), null);
  assert.equal(kachelAus({ z: '2', x: '1.5', y: '0' }), null);
  assert.equal(kachelAus({ z: '2', x: '../x', y: '0' }), null);
  assert.equal(kachelAus({ z: ['2', '3'], x: '0', y: '0' }), null);
  assert.equal(kachelAus({}), null);
});

test('Vorlage zeigt auf die eigene App', () => {
  assert.equal(proxyVorlage('https://a.example'), 'https://a.example/api/skill?kachel=1&z={z}&x={x}&y={y}');
});

test('holt bei OSM mit eigener Kennung und puffert eine Woche', async () => {
  let angefragt, optionen;
  const holen = async (url, o) => {
    angefragt = url; optionen = o;
    return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const res = antwortAttrappe();
  await kachelDurchreichen({ method: 'GET' }, res, { z: '16', x: '34125', y: '21789' }, holen);
  assert.equal(angefragt, 'https://tile.openstreetmap.org/16/34125/21789.png');
  assert.match(optionen.headers['User-Agent'], /wol-alexa-control/);
  assert.equal(res.code, 200);
  assert.equal(res.kopf['content-type'], 'image/png');
  assert.match(res.kopf['cache-control'], /s-maxage=604800/);
  assert.deepEqual([...res.rumpf], [137, 80, 78, 71]);
});

test('Fehler bei OSM: 502, nur kurz gepuffert', async () => {
  const res = antwortAttrappe();
  await kachelDurchreichen({ method: 'GET' }, res, { z: '1', x: '0', y: '0' }, async () => new Response('', { status: 403 }));
  assert.equal(res.code, 502);
  assert.match(res.kopf['cache-control'], /s-maxage=60/);
});

test('ungueltige Nummer: 400 ohne Anfrage bei OSM', async () => {
  let gefragt = false;
  const res = antwortAttrappe();
  await kachelDurchreichen({ method: 'GET' }, res, { z: '1', x: '9', y: '0' }, async () => { gefragt = true; });
  assert.equal(res.code, 400);
  assert.equal(gefragt, false);
});
