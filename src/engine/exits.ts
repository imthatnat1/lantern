import type { Candle, Position } from "../types.js";
import type { PriceRead } from "./price.js";

export interface ExitAction { fraction: number; reason: string }

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
  const newClose = lastClosed15 && lastClosed15.t > ((p.meta.lastCloseT as number) ?? 0);
  if (newClose) {
    p.meta.lastCloseT = lastClosed15.t;
    if (lastClosed15.c > p.peakClose) p.peakClose = lastClosed15.c;
  }

  // 1. Hard tick floor. Confirmed price only.
  if (read.confirmed && price <= p.entryPrice * (1 - p.plan.hardFloorPct)) {
    return [{ fraction: 1, reason: `hard floor -${(p.plan.hardFloorPct * 100).toFixed(0)}%` }];
  }

  // 2. Close-based stop. Only on a new closed candle.
  if (newClose && lastClosed15.c <= p.plan.closeStopPrice) {
    return [{ fraction: 1, reason: `close stop ${p.plan.closeStopPrice.toPrecision(4)}` }];
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
    if (newClose && lastClosed15.c <= trailStop) {
      out.push({ fraction: 1, reason: `trail ${(trail * 100).toFixed(0)}% from peak close` });
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
