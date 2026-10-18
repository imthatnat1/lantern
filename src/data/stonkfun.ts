/**
 * Stonk.fun's own coin list (public API, no key: https://www.stonkfun.xyz/developers).
 *
 * Before this, Lantern only found Stonk.fun coins by searching DexScreener for each quote token,
 * which returns ~30 pairs per search and misses new quotes (STONK, OPENAI, SPCXX...). The API lists
 * every launch with its pool, the token it's paired with, whether it's a reward coin, and its
 * transfer tax.
 *
 * Reward coins charge a Token-2022 transfer tax (usually 1%, some 3%) that is paid out to holders in
 * the paired token. That's the "fees go to holders, not the deployer" idea Nat likes, so these count
 * as creative pairs even when paired with SOL. The tax is a real cost on every buy and sell, so it is
 * charged in the fill model (data/tax.ts).
 */
import { getJson } from "./http.js";
import { kv } from "../db.js";
import { log } from "../log.js";
import { setTax } from "./tax.js";

export interface StonkInfo { mode: string; taxBps: number; quote: string; status: string; pool: string; mcap: number; vol24h: number }

export interface ApiToken {
  mint: string; pool?: string; symbol?: string; mode?: string; status?: string;
  quote?: { mint?: string; symbol?: string };
  market?: { marketCapUsd?: number; volume24hUsd?: number; liquidityUsd?: number };
  transferFee?: { bps?: number };
}

const BASE = "https://www.stonkfun.xyz/api/public/v1/tokens";
/** Worth watching: real trading or a real pool. Most of the 180k launches are $2.9k dust. */
const MIN_VOL = 5_000, MIN_LIQ = 10_000;

let info = new Map<string, StonkInfo>(kv.get<[string, StonkInfo][]>("stonkfun:info", []));
let cache = { at: 0, mints: [] as string[] };

export function stonkInfo(mint: string): StonkInfo | undefined { return info.get(mint); }
export function isStonkReward(mint: string): boolean { return info.get(mint)?.mode === "reward"; }

async function page(sort: string): Promise<ApiToken[]> {
  // The CDN can serve an hours-old copy; a changing parameter asks for a fresh one. Fall back to the plain URL.
  const bucket = Math.floor(Date.now() / (10 * 60_000));
  for (const url of [`${BASE}?sort=${sort}&pageSize=100&t=${bucket}`, `${BASE}?sort=${sort}&pageSize=100`]) {
    try {
      const r = await getJson<{ data?: { tokens?: ApiToken[] } }>(url, { ttlMs: 10 * 60_000 });
      return r.data?.tokens ?? [];
    } catch (e) { log.debug({ url, err: String(e) }, "stonkfun list failed"); }
  }
  return [];
}

/** The busiest and biggest Stonk.fun coins, refreshed every 10 minutes. */
export async function stonkfunMints(): Promise<string[]> {
  if (Date.now() - cache.at < 10 * 60_000) return cache.mints;
  const rows = [...await page("volume"), ...await page("marketCap")];
  if (!rows.length) { cache.at = Date.now() - 5 * 60_000; return cache.mints; }   // retry in 5 min, keep the old list
  const keep = absorb(rows);
  cache = { at: Date.now(), mints: keep };
  log.info({ n: keep.length, seen: rows.length }, "stonkfun universe refreshed");
  return cache.mints;
}

/** Record what the API says about each coin; return the ones worth watching. */
export function absorb(rows: ApiToken[]): string[] {
  const keep = new Set<string>();
  for (const t of rows) {
    if (!t.mint) continue;
    const m = t.market ?? {};
    const i: StonkInfo = {
      mode: t.mode ?? "standard", taxBps: t.transferFee?.bps ?? 0, quote: t.quote?.symbol ?? "", status: t.status ?? "",
      pool: t.pool ?? "", mcap: m.marketCapUsd ?? 0, vol24h: m.volume24hUsd ?? 0,
    };
    info.set(t.mint, i);
    if (i.taxBps) setTax(t.mint, i.taxBps / 100);
    if ((m.volume24hUsd ?? 0) >= MIN_VOL || (m.liquidityUsd ?? 0) >= MIN_LIQ) keep.add(t.mint);
  }
  if (info.size > 3000) info = new Map([...info].slice(-2000));
  kv.set("stonkfun:info", [...info]);
  return [...keep];
}
