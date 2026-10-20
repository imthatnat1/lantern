import { getJson } from "./http.js";
import type { Candle } from "../types.js";
import { recorder } from "../db.js";
import { mintForPair } from "./pairmint.js";

type Tf = "minute" | "hour";

/**
 * GeckoTerminal OHLCV. aggregate: 1/5/15 for minute. Returns oldest -> newest.
 * Cached for most of the candle length so we don't hammer their 30/min limit.
 */
/**
 * The OHLCV URL. With the coin's mint, GeckoTerminal charts that coin whichever side of the pool it lists it on.
 * Without it, it charts the pool's "base", which for ZCAT/ZEC was ZEC: $1,235 candles for a $0.056 coin, so dip read
 * every Stonk.fun pair as "down 100% from the high" and never bought their turn (20 to 21 Oct).
 */
export function ohlcvUrl(pairAddress: string, agg: number, limit: number, mint?: string): string {
  const tf: Tf = "minute";
  return `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}/ohlcv/${tf}?aggregate=${agg}&limit=${limit}&currency=usd${mint ? `&token=${mint}` : ""}`;
}

export async function candles(pairAddress: string, agg: 1 | 5 | 15, limit = 100, mint = mintForPair(pairAddress)): Promise<Candle[]> {
  const url = ohlcvUrl(pairAddress, agg, limit, mint);
  const r = await getJson<{ data: { attributes: { ohlcv_list: number[][] } } }>(url, { ttlMs: agg * 60_000 * 0.8 });
  const list = r.data?.attributes?.ohlcv_list ?? [];
  const out = list
    .map(([t, o, h, l, c, v]) => ({ t: t * 1000, o, h, l, c, v }))
    .sort((a, b) => a.t - b.t);
  if (out.length) { try { recorder.candles(pairAddress, agg, out); } catch { /* best effort */ } }
  return out;
}

/**
 * Roll 5m candles up into 15m ones, aligned to 15-minute boundaries (open of the first, high/low over all,
 * close of the last, volume summed). The last bucket can be partial, as GeckoTerminal's own latest candle is.
 */
export function rollUp(c5: Candle[], minutes = 15): Candle[] {
  const ms = minutes * 60_000;
  const out: Candle[] = [];
  for (const k of c5) {
    const t = Math.floor(k.t / ms) * ms;
    const last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, k.h); last.l = Math.min(last.l, k.l); last.c = k.c; last.v += k.v; }
    else out.push({ t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
  }
  return out;
}

/** Average true range over the last n candles. */
export function atr(c: Candle[], n = 14): number {
  if (c.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const prev = c[i - 1].c;
    trs.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - prev), Math.abs(c[i].l - prev)));
  }
  const slice = trs.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export function lowestLow(c: Candle[], sinceMs: number): number {
  let lo = Infinity;
  for (const k of c) if (k.t >= sinceMs) lo = Math.min(lo, k.l);
  return lo === Infinity ? (c.at(-1)?.l ?? 0) : lo;
}

/** Highest CLOSE since `sinceMs`. Wicks on thin pools and data glitches make raw highs useless as a reference. */
export function highestHigh(c: Candle[], sinceMs: number): number {
  let hi = 0;
  for (const k of c) if (k.t >= sinceMs) hi = Math.max(hi, Math.max(k.o, k.c));
  return hi || (c.at(-1)?.c ?? 0);
}

/** Lowest CLOSE since `sinceMs`, for the same reason. Stops still use true lows via lowestLow. */
export function lowestClose(c: Candle[], sinceMs: number): number {
  let lo = Infinity;
  for (const k of c) if (k.t >= sinceMs) lo = Math.min(lo, Math.min(k.o, k.c));
  return lo === Infinity ? (c.at(-1)?.c ?? 0) : lo;
}

export function vwap(c: Candle[], sinceMs: number): number {
  let pv = 0, v = 0;
  for (const k of c) if (k.t >= sinceMs) { const tp = (k.h + k.l + k.c) / 3; pv += tp * k.v; v += k.v; }
  return v ? pv / v : (c.at(-1)?.c ?? 0);
}
