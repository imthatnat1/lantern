/**
 * Recorded market history for one coin, rebuilt so the live patterns can be run at any past moment.
 *
 * Candles: the bot only fetches candles for coins it is actively checking, so real 5m/15m candles have
 * gaps. Gaps are filled with candles built from recorded ticks (price, rolling 5m volume). Every trade
 * the lab reports says whether its entry saw real candles or tick-built ones.
 *
 * Dust pools: ticks before 18 Oct were priced off whichever pair claimed the most liquidity, sometimes a
 * dead pool. Ticks now carry their pair; older ticks are cleaned with a jump filter (see cleanTicks).
 */
import { db } from "../db.js";
import type { Candle } from "../types.js";
import type { Mkt } from "../strategies/base.js";

export interface Tick { at: number; price: number; liquidity: number; mcap: number; vol5m: number; buys5m: number; sells5m: number; pair: string | null; ch1h?: number | null; ch6h?: number | null; ch24h?: number | null }

export interface CoinInfo { mint: string; symbol: string; pair: string | null; quote: string | null; onCurve: boolean; createdAt: number }

const M5 = 5 * 60_000, M15 = 15 * 60_000;

/** Drop ticks from other pairs, and old unlabelled ticks that jump >3x on no volume or >8x unconfirmed. */
export function cleanTicks(raw: Tick[], pair: string | null): Tick[] {
  const own = raw.filter(t => t.price > 0 && (!t.pair || !pair || t.pair === pair));
  const out: Tick[] = [];
  for (let i = 0; i < own.length; i++) {
    const t = own[i];
    const prev = out.at(-1);
    if (prev && !t.pair) {
      const r = Math.max(t.price / prev.price, prev.price / t.price);
      const next = own[i + 1];
      const confirmed = !!next && Math.abs(next.price - t.price) / t.price <= 0.15;
      if (r > 3 && !t.vol5m && prev.vol5m) continue;   // dust pool: big jump with no trading behind it
      if (r > 8 && !confirmed) continue;
    }
    out.push(t);
  }
  return out;
}

/** Bucket ticks into candles. Volume is the largest rolling 5m volume seen in the bucket, scaled to the bucket. */
export function candlesFromTicks(ticks: Tick[], aggMs: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const t of ticks) {
    const b = Math.floor(t.at / aggMs) * aggMs;
    if (!cur || cur.t !== b) {
      if (cur) out.push(cur);
      cur = { t: b, o: out.at(-1)?.c ?? t.price, h: t.price, l: t.price, c: t.price, v: 0 };
      cur.h = Math.max(cur.h, cur.o); cur.l = Math.min(cur.l, cur.o);
    }
    cur.h = Math.max(cur.h, t.price); cur.l = Math.min(cur.l, t.price); cur.c = t.price;
    cur.v = Math.max(cur.v, (t.vol5m || 0) * (aggMs / M5));
  }
  if (cur) out.push(cur);
  return out;
}

/** Real candles where we have them, tick-built ones in the gaps. `real` marks which is which. */
function merge(real: Candle[], built: Candle[]): { c: Candle[]; real: Set<number> } {
  const byT = new Map<number, Candle>();
  for (const k of built) byT.set(k.t, k);
  const realT = new Set<number>();
  for (const k of real) { byT.set(k.t, k); realT.add(k.t); }
  return { c: [...byT.values()].sort((a, b) => a.t - b.t), real: realT };
}

export class CoinHistory {
  readonly ticks: Tick[];
  readonly c5: Candle[];
  readonly c15: Candle[];
  private real5: Set<number>;
  private holders: { at: number; holders: number }[];
  private safety: { at: number; ok: number; top10: number | null; holders: number | null; reasons: string | null }[];
  private rejections: number[];

  constructor(readonly info: CoinInfo, from: number, to: number) {
    const raw = db.prepare("SELECT at, price, COALESCE(liquidity,0) AS liquidity, COALESCE(mcap,0) AS mcap, COALESCE(vol5m,0) AS vol5m, COALESCE(buys5m,0) AS buys5m, COALESCE(sells5m,0) AS sells5m, pair, ch1h, ch6h, ch24h FROM ticks WHERE mint=? AND at BETWEEN ? AND ? ORDER BY at")
      .all(info.mint, from, to) as Tick[];
    this.ticks = cleanTicks(raw, info.pair);
    const q = db.prepare("SELECT t,o,h,l,c,v FROM candles WHERE pair=? AND agg=? AND t BETWEEN ? AND ? ORDER BY t");
    const r5 = info.pair ? q.all(info.pair, 5, from, to) as Candle[] : [];
    const r15 = info.pair ? q.all(info.pair, 15, from, to) as Candle[] : [];
    const m5 = merge(r5, candlesFromTicks(this.ticks, M5));
    this.c5 = m5.c; this.real5 = m5.real;
    this.c15 = merge(r15, candlesFromTicks(this.ticks, M15)).c;
    this.holders = db.prepare("SELECT at, holders FROM holders_history WHERE mint=? AND at BETWEEN ? AND ? ORDER BY at").all(info.mint, from, to) as any[];
    this.safety = db.prepare("SELECT at, ok, top10, holders, reasons FROM safety_history WHERE mint=? AND at BETWEEN ? AND ? ORDER BY at").all(info.mint, from, to) as any[];
    this.rejections = (db.prepare("SELECT at FROM signals_log WHERE mint=? AND at BETWEEN ? AND ? AND reason LIKE 'rejected:%' ORDER BY at").all(info.mint, from, to) as { at: number }[]).map(r => r.at);
  }

  /** Last index with key <= t. */
  private static idx<T>(a: T[], t: number, key: (x: T) => number): number {
    let lo = 0, hi = a.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (key(a[mid]) <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }

  tickAt(t: number, maxAgeMs = 10 * 60_000): Tick | null {
    const i = CoinHistory.idx(this.ticks, t, x => x.at);
    if (i < 0 || t - this.ticks[i].at > maxAgeMs) return null;
    return this.ticks[i];
  }

  /** First tick at or after t, within `withinMs`. Used as the fill after a signal. */
  tickAfter(t: number, withinMs = 10 * 60_000): Tick | null {
    const i = CoinHistory.idx(this.ticks, t - 1, x => x.at) + 1;
    const k = this.ticks[i];
    return k && k.at - t <= withinMs ? k : null;
  }

  ticksFrom(t: number): Tick[] { return this.ticks.slice(CoinHistory.idx(this.ticks, t - 1, x => x.at) + 1); }

  /**
   * The 5m candles the live bot would have seen at `now`: closed candles before the current bucket
   * (at most `keep`), plus the forming candle built only from ticks so far. No peeking at the future.
   */
  c5At(now: number, keep = 300): { c5: Candle[]; realShare: number } {
    const bucket = Math.floor(now / M5) * M5;
    const i = CoinHistory.idx(this.c5, bucket - 1, x => x.t);
    const closed = this.c5.slice(Math.max(0, i - keep + 2), i + 1);
    const t = this.tickAt(now);
    const prevC = closed.at(-1)?.c ?? t?.price ?? 0;
    const a = CoinHistory.idx(this.ticks, bucket - 1, x => x.at) + 1, b = CoinHistory.idx(this.ticks, now, x => x.at);
    const formingTicks = this.ticks.slice(a, b + 1);
    const ps = formingTicks.map(x => x.price);
    const forming: Candle = { t: bucket, o: prevC, h: Math.max(prevC, ...ps), l: Math.min(prevC, ...ps), c: ps.at(-1) ?? prevC, v: Math.max(0, ...formingTicks.map(x => x.vol5m)) };
    const recent = closed.slice(-24);
    const realShare = recent.length ? recent.filter(k => this.real5.has(k.t)).length / recent.length : 0;
    return { c5: [...closed, forming], realShare };
  }

  c15Before(now: number, keep = 120): Candle[] {
    const i = CoinHistory.idx(this.c15, now - M15, x => x.t);
    return this.c15.slice(Math.max(0, i - keep + 1), i + 1);
  }

  /** The closed 15m candles after `t`, for the exit engine. */
  c15From(t: number): Candle[] { return this.c15.filter(k => k.t >= t - M15); }

  private closeAt(t: number): number | null {
    const i = CoinHistory.idx(this.c5, t, x => x.t);
    return i >= 0 && t - this.c5[i].t < 30 * 60_000 ? this.c5[i].c : null;
  }

  /** The market as the live bot would have read it at `now`, or null without a fresh tick. */
  mktAt(now: number): (Mkt & { change5m: number; onCurve: boolean }) | null {
    const t = this.tickAt(now);
    if (!t) return null;
    // DexScreener's own figure when recorded (from 18 Oct), else worked out from our candles.
    const ch = (ms: number, rec?: number | null) => { if (rec != null) return rec; const c = this.closeAt(now - ms); return c ? (t.price / c - 1) * 100 : 0; };
    let vol24 = 0;
    const i0 = CoinHistory.idx(this.c5, now - 24 * 3_600_000, x => x.t), i1 = CoinHistory.idx(this.c5, now - M5, x => x.t);
    for (let i = Math.max(0, i0); i <= i1; i++) vol24 += this.c5[i].v;
    return {
      priceUsd: t.price, buys5m: t.buys5m, sells5m: t.sells5m, liquidityUsd: t.liquidity, mcapUsd: t.mcap,
      change5m: ch(5 * 60_000), change1h: ch(3_600_000, t.ch1h), change6h: ch(6 * 3_600_000, t.ch6h), change24h: ch(24 * 3_600_000, t.ch24h),
      volume24h: vol24, onCurve: this.info.onCurve,
    };
  }

  holdersAt(now: number): number | undefined {
    const i = CoinHistory.idx(this.holders, now, x => x.at);
    return i >= 0 ? this.holders[i].holders : undefined;
  }

  /**
   * What the safety gate said near `now`. Uses the recorded RugCheck result when we have one (from 18 Oct),
   * otherwise whether the live bot logged a rejection for this coin within the hour.
   */
  safetyAt(now: number): { known: boolean; rugOk: boolean; top10?: number; holders?: number; reasons?: string } {
    const i = CoinHistory.idx(this.safety, now, x => x.at);
    if (i >= 0 && now - this.safety[i].at < 30 * 60_000) {
      const s = this.safety[i];
      return { known: true, rugOk: !!s.ok, top10: s.top10 ?? undefined, holders: s.holders ?? undefined, reasons: s.reasons ?? undefined };
    }
    const j = CoinHistory.idx(this.rejections, now, x => x);
    const rejected = j >= 0 && now - this.rejections[j] < 60 * 60_000;
    return { known: false, rugOk: !rejected };
  }
}

/** Every coin with enough recorded ticks in the window. */
export function coinsInWindow(from: number, to: number, minTicks = 12): CoinInfo[] {
  const rows = db.prepare(`SELECT t.mint, COUNT(*) AS n, m.symbol, m.pair, m.quote, m.on_curve, m.created_at
    FROM ticks t LEFT JOIN market m ON m.mint=t.mint WHERE t.at BETWEEN ? AND ? GROUP BY t.mint HAVING n >= ?`).all(from, to, minTicks) as any[];
  return rows.map(r => ({ mint: r.mint, symbol: r.symbol ?? r.mint.slice(0, 4), pair: r.pair ?? null, quote: r.quote ?? null, onCurve: !!r.on_curve, createdAt: r.created_at ?? from }));
}

export function migrationsMap(): Map<string, number> {
  const out = new Map<string, number>();
  try { for (const r of db.prepare("SELECT mint, at FROM migrations").all() as { mint: string; at: number }[]) out.set(r.mint, r.at); } catch { /* table appears on first start */ }
  return out;
}
