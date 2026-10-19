import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { kv, fills, db, usdAudNow } = await import("../src/db.js");
const { audSummary } = await import("../src/data/fx.js");

test("every fill stores the USD/AUD rate of its moment; stale rates aren't used", () => {
  const now = Date.now();
  kv.set("fx:usdaud", { rate: 1.5, at: now - 60_000 });
  assert.equal(usdAudNow(now), 1.5);
  assert.equal(usdAudNow(now + 4 * 86_400_000), null, "a rate older than 3 days isn't trusted");
  fills.insert({ side: "buy", mint: "M", mode: "dip", qty: 100, priceUsd: 0.1, grossUsd: 10, feesUsd: 0.2, netUsd: 10, reason: "x", at: now }, 1);
  assert.equal((db.prepare("SELECT usd_aud FROM fills WHERE position_id=1").get() as any).usd_aud, 1.5);
});

test("realised AUD P&L uses the rate on the day of each buy and each sale", () => {
  const now = Date.now();
  // Bought $10 at 1.50 (A$15 cost). Rate moves to 1.60. Sold half for $8 (A$12.80) and half for $6 (A$9.60).
  kv.set("fx:usdaud", { rate: 1.6, at: now });
  fills.insert({ side: "sell", mint: "M", mode: "dip", qty: 50, priceUsd: 0.16, grossUsd: 8, feesUsd: 0, netUsd: 8, reason: "TP", at: now }, 1);
  fills.insert({ side: "sell", mint: "M", mode: "dip", qty: 50, priceUsd: 0.12, grossUsd: 6, feesUsd: 0, netUsd: 6, reason: "trail", at: now }, 1);
  const a = audSummary(300, 250, 20, now);
  assert.equal(a.rate, 1.6);
  assert.ok(Math.abs(a.realizedAud - (12.8 - 7.5 + 9.6 - 7.5)) < 1e-9, `realised ${a.realizedAud}`);
  assert.equal(a.equityAud, 480);
  assert.equal(a.fillsWithoutRate, 0);
});
