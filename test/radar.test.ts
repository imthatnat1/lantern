import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { db, market } = await import("../src/db.js");
const { radarList, radarDumpedWhy } = await import("../src/server.js");
const { setNatWatch, natWatchMints, isNatWatched } = await import("../src/data/natwatch.js");
const { watchedMints } = await import("../src/strategies/base.js");

const NOW = Date.now(), M = 60_000;
const look = (mint: string, reason: string, ago: number) =>
  db.prepare("INSERT INTO signals_log(mode,mint,symbol,score,taken,reason,price,at) VALUES('launch',?,?,0,0,?,1,?)").run(mint, mint, reason, NOW - ago);
const mk = (mint: string, liq: number, vol5m: number) => market.upsert({ mint, symbol: mint, name: mint, pairAddress: "P" + mint, quoteSymbol: "SOL", priceUsd: 1,
  liquidityUsd: liq, mcapUsd: liq * 3, volume24h: 1, volume1h: 1, volume5m: vol5m, buys5m: 30, sells5m: 20, change5m: 1, change1h: 20, change6h: 20, change24h: 20,
  createdAt: NOW - 40 * M, onCurve: false, fetchedAt: NOW } as any);

test("radar: fresh launch looks with a real pool, waiting reasons only, busiest first", () => {
  look("BUSY", "only 18 buys in 5m, no crowd yet", 3 * M); mk("BUSY", 30_000, 9_000);
  look("QUIET", "buys only 1.10x sells in 5m, needs 1.3x", 2 * M); mk("QUIET", 20_000, 1_000);
  look("DEAD", "too thin, $2k liquidity (launch needs $10k)", M); mk("DEAD", 2_000, 50);
  look("SCAM", "rejected: copycat brand clone", M); mk("SCAM", 40_000, 5_000);
  look("OLD", "only 5 buys in 5m, no crowd yet", 60 * M); mk("OLD", 30_000, 9_000);
  const r = radarList(NOW).map(x => x.mint);
  assert.deepEqual(r, ["BUSY", "QUIET"]);
});

test("Watch: a tapped coin goes first on the radar and first in every mode's scan, for 3 days", () => {
  setNatWatch("QUIET", "QUIET", true, NOW);
  assert.equal(radarList(NOW)[0].mint, "QUIET");
  assert.equal(radarList(NOW)[0].watched, true);
  assert.equal(watchedMints("dip", NOW)[0], "QUIET");
  assert.ok(isNatWatched("QUIET", NOW));
  assert.ok(!isNatWatched("QUIET", NOW + 73 * 3_600_000), "expires after 3 days");
  setNatWatch("QUIET", "QUIET", false, NOW);
  assert.deepEqual(natWatchMints(NOW), []);
});

test("radar: rugged and dumping coins come off (SpaceX, 20 Oct: -78% in one candle)", () => {
  assert.match(radarDumpedWhy({ ch5m: -78, ch1h: -60 }, "only 12 buys in 5m", NOW)!, /down 78% in 5m/);
  assert.match(radarDumpedWhy({ ch5m: -5, ch1h: -55 }, "x", NOW)!, /down 55% in 1h/);
  assert.match(radarDumpedWhy({ ch5m: 0, ch1h: 0 }, "72% off its high, first leg stalling", NOW)!, /72% off its high/);
  assert.match(radarDumpedWhy({ ch5m: 0, ch1h: 0, updated_at: NOW - 20 * M }, "x", NOW)!, /no fresh price/);
  assert.equal(radarDumpedWhy({ ch5m: 3, ch1h: 40, updated_at: NOW - M }, "18% off its high, first leg stalling", NOW), null);
  look("RUG", "only 18 buys in 5m, no crowd yet", M);
  market.upsert({ mint: "RUG", symbol: "RUG", name: "RUG", pairAddress: "PRUG", quoteSymbol: "SOL", priceUsd: 1, liquidityUsd: 30_000, mcapUsd: 90_000,
    volume24h: 1, volume1h: 1, volume5m: 20_000, buys5m: 30, sells5m: 80, change5m: -78, change1h: -60, change6h: 0, change24h: 0, createdAt: NOW - 40 * M, onCurve: false, fetchedAt: NOW } as any);
  assert.ok(!radarList(NOW).map(x => x.mint).includes("RUG"));
});
