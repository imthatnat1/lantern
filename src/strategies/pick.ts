import { config, type ModeCfg } from "../config.js";
import { log } from "../log.js";
import type { ExitPlan, Signal } from "../types.js";
import { structuralStop } from "../engine/exits.js";
import * as broker from "../engine/broker.js";
import { atr, lowestLow } from "../data/gecko.js";
import { kv, positions } from "../db.js";
import { candles5and15, dex, gate, logLook, logSignal } from "./base.js";

const C: ModeCfg<"pick"> = config.modes.pick;

/**
 * Nat's picks (18 Oct): a Buy button on each Watching card. Her tap replaces the entry pattern, nothing else.
 * The coin still goes through the full entry gate (rug checks, bot volume, test sell, exit impact) and every
 * guardrail (Global stop, daily loss stop, drawdown halt, capital at risk, allocation, cash). Paper money,
 * like every other mode, tracked as its own mode so we can see whether picks beat the bot.
 */
export interface PickResult { ok: boolean; why?: string; symbol?: string; price?: number; stop?: number; sizeUsd?: number }

export function pickPlan(low: number): (entry: number, atr15: number) => ExitPlan {
  return (entry, atr15) => ({
    hardFloorPct: 0.45,
    closeStopPrice: structuralStop(entry, low, atr15, 0.5, 0.30),
    takeProfits: [{ gain: 0.5, sell: 0.5 }],
    trailPct: 0.20, trailAfterGain: 0.30,
    maxHoldMs: C.backstopMs,
  });
}

export async function pickBuy(mint: string, env: { marks: Map<string, number>; feedHealthy: boolean; solPrice: number }, now = Date.now()): Promise<PickResult> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return { ok: false, why: "that isn't a coin address" };
  if (kv.get("paused", false)) return { ok: false, why: "Global stop is on, resume first" };
  if (positions.isHeld(mint)) return { ok: false, why: "already holding it" };
  if (broker.modeOpenCount("pick") >= C.maxOpen) return { ok: false, why: `you already have ${C.maxOpen} picks open` };

  const s = await dex.snapshot(mint);
  if (!s) return { ok: false, why: "couldn't get a live price for it" };
  const fail = (why: string): PickResult => { logLook("pick", s, why.startsWith("rejected") ? why : `your pick: ${why}`); return { ok: false, why, symbol: s.symbol }; };
  if (s.change1h <= -50) return fail(`rejected: crashing, down ${Math.abs(s.change1h).toFixed(0)}% in the hour`);
  if (s.liquidityUsd < C.minLiquidity) return fail(`rejected: too thin, $${Math.round(s.liquidityUsd / 1000)}k liquidity (needs $${C.minLiquidity / 1000}k)`);

  const g = await gate(s, "pick", C.sizeUsd);
  if (!g.ok) return fail(g.why!.startsWith("rejected") ? g.why! : `rejected: ${g.why}`);
  if ((g.holders ?? 0) < C.minHolders) return fail(`rejected: only ${g.holders ?? "?"} holders (needs ${C.minHolders})`);

  let c15 = [] as Awaited<ReturnType<typeof candles5and15>>["c15"];
  let a15 = 0, low = s.priceUsd * 0.8;
  if (s.pairAddress) {
    try { ({ c15 } = await candles5and15(s.pairAddress)); if (c15.length) { a15 = atr(c15); low = lowestLow(c15, now - 3 * 3_600_000); } } catch { /* no candles: 20% under price, the stop clamps at 30% */ }
  }
  const sig: Signal = {
    mode: "pick", mint: s.mint, symbol: s.symbol, sizeUsd: C.sizeUsd, score: 0,
    reason: "your pick from Watching", snapshot: s, candles15: c15,
    meta: { atr15: a15, holders: g.holders },
    plan: pickPlan(low),
  };
  const r = broker.canOpen(sig, env.marks, env.feedHealthy);
  if (!r.ok) { logSignal(sig, false, r.why!); return { ok: false, why: r.why, symbol: s.symbol }; }
  const p = broker.openPosition(sig, env.solPrice, now);
  logSignal(sig, true, "opened (your pick)");
  env.marks.set(s.mint, s.priceUsd);
  log.info({ sym: s.symbol, price: p.entryPrice }, "pick opened from dashboard");
  return { ok: true, symbol: s.symbol, price: p.entryPrice, stop: p.plan.closeStopPrice, sizeUsd: C.sizeUsd };
}
