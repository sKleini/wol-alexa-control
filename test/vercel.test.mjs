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

test('strom_rewrite_vor_der_startseite', () => {
  // /api/strom hat keine eigene Funktion - der Hobby-Tarif erlaubt zwoelf, und
  // api/ hat zwoelf. Der Rewrite fuehrt zu api/relay-status.js, das an
  // lib/strom.js weitergibt.
  const rewrites = konfig.rewrites || [];
  const strom = rewrites.findIndex(r => r.source === '/api/strom');
  const start = rewrites.findIndex(r => r.source === '/');
  assert.notEqual(strom, -1);
  assert.equal(rewrites[strom].destination, '/api/relay-status?art=strom');
  assert.ok(strom < start);
  assert.ok(!Object.keys(konfig.functions || {}).some(k => k.includes('strom')));
});

test('relay_status_leitet_strom_vor_der_schluesselpruefung_weiter', () => {
  // Als Text geprueft: api/relay-status.js laedt @upstash/redis, und das ist
  // in der Test-Umgebung nicht installiert. Die Weiterleitung muss vor
  // keyOk() und vor der Methodenpruefung stehen - sonst bekaeme DELETE ein
  // 405 und der VPS mit seinem Push-Schluessel ein 401.
  const text = readFileSync(new URL('../api/relay-status.js', import.meta.url), 'utf8');
  const weiter = text.indexOf('return handleStrom(req, res, redis)');
  assert.notEqual(weiter, -1);
  assert.ok(weiter < text.indexOf("if (!['GET', 'POST'].includes(req.method))"));
  assert.ok(weiter < text.indexOf('if (!keyOk(req))'));
  // Ob Vercel die Query des Rewrite-Ziels in req.url schreibt, ist nicht
  // sicher - darum zaehlt auch der Pfad.
  assert.match(text, /queryOf\(req\)\.art === 'strom' \|\| \(req\.url \|\| ''\)\.startsWith\('\/api\/strom'\)/);
});
