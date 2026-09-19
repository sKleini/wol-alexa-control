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
  groesseAusContentRange,
  lesbareGroesse,
  spieldauerSekunden,
  lesbareDauer,
  laengerAlsSitzung,
  adresseKurz,
  handleSkill,
  handleManage,
  fritzSidMerken,
  istAudioUrl,
  audioLinksAusHtml,
  audioNamenImText,
  seitenDiagnose,
  sortierePlaylists,
  REDIS_KEY,
} from '../lib/musik.js'

// --- Helfer -----------------------------------------------------------------

function redisMit(daten = {}) {
  const speicher = { ...daten };
  return {
    speicher,
    async get(key) { return speicher[key] ?? null; },
    async set(key, wert) { speicher[key] = wert; },
  };
}

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

function anfrage(request, { token, offset = 0 } = {}) {
  const body = {
    context: { System: { application: { applicationId: 'amzn1.ask.skill.musik' } } },
    request: { timestamp: new Date().toISOString(), ...request },
  };
  if (token) body.context.AudioPlayer = { token, offsetInMilliseconds: offset, playerActivity: 'PLAYING' };
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
  assert.deepEqual(tokenLesen('Kinderlieder|2|1|4711'), { name: 'Kinderlieder', position: 2, runde: 1, seed: 4711 });
  assert.equal(tokenLesen('fremd'), null);
  assert.equal(tokenLesen('a|x|1|0'), null);
  assert.equal(tokenLesen('a|-1|1|0'), null);
  assert.equal(tokenLesen('a|0|0|-1'), null);
  assert.equal(tokenLesen(undefined), null);
});

test('Ein Token aus der Zeit vor der Mischung bleibt lesbar', () => {
  // Ein Stream, der beim Deploy noch laeuft, traegt drei Teile. Wuerde der
  // ploetzlich als fremd gelten, braeche die Wiedergabe mitten im Titel ab.
  assert.deepEqual(tokenLesen('Kinderlieder|1|2'), { name: 'Kinderlieder', position: 1, runde: 2, seed: 0 });
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
  assert.equal(r.directives.length, 1);
  assert.equal(r.directives[0].playBehavior, 'REPLACE_ALL');
  assert.equal(r.directives[0].audioItem.stream.token, 'Kinderlieder|0|0|0');
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
  assert.equal(r.directives[0].audioItem.stream.token, 'Kinderlieder|0|1|0');
  assert.equal(r.directives[0].audioItem.stream.url, KINDER.titel[0].url);
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
  assert.equal(weiter.directives[0].audioItem.stream.token, 'Kinderlieder|1|0|0');
  assert.equal(weiter.directives[0].audioItem.stream.offsetInMilliseconds, 25000);
});

test('Weiter ohne laufenden Stream fragt nach der Playlist', async () => {
  const r = await skill(intent('AMAZON.ResumeIntent'));
  assert.match(r.outputSpeech.text, /Es laeuft gerade nichts/);
});

test('Naechster und voriger Titel - per Sprache und per Knopf', async () => {
  const n = await skill(intent('AMAZON.NextIntent'), { token: 'Kinderlieder|0|0|0' });
  assert.equal(n.directives[0].audioItem.stream.token, 'Kinderlieder|1|0|0');
  const v = await skill({ type: 'PlaybackController.PreviousCommandIssued' }, { token: 'Kinderlieder|0|0|0' });
  assert.equal(v.directives[0].audioItem.stream.token, 'Kinderlieder|2|1|0');
  assert.equal(v.outputSpeech, undefined);
});

test('PlaybackFailed springt weiter, aber nicht ueber das Ende der Runde hinaus', async () => {
  const mitte = await skill({ type: 'AudioPlayer.PlaybackFailed', token: 'Kinderlieder|0|0|0', error: { type: 'MEDIA_ERROR_UNKNOWN' } });
  assert.equal(mitte.directives[0].audioItem.stream.token, 'Kinderlieder|1|0|0');
  const ende = await skill({ type: 'AudioPlayer.PlaybackFailed', token: 'Kinderlieder|2|0|0', error: { type: 'MEDIA_ERROR_UNKNOWN' } });
  assert.deepEqual(ende.directives, [{ type: 'AudioPlayer.Stop' }]);
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

test('adresseKurz verraet die Sitzungsnummer nicht', () => {
  const url = 'https://box.myfritz.net:456/nas/cgi-bin/luacgi_notimeout?sid=abcdef1234567890&c=music';
  const kurz = adresseKurz(url);
  assert.match(kurz, /box\.myfritz\.net:456/, 'Host und Port stehen drin');
  assert.match(kurz, /sid…7890/, 'nur die letzten vier Stellen');
  assert.doesNotMatch(kurz, /abcdef123456/, 'der Rest der Nummer nicht');
  assert.equal(adresseKurz('kaputt'), '(keine gueltige Adresse)');
  assert.match(adresseKurz('https://h.de/a.mp3'), /ohne sid/);
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
  assert.equal(r.directives[0].audioItem.stream.token, 'Taschenlampe|0|0|0');
});

test('SuchePlaylistIntent uebersteht Fuellwoerter im freien Text', async () => {
  const neu = { name: 'Taschenlampe', titel: [{ url: 'https://example.org/t.mp3', name: 't' }] };
  for (const gesagt of ['die taschenlampe', 'mal die taschenlampe bitte', 'taschen lampe']) {
    const r = await skill(sucheIntent(gesagt), {}, [KINDER, neu]);
    assert.equal(r.directives?.[0]?.audioItem.stream.token, 'Taschenlampe|0|0|0', gesagt);
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
  assert.equal(r.directives.length, 1);
  assert.equal(r.directives[0].playBehavior, 'REPLACE_ALL');
  assert.equal(r.directives[0].audioItem.stream.token, 'Leise|0|0|0');
});

test('Mit Ansage bleibt der Satz vor der Musik', async () => {
  const r = await skill(intent('PlayPlaylistIntent', 'kinderlieder'));
  assert.equal(r.outputSpeech.text, 'Ich spiele Kinderlieder.');
  assert.equal(r.directives[0].audioItem.stream.token, 'Kinderlieder|0|0|0');
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
  assert.equal(r.directives[0].audioItem.stream.token, 'Einmal|1|0|0');
});

test('Ohne Wiederholung stoppt naechster Titel am Ende und bleibt am Anfang stehen', async () => {
  const ende = await skill(intent('AMAZON.NextIntent'), { token: 'Einmal|2|0|0' }, [EINMAL]);
  assert.deepEqual(ende.directives, [{ type: 'AudioPlayer.Stop' }]);

  const anfang = await skill(intent('AMAZON.PreviousIntent'), { token: 'Einmal|0|0|0' }, [EINMAL]);
  assert.equal(anfang.directives[0].audioItem.stream.token, 'Einmal|0|0|0');
});

// --- Das Mikrofon nach dem Befehl -------------------------------------------

test('Jeder Sprachbefehl schliesst die Sitzung', async () => {
  // **Warum das eine eigene Zeile braucht.** Ein fehlendes `shouldEndSession`
  // heisst fuer Alexa nicht "beenden", sondern "lass es, wie es ist" - und
  // nach dem zweistufigen Aufruf ("oeffne meine Plattenkiste" … "spiele
  // Kinderlieder") steht es offen. Die Antworten hier tragen keine Sprache und
  // sahen deshalb harmlos aus; in Wahrheit horchte der Echo nach jedem
  // erledigten Befehl noch einmal.
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
  assert.equal(r.directives[0].audioItem.stream.token, 'Hörspiel|2|0|0');
  assert.equal(r.directives[0].audioItem.stream.offsetInMilliseconds, 60000, 'fuenf Sekunden Vorlauf');
});

test('Am Anfang stehengeblieben heisst nicht "weiter"', async () => {
  const redis = mitStand(HOERSPIEL, { position: 0, runde: 0, seed: 0, offset: 0 });
  const r = await skill(sucheIntent('hörspiel'), {}, null, redis);
  assert.equal(r.outputSpeech.text, 'Ich spiele Hörspiel.');
});

test('Ein Stand jenseits der gekuerzten Playlist faellt auf den Anfang', async () => {
  const redis = mitStand(HOERSPIEL, { position: 9, runde: 0, seed: 0, offset: 1000 });
  const r = await skill(sucheIntent('hörspiel'), {}, null, redis);
  assert.equal(r.directives[0].audioItem.stream.token, 'Hörspiel|0|0|0');
  assert.equal(r.directives[0].audioItem.stream.offsetInMilliseconds, 0);
});

test('Beim Fortsetzen gilt der gemerkte Seed weiter', async () => {
  // Nur mit demselben Seed steht an dieser Stelle wieder derselbe Titel.
  const redis = mitStand({ ...HOERSPIEL, zufall: true }, { position: 1, runde: 0, seed: 2024, offset: 0 });
  const r = await skill(sucheIntent('hörspiel'), {}, null, redis);
  assert.equal(r.directives[0].audioItem.stream.token, 'Hörspiel|1|0|2024');
  assert.equal(r.directives[0].audioItem.stream.url, KINDER.titel[reihenfolge(3, 2024)[1]].url);
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
  assert.equal(redis.speicher.musik_stand['hörspiel'].fertig, true);

  const neu = await skill(sucheIntent('hörspiel'), {}, null, redis);
  assert.equal(neu.outputSpeech.text, 'Ich spiele Hörspiel.');
  assert.equal(neu.directives[0].audioItem.stream.token, 'Hörspiel|0|0|0');
  assert.equal(neu.directives[0].audioItem.stream.offsetInMilliseconds, 0);
});

// Der Vermerk statt des Loeschens ist der Grund, warum dieser Test existiert:
// Der letzte Titel laeuft beim NearlyFinished noch, und sein Stopp kam frueher
// hinterher und legte die Stelle am Ende der Playlist wieder an.
test('Ein Stopp nach dem Durchlauf legt keine Stelle am Ende mehr an', async () => {
  const redis = mitStand(HOERSPIEL, { position: 2, runde: 0, seed: 0, offset: 5000 });
  await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Hörspiel|2|0|0' }, {}, null, redis);
  await skill({ type: 'AudioPlayer.PlaybackStopped', token: 'Hörspiel|2|0|0', offsetInMilliseconds: 178000 }, {}, null, redis);
  assert.equal(redis.speicher.musik_stand['hörspiel'].fertig, true);
  assert.equal(redis.speicher.musik_stand['hörspiel'].position, 0);
});

// Eine Playlist, die weiterhoert UND sich wiederholt - fuer den Endspurt, in
// dem Alexa den naechsten Titel schon angehaengt hat.
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
  assert.equal(r.directives[0].audioItem.stream.token, 'Hörspiel|1|0|0');
  assert.equal(r.directives[0].audioItem.stream.offsetInMilliseconds, 25000);
});

test('Ein Stand kurz nach dem Titelanfang ist keiner', async () => {
  // Drei Sekunden minus Vorlauf sind null - und bei null am ersten Titel
  // waere "weiter" eine Uebertreibung.
  const redis = mitStand(HOERSPIEL, { position: 0, runde: 0, seed: 0, offset: 3000 });
  const r = await skill(sucheIntent('hörspiel'), {}, null, redis);
  assert.equal(r.outputSpeech.text, 'Ich spiele Hörspiel.');
  assert.equal(r.directives[0].audioItem.stream.offsetInMilliseconds, 0);
});

test('MUSIK_VORLAUF_MS bestimmt den Vorlauf', async () => {
  const vorher = process.env.MUSIK_VORLAUF_MS;
  process.env.MUSIK_VORLAUF_MS = '0';
  try {
    const redis = mitStand(HOERSPIEL, { position: 1, runde: 0, seed: 0, offset: 30000 });
    const r = await skill(sucheIntent('hörspiel'), {}, null, redis);
    assert.equal(r.directives[0].audioItem.stream.offsetInMilliseconds, 30000);
  } finally {
    if (vorher === undefined) delete process.env.MUSIK_VORLAUF_MS;
    else process.env.MUSIK_VORLAUF_MS = vorher;
  }
});

test('Der Endspurt schiebt den Stand auf den angehaengten Titel', async () => {
  const redis = mitStand(ENDLOS, { position: 0, runde: 0, seed: 0, offset: 12000 });
  const r = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Endlos|0|0|0' }, {}, null, redis);
  assert.equal(r.directives[0].playBehavior, 'ENQUEUE');
  assert.deepEqual(
    { ...redis.speicher.musik_stand['endlos'], zeit: undefined },
    { position: 1, runde: 0, seed: 0, offset: 0, zeit: undefined },
  );
});

test('Ein Stopp im Endspurt zieht den Stand nicht zurueck', async () => {
  // Wer in den letzten Sekunden stoppt, will beim naechsten Mal den naechsten
  // Titel hoeren und nicht dessen Vorgaenger ausklingen. Der Stopp traegt aber
  // noch den alten Token.
  const redis = mitStand(ENDLOS, { position: 0, runde: 0, seed: 0, offset: 0 });
  await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Endlos|0|0|0' }, {}, null, redis);
  await skill({ type: 'AudioPlayer.PlaybackStopped', token: 'Endlos|0|0|0', offsetInMilliseconds: 178000 }, {}, null, redis);
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
  // Auskunft, die es gibt, und ueberschreibt deshalb bedingungslos.
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
  assert.equal(r.directives[0].audioItem.stream.token, 'Hörspiel|2|0|0');
  assert.equal(r.directives[0].audioItem.stream.offsetInMilliseconds, 60000);
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
  assert.equal(r.directives[0].audioItem.stream.token, 'Zweites|2|0|0');
  assert.equal(r.directives[0].audioItem.stream.offsetInMilliseconds, 35000);
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
  assert.equal(r.directives[0].audioItem.stream.token, 'Hörspiel|0|0|0', 'von vorn statt gar nicht');
  assert.equal(r.directives[0].audioItem.stream.offsetInMilliseconds, 0);
});

// Ein Album: setzt fort, aber titelgenau. Drei Titel wie ueberall hier.
const ALBUM = { name: 'Album', fortsetzen: 'titel', wiederholen: false, titel: KINDER.titel };

test('Album: der gemerkte Titel faengt wieder von vorn an', async () => {
  // Wer bei Lied drei nach siebenundvierzig Sekunden aufhoert, will Lied drei
  // ganz hoeren - nicht seine zweite Haelfte.
  const redis = mitStand(ALBUM, { position: 2, runde: 0, seed: 0, offset: 47000 });
  const r = await skill(sucheIntent('album'), {}, null, redis);
  assert.equal(r.outputSpeech.text, 'Ich spiele Album weiter.');
  assert.equal(r.directives[0].audioItem.stream.token, 'Album|2|0|0');
  assert.equal(r.directives[0].audioItem.stream.offsetInMilliseconds, 0);
});

test('Hoerbuch: derselbe Stand fuehrt auf die Sekunde', async () => {
  // Die Gegenprobe zum Album - derselbe Stand, nur die Gangart ist anders.
  const redis = mitStand({ ...ALBUM, name: 'Hoerbuch', fortsetzen: 'sekunde' }, { position: 2, runde: 0, seed: 0, offset: 47000 });
  const r = await skill(sucheIntent('hoerbuch'), {}, null, redis);
  assert.equal(r.directives[0].audioItem.stream.offsetInMilliseconds, 42000);
});

test('Album am ersten Titel heisst nicht "weiter"', async () => {
  const redis = mitStand(ALBUM, { position: 0, runde: 0, seed: 0, offset: 47000 });
  const r = await skill(sucheIntent('album'), {}, null, redis);
  assert.equal(r.outputSpeech.text, 'Ich spiele Album.');
  assert.equal(r.directives[0].audioItem.stream.offsetInMilliseconds, 0);
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
  assert.equal(r.directives[0].audioItem.stream.offsetInMilliseconds, 42000);
});

test('Album: "weiter" ohne laufenden Stream nimmt den Titelanfang', async () => {
  // Der Rueckfall auf den gemerkten Stand ist das spaetere Wiederaufnehmen -
  // dort gilt die Gangart wieder.
  const redis = mitStand(ALBUM, { position: 2, runde: 0, seed: 0, offset: 47000, zeit: 1000 });
  const r = await skill(intent('AMAZON.ResumeIntent'), {}, null, redis);
  assert.equal(r.directives[0].audioItem.stream.token, 'Album|2|0|0');
  assert.equal(r.directives[0].audioItem.stream.offsetInMilliseconds, 0);
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
  assert.equal(r.directives[0].audioItem.stream.token, 'Hörspiel|0|0|0', 'faengt eben von vorn an');
});

// --- Zufallswiedergabe im Betrieb --------------------------------------------------

test('Mit dem Schalter startet die Playlist gemischt', async () => {
  const gemischt = { name: 'Bunt', zufall: true, titel: KINDER.titel };
  const r = await skill(sucheIntent('bunt'), {}, [gemischt]);
  const token = tokenLesen(r.directives[0].audioItem.stream.token);
  assert.ok(token.seed > 0, 'ein Seed wurde gezogen');
  assert.equal(r.directives[0].audioItem.stream.url, KINDER.titel[reihenfolge(3, token.seed)[0]].url);
});

test('Ohne den Schalter bleibt die Reihenfolge der Liste', async () => {
  const r = await skill(sucheIntent('kinderlieder'));
  assert.equal(tokenLesen(r.directives[0].audioItem.stream.token).seed, 0);
  assert.equal(r.directives[0].audioItem.stream.url, KINDER.titel[0].url);
});

test('Die Sprachbefehle mischen nur den laufenden Stream', async () => {
  const an = await skill(intent('AMAZON.ShuffleOnIntent'), { token: 'Kinderlieder|1|0|0' });
  const neu = tokenLesen(an.directives[0].audioItem.stream.token);
  assert.ok(neu.seed > 0);
  assert.equal(neu.runde, 1, 'neue Runde, damit der Token sich unterscheidet');
  assert.equal(an.outputSpeech, undefined, 'die Musik spricht nicht dazwischen');

  const aus = await skill(intent('AMAZON.ShuffleOffIntent'), { token: 'Kinderlieder|1|0|4711' });
  assert.equal(tokenLesen(aus.directives[0].audioItem.stream.token).seed, 0);
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
  // Kein Netzabruf, keine Aenderung an den Adressen: Wer keine
  // FRITZ!NAS-Playlist hat, merkt von der Auffrischung nichts.
  const r = await skill(intent('PlayPlaylistIntent', 'Kinderlieder'));
  assert.equal(r.directives[0].audioItem.stream.url, KINDER.titel[0].url);
});

/** Eine FRITZ!NAS-Playlist samt gemerkter, noch gueltiger Sitzungsnummer. */
function mitSitzung(sid, alterMs = 0) {
  const playlist = {
    name: 'Schlaflieder',
    quelle: { typ: 'fritz', link: FRITZ_LINK },
    titel: [
      { url: fritzTitel('aaaaaaaaaaaaaaaa'), name: '01' },
      { url: fritzTitel('aaaaaaaaaaaaaaaa').replace('%2F01', '%2F02'), name: '02' },
    ],
  };
  return redisMit({
    [REDIS_KEY]: [playlist],
    musik_fritz_sid: { link: FRITZ_LINK, sid, zeit: Date.now() - alterMs },
  });
}

test('der Skill setzt die gemerkte Sitzungsnummer in jede Adresse ein', async () => {
  const redis = mitSitzung('bbbbbbbbbbbbbbbb');
  const r = await skill(intent('PlayPlaylistIntent', 'Schlaflieder'), {}, null, redis);
  const url = new URL(r.directives[0].audioItem.stream.url);
  assert.equal(url.searchParams.get('sid'), 'bbbbbbbbbbbbbbbb', 'die frische Nummer, nicht die gespeicherte');
  assert.equal(url.searchParams.get('path'), '/01.mp3', 'der Pfad bleibt');
});

test('auch der naechste Titel bekommt die frische Nummer', async () => {
  // PlaybackNearlyFinished haengt den naechsten Titel an - ohne Slot, nur mit
  // Token. Ginge die Auffrischung nur ueber den Slot, waere der zweite Titel
  // der erste, der stumm bleibt.
  const redis = mitSitzung('bbbbbbbbbbbbbbbb');
  const r = await skill(
    { type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Schlaflieder|0|0|0' },
    { token: 'Schlaflieder|0|0|0' },
    null,
    redis,
  );
  const url = new URL(r.directives[0].audioItem.stream.url);
  assert.equal(url.searchParams.get('sid'), 'bbbbbbbbbbbbbbbb');
  assert.equal(url.searchParams.get('path'), '/02.mp3');
});

test('mit einer abgelaufenen Nummer wird nicht mehr losgespielt', async () => {
  // Neun Minuten alt, also ueber der Frist von fuenf - es wird eine neue
  // geholt. Der Host endet auf .invalid und ist damit garantiert nicht
  // aufloesbar (RFC 2606), der Abruf scheitert also ohne Wartezeit.
  //
  // **Frueher spielte der Skill hier mit der alten Nummer los**, in der
  // Annahme, sie sei vielleicht noch gut und ein gescheiterter Titel hole sich
  // ueber PlaybackFailed eine frische. Im Betrieb kam davon nichts an: Alexa
  // sagte "Ich spiele das doppelte Lottchen", und dann war es still - jedes
  // Mal beim ersten Versuch, weil erst der zweite eine frische Nummer im
  // Zwischenspeicher vorfand. Ein Satz, der erklaert, ist besser als Stille,
  // die es nicht tut.
  const link = 'https://nicht-erreichbar.invalid/nas/filelink.lua?id=535f52fbb2016f4f';
  const redis = redisMit({
    [REDIS_KEY]: [{
      name: 'Schlaflieder',
      quelle: { typ: 'fritz', link },
      titel: [{ url: fritzTitel('bbbbbbbbbbbbbbbb'), name: '01' }],
    }],
    musik_fritz_sid: { link, sid: 'bbbbbbbbbbbbbbbb', zeit: Date.now() - 9 * 60_000 },
  });

  const r = await skill(intent('PlayPlaylistIntent', 'Schlaflieder'), {}, null, redis);
  // Die dynamischen Werte gehen mit (der Satz ist eine Rueckfrage wert) -
  // eine Wiedergabe nicht.
  assert.ok(!r.directives?.some(d => d.type === 'AudioPlayer.Play'), 'keine Play-Direktive mit toter Nummer');
  assert.match(r.outputSpeech.text, /nicht an die FRITZ!Box/);
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

test('Beim Oeffnen holt der Skill die FRITZ!Box-Sitzung schon vor der Frage', async () => {
  // **Der Kern der Sache.** Der Aufruf hat zwei Schritte, und der ganze Login
  // lag im zweiten - dem engen. Beim ersten Versuch nach einer Pause reichte
  // es dort nicht, der Echo bekam eine abgelaufene Nummer und blieb still;
  // erst der zweite Versuch fand eine frische im Zwischenspeicher. Jetzt
  // passiert die Anmeldung schon beim Oeffnen, wo Zeit ist.
  const a = unerreichbar('Schlaflieder', 'aaaa1111aaaa1111');
  const { redis, gelesen } = redisMitProtokoll({ [REDIS_KEY]: [a.playlist] });

  const r = await mitBudget(9000, () => skill({ type: 'LaunchRequest' }, {}, null, redis));
  assert.ok(gelesen.includes('musik_fritz_sid'), 'die Sitzung wird beim Oeffnen geholt');
  // Und die Frage kommt trotzdem: Der Login scheitert hier am toten Host, und
  // das darf den ersten Schritt nicht aufhalten - der zweite versucht es noch
  // einmal, dann mit warmen Verbindungen.
  assert.match(r.outputSpeech.text, /Welche Playlist soll ich spielen/);
  assert.equal(r.shouldEndSession, false);
});

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

test('Check URLs prueft die FRITZ!NAS-Adressen mit der frischen Sitzungsnummer', async () => {
  // Der Kern des Ganzen: Ohne die Auffrischung pruefte der Knopf die
  // gespeicherte, laengst abgelaufene Adresse - und meldete eine Playlist als
  // kaputt, die gerade tadellos spielt. Geprueft wird hier nur, WAS abgerufen
  // wird; dass der Abruf ohne Netz scheitert, ist fuer diese Frage egal.
  // Der Host endet auf .invalid (RFC 2606) und ist damit garantiert nicht
  // aufloesbar: Der Abruf scheitert sofort, statt die Testsuite an einem
  // echten Netzzugriff haengen zu lassen.
  const link = 'https://nicht-erreichbar.invalid/nas/filelink.lua?id=535f52fbb2016f4f';
  const titelUrl = (sid) =>
    `https://nicht-erreichbar.invalid/nas/cgi-bin/luacgi_notimeout?script=%2Fapi%2Fdata.lua&sid=${sid}&c=music&a=get&path=%2F01.mp3`;
  const redis = redisMit({
    [REDIS_KEY]: [{
      name: 'Schlaflieder',
      quelle: { typ: 'fritz', link },
      titel: [{ url: titelUrl('aaaaaaaaaaaaaaaa'), name: '01' }],
    }],
    musik_fritz_sid: { link, sid: 'bbbbbbbbbbbbbbbb', zeit: Date.now() },
  });

  const res = antwortFaenger();
  await handleManage({ method: 'GET', query: { pruefen: '1', name: 'Schlaflieder', ab: '0' } }, res, redis);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.aufgefrischt, true);
  assert.equal(new URL(res.body.ergebnisse[0].url).searchParams.get('sid'), 'bbbbbbbbbbbbbbbb');

  // Und die gespeicherte Playlist bleibt unberuehrt - die Pruefung schreibt nicht.
  assert.equal(new URL(redis.speicher[REDIS_KEY][0].titel[0].url).searchParams.get('sid'), 'aaaaaaaaaaaaaaaa');
});

test('Check URLs meldet fuer eine gewoehnliche Playlist keine Auffrischung', async () => {
  const redis = redisMit({ [REDIS_KEY]: [KINDER] });
  const res = antwortFaenger();
  await handleManage({ method: 'GET', query: { pruefen: '1', name: 'Kinderlieder', ab: '0' } }, res, redis);
  assert.equal(res.body.aufgefrischt, false);
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
  const url = r.directives?.[0]?.audioItem?.stream?.url;
  return url ? new URL(url).searchParams.get('sid') : null;
}

/** Was Alexa dabei gesagt hat. */
async function satzBeimSpielen(redis, name) {
  const r = await skill(intent('PlayPlaylistIntent', name), {}, null, redis);
  return r.outputSpeech?.text ?? '';
}

test('die gemerkte Sitzung einer ANDEREN Freigabe wird nicht verwendet', async () => {
  // Der Kern: Gemerkt ist die Sitzung von Playlist A, gespielt wird B. Haette
  // B sie eingesetzt, kaeme am Echo die Anmeldeseite der Box statt Musik - die
  // Box hat A's Sitzung beendet, als B's Freigabe geoeffnet wurde.
  //
  // Der Host antwortet nicht, das Neuholen scheitert also. Frueher blieb dann
  // die gespeicherte Adresse stehen und Alexa sagte "Ich spiele …" - ein
  // Versprechen mit einer Nummer aus der Importzeit, das der Echo nicht halten
  // konnte. Jetzt wird gar nicht erst gestartet, und das ist die staerkere
  // Zusicherung: Die fremde Nummer taucht nirgends auf, und niemand wartet
  // vergeblich auf Ton.
  const a = unerreichbar('Schlaflieder', 'aaaa1111aaaa1111');
  const b = unerreichbar('Udo CD zwei', 'bbbb2222bbbb2222');
  const redis = redisMit({
    [REDIS_KEY]: [a.playlist, b.playlist],
    musik_fritz_sid: { link: a.link, sid: 'fremdesitzung11', zeit: Date.now() },
  });

  assert.equal(await sidDerDirektive(redis, 'Udo CD zwei'), null, 'es wird nicht gespielt');
  assert.match(await satzBeimSpielen(redis, 'Udo CD zwei'), /komme gerade nicht an die FRITZ!Box/);
});

test('die gemerkte Sitzung DERSELBEN Freigabe wird verwendet', async () => {
  // Die Gegenprobe zum Test darueber: Passt der Link, wird sie eingesetzt,
  // ohne dass die Box ueberhaupt gefragt wird.
  const a = unerreichbar('Schlaflieder', 'aaaa1111aaaa1111');
  const redis = redisMit({
    [REDIS_KEY]: [a.playlist],
    musik_fritz_sid: { link: a.link, sid: 'eigenesitzung11', zeit: Date.now() },
  });

  assert.equal(await sidDerDirektive(redis, 'Schlaflieder'), 'eigenesitzung11');
});

test('fuenf Minuten sind die Grenze', async () => {
  const a = unerreichbar('Schlaflieder', 'aaaa1111aaaa1111');
  const mit = (alterMinuten) => redisMit({
    [REDIS_KEY]: [a.playlist],
    musik_fritz_sid: { link: a.link, sid: 'eigenesitzung11', zeit: Date.now() - alterMinuten * 60_000 },
  });

  assert.equal(await sidDerDirektive(mit(4), 'Schlaflieder'), 'eigenesitzung11', 'vier Minuten: noch gut');
  // Sechs Minuten: Es wird eine neue geholt, das scheitert am toten Host - und
  // damit ist die gemerkte aus dem Rennen. Sie mag noch gut sein oder nicht;
  // darauf zu wetten hiess im Betrieb, dem Hoerenden Stille zu servieren.
  assert.equal(await sidDerDirektive(mit(6), 'Schlaflieder'), null);
  assert.match(await satzBeimSpielen(mit(6), 'Schlaflieder'), /nicht an die FRITZ!Box/);
});

test('der alte Zwischenspeicher je Freigabe wird als leer gelesen', async () => {
  // Vor dieser Fassung stand dort eine Zuordnung Link -> Nummer. Aus ihr darf
  // keine Nummer mehr herausgelesen werden, auch nicht zufaellig. Ohne
  // brauchbare Nummer und mit totem Host wird nicht gespielt.
  const a = unerreichbar('Schlaflieder', 'aaaa1111aaaa1111');
  const redis = redisMit({
    [REDIS_KEY]: [a.playlist],
    musik_fritz_sid: { [a.link]: { sid: 'altesformat1111', zeit: Date.now() } },
  });

  assert.equal(await sidDerDirektive(redis, 'Schlaflieder'), null);
  assert.doesNotMatch(await satzBeimSpielen(redis, 'Schlaflieder'), /altesformat/);
});

test('fritzSidMerken legt genau einen Datensatz ab', async () => {
  const redis = redisMit();
  await fritzSidMerken(redis, FRITZ_LINK, 'frischgeholt111');
  const gemerkt = redis.speicher.musik_fritz_sid;
  assert.equal(gemerkt.link, FRITZ_LINK);
  assert.equal(gemerkt.sid, 'frischgeholt111');
  assert.ok(Date.now() - gemerkt.zeit < 5000);

  // Eine zweite Freigabe ersetzt die erste, sie kommt nicht daneben: Die Box
  // fuehrt nur eine Sitzung, also merkt sich der Zwischenspeicher auch nur eine.
  await fritzSidMerken(redis, 'https://abc.myfritz.net:456/nas/filelink.lua?id=bbbb2222bbbb2222', 'zweitesitzung11');
  assert.equal(redis.speicher.musik_fritz_sid.sid, 'zweitesitzung11');
  assert.equal(Object.keys(redis.speicher.musik_fritz_sid).sort().join(), 'link,sid,zeit');
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
function boxAmDraht(gueltig, neue = 'cccccccccccccccc') {
  const abrufe = [];
  const zustand = { gueltig };
  const vorher = globalThis.fetch;
  globalThis.fetch = async (eingabe, init = {}) => {
    const url = String(eingabe);
    abrufe.push(new URL(url).pathname);
    if (url.includes('/nas/filelink.lua')) {
      zustand.gueltig = neue; // die Anmeldung wirft jede bestehende Sitzung raus
      return boxAntwort('text/html', `<html><body data-sid="${neue}"></body></html>`);
    }
    if (url.includes('/nas/api/data.lua')) {
      const sid = new URLSearchParams(String(init.body || '')).get('sid');
      const daten = sid === zustand.gueltig ? { root: '/Musik', rights: { read: true } } : { error: 'no session' };
      return boxAntwort('application/json', JSON.stringify(daten));
    }
    if (url.includes('/nas/cgi-bin/luacgi_notimeout')) {
      // Der Abruf, den der Echo macht - und den "Check URLs" nachstellt. Mit
      // toter Nummer schickt die Box ihre Oberflaeche statt der Datei.
      if (new URL(url).searchParams.get('sid') !== zustand.gueltig) {
        return boxAntwort('text/html', '<title>FRITZ!NAS</title>Anmeldung erforderlich');
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
  return { abrufe, zustand, zurueck() { globalThis.fetch = vorher; } };
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

test('eine abgelaufene Frist fragt nach, statt sich neu anzumelden', async () => {
  // Der Titelwechsel nach sechs Minuten: Die Frist ist um, die Sitzung lebt -
  // weil der Echo sie mit jedem Abruf verlaengert hat. Frueher meldete sich
  // der Skill hier an und riss damit den laufenden Titel aus der Box.
  const redis = boxRedis('aaaaaaaaaaaaaaaa', 6);
  const box = boxAmDraht('aaaaaaaaaaaaaaaa');
  try {
    const r = await skillMitBudget(
      { type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Udo CD eins|0|0|0' },
      { token: 'Udo CD eins|0|0|0' },
      redis,
    );
    assert.ok(!box.abrufe.includes('/nas/filelink.lua'), 'keine Anmeldung, solange die Nummer gilt');
    assert.deepEqual(box.abrufe, ['/nas/api/data.lua'], 'genau ein Abruf: die Nachfrage');
    const url = new URL(r.directives[0].audioItem.stream.url);
    assert.equal(url.searchParams.get('sid'), 'aaaaaaaaaaaaaaaa', 'dieselbe Nummer bleibt');
    assert.equal(url.searchParams.get('path'), '/02.mp3');
    assert.ok(Date.now() - redis.speicher.musik_fritz_sid.zeit < 5000, 'die Frist beginnt von vorn');
  } finally {
    box.zurueck();
  }
});

test('erst eine wirklich tote Nummer loest die Anmeldung aus', async () => {
  // Die Gegenprobe: Die Box kennt die gemerkte Nummer nicht mehr (Neustart,
  // eine fremde Freigabe). Dann ist die Anmeldung richtig - und ihr Preis,
  // alle Sitzungen zu beenden, kostet hier nichts mehr.
  const redis = boxRedis('aaaaaaaaaaaaaaaa', 6);
  const box = boxAmDraht('totetotetotetote');
  try {
    const r = await skillMitBudget(
      { type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Udo CD eins|0|0|0' },
      { token: 'Udo CD eins|0|0|0' },
      redis,
    );
    assert.deepEqual(
      box.abrufe,
      ['/nas/api/data.lua', '/nas/filelink.lua', '/nas/api/data.lua'],
      'nachgefragt, abgelehnt, angemeldet, gegengeprueft',
    );
    assert.equal(new URL(r.directives[0].audioItem.stream.url).searchParams.get('sid'), 'cccccccccccccccc');
    assert.equal(redis.speicher.musik_fritz_sid.sid, 'cccccccccccccccc');
  } finally {
    box.zurueck();
  }
});

test('nach einer Anmeldung bekommt der gescheiterte Titel einen zweiten Versuch', async () => {
  // War die Nummer tot, lag es nicht am Titel, sondern an der Adresse. Ihn zu
  // ueberspringen hiesse, den Hoerenden fuer einen Fehler der Box zu bestrafen -
  // er faengt dort wieder an, wo er abbrach.
  const redis = boxRedis('aaaaaaaaaaaaaaaa', 0);
  const box = boxAmDraht('totetotetotetote');
  try {
    const r = await skillMitBudget(
      {
        type: 'AudioPlayer.PlaybackFailed',
        token: 'Udo CD eins|0|0|0',
        error: { type: 'MEDIA_ERROR_INTERNAL_SERVER_ERROR', message: 'Device playback error' },
      },
      { token: 'Udo CD eins|0|0|0', offset: 90_000 },
      redis,
    );
    const stream = r.directives[0].audioItem.stream;
    assert.equal(stream.token, 'Udo CD eins|0|0|0', 'derselbe Titel, nicht der naechste');
    assert.equal(new URL(stream.url).searchParams.get('sid'), 'cccccccccccccccc', 'mit der neuen Nummer');
    assert.equal(stream.offsetInMilliseconds, einstieg(90_000), 'dort, wo er abbrach - mit Vorlauf');
  } finally {
    box.zurueck();
  }
});

test('galt die Nummer noch, geht es nach einem Fehler mit dem naechsten Titel weiter', async () => {
  // Kein Sitzungsproblem, also auch kein zweiter Versuch: Dieselbe Adresse
  // noch einmal zu laden ergaebe nur denselben Fehler. Und das alte Verhalten
  // bleibt, wo es richtig ist.
  const redis = boxRedis('aaaaaaaaaaaaaaaa', 6);
  const box = boxAmDraht('aaaaaaaaaaaaaaaa');
  try {
    const r = await skillMitBudget(
      {
        type: 'AudioPlayer.PlaybackFailed',
        token: 'Udo CD eins|0|0|0',
        error: { type: 'MEDIA_ERROR_INTERNAL_SERVER_ERROR', message: 'Device playback error' },
      },
      { token: 'Udo CD eins|0|0|0', offset: 90_000 },
      redis,
    );
    assert.ok(!box.abrufe.includes('/nas/filelink.lua'), 'ein Stolperer beendet nicht alle Sitzungen der Box');
    const stream = r.directives[0].audioItem.stream;
    assert.equal(stream.token, 'Udo CD eins|1|0|0', 'der naechste Titel');
    assert.equal(stream.offsetInMilliseconds, 0);
  } finally {
    box.zurueck();
  }
});

test('die Nachfrage haelt eine spielende Playlist ueber Stunden am Leben', async () => {
  // Zehn Titelwechsel, jeder sechs Minuten nach dem vorigen - genau der Lauf,
  // bei dem "Udo CD eins|10|0|0" scheiterte. Keine einzige Anmeldung, keine
  // einzige neue Nummer: Die Sitzung traegt bis zum Schluss.
  const redis = boxRedis('aaaaaaaaaaaaaaaa', 6);
  const box = boxAmDraht('aaaaaaaaaaaaaaaa');
  try {
    for (let i = 0; i < 10; i++) {
      await skillMitBudget(
        { type: 'AudioPlayer.PlaybackNearlyFinished', token: `Udo CD eins|${i % 2}|${i}|0` },
        { token: `Udo CD eins|${i % 2}|${i}|0` },
        redis,
      );
      redis.speicher.musik_fritz_sid.zeit -= 6 * 60_000;
    }
    assert.ok(!box.abrufe.includes('/nas/filelink.lua'), 'kein einziges Mal angemeldet');
    assert.equal(box.abrufe.length, 10, 'ein Abruf je Titelwechsel');
    assert.equal(redis.speicher.musik_fritz_sid.sid, 'aaaaaaaaaaaaaaaa');
  } finally {
    box.zurueck();
  }
});

test('Check URLs meldet sich nicht an, nur weil Redis eine Weile braucht', async () => {
  // **Der Fehler, der das hier ausgeloest hat**, stand so im Vercel-Log:
  //
  //   TimeoutOverflowWarning: Infinity does not fit into a 32-bit signed integer.
  //   Timeout duration was set to 1.
  //   musik_fritz_sid nicht rechtzeitig: nach Infinity ms
  //   musik-box FRITZ!NAS-Login ok nach 1622 ms, Infinity ms Budget uebrig
  //
  // Ausserhalb des Skills gibt es kein Alexa-Fenster, also reicht "Check URLs"
  // `rest = () => Infinity` durch. `setTimeout` macht daraus eine
  // Millisekunde - und die gewinnt gegen jeden echten Netzabruf zu Upstash.
  // Die gemerkte Sitzungsnummer galt damit als nicht vorhanden, und der Knopf
  // meldete sich jedes Mal neu an: Genau der Zugriff, der auf der Box alle
  // Sitzungen beendet. Wer waehrend der Wiedergabe auf "Check URLs" drueckte,
  // warf damit den laufenden Titel aus der Box.
  //
  // Dass es in den Tests nie auffiel, liegt am Redis-Stellvertreter: Seine
  // `get` ist sofort fertig und gewinnt das Rennen im Microtask. Hier braucht
  // sie deshalb echte Zeit - so wie Upstash auch.
  const langsam = redisMit({
    [REDIS_KEY]: [{
      name: 'Udo CD eins',
      quelle: { typ: 'fritz', link: BOX_LINK },
      titel: [{ url: boxTitel(1, 'aaaaaaaaaaaaaaaa'), name: '01' }],
    }],
    musik_fritz_sid: { link: BOX_LINK, sid: 'aaaaaaaaaaaaaaaa', zeit: Date.now() },
  });
  const sofort = langsam.get.bind(langsam);
  langsam.get = async (key) => {
    await new Promise(fertig => setTimeout(fertig, 20));
    return sofort(key);
  };

  const box = boxAmDraht('aaaaaaaaaaaaaaaa');
  try {
    const res = antwortFaenger();
    await handleManage({ method: 'GET', query: { pruefen: '1', name: 'Udo CD eins', ab: '0' } }, res, langsam);
    assert.ok(!box.abrufe.includes('/nas/filelink.lua'), 'die gemerkte Nummer wurde gefunden, also keine Anmeldung');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ergebnisse[0].fehler, null, 'und die Pruefung sieht eine Audiodatei');
    assert.equal(res.body.ergebnisse[0].contentType, 'audio/mpeg');
  } finally {
    box.zurueck();
  }
});
