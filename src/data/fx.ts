/**
 * USD to AUD (19 Oct, from Blossom, which stores the rate on every trade). Nat is in Australia, so tax is in AUD:
 * each fill keeps the rate at the time it happened (fills.usd_aud, set in db.ts), and /api/state shows AUD totals.
 * Rate refreshed hourly from Frankfurter (ECB reference rates), with open.er-api.com as backup. Paper only for now,
 * but this is the record a real-money tax return would need.
 */
import { db, kv, usdAudNow } from "../db.js";
import { log } from "../log.js";
import { brisbaneDayStart } from "../engine/broker.js";

const SOURCES: [string, (j: any) => number | undefined][] = [
  ["https://api.frankfurter.app/latest?from=USD&to=AUD", j => j?.rates?.AUD],
  ["https://open.er-api.com/v6/latest/USD", j => j?.rates?.AUD],
];

export async function refreshFx(): Promise<number | null> {
  for (const [url, pick] of SOURCES) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const rate = Number(pick(await r.json()));
      if (rate > 0.8 && rate < 3) { kv.set("fx:usdaud", { rate, at: Date.now() }); return rate; }   // sanity band
    } catch (e) { log.debug({ url, err: String(e) }, "fx fetch failed"); }
  }
  log.warn("USD/AUD rate unavailable from both sources");
  return null;
}

/**
 * AUD totals. Realised P&L in AUD is worked out per position the way a tax return would: each sale's proceeds at the
 * rate on the day of the sale, minus that share of the cost at the rate(s) on the day(s) it was bought. Fills from
 * before rates were recorded use the current rate (flagged by `fillsWithoutRate`).
 */
export function audSummary(equityUsd: number, cashUsd: number, vaultUsd: number, now = Date.now()) {
  const rate = usdAudNow(now);
  const fx = kv.get<{ rate: number; at: number } | null>("fx:usdaud", null);
  const rows = db.prepare("SELECT position_id, side, qty, gross_usd, net_usd, usd_aud, at FROM fills WHERE position_id IS NOT NULL ORDER BY at").all() as
    { position_id: number; side: string; qty: number; gross_usd: number; net_usd: number; usd_aud: number | null; at: number }[];
  const pos = new Map<number, { qty: number; costAud: number }>();
  let realizedAud = 0, realizedTodayAud = 0, noRate = 0;
  const dayStart = brisbaneDayStart(now);
  for (const f of rows) {
    const r = f.usd_aud ?? rate;
    if (f.usd_aud == null) noRate++;
    if (r == null) continue;
    const p = pos.get(f.position_id) ?? { qty: 0, costAud: 0 };
    if (f.side === "buy") { p.qty += f.qty; p.costAud += f.gross_usd * r; }
    else if (p.qty > 0) {
      const share = Math.min(1, f.qty / p.qty);
      const cost = p.costAud * share;
      const pnl = f.net_usd * r - cost;
      realizedAud += pnl;
      if (f.at >= dayStart) realizedTodayAud += pnl;
      p.qty -= f.qty; p.costAud -= cost;
    }
    pos.set(f.position_id, p);
  }
  return {
    rate, rateAt: fx?.at ?? null,
    equityAud: rate != null ? equityUsd * rate : null, cashAud: rate != null ? cashUsd * rate : null, vaultAud: rate != null ? vaultUsd * rate : null,
    realizedAud, realizedTodayAud, fillsWithoutRate: noRate,
  };
}
