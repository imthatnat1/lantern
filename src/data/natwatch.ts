/**
 * Nat's watch list from the dashboard (19 Oct): "if I saw something that caught my eye I could pin it or something so
 * it gets looked at". Tap Watch on the Launch radar and Lantern checks that coin every scan, first in line, for 3 days.
 * Every rug, honeypot and bot check still applies. Like the hand-picked watch list in config, it skips the
 * socials rule (her eye stands in for the links) and never burns a name.
 */
import { kv } from "../db.js";

export interface NatWatch { mint: string; symbol: string; at: number }
const KEY = "natWatch", TTL = 72 * 3_600_000, MAX = 20;

export function natWatchList(now = Date.now()): NatWatch[] {
  return kv.get<NatWatch[]>(KEY, []).filter(w => now - w.at < TTL);
}
export function natWatchMints(now = Date.now()): string[] { return natWatchList(now).map(w => w.mint); }
export function isNatWatched(mint: string, now = Date.now()): boolean { return natWatchList(now).some(w => w.mint === mint); }

/** Add (or refresh) or remove a coin. Newest first, at most 20. */
export function setNatWatch(mint: string, symbol: string, on: boolean, now = Date.now()): NatWatch[] {
  const list = natWatchList(now).filter(w => w.mint !== mint);
  if (on) list.unshift({ mint, symbol: symbol.slice(0, 24), at: now });
  kv.set(KEY, list.slice(0, MAX));
  return natWatchList(now);
}
