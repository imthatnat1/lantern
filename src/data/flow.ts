/**
 * Is the buying real? Volume bots spray tiny buys (cents each) from wallet farms. That inflates the
 * buy count, the 24h volume and the "traders" number, which is exactly what our checks used to read
 * as demand. Minter (18 Oct): 2.3 buys per sell in the hour while price fell 25%.
 *
 * Two checks, both run in the shared entry gate:
 *  1. Free, from the DexScreener snapshot: buy count far ahead of sells while price falls.
 *  2. The last ~300 trades from GeckoTerminal: share of buys under $1, dollars bought vs sold,
 *     and how many of the buys came from the same few wallets.
 */
import { getJson } from "./http.js";
import { db } from "../db.js";

export interface Trade { kind: "buy" | "sell"; usd: number; from: string; at: number }

export interface Flow {
  trades: number; buys: number; sells: number;
  /** Share of buys under $1. */
  microBuyShare: number;
  buyUsd: number; sellUsd: number;
  buyers: number;
  /** Share of buy transactions made by the 3 busiest buying wallets. */
  top3BuyShare: number;
  medianBuyUsd: number;
  spanMin: number;
}

export const FLOW = {
  microUsd: 1,
  microShareMax: 0.5,
  top3ShareMax: 0.5,
  sellOverBuyMax: 2.0,
  minBuys: 40,
  /** Snapshot check: this many buys per sell in the hour while price is down this much = bot buys. */
  divergenceRatio: 1.8, divergenceDrop1h: -15, divergenceMinBuys: 200,
};

export function flowFromTrades(trades: Trade[]): Flow {
  const buys = trades.filter(t => t.kind === "buy"), sells = trades.filter(t => t.kind === "sell");
  const byWallet = new Map<string, number>();
  for (const b of buys) byWallet.set(b.from, (byWallet.get(b.from) ?? 0) + 1);
  const top3 = [...byWallet.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, n) => a + n, 0);
  const sizes = buys.map(b => b.usd).sort((a, b) => a - b);
  const ats = trades.map(t => t.at);
  return {
    trades: trades.length, buys: buys.length, sells: sells.length,
    microBuyShare: buys.length ? buys.filter(b => b.usd < FLOW.microUsd).length / buys.length : 0,
    buyUsd: buys.reduce((a, b) => a + b.usd, 0), sellUsd: sells.reduce((a, s) => a + s.usd, 0),
    buyers: byWallet.size, top3BuyShare: buys.length ? top3 / buys.length : 0,
    medianBuyUsd: sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0,
    spanMin: ats.length ? Math.round((Math.max(...ats) - Math.min(...ats)) / 60_000) : 0,
  };
}

/** Why the buying looks fake, or null if it looks real. */
export function flowVerdict(f: Flow): string | null {
  if (f.buys < FLOW.minBuys) return null;
  if (f.microBuyShare >= FLOW.microShareMax) return `bot volume: ${Math.round(f.microBuyShare * 100)}% of the last ${f.buys} buys were under $1`;
  if (f.top3BuyShare >= FLOW.top3ShareMax) return `bot volume: 3 wallets made ${Math.round(f.top3BuyShare * 100)}% of the last ${f.buys} buys`;
  if (f.buyUsd > 0 && f.sellUsd >= f.buyUsd * FLOW.sellOverBuyMax) return `real money is selling: $${Math.round(f.sellUsd)} sold vs $${Math.round(f.buyUsd)} bought in the last ${f.trades} trades`;
  return null;
}

/** Free check from the snapshot: lots more buys than sells, but the price is falling. */
export function divergence(s: { buys1h?: number; sells1h?: number; change1h: number }): string | null {
  const b = s.buys1h ?? 0, x = s.sells1h ?? 0;
  if (b < FLOW.divergenceMinBuys || !x) return null;
  const r = b / x;
  if (r >= FLOW.divergenceRatio && s.change1h <= FLOW.divergenceDrop1h)
    return `bot buys: ${r.toFixed(1)} buys per sell in the last hour but price is down ${Math.abs(s.change1h).toFixed(0)}%`;
  return null;
}

db.exec(`CREATE TABLE IF NOT EXISTS flow_history (
  mint TEXT NOT NULL, at INTEGER NOT NULL, micro REAL, top3 REAL, buy_usd REAL, sell_usd REAL, buys INTEGER, buyers INTEGER, verdict TEXT,
  PRIMARY KEY (mint, at)
) WITHOUT ROWID;`);
const insFlow = db.prepare("INSERT OR IGNORE INTO flow_history(mint,at,micro,top3,buy_usd,sell_usd,buys,buyers,verdict) VALUES(?,?,?,?,?,?,?,?,?)");

/** Recent trades on a pool from GeckoTerminal. Cached 2 minutes. Null when unavailable. */
export async function flow(mint: string, pool: string): Promise<{ f: Flow; verdict: string | null } | null> {
  try {
    const r = await getJson<{ data?: { attributes: { kind: string; volume_in_usd: string; tx_from_address: string; block_timestamp: string } }[] }>(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/trades`, { ttlMs: 2 * 60_000 });
    const trades: Trade[] = (r.data ?? []).map(d => ({
      kind: d.attributes.kind === "sell" ? "sell" : "buy", usd: Number(d.attributes.volume_in_usd) || 0,
      from: d.attributes.tx_from_address ?? "", at: Date.parse(d.attributes.block_timestamp) || 0,
    }));
    if (!trades.length) return null;
    const f = flowFromTrades(trades);
    const verdict = flowVerdict(f);
    try { insFlow.run(mint, Date.now(), f.microBuyShare, f.top3BuyShare, f.buyUsd, f.sellUsd, f.buys, f.buyers, verdict); } catch { /* best effort */ }
    return { f, verdict };
  } catch {
    return null;
  }
}
