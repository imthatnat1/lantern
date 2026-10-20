import { config, type ModeCfg } from "../config.js";
import { log } from "../log.js";
import type { ExitPlan, Signal, TokenSnapshot } from "../types.js";
import { structuralStop } from "../engine/exits.js";
import { atr, lowestLow } from "../data/gecko.js";
import * as helius from "../data/helius.js";
import { ingest, recentBuys as pushedBuys, trustedBuyerAddrs as buyersAddrs } from "../data/wallets.js";
import { kv } from "../db.js";
import { buySellRatio, candles5and15, dex, gate, logLook, holderScore, pairScore, sniperPenalty, holderVelocity, logSignal, prefilter, type Context, type Mkt, type Pattern, type Strategy } from "./base.js";

const C: ModeCfg<"trusted"> = config.modes.trusted;

interface Seen { [sig: string]: number }

/**
 * TRUSTED COPY with a floor. v1 bought RUGRIOT because a trusted wallet did and nothing else
 * was checked. Here a trusted buy is a *candidate*, then: our own score >= 50, mcap <= $150k,
 * no buying into a >40% 5m pump, and the slop filter.
 */
export const trusted: Strategy = {
  name: "trusted",
  everyMs: C.pollEveryMs,
  async scan(ctx: Context): Promise<Signal[]> {
    const out: Signal[] = [];
    const wallets = config.trustedWallets;
    if (!wallets.length) return out;
    const seen = kv.get<Seen>("trusted:seen", {});
    const since = ctx.now - 30 * 60_000;
    // Pushed by the Helius webhook when it's working; poll as a fallback when nothing has arrived in the last hour.
    const pushed = pushedBuys(since, "trusted");
    // The webhook's own delivery time, not "any event in the last hour": polled swaps land in wallet_events too
    // (so the exit loop sees trusted sells), and they must not make a dead webhook look alive.
    const webhookAlive = ctx.now - kv.get("helius:lastPushAt", 0) < 60 * 60_000;
    let buys: { wallet: string; mint: string; signature: string; at: number; solSpent: number }[];
    if (pushed.length || webhookAlive) {
      buys = pushed.map(b => ({ wallet: b.wallet, mint: b.mint, signature: `${b.wallet}:${b.mint}:${b.at}`, at: b.at, solSpent: b.sol }));
    } else {
      // Polling costs 100 credits per wallet per call, so it runs on its own slower clock.
      if (ctx.now - kv.get("trusted:lastPollAt", 0) < C.heliusPollEveryMs) return out;
      kv.set("trusted:lastPollAt", ctx.now);
      buys = (await Promise.all(wallets.map(w => helius.recentBuys(w, ctx.now - C.heliusPollEveryMs - 60_000, C.heliusDailyCredits, ingest)))).flat()
        // Same key as the push path, so a buy seen by the poll is never copied a second time once the webhook is back.
        .map(b => ({ ...b, signature: `${b.wallet}:${b.mint}:${b.at}` }));
    }

    // Group by mint; count distinct wallets within the window.
    const byMint = new Map<string, Set<string>>();   // mint -> wallet addresses
    for (const b of buys) {
      if (seen[b.signature]) continue;
      seen[b.signature] = b.at;
      const s = byMint.get(b.mint) ?? new Set(); s.add(b.wallet); byMint.set(b.mint, s);
    }
    // Prune seen set.
    for (const k of Object.keys(seen)) if (ctx.now - seen[k] > 24 * 3_600_000) delete seen[k];
    kv.set("trusted:seen", seen);
    if (!byMint.size) return out;

    // 20 Oct: count every trusted wallet that bought this coin in the last 30 minutes, not just this scan's. hexi bought
    // COUP and Sapphy followed 20 minutes later; Lantern saw two one-wallet buys, Blossom saw the pair (+$7.37).
    for (const [mint, ws] of byMint) for (const w of buyersAddrs(mint, C.twoWalletWindowMs)) ws.add(w);
    const snaps = await dex.snapshots([...byMint.keys()]);
    for (const [mint, ws] of byMint) {
      const s = snaps.get(mint);
      if (!s) continue;
      try {
        const sig = await check(s, ctx, ws.size, [...ws].map(config.walletName), [...ws]);
        if (sig) out.push(sig);
      } catch (e) { log.debug({ sym: s.symbol, err: String(e) }, "trusted check failed"); }
    }
    return out;
  },
};

/** The copy filter before any I/O: mcap ceiling, no buying into a 5m pump, enough liquidity. */
export function trustedFilter(m: Mkt & { change5m: number; onCurve: boolean }, who: string, C: ModeCfg<"trusted">): Pattern<{}> {
  if (m.mcapUsd > C.mcapMax) return { ok: false, why: `${who}, but mcap $${(m.mcapUsd / 1000).toFixed(0)}k > $150k ceiling (copy latency: we'd buy their exit)` };
  if (m.change5m / 100 > C.maxPump5m) return { ok: false, why: `${who}, but already up ${m.change5m.toFixed(0)}% in 5m` };
  if (m.liquidityUsd < C.minLiquidity && !m.onCurve) return { ok: false, why: `${who}, but liquidity under $10k` };
  return { ok: true };
}

export function trustedPlan(low: number, C: ModeCfg<"trusted">): (entry: number, atr15: number) => ExitPlan {
  return (entry, atr15) => ({
    hardFloorPct: 0.45,
    closeStopPrice: structuralStop(entry, low, atr15, 1, 0.30),
    takeProfits: [{ gain: 1.0, sell: 0.5 }],
    trailPct: 0.30, trailAfterGain: 0.60,
    maxHoldMs: C.backstopMs,
  });
}

async function check(s: TokenSnapshot, ctx: Context, walletCount: number, names: string[] = [], addrs: string[] = []): Promise<Signal | null> {
  const who = `${names.join(" + ") || walletCount + " trusted"} bought`;
  const f = trustedFilter(s, who, C);
  if (!f.ok) { if (f.why) logLook("trusted", s, f.why); return null; }
  const pre = await prefilter(s, "trusted");
  if (!pre.ok) { logLook("trusted", s, pre.why!, pre.holders); return null; }
  const size = walletCount >= 2 ? C.sizeUsdTwoWallets : C.sizeUsd;
  const g = await gate(s, "trusted", size);
  // 21 Oct: these two used to return silently, so a skipped trusted buy never showed on the dashboard.
  if ((g.holders ?? 0) < C.minHolders) { logLook("trusted", s, `${who}, but only ${g.holders ?? "?"} holders (needs ${C.minHolders})`, g.holders); return null; }
  if (s.mcapUsd > C.minHoldersAtMcap.mcap && (g.holders ?? 0) < C.minHoldersAtMcap.holders) {
    logLook("trusted", s, `${who}, but ${g.holders ?? "?"} holders at $${Math.round(s.mcapUsd / 1000)}k (needs ${C.minHoldersAtMcap.holders} above $${C.minHoldersAtMcap.mcap / 1000}k)`, g.holders);
    return null;
  }

  // Our own score. Not fixed at 60 anymore.
  const bs = buySellRatio(s);
  let score = 30;
  score += walletCount >= 2 ? 20 : 10;
  score += bs >= 1.2 && bs <= 5 ? 15 : bs > 8 ? 0 : 5;
  score += (g.holders ?? 0) >= 150 ? 10 : (g.holders ?? 0) >= 50 ? 5 : 0;
  score += (g.top10 ?? 100) > 40 ? -15 : (g.top10 ?? 100) > 25 ? -5 : 5;
  score += s.liquidityUsd >= 25_000 ? 10 : 0;
  score += holderScore(s.mint) + pairScore(s) + sniperPenalty(g);
  // Two or more trusted wallets agreeing is the strongest signal we have: a lower bar (Blossom bought COUP at 42).
  const floor = walletCount >= 2 ? C.minScoreCluster : C.minScore;
  if (score < floor) { logSignal({ mode: "trusted", mint: s.mint, symbol: s.symbol, sizeUsd: size, score, reason: "score floor", snapshot: s, candles15: [], plan: () => null as any }, false, "score below floor"); return null; }

  let c15 = [] as Awaited<ReturnType<typeof candles5and15>>["c15"];
  let a15 = 0; let low = s.priceUsd * 0.8;
  if (s.pairAddress) {
    try { ({ c15 } = await candles5and15(s.pairAddress)); a15 = atr(c15); low = lowestLow(c15, ctx.now - 2 * 3_600_000); } catch { /* curve coins have no pool yet */ }
  }

  const sig: Signal = {
    mode: "trusted", mint: s.mint, symbol: s.symbol, sizeUsd: size, score,
    reason: `trusted copy: ${names.join(" + ") || walletCount + " wallets"} bought`,
    snapshot: s, candles15: c15,
    meta: { atr15: a15, walletCount, wallets: names, walletAddrs: addrs, holders: g.holders },
    plan: trustedPlan(low, C),
  };
  if (!g.ok) { logSignal(sig, false, g.why!); return null; }
  return sig;
}
