// lib/fritz.js – FRITZ! Smart Home im Smart Home Skill: Heizkoerperregler,
// Steckdosen und Vorlagen des Routers FRITZ!Box 7590AX in Weinsheim.
//
// Der VPS (Dienst fritz-smarthome-relay, Repo wireguard-vps-strato, Workflow
// 41) liest die Box alle 60 s ueber den wg1-Tunnel und schiebt den Stand
// hierher; Alexa bekommt Discovery und ReportState aus diesem Stand, ohne dass
// jemand die Box fragt. Befehle gehen als ntfy-Nachricht an das Relay zurueck:
//
//   POST /api/fritz   (X-Fritz-Push-Schluessel)  Stand vom VPS -> Redis fritz:stand
//   api/alexa.js      Discover / ReportState / Thermostat / Schalter / Szene
//
// **Warum nicht api/fritz.js.** Der Hobby-Tarif erlaubt zwoelf Funktionen, und
// api/ hat zwoelf. api/relay-status.js leitet hierher weiter, vercel.json
// schreibt /api/fritz dorthin um.
//
// **Keine abgewiesene Anfrage kostet einen Redis-Befehl:** Schluessel, Groesse
// und Form werden vorher geprueft - Upstash rechnet je Befehl ab.
//
// Entwurf: docs/fritz-smarthome-entwurf.md (Repo wireguard-vps-strato).
import { createHash, timingSafeEqual } from 'node:crypto'

export const FRITZ_SCHLUESSEL = 'fritz:stand'
export const MAX_ALTER_S = 900          // drei verpasste Lebenszeichen (alle 5 min)
export const MAX_BYTES = 65536
export const MAX_GERAETE = 100
export const MAX_VORLAGEN = 50

const ID_MUSTER = /^[0-9a-z-]{1,40}$/;
const MODI = new Set(['HEAT', 'ECO', 'OFF']);

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest();

/** Bringt die Anfrage den Push-Schluessel des VPS mit? Fail-closed. */
export function pushSchluesselOk(req) {
  const erwartet = process.env.FRITZ_PUSH_SCHLUESSEL;
  const kommt = req.headers?.['x-fritz-push-schluessel'];
  if (!erwartet || typeof kommt !== 'string') return false;
  return timingSafeEqual(sha256(kommt), sha256(erwartet));
}

const zahlOderNull = (w) => w === null || (typeof w === 'number' && Number.isFinite(w));
const text = (w, max = 100) => typeof w === 'string' && w.length > 0 && w.length <= max;

function geraetOk(g) {
  if (!g || typeof g !== 'object') return false;
  if (!ID_MUSTER.test(g.id ?? '') || !text(g.ain, 40) || !text(g.name)) return false;
  if (typeof g.da !== 'boolean') return false;
  if (g.art === 'hkr') {
    return zahlOderNull(g.temp) && zahlOderNull(g.soll) && MODI.has(g.modus)
      && zahlOderNull(g.komfort) && zahlOderNull(g.absenk) && typeof g.boost === 'boolean'
      && zahlOderNull(g.batterie ?? null) && typeof g.batterieLeer === 'boolean';
  }
  if (g.art === 'dose') {
    return typeof g.an === 'boolean' && zahlOderNull(g.temp ?? null) && zahlOderNull(g.watt ?? null);
  }
  return false;
}

const vorlageOk = (v) => v && typeof v === 'object' && ID_MUSTER.test(v.id ?? '')
  && text(v.name) && (v.ain === undefined || text(v.ain, 40));

/** Genau die Form, die das Relay schiebt (Entwurf 4) - mehr nimmt die Funktion nicht an. */
export function standOk(stand) {
  return !!stand && typeof stand === 'object' && stand.v === 1
    && Number.isInteger(stand.zeit)
    && Array.isArray(stand.geraete) && stand.geraete.length <= MAX_GERAETE
    && Array.isArray(stand.vorlagen) && stand.vorlagen.length <= MAX_VORLAGEN
    && stand.geraete.every(geraetOk) && stand.vorlagen.every(vorlageOk);
}

/** Wert aus Redis -> Stand oder null. Upstash liefert JSON meist schon geparst. */
export function standAus(wert) {
  let stand = wert;
  if (typeof wert === 'string') {
    try { stand = JSON.parse(wert); } catch { return null; }
  }
  return standOk(stand) ? stand : null;
}

/** POST /api/fritz: Stand vom VPS annehmen. */
export async function handleFritzPush(req, res, redis) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!pushSchluesselOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    let stand = req.body;
    if (typeof stand === 'string') {
      if (Buffer.byteLength(stand) > MAX_BYTES) return res.status(413).json({ error: 'Too large' });
      try { stand = JSON.parse(stand); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    } else if (Buffer.byteLength(JSON.stringify(stand ?? null)) > MAX_BYTES) {
      return res.status(413).json({ error: 'Too large' });
    }
    if (!standOk(stand)) return res.status(400).json({ error: 'Invalid stand' });
    await redis.set(FRITZ_SCHLUESSEL, stand);
    return res.status(204).end();
  } catch (err) {
    console.error('fritz push error:', err?.message);
    return res.status(500).json({ error: 'Fritz push failed' });
  }
}

// --------------------------------------------------------- Discovery ---

const PRAEFIX = 'fritz-';
const HERSTELLER = 'AVM über Kleini';

const mitEigenschaften = (iface, namen, extra = {}) => ({
  type: 'AlexaInterface',
  interface: iface,
  version: '3',
  properties: { supported: namen.map(name => ({ name })), proactivelyReported: false, retrievable: true },
  ...extra,
});

const name = (text) => ({ friendlyNames: [{ '@type': 'text', value: { text, locale: 'de-DE' } }] });
const ALEXA = { type: 'AlexaInterface', interface: 'Alexa', version: '3' };

function endpunktRegler(g) {
  return {
    endpointId: PRAEFIX + g.id,
    manufacturerName: HERSTELLER,
    friendlyName: g.name,
    description: 'FRITZ! Heizkörperregler',
    displayCategories: ['THERMOSTAT'],
    capabilities: [
      mitEigenschaften('Alexa.ThermostatController', ['targetSetpoint', 'thermostatMode'], {
        configuration: { supportedModes: ['HEAT', 'ECO', 'OFF'], supportsScheduling: false },
      }),
      mitEigenschaften('Alexa.TemperatureSensor', ['temperature']),
      mitEigenschaften('Alexa.ToggleController', ['toggleState'], {
        instance: 'Fritz.Boost',
        capabilityResources: name('Boost'),
      }),
      mitEigenschaften('Alexa.EndpointHealth', ['connectivity', 'battery']),
      ALEXA,
    ],
  };
}

function endpunktDose(g) {
  const capabilities = [mitEigenschaften('Alexa.PowerController', ['powerState'])];
  if ('temp' in g) capabilities.push(mitEigenschaften('Alexa.TemperatureSensor', ['temperature']));
  if ('watt' in g) {
    // Nur Anzeige. Alexas Einheitenliste kennt kein Watt - deshalb steht die
    // Einheit im Namen statt in unitOfMeasure.
    const leistung = mitEigenschaften('Alexa.RangeController', ['rangeValue'], {
      instance: 'Fritz.Leistung',
      capabilityResources: name('Leistung in Watt'),
      configuration: { supportedRange: { minimumValue: 0, maximumValue: 3680, precision: 0.1 } },
    });
    leistung.properties.nonControllable = true;
    capabilities.push(leistung);
  }
  capabilities.push(mitEigenschaften('Alexa.EndpointHealth', ['connectivity']), ALEXA);
  return {
    endpointId: PRAEFIX + g.id,
    manufacturerName: HERSTELLER,
    friendlyName: g.name,
    description: 'FRITZ! Steckdose',
    displayCategories: ['SMARTPLUG'],
    capabilities,
  };
}

function endpunktVorlage(v) {
  return {
    endpointId: PRAEFIX + v.id,
    manufacturerName: HERSTELLER,
    friendlyName: v.name,
    description: 'FRITZ! Vorlage',
    displayCategories: ['SCENE_TRIGGER'],
    capabilities: [
      { type: 'AlexaInterface', interface: 'Alexa.SceneController', version: '3', supportsDeactivation: false },
      ALEXA,
    ],
  };
}

/** Discovery-Endpunkte aus dem Stand; ohne gueltigen Stand keine. */
export function fritzEndpunkte(stand) {
  if (!standOk(stand)) return [];
  return [
    ...stand.geraete.map(g => (g.art === 'hkr' ? endpunktRegler(g) : endpunktDose(g))),
    ...stand.vorlagen.map(endpunktVorlage),
  ];
}

// ----------------------------------------------------------- Zustand ---

/** Eintrag zu einer endpointId; Vorlagen kommen mit art 'vorlage' zurueck. */
export function eintragFuer(stand, endpointId) {
  if (!stand || typeof endpointId !== 'string' || !endpointId.startsWith(PRAEFIX)) return null;
  const id = endpointId.slice(PRAEFIX.length);
  const geraet = stand.geraete?.find(g => g.id === id);
  if (geraet) return geraet;
  const vorlage = stand.vorlagen?.find(v => v.id === id);
  return vorlage ? { ...vorlage, art: 'vorlage' } : null;
}

/** Erreichbar heisst: Box meldet das Geraet und der Stand ist hoechstens 15 min alt. */
export function erreichbar(eintrag, stand, jetztMs) {
  return eintrag.da !== false && jetztMs - stand.zeit * 1000 <= MAX_ALTER_S * 1000;
}

/** Alexa-Properties eines Eintrags, mit Zeitpunkt und Alter des Stands. */
export function eigenschaften(eintrag, stand, jetztMs) {
  const zeit = {
    timeOfSample: new Date(stand.zeit * 1000).toISOString(),
    uncertaintyInMilliseconds: Math.max(0, jetztMs - stand.zeit * 1000),
  };
  const props = [];
  const add = (namespace, n, value, instance) =>
    props.push({ namespace, ...(instance ? { instance } : {}), name: n, value, ...zeit });
  const da = erreichbar(eintrag, stand, jetztMs);
  const grad = (value) => ({ value, scale: 'CELSIUS' });

  if (eintrag.art === 'hkr') {
    if (eintrag.soll !== null) add('Alexa.ThermostatController', 'targetSetpoint', grad(eintrag.soll));
    add('Alexa.ThermostatController', 'thermostatMode', eintrag.modus);
    if (da && eintrag.temp !== null) add('Alexa.TemperatureSensor', 'temperature', grad(eintrag.temp));
    add('Alexa.ToggleController', 'toggleState', eintrag.boost ? 'ON' : 'OFF', 'Fritz.Boost');
  } else if (eintrag.art === 'dose') {
    add('Alexa.PowerController', 'powerState', eintrag.an ? 'ON' : 'OFF');
    if (da && eintrag.temp != null) add('Alexa.TemperatureSensor', 'temperature', grad(eintrag.temp));
    if (da && eintrag.watt != null) add('Alexa.RangeController', 'rangeValue', eintrag.watt, 'Fritz.Leistung');
  }
  if (eintrag.art !== 'vorlage') {
    add('Alexa.EndpointHealth', 'connectivity', { value: da ? 'OK' : 'UNREACHABLE' });
  }
  if (eintrag.art === 'hkr' && eintrag.batterie != null) {
    add('Alexa.EndpointHealth', 'battery', {
      health: eintrag.batterieLeer ? { state: 'WARNING', reasons: ['LOW_CHARGE'] } : { state: 'OK', reasons: [] },
      levelPercentage: eintrag.batterie,
    });
  }
  return props;
}

// -------------------------------------------------------- Direktiven ---

export const GRAD_MIN = 8
export const GRAD_MAX = 28
const BOOST = 'Fritz.Boost';

export const istFritz = (endpointId) => typeof endpointId === 'string' && endpointId.startsWith(PRAEFIX);

function inCelsius({ value, scale } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (scale === 'FAHRENHEIT') return (value - 32) * 5 / 9;
  if (scale === 'KELVIN') return value - 273.15;
  return value;
}

function deltaInCelsius({ value, scale } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return scale === 'FAHRENHEIT' ? value * 5 / 9 : value;
}

const grad = (value) => ({ value, scale: 'CELSIUS' });
const ziel = (namespace, name, value, instance) => ({ namespace, ...(instance ? { instance } : {}), name, value });
const ungueltig = (message) => ({ fehler: { type: 'INVALID_DIRECTIVE', message } });

/** Sollwert pruefen, auf 0,5 runden; 7,75-28,25 gilt noch als im Bereich. */
function sollBefehl(celsius) {
  if (celsius === null) return ungueltig('No temperature');
  if (celsius < GRAD_MIN - 0.25 || celsius > GRAD_MAX + 0.25) {
    return { fehler: {
      type: 'TEMPERATURE_VALUE_OUT_OF_RANGE',
      message: `Temperature must be between ${GRAD_MIN} and ${GRAD_MAX} °C`,
      validRange: { minimumValue: grad(GRAD_MIN), maximumValue: grad(GRAD_MAX) },
    } };
  }
  const wert = Math.min(GRAD_MAX, Math.max(GRAD_MIN, Math.round(celsius * 2) / 2));
  return {
    befehl: 'soll',
    wert: wert.toFixed(1),
    ziel: [ziel('Alexa.ThermostatController', 'targetSetpoint', grad(wert)),
           ziel('Alexa.ThermostatController', 'thermostatMode', 'HEAT')],
  };
}

function thermostatBefehl(name, payload, eintrag) {
  if (name === 'SetTargetTemperature') return sollBefehl(inCelsius(payload.targetSetpoint));
  if (name === 'AdjustTargetTemperature') {
    const delta = deltaInCelsius(payload.targetSetpointDelta);
    if (delta === null) return ungueltig('No delta');
    const basis = eintrag.modus === 'OFF' || eintrag.soll === null ? eintrag.komfort : eintrag.soll;
    if (basis === null) {
      // Aus, und die Komforttemperatur ist selbst "aus": es gibt nichts, wovon
      // "waermer" ausgehen koennte.
      return { fehler: { namespace: 'Alexa.ThermostatController', type: 'THERMOSTAT_IS_OFF',
                         message: 'Thermostat is off and has no comfort temperature' } };
    }
    return sollBefehl(basis + delta);
  }
  if (name === 'SetThermostatMode') {
    const modus = payload.thermostatMode?.value;
    if (modus === 'HEAT' || modus === 'ECO') {
      // Komfort/Absenkung koennen in der Box selbst "aus" sein (null im Stand):
      // dann ohne Sollwert antworten statt mit {value: null}.
      const temperatur = modus === 'HEAT' ? eintrag.komfort : eintrag.absenk;
      return {
        befehl: 'soll',
        wert: modus === 'HEAT' ? 'komfort' : 'absenk',
        ziel: [...(temperatur === null ? [] : [ziel('Alexa.ThermostatController', 'targetSetpoint', grad(temperatur))]),
               ziel('Alexa.ThermostatController', 'thermostatMode', modus)],
      };
    }
    if (modus === 'OFF') {
      return { befehl: 'soll', wert: 'aus', ziel: [ziel('Alexa.ThermostatController', 'thermostatMode', 'OFF')] };
    }
    return { fehler: { namespace: 'Alexa.ThermostatController', type: 'UNSUPPORTED_THERMOSTAT_MODE',
                       message: `Mode ${modus} is not supported` } };
  }
  return ungueltig(`Unsupported ${name}`);
}

/**
 * Direktive + Eintrag -> {befehl, wert, ziel} fuer die ntfy-Nachricht, oder
 * {fehler}. Rein: kein Redis, kein Netz. `ziel` sind die Properties, die Alexa
 * sofort als neuen Zustand bekommt - das Relay schiebt den echten danach.
 */
export function befehlFuer(directive, eintrag) {
  const { namespace, name, instance } = directive.header;
  const payload = directive.payload || {};
  if (namespace === 'Alexa.ThermostatController' && eintrag.art === 'hkr') {
    return thermostatBefehl(name, payload, eintrag);
  }
  if (namespace === 'Alexa.ToggleController' && eintrag.art === 'hkr' && instance === BOOST
      && (name === 'TurnOn' || name === 'TurnOff')) {
    const an = name === 'TurnOn';
    return { befehl: 'boost', wert: an ? 'an' : 'aus',
             ziel: [ziel('Alexa.ToggleController', 'toggleState', an ? 'ON' : 'OFF', BOOST)] };
  }
  if (namespace === 'Alexa.PowerController' && eintrag.art === 'dose' && (name === 'TurnOn' || name === 'TurnOff')) {
    const an = name === 'TurnOn';
    return { befehl: 'schalten', wert: an ? 'an' : 'aus',
             ziel: [ziel('Alexa.PowerController', 'powerState', an ? 'ON' : 'OFF')] };
  }
  if (namespace === 'Alexa.SceneController' && eintrag.art === 'vorlage' && name === 'Activate') {
    return { befehl: 'vorlage', wert: '-', ziel: [] };
  }
  return ungueltig(`${namespace}.${name} does not fit this device`);
}

function antwortKopf(header, namespace, name) {
  return { namespace, name, messageId: header.messageId + '-R',
           ...(header.correlationToken ? { correlationToken: header.correlationToken } : {}),
           payloadVersion: '3' };
}

function fehlerAntwort(res, header, endpointId, { namespace = 'Alexa', type, message, validRange }) {
  return res.status(200).json({
    event: {
      header: antwortKopf(header, namespace, 'ErrorResponse'),
      endpoint: { endpointId },
      payload: { type, message, ...(validRange ? { validRange } : {}) },
    },
  });
}

/**
 * Alle Direktiven fuer fritz-*-Endpunkte: ReportState, Thermostat, Boost,
 * Steckdose, Vorlage. `senden` und `jetztMs` sind fuer Tests austauschbar.
 */
export async function handleFritz(request, res, redis, { env = process.env, senden = fetch, jetztMs = Date.now() } = {}) {
  const { header } = request.directive;
  const endpointId = request.directive.endpoint?.endpointId;
  const stand = standAus(await redis.get(FRITZ_SCHLUESSEL));
  const eintrag = eintragFuer(stand, endpointId);
  if (!eintrag) {
    console.warn(`Fritz: unknown endpoint ${endpointId}`);
    return fehlerAntwort(res, header, endpointId, { type: 'NO_SUCH_ENDPOINT', message: 'Unknown endpoint' });
  }

  if (header.namespace === 'Alexa' && header.name === 'ReportState') {
    return res.status(200).json({
      event: { header: antwortKopf(header, 'Alexa', 'StateReport'), endpoint: { endpointId }, payload: {} },
      context: { properties: eigenschaften(eintrag, stand, jetztMs) },
    });
  }

  if (!erreichbar(eintrag, stand, jetztMs)) {
    return fehlerAntwort(res, header, endpointId, { type: 'ENDPOINT_UNREACHABLE', message: 'Device or relay not reachable' });
  }
  const plan = befehlFuer(request.directive, eintrag);
  if (plan.fehler) return fehlerAntwort(res, header, endpointId, plan.fehler);
  if (!env.FRITZ_TOPIC || !env.FRITZ_PASSWORD) {
    console.error('FRITZ_TOPIC or FRITZ_PASSWORD not configured');
    return fehlerAntwort(res, header, endpointId, { type: 'INTERNAL_ERROR', message: 'FRITZ_TOPIC or FRITZ_PASSWORD not configured' });
  }

  try {
    await senden(`https://ntfy.sh/${env.FRITZ_TOPIC}`, {
      method: 'POST',
      body: `fritz:${plan.befehl}:${eintrag.id}:${plan.wert}:${env.FRITZ_PASSWORD}`,
    });
    console.log(`Fritz: ${plan.befehl} ${eintrag.id.slice(-4)} -> ${plan.wert}`);
  } catch (err) {
    // Wie bei der LED: Alexa bekommt trotzdem die Quittung; der echte Stand
    // kommt mit dem naechsten Push des Relays.
    console.error('Fritz: ntfy failed:', err?.message);
  }

  const zeit = new Date(jetztMs).toISOString();
  if (plan.befehl === 'vorlage') {
    return res.status(200).json({
      event: {
        header: antwortKopf(header, 'Alexa.SceneController', 'ActivationStarted'),
        endpoint: { endpointId },
        payload: { cause: { type: 'VOICE_INTERACTION' }, timestamp: zeit },
      },
      context: {},
    });
  }
  const properties = [...plan.ziel, ziel('Alexa.EndpointHealth', 'connectivity', { value: 'OK' })]
    .map(p => ({ ...p, timeOfSample: zeit, uncertaintyInMilliseconds: 0 }));
  return res.status(200).json({
    event: { header: antwortKopf(header, 'Alexa', 'Response'), endpoint: { endpointId }, payload: {} },
    context: { properties },
  });
}
