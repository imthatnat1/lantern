import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { wantAdd, applyAdd } = await import("../src/engine/exits.js");
const { simulate } = await import("../src/lab/sim.js");
const { addRuleFor } = await import("../src/engine/broker.js");

const rule = { gains: [0.6, 1.5], fraction: 0.5 };
const T = Date.UTC(2026, 9, 19, 6, 0), M15 = 15 * 60_000;
const pos = () => ({ id: 1, mode: "launch", mint: "M", symbol: "S", entryPrice: 1, entryAt: T, qty: 12, remainingQty: 12, costUsd: 12,
  peakPrice: 1, peakClose: 1, lastGoodPrice: 1, lastGoodAt: T, atr15: 0.05, liquidityAtEntry: 50_000,
  plan: { hardFloorPct: 0.4, closeStopPrice: 0.65, takeProfits: [{ gain: 1, sell: 0.5 }], trailPct: 0.3, trailAfterGain: 0.5, maxHoldMs: 0 },
  tpTaken: [], realizedUsd: 0, status: "open", meta: {} } as any);
const read = (price: number) => ({ price, at: T, confirmed: true, source: "t" });
const candle = (o: number, c: number, i = 1) => ({ t: T + i * M15, o, h: c, l: o, c, v: 1 });

test("no add below the first level, on a red candle, below the peak close, or when sellers lead", () => {
  const p = pos(); p.peakClose = 1.6;
  assert.equal(wantAdd(p, read(1.5), candle(1.4, 1.5), rule, true), null, "only +50%");
  assert.equal(wantAdd(p, read(1.65), candle(1.7, 1.65), rule, true), null, "red candle");
  p.peakClose = 1.8;
  assert.equal(wantAdd(p, read(1.65), candle(1.5, 1.65), rule, true), null, "not a new high close");
  p.peakClose = 1.65;
  assert.equal(wantAdd(p, read(1.65), candle(1.5, 1.65), rule, false), null, "more sellers than buyers");
  assert.deepEqual(wantAdd(p, read(1.65), candle(1.5, 1.65), rule, true), { step: 1, usd: 6 });
});

test("an add averages the entry up, grows the size, and lifts the stop to the new average", () => {
  const p = pos(); p.peakClose = 1.6;
  applyAdd(p, 6, 1.6, 0, T + M15);
  assert.equal(p.costUsd, 18);
  assert.ok(Math.abs(p.entryPrice - 18 / 15.75) < 1e-9, `avg ${p.entryPrice}`);   // 12 tokens at 1 + 3.75 at 1.6
  assert.equal(p.plan.closeStopPrice, p.entryPrice, "the stop moved up to the average: an add can't turn a winner into a loser");
  assert.equal(p.meta.firstEntry, 1);
  assert.equal(wantAdd(p, read(1.7), candle(1.6, 1.7, 1), rule, true), null, "never twice on the same candle, and +70% < next level");
  p.peakClose = 2.6;
  assert.deepEqual(wantAdd(p, read(2.6), candle(2.3, 2.6, 3), rule, true), { step: 2, usd: 6 }, "second add at +150% from the FIRST entry");
  applyAdd(p, 6, 2.6, 0, T + 3 * M15);
  assert.equal(wantAdd(p, read(4), candle(3, 4, 5), rule, true), null, "two adds max");
});

test("replay: a runner earns more with adds", () => {
  // 15m candles climbing 1 -> 3, ticks every 5 minutes at each candle's close
  const closes = [1.1, 1.3, 1.65, 1.9, 2.2, 2.6, 3.0];
  const c15 = closes.map((c, i) => ({ t: T + i * M15, o: i ? closes[i - 1] : 1, h: c, l: i ? closes[i - 1] : 1, c, v: 1 }));
  const ticks = [{ at: T, price: 1, liquidity: 500_000 }, ...closes.map((c, i) => ({ at: T + (i + 1) * M15 + 60_000, price: c, liquidity: 500_000 }))];
  const plan = () => ({ hardFloorPct: 0.4, closeStopPrice: 0.65, takeProfits: [{ gain: 1, sell: 0.5 }], trailPct: 0.3, trailAfterGain: 0.5, maxHoldMs: 0 });
  const base = { mode: "launch" as const, mint: "RUN", symbol: "RUN", at: T, price: 1, liquidity: 500_000, onCurve: false, sizeUsd: 12, plan, atr15: 0.05, ticks, c15 };
  const without = simulate(base)!, withAdds = simulate({ ...base, adds: rule })!;
  assert.equal(withAdds.adds, 2);
  assert.ok(withAdds.pnl > without.pnl, `with ${withAdds.pnl.toFixed(2)} vs without ${without.pnl.toFixed(2)}`);
  assert.equal(withAdds.costUsd, 24);
});

test("which modes add: launch, dip, ultra, pullback; not trusted copies or your picks", () => {
  for (const m of ["launch", "dip", "ultra", "pullback"] as const) assert.ok(addRuleFor(m), m);
  for (const m of ["trusted", "pick", "ride", "bounce"] as const) assert.equal(addRuleFor(m), undefined, m);
  assert.equal(addRuleFor("launch", { addAtGains: [] }), undefined, "the lab's no-adds row switches it off");
});

test("replay: the honest downside, a sharp reversal right after an add", () => {
  // Up to +65%, add, then a straight drop: the stop sits at the new average but is judged on 15m closes,
  // so the exit fills at the close below it. Without the add this trade is about flat; with it, a small loss.
  const closes = [1.1, 1.3, 1.65, 1.2, 1.0];
  const c15 = closes.map((c, i) => ({ t: T + i * M15, o: i ? closes[i - 1] : 1, h: Math.max(c, i ? closes[i - 1] : 1), l: Math.min(c, i ? closes[i - 1] : 1), c, v: 1 }));
  const ticks = [{ at: T, price: 1, liquidity: 500_000 }, ...closes.map((c, i) => ({ at: T + (i + 1) * M15 + 60_000, price: c, liquidity: 500_000 }))];
  const plan = () => ({ hardFloorPct: 0.4, closeStopPrice: 0.65, takeProfits: [{ gain: 1, sell: 0.5 }], trailPct: 0.3, trailAfterGain: 0.5, maxHoldMs: 0 });
  const base = { mode: "launch" as const, mint: "REV", symbol: "REV", at: T, price: 1, liquidity: 500_000, onCurve: false, sizeUsd: 12, plan, atr15: 0.05, ticks, c15 };
  const without = simulate(base)!, withAdd = simulate({ ...base, adds: rule })!;
  assert.equal(withAdd.adds, 1);
  assert.ok(withAdd.pnl < without.pnl, "the add costs a little here");
  assert.ok(withAdd.pnl > -3, `loss stays small: ${withAdd.pnl.toFixed(2)}`);
});
