import type { Candle, Signal, TokenSnapshot } from "../types.js";
import * as dex from "../data/dexscreener.js";
import * as gecko from "../data/gecko.js";
import * as rug from "../data/rugcheck.js";
import * as jup from "../data/jupiter.js";
import { config } from "../config.js";
import { isCopycat, isSlop } from "../engine/filters.js";
import { cooldowns, audit, market } from "../db.js";

export interface Context {
  now: number;
  solPrice: number;
  migrations: Map<string, number>;   // mint -> migratedAt
}

export interface Strategy {
  name: Signal["mode"];
  everyMs: number;
  scan(ctx: Context): Promise<Signal[]>;
}

export interface Gate { ok: boolean; why?: string; holders?: number; top10?: number }

/** Shared pre-entry gate: copycat, safety, slop, exit liquidity, test sell. */
export async function gate(s: TokenSnapshot, mode: Signal["mode"], sizeUsd: number): Promise<Gate> {
  const cc = config.pinned.includes(s.mint) ? null : isCopycat(s);
  if (cc) return { ok: false, why: `copycat: ${cc}` };
  if (cooldowns.active(mode, s.mint)) return { ok: false, why: "cooldown" };
  const safe = await rug.safety(s.mint, s.onCurve);
  if (!safe.ok) return { ok: false, why: `safety: ${safe.reasons.join(", ")}` };
  const slop = isSlop(s, safe.holders);
  if (slop) return { ok: false, why: `slop: ${slop}` };
  if (!s.onCurve) {
    const qty = sizeUsd / s.priceUsd;
    const ts = await jup.testSell(s.mint, qty);
    if (!ts.routable) return { ok: false, why: "no sell route" };
    if (ts.impactPct > config.fees.exitImpactWarnPct) return { ok: false, why: `exit impact ${(ts.impactPct * 100).toFixed(1)}%` };
  }
  return { ok: true, holders: safe.holders, top10: safe.top10Pct };
}

export function logSignal(sig: Signal, taken: boolean, why: string) {
  audit.signal(sig.mode, sig.mint, sig.symbol, sig.score, taken, why, sig.snapshot.priceUsd, sig.snapshot.mcapUsd, sig.snapshot.liquidityUsd);
  const labels: string[] = [];
  if (sig.meta?.walletCount) labels.push(`${sig.meta.walletCount} trusted bought`);
  market.upsert(sig.snapshot, sig.meta?.holders as number | undefined, labels);
}

/** Record a look that never became a signal (filtered before scoring). Shows up in "looked at but did not buy". */
const lastLook = new Map<string, number>();
export function logLook(mode: Signal["mode"], s: TokenSnapshot, why: string, holders?: number) {
  const k = `${mode}:${s.mint}`;
  if (Date.now() - (lastLook.get(k) ?? 0) < 60 * 60_000) return;   // one look per coin per mode per hour
  lastLook.set(k, Date.now());
  audit.signal(mode, s.mint, s.symbol, 0, false, why, s.priceUsd, s.mcapUsd, s.liquidityUsd);
  market.upsert(s, holders);
}

export async function candles5and15(pair: string): Promise<{ c5: Candle[]; c15: Candle[] }> {
  const [c5, c15] = await Promise.all([gecko.candles(pair, 5, 100), gecko.candles(pair, 15, 60)]);
  return { c5, c15 };
}

export function buySellRatio(s: TokenSnapshot): number {
  return s.sells5m > 0 ? s.buys5m / s.sells5m : s.buys5m > 0 ? 99 : 0;
}

/** True if the last `n` closed 5m candles all have lows within tol of `low`. */
export function baseHolds(c5: Candle[], low: number, n: number, tol = 0.05): boolean {
  const last = c5.slice(-n - 1, -1);   // exclude the forming candle
  return last.length === n && last.every(k => k.l >= low * (1 - tol));
}

/** Green close above `level` on volume >= x times the average of the previous n candles. */
export function reclaim(c5: Candle[], level: number, volX: number, n = 6): boolean {
  if (c5.length < n + 2) return false;
  const k = c5.at(-2)!;                       // last CLOSED 5m candle
  const prev = c5.slice(-2 - n, -2);
  const avgV = prev.reduce((a, b) => a + b.v, 0) / prev.length;
  return k.c > k.o && k.c > level && avgV > 0 && k.v >= avgV * volX;
}

export { dex, gecko };
