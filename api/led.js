// api/led.js – GET /api/led?action=on|off&key=<geheimer-Aufruf-Key>
export default async function handler(req, res) {
  const { action, key } = req.query;
  // Fail closed: with LED_CALL_KEY unset, `key !== process.env.LED_CALL_KEY`
  // compares undefined against undefined, so a request without any key would
  // pass. Same guard style as location.js / manage.js / skill.js.
  if (!process.env.LED_CALL_KEY || key !== process.env.LED_CALL_KEY) return res.status(401).end();
  if (!["on", "off"].includes(action)) return res.status(400).end();
  if (!process.env.LED_TOPIC || !process.env.LED_PASSWORD) {
    console.error("LED_TOPIC or LED_PASSWORD not configured");
    return res.status(500).json({ ok: false, error: "LED not configured" });
  }
  try {
    await fetch(`https://ntfy.sh/${process.env.LED_TOPIC}`, {
      method: "POST",
      body: `led:${action}:${process.env.LED_PASSWORD}`,
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error("Error sending LED command to ntfy:", err);
    return res.status(502).json({ ok: false, error: "Upstream unreachable" });
  }
  res.status(200).json({ ok: true, action });
}
