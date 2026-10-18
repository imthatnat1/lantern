import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
process.env.DASHBOARD_TOKEN = "";
const { db } = await import("../src/db.js");
const { activity } = await import("../src/server.js");

test("last hour: coins checked, setups, and rejections grouped in plain words", () => {
  const now = Date.now();
  const tick = db.prepare("INSERT INTO ticks(mint,at,price) VALUES(?,?,?)");
  for (const m of ["A", "B", "C", "D", "E"]) tick.run(m, now - 60_000, 1);
  tick.run("OLD", now - 2 * 3_600_000, 1);
  const look = db.prepare("INSERT INTO signals_log(mode,mint,symbol,score,taken,reason,price,at,setup) VALUES(?,?,?,?,?,?,?,?,?)");
  look.run("ride", "A", "A", 0, 0, "rejected: bot buys: 2.3 buys per sell in the last hour but price is down 25%", 1, now - 5 * 60_000, null);
  look.run("pullback", "B", "B", 0, 0, "rejected: top 10 hold 70%", 1, now - 5 * 60_000, null);
  look.run("dip", "C", "C", 0, 0, "rejected: honeypot: transfer hook (can block sells)", 1, now - 5 * 60_000, null);
  look.run("dip", "D", "D", 0, 0, "dip found, waiting for a green 5m reclaim", 1, now - 5 * 60_000, JSON.stringify({ need: "x" }));
  const a = activity(now);
  assert.equal(a.checked, 5);
  assert.equal(a.setups, 1);
  assert.equal(a.rejected, 3);
  assert.deepEqual(a.rejectedBy, { "bot volume": 1, "rug risk": 1, honeypot: 1 });
  assert.equal(a.bought, 0);
});
