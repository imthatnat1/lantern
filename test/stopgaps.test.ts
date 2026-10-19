import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { evaluate } = await import("../src/engine/exits.js");
const { sell } = await import("../src/engine/broker.js");
const { stopGapSummary, setRealPrice, stopKind } = await import("../src/engine/stopgaps.js");
const { db, positions } = await import("../src/db.js");

const T = Date.UTC(2026, 9, 19, 8, 0), M15 = 15 * 60_000;
const plan = () => ({ hardFloorPct: 0.45, closeStopPrice: 0.8, takeProfits: [], trailPct: 0.2, trailAfterGain: 0.3, maxHoldMs: 0 });
const newPos = (mint: string) => positions.insert({ mode: "dip", mint, symbol: mint, entryPrice: 1, entryAt: T, qty: 10, remainingQty: 10, costUsd: 10,
  peakPrice: 1, peakClose: 1, lastGoodPrice: 1, lastGoodAt: T, atr15: 0.05, liquidityAtEntry: 40_000, plan: plan(), tpTaken: [], realizedUsd: 0, status: "open", meta: {} } as any);
const read = (price: number) => ({ price, at: T, confirmed: true, source: "t" }) as any;

test("every stop kind carries the level that fired", () => {
  const p = newPos("K1");
  assert.equal(evaluate(p, read(0.5), undefined, T)[0].trigger, 0.55, "hard floor = entry minus 45%");
  const q = newPos("K2");
  assert.equal(evaluate(q, read(0.7), { t: T + M15, o: 0.85, h: 0.85, l: 0.7, c: 0.7, v: 1 }, T + 2 * M15)[0].trigger, 0.8, "close stop");
  const r = newPos("K3"); r.peakClose = 2; r.plan.closeStopPrice = 0;
  const a = evaluate(r, read(1.5), { t: T + M15, o: 1.7, h: 1.7, l: 1.5, c: 1.5, v: 1 }, T + 2 * M15);
  assert.ok(Math.abs((a[0].trigger ?? 0) - 1.6) < 1e-9, "trail = peak close minus 20%");
  assert.equal(evaluate(newPos("K4"), read(2.5), undefined, T)[0]?.trigger, undefined, "a take profit isn't a stop");
  assert.equal(stopKind("close stop 0.8000"), "close stop");
});

test("a stop that fires on a close well under the line records how far past it the fill landed", () => {
  db.exec("DELETE FROM stop_gaps");
  const p = newPos("GAP");
  // Close stop at 0.80, the 15m candle closed at 0.70 and we sold at 0.69: about -14% past the trigger, like Blossom's MINTER.
  const [a] = evaluate(p, read(0.69), { t: T + M15, o: 0.82, h: 0.82, l: 0.68, c: 0.70, v: 1 }, T + 2 * M15);
  sell(p, a.fraction, 0.69, 40_000, false, 150, a.reason, T + 2 * M15, a.trigger);
  const s = stopGapSummary(0);
  assert.equal(s.n, 1);
  assert.ok(Math.abs((s.avgMarkGapPct ?? 0) - (0.69 / 0.8 - 1)) < 1e-9, `mark gap ${s.avgMarkGapPct}`);
  assert.ok((s.avgFillGapPct ?? 0) < (s.avgMarkGapPct ?? 0), "the paper fill lands a little further past than the mark (slippage model)");
  assert.equal(s.byKind["close stop"].n, 1);
  assert.equal(s.avgRealGapPct, null, "no Jupiter quote yet");
  const id = (db.prepare("SELECT id FROM stop_gaps").get() as any).id;
  setRealPrice(id, 0.64);
  assert.ok(Math.abs((stopGapSummary(0).avgRealGapPct ?? 0) - (0.64 / 0.8 - 1)) < 1e-9, "the real quote shows the real gap");
});

test("ordinary sells (take profit, time, wallet exits) aren't stop gaps", () => {
  db.exec("DELETE FROM stop_gaps");
  const p = newPos("TP");
  sell(p, 0.5, 2, 40_000, false, 150, "TP +100%", T);
  assert.equal(stopGapSummary(0).n, 0);
});
