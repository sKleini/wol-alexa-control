// api/ring.js – /api/ring?u=<person name>&do=<verb>
//
// Schickt der Mylo-App einen Befehl. Ausgelöst wird das aus der
// Actions-Hub-App per langem Tipp auf eine Zeile der Standort-Liste:
//
//   ring       Alarmton spielen, auch im Lautlos-Modus (Vorgabe)
//   silence    laufendes Klingeln UND Licht beenden
//   torch      Taschenlampe an (Dauerlicht, max. 5 Minuten)
//   torch-off  nur die Taschenlampe wieder aus
//   unmute     Klingelmodus wieder auf "normal" und Lautstärke hoch
//   vibrate    Klingelmodus auf Vibration
//   dnd-off    "Nicht stören" aufheben
//   dnd-on     "Nicht stören" einschalten (Filter "Prioritär", nicht "Totenstille")
//   locate     sofort eine frische Position melden
//   say        einen Text vorlesen (Parameter t=<Text>, sonst Mylos Standardsatz)
//   volume     Tonkanaele auf einen Prozentwert stellen
//              (Parameter t=media=70,ring=100 - ohne ihn passiert nichts)
//   buzz       ruettelt bis zu 30 Sekunden im Muster, ohne jeden Ton
//   buzz-off   nur das Ruetteln wieder aus
//   show       zeigt einen Text gross auf dem Bildschirm, auch im gesperrten
//              Zustand (Parameter t=<Text> wie bei say). Der sichtbare
//              Zwilling zu say: Er bleibt stehen, statt vorbei zu sein.
//              Dazu optional ein Bild: i=<id> aus dem Zwischenlager. Das Bild
//              selbst passt in keine Push-Nutzlast, deshalb nur die Kennung.
//   zones      die Zonen sofort neu holen, statt auf den Sechs-Stunden-Zyklus
//              zu warten. Schickt api/manage.js von selbst an alle Personen,
//              sobald sich eine Zone aendert; hier steht das Verb fuer den Fall,
//              dass ein Handy den Push verpasst hat.
//   interval   Mylos Sendetakt setzen (Parameter t=<Minuten>, ohne ihn faellt
//              das Handy auf "automatisch" zurueck und rechnet den Takt selbst.
//              Mylo klemmt die Zahl auf 15 bis 720 Minuten). Der einzige
//              Befehl, der drueben eine Einstellung verstellt statt etwas
//              auszuloesen - deshalb gilt er, bis ihn jemand wieder aendert.
//   pause      Mylos Uebermittlung anhalten. Das Handy schickt vorher noch
//              eine letzte Statusmeldung mit `pause=1`; ohne die saehe es in
//              der Liste aus wie ein leeres oder eines im Funkloch.
//   resume     die Uebermittlung wieder aufnehmen. Kommt an, weil der Push
//              auch bei angehaltener Uebermittlung ausgefuehrt wird - die
//              erste Meldung danach loescht die `pause`-Markierung von selbst.
//
// Mit dem Parameter `bild` ist dieselbe Adresse ausserdem das Zwischenlager
// fuer genau dieses Bild (POST legt ab, GET holt; siehe lib/bild.js). Das ist
// keine Eleganz, sondern eine Auflage: Vercel macht aus jeder Datei unter
// `api/` eine Serverless Function, und der Hobby-Tarif erlaubt zwoelf. Ein
// eigenes `api/bild.js` waere die dreizehnte gewesen und liess den Deploy
// scheitern. Der Zusammenhang stimmt trotzdem - das Bild gehoert zum Befehl.
//
// Warum der Umweg über den Server: Der Push braucht den privaten Schlüssel
// eines Firebase-Dienstkontos (siehe lib/fcm.js). Der darf nicht in eine APK.
//
// Der Endpunkt heisst weiterhin /api/ring, obwohl er inzwischen mehr kann:
// Actions Hub 2.1.0 ist bereits ausgeliefert und ruft genau diesen Pfad.
//
// **Die Zustellung selbst steht in lib/ring.js**, seit es zwei Absender gibt:
// diesen Endpunkt und die Sprachbefehle in api/skill.js. Hier bleibt nur, was
// zu HTTP gehoert - Schluessel pruefen, Parameter lesen, das Ergebnis in die
// JSON-Antwort uebersetzen, die beide Apps seit 2.1.0 lesen.
//
// Das Gerätetoken kommt von der App selbst – sie schickt es bei jeder
// Standortmeldung als Kopfzeile X-Fcm-Token mit (api/location.js).
import { Redis } from '@upstash/redis'
import { keyOk } from '../lib/auth.js'
import { fcmKonfiguriert } from '../lib/fcm.js'
import { bildHandler, istBildAnfrage } from '../lib/bild.js'
import { BEFEHLE, befehlAnPerson } from '../lib/ring.js'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

// Weiterhin exportiert, damit vorhandene Aufrufer und Pruefungen nichts
// merken - die Liste selbst wohnt jetzt in lib/ring.js, weil auch der
// Alexa-Skill sie braucht.
export { BEFEHLE };

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!keyOk(req)) return res.status(401).end();

  // Vor allem anderen abzweigen: Die Bild-Anfrage hat weder eine Person noch
  // ein Verb, und sie braucht auch kein Firebase - sie legt nur ab oder holt.
  if (istBildAnfrage(req.query)) return bildHandler(req, res);

  // **Diese Pruefung steht hier und nicht erst in lib/ring.js**, obwohl sie
  // dort noch einmal vorkommt: Sie stand vor dem Umbau an genau dieser Stelle,
  // also VOR dem Lesen von "u" und "do". Ein unkonfiguriertes Firebase
  // antwortet damit weiterhin mit fcm_not_configured statt mit einem 400 -
  // eine Reihenfolge, an der eine ausgelieferte App haengen koennte, aendert
  // man nicht nebenbei bei einem Umbau, der nichts aendern soll.
  //
  // Kein Fehler, sondern ein Zustand: Ohne die drei FCM_*-Variablen gibt es
  // diesen Weg schlicht nicht, und die App faellt auf ntfy zurueck. Ein 500
  // wuerde dort als Stoerung erscheinen, obwohl alles wie eingerichtet ist.
  if (!fcmKonfiguriert()) {
    return res.status(200).json({ ok: false, reason: 'fcm_not_configured' });
  }

  const personName = (req.query.u || '').trim();
  if (!personName) return res.status(400).json({ error: 'Missing person (u param)' });

  const befehl = (req.query.do || 'ring').trim().toLowerCase();
  // Unbekannte Verben werden abgewiesen statt durchgereicht: Sonst kaeme beim
  // Handy ein Befehl an, den dort niemand kennt - die App wuerde ihn stumm
  // verwerfen, und der Aufrufer haette "zugestellt" gemeldet.
  if (!BEFEHLE.includes(befehl)) {
    return res.status(400).json({ error: `Unknown command '${befehl}' (do param)`, allowed: BEFEHLE });
  }

  // `r=1` heisst "veroeffentliche den Rueckfall selbst". Der Actions Hub
  // schickte seine ntfy-Zeile bis hierher gleich nach diesem Aufruf selbst;
  // zwei Veroeffentlichungen mit leicht verschiedenen Zeitstempeln laegen dann
  // im Topic nebeneinander, und Mylos Dublettenschutz hielte die zweite fuer
  // neuer. Seit er es nicht mehr tut, sagt er es mit diesem Parameter - und
  // ein aelterer Hub, der ihn nicht kennt, veroeffentlicht wie gehabt selbst.
  // So gibt es zu jeder Zeit genau einen Absender, ohne Absprache.
  //
  // Hinterlegt wird der Befehl ohnehin und unabhaengig davon (lib/ring.js):
  // Das ist der Weg fuer jedes Mylo, das den Rueckfall aus der Antwort auf
  // seine Standortmeldung liest, und er kostet dort keinen eigenen Request.
  const ergebnis = await befehlAnPerson(redis, personName, befehl, {
    text: req.query.t,
    bild: req.query.i,
    rueckfall: req.query.r === '1',
  });

  // Die Antwort ist Zeichen fuer Zeichen die von vorher - beide Apps lesen
  // "ok" und "reason", und eine umbenannte Zeile hier waere ein stiller
  // Ausfall dort.
  if (ergebnis.ok) {
    return res.status(200).json({
      ok: true,
      person: ergebnis.person,
      do: befehl,
      tst: Math.floor(Date.now() / 1000),
    });
  }
  switch (ergebnis.grund) {
    case 'kein_fcm':
      // Oben schon abgefangen; steht hier fuer den Fall, dass die Pruefung
      // dort einmal verschwindet, damit dann nicht "push_failed" herauskommt.
      return res.status(200).json({ ok: false, reason: 'fcm_not_configured' });
    case 'unbekannte_person':
      return res.status(200).json({ ok: false, reason: 'unknown_person' });
    case 'kein_token':
      // Der haeufigste Fall beim ersten Einrichten: Die App hat noch nie
      // gemeldet. Eigener Grund statt eines nichtssagenden Fehlers, damit man
      // weiss, dass man in Mylo einmal "Jetzt senden" druecken muss.
      return res.status(200).json({ ok: false, reason: 'no_token' });
    default:
      return res.status(200).json({
        ok: false,
        reason: 'push_failed',
        status: ergebnis.status,
      });
  }
}
