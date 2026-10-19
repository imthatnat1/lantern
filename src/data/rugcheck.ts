import { getJson } from "./http.js";
import { config } from "../config.js";
import type { SafetyResult } from "../types.js";
import { recorder, creators, kv } from "../db.js";
import { setTax } from "./tax.js";
import { isStonkReward, isStonkListed } from "./stonkfun.js";
import { burnName } from "./flow.js";

interface RcReport {
  rugged?: boolean;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  transferFee?: { pct?: number };
  risks?: { name: string; level: string; description?: string }[];
  markets?: { pubkey?: string; liquidityAAccount?: string; liquidityBAccount?: string; lp?: { lpLockedPct?: number } }[];
  topHolders?: { pct: number; insider?: boolean; owner?: string; address?: string }[];
  knownAccounts?: Record<string, { name?: string; type?: string }>;
  totalHolders?: number;
  token?: { mintAuthority?: string | null; freezeAuthority?: string | null };
  creator?: string;
  creatorBalance?: number;
  totalSupply?: number;
  tokenMeta?: { name?: string; symbol?: string; uri?: string };
}

const LIQ_HOLDER_RISKS = /liquidity|lp|holder|single/i;

/** Accounts that hold supply on behalf of everyone: the bonding curve, AMM pools, lockers. */
const POOL_TYPES = /amm|pool|curve|bonding|locker|\blp\b/i;

/**
 * Top 10 by real wallets. RugCheck lists the bonding curve and pool vaults as holders, so a coin still on
 * the curve, or one that just got dumped into its pool, reads "top 10 hold 99%" even when wallets hold little.
 */
export function realTop10(rep: Pick<RcReport, "topHolders" | "knownAccounts" | "markets">): number {
  const poolAccts = new Set<string>();
  for (const m of rep.markets ?? []) for (const a of [m.pubkey, m.liquidityAAccount, m.liquidityBAccount]) if (a) poolAccts.add(a);
  const isPool = (h: { owner?: string; address?: string }) => {
    for (const a of [h.owner, h.address]) {
      if (!a) continue;
      if (poolAccts.has(a)) return true;
      const k = rep.knownAccounts?.[a];
      if (k && POOL_TYPES.test(`${k.type ?? ""} ${k.name ?? ""}`)) return true;
    }
    return false;
  };
  return (rep.topHolders ?? []).filter(h => !isPool(h)).slice(0, 10).reduce((a, h) => a + (h.pct ?? 0), 0);
}

/** Token-2022 extensions that let the dev take your tokens or stop you selling. Each one is a honeypot. */
export function trapsFromExtensions(exts: { extension?: string; state?: any }[] | undefined): string[] {
  const out: string[] = [];
  for (const e of exts ?? []) {
    const st = e.state ?? {};
    switch (e.extension) {
      case "permanentDelegate": if (st.delegate) out.push("permanent delegate (dev can move your tokens)"); break;
      case "transferHook": if (st.programId) out.push("transfer hook (can block sells)"); break;
      case "nonTransferable": out.push("non-transferable token"); break;
      case "defaultAccountState": if (/frozen/i.test(String(st.accountState ?? ""))) out.push("new accounts start frozen"); break;
      case "pausableConfig": if (st.authority || st.paused) out.push("transfers can be paused"); break;
    }
  }
  return out;
}

const TRAP_RISKS = /permanent delegate|transfer hook|non.?transferable|default account state|pausable/i;

/** Mint extensions straight from the chain. Cached 6h: one Helius credit per new coin that otherwise passes. */
const trapCache = new Map<string, { at: number; traps: string[] | null }>();
async function chainMint(mint: string): Promise<any | null> {
  if (!config.keys.helius) return null;
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${config.keys.helius}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed" }] }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await res.json() as any;
  return j?.result?.value?.data?.parsed?.info ?? null;
}
async function token2022Traps(mint: string): Promise<string[] | null> {
  const hit = trapCache.get(mint);
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.traps;
  let traps: string[] | null = null;
  try { const info = await chainMint(mint); traps = info ? trapsFromExtensions(info.extensions) : null; } catch { traps = null; }
  if (trapCache.size > 5000) trapCache.clear();
  trapCache.set(mint, { at: Date.now(), traps });
  return traps;
}

/** Shared safety gate from the v1 spec, minus the dev-history DB (added later). */
export async function safety(mint: string, onCurve: boolean): Promise<SafetyResult> {
  const reasons: string[] = [];
  if (config.pinned.includes(mint)) return { ok: true, reasons: [] };
  let rep: RcReport;
  try {
    rep = await getJson<RcReport>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
      ttlMs: 5 * 60_000,
      headers: config.keys.rugcheck ? { authorization: `Bearer ${config.keys.rugcheck}` } : {},
    });
  } catch (e) {
    kv.set("rugcheck:lastErr", String(e).slice(0, 60));
    return fallbackOnChain(mint, onCurve);
  }
  kv.set("rugcheck:lastOkAt", Date.now());

  if (rep.rugged) {
    reasons.push("flagged rugged");
    if (rep.creator) { try { creators.markRugged(rep.creator, mint); } catch { /* best effort */ } }
    if (rep.tokenMeta?.name && !isStonkListed(mint) && !config.watch.includes(mint)) burnName(rep.tokenMeta.name, mint, "was flagged rugged");
  }
  if (rep.creator && creators.isRugger(rep.creator)) reasons.push("creator has rugged before");
  if (rep.creator && rep.creatorBalance && rep.totalSupply && rep.creatorBalance / rep.totalSupply > 0.10) reasons.push(`creator holds ${(rep.creatorBalance / rep.totalSupply * 100).toFixed(0)}%`);
  const mintAuth = rep.mintAuthority ?? rep.token?.mintAuthority;
  const freezeAuth = rep.freezeAuthority ?? rep.token?.freezeAuthority;
  if (mintAuth) reasons.push("mint authority active");
  if (freezeAuth) reasons.push("freeze authority active");
  const fee = rep.transferFee?.pct ?? 0;
  if (fee > 0) setTax(mint, fee);
  // A Stonk.fun reward coin's tax goes to holders in the paired token, not to the dev: allow up to 3%.
  // 19 Oct: checked all 524 coins Stonk.fun's API lists: fees are exactly 1% (240) or 3% (178), never more, and only on
  // reward coins. Any coin Stonk.fun lists gets the 3% limit (Blossom's flat 2% was refusing every 3% coin).
  if (fee > (isStonkReward(mint) || isStonkListed(mint) ? 3 : 2)) reasons.push(`transfer fee ${fee}%`);
  for (const r of rep.risks ?? []) {
    if (TRAP_RISKS.test(r.name)) reasons.push(`honeypot: ${r.name}`);
    else if (r.level === "danger" && !LIQ_HOLDER_RISKS.test(r.name)) reasons.push(`danger: ${r.name}`);
  }
  const lp = rep.markets?.[0]?.lp?.lpLockedPct;
  if (!onCurve && lp !== undefined && lp < 90) reasons.push(`LP locked ${lp.toFixed(0)}%`);

  if (rep.totalHolders) { try { recorder.holders(mint, rep.totalHolders); } catch { /* best effort */ } }
  const top10 = realTop10(rep);
  const insiders = (rep.topHolders ?? []).filter(h => h.insider).length;
  const insiderPct = (rep.topHolders ?? []).filter(h => h.insider).reduce((a, h) => a + (h.pct ?? 0), 0);
  // Sniper and bundle wallets among the top holders (RugCheck labels them when it can). Hard reject at 30%, otherwise the strategies see the pct.
  let sniperPct = 0;
  for (const h of rep.topHolders ?? []) {
    const k = h.owner ? rep.knownAccounts?.[h.owner] : undefined;
    if (k && /sniper|bundle|bundler|fresh/i.test(`${k.name ?? ""} ${k.type ?? ""}`)) sniperPct += h.pct ?? 0;
  }
  if (sniperPct > 30) reasons.push(`snipers/bundles hold ${sniperPct.toFixed(0)}%`);
  if (insiderPct > 20) reasons.push(`insiders hold ${insiderPct.toFixed(0)}%`);
  if (top10 > 60) reasons.push(`top 10 hold ${top10.toFixed(0)}%`);
  // Belt and braces: RugCheck doesn't always flag Token-2022 traps, so read the mint ourselves for coins that pass.
  if (!reasons.length) {
    const traps = await token2022Traps(mint);
    if (traps?.length) reasons.push(...traps.map(t => `honeypot: ${t}`));
  }

  const out = { ok: reasons.length === 0, reasons, top10Pct: top10, insiders, holders: rep.totalHolders, lpLockedPct: lp, creator: rep.creator, sniperPct, metaUri: rep.tokenMeta?.uri };
  try { recorder.safety(mint, out); } catch { /* best effort */ }
  return out;
}

/**
 * When RugCheck is down or has no report, check the two things that matter most straight from the chain:
 * mint authority and freeze authority. Everything else (LP, holders) is unknown, so we pass with a note
 * and let the strategies' own liquidity/holder rules do the rest. Fails closed if the chain call also fails.
 */
async function fallbackOnChain(mint: string, onCurve: boolean): Promise<SafetyResult> {
  if (!config.keys.helius) return { ok: false, reasons: ["rugcheck unavailable, no helius key for fallback"] };
  try {
    const info = await chainMint(mint);
    if (!info) return { ok: false, reasons: ["rugcheck unavailable, mint not readable on chain"] };
    const reasons: string[] = [];
    if (info.mintAuthority) reasons.push("mint authority active (on-chain)");
    if (info.freezeAuthority) reasons.push("freeze authority active (on-chain)");
    for (const t of trapsFromExtensions(info.extensions)) reasons.push(`honeypot: ${t} (on-chain)`);
    return { ok: reasons.length === 0, reasons, holders: undefined };
  } catch {
    return { ok: false, reasons: ["rugcheck unavailable and chain check failed"] };
  }
}
