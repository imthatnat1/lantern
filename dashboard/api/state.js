// Vercel serverless proxy. Keeps the bot token server-side.
// Env: BOT_URL (e.g. http://203.0.113.5:8787), BOT_TOKEN (same as DASHBOARD_TOKEN on the droplet)
export default async function handler(req, res) {
  const base = process.env.BOT_URL;
  const token = process.env.BOT_TOKEN;
  if (!base || !token) {
    res.status(500).json({ error: "Dashboard isn't connected to the bot yet. Set BOT_URL and BOT_TOKEN in the Vercel project." });
    return;
  }
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/api/state`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const body = await r.text();
    res.setHeader("cache-control", "no-store");
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: "The bot didn't answer. It may be down, or the droplet firewall is blocking the port.", detail: String(e) });
  }
}
