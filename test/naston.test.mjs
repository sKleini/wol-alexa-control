// test/naston.test.mjs – der Durchleiter, ohne Netz und ohne FRITZ!Box.
//
//   node --test
//
// Geprueft werden die reinen Funktionen: das unterschriebene Token, die
// Adresse, die in der Playlist landet, das Umschreiben alter Adressen, die
// Bereichsrechnung samt Kappung und der Kopf, den der Echo zu sehen bekommt.
// Und am Ende der Durchlauf selbst, mit Attrappen statt FRITZ!Box - Netz
// braucht auch er nicht.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tonToken,
  tonTokenLesen,
  tonUrl,
  alsTonUrl,
  eigeneBasis,
  bereich,
  antwortKopf,
  kopfFuerHead,
  kappungBytes,
  budgetBytes,
  monatsSchluessel,
  lesbareMenge,
} from '../lib/naston.js'

const FREIGABE = 'https://abc.myfritz.net:456/nas/filelink.lua?id=535f52fbb2016f4f';
const PFAD = '/Das doppelte Lottchen/01 - Die Buehne.mp3';
const SCHLUESSEL = 'geheim-und-lang-genug';
const BASIS = 'https://meine-app.vercel.app';

/** Ein Headers-Objekt, wie fetch es liefert. */
const kopf = (eintraege) => new Headers(eintraege);

test('Token traegt Link und Pfad und kommt unveraendert zurueck', () => {
  const token = tonToken(FREIGABE, PFAD, SCHLUESSEL);
  assert.ok(token, 'Token wird gebaut');
  assert.deepEqual(tonTokenLesen(token, SCHLUESSEL), { link: FREIGABE, pfad: PFAD });
});

test('Token ohne gueltige Unterschrift gilt nicht', () => {
  const token = tonToken(FREIGABE, PFAD, SCHLUESSEL);
  const [nutzlast, unterschrift] = token.split('.');

  assert.equal(tonTokenLesen(token, 'anderer-schluessel'), null, 'fremder Schluessel');
  assert.equal(tonTokenLesen(`${nutzlast}x.${unterschrift}`, SCHLUESSEL), null, 'Nutzlast veraendert');
  assert.equal(tonTokenLesen(`${nutzlast}.${unterschrift}x`, SCHLUESSEL), null, 'Unterschrift veraendert');
  assert.equal(tonTokenLesen(nutzlast, SCHLUESSEL), null, 'ohne Unterschrift');
  assert.equal(tonTokenLesen('', SCHLUESSEL), null, 'leer');
  assert.equal(tonTokenLesen(token, ''), null, 'ohne Schluessel gilt nichts');
});

test('Token wird nur fuer eine FRITZ!NAS-Freigabe gebaut', () => {
  assert.equal(tonToken('https://example.org/musik/01.mp3', PFAD, SCHLUESSEL), null);
  assert.equal(tonToken(FREIGABE, PFAD, ''), null, 'ohne Schluessel kein Token');
});

test('tonUrl zeigt auf den Skill-Endpunkt und bleibt kurz genug', () => {
  const url = new URL(tonUrl(BASIS, FREIGABE, PFAD, SCHLUESSEL));
  assert.equal(url.origin, BASIS);
  assert.equal(url.pathname, '/api/skill');
  // Der Pfad mit Leerzeichen muss die Adresse heil ueberstehen - er ist der
  // Normalfall, nicht die Ausnahme.
  assert.deepEqual(tonTokenLesen(url.searchParams.get('ton'), SCHLUESSEL), { link: FREIGABE, pfad: PFAD });
  assert.ok(url.href.length < 2048, `Adresse bleibt unter MAX_URL (${url.href.length})`);
  assert.equal(tonUrl('', FREIGABE, PFAD, SCHLUESSEL), null, 'ohne Basis keine Adresse');
});

test('eigeneBasis nimmt den Host der Anfrage', () => {
  assert.equal(eigeneBasis({ headers: { host: 'meine-app.vercel.app' } }), 'https://meine-app.vercel.app');
  assert.equal(
    eigeneBasis({ headers: { 'x-forwarded-host': 'eigene.domain, andere' } }),
    'https://eigene.domain',
    'der erste Eintrag gilt',
  );
  assert.equal(eigeneBasis({ headers: {} }), '', 'ohne Host keine Basis');
});

test('alsTonUrl schreibt eine alte Sitzungsadresse um und sonst nichts', () => {
  const quelle = { typ: 'fritz', link: FREIGABE };
  const alt = 'https://abc.myfritz.net:456/nas/cgi-bin/luacgi_notimeout'
    + '?script=%2Fapi%2Fdata.lua&sid=83f20d7cb327ab09&c=music&a=get'
    + `&path=${encodeURIComponent(PFAD)}`;

  const neu = alsTonUrl(alt, quelle, BASIS, SCHLUESSEL);
  assert.notEqual(neu, alt);
  const token = new URL(neu).searchParams.get('ton');
  assert.deepEqual(tonTokenLesen(token, SCHLUESSEL), { link: FREIGABE, pfad: PFAD });

  // Alles andere bleibt, wie es ist.
  assert.equal(alsTonUrl('https://example.org/01.mp3', quelle, BASIS, SCHLUESSEL), 'https://example.org/01.mp3');
  assert.equal(alsTonUrl(FREIGABE, quelle, BASIS, SCHLUESSEL), FREIGABE, 'eine Dateifreigabe wird nicht angefasst');
  assert.equal(alsTonUrl(alt, null, BASIS, SCHLUESSEL), alt, 'ohne Herkunft fehlt der Freigabe-Link');
  assert.equal(alsTonUrl(alt, quelle, '', SCHLUESSEL), alt, 'ohne Basis bleibt es beim Alten');
  const ohnePfad = 'https://abc.myfritz.net:456/nas/cgi-bin/luacgi_notimeout?script=%2Fapi%2Fdata.lua&sid=83f20d7cb327ab09';
  assert.equal(alsTonUrl(ohnePfad, quelle, BASIS, SCHLUESSEL), ohnePfad, 'ohne path-Parameter kein Token');
});

test('bereich kappt, was zu gross waere', () => {
  const kappung = 16 * 1024 * 1024;

  const ohne = bereich(undefined, kappung);
  assert.deepEqual(
    { von: ohne.von, bis: ohne.bis, gefragt: ohne.gefragt },
    { von: 0, bis: kappung - 1, gefragt: false },
  );
  assert.equal(ohne.kopfzeile, `bytes=0-${kappung - 1}`);

  const ab = bereich('bytes=5000000-', kappung);
  assert.deepEqual({ von: ab.von, bis: ab.bis, gefragt: ab.gefragt }, { von: 5000000, bis: 5000000 + kappung - 1, gefragt: true });

  const klein = bereich('bytes=0-1023', kappung);
  assert.equal(klein.bis, 1023, 'ein kleinerer Wunsch bleibt klein');

  const ohneKappung = bereich('bytes=0-', 0);
  assert.equal(ohneKappung.bis, null);
  assert.equal(ohneKappung.kopfzeile, 'bytes=0-');

  const krumm = bereich('haeh?', kappung);
  assert.deepEqual({ von: krumm.von, gefragt: krumm.gefragt }, { von: 0, gefragt: false }, 'unverstaendlich zaehlt wie gar nicht');
});

test('antwortKopf reicht durch, macht aber aus einer ganzen Datei ein 200', () => {
  const teil = antwortKopf(206, kopf({
    'content-type': 'audio/mpeg',
    'content-range': 'bytes 0-16777215/52428800',
    'content-length': '16777216',
  }), false);
  assert.equal(teil.status, 206);
  assert.equal(teil.kopf['Content-Range'], 'bytes 0-16777215/52428800');
  assert.equal(teil.kopf['Accept-Ranges'], 'bytes');

  const ganzUngefragt = antwortKopf(206, kopf({
    'content-type': 'audio/mpeg',
    'content-range': 'bytes 0-4999999/5000000',
    'content-length': '5000000',
  }), false);
  assert.equal(ganzUngefragt.status, 200, 'wer nicht gefragt hat, bekommt die Datei als Ganzes');
  assert.equal(ganzUngefragt.kopf['Content-Range'], undefined);
  assert.equal(ganzUngefragt.kopf['Content-Length'], '5000000');

  const ganzGefragt = antwortKopf(206, kopf({
    'content-type': 'audio/mpeg',
    'content-range': 'bytes 0-4999999/5000000',
  }), true);
  assert.equal(ganzGefragt.status, 206, 'wer gefragt hat, bekommt seine Antwort auf die Frage');
});

test('kopfFuerHead nennt die Groesse der ganzen Datei', () => {
  const k = kopfFuerHead(kopf({
    'content-type': 'audio/mpeg',
    'content-range': 'bytes 0-0/5000000',
    'content-length': '1',
  }));
  assert.equal(k['Content-Length'], '5000000', 'nicht das eine geholte Byte');
  assert.equal(k['Content-Type'], 'audio/mpeg');
  assert.equal(k['Accept-Ranges'], 'bytes');
});

test('Kappung und Budget kommen aus der Umgebung', () => {
  const vorher = { max: process.env.MUSIK_TON_MAX_MB, budget: process.env.MUSIK_TON_BUDGET_GB };
  try {
    delete process.env.MUSIK_TON_MAX_MB;
    delete process.env.MUSIK_TON_BUDGET_GB;
    assert.equal(kappungBytes(), 0, 'Vorgabe: keine Kappung');
    assert.equal(budgetBytes(), 50 * 1024 ** 3, 'Vorgabe 50 GB');

    process.env.MUSIK_TON_MAX_MB = '8';
    assert.equal(kappungBytes(), 8 * 1024 * 1024, 'gesetzt wird gekappt');
    process.env.MUSIK_TON_BUDGET_GB = '0';
    assert.equal(budgetBytes(), 0, '0 heisst: kein Budget');

    process.env.MUSIK_TON_MAX_MB = 'viel';
    assert.equal(kappungBytes(), 0, 'Unsinn faellt auf die Vorgabe zurueck');
  } finally {
    if (vorher.max === undefined) delete process.env.MUSIK_TON_MAX_MB; else process.env.MUSIK_TON_MAX_MB = vorher.max;
    if (vorher.budget === undefined) delete process.env.MUSIK_TON_BUDGET_GB; else process.env.MUSIK_TON_BUDGET_GB = vorher.budget;
  }
});

test('Der Zaehler haengt am Kalendermonat', () => {
  assert.equal(monatsSchluessel(new Date('2026-09-20T18:04:00Z')), 'musik_ton_monat:2026-09');
  assert.equal(monatsSchluessel(new Date('2026-01-01T00:00:00Z')), 'musik_ton_monat:2026-01');
});

test('lesbareMenge sagt, was durchgelaufen ist', () => {
  assert.equal(lesbareMenge(512), '512 B');
  assert.equal(lesbareMenge(2048), '2 KB');
  assert.equal(lesbareMenge(5 * 1024 ** 2), '5.0 MB');
  assert.equal(lesbareMenge(3.25 * 1024 ** 3), '3.25 GB');
});

// --- Der Durchlauf selbst, mit Attrappen statt Box ---------------------------
//
// Die Freigabe zeigt auf eine numerische Adresse: `zielErlaubt` loest sie dann
// ohne Namensdienst auf, und der Abruf selbst wird ersetzt. Damit laeuft auch
// dieser Teil ohne Netz.
import { PassThrough, Writable } from 'node:stream'
import { nasTon } from '../lib/naston.js'

const BOX = 'https://203.0.113.10:456/nas/filelink.lua?id=535f52fbb2016f4f';

function attrappeRes() {
  const res = new PassThrough();
  res.stuecke = [];
  res.on('data', (s) => res.stuecke.push(s));
  res.statusCode = null;
  res.kopf = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.writeHead = (code, kopfzeilen) => { res.statusCode = code; res.kopf = kopfzeilen; return res; };
  return res;
}

function attrappeRedis(stand = 0, laeuft = null) {
  const merkzettel = { gezaehlt: 0, gemerkt: laeuft, geloescht: 0, verlauf: [] };
  return {
    merkzettel,
    // Der Zaehler und der Merkzettel liegen unter verschiedenen Schluesseln -
    // und `stand` ist nur der des Zaehlers.
    get: async (k) => (k === 'musik_ton_laeuft' ? merkzettel.gemerkt : stand),
    set: async (k, v) => { if (k === 'musik_ton_laeuft') merkzettel.gemerkt = v; },
    del: async (k) => {
      if (k === 'musik_ton_laeuft') { merkzettel.gemerkt = null; merkzettel.geloescht += 1; }
      if (k === VERLAUF_KEY) { merkzettel.verlauf = []; }
    },
    incrby: async (_k, wert) => { merkzettel.gezaehlt += wert; },
    expire: async () => {},
    lpush: async (_k, eintrag) => { merkzettel.verlauf.unshift(eintrag); },
    ltrim: async () => {},
    lrange: async () => merkzettel.verlauf,
  };
}

/** Wartet, bis die Attrappe fertig geschrieben ist. */
const fertig = (res) => new Promise(a => res.on('end', a));

async function mitAbruf(antwortGeber, arbeit) {
  const echt = globalThis.fetch;
  const aufrufe = [];
  globalThis.fetch = async (url, optionen) => {
    aufrufe.push({ url: String(url), optionen });
    return antwortGeber(aufrufe.length, optionen);
  };
  try { return await arbeit(aufrufe); } finally { globalThis.fetch = echt; }
}

test('die Logzeile nennt Bereich, Status, Menge und Dauer', async () => {
  // Der gemeldete Hoerbuch-Abbruch liess sich nur rekonstruieren, weil Vercel
  // selbst Dauer und Status je Anfrage mitschreibt - die eigene Zeile nannte
  // Datei und Menge und sonst nichts. Jetzt steht alles beisammen.
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = attrappeRes();
  const zeilen = [];
  const echtesLog = console.log;
  console.log = (...teile) => zeilen.push(teile.join(' '));

  try {
    await mitAbruf(() => new Response(Buffer.alloc(2048, 1), {
      status: 206,
      headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 1000-3047/9000', 'content-length': '2048' },
    }), async () => {
      const lauf = nasTon({ method: 'GET', headers: { range: 'bytes=1000-' } }, res, attrappeRedis(), token, async () => 'aabbccddeeff0011');
      await Promise.all([lauf, fertig(res)]);
    });
  } finally {
    console.log = echtesLog;
  }

  const zeile = zeilen.find(z => z.includes('musik-box Ton'));
  assert.ok(zeile, 'es gibt eine Zeile');
  assert.match(zeile, /bytes=1000-/, 'der verlangte Bereich');
  assert.match(zeile, /→ 206/, 'der Status, den der Echo bekommt');
  assert.match(zeile, /2 KB/, 'die Menge, die wirklich floss');
  assert.match(zeile, /in \d+ ms/, 'und wie lange es dauerte');
});

test('nasTon weist ein Token ohne gueltige Unterschrift ab, ohne die Box zu fragen', async () => {
  const res = attrappeRes();
  await mitAbruf(() => { throw new Error('haette nicht abrufen duerfen'); }, async () => {
    await nasTon({ method: 'GET', headers: {} }, res, attrappeRedis(), 'kaputt.kaputt', async () => 'sid');
  });
  assert.equal(res.statusCode, 401);
});

test('ohne Kappung wird gestroemt, mit Kappung am Stueck geliefert', async () => {
  // Der Unterschied ist keine Geschmacksfrage: Eine eingesammelte Antwort
  // darf bei Vercel 4,5 MB gross sein, eine gestroemte mehr - und ob gestroemt
  // wird, entscheidet die Laufzeit. Ein gekapptes Stueck passt in beides.
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const ton = Buffer.alloc(2048, 5);
  const vorherMax = process.env.MUSIK_TON_MAX_MB;

  for (const [kappung, erwartet] of [['1', 2048], ['0', 2048]]) {
    process.env.MUSIK_TON_MAX_MB = kappung;
    const res = attrappeRes();
    const redis = attrappeRedis();
    await mitAbruf(() => new Response(ton, {
      status: 206,
      headers: { 'content-type': 'audio/mpeg', 'content-range': `bytes 0-2047/9000`, 'content-length': '2048' },
    }), async () => {
      const lauf = nasTon({ method: 'GET', headers: { range: 'bytes=0-2047' } }, res, redis, token, async () => 'aabbccddeeff0011');
      await Promise.all([lauf, fertig(res)]);
    });
    assert.equal(res.statusCode, 206, `Kappung ${kappung}`);
    assert.equal(Buffer.concat(res.stuecke).length, erwartet, `Kappung ${kappung}: alle Bytes`);
    assert.equal(redis.merkzettel.gezaehlt, erwartet, `Kappung ${kappung}: gezaehlt`);
  }
  if (vorherMax === undefined) delete process.env.MUSIK_TON_MAX_MB; else process.env.MUSIK_TON_MAX_MB = vorherMax;
});

test('ohne Kappung geht der Bereich des Abspielers unveraendert an die Box', async () => {
  // **Der Fehler, gegen den dieser Test steht.** Mit Kappung bekam der Echo
  // vier Megabyte als 206, spielte sie, meldete den Titel als beendet - und
  // holte den Rest nicht nach. Von aussen: Der Titel bricht nach gut einer
  // Minute ab, der naechste beginnt. Also wird nicht mehr gekappt, und was
  // der Abspieler verlangt, verlangt auch der Durchleiter.
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const ganz = Buffer.alloc(9000, 7);
  const vorher = process.env.MUSIK_TON_MAX_MB;
  delete process.env.MUSIK_TON_MAX_MB;

  try {
    for (const [gefragt, erwartet] of [[undefined, 'bytes=0-'], ['bytes=1000-', 'bytes=1000-']]) {
      const res = attrappeRes();
      const aufrufe = await mitAbruf(() => new Response(ganz, {
        status: 206,
        headers: { 'content-type': 'audio/mpeg', 'content-range': `bytes 0-8999/9000`, 'content-length': '9000' },
      }), async (gesehen) => {
        const lauf = nasTon({ method: 'GET', headers: gefragt ? { range: gefragt } : {} },
          res, attrappeRedis(), token, async () => 'aabbccddeeff0011');
        await Promise.all([lauf, fertig(res)]);
        return gesehen;
      });
      assert.equal(aufrufe[0].optionen.headers.Range, erwartet, `Bereich "${gefragt || 'keiner'}" wird durchgereicht`);
      assert.equal(Buffer.concat(res.stuecke).length, 9000, 'und alle Bytes kommen an');
    }
  } finally {
    if (vorher === undefined) delete process.env.MUSIK_TON_MAX_MB; else process.env.MUSIK_TON_MAX_MB = vorher;
  }
});

test('nasTon reicht die Bytes durch, zaehlt sie und faelscht den Kopf nicht', async () => {
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = attrappeRes();
  const redis = attrappeRedis(0);
  const ton = Buffer.alloc(4096, 7);

  const aufrufe = await mitAbruf(() => new Response(ton, {
    status: 206,
    headers: {
      'content-type': 'audio/mpeg',
      'content-range': `bytes 0-4095/1000000`,
      'content-length': String(ton.length),
    },
  }), async (gesehen) => {
    const lauf = nasTon({ method: 'GET', headers: { range: 'bytes=0-4095' } }, res, redis, token, async () => 'aabbccddeeff0011');
    await Promise.all([lauf, fertig(res)]);
    return gesehen;
  });

  assert.equal(res.statusCode, 206);
  assert.equal(res.kopf['Content-Type'], 'audio/mpeg');
  assert.equal(res.kopf['Content-Range'], 'bytes 0-4095/1000000');
  assert.equal(Buffer.concat(res.stuecke).length, 4096, 'alle Bytes kommen an');
  assert.equal(redis.merkzettel.gezaehlt, 4096, 'und werden gezaehlt');
  assert.equal(aufrufe.length, 1, 'ein einziger Abruf bei der Box');
  assert.match(aufrufe[0].url, /luacgi_notimeout/);
  assert.equal(aufrufe[0].optionen.headers.Range, 'bytes=0-4095');
});

test('nasTon holt bei der Anmeldeseite eine frische Nummer und versucht es noch einmal', async () => {
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = attrappeRes();
  const erzwungen = [];
  const ton = Buffer.alloc(64, 3);

  await mitAbruf((nr) => (nr === 1
    ? new Response('<html>Anmeldung</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    : new Response(ton, { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-63/64' } })
  ), async () => {
    const lauf = nasTon({ method: 'GET', headers: {} }, res, attrappeRedis(), token, async (_link, erzwingen) => {
      erzwungen.push(erzwingen);
      return 'aabbccddeeff0011';
    });
    await Promise.all([lauf, fertig(res)]);
  });

  assert.deepEqual(erzwungen, [false, true], 'erst die gemerkte Nummer, dann eine erzwungen frische');
  assert.equal(res.statusCode, 200, 'die ganze Datei, und danach nicht gefragt worden');
  assert.equal(Buffer.concat(res.stuecke).length, 64);
});

test('nasTon liefert nichts mehr, wenn das Monatsbudget aufgebraucht ist', async () => {
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = attrappeRes();
  const vorher = process.env.MUSIK_TON_BUDGET_GB;
  process.env.MUSIK_TON_BUDGET_GB = '1';
  try {
    await mitAbruf(() => { throw new Error('haette nicht abrufen duerfen'); }, async () => {
      await nasTon({ method: 'GET', headers: {} }, res, attrappeRedis(2 * 1024 ** 3), token, async () => 'sid');
    });
  } finally {
    if (vorher === undefined) delete process.env.MUSIK_TON_BUDGET_GB; else process.env.MUSIK_TON_BUDGET_GB = vorher;
  }
  assert.equal(res.statusCode, 503);
});

test('nasTon reicht ein 416 durch, statt eine neue Nummer zu holen', async () => {
  // Hinter dem Ende der Datei gefragt: Das beantwortet die Box richtig, und
  // eine frische Sitzungsnummer aenderte daran nichts. Ein 502 daraus zu
  // machen hiesse, dem Abspieler eine Auskunft vorzuenthalten, die er hat.
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = attrappeRes();
  const sidRufe = [];

  const aufrufe = await mitAbruf(() => new Response('', {
    status: 416,
    headers: { 'content-range': 'bytes */5000000' },
  }), async (gesehen) => {
    const lauf = nasTon({ method: 'GET', headers: { range: 'bytes=9999999-' } }, res, attrappeRedis(), token, async (_l, e) => {
      sidRufe.push(e);
      return 'aabbccddeeff0011';
    });
    await Promise.all([lauf, fertig(res)]);
    return gesehen;
  });

  assert.equal(res.statusCode, 416);
  assert.equal(res.kopf['Content-Range'], 'bytes */5000000');
  assert.equal(aufrufe.length, 1, 'kein zweiter Anlauf');
  assert.deepEqual(sidRufe, [false], 'und keine erzwungene Anmeldung');
});

test('ein Absturz nennt seinen Grund, statt die Standardseite zu zeigen', async () => {
  // Gemeldet aus dem Betrieb: "500 FUNCTION_INVOCATION_FAILED", und dazu kein
  // Wort darueber, was schiefging. Was hier hochkommt, steht jetzt im Log und
  // in der Antwort - der naechste Klick sagt selbst, woran es lag.
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = attrappeRes();
  await mitAbruf(() => { throw new Error('Netz kaputt'); }, async () => {
    await nasTon({ method: 'GET', headers: {} }, res, {
      get: async () => { throw new Error('Redis weg'); },
    }, token, async () => { throw new Error('Sitzung explodiert'); });
  });
  assert.equal(res.statusCode, 500);
  assert.match(Buffer.concat(res.stuecke).toString(), /Sitzung explodiert/);
});

// --- Und einmal der ganze Weg, mit dem echten fritzSid ---------------------
//
// **Warum dieser Test existiert.** Gemeldet aus dem Betrieb:
// "Ton konnte nicht geliefert werden: budgetText is not defined" - eine
// Logzeile in `fritzSid` rief eine Hilfsfunktion, die beim Aufraeumen mit dem
// Weckruf verschwunden war. Alle Tests waren gruen, weil nach dem Aufraeumen
// kein einziger diesen Weg mehr entlangging: Der Durchleiter bekam seine
// Sitzungsnummer bisher immer von einer Attrappe. Hier nicht.
import { fritzSid } from '../lib/musik.js'

test('der ganze Weg: Anmeldung bei der Box, dann Ton', async () => {
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = attrappeRes();
  const gespeichert = {};
  const redis = {
    get: async (k) => gespeichert[k] ?? null,
    set: async (k, v) => { gespeichert[k] = v; },
    del: async (k) => { delete gespeichert[k]; },
    incrby: async () => {}, expire: async () => {},
  };
  const ton = Buffer.alloc(1024, 4);
  const wege = [];

  const echt = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    wege.push(u);
    // Schritt 1: die Freigabe oeffnen - sie gibt eine Sitzungsnummer heraus.
    if (u.includes('filelink.lua')) {
      return new Response('<html><script>var sid = "00112233445566aa";</script></html>',
        { status: 200, headers: { 'content-type': 'text/html' } });
    }
    // Schritt 2: gilt sie, und zu welchem Ordner gehoert sie?
    if (u.includes('/nas/api/data.lua')) {
      return new Response(JSON.stringify({ root: '/Musik', rights: { read: true } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Schritt 3: die Datei selbst - mit genau dieser Nummer.
    assert.match(u, /sid=00112233445566aa/, 'die Adresse traegt die frisch geholte Nummer');
    return new Response(ton, {
      status: 206,
      headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-1023/1024', 'content-length': '1024' },
    });
  };

  try {
    const lauf = nasTon({ method: 'GET', headers: {} }, res, redis, token,
      (link, erzwingen) => fritzSid(link, redis, erzwingen).then(e => e.sid));
    await Promise.all([lauf, fertig(res)]);
  } finally {
    globalThis.fetch = echt;
  }

  assert.equal(res.statusCode, 200, 'die ganze Datei, und nicht danach gefragt');
  assert.equal(Buffer.concat(res.stuecke).length, 1024, 'der Ton kommt an');
  assert.ok(wege.some(w => w.includes('filelink.lua')), 'die Box wurde geoeffnet');
  assert.ok(wege.some(w => w.includes('luacgi_notimeout')), 'und die Datei geholt');
  assert.ok(gespeichert.musik_fritz_sid, 'die Nummer wurde gemerkt');
});

// --- Der abgerissene Strom -------------------------------------------------
//
// **Gemeldet war: die Wiedergabe stoppt mitten im Kapitel.** Kein
// Titelwechsel, kein Ende der Playlist - der Strom riss ab, der Echo spielte
// seinen Puffer zu Ende und schwieg. Bisher hat das niemand gemerkt: Der
// Durchleiter schrieb, was er bekommen hatte, und meldete es als Erfolg.

/** Eine Antwort der Box, die weniger Bytes liefert, als sie ankuendigt. */
function halbeAntwort(gelieferte, angekuendigte, von = 0, gesamt = angekuendigte) {
  return new Response(Buffer.alloc(gelieferte, 7), {
    status: 206,
    headers: {
      'content-type': 'audio/mpeg',
      'content-length': String(angekuendigte),
      'content-range': `bytes ${von}-${von + angekuendigte - 1}/${gesamt}`,
    },
  });
}

test('waehrend geliefert wird, steht der Merkzettel - und danach nicht mehr', async () => {
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = attrappeRes();
  const redis = attrappeRedis();
  let standWaehrenddessen = null;

  await mitAbruf(() => {
    standWaehrenddessen = redis.merkzettel.gemerkt;
    return halbeAntwort(1024, 1024);
  }, async () => {
    const lauf = nasTon({ method: 'GET', headers: {} }, res, redis, token, async () => 'aabbccddeeff0011');
    await Promise.all([lauf, fertig(res)]);
  });

  // Beim Abruf selbst stand er noch nicht - gesetzt wird er erst, wenn Bytes
  // fliessen, und abgeraeumt, sobald die letzten durch sind.
  assert.equal(standWaehrenddessen, null);
  assert.equal(redis.merkzettel.gemerkt, null, 'danach ist der Merkzettel weg');
  assert.equal(redis.merkzettel.geloescht, 1, 'und zwar durch den, der ihn gesetzt hat');
});

test('steht der Merkzettel, wird die Sitzungsnummer ohne Anmeldung geholt', async () => {
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = attrappeRes();
  const redis = attrappeRedis(0, '1758440000000-abcdef');
  const schalter = [];

  await mitAbruf(() => halbeAntwort(1024, 1024), async () => {
    const lauf = nasTon({ method: 'GET', headers: {} }, res, redis, token, async (_link, erzwingen, ohneAnmeldung) => {
      schalter.push({ erzwingen, ohneAnmeldung });
      return 'aabbccddeeff0011';
    });
    await Promise.all([lauf, fertig(res)]);
  });

  assert.deepEqual(schalter, [{ erzwingen: false, ohneAnmeldung: true }],
    'der erste Anlauf darf sich nicht anmelden, solange nebenan geliefert wird');
});

// --- Und die andere Seite desselben Schalters: fritzSid --------------------

/** Die Tafel, die sich lib/musik.js merkt - mit einer Nummer ausser Frist. */
function tafelMit(sid, alterMinuten) {
  return { [BOX]: { sid, zeit: Date.now() - alterMinuten * 60_000 } };
}

async function sidOhneAnmeldung(datalua) {
  const gespeichert = { musik_fritz_sid: tafelMit('00112233445566aa', 30) };
  const redis = {
    get: async (k) => gespeichert[k] ?? null,
    set: async (k, v) => { gespeichert[k] = v; },
    del: async (k) => { delete gespeichert[k]; },
  };
  const wege = [];
  const echt = globalThis.fetch;
  globalThis.fetch = async (url) => {
    wege.push(String(url));
    if (String(url).includes('/nas/api/data.lua')) return datalua();
    throw new Error(`haette nicht abrufen duerfen: ${url}`);
  };
  try {
    return { ergebnis: await fritzSid(BOX, redis, false, () => Infinity, null, true), wege };
  } finally {
    globalThis.fetch = echt;
  }
}

test('fritzSid meldet sich nicht an, solange eine Lieferung laeuft', async () => {
  // Abgelaufenes Fenster, und die Box sagt nichts Brauchbares: Frueher hiess
  // das Anmeldung - und die beendet alle Sitzungen der Box, den gerade
  // spielenden Titel eingeschlossen.
  const ohneAntwort = await sidOhneAnmeldung(() => new Response('', { status: 503 }));
  assert.equal(ohneAntwort.ergebnis.sid, '00112233445566aa', 'es bleibt bei der gemerkten Nummer');
  assert.equal(ohneAntwort.ergebnis.angemeldet, false);
  assert.ok(!ohneAntwort.wege.some(w => w.includes('filelink.lua')), 'kein Login');

  // Und auch eine ausdruecklich abgelehnte Nummer fuehrt nicht zur Anmeldung:
  // Der zweite Anlauf des Durchleiters setzt den Schalter nicht mehr, der
  // darf sie dann holen.
  const tot = await sidOhneAnmeldung(() => new Response('<html>Anmeldung</html>',
    { status: 403, headers: { 'content-type': 'text/html' } }));
  assert.equal(tot.ergebnis.sid, '00112233445566aa');
  assert.equal(tot.ergebnis.angemeldet, false);
  assert.ok(!tot.wege.some(w => w.includes('filelink.lua')), 'auch dann kein Login');
});

// --- Die Attrappe war schneller als die Wirklichkeit ------------------------
//
// **Der teuerste Test dieser Datei, weil sein Fehlen teuer war.** Nach #122
// spielte keine Ordnerfreigabe mehr - und alle 241 Tests waren gruen. Grund:
// `attrappeRes` ist ein PassThrough mit einem `data`-Horcher. Der liest
// sofort mit, es gibt nie Gegendruck, und `finish` kommt im selben Tick wie
// das `end` des Lesestroms. Ob `durchleiten` auf die Antwort wartet oder nur
// auf den Zufluss, war daran nicht zu unterscheiden.
//
// Auf der Leitung zum Echo ist das anders: Dort steht das letzte Stueck noch
// im Puffer, wenn die Box laengst fertig ist. Wer dann auflaest, gibt die
// Function frei, waehrend der Echo noch auf Bytes wartet - und bekommt
// Kopfzeilen mit Content-Length und danach zu wenig.

/**
 * Ein `res`, das so langsam schreibt wie eine Leitung.
 *
 * **Gezaehlt wird beim Abschluss, nicht beim Beginn.** Der erste Anlauf dieses
 * Tests legte die Stuecke gleich in `_write` ab - und ging deshalb auch ueber
 * dem kaputten Code durch: Ein `write`, das noch laeuft, hatte sein Stueck
 * dort laengst hinterlegt. Auf der echten Leitung steht es dann noch im
 * Puffer. Was zaehlt, ist `writableFinished`: Erst dann ist die Antwort
 * draussen und die Function darf gehen.
 */
function langsamesRes(verzoegerungMs = 20) {
  const res = new Writable({
    highWaterMark: 64,
    write(stueck, _kodierung, weiter) {
      setTimeout(() => { res.stuecke.push(Buffer.from(stueck)); weiter(); }, verzoegerungMs);
    },
  });
  res.stuecke = [];
  res.statusCode = null;
  res.kopf = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.writeHead = (code, kopfzeilen) => { res.statusCode = code; res.kopf = kopfzeilen; return res; };
  return res;
}

test('nasTon loest erst auf, wenn alles hinausgeschrieben ist', async () => {
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = langsamesRes();

  await mitAbruf(() => new Response(Buffer.alloc(1024, 3), {
    status: 206,
    headers: { 'content-type': 'audio/mpeg', 'content-length': '1024', 'content-range': 'bytes 0-1023/1024' },
  }), async () => {
    // Kein `fertig(res)` daneben: Genau das ist die Frage - wartet nasTon von
    // sich aus, oder waere die Function hier schon weg?
    await nasTon({ method: 'GET', headers: {} }, res, attrappeRedis(), token, async () => 'aabbccddeeff0011');
  });

  // **Zum Stand dieses Tests, damit ihn niemand ueberschaetzt.** Geschrieben
  // wurde er gegen #122, wo `pipe(res, { end: false })` und ein eigenes
  // `res.end()` die Antwort aufloesten, bevor die Bytes drausssen waren. In
  // der heutigen Form (`pipe(res)` beendet die Antwort selbst) faellt er
  // nicht mehr um, wenn man nur die `finish`-Zeile entfernt - `close` faengt
  // das ab. Er prueft weiterhin die richtige Eigenschaft; er ist nur kein
  // Fallstrick mehr fuer genau jene eine Zeile.
  assert.ok(res.writableFinished,
    'wenn nasTon aufloest, ist die Antwort hinaus - nicht nur die Box fertig');
  assert.equal(Buffer.concat(res.stuecke).length, 1024, 'und zwar ganz');
});

test('legt der Echo auf, ist die Function sofort frei', async () => {
  // Sonst laedt sie eine Datei zu Ende, die niemand mehr hoert - und haelt
  // dabei ihre sechzig Sekunden besetzt. Die Box tropft hier absichtlich in
  // kleinen Stuecken: An einem einzigen grossen gaebe es nichts zu
  // unterbrechen, und der Test waere nur ein Wettlauf.
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = langsamesRes(1);
  const begonnen = Date.now();
  let gesendet = 0;

  const tropfen = new ReadableStream({
    async pull(steuerung) {
      if (gesendet >= 256) return steuerung.close();
      gesendet += 1;
      steuerung.enqueue(new Uint8Array(1024).fill(3));
      await new Promise(a => setTimeout(a, 2));
    },
  });

  await mitAbruf(() => new Response(tropfen, {
    status: 206,
    headers: {
      'content-type': 'audio/mpeg',
      'content-length': String(256 * 1024),
      'content-range': `bytes 0-${256 * 1024 - 1}/${1024 * 1024}`,
    },
  }), async () => {
    const lauf = nasTon({ method: 'GET', headers: { range: 'bytes=0-' } }, res, attrappeRedis(), token, async () => 'aabbccddeeff0011');
    setTimeout(() => res.destroy(), 30);
    await lauf;
  });

  const gebraucht = Date.now() - begonnen;
  assert.ok(gebraucht < 2000, `nicht haengen geblieben (${gebraucht} ms)`);
  assert.ok(gesendet < 256, `und nicht zu Ende geladen (${gesendet} von 256 Stuecken)`);
});

// --- Der Verlauf: damit die naechste Stoerung sich selbst erklaert ---------
//
// **Warum er sein muss.** Drei Runden lang wurde die Ursache des Abbruchs
// geraten, weil die Zahl, die sie nennt, nur im Log von Vercel stand - und
// wer Musik hoert, liest kein Vercel-Log. Dieselben Zahlen liegen jetzt in
// Redis und stehen im Dashboard.
import { verlaufLesen, verlaufLoeschen, VERLAUF_KEY } from '../lib/naston.js'

test('jeder Abruf hinterlaesst gelieferte gegen angekuendigte Bytes', async () => {
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = attrappeRes();
  const redis = attrappeRedis();

  await mitAbruf(() => halbeAntwort(1024, 1024), async () => {
    const lauf = nasTon({ method: 'GET', headers: {} }, res, redis, token, async () => 'aabbccddeeff0011');
    await Promise.all([lauf, fertig(res)]);
  });

  const [eintrag] = await verlaufLesen(redis);
  assert.equal(eintrag.was, 'ton');
  assert.equal(eintrag.bytes, 1024, 'was wirklich floss');
  assert.equal(eintrag.soll, 1024, 'und was angekuendigt war');
  assert.equal(eintrag.angemeldet, false, 'ohne Anmeldung an der Box');
  assert.equal(eintrag.status, 200);
  assert.ok(eintrag.datei.includes('Buehne'), 'und welche Datei es war');
  assert.ok(typeof eintrag.zeit === 'number' && typeof eintrag.dauer === 'number');
});

test('ein abgerissener Strom ist im Verlauf als solcher zu erkennen', async () => {
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = attrappeRes();
  const redis = attrappeRedis();
  const vorher = process.env.MUSIK_TON_ANLAEUFE;
  process.env.MUSIK_TON_ANLAEUFE = '1';

  try {
    await mitAbruf(() => halbeAntwort(256, 1024), async () => {
      const lauf = nasTon({ method: 'GET', headers: {} }, res, redis, token, async () => 'aabbccddeeff0011');
      await Promise.all([lauf, fertig(res)]);
    });
  } finally {
    if (vorher === undefined) delete process.env.MUSIK_TON_ANLAEUFE; else process.env.MUSIK_TON_ANLAEUFE = vorher;
  }

  const [eintrag] = await verlaufLesen(redis);
  assert.equal(eintrag.bytes, 256);
  assert.equal(eintrag.soll, 1024, 'die Luecke steht als Zahlenpaar da');
});

test('eine Anmeldung an der Box steht neben dem Abruf', async () => {
  // Der entscheidende Unterschied: Hat die Box abgerissen, oder haben wir ihr
  // selbst die Sitzung unter dem Kapitel weggezogen?
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = attrappeRes();
  const redis = attrappeRedis();

  await mitAbruf(() => halbeAntwort(1024, 1024), async () => {
    const lauf = nasTon({ method: 'GET', headers: {} }, res, redis, token,
      async () => ({ sid: 'aabbccddeeff0011', angemeldet: true }));
    await Promise.all([lauf, fertig(res)]);
  });

  const [eintrag] = await verlaufLesen(redis);
  assert.equal(eintrag.angemeldet, true);
});

test('ein Redis ohne Listen kostet nie die Wiedergabe', async () => {
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = attrappeRes();
  const kaputt = {
    get: async () => 0, set: async () => {}, del: async () => {},
    incrby: async () => {}, expire: async () => {},
    lpush: async () => { throw new Error('keine Liste'); },
  };

  await mitAbruf(() => halbeAntwort(1024, 1024), async () => {
    const lauf = nasTon({ method: 'GET', headers: {} }, res, kaputt, token, async () => 'aabbccddeeff0011');
    await Promise.all([lauf, fertig(res)]);
  });

  assert.equal(Buffer.concat(res.stuecke).length, 1024, 'der Ton kommt trotzdem an');
  assert.deepEqual(await verlaufLesen(kaputt), [], 'und der Verlauf bleibt leer statt zu werfen');
});

test('verlaufLesen gibt nur Eintraege zurueck, keine blanken Werte', async () => {
  // **Die Zeile, die es nie gab.** `JSON.parse("123")` ergibt `123`, und eine
  // Zahl ist wahr genug fuer `filter(Boolean)`. Im Dashboard wurde daraus eine
  // Zeile, in der jedes Feld `undefined` war - und die sah aus wie ein
  // missglueckter Tonabruf, war aber gar kein Eintrag. Eine Liste zaehlt
  // genauso wenig: `typeof [] === 'object'`.
  const redis = attrappeRedis();
  const echt = { zeit: 1, was: 'ton', status: 200 };
  redis.merkzettel.verlauf = [echt, 123, '"nur ein Text"', '{kaputt', ['a', 'b'], null, JSON.stringify({ zeit: 2, was: 'wort' })];

  assert.deepEqual(await verlaufLesen(redis), [echt, { zeit: 2, was: 'wort' }]);
});

test('verlaufLoeschen leert den Verlauf', async () => {
  const redis = attrappeRedis();
  redis.merkzettel.verlauf = [{ zeit: 1, was: 'ton' }, { zeit: 2, was: 'echo' }];

  const ok = await verlaufLoeschen(redis);

  assert.equal(ok, true);
  assert.deepEqual(await verlaufLesen(redis), []);
});

test('verlaufLoeschen wirft nie, auch wenn Redis es tut', async () => {
  const kaputt = { del: async () => { throw new Error('kein Loeschen'); } };

  assert.equal(await verlaufLoeschen(kaputt), false);
});

test('steht der Merkzettel, meldet sich auch der zweite Anlauf nicht an', async () => {
  // **#122 hat diesen Schalter nur halb gesetzt.** `laeuft && !erzwingen`
  // hiess: Genau der Anlauf, der nach der Ablehnung der Box kommt, meldete
  // sich an - und eine Anmeldung beendet alle Sitzungen der Box, den gerade
  // spielenden Titel eingeschlossen. Der halbe Schutz war keiner.
  const token = tonToken(BOX, PFAD, process.env.ADMIN_PASSWORD = 'test-schluessel');
  const res = attrappeRes();
  const redis = attrappeRedis(0, '1758440000000-abcdef');
  const schalter = [];

  await mitAbruf((nummer) => (nummer === 1
    // Erster Anlauf: die Box schickt ihre Anmeldeseite statt Tondaten.
    ? new Response('<html>Anmeldung</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    : halbeAntwort(1024, 1024)), async () => {
    const lauf = nasTon({ method: 'GET', headers: {} }, res, redis, token, async (_l, erzwingen, ohneAnmeldung) => {
      schalter.push({ erzwingen, ohneAnmeldung });
      return 'aabbccddeeff0011';
    });
    await Promise.all([lauf, fertig(res)]);
  });

  assert.deepEqual(schalter, [
    { erzwingen: false, ohneAnmeldung: true },
    { erzwingen: true, ohneAnmeldung: true },
  ], 'auch der erzwungene Anlauf darf die Box nicht anmelden, solange geliefert wird');
});
