/**
 * Shadow live (19 Oct): the first step to real money, with no wallet and nothing at risk.
 * Every paper buy, add and sell also asks Jupiter for a real quote of the same size. We record the price a real swap
 * would have got against the paper fill price, so before any real dollar goes in we know whether the paper results
 * would survive real slippage. Network/priority fees are charged separately in both, so this compares price only.
 */
import { db } from "../db.js";
import { log } from "../log.js";
import * as jup from "../data/jupiter.js";

const SOL = "So11111111111111111111111111111111111111112";

db.exec(`CREATE TABLE IF NOT EXISTS shadow_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, position_id INTEGER, mode TEXT, symbol TEXT, side TEXT, at INTEGER,
  usd REAL, paper_price REAL, real_price REAL, impact_pct REAL, worse_pct REAL, routed INTEGER
)`);

/** How much worse (positive) or better (negative) a real fill would have been than the paper fill, as a fraction. */
export function worseBy(side: "buy" | "sell", paperPrice: number, realPrice: number): number {
  return side === "buy" ? realPrice / paperPrice - 1 : 1 - realPrice / paperPrice;
}

export interface Quote { routed: boolean; realPrice: number; impactPct: number }

/** Jupiter's quote for this trade. Buy: `amount` is USD in. Sell: `amount` is the token quantity out. */
export async function quote(side: "buy" | "sell", mint: string, amount: number, solPrice: number): Promise<Quote> {
  try {
    const d = await jup.decimals(mint);
    if (side === "buy") {
      const lamports = Math.floor((amount / solPrice) * 1e9);
      const q = await jup.quote(SOL, mint, lamports);
      if (!q) return { routed: false, realPrice: 0, impactPct: 0 };
      const tokens = Number(q.outAmount) / 10 ** d;
      return { routed: tokens > 0, realPrice: tokens > 0 ? amount / tokens : 0, impactPct: Number(q.priceImpactPct) || 0 };
    }
    const q = await jup.quote(mint, SOL, Math.floor(amount * 10 ** d));
    if (!q) return { routed: false, realPrice: 0, impactPct: 0 };
    const usd = (Number(q.outAmount) / 1e9) * solPrice;
    return { routed: usd > 0, realPrice: amount > 0 ? usd / amount : 0, impactPct: Number(q.priceImpactPct) || 0 };
  } catch { return { routed: false, realPrice: 0, impactPct: 0 }; }
}

/** Fire and forget: never slows or blocks a paper trade. */
export function shadow(x: { positionId: number; mode: string; symbol: string; side: "buy" | "sell"; mint: string; usd: number; qty: number; paperPrice: number; solPrice: number },
  onRouted?: (q: Quote) => void) {
  if (process.env.DB_PATH === ":memory:") return;   // tests: no network
  const amount = x.side === "buy" ? x.usd : x.qty;
  quote(x.side, x.mint, amount, x.solPrice).then(q => {
    const worse = q.routed && x.paperPrice > 0 ? worseBy(x.side, x.paperPrice, q.realPrice) : null;
    db.prepare(`INSERT INTO shadow_quotes(position_id, mode, symbol, side, at, usd, paper_price, real_price, impact_pct, worse_pct, routed)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(x.positionId, x.mode, x.symbol, x.side, Date.now(), x.usd, x.paperPrice, q.realPrice, q.impactPct, worse, q.routed ? 1 : 0);
    if (q.routed && onRouted) onRouted(q);
  }).catch(e => log.debug({ err: String(e) }, "shadow quote failed"));
}

/** For the dashboard: how real fills would have compared with paper over the last week. */
export function shadowSummary(sinceMs: number) {
  const rows = db.prepare("SELECT mode, symbol, side, at, usd, worse_pct, impact_pct, routed FROM shadow_quotes WHERE at > ? ORDER BY at DESC").all(sinceMs) as any[];
  const priced = rows.filter(r => r.routed && r.worse_pct != null);
  const avg = priced.length ? priced.reduce((a, r) => a + r.worse_pct, 0) / priced.length : null;
  // Dollar effect: each fill's USD size times how much worse it would have been.
  const usd = priced.reduce((a, r) => a + r.usd * r.worse_pct, 0);
  return { n: rows.length, priced: priced.length, noRoute: rows.length - priced.length, avgWorsePct: avg, usdEffect: usd, recent: rows.slice(0, 10) };
}
