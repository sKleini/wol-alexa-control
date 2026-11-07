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
  fritzEndpunkte,
  eigenschaften,
  erreichbar,
  eintragFuer,
  istFritz,
  befehlFuer,
  handleFritz,
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


// ---------------------------------------------------------- Discovery ---

const JETZT = ZEIT * 1000 + 30_000;   // 30 s nach dem Abruf bei der Box

const nach = (endpunkte, id) => endpunkte.find(e => e.endpointId === `fritz-${id}`);
const schnittstelle = (e, name, instance) =>
  e.capabilities.find(c => c.interface === name && (instance === undefined || c.instance === instance));
const eigenschaft = (props, namespace, name) => props.find(p => p.namespace === namespace && p.name === name);

test('discovery_ohne_stand_ist_leer', () => {
  assert.deepEqual(fritzEndpunkte(null), []);
  assert.deepEqual(fritzEndpunkte({ v: 2 }), []);
});

test('discovery_heizkoerperregler', () => {
  const e = nach(fritzEndpunkte(standBeispiel()), '116570272633');
  assert.equal(e.friendlyName, 'Heizung Wohnzimmer');
  assert.deepEqual(e.displayCategories, ['THERMOSTAT']);
  assert.equal(e.description, 'FRITZ! Heizkörperregler');
  const thermostat = schnittstelle(e, 'Alexa.ThermostatController');
  assert.deepEqual(thermostat.properties.supported, [{ name: 'targetSetpoint' }, { name: 'thermostatMode' }]);
  assert.equal(thermostat.properties.retrievable, true);
  assert.equal(thermostat.properties.proactivelyReported, false);
  assert.deepEqual(thermostat.configuration, { supportedModes: ['HEAT', 'ECO', 'OFF'], supportsScheduling: false });
  assert.ok(schnittstelle(e, 'Alexa.TemperatureSensor'));
  const boost = schnittstelle(e, 'Alexa.ToggleController', 'Fritz.Boost');
  assert.deepEqual(boost.capabilityResources.friendlyNames,
    [{ '@type': 'text', value: { text: 'Boost', locale: 'de-DE' } }]);
  assert.deepEqual(schnittstelle(e, 'Alexa.EndpointHealth').properties.supported,
    [{ name: 'connectivity' }, { name: 'battery' }]);
  assert.ok(schnittstelle(e, 'Alexa'));
});

test('discovery_steckdose_mit_und_ohne_messer', () => {
  const endpunkte = fritzEndpunkte(standBeispiel());
  const keller = nach(endpunkte, '087610123456');
  assert.deepEqual(keller.displayCategories, ['SMARTPLUG']);
  assert.ok(schnittstelle(keller, 'Alexa.PowerController'));
  assert.ok(schnittstelle(keller, 'Alexa.TemperatureSensor'));
  const leistung = schnittstelle(keller, 'Alexa.RangeController', 'Fritz.Leistung');
  assert.equal(leistung.properties.nonControllable, true);
  assert.equal(leistung.capabilityResources.friendlyNames[0].value.text, 'Leistung in Watt');
  assert.deepEqual(leistung.configuration.supportedRange, { minimumValue: 0, maximumValue: 3680, precision: 0.1 });
  const terrasse = nach(endpunkte, '087610654321');
  assert.equal(schnittstelle(terrasse, 'Alexa.TemperatureSensor'), undefined);
  assert.equal(schnittstelle(terrasse, 'Alexa.RangeController'), undefined);
});

test('discovery_vorlage_als_szene', () => {
  const e = nach(fritzEndpunkte(standBeispiel()), 'tmp6f2c1a-3c8b1e4f2');
  assert.deepEqual(e.displayCategories, ['SCENE_TRIGGER']);
  assert.equal(schnittstelle(e, 'Alexa.SceneController').supportsDeactivation, false);
  assert.equal(e.friendlyName, 'Alles aus');
});

test('alle_endpunkte_fritz_und_eindeutig', () => {
  const ids = fritzEndpunkte(standBeispiel()).map(e => e.endpointId);
  assert.equal(ids.length, 6);
  assert.ok(ids.every(id => id.startsWith('fritz-')));
  assert.equal(new Set(ids).size, ids.length);
});

// ------------------------------------------------------------ Zustand ---

test('eintrag_fuer', () => {
  const stand = standBeispiel();
  assert.equal(eintragFuer(stand, 'fritz-116570272633').name, 'Heizung Wohnzimmer');
  assert.equal(eintragFuer(stand, 'fritz-tmp6f2c1a-3c8b1e4f2').art, 'vorlage');
  assert.equal(eintragFuer(stand, 'fritz-000000000000'), null);
  assert.equal(eintragFuer(stand, 'endpoint-116570272633'), null);
  assert.equal(eintragFuer(null, 'fritz-116570272633'), null);
});

test('zustand_regler_heizt', () => {
  const stand = standBeispiel();
  const props = eigenschaften(eintragFuer(stand, 'fritz-116570272633'), stand, JETZT);
  assert.deepEqual(eigenschaft(props, 'Alexa.ThermostatController', 'targetSetpoint').value, { value: 21, scale: 'CELSIUS' });
  assert.equal(eigenschaft(props, 'Alexa.ThermostatController', 'thermostatMode').value, 'HEAT');
  assert.deepEqual(eigenschaft(props, 'Alexa.TemperatureSensor', 'temperature').value, { value: 20.5, scale: 'CELSIUS' });
  const boost = eigenschaft(props, 'Alexa.ToggleController', 'toggleState');
  assert.equal(boost.value, 'OFF');
  assert.equal(boost.instance, 'Fritz.Boost');
  assert.deepEqual(eigenschaft(props, 'Alexa.EndpointHealth', 'connectivity').value, { value: 'OK' });
  assert.deepEqual(eigenschaft(props, 'Alexa.EndpointHealth', 'battery').value,
    { health: { state: 'OK', reasons: [] }, levelPercentage: 80 });
  for (const p of props) {
    assert.equal(p.timeOfSample, new Date(ZEIT * 1000).toISOString());
    assert.equal(p.uncertaintyInMilliseconds, 30_000);
  }
});

test('zustand_regler_aus_mit_boost_und_schwacher_batterie', () => {
  const stand = standBeispiel();
  const props = eigenschaften(eintragFuer(stand, 'fritz-116570111111'), stand, JETZT);
  assert.equal(eigenschaft(props, 'Alexa.ThermostatController', 'targetSetpoint'), undefined);
  assert.equal(eigenschaft(props, 'Alexa.ThermostatController', 'thermostatMode').value, 'OFF');
  assert.equal(eigenschaft(props, 'Alexa.ToggleController', 'toggleState').value, 'ON');
  assert.deepEqual(eigenschaft(props, 'Alexa.EndpointHealth', 'battery').value,
    { health: { state: 'WARNING', reasons: ['LOW_CHARGE'] }, levelPercentage: 10 });
});

test('zustand_nicht_erreichbar', () => {
  const stand = standBeispiel();
  const buero = eintragFuer(stand, 'fritz-116570222222');
  assert.equal(erreichbar(buero, stand, JETZT), false);
  assert.deepEqual(eigenschaft(eigenschaften(buero, stand, JETZT), 'Alexa.EndpointHealth', 'connectivity').value,
    { value: 'UNREACHABLE' });
  // Kein Ist-Wert bei abwesendem Geraet - nicht 0 melden.
  assert.equal(eigenschaft(eigenschaften(buero, stand, JETZT), 'Alexa.TemperatureSensor', 'temperature'), undefined);
  const wz = eintragFuer(stand, 'fritz-116570272633');
  assert.equal(erreichbar(wz, stand, ZEIT * 1000 + 900_000), true);
  assert.equal(erreichbar(wz, stand, ZEIT * 1000 + 901_000), false);
  assert.deepEqual(
    eigenschaft(eigenschaften(wz, stand, ZEIT * 1000 + 901_000), 'Alexa.EndpointHealth', 'connectivity').value,
    { value: 'UNREACHABLE' });
});

test('zustand_steckdose', () => {
  const stand = standBeispiel();
  const props = eigenschaften(eintragFuer(stand, 'fritz-087610123456'), stand, JETZT);
  assert.equal(eigenschaft(props, 'Alexa.PowerController', 'powerState').value, 'ON');
  assert.deepEqual(eigenschaft(props, 'Alexa.TemperatureSensor', 'temperature').value, { value: 18, scale: 'CELSIUS' });
  const leistung = eigenschaft(props, 'Alexa.RangeController', 'rangeValue');
  assert.equal(leistung.value, 12.3);
  assert.equal(leistung.instance, 'Fritz.Leistung');
  const terrasse = eigenschaften(eintragFuer(stand, 'fritz-087610654321'), stand, JETZT);
  assert.equal(eigenschaft(terrasse, 'Alexa.PowerController', 'powerState').value, 'OFF');
  assert.equal(eigenschaft(terrasse, 'Alexa.RangeController', 'rangeValue'), undefined);
});


// --------------------------------------------------------- Direktiven ---

const WZ = 'fritz-116570272633';      // Heizung Wohnzimmer, HEAT 21
const BAD = 'fritz-116570111111';     // Heizung Bad, OFF, Boost an
const BUERO = 'fritz-116570222222';   // nicht da
const KELLER = 'fritz-087610123456';  // Steckdose an
const VORLAGE = 'fritz-tmp6f2c1a-3c8b1e4f2';

function direktive(namespace, name, endpointId, payload = {}, instance) {
  return {
    directive: {
      header: { namespace, name, messageId: 'm-1', correlationToken: 'ct-1', payloadVersion: '3',
                ...(instance ? { instance } : {}) },
      endpoint: { endpointId, scope: { type: 'BearerToken', token: 'x' } },
      payload,
    },
  };
}

const soll = (value, scale = 'CELSIUS') => ({ targetSetpoint: { value, scale } });

async function sende(anfrage, { stand = standBeispiel(), jetztMs = JETZT, env = process.env, wirft = false } = {}) {
  const gesendet = [];
  const senden = async (url, opts) => {
    gesendet.push({ url, ...opts });
    if (wirft) throw new Error('ntfy weg');
    return { ok: true };
  };
  const redis = redisMit(stand ? { [FRITZ_SCHLUESSEL]: stand } : {});
  const res = antwortFaenger();
  await handleFritz(anfrage, res, redis, { env, senden, jetztMs });
  return { res, gesendet, redis };
}

const nachricht = (befehl, id, wert) => `fritz:${befehl}:${id}:${wert}:relay-pw`;
const ctx = (res, namespace, name) => res.body.context.properties.find(p => p.namespace === namespace && p.name === name);

test('ist_fritz', () => {
  assert.equal(istFritz(WZ), true);
  assert.equal(istFritz('endpoint-fritzbox-led'), false);
  assert.equal(istFritz(undefined), false);
});

test('soll_temperatur_setzen', async () => {
  const { res, gesendet } = await sende(direktive('Alexa.ThermostatController', 'SetTargetTemperature', WZ, soll(21.3)));
  assert.equal(gesendet.length, 1);
  assert.equal(gesendet[0].url, 'https://ntfy.sh/fritz-0123456789abcdef');
  assert.equal(gesendet[0].method, 'POST');
  assert.equal(gesendet[0].body, nachricht('soll', '116570272633', '21.5'));
  assert.equal(res.body.event.header.name, 'Response');
  assert.equal(res.body.event.header.correlationToken, 'ct-1');
  assert.deepEqual(ctx(res, 'Alexa.ThermostatController', 'targetSetpoint').value, { value: 21.5, scale: 'CELSIUS' });
  assert.equal(ctx(res, 'Alexa.ThermostatController', 'thermostatMode').value, 'HEAT');
});

test('fahrenheit_und_kelvin_werden_umgerechnet', async () => {
  for (const [wert, skala] of [[70, 'FAHRENHEIT'], [294.15, 'KELVIN']]) {
    const { gesendet } = await sende(direktive('Alexa.ThermostatController', 'SetTargetTemperature', WZ, soll(wert, skala)));
    assert.equal(gesendet[0].body, nachricht('soll', '116570272633', '21.0'), skala);
  }
});

test('ausserhalb_des_bereichs_nichts_senden', async () => {
  for (const wert of [30, 7, 85]) {
    const skala = wert === 85 ? 'FAHRENHEIT' : 'CELSIUS';
    const { res, gesendet } = await sende(direktive('Alexa.ThermostatController', 'SetTargetTemperature', WZ, soll(wert, skala)));
    assert.equal(gesendet.length, 0);
    assert.equal(res.body.event.header.name, 'ErrorResponse');
    assert.equal(res.body.event.payload.type, 'TEMPERATURE_VALUE_OUT_OF_RANGE');
    assert.deepEqual(res.body.event.payload.validRange, {
      minimumValue: { value: 8, scale: 'CELSIUS' }, maximumValue: { value: 28, scale: 'CELSIUS' },
    });
  }
});

test('waermer_und_kaelter', async () => {
  const delta = (value, scale = 'CELSIUS') => ({ targetSetpointDelta: { value, scale } });
  let r = await sende(direktive('Alexa.ThermostatController', 'AdjustTargetTemperature', WZ, delta(1)));
  assert.equal(r.gesendet[0].body, nachricht('soll', '116570272633', '22.0'));
  r = await sende(direktive('Alexa.ThermostatController', 'AdjustTargetTemperature', WZ, delta(-2)));
  assert.equal(r.gesendet[0].body, nachricht('soll', '116570272633', '19.0'));
  // Aus: Basis ist die Komforttemperatur (Bad: 22) - "waermer" heisst einschalten.
  r = await sende(direktive('Alexa.ThermostatController', 'AdjustTargetTemperature', BAD, delta(1)));
  assert.equal(r.gesendet[0].body, nachricht('soll', '116570111111', '23.0'));
  // Fahrenheit-Delta: 9 F = 5 C.
  r = await sende(direktive('Alexa.ThermostatController', 'AdjustTargetTemperature', WZ, delta(-9, 'FAHRENHEIT')));
  assert.equal(r.gesendet[0].body, nachricht('soll', '116570272633', '16.0'));
});

test('modus_setzen', async () => {
  const modus = (value) => ({ thermostatMode: { value } });
  const faelle = [['ECO', 'absenk', 17], ['HEAT', 'komfort', 21], ['OFF', 'aus', null]];
  for (const [wert, nachrichtWert, setpoint] of faelle) {
    const { res, gesendet } = await sende(direktive('Alexa.ThermostatController', 'SetThermostatMode', WZ, modus(wert)));
    assert.equal(gesendet[0].body, nachricht('soll', '116570272633', nachrichtWert));
    assert.equal(ctx(res, 'Alexa.ThermostatController', 'thermostatMode').value, wert);
    const ziel = ctx(res, 'Alexa.ThermostatController', 'targetSetpoint');
    if (setpoint === null) assert.equal(ziel, undefined);
    else assert.deepEqual(ziel.value, { value: setpoint, scale: 'CELSIUS' });
  }
  const { res, gesendet } = await sende(direktive('Alexa.ThermostatController', 'SetThermostatMode', WZ, modus('AUTO')));
  assert.equal(gesendet.length, 0);
  assert.equal(res.body.event.header.namespace, 'Alexa.ThermostatController');
  assert.equal(res.body.event.payload.type, 'UNSUPPORTED_THERMOSTAT_MODE');
});

test('boost_steckdose_vorlage', async () => {
  let r = await sende(direktive('Alexa.ToggleController', 'TurnOn', WZ, {}, 'Fritz.Boost'));
  assert.equal(r.gesendet[0].body, nachricht('boost', '116570272633', 'an'));
  const boost = ctx(r.res, 'Alexa.ToggleController', 'toggleState');
  assert.equal(boost.value, 'ON');
  assert.equal(boost.instance, 'Fritz.Boost');
  r = await sende(direktive('Alexa.ToggleController', 'TurnOff', BAD, {}, 'Fritz.Boost'));
  assert.equal(r.gesendet[0].body, nachricht('boost', '116570111111', 'aus'));
  r = await sende(direktive('Alexa.PowerController', 'TurnOff', KELLER));
  assert.equal(r.gesendet[0].body, nachricht('schalten', '087610123456', 'aus'));
  assert.equal(ctx(r.res, 'Alexa.PowerController', 'powerState').value, 'OFF');
  r = await sende(direktive('Alexa.SceneController', 'Activate', VORLAGE));
  assert.equal(r.gesendet[0].body, nachricht('vorlage', 'tmp6f2c1a-3c8b1e4f2', '-'));
  assert.equal(r.res.body.event.header.namespace, 'Alexa.SceneController');
  assert.equal(r.res.body.event.header.name, 'ActivationStarted');
});

test('falsche_direktive_fuer_die_art', async () => {
  for (const anfrage of [
    direktive('Alexa.PowerController', 'TurnOn', WZ),
    direktive('Alexa.ThermostatController', 'SetTargetTemperature', KELLER, soll(21)),
    direktive('Alexa.ToggleController', 'TurnOn', WZ, {}, 'Fritz.Fenster'),
    direktive('Alexa.SceneController', 'Deactivate', VORLAGE),
  ]) {
    const { res, gesendet } = await sende(anfrage);
    assert.equal(gesendet.length, 0);
    assert.equal(res.body.event.payload.type, 'INVALID_DIRECTIVE');
  }
  assert.ok(befehlFuer(direktive('Alexa.PowerController', 'TurnOn', WZ).directive, { art: 'hkr' }).fehler);
});

test('report_state', async () => {
  const { res, gesendet } = await sende(direktive('Alexa', 'ReportState', WZ));
  assert.equal(gesendet.length, 0);
  assert.equal(res.body.event.header.namespace, 'Alexa');
  assert.equal(res.body.event.header.name, 'StateReport');
  assert.equal(res.body.event.header.correlationToken, 'ct-1');
  assert.deepEqual(ctx(res, 'Alexa.ThermostatController', 'targetSetpoint').value, { value: 21, scale: 'CELSIUS' });
  // Auch ein abwesendes Geraet bekommt einen Bericht - mit UNREACHABLE.
  const buero = await sende(direktive('Alexa', 'ReportState', BUERO));
  assert.deepEqual(ctx(buero.res, 'Alexa.EndpointHealth', 'connectivity').value, { value: 'UNREACHABLE' });
});

test('unbekanntes_geraet', async () => {
  for (const anfrage of [
    direktive('Alexa.PowerController', 'TurnOn', 'fritz-000000000000'),
    direktive('Alexa', 'ReportState', 'fritz-000000000000'),
  ]) {
    const { res, gesendet } = await sende(anfrage);
    assert.equal(gesendet.length, 0);
    assert.equal(res.body.event.payload.type, 'NO_SUCH_ENDPOINT');
  }
  const ohneStand = await sende(direktive('Alexa.PowerController', 'TurnOn', KELLER), { stand: null });
  assert.equal(ohneStand.res.body.event.payload.type, 'NO_SUCH_ENDPOINT');
});

test('nicht_erreichbar_nichts_senden', async () => {
  let r = await sende(direktive('Alexa.ThermostatController', 'SetTargetTemperature', BUERO, soll(21)));
  assert.equal(r.gesendet.length, 0);
  assert.equal(r.res.body.event.payload.type, 'ENDPOINT_UNREACHABLE');
  r = await sende(direktive('Alexa.PowerController', 'TurnOn', KELLER), { jetztMs: ZEIT * 1000 + 901_000 });
  assert.equal(r.gesendet.length, 0);
  assert.equal(r.res.body.event.payload.type, 'ENDPOINT_UNREACHABLE');
});

test('ohne_topic_oder_passwort_internal_error', async () => {
  for (const env of [{ FRITZ_PASSWORD: 'relay-pw' }, { FRITZ_TOPIC: 'fritz-0123456789abcdef' }]) {
    const { res, gesendet } = await sende(direktive('Alexa.PowerController', 'TurnOn', KELLER), { env });
    assert.equal(gesendet.length, 0);
    assert.equal(res.body.event.payload.type, 'INTERNAL_ERROR');
  }
});

test('ntfy_weg_trotzdem_response', async () => {
  const { res, gesendet } = await sende(direktive('Alexa.PowerController', 'TurnOn', KELLER), { wirft: true });
  assert.equal(gesendet.length, 1);
  assert.equal(res.body.event.header.name, 'Response');
});

// ------------------------------------------ Befunde der Schlusspruefung ---

test('stand_mit_rohwerten_wird_angenommen', () => {
  // Das Relay traegt fuer Heizen/Eco die AHA-Rohwerte mit (komfortAha, absenkAha).
  const stand = standBeispiel();
  Object.assign(stand.geraete[0], { komfortAha: 42, absenkAha: 253, absenk: null });
  assert.equal(standOk(stand), true);
});

test('eco_mit_absenkung_aus_meldet_keinen_null_sollwert', async () => {
  const stand = standBeispiel();
  stand.geraete[0].absenk = null;   // Absenktemperatur "Aus" in der Box
  const { res, gesendet } = await sende(
    direktive('Alexa.ThermostatController', 'SetThermostatMode', WZ, { thermostatMode: { value: 'ECO' } }), { stand });
  assert.equal(gesendet[0].body, nachricht('soll', '116570272633', 'absenk'));
  assert.equal(ctx(res, 'Alexa.ThermostatController', 'targetSetpoint'), undefined);
  assert.equal(ctx(res, 'Alexa.ThermostatController', 'thermostatMode').value, 'ECO');
});

test('waermer_ohne_komforttemperatur_bei_aus', async () => {
  const stand = standBeispiel();
  stand.geraete[1].komfort = null;  // Bad: aus, Komfort unbekannt
  const { res, gesendet } = await sende(
    direktive('Alexa.ThermostatController', 'AdjustTargetTemperature', BAD, { targetSetpointDelta: { value: 1, scale: 'CELSIUS' } }), { stand });
  assert.equal(gesendet.length, 0);
  assert.equal(res.body.event.header.namespace, 'Alexa.ThermostatController');
  assert.equal(res.body.event.payload.type, 'THERMOSTAT_IS_OFF');
});
