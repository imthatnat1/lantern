import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";

const { readPrice, _resetPending } = await import("../src/engine/price.js");
const { evaluate, structuralStop } = await import("../src/engine/exits.js");
import type { Position, Candle } from "../src/types.js";

function pos(entry: number, over: Partial<Position> = {}): Position {
  return {
    id: 1, mode: "ultra", mint: "M", symbol: "T", entryPrice: entry, entryAt: 0, qty: 100, remainingQty: 100,
    costUsd: 100 * entry, peakPrice: entry, peakClose: entry, lastGoodPrice: entry, lastGoodAt: 0, atr15: entry * 0.05,
    liquidityAtEntry: 100_000,
    plan: { hardFloorPct: 0.55, closeStopPrice: entry * 0.7, takeProfits: [{ gain: 1, sell: 0.33 }], trailPct: 0.3, trailAfterGain: 0.5, maxHoldMs: 0 },
    tpTaken: [], realizedUsd: 0, status: "open", meta: {}, ...over,
  };
}
const candle = (t: number, c: number, o = c, h = c, l = c): Candle => ({ t, o, h, l, c, v: 1000 });

test("STONK: a -99% junk tick with a sane second source does not fill a stop", async () => {
  _resetPending();
  const sources = { primary: async () => 0.01, secondary: async () => 1.0 };
  const read = await readPrice("STONK", 1.0, sources, 1000);
  assert.ok(read && !read.confirmed, "tick should be unconfirmed");
  const p = pos(1.0);
  const actions = evaluate(p, read!, undefined, 1000);
  assert.deepEqual(actions, [], "no sell on an unconfirmed tick");
  assert.equal(p.lastGoodPrice, 1.0, "last good price untouched");
});

test("junk tick with no second source: still unconfirmed until the next tick agrees", async () => {
  _resetPending();
  const sources = { primary: async () => 0.01, secondary: async () => null };
  const r1 = await readPrice("DARK", 1.0, sources, 1000);
  assert.ok(r1 && !r1.confirmed);
  // Next tick recovers: primary says 1.0 again. Pending is dropped, normal read.
  const back = { primary: async () => 0.98, secondary: async () => null };
  const r2 = await readPrice("DARK", 1.0, back, 7000);
  assert.ok(r2 && r2.confirmed && r2.price === 0.98);
});

test("real rug: two agreeing ticks 5s apart confirm, hard floor fills", async () => {
  _resetPending();
  const sources = { primary: async () => 0.05, secondary: async () => null };
  const r1 = await readPrice("RUG", 1.0, sources, 1000);
  assert.ok(!r1!.confirmed);
  const r2 = await readPrice("RUG", 1.0, sources, 6500);
  assert.ok(r2!.confirmed, "second agreeing tick confirms");
  const actions = evaluate(pos(1.0), r2!, undefined, 6500);
  assert.equal(actions.length, 1);
  assert.match(actions[0].reason, /hard floor/);
});

test("real rug: second source agrees immediately, no delay", async () => {
  _resetPending();
  const sources = { primary: async () => 0.05, secondary: async () => 0.052 };
  const r = await readPrice("RUG2", 1.0, sources, 1000);
  assert.ok(r!.confirmed);
});

test("Irene: a wick to -52% does not fill. The 15m close above the stop holds the position", () => {
  const p = pos(1.0, { plan: { hardFloorPct: 0.55, closeStopPrice: 0.72, takeProfits: [], trailPct: 0.3, trailAfterGain: 0.5, maxHoldMs: 0 } });
  // Confirmed tick at -52% (it really traded there for a moment). Floor is -55%, so no tick fill.
  const wick = { price: 0.48, at: 1000, confirmed: true, source: "primary" };
  let actions = evaluate(p, wick, undefined, 1000);
  assert.deepEqual(actions, []);
  // Candle closes at 0.80, above the 0.72 close stop. Still held.
  actions = evaluate(p, { price: 0.80, at: 900_000, confirmed: true, source: "primary" }, candle(900_000, 0.80, 0.95, 0.96, 0.48), 900_000);
  assert.deepEqual(actions, []);
  // Next candle closes at 0.70. Now it stops, on the close.
  actions = evaluate(p, { price: 0.70, at: 1_800_000, confirmed: true, source: "primary" }, candle(1_800_000, 0.70), 1_800_000);
  assert.equal(actions.length, 1);
  assert.match(actions[0].reason, /close stop/);
});

test("take profit fires once, trail ratchets the close stop up and only up", () => {
  const p = pos(1.0);
  let a = evaluate(p, { price: 2.1, at: 1, confirmed: true, source: "p" }, candle(1, 2.1), 1);
  assert.equal(a.length, 1); assert.match(a[0].reason, /TP/);
  a = evaluate(p, { price: 2.2, at: 2, confirmed: true, source: "p" }, undefined, 2);
  assert.deepEqual(a, [], "TP does not fire twice");
  // Peak close 2.1, gain 110% -> base trail 30% -> stop lifted to 2.1*0.70 = 1.47
  assert.ok(Math.abs(p.plan.closeStopPrice - 1.47) < 1e-9);
  // A lower close later must not lower the stop.
  evaluate(p, { price: 1.6, at: 900_001, confirmed: true, source: "p" }, candle(900_001, 1.6), 900_001);
  assert.ok(Math.abs(p.plan.closeStopPrice - 1.47) < 1e-9);
});

test("structuralStop clamps to max loss and never sits above entry", () => {
  assert.equal(structuralStop(1.0, 0.9, 0.05, 1, 0.5), 0.85);
  assert.equal(structuralStop(1.0, 0.2, 0.05, 1, 0.5), 0.5);
  assert.equal(structuralStop(1.0, 1.5, 0.0, 1, 0.3), 0.7);
});
