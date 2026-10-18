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
import { db, kv } from "../db.js";
import { config } from "../config.js";

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
  /** Snapshot check: this many trades with an average under this size = a bot spraying cents. */
  microAvgUsd: 5, microMinTrades5m: 150, microMinTrades1h: 600,
  /** Snapshot check: this many buys per sell in 5m, over at least this many buys = a buy bot. */
  oneSidedRatio: 8, oneSidedMinBuys: 300,
  /** Market cap more than this many times the pool, on a coin under a week old = a valuation nobody could sell into. */
  fakeValuationX: 60, fakeValuationMaxAgeH: 7 * 24,
  /** No coin under 2h old is really worth this much. */
  youngMcapMax: 20_000_000, youngAgeH: 2,
  /** A coin under a day old whose whole life's volume is under this share of its market cap never traded its way there. */
  unbackedVolShare: 0.2, unbackedMaxAgeH: 24, unbackedMinMcap: 1_000_000,
};

/**
 * Free checks from the snapshot for a fake valuation. USDF (18 Oct): $171M market cap on a $1.1M pool
 * (153x), 15 minutes old, up 398,042% in the hour, 2,381 buys to 218 sells in 5m. Its average trade was $55
 * because a few big trades sat among the cent-sized ones, so microTrades() alone missed it. Real coins on the
 * same list ran 3-40x their pool (old flagships ZCAT 40x, STONK 36x).
 */
export function fakeValuation(s: { mcapUsd: number; liquidityUsd: number; createdAt: number; onCurve: boolean; buys5m: number; sells5m: number; volume24h?: number }, now = Date.now()): string | null {
  const ageH = s.createdAt ? (now - s.createdAt) / 3_600_000 : Infinity;
  // Glow (18 Oct): $6.9M at 15 minutes old with $102k ever traded (1.5%). USDF: $171M on $686k (0.4%).
  // Real young coins on the same list had traded 3-12x their market cap (TSI, SUPERCORE, NIP).
  if (ageH < FLOW.unbackedMaxAgeH && s.mcapUsd >= FLOW.unbackedMinMcap && (s.volume24h ?? 0) < s.mcapUsd * FLOW.unbackedVolShare)
    return `fake valuation: $${big(s.mcapUsd)} market cap but only $${big(s.volume24h ?? 0)} ever traded`;
  if (ageH < FLOW.youngAgeH && s.mcapUsd > FLOW.youngMcapMax)
    return `fake valuation: $${(s.mcapUsd / 1e6).toFixed(0)}M market cap at ${Math.round(ageH * 60)} minutes old`;
  if (!s.onCurve && s.liquidityUsd > 0 && ageH < FLOW.fakeValuationMaxAgeH && s.mcapUsd / s.liquidityUsd > FLOW.fakeValuationX)
    return `fake valuation: market cap ${Math.round(s.mcapUsd / s.liquidityUsd)}x the pool ($${big(s.mcapUsd)} on $${big(s.liquidityUsd)})`;
  const b = s.buys5m ?? 0, x = s.sells5m ?? 0;
  if (b >= FLOW.oneSidedMinBuys && b >= FLOW.oneSidedRatio * Math.max(1, x))
    return `bot buys: ${b} buys to ${x} sells in 5m`;
  return null;
}
const big = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`;

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

/**
 * Free check from the snapshot: thousands of trades averaging cents. FOMO (18 Oct): ~3,900 trades in 5m
 * averaging $1.68, price a dead-straight staircase up 2,400% in the hour, 33 holders on DexScreener.
 * Real coins on the same list averaged $25-150 a trade. The trade-level check at the gate would have
 * caught it before a buy, but this runs first, so the coin never reaches the hot list.
 */
export function microTrades(s: { buys5m: number; sells5m: number; volume5m: number; buys1h?: number; sells1h?: number; volume1h: number }): string | null {
  const t5 = (s.buys5m ?? 0) + (s.sells5m ?? 0);
  if (t5 >= FLOW.microMinTrades5m && s.volume5m / t5 < FLOW.microAvgUsd)
    return `bot volume: ${t5} trades in 5m averaging $${(s.volume5m / t5).toFixed(2)}`;
  const t1 = (s.buys1h ?? 0) + (s.sells1h ?? 0);
  if (t1 >= FLOW.microMinTrades1h && s.volume1h / t1 < FLOW.microAvgUsd)
    return `bot volume: ${t1} trades in the hour averaging $${(s.volume1h / t1).toFixed(2)}`;
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

/**
 * Coins caught with bot volume stay out for a day, so they don't sit on the Watching list waiting
 * for a setup the buy check would refuse anyway. Permanent blocks come from config (Minter).
 */
const blocks = new Map<string, { until: number; why: string }>(kv.get<[string, { until: number; why: string }][]>("flow:blocks", []));
export function blockMint(mint: string, why: string, hours = 24, name?: string) {
  blocks.set(mint, { until: Date.now() + hours * 3_600_000, why });
  for (const [k, v] of blocks) if (v.until < Date.now()) blocks.delete(k);
  kv.set("flow:blocks", [...blocks]);
  if (name) burnName(name, mint, why);
}

/**
 * Burned names. GTA 6 Coin (18 Oct): caught as a cent-trade bot coin at 17:00, then a new mint with the same name
 * showed up on the hot list at 20:38 and rugged 97% two minutes later. Scammers relaunch a name that drew attention.
 * When a coin is caught botting, flagged rugged, or crashes 80% in an hour, any OTHER coin with the same name is
 * refused for 48 hours. Names are compared without case, spaces or symbols ("GTA 6 Coin" = "gta6coin").
 */
type Burn = { at: number; until: number; why: string; name: string; mint: string };
const burned = new Map<string, Burn>(kv.get<[string, Burn][]>("flow:burnedNames", []));
export function nameKey(name: string): string { return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, ""); }
export function burnName(name: string, mint: string, why: string, hours = 48) {
  const k = nameKey(name);
  if (k.length < 4) return;   // "CAT", "AI": too common to burn
  burned.set(k, { at: Date.now(), until: Date.now() + hours * 3_600_000, why, name, mint });
  for (const [x, v] of burned) if (v.until < Date.now()) burned.delete(x);
  kv.set("flow:burnedNames", [...burned]);
}
export function burnedWhy(name: string, mint: string): string | null {
  const b = burned.get(nameKey(name));
  if (!b || b.until < Date.now() || b.mint === mint) return null;
  const ago = Math.max(1, Math.round((Date.now() - b.at) / 3_600_000));
  return `scam relaunch: a coin called "${b.name}" was caught ${ago}h ago (${b.why})`;
}
export function blockedWhy(mint: string): string | null {
  if (config.blocked.includes(mint)) return "blocked: bot-pumped volume (on the block list)";
  const b = blocks.get(mint);
  return b && b.until > Date.now() ? `blocked for ${Math.ceil((b.until - Date.now()) / 3_600_000)}h: ${b.why}` : null;
}

/** Recent trades on a pool from GeckoTerminal. Cached 2 minutes. Null when unavailable. */
export async function flow(mint: string, pool: string, name?: string): Promise<{ f: Flow; verdict: string | null } | null> {
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
    if (verdict) blockMint(mint, verdict, 24, name);
    try { insFlow.run(mint, Date.now(), f.microBuyShare, f.top3BuyShare, f.buyUsd, f.sellUsd, f.buys, f.buyers, verdict); } catch { /* best effort */ }
    return { f, verdict };
  } catch {
    return null;
  }
}

/** Test helper. */
export function _resetBlocks() { blocks.clear(); burned.clear(); }
