import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { divergence, flowFromTrades, flowVerdict, microTrades } = await import("../src/data/flow.js");

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

test("Minter is on the block list, and a coin caught with bot buys is blocked for a day", async () => {
  const { blockedWhy, blockMint } = await import("../src/data/flow.js");
  assert.match(blockedWhy("3NxfWMHmfQg8NJFW5AG1ti2xACdczWz24e9SKyk1pump")!, /block list/);
  assert.equal(blockedWhy("FRESHxxxx"), null);
  blockMint("FRESHxxxx", "bot buys: 2.3 buys per sell");
  assert.match(blockedWhy("FRESHxxxx")!, /blocked for 24h: bot buys/);
});

test("micro-trade bots are caught from the snapshot alone (18 Oct hot list)", () => {
  const snap = (b5: number, s5: number, v5: number) => ({ buys5m: b5, sells5m: s5, volume5m: v5, volume1h: 0 });
  // Bots: thousands of trades averaging cents to a dollar or two.
  assert.match(microTrades(snap(1995, 1894, 6534))!, /bot volume: 3889 trades in 5m averaging \$1\.68/);   // FOMO
  assert.ok(microTrades(snap(2261, 1685, 1915)));   // GTA 6 Coin, $0.49
  assert.ok(microTrades(snap(1143, 576, 2765)));    // ₽, $1.61
  // Real coins on the same list: $25-150 a trade.
  assert.equal(microTrades(snap(262, 175, 29131)), null);   // SUPERCORE $67
  assert.equal(microTrades(snap(187, 168, 36674)), null);   // TSI $103
  assert.equal(microTrades(snap(10, 10, 493)), null);       // VELUM, quiet
  assert.equal(microTrades(snap(40, 30, 50)), null, "too few trades to judge");
  // Hour view when 5m is quiet.
  assert.ok(microTrades({ buys5m: 5, sells5m: 5, volume5m: 20, buys1h: 500, sells1h: 400, volume1h: 2000 }));
});

test("fake valuations are caught from the snapshot (USDF, 18 Oct)", async () => {
  const { fakeValuation } = await import("../src/data/flow.js");
  const NOW = Date.now(), H = 3_600_000;
  const c = (mcap: number, liq: number, ageH: number, b5 = 100, s5 = 100, onCurve = false) => fakeValuation({ mcapUsd: mcap, liquidityUsd: liq, createdAt: NOW - ageH * H, onCurve, buys5m: b5, sells5m: s5, volume24h: mcap * 5 }, NOW);
  assert.match(c(171_291_005, 1_116_375, 0.24, 2381, 218)!, /\$171M market cap at 14 minutes old/);
  assert.match(c(30e6, 400_000, 5)!, /75x the pool/, "older than 2h but 75x its pool");
  assert.match(c(800_000, 60_000, 3, 2381, 218)!, /bot buys: 2381 buys to 218 sells/);
  // Real coins from the same list stay.
  assert.equal(c(353_106, 58_399, 5.9, 47, 60), null);            // TSI 6x
  assert.equal(c(75_406, 22_636, 0.65, 206, 173), null);          // NIP 3x
  assert.equal(c(704_065, 78_960, 5.25, 216, 217), null);         // SUPERCORE 9x
  assert.equal(c(42_334_570, 1_057_433, 1159, 0, 1), null);       // ZCAT 40x, old flagship
  assert.equal(c(79_943_450, 2_195_097, 1779, 3, 0), null);       // STONK 36x
  assert.equal(c(120e6, 1e6, 2000), null, "old big coins are judged by other rules");
  assert.equal(c(900, 0, 0.1, 10, 0, true), null);
});

test("a valuation nobody traded to is fake (Glow, 18 Oct)", async () => {
  const { fakeValuation } = await import("../src/data/flow.js");
  const NOW = Date.now(), H = 3_600_000;
  const c = (mcap: number, liq: number, ageH: number, vol24: number) => fakeValuation({ mcapUsd: mcap, liquidityUsd: liq, createdAt: NOW - ageH * H, onCurve: false, buys5m: 10, sells5m: 10, volume24h: vol24 }, NOW);
  assert.match(c(6_892_542, 222_285, 0.25, 102_055)!, /only \$102k ever traded/);   // Glow, 31x pool so the pool rule missed it
  assert.equal(c(368_392, 59_715, 6, 4_616_492), null);       // TSI
  assert.equal(c(704_065, 78_960, 5.25, 2_226_149), null);    // SUPERCORE
  assert.equal(c(167_137, 35_507, 20.5, 738_285), null);      // ZeroFee
  assert.equal(c(2_838_666, 170_802, 37.7, 3_661_477), null); // ELON, older than a day
  assert.equal(c(900_000, 80_000, 2, 50_000), null, "under $1M: other rules judge it");
});

test("SXSITBL (19 Oct): a coin under 6 hours old isn't flagged for buyers outnumbering sellers in a dip", () => {
  const now = Date.now();
  assert.equal(divergence({ buys1h: 1800, sells1h: 1000, change1h: -17, createdAt: now - 2 * 3_600_000 }, now), null);
  assert.match(divergence({ buys1h: 1800, sells1h: 1000, change1h: -17, createdAt: now - 8 * 3_600_000 }, now)!, /bot buys/);
});
