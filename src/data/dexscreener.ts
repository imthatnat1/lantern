import { getJson } from "./http.js";
import type { TokenSnapshot } from "../types.js";

interface DsPair {
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
  info?: { websites?: { url: string }[]; socials?: { type: string; url: string }[] };
}

/** Best pair for a mint: the one with the most liquidity. */
export async function snapshot(mint: string): Promise<TokenSnapshot | null> {
  const r = await getJson<{ pairs: DsPair[] | null }>(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { ttlMs: 5000 });
  const pairs = (r.pairs ?? []).filter(p => p.chainId === "solana");
  if (!pairs.length) return null;
  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const p = pairs[0];
  const price = Number(p.priceUsd ?? 0);
  if (!price) return null;
  return {
    mint, symbol: p.baseToken.symbol, name: p.baseToken.name, pairAddress: p.pairAddress, quoteSymbol: p.quoteToken.symbol,
    priceUsd: price,
    liquidityUsd: p.liquidity?.usd ?? 0,
    mcapUsd: p.marketCap ?? p.fdv ?? 0,
    volume24h: p.volume?.h24 ?? 0, volume1h: p.volume?.h1 ?? 0, volume5m: p.volume?.m5 ?? 0,
    buys5m: p.txns?.m5?.buys ?? 0, sells5m: p.txns?.m5?.sells ?? 0,
    change5m: p.priceChange?.m5 ?? 0, change1h: p.priceChange?.h1 ?? 0,
    change6h: p.priceChange?.h6 ?? 0, change24h: p.priceChange?.h24 ?? 0,
    createdAt: p.pairCreatedAt ?? Date.now(),
    onCurve: p.dexId === "pumpfun",
    website: p.info?.websites?.[0]?.url,
    twitter: p.info?.socials?.find(s => s.type === "twitter")?.url,
    fetchedAt: Date.now(),
  };
}

/** Batch of up to 30 mints in one call. */
export async function snapshots(mints: string[]): Promise<Map<string, TokenSnapshot>> {
  const out = new Map<string, TokenSnapshot>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const r = await getJson<{ pairs: DsPair[] | null }>(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`, { ttlMs: 5000 });
    const byMint = new Map<string, DsPair[]>();
    for (const p of r.pairs ?? []) {
      if (p.chainId !== "solana") continue;
      const l = byMint.get(p.baseToken.address) ?? [];
      l.push(p); byMint.set(p.baseToken.address, l);
    }
    for (const [mint, pairs] of byMint) {
      pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const s = await snapshotFromPair(mint, pairs[0]);
      if (s) out.set(mint, s);
    }
  }
  return out;
}

async function snapshotFromPair(mint: string, p: DsPair): Promise<TokenSnapshot | null> {
  const price = Number(p.priceUsd ?? 0);
  if (!price) return null;
  return {
    mint, symbol: p.baseToken.symbol, name: p.baseToken.name, pairAddress: p.pairAddress, quoteSymbol: p.quoteToken.symbol,
    priceUsd: price, liquidityUsd: p.liquidity?.usd ?? 0, mcapUsd: p.marketCap ?? p.fdv ?? 0,
    volume24h: p.volume?.h24 ?? 0, volume1h: p.volume?.h1 ?? 0, volume5m: p.volume?.m5 ?? 0,
    buys5m: p.txns?.m5?.buys ?? 0, sells5m: p.txns?.m5?.sells ?? 0,
    change5m: p.priceChange?.m5 ?? 0, change1h: p.priceChange?.h1 ?? 0,
    change6h: p.priceChange?.h6 ?? 0, change24h: p.priceChange?.h24 ?? 0,
    createdAt: p.pairCreatedAt ?? Date.now(), onCurve: p.dexId === "pumpfun",
    website: p.info?.websites?.[0]?.url,
    twitter: p.info?.socials?.find(s => s.type === "twitter")?.url,
    fetchedAt: Date.now(),
  };
}

/** Recently boosted / trending Solana pairs. Used to seed the ultra and pullback universes. */
export async function trendingSolana(): Promise<string[]> {
  const r = await getJson<{ tokenAddress: string; chainId: string }[]>("https://api.dexscreener.com/token-boosts/top/v1", { ttlMs: 60_000 });
  return r.filter(x => x.chainId === "solana").map(x => x.tokenAddress);
}
