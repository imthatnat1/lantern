/**
 * STOP SLIPPAGE (19 Oct, from Blossom's stopGaps). Blossom logged its stop fills landing 12-22% past the trigger
 * on thin coins (MINTER -14%, SWOLF -13%, PURR -12%, FTR -22%). Lantern judges stops on 15m closes, so by the time
 * a close stop fires the price can already be well under the line. This records, for every close stop, trail and
 * hard floor exit:
 *   trigger  the stop level that fired
 *   mark     the price we sold at (before slippage)
 *   fill     the paper fill (after the slippage model)
 *   real     what Jupiter would really have paid for the same sale (shadow live), when it answers
 * Gaps are fractions vs the trigger: -0.14 = landed 14% under the stop. If real gaps run well past paper gaps,
 * paper P&L is flattering the stops and real money would do worse.
 */
import { db } from "../db.js";

db.exec(`CREATE TABLE IF NOT EXISTS stop_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, position_id INTEGER, mode TEXT, symbol TEXT, mint TEXT, at INTEGER, kind TEXT,
  trigger_price REAL, mark_price REAL, fill_price REAL, real_price REAL, liquidity REAL, usd REAL
);
CREATE INDEX IF NOT EXISTS stop_gaps_at ON stop_gaps(at);`);

export const gap = (price: number | null | undefined, trigger: number) => price && trigger > 0 ? price / trigger - 1 : null;

export function stopKind(reason: string): "close stop" | "trail" | "hard floor" | "stop" {
  if (/^trail/.test(reason)) return "trail";
  if (/^hard floor/.test(reason)) return "hard floor";
  if (/^close stop/.test(reason)) return "close stop";
  return "stop";
}

/** Record one stop fill. Returns the row id, so the real quote can be filled in when Jupiter answers. */
export function recordStopGap(x: { positionId: number; mode: string; symbol: string; mint: string; at: number; reason: string; trigger: number; mark: number; fill: number; liquidity: number; usd: number }): number {
  const r = db.prepare(`INSERT INTO stop_gaps(position_id, mode, symbol, mint, at, kind, trigger_price, mark_price, fill_price, liquidity, usd)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(x.positionId, x.mode, x.symbol, x.mint, x.at, stopKind(x.reason), x.trigger, x.mark, x.fill, x.liquidity, x.usd);
  return Number(r.lastInsertRowid);
}

export function setRealPrice(id: number, realPrice: number) {
  db.prepare("UPDATE stop_gaps SET real_price=? WHERE id=?").run(realPrice, id);
}

const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/** For /api/state: average and worst gaps past the trigger, per kind, plus the latest stops. */
export function stopGapSummary(sinceMs: number) {
  const rows = db.prepare(`SELECT position_id, mode, symbol, mint, at, kind, trigger_price, mark_price, fill_price, real_price, liquidity, usd
    FROM stop_gaps WHERE at > ? ORDER BY at DESC`).all(sinceMs) as any[];
  const withGaps = rows.map(r => ({
    mode: r.mode, symbol: r.symbol, mint: r.mint, at: r.at, kind: r.kind, liquidity: r.liquidity, usd: r.usd,
    trigger: r.trigger_price, mark: r.mark_price, fill: r.fill_price, real: r.real_price ?? null,
    markGapPct: gap(r.mark_price, r.trigger_price), fillGapPct: gap(r.fill_price, r.trigger_price), realGapPct: gap(r.real_price, r.trigger_price),
  }));
  const sum = (xs: typeof withGaps) => {
    const fill = xs.map(x => x.fillGapPct).filter((x): x is number => x != null);
    const real = xs.map(x => x.realGapPct).filter((x): x is number => x != null);
    return { n: xs.length, avgMarkGapPct: avg(xs.map(x => x.markGapPct).filter((x): x is number => x != null)), avgFillGapPct: avg(fill),
      worstFillGapPct: fill.length ? Math.min(...fill) : null, realN: real.length, avgRealGapPct: avg(real) };
  };
  const kinds = [...new Set(withGaps.map(x => x.kind))];
  return { ...sum(withGaps), byKind: Object.fromEntries(kinds.map(k => [k, sum(withGaps.filter(x => x.kind === k))])), recent: withGaps.slice(0, 12) };
}
