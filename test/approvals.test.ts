import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const ap = await import("../src/engine/approvals.js");

const on = { enabled: true, aboveUsd: 20, ttlMs: 10 * 60_000, maxDriftPct: 0.15 };
const sig = (mint: string, sizeUsd: number, mode = "launch") => ({ mode, mint, symbol: mint, sizeUsd, score: 70, reason: "test", candles15: [],
  snapshot: { priceUsd: 1 }, plan: () => ({}) } as any);
const T = Date.now();

test("off by default, and on paper nothing waits", () => {
  assert.equal(ap.APPROVALS.enabled, false);
  assert.equal(ap.needsApproval(sig("A", 500)), false);
});

test("when on, only buys above the line wait; Nat's own picks never do", () => {
  assert.equal(ap.needsApproval(sig("A", 12), on), false);
  assert.equal(ap.needsApproval(sig("A", 25), on), true);
  assert.equal(ap.needsApproval(sig("A", 25, "pick"), on), false);
});

test("yes hands the signal back once; no and silence don't", () => {
  const a = ap.queue(sig("YES", 25), T);
  assert.equal(ap.queue(sig("YES", 25), T), a, "one request per coin and mode");
  const b = ap.queue(sig("NO", 25), T);
  const c = ap.queue(sig("LATE", 25), T - 11 * 60_000);
  assert.equal(ap.approvalsState(T, on).pending.length, 3);
  assert.deepEqual(ap.decide(a, true, T), { ok: true });
  assert.deepEqual(ap.decide(b, false, T), { ok: true });
  assert.equal(ap.decide(b, true, T).ok, false, "can't change a no");
  const got = ap.takeApproved(T, on);
  assert.deepEqual(got.map(g => g.sig.mint), ["YES"]);
  ap.done(a, true, "bought", T);
  assert.equal(ap.takeApproved(T, on).length, 0, "bought once");
  const st = ap.approvalsState(T, on);
  assert.equal(st.pending.length, 0);
  const status = Object.fromEntries((st.recent as any[]).map(r => [r.symbol, r.status]));
  assert.deepEqual(status, { YES: "bought", NO: "declined", LATE: "expired" });
  assert.equal(ap.decide(c, true, T).ok, false, "too late");
});

test("an approved buy is dropped if the price ran off while it waited", () => {
  assert.equal(ap.driftWhy(1, 1.1, on), null);
  assert.match(ap.driftWhy(1, 1.3, on) ?? "", /price moved \+30% while it waited/);
  assert.match(ap.driftWhy(1, 0.8, on) ?? "", /-20%/);
});
