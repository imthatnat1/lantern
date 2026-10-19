import { config, type ModeCfg } from "../config.js";
import { log } from "../log.js";
import type { Candle, ExitPlan, Signal, TokenSnapshot } from "../types.js";
import { atr, highestHigh } from "../data/gecko.js";
import { isNatWatched, natWatchMints } from "../data/natwatch.js";
import { isStonkListed } from "../data/stonkfun.js";
import { fakeValuation, microTrades } from "../data/flow.js";
import { buySellRatio, candles5and15, churnLabel, dex, dist, gate, holderScore, holderVelocity, logLook, logSignal, pairScore, prefilter, sniperPenalty, walletScore, type Context, type Mkt, type Pattern, type Strategy } from "./base.js";

const C: ModeCfg<"launch"> = config.modes.launch;
const M5 = 5 * 60_000;

/**
 * LAUNCH: buy the first leg of a fresh migration while a real crowd is piling in.
 *
 * 19 Oct: every other mode waits for weakness (bounce a 35-70% dip, pullback a 20-40% retrace, ultra a dump and a
 * second leg), so coins that went straight up never got bought: PIERRE 26x, mucron 18x, Vader +2700% sat on Watching
 * as "clean, no entry pattern yet". Nat: "Why are they appearing in my watch list already up 3000%".
 *
 * Qualify: migrated in the last hour, $25k+ pool, $60k to $3M, buys clearly ahead of sells, not churning,
 *          500+ holders with the top 10 under 25%, its own socials (prefilter).
 * Enter on: a closed 5m candle near the post-migration high, up on the last 15 minutes, on at least average volume,
 *          and not one giant candle (no buying a blow-off wick).
 * From 1h to 6h after migration it buys a breakout instead: a 5m close at a new high since migration on 3x the
 *          previous hour's average volume (Blossom's PIERRE trade, 19 Oct: 2.3h old, 4.5x volume, $3 -> +$9.28).
 * Exit: out on a 15m close 25% under entry, -40% hard floor on ticks; half off at 2x; trail 30% from the peak close
 *          once up 50% (35% after 4x); 6h backstop.
 * Most of these fail. It only works if the winners are big enough to pay for the losers, so size is small.
 */
export const launch: Strategy = {
  name: "launch",
  everyMs: C.scanEveryMs,
  async scan(ctx: Context): Promise<Signal[]> {
    const out: Signal[] = [];
    const recent = [...ctx.migrations.entries()]
      .filter(([, at]) => ctx.now - at < C.breakoutMaxAgeH * 3_600_000)
      .map(([m]) => m);
    // Coins Nat tapped Watch on: checked too while young, with their pool's creation time standing in for migration.
    const watched = natWatchMints(ctx.now).filter(m => !ctx.migrations.has(m));
    if (!recent.length && !watched.length) return out;
    const all = await dex.snapshots([...recent, ...watched]);
    // Local copy: the shared migrations map also feeds bounce and the market mood, which shouldn't see these.
    const migratedAt = new Map(ctx.migrations);
    for (const m of watched) {
      const s = all.get(m);
      if (s && !s.onCurve && ctx.now - s.createdAt < C.breakoutMaxAgeH * 3_600_000) migratedAt.set(m, s.createdAt);
      else all.delete(m);
    }
    // Launchpad coins only (pump.fun / bonk mints, Stonk.fun listings, or ones Nat watches). 20 Oct: a new pool for
    // tokenized stocks and wrapped coins (ABNB, TTWO, cbADA, INJ) looked like a migration and filled the radar.
    const snaps = [...all.values()].filter(s => isLaunchpadMint(s.mint) || isStonkListed(s.mint) || watched.includes(s.mint) || isNatWatched(s.mint));
    // Cheap checks first; the busiest buy-side coins get the candle and safety calls.
    const live = snaps.filter(s => {
      const why = cheapWhy(s, C, ctx.now);
      if (why) logLook("launch", s, why);
      return !why;
    })
      .sort((a, b) => (b.volume5m || 0) * buySellRatio(b) - (a.volume5m || 0) * buySellRatio(a))
      .sort((a, b) => Number(watched.includes(b.mint)) - Number(watched.includes(a.mint)))
      .slice(0, C.checksPerScan);
    for (const s of live) {
      try {
        const sig = await check(s, ctx, migratedAt.get(s.mint)!);
        if (sig) out.push(sig);
      } catch (e) { log.debug({ sym: s.symbol, err: String(e) }, "launch check failed"); }
    }
    return out;
  },
};

/** pump.fun and LetsBonk mints carry their launchpad in the address. */
export function isLaunchpadMint(mint: string): boolean { return /(pump|bonk)$/.test(mint); }

/** Checks that need no I/O. Null = worth a closer look. */
export function cheapWhy(m: Mkt & { volume1h?: number; volume5m?: number; buys1h?: number; sells1h?: number; createdAt?: number; onCurve?: boolean }, C: ModeCfg<"launch">, now = Date.now()): string | null {
  // Scams first, so they're named as scams. Moonoween (19 Oct 21:04): 1h old, "$157M" on a $1M pool, 1,798 buys to
  // 70 sells. It used to stop at "past launch's $3M", which the radar read as still waiting.
  if (m.createdAt != null) {
    const fake = fakeValuation({ mcapUsd: m.mcapUsd, liquidityUsd: m.liquidityUsd, createdAt: m.createdAt, onCurve: !!m.onCurve, buys5m: m.buys5m, sells5m: m.sells5m, volume24h: m.volume24h }, now);
    if (fake) return `rejected: ${fake}`;
  }
  if (m.volume5m != null && m.volume1h != null) {
    const micro = microTrades({ buys5m: m.buys5m, sells5m: m.sells5m, volume5m: m.volume5m, buys1h: m.buys1h, sells1h: m.sells1h, volume1h: m.volume1h });
    if (micro) return `rejected: ${micro}`;
  }
  if (m.liquidityUsd < C.minLiquidity) return `too thin, $${Math.round(m.liquidityUsd / 1000)}k liquidity (launch needs $${C.minLiquidity / 1000}k)`;
  if (m.mcapUsd < C.mcapMin) return `$${Math.round(m.mcapUsd / 1000)}k market cap, under launch's $${C.mcapMin / 1000}k`;
  if (m.mcapUsd > C.mcapMax) return `$${(m.mcapUsd / 1e6).toFixed(1)}M market cap, past launch's $${C.mcapMax / 1e6}M`;
  if (m.buys5m < C.minBuys5m) return `only ${m.buys5m} buys in 5m, no crowd yet`;
  if (buySellRatio(m) < C.minBuySell) return `buys only ${buySellRatio(m).toFixed(2)}x sells in 5m, needs ${C.minBuySell}x`;
  if (m.createdAt != null && m.volume1h != null && churnLabel({ createdAt: m.createdAt, mcapUsd: m.mcapUsd, volume1h: m.volume1h, buys1h: m.buys1h, sells1h: m.sells1h }, now).length)
    return "rejected: churn, buys and sells nearly even at 4x+ its market cap";
  return null;
}

/** The candle setup. Pure, shared by the live scan and the lab. */
export function launchPattern(m: Mkt, c5all: Candle[], migratedAt: number, now: number, C: ModeCfg<"launch">): Pattern<{ base: number; gain15: number; kind: "first leg" | "breakout"; plan: (entry: number, atr15: number) => ExitPlan }> {
  const c5 = c5all.filter(k => k.t >= migratedAt - M5 && k.t + M5 <= now);   // closed candles since migration
  if (c5.length < 3) return { ok: false, why: `${c5.length * 5} minutes since migration, needs 15 to read the first leg` };
  const last = c5.at(-1)!;
  const hi = highestHigh(c5, migratedAt - M5);
  const offHigh = 1 - last.c / hi;
  if (offHigh > C.maxOffHigh) return { ok: false, why: `${(offHigh * 100).toFixed(0)}% off its high, first leg stalling`, setup: { need: `5m close back near ${(hi * (1 - C.maxOffHigh)).toPrecision(3)}`, level: hi * (1 - C.maxOffHigh), distance: dist(m.priceUsd, hi * (1 - C.maxOffHigh)) } };
  const ref = c5.at(-4)?.c ?? c5[0].o;
  const gain15 = last.c / ref - 1;
  if (last.c / last.o > C.maxCandleX) return { ok: false, why: `last 5m candle +${((last.c / last.o - 1) * 100).toFixed(0)}%, too vertical to chase` };
  if (last.c < last.o) return { ok: false, why: "last 5m candle red, waiting for a green one" };
  const firstHour = now - migratedAt <= C.maxSinceMigrationMin * 60_000;
  let kind: "first leg" | "breakout";
  if (firstHour && !C.firstLeg) return { ok: false, why: "under an hour since migration, waiting for it to prove itself (breakouts from 1h)" };
  if (firstHour) {
    // First leg: still running, on at least average volume.
    if (gain15 < C.minGain15m) return { ok: false, why: `only +${(gain15 * 100).toFixed(0)}% in 15 minutes, not running` };
    const avgV = c5.reduce((a, k) => a + k.v, 0) / c5.length;
    if (avgV > 0 && last.v < avgV * C.minVolX) return { ok: false, why: "volume fading on the last candle" };
    kind = "first leg";
  } else {
    // Breakout (PIERRE at 2.3h): the close is a new high since migration, on a volume spike against the hour before.
    const prior = c5.slice(0, -1);
    const prevHighClose = Math.max(...prior.map(k => k.c));
    if (last.c <= prevHighClose) return { ok: false, why: "no new high yet", setup: { need: `5m close above ${prevHighClose.toPrecision(3)} on ${C.breakoutVolX}x volume`, level: prevHighClose, distance: dist(m.priceUsd, prevHighClose) } };
    const hour = prior.slice(-12);
    const avgV = hour.reduce((a, k) => a + k.v, 0) / Math.max(1, hour.length);
    if (avgV > 0 && last.v < avgV * C.breakoutVolX) return { ok: false, why: `new high on only ${(last.v / avgV).toFixed(1)}x volume, needs ${C.breakoutVolX}x` };
    kind = "breakout";
  }
  const base = 55 + Math.min(20, Math.max(0, gain15) * 40) + (buySellRatio(m) > 2 ? 10 : 0) + (m.liquidityUsd > 50_000 ? 5 : 0);
  return {
    ok: true, base, gain15, kind,
    plan: (entry) => ({
      hardFloorPct: C.hardFloorPct,
      closeStopPrice: entry * (1 - C.stopPct),
      takeProfits: [{ gain: 1.0, sell: 0.5 }],
      trailPct: 0.30, trailAfterGain: 0.50,
      trailLadder: [{ peakGain: 3.0, trailPct: 0.35 }],
      maxHoldMs: 6 * 3_600_000,
    }),
  };
}

/**
 * 20 Oct: the stricter first leg. Overnight, 8 of 11 first legs were dumped to ~$2k within 30 minutes. A first leg now
 * also needs a spread-out crowd (top 10 under firstLegMaxTop10%) that is still growing fast. Unknown = refused.
 * Pure, shared with the lab. Returns why it's refused, or null.
 */
export function firstLegWhy(kind: string, top10: number | undefined | null, holderGrowth10m: number | null, C: ModeCfg<"launch">): string | null {
  if (kind !== "first leg") return null;
  if ((top10 ?? 100) > C.firstLegMaxTop10) return `first leg: top 10 hold ${top10 == null ? "?" : top10.toFixed(0)}%, needs under ${C.firstLegMaxTop10}% this early`;
  if (C.firstLegMinHolderGrowth > -1 && (holderGrowth10m == null || holderGrowth10m < C.firstLegMinHolderGrowth)) return `first leg: holders ${holderGrowth10m == null ? "not measured yet" : `+${(holderGrowth10m * 100).toFixed(0)}%`} in 10m, needs +${(C.firstLegMinHolderGrowth * 100).toFixed(0)}%`;
  return null;
}

async function check(s: TokenSnapshot, ctx: Context, migratedAt: number): Promise<Signal | null> {
  const pre = await prefilter(s, "launch");
  if (!pre.ok) { logLook("launch", s, pre.why!, pre.holders); return null; }
  if ((pre.holders ?? 0) < C.minHolders) { logLook("launch", s, `rejected: ${pre.holders ?? "?"} holders, launch needs ${C.minHolders}`, pre.holders); return null; }
  if ((pre.top10 ?? 100) > C.maxTop10) { logLook("launch", s, `rejected: top 10 hold ${(pre.top10 ?? 100).toFixed(0)}%, launch needs under ${C.maxTop10}%`, pre.holders); return null; }
  if (!s.pairAddress) return null;
  const { c5, c15 } = await candles5and15(s.pairAddress);
  const p = launchPattern(s, c5, migratedAt, ctx.now, C);
  if (!p.ok) { if (p.why) logLook("launch", s, p.why, pre.holders, p.setup); return null; }
  const hv = holderVelocity(s.mint);
  if (hv != null && hv <= 0) { logLook("launch", s, `holders not growing (${(hv * 100).toFixed(0)}% in 10m)`, pre.holders); return null; }
  const fl = firstLegWhy(p.kind, pre.top10, hv, C);
  if (fl) { logLook("launch", s, fl, pre.holders); return null; }

  const g = await gate(s, "launch", C.sizeUsd);
  const score = p.base + (hv != null && hv >= 0.1 ? 10 : 0) + holderScore(s.mint) + pairScore(s) + walletScore(s.mint) + sniperPenalty(g);
  const sig: Signal = {
    mode: "launch", mint: s.mint, symbol: s.symbol, sizeUsd: C.sizeUsd, score,
    reason: `launch: ${p.kind} +${(p.gain15 * 100).toFixed(0)}% in 15m, ${((ctx.now - migratedAt) / 3_600_000).toFixed(1)}h after migrating, ${pre.holders} holders, buys ${buySellRatio(s).toFixed(1)}x sells`,
    snapshot: s, candles15: c15,
    meta: { atr15: atr(c15), migratedAt, holders: pre.holders },
    plan: p.plan,
  };
  if (!g.ok) { logSignal(sig, false, g.why!); return null; }
  return sig;
}
