import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { config } = await import("../src/config.js");
const { launchPattern, cheapWhy } = await import("../src/strategies/launch.js");
const C = { ...config.modes.launch, firstLeg: true };   // first-leg tests; live has it off since 20 Oct

const M5 = 5 * 60_000;
const MIG = Date.UTC(2026, 9, 19, 0, 0);
/** 5m candles from migration, one per close price; volume rising with the move. */
const run = (closes: number[], vol = (i: number) => 5_000 + i * 1_000) => closes.map((c, i) => ({ t: MIG + i * M5, o: i ? closes[i - 1] : c * 0.95, h: c * 1.03, l: Math.min(c, i ? closes[i - 1] : c) * 0.97, c, v: vol(i) }));
const mkt = { priceUsd: 2, buys5m: 300, sells5m: 150, liquidityUsd: 60_000, mcapUsd: 400_000, change1h: 300, change6h: 300, change24h: 300, volume24h: 900_000 };
const now = (n: number) => MIG + n * M5 + 30_000;   // just after the nth candle closed

test("Vader-style first leg: steady climb near the highs on rising volume = buy", () => {
  const c5 = run([1, 1.2, 1.45, 1.7, 2.0]);
  const p = launchPattern(mkt, c5, MIG, now(5), C);
  assert.ok(p.ok, JSON.stringify(p));
  if (p.ok) {
    const plan = p.plan(2.0, 0.1);
    assert.equal(plan.closeStopPrice, 1.3, "out on a 15m close 35% under entry");
    assert.deepEqual(plan.takeProfits, [{ gain: 1, sell: 0.5 }], "half off at 2x");
  }
});

test("too early, stalling, red, vertical or fading candles are not entries", () => {
  assert.match((launchPattern(mkt, run([1, 1.2]), MIG, now(2), C) as any).why, /needs 15/);
  assert.match((launchPattern(mkt, run([1, 1.5, 2.0, 1.8, 1.6]), MIG, now(5), C) as any).why, /off its high/);
  assert.match((launchPattern(mkt, run([1, 1.2, 1.45, 1.75, 1.7]), MIG, now(5), C) as any).why, /red/);
  assert.match((launchPattern(mkt, run([1, 1.05, 1.1, 1.15, 2.0]), MIG, now(5), C) as any).why, /too vertical/);
  assert.match((launchPattern(mkt, run([1, 1.2, 1.45, 1.7, 2.0], i => i === 4 ? 1_000 : 9_000), MIG, now(5), C) as any).why, /volume fading/);
  assert.match((launchPattern(mkt, run([1, 1.02, 1.03, 1.04, 1.05]), MIG, now(5), C) as any).why, /not running/);
});

test("the forming candle is ignored: only closed 5m candles count", () => {
  const c5 = [...run([1, 1.2, 1.45, 1.7, 2.0]), { t: MIG + 5 * M5, o: 2, h: 2, l: 1, c: 1.1, v: 99_000 }];
  assert.ok(launchPattern(mkt, c5, MIG, now(5), C).ok);
});

test("cheap checks: thin pools, tiny or huge caps, sell-heavy flow and churn never get a closer look", () => {
  const t = Date.now();
  assert.equal(cheapWhy(mkt, C, t), null);
  assert.match(cheapWhy({ ...mkt, liquidityUsd: 8_000 }, C, t)!, /too thin/);
  assert.match(cheapWhy({ ...mkt, mcapUsd: 20_000 }, C, t)!, /under launch's \$25k/);
  // UBI (19 Oct 10:43): $27k market cap and a $12k pool a minute after migrating, then 6.7x. Now worth a closer look.
  assert.equal(cheapWhy({ ...mkt, mcapUsd: 27_181, liquidityUsd: 12_000, buys5m: 1_066, sells5m: 792 }, C, t), null);
  assert.match(cheapWhy({ ...mkt, mcapUsd: 5_000_000 }, C, t)!, /past launch's/);
  assert.match(cheapWhy({ ...mkt, buys5m: 200, sells5m: 180 }, C, t)!, /needs 1.3x/);
  // safufun at 19 minutes: 3,545 buys / 3,418 sells, $345k traded on $83k
  assert.match(cheapWhy({ ...mkt, mcapUsd: 83_000, liquidityUsd: 26_000, buys5m: 200, sells5m: 120, createdAt: t - 19 * 60_000, volume1h: 345_000, buys1h: 3_545, sells1h: 3_418 }, C, t)!, /churn/);
});

test("breakout (PIERRE, Blossom's best trade): 2.3h after migrating, a new-high close on a volume spike = buy", () => {
  // 27 quiet candles drifting sideways, then a green candle closing at a new high on 5x the hour's volume
  const closes = Array.from({ length: 27 }, (_, i) => 1 + 0.05 * Math.sin(i));
  const c5 = run([...closes, 1.25], i => i === 27 ? 25_000 : 5_000);
  const p = launchPattern(mkt, c5, MIG, now(28), C);
  assert.ok(p.ok, JSON.stringify(p));
  if (p.ok) assert.equal(p.kind, "breakout");
});

test("breakout needs both: a new high and the volume", () => {
  const closes = Array.from({ length: 27 }, (_, i) => 1 + 0.05 * Math.sin(i));
  assert.match((launchPattern(mkt, run([...closes, 1.25], () => 5_000), MIG, now(28), C) as any).why, /needs 3x/);
  assert.match((launchPattern(mkt, run([...closes, 1.044], i => i === 27 ? 25_000 : 5_000), MIG, now(28), C) as any).why, /no new high/);
});

test("past 6 hours, launch is done with a coin", () => {
  assert.equal(C.breakoutMaxAgeH, 6);
});

test("Moonoween (19 Oct): a fake valuation is named a scam before any size check", () => {
  const t = Date.now();
  const why = cheapWhy({ ...mkt, mcapUsd: 157_700_000, liquidityUsd: 1_000_000, buys5m: 300, sells5m: 12, createdAt: t - 60 * 60_000, volume24h: 541_000, onCurve: false }, C, t);
  assert.match(why!, /^rejected: (fake valuation|bot buys)/);
});

test("with first legs off, under an hour after migration launch waits", async () => {
  const off = { ...config.modes.launch, firstLeg: false, firstDip: false };
  const p = launchPattern(mkt, run([1, 1.2, 1.45, 1.7, 2.0]), MIG, now(5), off) as any;
  assert.equal(p.ok, false);
  assert.match(p.why, /under an hour since migration/);
});

test("first legs (off live since 21 Oct) need a spread-out, fast-growing crowd; a first dip only the spread", async () => {
  const { firstLegWhy } = await import("../src/strategies/launch.js");
  const C = config.modes.launch;
  assert.equal(C.firstLeg, false);
  assert.equal(C.firstDip, true);
  assert.match(firstLegWhy("first dip", 31, null, C)!, /top 10 hold 31%/, "first dip: concentrated refused");
  assert.equal(firstLegWhy("first dip", 15, null, C), null, "first dip: no growth needed");
  assert.match(firstLegWhy("first leg", 31, 0.2, C)!, /top 10 hold 31%/, "concentrated: refused");
  assert.match(firstLegWhy("first leg", 15, 0.04, C)!, /holders \+4%/, "slow crowd: refused");
  assert.match(firstLegWhy("first leg", 15, null, C)!, /not measured yet/, "unknown growth: refused");
  assert.equal(firstLegWhy("first leg", 15, 0.12, C), null, "spread out and growing: allowed");
  assert.equal(firstLegWhy("breakout", 31, null, C), null, "breakouts keep the normal rules");
  assert.equal(firstLegWhy("first leg", 31, null, { ...C, firstLegMaxTop10: 100, firstLegMinHolderGrowth: -1 }), null, "the lab's loose row");
});

test("launchpad coins only: pump.fun and bonk mints, not tokenized stocks or wrapped coins", async () => {
  const { isLaunchpadMint } = await import("../src/strategies/launch.js");
  assert.ok(isLaunchpadMint("Goqx3oFohWoTnuJbVhT7DcGfq6EjLrPyhTEuyHUZpump"));
  assert.ok(isLaunchpadMint("AbcdEfgh1234bonk"));
  assert.ok(!isLaunchpadMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), "USDC");
});

// 21 Oct: live launch buys the first dip, not the spike.
const live = { ...config.modes.launch };
const firstDipMkt = { ...mkt, priceUsd: 1.45, buys5m: 200, sells5m: 150 };

test("live config: no spike buying in the first hour", () => {
  const p = launchPattern(mkt, run([1, 1.2, 1.45, 1.7, 2.0]), MIG, now(5), live);
  assert.equal(p.ok, false);
  assert.match((p as any).why, /waiting for the first dip/);
});

test("first dip: +100% leg, 35% pullback that stopped, green bounce = buy, stop under the dip low", () => {
  // run to 2.0, dip to a 1.3 close (low ~1.26), then a green candle to 1.45
  const c5 = run([1, 1.4, 2.0, 1.6, 1.3, 1.35, 1.45]);
  const p = launchPattern(firstDipMkt, c5, MIG, now(7), live);
  assert.ok(p.ok, JSON.stringify(p));
  if (p.ok) {
    assert.equal(p.kind, "first dip");
    const plan = p.plan(1.45, 0.1);
    assert.ok(plan.closeStopPrice < 1.26 && plan.closeStopPrice >= 1.45 * (1 - live.stopPct) - 1e-9, `stop ${plan.closeStopPrice}`);
  }
});

test("first dip refuses: no real leg, too shallow, too deep, still falling, red, more sells", () => {
  assert.match((launchPattern(firstDipMkt, run([1, 1.1, 1.15, 1.0, 1.05]), MIG, now(5), live) as any).why, /first leg only/);
  assert.match((launchPattern(firstDipMkt, run([1, 1.5, 2.0, 1.9, 1.95]), MIG, now(5), live) as any).why, /waiting for a 20-45% dip/);
  assert.match((launchPattern(firstDipMkt, run([1, 1.5, 2.0, 1.2, 0.8, 0.9]), MIG, now(6), live) as any).why, /more than a dip/);
  assert.match((launchPattern(firstDipMkt, run([1, 1.5, 2.0, 1.6, 1.3]), MIG, now(5), live) as any).why, /new lows/);
  assert.match((launchPattern(firstDipMkt, run([1, 1.5, 2.0, 1.4, 1.5, 1.42]), MIG, now(6), live) as any).why, /red/);
  assert.match((launchPattern({ ...firstDipMkt, buys5m: 100, sells5m: 150 }, run([1, 1.4, 2.0, 1.6, 1.3, 1.35, 1.45]), MIG, now(7), live) as any).why, /more sells/);
});
