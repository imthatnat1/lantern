/**
 * Exit simulation over recorded prices, using the live exit engine and fill model.
 * Shared by the exit replay (src/replay.ts) and the entry lab (src/lab/entries.ts).
 */
import { evaluate } from "../engine/exits.js";
import { fillModel } from "../engine/broker.js";
import type { Candle, ExitPlan, Mode, Position } from "../types.js";

export const SOL_USD = 150;

/** Exit overrides an experiment can apply on top of the plan a mode produced. */
export interface ExitVariant {
  hardFloorPct?: number; trailPct?: number; trailAfterGain?: number;
  tpGain?: number; tpSell?: number; noTp?: number;
  /** Clamp the close stop to entry * (1 - maxLoss). */
  maxLoss?: number;
  /** Hours; 0 removes the time exit. */
  maxHoldH?: number;
}

export function applyVariant(plan: ExitPlan, v: ExitVariant | undefined, entry: number): ExitPlan {
  const p: ExitPlan = JSON.parse(JSON.stringify(plan));
  if (!v) return p;
  if (v.hardFloorPct != null) p.hardFloorPct = v.hardFloorPct;
  if (v.trailPct != null) { p.trailPct = v.trailPct; if (p.trailLadder) p.trailLadder = p.trailLadder.map(r => ({ ...r, trailPct: Math.max(r.trailPct, v.trailPct!) })); }
  if (v.trailAfterGain != null) p.trailAfterGain = v.trailAfterGain;
  if (v.noTp) p.takeProfits = [];
  if (v.tpGain != null && p.takeProfits[0]) p.takeProfits[0].gain = v.tpGain;
  if (v.tpSell != null && p.takeProfits[0]) p.takeProfits[0].sell = v.tpSell;
  if (v.maxLoss != null) p.closeStopPrice = Math.max(p.closeStopPrice, entry * (1 - v.maxLoss));
  if (v.maxHoldH != null) p.maxHoldMs = v.maxHoldH * 3_600_000;
  return p;
}

export interface SimTick { at: number; price: number; liquidity: number }

export interface SimInput {
  mode: Mode; mint: string; symbol: string;
  at: number; price: number; liquidity: number; onCurve: boolean; sizeUsd: number;
  plan: (entry: number, atr15: number) => ExitPlan;
  atr15: number;
  ticks: SimTick[];          // from entry onward
  c15: Candle[];             // 15m candles covering the hold
  variant?: ExitVariant;
}

export interface SimResult { pnl: number; pct: number; reason: string; exitAt: number; heldMin: number; peakPct: number; open: boolean }

export function simulate(x: SimInput): SimResult | null {
  if (x.ticks.length < 2) return null;
  const liq0 = x.liquidity || 50_000;
  const { effPrice, feesUsd } = fillModel("buy", x.price, x.sizeUsd, liq0, x.onCurve, SOL_USD);
  const qty = (x.sizeUsd - feesUsd) / effPrice;
  const plan = applyVariant(x.plan(effPrice, x.atr15 || effPrice * 0.05), x.variant, effPrice);
  const p: Position = {
    id: 0, mode: x.mode, mint: x.mint, symbol: x.symbol, entryPrice: effPrice, entryAt: x.at, qty, remainingQty: qty,
    costUsd: x.sizeUsd, peakPrice: effPrice, peakClose: effPrice, lastGoodPrice: x.price, lastGoodAt: x.at, atr15: x.atr15 || effPrice * 0.05,
    liquidityAtEntry: liq0, plan, tpTaken: [], realizedUsd: 0, status: "open", meta: {},
  };
  let net = 0, ci = 0, reason = "still open", exitAt = x.at, peak = x.price;
  const M15 = 15 * 60_000;
  for (let i = 0; i < x.ticks.length; i++) {
    const t = x.ticks[i];
    // Junk-tick guard, same rule as live: a >40% jump needs the next tick to agree.
    const jump = Math.abs(t.price - p.lastGoodPrice) / p.lastGoodPrice;
    let confirmed = jump <= 0.4;
    if (!confirmed) { const nxt = x.ticks[i + 1]; confirmed = !!nxt && Math.abs(nxt.price - t.price) / t.price <= 0.15; }
    if (confirmed) peak = Math.max(peak, t.price);
    while (ci < x.c15.length && x.c15[ci].t + M15 <= t.at) ci++;
    const lastClosed = ci > 0 ? x.c15[ci - 1] : undefined;
    const actions = evaluate(p, { price: t.price, at: t.at, confirmed, source: "replay" }, lastClosed, t.at);
    for (const a of actions) {
      const q = p.remainingQty * a.fraction;
      const { effPrice: sp, feesUsd: sf } = fillModel("sell", t.price, q * t.price, t.liquidity || liq0, x.onCurve, SOL_USD);
      net += q * sp - sf; p.remainingQty -= q; reason = a.reason; exitAt = t.at;
      if (p.remainingQty <= p.qty * 0.001) { p.remainingQty = 0; p.status = "closed"; break; }
    }
    if (p.status === "closed") break;
  }
  const open = p.remainingQty > 0;
  if (open) { const last = x.ticks.at(-1)!; net += p.remainingQty * last.price; exitAt = last.at; }
  const pnl = net - x.sizeUsd;
  return { pnl, pct: pnl / x.sizeUsd, reason, exitAt, heldMin: Math.round((exitAt - x.at) / 60_000), peakPct: peak / x.price - 1, open };
}
