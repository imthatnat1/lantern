import { getJson } from "./http.js";
import * as dex from "./dexscreener.js";
import type { TokenSnapshot } from "../types.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { kv } from "../db.js";

/**
 * Where candidate coins come from. v1 found good coins (ZCAT, PURR, swordcat, the Stonk.fun
 * ZEC/HYPE/xStock pairs); Lantern keeps that universe and only changes how it manages them.
 *
 *  - pinned:    coins Nat likes, from config. Always in scope.
 *  - stonk:     Stonk.fun ecosystem, found by searching DexScreener for pairs whose quote token
 *               is ZEC, HYPE or an xStock (TSLAx, NVDAx, GLDx...). Refreshed every 10 min.
 *  - trending:  DexScreener boosted Solana tokens.
 *  - quality:   anything in the above that is established: >= 3 days old, liquidity >= $100k,
 *               24h volume >= $50k, >= 2,000 holders when known.
 */

/**
 * Creative pairs: the coin is paired with something other than SOL/USDC/USDT, so holders earn the pair
 * (ZCAT pays ZEC, NEARKAT sits on NEAR) and fees aren't just a deployer's rug fund. This cycle's meta.
 * The seed list is searched directly; any new quote we see on a snapshot gets learned and searched too.
 */
const STANDARD_QUOTES = new Set(["SOL", "WSOL", "USDC", "USDT", "USD1", "PYUSD"]);
const SEED_QUOTES = [
  "ZEC", "HYPE", "wXMR", "xSOL", "NEAR", "INJ", "TRUMP", "DJT", "PUMP", "PEPE", "MASK", "SKR", "WIF", "BONK", "JUP", "RAY", "ORCA", "PYTH", "JTO",
  "FARTCOIN", "RENDER", "HNT", "BTC", "WBTC", "cbBTC", "ETH", "WETH", "LINK", "SUI", "TON", "TTWO", "MUSK4",
  "TSLAx", "NVDAx", "GLDx", "SLVx", "AAPLx", "SPYx", "QQQx", "COINx", "MSTRx", "GOOGLx", "AMZNx", "METAx", "MSFTx", "HOODx", "PLTRx", "CRCLx",
];

interface DsSearch { pairs: { chainId: string; baseToken: { address: string; symbol: string }; quoteToken: { symbol: string }; liquidity?: { usd?: number } }[] }

let stonkCache: { at: number; mints: string[] } = { at: 0, mints: [] };

function learnedQuotes(): string[] { return kv.get<string[]>("universe:quotes", []); }
/** Called whenever a snapshot shows a quote token we haven't searched for. */
export function learnQuote(symbol: string | undefined) {
  if (!symbol) return;
  const q = symbol.trim();
  if (!q || STANDARD_QUOTES.has(q.toUpperCase())) return;
  if (SEED_QUOTES.some(x => x.toUpperCase() === q.toUpperCase())) return;
  const cur = learnedQuotes();
  if (cur.some(x => x.toUpperCase() === q.toUpperCase())) return;
  if (cur.length >= 60) cur.shift();
  cur.push(q); kv.set("universe:quotes", cur);
  log.info({ quote: q }, "new creative-pair quote learned");
}

export async function stonkMints(): Promise<string[]> {
  if (Date.now() - stonkCache.at < 10 * 60_000) return stonkCache.mints;
  const found = new Set<string>();
  for (const q of [...SEED_QUOTES, ...learnedQuotes()]) {
    try {
      const r = await getJson<DsSearch>(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, { ttlMs: 10 * 60_000 });
      for (const p of r.pairs ?? []) {
        if (p.chainId !== "solana") continue;
        if (p.quoteToken.symbol.toUpperCase() !== q.toUpperCase()) continue;
        if ((p.liquidity?.usd ?? 0) < 5_000) continue;
        found.add(p.baseToken.address);
      }
    } catch (e) { log.debug({ q, err: String(e) }, "stonk search failed"); }
  }
  stonkCache = { at: Date.now(), mints: [...found] };
  log.info({ n: found.size, quotes: SEED_QUOTES.length + learnedQuotes().length }, "creative-pair universe refreshed");
  return stonkCache.mints;
}

export async function trendingMints(): Promise<string[]> {
  try { return await dex.trendingSolana(); } catch { return []; }
}

/** Union of all sources, deduped, pinned first. */
export async function allCandidates(): Promise<string[]> {
  const [stonk, trend] = await Promise.all([stonkMints(), trendingMints()]);
  return [...new Set([...config.pinned, ...stonk, ...trend])];
}

export function isQuality(s: TokenSnapshot, holders?: number): boolean {
  const ageDays = (Date.now() - s.createdAt) / 86_400_000;
  if (ageDays < 3) return false;
  if (s.liquidityUsd < 100_000) return false;
  if (s.volume24h < 50_000) return false;
  if (holders !== undefined && holders < 2_000) return false;
  return true;
}

export function isPinned(mint: string): boolean { return config.pinned.includes(mint); }
/** Paired with anything other than SOL/USDC/USDT. The name is kept for the old call sites. */
export function isStonkPair(s: TokenSnapshot): boolean {
  return !!s.quoteSymbol && !STANDARD_QUOTES.has(s.quoteSymbol.toUpperCase());
}
export const isCreativePair = isStonkPair;
