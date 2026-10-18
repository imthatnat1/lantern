import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { db } = await import("../src/db.js");
const { periodStats } = await import("../src/server.js");

const H = 3_600_000, NOW = Date.now();

function closed(mode: string, pnl: number, entryAgoH: number, closedAgoH: number) {
  db.prepare(`INSERT INTO positions (mode,mint,symbol,entry_price,entry_at,qty,remaining_qty,cost_usd,peak_price,peak_close,last_good_price,last_good_at,atr15,liquidity_at_entry,plan,realized_usd,status,closed_at)
    VALUES (?,?,?,1,?,1,0,5,1,1,1,?,0,0,'{}',?,'closed',?)`).run(mode, "M" + Math.random(), "X", NOW - entryAgoH * H, NOW, pnl, NOW - closedAgoH * H);
}

test("period stats: wins, losses, profit factor, hold time, per mode, and the window", () => {
  closed("pullback", 4, 5, 3);     // win, held 2h
  closed("pullback", -1, 4, 2);    // loss, held 2h
  closed("ultra", -1, 3, 1);       // loss, held 2h
  closed("ultra", 9, 60, 50);      // older than 24h: only in 7d and all
  db.prepare("INSERT INTO signals_log(mode,mint,symbol,score,taken,reason,price,at) VALUES('pullback','A','A',0,0,'x',1,?),('pullback','A','A',0,0,'y',1,?),('ultra','B','B',0,0,'z',1,?)")
    .run(NOW - H, NOW - 2 * H, NOW - H);

  const d = periodStats(NOW - 24 * H);
  assert.equal(d.n, 3);
  assert.equal(d.wins, 1);
  assert.equal(d.pnl, 2);
  assert.equal(d.avgWin, 4);
  assert.equal(d.avgLoss, -1);
  assert.equal(d.profitFactor, 2);
  assert.equal(d.avgHoldMs, 2 * H);
  assert.equal(d.bought, 3);
  assert.equal(d.looked, 2, "one look per mode and coin");
  assert.equal(d.byMode.pullback.n, 2);
  assert.equal(d.byMode.ultra.pnl, -1);
  assert.equal(d.byMode.trusted.n, 0, "modes with no trades still appear");

  const all = periodStats(0);
  assert.equal(all.n, 4);
  assert.equal(all.pnl, 11);
});

test("no trades yet: nulls, not NaN", () => {
  const s = periodStats(NOW + H);
  assert.equal(s.n, 0);
  assert.equal(s.avgWin, null);
  assert.equal(s.profitFactor, null);
  assert.equal(s.avgHoldMs, null);
});

test("scored: total matches the parts, zero parts dropped", async () => {
  const { scored } = await import("../src/strategies/base.js");
  const r = scored({ setup: 60, "holder growth": 10, "creative pair": 0, snipers: -4 });
  assert.equal(r.score, 66);
  assert.deepEqual(r.scoreParts, { setup: 60, "holder growth": 10, snipers: -4 });
});
