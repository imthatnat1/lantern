import { config } from "./config.js";
import { log } from "./log.js";
import { positions, cooldowns, kv, market, db, recorder } from "./db.js";
import { startLab } from "./lab/scheduler.js";
import { PumpPortal } from "./data/pumpportal.js";
import * as dex from "./data/dexscreener.js";
import * as gecko from "./data/gecko.js";
import * as jup from "./data/jupiter.js";
import * as rug from "./data/rugcheck.js";
import { readPrice } from "./engine/price.js";
import { evaluate } from "./engine/exits.js";
import * as broker from "./engine/broker.js";
import { logSignal, type Context, type Strategy } from "./strategies/base.js";
import { ultra } from "./strategies/ultra.js";
import { bounce } from "./strategies/bounce.js";
import { pullback } from "./strategies/pullback.js";
import { trusted } from "./strategies/trusted.js";
import { dip } from "./strategies/dip.js";
import { ride } from "./strategies/ride.js";
import { startServer, snapshotEquity } from "./server.js";
import { ensureWebhook, soldSince, rotateKols } from "./data/wallets.js";

const strategies: Strategy[] = [ride, dip, ultra, bounce, pullback, trusted];
const lastRun = new Map<string, number>();
const migrations = new Map<string, number>(kv.get<[string, number][]>("migrations", []));
const markPrices = new Map<string, number>();
let solPrice = 150;
let lastDexOk = Date.now();

const feed = new PumpPortal();
feed.on("migration", (m: { mint: string; at: number }) => {
  migrations.set(m.mint, m.at);
  try { recorder.migration(m.mint, m.at); } catch { /* best effort */ }
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
      if (snap) market.upsert(snap, p.meta.holders as number | undefined);
      let c15: Awaited<ReturnType<typeof gecko.candles>> = [];
      if (snap?.pairAddress) { try { c15 = await gecko.candles(snap.pairAddress, 15, 10); } catch { /* rate limited, judge on ticks only */ } }
      const lastClosed = c15.length >= 2 ? c15.at(-2) : undefined;
      const actions = evaluate(p, read, lastClosed, now);
      // Trusted copies mirror the wallet's exit: if any wallet that bought it has sold since we entered, we sell too.
      if (p.mode === "trusted" && read.confirmed && !actions.length) {
        const ws = (p.meta.walletAddrs as string[] | undefined) ?? [];
        if (soldSince(p.mint, p.entryAt, ws)) actions.push({ fraction: 1, reason: "mirror: trusted wallet sold" });
      }
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

/**
 * Missed-runner tracker: re-price every coin we looked at in the last 48h and keep its peak.
 * The dashboard turns "skipped, then ran 26x" into a lesson. Runs every 20 minutes.
 */
let lastMissedAt = 0;
async function missedRunnersLoop() {
  const now = Date.now();
  if (now - lastMissedAt < 20 * 60_000) return;
  lastMissedAt = now;
  const since = now - 48 * 3_600_000;
  const rows = db.prepare(`SELECT DISTINCT mint, COALESCE(pair, '') AS pair FROM signals_log WHERE at > ? AND taken=0 ORDER BY at DESC LIMIT 120`).all(since) as { mint: string; pair: string }[];
  if (!rows.length) return;
  const byMint = await dex.pairsByMint([...new Set(rows.map(r => r.mint))].slice(0, 90));
  const upd = db.prepare(`UPDATE signals_log SET last_price=?, peak_price=MAX(peak_price, ?), peak_checked_at=? WHERE mint=? AND COALESCE(pair, '')=? AND at > ?`);
  for (const r of rows) {
    const pairs = byMint.get(r.mint);
    if (!pairs?.length) continue;
    // Re-price the pair we looked at, as long as it still trades. If it stopped (curve finished, pool drained),
    // follow the coin to its best live pair. Never a dust pool: that's how wibet showed a fake 783x.
    const traded = dex.tradedPairs(pairs);
    const p = traded.find(x => x.pairAddress === r.pair) ?? dex.bestPair(pairs);
    const price = Number(p?.priceUsd ?? 0);
    if (!price) continue;
    upd.run(price, price, now, r.mint, r.pair, since);
  }
  for (const [mint, pairs] of byMint) {
    const p = dex.bestPair(pairs);
    const s = p ? await dex.snapshotFromPair(mint, p) : null;
    if (s) market.upsert(s);
  }
}

/**
 * Holder velocity: re-check holder counts for coins on the radar every 5 minutes, so strategies can
 * see "holders +18% in 10m". Volume can be faked by one wallet; a rising holder count is harder.
 */
let lastHoldersAt = 0;
async function holdersLoop() {
  const now = Date.now();
  if (now - lastHoldersAt < 5 * 60_000) return;
  lastHoldersAt = now;
  const rows = db.prepare(`SELECT DISTINCT mint, on_curve FROM market WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 25`).all(now - 30 * 60_000) as { mint: string; on_curve: number }[];
  for (const r of rows) {
    try { await rug.safety(r.mint, !!r.on_curve); } catch { /* recorded inside safety() when it works */ }
  }
}

async function scanLoop() {
  const now = Date.now();
  if (kv.get("paused", false)) return;
  const ctx: Context = { now, solPrice, migrations };
  const feedHealthy = now - Math.max(lastDexOk, dex.lastOkAt) < config.risk.feedStaleMs;
  for (const s of strategies) {
    if (config.pausedModes.includes(s.name)) continue;
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
  try { kv.set("build", (await import("node:child_process")).execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()); } catch { /* not a git checkout */ }
  feed.start();
  const publicUrl = process.env.PUBLIC_URL ?? "http://134.199.147.128:8787";
  ensureWebhook(publicUrl).catch(e => log.warn({ err: String(e) }, "webhook setup failed"));
  setTimeout(() => rotateKols(publicUrl).catch(e => log.warn({ err: String(e) }, "kol rotation failed")), 60_000);
  setInterval(() => rotateKols(publicUrl).catch(e => log.warn({ err: String(e) }, "kol rotation failed")), 6 * 3_600_000);
  startServer(() => markPrices, () => ({
    feedDownS: Math.round(Math.min(feed.downForMs, 99_999_000) / 1000),
    dexStaleS: Math.round((Date.now() - Math.max(lastDexOk, dex.lastOkAt)) / 1000),
  }));
  startLab();
  solPrice = await jup.solPrice();
  setInterval(async () => { solPrice = await jup.solPrice(); }, 60_000);
  const tick = async () => {
    try { await exitLoop(); } catch (e) { log.error({ err: String(e) }, "exitLoop crashed"); }
    try { await scanLoop(); } catch (e) { log.error({ err: String(e) }, "scanLoop crashed"); }
    try { await missedRunnersLoop(); } catch (e) { log.warn({ err: String(e) }, "missedRunners failed"); }
    try { await holdersLoop(); } catch (e) { log.warn({ err: String(e) }, "holdersLoop failed"); }
    setTimeout(tick, 5000);
  };
  tick();
  setInterval(heartbeat, 5 * 60_000);
  setInterval(() => { try { recorder.prune(14); } catch (e) { log.warn({ err: String(e) }, "prune failed"); } }, 6 * 3_600_000);
  heartbeat();
}

process.on("unhandledRejection", (e) => log.error({ err: String(e) }, "unhandled rejection"));
main();
