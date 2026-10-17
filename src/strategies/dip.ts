import { config } from "../config.js";
import { log } from "../log.js";
import type { Signal, TokenSnapshot } from "../types.js";
import { structuralStop } from "../engine/exits.js";
import { atr, highestHigh, lowestLow } from "../data/gecko.js";
import { allCandidates, isPinned, isQuality, isStonkPair } from "../data/universe.js";
import { buySellRatio, candles5and15, dex, gate, dist, logLook, holderScore, pairScore, sniperPenalty, walletScore, holderVelocity, logSignal, prefilter, reclaim, type Context, type Strategy } from "./base.js";

const C = config.modes.dip;

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
    const mints = await allCandidates();
    const snaps = await dex.snapshots(mints.slice(0, 120));
    // Candles are the scarce resource (GeckoTerminal 30/min per IP). Check the most active coins first, cap per scan.
    const ranked = [...snaps.values()].sort((a, b) => (b.volume1h || 0) - (a.volume1h || 0)).slice(0, 20);
    for (const s of ranked) {
      try {
        const sig = await check(s, ctx);
        if (sig) out.push(sig);
      } catch (e) { log.debug({ sym: s.symbol, err: String(e) }, "dip check failed"); }
    }
    return out;
  },
};

async function check(s: TokenSnapshot, ctx: Context): Promise<Signal | null> {
  if (!isPinned(s.mint) && !isStonkPair(s) && !isQuality(s)) return null;
  const pre = await prefilter(s, "dip");
  if (!pre.ok) { logLook("dip", s, pre.why!, pre.holders); return null; }
  if (!s.pairAddress) return null;
  if (s.change24h > C.overheated24h) { logLook("dip", s, `up ${s.change24h.toFixed(0)}% in 24h, overheated`); return null; }

  const { c5, c15 } = await candles5and15(s.pairAddress);
  if (c5.length < 24) return null;
  const hi = highestHigh(c5, ctx.now - 24 * 3_600_000);
  const lo = lowestLow(c5.slice(-36), ctx.now - 3 * 3_600_000);
  const depth = 1 - s.priceUsd / hi;
  if (depth < C.dipMin) { logLook("dip", s, `only ${(depth * 100).toFixed(1)}% off the 24h high`, undefined, { need: `dip to ${(hi * (1 - C.dipMin)).toPrecision(3)} (6% off the 24h high)`, level: hi * (1 - C.dipMin), distance: dist(s.priceUsd, hi * (1 - C.dipMin)) }); return null; }
  if (depth > C.dipMax) { logLook("dip", s, `${(depth * 100).toFixed(0)}% off the 24h high, more than a dip`); return null; }
  // The last closed 5m candle must not be a new low: the dip has to have stopped.
  const last = c5.at(-2)!;
  if (last.l <= lo * 1.001 && last.c < last.o) { logLook("dip", s, "still making new lows"); return null; }
  if (!reclaim(c5, lo * 1.01, 1.0)) { logLook("dip", s, "dip found, waiting for a green 5m reclaim", undefined, { need: `green 5m close above ${(lo * 1.01).toPrecision(3)}`, level: lo * 1.01, distance: dist(s.priceUsd, lo * 1.01) }); return null; }
  const bs = buySellRatio(s);
  if (bs < 1.0) { logLook("dip", s, "more sells than buys in 5m"); return null; }

  const g = await gate(s, "dip", C.sizeUsd);
  const a15 = atr(c15);
  const dayLow = lowestLow(c15, ctx.now - 24 * 3_600_000);
  let score = 40 + Math.min(30, depth * 100 * 1.5) + (bs > 1.3 ? 10 : 5);
  if (isPinned(s.mint)) score += 10;
  score += pairScore(s) + walletScore(s.mint) + sniperPenalty(g);
  if (s.liquidityUsd >= 500_000) score += 5;
  score += holderScore(s.mint);
  if (score < C.minScore) { logLook("dip", s, `score ${score.toFixed(0)} below ${C.minScore}`); return null; }

  const sig: Signal = {
    mode: "dip", mint: s.mint, symbol: s.symbol, sizeUsd: C.sizeUsd, score,
    reason: `dip ${(depth * 100).toFixed(1)}% off 24h high${isStonkPair(s) ? `, ${s.quoteSymbol} pair` : ""}${isPinned(s.mint) ? ", pinned" : ""}`,
    snapshot: s, candles15: c15,
    meta: { atr15: a15, dipLow: lo, dayLow, holders: g.holders },
    plan: (entry, atr15) => ({
      hardFloorPct: 0.40,
      closeStopPrice: structuralStop(entry, Math.min(lo, dayLow), atr15, 1, 0.25),
      takeProfits: [{ gain: 0.40, sell: 0.33 }],
      trailPct: 0.20, trailAfterGain: 0.20,
      trailLadder: [{ peakGain: 0.60, trailPct: 0.25 }],
      maxHoldMs: 0,
    }),
  };
  if (!g.ok) { logSignal(sig, false, g.why!); return null; }
  return sig;
}
