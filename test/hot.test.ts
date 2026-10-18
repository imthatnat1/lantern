import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { db, hot } = await import("../src/db.js");
const { watchedMints } = await import("../src/strategies/base.js");
const { hotList } = await import("../src/server.js");

const NOW = Date.now(), M = 60_000;
const setupLook = (mode: string, mint: string, agoMs: number) =>
  db.prepare("INSERT INTO signals_log(mode,mint,symbol,score,taken,reason,price,at,setup) VALUES(?,?,?,0,0,'watching: x',1,?,?)")
    .run(mode, mint, mint, NOW - agoMs, JSON.stringify({ need: "green 5m close above 0.002", level: 0.002, distance: 0.03 }));

test("hot list: clean coins show up, setups first, rejected and written-off coins drop out", () => {
  hot.clean("pullback", "SETUP", "SETUP", 1, NOW - 2 * M); setupLook("pullback", "SETUP", 3 * M);
  hot.clean("pullback", "ONWAY", "ONWAY", 1, NOW - M); hot.status("pullback", "ONWAY", "watching: only 8% off the high, waiting for a 20-40% retrace", NOW - M);
  hot.clean("ultra", "QUIET", "QUIET", 1, NOW - M);
  hot.clean("pullback", "REJ", "REJ", 1, NOW - 5 * M); hot.status("pullback", "REJ", "rejected: creator history", NOW - 4 * M);
  hot.clean("bounce", "DEAD", "DEAD", 1, NOW - 5 * M); hot.status("bounce", "DEAD", "down 92% since migration, treated as dead", NOW - 4 * M);
  hot.clean("pullback", "OLD", "OLD", 1, NOW - 45 * M);
  hot.clean("pullback", "HELD", "HELD", 1, NOW - M);

  const h = hotList(NOW, new Set(["HELD"]));
  const mints = h.map(x => x.mint);
  assert.equal(mints[0], "SETUP");
  assert.equal(h[0].group, "setup");
  assert.ok(mints.includes("ONWAY") && mints.includes("QUIET"));
  for (const gone of ["REJ", "DEAD", "OLD", "HELD"]) assert.ok(!mints.includes(gone), gone);
  assert.equal(h.find(x => x.mint === "ONWAY")!.status, "only 8% off the high, waiting for a 20-40% retrace");
  assert.equal(h.find(x => x.mint === "QUIET")!.status, "clean, no entry pattern yet");
});

test("a coin on the hot list is re-checked first by its mode, so it can be bid the moment it qualifies", () => {
  const w = watchedMints("pullback", NOW);
  assert.ok(w.includes("ONWAY"));
  assert.ok(!w.includes("REJ") && !w.includes("OLD"));
  assert.ok(!watchedMints("pullback", NOW).includes("QUIET"), "ultra's hot coins don't take pullback slots");
});

test("passing safety again clears an old rejection; a coin clean an hour later starts a new 'since'", () => {
  hot.clean("pullback", "REJ", "REJ", 1, NOW - M);
  assert.ok(hotList(NOW).some(x => x.mint === "REJ"));
  const row = () => db.prepare("SELECT first_at FROM clean_seen WHERE mode='pullback' AND mint='OLD'").get() as { first_at: number };
  hot.clean("pullback", "OLD", "OLD", 1, NOW - 30 * M + 1);
  assert.equal(row().first_at, NOW - 45 * M, "within the hour: same stretch");
  hot.clean("pullback", "OLD", "OLD", 1, NOW + 2 * 3_600_000);
  assert.equal(row().first_at, NOW + 2 * 3_600_000, "gap over an hour: new stretch");
});

test("a coin crashing in the hour stays off the hot list", async () => {
  const { market } = await import("../src/db.js");
  hot.clean("bounce", "RUGGING", "RUGGING", 1, NOW - M);
  market.upsert({ mint: "RUGGING", symbol: "RUGGING", name: "r", priceUsd: 1, liquidityUsd: 9000, mcapUsd: 16000, volume24h: 1, volume1h: 1, volume5m: 1,
    buys5m: 1, sells5m: 1, change5m: -20, change1h: -70, change6h: -70, change24h: -70, createdAt: NOW, onCurve: false, fetchedAt: NOW } as any);
  assert.ok(!hotList(NOW).some(x => x.mint === "RUGGING"));
});

test("bounce takes at most 5 hot list spots unless a coin is in a setup", () => {
  for (let i = 0; i < 8; i++) hot.clean("bounce", "NEWPAIR" + i, "NEWPAIR" + i, 1, NOW - M);
  hot.clean("ultra", "PROVEN", "PROVEN", 1, NOW - M);
  const h = hotList(NOW, new Set(), 30);
  const onlyBounce = h.filter(x => x.group !== "setup" && x.modes.length === 1 && x.modes[0] === "bounce");
  assert.equal(onlyBounce.length, 5);
  assert.ok(h.some(x => x.mint === "PROVEN"));
});

test("stablecoin tickers are rejected as copycats, real names aren't", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../src/strategies/base.ts", import.meta.url), "utf8");
  const re = new RegExp(src.match(/const STABLE_TICKER = \/(.*)\/i;/)![1], "i");
  for (const t of ["USDF", "USDT", "USDC", "$USD1", "PYUSD", "FDUSD", "DAI", "EURC"]) assert.ok(re.test(t), t);
  for (const t of ["USDUC", "TSI", "DAIKON", "USDFUN", "SUPERCORE", "BUSDY2"]) assert.ok(!re.test(t), t);
});

test("Watching is for coins near a buy: far setups and breaking-down coins leave, new arrivals get a tag", () => {
  const far = (mint: string, distance: number) => db.prepare("INSERT INTO signals_log(mode,mint,symbol,score,taken,reason,price,at,setup) VALUES('ultra',?,?,0,0,'watching: x',1,?,?)")
    .run(mint, mint, NOW - M, JSON.stringify({ need: "recover to 1.8x the dump low", level: 1, distance }));
  // TSI at 22:41 on 18 Oct: an ultra setup 35.9% away, refreshed every check, so it never left the list.
  hot.clean("ultra", "TSIFAR", "TSIFAR", 1, NOW - 3 * M); far("TSIFAR", 0.359);
  hot.clean("ultra", "NEAR", "NEAR", 1, NOW - 3 * M); far("NEAR", 0.08);
  hot.clean("ultra", "BROKE", "BROKE", 1, NOW - 3 * M); hot.status("ultra", "BROKE", "printed a 1h lower low, structure broken", NOW - 2 * M);
  const h = hotList(NOW);
  const mints = h.map(x => x.mint);
  assert.ok(!mints.includes("TSIFAR"), "more than 25% from its trigger");
  assert.ok(!mints.includes("BROKE"), "the mode says it's breaking down");
  assert.ok(mints.includes("NEAR"));
  assert.equal(h.find(x => x.mint === "NEAR")!.chips[0], "new", "joined in the last 30 minutes");
  // Still checked first behind the scenes, so it comes back on its own when it gets close.
  assert.ok(watchedMints("ultra", NOW).includes("TSIFAR"));
});

test("paused modes stay off Watching: dip and ride coins show under Would have bought instead", () => {
  hot.clean("dip", "PAUSEDDIP", "PAUSEDDIP", 1, NOW - M); hot.status("dip", "PAUSEDDIP", "dip found, waiting for a green 5m reclaim", NOW - M);
  hot.clean("ride", "PAUSEDRIDE", "PAUSEDRIDE", 1, NOW - M);
  const mints = hotList(NOW).map(x => x.mint);
  assert.ok(!mints.includes("PAUSEDDIP") && !mints.includes("PAUSEDRIDE"));
});
