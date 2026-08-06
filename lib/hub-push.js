// lib/hub-push.js – Zonenwechsel als Push an die Actions-Hub-Geräte.
//
// **Warum das hier liegt und nicht in der App.** Der Hub fragte bis 3.15.x im
// Viertelstundentakt `/api/locations` ab und verglich selbst. Die Rechnung
// "höchstens eine Viertelstunde Verzögerung" ging von einem WorkManager-Job
// aus, der auch läuft: Android stuft eine selten geöffnete App aber als
// *frequent* oder *rare* ein und schiebt ihre Hintergrundaufgaben um acht bis
// vierundzwanzig Stunden. Die Meldung kam dann nicht eine Viertelstunde zu
// spät, sondern einen halben Tag.
//
// Ein Push umgeht die Einstufung, weil er die App vorübergehend wieder als
// aktiv gelten lässt – dieselbe Mechanik, wegen der Messenger sofort
// klingeln. Erkannt wird der Wechsel deshalb hier, beim Eingang der Position,
// und nicht mehr erst beim Abruf.
//
// **Anders als beim Klingeln geht der Push an alle Geräte, nicht an eines.**
// Welche Personen ein Hub gemeldet haben will, ist eine Einstellung auf dem
// Gerät (`Prefs.meldungenFuer`) und geht den Server nichts an; er wüsste sie
// auch gar nicht. Gefiltert wird auf dem Handy.
import { findZone } from './geo.js';
import { fcmKonfiguriert, sendeDaten } from './fcm.js';

/**
 * Der Redis-Schlüssel mit den Tokens der Hub-Geräte.
 *
 * Ein **Hash** und kein Objekt unter einem gewöhnlichen Schlüssel: Sonst wäre
 * jedes Registrieren ein Lesen-Ändern-Schreiben, und zwei Standortmeldungen,
 * die sich überschneiden, verlören dabei einen Token. `hset` setzt genau ein
 * Feld und lässt die übrigen in Ruhe.
 */
export const HUB_FCM_KEY = 'hub_fcm';

/**
 * Wie lange ein Hub-Token ohne Lebenszeichen aufgehoben wird.
 *
 * Der Hub meldet sich bei jedem Abruf der Standort-Liste. Ein Gerät, das
 * dreißig Tage nichts von sich hören ließ, ist verkauft, zurückgesetzt oder
 * hat die App nicht mehr — sein Token verursacht bei jedem Zonenwechsel eine
 * vergebliche Anfrage an Google.
 */
export const TOKEN_MAX_ALTER_SEK = 30 * 24 * 3600;

/**
 * Die beiden Verben. Wortgleich zur Grammatik von `/api/ring`
 * (`<verb>:<Person>:<tst>[:=<Text>]`), damit beide Nutzlasten im Feld `cmd`
 * reisen können und die App nur ein Format kennen muss.
 */
export const ZONE_ENTER = 'zone-enter';
export const ZONE_EXIT = 'zone-exit';

/**
 * Was zwischen zwei Positionen passiert ist – oder `null` für "nichts zu sagen".
 *
 * **Reine Funktion und exportiert**, damit die Entscheidung ohne Redis und
 * ohne Netz prüfbar bleibt. Sie ist die Sorte Logik, die still falsch sein
 * kann: eine Meldung zu viel ist lästig (und wer sie zweimal bekommt, schaltet
 * sie ab), eine zu wenig macht die ganze Funktion wertlos.
 *
 * Dieselben vier Fälle wie `Meldungen.wechsel` in der Actions-Hub-App, und das
 * ist kein Zufall: Der Hub prüft die Entscheidung beim Empfang noch einmal
 * gegen seinen eigenen gemerkten Stand. Liefen die beiden auseinander, käme
 * entweder eine Meldung doppelt oder gar nicht.
 *
 *   kein Vorgänger      -> null  ("wissen wir nicht" ist nicht "war unterwegs")
 *   gleiche Zone        -> null
 *   neue Zone           -> zone-enter mit der NEUEN Zone
 *   keine Zone mehr     -> zone-exit mit der ALTEN Zone
 *
 * Ein Wechsel von einer Zone direkt in eine andere meldet das Betreten der
 * neuen und nicht das Verlassen der alten: Wohin jemand gegangen ist, ist die
 * Auskunft, auf die es ankommt.
 *
 * @param zones  die eingerichteten Zonen (`geo_zones`)
 * @param vorher der bisherige `person_location:`-Datensatz (oder `{}`)
 * @param lat    Breitengrad der neuen Position
 * @param lon    Längengrad der neuen Position
 */
export function zonenWechsel(zones, vorher, lat, lon) {
  if (!Array.isArray(zones) || zones.length === 0) return null;
  // Ohne brauchbare Vorgaenger-Position gibt es keinen Wechsel, sondern nur
  // einen ersten Wert. Der erste Lauf schweigt - sonst kaeme nach jeder
  // Neueinrichtung eine Meldung ueber etwas, das laengst so war.
  if (!vorher || !Number.isFinite(vorher.lat) || !Number.isFinite(vorher.lon)) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const alt = findZone(zones, vorher.lat, vorher.lon);
  const neu = findZone(zones, lat, lon);

  if (neu && (!alt || neu.name !== alt.name)) return { verb: ZONE_ENTER, zone: neu.name };
  if (!neu && alt) return { verb: ZONE_EXIT, zone: alt.name };
  return null;
}

/**
 * Baut die Nutzlast: `zone-enter:Amelia:1712345678:=Schule`.
 *
 * Die Marke `=` vor dem Zonennamen ist nicht Zierrat, sondern dieselbe
 * Entscheidung wie bei `mitText` in `api/ring.js`: Ohne sie wäre
 * `zone-exit:Julia:1700000000:112` zweideutig — das letzte Feld könnte eine
 * Zone "112" sein oder der Zeitstempel eines Namens "Julia:1700000000".
 * `encodeURIComponent` erzeugt niemals ein `=`, also entscheidet es den Fall.
 *
 * Reine Funktion und exportiert, aus demselben Grund wie [zonenWechsel].
 */
export function nutzlast(verb, personName, tst, zone) {
  return `${verb}:${personName}:${tst}:=${encodeURIComponent(zone)}`;
}

/**
 * Merkt sich das Token eines Hub-Geräts und räumt dabei tote Einträge weg.
 *
 * Kein eigener Registrierungs-Endpunkt: Der Hub hängt das Token als Kopfzeile
 * `X-Fcm-Token` an den Abruf von `/api/locations`, den er ohnehin regelmäßig
 * macht — genau der Weg, den Mylo über `api/location.js` schon geht. Ein
 * zusätzlicher Aufruf könnte im Funkloch scheitern, ohne dass ihn jemand
 * wiederholt.
 *
 * Als Kopfzeile und **nicht** als Query-Parameter: Query-Strings landen in den
 * Request-Logs, und ein FCM-Token ist eine Zugangsberechtigung.
 */
export async function merkeHubToken(redis, req) {
  const token = req.headers?.['x-fcm-token'];
  if (typeof token !== 'string' || !token.trim()) return;
  const jetzt = Math.floor(Date.now() / 1000);
  await redis.hset(HUB_FCM_KEY, { [token.trim()]: jetzt });

  // Aufraeumen genau hier und nicht beim Senden: Ein Zonenwechsel soll nicht
  // auf ein hgetall warten muessen, und dieser Pfad laeuft je Geraet
  // hoechstens alle paar Minuten.
  const alle = (await redis.hgetall(HUB_FCM_KEY)) || {};
  const tot = Object.entries(alle)
    .filter(([, gesehen]) => !Number.isFinite(Number(gesehen))
      || jetzt - Number(gesehen) > TOKEN_MAX_ALTER_SEK)
    .map(([t]) => t);
  if (tot.length) await redis.hdel(HUB_FCM_KEY, ...tot);
}

/**
 * Schickt den Zonenwechsel an alle angemeldeten Hub-Geräte.
 *
 * **Wirft nie.** Der Aufrufer ist der Standort-Eingang, und dessen Aufgabe ist
 * das Speichern der Position. Ein Push, der nicht rausgeht, darf die Meldung
 * des Handys nicht scheitern lassen — Mylo versuchte sie sonst erneut, und die
 * Position stünde trotzdem längst in Redis.
 *
 * @returns {{gesendet: number, entfernt: number}}
 */
export async function sendeZonenwechsel(redis, personName, wechsel, tst) {
  if (!fcmKonfiguriert()) return { gesendet: 0, entfernt: 0 };

  let tokens = {};
  try {
    tokens = (await redis.hgetall(HUB_FCM_KEY)) || {};
  } catch (err) {
    console.warn('hub_fcm nicht lesbar:', err);
    return { gesendet: 0, entfernt: 0 };
  }
  const liste = Object.keys(tokens);
  if (liste.length === 0) return { gesendet: 0, entfernt: 0 };

  const daten = { cmd: nutzlast(wechsel.verb, personName, tst, wechsel.zone) };
  const tot = [];
  let gesendet = 0;

  // Nacheinander und nicht per Promise.all: Es sind eine Handvoll
  // Familien-Handys, und eine Serverless-Funktion, die parallel ein Dutzend
  // Anfragen aufmacht, spart hier nichts Messbares.
  for (const token of liste) {
    try {
      const ergebnis = await sendeDaten(token, daten);
      if (ergebnis.ok) {
        gesendet += 1;
        continue;
      }
      // Ein abgemeldetes oder ersetztes Geraet meldet UNREGISTERED bzw. 404 -
      // dieselbe Aufraeumlogik wie bei person_fcm in api/ring.js. Ohne sie
      // scheiterte jeder weitere Zonenwechsel an derselben Leiche.
      if (ergebnis.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(ergebnis.body)) {
        tot.push(token);
      }
      console.warn(`Hub-Push fehlgeschlagen (HTTP ${ergebnis.status}): ${ergebnis.body}`);
    } catch (err) {
      console.warn('Hub-Push fehlgeschlagen:', err);
    }
  }
  if (tot.length) {
    try {
      await redis.hdel(HUB_FCM_KEY, ...tot);
    } catch (err) {
      console.warn('hub_fcm aufraeumen fehlgeschlagen:', err);
    }
  }
  return { gesendet, entfernt: tot.length };
}
