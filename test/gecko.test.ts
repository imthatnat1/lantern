import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { rollUp, atr } = await import("../src/data/gecko.js");

const M = 60_000, T0 = Math.floor(Date.UTC(2026, 9, 18, 4, 0) / (15 * M)) * 15 * M;
const k = (i: number, o: number, h: number, l: number, c: number, v: number) => ({ t: T0 + i * 5 * M, o, h, l, c, v });

test("15m candles rolled up from 5m: open of the first, high/low over all, close of the last, volume summed", () => {
  const c5 = [k(0, 1, 2, 0.9, 1.5, 10), k(1, 1.5, 3, 1.4, 2.5, 20), k(2, 2.5, 2.6, 1.0, 1.2, 5), k(3, 1.2, 1.3, 1.1, 1.25, 7)];
  const c15 = rollUp(c5);
  assert.equal(c15.length, 2);
  assert.deepEqual(c15[0], { t: T0, o: 1, h: 3, l: 0.9, c: 1.2, v: 35 });
  assert.deepEqual(c15[1], { t: T0 + 15 * M, o: 1.2, h: 1.3, l: 1.1, c: 1.25, v: 7 }, "partial last bucket kept, like Gecko's");
  assert.equal(c5[0].v, 10, "input untouched");
});

test("a 5m series misaligned to the quarter hour still buckets on 15m boundaries", () => {
  const c5 = [k(1, 1, 1, 1, 1, 1), k(2, 1, 1, 1, 1, 1), k(3, 2, 2, 2, 2, 1)];
  assert.deepEqual(rollUp(c5).map(c => c.t), [T0, T0 + 15 * M]);
});

test("ATR on rolled-up candles is finite and positive", () => {
  const c5 = Array.from({ length: 60 }, (_, i) => k(i, 1 + i * 0.01, 1.05 + i * 0.01, 0.95 + i * 0.01, 1.02 + i * 0.01, 100));
  const a = atr(rollUp(c5));
  assert.ok(a > 0 && Number.isFinite(a));
});
