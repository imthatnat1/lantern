import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { config } = await import("../src/config.js");
const { turnPattern, dipPattern } = await import("../src/strategies/dip.js");
const C = config.modes.dip;
const H = 3_600_000, M5 = 5 * 60_000, T0 = Date.UTC(2026, 9, 19, 0, 0);
/** 5m candles from hourly closes: each hour drifts from the previous close to this one; `lows` override the hour's low. */
function hours(closes: number[], lows: Record<number, number> = {}) {
  const out = [];
  for (let h = 0; h < closes.length; h++) {
    const from = h ? closes[h - 1] : closes[0], to = closes[h];
    for (let i = 0; i < 12; i++) {
      const c = from + (to - from) * (i + 1) / 12, o = from + (to - from) * i / 12;
      out.push({ t: T0 + h * H + i * M5, o, c, h: Math.max(o, c) * 1.005, l: i === 6 && lows[h] ? lows[h] : Math.min(o, c) * 0.995, v: 1000 });
    }
  }
  return out;
}
const mkt = { priceUsd: 1, buys5m: 60, sells5m: 40, liquidityUsd: 600_000, mcapUsd: 5e6, change1h: 2, change6h: -5, change24h: -20, volume24h: 1e6 };
const at = (n: number) => T0 + n * H + 60_000;

test("a flagship that bled, made a higher low and closed above its last lower high = turn", () => {
  // 1.0 -> 0.70 low at hour 5, bounce, dip to 0.76 (higher low), close 0.86 above the lower high (~0.80)
  const c5 = hours([1.0, 0.95, 0.9, 0.85, 0.8, 0.72, 0.78, 0.76, 0.8, 0.86], { 5: 0.70 });
  const p = turnPattern(mkt, c5, at(10), C);
  assert.ok(p.ok, JSON.stringify(p));
});

test("still bleeding = no buy; the old first-green-candle trigger is what bought these", () => {
  const bleeding = hours([1.0, 0.95, 0.9, 0.86, 0.82, 0.78, 0.75, 0.72]);
  assert.match((turnPattern(mkt, bleeding, at(8), C) as any).why, /still making new lows/);
});

test("higher low in but no hourly close above the last lower high yet = a setup, not a buy", () => {
  const c5 = hours([1.0, 0.95, 0.9, 0.85, 0.8, 0.72, 0.76, 0.75, 0.77], { 5: 0.70 });
  const p = turnPattern(mkt, c5, at(9), C) as any;
  assert.equal(p.ok, false);
  assert.match(p.why, /waiting for an hourly close above the last lower high/);
  assert.ok(p.setup && p.setup.level > 0.77);
});

test("already 40%+ off the low = chasing", () => {
  const c5 = hours([1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.6, 0.65, 0.75], { 5: 0.48 });
  assert.match((turnPattern(mkt, c5, at(9), C) as any).why, /chasing/);
});

test("dip uses the turn rule by default, flagships only", () => {
  assert.equal(C.trigger, "turn");
  assert.equal(C.flagshipsOnly, true);
  const c5 = hours([1.0, 0.95, 0.9, 0.85, 0.8, 0.72, 0.78, 0.76, 0.8, 0.86], { 5: 0.70 });
  assert.ok(dipPattern(mkt, c5, at(10), C).ok);
});

test("with a bounce attempt before the low, the lower high is that bounce's top", () => {
  const base = [1.0, 0.9, 0.85, 0.92, 0.86, 0.78, 0.72, 0.79, 0.77, 0.85];
  const notYet = turnPattern(mkt, hours([...base, 0.90], { 6: 0.70 }), at(11), C) as any;
  assert.equal(notYet.ok, false);
  assert.ok(Math.abs(notYet.setup.level - 0.92 * 1.005) < 1e-9, `level ${notYet.setup.level}`);
  assert.ok(turnPattern(mkt, hours([...base, 0.94], { 6: 0.70 }), at(11), C).ok);
});
