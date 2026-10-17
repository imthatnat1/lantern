import { config } from "../config.js";
import { log } from "../log.js";
import type { Signal, TokenSnapshot } from "../types.js";
import { structuralStop } from "../engine/exits.js";
import { atr, highestHigh, lowestLow } from "../data/gecko.js";
import { baseHolds, buySellRatio, candles5and15, dex, gate, logSignal, reclaim, type Context, type Strategy } from "./base.js";

const C = config.modes.bounce;

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

async function check(s: TokenSnapshot, ctx: Context, migratedAt: number): Promise<Signal | null> {
  if (s.liquidityUsd < C.minLiquidity || !s.pairAddress) return null;
  const { c5, c15 } = await candles5and15(s.pairAddress);
  if (c5.length < 8) return null;
  const hi = highestHigh(c5, migratedAt);
  const lo = lowestLow(c5, migratedAt);
  const dd = 1 - lo / hi;
  if (dd > C.deadBelow) return null;
  if (dd < C.drawdownMin || dd > C.drawdownMax) return null;
  if (!baseHolds(c5, lo, C.baseHoldCandles5m)) return null;
  if (!reclaim(c5, lo * 1.03, C.reclaimVolX)) return null;
  if (buySellRatio(s) < 1.0) return null;
  if (s.priceUsd > lo * C.maxAboveLowX) return null;

  const g = await gate(s, "bounce", C.sizeUsd);
  if ((g.holders ?? 0) < C.minHolders) return null;
  const a15 = atr(c15);
  const score = 55 + Math.min(25, dd * 40) + (buySellRatio(s) > 1.5 ? 10 : 0) + ((g.holders ?? 0) > 200 ? 10 : 0);

  const sig: Signal = {
    mode: "bounce", mint: s.mint, symbol: s.symbol, sizeUsd: C.sizeUsd, score,
    reason: `bounce from -${(dd * 100).toFixed(0)}% post-migration`,
    snapshot: s, candles15: c15,
    meta: { atr15: a15, baseLow: lo, migratedAt, holders: g.holders },
    plan: (entry, atr15) => ({
      hardFloorPct: 0.45,
      closeStopPrice: structuralStop(entry, lo, atr15, 0.5, 0.25),
      takeProfits: [{ gain: 0.45, sell: 0.5 }],
      trailPct: 0.20, trailAfterGain: 0.30,
      maxHoldMs: 12 * 3_600_000,
    }),
  };
  if (!g.ok) { logSignal(sig, false, g.why!); return null; }
  return sig;
}
