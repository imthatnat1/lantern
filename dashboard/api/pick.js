import { isAuthed } from "./_auth.js";

// The Buy button on Watching. The bot runs its full safety gate and guardrails, then paper-buys or says why not.
// Safety checks call RugCheck, Jupiter and GeckoTerminal, so this can take 10-20 seconds.
export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (!isAuthed(req)) { res.status(401).json({ error: "login" }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const base = process.env.BOT_URL, token = process.env.BOT_TOKEN;
  if (!base || !token) { res.status(500).json({ ok: false, why: "Dashboard isn't connected to the bot yet." }); return; }
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/api/pick`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mint: String((req.body || {}).mint || "") }),
      signal: AbortSignal.timeout(28000),
    });
    res.setHeader("cache-control", "no-store");
    res.status(r.status).send(await r.text());
  } catch (e) {
    res.status(502).json({ ok: false, why: "The bot didn't answer in time. Check Open positions in a minute.", detail: String(e) });
  }
}
