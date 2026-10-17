import { isAuthed } from "./_auth.js";

// Proxies to the bot. Keeps BOT_TOKEN server-side; the browser only ever has the session cookie.
// Env: BOT_URL (http://<droplet-ip>:8787), BOT_TOKEN (same as DASHBOARD_TOKEN on the droplet), DASH_PASSWORD
export default async function handler(req, res) {
  if (!isAuthed(req)) { res.status(401).json({ error: "login" }); return; }
  const base = process.env.BOT_URL, token = process.env.BOT_TOKEN;
  if (!base || !token) { res.status(500).json({ error: "Dashboard isn't connected to the bot yet. Set BOT_URL and BOT_TOKEN in the Vercel project." }); return; }
  const path = req.method === "POST" ? "/api/control" : "/api/state";
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: req.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: req.method === "POST" ? JSON.stringify(req.body || {}) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    res.setHeader("cache-control", "no-store");
    res.status(r.status).send(await r.text());
  } catch (e) {
    res.status(502).json({ error: "The bot didn't answer. It may be down, or the droplet firewall is blocking port 8787.", detail: String(e) });
  }
}
