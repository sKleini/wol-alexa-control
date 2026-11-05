// lib/kachel.js – Kartenkacheln fuer die Echo-Karte, durchgereicht von dieser App
//
//   GET /api/skill?kachel=1&z=16&x=34125&y=21789   -> image/png
//
// **Warum es diesen Umweg gibt.** Direkt bei tile.openstreetmap.org bekam der
// Fire TV auf jede Kachel "403 Access blocked - App is not following the tile
// usage policy": Sein Bildlader schickt nicht die Absenderkennung, die OSM
// verlangt. CARTO als Ersatz zeigte
// "API KEY REQUIRED". Also holt diese App die Kachel selbst - mit eigener,
// erkennbarer Kennung, wie sie die OSM-Regeln fordern - und reicht sie durch.
// Seit es auf dem Fire TV lief, gehen auch Echo Show & Co. diesen Weg: Bei
// ihnen klappte es direkt, aber nur, weil OSM sie (noch) nicht sperrte.
//
// **Gepuffert vom Vercel-CDN.** Die Antwort traegt `s-maxage`; dieselbe Kachel
// kommt danach eine Woche lang aus dem CDN, ohne Function-Aufruf und ohne
// Anfrage bei OSM. Auch das verlangen die OSM-Regeln (nicht staendig neu laden).
//
// **Kein offener Proxy.** Angenommen werden nur ganze Zahlen im gueltigen
// Bereich einer Zoomstufe; das Ziel ist fest. Wer die Adresse kennt, kann damit
// nur OSM-Kacheln abrufen - dasselbe, was er auch direkt koennte.
//
// Steht in api/skill.js und nicht als eigene Datei unter api/, weil der
// Hobby-Tarif zwoelf Functions erlaubt und api/ zwoelf hat.

const QUELLE = 'https://tile.openstreetmap.org';
const KENNUNG = 'wol-alexa-control (https://github.com/sKleini/wol-alexa-control)';

/**
 * Prueft die Kachelnummer. Rein und exportiert, damit es ohne Netz pruefbar ist.
 * @returns {{z:number,x:number,y:number}|null}
 */
export function kachelAus(q) {
  const zahl = v => (typeof v === 'string' && /^\d{1,7}$/.test(v) ? Number(v) : NaN);
  const z = zahl(q?.z), x = zahl(q?.x), y = zahl(q?.y);
  if (![z, x, y].every(Number.isInteger)) return null;
  if (z < 0 || z > 19) return null;
  const n = 2 ** z;
  if (x >= n || y >= n) return null;
  return { z, x, y };
}

/** Die Kachelvorlage fuer den Fire TV - zeigt auf diese App. */
export function proxyVorlage(basis) {
  return `${basis}/api/skill?kachel=1&z={z}&x={x}&y={y}`;
}

export async function kachelDurchreichen(req, res, q, holen = fetch) {
  const k = kachelAus(q);
  if (!k) return res.status(400).end();
  try {
    const antwort = await holen(`${QUELLE}/${k.z}/${k.x}/${k.y}.png`, {
      headers: { 'User-Agent': KENNUNG, Referer: 'https://github.com/sKleini/wol-alexa-control' },
      signal: AbortSignal.timeout(8000),
    });
    if (!antwort.ok) {
      console.error(`Kachel ${k.z}/${k.x}/${k.y}: OSM ${antwort.status}`);
      // Kurz gepuffert, damit ein Aussetzer nicht eine Woche lang klebt.
      res.setHeader('Cache-Control', 'public, s-maxage=60');
      return res.status(502).end();
    }
    const bytes = Buffer.from(await antwort.arrayBuffer());
    res.setHeader('Content-Type', antwort.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    if (req.method === 'HEAD') return res.status(200).end();
    return res.status(200).send(bytes);
  } catch (err) {
    console.error(`Kachel ${k.z}/${k.x}/${k.y} nicht geholt:`, err);
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    return res.status(502).end();
  }
}
