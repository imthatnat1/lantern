import { taxPct } from "../data/tax.js";
import { config } from "../config.js";
import { kv, positions, fills } from "../db.js";
import { log } from "../log.js";
import { isCreativePair } from "../data/universe.js";
import type { Fill, Mode, Position, Signal } from "../types.js";
import { applyAdd, type AddRule } from "./exits.js";
import { shadow } from "./shadow.js";
import { recordStopGap, setRealPrice } from "./stopgaps.js";

/** Paper account: cash, vault, peak equity, daily P&L. */
export interface Account { cash: number; vault: number; peakEquity: number }

export function account(): Account {
  return kv.get<Account>("account", { cash: config.startingCapital, vault: 0, peakEquity: config.startingCapital });
}
function saveAccount(a: Account) { kv.set("account", a); }

export function openValueUsd(markPrices: Map<string, number>): number {
  return positions.open().reduce((a, p) => a + p.remainingQty * (markPrices.get(p.mint) ?? p.lastGoodPrice), 0);
}

export function equity(markPrices: Map<string, number>): number {
  return account().cash + openValueUsd(markPrices);
}

/** Brisbane-day start in ms. */
export function brisbaneDayStart(now = Date.now()): number {
  const d = new Date(now + 10 * 3_600_000);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - 10 * 3_600_000;
}

export function realizedToday(): number {
  return positions.realizedSince(brisbaneDayStart());
}

/** Fee + slippage model. Returns effective price and fee in USD. */
export function fillModel(side: "buy" | "sell", priceUsd: number, usdSize: number, liquidityUsd: number, onCurve: boolean, solPrice: number, transferTaxPct = 0) {
  const f = config.fees;
  const txFeeUsd = (f.baseSol + f.prioritySol + f.tipSol) * solPrice;
  const dexFeePct = onCurve ? f.curveFeePct : f.poolFeePct;
  // Constant-product impact estimate: trade / (liquidity/2) gives roughly the price move.
  const impact = liquidityUsd > 0 ? usdSize / (liquidityUsd / 2) : 1;
  // Token-2022 transfer tax (Stonk.fun reward coins): fewer tokens in on a buy, fewer dollars out on a sell.
  const slip = f.baseSlippagePct + impact + transferTaxPct / 100;
  const effPrice = side === "buy" ? priceUsd * (1 + slip) : priceUsd * (1 - slip);
  const feesUsd = txFeeUsd + usdSize * dexFeePct;
  return { effPrice, feesUsd, impact };
}

export interface RiskCheck { ok: boolean; why?: string }

export function canOpen(sig: Signal, markPrices: Map<string, number>, feedHealthy: boolean): RiskCheck {
  const a = account();
  const eq = equity(markPrices);
  if (realizedToday() <= -config.risk.dailyLossStopUsd) return { ok: false, why: "daily loss stop" };
  if (eq < a.peakEquity * (1 - config.risk.drawdownHaltPct)) return { ok: false, why: "drawdown halt" };
  if (!feedHealthy) return { ok: false, why: "price feed stale" };
  const atRisk = openValueUsd(markPrices);
  if (atRisk + sig.sizeUsd > config.risk.maxCapitalAtRiskUsd) return { ok: false, why: "capital at risk cap" };
  if (sig.sizeUsd > config.risk.maxSingleTradeUsd) return { ok: false, why: "single trade cap" };
  const modeCap = eq * config.allocation[sig.mode];
  const modeOpen = positions.openByMode(sig.mode).reduce((s, p) => s + p.remainingQty * (markPrices.get(p.mint) ?? p.lastGoodPrice), 0);
  if (modeOpen + sig.sizeUsd > modeCap) return { ok: false, why: `${sig.mode} allocation full` };
  // ride holds a core and a sleeve on the same coin on purpose; everything else is one position per coin.
  if (sig.mode !== "ride" && positions.isHeld(sig.mint)) return { ok: false, why: "already held" };
  if (sig.sizeUsd > a.cash) return { ok: false, why: "no cash" };
  if (sig.snapshot.liquidityUsd < config.minExitLiquidityUsd[sig.mode]) return { ok: false, why: "below min exit liquidity" };
  return { ok: true };
}

export function openPosition(sig: Signal, solPrice: number, now = Date.now()): Position {
  const snap = sig.snapshot;
  let size = sig.sizeUsd;
  if (snap.liquidityUsd < config.risk.thinPoolUsd) size = size / 2;   // thin pool: half size
  if (isCreativePair(snap) && sig.mode !== "ride") size = size / 1.5;  // wider stop, same dollar risk
  // Size by exit, not by dollars: a sell of `size` into a pool moves price by about size / (liq/2).
  // Cap so that estimated exit impact stays under maxExitImpactPct. Floor at $2 so tiny pools get a token position, not nothing.
  if (snap.liquidityUsd > 0) size = Math.max(2, Math.min(size, snap.liquidityUsd * config.risk.maxExitImpactPct / 2));
  const { effPrice, feesUsd } = fillModel("buy", snap.priceUsd, size, snap.liquidityUsd, snap.onCurve, solPrice, taxPct(sig.mint));
  const qty = (size - feesUsd) / effPrice;
  const atr15 = sig.meta?.atr15 as number ?? 0;
  const plan = sig.plan(effPrice, atr15);
  if (snap.liquidityUsd < config.risk.thinPoolUsd) plan.hardFloorPct = Math.min(plan.hardFloorPct, 0.4); // thin pool: tick floor only at -60%
  // Creative pairs (paired with ZEC, NEAR, an xStock...) pay holders and chop more. Wider stops, looser trail, smaller size.
  if (isCreativePair(snap) && sig.mode !== "ride") {
    const loss = 1 - plan.closeStopPrice / effPrice;
    plan.closeStopPrice = effPrice * (1 - Math.min(0.45, loss * 1.5));
    plan.hardFloorPct = Math.min(0.6, plan.hardFloorPct + 0.1);
    plan.trailPct = Math.min(0.6, plan.trailPct + 0.10);
    for (const step of plan.trailLadder ?? []) step.trailPct = Math.min(0.6, step.trailPct + 0.10);
  }

  const a = account();
  a.cash -= size;
  saveAccount(a);

  const p = positions.insert({
    mode: sig.mode, mint: sig.mint, symbol: sig.symbol,
    entryPrice: effPrice, entryAt: now, qty, remainingQty: qty, costUsd: size,
    peakPrice: effPrice, peakClose: effPrice, lastGoodPrice: snap.priceUsd, lastGoodAt: now,
    atr15, liquidityAtEntry: snap.liquidityUsd, plan, tpTaken: [], realizedUsd: 0, status: "open",
    meta: { score: sig.score, reason: sig.reason, mcapAtEntry: snap.mcapUsd, ...(sig.meta ?? {}) },
  });
  const f: Fill = { side: "buy", mint: sig.mint, mode: sig.mode, qty, priceUsd: effPrice, grossUsd: size, feesUsd, netUsd: size, reason: sig.reason, at: now };
  fills.insert(f, p.id);
  shadow({ positionId: p.id, mode: sig.mode, symbol: sig.symbol, side: "buy", mint: sig.mint, usd: size, qty, paperPrice: effPrice, solPrice });
  log.info({ mode: sig.mode, sym: sig.symbol, size, price: effPrice, score: sig.score, reason: sig.reason }, "BUY");
  return p;
}

/** `trigger`: for stop, trail and hard floor exits, the level that fired. Recorded with the fill's gap past it (engine/stopgaps.ts). */
export function sell(p: Position, fraction: number, priceUsd: number, liquidityUsd: number, onCurve: boolean, solPrice: number, reason: string, now = Date.now(), trigger?: number) {
  const qty = Math.min(p.remainingQty, p.remainingQty * fraction);
  if (qty <= 0) return;
  const gross = qty * priceUsd;
  const { effPrice, feesUsd } = fillModel("sell", priceUsd, gross, liquidityUsd, onCurve, solPrice, taxPct(p.mint));
  const net = qty * effPrice - feesUsd;
  const costShare = p.costUsd * (qty / p.qty);
  const pnl = net - costShare;

  const a = account();
  if (pnl > 0) {
    const toVault = pnl * config.risk.vaultShare;
    a.vault += toVault;
    a.cash += net - toVault;
  } else {
    a.cash += net;
  }
  p.remainingQty -= qty;
  p.realizedUsd += pnl;
  if (p.remainingQty <= p.qty * 0.001) { p.remainingQty = 0; p.status = "closed"; p.closedAt = now; p.closeReason = reason; }
  positions.update(p);
  const eq = a.cash + 0; // peak tracked on next mark
  a.peakEquity = Math.max(a.peakEquity, eq);
  saveAccount(a);

  fills.insert({ side: "sell", mint: p.mint, mode: p.mode, qty, priceUsd: effPrice, grossUsd: gross, feesUsd, netUsd: net, reason, at: now }, p.id);
  const gapId = trigger && trigger > 0
    ? recordStopGap({ positionId: p.id, mode: p.mode, symbol: p.symbol, mint: p.mint, at: now, reason, trigger, mark: priceUsd, fill: effPrice, liquidity: liquidityUsd, usd: gross })
    : null;
  shadow({ positionId: p.id, mode: p.mode, symbol: p.symbol, side: "sell", mint: p.mint, usd: gross, qty, paperPrice: effPrice, solPrice },
    gapId != null ? q => setRealPrice(gapId, q.realPrice) : undefined);
  log.info({ mode: p.mode, sym: p.symbol, frac: fraction.toFixed(2), price: effPrice, pnl: pnl.toFixed(2), reason, status: p.status }, "SELL");
}

export function markPeakEquity(markPrices: Map<string, number>) {
  const a = account();
  const eq = equity(markPrices);
  if (eq > a.peakEquity) { a.peakEquity = eq; saveAccount(a); }
}

export function modeOpenCount(mode: Mode) { return positions.openByMode(mode).length; }

/** The add-to-winners rule for a mode, from its config (addAtGains, addFraction). None for modes without one. */
export function addRuleFor(mode: Mode, overrides?: Record<string, unknown>): AddRule | undefined {
  const c = { ...((config.modes as Record<string, any>)[mode] ?? {}), ...(overrides ?? {}) };
  return Array.isArray(c.addAtGains) && c.addAtGains.length ? { gains: c.addAtGains, fraction: c.addFraction ?? 0.5 } : undefined;
}

/** Same guardrails as a new position: daily loss stop, drawdown halt, feed, capital at risk, mode allocation, cash. */
export function canAdd(p: Position, usd: number, markPrices: Map<string, number>, feedHealthy: boolean): RiskCheck {
  const a = account();
  const eq = equity(markPrices);
  if (realizedToday() <= -config.risk.dailyLossStopUsd) return { ok: false, why: "daily loss stop" };
  if (eq < a.peakEquity * (1 - config.risk.drawdownHaltPct)) return { ok: false, why: "drawdown halt" };
  if (!feedHealthy) return { ok: false, why: "price feed stale" };
  if (openValueUsd(markPrices) + usd > config.risk.maxCapitalAtRiskUsd) return { ok: false, why: "capital at risk cap" };
  const modeOpen = positions.openByMode(p.mode).reduce((s, x) => s + x.remainingQty * (markPrices.get(x.mint) ?? x.lastGoodPrice), 0);
  if (modeOpen + usd > eq * config.allocation[p.mode]) return { ok: false, why: `${p.mode} allocation full` };
  if (usd > a.cash) return { ok: false, why: "no cash" };
  return { ok: true };
}

/** Add to an open winner. Sized so the whole position can still exit within the pool's impact limit. */
export function addTo(p: Position, usd: number, priceUsd: number, liquidityUsd: number, onCurve: boolean, solPrice: number, reason: string, lastCloseT: number | undefined, now = Date.now()): boolean {
  const held = p.remainingQty * priceUsd;
  if (liquidityUsd > 0) usd = Math.min(usd, liquidityUsd * config.risk.maxExitImpactPct / 2 - held);
  if (usd < 2) return false;
  const { effPrice, feesUsd } = fillModel("buy", priceUsd, usd, liquidityUsd, onCurve, solPrice, taxPct(p.mint));
  const a = account();
  a.cash -= usd;
  saveAccount(a);
  const qtyBefore = p.qty;
  applyAdd(p, usd, effPrice, feesUsd, lastCloseT);
  positions.update(p);
  fills.insert({ side: "buy", mint: p.mint, mode: p.mode, qty: p.qty - qtyBefore, priceUsd: effPrice, grossUsd: usd, feesUsd, netUsd: usd, reason, at: now }, p.id);
  shadow({ positionId: p.id, mode: p.mode, symbol: p.symbol, side: "buy", mint: p.mint, usd, qty: p.qty - qtyBefore, paperPrice: effPrice, solPrice });
  log.info({ mode: p.mode, sym: p.symbol, usd: usd.toFixed(2), price: effPrice, avg: p.entryPrice, stop: p.plan.closeStopPrice, reason }, "ADD");
  return true;
}
