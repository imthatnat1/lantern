import { getJson } from "./http.js";
import { config } from "../config.js";
import { kv } from "../db.js";
import { log } from "../log.js";

const SOL = "So11111111111111111111111111111111111111112";
const CREDITS_PER_CALL = 100; // enhanced transactions endpoint

export interface WalletBuy { wallet: string; mint: string; signature: string; at: number; solSpent: number }

interface HeliusTx {
  signature: string; timestamp: number; type: string; feePayer: string;
  tokenTransfers?: { fromUserAccount: string; toUserAccount: string; mint: string; tokenAmount: number }[];
  nativeTransfers?: { fromUserAccount: string; toUserAccount: string; amount: number }[];
}

function dayKey() { return `helius:credits:${new Date().toISOString().slice(0, 10)}`; }

export function creditsUsedToday(): number { return kv.get(dayKey(), 0); }

function spend(n: number) { kv.set(dayKey(), creditsUsedToday() + n); }

/** Recent swaps where `wallet` received a non-SOL token. Within the daily credit budget. */
export async function recentBuys(wallet: string, sinceMs: number, budget: number): Promise<WalletBuy[]> {
  if (!config.keys.helius) return [];
  if (creditsUsedToday() + CREDITS_PER_CALL > budget) {
    log.warn({ used: creditsUsedToday(), budget }, "helius budget hit for today");
    return [];
  }
  spend(CREDITS_PER_CALL);
  const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${config.keys.helius}&limit=10&type=SWAP`;
  let txs: HeliusTx[];
  try { txs = await getJson<HeliusTx[]>(url); } catch (e) { log.warn({ wallet, err: String(e) }, "helius fetch failed"); return []; }

  const out: WalletBuy[] = [];
  for (const tx of txs) {
    const at = tx.timestamp * 1000;
    if (at < sinceMs) continue;
    const received = (tx.tokenTransfers ?? []).filter(t => t.toUserAccount === wallet && t.mint !== SOL);
    if (!received.length) continue;
    const solOut = (tx.nativeTransfers ?? []).filter(t => t.fromUserAccount === wallet).reduce((a, t) => a + t.amount, 0) / 1e9;
    for (const r of received) out.push({ wallet, mint: r.mint, signature: tx.signature, at, solSpent: solOut });
  }
  return out;
}

/** Recent swaps where `wallet` sent a given mint out (a sell). */
export async function recentSells(wallet: string, mint: string, sinceMs: number, budget: number): Promise<number> {
  if (!config.keys.helius) return 0;
  if (creditsUsedToday() + CREDITS_PER_CALL > budget) return 0;
  spend(CREDITS_PER_CALL);
  const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${config.keys.helius}&limit=10&type=SWAP`;
  let txs: HeliusTx[];
  try { txs = await getJson<HeliusTx[]>(url); } catch { return 0; }
  let sold = 0;
  for (const tx of txs) {
    if (tx.timestamp * 1000 < sinceMs) continue;
    for (const t of tx.tokenTransfers ?? []) if (t.fromUserAccount === wallet && t.mint === mint) sold += t.tokenAmount;
  }
  return sold;
}
