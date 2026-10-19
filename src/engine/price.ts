import { config } from "../config.js";
import { audit } from "../db.js";
import { log } from "../log.js";
import * as dex from "../data/dexscreener.js";
import * as jup from "../data/jupiter.js";

export interface PriceRead {
  price: number;
  at: number;
  confirmed: boolean;   // safe to fill a stop on
  source: string;
  note?: string;
}

/** Injectable so tests and replay can feed prices without hitting the network. */
export interface PriceSources {
  primary(mint: string): Promise<number | null>;
  secondary(mint: string): Promise<number | null>;
}

export const liveSources: PriceSources = {
  primary: async (mint) => (await dex.snapshot(mint))?.priceUsd ?? null,
  secondary: (mint) => jup.price(mint),
};

interface Pending { price: number; at: number }
const pending = new Map<string, Pending>();

/**
 * The rule:
 *   - A tick within `sanityJumpPct` of the last good price is accepted as-is.
 *   - A bigger jump is "unconfirmed" until either
 *       (a) the second source agrees within `sanityAgreePct`, or
 *       (b) the next primary tick (>= 5s later) lands within `sanityAgreePct` of it.
 *   - Unconfirmed prices still update peak tracking downward-safe (never raise the peak)
 *     and never trigger a stop fill.
 *
 * Real rugs confirm on the next tick within seconds. Junk ticks never do.
 */
export async function readPrice(
  mint: string,
  lastGood: number,
  sources: PriceSources = liveSources,
  now = Date.now(),
): Promise<PriceRead | null> {
  const p = await sources.primary(mint);
  if (!p || !Number.isFinite(p) || p <= 0) return null;

  const jump = lastGood > 0 ? Math.abs(p - lastGood) / lastGood : 0;
  if (jump <= config.risk.sanityJumpPct) {
    pending.delete(mint);
    return { price: p, at: now, confirmed: true, source: "primary" };
  }

  // Big move. Try the second source first.
  const s = await sources.secondary(mint);
  if (s && Math.abs(s - p) / p <= config.risk.sanityAgreePct) {
    pending.delete(mint);
    log.info({ mint, p, s, lastGood }, "big move confirmed by second source");
    return { price: p, at: now, confirmed: true, source: "primary+secondary" };
  }

  // A 5x+ rise in one read can only be confirmed by the second source. Next-tick agreement isn't enough: a wrong pool
  // agrees with itself every tick (ALLINU, 19 Oct). Big drops keep the next-tick fallback so a rug can still be exited.
  if (lastGood > 0 && p / lastGood >= 5) {
    const note = s ? `secondary ${s} disagrees with a ${Math.round(p / lastGood)}x jump` : `no secondary for a ${Math.round(p / lastGood)}x jump`;
    audit.rejectedTick(mint, "primary", p, lastGood, note);
    log.warn({ mint, p, lastGood, note }, "extreme price jump, holding");
    return { price: p, at: now, confirmed: false, source: "primary", note };
  }

  // Jupiter has a price and disagrees: never confirm. 20 Oct: Dacity was "sold" at $0.0000029 while Jupiter said $0.0068
  // (and every pool $0.007). The bad tick repeated, so next-tick agreement confirmed it. Only fall back to the next
  // tick when Jupiter has no price at all (a fresh coin it doesn't price yet, or a pool that's gone).
  if (s) {
    const note = `secondary ${s} disagrees`;
    audit.rejectedTick(mint, "primary", p, lastGood, note);
    log.warn({ mint, p, lastGood, s }, "price disagrees with Jupiter, holding");
    return { price: p, at: now, confirmed: false, source: "primary", note };
  }

  // No second source. Fall back to next-tick confirmation.
  const prev = pending.get(mint);
  if (prev && now - prev.at >= 5000 && Math.abs(prev.price - p) / p <= config.risk.sanityAgreePct) {
    pending.delete(mint);
    log.info({ mint, p, prev: prev.price, lastGood }, "big move confirmed by next tick");
    return { price: p, at: now, confirmed: true, source: "primary x2" };
  }

  if (!prev || Math.abs(prev.price - p) / p > config.risk.sanityAgreePct) pending.set(mint, { price: p, at: now });

  const note = s ? `secondary ${s} disagrees` : "no secondary";
  audit.rejectedTick(mint, "primary", p, lastGood, note);
  log.warn({ mint, p, lastGood, jumpPct: (jump * 100).toFixed(0), note }, "unconfirmed price tick, holding");
  return { price: p, at: now, confirmed: false, source: "primary", note };
}

/** For tests. */
export function _resetPending() { pending.clear(); }
