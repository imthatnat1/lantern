import { config, type ModeCfg } from "../config.js";
import { allCandidates } from "../data/universe.js";
import { log } from "../log.js";
import type { Candle, ExitPlan, Signal, TokenSnapshot } from "../types.js";
import { ageHours } from "../engine/filters.js";
import { structuralStop } from "../engine/exits.js";
import { atr, lowestLow } from "../data/gecko.js";
import { account } from "../engine/broker.js";
import { db, cooldowns } from "../db.js";
import { watchedMints, watchedFirst, buySellRatio, candles5and15, dex, dist, gate, logLook, holderScore, pairScore, sniperPenalty, walletScore, holderVelocity, logSignal, prefilter, type Context, type Mkt, type Pattern, type Strategy } from "./base.js";

const C: ModeCfg<"ultra"> = config.modes.ultra;

/**
 * ULTRA: second-leg runner. Dump, recovery >= 1.8x off the low, three higher lows, then a
 * volume breakout of the range top. v1 §3.2 with the same exits, which were the only
 * sane ones in the old bot.
 */
export const ultra: Strategy = {
  name: "ultra",
  everyMs: C.scanEveryMs,
  async scan(ctx: Context): Promise<Signal[]> {
    const out: Signal[] = [];
    const watched = watchedMints("ultra", ctx.now);
    const mints = [...new Set([...watched, ...await allCandidates()])];
    const snaps = await dex.snapshots(mints.slice(0, 90));
    // Candles are the scarce resource (GeckoTerminal 30/min per IP). Coins with a setup forming first, then the most active, cap per scan.
    const ranked = watchedFirst(watched, [...snaps.values()], 20, (a, b) => (b.volume1h || 0) - (a.volume1h || 0));
    for (const s of ranked) {
      try {
        const sig = await check(s, ctx);
        if (sig) out.push(sig);
      } catch (e) { log.debug({ sym: s.symbol, err: String(e) }, "ultra check failed"); logLook("ultra", s, `couldn't check: ${String(e).replace(/^Error:\s*/, "").slice(0, 70)}`); }
    }
    return out;
  },
};

function higherLows(c5: Candle[], n: number, tol: number): { ok: boolean; lows: number[] } {
  // Swing lows: candle lower than both neighbours.
  const lows: number[] = [];
  for (let i = 1; i < c5.length - 1; i++) if (c5[i].l < c5[i - 1].l && c5[i].l < c5[i + 1].l) lows.push(c5[i].l);
  const last = lows.slice(-n);
  if (last.length < n) return { ok: false, lows: last };
  for (let i = 1; i < last.length; i++) if (last[i] < last[i - 1] * (1 - tol)) return { ok: false, lows: last };
  return { ok: true, lows: last };
}

/**
 * Re-entry (Blossom §3.2): once per coin within 48h of an ultra stop-out, if price has reclaimed the
 * stop level and printed a new 1h high on >= 2x volume. Bypasses the normal 6h cooldown.
 */
async function reentry(s: TokenSnapshot, ctx: Context): Promise<Signal | null> {
  const last = db.prepare(`SELECT id, plan, closed_at, meta FROM positions WHERE mode='ultra' AND mint=? AND status='closed' AND closed_at > ?
    AND (close_reason LIKE 'close stop%' OR close_reason LIKE 'hard floor%') ORDER BY closed_at DESC LIMIT 1`).get(s.mint, ctx.now - 48 * 3_600_000) as any;
  if (!last) return null;
  if (JSON.parse(last.meta || "{}").reentered) return null;
  const stopLevel = JSON.parse(last.plan).closeStopPrice as number;
  if (s.priceUsd < stopLevel * 1.02) { logLook("ultra", s, `stopped out ${((ctx.now - last.closed_at) / 3_600_000).toFixed(1)}h ago, waiting for a reclaim of ${stopLevel.toPrecision(3)}`, undefined, { need: `reclaim the stop at ${stopLevel.toPrecision(3)} and make a new 1h high on 2x volume`, level: stopLevel, distance: dist(s.priceUsd, stopLevel) }); return null; }
  const { c5, c15 } = await candles5and15(s.pairAddress!);
  if (c5.length < 24) return null;
  const hourHigh = Math.max(...c5.slice(-13, -1).map(k => Math.max(k.o, k.c)));
  const k = c5.at(-2)!;
  const avgV = c5.slice(-14, -2).reduce((a, b) => a + b.v, 0) / 12;
  if (!(k.c >= hourHigh && avgV > 0 && k.v >= 2 * avgV)) { logLook("ultra", s, "reclaimed the stop, waiting for a new 1h high on 2x volume", undefined, { need: `5m close above ${hourHigh.toPrecision(3)} on 2x volume`, level: hourHigh, distance: dist(s.priceUsd, hourHigh) }); return null; }
  const size = Math.min(C.maxSizeUsd, account().cash * C.sizePctEquity);
  const g = await gate(s, "ultra", size);
  if (!g.ok) { logLook("ultra", s, g.why!, g.holders); return null; }
  db.prepare("UPDATE positions SET meta=json_set(meta,'$.reentered',1) WHERE id=?").run(last.id);
  cooldowns.set("ultra", s.mint, 0);
  const a15 = atr(c15);
  const sixHLow = lowestLow(c15, ctx.now - 6 * 3_600_000);
  return {
    mode: "ultra", mint: s.mint, symbol: s.symbol, sizeUsd: size, score: 72 + holderScore(s.mint) + pairScore(s) + walletScore(s.mint),
    reason: `ultra re-entry after stop: reclaimed ${stopLevel.toPrecision(3)}, new 1h high on ${(k.v / avgV).toFixed(1)}x volume`,
    snapshot: s, candles15: c15, meta: { atr15: a15, reentry: true, holders: g.holders },
    plan: (entry, atr15) => ({
      hardFloorPct: 0.55,
      closeStopPrice: structuralStop(entry, Math.max(sixHLow, stopLevel * 0.97), atr15, 1, 0.50),
      takeProfits: [{ gain: 1.0, sell: 0.33 }],
      trailPct: 0.30, trailAfterGain: 0.50,
      trailLadder: [{ peakGain: 1.0, trailPct: 0.35 }, { peakGain: 3.0, trailPct: Math.min(0.55, Math.max(0.40, (3 * atr15) / entry)) }],
      maxHoldMs: 0,
    }),
  };
}

/** Age and size window before any I/O. Returns the window used, or null when the coin doesn't fit. */
export function ultraWindow(m: Mkt, ageH: number, C: ModeCfg<"ultra">): { long: boolean } | null {
  const long = ageH > C.maxAgeH;
  if (ageH < C.minAgeH || ageH > C.longWindowMaxAgeH) return null;
  return { long };
}

/** The candle setup: 1.8x off the dump low, higher lows, a volume breakout of the 2h range, not chasing. */
export function ultraPattern(m: Mkt, c5: Candle[], now: number, long: boolean, C: ModeCfg<"ultra">): Pattern<{ base: number; volX: number; lows: number; dumpLow: number; rangeTop: number; breakoutVol: number }> {
  const [mcMin, mcMax, liqMin] = long
    ? [C.longWindowMcapMin, C.longWindowMcapMax, C.longWindowMinLiquidity]
    : [C.mcapMin, C.mcapMax, C.minLiquidity];
  if (m.mcapUsd < mcMin || m.mcapUsd > mcMax || m.liquidityUsd < liqMin) return { ok: false };
  if (c5.length < 30) return { ok: false };
  const dumpLow = lowestLow(c5, now - 12 * 3_600_000);
  if (m.priceUsd < dumpLow * C.recoverFromLowX) return { ok: false, why: `only ${(m.priceUsd / dumpLow).toFixed(2)}x off the dump low, need 1.8x`, setup: { need: `recover to ${(dumpLow * C.recoverFromLowX).toPrecision(3)} (1.8x the dump low)`, level: dumpLow * C.recoverFromLowX, distance: dist(m.priceUsd, dumpLow * C.recoverFromLowX) } };
  const hl = higherLows(c5.slice(-40), C.higherLows, C.lowTolerance);
  if (!hl.ok) return { ok: false, why: `recovered, but only ${hl.lows.length} higher lows`, setup: { need: `print ${C.higherLows} higher lows`, progress: { done: hl.lows.length, of: C.higherLows } } };
  if (hl.lows.at(-1)! < dumpLow * C.lastLowOverDumpX) return { ok: false, why: "last low too close to the dump low" };

  const range = c5.slice(-24, -1);
  const rangeTop = Math.max(...range.map(k => k.h));
  const rangeVol = range.reduce((a, k) => a + k.v, 0) / 2; // 2h of 5m candles
  if (rangeVol < C.minRangeVolPerHour) return { ok: false };
  const k = c5.at(-2)!;
  const avgV = range.reduce((a, b) => a + b.v, 0) / range.length;
  const volX = avgV ? k.v / avgV : 0;
  if (!(k.c > rangeTop && volX >= C.breakoutVolX)) return { ok: false, why: `structure forming, waiting for a 1.3x volume close above ${rangeTop.toPrecision(3)}`, setup: { need: `5m close above ${rangeTop.toPrecision(3)} on 1.3x volume`, level: rangeTop, distance: dist(m.priceUsd, rangeTop) } };
  const bs = buySellRatio(m);
  if (bs < C.buySellMin || bs > C.buySellMax) return { ok: false, why: `buy/sell ratio ${bs.toFixed(1)} outside 1-3` };
  const above = m.priceUsd / rangeTop - 1;
  const maxAbove = volX >= C.hotVolX && m.liquidityUsd >= C.hotMinLiq ? C.maxAboveRangeTopHot : C.maxAboveRangeTop;
  if (above > maxAbove) return { ok: false, why: `breakout already ${(above * 100).toFixed(0)}% above the range top, chasing` };
  const base = 65 + Math.min(15, volX * 3) + (bs > 1.5 ? 10 : 0) + (long ? 5 : 10);
  return { ok: true, base, volX, lows: hl.lows.length, dumpLow, rangeTop, breakoutVol: k.v };
}

export function ultraPlan(sixHLow: number): (entry: number, atr15: number) => ExitPlan {
  return (entry, atr15) => ({
    hardFloorPct: 0.55,
    closeStopPrice: structuralStop(entry, sixHLow, atr15, 1, 0.50),
    takeProfits: [{ gain: 1.0, sell: 0.33 }],
    trailPct: 0.30, trailAfterGain: 0.50,
    trailLadder: [{ peakGain: 1.0, trailPct: 0.35 }, { peakGain: 3.0, trailPct: Math.min(0.55, Math.max(0.40, (3 * atr15) / entry)) }],
    maxHoldMs: 0,
  });
}

async function check(s: TokenSnapshot, ctx: Context): Promise<Signal | null> {
  if (s.pairAddress && cooldowns.active("ultra", s.mint)) { const r = await reentry(s, ctx); if (r) return r; }
  const w = ultraWindow(s, ageHours(s, ctx.now), C);
  if (!w) return null;
  const pre = await prefilter(s, "ultra");
  if (!pre.ok) { logLook("ultra", s, pre.why!, pre.holders); return null; }
  if (!s.pairAddress) return null;
  const [mcMin, mcMax, liqMin] = w.long
    ? [C.longWindowMcapMin, C.longWindowMcapMax, C.longWindowMinLiquidity]
    : [C.mcapMin, C.mcapMax, C.minLiquidity];
  if (s.mcapUsd < mcMin || s.mcapUsd > mcMax || s.liquidityUsd < liqMin) return null;

  const { c5, c15 } = await candles5and15(s.pairAddress);
  const p = ultraPattern(s, c5, ctx.now, w.long, C);
  if (!p.ok) { if (p.why) logLook("ultra", s, p.why, undefined, p.setup); return null; }

  const eq = account().cash; // sizing on cash is conservative; fine for paper
  const size = Math.min(C.maxSizeUsd, eq * C.sizePctEquity);
  const g = await gate(s, "ultra", size);
  if ((g.holders ?? 0) < C.minHolders) return null;
  const a15 = atr(c15);
  const sixHLow = lowestLow(c15, ctx.now - 6 * 3_600_000);
  const score = p.base + holderScore(s.mint) + pairScore(s) + walletScore(s.mint) + sniperPenalty(g);

  const sig: Signal = {
    mode: "ultra", mint: s.mint, symbol: s.symbol, sizeUsd: size, score,
    reason: `second leg breakout, vol ${p.volX.toFixed(1)}x, ${p.lows} higher lows`,
    snapshot: s, candles15: c15,
    meta: { atr15: a15, dumpLow: p.dumpLow, rangeTop: p.rangeTop, breakoutVol: p.breakoutVol, holders: g.holders },
    plan: ultraPlan(sixHLow),
  };
  if (!g.ok) { logSignal(sig, false, g.why!); return null; }
  return sig;
}
