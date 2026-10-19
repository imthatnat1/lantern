import type { Candle, Position } from "../types.js";
import type { PriceRead } from "./price.js";

/** `trigger`: the stop level that fired (stops, trails, hard floor), so the fill's gap past it can be measured. */
export interface ExitAction { fraction: number; reason: string; trigger?: number }

/**
 * Pure exit logic. Given a position, a (possibly unconfirmed) price read and the
 * most recent CLOSED 15m candle, return what to sell. Mutates peak tracking on `p`.
 *
 * Principles, learned the hard way on 16 Oct:
 *   1. Nothing fills on an unconfirmed tick.
 *   2. Stops are judged on closes. The tick floor is a last-resort circuit breaker, far below the close stop.
 *   3. Trails only ever tighten.
 */
export function evaluate(p: Position, read: PriceRead, lastClosed15: Candle | undefined, now: number): ExitAction[] {
  const out: ExitAction[] = [];
  const price = read.price;
  const gain = price / p.entryPrice - 1;

  if (read.confirmed) {
    p.lastGoodPrice = price;
    p.lastGoodAt = read.at;
    if (price > p.peakPrice) p.peakPrice = price;
  }
  // Only candles that closed after we bought. 20 Oct: COMPUTE, 김여정 and discat were sold the minute they were bought,
  // because the last closed 15m candle was from before the pump, below the stop. COMPUTE then ran +452%.
  const afterEntry = !!lastClosed15 && lastClosed15.t + 15 * 60_000 > p.entryAt;
  const newClose = afterEntry && lastClosed15!.t > ((p.meta.lastCloseT as number) ?? 0);
  if (newClose) {
    p.meta.lastCloseT = lastClosed15!.t;
    if (lastClosed15!.c > p.peakClose) p.peakClose = lastClosed15!.c;
  }

  // 1. Hard tick floor. Confirmed price only.
  if (read.confirmed && price <= p.entryPrice * (1 - p.plan.hardFloorPct)) {
    return [{ fraction: 1, reason: `hard floor -${(p.plan.hardFloorPct * 100).toFixed(0)}%`, trigger: p.entryPrice * (1 - p.plan.hardFloorPct) }];
  }

  // 2. Close-based stop. Only on a new closed candle.
  if (newClose && lastClosed15!.c <= p.plan.closeStopPrice) {
    return [{ fraction: 1, reason: `close stop ${p.plan.closeStopPrice.toPrecision(4)}`, trigger: p.plan.closeStopPrice }];
  }

  // 3. Take-profit ladder on confirmed price.
  if (read.confirmed) {
    p.plan.takeProfits.forEach((tp, i) => {
      if (!p.tpTaken.includes(i) && gain >= tp.gain) {
        p.tpTaken.push(i);
        out.push({ fraction: tp.sell, reason: `TP +${(tp.gain * 100).toFixed(0)}%` });
      }
    });
  }

  // 4. Trailing stop, judged on closes, ratchets tighter with the peak.
  const peakGain = p.peakClose / p.entryPrice - 1;
  if (peakGain >= p.plan.trailAfterGain) {
    let trail = p.plan.trailPct;
    for (const step of p.plan.trailLadder ?? []) if (peakGain >= step.peakGain) trail = Math.max(trail, step.trailPct);
    // Lift the close stop under the trail. Only ever up.
    const trailStop = p.peakClose * (1 - trail);
    if (trailStop > p.plan.closeStopPrice) p.plan.closeStopPrice = trailStop;
    if (newClose && lastClosed15!.c <= trailStop) {
      out.push({ fraction: 1, reason: `trail ${(trail * 100).toFixed(0)}% from peak close`, trigger: trailStop });
      return out;
    }
  }

  // 5. Time backstop.
  if (p.plan.maxHoldMs > 0 && now - p.entryAt >= p.plan.maxHoldMs && read.confirmed) {
    out.push({ fraction: 1, reason: "time backstop" });
  }

  return out;
}

/** Close-stop helper: structural low minus k*ATR, clamped to a max loss from entry. */
export function structuralStop(entry: number, low: number, atr: number, k: number, maxLossPct: number): number {
  const raw = low - k * atr;
  const floor = entry * (1 - maxLossPct);
  return Math.max(raw, floor) > entry ? floor : Math.max(raw, floor);
}

/**
 * Adding to winners (19 Oct, Nat: "if it looks like its going to run can we keep bidding? So that we make the most of
 * that ticker"). Pure, shared by the live exit loop and the lab.
 *
 * An add happens only when the position is already up by the next level in `gains` (measured from the FIRST entry),
 * on a green closed 15m candle at a new peak close, with buyers at least matching sellers. Each add is `fraction` of
 * the first bid. After an add the close stop moves up to the new average entry. Stops are judged on 15m closes, so a
 * sharp drop right after an add can still exit a little below that average: a small loss, not a big one.
 */
export interface AddRule { gains: number[]; fraction: number }

export function wantAdd(p: Position, read: PriceRead, lastClosed15: Candle | undefined, rule: AddRule | undefined, buyersOk: boolean): { step: number; usd: number } | null {
  if (!rule || !rule.gains.length || !read.confirmed || !buyersOk || p.status !== "open") return null;
  const done = (p.meta.adds as number | undefined) ?? 0;
  if (done >= rule.gains.length) return null;
  const firstEntry = (p.meta.firstEntry as number | undefined) ?? p.entryPrice;
  const firstCost = (p.meta.firstCost as number | undefined) ?? p.costUsd;
  if (read.price / firstEntry - 1 < rule.gains[done]) return null;
  if (!lastClosed15 || lastClosed15.t === p.meta.lastAddCloseT) return null;
  if (lastClosed15.c <= lastClosed15.o || lastClosed15.c < p.peakClose * 0.999) return null;
  return { step: done + 1, usd: firstCost * rule.fraction };
}

/** Book an add on the position: average the entry, grow the size, lift the stop to the new average. */
export function applyAdd(p: Position, usd: number, effPrice: number, feesUsd: number, lastClosed15T?: number): void {
  if (p.meta.firstEntry == null) { p.meta.firstEntry = p.entryPrice; p.meta.firstCost = p.costUsd; }
  const qtyAdd = (usd - feesUsd) / effPrice;
  const remaining = p.remainingQty + qtyAdd;
  p.entryPrice = (p.entryPrice * p.remainingQty + effPrice * qtyAdd) / remaining;
  p.qty += qtyAdd; p.remainingQty = remaining; p.costUsd += usd;
  p.meta.adds = ((p.meta.adds as number | undefined) ?? 0) + 1;
  p.meta.lastAddCloseT = lastClosed15T;
  if (p.entryPrice > p.plan.closeStopPrice) p.plan.closeStopPrice = p.entryPrice;
}
