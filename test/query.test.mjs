// test/query.test.mjs – die Query-Parameter ohne url.parse().
//
// Der Anlass war eine Zeile im Vercel-Protokoll und kein Fehlverhalten:
// [DEP0169], die Deprecation von `url.parse()`, ausgeloest von Vercels
// Lazy-Getter fuer `req.query`. Genau deshalb steht hier vor allem, dass sich
// die Form der Antwort NICHT geaendert hat - eine Zeichenkette bei einmal,
// ein Array bei mehrfach, `undefined` bei gar nicht.
import test from 'node:test'
import assert from 'node:assert/strict'
import { queryOf } from '../lib/query.js'
import { keyOk } from '../lib/auth.js'

test('liest die Parameter aus req.url', () => {
  const q = queryOf({ url: '/api/location?u=Stefan&lat=52.5&lon=13.4' });
  assert.equal(q.u, 'Stefan');
  assert.equal(q.lat, '52.5');
  assert.equal(q.lon, '13.4');
});

test('ein fehlender Parameter ist undefined, kein leerer Text', () => {
  const q = queryOf({ url: '/api/location?u=Stefan' });
  assert.equal(q.lat, undefined);
  // `?flag` ohne `=` ist etwas anderes als gar kein Parameter.
  assert.equal(queryOf({ url: '/api/manage?import' }).import, '');
});

test('ohne Query-String und ohne url kommt nichts Ueberraschendes zurueck', () => {
  assert.deepEqual({ ...queryOf({ url: '/api/location' }) }, {});
  assert.deepEqual({ ...queryOf({ url: '' }) }, {});
});

test('ein mehrfach genannter Parameter wird zum Array', () => {
  // Genau daran haengt die Abwehr in keyOk: zwei ?key= gelten als keiner.
  assert.deepEqual(queryOf({ url: '/api/ring?key=a&key=b' }).key, ['a', 'b']);
  assert.deepEqual(queryOf({ url: '/api/ring?k=a&k=b&k=c' }).k, ['a', 'b', 'c']);
});

test('dekodiert wie bisher: Prozentzeichen und Plus', () => {
  const q = queryOf({ url: '/api/presence?zone=zu%20Hause&z2=zu+Hause&n=Andr%C3%A9' });
  assert.equal(q.zone, 'zu Hause');
  assert.equal(q.z2, 'zu Hause');
  assert.equal(q.n, 'André');
});

test('ein angehaengtes Fragment gehoert nicht zum letzten Wert', () => {
  assert.equal(queryOf({ url: '/api/led?action=on#top' }).action, 'on');
});

test('geerbte Namen sind gewoehnliche Parameter', () => {
  // Ohne Prototyp: `?constructor=x` darf keine Funktion zurueckgeben, und ein
  // fehlendes `toString` bleibt undefined statt einer geerbten Methode.
  const q = queryOf({ url: '/api/x?constructor=boese' });
  assert.equal(q.constructor, 'boese');
  assert.equal(q.toString, undefined);
});

test('ohne req.url gilt ein vorhandenes query - der Weg der Tests', () => {
  assert.deepEqual(queryOf({ query: { type: 'zones' } }), { type: 'zones' });
  assert.deepEqual({ ...queryOf({}) }, {});
});

test('keyOk liest den Schluessel aus der Adresse statt aus req.query', () => {
  const vorher = process.env.LOCATION_KEY;
  process.env.LOCATION_KEY = 'geheim';
  try {
    // Kein `query` am Objekt: Genau so kommt die Anfrage auf Vercel an, wenn
    // niemand den Getter anfasst - und das ist der Sinn der Umstellung.
    assert.equal(keyOk({ url: '/api/relay-status?key=geheim', headers: {} }), true);
    assert.equal(keyOk({ url: '/api/relay-status?key=falsch', headers: {} }), false);
    assert.equal(keyOk({ url: '/api/relay-status', headers: {} }), false);
    // Der Header bleibt der bevorzugte Weg und wirkt weiterhin ohne Adresse.
    assert.equal(keyOk({ url: '/api/relay-status', headers: { 'x-location-key': 'geheim' } }), true);
    // Zwei Schluessel gelten als keiner - die Pruefung haengt am Array oben.
    assert.equal(keyOk({ url: '/api/relay-status?key=geheim&key=x', headers: {} }), false);
  } finally {
    if (vorher === undefined) delete process.env.LOCATION_KEY;
    else process.env.LOCATION_KEY = vorher;
  }
});

test('keyOk bleibt fail-closed ohne gesetztes LOCATION_KEY', () => {
  const vorher = process.env.LOCATION_KEY;
  delete process.env.LOCATION_KEY;
  try {
    assert.equal(keyOk({ url: '/api/relay-status?key=egal', headers: {} }), false);
  } finally {
    if (vorher !== undefined) process.env.LOCATION_KEY = vorher;
  }
});
