import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { isCopycat, isSlop } = await import("../src/engine/filters.js");
import type { TokenSnapshot } from "../src/types.js";

const snap = (o: Partial<TokenSnapshot>): TokenSnapshot => ({
  mint: "M", symbol: "X", name: "x", priceUsd: 1, liquidityUsd: 50_000, mcapUsd: 100_000, volume24h: 1, volume1h: 1, volume5m: 1,
  buys5m: 1, sells5m: 1, change5m: 0, change1h: 0, change6h: 0, change24h: 0, createdAt: Date.now() - 86_400_000, onCurve: false, fetchedAt: Date.now(), ...o,
});

test("SPCX / SpaceX tokenized stock is a brand clone", () => {
  assert.equal(isCopycat(snap({ symbol: "SPCX", name: "SpaceX - Backpack Securities" })), "brand clone");
});
test("stock, ETF and major tickers are caught, x-suffix too", () => {
  assert.equal(isCopycat(snap({ symbol: "TSLA" })), "stock ticker");
  assert.equal(isCopycat(snap({ symbol: "TSLAx" })), "stock ticker");
  assert.equal(isCopycat(snap({ symbol: "SPY" })), "etf ticker");
  assert.equal(isCopycat(snap({ symbol: "BTC" })), "major ticker");
});
test("ordinary memecoin names pass", () => {
  assert.equal(isCopycat(snap({ symbol: "ZCAT", name: "Zcash Cat" })), null);
  assert.equal(isCopycat(snap({ symbol: "KURP", name: "kurp" })), null);
});
test("slop: cheap domain, social-as-website, thin holders at size, generated ticker", () => {
  assert.match(isSlop(snap({ website: "https://rugriot.com.co" }), 1000)!, /cheap domain/);
  assert.match(isSlop(snap({ website: "https://x.com/i/communities/123" }), 1000)!, /social link/);
  assert.match(isSlop(snap({ mcapUsd: 120_000 }), 200)!, /holders/);
  assert.match(isSlop(snap({ symbol: "ABCD12" }), 1000)!, /generated/);
  assert.equal(isSlop(snap({ symbol: "PURR", website: "https://purr.xyz.com" }), 5000), null);
});
