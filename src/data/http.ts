import { log } from "../log.js";

interface Bucket { tokens: number; last: number; rate: number; cap: number }
const buckets = new Map<string, Bucket>();

/** Simple token bucket per host so GeckoTerminal / RugCheck don't 429 us. */
function take(host: string, ratePerSec: number, cap: number): number {
  const now = Date.now();
  let b = buckets.get(host);
  if (!b) { b = { tokens: cap, last: now, rate: ratePerSec, cap }; buckets.set(host, b); }
  b.tokens = Math.min(b.cap, b.tokens + ((now - b.last) / 1000) * b.rate);
  b.last = now;
  if (b.tokens >= 1) { b.tokens -= 1; return 0; }
  return ((1 - b.tokens) / b.rate) * 1000;
}

const limits: Record<string, { rate: number; cap: number }> = {
  "api.dexscreener.com": { rate: 4, cap: 8 },
  "api.geckoterminal.com": { rate: 0.25, cap: 1 },  // 15/min. Their cap is 30/min per IP and v1 shares the IP.
  "api.rugcheck.xyz": { rate: 1, cap: 3 },
  "lite-api.jup.ag": { rate: 3, cap: 6 },
};

const cache = new Map<string, { at: number; v: unknown }>();
/** After a 429, stop calling that host for a while instead of burning the quota on retries. */
const coolUntil = new Map<string, number>();
export function hostCooling(host: string): boolean { return (coolUntil.get(host) ?? 0) > Date.now(); }

export async function getJson<T>(url: string, opts: { ttlMs?: number; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
  const ttl = opts.ttlMs ?? 0;
  if (ttl > 0) {
    const c = cache.get(url);
    if (c && Date.now() - c.at < ttl) return c.v as T;
  }
  const host = new URL(url).host;
  if (hostCooling(host)) throw new Error(`cooling ${host}`);
  const lim = limits[host];
  if (lim) {
    const wait = take(host, lim.rate, lim.cap);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, { headers: { accept: "application/json", ...(opts.headers ?? {}) }, signal: ctrl.signal });
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after")) || 30;
      coolUntil.set(host, Date.now() + ra * 1000);
      log.warn({ host, pauseS: ra }, "rate limited, pausing this host");
      throw new Error(`429 ${host}`);
    }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const v = (await res.json()) as T;
    if (ttl > 0) cache.set(url, { at: Date.now(), v });
    return v;
  } finally {
    clearTimeout(t);
  }
}
