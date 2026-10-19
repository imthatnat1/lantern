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

/**
 * Recent swaps where `wallet` received a non-SOL token. Within the daily credit budget.
 * Every fetched swap (buys AND sells) also goes into wallet_events through `ingestTx`, so when the webhook is quiet
 * this backup poll still tells the exit loop that a trusted wallet sold a coin we hold.
 */
export async function recentBuys(wallet: string, sinceMs: number, budget: number, ingestTx?: (tx: any) => unknown): Promise<WalletBuy[]> {
  if (!config.keys.helius) return [];
  if (creditsUsedToday() + CREDITS_PER_CALL > budget) {
    log.warn({ used: creditsUsedToday(), budget }, "helius budget hit for today");
    return [];
  }
  const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${config.keys.helius}&limit=10&type=SWAP`;
  let txs: HeliusTx[];
  try { txs = await getJson<HeliusTx[]>(url); spend(CREDITS_PER_CALL); kv.set("helius:lastOkAt", Date.now()); } catch (e) { kv.set("helius:lastErr", String(e).slice(0, 40)); log.warn({ wallet, err: String(e) }, "helius fetch failed"); return []; }
  if (ingestTx) for (const tx of txs) { try { ingestTx(tx); } catch { /* best effort */ } }

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

/**
 * How many tokens of `mint` a wallet holds right now (UI units, all its token accounts, Token-2022 included).
 * One RPC call; null when there's no key, the budget is spent, or the call fails.
 * Used to turn "wirelyss sold 1.2M tokens" into "wirelyss sold 80% of her bag".
 */
const BALANCE_CREDITS = 10;   // getTokenAccountsByOwner; counted high on purpose
export async function tokenBalance(owner: string, mint: string, budget: number): Promise<number | null> {
  if (!config.keys.helius) return null;
  if (creditsUsedToday() + BALANCE_CREDITS > budget) return null;
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${config.keys.helius}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { mint }, { encoding: "jsonParsed" }] }),
      signal: AbortSignal.timeout(8000),
    });
    spend(BALANCE_CREDITS);
    const j = await res.json() as any;
    const accts = j?.result?.value;
    if (!Array.isArray(accts)) return null;
    return accts.reduce((a: number, x: any) => {
      const t = x?.account?.data?.parsed?.info?.tokenAmount;
      return a + Number(t?.uiAmountString ?? t?.uiAmount ?? 0);
    }, 0);
  } catch (e) {
    log.debug({ owner: owner.slice(0, 6), err: String(e) }, "helius balance failed");
    return null;
  }
}

/** Recent swaps where `wallet` sent a given mint out (a sell). */
export async function recentSells(wallet: string, mint: string, sinceMs: number, budget: number): Promise<number> {
  if (!config.keys.helius) return 0;
  if (creditsUsedToday() + CREDITS_PER_CALL > budget) return 0;
  const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${config.keys.helius}&limit=10&type=SWAP`;
  let txs: HeliusTx[];
  try { txs = await getJson<HeliusTx[]>(url); spend(CREDITS_PER_CALL); kv.set("helius:lastOkAt", Date.now()); } catch { return 0; }
  let sold = 0;
  for (const tx of txs) {
    if (tx.timestamp * 1000 < sinceMs) continue;
    for (const t of tx.tokenTransfers ?? []) if (t.fromUserAccount === wallet && t.mint === mint) sold += t.tokenAmount;
  }
  return sold;
}
