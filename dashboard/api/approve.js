import { isAuthed } from "./_auth.js";

// Approval queue: Nat's yes or no on a buy waiting for her (engine/approvals.ts). Off while Lantern is on paper.
export default async function handler(req, res) {
  if (!isAuthed(req)) { res.status(401).json({ error: "login" }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const base = process.env.BOT_URL, token = process.env.BOT_TOKEN;
  if (!base || !token) { res.status(500).json({ ok: false, why: "Dashboard isn't connected to the bot yet." }); return; }
  const b = req.body || {};
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/api/approve`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: Number(b.id), yes: b.yes === true }),
      signal: AbortSignal.timeout(10000),
    });
    res.setHeader("cache-control", "no-store");
    res.status(r.status).send(await r.text());
  } catch (e) {
    res.status(502).json({ ok: false, why: "The bot didn't answer. Try again in a moment.", detail: String(e) });
  }
}
