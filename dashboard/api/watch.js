import { isAuthed } from "./_auth.js";

// The Watch button on the Launch radar: add or remove a coin from Nat's watch list. The bot then checks it every scan.
export default async function handler(req, res) {
  if (!isAuthed(req)) { res.status(401).json({ error: "login" }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const base = process.env.BOT_URL, token = process.env.BOT_TOKEN;
  if (!base || !token) { res.status(500).json({ ok: false, why: "Dashboard isn't connected to the bot yet." }); return; }
  try {
    const b = req.body || {};
    const r = await fetch(`${base.replace(/\/$/, "")}/api/watch`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mint: String(b.mint || ""), symbol: String(b.symbol || ""), on: b.on !== false }),
      signal: AbortSignal.timeout(10000),
    });
    res.setHeader("cache-control", "no-store");
    res.status(r.status).send(await r.text());
  } catch (e) {
    res.status(502).json({ ok: false, why: "The bot didn't answer. Try again in a minute.", detail: String(e) });
  }
}
