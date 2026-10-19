import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { config } = await import("../src/config.js");
const { breakoutPattern, ultraPattern } = await import("../src/strategies/ultra.js");
const C = config.modes.ultra;
const M5 = 5 * 60_000, T0 = Date.UTC(2026, 9, 20, 0, 0);
const mkt = { priceUsd: 1.12, buys5m: 60, sells5m: 40, liquidityUsd: 60_000, mcapUsd: 165_000, change1h: 20, change6h: 40, change24h: 300, volume24h: 500_000 };
/** 40 quiet 5m candles around 1.0, then a breakout candle, then the forming one. */
const series = (breakClose: number, breakVol: number) => {
  const c = Array.from({ length: 40 }, (_, i) => ({ t: T0 + i * M5, o: 1, h: 1.04, l: 0.97, c: 1 + 0.01 * Math.sin(i), v: 2_000 }));
  c.push({ t: T0 + 40 * M5, o: 1.0, h: breakClose, l: 0.99, c: breakClose, v: breakVol });
  c.push({ t: T0 + 41 * M5, o: breakClose, h: breakClose, l: breakClose, c: breakClose, v: 100 });
  return c;
};

test("ultra breakout (PIERRE, Blossom's best trade): a green close above the 2h high on 1.3x+ volume = buy", () => {
  const p = breakoutPattern(mkt, series(1.12, 9_000), false, C);
  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(config.modes.ultra.secondLeg, false, "breakout rule is live; the second-leg rule is the lab comparison");
  assert.ok(ultraPattern(mkt, series(1.12, 9_000), T0 + 42 * M5, false, C).ok);
});

test("no buy without the volume, without the new high, in a 6h downtrend, or when chasing", () => {
  assert.match((breakoutPattern(mkt, series(1.12, 2_100), false, C) as any).why, /1.3x volume/);
  assert.match((breakoutPattern(mkt, series(1.03, 9_000), false, C) as any).why, /2h high/);
  assert.match((breakoutPattern({ ...mkt, change6h: -12 }, series(1.12, 9_000), false, C) as any).why, /6h/);
  assert.match((breakoutPattern({ ...mkt, priceUsd: 1.5 }, series(1.12, 9_000), false, C) as any).why, /chasing/);
});
