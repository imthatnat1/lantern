process.env.DB_PATH = ":memory:";
import { test } from "node:test";
import assert from "node:assert/strict";
const { db } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const broker = await import("../src/engine/broker.js");

/** One closed position with a realized loss, written straight to the tables. */
function lose(mode: string, usd: number, at = Date.now()) {
  const mint = `M${mode}${Math.random()}`;
  const id = db.prepare(`INSERT INTO positions(mode, mint, symbol, entry_price, entry_at, qty, remaining_qty, cost_usd, peak_price, peak_close,
    last_good_price, last_good_at, atr15, liquidity_at_entry, plan, status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mode, mint, "X", 1, at - 60_000, 10, 0, 10, 1, 1, 1, at, 0, 50_000, "{}", "closed").lastInsertRowid;
  db.prepare("INSERT INTO fills(position_id, side, mode, mint, qty, price_usd, gross_usd, fees_usd, net_usd, reason, at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "sell", mode, mint, 10, 1, 10 - usd, 0, 10 - usd, "stop", at);
}

test("each mode has its own daily loss cap; one bad mode doesn't stop the others", () => {
  assert.equal(config.risk.modeDailyLossUsd, 15);
  assert.equal(config.pausedModes.length, 0, "nothing paused by default (Nat, 20 Oct: test every mode)");
  lose("bounce", 9); lose("bounce", 7);
  lose("ultra", 4);
  assert.ok(broker.modeStopped("bounce"), "bounce lost $16 today: sits out");
  assert.ok(!broker.modeStopped("ultra"), "ultra lost $4: still trading");
  assert.ok(!broker.modeStopped("dip"));
  assert.ok(Math.abs(broker.realizedToday() - -20) < 1e-9, "whole-bot total still adds up");
  assert.ok(broker.realizedToday() > -config.risk.dailyLossStopUsd, "under the $60 backstop");
});
