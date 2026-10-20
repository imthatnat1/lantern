/**
 * Our own 5-minute candles, built from DexScreener, so GeckoTerminal is only needed for history.
 *
 * GeckoTerminal allows ~30 chart calls a minute per server, shared with Blossom. Lantern asked it for a fresh chart
 * on every check, so the host kept "cooling" and checks failed (18 Oct, all evening). DexScreener's pairs endpoint
 * prices 30 pairs per call and allows ~300 calls a minute.
 *
 * How it works:
 *  - Any pair a strategy or the exit loop asks candles for is "wanted" for 2 hours.
 *  - Every 20s the wanted pairs (most recent first, up to 180) are priced from DexScreener, 30 per call. Each sample
 *    updates that pair's forming 5m candle: open = previous close, high/low/close from the samples, volume = the
 *    pair's rolling 5-minute volume at the last sample (about that candle's volume).
 *  - When a 5m bucket ends, the candle is written to the candles table (the lab reads it too).
 *  - GeckoTerminal is asked once per pair for history (24h of 5m candles), and again only if our sampling of that
 *    pair broke (dropped out of the wanted list, or DexScreener didn't return it for 2+ minutes), to fill the gap.
 *
 * Trade-off: 20s sampling can miss a wick between samples, so highs and lows are a little softer than GeckoTerminal's.
 * The patterns mostly read closes, and the stops are judged on 15m closes.
 */
import { db } from "../db.js";
import { getJson } from "./http.js";
import * as gecko from "./gecko.js";
import { mintForPair, notePairMint } from "./pairmint.js";
import { log } from "../log.js";
import type { Candle } from "../types.js";

const M5 = 5 * 60_000;
export const POLL_MS = 20_000;
const WANT_TTL_MS = 2 * 3_600_000;
const MAX_PAIRS = 180;
const BREAK_MS = 2 * 60_000;
const HISTORY_MS = 25 * 3_600_000;

interface Forming { bucket: number; o: number; h: number; l: number; c: number; v: number; first: number }

const wanted = new Map<string, number>();          // pair -> last asked for
const forming = new Map<string, Forming>();
const lastClose = new Map<string, number>();
const lastSampleAt = new Map<string, number>();
const sampledSince = new Map<string, number>();    // continuous sampling since (reset after a break)
const geckoFetchBucket = new Map<string, number>(); // the 5m bucket that was forming when history was fetched

/** Rolling counters for the dashboard: where each chart came from in the last hour. */
const served: { at: number; own: boolean }[] = [];
let geckoCalls: number[] = [], geckoFails: number[] = [];
function prune(a: number[], now: number) { while (a.length && now - a[0] > 3_600_000) a.shift(); }

const insert = db.prepare("INSERT OR REPLACE INTO candles(pair,agg,t,o,h,l,c,v) VALUES(?,?,?,?,?,?,?,?)");
const existing = db.prepare("SELECT o,h,l,c,v FROM candles WHERE pair=? AND agg=5 AND t=?");
const history = db.prepare("SELECT t,o,h,l,c,v FROM candles WHERE pair=? AND agg=5 AND t >= ? AND t < ? ORDER BY t");

/** A bucket ended: store its candle. A bucket we only saw part of is merged with what GeckoTerminal gave for it. */
function close(pair: string, f: Forming) {
  const complete = f.first - f.bucket <= POLL_MS * 2;
  if (complete) { insert.run(pair, 5, f.bucket, f.o, f.h, f.l, f.c, f.v); return; }
  const g = existing.get(pair, f.bucket) as Candle | undefined;
  if (!g) return;   // a partial candle with nothing to merge would be wrong; leave the gap to history
  insert.run(pair, 5, f.bucket, g.o, Math.max(g.h, f.h), Math.min(g.l, f.l), f.c, Math.max(g.v, f.v));
}

/** One price sample for a pair. Exported for tests. */
export function sample(pair: string, price: number, vol5m: number, now = Date.now()) {
  if (!(price > 0)) return;
  const bucket = Math.floor(now / M5) * M5;
  const last = lastSampleAt.get(pair);
  if (last === undefined || now - last > BREAK_MS) sampledSince.set(pair, now);
  lastSampleAt.set(pair, now);
  let f = forming.get(pair);
  if (f && f.bucket !== bucket) {
    if (bucket - f.bucket === M5 && now - (last ?? 0) <= BREAK_MS) close(pair, f);
    lastClose.set(pair, f.c);
    f = undefined;
  }
  if (!f) {
    const o = lastClose.get(pair) ?? price;
    f = { bucket, o, h: Math.max(o, price), l: Math.min(o, price), c: price, v: vol5m || 0, first: now };
    forming.set(pair, f);
  } else {
    f.h = Math.max(f.h, price); f.l = Math.min(f.l, price); f.c = price; f.v = vol5m || f.v;
  }
}

/** Price every wanted pair once. Called every POLL_MS by main.ts. */
export async function poll(now = Date.now()) {
  for (const [p, at] of wanted) if (now - at > WANT_TTL_MS) wanted.delete(p);
  const pairs = [...wanted].sort((a, b) => b[1] - a[1]).slice(0, MAX_PAIRS).map(([p]) => p);
  for (let i = 0; i < pairs.length; i += 30) {
    const chunk = pairs.slice(i, i + 30);
    try {
      type Row = { pairAddress: string; priceUsd?: string; volume?: { m5?: number }; baseToken?: { address?: string } };
      const r = await getJson<{ pairs?: Row[] | null; pair?: Row | null }>(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${chunk.join(",")}`);
      const rows = r.pairs ?? (r.pair ? [r.pair] : []);
      const t = Date.now();
      for (const p of rows) { notePairMint(p.pairAddress, p.baseToken?.address); sample(p.pairAddress, Number(p.priceUsd ?? 0), p.volume?.m5 ?? 0, t); }
    } catch (e) { log.debug({ err: String(e) }, "live candles poll failed"); }
  }
}

/**
 * Our coin's latest price for this pool: the forming candle, the last close, or the last DexScreener tick for the coin.
 * DexScreener always prices the coin we asked about, so this is the yardstick for stored history.
 */
const lastTick = db.prepare("SELECT price FROM ticks WHERE mint=? ORDER BY at DESC LIMIT 1");
function refPrice(pair: string): number | undefined {
  const f = forming.get(pair)?.c ?? lastClose.get(pair);
  if (f && f > 0) return f;
  const mint = mintForPair(pair);
  const r = mint ? lastTick.get(mint) as { price: number } | undefined : undefined;
  return r?.price && r.price > 0 ? r.price : undefined;
}

/**
 * Drop stored candles 100x away from the coin's live price. 21 Oct: GeckoTerminal history for inverted Stonk.fun pools
 * (ZEC/ZCAT) was stored in ZEC's price, $1,235 against $0.056, and with GeckoTerminal rate limiting most refetches the
 * bad rows kept being served, so dip read ZCAT as "down 100%". A real coin 100x off its price within a day is dead and
 * fails every mode's other checks anyway. Exported for tests.
 */
export function sane(rows: Candle[], ref: number | undefined, x = 100): Candle[] {
  if (!ref || !(ref > 0)) return rows;
  return rows.filter(k => k.h <= ref * x && k.l >= ref / x);
}

/** At least 20 of the last 24 hours of 5m candles on record (after the sanity filter), the newest within 15 minutes. */
export function storedIsWhole(pair: string, now: number, bucket = Math.floor(now / M5) * M5): boolean {
  const rows = sane(history.all(pair, now - 24 * 3_600_000, bucket) as Candle[], refPrice(pair));
  return rows.length >= 240 && bucket - rows[rows.length - 1].t <= 3 * M5;
}

export type HistoryFetch = (pair: string) => Promise<unknown>;
const fetchHistory: HistoryFetch = (pair) => gecko.candles(pair, 5, 288);

/**
 * 5m candles for a pair: stored history plus our live forming candle. Asks GeckoTerminal only when we have no
 * unbroken record of the pair since its last history fetch. Throws only if there's nothing at all to go on.
 */
export async function candles5(pair: string, now = Date.now(), fetch: HistoryFetch = fetchHistory): Promise<{ c5: Candle[]; own: boolean }> {
  wanted.set(pair, now);
  const bucket = Math.floor(now / M5) * M5;
  const since = sampledSince.get(pair);
  const fetched = geckoFetchBucket.get(pair);
  // Our record is complete from the first full bucket after sampling began. History fetched at bucket B covers
  // everything before B, and B itself gets merged when it closes. So we're whole if sampling began by B + 5m.
  const whole = since !== undefined && fetched !== undefined && Math.ceil(since / M5) * M5 <= fetched + M5
    && now - (lastSampleAt.get(pair) ?? 0) <= BREAK_MS;
  let own = whole;
  // 21 Oct: every restart forgot which pairs had history (geckoFetchBucket lives in memory) and asked GeckoTerminal
  // again for every wanted pair. On an IP shared with Blossom that storm got 34 of 34 calls refused at 07:20, and coins
  // with no history at all (MASK) couldn't be checked. If the stored record already covers the day and is recent,
  // use it and save GeckoTerminal for the pairs that really need it.
  if (!whole && storedIsWhole(pair, now, bucket)) { geckoFetchBucket.set(pair, bucket); own = true; }
  else if (!whole) {
    try {
      geckoCalls.push(now);
      await fetch(pair);
      geckoFetchBucket.set(pair, bucket);
    } catch (e) {
      geckoFails.push(now);
      own = true;   // serve what we have, if anything
      const rows = history.all(pair, now - HISTORY_MS, bucket + M5) as Candle[];
      if (rows.length < 12) throw e;
    }
  }
  const rows = sane(history.all(pair, now - HISTORY_MS, bucket) as Candle[], refPrice(pair));
  const f = forming.get(pair);
  const formingCandle: Candle | undefined = f && f.bucket === bucket
    ? { t: f.bucket, o: f.o, h: f.h, l: f.l, c: f.c, v: f.v }
    : (history.all(pair, bucket, bucket + M5) as Candle[])[0];
  served.push({ at: now, own });
  while (served.length && now - served[0].at > 3_600_000) served.shift();
  return { c5: formingCandle ? [...rows, formingCandle] : rows, own };
}

/** For the dashboard's Last hour strip. */
export function liveCandleStats(now = Date.now()) {
  prune(geckoCalls, now); prune(geckoFails, now);
  while (served.length && now - served[0].at > 3_600_000) served.shift();
  const pairs = [...wanted.values()].filter(at => now - at <= WANT_TTL_MS).length;
  return {
    tracking: Math.min(pairs, MAX_PAIRS),
    charts: served.length, own: served.filter(s => s.own).length,
    geckoCalls: geckoCalls.length, geckoFailed: geckoFails.length,
  };
}

/** Test helper: forget everything. */
export function _reset() {
  for (const m of [wanted, forming, lastClose, lastSampleAt, sampledSince, geckoFetchBucket]) m.clear();
  served.length = 0; geckoCalls = []; geckoFails = [];
}
