// lib/karte.js – die Karte auf dem Echo Show ("Alexa, wo ist Julia?")
//
// Geraete mit Bildschirm bekommen zur Ansage eine APL-Seite mit einer
// OpenStreetMap-Karte, einem Pin an der gemeldeten Position und - wenn das
// Geraet sie mitgeschickt hat - dem Genauigkeitskreis darum.
//
// **Warum die Karte aus Kacheln zusammengesetzt wird und kein fertiges Bild
// ist.** Ein statisches Kartenbild braeuchte einen Dienst mit API-Schluessel
// (Google, Mapbox, ...) oder eine eigene Function, die Kacheln zu einem PNG
// zusammenklebt - und api/ hat bereits die zwoelf, die der Hobby-Tarif
// erlaubt. APL kann Bilder aber frei positionieren: Der Echo holt die
// 256-Pixel-Kacheln selbst und legt sie nebeneinander. Keine Function, kein
// Schluessel, kein zusaetzlicher Dienst.
//
// **Nur so viele Kacheln, wie das Display braucht.** Das Raster reicht fuer
// den Echo Show 15 (1920 dp breit). Jede Kachel traegt aber ein `when`, das
// der Echo beim Aufbau gegen die eigene Bildschirmgroesse prueft - ein Show 5
// laedt also nicht fuenfunddreissig Kacheln, sondern die acht, die er zeigt.
//
// **Zwei Kachelquellen, je nach Geraet.** Echo Show & Co. holen die Kacheln
// direkt bei OpenStreetMap (tile.openstreetmap.org). Der Fire TV bekam dort
// auf jede Kachel "403 Access blocked - App is not following the tile usage
// policy": Sein Bildlader schickt nicht die Absenderkennung, die der
// OSM-Server verlangt, und darauf hat der Skill keinen Einfluss - die Kacheln
// holt das Geraet selbst. Fernseher (Viewport-Modus TV) bekommen deshalb die
// freien CARTO-Kacheln ("Voyager", auf OSM-Daten, ohne Schluessel).
//
// Umstellbar per KARTE_KACHELN (Echo Show & Co.) bzw. KARTE_KACHELN_TV
// (Fernseher), jeweils eine Vorlage mit {z}, {x}, {y}. Die Quellenangabe steht
// unten rechts auf der Karte und richtet sich nach der Quelle.

export const KACHEL = 256;
const STANDARD_KACHELN = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TV_KACHELN = 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png';

/**
 * Ist das anfragende Geraet ein Fernseher (Fire TV)?
 *
 * Alexa meldet die Bildschirmart in `context.Viewport.mode`: `HUB` beim Echo
 * Show, `TV` beim Fire TV. Neuere Anfragen tragen sie (auch) in
 * `context.Viewports[]` - beide werden gelesen.
 */
export function istFernseher(body) {
  const ctx = body?.context || {};
  const modi = [ctx.Viewport?.mode, ...(Array.isArray(ctx.Viewports) ? ctx.Viewports.map(v => v?.mode) : [])];
  return modi.some(m => typeof m === 'string' && m.toUpperCase() === 'TV');
}

/** Die Kachelvorlage fuer dieses Geraet. */
export function kachelVorlage(fernseher) {
  if (fernseher) return process.env.KARTE_KACHELN_TV || TV_KACHELN;
  return process.env.KARTE_KACHELN || STANDARD_KACHELN;
}
/** Halbe Rasterbreite/-hoehe in Kacheln: 9 x 7 deckt 1920 x 1080 dp sicher ab. */
const RAND_X = 4;
const RAND_Y = 3;

/** Standard-Anzeigedauer der Karte in Sekunden. */
export const KARTE_DAUER_SEK = 25;

/**
 * Anzeigedauer in Millisekunden - per KARTE_DAUER_SEK (Vercel) einstellbar,
 * geklemmt auf 10 s bis 10 min. Wie lange ein Echo tatsaechlich wartet,
 * entscheidet am Ende das Geraet; es darf die Angabe deckeln.
 */
export function kartenDauerMs(wert = process.env.KARTE_DAUER_SEK) {
  const sek = Number(wert);
  const dauer = Number.isFinite(sek) && sek > 0 ? sek : KARTE_DAUER_SEK;
  return Math.round(Math.min(600, Math.max(10, dauer)) * 1000);
}

/**
 * Kann dieses Geraet APL anzeigen?
 *
 * Wie bei `audioGeraet` in lib/musik.js beantwortet die Anfrage das selbst:
 * `supportedInterfaces` nennt `Alexa.Presentation.APL` nur, wenn das Geraet
 * einen Bildschirm hat **und** das Interface im Skill eingeschaltet ist
 * (Developer Console -> Build -> Interfaces). Fehlt es, bleibt es bei der
 * Ansage - eine APL-Direktive an ein Geraet ohne APL waere ein Fehler, und
 * Alexa sagte dann "Das Geraet reagiert nicht" statt des Standorts.
 */
export function kannKarte(body) {
  const koennen = body?.context?.System?.device?.supportedInterfaces;
  return !!(koennen && typeof koennen === 'object' && koennen['Alexa.Presentation.APL']);
}

/** Weltkoordinaten in Pixeln (Web-Mercator) bei Zoomstufe z. */
export function weltPixel(lat, lon, z) {
  const groesse = KACHEL * 2 ** z;
  // Mercator ist an den Polen unendlich - auf den ueblichen Kartenrand klemmen.
  const breite = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const phi = (breite * Math.PI) / 180;
  const x = ((lon + 180) / 360) * groesse;
  const y = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * groesse;
  return { x, y };
}

/** Meter pro Pixel an dieser Breite und Zoomstufe. */
export function meterProPixel(lat, z) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/**
 * Wie nah die Karte herangeht.
 *
 * Nach der gemeldeten Genauigkeit: Ein 900-m-Fix aus der Funkzelle auf
 * Strassenniveau gezeigt, saehe praeziser aus, als er ist - der Kreis passte
 * nicht einmal mehr auf den Bildschirm. Ohne Angabe gilt Strassenniveau.
 */
export function zoomFuer(acc) {
  if (!Number.isFinite(acc) || acc <= 0) return 16;
  if (acc > 3000) return 12;
  if (acc > 1200) return 13;
  if (acc > 500) return 14;
  if (acc > 150) return 15;
  return 16;
}

/**
 * Die Kacheln um die Position, jede mit ihrem Versatz zur Bildschirmmitte.
 *
 * Rein und exportiert, damit sich das Raster ohne Netz pruefen laesst.
 */
export function kachelRaster(lat, lon, z, vorlage = STANDARD_KACHELN) {
  const mitte = weltPixel(lat, lon, z);
  const tx = Math.floor(mitte.x / KACHEL);
  const ty = Math.floor(mitte.y / KACHEL);
  const anzahl = 2 ** z;
  const kacheln = [];
  for (let dy = -RAND_Y; dy <= RAND_Y; dy++) {
    const y = ty + dy;
    if (y < 0 || y >= anzahl) continue;
    for (let dx = -RAND_X; dx <= RAND_X; dx++) {
      // Ueber die Datumsgrenze hinweg weiter um die Erde.
      const x = (((tx + dx) % anzahl) + anzahl) % anzahl;
      kacheln.push({
        url: vorlage.replace('{z}', z).replace('{x}', x).replace('{y}', y),
        links: Math.round((tx + dx) * KACHEL - mitte.x),
        oben: Math.round(y * KACHEL - mitte.y),
      });
    }
  }
  return kacheln;
}

/**
 * Die APL-Direktive mit der Karte - oder `null`, wenn es nichts zu zeigen gibt.
 *
 * @param {object} p
 * @param {string} p.name   wer gesucht wurde
 * @param {number} p.lat
 * @param {number} p.lon
 * @param {number} [p.acc]  Genauigkeit in Metern
 * @param {string} p.ort    Zonenname oder Adresse, wie Alexa ihn spricht
 * @param {string} p.alter  "vor 5 Minuten"
 * @param {boolean} [p.veraltet]
 */
export function kartenDirektive({ name, lat, lon, acc, ort, alter, veraltet = false }, fernseher = false) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const z = zoomFuer(acc);
  const vorlage = kachelVorlage(fernseher);

  const kacheln = kachelRaster(lat, lon, z, vorlage).map(k => ({
    type: 'Image',
    source: k.url,
    position: 'absolute',
    width: KACHEL,
    height: KACHEL,
    left: `\${viewport.width / 2 + (${k.links})}`,
    top: `\${viewport.height / 2 + (${k.oben})}`,
    scale: 'fill',
    // Nur laden, was im Bild liegt (siehe Kopf der Datei).
    when: `\${${k.links} < viewport.width / 2 && ${k.links + KACHEL} > -viewport.width / 2`
      + ` && ${k.oben} < viewport.height / 2 && ${k.oben + KACHEL} > -viewport.height / 2}`,
  }));

  const ebenen = [...kacheln];

  // Genauigkeitskreis: nur, wenn er sichtbar groesser ist als der Pin selbst.
  const radius = Number.isFinite(acc) && acc > 0 ? Math.round(acc / meterProPixel(lat, z)) : 0;
  if (radius >= 14) {
    const r = Math.min(radius, 2000);
    ebenen.push({
      type: 'Frame',
      position: 'absolute',
      width: 2 * r,
      height: 2 * r,
      left: `\${viewport.width / 2 - ${r}}`,
      top: `\${viewport.height / 2 - ${r}}`,
      borderRadius: r,
      borderWidth: 2,
      borderColor: '#1a73e8',
      backgroundColor: 'rgba(26, 115, 232, 0.15)',
    });
  }

  // Der Pin: blauer Punkt mit weissem Rand, wie man ihn von Kartenapps kennt.
  ebenen.push({
    type: 'Frame',
    position: 'absolute',
    width: 30,
    height: 30,
    left: '${viewport.width / 2 - 15}',
    top: '${viewport.height / 2 - 15}',
    borderRadius: 15,
    borderWidth: 4,
    borderColor: '#ffffff',
    backgroundColor: veraltet ? '#80868b' : '#1a73e8',
  });

  // Kopfzeile: Name, Ort, Alter. Das Polster wahrt Abstand zum runden Echo Spot.
  // Hintergrundfarben gibt es in APL nur am Frame, nicht an Container oder Text.
  ebenen.push({
    type: 'Frame',
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    item: [{
      type: 'Container',
      paddingLeft: '${viewport.shape == "round" ? 80 : 32}',
      paddingRight: '${viewport.shape == "round" ? 80 : 32}',
      paddingTop: '${viewport.shape == "round" ? 48 : 20}',
      paddingBottom: 16,
      alignItems: '${viewport.shape == "round" ? "center" : "start"}',
      items: [
        {
          type: 'Text',
          text: '${payload.karte.name}',
          fontSize: '${viewport.width < 600 ? 28 : 40}',
          fontWeight: 'bold',
          color: '#ffffff',
          maxLines: 1,
        },
        {
          type: 'Text',
          text: '${payload.karte.zeile}',
          fontSize: '${viewport.width < 600 ? 20 : 26}',
          color: '#e8eaed',
          maxLines: 2,
          textAlign: '${viewport.shape == "round" ? "center" : "left"}',
        },
      ],
    }],
  });

  // Quellenangabe - verlangt von der OSM-Lizenz (ODbL) und von CARTO.
  ebenen.push({
    type: 'Frame',
    position: 'absolute',
    right: '${viewport.shape == "round" ? 120 : 8}',
    bottom: '${viewport.shape == "round" ? 40 : 4}',
    backgroundColor: 'rgba(255, 255, 255, 0.7)',
    item: [{
      type: 'Text',
      text: vorlage.includes('cartocdn') ? '© OpenStreetMap-Mitwirkende © CARTO' : '© OpenStreetMap-Mitwirkende',
      fontSize: 14,
      color: '#202124',
      paddingLeft: 4,
      paddingRight: 4,
    }],
  });

  return {
    type: 'Alexa.Presentation.APL.RenderDocument',
    token: 'standortkarte',
    document: {
      type: 'APL',
      version: '2023.2',
      // Wie lange die Karte stehen bleibt. Wirkt nur, weil die Antwort die
      // Sitzung offen laesst (`shouldEndSession` fehlt, siehe api/skill.js) -
      // mit beendeter Sitzung raeumt der Echo nach wenigen Sekunden ab, egal
      // was hier steht. "Alexa, stopp" oder ein Tipp auf den Bildschirm
      // schliessen sie frueher.
      settings: { idleTimeout: kartenDauerMs() },
      theme: 'dark',
      mainTemplate: {
        parameters: ['payload'],
        items: [{
          type: 'Container',
          width: '100vw',
          height: '100vh',
          // Hinter den Kacheln: solange sie laden, ist die Flaeche nicht schwarz.
          item: [{
            type: 'Frame',
            width: '100vw',
            height: '100vh',
            backgroundColor: '#e5e3df',
            item: [{
              type: 'Container',
              width: '100vw',
              height: '100vh',
              items: ebenen,
            }],
          }],
        }],
      },
    },
    datasources: {
      karte: {
        name,
        zeile: `${ort}${alter ? ` · ${veraltet ? 'zuletzt ' : ''}${alter}` : ''}`,
      },
    },
  };
}
