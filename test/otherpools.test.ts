import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { readPrice, _resetPending } = await import("../src/engine/price.js");

// 20 Oct 15:03: Dacity's Meteora SOL pool said $0.0000014 twice in a row, Jupiter had no price, every other pool said $0.0059.
test("Dacity (20 Oct 15:03): junk drop from one pool, no Jupiter, other pools disagree = never confirmed", async () => {
  _resetPending();
  const src = { primary: async () => 0.000001437, secondary: async () => null, others: async () => [0.00589, 0.005934, 0.005838] };
  for (const t of [1000, 6500, 12000, 18000]) {
    const r = await readPrice("DACITY", 0.00697, src, t);
    assert.equal(r!.confirmed, false, `tick at ${t}`);
    assert.match(r!.note!, /other pools/);
  }
});

test("a real rug: one pool crashes and the other pools crash with it = confirmed at once", async () => {
  _resetPending();
  const src = { primary: async () => 0.0004, secondary: async () => null, others: async () => [0.00042, 0.00039] };
  const r = await readPrice("RUG", 0.007, src, 1000);
  assert.equal(r!.confirmed, true);
  assert.equal(r!.source, "primary+pools");
});

test("a coin with only one pool keeps the next-tick fallback", async () => {
  _resetPending();
  const src = { primary: async () => 0.002, secondary: async () => null, others: async () => [] as number[] };
  assert.equal((await readPrice("ONE", 0.007, src, 1000))!.confirmed, false);
  assert.equal((await readPrice("ONE", 0.007, src, 7000))!.confirmed, true);
});

test("Jupiter disagreeing still wins over pools", async () => {
  _resetPending();
  const src = { primary: async () => 0.000001, secondary: async () => 0.006, others: async () => [0.000001] };
  assert.equal((await readPrice("JUP", 0.007, src, 1000))!.confirmed, false);
});
