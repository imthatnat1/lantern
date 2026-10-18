/**
 * Token-2022 transfer tax per coin, as a percent (1 = 1%). Filled from RugCheck reports and the
 * Stonk.fun API. A taxed coin delivers fewer tokens on a buy and fewer dollars on a sell, so the
 * fill model charges it on both sides. Kept in its own module so the broker can read it without
 * pulling in the data clients.
 */
import { kv } from "../db.js";

const taxes = new Map<string, number>(kv.get<[string, number][]>("taxes", []));
let dirty = 0;

export function setTax(mint: string, pct: number) {
  if (!(pct >= 0) || taxes.get(mint) === pct) return;
  taxes.set(mint, pct);
  if (taxes.size > 5000) for (const k of [...taxes.keys()].slice(0, 1000)) taxes.delete(k);
  if (++dirty >= 20) { kv.set("taxes", [...taxes]); dirty = 0; }
}

export function taxPct(mint: string): number { return taxes.get(mint) ?? 0; }
