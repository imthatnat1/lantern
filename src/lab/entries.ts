/**
 * Entry lab: replay the live entry rules over recorded history, with settings changed, and see what
 * would have happened. Every mode runs the same pattern code the live bot runs (exported from each
 * strategy file), so a tweak tested here is the tweak that ships.
 *
 * What it can't see, and how it covers for it:
 *  - Safety gate: uses the recorded RugCheck result (from 18 Oct). Before that, a coin counts as failing
 *    when the live bot logged a rejection for it within the hour.
 *  - Candles: real where the bot fetched them, built from ticks in the gaps. Trades say which.
 *  - Score extras that need live state (holder velocity, wallet flow, sniper share) are left out, so
 *    scores run a little low. Holder minimums use recorded holder counts when we have them.
 *  - Capital: each mode's max open positions is enforced; the account-wide caps are not.
 */
import { config, type Config, type ModeCfg } from "../config.js";
import { db } from "../db.js";
import { atr, lowestLow } from "../data/gecko.js";
import type { Mode } from "../types.js";
import { pairScore } from "../strategies/base.js";
import { isStonkPair } from "../data/universe.js";
import { pullbackPattern, pullbackQualifies } from "../strategies/pullback.js";
import { bounceFloor, bouncePattern } from "../strategies/bounce.js";
import { cheapWhy as launchCheap, launchPattern } from "../strategies/launch.js";
import { dipPattern, dipPlan } from "../strategies/dip.js";
import { ultraPattern, ultraPlan, ultraWindow } from "../strategies/ultra.js";
import { rideCorePlan, rideLeader, rideSleeve } from "../strategies/ride.js";
import { trustedFilter, trustedPlan } from "../strategies/trusted.js";
import { CoinHistory, coinsInWindow, migrationsMap, type CoinInfo } from "./data.js";
import { simulate, type ExitVariant } from "./sim.js";

type Modes = Config["modes"];
export type ModeOverrides = { [M in keyof Modes]?: Partial<ModeCfg<M>> };

/** Safety-gate settings an experiment can change. Defaults are the live prefilter rules. */
export interface GateCfg { freshAgeH: number; freshMinHolders: number; freshTop10Max: number }
const GATE: GateCfg = { freshAgeH: 2, freshMinHolders: 150, freshTop10Max: 35 };

export interface Experiment {
  name: string;
  /** What the experiment is testing, in plain words. Shown on the dashboard. */
  why?: string;
  /** Modes to replay. Default: every mode the experiment changes, or all of them. */
  modes?: Mode[];
  config?: ModeOverrides;
  gate?: Partial<GateCfg>;
  /** Exit overrides, per mode or "*" for all. */
  exits?: Partial<Record<Mode | "*", ExitVariant>>;
}

export interface LabTrade {
  mode: Mode; mint: string; symbol: string; at: number; entryMcap: number; sizeUsd: number;
  pnl: number; pct: number; peakPct: number; heldMin: number; exit: string; open: boolean;
  why: string; candles: "real" | "mixed" | "ticks"; leg?: string;
}

export interface ModeSummary { trades: number; wins: number; pnl: number; best: number; worst: number; avgPct: number; realCandleShare: number }

const ALL: Mode[] = ["pullback", "bounce", "launch", "dip", "ultra", "ride", "trusted"];
const STEP = 5 * 60_000;
const SCAN_OFFSET = 2 * 60_000;      // the bot scans a couple of minutes into each 5m candle
const thin = (liq: number) => liq < config.risk.thinPoolUsd;

function cfg<M extends keyof Modes>(m: M, o?: ModeOverrides): ModeCfg<M> {
  return { ...(config.modes[m] as unknown as ModeCfg<M>), ...((o?.[m] ?? {}) as object) } as ModeCfg<M>;
}

function candleTag(share: number): LabTrade["candles"] { return share >= 0.8 ? "real" : share >= 0.2 ? "mixed" : "ticks"; }

/** The live prefilter's fresh-coin and vertical-launch rules, on recorded data. */
function passesGate(h: CoinHistory, now: number, ageH: number, change1h: number, change6h: number, g: GateCfg): boolean {
  const s = h.safetyAt(now);
  if (!s.rugOk) return false;
  const holders = s.holders ?? h.holdersAt(now);
  if (ageH < g.freshAgeH && s.known) {
    if ((holders ?? 0) < g.freshMinHolders) return false;
    if ((s.top10 ?? 0) > g.freshTop10Max) return false;
  }
  if (ageH < 6 && (change1h > 500 || change6h > 2000)) {
    const wide = (holders ?? 0) >= 1000 && (s.top10 ?? 100) < 25;
    if (!wide) return false;
  }
  return true;
}

interface Candidate { trade: LabTrade; exitAt: number }

function sizeFor(mode: Mode, liq: number, o?: ModeOverrides, extra?: { leg?: string; wallets?: number; sizeUsd?: number }): number {
  let size: number;
  if (extra?.sizeUsd) size = extra.sizeUsd;
  else if (mode === "ultra") { const C = cfg("ultra", o); size = Math.min(C.maxSizeUsd, config.startingCapital * C.sizePctEquity); }
  else if (mode === "ride") { const C = cfg("ride", o); size = extra?.leg === "core" ? C.coreSizeUsd : C.sleeveSizeUsd; }
  else if (mode === "trusted") { const C = cfg("trusted", o); size = (extra?.wallets ?? 1) >= 2 ? C.sizeUsdTwoWallets : C.sizeUsd; }
  else size = (cfg(mode, o) as { sizeUsd: number }).sizeUsd;
  return thin(liq) ? size / 2 : size;
}

function enter(h: CoinHistory, mode: Mode, now: number, why: string, plan: (e: number, a: number) => import("../types.js").ExitPlan,
  realShare: number, exp: Experiment, extra?: { leg?: string; wallets?: number; sizeUsd?: number }): Candidate | null {
  const fill = h.tickAfter(now, 6 * 60_000);
  if (!fill) return null;
  const size = sizeFor(mode, fill.liquidity, exp.config, extra);
  const r = simulate({
    mode, mint: h.info.mint, symbol: h.info.symbol, at: fill.at, price: fill.price, liquidity: fill.liquidity, onCurve: h.info.onCurve,
    sizeUsd: size, plan, atr15: atr(h.c15Before(now)), ticks: h.ticksFrom(fill.at), c15: h.c15From(fill.at),
    variant: { ...(exp.exits?.["*"] ?? {}), ...(exp.exits?.[mode] ?? {}) },
  });
  if (!r) return null;
  return {
    exitAt: r.exitAt,
    trade: { mode, mint: h.info.mint, symbol: h.info.symbol, at: fill.at, entryMcap: fill.mcap, sizeUsd: size, pnl: r.pnl, pct: r.pct, peakPct: r.peakPct,
      heldMin: r.heldMin, exit: r.reason, open: r.open, why, candles: candleTag(realShare), leg: extra?.leg },
  };
}

/** Walk one coin through one mode, 5 minutes at a time, from `from` to `to`. */
function walk(h: CoinHistory, mode: Mode, from: number, to: number, exp: Experiment, g: GateCfg, migratedAt?: number): Candidate[] {
  const out: Candidate[] = [];
  const o = exp.config;
  let blockedUntil = 0;
  const start = Math.ceil(from / STEP) * STEP;
  for (let bucket = start; bucket < to; bucket += STEP) {
    const now = bucket + SCAN_OFFSET;
    if (now < blockedUntil) continue;
    const m = h.mktAt(now);
    if (!m) continue;
    const ageH = (now - h.info.createdAt) / 3_600_000;

    if (mode === "pullback") {
      const C = cfg("pullback", o);
      if (!pullbackQualifies(m, ageH, C)) continue;
      if (!passesGate(h, now, ageH, m.change1h, m.change6h, g)) continue;
      const { c5, realShare } = h.c5At(now);
      const p = pullbackPattern(m, c5, now, C);
      if (!p.ok) continue;
      if ((h.holdersAt(now) ?? Infinity) < C.minHolders) continue;
      const c = enter(h, mode, now, `pullback ${(p.retrace * 100).toFixed(0)}% from 1h high`, p.plan, realShare, exp);
      if (c) { out.push(c); blockedUntil = c.exitAt + C.cooldownMs; }
    } else if (mode === "bounce") {
      const C = cfg("bounce", o);
      if (migratedAt == null || now < migratedAt || now - migratedAt > C.maxSinceMigrationH * 3_600_000) continue;
      // Holders unknown in the replay = can't prove a crowd, so under $45k it's treated as 0 holders.
      const floor = bounceFloor(m.mcapUsd ?? 0, m.liquidityUsd ?? 0, h.holdersAt(now) ?? 0, C);
      if (floor.why) continue;
      if (!passesGate(h, now, ageH, m.change1h, m.change6h, g)) continue;
      const { c5, realShare } = h.c5At(now);
      const p = bouncePattern(m, c5, migratedAt, C);
      if (!p.ok) continue;
      if ((h.holdersAt(now) ?? Infinity) < C.minHolders) continue;
      const c = enter(h, mode, now, `bounce from -${(p.dd * 100).toFixed(0)}% post-migration${floor.crowd ? ", early" : ""}`, p.plan, realShare, exp, floor.crowd ? { sizeUsd: C.crowdSizeUsd } : undefined);
      if (c) { out.push(c); blockedUntil = c.exitAt + C.cooldownMs; }
    } else if (mode === "launch") {
      const C = cfg("launch", o);
      if (migratedAt == null || now < migratedAt || now - migratedAt > C.maxSinceMigrationMin * 60_000) continue;
      if (launchCheap(m, C, now)) continue;
      // Launch skips the vertical-launch rule live (base.ts prefilter), so pass 0 for the moves here.
      if (!passesGate(h, now, ageH, 0, 0, g)) continue;
      // Holders and top 10 from the recorded safety check; unknown = can't prove a crowd, skip.
      const sa = h.safetyAt(now);
      const holders = sa.holders ?? h.holdersAt(now);
      if ((holders ?? 0) < C.minHolders || (sa.top10 ?? 100) > C.maxTop10) continue;
      const { c5, realShare } = h.c5At(now);
      const p = launchPattern(m, c5, migratedAt, now, C);
      if (!p.ok) continue;
      const c = enter(h, mode, now, `launch: first leg +${(p.gain15 * 100).toFixed(0)}% in 15m`, p.plan, realShare, exp);
      if (c) { out.push(c); blockedUntil = c.exitAt + C.cooldownMs; }
    } else if (mode === "dip") {
      const C = cfg("dip", o);
      const pinned = config.pinned.includes(h.info.mint);
      const stonk = isStonkPair({ mint: h.info.mint, quoteSymbol: h.info.quote ?? undefined });
      const quality = ageH >= 72 && m.liquidityUsd >= 100_000 && m.volume24h >= 50_000;
      if (!pinned && !stonk && !quality) continue;
      if (!pinned && !passesGate(h, now, ageH, m.change1h, m.change6h, g)) continue;
      const { c5, realShare } = h.c5At(now);
      const p = dipPattern(m, c5, now, C);
      if (!p.ok) continue;
      const score = p.base + (pinned ? 10 : 0) + pairScore({ mint: h.info.mint, quoteSymbol: h.info.quote ?? undefined } as never);
      if (score < C.minScore) continue;
      const dayLow = lowestLow(h.c15Before(now), now - 24 * 3_600_000);
      const c = enter(h, mode, now, `dip ${(p.depth * 100).toFixed(1)}% off 24h high`, dipPlan(p.lo, dayLow), realShare, exp);
      if (c) { out.push(c); blockedUntil = c.exitAt + C.cooldownMs; }
    } else if (mode === "ultra") {
      const C = cfg("ultra", o);
      const w = ultraWindow(m, ageH, C);
      if (!w) continue;
      if (!passesGate(h, now, ageH, m.change1h, m.change6h, g)) continue;
      const { c5, realShare } = h.c5At(now);
      const p = ultraPattern(m, c5, now, w.long, C);
      if (!p.ok) continue;
      if ((h.holdersAt(now) ?? Infinity) < C.minHolders) continue;
      const sixHLow = lowestLow(h.c15Before(now), now - 6 * 3_600_000);
      const c = enter(h, mode, now, `second leg breakout, vol ${p.volX.toFixed(1)}x`, ultraPlan(sixHLow), realShare, exp);
      if (c) { out.push(c); blockedUntil = c.exitAt + C.cooldownMs; }

    }
  }
  return out;
}

/**
 * Ride works across coins, like the live scan: each step it ranks the liquid, busy coins (pinned and
 * creative pairs first, then 24h volume), checks the top 6, and rides at most 2 leaders.
 */
function rideTrades(coins: Map<string, CoinHistory>, from: number, to: number, exp: Experiment, g: GateCfg): Candidate[] {
  const C = cfg("ride", exp.config);
  const out: Candidate[] = [];
  const st = new Map<string, { coreUntil: number; blockedUntil: number; day: Map<number, number> }>();
  const stonk = (h: CoinHistory) => isStonkPair({ mint: h.info.mint, quoteSymbol: h.info.quote ?? undefined });
  for (let bucket = Math.ceil(from / STEP) * STEP; bucket < to; bucket += STEP) {
    const now = bucket + SCAN_OFFSET;
    const cands: { h: CoinHistory; m: NonNullable<ReturnType<CoinHistory["mktAt"]>>; pref: number }[] = [];
    for (const h of coins.values()) {
      const m = h.mktAt(now);
      if (!m || m.volume24h < C.minVol24h || m.liquidityUsd < C.minLiquidity) continue;
      cands.push({ h, m, pref: Number(config.pinned.includes(h.info.mint) || stonk(h)) });
    }
    cands.sort((a, b) => (b.pref - a.pref) || b.m.volume24h - a.m.volume24h);
    let leaders = 0;
    for (const { h, m } of cands.slice(0, 6)) {
      const ageH = (now - h.info.createdAt) / 3_600_000;
      if (!passesGate(h, now, ageH, m.change1h, m.change6h, g)) continue;
      const { c5, realShare } = h.c5At(now);
      const L = rideLeader(c5, C);
      if (!L.ok) continue;
      leaders++;
      const s = st.get(h.info.mint) ?? { coreUntil: 0, blockedUntil: 0, day: new Map() };
      st.set(h.info.mint, s);
      if (now >= s.coreUntil) {
        const c = enter(h, "ride", now, "ride core: leader, rising 1h structure", rideCorePlan(L.st, C), realShare, exp, { leg: "core" });
        if (c) { out.push(c); s.coreUntil = c.exitAt; }
      } else if (now >= s.blockedUntil) {
        const day = Math.floor((now + 10 * 3_600_000) / 86_400_000);
        if ((s.day.get(day) ?? 0) < C.maxSleeveTradesPerDay) {
          const p = rideSleeve(m, c5, now, L.st, C);
          if (p.ok) {
            const c = enter(h, "ride", now, `ride sleeve: pullback ${(p.pullback * 100).toFixed(0)}%`, p.plan, realShare, exp, { leg: "sleeve" });
            if (c) { out.push(c); s.day.set(day, (s.day.get(day) ?? 0) + 1); s.blockedUntil = c.exitAt + (c.trade.pnl > 0 ? C.reenterAfterWinMs : C.reenterAfterLossMs); }
          }
        }
      }
      if (leaders >= C.maxLeaders) break;
    }
  }
  return out;
}

/** Trusted copies: every recorded buy by a trusted wallet, entered a minute later (copy latency). */
function trustedTrades(coins: Map<string, CoinHistory>, from: number, to: number, exp: Experiment, g: GateCfg): Candidate[] {
  const C = cfg("trusted", exp.config);
  let events: { wallet: string; mint: string; at: number }[] = [];
  try { events = db.prepare("SELECT wallet, mint, at FROM wallet_events WHERE tier='trusted' AND side='buy' AND at BETWEEN ? AND ? ORDER BY at").all(from, to) as any[]; } catch { return []; }
  const out: Candidate[] = [];
  const busyUntil = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if ((busyUntil.get(e.mint) ?? 0) > e.at) continue;
    const h = coins.get(e.mint);
    if (!h) continue;
    const wallets = new Set(events.filter(x => x.mint === e.mint && x.at >= e.at - C.twoWalletWindowMs && x.at <= e.at).map(x => x.wallet));
    const now = e.at + 60_000;
    const m = h.mktAt(now) ?? (() => { const t = h.tickAfter(e.at, 5 * 60_000); return t ? h.mktAt(t.at) : null; })();
    if (!m) continue;
    const ageH = (now - h.info.createdAt) / 3_600_000;
    const names = [...wallets].map(config.walletName);
    if (!trustedFilter(m, names.join(" + "), C).ok) continue;
    if (!passesGate(h, now, ageH, m.change1h, m.change6h, g)) continue;
    const holders = h.holdersAt(now);
    if (holders != null && holders < C.minHolders) continue;
    if (holders != null && m.mcapUsd > C.minHoldersAtMcap.mcap && holders < C.minHoldersAtMcap.holders) continue;
    const low = lowestLow(h.c15Before(now), now - 2 * 3_600_000) || m.priceUsd * 0.8;
    const c = enter(h, "trusted", now, `trusted copy: ${names.join(" + ")} bought`, trustedPlan(low, C), h.c5At(now).realShare, exp, { wallets: wallets.size });
    if (c) { out.push(c); busyUntil.set(e.mint, c.exitAt); }
  }
  return out;
}

/** Drop entries that would have gone over a mode's max open positions. */
function capOpen(cands: Candidate[], o?: ModeOverrides): LabTrade[] {
  const kept: LabTrade[] = [];
  const open = new Map<Mode, number[]>();
  for (const c of [...cands].sort((a, b) => a.trade.at - b.trade.at)) {
    const mode = c.trade.mode;
    const max = mode === "ride" ? 99 : (cfg(mode, o) as { maxOpen?: number }).maxOpen ?? 99;
    const exits = (open.get(mode) ?? []).filter(x => x > c.trade.at);
    if (exits.length >= max) { open.set(mode, exits); continue; }
    exits.push(c.exitAt); open.set(mode, exits);
    kept.push(c.trade);
  }
  return kept;
}

export function summarize(trades: LabTrade[]): Partial<Record<Mode, ModeSummary>> {
  const out: Partial<Record<Mode, ModeSummary>> = {};
  for (const t of trades) {
    const s = out[t.mode] ?? { trades: 0, wins: 0, pnl: 0, best: -Infinity, worst: Infinity, avgPct: 0, realCandleShare: 0 };
    s.trades++; if (t.pnl > 0) s.wins++; s.pnl += t.pnl; s.best = Math.max(s.best, t.pnl); s.worst = Math.min(s.worst, t.pnl);
    s.avgPct += t.pct; s.realCandleShare += t.candles === "real" ? 1 : t.candles === "mixed" ? 0.5 : 0;
    out[t.mode] = s;
  }
  for (const s of Object.values(out)) { s!.avgPct /= s!.trades; s!.realCandleShare /= s!.trades; }
  return out;
}

export function modesFor(exp: Experiment): Mode[] {
  if (exp.modes?.length) return exp.modes;
  const touched = new Set<Mode>([...Object.keys(exp.config ?? {}), ...Object.keys(exp.exits ?? {}).filter(k => k !== "*")] as Mode[]);
  return touched.size && !exp.gate ? [...touched] : ALL;
}

/** Load each coin's history once; experiments share it. */
export class Lab {
  readonly coins = new Map<string, CoinHistory>();
  readonly migrations = migrationsMap();
  constructor(readonly from: number, readonly to: number, infos: CoinInfo[] = coinsInWindow(from, to)) {
    const lookback = 24 * 3_600_000;
    for (const info of infos) this.coins.set(info.mint, new CoinHistory(info, from - lookback, to));
  }

  /** Migration time: recorded when we have it, else the post-migration pool's creation time. */
  private migratedAt(h: CoinHistory): number | undefined {
    return this.migrations.get(h.info.mint) ?? (!h.info.onCurve && h.info.pair ? h.info.createdAt : undefined);
  }

  run(exp: Experiment): { trades: LabTrade[]; modes: Mode[] } {
    const g = { ...GATE, ...(exp.gate ?? {}) };
    const modes = modesFor(exp);
    const cands: Candidate[] = [];
    for (const mode of modes) {
      if (mode === "trusted") { cands.push(...trustedTrades(this.coins, this.from, this.to, exp, g)); continue; }
      if (mode === "ride") { cands.push(...rideTrades(this.coins, this.from, this.to, exp, g)); continue; }
      for (const h of this.coins.values()) cands.push(...walk(h, mode, this.from, this.to, exp, g, mode === "bounce" || mode === "launch" ? this.migratedAt(h) : undefined));
    }
    return { trades: capOpen(cands, exp.config), modes };
  }
}
