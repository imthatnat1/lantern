import type { Position } from "../types.js";
import { config } from "../config.js";
import { kv } from "../db.js";
import { log } from "../log.js";
import { recordedBag, trustedSellsSince } from "../data/wallets.js";
import * as helius from "../data/helius.js";

/**
 * EXIT WHEN A TRUSTED WALLET SELLS (19 Oct, from Blossom's kolSell).
 *
 * Lantern copies wirelyss, hexi and sapphy's buys. Until now it only mirrored a sell on `trusted` copies, and any
 * sell at all (even a 5% trim) dumped the whole position. The rule now:
 *   - The wallet whose buy triggered ours sells most of its bag (50%+ since we entered): we exit.
 *   - Any other trusted sell of 10%+ of its bag, on any coin we hold in any mode, or a smaller trim by the trigger
 *     wallet: the trail tightens to 15% from the peak close, armed straight away, and the card gets a warning.
 *   - Sells under 10% of the bag are ignored (dust, fees, small rebalances).
 * "Bag" = what they sold since we entered plus what they still hold (one RPC balance read per new sell). If the
 * balance can't be read we fall back to the buys and sells we recorded; if that's unknown too, a trigger wallet's
 * sell counts as most of the bag (the reason we bought is gone) and anyone else's as a warning.
 */

export const MOST_OF_BAG = 0.5;
export const MIN_SELL = 0.1;
export const TIGHT_TRAIL = 0.15;

export interface WalletSell { wallet: string; name: string; trigger: boolean; soldPct: number | null; at: number }
export interface WalletSellAction { kind: "exit" | "tighten"; wallet: string; name: string; soldPct: number | null; reason: string }

const pctText = (x: number | null) => x == null ? "part of their bag (size unknown)" : `${Math.round(x * 100)}% of their bag`;

/** Pure: what the sells call for. Exit beats tighten; among tightens, the biggest sell wins. */
export function judgeWalletSells(sells: WalletSell[]): WalletSellAction | null {
  const exit = sells.find(s => s.trigger && (s.soldPct == null || s.soldPct >= MOST_OF_BAG));
  if (exit) return { kind: "exit", wallet: exit.wallet, name: exit.name, soldPct: exit.soldPct, reason: `trusted wallet sold: ${exit.name} (who we copied) sold ${pctText(exit.soldPct)}` };
  const warn = sells.filter(s => s.soldPct == null || s.soldPct >= MIN_SELL)
    .sort((a, b) => (b.soldPct ?? 0.5) - (a.soldPct ?? 0.5))[0];
  if (warn) return { kind: "tighten", wallet: warn.wallet, name: warn.name, soldPct: warn.soldPct, reason: `${warn.name} sold ${pctText(warn.soldPct)}: trail tightened to ${TIGHT_TRAIL * 100}%` };
  return null;
}

/**
 * Pure: tighten the trail on `p`. Armed at any gain (a coin a trusted wallet is dumping shouldn't need +30% first),
 * 15% under the peak close, ladder steps capped at 15% too. Trails only tighten: nothing here can loosen a stop.
 * Returns true if the plan changed.
 */
export function tightenTrail(p: Position, trail = TIGHT_TRAIL): boolean {
  const before = JSON.stringify(p.plan);
  p.plan.trailPct = Math.min(p.plan.trailPct, trail);
  p.plan.trailAfterGain = Math.min(p.plan.trailAfterGain, -1);
  if (p.plan.trailLadder) p.plan.trailLadder = p.plan.trailLadder.map(s => ({ ...s, trailPct: Math.min(s.trailPct, trail) }));
  const stop = p.peakClose * (1 - p.plan.trailPct);
  if (stop > p.plan.closeStopPrice) p.plan.closeStopPrice = stop;
  return JSON.stringify(p.plan) !== before;
}

interface BagCache { n: number; sold: number; bal: number | null; pct: number | null; at: number }
export interface WalletSellLog { at: number; positionId: number; mint: string; symbol: string; mode: string; wallet: string; soldPct: number | null; action: "exit" | "tighten"; note: string }

/** The trusted sells of a held coin since we entered, with how much of each wallet's bag that was. Caches on p.meta. */
export async function assessSells(p: Position, budget = config.modes.trusted.heliusDailyCredits): Promise<WalletSell[]> {
  const rows = trustedSellsSince(p.mint, p.entryAt);
  if (!rows.length) return [];
  const triggers = new Set((p.meta.walletAddrs as string[] | undefined) ?? []);
  const cache = { ...((p.meta.walletBags as Record<string, BagCache> | undefined) ?? {}) };
  for (const r of rows) {
    const c = cache[r.wallet];
    if (c && c.n === r.n) continue;   // nothing new from this wallet
    const bal = await helius.tokenBalance(r.wallet, p.mint, budget);
    let pct: number | null = null;
    if (bal != null && r.sold + bal > 0) pct = r.sold / (r.sold + bal);
    else {
      const bag = recordedBag(r.wallet, p.mint, p.entryAt);
      if (bag > 0) pct = Math.min(1, r.sold / bag);
    }
    cache[r.wallet] = { n: r.n, sold: r.sold, bal, pct, at: r.lastAt };
  }
  p.meta.walletBags = cache;
  return rows.map(r => ({ wallet: r.wallet, name: r.name, trigger: triggers.has(r.wallet), soldPct: cache[r.wallet]?.pct ?? null, at: r.lastAt }));
}

/**
 * Run the rule for one open position. Tightening is applied here; an exit is returned for the caller to fill
 * (only on a confirmed price). Each wallet's action is logged once per position, so the dashboard isn't spammed.
 */
export async function walletSellCheck(p: Position, now = Date.now()): Promise<WalletSellAction | null> {
  const sells = await assessSells(p);
  const a = judgeWalletSells(sells);
  if (!a) return null;
  const acted = { ...((p.meta.walletActed as Record<string, string> | undefined) ?? {}) };
  if (a.kind === "tighten") {
    tightenTrail(p);
    p.meta.walletWarn = a.reason;
    if (acted[a.wallet] !== "tighten" && acted[a.wallet] !== "exit") {
      acted[a.wallet] = "tighten";
      p.meta.walletActed = acted;
      record({ at: now, positionId: p.id, mint: p.mint, symbol: p.symbol, mode: p.mode, wallet: a.name, soldPct: a.soldPct, action: "tighten", note: a.reason });
      log.info({ sym: p.symbol, wallet: a.name, pct: a.soldPct }, "trusted wallet sold: trail tightened");
    }
    return null;
  }
  if (acted[a.wallet] !== "exit") {
    acted[a.wallet] = "exit";
    p.meta.walletActed = acted;
    record({ at: now, positionId: p.id, mint: p.mint, symbol: p.symbol, mode: p.mode, wallet: a.name, soldPct: a.soldPct, action: "exit", note: a.reason });
    log.info({ sym: p.symbol, wallet: a.name, pct: a.soldPct }, "trusted wallet sold: exiting");
  }
  return a;
}

const LOG_KEY = "walletSells:log";
function record(e: WalletSellLog) {
  const xs = kv.get<WalletSellLog[]>(LOG_KEY, []);
  xs.unshift(e);
  kv.set(LOG_KEY, xs.slice(0, 50));
}

/** For /api/state: trusted-wallet sells on coins we held, and what we did, newest first. */
export function walletSellLog(sinceMs: number): WalletSellLog[] {
  return kv.get<WalletSellLog[]>(LOG_KEY, []).filter(e => e.at >= sinceMs);
}
