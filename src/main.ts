import { config } from "./config.js";
import { log } from "./log.js";
import { positions, cooldowns, kv, market, db, recorder, hot, reprice } from "./db.js";
import { startLab } from "./lab/scheduler.js";
import { PumpPortal } from "./data/pumpportal.js";
import * as dex from "./data/dexscreener.js";
import { pickBuy } from "./strategies/pick.js";
import * as gecko from "./data/gecko.js";
import * as jup from "./data/jupiter.js";
import * as rug from "./data/rugcheck.js";
import { readPrice } from "./engine/price.js";
import { evaluate, wantAdd } from "./engine/exits.js";
import { repairAllinu19Oct, repairDacity20Oct } from "./repair.js";
import * as broker from "./engine/broker.js";
import { candles5and15, logSignal, type Context, type Strategy } from "./strategies/base.js";
import * as liveCandles from "./data/livecandles.js";
import type { Candle } from "./types.js";
import { ultra } from "./strategies/ultra.js";
import { bounce } from "./strategies/bounce.js";
import { pullback } from "./strategies/pullback.js";
import { trusted } from "./strategies/trusted.js";
import { dip } from "./strategies/dip.js";
import { ride } from "./strategies/ride.js";
import { launch } from "./strategies/launch.js";
import { startServer, snapshotEquity } from "./server.js";
import { ensureWebhook, rotateKols } from "./data/wallets.js";
import { walletSellCheck } from "./engine/walletsell.js";
import { pruneCreates, recordCreate } from "./data/creators.js";
import { refreshFx } from "./data/fx.js";
import { done as approvalDone, driftWhy, needsApproval, queue as queueApproval, takeApproved } from "./engine/approvals.js";
import { takeGraduations } from "./data/stonkfun.js";
import { flagshipMints } from "./data/universe.js";
import { currentMood, moodScore, moodSizeX, saveMood } from "./engine/mood.js";

const strategies: Strategy[] = [ride, dip, ultra, launch, bounce, pullback, trusted];
const lastRun = new Map<string, number>();
const migrations = new Map<string, number>(kv.get<[string, number][]>("migrations", []));
const markPrices = new Map<string, number>();
let solPrice = 150;
let lastDexOk = Date.now();

const feed = new PumpPortal();
function addMigration(m: { mint: string; at: number }) {
  migrations.set(m.mint, m.at);
  try { recorder.migration(m.mint, m.at); } catch { /* best effort */ }
  for (const [k, v] of migrations) if (Date.now() - v > 12 * 3_600_000) migrations.delete(k);
  kv.set("migrations", [...migrations.entries()]);
}
feed.on("migration", addMigration);
// Every pump.fun create, for counting a creator's launches (serial creator check). Spoofed ones are counted, not kept.
feed.on("new", (e: { mint?: string; creator?: string; signature?: string; at: number }) => { try { recordCreate(e); } catch { /* best effort */ } });

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
      // 15m closes from our own live candles (fresh every 20s), not a GeckoTerminal call per position.
      let c15: Candle[] = [];
      if (snap?.pairAddress) { try { c15 = (await candles5and15(snap.pairAddress)).c15; } catch { /* no history yet: judge on ticks only */ } }
      const lastClosed = c15.length >= 2 ? c15.at(-2) : undefined;
      const actions = evaluate(p, read, lastClosed, now);
      // Trusted wallets selling a coin we hold (any mode, engine/walletsell.ts): the wallet we copied dumping most of its
      // bag = exit; any other trusted sell = tighter trail and a warning. Exits fill on a confirmed price only.
      if (!actions.length) {
        const ws = await walletSellCheck(p, now);
        if (ws?.kind === "exit" && read.confirmed) actions.push({ fraction: 1, reason: ws.reason });
      }
      for (const a of actions) {
        if ((p.status as string) !== "open") break;
        broker.sell(p, a.fraction, read.price, snap?.liquidityUsd ?? p.liquidityAtEntry, snap?.onCurve ?? false, solPrice, a.reason, now, a.trigger);
        if ((p.status as string) === "closed" && (a.reason.startsWith("close stop") || a.reason.startsWith("hard floor"))) {
          cooldowns.set(p.mode, p.mint, now + 6 * 3_600_000);   // 6h before re-entering a stop-out
        }
      }
      // Adding to winners: a green 15m close at a new high, buyers at least matching sellers, at the mode's next level.
      if (p.status === "open" && !actions.length && snap) {
        const want = wantAdd(p, read, lastClosed, broker.addRuleFor(p.mode), snap.buys5m >= snap.sells5m);
        if (want) {
          const feedHealthy = now - Math.max(lastDexOk, dex.lastOkAt) < config.risk.feedStaleMs;
          const ok = broker.canAdd(p, want.usd, markPrices, feedHealthy);
          const gain = read.price / ((p.meta.firstEntry as number | undefined) ?? p.entryPrice) - 1;
          if (ok.ok) broker.addTo(p, want.usd, read.price, snap.liquidityUsd, snap.onCurve, solPrice, `add #${want.step} at +${Math.round(gain * 100)}%: new high on a green 15m close`, lastClosed?.t, now);
          else { p.meta.lastAddCloseT = lastClosed?.t; log.info({ sym: p.symbol, why: ok.why }, "add skipped"); }   // once per candle
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
  // Would-have-bought signals from paused modes first, so their outcome is always tracked; then the latest looks.
  const rows = db.prepare(`SELECT mint, COALESCE(pair, '') AS pair, MAX(reason LIKE '%paused: watching only%') AS w, MAX(at) AS t FROM signals_log
    WHERE at > ? AND taken=0 GROUP BY mint, COALESCE(pair, '') ORDER BY w DESC, t DESC LIMIT 120`).all(since) as { mint: string; pair: string }[];
  if (!rows.length) return;
  const byMint = await dex.pairsByMint([...new Set(rows.map(r => r.mint))].slice(0, 90));

  for (const r of rows) {
    const pairs = byMint.get(r.mint);
    if (!pairs?.length) continue;
    // Re-price the pair we looked at, as long as it still trades. If it stopped (curve finished, pool drained),
    // follow the coin to its best live pair. Never a dust pool: that's how wibet showed a fake 783x.
    const traded = dex.tradedPairs(pairs);
    const p = traded.find(x => x.pairAddress === r.pair) ?? dex.bestPair(pairs);
    const price = Number(p?.priceUsd ?? 0);
    if (!price) continue;
    reprice(r.mint, r.pair, price, now, since);
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
  // Stonk.fun graduations (seen in its API every 10 min) go to bounce the same way pump.fun migrations do.
  for (const g of takeGraduations()) { addMigration(g); log.info({ mint: g.mint }, "stonkfun graduation"); }
  const ctx: Context = { now, solPrice, migrations };
  const feedHealthy = now - Math.max(lastDexOk, dex.lastOkAt) < config.risk.feedStaleMs;
  // Approval queue (engine/approvals.ts, off unless APPROVALS=on): buys Nat said yes to, re-checked at today's price.
  for (const { id, sig } of takeApproved(now)) {
    const snap = (await dex.snapshots([sig.mint])).get(sig.mint);
    const drift = snap ? driftWhy(sig.snapshot.priceUsd, snap.priceUsd) : "couldn't price it";
    if (drift) { approvalDone(id, false, drift); logSignal(sig, false, `approved, but ${drift}`); continue; }
    sig.snapshot = snap!;
    const cfg = (config.modes as any)[sig.mode];
    const r = broker.modeOpenCount(sig.mode) >= cfg.maxOpen ? { ok: false, why: "mode full" } : broker.canOpen(sig, markPrices, feedHealthy);
    if (!r.ok) { approvalDone(id, false, r.why!); logSignal(sig, false, `approved, but ${r.why}`); continue; }
    broker.openPosition(sig, solPrice, now);
    logSignal(sig, true, "opened (approved by Nat)");
    approvalDone(id, true, "bought");
    markPrices.set(sig.mint, sig.snapshot.priceUsd);
  }
  for (const s of strategies) {
    // Paused modes still watch (at a third of the pace, to spare GeckoTerminal) so their setups show on
    // the dashboard and their candles get recorded for the lab. They just never buy.
    const paused = config.pausedModes.includes(s.name);
    // Paused dip still runs at full pace: it's the flagship dip watch (fewer coins, flagships first, see dip.ts).
    if (now - (lastRun.get(s.name) ?? 0) < s.everyMs * (paused && s.name !== "dip" ? 3 : 1)) continue;
    lastRun.set(s.name, now);
    let sigs;
    try { sigs = await s.scan(ctx); } catch (e) { log.warn({ mode: s.name, err: String(e) }, "scan failed"); continue; }
    sigs.sort((a, b) => b.score - a.score);
    for (const sig of sigs) {
      if (paused) { logSignal(sig, false, `${sig.mode} is paused: watching only`); continue; }
      // Market mood sizing: half size when fearful, 1.5x when green (engine/mood.ts). Capped by the single-trade limit.
      const mx = moodSizeX(sig.mode, now);
      if (mx !== 1) { sig.sizeUsd = Math.min(sig.sizeUsd * mx, config.risk.maxSingleTradeUsd); sig.reason += ` · ${mx}x size, ${currentMood()?.level} market`; }
      const cfg = (config.modes as any)[sig.mode];
      if (broker.modeOpenCount(sig.mode) >= cfg.maxOpen) { logSignal(sig, false, "mode full"); continue; }
      const r = broker.canOpen(sig, markPrices, feedHealthy);
      if (!r.ok) { logSignal(sig, false, r.why!); continue; }
      if (needsApproval(sig)) { const id = queueApproval(sig, now); logSignal(sig, false, `waiting for Nat's yes (request #${id})`); continue; }
      broker.openPosition(sig, solPrice, now);
      logSignal(sig, true, "opened");
      markPrices.set(sig.mint, sig.snapshot.priceUsd);
    }
  }
}

/**
 * Market mood: every 10 minutes, read the flagships, SOL and the pump.fun launch flow, and score the market
 * 0-100 (engine/mood.ts). New bets are sized by it: half when fearful, 1.5x when green.
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";
let lastMoodAt = 0;
async function moodLoop() {
  const now = Date.now();
  if (now - lastMoodAt < 10 * 60_000) return;
  lastMoodAt = now;
  const flag = [...(await dex.snapshots(flagshipMints().slice(0, 30))).values()];
  const share = (xs: number[]) => xs.length ? xs.filter(x => x > 0).length / xs.length : null;
  const sol = (await dex.snapshots([SOL_MINT])).get(SOL_MINT);
  const ats = [...migrations.values()];
  const lastHour = ats.filter(t => now - t < 3_600_000).length;
  const perHour12 = ats.filter(t => now - t < 12 * 3_600_000).length / 12;
  const recent = [...migrations.entries()].filter(([, t]) => now - t < 3 * 3_600_000).map(([m]) => m).slice(-60);
  const recentSnaps = [...(await dex.snapshots(recent)).values()].filter(s => s.liquidityUsd >= 10_000);
  const m = moodScore({
    flagships6h: share(flag.map(s => s.change6h)),
    flagships1h: share(flag.map(s => s.change1h)),
    sol24h: sol ? sol.change24h : null, sol6h: sol ? sol.change6h : null,
    launchesRatio: perHour12 >= 1 ? lastHour / perHour12 : null,
    followThru: recentSnaps.length >= 5 ? share(recentSnaps.map(s => s.change1h)) : null,
  }, currentMood()?.score, now);
  saveMood(m);
  log.info({ score: m.score, level: m.level, sizeX: m.sizeX, parts: m.parts }, "market mood");
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
  repairAllinu19Oct();
  repairDacity20Oct();
  try { kv.set("build", (await import("node:child_process")).execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()); } catch { /* not a git checkout */ }
  feed.start();
  const publicUrl = process.env.PUBLIC_URL ?? "http://134.199.147.128:8787";
  ensureWebhook(publicUrl).catch(e => log.warn({ err: String(e) }, "webhook setup failed"));
  setTimeout(() => rotateKols(publicUrl).catch(e => log.warn({ err: String(e) }, "kol rotation failed")), 60_000);
  setInterval(() => rotateKols(publicUrl).catch(e => log.warn({ err: String(e) }, "kol rotation failed")), 6 * 3_600_000);
  startServer(() => markPrices, () => ({
    feedDownS: Math.round(Math.min(feed.downForMs, 99_999_000) / 1000),
    dexStaleS: Math.round((Date.now() - Math.max(lastDexOk, dex.lastOkAt)) / 1000),
  }), mint => pickBuy(mint, {
    marks: markPrices, solPrice,
    feedHealthy: Date.now() - Math.max(lastDexOk, dex.lastOkAt) < config.risk.feedStaleMs,
  }));
  startLab();
  // Live candles: price every wanted pair from DexScreener every 20s (see data/livecandles.ts).
  let polling = false;
  setInterval(async () => {
    if (polling) return;
    polling = true;
    try { await liveCandles.poll(); } catch (e) { log.debug({ err: String(e) }, "live candles poll failed"); } finally { polling = false; }
  }, liveCandles.POLL_MS);
  refreshFx().catch(() => null);
  setInterval(() => refreshFx().catch(() => null), 3_600_000);   // USD/AUD for tax (data/fx.ts)
  solPrice = await jup.solPrice();
  setInterval(async () => { solPrice = await jup.solPrice(); }, 60_000);
  const tick = async () => {
    try { await exitLoop(); } catch (e) { log.error({ err: String(e) }, "exitLoop crashed"); }
    try { await scanLoop(); } catch (e) { log.error({ err: String(e) }, "scanLoop crashed"); }
    try { await missedRunnersLoop(); } catch (e) { log.warn({ err: String(e) }, "missedRunners failed"); }
    try { await holdersLoop(); } catch (e) { log.warn({ err: String(e) }, "holdersLoop failed"); }
    try { await moodLoop(); } catch (e) { log.warn({ err: String(e) }, "moodLoop failed"); }
    setTimeout(tick, 5000);
  };
  tick();
  setInterval(heartbeat, 5 * 60_000);
  setInterval(() => { try { hot.prune(); } catch { /* best effort */ } }, 3_600_000);
  setInterval(() => { try { recorder.prune(14); pruneCreates(); } catch (e) { log.warn({ err: String(e) }, "prune failed"); } }, 6 * 3_600_000);
  heartbeat();
}

process.on("unhandledRejection", (e) => log.error({ err: String(e) }, "unhandled rejection"));
main();
