import { getJson } from "./http.js";
import type { TokenSnapshot } from "../types.js";
import { recorder } from "../db.js";
import { learnQuote } from "./universe.js";

/** Last time DexScreener answered with usable data. Read by the health check. */
export let lastOkAt = 0;

export interface DsPair {
  chainId: string; dexId: string; pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  marketCap?: number; fdv?: number;
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: { m5?: { buys: number; sells: number }; h1?: { buys: number; sells: number } };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  pairCreatedAt?: number;
  info?: { imageUrl?: string; websites?: { url: string }[]; socials?: { type: string; url: string }[] };
}

/** Still on a launch curve (pump.fun, or Raydium LaunchLab, which Stonk.fun launches on): no pool liquidity yet. */
export function isCurve(dexId: string): boolean { return dexId === "pumpfun" || /launchlab/i.test(dexId); }

/** A pair's real trading, by its busiest window. */
function activity(p: { volume?: { h1?: number; h6?: number; h24?: number } }): number {
  return Math.max(p.volume?.h24 ?? 0, p.volume?.h6 ?? 0, p.volume?.h1 ?? 0);
}

/**
 * Pairs that actually trade. Dust pools (a stray Meteora pool with $2 of volume) can report more
 * "liquidity" than the real pair once it drains, and their price is meaningless. wibet showed a
 * $33.8M cap on one of these while the real PumpSwap pair sat at $13k. A pair needs at least 1% of
 * the busiest pair's volume to count.
 */
export function tradedPairs<T extends { volume?: { h1?: number; h6?: number; h24?: number } }>(pairs: T[]): T[] {
  const top = Math.max(0, ...pairs.map(activity));
  if (top <= 0) return pairs;
  return pairs.filter(p => activity(p) >= top * 0.01);
}

/** Best pair for a mint: most liquidity among the pairs that actually trade. */
export function bestPair<T extends { liquidity?: { usd?: number }; volume?: { h1?: number; h6?: number; h24?: number } }>(pairs: T[]): T | undefined {
  return [...tradedPairs(pairs)].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0) || activity(b) - activity(a))[0];
}

/** Raw Solana pairs for up to 30 mints per call, grouped by mint. */
export async function pairsByMint(mints: string[]): Promise<Map<string, DsPair[]>> {
  const byMint = new Map<string, DsPair[]>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const asked = new Set(chunk);
    const r = await getJson<{ pairs: DsPair[] | null }>(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`, { ttlMs: 5000 });
    for (const p of r.pairs ?? []) {
      // Only the coins we asked about. The answer also holds pools where an asked coin is the QUOTE, and their base
      // tokens (USDC, WBTC, STRK on 19 Oct) were turning up as "fresh launches" on the radar and in every scan.
      if (p.chainId !== "solana" || !asked.has(p.baseToken.address)) continue;
      const l = byMint.get(p.baseToken.address) ?? [];
      l.push(p); byMint.set(p.baseToken.address, l);
    }
  }
  return byMint;
}

/**
 * Prices of a coin's OTHER real pools (traded, $5k+ liquidity), from the same DexScreener answer snapshot() just used.
 * The price check compares the chosen pool with them when Jupiter has no price. 20 Oct 15:03: Dacity's Meteora SOL pool
 * reported $0.0000014 twice in a row while its PumpSwap and other pools sat at $0.0059, and the next-tick fallback
 * confirmed the junk. No extra API call: filled by snapshot().
 */
const otherPools = new Map<string, { at: number; prices: number[] }>();
export function otherPoolPrices(mint: string, maxAgeMs = 30_000): number[] {
  const o = otherPools.get(mint);
  return o && Date.now() - o.at <= maxAgeMs ? o.prices : [];
}

export async function snapshot(mint: string): Promise<TokenSnapshot | null> {
  const r = await getJson<{ pairs: DsPair[] | null }>(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { ttlMs: 5000 });
  // Only pools where this coin is the token being priced. 19 Oct: ALLINU is also the PAIRING token for other coins;
  // the biggest pool containing it was "<another coin> / ALLINU" at $19.17, so the exit loop re-priced a $0.0048
  // position at 3,900x and booked a fake $7,682 sale. pairsByMint (the scanners' batch call) already did this.
  const pairs = (r.pairs ?? []).filter(p => p.chainId === "solana" && p.baseToken?.address === mint);
  const p = bestPair(pairs);
  if (!p) return null;
  const price = Number(p.priceUsd ?? 0);
  if (!price) return null;
  otherPools.set(mint, {
    at: Date.now(),
    prices: tradedPairs(pairs).filter(x => x !== p && (x.liquidity?.usd ?? 0) >= 5_000).map(x => Number(x.priceUsd ?? 0)).filter(x => x > 0),
  });
  if (otherPools.size > 2000) otherPools.clear();
  const snap: TokenSnapshot = {
    mint, symbol: p.baseToken.symbol, name: p.baseToken.name, pairAddress: p.pairAddress, quoteSymbol: p.quoteToken.symbol,
    priceUsd: price,
    liquidityUsd: p.liquidity?.usd ?? 0,
    mcapUsd: p.marketCap ?? p.fdv ?? 0,
    volume24h: p.volume?.h24 ?? 0, volume1h: p.volume?.h1 ?? 0, volume5m: p.volume?.m5 ?? 0,
    buys5m: p.txns?.m5?.buys ?? 0, sells5m: p.txns?.m5?.sells ?? 0, buys1h: p.txns?.h1?.buys, sells1h: p.txns?.h1?.sells,
    change5m: p.priceChange?.m5 ?? 0, change1h: p.priceChange?.h1 ?? 0,
    change6h: p.priceChange?.h6 ?? 0, change24h: p.priceChange?.h24 ?? 0,
    createdAt: p.pairCreatedAt ?? Date.now(),
    onCurve: isCurve(p.dexId),
    website: p.info?.websites?.[0]?.url,
    twitter: p.info?.socials?.find(s => /^(twitter|x)$/i.test(s.type))?.url,
    telegram: p.info?.socials?.find(s => s.type === "telegram")?.url,
    imageUrl: p.info?.imageUrl,
    fetchedAt: Date.now(),
  };
  lastOkAt = Date.now();
  try { recorder.tick(snap); learnQuote(snap.quoteSymbol); } catch { /* best effort */ }
  return snap;
}

/** Batch of up to 30 mints in one call. */
export async function snapshots(mints: string[]): Promise<Map<string, TokenSnapshot>> {
  const out = new Map<string, TokenSnapshot>();
  for (const [mint, pairs] of await pairsByMint(mints)) {
    const p = bestPair(pairs);
    const s = p ? await snapshotFromPair(mint, p) : null;
    if (s) out.set(mint, s);
  }
  return out;
}

export async function snapshotFromPair(mint: string, p: DsPair): Promise<TokenSnapshot | null> {
  const price = Number(p.priceUsd ?? 0);
  if (!price) return null;
  const snap: TokenSnapshot = {
    mint, symbol: p.baseToken.symbol, name: p.baseToken.name, pairAddress: p.pairAddress, quoteSymbol: p.quoteToken.symbol,
    priceUsd: price, liquidityUsd: p.liquidity?.usd ?? 0, mcapUsd: p.marketCap ?? p.fdv ?? 0,
    volume24h: p.volume?.h24 ?? 0, volume1h: p.volume?.h1 ?? 0, volume5m: p.volume?.m5 ?? 0,
    buys5m: p.txns?.m5?.buys ?? 0, sells5m: p.txns?.m5?.sells ?? 0, buys1h: p.txns?.h1?.buys, sells1h: p.txns?.h1?.sells,
    change5m: p.priceChange?.m5 ?? 0, change1h: p.priceChange?.h1 ?? 0,
    change6h: p.priceChange?.h6 ?? 0, change24h: p.priceChange?.h24 ?? 0,
    createdAt: p.pairCreatedAt ?? Date.now(), onCurve: isCurve(p.dexId),
    website: p.info?.websites?.[0]?.url,
    twitter: p.info?.socials?.find(s => /^(twitter|x)$/i.test(s.type))?.url,
    telegram: p.info?.socials?.find(s => s.type === "telegram")?.url,
    imageUrl: p.info?.imageUrl,
    fetchedAt: Date.now(),
  };
  lastOkAt = Date.now();
  try { recorder.tick(snap); learnQuote(snap.quoteSymbol); } catch { /* best effort */ }
  return snap;
}

/** Recently boosted / trending Solana pairs. Used to seed the ultra and pullback universes. */
export async function trendingSolana(): Promise<string[]> {
  const r = await getJson<{ tokenAddress: string; chainId: string }[]>("https://api.dexscreener.com/token-boosts/top/v1", { ttlMs: 60_000 });
  return r.filter(x => x.chainId === "solana").map(x => x.tokenAddress);
}
