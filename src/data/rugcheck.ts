import { getJson } from "./http.js";
import { config } from "../config.js";
import type { SafetyResult } from "../types.js";
import { recorder, creators } from "../db.js";

interface RcReport {
  rugged?: boolean;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  transferFee?: { pct?: number };
  risks?: { name: string; level: string; description?: string }[];
  markets?: { lp?: { lpLockedPct?: number } }[];
  topHolders?: { pct: number; insider?: boolean; owner?: string }[];
  knownAccounts?: Record<string, { name?: string; type?: string }>;
  totalHolders?: number;
  token?: { mintAuthority?: string | null; freezeAuthority?: string | null };
  creator?: string;
  creatorBalance?: number;
  totalSupply?: number;
}

const LIQ_HOLDER_RISKS = /liquidity|lp|holder|single/i;

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
    return fallbackOnChain(mint, onCurve);
  }

  if (rep.rugged) {
    reasons.push("flagged rugged");
    if (rep.creator) { try { creators.markRugged(rep.creator, mint); } catch { /* best effort */ } }
  }
  if (rep.creator && creators.isRugger(rep.creator)) reasons.push("creator has rugged before");
  if (rep.creator && rep.creatorBalance && rep.totalSupply && rep.creatorBalance / rep.totalSupply > 0.10) reasons.push(`creator holds ${(rep.creatorBalance / rep.totalSupply * 100).toFixed(0)}%`);
  const mintAuth = rep.mintAuthority ?? rep.token?.mintAuthority;
  const freezeAuth = rep.freezeAuthority ?? rep.token?.freezeAuthority;
  if (mintAuth) reasons.push("mint authority active");
  if (freezeAuth) reasons.push("freeze authority active");
  if ((rep.transferFee?.pct ?? 0) > 2) reasons.push(`transfer fee ${rep.transferFee?.pct}%`);
  for (const r of rep.risks ?? []) {
    if (r.level === "danger" && !LIQ_HOLDER_RISKS.test(r.name)) reasons.push(`danger: ${r.name}`);
  }
  const lp = rep.markets?.[0]?.lp?.lpLockedPct;
  if (!onCurve && lp !== undefined && lp < 90) reasons.push(`LP locked ${lp.toFixed(0)}%`);

  if (rep.totalHolders) { try { recorder.holders(mint, rep.totalHolders); } catch { /* best effort */ } }
  const top10 = (rep.topHolders ?? []).slice(0, 10).reduce((a, h) => a + (h.pct ?? 0), 0);
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

  return { ok: reasons.length === 0, reasons, top10Pct: top10, insiders, holders: rep.totalHolders, lpLockedPct: lp, creator: rep.creator, sniperPct };
}

/**
 * When RugCheck is down or has no report, check the two things that matter most straight from the chain:
 * mint authority and freeze authority. Everything else (LP, holders) is unknown, so we pass with a note
 * and let the strategies' own liquidity/holder rules do the rest. Fails closed if the chain call also fails.
 */
async function fallbackOnChain(mint: string, onCurve: boolean): Promise<SafetyResult> {
  if (!config.keys.helius) return { ok: false, reasons: ["rugcheck unavailable, no helius key for fallback"] };
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${config.keys.helius}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed" }] }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json() as any;
    const info = j?.result?.value?.data?.parsed?.info;
    if (!info) return { ok: false, reasons: ["rugcheck unavailable, mint not readable on chain"] };
    const reasons: string[] = [];
    if (info.mintAuthority) reasons.push("mint authority active (on-chain)");
    if (info.freezeAuthority) reasons.push("freeze authority active (on-chain)");
    return { ok: reasons.length === 0, reasons: reasons.length ? reasons : [], holders: undefined };
  } catch {
    return { ok: false, reasons: ["rugcheck unavailable and chain check failed"] };
  }
}
