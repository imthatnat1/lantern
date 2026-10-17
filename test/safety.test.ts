import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { bestPair, tradedPairs } = await import("../src/data/dexscreener.js");
const { realTop10, trapsFromExtensions } = await import("../src/data/rugcheck.js");

// Real DexScreener numbers from 18 Oct.
const wibet = [
  { pairAddress: "meteora-dust", dexId: "meteora", priceUsd: "0.03456", liquidity: { usd: 11_683 }, volume: { h24: 2.03 } },
  { pairAddress: "pumpswap", dexId: "pumpswap", priceUsd: "0.00001333", liquidity: { usd: 8_302 }, volume: { h24: 390_687 } },
  { pairAddress: "pumpfun", dexId: "pumpfun", priceUsd: "0.00004272", volume: { h24: 149_631 } },
];
const ape = [
  { pairAddress: "meteora-dust", dexId: "meteora", priceUsd: "0.00005481", liquidity: { usd: 776 }, volume: { h24: 104 } },
  { pairAddress: "pumpswap", dexId: "pumpswap", priceUsd: "0.000002019", liquidity: { usd: 2_081 }, volume: { h24: 192_764 } },
  { pairAddress: "pumpfun", dexId: "pumpfun", priceUsd: "0.00004301", volume: { h24: 20_300 } },
];

test("wibet: dust Meteora pool with more 'liquidity' loses to the real PumpSwap pair", () => {
  assert.equal(bestPair(wibet)!.pairAddress, "pumpswap");
  assert.ok(!tradedPairs(wibet).some(p => p.pairAddress === "meteora-dust"));
});
test("ApeMaxxing: real pair wins, dust pool ignored", () => {
  assert.equal(bestPair(ape)!.pairAddress, "pumpswap");
});
test("coin still on the curve: the curve pair is the price", () => {
  assert.equal(bestPair([{ pairAddress: "pumpfun", volume: { h24: 5_000 } }])!.pairAddress, "pumpfun");
});

test("top 10 leaves out the bonding curve and pool vaults", () => {
  const rep = {
    topHolders: [
      { pct: 70, owner: "CURVE" }, { pct: 9, address: "VAULT_A" },
      { pct: 4, owner: "w1" }, { pct: 3, owner: "w2" }, { pct: 2, owner: "w3" },
    ],
    knownAccounts: { CURVE: { name: "Pump Fun Bonding Curve", type: "AMM" } },
    markets: [{ pubkey: "POOL", liquidityAAccount: "VAULT_A" }],
  };
  assert.equal(realTop10(rep), 9);
});
test("top 10 still counts a whale wallet", () => {
  assert.equal(realTop10({ topHolders: [{ pct: 40, owner: "whale" }, { pct: 5, owner: "w2" }] }), 45);
});

test("Token-2022 traps are caught, harmless extensions pass", () => {
  assert.equal(trapsFromExtensions([{ extension: "permanentDelegate", state: { delegate: "Dev" } }]).length, 1);
  assert.equal(trapsFromExtensions([{ extension: "transferHook", state: { programId: "Hook" } }]).length, 1);
  assert.equal(trapsFromExtensions([{ extension: "defaultAccountState", state: { accountState: "frozen" } }]).length, 1);
  assert.equal(trapsFromExtensions([{ extension: "nonTransferable" }]).length, 1);
  assert.deepEqual(trapsFromExtensions([
    { extension: "metadataPointer", state: {} }, { extension: "tokenMetadata", state: {} },
    { extension: "permanentDelegate", state: { delegate: null } }, { extension: "transferHook", state: { programId: null } },
  ]), []);
  assert.deepEqual(trapsFromExtensions(undefined), []);
});
