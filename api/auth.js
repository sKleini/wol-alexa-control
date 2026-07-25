// api/auth.js – Account-Linking-Einstieg für den Alexa-Skill.
// Nur Amazons Linking-Ziele sind als redirect_uri zulaessig: ohne Allowlist ist
// das ein offener Redirect, mit dem sich unter der eigenen Domain auf beliebige
// Seiten weiterleiten laesst (Phishing).
function isAllowedRedirect(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  return host === 'layla.amazon.com'
    || host === 'pitangui.amazon.com'
    || host === 'alexa.amazon.co.jp'
    || host.endsWith('.amazon.com')
    || host.endsWith('.amazon.co.jp')
    || host.endsWith('.amazon.de');
}

export default async function handler(req, res) {
  const { redirect_uri, state } = req.query;
  if (!redirect_uri) return res.status(400).send('Missing redirect_uri');
  if (!isAllowedRedirect(redirect_uri)) return res.status(400).send('Invalid redirect_uri');

  const url = new URL(redirect_uri);
  url.searchParams.set('code', 'fake_code');
  // Ueber searchParams wird korrekt kodiert: ein state mit & oder # zerlegte
  // sonst die URL, ein fehlender state ergab woertlich "state=undefined".
  if (typeof state === 'string' && state) url.searchParams.set('state', state);
  return res.redirect(url.toString());
}
