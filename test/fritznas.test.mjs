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
  weckUrteil,
  sitzungsUrteil,
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

// --- Leerzeichen in der Adresse ----------------------------------------------
//
// **Warum das eine Frage ist.** URLSearchParams schreibt ein Leerzeichen als
// "+" - so will es das Formular-Format, und die FRITZ!Box versteht es: Der Echo
// spielt damit tadellos. Ein anderer Abspieler muss es aber nicht verstehen.
// "+" heisst nur im Formular-Format "Leerzeichen"; in einer Adresse ist es
// sonst ein gewoehnliches Zeichen, und wer die Abfrage nach eigenen Regeln neu
// zusammensetzt, sucht anschliessend eine Datei namens "01.+Die+Buehne.mp3".

test('streamUrl schreibt Leerzeichen als %20', () => {
  const url = streamUrl('https://box.myfritz.net:456', 'aaaaaaaaaaaaaaaa', '/01. Die Bühne Ist Angerichtet.mp3');
  assert.ok(!url.includes('+'), 'kein + in der Adresse');
  assert.match(url, /%20Die%20B%C3%BChne%20/);
  assert.equal(
    new URL(url).searchParams.get('path'),
    '/01. Die Bühne Ist Angerichtet.mp3',
    'und der Pfad kommt unveraendert wieder heraus',
  );
});

test('ein + im Dateinamen bleibt ein +', () => {
  // URLSearchParams macht daraus %2B, bevor irgendjemand ersetzt. Sonst wuerde
  // aus "Best Of + Mehr.mp3" beim Abspielen "Best Of   Mehr.mp3".
  const url = streamUrl('https://box.myfritz.net:456', 'aaaaaaaaaaaaaaaa', '/Best Of + Mehr.mp3');
  assert.equal(new URL(url).searchParams.get('path'), '/Best Of + Mehr.mp3');
});

test('mitSid zieht die Schreibweise der Leerzeichen gerade', () => {
  // **Hier lag der Haken.** searchParams.set markiert die Abfrage als
  // geaendert, und href setzt sie danach komplett neu zusammen - aus dem %20
  // des Imports wurde beim Abspielen wieder ein +. Die Funktion hat also
  // genau das zurueckgedreht, was streamUrl vermeidet.
  const importiert = streamUrl('https://box.myfritz.net:456', 'aaaaaaaaaaaaaaaa', '/01. Die Bühne.mp3');
  const gespielt = mitSid(importiert, 'bbbbbbbbbbbbbbbb');
  assert.ok(!gespielt.includes('+'), 'auch nach dem Austausch kein +');
  assert.equal(new URL(gespielt).searchParams.get('sid'), 'bbbbbbbbbbbbbbbb');
  assert.equal(new URL(gespielt).searchParams.get('path'), '/01. Die Bühne.mp3');
  assert.equal(gespielt, importiert.replace('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'), 'nur die Nummer ist anders');
});

test('mitSid raeumt auch eine alt gespeicherte Adresse mit + auf', () => {
  // Die Playlists in der Datenbank tragen die alte Schreibweise. Sie werden
  // nicht umgeschrieben - beim Abspielen wird die Adresse ohnehin neu gebaut.
  const alt = 'https://box.myfritz.net:456/nas/cgi-bin/luacgi_notimeout'
    + '?script=%2Fapi%2Fdata.lua&sid=aaaaaaaaaaaaaaaa&c=music&a=get&path=%2F01.+Die+B%C3%BChne.mp3';
  const neu = mitSid(alt, 'bbbbbbbbbbbbbbbb');
  assert.ok(!neu.includes('+'));
  assert.equal(new URL(neu).searchParams.get('path'), '/01. Die Bühne.mp3');
});

// --- Der Weckruf an die Datei ------------------------------------------------
//
// Zwei Fragen, und sie sind nicht dieselbe: Kam Ton? Und war es eine Absage?
// Nur die zweite haelt eine Wiedergabe auf - eine Zeitueberschreitung ist der
// Normalfall bei einer Platte, die gerade anlaeuft, und kommt hier gar nicht
// erst an (sie hat keinen Status).

test('weckUrteil erkennt eine Datei am Inhaltstyp, nicht am Status allein', () => {
  assert.equal(weckUrteil(206, 'audio/mpeg').ok, true, 'der Regelfall: ein Bereich MP3');
  assert.equal(weckUrteil(200, 'audio/mp4').ok, true);
  assert.equal(weckUrteil(200, 'application/octet-stream').ok, true, 'ohne Ahnung vom Typ liefert die Box das');
  assert.equal(weckUrteil(200, '').ok, true, 'gar kein Inhaltstyp ist kein Nein');
  assert.equal(weckUrteil(206, 'Audio/MPEG; charset=binary').ok, true, 'Schreibweise und Zusatz zaehlen nicht');
});

test('weckUrteil sagt nein, wo die Box etwas anderes als Ton schickt', () => {
  // Der gemeldete Fall hinter "Ich spiele ...", dann Stille: Die Box schickt
  // ihre Oberflaeche, weil die Sitzungsnummer nicht (mehr) gilt.
  assert.equal(weckUrteil(200, 'text/html').ok, false);
  assert.equal(weckUrteil(302, 'text/html').ok, false, 'die Umleitung auf die Anmeldung');
  assert.equal(weckUrteil(404, 'text/html').ok, false);
  assert.equal(weckUrteil(500, 'audio/mpeg').ok, false, 'ein Fehler bleibt einer, auch mit Audio-Etikett');
});

// --- Was eine Antwort der Box ueber die Sitzungsnummer aussagt ---------------
//
// **Gemeldet:** `FRITZ!NAS-Sitzung nachgefragt: ohne Antwort (HTTP 303)`.
// Eine Umleitung ist kein Schweigen - sie ist die Box, die sagt "diese Nummer
// kenne ich nicht, geh zur Anmeldung". Als "nicht zu erfahren" verbucht,
// konnte der Skill innerhalb seiner Frist damit losspielen, und der Echo bekam
// die Anmeldeseite statt der Datei.

test('sitzungsUrteil liest die Zustimmung aus den Daten', () => {
  assert.equal(sitzungsUrteil(200, { root: '/Musik', rights: { read: true } }), true);
  assert.equal(sitzungsUrteil(200, { rights: { read: true } }), true, 'rights allein genuegt');
  assert.equal(sitzungsUrteil(200, { error: 'no session' }), false, 'JSON ohne Rechte ist ein Nein');
});

test('sitzungsUrteil wertet jede Antwort unter 500 als Ablehnung', () => {
  // Der gemeldete Fall und seine Verwandten: Umleitung auf die Anmeldung,
  // Fehlerstatus, oder die FRITZ!NAS-Oberflaeche als HTML mit Status 200.
  assert.equal(sitzungsUrteil(303, null), false, 'die Umleitung auf die Anmeldung');
  assert.equal(sitzungsUrteil(403, null), false);
  assert.equal(sitzungsUrteil(404, null), false);
  assert.equal(sitzungsUrteil(200, null), false, 'HTTP 200, aber kein lesbares JSON');
});

test('sitzungsUrteil laesst 5xx und Schweigen unklar', () => {
  // **Hier bleibt "Schweigen ist kein Nein" genau dort, wo es gemeint war.**
  // Bei 5xx ist die Box ueberlastet oder kaputt; das sagt nichts ueber die
  // Nummer. Sie deswegen fuer tot zu erklaeren hiesse, sich mitten in einer
  // laufenden Wiedergabe anzumelden - und eine Anmeldung beendet alle
  // Sitzungen der Box.
  assert.equal(sitzungsUrteil(500, null), null);
  assert.equal(sitzungsUrteil(503, null), null);
  assert.equal(sitzungsUrteil(null, null), null, 'nicht erreichbar');
  assert.equal(sitzungsUrteil(undefined, null), null, 'Zeit abgelaufen');
});
