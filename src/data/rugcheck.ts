import { getJson } from "./http.js";
import { config } from "../config.js";
import type { SafetyResult } from "../types.js";

interface RcReport {
  rugged?: boolean;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  transferFee?: { pct?: number };
  risks?: { name: string; level: string; description?: string }[];
  markets?: { lp?: { lpLockedPct?: number } }[];
  topHolders?: { pct: number; insider?: boolean }[];
  totalHolders?: number;
  token?: { mintAuthority?: string | null; freezeAuthority?: string | null };
}

const LIQ_HOLDER_RISKS = /liquidity|lp|holder|single/i;

/** Shared safety gate from the v1 spec, minus the dev-history DB (added later). */
export async function safety(mint: string, onCurve: boolean): Promise<SafetyResult> {
  const reasons: string[] = [];
  let rep: RcReport;
  try {
    rep = await getJson<RcReport>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
      ttlMs: 10 * 60_000,
      headers: config.keys.rugcheck ? { authorization: `Bearer ${config.keys.rugcheck}` } : {},
    });
  } catch (e) {
    return { ok: false, reasons: ["rugcheck unavailable"] };
  }

  if (rep.rugged) reasons.push("flagged rugged");
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

  const top10 = (rep.topHolders ?? []).slice(0, 10).reduce((a, h) => a + (h.pct ?? 0), 0);
  const insiders = (rep.topHolders ?? []).filter(h => h.insider).length;

  return { ok: reasons.length === 0, reasons, top10Pct: top10, insiders, holders: rep.totalHolders, lpLockedPct: lp };
}
