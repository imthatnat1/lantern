import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
process.env.DB_PATH = ":memory:";
process.env.DASHBOARD_TOKEN = "";
const { db, recorder } = await import("../src/db.js");
const { latestLooks, stateBody, resetStateCache, outcomeCards, resetOutcomeCards } = await import("../src/server.js");

// 22 Oct: the dashboard went dark because /api/state took 5-10s (Vercel gives up at 8s) and blocked the bot while it ran.

const look = db.prepare("INSERT INTO signals_log(mode,mint,symbol,score,taken,reason,price,at,setup,peak_price,last_price,mcap) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");

test("latest looks: same answer as grouping a day of looks, newest per mode and coin", () => {
  db.exec("DELETE FROM signals_log");
  const now = Date.now();
  const modes = ["dip", "launch", "ride"];
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return (seed >>> 12) % n; };
  for (let i = 0; i < 3000; i++) {
    const at = now - rnd(30 * 3_600_000) - 1;
    const reason = ["rejected: top 10 hold 70%", "waiting for a reclaim", "dip found"][rnd(3)];
    look.run(modes[rnd(3)], `M${rnd(150)}`, "X", 1, rnd(20) === 0 ? 1 : 0, reason, 1, at, rnd(2) ? JSON.stringify({ need: "x" }) : null, 1, 1, 10_000);
  }
  // The old queries, kept here as the reference.
  const latest = `SELECT s.* FROM signals_log s JOIN (SELECT mode, mint, max(at) AS at FROM signals_log WHERE at > ? GROUP BY mode, mint) l
    ON l.mode=s.mode AND l.mint=s.mint AND l.at=s.at WHERE s.taken=0`;
  const oldRecent = db.prepare(`${latest} ORDER BY s.at DESC LIMIT 80`).all(now - 24 * 3_600_000) as any[];
  const oldForming = db.prepare(`${latest} AND s.setup IS NOT NULL AND s.reason NOT LIKE 'rejected%' AND s.at > ? ORDER BY s.at DESC LIMIT 40`).all(now - 24 * 3_600_000, now - 3 * 3_600_000) as any[];
  const { recent, forming } = latestLooks(now);
  assert.deepEqual(recent.map(r => r.id), oldRecent.map(r => r.id));
  assert.deepEqual(forming.map(r => r.id), oldForming.map(r => r.id));
  assert.ok(forming.length > 0 && recent.length === 80, `recent ${recent.length} forming ${forming.length}`);
});

test("state is built once per 15s and served gzipped; a reset rebuilds", () => {
  resetStateCache();
  let builds = 0;
  const t0 = 1_000_000;
  const a = stateBody(() => ({ n: ++builds }), t0);
  const b = stateBody(() => ({ n: ++builds }), t0 + 14_000);
  assert.equal(builds, 1);
  assert.equal(a.json, b.json);
  assert.equal(stateBody(() => ({ n: ++builds }), t0 + 15_000).json, '{"n":2}');
  resetStateCache();
  assert.equal(stateBody(() => ({ n: ++builds }), t0 + 15_001).json, '{"n":3}');
  const s = stateBody(() => ({ n: ++builds }), t0 + 15_002);
  assert.equal(gunzipSync(s.gz()).toString(), s.json);
});

test("miss cards are rebuilt at most every 5 minutes", () => {
  db.exec("DELETE FROM signals_log");
  resetOutcomeCards();
  const now = Date.now();
  look.run("dip", "RAN", "RAN", 1, 0, "waiting", 1, now - 3_600_000, null, 3, 3, 50_000);
  assert.equal(outcomeCards(now).missed.length, 1);
  look.run("dip", "RAN2", "RAN2", 1, 0, "waiting", 1, now - 3_600_000, null, 4, 4, 50_000);
  assert.equal(outcomeCards(now + 60_000).missed.length, 1, "cached");
  assert.equal(outcomeCards(now + 5 * 60_000).missed.length, 2, "rebuilt");
});

test("every per-coin lookup on the look log uses an index, not a day-long walk", () => {
  const plan = (q: string) => (db.prepare("EXPLAIN QUERY PLAN " + q).all() as { detail: string }[]).map(r => r.detail).join(" | ");
  // Missed-runner tracker (db.ts reprice), every 20 min for 120 coins.
  assert.match(plan("UPDATE signals_log SET last_price=1 WHERE mint='x' AND COALESCE(pair, '')='y' AND at > 1"), /signals_mint_at/);
  // watchedSince, once per look card.
  assert.match(plan("SELECT min(at) AS t FROM signals_log WHERE mode='dip' AND mint='x' AND at > 1"), /signals_mode_mint/);
  // Partial indexes only work while the query repeats their WHERE word for word.
  assert.match(plan("SELECT mode FROM signals_log WHERE taken=0 AND at > 1 AND mcap >= 5000 AND peak_price >= price * 2 ORDER BY peak_price / price DESC LIMIT 20"), /signals_missed/);
  assert.match(plan("SELECT mode, mint, max(at) AS at FROM signals_log WHERE at > 1 AND taken=0 AND reason LIKE '%paused: watching only%' GROUP BY mode, mint"), /signals_paused/);
  const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.ok(src.includes("WHERE taken=0 AND at > ? AND mcap >= 5000 AND peak_price >= price * 2"), "missed query still matches signals_missed");
  assert.ok(src.includes("WHERE at > ? AND taken=0 AND reason LIKE '%paused: watching only%'"), "would-buy query still matches signals_paused");
});

test("old looks are pruned at 14 days; real buys are kept", () => {
  db.exec("DELETE FROM signals_log");
  const old = Date.now() - 15 * 86_400_000;
  look.run("dip", "A", "A", 1, 0, "rejected: x", 1, old, null, 1, 1, 0);
  look.run("dip", "B", "B", 1, 1, "bought", 1, old, null, 1, 1, 0);
  look.run("dip", "C", "C", 1, 0, "waiting", 1, Date.now(), null, 1, 1, 0);
  recorder.prune(14);
  assert.deepEqual((db.prepare("SELECT mint FROM signals_log ORDER BY mint").all() as { mint: string }[]).map(r => r.mint), ["B", "C"]);
});
