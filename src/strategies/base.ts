import type { Candle, Signal, TokenSnapshot } from "../types.js";
import * as dex from "../data/dexscreener.js";
import * as gecko from "../data/gecko.js";
import * as rug from "../data/rugcheck.js";
import * as jup from "../data/jupiter.js";
import { config } from "../config.js";
import { isCopycat, isSlop } from "../engine/filters.js";
import { db, cooldowns, audit, market, recorder, hot, type Setup } from "../db.js";
import { isCreativePair } from "../data/universe.js";
import { isStonkListed } from "../data/stonkfun.js";
import { buyersOf } from "../data/wallets.js";
import { blockedWhy, blockMint, divergence, flow, microTrades } from "../data/flow.js";

export interface Context {
  now: number;
  solPrice: number;
  migrations: Map<string, number>;   // mint -> migratedAt
}

export interface Strategy {
  name: Signal["mode"];
  everyMs: number;
  scan(ctx: Context): Promise<Signal[]>;
}

/**
 * A mode's candle logic, kept free of I/O so the live bot and the replay run the same code.
 * Not ok with no `why` means "skip silently"; with a `why` it becomes a look on the dashboard.
 */
export type Pattern<T> = { ok: false; why?: string; setup?: Setup } | ({ ok: true } & T);

/** The market fields the patterns read. Live: a DexScreener snapshot. Replay: recorded ticks and candles. */
export interface Mkt {
  priceUsd: number; buys5m: number; sells5m: number; liquidityUsd: number; mcapUsd: number;
  change1h: number; change6h: number; change24h: number; volume24h: number;
}

export interface Gate { ok: boolean; why?: string; holders?: number; top10?: number; sniperPct?: number }
/** Score penalty for sniper/bundle concentration: -1 per percent, max -20. */
/** Add up a score from named parts and keep the parts, so the dashboard can show why it scored what it did. Zero parts are dropped. */
export function scored(parts: Record<string, number>): { score: number; scoreParts: Record<string, number> } {
  const scoreParts: Record<string, number> = {};
  let score = 0;
  for (const [k, v] of Object.entries(parts)) { score += v; if (v) scoreParts[k] = v; }
  return { score, scoreParts };
}

export function sniperPenalty(g: Gate): number { return -Math.min(20, Math.round(g.sniperPct ?? 0)); }

/**
 * Cheap rug guard, run BEFORE any candle fetch or pattern check. A coin that fails here never
 * appears on the hot list and never costs us a GeckoTerminal call.
 *   copycat ticker / brand clone, missing mcap or liquidity, RugCheck (mint/freeze authority, rugged,
 *   danger flags, transfer fee, LP lock, creator history, creator balance, insiders, top-10),
 *   slop (cheap domain, social-as-website, thin holders at size), fresh-coin rules (< 2h old needs
 *   150+ holders and top-10 under 35%), honeypot smell (20+ buys and zero sells in 5m).
 */
export async function prefilter(s: TokenSnapshot, mode: Signal["mode"]): Promise<Gate> {
  const pinned = config.pinned.includes(s.mint);
  // Stonk.fun coins are themed on stocks and brands (xStocks, OPENAI, SPCX pairs). That's the platform, not a copy,
  // so coins Stonk.fun itself lists skip the name check. Every rug check below still applies.
  const cc = pinned || isStonkListed(s.mint) ? null : isCopycat(s);
  if (cc) return { ok: false, why: `rejected: copycat ${cc}` };
  if (!pinned && (!s.mcapUsd || s.mcapUsd <= 0)) return { ok: false, why: "rejected: no market cap reported" };
  if (!s.onCurve && s.liquidityUsd <= 0) return { ok: false, why: "rejected: no liquidity reported" };
  // KKK, $CAT, PANIC (18 Oct): market caps of $11-21 and a few dollars of volume. Nothing to trade.
  if (!pinned && s.mcapUsd < 3_000) return { ok: false, why: `rejected: no real market, $${Math.round(s.mcapUsd)} market cap` };
  if (cooldowns.active(mode, s.mint)) return { ok: false, why: "cooldown after a recent stop-out" };
  if (!pinned) {
    const b = blockedWhy(s.mint);
    if (b) return { ok: false, why: `rejected: ${b}` };
    const d = divergence(s) ?? microTrades(s);
    if (d) { blockMint(s.mint, d); return { ok: false, why: `rejected: ${d}` }; }
  }
  const safe = await rug.safety(s.mint, s.onCurve);
  if (!safe.ok) return { ok: false, why: `rejected: ${safe.reasons.join(", ")}` };
  const slop = pinned ? null : isSlop(s, safe.holders);
  if (slop) return { ok: false, why: `rejected: slop, ${slop}` };
  const ageH = (Date.now() - s.createdAt) / 3_600_000;
  if (!pinned && ageH < 2) {
    if ((safe.holders ?? 0) < 150) return { ok: false, why: `rejected: ${ageH.toFixed(1)}h old with only ${safe.holders ?? "?"} holders` };
    if ((safe.top10Pct ?? 0) > 35) return { ok: false, why: `rejected: fresh coin, top 10 hold ${safe.top10Pct!.toFixed(0)}%` };
  }
  if (s.buys5m >= 20 && s.sells5m === 0) return { ok: false, why: "rejected: buys but no sells in 5m, possible honeypot" };
  // Vertical launches: a coin that went 5x in an hour (or 20x in six) while still under 6h old is a pump, not a setup,
  // unless it has already spread to a real holder base.
  if (!pinned && ageH < 6 && (s.change1h > 500 || s.change6h > 2000)) {
    const wide = (safe.holders ?? 0) >= 1000 && (safe.top10Pct ?? 100) < 25;
    if (!wide) return { ok: false, why: `rejected: vertical launch, +${Math.round(Math.max(s.change1h, s.change6h))}% at ${ageH.toFixed(1)}h old` };
  }
  try {
    hot.clean(mode, s.mint, s.symbol, s.priceUsd);
    // Keep the hot list's market numbers (1h change, volume, labels) fresh; at most once a minute per coin.
    if (Date.now() - (lastMkt.get(s.mint) ?? 0) > 60_000) { lastMkt.set(s.mint, Date.now()); market.upsert(s, safe.holders, [...velocityLabel(s.mint), ...walletLabels(s.mint)]); }
  } catch { /* best effort */ }
  return { ok: true, holders: safe.holders, top10: safe.top10Pct };
}

/** Shared pre-entry gate: copycat, safety, slop, exit liquidity, test sell. */
export async function gate(s: TokenSnapshot, mode: Signal["mode"], sizeUsd: number): Promise<Gate> {
  const pre = await prefilter(s, mode);
  if (!pre.ok) return pre;
  if (!s.onCurve) {
    const qty = sizeUsd / s.priceUsd;
    const ts = await jup.testSell(s.mint, qty);
    if (!ts.routable) return { ok: false, why: "no sell route" };
    if (ts.impactPct > config.fees.exitImpactWarnPct) return { ok: false, why: `exit impact ${(ts.impactPct * 100).toFixed(1)}%` };
    // Is the buying real? Bot micro-buys inflate buy counts and volume (Minter, 18 Oct).
    const pinned = config.pinned.includes(s.mint);
    if (!pinned) {
      const d = divergence(s);
      if (d) return { ok: false, why: `rejected: ${d}`, holders: pre.holders };
      if (s.pairAddress) {
        const fl = await flow(s.mint, s.pairAddress);
        if (fl?.verdict) return { ok: false, why: `rejected: ${fl.verdict}`, holders: pre.holders };
      }
    }
  }
  return { ok: true, holders: pre.holders, top10: pre.top10, sniperPct: pre.sniperPct };
}

/** Wallet flow in the last hour: +10 per trusted wallet, +5 per KOL (max +15). Every mode. */
export function walletScore(mint: string): number {
  const t = buyersOf(mint, 60 * 60_000, "trusted").length;
  const k = buyersOf(mint, 60 * 60_000, "kol").length;
  return t * 10 + Math.min(15, k * 5);
}
export function walletLabels(mint: string): string[] {
  const t = buyersOf(mint, 60 * 60_000, "trusted"), k = buyersOf(mint, 60 * 60_000, "kol");
  const out: string[] = [];
  if (t.length) out.push(`${t.join(" + ")} bought`);
  if (k.length) out.push(`KOL: ${k.join(", ")}`);
  return out;
}

/** Creative pair (paired with something other than SOL/USDC/USDT): +8 in every mode. */
export function pairScore(s: TokenSnapshot): number { return isCreativePair(s) ? 8 : 0; }

/** Holder growth over the last 10 minutes as a fraction, or null if unknown. */
export function holderVelocity(mint: string): number | null {
  try { return recorder.holderVelocity(mint, 10 * 60_000); } catch { return null; }
}

/** Score points for holder growth: +20 at >=25%/10m, +10 at >=10%, -10 if shrinking >5%. */
export function holderScore(mint: string): number {
  const v = holderVelocity(mint);
  if (v == null) return 0;
  if (v >= 0.25) return 20;
  if (v >= 0.10) return 10;
  if (v <= -0.05) return -10;
  return 0;
}

function velocityLabel(mint: string): string[] {
  const v = holderVelocity(mint);
  if (v == null || Math.abs(v) < 0.03) return [];
  return [`holders ${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}% / 10m`];
}

export function logSignal(sig: Signal, taken: boolean, why: string) {
  audit.signal(sig.mode, sig.mint, sig.symbol, sig.score, taken, why, sig.snapshot.priceUsd, sig.snapshot.mcapUsd, sig.snapshot.liquidityUsd, undefined, sig.snapshot.pairAddress);
  const labels: string[] = [...velocityLabel(sig.mint), ...walletLabels(sig.mint)];
  if (!labels.some(l => /bought/.test(l)) && sig.meta?.wallets && (sig.meta.wallets as string[]).length) labels.push(`${(sig.meta.wallets as string[]).join(" + ")} bought`);
  market.upsert(sig.snapshot, sig.meta?.holders as number | undefined, labels);
}

/** Record a look that never became a signal (filtered before scoring). Shows up in "looked at but did not buy". */
/**
 * Coins this mode logged a forming setup for in the last 3h, newest first. Scans put these first, so a
 * setup isn't dropped half way because newer coins out-traded it on 1h volume (Chaton, 18 Oct: setup at
 * 11:36, never re-checked, price went through the trigger unseen).
 */
export function watchedMints(mode: Signal["mode"], now = Date.now(), max = 10): string[] {
  const setups = (db.prepare(`SELECT mint, max(at) AS t FROM signals_log WHERE mode=? AND taken=0 AND setup IS NOT NULL AND at > ?
    GROUP BY mint ORDER BY t DESC LIMIT ?`).all(mode, now - 3 * 3_600_000, max) as { mint: string }[]).map(r => r.mint);
  // Then the hot list: coins that passed safety for this mode in the last 30 min and weren't rejected since,
  // so a coin "on its way" is re-checked every scan and gets bid the moment it meets the criteria.
  const onWay = (db.prepare(`SELECT mint FROM clean_seen WHERE mode=? AND at > ? AND (status IS NULL OR (status NOT LIKE 'rejected%'
      AND status NOT LIKE '%dead%' AND status NOT LIKE 'cooldown%' AND status NOT LIKE 'no sell route%'
      AND status NOT LIKE '%deeper than%' AND status NOT LIKE '%too deep%' AND status NOT LIKE 'too thin%'))
    ORDER BY at DESC LIMIT ?`).all(mode, now - 30 * 60_000, max) as { mint: string }[]).map(r => r.mint);
  return [...new Set([...setups, ...onWay])].slice(0, max);
}

/** Watched coins first (up to two thirds of the cap), then the rest by the mode's own ranking. */
export function watchedFirst(watched: string[], snaps: TokenSnapshot[], cap: number, rank: (a: TokenSnapshot, b: TokenSnapshot) => number): TokenSnapshot[] {
  const w = new Set(watched);
  const first = snaps.filter(s => w.has(s.mint)).sort((a, b) => watched.indexOf(a.mint) - watched.indexOf(b.mint)).slice(0, Math.ceil(cap * 2 / 3));
  const taken = new Set(first.map(s => s.mint));
  return [...first, ...snaps.filter(s => !taken.has(s.mint)).sort(rank)].slice(0, cap);
}

const lastLook = new Map<string, number>();
const lastMkt = new Map<string, number>();
export function logLook(mode: Signal["mode"], s: TokenSnapshot, why: string, holders?: number, setup?: Setup) {
  try { hot.status(mode, s.mint, why); } catch { /* best effort */ }
  const k = `${mode}:${s.mint}`;
  const gap = setup ? 10 * 60_000 : 60 * 60_000;   // setups refresh every 10 min so the distance bar moves; rejections hourly
  if (Date.now() - (lastLook.get(k) ?? 0) < gap) return;
  lastLook.set(k, Date.now());
  audit.signal(mode, s.mint, s.symbol, 0, false, why, s.priceUsd, s.mcapUsd, s.liquidityUsd, setup, s.pairAddress);
  market.upsert(s, holders, [...velocityLabel(s.mint), ...walletLabels(s.mint)]);
}

/** Distance helper: how far price must move to reach `level`, as a positive fraction. */
export function dist(price: number, level: number): number { return Math.abs(level - price) / price; }

/**
 * One GeckoTerminal call per coin, not two: 180 five-minute candles (15h), with the 15m candles rolled up from
 * them. GeckoTerminal allows ~30 calls a minute per server (we keep to 15, Blossom shares the IP); with two calls
 * per check the scans asked for far more, the host kept "cooling", and checks failed (18 Oct: every flagship
 * dip check failed with "cooling api.geckoterminal.com").
 */
export async function candles5and15(pair: string): Promise<{ c5: Candle[]; c15: Candle[] }> {
  const all5 = await gecko.candles(pair, 5, 180);
  const c15 = gecko.rollUp(all5).slice(-60);
  try { if (c15.length) recorder.candles(pair, 15, c15); } catch { /* best effort, the lab reads these */ }
  return { c5: all5.slice(-100), c15 };
}

export function buySellRatio(s: Pick<Mkt, "buys5m" | "sells5m">): number {
  return s.sells5m > 0 ? s.buys5m / s.sells5m : s.buys5m > 0 ? 99 : 0;
}

/** True if the last `n` closed 5m candles all have lows within tol of `low`. */
export function baseHolds(c5: Candle[], low: number, n: number, tol = 0.05): boolean {
  const last = c5.slice(-n - 1, -1);   // exclude the forming candle
  return last.length === n && last.every(k => k.l >= low * (1 - tol));
}

/** How many of the last n closed 5m candles have held above `low`, counting back from the most recent. */
export function heldCount(c5: Candle[], low: number, tol = 0.05): number {
  let n = 0;
  for (let i = c5.length - 2; i >= 0 && n < 10; i--) { if (c5[i].l >= low * (1 - tol)) n++; else break; }
  return n;
}

/** Green close above `level` on volume >= x times the average of the previous n candles. */
export function reclaim(c5: Candle[], level: number, volX: number, n = 6): boolean {
  if (c5.length < n + 2) return false;
  const k = c5.at(-2)!;                       // last CLOSED 5m candle
  const prev = c5.slice(-2 - n, -2);
  const avgV = prev.reduce((a, b) => a + b.v, 0) / prev.length;
  return k.c > k.o && k.c > level && avgV > 0 && k.v >= avgV * volX;
}

export { dex, gecko };
