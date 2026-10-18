import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { db } = await import("../src/db.js");
const { Lab } = await import("../src/lab/entries.js");
const { runLab } = await import("../src/lab/run.js");
const { cleanTicks, candlesFromTicks, CoinHistory } = await import("../src/lab/data.js");

const MIN = 60_000, H = 3_600_000;
const NOW = Math.floor(Date.now() / (5 * MIN)) * 5 * MIN;
const T0 = NOW - 10 * H;
const MINT = "PULLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump", PAIR = "PULLPAIR";

/**
 * A textbook pullback: flat at 0.8 for 4h, ramps to 2.5 in an hour, retraces to 1.8, holds a base for
 * 20 minutes, reclaims green on big volume, then rallies to 3.0. Every rule in pullbackPattern passes.
 */
function path(m: number): { p: number; v: number } {
  if (m < 240) return { p: 0.8 * (1 + 0.01 * Math.sin(m / 7)), v: 1000 };
  if (m < 300) return { p: 0.8 + (2.5 - 0.8) * (m - 240) / 60, v: 3000 };
  if (m < 330) return { p: 2.5 - 0.7 * (m - 300) / 30, v: 1500 };
  if (m < 350) return { p: 1.8 + 0.03 * Math.sin(m), v: 800 };
  if (m < 355) return { p: 1.95, v: 4000 };
  if (m < 480) return { p: 1.95 + (3.0 - 1.95) * (m - 355) / 125, v: 2000 };
  return { p: 3.0, v: 1500 };
}

function seed() {
  db.prepare("INSERT OR REPLACE INTO market(mint,symbol,pair,quote,price,mcap,liquidity,on_curve,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(MINT, "PULL", PAIR, "SOL", 3.0, 3e6, 60_000, 0, T0 - 2 * H, NOW);
  const ins = db.prepare("INSERT OR IGNORE INTO ticks(mint,at,price,liquidity,mcap,vol5m,buys5m,sells5m,pair) VALUES(?,?,?,?,?,?,?,?,?)");
  for (let m = 0; m <= 600; m++) {
    const { p, v } = path(m);
    ins.run(MINT, T0 + m * MIN + 1000, p, 60_000, p * 1e6, v, 30, 20, m < 360 ? null : PAIR);
  }
  // Junk: a dust-pool tick from another pair, and an old unlabelled 100x tick with no volume.
  ins.run(MINT, T0 + 400 * MIN + 2000, 800, 11_000, 8e8, 0, 0, 0, "DUSTPOOL");
  ins.run(MINT, T0 + 200 * MIN + 2000, 80, 11_000, 8e7, 0, 0, 0, null);
}
seed();

test("dust ticks are dropped: other pair, and an unlabelled 100x jump with no volume", () => {
  const h = new CoinHistory({ mint: MINT, symbol: "PULL", pair: PAIR, quote: "SOL", onCurve: false, createdAt: T0 - 2 * H }, T0 - H, NOW);
  assert.ok(h.ticks.every(t => t.price < 10));
});

test("candles from ticks: OHLC and volume", () => {
  const ticks = [0, 1, 2, 3, 4].map(i => ({ at: i * MIN, price: [1, 3, 0.5, 2, 1.5][i], liquidity: 0, mcap: 0, vol5m: 100 * i, buys5m: 0, sells5m: 0, pair: null }));
  const [k] = candlesFromTicks(ticks, 5 * MIN);
  assert.deepEqual([k.o, k.h, k.l, k.c, k.v], [1, 3, 0.5, 1.5, 400]);
});

test("cleanTicks keeps a real confirmed move", () => {
  const t = (at: number, price: number, vol5m = 500) => ({ at, price, liquidity: 0, mcap: 0, vol5m, buys5m: 0, sells5m: 0, pair: null });
  assert.equal(cleanTicks([t(0, 1), t(1, 10), t(2, 10.5)], null).length, 3);
});

test("the replay never sees the future: forming candle only has ticks up to now", () => {
  const h = new CoinHistory({ mint: MINT, symbol: "PULL", pair: PAIR, quote: "SOL", onCurve: false, createdAt: T0 - 2 * H }, T0 - H, NOW);
  const at = T0 + 352 * MIN + 30_000;     // inside the reclaim candle, before the rally
  const { c5 } = h.c5At(at);
  assert.ok(c5.at(-1)!.h <= 1.95 + 1e-9);
  assert.ok(c5.every(k => k.t <= at));
});

test("pullback: the lab finds the setup and the trade makes money", () => {
  const lab = new Lab(T0, NOW);
  const r = lab.run({ name: "live", modes: ["pullback"] });
  assert.equal(r.trades.length, 1, JSON.stringify(r.trades));
  const t = r.trades[0];
  assert.ok(t.at > T0 + 355 * MIN && t.at < T0 + 375 * MIN, `entry at minute ${(t.at - T0) / MIN}`);
  assert.ok(t.pnl > 0, `pnl ${t.pnl}`);
  assert.match(t.why, /pullback/);
});

test("a stricter setting removes the trade, and the report shows it as dropped", () => {
  const rep = runLab(10, [{ name: "Pullback: retrace 30-40% only", modes: ["pullback"], config: { pullback: { retraceMin: 0.30 } } }], NOW);
  const e = rep.experiments[0];
  assert.equal(e.error, undefined);
  assert.equal(e.totals.trades, 0);
  assert.equal(e.totals.baseTrades, 1);
  assert.equal(e.dropped.length, 1);
});

test("a gate rejection logged by the live bot blocks the replay entry", () => {
  db.prepare("INSERT INTO signals_log(mode,mint,symbol,score,taken,reason,price,at) VALUES(?,?,?,?,?,?,?,?)")
    .run("pullback", MINT, "PULL", 0, 0, "rejected: top 10 hold 70%", 1.9, T0 + 340 * MIN);
  const r = new Lab(T0, NOW).run({ name: "live", modes: ["pullback"] });
  assert.equal(r.trades.length, 0);
  db.prepare("DELETE FROM signals_log WHERE mint=?").run(MINT);
});
