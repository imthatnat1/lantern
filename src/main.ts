import { config } from "./config.js";
import { log } from "./log.js";
import { positions, cooldowns, kv } from "./db.js";
import { PumpPortal } from "./data/pumpportal.js";
import * as dex from "./data/dexscreener.js";
import * as gecko from "./data/gecko.js";
import * as jup from "./data/jupiter.js";
import { readPrice } from "./engine/price.js";
import { evaluate } from "./engine/exits.js";
import * as broker from "./engine/broker.js";
import { logSignal, type Context, type Strategy } from "./strategies/base.js";
import { ultra } from "./strategies/ultra.js";
import { bounce } from "./strategies/bounce.js";
import { pullback } from "./strategies/pullback.js";
import { trusted } from "./strategies/trusted.js";
import { startServer, snapshotEquity } from "./server.js";

const strategies: Strategy[] = [ultra, bounce, pullback, trusted];
const lastRun = new Map<string, number>();
const migrations = new Map<string, number>(kv.get<[string, number][]>("migrations", []));
const markPrices = new Map<string, number>();
let solPrice = 150;
let lastDexOk = Date.now();

const feed = new PumpPortal();
feed.on("migration", (m: { mint: string; at: number }) => {
  migrations.set(m.mint, m.at);
  for (const [k, v] of migrations) if (Date.now() - v > 12 * 3_600_000) migrations.delete(k);
  kv.set("migrations", [...migrations.entries()]);
});

async function exitLoop() {
  const open = positions.open();
  if (!open.length) return;
  const now = Date.now();
  for (const p of open) {
    try {
      const read = await readPrice(p.mint, p.lastGoodPrice);
      if (!read) continue;
      lastDexOk = now;
      if (read.confirmed) markPrices.set(p.mint, read.price);
      const snap = await dex.snapshot(p.mint);
      let c15: Awaited<ReturnType<typeof gecko.candles>> = [];
      if (snap?.pairAddress) { try { c15 = await gecko.candles(snap.pairAddress, 15, 10); } catch { /* rate limited, judge on ticks only */ } }
      const lastClosed = c15.length >= 2 ? c15.at(-2) : undefined;
      const actions = evaluate(p, read, lastClosed, now);
      for (const a of actions) {
        if ((p.status as string) !== "open") break;
        broker.sell(p, a.fraction, read.price, snap?.liquidityUsd ?? p.liquidityAtEntry, snap?.onCurve ?? false, solPrice, a.reason, now);
        if ((p.status as string) === "closed" && (a.reason.startsWith("close stop") || a.reason.startsWith("hard floor"))) {
          cooldowns.set(p.mode, p.mint, now + 6 * 3_600_000);   // 6h before re-entering a stop-out
        }
      }
      if (p.status === "open") positions.update(p);
    } catch (e) {
      log.warn({ sym: p.symbol, err: String(e) }, "exit loop error");
    }
  }
  broker.markPeakEquity(markPrices);
}

async function scanLoop() {
  const now = Date.now();
  const ctx: Context = { now, solPrice, migrations };
  const feedHealthy = now - lastDexOk < config.risk.feedStaleMs || positions.open().length === 0;
  for (const s of strategies) {
    if (now - (lastRun.get(s.name) ?? 0) < s.everyMs) continue;
    lastRun.set(s.name, now);
    let sigs;
    try { sigs = await s.scan(ctx); } catch (e) { log.warn({ mode: s.name, err: String(e) }, "scan failed"); continue; }
    sigs.sort((a, b) => b.score - a.score);
    for (const sig of sigs) {
      const cfg = (config.modes as any)[sig.mode];
      if (broker.modeOpenCount(sig.mode) >= cfg.maxOpen) { logSignal(sig, false, "mode full"); continue; }
      const r = broker.canOpen(sig, markPrices, feedHealthy);
      if (!r.ok) { logSignal(sig, false, r.why!); continue; }
      broker.openPosition(sig, solPrice, now);
      logSignal(sig, true, "opened");
      markPrices.set(sig.mint, sig.snapshot.priceUsd);
    }
  }
}

async function heartbeat() {
  const a = broker.account();
  const eq = broker.equity(markPrices);
  log.info({
    cash: a.cash.toFixed(2), vault: a.vault.toFixed(2), equity: eq.toFixed(2), peak: a.peakEquity.toFixed(2),
    open: positions.open().length, today: broker.realizedToday().toFixed(2),
    feedDownS: Math.round(feed.downForMs / 1000),
  }, "heartbeat");
  snapshotEquity(markPrices);
}

async function main() {
  log.info({ capital: config.startingCapital, modes: strategies.map(s => s.name) }, "lantern starting");
  if (!kv.get("startedAt", 0)) kv.set("startedAt", Date.now());
  feed.start();
  startServer(() => markPrices, () => ({
    feedDownS: Math.round(Math.min(feed.downForMs, 99_999_000) / 1000),
    dexStaleS: Math.round((Date.now() - lastDexOk) / 1000),
  }));
  solPrice = await jup.solPrice();
  setInterval(async () => { solPrice = await jup.solPrice(); }, 60_000);
  const tick = async () => {
    try { await exitLoop(); } catch (e) { log.error({ err: String(e) }, "exitLoop crashed"); }
    try { await scanLoop(); } catch (e) { log.error({ err: String(e) }, "scanLoop crashed"); }
    setTimeout(tick, 5000);
  };
  tick();
  setInterval(heartbeat, 5 * 60_000);
  heartbeat();
}

process.on("unhandledRejection", (e) => log.error({ err: String(e) }, "unhandled rejection"));
main();
