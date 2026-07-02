// api/led.js – GET /api/led?action=on|off&key=<geheimer-Aufruf-Key>
export default async function handler(req, res) {
  const { action, key } = req.query;
  if (key !== process.env.LED_CALL_KEY) return res.status(401).end();
  if (!["on", "off"].includes(action)) return res.status(400).end();
  await fetch(`https://ntfy.sh/${process.env.LED_TOPIC}`, {
    method: "POST",
    body: `led:${action}:${process.env.LED_PASSWORD}`,
  });
  res.status(200).json({ ok: true, action });
}
