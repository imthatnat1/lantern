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
  lastExitDoneAt?: number;  // the exit loop (stops), on its own clock since 21 Oct
  exitStage?: string;
  scansInFlight?: { name: string; since: number }[];   // strategy scans still running (timed out ones included)
}

export const WATCHDOG = {
  tickStuckMs: 20 * 60_000,   // a scan can be slow (GeckoTerminal is rate limited), never 20 minutes
  dexSilentMs: 30 * 60_000,   // normally seconds; open positions are priced every tick
  graceMs: 30 * 60_000,       // after a restart, give it 30 min before restarting again for a silent DexScreener
  exitStuckMs: 5 * 60_000,    // stops are judged every 5s; 5 minutes without a finished pass is broken
  scanHungMs: 30 * 60_000,    // a scan is cut loose after 4 min; still not back after 30 is a hang
};

/** Why the bot should restart now, or null. */
export function watchdogWhy(h: LoopHealth, w = WATCHDOG): string | null {
  if (h.lastExitDoneAt !== undefined && h.now - h.lastExitDoneAt > w.exitStuckMs)
    return `stop checks haven't finished a pass in ${Math.round((h.now - h.lastExitDoneAt) / 60_000)} min (stuck in ${h.exitStage ?? "exit"})`;
  const hung = (h.scansInFlight ?? []).find(s => h.now - s.since > w.scanHungMs);
  if (hung) return `${hung.name} scan never came back (${Math.round((h.now - hung.since) / 60_000)} min)`;
  const sinceTick = h.now - h.lastTickDoneAt;
  if (sinceTick > w.tickStuckMs) return `main loop hasn't finished a pass in ${Math.round(sinceTick / 60_000)} min (stuck in ${h.tickStage})`;
  const silent = h.now - h.dexLastOk;
  if (silent > w.dexSilentMs && h.upMs > w.graceMs) return `no DexScreener price for ${Math.round(silent / 60_000)} min`;
  return null;
}
