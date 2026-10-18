import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { absorb, takeGraduations, isStonkListed, stonkFlagships } = await import("../src/data/stonkfun.js");
const { interleave } = await import("../src/data/universe.js");
const { isSlop } = await import("../src/engine/filters.js");

const tok = (mint: string, status: string, mcap = 1e5, liq = 20_000, vol = 10_000) =>
  ({ mint, status, market: { marketCapUsd: mcap, liquidityUsd: liq, volume24hUsd: vol } });

test("a graduation counts only when we saw it happen", () => {
  takeGraduations();
  absorb([tok("GRAD1", "aboutToGraduate")], undefined, 1000);
  absorb([tok("OLDGRAD", "graduated")], undefined, 1000);          // first seen already graduated: not fresh
  absorb([tok("GRAD1", "graduated"), tok("OLDGRAD", "graduated")], undefined, 2000);
  assert.deepEqual(takeGraduations(), [{ mint: "GRAD1", at: 2000 }]);
  assert.deepEqual(takeGraduations(), [], "drained once");
});

test("coins Stonk.fun lists are known as listed", () => {
  absorb([tok("LISTED", "graduated")]);
  assert.equal(isStonkListed("LISTED"), true);
  assert.equal(isStonkListed("NOTLISTED"), false);
});

test("flagships: biggest by market cap with a real pool, never still on the curve", () => {
  absorb([tok("BIGPOOL", "graduated", 9e6, 400_000), tok("THIN", "graduated", 20e6, 3_000), tok("CURVE", "new", 30e6, 900_000), tok("MID", "graduated", 2e6, 80_000)]);
  const f = stonkFlagships(8);
  assert.ok(f.indexOf("BIGPOOL") === 0 && f.includes("MID"));
  assert.ok(!f.includes("THIN") && !f.includes("CURVE"));
});

test("fresh launches keep a lower bar than the top lists", () => {
  const keep = absorb([tok("EARLY", "new", 20_000, 2_000, 1_500)], { minVol: 1_000, minLiq: 5_000 });
  assert.deepEqual(keep, ["EARLY"]);
  assert.deepEqual(absorb([tok("EARLY2", "new", 20_000, 2_000, 1_500)]), [], "not enough for the top lists");
});

test("interleave gives each source a fair share of the first slots", () => {
  assert.deepEqual(interleave([["a1", "a2", "a3"], ["b1"], ["c1", "c2"]]), ["a1", "b1", "c1", "a2", "c2", "a3"]);
});

test("stonkfun.xyz is the launchpad's own page, not a cheap domain", () => {
  const base = { symbol: "MEOW", mcapUsd: 1e5 } as any;
  assert.equal(isSlop({ ...base, website: "https://www.stonkfun.xyz/token/abc" }, 900), null);
  assert.match(String(isSlop({ ...base, website: "https://meow.xyz" }, 900)), /cheap domain/);
});

test("recent graduations list: new to us counts once, already-graduated doesn't repeat", () => {
  takeGraduations();
  absorb([tok("NEWGRAD", "graduated")], { minVol: 0, minLiq: 0 }, 5000, true);
  absorb([tok("NEWGRAD", "graduated")], { minVol: 0, minLiq: 0 }, 6000, true);   // next refresh: already known
  assert.deepEqual(takeGraduations(), [{ mint: "NEWGRAD", at: 5000 }]);
});
