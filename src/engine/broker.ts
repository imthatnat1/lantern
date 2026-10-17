import { config } from "../config.js";
import { kv, positions, fills } from "../db.js";
import { log } from "../log.js";
import type { Fill, Mode, Position, Signal } from "../types.js";

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
export function fillModel(side: "buy" | "sell", priceUsd: number, usdSize: number, liquidityUsd: number, onCurve: boolean, solPrice: number) {
  const f = config.fees;
  const txFeeUsd = (f.baseSol + f.prioritySol + f.tipSol) * solPrice;
  const dexFeePct = onCurve ? f.curveFeePct : f.poolFeePct;
  // Constant-product impact estimate: trade / (liquidity/2) gives roughly the price move.
  const impact = liquidityUsd > 0 ? usdSize / (liquidityUsd / 2) : 1;
  const slip = f.baseSlippagePct + impact;
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
  if (positions.isHeld(sig.mint)) return { ok: false, why: "already held" };
  if (sig.sizeUsd > a.cash) return { ok: false, why: "no cash" };
  if (sig.snapshot.liquidityUsd < config.minExitLiquidityUsd[sig.mode]) return { ok: false, why: "below min exit liquidity" };
  return { ok: true };
}

export function openPosition(sig: Signal, solPrice: number, now = Date.now()): Position {
  const snap = sig.snapshot;
  let size = sig.sizeUsd;
  if (snap.liquidityUsd < config.risk.thinPoolUsd) size = size / 2;   // thin pool: half size
  // Size by exit, not by dollars: a sell of `size` into a pool moves price by about size / (liq/2).
  // Cap so that estimated exit impact stays under maxExitImpactPct. Floor at $2 so tiny pools get a token position, not nothing.
  if (snap.liquidityUsd > 0) size = Math.max(2, Math.min(size, snap.liquidityUsd * config.risk.maxExitImpactPct / 2));
  const { effPrice, feesUsd } = fillModel("buy", snap.priceUsd, size, snap.liquidityUsd, snap.onCurve, solPrice);
  const qty = (size - feesUsd) / effPrice;
  const atr15 = sig.meta?.atr15 as number ?? 0;
  const plan = sig.plan(effPrice, atr15);
  if (snap.liquidityUsd < config.risk.thinPoolUsd) plan.hardFloorPct = Math.min(plan.hardFloorPct, 0.4); // thin pool: tick floor only at -60%

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
  log.info({ mode: sig.mode, sym: sig.symbol, size, price: effPrice, score: sig.score, reason: sig.reason }, "BUY");
  return p;
}

export function sell(p: Position, fraction: number, priceUsd: number, liquidityUsd: number, onCurve: boolean, solPrice: number, reason: string, now = Date.now()) {
  const qty = Math.min(p.remainingQty, p.remainingQty * fraction);
  if (qty <= 0) return;
  const gross = qty * priceUsd;
  const { effPrice, feesUsd } = fillModel("sell", priceUsd, gross, liquidityUsd, onCurve, solPrice);
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
  log.info({ mode: p.mode, sym: p.symbol, frac: fraction.toFixed(2), price: effPrice, pnl: pnl.toFixed(2), reason, status: p.status }, "SELL");
}

export function markPeakEquity(markPrices: Map<string, number>) {
  const a = account();
  const eq = equity(markPrices);
  if (eq > a.peakEquity) { a.peakEquity = eq; saveAccount(a); }
}

export function modeOpenCount(mode: Mode) { return positions.openByMode(mode).length; }
