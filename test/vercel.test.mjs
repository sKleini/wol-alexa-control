// test/vercel.test.mjs – die Einstellungen in vercel.json, an denen die
// Wiedergabe haengt.
//
//   node --test
//
// Sie stehen in keiner Zeile Code und fallen deshalb bei keinem anderen Test
// auf, wenn jemand sie zuruecknimmt - und Fluid Compute ist bei Vercel fuer
// neue Projekte die Vorgabe.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const konfig = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

test('Fluid Compute bleibt aus - sonst wartet ein Befehl auf eine haengende Lieferung', () => {
  // **Gemessen am 28.9.** Gestoppt, waehrend der Echo den Titel noch lud: Die
  // beiden Lieferungen hingen bis zum Zeitlimit von 60 s, und das "spiele
  // ..." von 12:52:53 UTC lief auf derselben Instanz erst um 12:53:47.191 -
  // 2 ms nach ihrem `Task timed out after 60 seconds`. Alexa hatte um
  // 12:53:05 mit `INVALID_RESPONSE` aufgegeben. Ohne Fluid Compute hat jede
  // Anfrage eine Instanz fuer sich. Siehe README, "Fluid Compute is off".
  assert.equal(konfig.fluid, false);
});

test('Ohne Fluid Compute brauchen Ton und Pruefung ihr eigenes Zeitlimit', () => {
  // Ohne Eintrag gibt Vercel zehn Sekunden. Eine Lieferung dauert 10 bis 14 s,
  // "Check URLs" prueft eine FRITZ!NAS-Freigabe einen Titel nach dem anderen.
  assert.equal(konfig.functions?.['api/skill.js']?.maxDuration, 60);
  assert.equal(konfig.functions?.['api/manage.js']?.maxDuration, 60);
});
