// test/fritznas.test.mjs – die FRITZ!NAS-Kette ohne Netz.
//
//   node --test
//
// Geprueft werden die reinen Funktionen: Erkennung des Freigabe-Links, das
// Zusammensetzen der Stream-Adresse, das Auflesen der Sitzungsnummer und das
// Umwandeln der Antwort in Titel. Der Ablauf selbst (importiereFritzOrdner)
// braucht eine FRITZ!Box und steht deshalb nicht hier.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  istFritzFreigabe,
  streamUrl,
  sidKandidaten,
  titelAusListe,
  mitSid,
  textAuszug,
} from '../lib/fritznas.js'

const FREIGABE = 'https://abc.myfritz.net:456/nas/filelink.lua?id=535f52fbb2016f4f';

test('istFritzFreigabe erkennt den Freigabe-Link und sonst nichts', () => {
  assert.deepEqual(istFritzFreigabe(FREIGABE), {
    herkunft: 'https://abc.myfritz.net:456',
    id: '535f52fbb2016f4f',
  });
  assert.equal(istFritzFreigabe('https://abc.myfritz.net:456/nas/filelink.lua'), null, 'ohne id');
  assert.equal(istFritzFreigabe('https://example.org/musik/'), null);
  assert.equal(istFritzFreigabe('kein url'), null);
});

test('streamUrl baut den Abruf, den der Echo macht', () => {
  const u = new URL(streamUrl('https://abc.myfritz.net:456', '83f20d7cb327ab09', '/04 - La-Le-Lu.mp3'));
  assert.equal(u.pathname, '/nas/cgi-bin/luacgi_notimeout');
  assert.equal(u.searchParams.get('script'), '/api/data.lua');
  assert.equal(u.searchParams.get('sid'), '83f20d7cb327ab09');
  assert.equal(u.searchParams.get('c'), 'music');
  assert.equal(u.searchParams.get('a'), 'get');
  assert.equal(u.searchParams.get('path'), '/04 - La-Le-Lu.mp3');
  // Das Komma in "Funkel, funkel" darf die Abfrage nicht zerlegen.
  const komma = new URL(streamUrl('https://h.de', 'a1b2c3d4e5f60718', '/01 - Funkel, funkel.mp3'));
  assert.equal(komma.searchParams.get('path'), '/01 - Funkel, funkel.mp3');
});

test('sidKandidaten liest die Sitzungsnummer aus Cookie, Adresse und Geruest', () => {
  assert.deepEqual(sidKandidaten({ kekse: 'NAS_SID=83f20d7cb327ab09; Pfad=/' }), ['83f20d7cb327ab09']);
  assert.deepEqual(sidKandidaten({ schlussUrl: 'https://h.de/nas?sid=754bba5ff3987c37' }), ['754bba5ff3987c37']);
  assert.deepEqual(sidKandidaten({ html: 'window.sid = "0123456789abcdef";' }), ['0123456789abcdef']);
});

test('sidKandidaten nimmt die ausdrueckliche sid zuerst und laesst Leernummern liegen', () => {
  const k = sidKandidaten({
    kekse: 'irgendwas=aaaabbbbccccdddd',
    schlussUrl: 'https://h.de/nas?sid=754bba5ff3987c37',
  });
  assert.equal(k[0], '754bba5ff3987c37', 'die ausdrueckliche sid gewinnt');
  assert.ok(k.includes('aaaabbbbccccdddd'), 'ein Cookie ohne den Namen sid bleibt Kandidat');
  assert.deepEqual(sidKandidaten({ kekse: 'sid=0000000000000000' }), [], 'die Leernummer ist keine Sitzung');
});

test('titelAusListe macht aus der Antwort der Box Titel in ihrer Reihenfolge', () => {
  const antwort = {
    diskInfo: { used: 1, total: 2, free: 1 },
    files: [
      { path: '/01 - Funkel, funkel, kleiner Stern.mp3', type: 'audio', filename: '01 - Funkel, funkel, kleiner Stern.mp3' },
      { path: '/Cover.jpg', type: 'image', filename: 'Cover.jpg' },
      { path: '/02 - Der Mond ist aufgegangen.mp3', type: 'audio', filename: '02 - Der Mond ist aufgegangen.mp3' },
    ],
  };
  assert.deepEqual(titelAusListe(antwort), [
    { pfad: '/01 - Funkel, funkel, kleiner Stern.mp3', name: '01 - Funkel, funkel, kleiner Stern' },
    { pfad: '/02 - Der Mond ist aufgegangen.mp3', name: '02 - Der Mond ist aufgegangen' },
  ]);
});

test('titelAusListe haengt nicht am Feldnamen "files"', () => {
  const titel = titelAusListe({ eintraege: [{ path: '/a.mp3', filename: 'a.mp3' }] });
  assert.deepEqual(titel, [{ pfad: '/a.mp3', name: 'a' }]);
  assert.deepEqual(titelAusListe([{ path: '/b.m4a', filename: 'b.m4a' }]), [{ pfad: '/b.m4a', name: 'b' }]);
});

test('titelAusListe uebergeht Ordner und Antworten ohne Liste', () => {
  assert.deepEqual(titelAusListe({ files: [{ path: '/Unterordner', type: 'dir' }] }), []);
  assert.deepEqual(titelAusListe({ root: '/Musik', rights: { read: true } }), []);
  assert.deepEqual(titelAusListe(null), []);
});

test('mitSid tauscht nur die Sitzungsnummer und laesst den Pfad in Ruhe', () => {
  const alt = streamUrl('https://abc.myfritz.net:456', 'aaaaaaaaaaaaaaaa', '/01 - Funkel, funkel.mp3');
  const neu = new URL(mitSid(alt, 'bbbbbbbbbbbbbbbb'));
  assert.equal(neu.searchParams.get('sid'), 'bbbbbbbbbbbbbbbb');
  assert.equal(neu.searchParams.get('path'), '/01 - Funkel, funkel.mp3', 'der Pfad bleibt unangetastet');
  assert.equal(neu.searchParams.get('script'), '/api/data.lua');
});

test('mitSid laesst Adressen ohne sid unveraendert', () => {
  const fremd = 'https://example.org/musik/01.mp3';
  assert.equal(mitSid(fremd, 'bbbbbbbbbbbbbbbb'), fremd);
  assert.equal(mitSid('keine url', 'bbbbbbbbbbbbbbbb'), 'keine url');
});

test('textAuszug holt die Aussage aus einer HTML-Antwort', () => {
  const seite = '<html><head><title>FRITZ!NAS</title><style>body{color:red}</style>'
    + '<script>var x=1;</script></head><body><p>Die Datei wurde nicht gefunden.</p></body></html>';
  const auszug = textAuszug(seite);
  assert.match(auszug, /FRITZ!NAS/);
  assert.match(auszug, /Die Datei wurde nicht gefunden\./);
  assert.doesNotMatch(auszug, /var x/, 'Skript und Stil fliegen raus');
  assert.doesNotMatch(auszug, /</, 'und das Markup auch');
});

test('textAuszug kappt und kommt ohne title aus', () => {
  assert.equal(textAuszug(`<p>${'a'.repeat(500)}</p>`, 50).length, 51, '50 Zeichen plus Auslassungszeichen');
  assert.equal(textAuszug('<p>nur Text</p>'), 'nur Text');
  assert.equal(textAuszug(''), '');
});
