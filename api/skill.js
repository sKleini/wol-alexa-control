// api/skill.js – Alexa Custom Skill endpoint ("Alexa, wo ist Julia?")
// LaunchRequest answers with the default person (used by the Alexa Routine),
// WhereIsPersonIntent answers for a specific person via the {person} slot.
import { Redis } from '@upstash/redis'
import { buildLocationSpeech } from '../lib/geo.js'

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
        case 'AMAZON.HelpIntent':
          return speak(res, 'Frag mich zum Beispiel: wo ist Julia? Wen soll ich suchen?', false);
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
  if (!value) return speak(res, 'Wen soll ich suchen?', false);

  const persons = await redis.get('geo_persons') || [];
  const person = persons.find(p => p.name.toLowerCase() === value.toLowerCase());
  if (!person) return speak(res, `Ich habe keine Person namens ${value} gefunden.`);

  return speak(res, await buildLocationSpeech(redis, person));
}
