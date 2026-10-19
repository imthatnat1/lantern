import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { db, positions } = await import("../src/db.js");

const H = 3_600_000, NOW = Date.now(), MIDNIGHT = NOW - 7 * H;
const pos = (id: number, entryAt: number, cost: number, qty: number, closedAt: number) => {
  db.prepare(`INSERT INTO positions(id,mode,mint,symbol,entry_price,entry_at,qty,remaining_qty,cost_usd,peak_price,peak_close,last_good_price,last_good_at,atr15,liquidity_at_entry,plan,status,closed_at)
    VALUES(?, 'ride', 'M'||?, 'S', 1, ?, ?, 0, ?, 1, 1, 1, ?, 0, 0, '{}', 'closed', ?)`).run(id, id, entryAt, qty, cost, entryAt, closedAt);
  db.prepare("INSERT INTO fills(position_id,side,mode,mint,qty,price_usd,gross_usd,fees_usd,net_usd,reason,at) VALUES(?, 'buy', 'ride', 'M'||?, ?, 1, ?, 0, ?, 'x', ?)").run(id, id, qty, cost, cost, entryAt);
};
const sell = (id: number, qty: number, net: number, at: number) =>
  db.prepare("INSERT INTO fills(position_id,side,mode,mint,qty,price_usd,gross_usd,fees_usd,net_usd,reason,at) VALUES(?, 'sell', 'ride', 'M'||?, ?, 1, ?, 0, ?, 'x', ?)").run(id, id, qty, net, net, at);

test("today's P&L: FTR bought yesterday at $8, stopped after midnight for $6.20, is a $1.80 loss, not a $6.20 gain", () => {
  pos(1, MIDNIGHT - 6 * H, 8, 100, MIDNIGHT + H); sell(1, 100, 6.2, MIDNIGHT + H);
  assert.equal(Math.round(positions.realizedSince(MIDNIGHT) * 100) / 100, -1.8);
});

test("today's P&L: a half sold today counts half the cost", () => {
  pos(2, MIDNIGHT + 2 * H, 4, 100, MIDNIGHT + 3 * H); sell(2, 50, 4, MIDNIGHT + 3 * H);   // half at 2x: +$2
  assert.equal(Math.round(positions.realizedSince(MIDNIGHT) * 100) / 100, 0.2);
});
