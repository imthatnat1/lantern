import { createHmac, timingSafeEqual } from "node:crypto";

// Session cookie: HMAC of a fixed string with DASH_SECRET. Login compares against DASH_PASSWORD.
const secret = () => process.env.DASH_SECRET || process.env.BOT_TOKEN || "";
export const COOKIE = "lantern_session";

export function sessionValue() {
  return createHmac("sha256", secret()).update("lantern-ok").digest("hex");
}

export function isAuthed(req) {
  const raw = req.headers.cookie || "";
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`));
  if (!m) return false;
  const want = Buffer.from(sessionValue());
  const got = Buffer.from(m[1]);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function setSession(res) {
  res.setHeader("set-cookie", `${COOKIE}=${sessionValue()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`);
}

export function clearSession(res) {
  res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
