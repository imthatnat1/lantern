import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { absorb, isStonkReward, stonkInfo } = await import("../src/data/stonkfun.js");
const { isStonkPair } = await import("../src/data/universe.js");
const { taxPct } = await import("../src/data/tax.js");
const { fillModel } = await import("../src/engine/broker.js");

// Shapes from the live API (17 Oct): a busy xSOL reward coin, a SOL-paired reward coin, $2.9k dust.
const rows = [
  { mint: "9FFLacDF5aMrpjgKiMteSRvYDtx47pFZTDeViPFGqayZ", pool: "Cd6q", symbol: "索拉纳", mode: "reward", status: "new", quote: { symbol: "xSOL" }, market: { marketCapUsd: 17886, volume24hUsd: 79758, liquidityUsd: 0 }, transferFee: { bps: 100 } },
  { mint: "SOLREWARDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", pool: "P2", symbol: "RWD", mode: "reward", status: "graduated", quote: { symbol: "SOL" }, market: { marketCapUsd: 400000, volume24hUsd: 90000, liquidityUsd: 60000 }, transferFee: { bps: 300 } },
  { mint: "G6PujzkpgGvtKbdBmpd3Wi5udbzdVJgyNFWvScgmEP8v", pool: "J8hN", symbol: "CHONKS", mode: "standard", status: "new", quote: { symbol: "STONK" }, market: { marketCapUsd: 2905, volume24hUsd: 0, liquidityUsd: 0 } },
];

test("busy launches are watched, $2.9k dust isn't", () => {
  const keep = absorb(rows);
  assert.deepEqual(keep.sort(), [rows[0].mint, rows[1].mint].sort());
  assert.equal(stonkInfo(rows[2].mint)!.quote, "STONK");
});
test("a SOL-paired reward coin counts as a creative pair: its tax pays holders", () => {
  assert.ok(isStonkReward(rows[1].mint));
  assert.ok(isStonkPair({ mint: rows[1].mint, quoteSymbol: "SOL" }));
  assert.ok(!isStonkPair({ mint: "plain", quoteSymbol: "SOL" }));
});
test("the transfer tax is charged on both sides of a trade", () => {
  assert.equal(taxPct(rows[1].mint), 3);
  const plain = fillModel("buy", 1, 10, 1e9, false, 150, 0).effPrice;
  const taxed = fillModel("buy", 1, 10, 1e9, false, 150, 3).effPrice;
  assert.ok(Math.abs(taxed - plain - 0.03) < 1e-9);
  assert.ok(fillModel("sell", 1, 10, 1e9, false, 150, 3).effPrice < fillModel("sell", 1, 10, 1e9, false, 150, 0).effPrice - 0.029);
});
