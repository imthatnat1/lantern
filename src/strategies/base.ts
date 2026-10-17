import type { Candle, Signal, TokenSnapshot } from "../types.js";
import * as dex from "../data/dexscreener.js";
import * as gecko from "../data/gecko.js";
import * as rug from "../data/rugcheck.js";
import * as jup from "../data/jupiter.js";
import { config } from "../config.js";
import { isCopycat, isSlop } from "../engine/filters.js";
import { cooldowns, audit, market, recorder, type Setup } from "../db.js";
import { isCreativePair } from "../data/universe.js";

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

/**
 * Cheap rug guard, run BEFORE any candle fetch or pattern check. A coin that fails here never
 * appears on the hot list and never costs us a GeckoTerminal call.
 *   copycat ticker / brand clone, missing mcap or liquidity, RugCheck (mint/freeze authority, rugged,
 *   danger flags, transfer fee, LP lock, creator history, creator balance, insiders, top-10),
 *   slop (cheap domain, social-as-website, thin holders at size), fresh-coin rules (< 2h old needs
 *   150+ holders and top-10 under 35%), honeypot smell (20+ buys and zero sells in 5m).
 */
export async function prefilter(s: TokenSnapshot, mode: Signal["mode"]): Promise<Gate> {
  const pinned = config.pinned.includes(s.mint);
  const cc = pinned ? null : isCopycat(s);
  if (cc) return { ok: false, why: `rejected: copycat ${cc}` };
  if (!pinned && (!s.mcapUsd || s.mcapUsd <= 0)) return { ok: false, why: "rejected: no market cap reported" };
  if (!s.onCurve && s.liquidityUsd <= 0) return { ok: false, why: "rejected: no liquidity reported" };
  if (cooldowns.active(mode, s.mint)) return { ok: false, why: "cooldown after a recent stop-out" };
  const safe = await rug.safety(s.mint, s.onCurve);
  if (!safe.ok) return { ok: false, why: `rejected: ${safe.reasons.join(", ")}` };
  const slop = pinned ? null : isSlop(s, safe.holders);
  if (slop) return { ok: false, why: `rejected: slop, ${slop}` };
  const ageH = (Date.now() - s.createdAt) / 3_600_000;
  if (!pinned && ageH < 2) {
    if ((safe.holders ?? 0) < 150) return { ok: false, why: `rejected: ${ageH.toFixed(1)}h old with only ${safe.holders ?? "?"} holders` };
    if ((safe.top10Pct ?? 0) > 35) return { ok: false, why: `rejected: fresh coin, top 10 hold ${safe.top10Pct!.toFixed(0)}%` };
  }
  if (s.buys5m >= 20 && s.sells5m === 0) return { ok: false, why: "rejected: buys but no sells in 5m, possible honeypot" };
  // Vertical launches: a coin that went 5x in an hour (or 20x in six) while still under 6h old is a pump, not a setup,
  // unless it has already spread to a real holder base.
  if (!pinned && ageH < 6 && (s.change1h > 500 || s.change6h > 2000)) {
    const wide = (safe.holders ?? 0) >= 1000 && (safe.top10Pct ?? 100) < 25;
    if (!wide) return { ok: false, why: `rejected: vertical launch, +${Math.round(Math.max(s.change1h, s.change6h))}% at ${ageH.toFixed(1)}h old` };
  }
  return { ok: true, holders: safe.holders, top10: safe.top10Pct };
}

/** Shared pre-entry gate: copycat, safety, slop, exit liquidity, test sell. */
export async function gate(s: TokenSnapshot, mode: Signal["mode"], sizeUsd: number): Promise<Gate> {
  const pre = await prefilter(s, mode);
  if (!pre.ok) return pre;
  if (!s.onCurve) {
    const qty = sizeUsd / s.priceUsd;
    const ts = await jup.testSell(s.mint, qty);
    if (!ts.routable) return { ok: false, why: "no sell route" };
    if (ts.impactPct > config.fees.exitImpactWarnPct) return { ok: false, why: `exit impact ${(ts.impactPct * 100).toFixed(1)}%` };
  }
  return { ok: true, holders: pre.holders, top10: pre.top10 };
}

/** Creative pair (paired with something other than SOL/USDC/USDT): +8 in every mode. */
export function pairScore(s: TokenSnapshot): number { return isCreativePair(s) ? 8 : 0; }

/** Holder growth over the last 10 minutes as a fraction, or null if unknown. */
export function holderVelocity(mint: string): number | null {
  try { return recorder.holderVelocity(mint, 10 * 60_000); } catch { return null; }
}

/** Score points for holder growth: +20 at >=25%/10m, +10 at >=10%, -10 if shrinking >5%. */
export function holderScore(mint: string): number {
  const v = holderVelocity(mint);
  if (v == null) return 0;
  if (v >= 0.25) return 20;
  if (v >= 0.10) return 10;
  if (v <= -0.05) return -10;
  return 0;
}

function velocityLabel(mint: string): string[] {
  const v = holderVelocity(mint);
  if (v == null || Math.abs(v) < 0.03) return [];
  return [`holders ${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}% / 10m`];
}

export function logSignal(sig: Signal, taken: boolean, why: string) {
  audit.signal(sig.mode, sig.mint, sig.symbol, sig.score, taken, why, sig.snapshot.priceUsd, sig.snapshot.mcapUsd, sig.snapshot.liquidityUsd);
  const labels: string[] = [...velocityLabel(sig.mint)];
  if (sig.meta?.wallets && (sig.meta.wallets as string[]).length) labels.push(`${(sig.meta.wallets as string[]).join(" + ")} bought`);
  else if (sig.meta?.walletCount) labels.push(`${sig.meta.walletCount} trusted bought`);
  market.upsert(sig.snapshot, sig.meta?.holders as number | undefined, labels);
}

/** Record a look that never became a signal (filtered before scoring). Shows up in "looked at but did not buy". */
const lastLook = new Map<string, number>();
export function logLook(mode: Signal["mode"], s: TokenSnapshot, why: string, holders?: number, setup?: Setup) {
  const k = `${mode}:${s.mint}`;
  const gap = setup ? 10 * 60_000 : 60 * 60_000;   // setups refresh every 10 min so the distance bar moves; rejections hourly
  if (Date.now() - (lastLook.get(k) ?? 0) < gap) return;
  lastLook.set(k, Date.now());
  audit.signal(mode, s.mint, s.symbol, 0, false, why, s.priceUsd, s.mcapUsd, s.liquidityUsd, setup);
  market.upsert(s, holders, velocityLabel(s.mint));
}

/** Distance helper: how far price must move to reach `level`, as a positive fraction. */
export function dist(price: number, level: number): number { return Math.abs(level - price) / price; }

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

/** How many of the last n closed 5m candles have held above `low`, counting back from the most recent. */
export function heldCount(c5: Candle[], low: number, tol = 0.05): number {
  let n = 0;
  for (let i = c5.length - 2; i >= 0 && n < 10; i--) { if (c5[i].l >= low * (1 - tol)) n++; else break; }
  return n;
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
