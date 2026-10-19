import { config, type ModeCfg } from "../config.js";
import { log } from "../log.js";
import type { Candle, ExitPlan, Signal, TokenSnapshot } from "../types.js";
import { structuralStop } from "../engine/exits.js";
import { atr, highestHigh, lowestLow, rollUp } from "../data/gecko.js";
import { allCandidates, flagshipMints, isFlagship, isPinned, isQuality, isStonkPair } from "../data/universe.js";
import { watchedMints, watchedFirst, buySellRatio, candles5and15, dex, gate, dist, logLook, holderScore, pairScore, sniperPenalty, walletScore, holderVelocity, logSignal, prefilter, reclaim, type Context, type Mkt, type Pattern, type Strategy } from "./base.js";

const C: ModeCfg<"dip"> = config.modes.dip;

/**
 * DIP: what Core and Swing were for in v1, on the coins they were good at finding
 * (pinned quality coins, the Stonk.fun ZEC/HYPE/xStock pairs, established trenders).
 *
 * Entry: 6-30% off the 24h high, the dip low has stopped making new lows, and a green
 * 5m candle has reclaimed it with buys > sells. Overheated coins (+150% in 24h) are skipped.
 *
 * Exit: close-based stop under the 24h low minus 1 ATR, capped at -25% (v1 Swing's 15%
 * tick stop was the single biggest leak: 20 closes, 4 wins). TP 33% at +40%, 20% trail after +20%.
 */
export const dip: Strategy = {
  name: "dip",
  everyMs: C.scanEveryMs,
  async scan(ctx: Context): Promise<Signal[]> {
    const out: Signal[] = [];
    const watched = watchedMints("dip", ctx.now);
    const mints = [...new Set([...watched, ...flagshipMints(), ...await allCandidates()])];
    const snaps = await dex.snapshots(mints.slice(0, 120));
    // Candles are the scarce resource (GeckoTerminal 30/min per IP). Check the most active coins first, cap per scan.
    // Only coins dip is allowed to trade compete for the slots (pinned first), so junk doesn't crowd out ZCAT/PURR/the creative pairs.
    // Paused, dip is the flagship dip watch: fewer slots, flagships first (pinned + Stonk.fun's biggest coins).
    // Its would-buys are logged and tracked, never bought (main.ts).
    const paused = config.pausedModes.includes("dip");
    const turnOnly = C.trigger === "turn" && C.flagshipsOnly;
    const ranked = watchedFirst(watched, [...snaps.values()].filter(s => turnOnly ? isFlagship(s.mint) || isPinned(s.mint) : isFlagship(s.mint) || isStonkPair(s) || isQuality(s)), paused ? 12 : 20,
      (a, b) => (Number(isFlagship(b.mint)) - Number(isFlagship(a.mint))) || (Number(isPinned(b.mint)) - Number(isPinned(a.mint))) || (b.volume1h || 0) - (a.volume1h || 0), "dip");
    for (const s of ranked) {
      try {
        const sig = await check(s, ctx);
        if (sig) out.push(sig);
      } catch (e) { log.debug({ sym: s.symbol, err: String(e) }, "dip check failed"); logLook("dip", s, `couldn't check: ${String(e).replace(/^Error:\s*/, "").slice(0, 70)}`); }
    }
    return out;
  },
};

/** The candle setup: 6-30% off the 24h high, the dip has stopped, green 5m reclaim, buys >= sells. */
export function dipPattern(m: Mkt, c5: Candle[], now: number, C: ModeCfg<"dip">): Pattern<{ base: number; depth: number; lo: number; bs: number }> {
  if (m.change24h > C.overheated24h) return { ok: false, why: `up ${m.change24h.toFixed(0)}% in 24h, overheated` };
  if (C.trigger === "turn") return turnPattern(m, c5, now, C);
  if (c5.length < 24) return { ok: false };
  if (m.change1h < C.maxDrop1h) return { ok: false, why: `down ${Math.abs(m.change1h).toFixed(0)}% in the hour, falling knife` };
  const hi = highestHigh(c5, now - 24 * 3_600_000);
  const lo = lowestLow(c5.slice(-36), now - 3 * 3_600_000);
  const depth = 1 - m.priceUsd / hi;
  if (depth < C.dipMin) return { ok: false, why: `only ${(depth * 100).toFixed(1)}% off the 24h high`, setup: { need: `dip to ${(hi * (1 - C.dipMin)).toPrecision(3)} (6% off the 24h high)`, level: hi * (1 - C.dipMin), distance: dist(m.priceUsd, hi * (1 - C.dipMin)) } };
  if (depth > C.dipMax) return { ok: false, why: `${(depth * 100).toFixed(0)}% off the 24h high, more than a dip` };
  // The last closed 5m candle must not be a new low: the dip has to have stopped.
  const last = c5.at(-2)!;
  if (last.l <= lo * 1.001 && last.c < last.o) return { ok: false, why: "still making new lows" };
  const lvl = lo * C.reclaimAboveLow;
  if (!reclaim(c5, lvl, C.reclaimVolX)) return { ok: false, why: "dip found, waiting for a green 5m reclaim", setup: { need: `green 5m close above ${lvl.toPrecision(3)}`, level: lvl, distance: dist(m.priceUsd, lvl) } };
  const bs = buySellRatio(m);
  if (bs < 1.0) return { ok: false, why: "more sells than buys in 5m" };
  const base = 40 + Math.min(30, depth * 100 * 1.5) + (bs > 1.3 ? 10 : 5) + (m.liquidityUsd >= 500_000 ? 5 : 0);
  return { ok: true, base, depth, lo, bs };
}

/**
 * The turn rule (19 Oct). On closed hourly candles from the last 12h: find the lowest low. Buy only when
 * - it's a real dip (6%+ off the high, not more than 70%),
 * - at least 2 hourly candles have closed since the low and none went back under it (a higher low),
 * - the last hourly close is above the last lower high (the nearest swing high before the low),
 * - and price isn't already 40%+ off the low.
 * It buys later than the old trigger, often 10-20% above the bottom; that's the price of not catching falling knives.
 */
export function turnPattern(m: Mkt, c5: Candle[], now: number, C: ModeCfg<"dip">): Pattern<{ base: number; depth: number; lo: number; bs: number }> {
  const h1 = rollUp(c5, 60).filter(k => k.t + 3_600_000 <= now).slice(-12);
  if (h1.length < 6) return { ok: false, why: `${h1.length}h of chart, the turn rule needs 6` };
  let iL = 0;
  for (let i = 1; i < h1.length; i++) if (h1[i].l < h1[iL].l) iL = i;
  const L = h1[iL].l;
  const hi = Math.max(highestHigh(c5, now - 24 * 3_600_000), ...h1.map(k => k.h));
  const depth = 1 - L / hi;
  if (depth < C.dipMin) return { ok: false, why: `only ${(depth * 100).toFixed(0)}% off the high, no dip to turn from` };
  if (depth > C.turnMaxDepth) return { ok: false, why: `down ${(depth * 100).toFixed(0)}% from the high, more than a dip` };
  if (iL > h1.length - 3) return { ok: false, why: "still making new lows on the hourly chart" };
  if (iL === 0) return { ok: false, why: "no lower high before the low to break yet" };
  // The last lower high: the nearest swing high (an hourly high above both neighbours) in the 6 hours before the low.
  // In a steady bleed there isn't one, so it's the high of the hour before the low.
  let lowerHigh = h1[iL - 1].h;
  for (let j = iL - 1; j >= Math.max(1, iL - 6); j--) if (h1[j].h > h1[j - 1].h && h1[j].h >= h1[j + 1].h) { lowerHigh = h1[j].h; break; }
  const higherLow = Math.min(...h1.slice(iL + 1).map(k => k.l));
  if (higherLow <= L * 1.01) return { ok: false, why: "back at the low, no higher low yet" };
  const last = h1.at(-1)!;
  if (last.c <= lowerHigh) return { ok: false, why: "higher low in, waiting for an hourly close above the last lower high", setup: { need: `hourly close above ${lowerHigh.toPrecision(3)}`, level: lowerHigh, distance: dist(m.priceUsd, lowerHigh) } };
  if (last.c > L * C.turnMaxAboveLow) return { ok: false, why: `already ${Math.round((last.c / L - 1) * 100)}% off the low, chasing` };
  const bs = buySellRatio(m);
  if (bs < 1.0) return { ok: false, why: "more sells than buys in 5m" };
  const base = 45 + Math.min(30, depth * 60) + (bs > 1.3 ? 10 : 5) + (m.liquidityUsd >= 500_000 ? 5 : 0);
  return { ok: true, base, depth, lo: higherLow, bs };
}

export function dipPlan(lo: number, dayLow: number): (entry: number, atr15: number) => ExitPlan {
  return (entry, atr15) => ({
    hardFloorPct: 0.40,
    closeStopPrice: structuralStop(entry, Math.min(lo, dayLow), atr15, 1, 0.25),
    takeProfits: [{ gain: 0.40, sell: 0.33 }],
    trailPct: 0.20, trailAfterGain: 0.20,
    trailLadder: [{ peakGain: 0.60, trailPct: 0.25 }],
    maxHoldMs: 0,
  });
}

async function check(s: TokenSnapshot, ctx: Context): Promise<Signal | null> {
  const pre = await prefilter(s, "dip");
  if (!pre.ok) { logLook("dip", s, pre.why!, pre.holders); return null; }
  if (!s.pairAddress) return null;
  if (s.change24h > C.overheated24h) { logLook("dip", s, `up ${s.change24h.toFixed(0)}% in 24h, overheated`); return null; }

  const { c5, c15 } = await candles5and15(s.pairAddress);
  const p = dipPattern(s, c5, ctx.now, C);
  if (!p.ok) { if (p.why) logLook("dip", s, p.why, undefined, p.setup); return null; }

  const g = await gate(s, "dip", C.sizeUsd);
  const a15 = atr(c15);
  const dayLow = lowestLow(c15, ctx.now - 24 * 3_600_000);
  let score = p.base;
  if (isPinned(s.mint)) score += 10;
  score += pairScore(s) + walletScore(s.mint) + sniperPenalty(g);
  score += holderScore(s.mint);
  if (score < C.minScore) { logLook("dip", s, `score ${score.toFixed(0)} below ${C.minScore}`); return null; }

  const sig: Signal = {
    mode: "dip", mint: s.mint, symbol: s.symbol, sizeUsd: C.sizeUsd, score,
    reason: `dip ${(p.depth * 100).toFixed(1)}% off 24h high${isStonkPair(s) ? `, ${s.quoteSymbol} pair` : ""}${isPinned(s.mint) ? ", pinned" : ""}`,
    snapshot: s, candles15: c15,
    meta: { atr15: a15, dipLow: p.lo, dayLow, holders: g.holders },
    plan: dipPlan(p.lo, dayLow),
  };
  if (!g.ok) { logSignal(sig, false, g.why!); return null; }
  return sig;
}
