import { config } from "../config.js";
import { kv, db } from "../db.js";
import { log } from "../log.js";

/**
 * Wallet flow, pushed by Helius webhooks instead of polled (polling 10 wallets costs more credits
 * than the free tier has). On startup we make sure one webhook exists pointing at our API, covering
 * the trusted wallets (tier 1: can trigger buys, audited) and the KOL wallets (tier 2: score boost
 * and candidate source only). Every buy they make lands in wallet_events and the strategies read it.
 */

/** Starting bench. Replaced by rotateKols() once we have our own data; read via currentKols(). */
const SEED_KOLS: { name: string; address: string }[] = [
  { name: "Cooker", address: "8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6" },
  { name: "Letterbomb", address: "BtMBMPkoNbnLF9Xn552guQq528KKXcsNBNNBre3oaQtr" },
  { name: "Advyth", address: "GEKZWL474tFAyYDUoTgKEgYuMxT3Se7HzKDDptrnXnvS" },
  { name: "S", address: "ApRnQN2HkbCn7W2WWiT2FEKvuKJp9LugRyAE1a9Hdz1" },
  { name: "Dame", address: "EtyHwLDfAi9E24Qw41xFUW8WtQ3NxajxJA2yaaUASR5a" },
  { name: "Rilsio", address: "4fZFcK8ms3bFMpo1ACzEUz8bH741fQW4zhAMGd5yZMHu" },
];

const SOL = "So11111111111111111111111111111111111111112";

/** Wallets Blossom measured at 2,000+ trades a month. Never on the bench. */
const KNOWN_BOTS = new Set([
  "4DdrfiDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh", // Mr. Frog
  "FqamE7xrahg7FEWoByrx1o8SeyHt44rpmE6ZQfT7zrve", // EustazZ
  "8MaVa9kdt3NW4Q5HyNAm1X5LbR8PQRVDc1W8NMVK88D5", // Daumen
  "ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT",  // trunoest
]);

export function currentKols(): { name: string; address: string }[] {
  return kv.get<{ name: string; address: string }[]>("kols:bench", SEED_KOLS);
}
export const KOLS = { get list() { return currentKols(); } };

export function walletTier(address: string): "trusted" | "kol" | null {
  if (config.trustedWallets.includes(address)) return "trusted";
  if (currentKols().some(k => k.address === address)) return "kol";
  if (kv.get<Record<string, string>>("kols:names", {})[address]) return "kol";   // recently rotated out, still name its old events
  return null;
}
export function walletName(address: string): string {
  return currentKols().find(k => k.address === address)?.name ?? kv.get<Record<string, string>>("kols:names", {})[address] ?? config.walletName(address);
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
  const watched = new Set([...config.trustedWallets, ...currentKols().map(k => k.address)]);
  for (const w of watched) {
    const solOut = (tx.nativeTransfers ?? []).filter((t: any) => t.fromUserAccount === w).reduce((a: number, t: any) => a + t.amount, 0) / 1e9;
    const solIn = (tx.nativeTransfers ?? []).filter((t: any) => t.toUserAccount === w).reduce((a: number, t: any) => a + t.amount, 0) / 1e9;
    for (const t of tx.tokenTransfers ?? []) {
      if (t.mint === SOL) continue;
      // A buy spends SOL. Tokens that just arrive (airdropped dust, a transfer from their other wallet) aren't buys.
      if (t.toUserAccount === w && solOut >= 0.005) { ins.run(`${sig}:${w}:${t.mint}:b`, w, walletTier(w)!, "buy", t.mint, t.tokenAmount, solOut, at); n++; }
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

/** Addresses of trusted wallets that bought `mint` in the last `windowMs` (20 Oct: the two-wallet cluster). */
export function trustedBuyerAddrs(mint: string, windowMs: number, now = Date.now()): string[] {
  return (db.prepare("SELECT DISTINCT wallet FROM wallet_events WHERE side='buy' AND tier='trusted' AND mint=? AND at >= ?").all(mint, now - windowMs) as { wallet: string }[]).map(r => r.wallet);
}

/** Did any watched wallet sell `mint` since `sinceMs`? Used to mirror exits. */
export function soldSince(mint: string, sinceMs: number, wallets: string[]): boolean {
  if (!wallets.length) return false;
  const q = wallets.map(() => "?").join(",");
  return !!db.prepare(`SELECT 1 FROM wallet_events WHERE side='sell' AND mint=? AND at >= ? AND wallet IN (${q})`).get(mint, sinceMs, ...wallets);
}

/**
 * Trusted-wallet sells of `mint` since `sinceMs`, one row per wallet: tokens sold, how many sell events, latest time.
 * `n` changes whenever a new sell lands, so callers can re-check a wallet's bag only then.
 */
export interface WalletSellRow { wallet: string; name: string; sold: number; n: number; lastAt: number }
export function trustedSellsSince(mint: string, sinceMs: number): WalletSellRow[] {
  const rows = db.prepare(`SELECT wallet, sum(amount) AS sold, count(*) AS n, max(at) AS lastAt FROM wallet_events
    WHERE side='sell' AND tier='trusted' AND mint=? AND at >= ? GROUP BY wallet`).all(mint, sinceMs) as any[];
  return rows.filter(r => config.trustedWallets.includes(r.wallet)).map(r => ({ ...r, name: walletName(r.wallet) }));
}

/** What our own records say a wallet held of `mint` at `atMs`: recorded buys minus recorded sells before then. */
export function recordedBag(wallet: string, mint: string, atMs: number): number {
  const r = db.prepare(`SELECT coalesce(sum(CASE WHEN side='buy' THEN amount ELSE -amount END), 0) AS bag FROM wallet_events
    WHERE wallet=? AND mint=? AND at < ?`).get(wallet, mint, atMs) as { bag: number };
  return r.bag;
}

/** Make sure a Helius webhook exists for our address list and points at our API. Idempotent. */
export async function ensureWebhook(publicUrl: string) {
  if (!config.keys.helius) { log.warn("no helius key, wallet webhook disabled"); return; }
  const addresses = [...new Set([...config.trustedWallets, ...currentKols().map(k => k.address)])];
  const want = { webhookURL: `${publicUrl}/api/wallet-events`, transactionTypes: ["ANY"], accountAddresses: addresses, webhookType: "enhanced", authHeader: `Bearer ${process.env.DASHBOARD_TOKEN ?? ""}` };
  const base = `https://api.helius.xyz/v0/webhooks?api-key=${config.keys.helius}`;
  try {
    const list = await (await fetch(base, { signal: AbortSignal.timeout(10_000) })).json() as any[];
    const mine = (list ?? []).find(w => w.webhookURL === want.webhookURL);
    if (mine) {
      // 20 Oct: the webhook took only "SWAP" transactions, and pump.fun curve buys aren't labelled that, so trusted mode
      // never saw COUP (Sapphy + hexi, Blossom +$7.37) or any of the ~60 overnight buys Blossom saw. Now "ANY".
      const same = JSON.stringify([...mine.accountAddresses].sort()) === JSON.stringify([...addresses].sort())
        && JSON.stringify(mine.transactionTypes ?? []) === JSON.stringify(want.transactionTypes);
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

/**
 * Daily KOL rotation.
 *   pool  = KOLscan 30-day board: positive P&L, >= 10 scored tokens, >= 50% green, not a known bot
 *   keep  = any current KOL whose record with us is good (>= 8 buys, >= 30% hit 2x in 6h, <= 35% halved)
 *   drop  = any current KOL with >= 8 buys and < 15% hit 2x, or > 40% halved
 *   fill  = back to 6 from the pool, best green ratio first
 * Trusted wallets are never touched. The Helius webhook is updated when the bench changes.
 */
export async function rotateKols(publicUrl: string) {
  const last = kv.get<number>("kols:rotatedAt", 0);
  if (Date.now() - last < 24 * 3_600_000) return;
  kv.set("kols:rotatedAt", Date.now());

  let pool: { name: string; address: string; green: number; red: number; pnl: number }[] = [];
  try {
    const html = await (await fetch("https://kolscan.io/leaderboard?timeframe=30", { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "Mozilla/5.0" } })).text();
    // Split by account links; within each chunk read the name, the green/red pair and the SOL figure from the text.
    const parts = html.split(/href="\/account\//).slice(1);
    for (const part of parts) {
      const address = part.match(/^([1-9A-HJ-NP-Za-km-z]{32,44})/)?.[1];
      if (!address) continue;
      const chunk = part.slice(0, 4000);
      const text = chunk.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const name = (chunk.match(/>\s*([^<>]{1,40}?)\s*</)?.[1] ?? "").trim() || address.slice(0, 6);
      const pair = text.match(/(\d+)\s*\/\s*(\d+)/);
      const pnl = text.match(/([+-]\s?\d+(?:\.\d+)?)\s*Sol/i);
      if (!pair || !pnl) continue;
      if (KNOWN_BOTS.has(address) || config.trustedWallets.includes(address)) continue;
      if (pool.some(x => x.address === address)) continue;
      pool.push({ name, address, green: Number(pair[1]), red: Number(pair[2]), pnl: Number(pnl[1].replace(/\s/, "")) });
    }
  } catch (e) { log.warn({ err: String(e) }, "kolscan fetch failed, rotation skipped"); return; }
  pool = pool.filter(p => p.pnl > 0 && p.green + p.red >= 10 && p.green / (p.green + p.red) >= 0.5)
    .sort((a, b) => b.green / (b.green + b.red) - a.green / (a.green + a.red) || b.pnl - a.pnl);
  if (!pool.length) { log.warn("kolscan parse found no qualifying wallets, keeping bench"); return; }

  const bench = currentKols();
  const card = new Map(scorecard(7).map(c => [c.name, c]));
  const keep: typeof bench = [], dropped: string[] = [];
  for (const k of bench) {
    const c = card.get(k.name);
    if (c && c.n >= 8 && (c.up2x / c.n < 0.15 || c.down50 / c.n > 0.40)) { dropped.push(k.name); continue; }
    keep.push(k);
  }
  const names = kv.get<Record<string, string>>("kols:names", {});
  for (const k of bench) names[k.address] = k.name;
  for (const p of pool) { if (keep.length >= 6) break; if (!keep.some(k => k.address === p.address)) keep.push({ name: p.name, address: p.address }); }
  kv.set("kols:names", names);
  const changed = JSON.stringify(keep.map(k => k.address).sort()) !== JSON.stringify(bench.map(k => k.address).sort());
  kv.set("kols:bench", keep);
  log.info({ bench: keep.map(k => k.name), dropped, poolSize: pool.length }, changed ? "kol bench rotated" : "kol bench unchanged");
  if (changed) await ensureWebhook(publicUrl);
}
