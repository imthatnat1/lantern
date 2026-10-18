import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { divergence, flowFromTrades, flowVerdict } = await import("../src/data/flow.js");

test("Minter on 18 Oct: 6,820 buys vs 2,963 sells in the hour, price -24.8%, is flagged", () => {
  assert.match(divergence({ buys1h: 6820, sells1h: 2963, change1h: -24.82 })!, /bot buys: 2\.3 buys per sell/);
});
test("lots of buys with price rising is fine", () => {
  assert.equal(divergence({ buys1h: 6820, sells1h: 2963, change1h: 18 }), null);
});
test("quiet coins aren't judged on a handful of trades", () => {
  assert.equal(divergence({ buys1h: 40, sells1h: 10, change1h: -30 }), null);
});

const T = (kind: "buy" | "sell", usd: number, from: string, i: number) => ({ kind, usd, from, at: i * 1000 });

test("mostly sub-$1 buys from a wallet farm = bot volume", () => {
  const trades = [
    ...Array.from({ length: 200 }, (_, i) => T("buy", 0.02 + (i % 5) * 0.01, `bot${i % 40}`, i)),
    ...Array.from({ length: 40 }, (_, i) => T("buy", 30 + i, `real${i}`, 300 + i)),
    ...Array.from({ length: 60 }, (_, i) => T("sell", 120, `seller${i}`, 400 + i)),
  ];
  assert.match(flowVerdict(flowFromTrades(trades))!, /bot volume: 83% of the last 240 buys were under \$1/);
});
test("three wallets doing half the buying = bot volume", () => {
  const trades = [
    ...Array.from({ length: 60 }, (_, i) => T("buy", 25, `farm${i % 3}`, i)),
    ...Array.from({ length: 40 }, (_, i) => T("buy", 25, `real${i}`, 100 + i)),
  ];
  assert.match(flowVerdict(flowFromTrades(trades))!, /3 wallets made 60%/);
});
test("sellers dumping twice the dollars buyers bring = real money is selling", () => {
  const trades = [
    ...Array.from({ length: 60 }, (_, i) => T("buy", 20, `b${i}`, i)),
    ...Array.from({ length: 40 }, (_, i) => T("sell", 80, `s${i}`, 100 + i)),
  ];
  assert.match(flowVerdict(flowFromTrades(trades))!, /real money is selling: \$3200 sold vs \$1200 bought/);
});
test("organic flow passes: spread wallets, real sizes, balanced dollars", () => {
  const trades = [
    ...Array.from({ length: 120 }, (_, i) => T("buy", 15 + (i % 30) * 4, `b${i}`, i)),
    ...Array.from({ length: 90 }, (_, i) => T("sell", 20 + (i % 20) * 5, `s${i}`, 200 + i)),
  ];
  assert.equal(flowVerdict(flowFromTrades(trades)), null);
});
