// test/boxweg.test.mjs – der Weg zur FRITZ!Box, direkt oder ueber den VPS.
//
//   node --test
//
// Ohne Netz: `boxnetz` wird ersetzt, Namensaufloesung und Abrufe sind Attrappen.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  vpsKonfig, istBoxAdresse, wegUrteil, boxWeg, boxPruefen, boxFetch, aufVps,
  mitUrsprung, ueberVps, verbindungWeg, wegVergessen, boxnetz, WEG_GILT_MS, SCHLUESSEL_KOPF,
} from '../lib/boxweg.js'

const ENV = {
  MUSIK_VPS_URL: 'https://85.215.133.221:8443',
  MUSIK_VPS_KEY: 'k'.repeat(64),
  MUSIK_VPS_CERT: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
};
const KONFIG = vpsKonfig(ENV);
const BOX = 'https://dy9gujj18dwlu4bu.myfritz.net:456';
const PRIVAT = 'zeigt auf eine private Adresse';

const echt = { ...boxnetz };
let uhr = 1_000_000;
let gefragt = 0;
let direkte = [];
let ueberVpsAbrufe = [];

beforeEach(() => {
  Object.assign(boxnetz, echt);
  wegVergessen();
  uhr = 1_000_000;
  gefragt = 0;
  direkte = [];
  ueberVpsAbrufe = [];
  boxnetz.jetzt = () => uhr;
  boxnetz.direkt = async (url, init) => { direkte.push({ url: String(url), init }); return new Response('direkt', { status: 200 }); };
  boxnetz.vps = async (url, init, konfig) => {
    ueberVpsAbrufe.push({ url, init, konfig });
    return new Response('vps', { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  };
});

function nameZeigt(grund) {
  boxnetz.pruefe = async () => { gefragt++; return grund; };
}

test('vpsKonfig: nur vollstaendig und nur https ohne Pfad', () => {
  assert.deepEqual(vpsKonfig(ENV), { url: 'https://85.215.133.221:8443', key: ENV.MUSIK_VPS_KEY, cert: ENV.MUSIK_VPS_CERT });
  for (const fehlt of ['MUSIK_VPS_URL', 'MUSIK_VPS_KEY', 'MUSIK_VPS_CERT']) {
    assert.equal(vpsKonfig({ ...ENV, [fehlt]: '' }), null, fehlt);
  }
  assert.equal(vpsKonfig({ ...ENV, MUSIK_VPS_URL: 'http://85.215.133.221:8443' }), null);
  assert.equal(vpsKonfig({ ...ENV, MUSIK_VPS_URL: 'https://85.215.133.221:8443/x' }), null);
  assert.equal(vpsKonfig({ ...ENV, MUSIK_VPS_URL: 'kein url' }), null);
  assert.equal(vpsKonfig({ ...ENV, MUSIK_VPS_URL: 'https://85.215.133.221:8443/' }).url, 'https://85.215.133.221:8443');
});

test('istBoxAdresse: nur NAS-Seiten eines MyFRITZ!-Namens, oder des gesetzten Hosts', () => {
  assert.equal(istBoxAdresse(`${BOX}/nas/filelink.lua?id=abc`, {}), true);
  assert.equal(istBoxAdresse(`${BOX}/nas/cgi-bin/luacgi_notimeout?sid=1`, {}), true);
  assert.equal(istBoxAdresse(`${BOX}/login_sid.lua`, {}), false, 'nicht unter /nas/');
  assert.equal(istBoxAdresse('https://example.org/nas/a.mp3', {}), false, 'fremder Host');
  assert.equal(istBoxAdresse('https://evilmyfritz.net/nas/a.mp3', {}), false, 'kein Unterdomain-Trick');
  assert.equal(istBoxAdresse('ftp://x.myfritz.net/nas/a', {}), false);
  assert.equal(istBoxAdresse('kein url', {}), false);
  const env = { MUSIK_VPS_BOX: 'Box.Example.org' };
  assert.equal(istBoxAdresse('https://box.example.org/nas/a', env), true);
  assert.equal(istBoxAdresse(`${BOX}/nas/a`, env), false, 'mit MUSIK_VPS_BOX nur dieser Host');
});

test('wegUrteil: nur die Gruende eines DSL-Ausfalls schicken zum VPS', () => {
  assert.equal(wegUrteil(PRIVAT), 'vps');
  assert.equal(wegUrteil('Hostname nicht aufloesbar'), 'vps');
  assert.equal(wegUrteil(null), 'direkt');
  assert.equal(wegUrteil('kein https (http:)'), 'direkt');
  assert.equal(wegUrteil('lokaler Host'), 'direkt');
  assert.equal(wegUrteil('private Adresse'), 'direkt', 'eine private Adresse in der URL selbst ist kein Ausfall');
});

test('boxWeg ohne Durchgang: immer direkt, der Grund bleibt', async () => {
  nameZeigt(PRIVAT);
  assert.deepEqual(await boxWeg(`${BOX}/nas/a`, { konfig: null, env: {} }), { name: 'direkt', grund: PRIVAT });
});

test('boxWeg: Name zeigt privat -> VPS, und fuenf Minuten lang ohne neue Frage', async () => {
  nameZeigt(PRIVAT);
  assert.deepEqual(await boxWeg(`${BOX}/nas/a`, { konfig: KONFIG, env: {} }), { name: 'vps', grund: null });
  assert.equal(gefragt, 1);
  uhr += WEG_GILT_MS - 1;
  assert.equal((await boxWeg(`${BOX}/nas/b`, { konfig: KONFIG, env: {} })).name, 'vps');
  assert.equal(gefragt, 1, 'gemerkt, nicht neu gefragt');
  // Danach wird wieder gefragt - so kehrt die App von selbst zurueck.
  uhr += 2;
  nameZeigt(null);
  assert.deepEqual(await boxWeg(`${BOX}/nas/c`, { konfig: KONFIG, env: {} }), { name: 'direkt', grund: null });
});

test('boxWeg: Normalfall bleibt direkt', async () => {
  nameZeigt(null);
  assert.deepEqual(await boxWeg(`${BOX}/nas/a`, { konfig: KONFIG, env: {} }), { name: 'direkt', grund: null });
});

test('boxWeg: fremde Adressen nie ueber den VPS, auch wenn der Weg gemerkt ist', async () => {
  nameZeigt(PRIVAT);
  await boxWeg(`${BOX}/nas/a`, { konfig: KONFIG, env: {} });
  assert.deepEqual(await boxWeg('https://example.org/nas/x.mp3', { konfig: KONFIG, env: {} }), { name: 'direkt', grund: PRIVAT });
});

test('boxPruefen: kein Einwand, wenn der VPS uebernimmt', async () => {
  nameZeigt(PRIVAT);
  assert.equal(await boxPruefen(`${BOX}/nas/a`, { konfig: KONFIG, env: {} }), null);
  wegVergessen();
  assert.equal(await boxPruefen(`${BOX}/nas/a`, { konfig: null, env: {} }), PRIVAT);
});

test('aufVps: Herkunft des Durchgangs, Pfad und Abfrage unveraendert', () => {
  assert.equal(aufVps(`${BOX}/nas/cgi-bin/luacgi_notimeout?sid=1&path=%2FMusik%2F01%20%C3%A4.mp3`, KONFIG),
    'https://85.215.133.221:8443/nas/cgi-bin/luacgi_notimeout?sid=1&path=%2FMusik%2F01%20%C3%A4.mp3');
});

test('boxFetch ueber den VPS: Schluessel im Kopf, Methode/Range/Koerper bleiben, Antwort markiert', async () => {
  nameZeigt(PRIVAT);
  const antwort = await boxFetch(`${BOX}/nas/api/data.lua`, {
    method: 'POST', body: 'sid=1', headers: { Range: 'bytes=0-9', 'Content-Type': 'application/x-www-form-urlencoded' },
  }, { konfig: KONFIG, env: {} });
  assert.equal(direkte.length, 0);
  assert.equal(ueberVpsAbrufe.length, 1);
  const { url, init } = ueberVpsAbrufe[0];
  assert.equal(url, 'https://85.215.133.221:8443/nas/api/data.lua');
  assert.equal(init.method, 'POST');
  assert.equal(init.body, 'sid=1');
  assert.equal(init.headers.get(SCHLUESSEL_KOPF), KONFIG.key);
  assert.equal(init.headers.get('range'), 'bytes=0-9');
  assert.equal(await antwort.text(), 'vps');
  assert.equal(ueberVps(antwort), true);
});

test('boxFetch im Normalfall: direkt, ohne Schluessel, nicht markiert', async () => {
  nameZeigt(null);
  const antwort = await boxFetch(`${BOX}/nas/a`, { headers: { Range: 'bytes=0-0' } }, { konfig: KONFIG, env: {} });
  assert.equal(direkte.length, 1);
  assert.equal(ueberVpsAbrufe.length, 0);
  assert.equal(new Headers(direkte[0].init.headers).has(SCHLUESSEL_KOPF), false);
  assert.equal(ueberVps(antwort), false);
});

test('boxFetch: abgelehnte Verbindung -> naechster Abruf ueber den VPS; Zeitueberschreitung nicht', async () => {
  nameZeigt(null);
  boxnetz.direkt = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(boxFetch(`${BOX}/nas/a`, {}, { konfig: KONFIG, env: {} }));
  assert.equal(ueberVpsAbrufe.length, 0, 'dieser Abruf wird nicht wiederholt');
  await boxFetch(`${BOX}/nas/b`, {}, { konfig: KONFIG, env: {} });
  assert.equal(ueberVpsAbrufe.length, 1, 'der naechste geht ueber den VPS');

  wegVergessen();
  ueberVpsAbrufe = [];
  boxnetz.direkt = async () => { throw new DOMException('timeout', 'TimeoutError'); };
  await assert.rejects(boxFetch(`${BOX}/nas/a`, {}, { konfig: KONFIG, env: {} }));
  boxnetz.direkt = async () => new Response('direkt');
  await boxFetch(`${BOX}/nas/b`, {}, { konfig: KONFIG, env: {} });
  assert.equal(ueberVpsAbrufe.length, 0, 'eine anlaufende Platte ist kein Ausfall');
});

test('boxFetch: ein Fehler beim VPS aendert den gemerkten Weg nicht und wird weitergereicht', async () => {
  nameZeigt(PRIVAT);
  boxnetz.vps = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(boxFetch(`${BOX}/nas/a`, {}, { konfig: KONFIG, env: {} }));
  assert.equal(direkte.length, 0, 'kein Rueckfall auf den direkten Weg, der ohnehin nicht geht');
});

test('verbindungWeg erkennt nur Fehler beim Verbindungsaufbau', () => {
  assert.equal(verbindungWeg({ cause: { code: 'ECONNREFUSED' } }), true);
  assert.equal(verbindungWeg({ cause: { code: 'ENETUNREACH' } }), true);
  assert.equal(verbindungWeg({ name: 'TimeoutError' }), false);
  assert.equal(verbindungWeg({ cause: { code: 'ECONNRESET' } }), false, 'abgerissen ist nicht weg');
  assert.equal(verbindungWeg(null), false);
});

test('mitUrsprung: Umleitung auf die interne Adresse der Box zeigt wieder auf ihren Namen', async () => {
  const u = new URL(`${BOX}/nas/filelink.lua?id=abc`);
  const umleitung = (ort, status = 302) => new Response(null, { status, headers: { Location: ort, 'Set-Cookie': 'sid=1' } });

  let a = mitUrsprung(umleitung('https://192.168.188.1/nas/index.lua?sid=1'), u, KONFIG);
  assert.equal(a.headers.get('location'), `${BOX}/nas/index.lua?sid=1`);
  assert.equal(a.status, 302);
  assert.deepEqual(a.headers.getSetCookie(), ['sid=1'], 'Cookies bleiben');

  a = mitUrsprung(umleitung('https://85.215.133.221:8443/nas/x'), u, KONFIG);
  assert.equal(a.headers.get('location'), `${BOX}/nas/x`, 'auch die Adresse des Durchgangs selbst');

  a = mitUrsprung(umleitung('/nas/index.lua?sid=2'), u, KONFIG);
  assert.equal(a.headers.get('location'), '/nas/index.lua?sid=2', 'relativ bleibt relativ - und zeigt auf die Box');

  a = mitUrsprung(umleitung('https://192.168.188.1/login_sid.lua'), u, KONFIG);
  assert.equal(a.headers.get('location'), 'https://192.168.188.1/login_sid.lua', 'ausserhalb /nas/ unangetastet');

  a = mitUrsprung(umleitung('https://example.org/nas/x'), u, KONFIG);
  assert.equal(a.headers.get('location'), 'https://example.org/nas/x', 'fremder Name unangetastet');

  const ohne = new Response('x', { status: 200 });
  assert.equal(mitUrsprung(ohne, u, KONFIG), ohne);
});

test('boxFetch reicht die umgeschriebene Umleitung durch', async () => {
  nameZeigt(PRIVAT);
  boxnetz.vps = async () => new Response(null, { status: 303, headers: { Location: 'https://192.168.188.1/nas/x?sid=9' } });
  const antwort = await boxFetch(`${BOX}/nas/filelink.lua?id=abc`, { redirect: 'manual' }, { konfig: KONFIG, env: {} });
  assert.equal(antwort.status, 303);
  assert.equal(antwort.headers.get('location'), `${BOX}/nas/x?sid=9`);
  assert.equal(ueberVps(antwort), true);
});

test('boxFetch ueber den VPS folgt nie selbst einer Umleitung - der Schluessel bleibt beim Durchgang', async () => {
  nameZeigt(PRIVAT);
  await boxFetch(`${BOX}/nas/a`, { redirect: 'follow' }, { konfig: KONFIG, env: {} });
  assert.equal(ueberVpsAbrufe[0].init.redirect, 'manual');
});

test('boxFetch ohne Durchgang fragt keinen Namen nach', async () => {
  nameZeigt(null);
  await boxFetch(`${BOX}/nas/a`, {}, { konfig: null, env: {} });
  await boxFetch('https://example.org/nas/a', {}, { konfig: KONFIG, env: {} });
  assert.equal(gefragt, 0);
  assert.equal(direkte.length, 2);
});
