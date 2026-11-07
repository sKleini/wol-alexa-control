// test/fritz.test.mjs – FRITZ! Smart Home (lib/fritz.js) ohne Netz und ohne Redis.
//
//   node --test
//
// Der VPS (fritz-smarthome-relay, Repo wireguard-vps-strato) schiebt den
// Stand der Heizkoerperregler, Steckdosen und Vorlagen nach /api/fritz; der
// Smart Home Skill beantwortet daraus Discovery und ReportState und schickt
// Befehle als ntfy-Nachricht zurueck. Geprueft wird mit einem
// Redis-Stellvertreter, der jeden Befehl zaehlt: Eine abgewiesene Anfrage
// darf keinen kosten.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const PUSH = 'f'.repeat(64);
process.env.FRITZ_PUSH_SCHLUESSEL = PUSH;
process.env.FRITZ_TOPIC = 'fritz-0123456789abcdef';
process.env.FRITZ_PASSWORD = 'relay-pw';

import {
  FRITZ_SCHLUESSEL,
  MAX_BYTES,
  pushSchluesselOk,
  standOk,
  standAus,
  handleFritzPush,
} from '../lib/fritz.js'

// Ein Stand, wie ihn lese_stand() im Relay fuer die Beispiel-XML in
// wireguard-vps-strato/tests/daten/fritz-geraete.xml liefert. Frische Kopie je Aufruf.
const ZEIT = 1794067200;

function standBeispiel(zeit = ZEIT) {
  return structuredClone({
    v: 1,
    zeit,
    geraete: [
      { id: '116570272633', ain: '11657 0272633', art: 'hkr', name: 'Heizung Wohnzimmer', da: true,
        temp: 20.5, soll: 21.0, modus: 'HEAT', komfort: 21.0, absenk: 17.0, boost: false,
        batterie: 80, batterieLeer: false },
      { id: '116570111111', ain: '11657 0111111', art: 'hkr', name: 'Heizung Bad', da: true,
        temp: 19.0, soll: null, modus: 'OFF', komfort: 22.0, absenk: 16.0, boost: true,
        batterie: 10, batterieLeer: true },
      { id: '116570222222', ain: '11657 0222222', art: 'hkr', name: 'Heizung Büro', da: false,
        temp: null, soll: 28.0, modus: 'HEAT', komfort: 21.0, absenk: 17.0, boost: false,
        batterie: 60, batterieLeer: false },
      { id: '087610123456', ain: '08761 0123456', art: 'dose', name: 'Steckdose Keller', da: true,
        an: true, temp: 18.0, watt: 12.3 },
      { id: '087610654321', ain: '08761 0654321', art: 'dose', name: 'Steckdose Terrasse', da: true,
        an: false },
    ],
    vorlagen: [{ id: 'tmp6f2c1a-3c8b1e4f2', ain: 'tmp6F2C1A-3C8B1E4F2', name: 'Alles aus' }],
  });
}

function redisMit(speicher = {}) {
  const r = { speicher, befehle: 0 };
  r.set = async (k, v) => { r.befehle++; r.speicher[k] = v; return 'OK'; };
  r.get = async (k) => { r.befehle++; return r.speicher[k] ?? null; };
  return r;
}

function antwortFaenger() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = () => res;
  return res;
}

const mitPush = { 'x-fritz-push-schluessel': PUSH };

async function schiebe({ method = 'POST', headers = mitPush, body = standBeispiel() } = {}, redis = redisMit()) {
  const res = antwortFaenger();
  await handleFritzPush({ method, url: '/api/fritz', headers, body }, res, redis);
  return { res, redis };
}

// ------------------------------------------------------------- Push ---

test('push_schluessel_fail_closed', () => {
  const vorher = process.env.FRITZ_PUSH_SCHLUESSEL;
  try {
    process.env.FRITZ_PUSH_SCHLUESSEL = '';
    assert.equal(pushSchluesselOk({ headers: { 'x-fritz-push-schluessel': '' } }), false);
    process.env.FRITZ_PUSH_SCHLUESSEL = PUSH;
    assert.equal(pushSchluesselOk({ headers: {} }), false);
    assert.equal(pushSchluesselOk({ headers: { 'x-fritz-push-schluessel': 'e'.repeat(64) } }), false);
    assert.equal(pushSchluesselOk({ headers: { 'x-fritz-push-schluessel': [PUSH] } }), false);
    assert.equal(pushSchluesselOk({ headers: mitPush }), true);
  } finally {
    process.env.FRITZ_PUSH_SCHLUESSEL = vorher;
  }
});

test('gueltiger_push_kostet_genau_einen_befehl', async () => {
  const { res, redis } = await schiebe();
  assert.equal(res.statusCode, 204);
  assert.equal(redis.befehle, 1);
  assert.deepEqual(redis.speicher[FRITZ_SCHLUESSEL], standBeispiel());
});

test('push_als_text_wird_gelesen', async () => {
  const { res, redis } = await schiebe({ body: JSON.stringify(standBeispiel()) });
  assert.equal(res.statusCode, 204);
  assert.deepEqual(redis.speicher[FRITZ_SCHLUESSEL], standBeispiel());
});

test('falscher_schluessel_kostet_nichts', async () => {
  for (const headers of [{}, { 'x-fritz-push-schluessel': 'nein' }]) {
    const { res, redis } = await schiebe({ headers });
    assert.equal(res.statusCode, 401);
    assert.equal(redis.befehle, 0);
  }
});

test('ohne_env_variable_401', async () => {
  const vorher = process.env.FRITZ_PUSH_SCHLUESSEL;
  try {
    delete process.env.FRITZ_PUSH_SCHLUESSEL;
    const { res, redis } = await schiebe();
    assert.equal(res.statusCode, 401);
    assert.equal(redis.befehle, 0);
  } finally {
    process.env.FRITZ_PUSH_SCHLUESSEL = vorher;
  }
});

test('nur_post', async () => {
  const { res, redis } = await schiebe({ method: 'GET' });
  assert.equal(res.statusCode, 405);
  assert.equal(redis.befehle, 0);
});

test('zu_gross_413', async () => {
  const stand = standBeispiel();
  stand.geraete[0].name = 'x'.repeat(MAX_BYTES);
  const { res, redis } = await schiebe({ body: stand });
  assert.equal(res.statusCode, 413);
  assert.equal(redis.befehle, 0);
});

test('falsche_form_400', async () => {
  const kaputt = [
    (s) => { s.v = 2; },
    (s) => { s.zeit = 'gestern'; },
    (s) => { s.geraete = Array.from({ length: 101 }, () => s.geraete[0]); },
    (s) => { s.vorlagen = Array.from({ length: 51 }, () => s.vorlagen[0]); },
    (s) => { s.geraete[0].id = '11657 0272633'; },
    (s) => { s.geraete[0].id = 'ABC'; },
    (s) => { s.geraete[0].art = 'lampe'; },
    (s) => { s.geraete[0].name = 42; },
    (s) => { s.geraete[0].da = 'ja'; },
    (s) => { s.geraete[0].soll = '21'; },
    (s) => { s.geraete[0].modus = 'AUTO'; },
    (s) => { s.geraete[3].an = 1; },
    (s) => { s.vorlagen[0].id = 'tmp 1'; },
    (s) => { delete s.geraete; },
  ];
  for (const aendern of kaputt) {
    const stand = standBeispiel();
    aendern(stand);
    assert.equal(standOk(stand), false, aendern.toString());
    const { res, redis } = await schiebe({ body: stand });
    assert.equal(res.statusCode, 400, aendern.toString());
    assert.equal(redis.befehle, 0);
  }
  assert.equal(standOk(standBeispiel()), true);
});

test('stand_aus_redis_als_objekt_oder_text', () => {
  // Upstash gibt JSON beim Lesen schon geparst zurueck; als Text abgelegte
  // Werte (oder ein aelterer Client) kommen als String.
  assert.deepEqual(standAus(standBeispiel()), standBeispiel());
  assert.deepEqual(standAus(JSON.stringify(standBeispiel())), standBeispiel());
  assert.equal(standAus('kaputt'), null);
  assert.equal(standAus(null), null);
  assert.equal(standAus({ v: 2 }), null);
  assert.equal(ZEIT, standBeispiel().zeit);
});
