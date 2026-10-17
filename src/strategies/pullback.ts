import { config } from "../config.js";
import { allCandidates } from "../data/universe.js";
import { log } from "../log.js";
import type { Signal, TokenSnapshot } from "../types.js";
import { ageHours } from "../engine/filters.js";
import { structuralStop } from "../engine/exits.js";
import { atr, highestHigh, lowestLow } from "../data/gecko.js";
import { baseHolds, buySellRatio, candles5and15, dex, gate, logLook, holderScore, holderVelocity, logSignal, reclaim, type Context, type Strategy } from "./base.js";

const C = config.modes.pullback;

/**
 * PULLBACK: the coins v1 hard-skipped for "already 3x in an hour" (KURP +2333%, Irene, OPTIMA).
 * Instead of skipping, watch them. Enter on the first retrace that holds and gets bought back.
 *
 * Qualify: up >= 2x in the hour, liquid, holders growing.
 * Wait for: 20-40% retrace from the 1h high; low holds 3 closed 5m candles; green 5m reclaim on volume.
 * Stop: under the retrace low minus 1 ATR, on closes. Hard floor -45%.
 * Targets: 33% at +60%, trail 25% after +40%, ratcheting.
 */
export const pullback: Strategy = {
  name: "pullback",
  everyMs: C.scanEveryMs,
  async scan(ctx: Context): Promise<Signal[]> {
    const out: Signal[] = [];
    const mints = await allCandidates();
    const snaps = await dex.snapshots(mints.slice(0, 90));
    // Candles are the scarce resource (GeckoTerminal 30/min per IP). Check the most active coins first, cap per scan.
    const ranked = [...snaps.values()].sort((a, b) => (b.volume1h || 0) - (a.volume1h || 0)).slice(0, 15);
    for (const s of ranked) {
      try {
        const sig = await check(s, ctx);
        if (sig) out.push(sig);
      } catch (e) { log.debug({ sym: s.symbol, err: String(e) }, "pullback check failed"); }
    }
    return out;
  },
};

async function check(s: TokenSnapshot, ctx: Context): Promise<Signal | null> {
  if (s.change1h / 100 + 1 < C.minHourGainX && s.change6h / 100 + 1 < C.minHourGainX) return null;
  if (ageHours(s, ctx.now) > C.maxAgeH) return null;
  if (s.liquidityUsd < C.minLiquidity || !s.pairAddress) return null;

  const { c5, c15 } = await candles5and15(s.pairAddress);
  if (c5.length < 20) return null;
  const hour = ctx.now - 3_600_000;
  const hi = highestHigh(c5, hour * 1 - 2 * 3_600_000);
  const lo = lowestLow(c5.slice(-12), ctx.now - 60 * 60_000);
  const retrace = 1 - lo / hi;
  if (retrace < C.retraceMin) { logLook("pullback", s, `watching: only ${(retrace * 100).toFixed(0)}% off the high, waiting for a 20-40% retrace`); return null; }
  if (retrace > C.retraceMax) { logLook("pullback", s, `retraced ${(retrace * 100).toFixed(0)}%, too deep, likely dead`); return null; }
  if (!baseHolds(c5, lo, C.holdCandles5m)) { logLook("pullback", s, "retrace low not held for 3 candles yet"); return null; }
  if (!reclaim(c5, lo * 1.03, C.reclaimVolX)) { logLook("pullback", s, "base holding, waiting for a green reclaim on volume"); return null; }
  if (s.priceUsd > lo * C.maxAboveLowX) { logLook("pullback", s, "reclaim already ran >25% off the low, chasing"); return null; }
  if (buySellRatio(s) < 1.0) { logLook("pullback", s, "more sells than buys in 5m"); return null; }

  const g = await gate(s, "pullback", C.sizeUsd);
  if ((g.holders ?? 0) < C.minHolders) return null;
  const a15 = atr(c15);
  const hv = holderVelocity(s.mint);
  if (hv != null && hv <= -0.10) { logLook("pullback", s, `holders shrinking ${(hv * 100).toFixed(0)}% in 10m`); return null; }
  const score = 60 + Math.min(20, retrace * 50) + (buySellRatio(s) > 1.3 ? 10 : 0) + (s.liquidityUsd > 50_000 ? 10 : 0) + holderScore(s.mint);

  const sig: Signal = {
    mode: "pullback", mint: s.mint, symbol: s.symbol, sizeUsd: C.sizeUsd, score,
    reason: `pullback ${(retrace * 100).toFixed(0)}% from 1h high, reclaim on vol`,
    snapshot: s, candles15: c15,
    meta: { atr15: a15, retraceLow: lo, hiRef: hi, holders: g.holders },
    plan: (entry, atr15) => ({
      hardFloorPct: 0.45,
      closeStopPrice: structuralStop(entry, lo, atr15, 1, 0.35),
      takeProfits: [{ gain: 0.6, sell: 0.33 }],
      trailPct: 0.25, trailAfterGain: 0.40,
      trailLadder: [{ peakGain: 1.0, trailPct: 0.30 }, { peakGain: 3.0, trailPct: 0.40 }],
      maxHoldMs: 12 * 3_600_000,
    }),
  };
  if (!g.ok) { logSignal(sig, false, g.why!); return null; }
  return sig;
}
