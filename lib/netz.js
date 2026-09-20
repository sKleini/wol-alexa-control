// lib/netz.js – die Grenzen fuer Abrufe, die der Server im Auftrag des
// Dashboards macht.
//
// Zwei Stellen holen fremde Adressen ab: die URL-Pruefung und der
// Ordner-Import (lib/musik.js, lib/fritznas.js). Beide laufen auf dem Server
// und mit dem Admin-Passwort - und beide duerfen trotzdem nicht als Sonde ins
// Vercel-Netz oder auf 127.0.0.1 taugen. Die Regel dafuer steht hier einmal,
// statt zweimal nebeneinander zu altern.

import { lookup } from 'dns/promises'

/**
 * Ist eine IP-Adresse privat, lokal oder sonst keine Adresse im Internet?
 *
 * Rein und exportiert, damit die Grenzen ohne Netz pruefbar sind.
 */
export function istPrivateAdresse(ip) {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return istPrivateAdresse(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/**
 * Darf der Server diese Adresse abrufen? Liefert den Grund, wenn nicht.
 */
export async function zielErlaubt(url) {
  if (url.protocol !== 'https:') return `kein https (${url.protocol})`;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local')) return 'lokaler Host';
  if (istPrivateAdresse(host)) return 'private Adresse';
  try {
    const { address } = await lookup(host);
    if (istPrivateAdresse(address)) return 'zeigt auf eine private Adresse';
  } catch {
    return 'Hostname nicht aufloesbar';
  }
  return null;
}

/**
 * Ueber welche Adresse erreicht der Server diese Box - und welche gibt es noch?
 *
 * **Warum das im Log fehlte.** Gemeldet war ein Abend, an dem jeder Titel mit
 * `MEDIA_ERROR_INTERNAL_SERVER_ERROR` scheiterte, waehrend der Skill dieselbe
 * Adresse Sekundenbruchteile vorher mit `HTTP 206, audio/mpeg` abrufen konnte -
 * siebzehnmal hintereinander. Datei, Pfad und Sitzungsnummer waren damit
 * ausgeschlossen; der Unterschied lag beim Abrufenden.
 *
 * Und dort gibt es einen, den bis dahin niemand gesehen hat: Ein
 * MyFRITZ!-Name traegt **zwei** Adressen. Der Server laeuft bei Vercel und
 * geht ueber IPv4; ein Echo im Heimnetz bevorzugt IPv6 und nimmt damit einen
 * ganz anderen Weg zur selben Box - einen, den der Skill nie anfasst. Bricht
 * der weg (ein neues Praefix, das im MyFRITZ!-Namen noch nicht steht, eine
 * Freigabe, die nur fuer IPv4 gilt), sieht der Skill weiter gruen, und der
 * Echo bleibt stumm.
 *
 * Diese Zeile macht die Luecke sichtbar, statt sie weiter zu verschweigen.
 */
export async function wegZurBox(host) {
  const name = String(host || '').replace(/^\[|\]$/g, '');
  if (!name) return '';
  let eigener = null;
  let alle = [];
  try {
    eigener = await lookup(name);
    alle = await lookup(name, { all: true });
  } catch {
    return `${name}: nicht aufloesbar`;
  }
  const v6 = alle.filter(a => a.family === 6).map(a => a.address);
  const teile = [`${name}: der Skill geht ueber IPv${eigener.family} ${eigener.address}`];
  if (eigener.family === 4 && v6.length) {
    teile.push(`die Box hat auch IPv6 ${v6[0]} – diesen Weg nimmt ein Echo zuerst, und er wird hier nie geprueft`);
  } else if (eigener.family === 4) {
    teile.push('keine IPv6-Adresse – Echo und Skill nehmen denselben Weg');
  }
  return teile.join(', ');
}
