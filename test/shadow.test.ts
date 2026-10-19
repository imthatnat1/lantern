import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { worseBy, shadowSummary } = await import("../src/engine/shadow.js");
const { db } = await import("../src/db.js");

test("shadow live: a real buy at a higher price, or a real sell at a lower one, counts as worse", () => {
  assert.ok(Math.abs(worseBy("buy", 1.0, 1.03) - 0.03) < 1e-9);
  assert.ok(Math.abs(worseBy("sell", 1.0, 0.97) - 0.03) < 1e-9);
  assert.ok(worseBy("buy", 1.0, 0.99) < 0, "a better real fill shows as negative");
});

test("shadow summary: average gap, dollar effect, and trades Jupiter couldn't route", () => {
  const now = Date.now();
  const ins = db.prepare("INSERT INTO shadow_quotes(position_id, mode, symbol, side, at, usd, paper_price, real_price, impact_pct, worse_pct, routed) VALUES(1,'launch','A',?,?,?,1,1,0.01,?,?)");
  ins.run("buy", now - 1000, 12, 0.02, 1);
  ins.run("sell", now - 500, 18, 0.04, 1);
  ins.run("buy", now - 100, 6, null, 0);
  const s = shadowSummary(now - 3_600_000);
  assert.equal(s.n, 3); assert.equal(s.priced, 2); assert.equal(s.noRoute, 1);
  assert.ok(Math.abs(s.avgWorsePct! - 0.03) < 1e-9);
  assert.ok(Math.abs(s.usdEffect - (12 * 0.02 + 18 * 0.04)) < 1e-9);
});
