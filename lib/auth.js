// lib/auth.js – Prüfung des LOCATION_KEY für die /api-Endpunkte.

/**
 * Prüft, ob die Anfrage den richtigen LOCATION_KEY mitbringt.
 *
 * Akzeptiert zwei Wege:
 *   1. Header `X-Location-Key` – bevorzugt.
 *   2. Query-Parameter `?key=` – der bisherige Weg, bleibt erhalten.
 *
 * Warum der Header: Query-Strings landen in Access- und Vercel-Request-Logs.
 * TLS schützt sie auf dem Weg, aber nicht am Ziel – der Schlüssel steht dort
 * dauerhaft im Klartext. Header werden nicht mitgeloggt.
 *
 * Der Query-Parameter bleibt bewusst zulässig: die Relays auf dem VPS
 * (Cron-Skripte, curl) nutzen ihn, und eine ältere App-Version im Umlauf
 * ebenfalls. Er lässt sich entfernen, sobald beide umgestellt sind.
 *
 * Fail-closed: ohne gesetztes LOCATION_KEY wird immer abgewiesen, statt
 * versehentlich alles durchzulassen.
 *
 * @param {import('http').IncomingMessage & {query?: Record<string,string>}} req
 * @returns {boolean}
 */
export function keyOk(req) {
  const erwartet = process.env.LOCATION_KEY;
  if (!erwartet) return false;

  const ausHeader = req.headers?.['x-location-key'];
  const ausQuery = req.query?.key;

  // Ein Array kann entstehen, wenn der Parameter mehrfach vorkommt – dann
  // gilt keiner der Werte, sonst liesse sich die Prüfung durch Anhängen
  // eines zweiten Parameters aushebeln.
  if (typeof ausHeader === 'string' && ausHeader === erwartet) return true;
  if (typeof ausQuery === 'string' && ausQuery === erwartet) return true;
  return false;
}
