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
  handleSkill,
  handleManage,
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

async function skill(request, opts = {}, playlists = [KINDER, EINZEL]) {
  const res = antwortFaenger();
  await handleSkill(anfrage(request, opts), res, redisMit({ [REDIS_KEY]: playlists }));
  return res.body.response;
}

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
  const t = tokenBauen('Kinderlieder', 2, 1);
  assert.equal(t, 'Kinderlieder|2|1');
  assert.deepEqual(tokenLesen(t), { name: 'Kinderlieder', index: 2, runde: 1 });
  assert.equal(tokenLesen('fremd'), null);
  assert.equal(tokenLesen('a|x|1'), null);
  assert.equal(tokenLesen('a|-1|1'), null);
  assert.equal(tokenLesen(undefined), null);
});

test('schritt laeuft vorwaerts mit Umbruch und zaehlt die Runde hoch', () => {
  assert.deepEqual(schritt(KINDER, { index: 0, runde: 0 }, +1), { index: 1, runde: 0, umbruch: false });
  assert.deepEqual(schritt(KINDER, { index: 2, runde: 0 }, +1), { index: 0, runde: 1, umbruch: true });
});

test('schritt rueckwaerts bricht am Anfang um', () => {
  assert.deepEqual(schritt(KINDER, { index: 1, runde: 3 }, -1), { index: 0, runde: 3, umbruch: false });
  assert.deepEqual(schritt(KINDER, { index: 0, runde: 3 }, -1), { index: 2, runde: 4, umbruch: true });
});

test('Ein-Titel-Playlist bekommt bei jedem Schritt einen neuen Token', () => {
  const a = schritt(EINZEL, { index: 0, runde: 0 }, +1);
  assert.deepEqual(a, { index: 0, runde: 1, umbruch: true });
  assert.notEqual(tokenBauen('Solo', a.index, a.runde), tokenBauen('Solo', 0, 0));
});

test('schritt faengt einen Index jenseits der gekuerzten Playlist ab', () => {
  assert.deepEqual(schritt(KINDER, { index: 7, runde: 0 }, +1), { index: 0, runde: 1, umbruch: true });
  assert.equal(schritt({ name: 'leer', titel: [] }, { index: 0, runde: 0 }, +1), null);
});

test('playDirektive baut Stream und Anzeige', () => {
  const d = playDirektive(KINDER, 1, 0, { verhalten: 'ENQUEUE', vorherigerToken: 'Kinderlieder|0|0' });
  assert.equal(d.type, 'AudioPlayer.Play');
  assert.equal(d.playBehavior, 'ENQUEUE');
  assert.deepEqual(d.audioItem.stream, {
    url: 'https://example.org/k/02.mp3',
    token: 'Kinderlieder|1|0',
    offsetInMilliseconds: 0,
    expectedPreviousToken: 'Kinderlieder|0|0',
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
  assert.equal(r.directives[0].audioItem.stream.token, 'Kinderlieder|0|0');
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
  const r = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Kinderlieder|1|0' }, { token: 'Kinderlieder|1|0' });
  assert.equal(r.outputSpeech, undefined);
  assert.equal(r.shouldEndSession, undefined);
  const d = r.directives[0];
  assert.equal(d.playBehavior, 'ENQUEUE');
  assert.equal(d.audioItem.stream.token, 'Kinderlieder|2|0');
  assert.equal(d.audioItem.stream.expectedPreviousToken, 'Kinderlieder|1|0');
});

test('Nach dem letzten Titel folgt wieder der erste - die Endlosschleife', async () => {
  const r = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Kinderlieder|2|0' }, { token: 'Kinderlieder|2|0' });
  assert.equal(r.directives[0].audioItem.stream.token, 'Kinderlieder|0|1');
  assert.equal(r.directives[0].audioItem.stream.url, KINDER.titel[0].url);
});

test('PlaybackNearlyFinished mit fremdem oder verwaistem Token bleibt still', async () => {
  const fremd = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'irgendwas' });
  assert.deepEqual(fremd, {});
  const weg = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Geloescht|0|0' });
  assert.deepEqual(weg, {});
});

test('Pause stoppt, Weiter setzt am Offset fort', async () => {
  const pause = await skill(intent('AMAZON.PauseIntent'), { token: 'Kinderlieder|1|0', offset: 5000 });
  assert.deepEqual(pause.directives, [{ type: 'AudioPlayer.Stop' }]);
  assert.equal(pause.outputSpeech, undefined);

  const weiter = await skill(intent('AMAZON.ResumeIntent'), { token: 'Kinderlieder|1|0', offset: 5000 });
  assert.equal(weiter.directives[0].audioItem.stream.token, 'Kinderlieder|1|0');
  assert.equal(weiter.directives[0].audioItem.stream.offsetInMilliseconds, 5000);
});

test('Weiter ohne laufenden Stream fragt nach der Playlist', async () => {
  const r = await skill(intent('AMAZON.ResumeIntent'));
  assert.match(r.outputSpeech.text, /Es laeuft gerade nichts/);
});

test('Naechster und voriger Titel - per Sprache und per Knopf', async () => {
  const n = await skill(intent('AMAZON.NextIntent'), { token: 'Kinderlieder|0|0' });
  assert.equal(n.directives[0].audioItem.stream.token, 'Kinderlieder|1|0');
  const v = await skill({ type: 'PlaybackController.PreviousCommandIssued' }, { token: 'Kinderlieder|0|0' });
  assert.equal(v.directives[0].audioItem.stream.token, 'Kinderlieder|2|1');
  assert.equal(v.outputSpeech, undefined);
});

test('PlaybackFailed springt weiter, aber nicht ueber das Ende der Runde hinaus', async () => {
  const mitte = await skill({ type: 'AudioPlayer.PlaybackFailed', token: 'Kinderlieder|0|0', error: { type: 'MEDIA_ERROR_UNKNOWN' } });
  assert.equal(mitte.directives[0].audioItem.stream.token, 'Kinderlieder|1|0');
  const ende = await skill({ type: 'AudioPlayer.PlaybackFailed', token: 'Kinderlieder|2|0', error: { type: 'MEDIA_ERROR_UNKNOWN' } });
  assert.deepEqual(ende.directives, [{ type: 'AudioPlayer.Stop' }]);
});

test('Shuffle antwortet mit einem Satz', async () => {
  assert.match((await skill(intent('AMAZON.ShuffleOnIntent'))).outputSpeech.text, /Zufallswiedergabe/);
});

test('PlaybackStarted und SessionEnded bleiben still', async () => {
  assert.deepEqual(await skill({ type: 'AudioPlayer.PlaybackStarted', token: 'Kinderlieder|0|0' }), {});
  assert.deepEqual(await skill({ type: 'SessionEndedRequest' }), {});
});

test('Ein lesbarer Redis-Fehler bricht den Skill nicht', async () => {
  const res = antwortFaenger();
  const kaputt = { async get() { throw new Error('offline'); } };
  await handleSkill(anfrage({ type: 'LaunchRequest' }), res, kaputt);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.response.outputSpeech.text, /keine Playlist angelegt/);
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
  assert.equal(r.directives[0].audioItem.stream.token, 'Leise|0|0');
});

test('Mit Ansage bleibt der Satz vor der Musik', async () => {
  const r = await skill(intent('PlayPlaylistIntent', 'kinderlieder'));
  assert.equal(r.outputSpeech.text, 'Ich spiele Kinderlieder.');
  assert.equal(r.directives[0].audioItem.stream.token, 'Kinderlieder|0|0');
});

test('Die Ansage schweigt nur vorn - Rueckfragen und Fehler bleiben hoerbar', async () => {
  const unbekannt = await skill(intent('PlayPlaylistIntent', 'Jazz'), {}, [STILL]);
  assert.match(unbekannt.outputSpeech.text, /keine Playlist namens Jazz/);

  const leer = await skill(intent('PlayPlaylistIntent', 'leer'), {}, [{ name: 'Leer', ansage: false, titel: [] }]);
  assert.match(leer.outputSpeech.text, /noch keine Titel/);
});

test('Ohne Wiederholung wird hinter dem letzten Titel nichts angehaengt', async () => {
  const r = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Einmal|2|0' }, { token: 'Einmal|2|0' }, [EINMAL]);
  // Kein Stop: Der letzte Titel laeuft noch und soll zu Ende spielen.
  assert.deepEqual(r, {});
});

test('Ohne Wiederholung laeuft die Playlist bis dahin normal weiter', async () => {
  const r = await skill({ type: 'AudioPlayer.PlaybackNearlyFinished', token: 'Einmal|0|0' }, { token: 'Einmal|0|0' }, [EINMAL]);
  assert.equal(r.directives[0].audioItem.stream.token, 'Einmal|1|0');
});

test('Ohne Wiederholung stoppt naechster Titel am Ende und bleibt am Anfang stehen', async () => {
  const ende = await skill(intent('AMAZON.NextIntent'), { token: 'Einmal|2|0' }, [EINMAL]);
  assert.deepEqual(ende.directives, [{ type: 'AudioPlayer.Stop' }]);

  const anfang = await skill(intent('AMAZON.PreviousIntent'), { token: 'Einmal|0|0' }, [EINMAL]);
  assert.equal(anfang.directives[0].audioItem.stream.token, 'Einmal|0|0');
});

test('Loop-Befehle geben Auskunft, statt etwas zu behaupten oder umzuschalten', async () => {
  const aus = await skill(intent('AMAZON.LoopOffIntent'), { token: 'Einmal|0|0' }, [EINMAL]);
  assert.match(aus.outputSpeech.text, /Einmal wiederholt sich nicht.*Dashboard/);

  const an = await skill(intent('AMAZON.LoopOnIntent'), { token: 'Kinderlieder|0|0' });
  assert.match(an.outputSpeech.text, /Kinderlieder wiederholt sich\./);

  const ohne = await skill(intent('AMAZON.RepeatIntent'));
  assert.match(ohne.outputSpeech.text, /Dashboard/);
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
