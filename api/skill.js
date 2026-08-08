// api/skill.js – Alexa Custom Skill endpoint ("Alexa, wo ist Julia?")
// LaunchRequest answers with the default person (used by the Alexa Routine),
// WhereIsPersonIntent answers for a specific person via the {person} slot.
//
// Dazu zwei Befehle ans Handy selbst:
//
//   RingPersonIntent     laesst es klingeln - MIT Rueckfrage
//   SilencePersonIntent  beendet Ton, Licht und Ansage - ohne Rueckfrage
//
// **Warum das hier steht und nicht als Szene in api/alexa.js.** Eine Szene
// waere kuerzer zu sagen ("Alexa, Julias Handy", so wie "Alexa, Muelltonne")
// und braeuchte keinerlei neue Einrichtung. Sie kann aber nicht zurueckfragen:
// Smart-Home-Direktiven sind einseitig, Alexa schickt "Activate" und erwartet
// eine Quittung. Wer eine Bestaetigung will, braucht einen Dialog, und Dialoge
// gibt es nur im Custom Skill. Der Preis ist der laengere Aufruf - der
// nebenbei die halbe Sorge schon selbst erledigt, weil ihn niemand
// versehentlich sagt.
import { Redis } from '@upstash/redis'
import { buildLocationSpeech } from '../lib/geo.js'
import { befehlAnPerson } from '../lib/ring.js'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export default async function handler(req, res) {
  const body = req.body;
  if (!body || !body.request) return res.status(400).end();

  // Dev-stage skill check: verify the skill ID and reject stale requests.
  // Not a substitute for full Alexa request-signature verification (certification).
  const appId = body.context?.System?.application?.applicationId
    || body.session?.application?.applicationId;
  if (!process.env.ALEXA_SKILL_ID || appId !== process.env.ALEXA_SKILL_ID) {
    return res.status(401).end();
  }
  const ts = Date.parse(body.request.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 150000) {
    return res.status(401).end();
  }

  try {
    if (body.request.type === 'LaunchRequest') {
      const person = await getDefaultPerson();
      if (!person) return speak(res, 'Es ist noch keine Person eingerichtet. Bitte lege im Dashboard eine Person an.');
      return speak(res, await buildLocationSpeech(redis, person));
    }

    if (body.request.type === 'IntentRequest') {
      const intent = body.request.intent || {};
      switch (intent.name) {
        case 'WhereIsPersonIntent':
          return handleWhereIs(intent, res);
        case 'RingPersonIntent':
          return handleRing(intent, res);
        case 'SilencePersonIntent':
          return handleSilence(intent, res);
        case 'AMAZON.HelpIntent':
          return speak(
            res,
            'Frag mich zum Beispiel: wo ist Julia? Oder lass Julias Handy klingeln. '
            + 'Wen soll ich suchen?',
            false,
          );
        case 'AMAZON.StopIntent':
        case 'AMAZON.CancelIntent':
        case 'AMAZON.NavigateHomeIntent':
          return speak(res, 'Bis bald.');
        default:
          return speak(res, 'Das habe ich leider nicht verstanden.');
      }
    }

    // SessionEndedRequest and anything else: empty response, no speech allowed
    return res.status(200).json({ version: '1.0', response: {} });
  } catch (err) {
    console.error('Skill error:', err);
    return speak(res, 'Es ist leider ein Fehler aufgetreten.');
  }
}

function speak(res, text, endSession = true) {
  return res.status(200).json({
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      shouldEndSession: endSession,
    },
  });
}

async function getDefaultPerson() {
  const persons = await redis.get('geo_persons') || [];
  return persons.find(p => p.default)
    || persons.find(p => p.name.toLowerCase() === (process.env.DEFAULT_PERSON || '').toLowerCase())
    || persons[0]
    || null;
}

function resolvedSlotValue(slot) {
  if (!slot) return null;
  const resolution = slot.resolutions?.resolutionsPerAuthority?.[0];
  if (resolution?.status?.code === 'ER_SUCCESS_MATCH') {
    return resolution.values?.[0]?.value?.name || slot.value;
  }
  return slot.value || null;
}

async function handleWhereIs(intent, res) {
  const value = resolvedSlotValue(intent.slots?.person);
  if (!value) return frageWer(res, 'Wen soll ich suchen?');

  const persons = await redis.get('geo_persons') || [];
  const person = persons.find(p => p.name.toLowerCase() === value.toLowerCase());
  if (!person) return speak(res, `Ich habe keine Person namens ${value} gefunden.`);

  return speak(res, await buildLocationSpeech(redis, person));
}

/**
 * Zaehlt Namen so auf, wie man sie spricht: "Julia, Oma Petra und Stefan".
 *
 * Rein und exportiert, damit die Aufzaehlung ohne Netz pruefbar bleibt.
 */
export function aufzaehlung(namen) {
  const liste = (namen || []).filter(n => typeof n === 'string' && n.trim());
  if (liste.length === 0) return '';
  if (liste.length === 1) return liste[0];
  return `${liste.slice(0, -1).join(', ')} und ${liste[liste.length - 1]}`;
}

/**
 * Die Rueckfrage, wenn kein Name ankam - **mit den Namen, die es gibt.**
 *
 * Ein blosses "Wessen Handy soll klingeln?" ist genau dann eine Sackgasse,
 * wenn man gerade einen Namen gesagt hat: Alexa fuellt den Slot nur, wenn der
 * Name im Sprachmodell unter PERSON_NAME steht, und ein unbekannter kommt hier
 * als gar nichts an. Die Frage klingt dann, als haette man geschwiegen - und
 * man sagt denselben Satz noch einmal, lauter.
 *
 * Wer die bekannten Namen mitliest, sieht den Grund sofort. Die Liste kommt
 * dabei aus dem Dashboard und nicht aus dem Sprachmodell: Sie beantwortet
 * "wen kann dieser Skill erreichen", und das ist die Frage dahinter.
 */
async function frageWer(res, satz) {
  const persons = await redis.get('geo_persons') || [];
  const namen = aufzaehlung(persons.map(p => p.name));
  return speak(res, namen ? `${satz} Ich kenne ${namen}.` : satz, false);
}

/**
 * Was Alexa nach einem Klingel-Versuch sagt.
 *
 * **Der Unterschied zwischen "klingelt" und "losgeschickt" ist der ganze
 * Zweck dieser Funktion.** Der Push ist in Sekunden da; der ntfy-Rueckfall
 * erst beim naechsten Standort-Lauf, also bis zu eine Viertelstunde spaeter.
 * Wer in beiden Faellen "klingelt" sagen liesse, schickte jemanden lauschend
 * durch die Wohnung, waehrend gar nichts passiert - dieselbe Sorte Auskunft
 * wie die 50 %, die einmal als Lautstaerke dastanden.
 *
 * Rein und exportiert, damit sich jede Lage ohne Netz pruefen laesst.
 */
export function ansage(ergebnis, name) {
  if (ergebnis.ok) return `${name}s Handy klingelt.`;
  if (ergebnis.ntfy) {
    return `Ich habe es an ${name}s Handy geschickt. Es kann ein paar Minuten dauern.`;
  }
  if (ergebnis.grund === 'kein_fcm') {
    return 'Das Klingeln ist noch nicht eingerichtet.';
  }
  return `Ich konnte ${name}s Handy nicht erreichen.`;
}

/**
 * Laesst das Handy klingeln – **erst nach einer Rueckfrage.**
 *
 * Die Bestaetigung ist der Grund, warum es diesen Intent ueberhaupt im Custom
 * Skill gibt: Ein Handy, das mitten in einer Besprechung losgeht, weil jemand
 * einen aehnlich klingenden Satz gesagt hat, ist schlimmer als ein Handy, das
 * man von Hand sucht.
 *
 * Drei Zustaende, und alle drei kommen vor:
 *   CONFIRMED  Alexa hat gefragt, es kam "ja" - jetzt darf es klingeln
 *   DENIED     es kam "nein" - dann passiert nichts, und das wird gesagt
 *   NONE       die Rueckfrage hat noch nicht stattgefunden
 *
 * Der dritte Fall ist der wichtige: Er tritt ein, wenn im Sprachmodell
 * `confirmationRequired` fehlt oder die automatische Delegation aus ist. Dann
 * fragt dieser Code selbst nach (Dialog.ConfirmIntent), statt durchzulaufen -
 * sonst zeigte sich ein Konfigurationsfehler ausgerechnet als "klingelt
 * sofort", also als genau das, was nicht passieren soll.
 */
async function handleRing(intent, res) {
  const value = resolvedSlotValue(intent.slots?.person);
  if (!value) return frageWer(res, 'Wessen Handy soll klingeln?');

  const persons = await redis.get('geo_persons') || [];
  const person = persons.find(p => p.name.toLowerCase() === value.toLowerCase());
  if (!person) return speak(res, `Ich habe keine Person namens ${value} gefunden.`);

  if (intent.confirmationStatus === 'DENIED') {
    return speak(res, 'Alles klar, dann nicht.');
  }
  if (intent.confirmationStatus !== 'CONFIRMED') {
    return frageNach(res, intent, `Soll ${person.name}s Handy wirklich klingeln?`);
  }

  // Mit ntfy-Rueckfall: Hier gibt es keinen zweiten Absender, der ihn
  // nachholen koennte - anders als beim Actions Hub, der seine Zeile selbst
  // veroeffentlicht.
  const ergebnis = await befehlAnPerson(redis, person.name, 'ring', { rueckfall: true });
  return speak(res, ansage(ergebnis, person.name));
}

/**
 * Beendet Ton, Licht und Ansage – **ohne** Rueckfrage.
 *
 * Aufhoeren ist harmlos, und wer das Handy gerade gefunden hat, waehrend es
 * Alarm schlaegt, will keine Rueckfrage beantworten. Die Vorsicht gehoert vor
 * das Geraeusch, nicht dahinter.
 */
async function handleSilence(intent, res) {
  const value = resolvedSlotValue(intent.slots?.person);
  if (!value) return frageWer(res, 'Wessen Handy soll aufhören?');

  const persons = await redis.get('geo_persons') || [];
  const person = persons.find(p => p.name.toLowerCase() === value.toLowerCase());
  if (!person) return speak(res, `Ich habe keine Person namens ${value} gefunden.`);

  const ergebnis = await befehlAnPerson(redis, person.name, 'silence', { rueckfall: true });
  if (ergebnis.ok) return speak(res, `${person.name}s Handy ist wieder ruhig.`);
  if (ergebnis.ntfy) return speak(res, 'Ich habe es geschickt. Es kann ein paar Minuten dauern.');
  return speak(res, `Ich konnte ${person.name}s Handy nicht erreichen.`);
}

/** Laesst Alexa den Intent bestaetigen, statt ihn auszufuehren. */
function frageNach(res, intent, frage) {
  return res.status(200).json({
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text: frage },
      shouldEndSession: false,
      directives: [{ type: 'Dialog.ConfirmIntent', updatedIntent: intent }],
    },
  });
}
