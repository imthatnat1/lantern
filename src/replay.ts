/**
 * Replay: re-run the exit engine over recorded ticks and candles, with different plan settings,
 * against every signal the bot saw in a window (taken or not).
 *
 *   npm run replay -- --hours 24
 *   npm run replay -- --hours 24 --mode pullback --min-score 60
 *   npm run replay -- --hours 48 --variant '{"hardFloorPct":0.35,"trailPct":0.2}' --variant '{"maxLoss":0.5}'
 *
 * Each variant is a JSON object of overrides applied on top of the plan the strategy produced:
 *   hardFloorPct, trailPct, trailAfterGain, tpGain, tpSell, maxLoss (clamps the close stop to entry*(1-maxLoss)),
 *   sizeUsd. Fees and slippage use the live model. Output: a table per variant.
 *
 * Honest limits: entries come from the signals we actually logged, so a looser *entry* rule can't be
 * replayed from here yet (that needs the detectors to run on recorded candles; next step). Exits can.
 */
import "dotenv/config";
import { db } from "./db.js";
import { evaluate } from "./engine/exits.js";
import { fillModel } from "./engine/broker.js";
import { structuralStop } from "./engine/exits.js";
import type { Candle, ExitPlan, Mode, Position } from "./types.js";

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const all = (k: string) => args.flatMap((a, i) => a === `--${k}` ? [args[i + 1]] : []);

const hours = Number(opt("hours", "24"));
const modeFilter = opt("mode") as Mode | undefined;
const minScore = Number(opt("min-score", "0"));
const takenOnly = args.includes("--taken-only");
const variants = all("variant").map(v => JSON.parse(v) as Record<string, number>);
if (!variants.length) variants.push({});
const SOL = 150;

const since = Date.now() - hours * 3_600_000;
const sigs = db.prepare(`SELECT s.*, m.pair, m.liquidity AS liq_now, m.on_curve FROM signals_log s LEFT JOIN market m ON m.mint=s.mint
  WHERE s.at >= ? AND s.score > 0 ${modeFilter ? "AND s.mode=?" : ""} ${takenOnly ? "AND s.taken=1" : ""} ORDER BY s.at`)
  .all(...(modeFilter ? [since, modeFilter] : [since])) as any[];

if (!sigs.length) { console.log(`No scored signals in the last ${hours}h${modeFilter ? " for " + modeFilter : ""}. Give the recorder time.`); process.exit(0); }

const tickQ = db.prepare("SELECT at, price, liquidity FROM ticks WHERE mint=? AND at>? ORDER BY at");
const candleQ = db.prepare("SELECT t,o,h,l,c,v FROM candles WHERE pair=? AND agg=15 AND t>? ORDER BY t");
const lowQ = db.prepare("SELECT MIN(l) AS lo FROM candles WHERE pair=? AND agg=15 AND t BETWEEN ? AND ?");

/** Default plan per mode, mirroring the strategies. Replay can't call the detectors, so it rebuilds the plan shape. */
function basePlan(mode: Mode, entry: number, pair: string | null, at: number): ExitPlan {
  const atr = entry * 0.05;
  const lo6 = pair ? ((lowQ.get(pair, at - 6 * 3_600_000, at) as any)?.lo ?? entry * 0.8) : entry * 0.8;
  const lo24 = pair ? ((lowQ.get(pair, at - 24 * 3_600_000, at) as any)?.lo ?? entry * 0.8) : entry * 0.8;
  switch (mode) {
    case "ultra": return { hardFloorPct: 0.55, closeStopPrice: structuralStop(entry, lo6, atr, 1, 0.5), takeProfits: [{ gain: 1, sell: 0.33 }], trailPct: 0.3, trailAfterGain: 0.5, trailLadder: [{ peakGain: 1, trailPct: 0.35 }, { peakGain: 3, trailPct: 0.45 }], maxHoldMs: 0 };
    case "pullback": return { hardFloorPct: 0.45, closeStopPrice: structuralStop(entry, lo6, atr, 1, 0.35), takeProfits: [{ gain: 0.6, sell: 0.33 }], trailPct: 0.25, trailAfterGain: 0.4, trailLadder: [{ peakGain: 1, trailPct: 0.3 }, { peakGain: 3, trailPct: 0.4 }], maxHoldMs: 12 * 3_600_000 };
    case "bounce": return { hardFloorPct: 0.45, closeStopPrice: structuralStop(entry, lo6, atr, 0.5, 0.25), takeProfits: [{ gain: 0.45, sell: 0.5 }], trailPct: 0.2, trailAfterGain: 0.3, maxHoldMs: 12 * 3_600_000 };
    case "trusted": return { hardFloorPct: 0.45, closeStopPrice: structuralStop(entry, lo6, atr, 1, 0.3), takeProfits: [{ gain: 1, sell: 0.5 }], trailPct: 0.3, trailAfterGain: 0.6, maxHoldMs: 24 * 3_600_000 };
    case "dip": return { hardFloorPct: 0.4, closeStopPrice: structuralStop(entry, lo24, atr, 1, 0.25), takeProfits: [{ gain: 0.4, sell: 0.33 }], trailPct: 0.2, trailAfterGain: 0.2, trailLadder: [{ peakGain: 0.6, trailPct: 0.25 }], maxHoldMs: 0 };
    case "ride": return { hardFloorPct: 0.3, closeStopPrice: structuralStop(entry, lo6, atr, 0.5, 0.15), takeProfits: [{ gain: 0.15, sell: 0.5 }], trailPct: 0.12, trailAfterGain: 0.06, maxHoldMs: 12 * 3_600_000 };
  }
}

function applyVariant(plan: ExitPlan, v: Record<string, number>, entry: number): ExitPlan {
  const p: ExitPlan = JSON.parse(JSON.stringify(plan));
  if (v.hardFloorPct != null) p.hardFloorPct = v.hardFloorPct;
  if (v.trailPct != null) p.trailPct = v.trailPct;
  if (v.trailAfterGain != null) p.trailAfterGain = v.trailAfterGain;
  if (v.tpGain != null && p.takeProfits[0]) p.takeProfits[0].gain = v.tpGain;
  if (v.tpSell != null && p.takeProfits[0]) p.takeProfits[0].sell = v.tpSell;
  if (v.maxLoss != null) p.closeStopPrice = Math.max(p.closeStopPrice, entry * (1 - v.maxLoss));
  return p;
}

interface Result { symbol: string; mode: Mode; pnl: number; pct: number; reason: string; heldMin: number; ticks: number }

function simulate(sig: any, v: Record<string, number>): Result | null {
  const ticks = tickQ.all(sig.mint, sig.at) as { at: number; price: number; liquidity: number }[];
  if (ticks.length < 3) return null;
  const c15 = sig.pair ? (candleQ.all(sig.pair, sig.at) as Candle[]) : [];
  const size = v.sizeUsd ?? (sig.mode === "ultra" ? 8 : sig.mode === "dip" ? 8 : sig.mode === "pullback" ? 5 : 4);
  const liq0 = sig.liquidity || sig.liq_now || 50_000;
  const { effPrice, feesUsd } = fillModel("buy", sig.price, size, liq0, !!sig.on_curve, SOL);
  const qty = (size - feesUsd) / effPrice;
  const plan = applyVariant(basePlan(sig.mode, effPrice, sig.pair, sig.at), v, effPrice);
  const p: Position = {
    id: 0, mode: sig.mode, mint: sig.mint, symbol: sig.symbol, entryPrice: effPrice, entryAt: sig.at, qty, remainingQty: qty,
    costUsd: size, peakPrice: effPrice, peakClose: effPrice, lastGoodPrice: sig.price, lastGoodAt: sig.at, atr15: effPrice * 0.05,
    liquidityAtEntry: liq0, plan, tpTaken: [], realizedUsd: 0, status: "open", meta: {},
  };
  let net = 0, ci = 0, lastReason = "still open", lastAt = sig.at;
  for (const t of ticks) {
    // Junk-tick guard, same rule as live: >40% jump needs the next tick to agree.
    const jump = Math.abs(t.price - p.lastGoodPrice) / p.lastGoodPrice;
    let confirmed = jump <= 0.4;
    if (!confirmed) { const nxt = ticks[ticks.indexOf(t) + 1]; confirmed = !!nxt && Math.abs(nxt.price - t.price) / t.price <= 0.15; }
    while (ci < c15.length && c15[ci].t + 15 * 60_000 <= t.at) ci++;
    const lastClosed = ci > 0 ? c15[ci - 1] : undefined;
    const actions = evaluate(p, { price: t.price, at: t.at, confirmed, source: "replay" }, lastClosed, t.at);
    for (const a of actions) {
      const q = p.remainingQty * a.fraction;
      const { effPrice: sp, feesUsd: sf } = fillModel("sell", t.price, q * t.price, t.liquidity || liq0, !!sig.on_curve, SOL);
      net += q * sp - sf; p.remainingQty -= q; lastReason = a.reason; lastAt = t.at;
      if (p.remainingQty <= p.qty * 0.001) { p.remainingQty = 0; p.status = "closed"; break; }
    }
    if (p.status === "closed") break;
  }
  if (p.remainingQty > 0) { const last = ticks.at(-1)!; net += p.remainingQty * last.price; lastAt = last.at; }
  const pnl = net - size;
  return { symbol: sig.symbol, mode: sig.mode, pnl, pct: pnl / size, reason: lastReason, heldMin: Math.round((lastAt - sig.at) / 60_000), ticks: ticks.length };
}

console.log(`Replaying ${sigs.length} signals from the last ${hours}h${modeFilter ? " (" + modeFilter + ")" : ""}${minScore ? `, score >= ${minScore}` : ""}\n`);
for (const v of variants) {
  const rows = sigs.filter(s => s.score >= minScore).map(s => simulate(s, v)).filter((r): r is Result => !!r);
  const wins = rows.filter(r => r.pnl > 0).length;
  const total = rows.reduce((a, r) => a + r.pnl, 0);
  console.log(`== variant ${JSON.stringify(v)}: ${rows.length} trades, ${wins} wins (${rows.length ? Math.round(wins / rows.length * 100) : 0}%), P&L ${total >= 0 ? "+" : ""}$${total.toFixed(2)}`);
  const byMode = new Map<string, { n: number; w: number; pnl: number }>();
  for (const r of rows) { const m = byMode.get(r.mode) ?? { n: 0, w: 0, pnl: 0 }; m.n++; if (r.pnl > 0) m.w++; m.pnl += r.pnl; byMode.set(r.mode, m); }
  for (const [m, x] of byMode) console.log(`   ${m.padEnd(9)} ${String(x.n).padStart(3)} trades  ${String(x.w).padStart(3)} wins  ${x.pnl >= 0 ? "+" : ""}$${x.pnl.toFixed(2)}`);
  if (args.includes("--trades")) for (const r of rows) console.log(`   ${r.symbol.padEnd(12)} ${r.mode.padEnd(9)} ${(r.pct * 100).toFixed(0).padStart(5)}%  $${r.pnl.toFixed(2).padStart(7)}  ${String(r.heldMin).padStart(5)}m  ${r.reason}`);
  console.log();
}
