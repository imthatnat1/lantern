import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { db, reprice } = await import("../src/db.js");
const { honest } = await import("../src/server.js");

const NOW = Date.now();
const look = (mint: string, price: number) => db.prepare("INSERT INTO signals_log(mode,mint,symbol,score,taken,reason,price,at,peak_price,last_price,pair) VALUES('ride',?,?,0,0,'x',?,?,?,?, 'P')").run(mint, mint, price, NOW - 60_000, price, price);
const row = (mint: string) => db.prepare("SELECT peak_price, low_price, low_before_peak FROM signals_log WHERE mint=?").get(mint) as any;

test("miss cards: the drop before the peak is kept, later dips don't overwrite it", () => {
  look("ELON", 1.0);
  for (const p of [0.8, 0.7, 0.9, 1.4, 1.8, 1.2]) reprice("ELON", "P", p, NOW, NOW - 3_600_000);
  const r = row("ELON");
  assert.equal(r.peak_price, 1.8);
  assert.equal(r.low_before_peak, 0.7, "fell 30% before it ran");
  assert.equal(r.low_price, 0.7);
  assert.equal(honest({ mode: "dip", reason: "x", price: 1.0, low_before_peak: r.low_before_peak }).fellFirst?.toFixed(2), "0.30");
});

test("a coin that went straight up fell nothing first", () => {
  look("PIERRE", 1.0);
  for (const p of [1.5, 3, 8]) reprice("PIERRE", "P", p, NOW, NOW - 3_600_000);
  assert.equal(row("PIERRE").low_before_peak, 1.0);
});

test("reasons we've already fixed or paused are marked", () => {
  assert.match(honest({ mode: "dip", reason: "couldn't check: cooling api.geckoterminal.com", price: 1 }).fixed!, /own charts/);
  assert.match(honest({ mode: "ride", reason: "cooldown after a recent stop-out", price: 1 }).fixed!, /ride is paused/);
  assert.match(honest({ mode: "bounce", reason: "rejected: $43k market cap, under the $45k bounce floor", price: 1 }).fixed!, /bounce is paused/);
  assert.match(honest({ mode: "launch", reason: "$27k market cap, under launch's $60k", price: 1 }).fixed!, /\$10k pool/);
  assert.equal(honest({ mode: "launch", reason: "rejected: top 10 hold 71%", price: 1 }).fixed, null);
  assert.equal(honest({ mode: "dip", reason: "dip is paused: watching only", price: 1 }).fixed, null, "a would-buy isn't a fixed miss");
});
