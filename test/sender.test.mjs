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
  netz, serverBild,
} from '../lib/sender.js'
import { playDirektive, handleSkill, handleManage, REDIS_KEY } from '../lib/musik.js'

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
  const merkzettel = { gezaehlt: 0, verlauf: [] };
  return {
    merkzettel,
    get: async (k) => daten[k] ?? null,
    set: async (k, v) => { daten[k] = v; },
    incrby: async (_k, wert) => { merkzettel.gezaehlt += wert; },
    expire: async () => {},
    lpush: async (_k, eintrag) => { merkzettel.verlauf.unshift(typeof eintrag === 'string' ? JSON.parse(eintrag) : eintrag); },
    ltrim: async () => {},
    lrange: async () => [],
    del: async () => {},
  };
}

/**
 * Die Verbindungen zum Sender, ersetzt: `antwortGeber(k, optionen)` antwortet
 * fuer Verbindung k. So laesst sich nachstellen, dass manche Server eine alte
 * Sendung halten - der Fall, fuer den `waehleServer` da ist.
 */
async function mitAbruf(antwortGeber, arbeit) {
  const echt = { verbindung: netz.verbindung, einfach: netz.einfach };
  const aufrufe = [];
  const geschlossen = [];
  const verbindung = (k) => ({
    fetch: async (url, optionen) => {
      aufrufe.push({ url: String(url), optionen, k });
      return antwortGeber(k, optionen);
    },
    close: async () => { geschlossen.push(k); },
  });
  netz.verbindung = async (k) => verbindung(k);
  netz.einfach = () => verbindung('einfach');
  try { return await arbeit(aufrufe, geschlossen); } finally { Object.assign(netz, echt); }
}

const FRISCH = 'Sun, 28 Sep 2026 19:05:12 GMT';   // 21:05
const ALT = 'Sun, 28 Sep 2026 07:05:12 GMT';      // 09:05

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
    assert.match(redis.merkzettel.verlauf[0].datei, /Server: Fehler ×4/);
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
    assert.ok(aufrufe.every(a => a.optionen.headers.Range === 'bytes=0-0'), 'ein Byte genuegt');

    const res = attrappeRes();
    await handleManage({ method: 'GET', url: '/api/manage?type=playlists&sender=swr3', headers: { host: 'meine-app.vercel.app' } }, res, attrappeRedis());
    assert.equal(res.koerper.sendezeit, '21:05');
    assert.equal(res.koerper.url, `${BASIS}/api/skill?sender=swr3&k=${senderKennung('swr3', SCHLUESSEL)}`,
      'der Anhoer-Knopf hoert, was der Echo hoert');
  });
  assert.deepEqual(await senderStand('unbekannt'), { error: 'Unknown station' });
});
