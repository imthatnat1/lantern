import { test } from "node:test";
import assert from "node:assert/strict";
import { watchdogWhy } from "../src/engine/watchdog.js";

const M = 60_000;
const base = { now: 100 * M, lastTickDoneAt: 100 * M - 10_000, tickStartedAt: 100 * M - 5_000, tickStage: "scan", dexLastOk: 100 * M - 2_000, upMs: 90 * M };

test("healthy loop: no restart", () => {
  assert.equal(watchdogWhy(base), null);
});

test("a slow scan (10 min) is allowed", () => {
  assert.equal(watchdogWhy({ ...base, lastTickDoneAt: base.now - 10 * M }), null);
});

test("20 Oct freeze: no finished pass for 7 hours = restart, naming the stage", () => {
  const why = watchdogWhy({ ...base, lastTickDoneAt: base.now - 420 * M, tickStartedAt: base.now - 420 * M, dexLastOk: base.now - 420 * M, tickStage: "scan" });
  assert.match(why!, /stuck in scan/);
});

test("loop finishing but DexScreener silent 30+ min = restart", () => {
  assert.match(watchdogWhy({ ...base, dexLastOk: base.now - 45 * M })!, /no DexScreener price for 45 min/);
});

test("silent DexScreener right after a restart waits out the grace period", () => {
  assert.equal(watchdogWhy({ ...base, dexLastOk: base.now - 45 * M, upMs: 10 * M }), null);
});

test("21 Oct: stop checks on their own loop; 5 min without a finished exit pass = restart", () => {
  assert.equal(watchdogWhy({ ...base, lastExitDoneAt: base.now - 2 * M, exitStage: "exit" }), null);
  assert.match(watchdogWhy({ ...base, lastExitDoneAt: base.now - 6 * M, exitStage: "exit" })!, /stop checks/);
});

test("a strategy scan that never comes back is named", () => {
  assert.equal(watchdogWhy({ ...base, scansInFlight: [{ name: "launch", since: base.now - 10 * M }] }), null);
  assert.match(watchdogWhy({ ...base, scansInFlight: [{ name: "launch", since: base.now - 31 * M }] })!, /launch scan never came back/);
});
