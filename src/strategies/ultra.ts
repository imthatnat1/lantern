import { config } from "../config.js";
import { allCandidates } from "../data/universe.js";
import { log } from "../log.js";
import type { Candle, Signal, TokenSnapshot } from "../types.js";
import { ageHours } from "../engine/filters.js";
import { structuralStop } from "../engine/exits.js";
import { atr, lowestLow } from "../data/gecko.js";
import { account } from "../engine/broker.js";
import { buySellRatio, candles5and15, dex, gate, logLook, holderScore, holderVelocity, logSignal, type Context, type Strategy } from "./base.js";

const C = config.modes.ultra;

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
    const mints = await allCandidates();
    const snaps = await dex.snapshots(mints.slice(0, 90));
    // Candles are the scarce resource (GeckoTerminal 30/min per IP). Check the most active coins first, cap per scan.
    const ranked = [...snaps.values()].sort((a, b) => (b.volume1h || 0) - (a.volume1h || 0)).slice(0, 20);
    for (const s of ranked) {
      try {
        const sig = await check(s, ctx);
        if (sig) out.push(sig);
      } catch (e) { log.debug({ sym: s.symbol, err: String(e) }, "ultra check failed"); }
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

async function check(s: TokenSnapshot, ctx: Context): Promise<Signal | null> {
  const age = ageHours(s, ctx.now);
  const long = age > C.maxAgeH;
  if (age < C.minAgeH || age > C.longWindowMaxAgeH) return null;
  const [mcMin, mcMax, liqMin] = long
    ? [C.longWindowMcapMin, C.longWindowMcapMax, C.longWindowMinLiquidity]
    : [C.mcapMin, C.mcapMax, C.minLiquidity];
  if (s.mcapUsd < mcMin || s.mcapUsd > mcMax || s.liquidityUsd < liqMin || !s.pairAddress) return null;

  const { c5, c15 } = await candles5and15(s.pairAddress);
  if (c5.length < 30) return null;
  const dumpLow = lowestLow(c5, ctx.now - 12 * 3_600_000);
  if (s.priceUsd < dumpLow * C.recoverFromLowX) { logLook("ultra", s, `only ${(s.priceUsd / dumpLow).toFixed(2)}x off the dump low, need 1.8x`); return null; }
  const hl = higherLows(c5.slice(-40), C.higherLows, C.lowTolerance);
  if (!hl.ok) { logLook("ultra", s, `recovered, but only ${hl.lows.length} higher lows`); return null; }
  if (hl.lows.at(-1)! < dumpLow * C.lastLowOverDumpX) { logLook("ultra", s, "last low too close to the dump low"); return null; }

  const range = c5.slice(-24, -1);
  const rangeTop = Math.max(...range.map(k => k.h));
  const rangeVol = range.reduce((a, k) => a + k.v, 0) / 2; // 2h of 5m candles
  if (rangeVol < C.minRangeVolPerHour) return null;
  const k = c5.at(-2)!;
  const avgV = range.reduce((a, b) => a + b.v, 0) / range.length;
  const volX = avgV ? k.v / avgV : 0;
  if (!(k.c > rangeTop && volX >= C.breakoutVolX)) { logLook("ultra", s, `structure forming, waiting for a 1.3x volume close above ${rangeTop.toPrecision(3)}`); return null; }
  const bs = buySellRatio(s);
  if (bs < C.buySellMin || bs > C.buySellMax) { logLook("ultra", s, `buy/sell ratio ${bs.toFixed(1)} outside 1-3`); return null; }
  const above = s.priceUsd / rangeTop - 1;
  const maxAbove = volX >= C.hotVolX && s.liquidityUsd >= C.hotMinLiq ? C.maxAboveRangeTopHot : C.maxAboveRangeTop;
  if (above > maxAbove) { logLook("ultra", s, `breakout already ${(above * 100).toFixed(0)}% above the range top, chasing`); return null; }

  const eq = account().cash; // sizing on cash is conservative; fine for paper
  const size = Math.min(C.maxSizeUsd, eq * C.sizePctEquity);
  const g = await gate(s, "ultra", size);
  if ((g.holders ?? 0) < C.minHolders) return null;
  const a15 = atr(c15);
  const sixHLow = lowestLow(c15, ctx.now - 6 * 3_600_000);
  const score = 65 + Math.min(15, volX * 3) + (bs > 1.5 ? 10 : 0) + (long ? 5 : 10) + holderScore(s.mint);

  const sig: Signal = {
    mode: "ultra", mint: s.mint, symbol: s.symbol, sizeUsd: size, score,
    reason: `second leg breakout, vol ${volX.toFixed(1)}x, ${hl.lows.length} higher lows`,
    snapshot: s, candles15: c15,
    meta: { atr15: a15, dumpLow, rangeTop, breakoutVol: k.v, holders: g.holders },
    plan: (entry, atr15) => ({
      hardFloorPct: 0.55,
      closeStopPrice: structuralStop(entry, sixHLow, atr15, 1, 0.50),
      takeProfits: [{ gain: 1.0, sell: 0.33 }],
      trailPct: 0.30, trailAfterGain: 0.50,
      trailLadder: [{ peakGain: 1.0, trailPct: 0.35 }, { peakGain: 3.0, trailPct: Math.min(0.55, Math.max(0.40, (3 * atr15) / entry)) }],
      maxHoldMs: 0,
    }),
  };
  if (!g.ok) { logSignal(sig, false, g.why!); return null; }
  return sig;
}
