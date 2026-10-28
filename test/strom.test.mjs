// test/strom.test.mjs – /api/strom ohne Netz und ohne Redis.
//
//   node --test
//
// lib/strom.js nimmt Chiffrat vom VPS an und gibt es an den Actions Hub
// heraus. Geprueft werden Schluessel, Fachnamen, Huelle und Grenzen mit einem
// Redis-Stellvertreter, der jeden Befehl zaehlt: Eine abgewiesene Anfrage
// darf keinen einzigen kosten (Upstash rechnet je Befehl ab).
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.STROM_PUSH_SCHLUESSEL = 'a'.repeat(64);
process.env.LOCATION_KEY = 'standort-schluessel';
import {
  pushSchluesselOk,
  huelleOk,
  handleStrom,
  KURVE_TTL_S,
  MAX_BYTES,
  MAX_C,
} from '../lib/strom.js'

const PUSH = 'a'.repeat(64);

function redisMit(speicher = {}) {
  const r = { speicher, ttl: {}, befehle: 0, mgetSchluessel: null };
  r.pipeline = () => {
    const ops = [];
    return {
      set(k, v, opts) { ops.push([k, v, opts]); return this; },
      async exec() {
        for (const [k, v, opts] of ops) {
          r.befehle++;
          r.speicher[k] = v;
          if (opts?.ex) r.ttl[k] = opts.ex; else delete r.ttl[k];
        }
        return ops.map(() => 'OK');
      },
    };
  };
  r.mget = async (...schluessel) => {
    r.befehle++;
    r.mgetSchluessel = schluessel;
    return schluessel.map(k => r.speicher[k] ?? null);
  };
  r.scan = async (cursor, { match }) => {
    r.befehle++;
    const muster = new RegExp('^' + match.replace('*', '.*') + '$');
    return ['0', Object.keys(r.speicher).filter(k => muster.test(k))];
  };
  r.del = async (...schluessel) => {
    r.befehle++;
    let n = 0;
    for (const k of schluessel) if (k in r.speicher) { delete r.speicher[k]; n++; }
    return n;
  };
  return r;
}

function antwortFaenger() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = () => res;
  res.setHeader = (name, wert) => { res.headers[name.toLowerCase()] = wert; return res; };
  return res;
}

function huelle(c = 'QUJD') {
  return { v: 1, k: '3f9a0c12', n: Buffer.alloc(12).toString('base64'), c };
}

async function rufe({ method = 'POST', url = '/api/strom', headers = {}, body } = {}, redis = redisMit()) {
  const res = antwortFaenger();
  await handleStrom({ method, url, headers, body }, res, redis);
  return { res, redis };
}

const mitPush = { 'x-strom-push-schluessel': PUSH };

test('push_schluessel_fail_closed', () => {
  const vorher = process.env.STROM_PUSH_SCHLUESSEL;
  try {
    process.env.STROM_PUSH_SCHLUESSEL = '';
    assert.equal(pushSchluesselOk({ headers: { 'x-strom-push-schluessel': '' } }), false);
    assert.equal(pushSchluesselOk({ headers: {} }), false);
    process.env.STROM_PUSH_SCHLUESSEL = PUSH;
    assert.equal(pushSchluesselOk({ headers: { 'x-strom-push-schluessel': 'b'.repeat(64) } }), false);
    assert.equal(pushSchluesselOk({ headers: { 'x-strom-push-schluessel': PUSH } }), true);
    assert.equal(pushSchluesselOk({ headers: { 'x-strom-push-schluessel': [PUSH, PUSH] } }), false);
  } finally {
    process.env.STROM_PUSH_SCHLUESSEL = vorher;
  }
});

test('post_speichert_faecher_mit_ttl_nur_fuer_kurven', async () => {
  const redis = redisMit({ 'strom:heute': huelle('QUFB'), });
  redis.ttl['strom:heute'] = 99;
  const { res } = await rufe({
    headers: mitPush,
    body: { faecher: { heute: huelle(), 'kurve:2026-10-27': huelle() } },
  }, redis);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, gespeichert: 2 });
  assert.deepEqual(redis.speicher['strom:heute'], huelle());
  assert.deepEqual(redis.speicher['strom:kurve:2026-10-27'], huelle());
  assert.equal(redis.ttl['strom:kurve:2026-10-27'], KURVE_TTL_S);
  assert.equal(KURVE_TTL_S, 5443200);
  assert.equal(redis.ttl['strom:heute'], undefined);
});

test('post_nimmt_rumpf_als_text', async () => {
  // Wie api/relay-status.js: ohne passenden Content-Type kommt der Rumpf als String.
  const { res, redis } = await rufe({
    headers: mitPush,
    body: JSON.stringify({ faecher: { heute: huelle() } }),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(redis.speicher['strom:heute'], huelle());
});

test('post_ohne_schluessel_kostet_keinen_befehl', async () => {
  for (const anfrage of [
    { headers: { 'x-strom-push-schluessel': 'b'.repeat(64) } },
    { headers: {}, url: `/api/strom?key=${PUSH}` },
    { headers: { 'x-location-key': 'standort-schluessel' } },
  ]) {
    const { res, redis } = await rufe({ ...anfrage, body: { faecher: { heute: huelle() } } });
    assert.equal(res.statusCode, 401);
    assert.equal(redis.befehle, 0);
    assert.deepEqual(redis.speicher, {});
  }
});

test('post_lehnt_fremde_namen_ab', async () => {
  for (const name of ['locations', 'strom:heute', 'jahr:26', 'kurve:2026-1-1', 'heute ', 'jahr:2026x', '']) {
    const { res, redis } = await rufe({ headers: mitPush, body: { faecher: { [name]: huelle() } } });
    assert.equal(res.statusCode, 400, name);
    assert.equal(redis.befehle, 0, name);
  }
  const { res } = await rufe({ headers: mitPush, body: { faecher: {} } });
  assert.equal(res.statusCode, 400);
  const ohne = await rufe({ headers: mitPush, body: {} });
  assert.equal(ohne.res.statusCode, 400);
});

test('post_lehnt_kaputte_huelle_ab', async () => {
  const kaputt = [
    { ...huelle(), extra: 1 },
    { ...huelle(), v: 2 },
    { ...huelle(), k: '3F9A0C12' },
    { ...huelle(), k: '3f9a0c1' },
    { ...huelle(), n: Buffer.alloc(11).toString('base64') },
    { ...huelle(), c: '' },
    { ...huelle(), c: 'QU*D' },
    { v: 1, k: '3f9a0c12', n: Buffer.alloc(12).toString('base64') },
    'text',
    null,
  ];
  for (const h of kaputt) {
    assert.equal(huelleOk(h), false, JSON.stringify(h));
    const { res, redis } = await rufe({ headers: mitPush, body: { faecher: { heute: h } } });
    assert.equal(res.statusCode, 400, JSON.stringify(h));
    assert.equal(redis.befehle, 0);
  }
  assert.equal(huelleOk(huelle()), true);
});

test('post_grenzen', async () => {
  const viele = {};
  for (let i = 0; i < 71; i++) viele[`kurve:2026-08-${String(1 + (i % 28)).padStart(2, '0')}`.replace(/08-/, `0${1 + Math.floor(i / 28)}-`)] = huelle();
  assert.equal(Object.keys(viele).length, 71);
  assert.equal((await rufe({ headers: mitPush, body: { faecher: viele } })).res.statusCode, 400);

  // Knapp ueber MAX_BYTES (gueltiges Base64 waechst in Viererschritten) → 413,
  // knapp darunter → 200.
  const mitLaenge = (laenge) => ({
    heute: huelle('Q'.repeat(400000)),
    'jahr:2026': huelle('Q'.repeat(400000)),
    'jahr:2025': huelle('Q'.repeat(laenge)),
  });
  const groesse = (f) => Buffer.byteLength(JSON.stringify(f));
  // Die Groesse waechst genau mit der Laenge von c: einmal messen, dann rechnen.
  const rest = MAX_BYTES - (groesse(mitLaenge(4)) - 4);
  const laenge = rest - (rest % 4);
  assert.ok(groesse(mitLaenge(laenge)) <= MAX_BYTES);
  assert.ok(groesse(mitLaenge(laenge + 4)) > MAX_BYTES);
  const drueber = await rufe({ headers: mitPush, body: { faecher: mitLaenge(laenge + 4) } });
  assert.equal(drueber.res.statusCode, 413);
  assert.equal(drueber.redis.befehle, 0);
  assert.equal((await rufe({ headers: mitPush, body: { faecher: mitLaenge(laenge) } })).res.statusCode, 200);

  const zuLang = huelle('Q'.repeat(MAX_C + 4));
  assert.equal((await rufe({ headers: mitPush, body: { faecher: { heute: zuLang } } })).res.statusCode, 400);
  assert.equal(MAX_C, 400000);
});

test('get_mit_location_key', async () => {
  const speicher = { 'strom:heute': huelle(), 'geo_persons': ['x'] };
  const ohne = await rufe({ method: 'GET', url: '/api/strom?teile=heute' }, redisMit(speicher));
  assert.equal(ohne.res.statusCode, 401);
  assert.equal(ohne.redis.befehle, 0);

  const { res, redis } = await rufe({
    method: 'GET',
    url: '/api/relay-status?art=strom&teile=heute,jahr:2025',
    headers: { 'x-location-key': 'standort-schluessel' },
  }, redisMit(speicher));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { teile: { heute: huelle(), 'jahr:2025': null } });
  assert.equal(redis.befehle, 1);
  assert.deepEqual(redis.mgetSchluessel, ['strom:heute', 'strom:jahr:2025']);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('get_hoechstens_vier_teile', async () => {
  const kopf = { 'x-location-key': 'standort-schluessel' };
  const fuenf = await rufe({ method: 'GET', url: '/api/strom?teile=heute,jahr:2021,jahr:2022,jahr:2023,jahr:2024', headers: kopf });
  assert.equal(fuenf.res.statusCode, 400);
  assert.equal(fuenf.redis.befehle, 0);
  const doppelt = await rufe({ method: 'GET', url: '/api/strom?teile=heute,heute', headers: kopf });
  assert.equal(doppelt.res.statusCode, 200);
  assert.deepEqual(doppelt.redis.mgetSchluessel, ['strom:heute']);
  for (const teile of ['', 'locations', 'heute,geo_persons']) {
    const r = await rufe({ method: 'GET', url: `/api/strom?teile=${teile}`, headers: kopf });
    assert.equal(r.res.statusCode, 400, teile);
    assert.equal(r.redis.befehle, 0);
  }
  const ohneTeile = await rufe({ method: 'GET', url: '/api/strom', headers: kopf });
  assert.equal(ohneTeile.res.statusCode, 400);
});

test('delete_nur_strom', async () => {
  const speicher = { 'strom:heute': huelle(), 'strom:kurve:2026-10-27': huelle(), geo_persons: ['x'] };
  const falsch = await rufe({ method: 'DELETE', headers: { 'x-strom-push-schluessel': 'b'.repeat(64) } }, redisMit({ ...speicher }));
  assert.equal(falsch.res.statusCode, 401);
  assert.equal(falsch.redis.befehle, 0);

  const { res, redis } = await rufe({ method: 'DELETE', headers: mitPush }, redisMit({ ...speicher }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, geloescht: 2 });
  assert.deepEqual(Object.keys(redis.speicher), ['geo_persons']);
});

test('falsche_methode', async () => {
  const { res, redis } = await rufe({ method: 'PUT', headers: mitPush });
  assert.equal(res.statusCode, 405);
  assert.equal(redis.befehle, 0);
});
