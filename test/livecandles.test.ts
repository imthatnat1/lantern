import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { db } = await import("../src/db.js");
const live = await import("../src/data/livecandles.js");

const M5 = 5 * 60_000, S = 20_000;
const T0 = Math.floor(Date.UTC(2026, 9, 18, 10, 0) / M5) * M5;   // a bucket start
const row = (pair: string, t: number) => db.prepare("SELECT o,h,l,c,v FROM candles WHERE pair=? AND agg=5 AND t=?").get(pair, t) as any;

/** Pretend GeckoTerminal: store 24 closed candles before `now` plus a partial forming one, count calls. */
function fakeGecko(calls: { n: number }) {
  return async (pair: string) => {
    calls.n++;
    const now = (globalThis as any).__now as number;
    const b = Math.floor(now / M5) * M5;
    const ins = db.prepare("INSERT OR REPLACE INTO candles(pair,agg,t,o,h,l,c,v) VALUES(?,?,?,?,?,?,?,?)");
    for (let i = 24; i >= 1; i--) ins.run(pair, 5, b - i * M5, 1, 1.1, 0.9, 1, 100);
    ins.run(pair, 5, b, 1, 1.05, 0.98, 1.02, 40);   // partial
  };
}

test("samples every 20s make a proper 5m candle when the bucket ends", () => {
  live._reset();
  const P = "PAIR_A";
  const prices = [1.0, 1.2, 0.9, 1.1, 1.05, 1.15, 1.0, 1.3, 1.25, 1.2, 1.1, 1.12, 1.18, 1.2, 1.22];
  prices.forEach((p, i) => live.sample(P, p, 500 + i * 10, T0 + 5_000 + i * S));
  live.sample(P, 1.4, 50, T0 + M5 + 5_000);   // next bucket: closes the first
  const k = row(P, T0);
  assert.deepEqual([k.o, k.h, k.l, k.c, k.v], [1.0, 1.3, 0.9, 1.22, 640]);
});

test("GeckoTerminal is asked once for history, then not again while our sampling is unbroken", async () => {
  live._reset();
  const P = "PAIR_B", calls = { n: 0 }, gecko = fakeGecko(calls);
  let now = T0 + 60_000;
  (globalThis as any).__now = now;
  const first = await live.candles5(P, now, gecko);
  assert.equal(calls.n, 1);
  assert.equal(first.own, false);
  assert.equal(first.c5.length, 25);             // 24 closed + the partial forming one
  // Sample for 30 minutes, asking for candles every 5 minutes.
  for (let t = now + 10_000; t < now + 30 * 60_000; t += S) {
    live.sample(P, 1 + ((t / S) % 7) / 100, 300, t);
    if ((t - now) % M5 < S) { (globalThis as any).__now = t; await live.candles5(P, t, gecko); }
  }
  assert.equal(calls.n, 1, "no more GeckoTerminal calls while sampling");
  const later = await live.candles5(P, now + 30 * 60_000 - S, gecko);
  assert.equal(later.own, true);
  // The bucket that was forming at fetch time was merged: Gecko's open, our close.
  const merged = row(P, Math.floor(now / M5) * M5);
  assert.equal(merged.o, 1);
  assert.ok(merged.h >= 1.05);
  // Every bucket since then is ours and there are no gaps.
  const c5 = later.c5;
  for (let i = 1; i < c5.length; i++) assert.equal(c5[i].t - c5[i - 1].t, M5, `gap at ${i}`);
});

test("after a break in sampling, history is fetched again to fill the gap", async () => {
  live._reset();
  const P = "PAIR_C", calls = { n: 0 }, gecko = fakeGecko(calls);
  let now = T0 + 60_000;
  (globalThis as any).__now = now;
  await live.candles5(P, now, gecko);
  for (let t = now + 10_000; t < now + 10 * 60_000; t += S) live.sample(P, 1, 100, t);
  // 20 minutes with no samples (dropped off the list, or DexScreener didn't return it).
  now += 30 * 60_000;
  (globalThis as any).__now = now;
  live.sample(P, 1, 100, now - 30_000);
  await live.candles5(P, now, gecko);
  assert.equal(calls.n, 2);
});

test("if GeckoTerminal is blocked, stored candles are still served; with nothing stored it fails loudly", async () => {
  live._reset();
  const blocked = async () => { throw new Error("cooling api.geckoterminal.com"); };
  const now = T0 + 60_000;
  await assert.rejects(live.candles5("PAIR_EMPTY", now, blocked), /cooling/);
  const ins = db.prepare("INSERT OR REPLACE INTO candles(pair,agg,t,o,h,l,c,v) VALUES(?,?,?,?,?,?,?,?)");
  const b = Math.floor(now / M5) * M5;
  for (let i = 20; i >= 1; i--) ins.run("PAIR_OLD", 5, b - i * M5, 1, 1, 1, 1, 1);
  const r = await live.candles5("PAIR_OLD", now, blocked);
  assert.equal(r.c5.length, 20);
  assert.equal(live.liveCandleStats(now).geckoFailed, 2);
});
