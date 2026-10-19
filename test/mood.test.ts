import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { moodScore, levelOf, moodSizeX, saveMood } = await import("../src/engine/mood.js");

const bleak = { flagships6h: 0.1, flagships1h: 0.2, sol24h: -6, sol6h: -3, launchesRatio: 0.6, followThru: 0.2 };
const neutral = { flagships6h: 0.5, flagships1h: 0.5, sol24h: 0, sol6h: 0, launchesRatio: 1, followThru: 0.5 };
const green = { flagships6h: 0.85, flagships1h: 0.7, sol24h: 6, sol6h: 3, launchesRatio: 1.4, followThru: 0.75 };

test("mood: a bleeding market reads fearful (half-size bets), a broad bounce reads green (1.5x)", () => {
  const b = moodScore(bleak), n = moodScore(neutral), g = moodScore(green);
  assert.equal(b.level, "fearful"); assert.equal(b.sizeX, 0.5);
  assert.equal(n.level, "neutral"); assert.equal(n.sizeX, 1); assert.equal(n.score, 50);
  assert.equal(g.level, "green"); assert.equal(g.sizeX, 1.5);
});

test("mood: one reading can't flip it, the last score counts for half", () => {
  const m = moodScore(green, 20);
  assert.ok(m.raw > 60 && m.score < m.raw, `raw ${m.raw} smoothed ${m.score}`);
  assert.equal(levelOf(34), "fearful"); assert.equal(levelOf(61), "green"); assert.equal(levelOf(50), "neutral");
});

test("mood: missing readings are left out, not counted as bad", () => {
  const m = moodScore({ flagships6h: 0.9, flagships1h: 0.9, sol24h: null, sol6h: null, launchesRatio: null, followThru: null });
  assert.equal(m.score, 90);
  assert.equal(moodScore({ flagships6h: null, flagships1h: null, sol24h: null, sol6h: null, launchesRatio: null, followThru: null }).score, 50);
});

test("mood sizing: applies to launch/dip/ultra/pullback, not trusted copies or picks, and expires after 30 min", () => {
  const now = Date.now();
  saveMood(moodScore(green, undefined, now));
  assert.equal(moodSizeX("launch", now), 1.5);
  assert.equal(moodSizeX("dip", now), 1.5);
  assert.equal(moodSizeX("trusted", now), 1);
  assert.equal(moodSizeX("pick", now), 1);
  assert.equal(moodSizeX("launch", now + 31 * 60_000), 1, "a stale reading doesn't size bets");
});
