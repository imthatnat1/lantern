import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { db } = await import("../src/db.js");
const { watchedMints, watchedFirst } = await import("../src/strategies/base.js");

const NOW = Date.now(), H = 3_600_000;
const snap = (mint: string, volume1h: number) => ({ mint, volume1h } as any);
const look = (mode: string, mint: string, agoMs: number, setup: boolean, taken = 0) =>
  db.prepare("INSERT INTO signals_log(mode,mint,symbol,score,taken,reason,price,at,setup) VALUES(?,?,?,0,?,?,1,?,?)")
    .run(mode, mint, mint, taken, "x", NOW - agoMs, setup ? JSON.stringify({ need: "x" }) : null);

test("Chaton case: a watched coin with low volume still gets checked, ahead of busier coins", () => {
  look("pullback", "CHATON", 2 * H, true);     // setup logged 2h ago, then out-traded
  look("pullback", "OLD", 4 * H, true);        // older than 3h: no longer watched
  look("pullback", "REJ", 10 * 60_000, false); // a rejection is not a setup
  look("ultra", "OTHERMODE", 60_000, true);    // another mode's setup doesn't count
  const w = watchedMints("pullback", NOW);
  assert.deepEqual(w, ["CHATON"]);

  const snaps = [snap("CHATON", 1), ...Array.from({ length: 30 }, (_, i) => snap("BUSY" + i, 1000 + i))];
  const ranked = watchedFirst(w, snaps, 15, (a, b) => b.volume1h - a.volume1h);
  assert.equal(ranked.length, 15);
  assert.equal(ranked[0].mint, "CHATON");
  assert.equal(ranked[1].mint, "BUSY29", "the rest still by volume");
});

test("watched coins never take more than half the slots, so discovery continues", () => {
  const w = Array.from({ length: 12 }, (_, i) => "W" + i);
  const snaps = [...w.map(m => snap(m, 1)), ...Array.from({ length: 10 }, (_, i) => snap("NEW" + i, 500))];
  const ranked = watchedFirst(w, snaps, 15, (a, b) => b.volume1h - a.volume1h);
  assert.equal(ranked.filter(s => s.mint.startsWith("W")).length, 8);
  assert.equal(ranked.filter(s => s.mint.startsWith("NEW")).length, 7);
});

test("fresh slots: coins not checked in the last hour get a look ahead of the same busy coins", () => {
  const rank = (a: any, b: any) => b.volume1h - a.volume1h;
  const busy = Array.from({ length: 12 }, (_, i) => snap("TOP" + i, 1000 - i));
  const quiet = Array.from({ length: 6 }, (_, i) => snap("QUIET" + i, 10 - i));
  const first = watchedFirst([], [...busy, ...quiet], 12, rank, "fresh-test", NOW);
  assert.ok(first.every(s => s.mint.startsWith("TOP")), "first scan: all busy coins (all fresh, ranked by volume)");
  const next = watchedFirst([], [...busy, ...quiet], 12, rank, "fresh-test", NOW + 5 * 60_000);
  assert.deepEqual(next.slice(0, 3).map(s => s.mint), ["QUIET0", "QUIET1", "QUIET2"], "next scan: a quarter of the slots go to coins not checked yet");
  assert.equal(next.length, 12);
  const later = watchedFirst([], [...busy, ...quiet], 12, rank, "fresh-test", NOW + 70 * 60_000);
  assert.ok(later.slice(0, 3).every(s => s.mint.startsWith("TOP")), "an hour on, everyone is fresh again and volume decides");
});
