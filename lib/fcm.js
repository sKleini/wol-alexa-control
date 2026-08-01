// lib/fcm.js – Push an ein Android-Gerät über Firebase Cloud Messaging.
//
// Warum das hier liegt und nicht in der App: Die FCM-HTTP-v1-Schnittstelle
// verlangt ein OAuth2-Zugangstoken, das mit dem privaten Schlüssel eines
// Dienstkontos signiert wird. Dieser Schlüssel darf nicht in eine APK – jeder
// könnte sie auspacken und dann Pushes an fremde Geräte des Projekts senden.
// Also signiert der Server, und die App ruft nur /api/ring auf.
//
// Bewusst ohne google-auth-library: Dieses Projekt hat genau eine Abhängigkeit
// (@upstash/redis). Ein RS256-JWT sind mit node:crypto knapp vierzig Zeilen,
// und die Bibliothek zöge ein gutes Dutzend weiterer Pakete in eine
// Serverless-Funktion, die einmal am Tag läuft.
//
// Nötige Umgebungsvariablen (aus dem Dienstkonto-JSON der Firebase-Konsole):
//   FCM_PROJECT_ID    z. B. mylo-12345
//   FCM_CLIENT_EMAIL  firebase-adminsdk-xxxxx@<projekt>.iam.gserviceaccount.com
//   FCM_PRIVATE_KEY   der PEM-Block ("-----BEGIN PRIVATE KEY----- …")
import crypto from 'node:crypto';

const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

// Das Zugangstoken gilt eine Stunde. Im Modulspeicher gehalten, damit nicht
// jeder Klingel-Befehl eine zusätzliche Anfrage an Google auslöst; eine warme
// Serverless-Instanz bedient mehrere Aufrufe.
let zugang = { token: null, gueltigBis: 0 };

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Ist FCM überhaupt eingerichtet? Ohne die drei Werte bleibt es beim ntfy-Weg. */
export function fcmKonfiguriert() {
  return Boolean(process.env.FCM_PROJECT_ID
    && process.env.FCM_CLIENT_EMAIL
    && process.env.FCM_PRIVATE_KEY);
}

async function holeZugangstoken() {
  const jetzt = Math.floor(Date.now() / 1000);
  // 60 s Sicherheitsabstand: Ein Token, das während der Anfrage abläuft, wäre
  // ein Fehler, den man nur sporadisch sähe.
  if (zugang.token && zugang.gueltigBis - 60 > jetzt) return zugang.token;

  const kopf = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const rumpf = base64url(JSON.stringify({
    iss: process.env.FCM_CLIENT_EMAIL,
    scope: SCOPE,
    aud: OAUTH_URL,
    iat: jetzt,
    exp: jetzt + 3600,
  }));
  // In Umgebungsvariablen stehen Zeilenumbrüche oft als "\n" – Vercel gibt den
  // Wert dann wörtlich zurück, und crypto.sign scheitert an einem PEM ohne
  // echte Umbrüche. Der Ersatz ist harmlos, wenn schon echte drin sind.
  const schluessel = process.env.FCM_PRIVATE_KEY.replace(/\\n/g, '\n');
  const signatur = base64url(
    crypto.sign('RSA-SHA256', Buffer.from(`${kopf}.${rumpf}`), schluessel)
  );

  const antwort = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${kopf}.${rumpf}.${signatur}`,
    }),
  });
  if (!antwort.ok) {
    const text = await antwort.text().catch(() => '');
    throw new Error(`OAuth2 fehlgeschlagen (HTTP ${antwort.status}): ${text.slice(0, 200)}`);
  }
  const daten = await antwort.json();
  zugang = { token: daten.access_token, gueltigBis: jetzt + (daten.expires_in || 3600) };
  return zugang.token;
}

/**
 * Schickt eine Data-only-Nachricht an ein Gerät.
 *
 * **Data-only und priority high sind beide Absicht.** Eine Nachricht mit
 * `notification`-Block würde Android selbst als Benachrichtigung anzeigen und
 * die App im Hintergrund gar nicht erst aufwecken – genau falsch herum: Die
 * App soll klingeln, nicht ein Popup zeigen. Nur eine Data-Nachricht mit hoher
 * Priorität landet auch im Doze-Modus zuverlässig in onMessageReceived.
 *
 * @returns {{ok: boolean, status: number, body: string}}
 */
export async function sendeDaten(token, daten) {
  const zugangstoken = await holeZugangstoken();
  const url = `https://fcm.googleapis.com/v1/projects/${process.env.FCM_PROJECT_ID}/messages:send`;
  const antwort = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${zugangstoken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        data: daten,
        android: { priority: 'HIGH' },
      },
    }),
  });
  const text = await antwort.text().catch(() => '');
  return { ok: antwort.ok, status: antwort.status, body: text.slice(0, 500) };
}
