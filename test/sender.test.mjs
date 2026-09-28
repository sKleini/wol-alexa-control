// test/sender.test.mjs – die Nachrichten eines Senders durch die eigene App.
//
//   node --test
//
// Ohne Netz: Der Abruf beim Sender ist ersetzt, Redis ist ein Stellvertreter.
// Geprueft wird, dass der Echo die App-Adresse bekommt, dass nur ein Aufruf
// mit Kennung etwas bekommt und dass die App beim Sender am Zwischenspeicher
// vorbei fragt. Warum es den Umweg braucht, steht in lib/sender.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

process.env.MUSIK_TON_KEY = 'geheim-und-lang-genug';
process.env.MUSIK_BUDGET_MS = '300';

import {
  SENDER, senderKennung, senderAus, senderUrl, mitDurchleitung, sendezeit, senderTon, senderStand,
  netz, serverBild, sendezeitGesprochen, frisch, waehleServer, adressenFuer, vergiss, GEMERKT_KEY, SERVERLOG_KEY, serverLogLesen,
} from '../lib/sender.js'
import { playDirektive, handleSkill, handleManage, validierePlaylist, sagtZeitAn, REDIS_KEY } from '../lib/musik.js'

const SCHLUESSEL = 'geheim-und-lang-genug';
const BASIS = 'https://meine-app.vercel.app';
const SWR3 = SENDER.swr3;
const NACHRICHTEN = {
  name: 'SWR3 Nachrichten', aktuell: true, wiederholen: false,
  titel: [{ url: SWR3, name: 'SWR3 Nachrichten' }],
};
const KINDER = { name: 'Kinderlieder', titel: [{ url: 'https://example.org/k/01.mp3', name: '01' }] };

function attrappeRes() {
  const res = new PassThrough();
  res.stuecke = [];
  res.on('data', (s) => res.stuecke.push(s));
  res.statusCode = null;
  res.kopf = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (koerper) => { res.koerper = koerper; res.end(); return res; };
  res.writeHead = (code, kopfzeilen) => { res.statusCode = code; res.kopf = kopfzeilen; return res; };
  return res;
}

function attrappeRedis(daten = {}) {
  const merkzettel = { gezaehlt: 0, verlauf: [], serverlog: [] };
  return {
    merkzettel,
    get: async (k) => daten[k] ?? null,
    set: async (k, v) => { daten[k] = v; },
    incrby: async (_k, wert) => { merkzettel.gezaehlt += wert; },
    expire: async () => {},
    lpush: async (k, eintrag) => {
      (k === SERVERLOG_KEY ? merkzettel.serverlog : merkzettel.verlauf).unshift(typeof eintrag === 'string' ? JSON.parse(eintrag) : eintrag);
    },
    ltrim: async () => {},
    lrange: async (k) => (k === SERVERLOG_KEY ? merkzettel.serverlog : []),
    del: async () => {},
  };
}

/**
 * Die Verbindungen zum Sender, ersetzt: `antwortGeber(k, optionen)` antwortet
 * fuer Verbindung k. So laesst sich nachstellen, dass manche Server eine alte
 * Sendung halten - der Fall, fuer den `waehleServer` da ist.
 */
async function mitAbruf(antwortGeber, arbeit, adressen = []) {
  const echt = { verbindung: netz.verbindung, einfach: netz.einfach, jetzt: netz.jetzt, adressen: netz.adressen };
  vergiss();
  const aufrufe = [];
  const geschlossen = [];
  const verbindung = (k, adresse = null) => ({
    adresse,
    fetch: async (url, optionen) => {
      aufrufe.push({ url: String(url), optionen, k, adresse });
      return antwortGeber(k, optionen, adresse);
    },
    close: async () => { geschlossen.push(k); },
  });
  netz.verbindung = async (k, adresse) => verbindung(k, adresse);
  netz.adressen = async () => adressen;
  netz.einfach = () => verbindung('einfach');
  // Die Uhr steht fest: 21:10 am Abend der Meldung. Ob eine Sendung als
  // aktuell gilt, darf nicht davon abhaengen, wann die Tests laufen.
  netz.jetzt = () => JETZT;
  try { return await arbeit(aufrufe, geschlossen); } finally { Object.assign(netz, echt); }
}

const FRISCH = 'Sun, 28 Sep 2026 19:05:12 GMT';   // 21:05
const VORHIN = 'Sun, 28 Sep 2026 18:05:12 GMT';   // 20:05
const ALT = 'Sun, 28 Sep 2026 07:05:12 GMT';      // 09:05
const JETZT = Date.parse('Sun, 28 Sep 2026 19:10:00 GMT');  // 21:10

/** Ein Server mit dieser Sendung: ein Byte fuer die Probe, sonst die ganze. */
function server(lastModified, groesse = 3000) {
  return (optionen) => {
    const probe = optionen?.headers?.Range === 'bytes=0-0';
    const laenge = probe ? 1 : groesse;
    return new Response(Buffer.alloc(laenge, 7), {
      status: 206,
      headers: {
        'content-type': 'audio/mpeg', 'content-length': String(laenge),
        'content-range': `bytes 0-${laenge - 1}/${groesse}`, 'last-modified': lastModified,
      },
    });
  };
}

const anfrage = (qs, { method = 'GET', range } = {}) => ({
  method, url: `/api/skill?${qs}`, headers: range ? { range } : {},
});

// --- Reine Funktionen ------------------------------------------------------------

test('senderKennung: fest je Name und Schluessel, sonst nichts', () => {
  const k = senderKennung('swr3', SCHLUESSEL);
  assert.equal(k.length, 22);
  assert.equal(senderKennung('swr3', SCHLUESSEL), k, 'dieselbe bei jedem Aufruf - sie steht in der Adresse');
  assert.notEqual(senderKennung('swr3', 'anderer-schluessel'), k);
  assert.equal(senderKennung('unbekannt', SCHLUESSEL), null, 'nur Namen aus der Tafel');
  assert.equal(senderKennung('swr3', ''), null, 'ohne Schluessel keine Adresse');
});

test('senderAus erkennt die Adresse des Senders und sonst keine', () => {
  assert.equal(senderAus(SWR3), 'swr3');
  assert.equal(senderAus(`${SWR3}?t=1`), null);
  assert.equal(senderAus('https://example.org/k/01.mp3'), null);
  assert.equal(senderAus(undefined), null);
});

test('mitDurchleitung schreibt nur die Sender-Adresse um und nur mit eigener Adresse', () => {
  const [kinder, nachrichten] = mitDurchleitung([KINDER, NACHRICHTEN], BASIS, SCHLUESSEL);
  assert.equal(kinder, KINDER, 'andere Playlists bleiben dasselbe Objekt');
  assert.equal(nachrichten.titel[0].url, `${BASIS}/api/skill?sender=swr3&k=${senderKennung('swr3', SCHLUESSEL)}`);
  assert.equal(nachrichten.titel[0].name, 'SWR3 Nachrichten');
  assert.equal(nachrichten.aktuell, true, 'die Schalter bleiben');
  assert.equal(NACHRICHTEN.titel[0].url, SWR3, 'der Bestand selbst bleibt unangetastet');

  assert.deepEqual(mitDurchleitung([NACHRICHTEN], '', SCHLUESSEL), [NACHRICHTEN], 'ohne eigene Adresse direkt');
  assert.deepEqual(mitDurchleitung([NACHRICHTEN], BASIS, ''), [NACHRICHTEN], 'ohne Schluessel direkt');
  assert.equal(senderUrl(`${BASIS}/`, 'swr3', SCHLUESSEL).startsWith(`${BASIS}/api/skill?`), true);
});

test('Der Echo bekommt die App-Adresse, mit frischem t dahinter', () => {
  const [pl] = mitDurchleitung([NACHRICHTEN], BASIS, SCHLUESSEL);
  const url = playDirektive(pl, 0, 0, { stempel: 1700 }).audioItem.stream.url;
  assert.equal(url, `${BASIS}/api/skill?sender=swr3&k=${senderKennung('swr3', SCHLUESSEL)}&t=1700`);
});

test('sendezeit liest Last-Modified in deutscher Zeit', () => {
  assert.equal(sendezeit('Sun, 28 Sep 2026 18:05:12 GMT'), '20:05');
  assert.equal(sendezeit('Sun, 28 Jan 2026 18:05:12 GMT'), '19:05', 'im Winter eine Stunde weniger Abstand');
  assert.equal(sendezeit(null), null);
  assert.equal(sendezeit('kaputt'), null);
});

// --- Der Skill -------------------------------------------------------------------

test('"Spiele SWR3 Nachrichten" schickt den Echo ueber die App', async () => {
  const res = attrappeRes();
  const body = {
    context: { System: { application: { applicationId: 'amzn1.ask.skill.musik' } } },
    session: { new: true, sessionId: 's', application: { applicationId: 'amzn1.ask.skill.musik' } },
    request: {
      type: 'IntentRequest', timestamp: new Date().toISOString(),
      intent: { name: 'SuchePlaylistIntent', slots: { suche: { name: 'suche', value: 'swr drei nachrichten' } } },
    },
  };
  const redis = attrappeRedis({ [REDIS_KEY]: [KINDER, NACHRICHTEN] });
  await handleSkill(body, res, redis, BASIS);
  const play = res.koerper.response.directives.find(d => d.type === 'AudioPlayer.Play');
  assert.match(play.audioItem.stream.url, new RegExp(`^${BASIS}/api/skill\\?sender=swr3&k=[\\w-]{22}&t=\\d+$`));
});

// --- Der Endpunkt ----------------------------------------------------------------

test('Ohne gueltige Kennung gibt es nichts - und der Sender wird nicht gefragt', async () => {
  await mitAbruf(() => { throw new Error('darf nicht gefragt werden'); }, async (aufrufe) => {
    for (const qs of ['sender=swr3', 'sender=swr3&k=falsch', `sender=andere&k=${senderKennung('swr3', SCHLUESSEL)}`]) {
      const res = attrappeRes();
      await senderTon(anfrage(qs), res, attrappeRedis());
      assert.equal(res.statusCode, 401, qs);
    }
    assert.equal(aufrufe.length, 0);
  });
});

test('Die App fragt vier Server, nimmt den neuesten und reicht die Bytes durch', async () => {
  // Server 0 und 2 halten die Sendung von heute frueh - so wie es das
  // Dashboard beim wiederholten Antippen gezeigt hat.
  const server_ = [server(ALT), server(FRISCH), server(ALT), server(FRISCH)];
  await mitAbruf((k, optionen) => server_[k](optionen), async (aufrufe, geschlossen) => {
    const res = attrappeRes();
    const redis = attrappeRedis();
    const vorher = Date.now();
    await senderTon(anfrage(`sender=swr3&k=${senderKennung('swr3', SCHLUESSEL)}&t=99`, { range: 'bytes=0-' }), res, redis);

    const proben = aufrufe.filter(a => a.optionen.headers.Range === 'bytes=0-0');
    assert.deepEqual(proben.map(a => a.k).sort(), [0, 1, 2, 3], 'jede Verbindung einmal gefragt');
    const abruf = aufrufe.filter(a => a.optionen.headers.Range === 'bytes=0-');
    assert.equal(abruf.length, 1, 'die Sendung einmal geholt');
    assert.ok([1, 3].includes(abruf[0].k), 'ueber eine Verbindung mit der neuen Sendung');

    for (const a of aufrufe) {
      const [ziel, t] = a.url.split('?t=');
      assert.equal(ziel, SWR3, 'nur die Adresse aus der Tafel');
      assert.ok(Number(t) >= vorher, 'mit eigenem frischem t');
      assert.equal(a.optionen.headers['Cache-Control'], 'no-cache');
    }

    assert.equal(res.statusCode, 206, 'wer einen Bereich verlangt, bekommt einen - wie beim FRITZ!NAS-Ton');
    assert.equal(res.kopf['Content-Range'], 'bytes 0-2999/3000');
    assert.equal(res.kopf['Cache-Control'], 'no-store', 'der Echo selbst soll sich nichts merken');
    assert.equal(Buffer.concat(res.stuecke).length, 3000);
    assert.equal(redis.merkzettel.gezaehlt, 3000, 'gegen das Monatsbudget gezaehlt');
    assert.equal(redis.merkzettel.verlauf[0].datei, 'SWR3 (Stand 21:05; Server: 21:05 ×2, 09:05 ×2)',
      'der Verlauf nennt die Sendung und was die Server hatten');
    assert.deepEqual(geschlossen.sort(), [0, 1, 2, 3], 'alle Verbindungen wieder zu');
  });
});

test('Liefert die gewaehlte Verbindung doch die alte Sendung, kommt die naechste dran', async () => {
  // Ein Lastverteiler kann die zweite Anfrage an einen anderen Server geben.
  // Dann darf der Echo nicht die alte Sendung bekommen, nur weil die Probe gut war.
  const abrufe = new Map();
  await mitAbruf((k, optionen) => {
    if (optionen.headers.Range === 'bytes=0-0') return server(k < 2 ? FRISCH : ALT)(optionen);
    abrufe.set(k, (abrufe.get(k) || 0) + 1);
    return server(k === 0 || k === 1 ? (abrufe.size === 1 ? ALT : FRISCH) : ALT)(optionen);
  }, async () => {
    const res = attrappeRes();
    const redis = attrappeRedis();
    await senderTon(anfrage(`sender=swr3&k=${senderKennung('swr3', SCHLUESSEL)}`, { range: 'bytes=0-' }), res, redis);
    assert.equal(abrufe.size, 2, 'die erste Verbindung verworfen, die zweite genommen');
    assert.match(redis.merkzettel.verlauf[0].datei, /^SWR3 \(Stand 21:05;/);
    assert.equal(Buffer.concat(res.stuecke).length, 3000);
  });
});

test('Kommt keine Verbindung zustande, geht es wie frueher mit einem einfachen Abruf', async () => {
  await mitAbruf((k, optionen) => {
    if (k !== 'einfach') throw new Error('keine Verbindung');
    return server(FRISCH)(optionen);
  }, async (aufrufe) => {
    const res = attrappeRes();
    const redis = attrappeRedis();
    await senderTon(anfrage(`sender=swr3&k=${senderKennung('swr3', SCHLUESSEL)}`, { range: 'bytes=0-' }), res, redis);
    assert.equal(aufrufe.filter(a => a.k === 'einfach').length, 1);
    assert.equal(Buffer.concat(res.stuecke).length, 3000, 'besser eine Sendung als Stille');
    assert.match(redis.merkzettel.verlauf[0].datei, /Server: Fehler ×12/, 'drei Runden, dann der Rueckfall');
  });
});

test('frisch: ab xx:08 muss es die Sendung der laufenden Stunde sein', () => {
  const um = (zeit) => Date.parse(`Sun, 28 Sep 2026 ${zeit} GMT`);
  assert.equal(frisch(Date.parse(FRISCH), JETZT), true, '21:05 um 21:10');
  assert.equal(frisch(Date.parse(VORHIN), um('19:04:00')), true, '20:05 um 21:04 - die neue ist noch nicht da');
  assert.equal(frisch(Date.parse(VORHIN), um('19:07:59')), true, '20:05 um 21:07 - noch in der Schonfrist');
  assert.equal(frisch(Date.parse(VORHIN), um('19:08:00')), false, '20:05 um 21:08 - jetzt wird weitergesucht');
  assert.equal(frisch(Date.parse(VORHIN), JETZT), false, '20:05 um 21:10 - der gemeldete Fall');
  assert.equal(frisch(Date.parse(FRISCH), um('20:03:00')), true, '21:05 um 22:03');
  assert.equal(frisch(Date.parse(ALT), JETZT), false);
  assert.equal(frisch(0, JETZT), false);
  assert.equal(frisch(-1, JETZT), false, 'ein Fehler ist nie aktuell');
});

test('Hat keiner der ersten vier die aktuelle Sendung, wird weitergefragt', async () => {
  // Der gemeldete Fall: 20:05 ×1, 09:05 ×3 um kurz nach 21 Uhr. Erst in der
  // zweiten Runde hat einer die Sendung von 21:05.
  const zeiten = [VORHIN, ALT, ALT, ALT, ALT, ALT, FRISCH, ALT, FRISCH, FRISCH, FRISCH, FRISCH];
  await mitAbruf((k, optionen) => server(zeiten[k])(optionen), async (aufrufe, geschlossen) => {
    const res = attrappeRes();
    const redis = attrappeRedis();
    await senderTon(anfrage(`sender=swr3&k=${senderKennung('swr3', SCHLUESSEL)}`, { range: 'bytes=0-' }), res, redis);
    const proben = aufrufe.filter(a => a.optionen.headers.Range === 'bytes=0-0');
    assert.equal(proben.length, 8, 'zwei Runden, die dritte nicht mehr');
    const abruf = aufrufe.find(a => a.optionen.headers.Range === 'bytes=0-');
    assert.equal(abruf.k, 6, 'ueber die Verbindung, die 21:05 hatte');
    assert.equal(redis.merkzettel.verlauf[0].datei, 'SWR3 (Stand 21:05; Server: 21:05 ×1, 20:05 ×1, 09:05 ×6)');
    assert.equal(geschlossen.length, 8, 'alle Verbindungen beider Runden wieder zu');
  });
});

test('Findet auch die dritte Runde nichts Aktuelles, gilt die neueste gefundene', async () => {
  const zeiten = [ALT, ALT, VORHIN, ALT, ALT, ALT, ALT, ALT, ALT, ALT, ALT, ALT];
  await mitAbruf((k, optionen) => server(zeiten[k])(optionen), async (aufrufe) => {
    const stand = await senderStand('swr3');
    assert.equal(aufrufe.length, 12, 'drei Runden, dann Schluss');
    assert.equal(stand.sendezeit, '20:05');
    assert.equal(stand.server, '20:05 ×1, 09:05 ×11', 'die neueste zuerst');
  });
});

test('Die Frist begrenzt die Runden', async () => {
  // Jede Probe braucht 60 ms, die Frist ist 100 ms: Die zweite Runde faengt
  // noch an, eine dritte nicht mehr.
  await mitAbruf(async (k, optionen) => {
    await new Promise(r => setTimeout(r, 60));
    return server(ALT)(optionen);
  }, async (aufrufe) => {
    const { schliessen } = await waehleServer('swr3', { frist: 100 });
    await schliessen();
    assert.equal(aufrufe.length, 8);
  });
});

test('serverBild zaehlt, was die Server hatten', () => {
  assert.equal(serverBild([
    { lastModified: FRISCH, ok: true }, { lastModified: ALT, ok: true },
    { lastModified: FRISCH, ok: true }, { fehler: 'keine Antwort in 4000 ms' },
  ]), '21:05 ×2, 09:05 ×1, Fehler ×1');
});

test('Ein Fehler beim Sender wird ein 502 und steht im Verlauf', async () => {
  await mitAbruf(() => new Response('weg', { status: 404 }), async () => {
    const res = attrappeRes();
    const redis = attrappeRedis();
    await senderTon(anfrage(`sender=swr3&k=${senderKennung('swr3', SCHLUESSEL)}`), res, redis);
    assert.equal(res.statusCode, 502);
    assert.equal(redis.merkzettel.verlauf[0].grund, 'HTTP 404');
  });
});

test('Das Dashboard erfaehrt, welche Sendung die App gerade bekommt', async () => {
  const server_ = [server(ALT), server(FRISCH), server(FRISCH), server(FRISCH)];
  await mitAbruf((k, optionen) => server_[k](optionen), async (aufrufe) => {
    const stand = await senderStand('swr3');
    assert.equal(stand.sendezeit, '21:05', 'die neueste, auch wenn ein Server die alte hat');
    assert.equal(stand.server, '21:05 ×3, 09:05 ×1');
    assert.equal(stand.gesprochen, '21 Uhr', 'die Stunde fuer den Beispielsatz im Dashboard');
    assert.ok(aufrufe.every(a => a.optionen.headers.Range === 'bytes=0-0'), 'ein Byte genuegt');

    const res = attrappeRes();
    await handleManage({ method: 'GET', url: '/api/manage?type=playlists&sender=swr3', headers: { host: 'meine-app.vercel.app' } }, res, attrappeRedis());
    assert.equal(res.koerper.sendezeit, '21:05');
    assert.equal(res.koerper.url, `${BASIS}/api/skill?sender=swr3&k=${senderKennung('swr3', SCHLUESSEL)}`,
      'der Anhoer-Knopf hoert, was der Echo hoert');
  });
  assert.deepEqual(await senderStand('unbekannt'), { error: 'Unknown station' });
});

test('Die Proben gehen reihum an alle Adressen, auch die der oeffentlichen Namensdienste', async () => {
  // Gemeldet um 22 Uhr: je Abruf hatten alle Server dasselbe - welche Gruppe
  // antwortet, haengt an der Adresse. Hier hat nur 10.0.0.3 die neue Sendung.
  const zeiten = { '10.0.0.1': VORHIN, '10.0.0.2': VORHIN, '10.0.0.3': FRISCH };
  await mitAbruf((k, optionen, adresse) => server(zeiten[adresse])(optionen), async (aufrufe) => {
    const stand = await senderStand('swr3');
    assert.deepEqual(aufrufe.map(a => a.adresse), ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.1']);
    assert.equal(stand.sendezeit, '21:05');
    assert.equal(stand.server, '21:05 ×1, 20:05 ×3');
  }, ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
});

test('Die Adresse mit der neuesten Sendung wird gemerkt und beim naechsten Mal zuerst gefragt', async () => {
  const zeiten = { '10.0.0.1': VORHIN, '10.0.0.2': VORHIN, '10.0.0.3': FRISCH };
  const redis = attrappeRedis();
  await mitAbruf((k, optionen, adresse) => server(zeiten[adresse])(optionen), async () => {
    await senderStand('swr3', undefined, redis);
  }, ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  assert.deepEqual(await redis.get(GEMERKT_KEY), { swr3: { adresse: '10.0.0.3', zeit: Date.parse(FRISCH) } });

  // Eine andere Function-Instanz (nichts im Speicher) liest es aus Redis:
  // Der Anhoer-Knopf fragt dort zuerst, wo die Anzeige die Sendung fand.
  await mitAbruf((k, optionen, adresse) => server(zeiten[adresse])(optionen), async (aufrufe) => {
    assert.deepEqual(await adressenFuer('swr3', redis), ['10.0.0.3', '10.0.0.1', '10.0.0.2']);
    const res = attrappeRes();
    await senderTon(anfrage(`sender=swr3&k=${senderKennung('swr3', SCHLUESSEL)}`, { range: 'bytes=0-' }), res, redis);
    assert.equal(aufrufe[0].adresse, '10.0.0.3');
    assert.equal(aufrufe.find(a => a.optionen.headers.Range === 'bytes=0-').adresse, '10.0.0.3');
  }, ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
});

test('Das Server-Log zeigt je Wahl, welche Adresse was hatte - die gewaehlte zuerst', async () => {
  const zeiten = { '10.0.0.1': VORHIN, '10.0.0.2': VORHIN, '10.0.0.3': FRISCH };
  const redis = attrappeRedis();
  const quellen = { '10.0.0.1': ['System', '1.1.1.1'], '10.0.0.2': ['8.8.8.8'], '10.0.0.3': ['9.9.9.9'] };
  await mitAbruf((k, optionen, adresse) => server(zeiten[adresse])(optionen), async () => {
    netz.adressen = async () => Object.defineProperty(['10.0.0.1', '10.0.0.2', '10.0.0.3'], 'quellen', { value: quellen });
    await senderStand('swr3', undefined, redis, 'Dashboard');
    const res = attrappeRes();
    await senderTon(anfrage(`sender=swr3&k=${senderKennung('swr3', SCHLUESSEL)}`, { range: 'bytes=0-' }), res, redis);
  }, ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  const log = await serverLogLesen(redis);
  assert.deepEqual(log.map(e => e.anlass), ['Echo', 'Dashboard']);
  assert.deepEqual(log[1].proben[0], { adresse: '10.0.0.3', dns: ['9.9.9.9'], stand: '21:05' });
  assert.deepEqual(log[1].proben[1].dns, ['System', '1.1.1.1']);
  // Beim Echo danach steht die gemerkte Adresse vorn - und dass sie gemerkt war.
  assert.deepEqual(log[0].proben.find(p => p.adresse === '10.0.0.3').dns, ['9.9.9.9', 'gemerkt']);
  assert.equal(log[1].proben.length, 4);
  assert.ok(log[1].proben.slice(1).every(p => p.stand === '20:05'));
  // Ohne Anlass (etwa die Tests oben) wird nichts geschrieben.
  const still = attrappeRedis();
  await mitAbruf((k, optionen) => server(FRISCH)(optionen), () => senderStand('swr3', undefined, still));
  assert.equal(still.merkzettel.serverlog.length, 0);
});

test('Ohne Adressen fragt die Verbindung selbst nach dem Namen', async () => {
  await mitAbruf((k, optionen) => server(FRISCH)(optionen), async (aufrufe) => {
    await senderStand('swr3');
    assert.ok(aufrufe.every(a => a.adresse === null));
  });
});

// --- Die Zeitansage ----------------------------------------------------------------
//
// "Ich spiele die SWR3 Nachrichten von 21 Uhr." statt "Ich spiele SWR3 Nachrichten." -
// geschaltet in der SWR3-Karte, und die Uhrzeit ist die der Sendung, die die
// App gerade beim Sender bekommt.

function spieleNachrichten(playlist, redis = attrappeRedis({ [REDIS_KEY]: [playlist] })) {
  const res = attrappeRes();
  const body = {
    context: { System: { application: { applicationId: 'amzn1.ask.skill.musik' } } },
    session: { new: true, sessionId: 's', application: { applicationId: 'amzn1.ask.skill.musik' } },
    request: {
      type: 'IntentRequest', timestamp: new Date().toISOString(),
      intent: { name: 'SuchePlaylistIntent', slots: { suche: { name: 'suche', value: 'swr3 nachrichten' } } },
    },
  };
  return handleSkill(body, res, redis, BASIS).then(() => res.koerper.response);
}

test('sendezeitGesprochen: nur die volle Stunde', () => {
  assert.equal(sendezeitGesprochen('Sun, 28 Sep 2026 18:05:12 GMT'), '20 Uhr', 'die Sendung von 20:05 sind die Nachrichten von 20 Uhr');
  assert.equal(sendezeitGesprochen('Sun, 28 Sep 2026 19:00:00 GMT'), '21 Uhr');
  assert.equal(sendezeitGesprochen('Sun, 28 Sep 2026 18:59:59 GMT'), '20 Uhr', 'nie aufgerundet');
  assert.equal(sendezeitGesprochen('Sun, 28 Sep 2026 22:05:00 GMT'), '0 Uhr', 'nach Mitternacht');
  assert.equal(sendezeitGesprochen('Wed, 28 Jan 2026 08:05:00 GMT'), '9 Uhr', 'Winterzeit');
  assert.equal(sendezeitGesprochen(null), null);
});

test('validierePlaylist: die Zeitansage ist aus, bis sie jemand anschaltet', () => {
  assert.equal(validierePlaylist({ name: 'A', urls: SWR3 }).playlist.zeitansage, false);
  assert.equal(validierePlaylist({ name: 'A', urls: SWR3, zeitansage: true }).playlist.zeitansage, true);
  assert.equal(validierePlaylist({ name: 'A', urls: SWR3 }, { zeitansage: true }).playlist.zeitansage, true,
    'ein fehlendes Feld laesst den gespeicherten Wert stehen');
  assert.equal(sagtZeitAn(KINDER), false);
});

test('Mit Zeitansage sagt Alexa die Sendezeit der neuesten Sendung', async () => {
  const server_ = [server(ALT), server(FRISCH), server(ALT), server(FRISCH)];
  await mitAbruf((k, optionen) => server_[k](optionen), async (aufrufe) => {
    const r = await spieleNachrichten({ ...NACHRICHTEN, zeitansage: true });
    assert.equal(r.outputSpeech.text, 'Ich spiele die SWR3 Nachrichten von 21 Uhr.');
    assert.ok(r.directives.some(d => d.type === 'AudioPlayer.Play'), 'und die Sendung laeuft');
    assert.ok(aufrufe.every(a => a.optionen.headers.Range === 'bytes=0-0'), 'vor der Antwort nur Proben');
  });
});

test('Die Zeitansage geht auch ohne Ansage - dann ohne "Ich spiele die"', async () => {
  await mitAbruf((k, optionen) => server(FRISCH)(optionen), async () => {
    const r = await spieleNachrichten({ ...NACHRICHTEN, zeitansage: true, ansage: false });
    assert.equal(r.outputSpeech.text, 'SWR3 Nachrichten von 21 Uhr.');
    assert.ok(r.directives.some(d => d.type === 'AudioPlayer.Play'), 'und die Sendung laeuft');
  });
});

test('Ohne Zeitansage oder ohne Auskunft bleibt es beim alten Satz - oder bei Stille', async () => {
  await mitAbruf((k, optionen) => server(FRISCH)(optionen), async (aufrufe) => {
    const ohne = await spieleNachrichten(NACHRICHTEN);
    assert.equal(ohne.outputSpeech.text, 'Ich spiele SWR3 Nachrichten.');
    const still = await spieleNachrichten({ ...NACHRICHTEN, ansage: false });
    assert.equal(still.outputSpeech, undefined, 'weder Ansage noch Zeitansage: Stille');
    assert.equal(aufrufe.length, 0, 'und ohne Zeitansage wird der Sender vorher nicht gefragt');
  });
  await mitAbruf(() => { throw new Error('keine Verbindung'); }, async () => {
    const r = await spieleNachrichten({ ...NACHRICHTEN, zeitansage: true });
    assert.equal(r.outputSpeech.text, 'Ich spiele SWR3 Nachrichten.', 'kein Stand - dann eben ohne Uhrzeit');
    const still = await spieleNachrichten({ ...NACHRICHTEN, zeitansage: true, ansage: false });
    assert.equal(still.outputSpeech, undefined, 'ohne Ansage und ohne Stand: Stille');
    assert.ok(still.directives.some(d => d.type === 'AudioPlayer.Play'), 'die Sendung laeuft trotzdem');
  });
});

test('Eine Zeitansage bei Musik bleibt folgenlos', async () => {
  await mitAbruf(() => { throw new Error('darf nicht gefragt werden'); }, async (aufrufe) => {
    const lieder = { ...KINDER, zeitansage: true };
    const res = attrappeRes();
    await handleSkill({
      context: { System: { application: { applicationId: 'x' } } },
      session: { new: true, sessionId: 's', application: { applicationId: 'x' } },
      request: { type: 'IntentRequest', timestamp: new Date().toISOString(),
        intent: { name: 'SuchePlaylistIntent', slots: { suche: { name: 'suche', value: 'kinderlieder' } } } },
    }, res, attrappeRedis({ [REDIS_KEY]: [lieder] }), BASIS);
    assert.equal(res.koerper.response.outputSpeech.text, 'Ich spiele Kinderlieder.');
    assert.equal(aufrufe.length, 0);
  });
});
