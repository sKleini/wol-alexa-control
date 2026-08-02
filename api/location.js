// api/location.js – /api/location?key=<LOCATION_KEY>&u=<person name>
// Location ingest endpoint. Source-agnostic: fields may come from a JSON
// body (POST, e.g. OwnTracks) or from query parameters (GET/POST, e.g.
// GPSLogger's custom URL with %LAT/%LON/%ACC/%BATT placeholders).
import { Redis } from '@upstash/redis'
import { keyOk } from '../lib/auth.js'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

/**
 * Die erlaubten Werte von `ring` - eine feste Liste, kein Durchreichen.
 *
 * Der Wert landet in Redis und von dort in der Oberflaeche der Actions-App.
 * Ein Tippfehler auf der Handy-Seite soll dort als "unbekannt" ankommen und
 * nicht als eigener, stiller dritter Zustand.
 */
const RINGER_MODES = ['normal', 'vibrate', 'silent'];

/**
 * Ein Ja/Nein-Feld als echtes Tri-State lesen: true, false oder unbekannt.
 *
 * Bewusst NICHT `pick(x) === '1'`: Das machte aus einem fehlenden Feld ein
 * "nein" - und die App wuerde bei jedem OwnTracks-Nutzer behaupten, das
 * Lautstellen ginge dort nicht.
 *
 * Wird von `dnd` und `zen` benutzt. **Die zwei bedeuten Verschiedenes**, und
 * die Namen verraten es nicht von selbst:
 *
 *   dnd  Darf Mylo den Klingelmodus AENDERN? (Richtlinienzugriff erteilt)
 *   zen  Laeuft "Nicht stoeren" auf dem Geraet gerade?
 *
 * Das zweite ist der Grund, warum ein Handy `silent` meldet, obwohl im
 * Tonprofil "Ton" steht: Viele Geraete legen bei aktivem "Nicht stoeren" den
 * internen Klingelmodus auf stumm.
 */
function jaNeinFlag(raw) {
  if (raw === '1' || raw === 1 || raw === true) return true;
  if (raw === '0' || raw === 0 || raw === false) return false;
  return null;
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!keyOk(req)) return res.status(401).end();

  // Prefer JSON body (keeps existing behavior), fall back to query params.
  const body = req.body || {};

  // OwnTracks posts a JSON body carrying a "_type" discriminator and expects the
  // HTTP response to be a JSON array of OwnTracks messages ([] = "received, no
  // commands"). Our default {ok:true} reply has no _type, so OwnTracks fails to
  // parse it, treats delivery as failed and re-queues the message forever. When
  // the caller is OwnTracks, answer in its own dialect. GPSLogger ignores the
  // body and keeps the {ok:true} reply.
  const isOwnTracks = typeof body._type === 'string';
  const ackOwnTracks = () => res.status(200).json([]);

  const personName = (req.query.u || process.env.DEFAULT_PERSON || '').trim();
  if (!personName) {
    if (isOwnTracks) return ackOwnTracks();
    return res.status(400).json({ error: 'Missing person (u param or DEFAULT_PERSON)' });
  }

  const persons = await redis.get('geo_persons') || [];
  const person = persons.find(p => p.name.toLowerCase() === personName.toLowerCase());
  if (!person) {
    console.warn(`Location update for unknown person: ${personName}`);
    if (isOwnTracks) return ackOwnTracks();
    return res.status(200).json({ ok: false, error: 'Unknown person' });
  }

  const pick = (k) => (body[k] ?? req.query[k]);
  const lat = parseFloat(pick('lat'));
  const lon = parseFloat(pick('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    // OwnTracks legitimately sends messages without coordinates (lwt, status,
    // waypoints, transitions). Acknowledge them without storing so they are not
    // re-queued; other sources still get an explicit error.
    if (isOwnTracks) return ackOwnTracks();
    return res.status(400).json({ error: 'Missing lat/lon' });
  }

  const tst = parseInt(pick('tst'));
  const location = {
    lat,
    lon,
    tst: Number.isFinite(tst) ? tst : Math.floor(Date.now() / 1000),
    acc: Number.isFinite(parseFloat(pick('acc'))) ? parseFloat(pick('acc')) : null,
    address: pick('address') || null,
    batt: Number.isFinite(parseFloat(pick('batt'))) ? parseFloat(pick('batt')) : null,
    // Klingelmodus, "Nicht stoeren"-Zugriff und ob "Nicht stoeren" laeuft.
    // Nur die Mylo-App schickt das; OwnTracks und der SmartTag-Relay kennen
    // die Felder nicht.
    //
    // Deshalb ist null hier NICHT "normal", sondern "unbekannt" - und muss es
    // bis in die Oberflaeche bleiben. Ein Standardwert waere eine Behauptung
    // ueber ein Geraet, von dem wir nichts gehoert haben.
    ring: RINGER_MODES.includes(pick('ring')) ? pick('ring') : null,
    dnd: jaNeinFlag(pick('dnd')),
    zen: jaNeinFlag(pick('zen')),
    // Brennt gerade die Taschenlampe? Der einzige Zustand hier, der von
    // selbst endet - Mylo schaltet sie nach spaetestens fuenf Minuten ab.
    // Die Actions-App traut ihm deshalb auch nur so lange.
    torch: jaNeinFlag(pick('torch')),
    // Haengt das Handy am Kabel? Wechselt selten und haelt stundenlang,
    // deshalb reist es nur mit dem regulaeren Lauf mit - anders als ring
    // und torch, die eine Sofortmeldung ausloesen.
    chg: jaNeinFlag(pick('chg')),
    receivedAt: Math.floor(Date.now() / 1000),
  };

  await redis.set('person_location:' + person.name.toLowerCase(), location);

  // Die Mylo-App haengt ihr FCM-Gerätetoken an jede Standortmeldung – so
  // braucht es keinen eigenen Registrierungs-Endpunkt, und ein nach einer
  // Neuinstallation gewechseltes Token erneuert sich von selbst.
  //
  // Als Kopfzeile und NICHT als Query-Parameter, aus demselben Grund, aus dem
  // der LOCATION_KEY dort nicht steht (siehe lib/auth.js): Query-Strings
  // landen in den Request-Logs. Ein FCM-Token ist eine Zugangsberechtigung –
  // wer es hat, kann dem Geraet Pushes dieses Projekts schicken.
  const fcmToken = req.headers?.['x-fcm-token'];
  if (typeof fcmToken === 'string' && fcmToken.trim()) {
    await redis.set('person_fcm:' + person.name.toLowerCase(), fcmToken.trim());
  }

  if (isOwnTracks) return ackOwnTracks();
  return res.status(200).json({ ok: true });
}
