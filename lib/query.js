// lib/query.js – die Query-Parameter einer Anfrage, ohne `url.parse()`.

/**
 * Die Query-Parameter der Anfrage als einfaches Objekt.
 *
 * **Warum das nicht einfach `req.query` ist.** Vercel haengt `query` als
 * Lazy-Getter an das Request-Objekt, und dieser Getter ruft intern
 * `url.parse(req.url, true)` auf. Seit Node 22 ist das eine Runtime
 * Deprecation, und der erste Zugriff schreibt sie in das Funktionsprotokoll:
 *
 *   [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized
 *   and prone to errors that have security implications.
 *
 * Genau deshalb tauchte sie bei /api/relay-status und /api/location auf und
 * nicht ueberall: Der Getter feuert erst, wenn ein Handler `req.query`
 * tatsaechlich liest - bei relay-status durch `keyOk()`, bei location durch
 * `pick()`. Wird `req.query` nie angefasst, bleibt das Protokoll sauber.
 *
 * Hier wird der Query-String deshalb selbst gelesen, mit `URLSearchParams`
 * aus der WHATWG-URL-API - das ist die Ablösung, die die Warnung empfiehlt.
 *
 * **Abgetrennt wird von Hand statt mit `new URL(req.url, base)`.** `req.url`
 * ist ein Pfad, kein vollstaendiger Link; `new URL` braucht dafuer eine
 * erfundene Basis und wirft bei allem, was es nicht als Pfad durchgehen
 * laesst. Der Teil hinter dem ersten `?` ist genau das, was gebraucht wird,
 * und ein Handler soll an einer krummen Adresse nicht mit einem 500
 * aussteigen, sondern sie wie eine ohne Parameter behandeln.
 *
 * **Die Form ist die von `url.parse(..., true)`**, damit die Aufrufer nichts
 * merken: ein fehlender Parameter ist `undefined`, ein einmal genannter eine
 * Zeichenkette, ein mehrfach genannter ein Array. Das Array ist nicht
 * Kosmetik - `keyOk()` in lib/auth.js weist genau daran einen zweiten
 * `?key=`-Parameter ab.
 *
 * Ohne Prototyp: Ein Parameter namens `constructor` oder `toString` soll ein
 * gewoehnlicher Eintrag sein und keine geerbte Funktion zurueckgeben. Auch
 * das hielte es so wie `url.parse`.
 *
 * Der Rueckfall auf ein bereits vorhandenes `req.query` gilt den Tests und
 * Aufrufern, die ein Request-Objekt von Hand bauen und gar kein `url` haben.
 * Auf Vercel steht `req.url` immer, der Rueckfall greift dort also nie - und
 * der Getter bleibt unberuehrt.
 *
 * @param {{url?: string, query?: Record<string, string|string[]>}} req
 * @returns {Record<string, string|string[]>}
 */
export function queryOf(req) {
  const roh = typeof req?.url === 'string' ? req.url : null;
  if (roh === null) return req?.query ?? Object.create(null);

  const out = Object.create(null);
  const ab = roh.indexOf('?');
  if (ab < 0) return out;

  // Ein Fragment kann in einer Server-Anfrage nicht ankommen - der Browser
  // schickt es nicht mit. Es steht trotzdem hier, weil ein selbstgebauter
  // Aufrufer (curl, ein Skript auf dem VPS) eines anhaengen kann, und dann
  // gehoerte "#top" sonst zum letzten Wert.
  const bis = roh.indexOf('#', ab);
  const qs = bis < 0 ? roh.slice(ab + 1) : roh.slice(ab + 1, bis);

  for (const [k, v] of new URLSearchParams(qs)) {
    const da = out[k];
    if (da === undefined) out[k] = v;
    else if (Array.isArray(da)) da.push(v);
    else out[k] = [da, v];
  }
  return out;
}
