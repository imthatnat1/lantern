import { config, type ModeCfg } from "../config.js";
import { log } from "../log.js";
import type { Candle, ExitPlan, Signal, TokenSnapshot } from "../types.js";
import { structuralStop } from "../engine/exits.js";
import { atr, lowestLow, vwap } from "../data/gecko.js";
import { allCandidates, isFlagship, isPinned, isStonkPair } from "../data/universe.js";
import { ride as rideDb } from "../db.js";
import { brisbaneDayStart } from "../engine/broker.js";
import { buySellRatio, candles5and15, dex, dist, gate, holderScore, walletScore, logLook, logSignal, prefilter, reclaim, type Context, type Mkt, type Pattern, type Strategy } from "./base.js";

const C: ModeCfg<"ride"> = config.modes.ride;

/**
 * RIDE: pick the one or two coins that have already proven they can run (24h volume >= $2M, liquidity
 * >= $100k, rising 1h structure) and work them all day instead of hunting strangers.
 *
 *   core   one position per leader, wide 35% close-based trail. Meant to sit through the whole move.
 *   sleeve repeated swing trades around the core: buy a pullback to the 1h VWAP or the last higher low
 *          on a green 5m reclaim, sell half at the prior high, trail the rest 12%. Up to 6 a day per coin,
 *          30 min after a win, 2h after a loss.
 *
 * A leader is dropped when it prints a 1h lower low or its volume fades under 0.3x average.
 */
export const ride: Strategy = {
  name: "ride",
  everyMs: C.scanEveryMs,
  async scan(ctx: Context): Promise<Signal[]> {
    const out: Signal[] = [];
    const mints = await allCandidates();
    const snaps = await dex.snapshots(mints.slice(0, 120));
    // Candidates: liquid, busy, and preferably ours. Rank by 24h volume, keep a short list to check structure on.
    const cands = [...snaps.values()]
      .filter(s => s.volume24h >= C.minVol24h && s.liquidityUsd >= C.minLiquidity && s.pairAddress)
      .filter(s => !C.flagshipsOnly || isFlagship(s.mint) || isPinned(s.mint))
      .sort((a, b) => (Number(isPinned(b.mint) || isStonkPair(b)) - Number(isPinned(a.mint) || isStonkPair(a))) || b.volume24h - a.volume24h)
      .slice(0, 6);
    const leaders: string[] = [];
    for (const s of cands) {
      try {
        const r = await check(s, ctx);
        if (r.leader) leaders.push(s.mint);
        if (r.sig) out.push(r.sig);
        if (leaders.length >= C.maxLeaders) break;
      } catch (e) { log.debug({ sym: s.symbol, err: String(e) }, "ride check failed"); logLook("ride", s, `couldn't check: ${String(e).replace(/^Error:\s*/, "").slice(0, 70)}`); }
    }
    rideDb.setLeaders(leaders);
    return out;
  },
};

/** Rising 1h structure: the last two 1h-equivalent swing lows and highs are higher. Built from 5m candles. */
export function structure(c5: Candle[]): { rising: boolean; lastHigherLow: number; priorHigh: number; lowerLow: boolean } {
  const hourly: Candle[] = [];
  for (let i = 0; i + 12 <= c5.length; i += 12) {
    const b = c5.slice(i, i + 12);
    hourly.push({ t: b[0].t, o: b[0].o, c: b.at(-1)!.c, h: Math.max(...b.map(k => Math.max(k.o, k.c))), l: Math.min(...b.map(k => Math.min(k.o, k.c))), v: b.reduce((a, k) => a + k.v, 0) });
  }
  const last = hourly.slice(-4);
  if (last.length < 3) return { rising: false, lastHigherLow: 0, priorHigh: 0, lowerLow: false };
  const lows = last.map(k => k.l), highs = last.map(k => k.h);
  const rising = lows.at(-1)! > lows.at(-3)! && highs.at(-1)! >= highs.at(-3)! * 0.97;
  const lowerLow = lows.at(-1)! < lows.at(-2)! * 0.97;
  return { rising, lastHigherLow: lows.at(-1)!, priorHigh: Math.max(...highs), lowerLow };
}

export type RideStructure = ReturnType<typeof structure>;

/** Is this coin a leader right now? Rising 1h structure, no lower low, volume holding. */
export function rideLeader(c5: Candle[], C: ModeCfg<"ride">): Pattern<{ st: RideStructure }> {
  if (c5.length < 48) return { ok: false };
  const st = structure(c5);
  const avgVol = c5.slice(-48).reduce((a, k) => a + k.v, 0) / 48;
  const recentVol = c5.slice(-12).reduce((a, k) => a + k.v, 0) / 12;
  const faded = avgVol > 0 && recentVol < avgVol * C.fadeVolX;
  if (!st.rising || st.lowerLow || faded) return { ok: false, why: faded ? "volume faded under 0.3x average, not a leader right now" : st.lowerLow ? "printed a 1h lower low, structure broken" : "no rising 1h structure yet", setup: { need: "higher highs and higher lows on the 1h, volume holding" } };
  return { ok: true, st };
}

export function rideCorePlan(st: RideStructure, C: ModeCfg<"ride">): (entry: number, atr15: number) => ExitPlan {
  return (entry, atr15) => ({
    hardFloorPct: 0.45,
    closeStopPrice: structuralStop(entry, st.lastHigherLow, atr15, 1, C.coreMaxLoss),
    takeProfits: [],
    trailPct: C.coreTrailPct, trailAfterGain: C.coreTrailAfterGain,
    maxHoldMs: 0,
  });
}

/** Sleeve swing entry on a leader: pullback to the 1h VWAP or last higher low, green reclaim. */
export function rideSleeve(m: Mkt, c5: Candle[], now: number, st: RideStructure, C: ModeCfg<"ride">): Pattern<{ base: number; pullback: number; ref: number; target: number; plan: (entry: number, atr15: number) => ExitPlan }> {
  const vw = vwap(c5, now - 3_600_000);
  const ref = Math.max(st.lastHigherLow, vw);
  const pullback = 1 - m.priceUsd / st.priorHigh;
  if (pullback < C.pullbackMin) return { ok: false, why: `near the high, waiting for a pullback to ${ref.toPrecision(3)}`, setup: { need: `pull back to ${ref.toPrecision(3)} (1h VWAP / last higher low)`, level: ref, distance: dist(m.priceUsd, ref) } };
  if (pullback > C.pullbackMax) return { ok: false, why: `${(pullback * 100).toFixed(0)}% off the high, too deep for a swing entry` };
  if (m.priceUsd > ref * 1.06) return { ok: false, why: "pulling back, not at the reference yet", setup: { need: `reach ${ref.toPrecision(3)}`, level: ref, distance: dist(m.priceUsd, ref) } };
  if (!reclaim(c5, ref, 1.0)) return { ok: false, why: "at the reference, waiting for a green 5m reclaim", setup: { need: `green 5m close above ${ref.toPrecision(3)}`, level: ref, distance: dist(m.priceUsd, ref) } };
  if (buySellRatio(m) < 1.0) return { ok: false, why: "more sells than buys in 5m" };
  const swingLow = lowestLow(c5.slice(-6), 0);
  const target = st.priorHigh;
  return {
    ok: true, base: 65 + Math.min(15, pullback * 60), pullback, ref, target,
    plan: (entry, atr15) => ({
      hardFloorPct: 0.30,
      closeStopPrice: structuralStop(entry, swingLow, atr15, 0.5, C.sleeveMaxLoss),
      takeProfits: [{ gain: Math.max(0.08, target / entry - 1), sell: 0.5 }],
      trailPct: C.sleeveTrailPct, trailAfterGain: 0.06,
      maxHoldMs: 12 * 3_600_000,
    }),
  };
}

async function check(s: TokenSnapshot, ctx: Context): Promise<{ leader: boolean; sig: Signal | null }> {
  const pre = await prefilter(s, "ride");
  if (!pre.ok) { logLook("ride", s, pre.why!, pre.holders); return { leader: false, sig: null }; }
  const { c5, c15 } = await candles5and15(s.pairAddress!);
  const L = rideLeader(c5, C);
  if (!L.ok) { if (L.why) logLook("ride", s, L.why, pre.holders, L.setup); return { leader: false, sig: null }; }
  const st = L.st;

  // It's a leader. Core first if we don't have one.
  const a15 = atr(c15);
  const hasCore = rideDb.hasCore(s.mint);

  if (!hasCore) {
    const g = await gate(s, "ride", C.coreSizeUsd);
    if (!g.ok) { logLook("ride", s, g.why!, g.holders); return { leader: true, sig: null }; }
    const score = 70 + (isPinned(s.mint) ? 10 : 0) + (isStonkPair(s) ? 5 : 0) + holderScore(s.mint) + walletScore(s.mint);
    return { leader: true, sig: {
      mode: "ride", mint: s.mint, symbol: s.symbol, sizeUsd: C.coreSizeUsd, score,
      reason: `ride core: leader with $${(s.volume24h / 1e6).toFixed(1)}M 24h volume, rising 1h structure`,
      snapshot: s, candles15: c15, meta: { atr15: a15, leg: "core", holders: g.holders },
      plan: rideCorePlan(st, C),
    } };
  }

  // Sleeve: only when flat on the sleeve, within daily budget, and past the re-entry cooldown.
  if (rideDb.hasSleeve(s.mint)) { logLook("ride", s, "core and sleeve both open, riding", pre.holders, { need: "sleeve to close before the next swing trade" }); return { leader: true, sig: null }; }
  const h = rideDb.sleeveHistory(s.mint, brisbaneDayStart(ctx.now));
  if (h.tradesToday >= C.maxSleeveTradesPerDay) { logLook("ride", s, `${h.tradesToday} sleeve trades today, done for the day`, pre.holders); return { leader: true, sig: null }; }
  if (h.lastClosedAt) {
    const wait = h.lastWon ? C.reenterAfterWinMs : C.reenterAfterLossMs;
    if (ctx.now - h.lastClosedAt < wait) { logLook("ride", s, `cooling ${Math.round((wait - (ctx.now - h.lastClosedAt)) / 60_000)}m after the last ${h.lastWon ? "win" : "loss"}`, pre.holders); return { leader: true, sig: null }; }
  }
  const p = rideSleeve(s, c5, ctx.now, st, C);
  if (!p.ok) { if (p.why) logLook("ride", s, p.why, pre.holders, p.setup); return { leader: true, sig: null }; }

  const g = await gate(s, "ride", C.sleeveSizeUsd);
  if (!g.ok) { logLook("ride", s, g.why!, g.holders); return { leader: true, sig: null }; }
  const score = p.base + holderScore(s.mint) + walletScore(s.mint);
  return { leader: true, sig: {
    mode: "ride", mint: s.mint, symbol: s.symbol, sizeUsd: C.sleeveSizeUsd, score,
    reason: `ride sleeve: pullback ${(p.pullback * 100).toFixed(0)}% to ${p.ref.toPrecision(3)}, target ${p.target.toPrecision(3)}`,
    snapshot: s, candles15: c15, meta: { atr15: a15, leg: "sleeve", target: p.target, holders: g.holders },
    plan: p.plan,
  } };
}
