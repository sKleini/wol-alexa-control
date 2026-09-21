// test/musik.test.mjs – Meine Plattenkiste ohne Netz und ohne Redis.
//
//   node --test
//
// Geprueft werden die reinen Funktionen aus lib/musik.js und der Skill-Handler
// mit einem Redis-Stellvertreter. Kein Testpaket noetig: node:test und
// node:assert reichen, und sie laufen in derselben CI wie die Modell-Pruefung.
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Das Antwortbudget des Skills auf einen Testwert. Wirkt, weil lib/musik.js es
// bei jedem Request neu liest - eine Konstante beim Laden des Moduls waere hier
// nicht mehr zu erreichen, denn ES-Module fuehren ihre Importe vorher aus.
process.env.MUSIK_BUDGET_MS = '300';
import {
  titelnameAusUrl,
  validierePlaylist,
  normalisiere,
  findePlaylist,
  tokenBauen,
  tokenLesen,
  schritt,
  playDirektive,
  istPrivateAdresse,
  wiederholtSich,
  sagtAn,
  mischt,
  setztFort,
  fortsetzArt,
  reihenfolge,
  titelAn,
  neuerSeed,
  einstieg,
  einstiegNachGangart,
  standNichtZurueck,
  groesseAusContentRange,
  lesbareGroesse,
  spieldauerSekunden,
  lesbareDauer,
  laengerAlsSitzung,
  handleSkill,
  alexaVorlaufMs,
  handleManage,
  fritzSidMerken,
  istAudioUrl,
  audioLinksAusHtml,
  audioNamenImText,
  seitenDiagnose,
  sortierePlaylists,
  REDIS_KEY,
  alsSidTafel,
  fremderOrdner,
} from '../lib/musik.js'

// --- Helfer -----------------------------------------------------------------

function redisMit(daten = {}) {
  const speicher = { ...daten };
  return {
    speicher,
    async get(key) { return speicher[key] ?? null; },
    async set(key, wert) { speicher[key] = wert; },
    // Der Verlauf interessiert hier nicht, soll aber auch nicht in jedem
    // zweiten Test eine Warnung ausloesen: Wer ihn pruefen will, nimmt
    // `redisMitListe` weiter unten.
    async lpush() {}, async ltrim() {}, async expire() {},
  };
}

/**
 * Die Play-Direktive einer Antwort - egal, was vor ihr steht.
 *
 * **Hier stand ueberall `directives[0]`, und das war eine Wette auf die
 * Reihenfolge.** Seit vor einem Start ein `AudioPlayer.ClearQueue` steht,
 * ist die Wiedergabe nicht mehr die erste Direktive - und vierundvierzig
 * Tests fielen auf einmal um, ohne dass an ihrer Aussage etwas falsch war.
 * Gesucht wird deshalb nach dem Typ: Das ist die Frage, die sie stellen
 * wollten.
 */
const spielt = (r) => (r.directives || []).find(d => d.type === 'AudioPlayer.Play');

function antwortFaenger() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = () => res;
  return res;
}

const KINDER = {
  name: 'Kinderlieder',
  titel: [
    { url: 'https://example.org/k/01.mp3', name: '01' },
    { url: 'https://example.org/k/02.mp3', name: '02' },
    { url: 'https://example.org/k/03.mp3', name: '03' },
  ],
};
const EINZEL = { name: 'Solo', titel: [{ url: 'https://example.org/solo.mp3', name: 'solo' }] };
const EINMAL = { name: 'Einmal', wiederholen: false, titel: KINDER.titel };
const STILL = { name: 'Leise', ansage: false, titel: KINDER.titel };

/**
 * Die Anfrage, wie sie wirklich ankommt - mit allem, was gefehlt hat.
 *
 * **Die Sitzung stand hier nirgends, und genau das hat einen Fehler
 * durchgelassen.** Ein LaunchRequest und ein gesprochener Intent im Dialog
 * tragen ein `session`-Objekt; "Stopp" oder "weiter" waehrend laufender Musik
 * tragen keines. Wovon die Antwort dann nichts enthalten darf, steht in
 * `hatSitzung` in lib/musik.js - ohne diese Unterscheidung sahen alle Tests
 * aus wie ein Dialog, und die Antwort ohne Sitzung wurde nie geprueft.
 *
 * `aktivitaet` und `ohneOffset` sind der andere gemeldete Zustand: Das Geraet
 * traegt den Token seines letzten Stroms noch, die Stelle darin aber nicht
 * mehr - null, oder gar kein Feld.
 */
function anfrage(request, { token, offset = 0, geraet, ohneSitzung = false, aktivitaet = 'PLAYING', ohneOffset = false } = {}) {
  const body = {
    context: { System: { application: { applicationId: 'amzn1.ask.skill.musik' } } },
    request: { timestamp: new Date().toISOString(), ...request },
  };
  const imDialog = request.type === 'IntentRequest' || request.type === 'LaunchRequest';
  if (imDialog && !ohneSitzung) {
    body.session = { new: true, sessionId: 'amzn1.echo-api.session.test', application: { applicationId: 'amzn1.ask.skill.musik' } };
  }
  if (token) {
    body.context.AudioPlayer = { token, playerActivity: aktivitaet };
    if (!ohneOffset) body.context.AudioPlayer.offsetInMilliseconds = offset;
  }
  // `geraet` ist die Liste der Schnittstellen, die das Geraet meldet. Ohne sie
  // steht in der Anfrage kein `device` - so wie bei allen anderen Tests hier,
  // und so kommen sie auch weiterhin ans Abspielen.
  if (geraet) body.context.System.device = { supportedInterfaces: Object.fromEntries(geraet.map(n => [n, {}])) };
  return body;
}

function intent(name, slotWert) {
  const req = { type: 'IntentRequest', intent: { name } };
  if (slotWert !== undefined) req.intent.slots = { playlist: { name: 'playlist', value: slotWert } };
  return req;
}

/**
 * Der Ein-Satz-Aufruf, so wie er wirklich ankommt: Ein AMAZON.SearchQuery-Slot
 * heisst `suche` und bringt **keine** resolutions mit - Entity Resolution gibt
 * es fuer diesen Typ nicht, es kommt nur der gehoerte Text.
 */
function sucheIntent(wert) {
  return { type: 'IntentRequest', intent: { name: 'SuchePlaylistIntent', slots: { suche: { name: 'suche', value: wert } } } };
}

async function skill(request, opts = {}, playlists = [KINDER, EINZEL], redis = null) {
  const res = antwortFaenger();
  await handleSkill(anfrage(request, opts), res, redis || redisMit({ [REDIS_KEY]: playlists }));
  return res.body.response;
}

/** Eine Playlist, die fortgesetzt wird, samt Redis zum Hineinschauen. */
function mitStand(playlist, stand = null) {
  const daten = { [REDIS_KEY]: [playlist] };
  if (stand) daten.musik_stand = { [playlist.name.toLowerCase()]: stand };
  return redisMit(daten);
}

const HOERSPIEL = { name: 'Hörspiel', fortsetzen: true, wiederholen: false, titel: KINDER.titel };

// --- titelnameAusUrl ----------------------------------------------------------

test('titelnameAusUrl nimmt den Dateinamen ohne Endung und Trenner', () => {
  assert.equal(titelnameAusUrl('https://h.de/musik/01_Hallo-Welt.mp3'), '01 Hallo Welt');
  assert.equal(titelnameAusUrl('https://h.de/a/b/Gute%20Nacht.MP3?x=1'), 'Gute Nacht');
  assert.equal(titelnameAusUrl('https://h.de/'), '');
  assert.equal(titelnameAusUrl('kaputt'), '');
});

// --- validierePlaylist --------------------------------------------------------

test('validierePlaylist nimmt Text mit einer URL je Zeile und optionalem Namen', () => {
  const { playlist, fehler } = validierePlaylist({
    name: ' Kinderlieder ',
    urls: 'https://h.de/01.mp3\n\n  https://h.de/02.mp3 | Zweiter Titel  \r\n',
  });
  assert.equal(fehler, undefined);
  assert.equal(playlist.name, 'Kinderlieder');
  assert.deepEqual(playlist.titel, [
    { url: 'https://h.de/01.mp3', name: '01' },
    { url: 'https://h.de/02.mp3', name: 'Zweiter Titel' },
  ]);
});

test('validierePlaylist nimmt auch ein Array von Zeilen', () => {
  const { playlist } = validierePlaylist({ name: 'A', urls: ['https://h.de/a.mp3'] });
  assert.equal(playlist.titel.length, 1);
});

test('validierePlaylist nennt die Zeile, die nicht stimmt', () => {
  assert.match(validierePlaylist({ name: 'A', urls: 'https://h.de/1.mp3\nhttp://h.de/2.mp3' }).fehler, /Zeile 2: .*https/);
  assert.match(validierePlaylist({ name: 'A', urls: 'https://h.de/1.mp3\nkein link' }).fehler, /Zeile 2: keine gueltige URL/);
  assert.match(validierePlaylist({ name: 'A', urls: 'https://h.de/1.mp3\nhttps://h.de/1.mp3' }).fehler, /Zeile 2: .*doppelt/);
  assert.match(validierePlaylist({ name: 'A', urls: 'https://u:p@h.de/1.mp3' }).fehler, /Zugangsdaten/);
});

test('validierePlaylist verlangt Name und mindestens eine URL', () => {
  assert.match(validierePlaylist({ name: '', urls: 'https://h.de/1.mp3' }).fehler, /Name fehlt/);
  assert.match(validierePlaylist({ name: 'A', urls: '\n\n' }).fehler, /Keine URL/);
  assert.match(validierePlaylist({ name: 'A' }).fehler, /URLs fehlen/);
  assert.match(validierePlaylist({ name: 'A|B', urls: 'https://h.de/1.mp3' }).fehler, /\|/);
});

// --- Namen finden -------------------------------------------------------------

test('normalisiere macht Umlaute und Sonderzeichen vergleichbar', () => {
  assert.equal(normalisiere('Hörspiele!'), 'hoerspiele');
  assert.equal(normalisiere('Café Musik'), 'cafemusik');
});

test('findePlaylist bevorzugt den aufgeloesten Slot-Wert', () => {
  const slot = {
    name: 'playlist',
    value: 'kinder lieder',
    resolutions: { resolutionsPerAuthority: [
      { status: { code: 'ER_SUCCESS_NO_MATCH' } },
      { status: { code: 'ER_SUCCESS_MATCH' }, values: [{ value: { name: 'Kinderlieder' } }] },
    ] },
  };
  assert.equal(findePlaylist([KINDER, EINZEL], slot).playlist, KINDER);
});

test('findePlaylist ist kulant beim gehoerten Wort', () => {
  const liste = [KINDER, { name: 'Hörspiele', titel: [] }];
  assert.equal(findePlaylist(liste, { value: 'hoerspiele' }).playlist.name, 'Hörspiele');
  assert.equal(findePlaylist(liste, { value: 'Kinder' }).playlist, KINDER);
  assert.equal(findePlaylist(liste, { value: 'die kinderlieder bitte' }).playlist, KINDER);
  assert.equal(findePlaylist(liste, { value: 'Jazz' }).playlist, null);
  assert.equal(findePlaylist(liste, { value: 'Jazz' }).gesagt, 'Jazz');
  assert.deepEqual(findePlaylist(liste, undefined), { playlist: null, gesagt: null });
});

// --- Token und Schritte -------------------------------------------------------

test('Token hin und zurueck', () => {
  assert.equal(tokenBauen('Kinderlieder', 2, 1), 'Kinderlieder|2|1|0');
  assert.equal(tokenBauen('Kinderlieder', 2, 1, 4711), 'Kinderlieder|2|1|4711');
  assert.deepEqual(tokenLesen('Kinderlieder|2|1|4711'), { name: 'Kinderlieder', position: 2, runde: 1, seed: 4711, versuch: 0, pech: 0 });
  assert.equal(tokenLesen('fremd'), null);
  assert.equal(tokenLesen('a|x|1|0'), null);
  assert.equal(tokenLesen('a|-1|1|0'), null);
  assert.equal(tokenLesen('a|0|0|-1'), null);
  assert.equal(tokenLesen('a|0|0|0|-1'), null);
  assert.equal(tokenLesen('a|0|0|0|0|-1'), null);
  assert.equal(tokenLesen('a|0|0|0|0|0|0'), null, 'sieben Teile sind nicht von hier');
  assert.equal(tokenLesen(undefined), null);
});

test('Der Versuchszaehler steht nur im Token, wenn es einen Versuch gab', () => {
  // Eine 0 wegzulassen ist kein Geiz: Ein Token, bei dem nichts schiefging,
  // sieht damit aus wie vor dieser Fassung - und jeder Stream, der beim
  // Deploy laeuft, bleibt gueltig.
  assert.equal(tokenBauen('Kinderlieder', 2, 1, 4711, 0), 'Kinderlieder|2|1|4711');
  assert.equal(tokenBauen('Kinderlieder', 2, 1, 4711, 1), 'Kinderlieder|2|1|4711|1');
  assert.deepEqual(
    tokenLesen('Kinderlieder|2|1|4711|1'),
    { name: 'Kinderlieder', position: 2, runde: 1, seed: 4711, versuch: 1, pech: 0 },
  );
});

test('Die Pechstraehne haengt hinten an und laesst heile Token in Ruhe', () => {
  // Sie zaehlt die Titel, die hintereinander nicht angelaufen sind. Steht
  // keiner an, sieht der Token aus wie vorher - ein Stream, der beim Deploy
  // laeuft, bleibt gueltig.
  assert.equal(tokenBauen('Kinderlieder', 2, 1, 4711, 0, 0), 'Kinderlieder|2|1|4711');
  assert.equal(tokenBauen('Kinderlieder', 2, 1, 4711, 0, 2), 'Kinderlieder|2|1|4711|0|2');
  assert.equal(tokenBauen('Kinderlieder', 2, 1, 4711, 1, 2), 'Kinderlieder|2|1|4711|1|2');
  assert.deepEqual(
    tokenLesen('Kinderlieder|2|1|4711|0|2'),
    { name: 'Kinderlieder', position: 2, runde: 1, seed: 4711, versuch: 0, pech: 2 },
  );
});

test('Ein Token aus der Zeit vor der Mischung bleibt lesbar', () => {
  // Ein Stream, der beim Deploy noch laeuft, traegt drei Teile. Wuerde der
  // ploetzlich als fremd gelten, braeche die Wiedergabe mitten im Titel ab.
  assert.deepEqual(tokenLesen('Kinderlieder|1|2'), { name: 'Kinderlieder', position: 1, runde: 2, seed: 0, versuch: 0, pech: 0 });
});

test('schritt laeuft vorwaerts mit Umbruch und zaehlt die Runde hoch', () => {
  assert.deepEqual(schritt(KINDER, { position: 0, runde: 0, seed: 0 }, +1), { position: 1, runde: 0, seed: 0, umbruch: false });
  assert.deepEqual(schritt(KINDER, { position: 2, runde: 0, seed: 0 }, +1), { position: 0, runde: 1, seed: 0, umbruch: true });
});

test('schritt rueckwaerts bricht am Anfang um', () => {
  assert.deepEqual(schritt(KINDER, { position: 1, runde: 3, seed: 0 }, -1), { position: 0, runde: 3, seed: 0, umbruch: false });
  assert.deepEqual(schritt(KINDER, { position: 0, runde: 3, seed: 0 }, -1), { position: 2, runde: 4, seed: 0, umbruch: true });
});

test('Ein-Titel-Playlist bekommt bei jedem Schritt einen neuen Token', () => {
  const a = schritt(EINZEL, { position: 0, runde: 0, seed: 0 }, +1);
  assert.deepEqual(a, { position: 0, runde: 1, seed: 0, umbruch: true });
  assert.notEqual(tokenBauen('Solo', a.position, a.runde), tokenBauen('Solo', 0, 0));
});

test('schritt faengt eine Stelle jenseits der gekuerzten Playlist ab', () => {
  assert.deepEqual(schritt(KINDER, { position: 7, runde: 0, seed: 0 }, +1), { position: 0, runde: 1, seed: 0, umbruch: true });
  assert.equal(schritt({ name: 'leer', titel: [] }, { position: 0, runde: 0, seed: 0 }, +1), null);
});

// --- Mischung -----------------------------------------------------------------

test('reihenfolge: Seed 0 laesst die Liste in Ruhe, jeder andere mischt fest', () => {
  assert.deepEqual(reihenfolge(4, 0), [0, 1, 2, 3]);
  const a = reihenfolge(8, 12345);
  assert.deepEqual(a, reihenfolge(8, 12345), 'derselbe Seed, dieselbe Folge');
  assert.notDeepEqual(a, [0, 1, 2, 3, 4, 5, 6, 7], 'gemischt');
  assert.deepEqual([...a].sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7], 'jeder Titel genau einmal');
  assert.notDeepEqual(a, reihenfolge(8, 999), 'anderer Seed, andere Folge');
});

test('reihenfolge kommt mit leer und einem Titel klar', () => {
  assert.deepEqual(reihenfolge(0, 4711), []);
  assert.deepEqual(reihenfolge(1, 4711), [0]);
});

test('neuerSeed ist nie 0, denn 0 heisst ungemischt', () => {
  for (let i = 0; i < 200; i++) assert.ok(neuerSeed() > 0);
});

test('titelAn loest die Stelle ueber die Mischung auf', () => {
  const ungemischt = titelAn(KINDER, 1, 0);
  assert.equal(ungemischt.nummer, 1);
  assert.equal(ungemischt.titel, KINDER.titel[1]);

  const seed = 777;
  const folge = reihenfolge(3, seed);
  assert.equal(titelAn(KINDER, 2, seed).nummer, folge[2]);
});

test('schritt mischt beim Umbruch neu, aber nur wenn ueberhaupt gemischt wird', () => {
  const gemischt = schritt(KINDER, { position: 2, runde: 0, seed: 555 }, +1);
  assert.equal(gemischt.umbruch, true);
  assert.notEqual(gemischt.seed, 555, 'zweite Runde bekommt eine neue Folge');
  assert.ok(gemischt.seed > 0);

  const mitten = schritt(KINDER, { position: 0, runde: 0, seed: 555 }, +1);
  assert.equal(mitten.seed, 555, 'innerhalb der Runde bleibt die Folge');

  const ohne = schritt(KINDER, { position: 2, runde: 0, seed: 0 }, +1);
  assert.equal(ohne.seed, 0, 'ungemischt bleibt ungemischt');
});

test('playDirektive baut Stream und Anzeige', () => {
  const d = playDirektive(KINDER, 1, 0, { verhalten: 'ENQUEUE', vorherigerToken: 'Kinderlieder|0|0|0' });
  assert.equal(d.type, 'AudioPlayer.Play');
  assert.equal(d.playBehavior, 'ENQUEUE');
  assert.deepEqual(d.audioItem.stream, {
    url: 'https://example.org/k/02.mp3',
    token: 'Kinderlieder|1|0|0',
    offsetInMilliseconds: 0,
    expectedPreviousToken: 'Kinderlieder|0|0|0',
  });
  assert.equal(d.audioItem.metadata.title, '02');
  assert.equal(d.audioItem.metadata.subtitle, 'Kinderlieder · 2 von 3');

  const r = playDirektive(KINDER, 0, 2, { offset: 12345 });
  assert.equal(r.playBehavior, 'REPLACE_ALL');
  assert.equal(r.audioItem.stream.offsetInMilliseconds, 12345);
  assert.equal(r.audioItem.stream.expectedPreviousToken, undefined);
});

// --- Der Token, den das Geraet schon traegt ---------------------------------
//
// **Der gemeldete Fehler.** Eine Playlist aus einer FRITZ!NAS-Ordnerfreigabe
// starten, kurz darauf stoppen, wieder starten - und es kommt kein Ton. Im
// Log vom 21. September steht der Ablauf vollstaendig:
//
//   20:28:28  spielt Udo CD eins ab 1/13 bei 0 ms  → PlaybackStarted, Musik
//   20:28:41  AMAZON.PauseIntent, Stand 10432 ms gemerkt
//   20:28:55  spielt Udo CD eins ab 1/13 bei 0 ms  → GET auf die Tondatei,
//             und danach nichts: kein PlaybackStarted, kein PlaybackFailed
//
// Der einzige Unterschied zum geglueckten Start elf Sekunden davor: Diesmal
// war der Token Zeichen fuer Zeichen derselbe, den das Geraet vom ersten
// Start noch trug. Wer kurz nach dem Start stoppt, steht ja noch beim ersten
// Titel - Stelle, Runde und Mischung fallen dann zusammen.

test('Ein Start bekommt nie den Token, den das Geraet schon traegt', () => {
  const gleich = playDirektive(KINDER, 0, 0, { ungleich: 'Kinderlieder|0|0|0' });
  assert.equal(gleich.audioItem.stream.token, 'Kinderlieder|0|1|0', 'die Runde zaehlt hoch');
  assert.equal(gleich.audioItem.stream.url, 'https://example.org/k/01.mp3', 'derselbe Titel');

  const anderer = playDirektive(KINDER, 0, 0, { ungleich: 'Kinderlieder|1|0|0' });
  assert.equal(anderer.audioItem.stream.token, 'Kinderlieder|0|0|0', 'sonst bleibt alles, wie es war');

  // Ein ENQUEUE weist sich ueber `expectedPreviousToken` aus; dort ist der
  // Token des Geraets die Zusage und nicht die Kollision.
  const angehaengt = playDirektive(KINDER, 0, 0, {
    verhalten: 'ENQUEUE', vorherigerToken: 'Kinderlieder|2|0|0', ungleich: 'Kinderlieder|0|0|0',
  });
  assert.equal(angehaengt.audioItem.stream.token, 'Kinderlieder|0|0|0');
});

test('Starten, stoppen, wieder starten - der zweite Start bleibt nicht stumm', async () => {
  // Der gemeldete Ablauf, Schritt fuer Schritt. Der zweite Start trifft ein
  // Geraet, das den Token des ersten noch traegt.
  const erst = await skill(sucheIntent('kinderlieder'));
  assert.equal(spielt(erst).audioItem.stream.token, 'Kinderlieder|0|0|0');

  const stopp = await skill(intent('AMAZON.PauseIntent'), { token: 'Kinderlieder|0|0|0', offset: 10432 });
  assert.deepEqual(stopp.directives, [{ type: 'AudioPlayer.Stop' }]);

  const wieder = await skill(sucheIntent('kinderlieder'), { token: 'Kinderlieder|0|0|0', offset: 10432, aktivitaet: 'STOPPED' });
  assert.equal(spielt(wieder).audioItem.stream.token, 'Kinderlieder|0|1|0');
  assert.equal(spielt(wieder).audioItem.stream.url, 'https://example.org/k/01.mp3', 'und es ist derselbe Titel');
});

// --- Grenzen der URL-Pruefung -------------------------------------------------

test('istPrivateAdresse kennt die privaten Bereiche', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.188.90', '172.16.0.1', '172.31.255.255', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(istPrivateAdresse(ip), true, ip);
  }
  for (const ip of ['85.215.133.221', '172.32.0.1', '8.8.8.8', '2a01:239:316:6700::1']) {
    assert.equal(istPrivateAdresse(ip), false, ip);
  }
});

// --- Der Skill ------------------------------------------------------------------

test('LaunchRequest fragt knapp und schiebt die Namen trotzdem nach', async () => {
  // Gesprochen wird nur die Frage: Wer den Skill oeffnet, weiss meist schon,
  // was er hoeren will, und muss sich nicht erst durch alle Namen hoeren.
  //
  // Nachgeschoben werden sie trotzdem - als dynamische Entitaeten. Genau das
  // ist der Grund, warum Alexa die Antwort auf diese Frage versteht; sie
  // zusammen mit der Ansage wegzulassen waere der naheliegende Fehler und
  // machte die Rueckfrage unbrauchbar.
  const r = await skill({ type: 'LaunchRequest' });
  assert.match(r.outputSpeech.text, /Welche Playlist soll ich spielen\?/);
  assert.doesNotMatch(r.outputSpeech.text, /Ich kenne|Kinderlieder|Solo/);
  assert.equal(r.shouldEndSession, false);
  assert.equal(r.directives[0].type, 'Dialog.UpdateDynamicEntities');
  assert.deepEqual(r.directives[0].types[0].values.map(v => v.name.value), ['Kinderlieder', 'Solo']);
});

test('ein unbekannter Name zaehlt die Playlists weiterhin auf', async () => {
  // Die Gegenprobe zum Test darueber: Hier ist die Liste die eigentliche
  // Antwort, nicht Beiwerk. Ohne diesen Test wuerde eine spaetere
  // Vereinfachung von frageWelche die Unterscheidung unbemerkt einebnen.
  const r = await skill(intent('PlayPlaylistIntent', 'Taschenlampe'));
  assert.match(r.outputSpeech.text, /keine Playlist namens Taschenlampe/);
  assert.match(r.outputSpeech.text, /Ich kenne Kinderlieder und Solo/);
});

test('LaunchRequest ohne Playlists verweist aufs Dashboard', async () => {
  const r = await skill({ type: 'LaunchRequest' }, {}, []);
  assert.match(r.outputSpeech.text, /Dashboard/);
  assert.equal(r.directives, undefined);
});

test('PlayPlaylistIntent startet den ersten Titel', async () => {
  const r = await skill(intent('PlayPlaylistIntent', 'kinderlieder'));
  // Ohne Titelzahl: Die Ansage steht vor der Musik und bleibt deshalb kurz.
  assert.equal(r.outputSpeech.text, 'Ich spiele Kinderlieder.');
  assert.equal(r.shouldEndSession, true);
  // Die Warteschlange wird geleert, dann gespielt - und sonst geht nichts mit,
  // besonders keine dynamischen Werte neben einer AudioPlayer-Direktive.
  assert.deepEqual(r.directives.map(d => d.type), ['AudioPlayer.ClearQueue', 'AudioPlayer.Play']);
  assert.equal(spielt(r).playBehavior, 'REPLACE_ALL');
  assert.equal(spielt(r).audioItem.stream.token, 'Kinderlieder|0|0|0');
});

test('PlayPlaylistIntent fragt bei unbekanntem Namen nach und zaehlt auf', async () => {
  const r = await skill(intent('PlayPlaylistIntent', 'Jazz'));
  assert.match(r.outputSpeech.text, /keine Playlist namens Jazz.*Ich kenne Kinderlieder und Solo/);
  assert.equal(r.shouldEndSession, false);
});

test('PlayPlaylistIntent ohne Slot-Wert fragt nach', async () => {
  const r = await skill(intent('PlayPlaylistIntent'));
  assert.match(r.outputSpeech.text, /Welche Playlist/);
  assert.equal(r.shouldEndSession, false);
});

test('PlaybackNearlyFinished haengt den naechsten Titel an', async () => {
  const r = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Kinderlieder|1|0|0' }, { token: 'Kinderlieder|1|0|0' });
  assert.equal(r.outputSpeech, undefined);
  assert.equal(r.shouldEndSession, undefined);
  const d = r.directives[0];
  assert.equal(d.playBehavior, 'ENQUEUE');
  assert.equal(d.audioItem.stream.token, 'Kinderlieder|2|0|0');
  assert.equal(d.audioItem.stream.expectedPreviousToken, 'Kinderlieder|1|0|0');
});

test('Nach dem letzten Titel folgt wieder der erste - die Endlosschleife', async () => {
  const r = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Kinderlieder|2|0|0' }, { token: 'Kinderlieder|2|0|0' });
  assert.equal(spielt(r).audioItem.stream.token, 'Kinderlieder|0|1|0');
  assert.equal(spielt(r).audioItem.stream.url, KINDER.titel[0].url);
});

test('PlaybackNearlyFinished mit fremdem oder verwaistem Token bleibt still', async () => {
  const fremd = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'irgendwas' });
  assert.deepEqual(fremd, {});
  const weg = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Geloescht|0|0|0' });
  assert.deepEqual(weg, {});
});

test('Pause stoppt, Weiter setzt am Offset fort - um den Vorlauf zurueck', async () => {
  const pause = await skill(intent('AMAZON.PauseIntent'), { token: 'Kinderlieder|1|0|0', offset: 30000 });
  assert.deepEqual(pause.directives, [{ type: 'AudioPlayer.Stop' }]);
  assert.equal(pause.outputSpeech, undefined);

  const weiter = await skill(intent('AMAZON.ResumeIntent'), { token: 'Kinderlieder|1|0|0', offset: 30000 });
  // Derselbe Titel, dieselbe Mischung - nur die Runde zaehlt hoch, damit der
  // Token nicht der des pausierten Stroms ist. Mit ihm bliebe es still.
  assert.equal(spielt(weiter).audioItem.stream.token, 'Kinderlieder|1|1|0');
  assert.equal(spielt(weiter).audioItem.stream.offsetInMilliseconds, 25000);
});

test('Weiter ohne laufenden Stream fragt nach der Playlist', async () => {
  const r = await skill(intent('AMAZON.ResumeIntent'));
  assert.match(r.outputSpeech.text, /Es laeuft gerade nichts/);
});

test('Naechster und voriger Titel - per Sprache und per Knopf', async () => {
  const n = await skill(intent('AMAZON.NextIntent'), { token: 'Kinderlieder|0|0|0' });
  assert.equal(spielt(n).audioItem.stream.token, 'Kinderlieder|1|0|0');
  const v = await skill({ type: 'PlaybackController.PreviousCommandIssued' }, { token: 'Kinderlieder|0|0|0' });
  assert.equal(spielt(v).audioItem.stream.token, 'Kinderlieder|2|1|0');
  assert.equal(v.outputSpeech, undefined);
});

test('PlaybackFailed wiederholt den Titel einmal - und nur einmal', async () => {
  // Erster Fehler: derselbe Titel noch einmal, der Token traegt jetzt die 1.
  const erst = await skill({ type: 'AudioPlayer.PlaybackFailed', token: 'Kinderlieder|0|0|0', error: { type: 'MEDIA_ERROR_UNKNOWN' } });
  assert.equal(spielt(erst).audioItem.stream.token, 'Kinderlieder|0|0|0|1');

  // Zweiter Fehler am selben Titel: jetzt wird uebersprungen. Das Budget des
  // naechsten faengt wieder bei null an - er traegt aber die 1 der Straehne,
  // damit nicht die ganze Playlist durchlaeuft, wenn gar nichts mehr anlaeuft.
  const dann = await skill({ type: 'AudioPlayer.PlaybackFailed', token: 'Kinderlieder|0|0|0|1', error: { type: 'MEDIA_ERROR_UNKNOWN' } });
  assert.equal(spielt(dann).audioItem.stream.token, 'Kinderlieder|1|0|0|0|1');
});

test('nach drei Titeln, die nicht anlaufen, ist Schluss', async () => {
  // **Gemeldet:** neun Titel, jeder zweimal versucht, jeder mit
  // MEDIA_ERROR_INTERNAL_SERVER_ERROR - fuenfundsechzig Sekunden, in denen
  // kein Ton kam und die Box siebzehn Abrufe bekam. Wenn drei Titel
  // nacheinander nicht einmal anfangen, liegt es nicht an den Titeln.
  const aus = await skill({
    type: 'AudioPlayer.PlaybackFailed',
    token: 'Kinderlieder|0|0|0|1|2',
    error: { type: 'MEDIA_ERROR_INTERNAL_SERVER_ERROR' },
  });
  assert.deepEqual(aus.directives, [{ type: 'AudioPlayer.Stop' }], 'kein weiterer Titel');
});

test('ein Titel, der wirklich lief, loescht die Straehne', async () => {
  // Die Straehne meint "nichts laeuft mehr an". Ein Stueck, das eine halbe
  // Minute gespielt hat und dann abriss, gehoert nicht dazu - dort ging die
  // Kette aus Box, Leitung und Echo ja gerade noch.
  const weiter = await skill(
    { type: 'AudioPlayer.PlaybackFailed', token: 'Kinderlieder|0|0|0|1|2', error: { type: 'MEDIA_ERROR_UNKNOWN' } },
    { token: 'Kinderlieder|0|0|0|1|2', offset: 30000 },
  );
  assert.equal(spielt(weiter).audioItem.stream.token, 'Kinderlieder|1|0|0|0|1', 'die Zaehlung faengt von vorn an');
});

test('PlaybackFailed springt nicht ueber das Ende der Runde hinaus', async () => {
  // Der letzte Titel, schon einmal versucht: Ein Sprung waere ein Umbruch,
  // und dann endet die Wiedergabe, statt endlos um die Liste zu kreisen.
  const ende = await skill({ type: 'AudioPlayer.PlaybackFailed', token: 'Kinderlieder|2|0|0|1', error: { type: 'MEDIA_ERROR_UNKNOWN' } });
  assert.deepEqual(ende.directives, [{ type: 'AudioPlayer.Stop' }]);
});

test('der wiederholte Titel steigt dort ein, wo er abbrach', async () => {
  // Der uebliche Fall ist "nie angelaufen" - dann ist das der Anfang. Riss er
  // mitten im Stueck ab, greift derselbe Vorlauf wie beim Weiterhoeren.
  const anfang = await skill(
    { type: 'AudioPlayer.PlaybackFailed', token: 'Kinderlieder|0|0|0', error: { type: 'MEDIA_ERROR_INTERNAL_SERVER_ERROR' } },
    { token: 'Kinderlieder|0|0|0', offset: 1 },
  );
  assert.equal(spielt(anfang).audioItem.stream.offsetInMilliseconds, 0);

  const mittendrin = await skill(
    { type: 'AudioPlayer.PlaybackFailed', token: 'Kinderlieder|0|0|0', error: { type: 'MEDIA_ERROR_INTERNAL_SERVER_ERROR' } },
    { token: 'Kinderlieder|0|0|0', offset: 240_000 },
  );
  assert.equal(spielt(mittendrin).audioItem.stream.offsetInMilliseconds, einstieg(240_000));
});

test('Shuffle antwortet mit einem Satz', async () => {
  assert.match((await skill(intent('AMAZON.ShuffleOnIntent'))).outputSpeech.text, /Zufallswiedergabe/);
});

test('PlaybackStarted und SessionEnded bleiben still', async () => {
  assert.deepEqual(await skill({ type: 'AudioPlayer.PlaybackStarted', token: 'Kinderlieder|0|0|0' }), {});
  assert.deepEqual(await skill({ type: 'SessionEndedRequest' }), {});
});

// --- Wie gross ist die Datei? -------------------------------------------------------

test('groesseAusContentRange liest die Gesamtgroesse, sonst nichts', () => {
  assert.equal(groesseAusContentRange('bytes 0-0/52428800'), 52428800);
  assert.equal(groesseAusContentRange('bytes 0-0 / 52428800'), 52428800);
  assert.equal(groesseAusContentRange('bytes 0-0/*'), null, 'Laenge unbekannt');
  assert.equal(groesseAusContentRange(null), null, 'Kopf fehlt ganz');
  assert.equal(groesseAusContentRange('Unsinn'), null);
  assert.equal(groesseAusContentRange('bytes 0-0/0'), null, 'null Bytes ist keine Datei');
});

test('Groesse und Dauer werden lesbar ausgedrueckt', () => {
  assert.equal(lesbareGroesse(3145728), '3,0 MB');
  assert.equal(lesbareGroesse(52428800), '50 MB');
  assert.equal(lesbareGroesse(204800), '200 KB');
  assert.equal(lesbareGroesse(null), null);

  assert.equal(lesbareDauer(45), '45 Sekunden');
  assert.equal(lesbareDauer(600), '10 Minuten');
  assert.equal(lesbareDauer(7200), '2 Stunden');
  assert.equal(lesbareDauer(5400 + 600), '1 Std. 40 Min.');
  assert.equal(lesbareDauer(null), null);
});

test('laengerAlsSitzung warnt erst, wenn es sicher nicht reicht', () => {
  // Gerechnet mit 320 kbit/s, also der KUERZESTEN plausiblen Spieldauer:
  // Hinter der Warnung soll eine Gewissheit stehen, keine Annahme.
  assert.equal(laengerAlsSitzung(3145728), false, 'ein Lied');
  assert.equal(laengerAlsSitzung(52428800), true, 'ein Hoerspiel');
  assert.equal(laengerAlsSitzung(null), false, 'ohne Groesse keine Behauptung');

  // Die Schwelle selbst: zehn Minuten bei 320 kbit/s sind 24 MB.
  const zehnMinuten = (320 * 1000 * 600) / 8;
  assert.equal(laengerAlsSitzung(zehnMinuten - 1000), false);
  assert.equal(laengerAlsSitzung(zehnMinuten + 1000), true);
});

test('spieldauerSekunden rechnet mit der angenommenen Bitrate', () => {
  assert.equal(spieldauerSekunden((128 * 1000 * 60) / 8), 60, 'eine Minute bei 128 kbit/s');
  assert.equal(spieldauerSekunden((320 * 1000 * 60) / 8, 320), 60);
  assert.equal(spieldauerSekunden(null), null);
});

// --- Der Skill schweigt nie ---------------------------------------------------------

test('Ein Redis-Fehler sagt es, statt eine leere Liste vorzutaeuschen', async () => {
  // Frueher hiess es hier "es ist noch keine Playlist angelegt" - und wer fuenf
  // angelegt hatte, suchte den Fehler im Dashboard, wo keiner war.
  const res = antwortFaenger();
  const kaputt = { async get() { throw new Error('offline'); } };
  await handleSkill(anfrage({ type: 'LaunchRequest' }), res, kaputt);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.response.outputSpeech.text, /komme gerade nicht an deine Playlists/);
});

test('Eine wirklich leere Liste bleibt der Dashboard-Hinweis', async () => {
  // Die beiden Faelle muessen unterscheidbar bleiben, das ist der ganze Punkt.
  const r = await skill({ type: 'LaunchRequest' }, {}, []);
  assert.match(r.outputSpeech.text, /keine Playlist angelegt/);
});

test('Ein Redis, das nie antwortet, laesst Alexa trotzdem sprechen', async () => {
  // Ohne Frist wartete der Skill, bis Alexa aufgab - und der Sprechende hoerte
  // gar nichts. Das Budget steht fuer diesen Test auf 300 ms (siehe unten).
  const res = antwortFaenger();
  const haengt = { get: () => new Promise(() => {}) };
  const begonnen = Date.now();
  await handleSkill(anfrage({ type: 'LaunchRequest' }), res, haengt);
  assert.ok(Date.now() - begonnen < 2000, 'antwortet binnen Frist statt zu haengen');
  assert.match(res.body.response.outputSpeech.text, /komme gerade nicht an deine Playlists/);
});

test('Eine offene Rueckfrage traegt ein Reprompt, eine Wiedergabe nicht', async () => {
  // Ohne Reprompt beendet Alexa die Sitzung kommentarlos, und der naechste Satz
  // geht ins Leere - der haeufigste Grund fuer "klappt erst beim zweiten Mal".
  const frage = await skill({ type: 'LaunchRequest' });
  assert.equal(frage.shouldEndSession, false);
  assert.match(frage.reprompt.outputSpeech.text, /Welche Playlist soll ich spielen/);

  const spielt = await skill(sucheIntent('kinderlieder'));
  assert.equal(spielt.shouldEndSession, true);
  assert.equal(spielt.reprompt, undefined, 'neben AudioPlayer.Play waere es ungueltig');
});

test('Das Nachfragen zaehlt die Namen nicht noch einmal auf', async () => {
  const r = await skill(sucheIntent('Bundesliga'));
  assert.match(r.outputSpeech.text, /Ich kenne/, 'die erste Antwort nennt sie');
  assert.doesNotMatch(r.reprompt.outputSpeech.text, /Ich kenne/, 'das Nachfragen nicht');
});

// --- Der Name aus freiem Text (AMAZON.SearchQuery) ---------------------------------

test('SuchePlaylistIntent spielt einen Namen, der im Modell nirgends steht', async () => {
  const neu = { name: 'Taschenlampe', titel: [{ url: 'https://example.org/t.mp3', name: 't' }] };
  const r = await skill(sucheIntent('taschenlampe'), {}, [KINDER, neu]);
  assert.equal(r.outputSpeech.text, 'Ich spiele Taschenlampe.');
  assert.equal(spielt(r).audioItem.stream.token, 'Taschenlampe|0|0|0');
});

test('SuchePlaylistIntent uebersteht Fuellwoerter im freien Text', async () => {
  const neu = { name: 'Taschenlampe', titel: [{ url: 'https://example.org/t.mp3', name: 't' }] };
  for (const gesagt of ['die taschenlampe', 'mal die taschenlampe bitte', 'taschen lampe']) {
    const r = await skill(sucheIntent(gesagt), {}, [KINDER, neu]);
    assert.equal(spielt(r)?.audioItem.stream.token, 'Taschenlampe|0|0|0', gesagt);
  }
});

test('SuchePlaylistIntent fragt nach, wenn wirklich nichts passt', async () => {
  const r = await skill(sucheIntent('Bundesliga'));
  assert.match(r.outputSpeech.text, /keine Playlist namens Bundesliga/);
  assert.equal(r.shouldEndSession, false);
});

test('Beide Intents fuehren zum selben Ergebnis', async () => {
  const ueberSuche = await skill(sucheIntent('kinderlieder'));
  const ueberSlot = await skill(intent('PlayPlaylistIntent', 'kinderlieder'));
  assert.deepEqual(ueberSuche.directives, ueberSlot.directives);
  assert.equal(ueberSuche.outputSpeech.text, ueberSlot.outputSpeech.text);
});

// --- Wiederholung -----------------------------------------------------------------

test('Beide Schalter: nur ein ausdrueckliches false schaltet ab', () => {
  for (const [name, fn, feld] of [['wiederholtSich', wiederholtSich, 'wiederholen'], ['sagtAn', sagtAn, 'ansage']]) {
    assert.equal(fn({ [feld]: true }), true, name);
    assert.equal(fn({ [feld]: false }), false, name);
    assert.equal(fn({}), true, `${name}: fehlendes Feld heisst ja`);
    assert.equal(fn(null), true, `${name}: neue Playlist steht auf an`);
  }
  // Die Schalter sind unabhaengig voneinander.
  assert.equal(wiederholtSich({ ansage: false }), true);
  assert.equal(sagtAn({ wiederholen: false }), true);
});

test('fortsetzArt kennt drei Zustaende und versteht den Wert von frueher', () => {
  // `true` ist der gespeicherte Wert aus der Zeit vor den Gangarten. Er muss
  // sekundengenau bleiben, sonst aendert ein Deployment das Verhalten jeder
  // vorhandenen Playlist, ohne dass jemand etwas angefasst haette.
  assert.equal(fortsetzArt({ fortsetzen: true }), 'sekunde');
  assert.equal(fortsetzArt({ fortsetzen: 'sekunde' }), 'sekunde');
  assert.equal(fortsetzArt({ fortsetzen: 'titel' }), 'titel');
  assert.equal(fortsetzArt({ fortsetzen: false }), 'aus');
  assert.equal(fortsetzArt({}), 'aus', 'fehlendes Feld: die Vorgabe');
  assert.equal(fortsetzArt(null), 'aus', 'neue Playlist');
  assert.equal(fortsetzArt({ fortsetzen: 'unsinn' }), 'aus');

  // setztFort ist seither nur noch die Frage, ob ueberhaupt etwas gemerkt wird.
  assert.equal(setztFort({ fortsetzen: 'titel' }), true);
  assert.equal(setztFort({ fortsetzen: true }), true);
  assert.equal(setztFort({}), false);
  assert.equal(setztFort(null), false);
});

test('validierePlaylist nimmt die Gangart an und weist Unsinn ab', () => {
  const zeile = 'https://h.de/1.mp3';
  const wert = (body, bisher) => validierePlaylist({ name: 'A', urls: zeile, ...body }, bisher).playlist?.fortsetzen;

  assert.equal(wert({}), false, 'neue Playlist setzt nicht fort');
  assert.equal(wert({ fortsetzen: 'titel' }), 'titel');
  assert.equal(wert({ fortsetzen: 'sekunde' }), 'sekunde');
  assert.equal(wert({ fortsetzen: 'aus' }), false);
  assert.equal(wert({ fortsetzen: false }), false);
  // Ein aelteres Dashboard oder ein Skript kennt nur den Schalter.
  assert.equal(wert({ fortsetzen: true }), 'sekunde');

  // Weggelassen: der gespeicherte Wert bleibt stehen - eine Titelkorrektur
  // darf ein Album nicht nebenbei zum Hoerbuch machen.
  assert.equal(wert({}, { fortsetzen: 'titel' }), 'titel');
  assert.equal(wert({}, { fortsetzen: true }), 'sekunde', 'und wird dabei normalisiert');
  assert.equal(wert({ fortsetzen: 'aus' }, { fortsetzen: 'titel' }), false);

  // Ein Tippfehler faellt nicht still auf "aus": Eine Playlist, die sich
  // ploetzlich nichts mehr merkt, sucht man im falschen Eck.
  const kaputt = validierePlaylist({ name: 'A', urls: zeile, fortsetzen: 'titelgenau' });
  assert.match(kaputt.fehler, /fortsetzen/);
});

test('validierePlaylist: fehlendes Feld nimmt den Bestand, sonst die Vorgabe', () => {
  const zeile = 'https://h.de/1.mp3';
  for (const feld of ['wiederholen', 'ansage']) {
    assert.equal(validierePlaylist({ name: 'A', urls: zeile }).playlist[feld], true, feld);
    assert.equal(validierePlaylist({ name: 'A', urls: zeile, [feld]: false }).playlist[feld], false, feld);
    // Ohne Feld bleibt der gespeicherte Wert stehen - eine Titelkorrektur darf
    // die Einstellung nicht nebenbei umlegen.
    assert.equal(validierePlaylist({ name: 'A', urls: zeile }, { [feld]: false }).playlist[feld], false, feld);
    assert.equal(validierePlaylist({ name: 'A', urls: zeile, [feld]: true }, { [feld]: false }).playlist[feld], true, feld);
  }
  // Die neuen beiden stehen auf aus, weil es das bisherige Verhalten war.
  const frisch = validierePlaylist({ name: 'A', urls: zeile }).playlist;
  assert.equal(frisch.zufall, false);
  assert.equal(frisch.fortsetzen, false);

  // Ein Schalter im Body laesst den anderen in Ruhe.
  const nur = validierePlaylist({ name: 'A', urls: zeile, ansage: false }, { wiederholen: false, ansage: true });
  assert.equal(nur.playlist.ansage, false);
  assert.equal(nur.playlist.wiederholen, false);
});

test('Ohne Ansage startet die Musik ohne ein Wort davor', async () => {
  const r = await skill(intent('PlayPlaylistIntent', 'leise'), {}, [STILL]);
  assert.equal(r.outputSpeech, undefined, 'keine Sprachausgabe');
  // Die Sitzung endet trotzdem, sonst horcht der Echo nach dem stillen Start
  // weiter. Neben einer Play-Direktive ist `true` erlaubt, nur `false` nicht.
  assert.equal(r.shouldEndSession, true, 'die Sitzung endet auch ohne Ansage');
  assert.deepEqual(r.directives.map(d => d.type), ['AudioPlayer.ClearQueue', 'AudioPlayer.Play']);
  assert.equal(spielt(r).playBehavior, 'REPLACE_ALL');
  assert.equal(spielt(r).audioItem.stream.token, 'Leise|0|0|0');
});

test('Mit Ansage bleibt der Satz vor der Musik', async () => {
  const r = await skill(intent('PlayPlaylistIntent', 'kinderlieder'));
  assert.equal(r.outputSpeech.text, 'Ich spiele Kinderlieder.');
  assert.equal(spielt(r).audioItem.stream.token, 'Kinderlieder|0|0|0');
});

test('Die Ansage schweigt nur vorn - Rueckfragen und Fehler bleiben hoerbar', async () => {
  const unbekannt = await skill(intent('PlayPlaylistIntent', 'Jazz'), {}, [STILL]);
  assert.match(unbekannt.outputSpeech.text, /keine Playlist namens Jazz/);

  const leer = await skill(intent('PlayPlaylistIntent', 'leer'), {}, [{ name: 'Leer', ansage: false, titel: [] }]);
  assert.match(leer.outputSpeech.text, /noch keine Titel/);
});

test('Ohne Wiederholung wird hinter dem letzten Titel nichts angehaengt', async () => {
  const r = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Einmal|2|0|0' }, { token: 'Einmal|2|0|0' }, [EINMAL]);
  // Kein Stop: Der letzte Titel laeuft noch und soll zu Ende spielen.
  assert.deepEqual(r, {});
});

test('Ohne Wiederholung laeuft die Playlist bis dahin normal weiter', async () => {
  const r = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Einmal|0|0|0' }, { token: 'Einmal|0|0|0' }, [EINMAL]);
  assert.equal(spielt(r).audioItem.stream.token, 'Einmal|1|0|0');
});

test('Ohne Wiederholung stoppt naechster Titel am Ende und bleibt am Anfang stehen', async () => {
  const ende = await skill(intent('AMAZON.NextIntent'), { token: 'Einmal|2|0|0' }, [EINMAL]);
  assert.deepEqual(ende.directives, [{ type: 'AudioPlayer.Stop' }]);

  const anfang = await skill(intent('AMAZON.PreviousIntent'), { token: 'Einmal|0|0|0' }, [EINMAL]);
  // Stelle 1 von 3 noch einmal - und mit einer hochgezaehlten Runde, weil ein
  // Token, den das Geraet schon traegt, keinen neuen Strom anwirft.
  assert.equal(spielt(anfang).audioItem.stream.token, 'Einmal|0|1|0');
});

// --- Das Mikrofon nach dem Befehl -------------------------------------------

test('Jeder Sprachbefehl schliesst die Sitzung - wenn es eine gibt', async () => {
  // **Warum das eine eigene Zeile braucht.** Ein fehlendes `shouldEndSession`
  // heisst fuer Alexa nicht "beenden", sondern "lass es, wie es ist" - und
  // nach dem zweistufigen Aufruf ("oeffne meine Plattenkiste" … "spiele
  // Kinderlieder") steht es offen. Die Antworten hier tragen keine Sprache und
  // sahen deshalb harmlos aus; in Wahrheit horchte der Echo nach jedem
  // erledigten Befehl noch einmal.
  //
  // **Der Nachsatz im Namen ist die Korrektur.** Hier stand die Regel ohne
  // ihre Grenze, und der Helfer schickte nie eine Sitzung mit - deshalb sah
  // niemand, dass dieselben Befehle auch ohne eine ankommen. Was dann gilt,
  // steht im Block darunter.
  const befehle = [
    'AMAZON.PauseIntent',
    'AMAZON.StopIntent',
    'AMAZON.CancelIntent',
    'AMAZON.ResumeIntent',
    'AMAZON.NextIntent',
    'AMAZON.PreviousIntent',
    'AMAZON.StartOverIntent',
    'AMAZON.ShuffleOnIntent',
    'AMAZON.ShuffleOffIntent',
  ];
  for (const name of befehle) {
    const r = await skill(intent(name), { token: 'Kinderlieder|1|0|0', offset: 5000 });
    assert.equal(r.shouldEndSession, true, name);
  }
});

test('Auch ohne laufenden Stream bleibt das Mikrofon nach dem Befehl nicht offen', async () => {
  // Der Zweig, in dem der Skill nichts zu tun findet, ist derselbe Fall fuer
  // den Hoerenden: Der Befehl ist erledigt, es kommt keine Frage mehr.
  for (const name of ['AMAZON.NextIntent', 'AMAZON.PreviousIntent', 'AMAZON.StartOverIntent']) {
    const r = await skill(intent(name));
    assert.deepEqual(r, { shouldEndSession: true }, name);
  }
});

test('Knoepfe und AudioPlayer-Ereignisse tragen kein shouldEndSession', async () => {
  // Die Gegenprobe: Dort gibt es keine Sitzung zu beenden, und das Feld haette
  // in der Antwort nichts verloren. Dieselben Helfer beantworten beides - ohne
  // diesen Test faellt das Feld beim naechsten Umbau ueberall hinein.
  const ereignisse = [
    { type: 'PlaybackController.NextCommandIssued' },
    { type: 'PlaybackController.PreviousCommandIssued' },
    { type: 'PlaybackController.PlayCommandIssued' },
    { type: 'PlaybackController.PauseCommandIssued' },
    { type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Kinderlieder|1|0|0' },
    { type: 'AudioPlayer.PlaybackStarted', token: 'Kinderlieder|1|0|0' },
    { type: 'AudioPlayer.PlaybackStopped', token: 'Kinderlieder|1|0|0' },
  ];
  for (const request of ereignisse) {
    const r = await skill(request, { token: 'Kinderlieder|1|0|0', offset: 5000 });
    assert.equal(r.shouldEndSession, undefined, request.type);
  }
});

// --- Und ohne Sitzung gibt es nichts zu schliessen ---------------------------
//
// **Gemeldet:** Auf "Alexa aus", "Alexa Stopp" und "Alexa Pause" antwortete
// Alexa mit "Der angeforderte Skill hat keine gueltige Antwort uebermittelt".
// Genau diese drei sagt man, waehrend Musik laeuft - also ohne offenen Dialog,
// und damit ohne `session` in der Anfrage. Die Antwort trug trotzdem
// `shouldEndSession` (bei Stopp/Pause/Abbrechen sogar hart verdrahtet), und
// das macht sie ungueltig: Alexa verwarf sie ganz, der Befehl verpuffte.

test('Ein Stopp ohne Sitzung traegt kein shouldEndSession', async () => {
  const r = await skill(intent('AMAZON.StopIntent'), { token: 'Kinderlieder|1|0|0', offset: 5000, ohneSitzung: true });
  assert.deepEqual(r.directives, [{ type: 'AudioPlayer.Stop' }], 'die Direktive bleibt, was sie war');
  assert.equal('shouldEndSession' in r, false, 'aber das Feld hat dort nichts verloren');
});

test('Pause und Abbrechen ohne Sitzung genauso', async () => {
  for (const name of ['AMAZON.PauseIntent', 'AMAZON.CancelIntent']) {
    const r = await skill(intent(name), { token: 'Kinderlieder|1|0|0', offset: 5000, ohneSitzung: true });
    assert.deepEqual(r.directives, [{ type: 'AudioPlayer.Stop' }], name);
    assert.equal('shouldEndSession' in r, false, name);
  }
});

test('Auch "weiter" und die Titelsprünge tragen ohne Sitzung keines', async () => {
  // Dieselbe Luecke, nur faellt sie dort seltener auf: Auch diese Befehle
  // kommen ohne Dialog an. Die Reparatur sitzt deshalb in `ausSprache` und
  // nicht in drei Zweigen.
  for (const name of ['AMAZON.ResumeIntent', 'AMAZON.NextIntent', 'AMAZON.PreviousIntent', 'AMAZON.StartOverIntent']) {
    const r = await skill(intent(name), { token: 'Kinderlieder|1|0|0', offset: 30000, ohneSitzung: true });
    assert.equal('shouldEndSession' in r, false, name);
    assert.ok(r.directives?.length, `${name}: die Direktive geht trotzdem hinaus`);
  }
});

test('Ohne Sitzung wird nicht gesprochen', async () => {
  // Sprache und Reprompt sind dort genauso verboten. Der Satz ginge nicht nur
  // verloren, er riss die ganze Antwort mit - also geht er ins Log, und die
  // Antwort bleibt still und gueltig.
  for (const name of ['AMAZON.RepeatIntent', 'AMAZON.LoopOnIntent', 'AMAZON.ShuffleOnIntent']) {
    const r = await skill(intent(name), { ohneSitzung: true });
    assert.equal(r.outputSpeech, undefined, name);
    assert.equal(r.reprompt, undefined, name);
    assert.equal('shouldEndSession' in r, false, name);
  }
});

test('Ohne Sitzung spielt "spiele ..." trotzdem', async () => {
  // Der Nebengewinn: Die Ansage faellt weg, die Musik nicht. Vorher waere die
  // ganze Antwort an ihrem eigenen Ansagesatz gescheitert.
  const r = await skill(sucheIntent('Kinderlieder'), { ohneSitzung: true });
  assert.equal(spielt(r).audioItem.stream.token, 'Kinderlieder|0|0|0');
  assert.equal(r.outputSpeech, undefined, 'die Ansage bleibt stumm');
  assert.equal('shouldEndSession' in r, false);
  assert.ok(!r.directives.some(d => String(d.type).startsWith('Dialog.')), 'und die dynamischen Werte bleiben draussen');
});

test('Mit Sitzung bleibt alles, wie es war', async () => {
  // Die Gegenprobe, damit die Reparatur nicht die Zusage von oben aushebelt.
  const stopp = await skill(intent('AMAZON.StopIntent'), { token: 'Kinderlieder|1|0|0', offset: 5000 });
  assert.equal(stopp.shouldEndSession, true);
  const ansage = await skill(sucheIntent('Kinderlieder'));
  assert.match(ansage.outputSpeech.text, /Ich spiele Kinderlieder/);
});

test('Keine einzige Antwort ohne Sitzung traegt ein verbotenes Feld', async () => {
  // **Die Probe, die den Fehler von Anfang an gefunden haette.** Sie fragt
  // nicht einzelne Zweige ab, sondern alle Intents auf einmal: Ohne Sitzung
  // darf keine Antwort Sprache, Reprompt oder shouldEndSession tragen - und
  // mit Sitzung muss sie sie schliessen.
  const alle = [
    'PlayPlaylistIntent', 'ListPlaylistsIntent', 'AMAZON.PauseIntent', 'AMAZON.StopIntent',
    'AMAZON.CancelIntent', 'AMAZON.ResumeIntent', 'AMAZON.NextIntent', 'AMAZON.PreviousIntent',
    'AMAZON.StartOverIntent', 'AMAZON.LoopOnIntent', 'AMAZON.LoopOffIntent', 'AMAZON.RepeatIntent',
    'AMAZON.ShuffleOnIntent', 'AMAZON.ShuffleOffIntent', 'AMAZON.HelpIntent',
    'AMAZON.NavigateHomeIntent', 'AMAZON.FallbackIntent',
  ];
  for (const name of alle) {
    const ohne = await skill(intent(name), { token: 'Kinderlieder|1|0|0', offset: 5000, ohneSitzung: true });
    assert.equal(ohne.outputSpeech, undefined, `${name}: keine Sprache ohne Sitzung`);
    assert.equal(ohne.reprompt, undefined, `${name}: kein Reprompt ohne Sitzung`);
    assert.equal('shouldEndSession' in ohne, false, `${name}: kein shouldEndSession ohne Sitzung`);

    const mit = await skill(intent(name), { token: 'Kinderlieder|1|0|0', offset: 5000 });
    assert.equal(typeof mit.shouldEndSession, 'boolean', `${name}: mit Sitzung wird sie entschieden`);
  }
});

test('Rueckfragen halten die Sitzung offen - sonst waere niemand da, der antwortet', async () => {
  // Die Grenze des Ganzen: Wo der Skill fragt, muss das Mikrofon aufbleiben,
  // und dazu gehoert ein reprompt. Ein pauschales "immer beenden" waere die
  // naheliegende Vereinfachung und nimmt genau diesen Fall mit.
  for (const r of [
    await skill({ type: 'LaunchRequest' }),
    await skill(intent('PlayPlaylistIntent')),
    await skill(intent('AMAZON.ResumeIntent')),
    await skill(intent('AMAZON.HelpIntent')),
  ]) {
    assert.equal(r.shouldEndSession, false);
    assert.ok(r.reprompt.outputSpeech.text);
  }
});

test('Loop-Befehle geben Auskunft, statt etwas zu behaupten oder umzuschalten', async () => {
  const aus = await skill(intent('AMAZON.LoopOffIntent'), { token: 'Einmal|0|0|0' }, [EINMAL]);
  assert.match(aus.outputSpeech.text, /Einmal wiederholt sich nicht.*Dashboard/);

  const an = await skill(intent('AMAZON.LoopOnIntent'), { token: 'Kinderlieder|0|0|0' });
  assert.match(an.outputSpeech.text, /Kinderlieder wiederholt sich\./);

  const ohne = await skill(intent('AMAZON.RepeatIntent'));
  assert.match(ohne.outputSpeech.text, /Dashboard/);
});

// --- Weiterhoeren -----------------------------------------------------------------

test('Der Stand wird gemerkt, wenn die Wiedergabe stoppt', async () => {
  const redis = mitStand(HOERSPIEL);
  await skill({ type: 'AudioPlayer.PlaybackStopped', token: 'Hörspiel|1|0|0', offsetInMilliseconds: 42000 }, {}, null, redis);
  assert.deepEqual(
    { ...redis.speicher.musik_stand['hörspiel'], zeit: undefined },
    { position: 1, runde: 0, seed: 0, offset: 42000, zeit: undefined },
  );
});

test('Ohne den Schalter wird nichts gemerkt', async () => {
  const redis = mitStand(KINDER);
  await skill({ type: 'AudioPlayer.PlaybackStopped', token: 'Kinderlieder|1|0|0', offsetInMilliseconds: 42000 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand, undefined);
});

test('Der naechste Start setzt an der gemerkten Stelle fort, mit Offset und Ansage', async () => {
  const redis = mitStand(HOERSPIEL, { position: 2, runde: 0, seed: 0, offset: 65000 });
  const r = await skill(sucheIntent('hörspiel'), {}, null, redis);
  assert.equal(r.outputSpeech.text, 'Ich spiele Hörspiel weiter.');
  assert.equal(spielt(r).audioItem.stream.token, 'Hörspiel|2|0|0');
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 60000, 'fuenf Sekunden Vorlauf');
});

test('Am Anfang stehengeblieben heisst nicht "weiter"', async () => {
  const redis = mitStand(HOERSPIEL, { position: 0, runde: 0, seed: 0, offset: 0 });
  const r = await skill(sucheIntent('hörspiel'), {}, null, redis);
  assert.equal(r.outputSpeech.text, 'Ich spiele Hörspiel.');
});

test('Ein Stand jenseits der gekuerzten Playlist faellt auf den Anfang', async () => {
  const redis = mitStand(HOERSPIEL, { position: 9, runde: 0, seed: 0, offset: 1000 });
  const r = await skill(sucheIntent('hörspiel'), {}, null, redis);
  assert.equal(spielt(r).audioItem.stream.token, 'Hörspiel|0|0|0');
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 0);
});

test('Beim Fortsetzen gilt der gemerkte Seed weiter', async () => {
  // Nur mit demselben Seed steht an dieser Stelle wieder derselbe Titel.
  const redis = mitStand({ ...HOERSPIEL, zufall: true }, { position: 1, runde: 0, seed: 2024, offset: 0 });
  const r = await skill(sucheIntent('hörspiel'), {}, null, redis);
  assert.equal(spielt(r).audioItem.stream.token, 'Hörspiel|1|0|2024');
  assert.equal(spielt(r).audioItem.stream.url, KINDER.titel[reihenfolge(3, 2024)[1]].url);
});

test('"Von vorn" vergisst den Stand', async () => {
  const redis = mitStand(HOERSPIEL, { position: 2, runde: 0, seed: 0, offset: 5000 });
  await skill(intent('AMAZON.StartOverIntent'), { token: 'Hörspiel|2|0|0' }, null, redis);
  assert.deepEqual(redis.speicher.musik_stand, {});
});

test('Durchgelaufen vergisst den Stand, sonst begaenne der naechste Start am Ende', async () => {
  const redis = mitStand(HOERSPIEL, { position: 2, runde: 0, seed: 0, offset: 5000 });
  const r = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Hörspiel|2|0|0' }, {}, null, redis);
  assert.deepEqual(r, {}, 'ohne Wiederholung wird nichts angehaengt');
  assert.equal(redis.speicher.musik_stand['hörspiel'].fertig, undefined, 'der letzte Titel laeuft ja noch');

  await skill({ type: 'AudioPlayer.PlaybackFinished', token: 'Hörspiel|2|0|0' }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['hörspiel'].fertig, true);

  const neu = await skill(sucheIntent('hörspiel'), {}, null, redis);
  assert.equal(neu.outputSpeech.text, 'Ich spiele Hörspiel.');
  assert.equal(spielt(neu).audioItem.stream.token, 'Hörspiel|0|0|0');
  assert.equal(spielt(neu).audioItem.stream.offsetInMilliseconds, 0);
});

// Wer waehrend des letzten Titels stoppt, ist nicht durchgelaufen: Der Stand
// gehoert auf diesen Titel, nicht auf den Anfang der Playlist.
test('Ein Stopp im letzten Titel merkt sich den letzten Titel', async () => {
  const redis = mitStand(HOERSPIEL, { position: 2, runde: 0, seed: 0, offset: 0 });
  await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Hörspiel|2|0|0' }, {}, null, redis);
  await skill({ type: 'AudioPlayer.PlaybackStopped', token: 'Hörspiel|2|0|0', offsetInMilliseconds: 40000 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['hörspiel'].fertig, undefined);
  assert.equal(redis.speicher.musik_stand['hörspiel'].position, 2);
  assert.equal(redis.speicher.musik_stand['hörspiel'].offset, 40000);
});

// Der Vermerk statt des Loeschens ist der Grund, warum dieser Test existiert:
// Ein Stopp aus den letzten Sekunden kann dem PlaybackFinished hinterherlaufen
// und legte die Stelle am Ende der Playlist wieder an.
test('Ein Stopp nach dem Durchlauf legt keine Stelle am Ende mehr an', async () => {
  const redis = mitStand(HOERSPIEL, { position: 2, runde: 0, seed: 0, offset: 5000 });
  await skill({ type: 'AudioPlayer.PlaybackFinished', token: 'Hörspiel|2|0|0' }, {}, null, redis);
  await skill({ type: 'AudioPlayer.PlaybackStopped', token: 'Hörspiel|2|0|0', offsetInMilliseconds: 178000 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['hörspiel'].fertig, true);
  assert.equal(redis.speicher.musik_stand['hörspiel'].position, 0);
});

// Eine Playlist, die weiterhoert UND sich wiederholt - fuer die Frage, was das
// Anhaengen des naechsten Titels mit dem gemerkten Stand macht.
const ENDLOS = { name: 'Endlos', fortsetzen: true, wiederholen: true, titel: KINDER.titel };

test('einstieg geht den Vorlauf zurueck, aber nie unter null', () => {
  assert.equal(einstieg(30000), 25000);
  assert.equal(einstieg(5000), 0);
  assert.equal(einstieg(3000), 0, 'eine Stelle, die noch keine ist, ist keine wert');
  assert.equal(einstieg(0), 0);
  assert.equal(einstieg(undefined), 0);
  assert.equal(einstieg(-1), 0, 'Unsinn aus der Datenbank faengt eben von vorn an');
});

test('Nach dreissig Sekunden gestoppt heisst beim naechsten Mal ab fuenfundzwanzig', async () => {
  const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 30000 });
  const r = await skill(sucheIntent('hörspiel'), {}, null, redis);
  assert.equal(r.outputSpeech.text, 'Ich spiele Hörspiel weiter.');
  assert.equal(spielt(r).audioItem.stream.token, 'Hörspiel|1|0|0');
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 25000);
});

test('Ein Stand kurz nach dem Titelanfang ist keiner', async () => {
  // Drei Sekunden minus Vorlauf sind null - und bei null am ersten Titel
  // waere "weiter" eine Uebertreibung.
  const redis = mitStand(HOERSPIEL, { position: 0, runde: 0, seed: 0, offset: 3000 });
  const r = await skill(sucheIntent('hörspiel'), {}, null, redis);
  assert.equal(r.outputSpeech.text, 'Ich spiele Hörspiel.');
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 0);
});

test('MUSIK_VORLAUF_MS bestimmt den Vorlauf', async () => {
  const vorher = process.env.MUSIK_VORLAUF_MS;
  process.env.MUSIK_VORLAUF_MS = '0';
  try {
    const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 30000 });
    const r = await skill(sucheIntent('hörspiel'), {}, null, redis);
    assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 30000);
  } finally {
    if (vorher === undefined) delete process.env.MUSIK_VORLAUF_MS;
    else process.env.MUSIK_VORLAUF_MS = vorher;
  }
});

test('Das Anhaengen des naechsten Titels laesst den Stand, wo er ist', async () => {
  // Der Echo fragt den naechsten Titel an, sobald seine Warteschlange Platz
  // hat - oft Sekunden nach dem Titelanfang. Der laufende Titel ist also
  // laengst nicht vorbei, und der Stand gehoert noch auf ihn.
  const redis = mitStand(ENDLOS, { position: 0, runde: 0, seed: 0, offset: 12000 });
  const r = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Endlos|0|0|0' }, {}, null, redis);
  assert.equal(spielt(r).playBehavior, 'ENQUEUE');
  assert.equal(spielt(r).audioItem.stream.token, 'Endlos|1|0|0');
  assert.deepEqual(
    { ...redis.speicher.musik_stand['endlos'], zeit: undefined },
    { position: 0, runde: 0, seed: 0, offset: 12000, zeit: undefined },
  );
});

test('Ein Stopp nach dem Anhaengen merkt sich den Titel, der laeuft', async () => {
  // Der Fehler, der diesen Test hervorgebracht hat: Das Anhaengen schob den
  // Stand auf den naechsten Titel vor, der Stopp mitten im Stueck fiel damit
  // in die Sperre gegen zurueckspringende Staende - und "weiter" begann beim
  // naechsten Lied statt bei dem, das gerade lief.
  const redis = mitStand(ENDLOS, { position: 0, runde: 0, seed: 0, offset: 0 });
  await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Endlos|0|0|0' }, {}, null, redis);
  await skill({ type: 'AudioPlayer.PlaybackStopped', token: 'Endlos|0|0|0', offsetInMilliseconds: 42000 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['endlos'].position, 0);
  assert.equal(redis.speicher.musik_stand['endlos'].offset, 42000);
});

test('Der Titelwechsel traegt den neuen Titel ein, nicht der Endspurt', async () => {
  // Die Gegenprobe: Ist der Titel wirklich durch, meldet der Echo Finished und
  // gleich darauf den Anfang des angehaengten Titels. Der Stand folgt dem
  // Anfang - mit dem Token, der wirklich laeuft.
  const redis = mitStand(ENDLOS, { position: 0, runde: 0, seed: 0, offset: 42000 });
  await skill({ type: 'AudioPlayer.PlaybackFinished', token: 'Endlos|0|0|0', offsetInMilliseconds: 178000 }, {}, null, redis);
  await skill({ type: 'AudioPlayer.PlaybackStarted', token: 'Endlos|1|0|0', offsetInMilliseconds: 0 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['endlos'].position, 1);
  assert.equal(redis.speicher.musik_stand['endlos'].offset, 0);
});

test('Ein Stopp am selben Titel schreibt den genauen Offset weiter', async () => {
  const redis = mitStand(ENDLOS, { position: 1, runde: 0, seed: 0, offset: 0 });
  await skill({ type: 'AudioPlayer.PlaybackStopped', token: 'Endlos|1|0|0', offsetInMilliseconds: 42000 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['endlos'].offset, 42000);
});

test('PlaybackStarted setzt den Stand auch zurueck - der Titel laeuft ja', async () => {
  // Die Gegenprobe zum Endspurt: Ein Titelanfang ist die verlaesslichste
  // Auskunft, die es gibt, und ueberschreibt deshalb auch einen Stand, der
  // weiter vorn stand. Nur die Stelle *desselben* Titels dreht er nicht mit
  // einer Null zurueck - siehe `standNichtZurueck`; hier ist es ein anderer.
  const redis = mitStand(ENDLOS, { position: 2, runde: 0, seed: 0, offset: 90000 });
  await skill({ type: 'AudioPlayer.PlaybackStarted', token: 'Endlos|0|1|0', offsetInMilliseconds: 0 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['endlos'].position, 0);
  assert.equal(redis.speicher.musik_stand['endlos'].runde, 1);
});

test('"Weiter" ohne laufenden Stream nimmt die zuletzt gestoppte Playlist auf', async () => {
  // Lief zwischendurch etwas anderes, ist context.AudioPlayer leer - die
  // Stelle steht aber in der Datenbank, und genau dort sagt jemand "weiter".
  const redis = mitStand(HOERSPIEL, { position: 2, runde: 0, seed: 0, offset: 65000, zeit: 1000 });
  const r = await skill(intent('AMAZON.ResumeIntent'), {}, null, redis);
  assert.equal(spielt(r).audioItem.stream.token, 'Hörspiel|2|0|0');
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 60000);
  assert.equal(r.outputSpeech, undefined, '"weiter" kommt auch vom Knopf in der App');
});

test('"Weiter" nimmt die juengste von mehreren gemerkten Playlists auf', async () => {
  const zweite = { name: 'Zweites', fortsetzen: true, titel: KINDER.titel };
  const redis = redisMit({
    [REDIS_KEY]: [HOERSPIEL, zweite],
    musik_stand: {
      'hörspiel': { position: 1, runde: 0, seed: 0, offset: 20000, zeit: 1000 },
      zweites: { position: 2, runde: 0, seed: 0, offset: 40000, zeit: 2000 },
    },
  });
  const r = await skill(intent('AMAZON.ResumeIntent'), {}, null, redis);
  assert.equal(spielt(r).audioItem.stream.token, 'Zweites|2|0|0');
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 35000);
});

test('"Weiter" greift nicht auf Playlists ohne den Schalter zurueck', async () => {
  const redis = redisMit({
    [REDIS_KEY]: [KINDER],
    musik_stand: { kinderlieder: { position: 1, runde: 0, seed: 0, offset: 20000, zeit: 1000 } },
  });
  const r = await skill(intent('AMAZON.ResumeIntent'), {}, null, redis);
  assert.match(r.outputSpeech.text, /Es laeuft gerade nichts/);
});

test('Ein durchgelaufener Vermerk ist fuer "weiter" kein Stand', async () => {
  const redis = mitStand(HOERSPIEL, { position: 0, runde: 0, seed: 0, offset: 0, fertig: true, zeit: 1000 });
  const r = await skill(intent('AMAZON.ResumeIntent'), {}, null, redis);
  assert.equal(spielt(r).audioItem.stream.token, 'Hörspiel|0|0|0', 'von vorn statt gar nicht');
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 0);
});

// Ein Album: setzt fort, aber titelgenau. Drei Titel wie ueberall hier.
const ALBUM = { name: 'Album', fortsetzen: 'titel', wiederholen: false, titel: KINDER.titel };

test('Album: der gemerkte Titel faengt wieder von vorn an', async () => {
  // Wer bei Lied drei nach siebenundvierzig Sekunden aufhoert, will Lied drei
  // ganz hoeren - nicht seine zweite Haelfte.
  const redis = mitStand(ALBUM, { position: 2, runde: 0, seed: 0, offset: 47000 });
  const r = await skill(sucheIntent('album'), {}, null, redis);
  assert.equal(r.outputSpeech.text, 'Ich spiele Album weiter.');
  assert.equal(spielt(r).audioItem.stream.token, 'Album|2|0|0');
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 0);
});

test('Album: gestoppt wird das Lied, das laeuft - nicht das angehaengte', async () => {
  // Der gemeldete Fehler, vom Titelanfang bis zum naechsten Start: Lied zwei
  // laeuft, der Echo hat sich laengst Lied drei anhaengen lassen, und mitten
  // im Stueck faellt "Alexa, stopp". Wer danach die Playlist startet, soll
  // Lied zwei hoeren - von vorn, wie die Einstellung es zusagt.
  const redis = mitStand(ALBUM);
  await skill({ type: 'AudioPlayer.PlaybackStarted', token: 'Album|1|0|0', offsetInMilliseconds: 0 }, {}, null, redis);
  await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Album|1|0|0' }, {}, null, redis);
  await skill({ type: 'AudioPlayer.PlaybackStopped', token: 'Album|1|0|0', offsetInMilliseconds: 47000 }, {}, null, redis);

  const r = await skill(sucheIntent('album'), {}, null, redis);
  assert.equal(spielt(r).audioItem.stream.token, 'Album|1|0|0', 'dasselbe Lied, nicht das naechste');
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 0, 'und von vorn');
});

test('Hoerbuch: derselbe Stand fuehrt auf die Sekunde', async () => {
  // Die Gegenprobe zum Album - derselbe Stand, nur die Gangart ist anders.
  const redis = mitStand({ ...ALBUM, name: 'Hoerbuch', fortsetzen: 'sekunde' }, { position: 2, runde: 0, seed: 0, offset: 47000 });
  const r = await skill(sucheIntent('hoerbuch'), {}, null, redis);
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 42000);
});

test('Album am ersten Titel heisst nicht "weiter"', async () => {
  const redis = mitStand(ALBUM, { position: 0, runde: 0, seed: 0, offset: 47000 });
  const r = await skill(sucheIntent('album'), {}, null, redis);
  assert.equal(r.outputSpeech.text, 'Ich spiele Album.');
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 0);
});

test('Album merkt sich die Sekunde trotzdem', async () => {
  // Sie kostet nichts, und wer spaeter auf Hoerbuch umstellt, findet sie dann
  // vor, statt erst beim naechsten Stopp wieder eine zu bekommen.
  const redis = mitStand(ALBUM, { position: 1, runde: 0, seed: 0, offset: 0 });
  await skill({ type: 'AudioPlayer.PlaybackStopped', token: 'Album|1|0|0', offsetInMilliseconds: 47000 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['album'].offset, 47000);
});

test('Album: eine Pause fuehrt trotzdem an derselben Stelle weiter', async () => {
  // Die Gangart gilt dem spaeteren Wiederaufnehmen. Wer auf Pause drueckt,
  // will nicht das halbe Lied noch einmal.
  const redis = mitStand(ALBUM);
  const r = await skill(intent('AMAZON.ResumeIntent'), { token: 'Album|1|0|0', offset: 47000 }, null, redis);
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 42000);
});

test('Album: "weiter" ohne laufenden Stream nimmt den Titelanfang', async () => {
  // Der Rueckfall auf den gemerkten Stand ist das spaetere Wiederaufnehmen -
  // dort gilt die Gangart wieder.
  const redis = mitStand(ALBUM, { position: 2, runde: 0, seed: 0, offset: 47000, zeit: 1000 });
  const r = await skill(intent('AMAZON.ResumeIntent'), {}, null, redis);
  assert.equal(spielt(r).audioItem.stream.token, 'Album|2|0|0');
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 0);
});

// --- Sekundengenau fortsetzen: die zwei Quellen ------------------------------
//
// **Der gemeldete Fehler.** Eine Playlist auf *Hoerbuch* fing nach
// "Alexa, Stopp" ... "Alexa, weiter" immer am Anfang des zuletzt gespielten
// Titels an: Die Nummer stimmte, die Sekunde war weg. Im Dashboard stand
//
//   15:11:30  ECHO  PlaybackStarted  @0s  [keine Direktive]  8. Das doppelte …
//
// und mehr gab der Verlauf nicht her - der Befehl selbst hinterliess keine
// Zeile. Drei Ursachen mit demselben Bild, alle hier festgenagelt: das Geraet
// trug den Token ohne die Stelle, `weiter` fragte die Datenbank nicht, und der
// Titelanfang deckte die gemerkte Sekunde mit einer Null zu.

test('"Weiter" nimmt die gemerkte Sekunde, wenn das Geraet nur noch den Titel weiss', async () => {
  // Genau der Bericht: derselbe Token, aber keine Stelle mehr darin - nach
  // einem Neustart, nach dem Radio dazwischen, am naechsten Tag.
  const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 600000 });
  const r = await skill(intent('AMAZON.ResumeIntent'), { token: 'Hörspiel|1|0|0', offset: 0, aktivitaet: 'STOPPED' }, null, redis);
  assert.equal(spielt(r).audioItem.stream.token, 'Hörspiel|1|1|0', 'derselbe Titel, eine Runde weiter');
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 595000);
});

test('"Weiter" nimmt die gemerkte Sekunde auch ohne jede Offset-Angabe', async () => {
  // Dasselbe, nur meldet das Geraet das Feld gar nicht. `|| 0` machte daraus
  // stillschweigend einen Titelanfang.
  const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 600000 });
  const r = await skill(intent('AMAZON.ResumeIntent'), { token: 'Hörspiel|1|0|0', ohneOffset: true, aktivitaet: 'FINISHED' }, null, redis);
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 595000);
});

test('"Weiter" traut dem Geraet, wenn es die groessere Stelle kennt', async () => {
  // Die Gegenprobe, ohne die aus der Reparatur eine neue Stoerung wird: Eine
  // alte Marke darf eine echte Pause nicht ueberstimmen.
  const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 20000 });
  const r = await skill(intent('AMAZON.ResumeIntent'), { token: 'Hörspiel|1|0|0', offset: 90000 }, null, redis);
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 85000);
});

test('"Weiter" nimmt keine Stelle aus einem fremden Titel', async () => {
  // Sonst finge Titel zwei bei der Stelle von Titel drei an.
  const redis = mitStand(HOERSPIEL, { position: 2, runde: 0, seed: 0, offset: 600000 });
  const r = await skill(intent('AMAZON.ResumeIntent'), { token: 'Hörspiel|1|0|0', offset: 0 }, null, redis);
  assert.equal(spielt(r).audioItem.stream.token, 'Hörspiel|1|1|0', 'derselbe Titel, eine Runde weiter');
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 0);
});

test('Ein durchgelaufener Stand gibt "weiter" keine Stelle mehr', async () => {
  const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 600000, fertig: true });
  const r = await skill(intent('AMAZON.ResumeIntent'), { token: 'Hörspiel|1|0|0', offset: 0 }, null, redis);
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 0);
});

test('"Weiter" gibt einer gekuerzten Playlist keinen alten Offset mit', async () => {
  // Die Position faellt auf den Anfang zurueck - dann ist es ein anderer
  // Titel, und die Stelle des alten hat dort nichts zu suchen.
  const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 600000 });
  const r = await skill(intent('AMAZON.ResumeIntent'), { token: 'Hörspiel|9|0|0', offset: 600000 }, null, redis);
  assert.equal(spielt(r).audioItem.stream.token, 'Hörspiel|0|0|0');
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 0);
});

test('Album: nur das Geraet darf "weiter" sekundengenau machen', async () => {
  // Die Zusage der Gangart in Testform: Eine Pause ist ueberall
  // sekundengenau, ein spaeteres Wiederaufnehmen bei Album nicht.
  const stand = { position: 1, runde: 0, seed: 0, offset: 47000 };
  const pause = await skill(intent('AMAZON.ResumeIntent'), { token: 'Album|1|0|0', offset: 47000 }, null, mitStand(ALBUM, stand));
  assert.equal(spielt(pause).audioItem.stream.offsetInMilliseconds, 42000, 'die Pause zaehlt');

  const spaeter = await skill(intent('AMAZON.ResumeIntent'), { token: 'Album|1|0|0', offset: 0, aktivitaet: 'STOPPED' }, null, mitStand(ALBUM, stand));
  assert.equal(spielt(spaeter).audioItem.stream.offsetInMilliseconds, 0, 'die gemerkte Stelle nicht');
});

// --- Der Stand auf Befehl ---------------------------------------------------

test('Stopp merkt die Stelle, auch wenn kein PlaybackStopped kommt', async () => {
  // Gestoppt wird gesprochen, und diese Anfrage traegt die genaue Sekunde.
  // Bisher wurde sie weggeworfen und allein vom Ereignis danach erwartet.
  const redis = mitStand(HOERSPIEL);
  const r = await skill(intent('AMAZON.StopIntent'), { token: 'Hörspiel|1|0|0', offset: 42000 }, null, redis);
  assert.deepEqual(r.directives, [{ type: 'AudioPlayer.Stop' }], 'der Stopp bleibt, was er war');
  assert.equal(r.shouldEndSession, true);
  assert.equal(redis.speicher.musik_stand['hörspiel'].position, 1);
  assert.equal(redis.speicher.musik_stand['hörspiel'].offset, 42000);
});

test('Der Pause-Knopf in der App merkt die Stelle genauso', async () => {
  const redis = mitStand(HOERSPIEL);
  const r = await skill({ type: 'PlaybackController.PauseCommandIssued' }, { token: 'Hörspiel|1|0|0', offset: 42000 }, null, redis);
  assert.equal(r.shouldEndSession, undefined, 'am Knopf gibt es keine Sitzung zu schliessen');
  assert.equal(redis.speicher.musik_stand['hörspiel'].offset, 42000);
});

test('AMAZON.PauseIntent und AMAZON.CancelIntent merken sie auch', async () => {
  for (const name of ['AMAZON.PauseIntent', 'AMAZON.CancelIntent']) {
    const redis = mitStand(HOERSPIEL);
    await skill(intent(name), { token: 'Hörspiel|1|0|0', offset: 42000 }, null, redis);
    assert.equal(redis.speicher.musik_stand['hörspiel'].offset, 42000, name);
  }
});

test('Ein Stopp ohne den Schalter merkt nichts', async () => {
  const redis = redisMit({ [REDIS_KEY]: [KINDER] });
  await skill(intent('AMAZON.StopIntent'), { token: 'Kinderlieder|1|0|0', offset: 42000 }, [KINDER], redis);
  assert.equal(redis.speicher.musik_stand, undefined);
});

test('Ein Stopp ohne laufenden Stream schreibt nichts', async () => {
  const redis = mitStand(HOERSPIEL);
  await skill(intent('AMAZON.StopIntent'), {}, null, redis);
  assert.equal(redis.speicher.musik_stand, undefined);
});

test('Ein Stopp mit altem Token schiebt den Stand nicht zurueck', async () => {
  // Dieselbe Sperre wie beim nachklappenden PlaybackStopped, nur auf dem
  // neuen Weg: Der Stand steht schon beim naechsten Titel.
  const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 5000 });
  await skill(intent('AMAZON.StopIntent'), { token: 'Hörspiel|0|0|0', offset: 42000 }, null, redis);
  assert.equal(redis.speicher.musik_stand['hörspiel'].position, 1);
  assert.equal(redis.speicher.musik_stand['hörspiel'].offset, 5000);
});

test('Der Stand wird gemerkt, auch wenn das Antwortbudget schon aufgebraucht ist', async () => {
  // **Die stille Ursache.** Der Stand stand unter demselben Budget wie die
  // Antwort, und `standSchreiben` kehrt bei abgelaufener Frist ohne Schreiben
  // um. Auf einer kalten Function blieb nach dem Vorlauf der Boden von 1200 ms
  // - und genau dann ging die Stelle verloren, waehrend der letzte
  // Titelanfang mit seiner Null stehenblieb.
  // Gemessen wird mit einer Datenbank, die eine Sekunde fuer die Playlists
  // braucht: Danach ist vom Budget (der Boden, 1200 ms) fast nichts uebrig,
  // und die dreihundert Millisekunden fuer den Stand passen nicht mehr hinein.
  // Ein Abspieler-Ereignis hat nichts zu beantworten und bekommt deshalb
  // `EREIGNIS_FRIST_MS` statt des Restbudgets - es schafft es.
  const staende = {};
  const langsam = {
    async get(key) {
      const wert = key === REDIS_KEY ? [HOERSPIEL] : staende;
      const dauer = key === REDIS_KEY ? 1000 : 300;
      return new Promise((fertig) => { setTimeout(() => fertig(wert), dauer); });
    },
    async set(key, wert) { if (key === 'musik_stand') Object.assign(staende, wert); },
    async lpush() {}, async ltrim() {}, async expire() {},
  };
  await skill({ type: 'AudioPlayer.PlaybackStopped', token: 'Hörspiel|1|0|0', offsetInMilliseconds: 42000 }, {}, null, langsam);
  assert.equal(staende['hörspiel']?.offset, 42000);
});

// --- Der Stand vor der Antwort ----------------------------------------------
//
// **Der erste gemeldete Defekt, und der teurere von beiden.** Der Stand wurde
// im `finally` geschrieben, hinter `res.json()`, mit der Begruendung, dass
// Alexa dort nicht mehr wartet. Das stimmt fuer Alexa und nicht fuer Vercel:
// Mit der Antwort endet die Invocation, die Instanz friert ein, und der Rest
// laeuft erst, wenn sie das naechste Mal drankommt. Im Log:
//
//   18:45:34  PlaybackStopped   (Antwort in 17 ms)
//   18:45:34  AMAZON.PauseIntent (Antwort in 10 ms)
//   18:50:01  GET /api/skill 400 -- und daran haengen, 4 Min 27 Sek spaeter:
//               musik_stand nicht rechtzeitig: nach 2000 ms
//               musik-box Stand: nicht gelesen, nichts geschrieben
//               musik_stand nicht rechtzeitig: nach 2000 ms
//               musik-box Stand: 113130 ms gemerkt (stopp)
//
// Beide Fristen waren waehrend des Einfrierens abgelaufen, ein dritter
// Schreibvorgang lief nie - die Instanz tauchte danach nicht wieder auf.
// Geprueft wird hier deshalb nicht, *dass* geschrieben wird, sondern *wann*.

test('Der Stand steht in der Datenbank, bevor die Antwort hinausgeht', async () => {
  const faelle = [
    ['Sprachbefehl', intent('AMAZON.StopIntent'), { token: 'Hörspiel|1|0|0', offset: 600000 }],
    ['Ereignis', { type: 'AudioPlayer.PlaybackStopped', token: 'Hörspiel|1|0|0', offsetInMilliseconds: 600000 }, {}],
  ];
  for (const [was, request, opts] of faelle) {
    const redis = mitStand(HOERSPIEL);
    let beiDerAntwort = null;
    const res = antwortFaenger();
    const echtes = res.json.bind(res);
    // Eine Kopie, kein Verweis: Sonst zeigt die Zusicherung am Ende auf das
    // Objekt, wie es *danach* aussieht, und der Test ginge auch durch, wenn
    // erst das `finally` geschrieben haette.
    res.json = (koerper) => {
      const stand = redis.speicher.musik_stand?.['hörspiel'];
      beiDerAntwort = stand ? { position: stand.position, offset: stand.offset } : null;
      return echtes(koerper);
    };
    await handleSkill(anfrage(request, opts), res, redis);
    assert.deepEqual(beiDerAntwort, { position: 1, offset: 600000 }, was);
  }
});

test('Ein Durchlauf wird vermerkt, bevor die Antwort hinausgeht', async () => {
  const redis = mitStand(HOERSPIEL);
  let beiDerAntwort = null;
  const res = antwortFaenger();
  const echtes = res.json.bind(res);
  res.json = (koerper) => {
    beiDerAntwort = redis.speicher.musik_stand?.['hörspiel']?.fertig ?? null;
    return echtes(koerper);
  };
  // Letzter Titel einer Playlist ohne Wiederholung: Danach ist sie durch.
  await handleSkill(anfrage({ type: 'AudioPlayer.PlaybackFinished', token: 'Hörspiel|2|0|0' }), res, redis);
  assert.equal(beiDerAntwort, true);
});

test('Ein Schreibvorgang, der nicht ankommt, meldet sich als solcher', async () => {
  // **Die Zeile, die gelogen hat.** `standSchreiben` kehrte bei abgelaufener
  // Frist wortlos um, `standMerken` meldete trotzdem "gemerkt" - im
  // Vercel-Log wie im Verlauf des Dashboards. Wer die verlorene Sekunde
  // suchte, las also ausgerechnet dort eine Erfolgsmeldung.
  const redis = redisMitListe({ [REDIS_KEY]: [HOERSPIEL] });
  redis.set = async () => { throw new Error('offline'); };
  await skill({ type: 'AudioPlayer.PlaybackStopped', token: 'Hörspiel|1|0|0', offsetInMilliseconds: 42000 }, {}, null, redis);
  const [eintrag] = redis.liste;
  assert.match(eintrag.stand, /NICHT gespeichert/);
});

// --- Eine Null ist keine Stelle ---------------------------------------------

test('Ein Titelanfang bei null laesst die gemerkte Stelle desselben Titels stehen', async () => {
  // Die Ratsche, die aus einem einmaligen Fehlgriff ein "immer von vorn"
  // gemacht hat: Der misslungene Wiedereinstieg loeschte seinen eigenen Zeugen.
  const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 600000 });
  await skill({ type: 'AudioPlayer.PlaybackStarted', token: 'Hörspiel|1|0|0', offsetInMilliseconds: 0 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['hörspiel'].offset, 600000);
});

test('Ein Titelanfang bei einer Sekunde loescht die gemerkte Stelle auch nicht', async () => {
  // **Der zweite gemeldete Defekt.** In der Datenbank stand `@1093 ms`, und
  // weil das keine Null war, ging es durch und deckte die echte Stelle zu.
  // Die Zahl selbst ist ehrlich: Der Verlauf zeigt eine Kette von Wiedergaben,
  // die nach 8, 11, 21 und 42 Sekunden endeten, bei Titeln von rund einer
  // Stunde. Wer nach einer Sekunde abbricht, steht eben bei einer Sekunde -
  // nur ist das kein Ziel, `einstieg()` macht 0 daraus, und es darf die zehnte
  // Minute nicht loeschen, die vorher dastand.
  const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 600000 });
  await skill({ type: 'AudioPlayer.PlaybackStarted', token: 'Hörspiel|1|0|0', offsetInMilliseconds: 1093 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['hörspiel'].offset, 600000, 'die Stelle steht noch');

  // Und die Probe aufs Exempel: Der naechste Start landet wieder dort.
  const r = await skill(sucheIntent('hörspiel'), {}, null, redis);
  assert.equal(spielt(r).audioItem.stream.offsetInMilliseconds, 595000);
});

test('Ein Titelanfang mitten im Stueck schreibt seine Stelle', async () => {
  // Die Sperre gilt der Null, nicht der Monotonie: Ein gelungener
  // Wiedereinstieg meldet seine Stelle, und die ist die neue Wahrheit -
  // auch wenn sie um den Vorlauf kleiner ist als die gemerkte.
  const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 600000 });
  await skill({ type: 'AudioPlayer.PlaybackStarted', token: 'Hörspiel|1|0|0', offsetInMilliseconds: 595000 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['hörspiel'].offset, 595000);
});

test('Ein Stopp schreibt keine Null ueber eine gemerkte Stelle', async () => {
  const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 42000 });
  await skill({ type: 'AudioPlayer.PlaybackStopped', token: 'Hörspiel|1|0|0', offsetInMilliseconds: 0 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['hörspiel'].offset, 42000);
});

test('"Von vorn" laesst sich von der Null-Sperre nicht aufhalten', async () => {
  // Der Weg, eine Stelle absichtlich loszuwerden: loeschen, und die Runde
  // zaehlt hoch. Der Titelanfang danach legt eine frische Marke an.
  const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 600000 });
  await skill(intent('AMAZON.StartOverIntent'), { token: 'Hörspiel|1|0|0', offset: 600000 }, null, redis);
  assert.equal(redis.speicher.musik_stand['hörspiel'], undefined, 'geloescht');
  await skill({ type: 'AudioPlayer.PlaybackStarted', token: 'Hörspiel|0|1|0', offsetInMilliseconds: 0 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['hörspiel'].offset, 0);
  assert.equal(redis.speicher.musik_stand['hörspiel'].runde, 1);
});

test('Der Wiederholungsversuch nach einem Fehlschlag laesst den Stand stehen', async () => {
  // `selberTitel` ignoriert `versuch` und `pech` absichtlich: Der zweite
  // Versuch ist derselbe Titel, und sein Anfang bei null darf die gemerkte
  // Stelle nicht zudecken.
  const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 600000 });
  await skill({ type: 'AudioPlayer.PlaybackStarted', token: 'Hörspiel|1|0|0|1', offsetInMilliseconds: 0 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['hörspiel'].offset, 600000);
});

test('Ein Stopp schreibt nichts, wenn der Stand nicht gelesen werden konnte', async () => {
  // Der Rueckfall "leeres Objekt" hob die Sperre gegen zurueckspringende
  // Staende genau dann auf, wenn die Datenbank langsam ist - also genau dann,
  // wenn zwei Ereignisse sich ueberholen.
  const staende = { 'hörspiel': { position: 2, runde: 0, seed: 0, offset: 40000 } };
  const lahm = {
    async get(key) {
      if (key === REDIS_KEY) return [HOERSPIEL];
      return new Promise((fertig) => { setTimeout(() => fertig(staende), 5000); });
    },
    async set(key, wert) { if (key === 'musik_stand') Object.assign(staende, wert); },
    async lpush() {}, async ltrim() {}, async expire() {},
  };
  await skill({ type: 'AudioPlayer.PlaybackStopped', token: 'Hörspiel|1|0|0', offsetInMilliseconds: 42000 }, {}, null, lahm);
  assert.deepEqual(staende['hörspiel'], { position: 2, runde: 0, seed: 0, offset: 40000 });
});

test('einstiegNachGangart kennt die Gangart, einstieg nur den Vorlauf', () => {
  assert.equal(einstiegNachGangart({ fortsetzen: 'sekunde' }, 47000), 42000);
  assert.equal(einstiegNachGangart({ fortsetzen: 'titel' }, 47000), 0);
  assert.equal(einstiegNachGangart({ fortsetzen: 'sekunde' }, 3000), 0, 'unter dem Vorlauf: von vorn');
});

test('standNichtZurueck sperrt alles unter dem Vorlauf, nicht nur die Null', () => {
  const token = { position: 1, runde: 0, seed: 0 };
  const stand = { position: 1, runde: 0, seed: 0, offset: 600000 };
  assert.equal(standNichtZurueck(stand, token, 0), true);
  // **Der gemeldete Fall.** In der Datenbank stand @1093 ms, und weil das
  // keine Null war, ging es durch und deckte die echte Stelle zu: Eine
  // Wiedergabe, die nach einer Sekunde endete, hat die zehnte Minute
  // ueberschrieben. Der Verlauf zeigt eine ganze Kette davon - 8, 11, 21, 42
  // Sekunden, bei Titeln von rund einer Stunde.
  assert.equal(standNichtZurueck(stand, token, 1093), true, 'eine Stelle, die keine ist');
  assert.equal(standNichtZurueck(stand, token, 1), true, 'was einstieg() zu 0 macht, ist keine Stelle');
  assert.equal(standNichtZurueck(stand, token, 5000), false, 'ab dem Vorlauf ist es eine Stelle');
  assert.equal(standNichtZurueck(stand, token, 30000), false, 'auch eine kleinere echte Stelle gilt');
  assert.equal(standNichtZurueck({ ...stand, position: 2 }, token, 0), false, 'anderer Titel');
  assert.equal(standNichtZurueck({ ...stand, offset: 0 }, token, 0), false, 'nichts zu schuetzen');
  assert.equal(standNichtZurueck(null, token, 0), false);
});

test('Ohne Vorlauf bleibt es bei genau der Null', () => {
  // MUSIK_VORLAUF_MS=0 heisst "auf die Millisekunde". Dort ist jede
  // Millisekunde eine Stelle, und die Sperre darf nicht zur Attrappe werden.
  const vorher = process.env.MUSIK_VORLAUF_MS;
  process.env.MUSIK_VORLAUF_MS = '0';
  try {
    const token = { position: 1, runde: 0, seed: 0 };
    const stand = { position: 1, runde: 0, seed: 0, offset: 600000 };
    assert.equal(standNichtZurueck(stand, token, 0), true);
    assert.equal(standNichtZurueck(stand, token, 1), false);
  } finally {
    if (vorher === undefined) delete process.env.MUSIK_VORLAUF_MS;
    else process.env.MUSIK_VORLAUF_MS = vorher;
  }
});

test('handleManage haelt die Gangart ueber eine Titelaenderung hinweg', async () => {
  const redis = redisMit();
  const post = (body) => handleManage({ method: 'POST', query: {}, body }, antwortFaenger(), redis);

  await post({ name: 'Album', urls: 'https://h.de/1.mp3', fortsetzen: 'titel' });
  assert.equal(redis.speicher[REDIS_KEY][0].fortsetzen, 'titel');

  // Zweiter Aufruf ohne das Feld: die Gangart bleibt stehen.
  await post({ name: 'Album', urls: 'https://h.de/1.mp3\nhttps://h.de/2.mp3' });
  assert.equal(redis.speicher[REDIS_KEY][0].titel.length, 2);
  assert.equal(redis.speicher[REDIS_KEY][0].fortsetzen, 'titel');

  // Und ausdruecklich ab.
  await post({ name: 'Album', urls: 'https://h.de/1.mp3', fortsetzen: 'aus' });
  assert.equal(redis.speicher[REDIS_KEY][0].fortsetzen, false);
});

test('Eine zu langsame Datenbank loescht die Staende der anderen Playlists nicht', async () => {
  // Alle Staende stehen unter einem Schluessel. Wer nach einer abgelaufenen
  // Frist mit einem leeren Objekt weiterrechnet, schreibt genau einen Stand
  // zurueck - und die aller anderen Playlists sind weg.
  const zweite = { name: 'Zweites', fortsetzen: true, titel: KINDER.titel };
  const staende = { zweites: { position: 2, runde: 0, seed: 0, offset: 40000, zeit: 2000 } };
  const lahm = {
    async get(key) {
      if (key === REDIS_KEY) return [HOERSPIEL, zweite];
      if (key === 'musik_stand') return new Promise((fertig) => { setTimeout(() => fertig(staende), 5000); });
      return null;
    },
    async set(key, wert) { if (key === 'musik_stand') Object.assign(staende, wert); },
  };
  await skill({ type: 'AudioPlayer.PlaybackStarted', token: 'Hörspiel|1|0|0', offsetInMilliseconds: 0 }, {}, null, lahm);
  assert.deepEqual(Object.keys(staende), ['zweites'], 'nichts geschrieben ist besser als alles verloren');
});

test('Ein kaputtes Redis bricht die Wiedergabe nicht', async () => {
  const kaputt = {
    async get(key) { if (key === REDIS_KEY) return [HOERSPIEL]; throw new Error('offline'); },
    async set() { throw new Error('offline'); },
  };
  const r = await skill(sucheIntent('hörspiel'), {}, null, kaputt);
  assert.equal(spielt(r).audioItem.stream.token, 'Hörspiel|0|0|0', 'faengt eben von vorn an');
});

// --- Zufallswiedergabe im Betrieb --------------------------------------------------

test('Mit dem Schalter startet die Playlist gemischt', async () => {
  const gemischt = { name: 'Bunt', zufall: true, titel: KINDER.titel };
  const r = await skill(sucheIntent('bunt'), {}, [gemischt]);
  const token = tokenLesen(spielt(r).audioItem.stream.token);
  assert.ok(token.seed > 0, 'ein Seed wurde gezogen');
  assert.equal(spielt(r).audioItem.stream.url, KINDER.titel[reihenfolge(3, token.seed)[0]].url);
});

test('Ohne den Schalter bleibt die Reihenfolge der Liste', async () => {
  const r = await skill(sucheIntent('kinderlieder'));
  assert.equal(tokenLesen(spielt(r).audioItem.stream.token).seed, 0);
  assert.equal(spielt(r).audioItem.stream.url, KINDER.titel[0].url);
});

test('Die Sprachbefehle mischen nur den laufenden Stream', async () => {
  const an = await skill(intent('AMAZON.ShuffleOnIntent'), { token: 'Kinderlieder|1|0|0' });
  const neu = tokenLesen(spielt(an).audioItem.stream.token);
  assert.ok(neu.seed > 0);
  assert.equal(neu.runde, 1, 'neue Runde, damit der Token sich unterscheidet');
  assert.equal(an.outputSpeech, undefined, 'die Musik spricht nicht dazwischen');

  const aus = await skill(intent('AMAZON.ShuffleOffIntent'), { token: 'Kinderlieder|1|0|4711' });
  assert.equal(tokenLesen(spielt(aus).audioItem.stream.token).seed, 0);
});

test('Mischen ohne laufende Wiedergabe verweist aufs Dashboard', async () => {
  const r = await skill(intent('AMAZON.ShuffleOnIntent'));
  assert.match(r.outputSpeech.text, /Dashboard/);
});

// --- Verwaltung -------------------------------------------------------------------

test('handleManage legt an, ueberschreibt nach Name und loescht', async () => {
  const redis = redisMit();

  let res = antwortFaenger();
  await handleManage({ method: 'POST', query: {}, body: { name: 'Kinder', urls: 'https://h.de/1.mp3' } }, res, redis);
  assert.equal(res.statusCode, 200);
  assert.equal(redis.speicher[REDIS_KEY].length, 1);

  res = antwortFaenger();
  await handleManage({ method: 'POST', query: {}, body: { name: 'kinder', urls: 'https://h.de/1.mp3\nhttps://h.de/2.mp3' } }, res, redis);
  assert.equal(redis.speicher[REDIS_KEY].length, 1);
  assert.equal(redis.speicher[REDIS_KEY][0].name, 'kinder');
  assert.equal(redis.speicher[REDIS_KEY][0].titel.length, 2);

  res = antwortFaenger();
  await handleManage({ method: 'GET', query: {} }, res, redis);
  assert.equal(res.body.length, 1);

  res = antwortFaenger();
  await handleManage({ method: 'DELETE', query: {}, body: { name: 'KINDER' } }, res, redis);
  assert.deepEqual(redis.speicher[REDIS_KEY], []);
});

test('handleManage haelt die Wiederholung ueber eine Titelaenderung hinweg', async () => {
  const redis = redisMit();
  const post = (body) => handleManage({ method: 'POST', query: {}, body }, antwortFaenger(), redis);

  await post({ name: 'Einmal', urls: 'https://h.de/1.mp3', wiederholen: false });
  assert.equal(redis.speicher[REDIS_KEY][0].wiederholen, false);

  // Zweiter Aufruf ohne das Feld: die Einstellung bleibt stehen.
  await post({ name: 'Einmal', urls: 'https://h.de/1.mp3\nhttps://h.de/2.mp3' });
  assert.equal(redis.speicher[REDIS_KEY][0].titel.length, 2);
  assert.equal(redis.speicher[REDIS_KEY][0].wiederholen, false);

  // Ausdruecklich wieder an.
  await post({ name: 'Einmal', urls: 'https://h.de/1.mp3', wiederholen: true });
  assert.equal(redis.speicher[REDIS_KEY][0].wiederholen, true);
});

test('handleManage speichert beide Schalter unabhaengig voneinander', async () => {
  const redis = redisMit();
  const post = (body) => handleManage({ method: 'POST', query: {}, body }, antwortFaenger(), redis);

  await post({ name: 'Leise', urls: 'https://h.de/1.mp3', wiederholen: false, ansage: false });
  assert.deepEqual(
    { w: redis.speicher[REDIS_KEY][0].wiederholen, a: redis.speicher[REDIS_KEY][0].ansage },
    { w: false, a: false },
  );

  // Nur die Ansage wieder an, die Wiederholung bleibt aus.
  await post({ name: 'Leise', urls: 'https://h.de/1.mp3', ansage: true });
  assert.deepEqual(
    { w: redis.speicher[REDIS_KEY][0].wiederholen, a: redis.speicher[REDIS_KEY][0].ansage },
    { w: false, a: true },
  );
});

test('handleManage weist eine kaputte Playlist mit 400 und Zeilennummer ab', async () => {
  const redis = redisMit();
  const res = antwortFaenger();
  await handleManage({ method: 'POST', query: {}, body: { name: 'X', urls: 'http://h.de/1.mp3' } }, res, redis);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Zeile 1/);
  assert.equal(redis.speicher[REDIS_KEY], undefined);
});

test('handleManage: Pruefung einer unbekannten Playlist ist 404', async () => {
  const res = antwortFaenger();
  await handleManage({ method: 'GET', query: { pruefen: '1', name: 'nix' } }, res, redisMit());
  assert.equal(res.statusCode, 404);
});

// --- Ordner-Import ----------------------------------------------------------------
//
// Geprueft wird der Teil ohne Netz: aus dem Quelltext einer Verzeichnisseite
// die Titelliste. Der Abruf selbst (handleImport) steht hier nur mit den
// Faellen, die er vor dem ersten Byte entscheidet - alles andere braeuchte
// einen Server und gehoert nicht in einen Test, der ohne Netz laufen soll.

const FRITZ_ORDNER = 'https://abc.myfritz.net:456/nas/filelink.lua?id=535f52fb';

test('istAudioUrl sieht den Dateinamen auch in der Abfrage', () => {
  assert.equal(istAudioUrl('https://h.de/musik/01.mp3'), true);
  assert.equal(istAudioUrl('https://h.de/musik/01.MP3?x=1'), true);
  // Der FRITZ!NAS-Fall: immer derselbe Pfad, der Name steckt in `path`.
  assert.equal(istAudioUrl(`${FRITZ_ORDNER}&path=%2FMusik%2F01%20Hallo.mp3`), true);
  assert.equal(istAudioUrl(FRITZ_ORDNER), false);
  assert.equal(istAudioUrl('https://h.de/musik/cover.jpg'), false);
  assert.equal(istAudioUrl('kein url'), false);
});

test('audioLinksAusHtml liest einen Verzeichnisindex in seiner Reihenfolge', () => {
  const html = `
    <a href="../">Parent Directory</a>
    <a href="02-tschuess.mp3">02-tschuess.mp3</a>
    <a href="01-hallo.mp3">01-hallo.mp3</a>
    <a href="Mein Lied.m4a">Mein Lied.m4a</a>
    <a href="cover.jpg">cover.jpg</a>`;
  assert.deepEqual(audioLinksAusHtml(html, 'https://h.de/musik/'), [
    'https://h.de/musik/02-tschuess.mp3',
    'https://h.de/musik/01-hallo.mp3',
    'https://h.de/musik/Mein%20Lied.m4a',
  ]);
});

test('audioLinksAusHtml loest &amp; auf, statt daraus einen Abfragewert zu machen', () => {
  const html = '<a href="/nas/filelink.lua?id=535f&amp;path=%2FM%2F01.mp3">01</a>';
  const [erste] = audioLinksAusHtml(html, FRITZ_ORDNER);
  assert.equal(new URL(erste).searchParams.get('path'), '/M/01.mp3');
  assert.equal(new URL(erste).searchParams.get('id'), '535f');
});

test('audioLinksAusHtml findet die Liste auch in einem JSON-Block', () => {
  const html = '<script>var files=['
    + '{"name":"01 Hallo.mp3","url":"\\/nas\\/filelink.lua?id=535f\\u0026path=%2FM%2F01.mp3"},'
    + '{"name":"02.mp3","url":"\\/nas\\/filelink.lua?id=535f\\u0026path=%2FM%2F02.mp3"}];</script>';
  const links = audioLinksAusHtml(html, FRITZ_ORDNER);
  assert.deepEqual(links.map(u => new URL(u).searchParams.get('path')), ['/M/01.mp3', '/M/02.mp3']);
});

test('audioLinksAusHtml haelt den blossen Anzeigenamen aus der Liste heraus', () => {
  // "Anzeige.mp3" ist der Name der Datei, nicht ihre Adresse. Als relative
  // Adresse gelesen ergaebe er eine Zeile, die im Formular richtig aussieht
  // und am Echo ins Leere laeuft.
  const html = '<a href="/nas/filelink.lua?id=535f&amp;path=%2FM%2F02.mp3">02</a>'
    + '<script>var x={"name":"Anzeige.mp3"};</script>';
  assert.deepEqual(audioLinksAusHtml(html, FRITZ_ORDNER), [
    'https://abc.myfritz.net:456/nas/filelink.lua?id=535f&path=%2FM%2F02.mp3',
  ]);
});

test('audioLinksAusHtml uebergeht Dubletten und findet in einer leeren Seite nichts', () => {
  const html = '<a href="01.mp3">a</a><a href="01.mp3">nochmal</a>';
  assert.deepEqual(audioLinksAusHtml(html, 'https://h.de/m/'), ['https://h.de/m/01.mp3']);
  assert.deepEqual(audioLinksAusHtml('<html><body>leer</body></html>', 'https://h.de/m/'), []);
});

test('audioNamenImText erkennt die Liste, die ihre Adressen erst im Browser baut', () => {
  const namen = audioNamenImText('<td class="n">01 Hallo.mp3</td><td>Bild.jpg</td><td>02.mp3</td>');
  assert.deepEqual(namen, ['01 Hallo.mp3', '02.mp3']);
});

test('handleImport weist einen fehlenden oder krummen Link ab, ohne ihn abzurufen', async () => {
  let res = antwortFaenger();
  await handleManage({ method: 'GET', query: { import: '1' } }, res, redisMit());
  assert.equal(res.statusCode, 400);

  res = antwortFaenger();
  await handleManage({ method: 'GET', query: { import: '1', url: 'kein link' } }, res, redisMit());
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /URL/);
});

test('handleImport laesst sich nicht als Sonde ins eigene Netz verwenden', async () => {
  const res = antwortFaenger();
  await handleManage({ method: 'GET', query: { import: '1', url: 'https://localhost/nas/' } }, res, redisMit());
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /lokaler Host/);
});

test('seitenDiagnose nimmt eine kleine Seite ganz und nennt ihre Skripte', () => {
  const html = '<html><head><title> FRITZ!NAS </title>'
    + '<script src="/nas/js/app.js"></script></head><body><div id="app"></div></body></html>';
  const d = seitenDiagnose(html);
  assert.equal(d.titel, 'FRITZ!NAS');
  assert.equal(d.laenge, html.length);
  assert.deepEqual(d.skripte, ['/nas/js/app.js']);
  assert.equal(d.auszug, html, 'klein genug, also vollstaendig');
});

test('seitenDiagnose kappt eine grosse Seite an beiden Enden', () => {
  const html = `<title>Anfang</title>${'x'.repeat(5000)}ENDE-MARKE`;
  const d = seitenDiagnose(html, 1000);
  assert.equal(d.laenge, html.length);
  assert.ok(d.auszug.length < html.length);
  assert.match(d.auszug, /^<title>Anfang<\/title>/, 'der Anfang bleibt');
  assert.match(d.auszug, /ENDE-MARKE$/, 'das Ende auch');
  assert.match(d.auszug, /Zeichen ausgelassen/);
});

test('seitenDiagnose kommt ohne title und ohne Skripte aus', () => {
  const d = seitenDiagnose('nur text');
  assert.equal(d.titel, null);
  assert.deepEqual(d.skripte, []);
});

// --- FRITZ!NAS-Playlists ----------------------------------------------------------

const FRITZ_LINK = 'https://abc.myfritz.net:456/nas/filelink.lua?id=535f52fbb2016f4f';
const fritzTitel = (sid) =>
  `https://abc.myfritz.net:456/nas/cgi-bin/luacgi_notimeout?script=%2Fapi%2Fdata.lua&sid=${sid}&c=music&a=get&path=%2F01.mp3`;

test('validierePlaylist merkt sich die FRITZ!NAS-Herkunft', () => {
  const { playlist } = validierePlaylist({
    name: 'Schlaflieder',
    urls: fritzTitel('aaaaaaaaaaaaaaaa'),
    quelle: { typ: 'fritz', link: FRITZ_LINK },
  });
  assert.deepEqual(playlist.quelle, { typ: 'fritz', link: FRITZ_LINK });
});

test('validierePlaylist haelt die Herkunft ueber eine Titelaenderung hinweg', () => {
  const bisher = { name: 'Schlaflieder', titel: [], quelle: { typ: 'fritz', link: FRITZ_LINK } };
  const { playlist } = validierePlaylist({ name: 'Schlaflieder', urls: fritzTitel('aaaaaaaaaaaaaaaa') }, bisher);
  assert.deepEqual(playlist.quelle, { typ: 'fritz', link: FRITZ_LINK }, 'ein fehlendes Feld nimmt sie nicht weg');

  const entfernt = validierePlaylist(
    { name: 'Schlaflieder', urls: 'https://h.de/1.mp3', quelle: null },
    bisher,
  ).playlist;
  assert.equal(entfernt.quelle, undefined, 'ausdruecklich null entfernt sie');
});

test('validierePlaylist merkt sich den Ordnerpfad und kappt ihn', () => {
  const { playlist } = validierePlaylist({
    name: 'Schlaflieder',
    urls: fritzTitel('aaaaaaaaaaaaaaaa'),
    quelle: { typ: 'fritz', link: FRITZ_LINK, ordner: '  /Musik/Schlaflieder  ' },
  });
  assert.equal(playlist.quelle.ordner, '/Musik/Schlaflieder');

  const lang = validierePlaylist({
    name: 'X',
    urls: 'https://h.de/1.mp3',
    quelle: { typ: 'fritz', link: FRITZ_LINK, ordner: '/' + 'a'.repeat(400) },
  }).playlist;
  assert.equal(lang.quelle.ordner.length, 256);

  const ohne = validierePlaylist({
    name: 'X',
    urls: 'https://h.de/1.mp3',
    quelle: { typ: 'fritz', link: FRITZ_LINK, ordner: '   ' },
  }).playlist;
  assert.equal(ohne.quelle.ordner, undefined, 'ein leerer Pfad wird nicht gespeichert');
});

test('validierePlaylist nimmt nur einen echten Freigabe-Link als Herkunft', () => {
  // Sie wandert spaeter in einen Abruf des Servers - alles andere als ein
  // filelink.lua-Link waere eine Adresse, die sich jemand holen laesst.
  for (const quelle of [
    { typ: 'fritz', link: 'https://example.org/beliebig' },
    { typ: 'anderes', link: FRITZ_LINK },
    { link: FRITZ_LINK },
    'https://example.org',
  ]) {
    const { playlist } = validierePlaylist({ name: 'X', urls: 'https://h.de/1.mp3', quelle });
    assert.equal(playlist.quelle, undefined, `abgelehnt: ${JSON.stringify(quelle)}`);
  }
});

test('beim Speichern werden alte Sitzungsadressen umgeschrieben', async () => {
  // Der Weg, auf dem bestehende Playlists heil werden: Der Pfad steht in der
  // alten Adresse, der Freigabe-Link in der Herkunft - mehr braucht die neue
  // nicht. Ohne Basis (etwa in einem Test ohne Anfrage) bleibt alles, wie es
  // ist; das ist die zweite Haelfte der Zusicherung.
  const vorher = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = 'test-schluessel';
  const { playlist } = validierePlaylist({
    name: 'Schlaflieder',
    urls: fritzTitel('aaaaaaaaaaaaaaaa'),
    quelle: { typ: 'fritz', link: FRITZ_LINK },
  }, null, 'https://app.example');

  const url = new URL(playlist.titel[0].url);
  assert.equal(url.origin + url.pathname, 'https://app.example/api/skill');
  assert.ok(url.searchParams.get('ton'), 'mit Token');
  assert.equal(url.searchParams.get('sid'), null, 'und ohne Sitzungsnummer');

  const ohneBasis = validierePlaylist({
    name: 'Schlaflieder',
    urls: fritzTitel('aaaaaaaaaaaaaaaa'),
    quelle: { typ: 'fritz', link: FRITZ_LINK },
  }).playlist;
  assert.match(ohneBasis.titel[0].url, /luacgi_notimeout/, 'ohne Basis bleibt es beim Alten');

  // **Und ohne Schluessel ebenso.** Dann gibt es keine Adresse, die der Echo
  // abrufen koennte - eine halbe waere schlimmer als die alte.
  delete process.env.ADMIN_PASSWORD;
  const ohneSchluessel = validierePlaylist({
    name: 'Schlaflieder',
    urls: fritzTitel('aaaaaaaaaaaaaaaa'),
    quelle: { typ: 'fritz', link: FRITZ_LINK },
  }, null, 'https://app.example').playlist;
  assert.match(ohneSchluessel.titel[0].url, /luacgi_notimeout/);
  if (vorher === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = vorher;
});

test('handleManage speichert die Herkunft mit der Playlist', async () => {
  const redis = redisMit();
  await handleManage({
    method: 'POST',
    query: {},
    body: { name: 'Schlaflieder', urls: fritzTitel('aaaaaaaaaaaaaaaa'), quelle: { typ: 'fritz', link: FRITZ_LINK } },
  }, antwortFaenger(), redis);
  assert.deepEqual(redis.speicher[REDIS_KEY][0].quelle, { typ: 'fritz', link: FRITZ_LINK });
});

test('eine Playlist ohne Herkunft ruehrt der Skill nicht an', async () => {
  const r = await skill(intent('PlayPlaylistIntent', 'Kinderlieder'));
  assert.equal(spielt(r).audioItem.stream.url, KINDER.titel[0].url);
});

/** Eine Playlist, wie der Ordner-Import sie heute anlegt: Adressen dieser App. */
const TON_PLAYLIST = {
  name: 'Lottchen',
  quelle: { typ: 'fritz', link: FRITZ_LINK, ordner: '/Musik/Lottchen' },
  titel: [
    { url: 'https://app.example/api/skill?ton=eins.unterschrift', name: '01' },
    { url: 'https://app.example/api/skill?ton=zwei.unterschrift', name: '02' },
  ],
};

test('die Adresse geht unveraendert an den Echo - und die Box wird nicht angefasst', async () => {
  // **Der Kern der Sache.** Eine Sitzungsnummer der Box gilt nur fuer die
  // Adresse, die sie geholt hat; der Echo ist nie diese Adresse. Der Skill
  // setzt deshalb nichts mehr ein, fragt nichts nach und meldet sich nirgends
  // an - er antwortet mit dem, was gespeichert ist.
  const vorher = globalThis.fetch;
  const abrufe = [];
  globalThis.fetch = async (url) => { abrufe.push(String(url)); throw new Error('haette nicht abrufen duerfen'); };
  try {
    const redis = redisMit({ [REDIS_KEY]: [TON_PLAYLIST] });
    const r = await skill(intent('PlayPlaylistIntent', 'Lottchen'), {}, null, redis);
    assert.equal(spielt(r).audioItem.stream.url, TON_PLAYLIST.titel[0].url);
    assert.deepEqual(abrufe, [], 'kein einziger Abruf bei der FRITZ!Box');
  } finally {
    globalThis.fetch = vorher;
  }
});

test('auch eine FRITZ!NAS-Playlist reiht den naechsten Titel vor', async () => {
  // **Das ist die Reparatur, und sie hat fuenf Runden gekostet.** #121 hatte
  // das Vorreihen fuer diese Box abgeschaltet und den naechsten Titel
  // stattdessen bei `PlaybackFinished` bestellt - aus Sorge vor zwei
  // gleichzeitigen Abrufen. In keiner Messung hat daraufhin je ein
  // Titelwechsel stattgefunden: Die Datei lief sauber zu Ende
  // (`7594648 von 7594648 B`), und danach kam nichts.
  //
  // Was die Fehlertabelle im README seit Monaten sagt, gilt eben doch:
  // "First track plays, then silence - PlaybackNearlyFinished got no ENQUEUE".
  // Die Warteschlange wird dort gefuellt und nirgends sonst.
  const redis = redisMit({ [REDIS_KEY]: [TON_PLAYLIST] });
  const r = await skill(
    { type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Lottchen|0|0|0' },
    { token: 'Lottchen|0|0|0' },
    null,
    redis,
  );
  const stream = spielt(r).audioItem.stream;
  assert.equal(stream.url, TON_PLAYLIST.titel[1].url, 'der naechste Titel');
  assert.equal(spielt(r).playBehavior, 'ENQUEUE', 'angehaengt, nicht ersetzt');
  assert.equal(stream.expectedPreviousToken, 'Lottchen|0|0|0', 'an den laufenden gehaengt');
});

test('am Titelende wird nichts mehr bestellt - es haengt laengst in der Schlange', async () => {
  const redis = redisMit({ [REDIS_KEY]: [TON_PLAYLIST] });
  const r = await skill(
    { type: 'AudioPlayer.PlaybackFinished', token: 'Lottchen|0|0|0' },
    { token: 'Lottchen|0|0|0' },
    null,
    redis,
  );
  assert.equal(r.directives, undefined, 'keine zweite Bestellung');
});

test('eine Playlist ohne FRITZ!NAS-Herkunft bleibt nahtlos', async () => {
  // Die Gegenprobe: Wo die Quelle zwei Abrufe vertraegt, wird weiter
  // vorgereiht - eine Luecke zwischen den Titeln ohne Not waere ein
  // Rueckschritt.
  const r = await skill(
    { type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Kinderlieder|0|0|0' },
    { token: 'Kinderlieder|0|0|0' },
  );
  assert.equal(spielt(r).playBehavior, 'ENQUEUE');
});

test('eine Playlist ohne Sitzungsnummer bleibt nahtlos', async () => {
  // Die Gegenprobe: Wo die Adresse nicht verdirbt, wird weiter vorab
  // angehaengt - eine Luecke zwischen den Titeln ohne Not waere ein Rueckschritt.
  const r = await skill(
    { type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Kinderlieder|0|0|0' },
    { token: 'Kinderlieder|0|0|0' },
  );
  assert.equal(spielt(r).playBehavior, 'ENQUEUE');
  assert.equal(spielt(r).audioItem.stream.expectedPreviousToken, 'Kinderlieder|0|0|0');
});

// --- Die Sitzung wird beim Oeffnen geholt ------------------------------------

/** Dasselbe Redis, das nebenbei mitschreibt, welche Schluessel gelesen wurden. */
function redisMitProtokoll(daten) {
  const redis = redisMit(daten);
  const gelesen = [];
  return {
    gelesen,
    redis: { ...redis, async get(key) { gelesen.push(key); return redis.get(key); } },
  };
}

/** Ein grosszuegiges Budget - sonst laesst der Skill den Login von vornherein aus. */
async function mitBudget(ms, tu) {
  process.env.MUSIK_BUDGET_MS = String(ms);
  try { return await tu(); } finally { process.env.MUSIK_BUDGET_MS = '300'; }
}

test('Ohne FRITZ!NAS-Playlist wird beim Oeffnen nichts geholt', async () => {
  const { redis, gelesen } = redisMitProtokoll({ [REDIS_KEY]: [KINDER] });
  await mitBudget(9000, () => skill({ type: 'LaunchRequest' }, {}, null, redis));
  assert.ok(!gelesen.includes('musik_fritz_sid'), 'ohne Freigabe gibt es nichts vorzuwaermen');
});

test('Bei zwei Freigaben wird nicht geraten', async () => {
  // Jede Anmeldung beendet laut AVM alle Sitzungen der Box. Welche Freigabe
  // gemeint ist, steht beim Oeffnen noch nicht fest - und die falsche zu
  // waehlen naehme der richtigen gerade die Sitzung.
  const a = unerreichbar('Schlaflieder', 'aaaa1111aaaa1111');
  const b = unerreichbar('Hoerspiele', 'bbbb2222bbbb2222');
  const { redis, gelesen } = redisMitProtokoll({ [REDIS_KEY]: [a.playlist, b.playlist] });
  await mitBudget(9000, () => skill({ type: 'LaunchRequest' }, {}, null, redis));
  assert.ok(!gelesen.includes('musik_fritz_sid'), 'zwei Freigaben: keine Wahl treffen');
});

test('Reicht die Zeit beim Oeffnen nicht, wird die Frage nicht aufgehalten', async () => {
  // Das knappe Budget der Testsuite ist genau dieser Fall: Dann bleibt es beim
  // bisherigen Weg, und der zweite Schritt meldet sich an.
  const a = unerreichbar('Schlaflieder', 'aaaa1111aaaa1111');
  const { redis, gelesen } = redisMitProtokoll({ [REDIS_KEY]: [a.playlist] });
  const r = await skill({ type: 'LaunchRequest' }, {}, null, redis);
  assert.ok(!gelesen.includes('musik_fritz_sid'));
  assert.match(r.outputSpeech.text, /Welche Playlist soll ich spielen/);
});

test('eine FRITZ!NAS-Playlist wird in kleineren Haeppchen geprueft', async () => {
  // Vier gleichzeitige Abrufe beantwortet eine FRITZ!Box nicht rechtzeitig -
  // sie bekommt einen nach dem anderen und mehr Zeit. Damit die zehn Sekunden
  // der Function trotzdem reichen, sind es sechs Titel je Aufruf statt
  // zwanzig; den Rest holt das Dashboard mit `ab=` nach.
  const link = 'https://nicht-erreichbar.invalid/nas/filelink.lua?id=535f52fbb2016f4f';
  const titel = Array.from({ length: 10 }, (_, i) => ({
    url: `https://nicht-erreichbar.invalid/nas/cgi-bin/luacgi_notimeout?script=%2Fapi%2Fdata.lua&sid=aaaaaaaaaaaaaaaa&c=music&a=get&path=%2F${i}.mp3`,
    name: String(i),
  }));

  const res = antwortFaenger();
  await handleManage(
    { method: 'GET', query: { pruefen: '1', name: 'Schlaflieder', ab: '0' } },
    res,
    redisMit({ [REDIS_KEY]: [{ name: 'Schlaflieder', quelle: { typ: 'fritz', link }, titel }] }),
  );
  assert.equal(res.body.ergebnisse.length, 6);
  assert.equal(res.body.weiter, 6);
  assert.equal(res.body.gesamt, 10);
});

test('eine gewoehnliche Playlist bleibt bei zwanzig je Aufruf', async () => {
  const titel = Array.from({ length: 10 }, (_, i) => ({ url: `https://nicht-erreichbar.invalid/${i}.mp3`, name: String(i) }));
  const res = antwortFaenger();
  await handleManage(
    { method: 'GET', query: { pruefen: '1', name: 'Viele', ab: '0' } },
    res,
    redisMit({ [REDIS_KEY]: [{ name: 'Viele', titel }] }),
  );
  assert.equal(res.body.ergebnisse.length, 10, 'alle zehn in einem Aufruf');
  assert.equal(res.body.weiter, null);
});

// --- Reihenfolge der Playlists ----------------------------------------------------

const pl = (name) => ({ name, titel: [{ url: 'https://h.de/1.mp3', name: '1' }] });

test('sortierePlaylists bringt sie in die gewuenschte Reihenfolge', () => {
  const bestand = [pl('Kinderlieder'), pl('Hörspiele'), pl('Schlaflieder')];
  const neu = sortierePlaylists(bestand, ['Schlaflieder', 'Hörspiele', 'Kinderlieder']);
  assert.deepEqual(neu.map(p => p.name), ['Schlaflieder', 'Hörspiele', 'Kinderlieder']);
});

test('sortierePlaylists vergleicht Namen ohne Ruecksicht auf Gross- und Kleinschreibung', () => {
  const neu = sortierePlaylists([pl('Kinderlieder'), pl('Hörspiele')], ['hörspiele', 'KINDERLIEDER']);
  assert.deepEqual(neu.map(p => p.name), ['Hörspiele', 'Kinderlieder']);
});

test('sortierePlaylists verliert nichts und stolpert ueber nichts', () => {
  const bestand = [pl('A'), pl('B'), pl('C')];

  // Ein Name, den es nicht gibt - etwa eine Playlist, die inzwischen geloescht
  // wurde -, wird uebergangen.
  const mitGeist = sortierePlaylists(bestand, ['C', 'Weg', 'A']);
  assert.deepEqual(mitGeist.map(p => p.name), ['C', 'A', 'B'], 'B fehlte in der Liste und haengt sich hinten an');

  // Gar keine Liste, eine leere, etwas Krummes: Der Bestand bleibt, wie er ist.
  for (const namen of [undefined, null, [], 'kein Array', ['', '   ']]) {
    assert.deepEqual(sortierePlaylists(bestand, namen).map(p => p.name), ['A', 'B', 'C']);
  }
});

test('handleManage speichert die neue Reihenfolge', async () => {
  const redis = redisMit({ [REDIS_KEY]: [pl('Kinderlieder'), pl('Hörspiele')] });
  const res = antwortFaenger();
  await handleManage(
    { method: 'POST', query: { sortieren: '1' }, body: { namen: ['Hörspiele', 'Kinderlieder'] } },
    res,
    redis,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(redis.speicher[REDIS_KEY].map(p => p.name), ['Hörspiele', 'Kinderlieder']);
});

test('das Umsortieren laesst die Playlists selbst unangetastet', async () => {
  // Es kommt kein Inhalt mit, also darf auch keiner verlorengehen - weder
  // Titel noch Schalter noch die FRITZ!NAS-Herkunft.
  const voll = {
    name: 'Schlaflieder',
    titel: [{ url: 'https://h.de/1.mp3', name: '1' }, { url: 'https://h.de/2.mp3', name: '2' }],
    wiederholen: false,
    zufall: true,
    quelle: { typ: 'fritz', link: FRITZ_LINK, ordner: '/Musik/Schlaflieder' },
  };
  const redis = redisMit({ [REDIS_KEY]: [pl('Andere'), voll] });
  await handleManage(
    { method: 'POST', query: { sortieren: '1' }, body: { namen: ['Schlaflieder', 'Andere'] } },
    antwortFaenger(),
    redis,
  );
  assert.deepEqual(redis.speicher[REDIS_KEY][0], voll);
});

// --- Eine Sitzung je FRITZ!Box ----------------------------------------------------
//
// AVM: Die Zahl der Sitzungen ist begrenzt, ein Programm soll nur eine je Box
// verwenden - und ein Zugriff ohne gueltige Sitzung beendet alle bestehenden.
// Die Tests hier halten fest, was daraus folgt.

/** Eine FRITZ!NAS-Playlist auf einem Host, der garantiert nicht antwortet. */
function unerreichbar(name, id) {
  const link = `https://nicht-erreichbar.invalid/nas/filelink.lua?id=${id}`;
  return {
    link,
    playlist: {
      name,
      quelle: { typ: 'fritz', link },
      titel: [{
        url: `https://nicht-erreichbar.invalid/nas/cgi-bin/luacgi_notimeout?script=%2Fapi%2Fdata.lua&sid=gespeichertexxxx&c=music&a=get&path=%2F01.mp3`,
        name: '01',
      }],
    },
  };
}

/**
 * Welche Sitzungsnummer steckt in der Adresse, die Alexa bekommen hat?
 *
 * `null`, wenn gar nicht gespielt wurde - seit der Skill ohne frische Nummer
 * nichts mehr verspricht, ist das ein eigenes, gueltiges Ergebnis und kein
 * Fehler des Tests.
 */
async function sidDerDirektive(redis, name) {
  const r = await skill(intent('PlayPlaylistIntent', name), {}, null, redis);
  const url = spielt(r)?.audioItem?.stream?.url;
  return url ? new URL(url).searchParams.get('sid') : null;
}

/** Was Alexa dabei gesagt hat. */
async function satzBeimSpielen(redis, name) {
  const r = await skill(intent('PlayPlaylistIntent', name), {}, null, redis);
  return r.outputSpeech?.text ?? '';
}

test('beide fruehere Formen des Zwischenspeichers bleiben lesbar', () => {
  // Ein Deploy mitten in einer Wiedergabe soll nicht zur Anmeldung fuehren.
  const link = 'https://abc.myfritz.net:456/nas/filelink.lua?id=aaaa1111aaaa1111';
  assert.deepEqual(
    alsSidTafel({ link, sid: 'einzelform1111x', zeit: 4711 }),
    { [link]: { sid: 'einzelform1111x', zeit: 4711 } },
    'die eine Nummer je Box',
  );
  assert.deepEqual(
    alsSidTafel({ [link]: { sid: 'tafelform11111x', zeit: 4711 } }),
    { [link]: { sid: 'tafelform11111x', zeit: 4711 } },
    'die Tafel je Freigabe',
  );
  assert.deepEqual(alsSidTafel(null), {});
  assert.deepEqual(alsSidTafel({ [link]: { zeit: 1 } }), {}, 'ohne Nummer kein Eintrag');
});

test('eine Sitzung, die zu einem anderen Ordner gehoert, gilt nicht', () => {
  // `check_nas_rights` sagt, welchen Ordner die Sitzung freigibt. Stimmt der
  // nicht mit dem der Playlist ueberein, lebt die Nummer zwar - sie gibt aber
  // diese Titel nicht heraus. Genau so sah der gemeldete Fehler aus:
  // data.lua meldet "gilt noch", und der Echo bekommt die Datei trotzdem nicht.
  assert.equal(fremderOrdner('/Musik/Schlaflieder', '/Musik/Hoerspiele'), true);
  assert.equal(fremderOrdner('/Musik/Schlaflieder', '/Musik/Schlaflieder'), false);
  assert.equal(fremderOrdner('/Musik/Schlaflieder/', '/Musik/Schlaflieder'), false, 'ein Schraegstrich am Ende zaehlt nicht');
  // Ohne beide Angaben gibt es keine Auskunft - eine Playlist aus der Zeit
  // vor `quelle.ordner`, eine Box ohne `root`. Dann bleibt alles wie vorher.
  assert.equal(fremderOrdner(null, '/Musik/Schlaflieder'), false);
  assert.equal(fremderOrdner('/Musik/Schlaflieder', null), false);
  assert.equal(fremderOrdner('', '/Musik'), false);
});

test('fritzSidMerken haelt je Freigabe eine Nummer', async () => {
  const zweiter = 'https://abc.myfritz.net:456/nas/filelink.lua?id=bbbb2222bbbb2222';
  const redis = redisMit();
  await fritzSidMerken(redis, FRITZ_LINK, 'frischgeholt111');
  assert.equal(redis.speicher.musik_fritz_sid[FRITZ_LINK].sid, 'frischgeholt111');
  assert.ok(Date.now() - redis.speicher.musik_fritz_sid[FRITZ_LINK].zeit < 5000);

  // **Die zweite Freigabe steht daneben, nicht darueber.** Sonst faengt jeder
  // Wechsel zwischen zwei Ordner-Playlists mit einer Anmeldung an - und die
  // wirft die andere aus der Box.
  await fritzSidMerken(redis, zweiter, 'zweitesitzung11');
  assert.equal(redis.speicher.musik_fritz_sid[FRITZ_LINK].sid, 'frischgeholt111');
  assert.equal(redis.speicher.musik_fritz_sid[zweiter].sid, 'zweitesitzung11');
});

test('eine Anmeldung entwertet die Zeitstempel der anderen Freigaben', async () => {
  // Sie beendet laut AVM alle Sitzungen der Box. Die Nummern bleiben gemerkt -
  // aber ohne Zeitstempel, damit sie nicht mehr blind verwendet, sondern vor
  // dem Gebrauch nachgefragt werden.
  const zweiter = 'https://abc.myfritz.net:456/nas/filelink.lua?id=bbbb2222bbbb2222';
  const redis = redisMit();
  await fritzSidMerken(redis, FRITZ_LINK, 'frischgeholt111');
  await fritzSidMerken(redis, zweiter, 'zweitesitzung11', { nachAnmeldung: true });
  assert.equal(redis.speicher.musik_fritz_sid[FRITZ_LINK].sid, 'frischgeholt111', 'die Nummer bleibt');
  assert.equal(redis.speicher.musik_fritz_sid[FRITZ_LINK].zeit, 0, 'ihr Zeitstempel nicht');
  assert.ok(redis.speicher.musik_fritz_sid[zweiter].zeit > 0);
});

test('fritzSidMerken laesst einen kaputten Zwischenspeicher die Wiedergabe nicht aufhalten', async () => {
  const kaputt = { async get() { return null; }, async set() { throw new Error('offline'); } };
  await assert.doesNotReject(() => fritzSidMerken(kaputt, FRITZ_LINK, 'frischgeholt111'));
});

// --- Nachfragen statt anmelden ----------------------------------------------
//
// **Der Fehler, um den es hier geht.** Mitten in einem Album meldete der Echo
// "MEDIA_ERROR_INTERNAL_SERVER_ERROR – Device playback error", und der Skill
// sprang zum naechsten Titel. Schuld war der Skill selbst: Lief die gemerkte
// Sitzungsnummer aus ihrem Fuenf-Minuten-Fenster, meldete er sich neu an - und
// eine Anmeldung beendet auf der FRITZ!Box **alle** Sitzungen, auch die, mit
// der der Echo gerade lud. Bei Titeln von vier, fuenf Minuten fiel das Fenster
// fast immer in einen laufenden Titel.
//
// Die Tests hier haengen deshalb eine Box an den Draht, die sich wie das
// Original verhaelt - genau eine Sitzung, und jede Anmeldung ersetzt sie - und
// pruefen, welche Abrufe der Skill macht. Die Adresse ist eine aus TEST-NET-3
// (RFC 5737): oeffentlich genug fuer die Zielpruefung, und `dns.lookup` gibt
// eine IP-Literale ohne Netz zurueck.

const BOX = 'https://203.0.113.9:456';
const BOX_LINK = `${BOX}/nas/filelink.lua?id=535f52fbb2016f4f`;
const boxTitel = (nr, sid) =>
  `${BOX}/nas/cgi-bin/luacgi_notimeout?script=%2Fapi%2Fdata.lua&sid=${sid}&c=music&a=get&path=%2F0${nr}.mp3`;

/** Eine Antwort, wie sie die Box schickt. */
function boxAntwort(typ, text) {
  return new Response(text, { status: 200, headers: { 'Content-Type': typ } });
}

/**
 * Die Box am Draht: eine einzige Sitzung, und `filelink.lua` ersetzt sie.
 *
 * `abrufe` protokolliert die Pfade in ihrer Reihenfolge - daran haengt die
 * eigentliche Zusicherung dieser Tests: dass `filelink.lua` **nicht** vorkommt,
 * solange die gemerkte Nummer noch gilt.
 */
function boxAmDraht(gueltig, neue = 'cccccccccccccccc', ton = 'audio') {
  const abrufe = [];
  const zustand = { gueltig };
  // Welche Adresse der Weckruf angetippt hat und mit welchem Kopf - beides
  // gehoert zur Aussage: Eine andere Datei weckt die falsche Stelle, und ohne
  // `Range` zoege der Weckruf die ganze Datei ueber die Leitung.
  const box = {
    abrufe, zustand, geweckt: null, weckkopf: null,
    tonZaehler: 0, nurEinmalTon: false, umleitung: false, wurzel: '/Musik',
    tonNurEinmal() { box.nurEinmalTon = true; },
    leitetUm() { box.umleitung = true; },
  };
  const vorher = globalThis.fetch;
  globalThis.fetch = async (eingabe, init = {}) => {
    const url = String(eingabe);
    abrufe.push(new URL(url).pathname);
    if (url.includes('/nas/filelink.lua')) {
      zustand.gueltig = neue; // die Anmeldung wirft jede bestehende Sitzung raus
      return boxAntwort('text/html', `<html><body data-sid="${neue}"></body></html>`);
    }
    if (url.includes('/nas/api/data.lua')) {
      // Die Box, die eine unbekannte Nummer mit einer Umleitung auf die
      // Anmeldung beantwortet statt mit JSON - der gemeldete HTTP 303.
      if (box.umleitung) return new Response('', { status: 303, headers: { Location: '/nas/login.lua' } });
      const sid = new URLSearchParams(String(init.body || '')).get('sid');
      const daten = sid === zustand.gueltig ? { root: box.wurzel, rights: { read: true } } : { error: 'no session' };
      return boxAntwort('application/json', JSON.stringify(daten));
    }
    if (url.includes('/nas/cgi-bin/luacgi_notimeout')) {
      // Der Abruf, den der Echo macht - und den "Check URLs" und der Weckruf
      // nachstellen. Mit toter Nummer schickt die Box ihre Oberflaeche statt
      // der Datei.
      if (new URL(url).searchParams.get('sid') !== zustand.gueltig) {
        return boxAntwort('text/html', '<title>FRITZ!NAS</title>Anmeldung erforderlich');
      }
      // `ton` stellt die schlafende Platte nach: Sie antwortet nicht, obwohl
      // die Sitzung gilt - genau der Fall, fuer den es den Weckruf gibt.
      box.geweckt = url;
      box.weckkopf = init.headers || null;
      box.tonZaehler += 1;
      // Stellt die Box nach, die im Moment der Anmeldung noch liefert und
      // kurz darauf nicht mehr - der Fall, fuer den es den zweiten Weckruf gibt.
      if (box.nurEinmalTon && box.tonZaehler > 1) {
        return boxAntwort('text/html', '<title>FRITZ!NAS</title>Anmeldung erforderlich');
      }
      if (ton === 'keiner') {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      if (ton === 'oberflaeche') {
        return boxAntwort('text/html', '<title>FRITZ!NAS</title>Anmeldung erforderlich');
      }
      // Der Kopf kommt, die Tondaten nicht - die Box, die eine Datei
      // ankuendigt und dann nichts liefert. Genau das war siebzehnmal im Log
      // als "HTTP 206, audio/mpeg" verbucht.
      if (ton === 'kopfOhneTon') {
        return new Response(new ReadableStream({ start() { /* es kommt nichts */ } }), {
          status: 206,
          headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 0-32767/4096000' },
        });
      }
      return new Response(new Uint8Array(64), {
        status: 206,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Range': 'bytes 0-63/4096000',
          'Accept-Ranges': 'bytes',
        },
      });
    }
    throw new Error(`unerwarteter Abruf: ${url}`);
  };
  box.zurueck = () => { globalThis.fetch = vorher; };
  return box;
}

/** Der Skill mit einem Budget, das fuer Nachfrage und Anmeldung reicht. */
async function skillMitBudget(request, opts, redis) {
  const vorher = process.env.MUSIK_BUDGET_MS;
  process.env.MUSIK_BUDGET_MS = '6500';
  try {
    return await skill(request, opts, null, redis);
  } finally {
    process.env.MUSIK_BUDGET_MS = vorher;
  }
}

/** Eine FRITZ!NAS-Playlist an der Box oben, samt gemerkter Nummer von vorhin. */
function boxRedis(sid, alterMinuten) {
  return redisMit({
    [REDIS_KEY]: [{
      name: 'Udo CD eins',
      quelle: { typ: 'fritz', link: BOX_LINK },
      titel: [
        { url: boxTitel(1, sid), name: '01' },
        { url: boxTitel(2, sid), name: '02' },
      ],
    }],
    musik_fritz_sid: { link: BOX_LINK, sid, zeit: Date.now() - alterMinuten * 60_000 },
  });
}

const laufend = (token, offset = 0) => ({
  request: { type: 'AudioPlayer.PlaybackNearlyFinished', token },
  opts: { token, offset },
});

test('ein Stolperer bei gueltiger Nummer wird wiederholt, ohne die Box anzufassen', async () => {
  // Der gemeldete Fall: Sitzung gerade geprueft, Offset 1, und die Box
  // antwortet trotzdem mit 5xx. Dann ist die Last der wahrscheinlichste Grund,
  // und beim naechsten Versuch ist sie weg. Angemeldet wird dafuer nichts.
  const redis = boxRedis('aaaaaaaaaaaaaaaa', 6);
  const box = boxAmDraht('aaaaaaaaaaaaaaaa');
  try {
    const r = await skillMitBudget(
      {
        type: 'AudioPlayer.PlaybackFailed',
        token: 'Udo CD eins|0|0|0',
        error: { type: 'MEDIA_ERROR_INTERNAL_SERVER_ERROR', message: 'Device playback error' },
      },
      { token: 'Udo CD eins|0|0|0', offset: 1 },
      redis,
    );
    assert.ok(!box.abrufe.includes('/nas/filelink.lua'), 'ein Stolperer beendet nicht alle Sitzungen der Box');
    const stream = spielt(r).audioItem.stream;
    assert.equal(stream.token, 'Udo CD eins|0|0|0|1', 'derselbe Titel noch einmal');
    assert.equal(stream.offsetInMilliseconds, 0, 'er war nie angelaufen');
  } finally {
    box.zurueck();
  }
});

test('beim zweiten Fehler am selben Titel geht es weiter', async () => {
  // Die Gegenprobe zum Test darueber: Hilft die Wiederholung nicht, liegt es
  // nicht an der Last. Dann kostet ein dritter Versuch nur Zeit.
  const redis = boxRedis('aaaaaaaaaaaaaaaa', 6);
  const box = boxAmDraht('aaaaaaaaaaaaaaaa');
  try {
    const r = await skillMitBudget(
      {
        type: 'AudioPlayer.PlaybackFailed',
        token: 'Udo CD eins|0|0|0|1',
        error: { type: 'MEDIA_ERROR_INTERNAL_SERVER_ERROR', message: 'Device playback error' },
      },
      { token: 'Udo CD eins|0|0|0|1', offset: 1 },
      redis,
    );
    assert.ok(!box.abrufe.includes('/nas/filelink.lua'));
    // Der naechste Titel, Versuchsbudget wieder bei null - mit der 1 der
    // Straehne, damit nicht die ganze Playlist durchlaeuft, wenn gar nichts
    // mehr anlaeuft.
    assert.equal(spielt(r).audioItem.stream.token, 'Udo CD eins|1|0|0|0|1');
  } finally {
    box.zurueck();
  }
});

test('die Fehlerzeile nennt den Titel, nicht nur die Stelle in der Mischung', async () => {
  // **Warum das im Log stehen muss.** Gemeldet wurde
  // "Token: Udo|23|0|251337043" - und damit war nicht zu sagen, welche Datei
  // es getroffen hat: Mit Mischung ist Stelle 23 nicht Titel 24, und die
  // Reihenfolge steht nirgends, sie wird aus dem Seed gerechnet. Ohne den
  // Namen laesst sich die Zeile im Dashboard nicht nachschlagen.
  //
  // Bei drei Titeln und diesem Seed steht an Stelle 0 der Titel mit der
  // Nummer 1 - also "02", der zweite der Liste.
  const gesagt = [];
  const vorher = console.warn;
  console.warn = (...teile) => gesagt.push(teile.join(' '));
  try {
    await skill(
      {
        type: 'AudioPlayer.PlaybackFailed',
        token: 'Kinderlieder|0|0|251337043',
        error: { type: 'MEDIA_ERROR_INTERNAL_SERVER_ERROR', message: 'Device playback error' },
      },
      { token: 'Kinderlieder|0|0|251337043', offset: 1 },
    );
  } finally {
    console.warn = vorher;
  }

  const zeile = gesagt.find(z => z.startsWith('Alexa konnte nicht abspielen:'));
  assert.ok(zeile, 'der Fehler wird ueberhaupt protokolliert');
  assert.match(zeile, /Titel: 2\. 02 /, 'Nummer in der Liste und Name');
  assert.match(zeile, /Offset: 1\b/, 'der Offset trennt "nie angelaufen" von "mittendrin abgerissen"');
});

test('eine gekuerzte Playlist bringt die Fehlerzeile nicht durcheinander', async () => {
  // Stelle 9 gibt es in einer Liste mit drei Titeln nicht mehr. Dann wird kein
  // Titel genannt - und protokolliert wird trotzdem.
  const gesagt = [];
  const vorher = console.warn;
  console.warn = (...teile) => gesagt.push(teile.join(' '));
  try {
    await skill(
      {
        type: 'AudioPlayer.PlaybackFailed',
        token: 'Kinderlieder|9|0|0',
        error: { type: 'MEDIA_ERROR_INTERNAL_SERVER_ERROR', message: 'Device playback error' },
      },
      { token: 'Kinderlieder|9|0|0' },
    );
  } finally {
    console.warn = vorher;
  }

  const zeile = gesagt.find(z => z.startsWith('Alexa konnte nicht abspielen:'));
  assert.ok(zeile);
  assert.doesNotMatch(zeile, /Titel:/);
});

// --- Zahlwoerter: der Ein-Satz-Aufruf ----------------------------------------
//
// **Gemeldet:** "Alexa, oeffne meine Plattenkiste und spiele udo cd eins"
// funktioniert nicht zuverlaessig, teilweise kommt keine Musik. Der
// zweistufige Aufruf dagegen laeuft.
//
// Der Unterschied liegt nicht am Abspielen, sondern am Namen. Der Ein-Satz-
// Aufruf geht ueber SuchePlaylistIntent, und dessen Slot ist ein
// AMAZON.SearchQuery - ohne Entity Resolution, es kommt nur der gehoerte Text.
// Ob die Spracherkennung daraus "eins" oder "1" macht, entscheidet sie von Mal
// zu Mal anders. Beim zweistufigen Aufruf traegt die Antwort auf "oeffne meine
// Plattenkiste" die Namen als dynamische Werte mit, und Alexa loest dagegen
// auf; der Ein-Satz-Aufruf hat diese Liste nie bekommen.

test('normalisiere macht aus Zahlwoertern Ziffern', () => {
  assert.equal(normalisiere('Udo CD eins'), 'udocd1');
  assert.equal(normalisiere('Udo CD 1'), 'udocd1', 'beide Schreibweisen treffen sich');
  assert.equal(normalisiere('Udo CD zwei'), 'udocd2');
  assert.equal(normalisiere('udo cd zwo'), 'udocd2', 'auch die Telefon-Zwei');
  assert.equal(normalisiere('Kapitel zwoelf'), 'kapitel12');
});

test('normalisiere ersetzt nur ganze Woerter', () => {
  // "Kleinstadt" traegt ein "eins" in der Mitte. Wuerde blind ersetzt, hiesse
  // die Playlist fortan "kl1tadt" - und ein Tippfehler im Dashboard oder eine
  // leicht andere Aussprache traefe sie nicht mehr.
  assert.equal(normalisiere('Kleinstadt'), 'kleinstadt');
  assert.equal(normalisiere('Neunkirchen'), 'neunkirchen');
  assert.equal(normalisiere('Dreiklang'), 'dreiklang');
});

test('findePlaylist trifft die Playlist, egal ob Zahl oder Wort gesprochen wurde', () => {
  const listen = [
    { name: 'Udo CD eins', titel: [{ url: 'https://h.de/1.mp3', name: '1' }] },
    { name: 'Udo CD zwei', titel: [{ url: 'https://h.de/2.mp3', name: '2' }] },
  ];
  assert.equal(findePlaylist(listen, { value: 'Udo CD 1' }).playlist.name, 'Udo CD eins');
  assert.equal(findePlaylist(listen, { value: 'udo cd eins' }).playlist.name, 'Udo CD eins');
  assert.equal(findePlaylist(listen, { value: 'Udo CD 2' }).playlist.name, 'Udo CD zwei');
  // Die Gegenprobe: Eine Ziffer im Namen und ein Wort im Gesagten.
  const ziffer = [{ name: 'Udo CD 1', titel: [{ url: 'https://h.de/1.mp3', name: '1' }] }];
  assert.equal(findePlaylist(ziffer, { value: 'udo cd eins' }).playlist.name, 'Udo CD 1');
});

test('der Ein-Satz-Aufruf spielt auch, wenn Alexa die Ziffer verstanden hat', async () => {
  // Der gemeldete Satz, so wie er beim Skill ankommt: ein Intent, kein
  // LaunchRequest davor, keine aufgeloesten Werte - nur der gehoerte Text.
  const UDO = { name: 'Udo CD eins', titel: [{ url: 'https://example.org/u/01.mp3', name: '01' }] };
  const wort = await skill(sucheIntent('Udo CD eins'), {}, [UDO]);
  assert.equal(spielt(wort).audioItem.stream.token, 'Udo CD eins|0|0|0');

  const ziffer = await skill(sucheIntent('Udo CD 1'), {}, [UDO]);
  assert.equal(spielt(ziffer).audioItem.stream.token, 'Udo CD eins|0|0|0');
  assert.match(ziffer.outputSpeech.text, /Ich spiele Udo CD eins/, 'gesagt wird der richtige Name');
});

test('ein Name, den niemand kennt, steht im Log', async () => {
  // Bisher hinterliess der haeufigste Fehlschlag keine Spur: Von aussen war
  // nicht zu unterscheiden, ob die Box stumm blieb oder der Name nicht ankam.
  const gesagt = [];
  const vorher = console.warn;
  console.warn = (...teile) => gesagt.push(teile.join(' '));
  try {
    await skill(sucheIntent('Uter Zett'));
  } finally {
    console.warn = vorher;
  }
  const zeile = gesagt.find(z => z.startsWith('musik-box kennt'));
  assert.ok(zeile, 'der Fehlschlag wird protokolliert');
  assert.match(zeile, /"Uter Zett"/, 'was gehoert wurde');
  assert.match(zeile, /Kinderlieder=kinderlieder/, 'und wogegen verglichen wurde');
});

// --- Geraete ohne AudioPlayer ------------------------------------------------
//
// **Gemeldet vom Fire TV:** Alexa sagte "Ich spiele Udo CD eins weiter", und
// dann kam keine Musik. Der Skill hatte alles richtig gemacht - Playlist
// gefunden, Stand gelesen, Direktive geschickt -, nur nimmt ein Geraet ohne
// AudioPlayer eine Play-Direktive wortlos nicht an. Uebrig blieb der Satz, und
// der versprach etwas, das nicht kam.
//
// Was ein Geraet kann, steht in jeder Anfrage. Damit beantwortet die Anfrage
// selbst die Frage - statt einer Liste von Geraetetypen, die mit jeder
// Amazon-Generation veralten wuerde.

test('ein Geraet ohne AudioPlayer bekommt einen Satz statt eines Versprechens', async () => {
  const r = await skill(intent('PlayPlaylistIntent', 'Kinderlieder'), { geraet: ['VideoApp', 'Display'] });
  assert.ok(!r.directives?.some(d => d.type === 'AudioPlayer.Play'), 'keine Play-Direktive');
  assert.match(r.outputSpeech.text, /kann meine Musik leider nicht abspielen/);
  assert.doesNotMatch(r.outputSpeech.text, /Ich spiele/, 'nichts versprechen, was nicht kommt');
});

test('ein Echo spielt wie bisher', async () => {
  const r = await skill(intent('PlayPlaylistIntent', 'Kinderlieder'), { geraet: ['AudioPlayer'] });
  assert.ok(spielt(r), 'eine Play-Direktive ist dabei');
  assert.match(r.outputSpeech.text, /Ich spiele Kinderlieder/);
});

test('ohne Auskunft ueber das Geraet wird gespielt', async () => {
  // Der Rueckfall ist das bisherige Verhalten: Ein Geraet, das nichts ueber
  // sich sagt, ist kein Grund, ihm die Musik zu verweigern. Alle anderen Tests
  // in dieser Datei laufen ueber genau diesen Weg.
  const r = await skill(intent('PlayPlaylistIntent', 'Kinderlieder'));
  assert.ok(spielt(r), 'eine Play-Direktive ist dabei');
});

test('der Riegel gilt fuer jeden Weg, der Musik ausgeben will', async () => {
  const ohne = { geraet: ['VideoApp'] };
  for (const name of ['SuchePlaylistIntent', 'AMAZON.ResumeIntent', 'AMAZON.NextIntent',
    'AMAZON.PreviousIntent', 'AMAZON.StartOverIntent', 'AMAZON.ShuffleOnIntent']) {
    const req = name === 'SuchePlaylistIntent' ? sucheIntent('Kinderlieder') : intent(name);
    const r = await skill(req, { ...ohne, token: 'Kinderlieder|0|0|0' });
    assert.ok(!r.directives?.some(d => d.type === 'AudioPlayer.Play'), `${name}: keine Play-Direktive`);
    assert.match(r.outputSpeech.text, /nicht abspielen/, `${name}: und ein Satz dazu`);
  }
});

test('was ohne AudioPlayer trotzdem geht, geht weiter', async () => {
  // Die Liste vorlesen, die Hilfe, Pause und Stopp brauchen keinen AudioPlayer -
  // ein Riegel davor waere reine Schikane.
  const ohne = { geraet: ['VideoApp'] };
  assert.match((await skill(intent('ListPlaylistsIntent'), ohne)).outputSpeech.text, /Kinderlieder/);
  assert.match((await skill(intent('AMAZON.HelpIntent'), ohne)).outputSpeech.text, /spiele/i);
  assert.deepEqual((await skill(intent('AMAZON.StopIntent'), ohne)).directives, [{ type: 'AudioPlayer.Stop' }]);
});

// --- Der Start traut der Frist nicht -----------------------------------------
//
// **Gemeldet:** Ein stummer Start, und im Log nur drei Zeilen:
//
//   musik-box Geraet kann: AudioPlayer
//   musik-box spielt Udo CD eins (gehoert: "udo cd eins") ab 8/13 bei 0 ms: … sid…a9ef
//   musik-box IntentRequest in 34 ms
//
// Vierunddreissig Millisekunden: kein Login (rund 1550 ms), keine Nachfrage
// (rund 640 ms), keine Zeile darueber. Der Skill nahm die gemerkte Nummer, weil
// ihre Fuenf-Minuten-Frist noch lief.
//
// Die Frist misst aber Zeit, und auf dieser Box stirbt eine Sitzung nicht an
// Zeit, sondern an Ereignissen: eine Anmeldung fuer die zweite Freigabe, ein
// Import, die FRITZ!NAS-Oberflaeche. Waehrend gespielt wird, faellt das kaum
// ins Gewicht - der Echo haelt die Sitzung mit jedem Bereichsabruf selbst am
// Leben, und ein Fehler kostet einen Titel. Vor dem ersten Ton haelt sie
// niemand, und ein Fehler kostet die ganze Antwort.

// --- Der Weckruf an die Datei ------------------------------------------------
//
// **Gemeldet:** Nach einer laengeren Pause bleibt der erste Versuch stumm, der
// zweite spielt. Die beiden Logs sind bis auf die Sitzungsbeschaffung gleich:
//
//   musik-box FRITZ!NAS-Login ok nach 2039 ms, 4338 ms Budget uebrig
//   musik-box spielt Das doppelte Lottchen … ab 1/9 bei 2808 ms: … sid…95f3
//
//   musik-box FRITZ!NAS-Sitzung nachgefragt: gilt noch nach 946 ms, …
//   musik-box spielt Das doppelte Lottchen … ab 1/9 bei 2808 ms: … sid…95f3
//
// Dieselbe Nummer, dieselbe Adresse, derselbe Offset - der zweite Versuch
// bekam Byte fuer Byte, was der erste bekam. An der Antwort des Skills kann es
// also nicht liegen. Was der erste Versuch geaendert hat, ist die Platte der
// Box: Sein Abruf hat sie aufgeweckt und ist dabei selbst in Alexas Ladefrist
// gelaufen. Deshalb weckt sie jetzt der Skill, bevor er etwas verspricht.

// --- Das Budget rechnet ab Alexa, nicht ab dem ersten Befehl -----------------
//
// **Der blinde Fleck hinter "geht erst beim zweiten Versuch".** Gemeldet war
// ein stummer Start, bei dem alles stimmte, was der Skill selbst sehen kann:
//
//   musik-box FRITZ!NAS-Login ok nach 1951 ms, 4426 ms Budget uebrig
//   musik-box Geraet kann: AudioPlayer
//   musik-box spielt Das doppelte Lottchen … ab 1/9 bei 0 ms: … sid…f154
//   musik-box Datei angetippt: HTTP 206, audio/mpeg nach 613 ms, 3798 ms Budget
//   musik-box IntentRequest in 2705 ms
//
// Sitzung gueltig, Datei in 613 ms abrufbar, Geraet kann AudioPlayer - und
// danach kein einziges AudioPlayer-Ereignis. Der Echo hat die Direktive nie
// zu sehen bekommen. Was das Log nicht zeigte: die Zeit **vor** dem ersten
// Befehl. Das Budget begann bei Null zu zaehlen, obwohl der Kaltstart der
// Function da schon gelaufen war - der Skill rechnete mit Sekunden, die es
// nicht mehr gab, und liess den Login noch durchgehen.

test('alexaVorlaufMs misst, was vor dem Skill lag', () => {
  const jetzt = Date.parse('2026-09-19T20:00:05.000Z');
  assert.equal(alexaVorlaufMs({ request: { timestamp: '2026-09-19T20:00:00.000Z' } }, jetzt), 5000);
  assert.equal(alexaVorlaufMs({ request: { timestamp: '2026-09-19T20:00:05.000Z' } }, jetzt), 0);
});

test('alexaVorlaufMs traut zwei Uhren nicht weiter als noetig', () => {
  const jetzt = Date.parse('2026-09-19T20:00:05.000Z');
  // Eine Uhr, die vorgeht: Der Zeitstempel liegt in der Zukunft.
  assert.equal(alexaVorlaufMs({ request: { timestamp: '2026-09-19T20:00:09.000Z' } }, jetzt), null);
  // Und eine, die weit nachgeht - daraus ein Budget zu rechnen waere schlimmer
  // als gar keines.
  assert.equal(alexaVorlaufMs({ request: { timestamp: '2026-09-19T19:59:00.000Z' } }, jetzt), null);
  assert.equal(alexaVorlaufMs({ request: {} }, jetzt), null, 'ohne Zeitstempel gilt das volle Fenster');
  assert.equal(alexaVorlaufMs({}, jetzt), null);
});

// --- Abstand zwischen Anmeldung und dem Abruf des Echos ----------------------
//
// **Das Ergebnis des Ausschlussverfahrens.** Gemessen und bestaetigt:
//
//   * Die Antwort kommt rechtzeitig an - "Alexa wartet seit 3683 ms" von 8000.
//   * Alexa spricht den Satz, die Direktive wird also angenommen.
//   * Das Geraet meldet AudioPlayer und spielt nach derselben langen Pause
//     eine Playlist von einem anderen Server ohne Zoegern.
//   * Der Weckruf des Skills kommt 668 ms nach der Anmeldung noch durch.
//   * Der Abruf des Echos, ein bis zwei Sekunden spaeter, nicht mehr.
//   * Eine Minute danach spielt dieselbe Adresse mit derselben Nummer.
//
// Uebrig bleibt die Box in den Sekunden nach `filelink.lua` ohne Sitzung - dem
// Aufruf, der laut AVM alle Sitzungen beendet. Der Abstand schiebt den Abruf
// des Echos von diesem Moment weg; der zweite Weckruf sagt im Log, ob die Box
// dann noch liefert.

// --- Atempause vor dem naechsten Anlauf --------------------------------------
//
// **Gemeldet:** `MEDIA_ERROR_INTERNAL_SERVER_ERROR`, `Offset: 1`, Titel 4 von
// "Udo CD eins", Sitzung gerade geprueft ("gilt noch") - und danach spielte die
// Musik nicht mehr. Sitzung und Datei waren in Ordnung; was fehlte, war Luft.
// Der Wiederholversuch lief sofort los und traf damit dieselbe ueberlastete
// Box, der naechste Titel danach wieder, bis die Runde herum war.

// --- Die Warteschlange vor einem Start leeren --------------------------------
//
// **Der bekannte Kniff gegen einen Echo, der stumm auf altem Zustand sitzt.**
// `REPLACE_ALL` ersetzt die Warteschlange ohnehin; `ClearQueue` davor raeumt
// sie ausdruecklich ab.
//
// **Die These dahinter ist schwach, und das steht hier absichtlich.** Gemessen
// ist, dass derselbe Echo nach derselben langen Pause eine Playlist von einem
// anderen Server beim ersten Versuch spielt - ein haengender Warteschlangen-
// Zustand waere dort genauso im Weg gewesen. Der Kniff kostet nichts, aber er
// behebt vermutlich nicht das, was hier stumm bleibt.

test('vor einem Start steht das Leeren der Warteschlange', async () => {
  const r = await skill(intent('PlayPlaylistIntent', 'Kinderlieder'));
  assert.deepEqual(r.directives[0], { type: 'AudioPlayer.ClearQueue', clearBehavior: 'CLEAR_ALL' });
  // Die Reihenfolge ist der ganze Zweck: erst abraeumen, dann spielen.
  assert.equal(r.directives[1].type, 'AudioPlayer.Play');
});

test('auch "weiter" und "von vorn" raeumen erst ab', async () => {
  for (const name of ['AMAZON.ResumeIntent', 'AMAZON.StartOverIntent']) {
    const r = await skill(intent(name), { token: 'Kinderlieder|0|0|0', offset: 5000 });
    assert.equal(r.directives[0].type, 'AudioPlayer.ClearQueue', name);
    assert.ok(spielt(r), `${name}: und gespielt wird auch`);
  }
});

test('beim Titelwechsel wird NICHT geleert', async () => {
  // Der naechste Titel wird mit ENQUEUE angehaengt - eine geleerte
  // Warteschlange davor wuerde genau das abraeumen, was gerade entsteht.
  const r = await skill(
    { type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Kinderlieder|0|0|0' },
    { token: 'Kinderlieder|0|0|0' },
  );
  assert.ok(!r.directives.some(d => d.type === 'AudioPlayer.ClearQueue'), 'kein ClearQueue');
  assert.equal(spielt(r).playBehavior, 'ENQUEUE');
});

test('mitten in der Wiedergabe wird nicht geleert', async () => {
  // "Naechster Titel" und Mischen passieren in einer laufenden Wiedergabe.
  // Dort gibt es keinen alten Zustand, auf dem jemand sitzen bleiben koennte.
  for (const name of ['AMAZON.NextIntent', 'AMAZON.ShuffleOnIntent']) {
    const r = await skill(intent(name), { token: 'Kinderlieder|0|0|0' });
    assert.ok(!r.directives.some(d => d.type === 'AudioPlayer.ClearQueue'), name);
  }
});

test('das Leeren laesst sich abschalten', async () => {
  // Weil die These schwach ist: MUSIK_CLEAR_QUEUE=0 nimmt es wieder heraus,
  // ohne Deploy.
  const vorher = process.env.MUSIK_CLEAR_QUEUE;
  process.env.MUSIK_CLEAR_QUEUE = '0';
  try {
    const r = await skill(intent('PlayPlaylistIntent', 'Kinderlieder'));
    assert.deepEqual(r.directives.map(d => d.type), ['AudioPlayer.Play']);
  } finally {
    process.env.MUSIK_CLEAR_QUEUE = vorher;
  }
});

// --- Das Eilziel: was entbehrlich ist, weicht der Antwortzeit ----------------
//
// **Nicht Alexas Fenster entscheidet, sondern eine viel engere Grenze.** Alexa
// hat jede Antwort angenommen und den Satz gesprochen; ob der Echo die
// Play-Direktive danach ausfuehrt, ist eine andere Frage. Gemessen an einem
// Echo, der laenger untaetig war:
//
//   stumm:   3683, 3846, 4537, 5204, 5771 ms  - und kein einziges
//                                               AudioPlayer-Ereignis danach
//   spielt:  1868, 2524 ms                    - PlaybackStarted nach 18 ms
//
// Der Echo hat es auf der stummen Seite nicht einmal versucht. Was dazwischen
// anders war, ist nichts als die Zeit.

// --- Nur wer eine Adresse herausgibt, frischt die Sitzung auf ----------------
//
// **Gemeldet aus einem Log mit genau zwei Zeilen:**
//
//   musik-box FRITZ!NAS-Login ok nach 1572 ms, 4355 ms Budget uebrig
//   musik-box IntentRequest in 1603 ms
//
// Kein "Geraet kann", kein "spielt" - ein Intent, der nichts abspielt. Und
// trotzdem eine Anmeldung, die alle Sitzungen der Box beendet, waehrend der
// Echo gerade streamte. Die Auffrischung lief fuer jede Anfrage, weil
// `gemeintePlaylist` ohne Slot auf den laufenden Stream zurueckfaellt.

// --- Die Anmeldung ohne Gegenprobe ------------------------------------------
//
// Zwei Wege zur Box, gemessen 1443 bis 2635 ms zusammen - vor dem ersten Ton
// der groesste Posten. Die Gegenprobe ist die entbehrlichere Haelfte: Die
// erste Nummer stammt aus der Antwort, die die Box gerade auf diese Anmeldung
// gegeben hat. Und ein Irrtum traegt sich selbst, ueber PlaybackFailed.


// --- Der Verlauf: was der Echo meldet, neben dem, was geliefert wurde ------
//
// **Drei Runden lang wurde die Ursache des Abbruchs geraten**, weil die
// entscheidende Zeile nur im Log von Vercel stand. Der Durchleiter schreibt
// seine Zahlen jetzt in den Verlauf (siehe test/naston.test.mjs); hier ist
// die andere Haelfte: Ein `PlaybackStopped` unmittelbar hinter einem
// unvollstaendigen Ton ist ein abgerissener Strom - eines ohne solchen
// Eintrag kam vom Echo selbst.

/** Ein Redis, das auch Listen kann - der Verlauf liegt in einer. */
function redisMitListe(daten = {}) {
  const redis = redisMit(daten);
  const liste = [];
  return {
    ...redis,
    liste,
    async lpush(_k, eintrag) { liste.unshift(eintrag); },
    async ltrim() {},
    async expire() {},
    async lrange() { return liste; },
    async del() { liste.length = 0; },
  };
}

test('ein Abspieler-Ereignis landet im Verlauf', async () => {
  const redis = redisMitListe({ [REDIS_KEY]: [KINDER] });
  await skill(
    { type: 'AudioPlayer.PlaybackStopped', token: 'Kinderlieder|1|0|0' },
    { token: 'Kinderlieder|1|0|0', offset: 42000 },
    [KINDER], redis,
  );

  const [eintrag] = redis.liste;
  assert.ok(eintrag, 'es gibt einen Eintrag');
  assert.equal(eintrag.was, 'echo');
  assert.equal(eintrag.ereignis, 'PlaybackStopped', 'das Ereignis, an dem die Kette endet');
  assert.equal(eintrag.offset, 42000, 'und an welcher Stelle');
});

test('ein "weiter" landet mit seiner Quelle im Verlauf', async () => {
  // **Die Zeile, die bei der Meldung gefehlt hat.** Der Verlauf hielt nur
  // Abspieler-Ereignisse fest; welcher Befehl die Wiedergabe angefangen hat,
  // mit welcher Stelle und aus welcher Quelle, stand nirgends - und genau das
  // war die Frage.
  const redis = redisMitListe({ [REDIS_KEY]: [HOERSPIEL], musik_stand: { 'hörspiel': { position: 1, runde: 0, seed: 0, offset: 600000 } } });
  await skill(intent('AMAZON.ResumeIntent'), { token: 'Hörspiel|1|0|0', offset: 0, aktivitaet: 'STOPPED' }, null, redis);

  const [eintrag] = redis.liste;
  assert.equal(eintrag.was, 'wort');
  assert.equal(eintrag.ereignis, 'ResumeIntent', 'ohne den AMAZON-Vorsatz');
  assert.equal(eintrag.offset, 595000, 'die Stelle, die hinausging');
  assert.equal(eintrag.woher, 'stand', 'und woher sie kam');
  assert.equal(eintrag.gangart, 'sekunde');
  assert.equal(eintrag.aktivitaet, 'STOPPED', 'protokolliert, nicht verzweigt');
  assert.match(eintrag.antwort, /Play REPLACE_ALL -> 02/, 'und was hinausging');
});

test('ein Stopp landet mit der gemerkten Stelle im Verlauf', async () => {
  const redis = redisMitListe({ [REDIS_KEY]: [HOERSPIEL] });
  await skill(intent('AMAZON.StopIntent'), { token: 'Hörspiel|1|0|0', offset: 42000 }, null, redis);

  const [eintrag] = redis.liste;
  assert.equal(eintrag.was, 'wort');
  assert.equal(eintrag.ereignis, 'StopIntent');
  assert.equal(eintrag.offset, 42000);
  assert.match(eintrag.stand, /42000 ms gemerkt/, 'und dass sie wirklich angekommen ist');
});

test('der Knopf in der App landet auch im Verlauf', async () => {
  const redis = redisMitListe({ [REDIS_KEY]: [HOERSPIEL] });
  await skill({ type: 'PlaybackController.PauseCommandIssued' }, { token: 'Hörspiel|1|0|0', offset: 42000 }, null, redis);
  assert.equal(redis.liste[0].ereignis, 'PauseCommandIssued');
});

test('die Hilfe fuellt den Verlauf nicht', async () => {
  // Vierzig Eintraege sind ein Zeuge, kein Archiv: Ein paar missverstandene
  // Saetze schoeben sonst genau die Ereignisse aus dem Fenster, die eine
  // Stoerung erklaeren.
  const redis = redisMitListe({ [REDIS_KEY]: [KINDER] });
  await skill(intent('AMAZON.HelpIntent'), {}, [KINDER], redis);
  await skill(intent('ListPlaylistsIntent'), {}, [KINDER], redis);
  assert.equal(redis.liste.length, 0);
});

test('der Verlauf nimmt bei einem Abspieler-Ereignis die Stelle aus dem Ereignis', async () => {
  // Hier stand der Offset aus dem `context`, und der traegt bei einem
  // Abspieler-Ereignis gern eine Null - die Zeile untertrieb also genau dort,
  // wo sie gebraucht wurde.
  const redis = redisMitListe({ [REDIS_KEY]: [KINDER] });
  await skill(
    { type: 'AudioPlayer.PlaybackStopped', token: 'Kinderlieder|1|0|0', offsetInMilliseconds: 42000 },
    { token: 'Kinderlieder|1|0|0', offset: 0 },
    [KINDER], redis,
  );
  assert.equal(redis.liste[0].offset, 42000);
});

test('ein Fehlschlag traegt seinen Grund in den Verlauf', async () => {
  const redis = redisMitListe({ [REDIS_KEY]: [KINDER] });
  await skill(
    {
      type: 'AudioPlayer.PlaybackFailed',
      token: 'Kinderlieder|0|0|0',
      error: { type: 'MEDIA_ERROR_INTERNAL_SERVER_ERROR', message: 'nope' },
    },
    { token: 'Kinderlieder|0|0|0' },
    [KINDER], redis,
  );

  const [eintrag] = redis.liste;
  assert.equal(eintrag.ereignis, 'PlaybackFailed');
  assert.equal(eintrag.fehler, 'MEDIA_ERROR_INTERNAL_SERVER_ERROR', 'der Grund, den Alexa nennt');
});

test('/api/manage?verlauf=1 gibt die Eintraege heraus, neueste zuerst', async () => {
  const redis = redisMitListe({ [REDIS_KEY]: [KINDER] });
  await redis.lpush('musik_ton_verlauf', { zeit: 1, was: 'ton', bytes: 10, soll: 20 });
  await redis.lpush('musik_ton_verlauf', { zeit: 2, was: 'echo', ereignis: 'PlaybackStopped' });

  const res = antwortFaenger();
  await handleManage({ method: 'GET', query: { type: 'playlists', verlauf: '1' } }, res, redis);
  assert.equal(res.body.eintraege.length, 2);
  assert.equal(res.body.eintraege[0].zeit, 2, 'neueste zuerst');
});

test('DELETE .../manage?verlauf=1 leert den Verlauf, laesst die Playlists in Ruhe', async () => {
  const redis = redisMitListe({ [REDIS_KEY]: [KINDER] });
  await redis.lpush('musik_ton_verlauf', { zeit: 1, was: 'ton', bytes: 10, soll: 20 });

  const res = antwortFaenger();
  await handleManage({ method: 'DELETE', query: { type: 'playlists', verlauf: '1' } }, res, redis);

  assert.deepEqual(res.body, { success: true });
  assert.deepEqual(redis.liste, [], 'der Verlauf ist leer');
  assert.deepEqual(redis.speicher[REDIS_KEY], [KINDER], 'die Playlists blieben unberuehrt');
});

test('ein DELETE mit Playlist-Namen loescht weiterhin nur die Playlist, nicht den Verlauf', async () => {
  const redis = redisMitListe({ [REDIS_KEY]: [KINDER] });
  await redis.lpush('musik_ton_verlauf', { zeit: 1, was: 'ton', bytes: 10, soll: 20 });

  const res = antwortFaenger();
  await handleManage({ method: 'DELETE', query: {}, body: { name: 'Kinderlieder' } }, res, redis);

  assert.deepEqual(redis.speicher[REDIS_KEY], [], 'die Playlist ist weg');
  assert.equal(redis.liste.length, 1, 'der Verlauf steht unveraendert da');
});

test('ohne laufende Lieferung prueft der Knopf wie bisher', async () => {
  const fritzPl = {
    name: 'Lottchen',
    quelle: { typ: 'fritz', link: 'https://abc.myfritz.net:456/nas/filelink.lua?id=535f52fbb2016f4f' },
    titel: [{ url: 'https://203.0.113.10/api/skill?ton=x', name: '1' }],
  };
  const redis = redisMitListe({ [REDIS_KEY]: [fritzPl] });

  const echt = globalThis.fetch;
  let geholt = 0;
  globalThis.fetch = async () => {
    geholt += 1;
    return new Response(Buffer.alloc(32768), {
      status: 206,
      headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-32767/1000000' },
    });
  };
  try {
    const res = antwortFaenger();
    await handleManage(
      { method: 'GET', query: { type: 'playlists', pruefen: '1', name: 'Lottchen' } }, res, redis,
    );
    assert.equal(res.body.gesperrt, undefined, 'keine Sperre');
    assert.equal(geholt, 1, 'und der Titel wurde geprueft');
  } finally {
    globalThis.fetch = echt;
  }
});

test('der Verlauf traegt, was der Skill geantwortet hat', async () => {
  // **Die blinde Stelle, die fuenf Runden gekostet hat.** Am Echo sieht
  // "keine Direktive geschickt" genauso aus wie "Alexa hat sie abgelehnt":
  // Stille. Im Verlauf steht jetzt, was hinausging.
  const redis = redisMitListe({ [REDIS_KEY]: [KINDER] });
  await skill(
    { type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Kinderlieder|0|0|0' },
    { token: 'Kinderlieder|0|0|0' },
    [KINDER], redis,
  );

  const [eintrag] = redis.liste;
  assert.equal(eintrag.ereignis, 'PlaybackNearlyFinished');
  assert.match(eintrag.antwort, /^Play ENQUEUE/, 'die Bestellung steht da');
});

test('eine Antwort ohne Direktive ist als solche zu erkennen', async () => {
  const redis = redisMitListe({ [REDIS_KEY]: [KINDER] });
  await skill(
    { type: 'AudioPlayer.PlaybackFinished', token: 'Kinderlieder|0|0|0' },
    { token: 'Kinderlieder|0|0|0' },
    [KINDER], redis,
  );

  const [eintrag] = redis.liste;
  assert.equal(eintrag.antwort, 'keine Direktive',
    'am Titelende wird nichts bestellt - und das steht so da, statt zu fehlen');
});

test('Alexas eigene Beschwerde landet im Verlauf', async () => {
  // System.ExceptionEncountered ist die einzige Stelle, an der Alexa sagt,
  // dass sie unsere Antwort nicht angenommen hat. Bisher stand sie nur im
  // Log von Vercel - also genau dort, wo niemand nachsieht.
  const redis = redisMitListe({ [REDIS_KEY]: [KINDER] });
  const echterFehler = console.error;
  console.error = () => {};
  try {
    await skill(
      {
        type: 'System.ExceptionEncountered',
        error: { type: 'INVALID_RESPONSE', message: 'directive not accepted' },
        cause: { requestId: 'amzn1.echo-api.request.42' },
      },
      {}, [KINDER], redis,
    );
  } finally {
    console.error = echterFehler;
  }

  const [eintrag] = redis.liste;
  assert.equal(eintrag.ereignis, 'ExceptionEncountered');
  assert.equal(eintrag.fehler, 'INVALID_RESPONSE');
  assert.match(eintrag.ursache, /request\.42/, 'samt Ursache');
});
