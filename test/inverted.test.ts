import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { ohlcvUrl } = await import("../src/data/gecko.js");
const { tradeKind } = await import("../src/data/flow.js");
const { notePairMint, mintForPair } = await import("../src/data/pairmint.js");

const ZCAT = "HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR", POOL = "BTccxxTFi7a9xJTE1exKn38Jgie35s6gNeRxd8DM61Rc";

test("ZCAT/ZEC (21 Oct): the chart call names our coin, so GeckoTerminal charts ZCAT, not ZEC", () => {
  assert.match(ohlcvUrl(POOL, 5, 288, ZCAT), new RegExp(`&token=${ZCAT}$`));
  assert.doesNotMatch(ohlcvUrl(POOL, 5, 288), /token=/);
});

test("pool -> coin is learned from DexScreener", () => {
  notePairMint(POOL, ZCAT);
  assert.equal(mintForPair(POOL), ZCAT);
});

test("trade side follows our coin, not GeckoTerminal's base (real ZCAT/ZEC trades, 21 Oct)", () => {
  // GeckoTerminal said "sell" while ZCAT went TO the trader: a ZCAT buy.
  assert.equal(tradeKind({ kind: "sell", from_token_address: "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS", to_token_address: ZCAT }, ZCAT), "buy");
  assert.equal(tradeKind({ kind: "buy", from_token_address: ZCAT, to_token_address: "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS" }, ZCAT), "sell");
  assert.equal(tradeKind({ kind: "sell" }, ZCAT), "sell");   // no addresses: keep GeckoTerminal's word
});

test("stored ZEC-priced candles are dropped against ZCAT's live price; real moves stay", async () => {
  const { sane } = await import("../src/data/livecandles.js");
  const k = (t: number, p: number) => ({ t, o: p, h: p * 1.02, l: p * 0.98, c: p, v: 1 });
  const rows = [k(1, 1235), k(2, 1240), k(3, 0.06), k(4, 0.055), k(5, 0.2)];   // two ZEC rows, ZCAT rows incl. a real 3.6x
  const out = sane(rows, 0.056);
  assert.deepEqual(out.map(r => r.t), [3, 4, 5]);
  assert.equal(sane(rows, undefined).length, 5);   // no reference yet: serve as is
});
