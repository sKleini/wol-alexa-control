// test/musik.test.mjs – die Musik-Box ohne Netz und ohne Redis.
//
//   node --test
//
// Geprueft werden die reinen Funktionen aus lib/musik.js und der Skill-Handler
// mit einem Redis-Stellvertreter. Kein Testpaket noetig: node:test und
// node:assert reichen, und sie laufen in derselben CI wie die Modell-Pruefung.
import { test } from 'node:test'
import assert from 'node:assert/strict'
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
  reihenfolge,
  titelAn,
  neuerSeed,
  handleSkill,
  handleManage,
  istAudioUrl,
  audioLinksAusHtml,
  audioNamenImText,
  seitenDiagnose,
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

test('LaunchRequest fragt nach der Playlist und schiebt die Namen nach', async () => {
  const r = await skill({ type: 'LaunchRequest' });
  assert.match(r.outputSpeech.text, /Welche Playlist.*Kinderlieder und Solo/);
  assert.equal(r.shouldEndSession, false);
  assert.equal(r.directives[0].type, 'Dialog.UpdateDynamicEntities');
  assert.deepEqual(r.directives[0].types[0].values.map(v => v.name.value), ['Kinderlieder', 'Solo']);
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

test('Pause stoppt, Weiter setzt am Offset fort', async () => {
  const pause = await skill(intent('AMAZON.PauseIntent'), { token: 'Kinderlieder|1|0|0', offset: 5000 });
  assert.deepEqual(pause.directives, [{ type: 'AudioPlayer.Stop' }]);
  assert.equal(pause.outputSpeech, undefined);

  const weiter = await skill(intent('AMAZON.ResumeIntent'), { token: 'Kinderlieder|1|0|0', offset: 5000 });
  assert.equal(weiter.directives[0].audioItem.stream.token, 'Kinderlieder|1|0|0');
  assert.equal(weiter.directives[0].audioItem.stream.offsetInMilliseconds, 5000);
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

test('Ein lesbarer Redis-Fehler bricht den Skill nicht', async () => {
  const res = antwortFaenger();
  const kaputt = { async get() { throw new Error('offline'); } };
  await handleSkill(anfrage({ type: 'LaunchRequest' }), res, kaputt);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.response.outputSpeech.text, /keine Playlist angelegt/);
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
  assert.equal(r.shouldEndSession, undefined, 'kein shouldEndSession neben AudioPlayer.Play');
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
  assert.equal(r.directives[0].audioItem.stream.offsetInMilliseconds, 65000);
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
  assert.deepEqual(redis.speicher.musik_stand, {});
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
    musik_fritz_sid: { [FRITZ_LINK]: { sid, zeit: Date.now() - alterMs } },
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

test('ist die Box nicht erreichbar, bleibt die gemerkte Nummer der letzte Versuch', async () => {
  // Neun Minuten alt, also ueber der Frist von acht - es wird eine neue
  // geholt. Der Host endet auf .invalid und ist damit garantiert nicht
  // aufloesbar (RFC 2606), der Abruf scheitert also ohne Wartezeit.
  //
  // Dann lieber die alte Nummer als gar keine: Sie ist vielleicht noch gut
  // (die FRITZ!Box laesst mehr Zeit, als hier gewartet wird), und eine
  // Playlist mit vielleicht toten Adressen ist besser als eine Antwort ohne
  // Titel. Was wirklich tot ist, faengt der PlaybackFailed-Weg ab.
  const link = 'https://nicht-erreichbar.invalid/nas/filelink.lua?id=535f52fbb2016f4f';
  const redis = redisMit({
    [REDIS_KEY]: [{
      name: 'Schlaflieder',
      quelle: { typ: 'fritz', link },
      titel: [{ url: fritzTitel('bbbbbbbbbbbbbbbb'), name: '01' }],
    }],
    musik_fritz_sid: { [link]: { sid: 'bbbbbbbbbbbbbbbb', zeit: Date.now() - 9 * 60_000 } },
  });

  const r = await skill(intent('PlayPlaylistIntent', 'Schlaflieder'), {}, null, redis);
  const url = new URL(r.directives[0].audioItem.stream.url);
  assert.equal(url.searchParams.get('sid'), 'bbbbbbbbbbbbbbbb');
  assert.equal(url.searchParams.get('path'), '/01.mp3');
});
