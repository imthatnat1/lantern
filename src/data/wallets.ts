import { config } from "../config.js";
import { kv, db } from "../db.js";
import { log } from "../log.js";

/**
 * Wallet flow, pushed by Helius webhooks instead of polled (polling 10 wallets costs more credits
 * than the free tier has). On startup we make sure one webhook exists pointing at our API, covering
 * the trusted wallets (tier 1: can trigger buys, audited) and the KOL wallets (tier 2: score boost
 * and candidate source only). Every buy they make lands in wallet_events and the strategies read it.
 */

export const KOLS: { name: string; address: string }[] = [
  { name: "Cooker", address: "8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6" },
  { name: "Letterbomb", address: "BtMBMPkoNbnLF9Xn552guQq528KKXcsNBNNBre3oaQtr" },
  { name: "Advyth", address: "GEKZWL474tFAyYDUoTgKEgYuMxT3Se7HzKDDptrnXnvS" },
  { name: "S", address: "ApRnQN2HkbCn7W2WWiT2FEKvuKJp9LugRyAE1a9Hdz1" },
  { name: "Dame", address: "EtyHwLDfAi9E24Qw41xFUW8WtQ3NxajxJA2yaaUASR5a" },
  { name: "Rilsio", address: "4fZFcK8ms3bFMpo1ACzEUz8bH741fQW4zhAMGd5yZMHu" },
];

const SOL = "So11111111111111111111111111111111111111112";

export function walletTier(address: string): "trusted" | "kol" | null {
  if (config.trustedWallets.includes(address)) return "trusted";
  if (KOLS.some(k => k.address === address)) return "kol";
  return null;
}
export function walletName(address: string): string {
  return KOLS.find(k => k.address === address)?.name ?? config.walletName(address);
}

db.exec(`CREATE TABLE IF NOT EXISTS wallet_events (
  signature TEXT PRIMARY KEY, wallet TEXT NOT NULL, tier TEXT NOT NULL, side TEXT NOT NULL,
  mint TEXT NOT NULL, amount REAL NOT NULL, sol REAL NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_events_at ON wallet_events(at);`);

const ins = db.prepare("INSERT OR IGNORE INTO wallet_events(signature,wallet,tier,side,mint,amount,sol,at) VALUES(?,?,?,?,?,?,?,?)");

/** Parse a Helius enhanced transaction (webhook payload item) into buy/sell events for watched wallets. */
export function ingest(tx: any): number {
  if (!tx || tx.type !== "SWAP" && !tx.tokenTransfers) return 0;
  const at = (tx.timestamp ?? Math.floor(Date.now() / 1000)) * 1000;
  const sig = tx.signature as string;
  let n = 0;
  const watched = new Set([...config.trustedWallets, ...KOLS.map(k => k.address)]);
  for (const w of watched) {
    const solOut = (tx.nativeTransfers ?? []).filter((t: any) => t.fromUserAccount === w).reduce((a: number, t: any) => a + t.amount, 0) / 1e9;
    const solIn = (tx.nativeTransfers ?? []).filter((t: any) => t.toUserAccount === w).reduce((a: number, t: any) => a + t.amount, 0) / 1e9;
    for (const t of tx.tokenTransfers ?? []) {
      if (t.mint === SOL) continue;
      if (t.toUserAccount === w) { ins.run(`${sig}:${w}:${t.mint}:b`, w, walletTier(w)!, "buy", t.mint, t.tokenAmount, solOut, at); n++; }
      else if (t.fromUserAccount === w) { ins.run(`${sig}:${w}:${t.mint}:s`, w, walletTier(w)!, "sell", t.mint, t.tokenAmount, solIn, at); n++; }
    }
  }
  if (n) log.info({ sig: sig?.slice(0, 8), n }, "wallet events ingested");
  return n;
}

export interface WalletBuy { wallet: string; name: string; tier: "trusted" | "kol"; mint: string; at: number; sol: number }

export function recentBuys(sinceMs: number, tier?: "trusted" | "kol"): WalletBuy[] {
  const rows = db.prepare(`SELECT wallet, tier, mint, at, sol FROM wallet_events WHERE side='buy' AND at >= ? ${tier ? "AND tier=?" : ""} ORDER BY at DESC`)
    .all(...(tier ? [sinceMs, tier] : [sinceMs])) as any[];
  return rows.map(r => ({ ...r, name: walletName(r.wallet) }));
}

/** Wallets of a tier that bought `mint` in the last `windowMs`. */
export function buyersOf(mint: string, windowMs: number, tier?: "trusted" | "kol"): string[] {
  const rows = db.prepare(`SELECT DISTINCT wallet FROM wallet_events WHERE side='buy' AND mint=? AND at >= ? ${tier ? "AND tier=?" : ""}`)
    .all(...(tier ? [mint, Date.now() - windowMs, tier] : [mint, Date.now() - windowMs])) as { wallet: string }[];
  return rows.map(r => walletName(r.wallet));
}

/** Did any watched wallet sell `mint` since `sinceMs`? Used to mirror exits. */
export function soldSince(mint: string, sinceMs: number, wallets: string[]): boolean {
  if (!wallets.length) return false;
  const q = wallets.map(() => "?").join(",");
  return !!db.prepare(`SELECT 1 FROM wallet_events WHERE side='sell' AND mint=? AND at >= ? AND wallet IN (${q})`).get(mint, sinceMs, ...wallets);
}

/** Make sure a Helius webhook exists for our address list and points at our API. Idempotent. */
export async function ensureWebhook(publicUrl: string) {
  if (!config.keys.helius) { log.warn("no helius key, wallet webhook disabled"); return; }
  const addresses = [...new Set([...config.trustedWallets, ...KOLS.map(k => k.address)])];
  const want = { webhookURL: `${publicUrl}/api/wallet-events`, transactionTypes: ["SWAP"], accountAddresses: addresses, webhookType: "enhanced", authHeader: `Bearer ${process.env.DASHBOARD_TOKEN ?? ""}` };
  const base = `https://api.helius.xyz/v0/webhooks?api-key=${config.keys.helius}`;
  try {
    const list = await (await fetch(base, { signal: AbortSignal.timeout(10_000) })).json() as any[];
    const mine = (list ?? []).find(w => w.webhookURL === want.webhookURL);
    if (mine) {
      const same = JSON.stringify([...mine.accountAddresses].sort()) === JSON.stringify([...addresses].sort());
      if (!same) {
        await fetch(`https://api.helius.xyz/v0/webhooks/${mine.webhookID}?api-key=${config.keys.helius}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(want), signal: AbortSignal.timeout(10_000) });
        log.info({ n: addresses.length }, "helius webhook updated");
      } else log.info({ n: addresses.length }, "helius webhook ok");
      kv.set("helius:webhook", mine.webhookID);
      return;
    }
    const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(want), signal: AbortSignal.timeout(10_000) });
    const j = await r.json() as any;
    if (j.webhookID) { kv.set("helius:webhook", j.webhookID); log.info({ n: addresses.length }, "helius webhook created"); }
    else log.warn({ j }, "helius webhook create failed");
  } catch (e) {
    log.warn({ err: String(e) }, "helius webhook setup failed, falling back to polling for trusted wallets");
  }
}

/** Per-wallet scorecard: what happened to the coins each wallet bought, from our recorded ticks. */
export function scorecard(days = 7) {
  const since = Date.now() - days * 86_400_000;
  const buys = db.prepare("SELECT wallet, tier, mint, at FROM wallet_events WHERE side='buy' AND at >= ?").all(since) as any[];
  const out = new Map<string, { name: string; tier: string; n: number; up2x: number; down50: number; medianRet: number; rets: number[] }>();
  type E = { name: string; tier: string; n: number; up2x: number; down50: number; medianRet: number; rets: number[] };
  const first = db.prepare("SELECT price FROM ticks WHERE mint=? AND at >= ? ORDER BY at LIMIT 1");
  const peak = db.prepare("SELECT MAX(price) AS p FROM ticks WHERE mint=? AND at >= ? AND at <= ?");
  const last = db.prepare("SELECT price FROM ticks WHERE mint=? ORDER BY at DESC LIMIT 1");
  for (const b of buys) {
    const p0 = (first.get(b.mint, b.at) as any)?.price; if (!p0) continue;
    const pk = (peak.get(b.mint, b.at, b.at + 6 * 3_600_000) as any)?.p ?? p0;
    const pl = (last.get(b.mint) as any)?.price ?? p0;
    const e: E = out.get(b.wallet) ?? { name: walletName(b.wallet), tier: b.tier, n: 0, up2x: 0, down50: 0, medianRet: 0, rets: [] as number[] };
    e.n++; if (pk >= p0 * 2) e.up2x++; if (pl <= p0 * 0.5) e.down50++; e.rets.push(pl / p0 - 1);
    out.set(b.wallet, e);
  }
  return [...out.values()].map(e => { const r = [...e.rets].sort((a, b) => a - b); return { ...e, medianRet: r.length ? r[Math.floor(r.length / 2)] : 0, rets: undefined }; });
}
