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
