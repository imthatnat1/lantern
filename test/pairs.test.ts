import { test } from "node:test";
import assert from "node:assert/strict";

test("batch lookup keeps only the coins we asked about (USDC, WBTC, STRK showed up as fresh launches, 19 Oct)", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ pairs: [
    { chainId: "solana", pairAddress: "P1", baseToken: { address: "NEWCOIN", symbol: "NEW", name: "New" }, quoteToken: { address: "SOL", symbol: "SOL" }, priceUsd: "0.001", liquidity: { usd: 20000 } },
    { chainId: "solana", pairAddress: "P2", baseToken: { address: "USDC", symbol: "USDC", name: "USD Coin" }, quoteToken: { address: "NEWCOIN", symbol: "NEW" }, priceUsd: "1", liquidity: { usd: 9000 } },
  ] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const { pairsByMint } = await import("../src/data/dexscreener.js");
    const m = await pairsByMint(["NEWCOIN"]);
    assert.deepEqual([...m.keys()], ["NEWCOIN"]);
  } finally { globalThis.fetch = realFetch; }
});
