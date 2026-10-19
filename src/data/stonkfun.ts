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

export interface StonkInfo { mode: string; taxBps: number; quote: string; status: string; pool: string; mcap: number; vol24h: number; liq?: number }

export interface ApiToken {
  mint: string; pool?: string; symbol?: string; mode?: string; status?: string;
  quote?: { mint?: string; symbol?: string };
  market?: { marketCapUsd?: number; volume24hUsd?: number; liquidityUsd?: number };
  transferFee?: { bps?: number };
  createdAt?: string; graduationProgress?: number;
}

const BASE = "https://www.stonkfun.xyz/api/public/v1/tokens";
/** Worth watching: real trading or a real pool. Most of the 180k launches are $2.9k dust. */
const MIN_VOL = 5_000, MIN_LIQ = 10_000;

let info = new Map<string, StonkInfo>(kv.get<[string, StonkInfo][]>("stonkfun:info", []));
let cache = { at: 0, mints: [] as string[], fresh: [] as string[] };
/** Graduations we saw happen (status went from new / aboutToGraduate to graduated). main.ts feeds them to bounce. */
let graduations: { mint: string; at: number }[] = [];
export function takeGraduations(): { mint: string; at: number }[] { const g = graduations; graduations = []; return g; }

/** Listed by Stonk.fun itself (seen in its API). Their stock and brand names are the platform's theme, not copycats. */
export function isStonkListed(mint: string): boolean { return info.has(mint); }

/**
 * Flagships: Stonk.fun's biggest coins with a real pool, by market cap. Dip watches these first.
 * (Pinned coins are added by universe.ts.)
 */
export function stonkFlagships(n = 8, minLiq = 50_000): string[] {
  return [...info.entries()].filter(([, i]) => (i.liq ?? 0) >= minLiq && i.status !== "new")
    .sort((a, b) => b[1].mcap - a[1].mcap).slice(0, n).map(([m]) => m);
}

export function stonkInfo(mint: string): StonkInfo | undefined { return info.get(mint); }
export function isStonkReward(mint: string): boolean { return info.get(mint)?.mode === "reward"; }

/**
 * One page of the token list. The CDN can serve a copy days old for some URLs (18 Oct: sort=newest was stuck on
 * 14 Oct, sort=volume&status=new on 10 Oct, while sort=newest&status=new was live), so every page is checked
 * against meta.generatedAt. `needFresh` pages (new launches, graduations) are dropped when older than an hour;
 * the top lists accept an older copy, since their coins are re-priced from DexScreener anyway.
 */
async function page(sort: string, extra = "", needFresh = false): Promise<ApiToken[]> {
  const bucket = Math.floor(Date.now() / (10 * 60_000));
  let best: { at: number; tokens: ApiToken[] } | null = null;
  for (const url of [`${BASE}?sort=${sort}${extra}&pageSize=100&t=${bucket}`, `${BASE}?pageSize=100&sort=${sort}${extra}`]) {
    try {
      const r = await getJson<{ data?: { tokens?: ApiToken[] }; meta?: { generatedAt?: string } }>(url, { ttlMs: 10 * 60_000 });
      const at = Date.parse(r.meta?.generatedAt ?? "") || 0;
      const tokens = r.data?.tokens ?? [];
      if (Date.now() - at < 60 * 60_000) return tokens;
      if (!best || at > best.at) best = { at, tokens };
    } catch (e) { log.debug({ url, err: String(e) }, "stonkfun list failed"); }
  }
  if (best && needFresh) { log.debug({ sort, extra, servedFrom: new Date(best.at).toISOString() }, "stonkfun list stale, skipped"); return []; }
  return best?.tokens ?? [];
}

/** The busiest and biggest Stonk.fun coins, refreshed every 10 minutes. */
export async function stonkfunMints(): Promise<string[]> {
  await refresh();
  return cache.mints;
}

/**
 * New Stonk.fun pairs: the newest launches with real early trading, everything about to graduate, and the
 * latest graduations. These are what pullback, ultra and bounce look for (on pump.fun they come from the
 * launch feed and DexScreener trending).
 */
export async function stonkfunFresh(): Promise<string[]> {
  await refresh();
  return cache.fresh;
}

async function refresh() {
  if (Date.now() - cache.at < 10 * 60_000) return;
  // ("status=aboutToGraduate" exists in the docs but returned nothing on 18 Oct; graduationProgress does the job.)
  const [vol, cap, newest, grad, cap2, cap3] = await Promise.all([
    page("volume"), page("marketCap"), page("newest", "&status=new", true), page("newest", "&status=graduated", true),
    page("marketCap", "&page=2"), page("marketCap", "&page=3"),
  ]);
  // Pages 2-3 by market cap: recorded so the bot knows they're Stonk.fun coins (3% fee limit, no name-based copycat
  // check), but only watched if they clear the usual volume/liquidity bar. 19 Oct: ~524 coins listed in total.
  absorb([...cap2, ...cap3]);
  const top = [...vol, ...cap];
  if (!top.length && !newest.length && !grad.length) { cache.at = Date.now() - 5 * 60_000; return; }   // retry in 5 min, keep the old lists
  const keep = absorb(top);
  const now = Date.now();
  // Launches still on the curve: keep the ones with real early trading or close to graduating.
  const early = absorb(newest.filter(t => (t.market?.volume24hUsd ?? 0) >= 1_000 || (t.graduationProgress ?? 0) >= 0.5), { minVol: 0, minLiq: 0 });
  // Recent graduations: created in the last 12h, so the bounce window still applies.
  const recentGrads = grad.filter(t => now - (Date.parse(t.createdAt ?? "") || 0) < 12 * 3_600_000);
  const gradFresh = absorb(recentGrads, { minVol: 1_000, minLiq: 3_000 }, now, true);
  const fresh = [...new Set([...gradFresh, ...early])];
  cache = { at: now, mints: keep.length ? keep : cache.mints, fresh: fresh.length ? fresh : cache.fresh };
  log.info({ top: keep.length, fresh: fresh.length, grads: recentGrads.length }, "stonkfun universe refreshed");
}

/** Record what the API says about each coin; return the ones worth watching. Notes graduations as they happen. */
export function absorb(rows: ApiToken[], min = { minVol: MIN_VOL, minLiq: MIN_LIQ }, now = Date.now(), recentGraduations = false): string[] {
  const keep = new Set<string>();
  for (const t of rows) {
    if (!t.mint) continue;
    const m = t.market ?? {};
    const before = info.get(t.mint);
    const i: StonkInfo = {
      mode: t.mode ?? "standard", taxBps: t.transferFee?.bps ?? 0, quote: t.quote?.symbol ?? "", status: t.status ?? before?.status ?? "",
      pool: t.pool ?? "", mcap: m.marketCapUsd ?? 0, vol24h: m.volume24hUsd ?? 0, liq: m.liquidityUsd ?? before?.liq,
    };
    // A graduation counts when we watched it change, or when it shows up in the recent-graduations list (created in
    // the last 12h) and we hadn't seen it graduated before. A coin first seen graduated elsewhere may have done it days ago.
    const changed = !!before?.status && before.status !== "graduated" && i.status === "graduated";
    const fresh = recentGraduations && i.status === "graduated" && before?.status !== "graduated";
    if (changed || fresh) graduations.push({ mint: t.mint, at: now });
    info.set(t.mint, i);
    if (i.taxBps) setTax(t.mint, i.taxBps / 100);
    if ((m.volume24hUsd ?? 0) >= min.minVol || (m.liquidityUsd ?? 0) >= min.minLiq) keep.add(t.mint);
  }
  if (info.size > 3000) info = new Map([...info].slice(-2000));
  kv.set("stonkfun:info", [...info]);
  return [...keep];
}
