import { setSession, clearSession } from "./_auth.js";

export default async function handler(req, res) {
  if (req.method === "DELETE") { clearSession(res); res.status(200).json({ ok: true }); return; }
  if (req.method !== "POST") { res.status(405).end(); return; }
  const want = process.env.DASH_PASSWORD;
  if (!want) { res.status(500).json({ error: "DASH_PASSWORD isn't set in the Vercel project." }); return; }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const got = (body && body.password) || "";
  if (got.length !== want.length || got !== want) { res.status(401).json({ error: "That password doesn't match." }); return; }
  setSession(res);
  res.status(200).json({ ok: true });
}
