/**
 * Main loop watchdog (20 Oct). From 15:19 to ~22:30 the bot priced nothing, scanned nothing and judged no stops
 * for 7 hours while the dashboard API kept answering, so the dashboard looked alive. A hung loop or a silent
 * DexScreener now ends the process and pm2 starts it fresh. Pure, so it's testable.
 */
export interface LoopHealth {
  now: number;
  lastTickDoneAt: number;   // last time the whole tick (exit, scan, missed, holders, mood) finished
  tickStartedAt: number;
  tickStage: string;
  dexLastOk: number;        // last usable DexScreener answer
  upMs: number;             // this process's uptime
}

export const WATCHDOG = {
  tickStuckMs: 20 * 60_000,   // a scan can be slow (GeckoTerminal is rate limited), never 20 minutes
  dexSilentMs: 30 * 60_000,   // normally seconds; open positions are priced every tick
  graceMs: 30 * 60_000,       // after a restart, give it 30 min before restarting again for a silent DexScreener
};

/** Why the bot should restart now, or null. */
export function watchdogWhy(h: LoopHealth, w = WATCHDOG): string | null {
  const sinceTick = h.now - h.lastTickDoneAt;
  if (sinceTick > w.tickStuckMs) return `main loop hasn't finished a pass in ${Math.round(sinceTick / 60_000)} min (stuck in ${h.tickStage})`;
  const silent = h.now - h.dexLastOk;
  if (silent > w.dexSilentMs && h.upMs > w.graceMs) return `no DexScreener price for ${Math.round(silent / 60_000)} min`;
  return null;
}
