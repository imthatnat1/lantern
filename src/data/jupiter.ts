import { getJson } from "./http.js";

const SOL = "So11111111111111111111111111111111111111112";

/** Jupiter's own price feed. Second source for the sanity check. */
export async function price(mint: string): Promise<number | null> {
  try {
    const r = await getJson<Record<string, { usdPrice?: number }>>(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { ttlMs: 3000 });
    const p = r[mint]?.usdPrice;
    return p && p > 0 ? p : null;
  } catch { return null; }
}

export async function decimals(mint: string): Promise<number> {
  try {
    const r = await getJson<{ id: string; decimals: number }[]>(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, { ttlMs: 3_600_000 });
    const t = r.find(x => x.id === mint);
    return t?.decimals ?? 6;
  } catch { return 6; }
}

export interface TestSell { routable: boolean; impactPct: number; outSolLamports: number }

/** Simulate selling `tokenQty` into SOL to measure price impact. */
export async function testSell(mint: string, tokenQty: number): Promise<TestSell> {
  const d = await decimals(mint);
  const amount = Math.floor(tokenQty * 10 ** d);
  if (amount <= 0) return { routable: false, impactPct: 1, outSolLamports: 0 };
  try {
    const q = await getJson<{ priceImpactPct: string; outAmount: string }>(
      `https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${SOL}&amount=${amount}&slippageBps=100`,
      { ttlMs: 10_000 });
    return { routable: true, impactPct: Number(q.priceImpactPct), outSolLamports: Number(q.outAmount) };
  } catch {
    return { routable: false, impactPct: 1, outSolLamports: 0 };
  }
}

export async function solPrice(): Promise<number> {
  return (await price(SOL)) ?? 150;
}
