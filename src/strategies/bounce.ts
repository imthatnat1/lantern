import { config, type ModeCfg } from "../config.js";
import { log } from "../log.js";
import type { Candle, ExitPlan, Signal, TokenSnapshot } from "../types.js";
import { structuralStop } from "../engine/exits.js";
import { atr, highestHigh, lowestLow } from "../data/gecko.js";
import { baseHolds, buySellRatio, candles5and15, dex, dist, gate, heldCount, logLook, holderScore, pairScore, sniperPenalty, walletScore, holderVelocity, logSignal, prefilter, reclaim, type Context, type Mkt, type Pattern, type Strategy } from "./base.js";

const C: ModeCfg<"bounce"> = config.modes.bounce;

/**
 * BOUNCE: post-migration dip that holds and gets bought back. Same shape as v1 §3.7,
 * with a close-based structural stop instead of a tick stop.
 */
export const bounce: Strategy = {
  name: "bounce",
  everyMs: C.scanEveryMs,
  async scan(ctx: Context): Promise<Signal[]> {
    const out: Signal[] = [];
    const recent = [...ctx.migrations.entries()]
      .filter(([, at]) => ctx.now - at < C.maxSinceMigrationH * 3_600_000)
      .map(([m]) => m);
    if (!recent.length) return out;
    const snaps = await dex.snapshots(recent);
    for (const s of snaps.values()) {
      try {
        const sig = await check(s, ctx, ctx.migrations.get(s.mint)!);
        if (sig) out.push(sig);
      } catch (e) { log.debug({ sym: s.symbol, err: String(e) }, "bounce check failed"); }
    }
    return out;
  },
};

/** The candle setup: 35-70% off the post-migration high, base holds, green reclaim on 1.5x volume. */
export function bouncePattern(m: Mkt, c5: Candle[], migratedAt: number, C: ModeCfg<"bounce">): Pattern<{ base: number; dd: number; lo: number; plan: (entry: number, atr15: number) => ExitPlan }> {
  if (m.liquidityUsd < C.minLiquidity) return { ok: false, why: `too thin, $${Math.round(m.liquidityUsd / 1000)}k liquidity` };
  if (c5.length < 8) return { ok: false, why: `${c5.length * 5} minutes of trading since migration, needs 40 to read a dip` };
  const hi = highestHigh(c5, migratedAt);
  const lo = lowestLow(c5, migratedAt);
  const dd = 1 - lo / hi;
  if (dd > C.deadBelow) return { ok: false, why: `down ${(dd * 100).toFixed(0)}% since migration, treated as dead` };
  if (dd < C.drawdownMin) return { ok: false, why: `only ${(dd * 100).toFixed(0)}% off the post-migration high, no dip yet` };
  if (dd > C.drawdownMax) return { ok: false, why: `down ${(dd * 100).toFixed(0)}%, deeper than the 70% limit` };
  if (!baseHolds(c5, lo, C.baseHoldCandles5m)) return { ok: false, why: "low not held for 3 candles yet", setup: { need: `hold above ${lo.toPrecision(3)} for 3 closed 5m candles`, level: lo, distance: dist(m.priceUsd, lo), progress: { done: heldCount(c5, lo), of: C.baseHoldCandles5m } } };
  if (!reclaim(c5, lo * 1.03, C.reclaimVolX)) return { ok: false, why: "base holding, waiting for a green reclaim on 1.5x volume", setup: { need: `green 5m close above ${(lo * 1.03).toPrecision(3)} on 1.5x volume`, level: lo * 1.03, distance: dist(m.priceUsd, lo * 1.03) } };
  if (buySellRatio(m) < 1.0) return { ok: false, why: "more sells than buys in 5m" };
  if (m.priceUsd > lo * C.maxAboveLowX) return { ok: false, why: "already 1.6x off the low, chasing" };
  const base = 55 + Math.min(25, dd * 40) + (buySellRatio(m) > 1.5 ? 10 : 0);
  return {
    ok: true, base, dd, lo,
    plan: (entry, atr15) => ({
      hardFloorPct: 0.45,
      closeStopPrice: structuralStop(entry, lo, atr15, 0.5, 0.25),
      takeProfits: [{ gain: 0.45, sell: 0.5 }],
      trailPct: 0.20, trailAfterGain: 0.30,
      maxHoldMs: 12 * 3_600_000,
    }),
  };
}

/**
 * The market cap floor. $45k for everyone; from $25k for a coin with a real crowd (1,000+ holders, $25k+ liquidity),
 * which then enters at half size. `holders` undefined = not known yet: pass on liquidity alone and check again later.
 * Shared by the live scan and the lab.
 */
export function bounceFloor(mcap: number, liquidity: number, holders: number | undefined, C: ModeCfg<"bounce">): { why: string | null; crowd: boolean } {
  if (mcap >= C.mcapMin) return { why: null, crowd: false };
  const k = (n: number) => `$${Math.round(n / 1000)}k`;
  const floor = C.crowdMcapMin ?? C.mcapMin;
  if (mcap < floor) return { why: `rejected: ${k(mcap)} market cap, under the ${k(floor)} bounce floor`, crowd: false };
  if (liquidity < (C.crowdLiquidity ?? 0)) return { why: `rejected: ${k(mcap)} market cap with ${k(liquidity)} liquidity, under the ${k(C.mcapMin)} bounce floor without a ${k(C.crowdLiquidity)} pool`, crowd: false };
  if (holders !== undefined && holders < (C.crowdHolders ?? 0)) return { why: `rejected: ${k(mcap)} market cap with ${holders} holders, under the ${k(C.mcapMin)} bounce floor without ${C.crowdHolders.toLocaleString("en-US")} holders`, crowd: false };
  return { why: null, crowd: true };
}

async function check(s: TokenSnapshot, ctx: Context, migratedAt: number): Promise<Signal | null> {
  // Checked before the safety calls, so coins under the floor cost nothing and never reach the hot list.
  const early = bounceFloor(s.mcapUsd, s.liquidityUsd, undefined, C);
  if (early.why) { logLook("bounce", s, early.why); return null; }
  const pre = await prefilter(s, "bounce");
  if (!pre.ok) { logLook("bounce", s, pre.why!, pre.holders); return null; }
  const floor = bounceFloor(s.mcapUsd, s.liquidityUsd, pre.holders ?? 0, C);
  if (floor.why) { logLook("bounce", s, floor.why, pre.holders); return null; }
  const size = floor.crowd ? C.crowdSizeUsd : C.sizeUsd;
  if (s.liquidityUsd < C.minLiquidity || !s.pairAddress) { logLook("bounce", s, s.pairAddress ? `too thin, $${Math.round(s.liquidityUsd / 1000)}k liquidity (needs $${C.minLiquidity / 1000}k)` : "too thin, no pool yet"); return null; }
  const { c5, c15 } = await candles5and15(s.pairAddress);
  const p = bouncePattern(s, c5, migratedAt, C);
  if (!p.ok) { if (p.why) logLook("bounce", s, p.why, undefined, p.setup); return null; }

  const g = await gate(s, "bounce", size);
  if ((g.holders ?? 0) < C.minHolders) return null;
  const a15 = atr(c15);
  const hv = holderVelocity(s.mint);
  if (hv != null && hv <= -0.10) { logLook("bounce", s, `holders shrinking ${(hv * 100).toFixed(0)}% in 10m`); return null; }
  const score = p.base + ((g.holders ?? 0) > 200 ? 10 : 0) + holderScore(s.mint) + pairScore(s) + walletScore(s.mint) + sniperPenalty(g);

  const sig: Signal = {
    mode: "bounce", mint: s.mint, symbol: s.symbol, sizeUsd: size, score,
    reason: `bounce from -${(p.dd * 100).toFixed(0)}% post-migration${floor.crowd ? `, early ($${Math.round(s.mcapUsd / 1000)}k, ${pre.holders} holders, half size)` : ""}`,
    snapshot: s, candles15: c15,
    meta: { atr15: a15, baseLow: p.lo, migratedAt, holders: g.holders },
    plan: p.plan,
  };
  if (!g.ok) { logSignal(sig, false, g.why!); return null; }
  return sig;
}
