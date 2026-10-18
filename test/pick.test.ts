import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { kv } = await import("../src/db.js");
const { pickBuy, pickPlan } = await import("../src/strategies/pick.js");

const env = { marks: new Map<string, number>(), feedHealthy: true, solPrice: 150 };

test("picks refuse bad input and respect Global stop before any network call", async () => {
  assert.equal((await pickBuy("not a mint", env)).why, "that isn't a coin address");
  kv.set("paused", true);
  assert.match((await pickBuy("So11111111111111111111111111111111111111112", env)).why!, /Global stop/);
  kv.set("paused", false);
});

test("pick exit plan: stop under the recent low, capped at 30% loss; half off at +50%; 20% trail after +30%", () => {
  const p = pickPlan(0.9)(1, 0.02);
  assert.ok(p.closeStopPrice < 0.9 && p.closeStopPrice >= 0.7);
  assert.equal(pickPlan(0.2)(1, 0.02).closeStopPrice, 0.7, "a deep low clamps at 30% under entry");
  assert.deepEqual(p.takeProfits, [{ gain: 0.5, sell: 0.5 }]);
  assert.equal(p.trailPct, 0.2);
  assert.equal(p.maxHoldMs, 24 * 3_600_000);
});
