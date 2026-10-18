import { isAuthed } from "./_auth.js";

// Proxies the bot's lab report (entry replay experiments). GET reads the latest report, POST starts a run.
export default async function handler(req, res) {
  if (!isAuthed(req)) { res.status(401).json({ error: "login" }); return; }
  const base = process.env.BOT_URL, token = process.env.BOT_TOKEN;
  if (!base || !token) { res.status(500).json({ error: "Dashboard isn't connected to the bot yet." }); return; }
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/api/lab`, {
      method: req.method === "POST" ? "POST" : "GET", headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    res.setHeader("cache-control", "no-store");
    res.status(r.status).send(await r.text());
  } catch (e) {
    res.status(502).json({ error: "The bot didn't answer.", detail: String(e) });
  }
}
