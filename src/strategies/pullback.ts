import { config, type ModeCfg } from "../config.js";
import { allCandidates } from "../data/universe.js";
import { log } from "../log.js";
import type { Candle, ExitPlan, Signal, TokenSnapshot } from "../types.js";
import { ageHours } from "../engine/filters.js";
import { structuralStop } from "../engine/exits.js";
import { atr, highestHigh, lowestLow } from "../data/gecko.js";
import { scored, baseHolds, buySellRatio, candles5and15, dex, dist, gate, heldCount, logLook, holderScore, pairScore, sniperPenalty, walletScore, holderVelocity, logSignal, prefilter, reclaim, type Context, type Mkt, type Pattern, type Strategy } from "./base.js";

const C: ModeCfg<"pullback"> = config.modes.pullback;

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

/** Qualifies before any I/O: a real 2x move, young enough. */
export function pullbackQualifies(m: Mkt, ageH: number, C: ModeCfg<"pullback">): boolean {
  if (m.change1h / 100 + 1 < C.minHourGainX && m.change6h / 100 + 1 < C.minHourGainX) return false;
  return ageH <= C.maxAgeH;
}

/** The candle setup: 20-40% retrace from the high, base holds, green reclaim on volume, not chasing. */
export function pullbackPattern(m: Mkt, c5: Candle[], now: number, C: ModeCfg<"pullback">): Pattern<{ base: number; retrace: number; lo: number; hi: number; plan: (entry: number, atr15: number) => ExitPlan }> {
  if (m.liquidityUsd < C.minLiquidity) return { ok: false };
  if (c5.length < 20) return { ok: false };
  const hour = now - 3_600_000;
  const hi = highestHigh(c5, hour * 1 - 2 * 3_600_000);
  const lo = lowestLow(c5.slice(-12), now - 60 * 60_000);
  const retrace = 1 - lo / hi;
  if (retrace < C.retraceMin) return { ok: false, why: `watching: only ${(retrace * 100).toFixed(0)}% off the high, waiting for a 20-40% retrace`, setup: { need: `pull back to ${(hi * (1 - C.retraceMin)).toPrecision(3)} (20% off the 1h high)`, level: hi * (1 - C.retraceMin), distance: dist(m.priceUsd, hi * (1 - C.retraceMin)) } };
  if (retrace > C.retraceMax) return { ok: false, why: `retraced ${(retrace * 100).toFixed(0)}%, too deep, likely dead` };
  if (!baseHolds(c5, lo, C.holdCandles5m)) return { ok: false, why: "retrace low not held for 3 candles yet", setup: { need: `hold above ${lo.toPrecision(3)} for 3 closed 5m candles`, level: lo, distance: dist(m.priceUsd, lo), progress: { done: heldCount(c5, lo), of: C.holdCandles5m } } };
  if (!reclaim(c5, lo * 1.03, C.reclaimVolX)) return { ok: false, why: "base holding, waiting for a green reclaim on volume", setup: { need: `green 5m close above ${(lo * 1.03).toPrecision(3)} on 1.3x volume`, level: lo * 1.03, distance: dist(m.priceUsd, lo * 1.03) } };
  if (m.priceUsd > lo * C.maxAboveLowX) return { ok: false, why: "reclaim already ran >25% off the low, chasing" };
  if (buySellRatio(m) < 1.0) return { ok: false, why: "more sells than buys in 5m" };
  const base = 60 + Math.min(20, retrace * 50) + (buySellRatio(m) > 1.3 ? 10 : 0) + (m.liquidityUsd > 50_000 ? 10 : 0);
  return {
    ok: true, base, retrace, lo, hi,
    plan: (entry, atr15) => ({
      hardFloorPct: 0.45,
      closeStopPrice: structuralStop(entry, lo, atr15, 1, 0.35),
      takeProfits: [{ gain: 0.6, sell: 0.33 }],
      trailPct: 0.25, trailAfterGain: 0.40,
      trailLadder: [{ peakGain: 1.0, trailPct: 0.30 }, { peakGain: 3.0, trailPct: 0.40 }],
      maxHoldMs: 12 * 3_600_000,
    }),
  };
}

async function check(s: TokenSnapshot, ctx: Context): Promise<Signal | null> {
  if (!pullbackQualifies(s, ageHours(s, ctx.now), C)) return null;
  const pre = await prefilter(s, "pullback");
  if (!pre.ok) { logLook("pullback", s, pre.why!, pre.holders); return null; }
  if (s.liquidityUsd < C.minLiquidity || !s.pairAddress) return null;

  const { c5, c15 } = await candles5and15(s.pairAddress);
  const p = pullbackPattern(s, c5, ctx.now, C);
  if (!p.ok) { if (p.why) logLook("pullback", s, p.why, undefined, p.setup); return null; }

  const g = await gate(s, "pullback", C.sizeUsd);
  if ((g.holders ?? 0) < C.minHolders) return null;
  const a15 = atr(c15);
  const hv = holderVelocity(s.mint);
  if (hv != null && hv <= -0.10) { logLook("pullback", s, `holders shrinking ${(hv * 100).toFixed(0)}% in 10m`); return null; }
  const { score, scoreParts } = scored({ setup: p.base, "holder growth": holderScore(s.mint), "creative pair": pairScore(s), wallets: walletScore(s.mint), snipers: sniperPenalty(g) });

  const sig: Signal = {
    mode: "pullback", mint: s.mint, symbol: s.symbol, sizeUsd: C.sizeUsd, score,
    reason: `pullback ${(p.retrace * 100).toFixed(0)}% from 1h high, reclaim on vol`,
    snapshot: s, candles15: c15,
    meta: { atr15: a15, retraceLow: p.lo, hiRef: p.hi, holders: g.holders, scoreParts },
    plan: p.plan,
  };
  if (!g.ok) { logSignal(sig, false, g.why!); return null; }
  return sig;
}
