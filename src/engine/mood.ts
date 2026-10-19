/**
 * Market mood (19 Oct). Nat: "it allows us to take more risk in green markets and not spend time catching knives in
 * a bad market". Nobody can call the bottom, but a turn shows up in the data, so the bot reads it every 10 minutes and
 * sizes its bets by it: half size when the market is fearful, normal when neutral, 1.5x when it's green.
 *
 * Five readings, each scored 0 to 1 (a reading we couldn't get is left out and the rest are re-weighted):
 *   flagships6h  share of the flagships (pinned + Stonk.fun's biggest) up over 6 hours            weight 30
 *   flagships1h  share of them up over the last hour                                                weight 15
 *   sol          SOL's 24h and 6h moves, -8%..+8% and -4%..+4% mapped onto 0..1                     weight 25
 *   launches     pump.fun migrations in the last hour against the 12h hourly average, 0.5x..1.5x    weight 15
 *   followThru   share of the last 3 hours' migrations (real pools) that are up over the hour       weight 15
 */
import { db, kv } from "../db.js";

export type MoodLevel = "fearful" | "neutral" | "green";
export interface MoodInputs {
  flagships6h: number | null; flagships1h: number | null;
  sol24h: number | null; sol6h: number | null;
  launchesRatio: number | null; followThru: number | null;
}
export interface Mood { at: number; score: number; raw: number; level: MoodLevel; sizeX: number; parts: Record<string, number | null>; inputs: MoodInputs }

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const span = (x: number, lo: number, hi: number) => clamp01((x - lo) / (hi - lo));

export const MOOD_SIZE: Record<MoodLevel, number> = { fearful: 0.5, neutral: 1, green: 1.5 };
/** Modes whose bet size follows the mood. Trusted copies and Nat's picks keep their own size. */
export const MOOD_MODES = new Set(["launch", "dip", "ultra", "pullback", "bounce", "ride"]);

export function levelOf(score: number): MoodLevel { return score < 35 ? "fearful" : score > 60 ? "green" : "neutral"; }

/** Pure: readings in, a 0-100 score out. `prev` smooths it (the last score counts for half) so one reading can't flip it. */
export function moodScore(inp: MoodInputs, prev?: number, now = Date.now()): Mood {
  const solParts = [inp.sol24h != null ? span(inp.sol24h, -8, 8) : null, inp.sol6h != null ? span(inp.sol6h, -4, 4) : null].filter((x): x is number => x != null);
  const parts: Record<string, number | null> = {
    flagships6h: inp.flagships6h,
    flagships1h: inp.flagships1h,
    sol: solParts.length ? solParts.reduce((a, b) => a + b, 0) / solParts.length : null,
    launches: inp.launchesRatio != null ? span(inp.launchesRatio, 0.5, 1.5) : null,
    followThru: inp.followThru,
  };
  const W: Record<string, number> = { flagships6h: 30, flagships1h: 15, sol: 25, launches: 15, followThru: 15 };
  let sum = 0, w = 0;
  for (const [k, v] of Object.entries(parts)) if (v != null) { sum += v * W[k]; w += W[k]; }
  const raw = w ? (sum / w) * 100 : 50;
  const score = prev != null ? (raw + prev) / 2 : raw;
  const level = levelOf(score);
  return { at: now, score: Math.round(score), raw: Math.round(raw), level, sizeX: MOOD_SIZE[level], parts, inputs: inp };
}

db.exec(`CREATE TABLE IF NOT EXISTS mood_history (at INTEGER PRIMARY KEY, score REAL, level TEXT, inputs TEXT)`);

export function saveMood(m: Mood) {
  kv.set("mood", m);
  db.prepare("INSERT OR REPLACE INTO mood_history(at, score, level, inputs) VALUES(?,?,?,?)").run(m.at, m.score, m.level, JSON.stringify(m.inputs));
  db.prepare("DELETE FROM mood_history WHERE at < ?").run(m.at - 30 * 86_400_000);
}

export function currentMood(): Mood | null { return kv.get<Mood | null>("mood", null); }

/** Size multiplier for a new bet in this mode. 1 when there's no reading yet or it's over 30 minutes old. */
export function moodSizeX(mode: string, now = Date.now()): number {
  const m = currentMood();
  if (!m || !MOOD_MODES.has(mode) || now - m.at > 30 * 60_000) return 1;
  return m.sizeX;
}

export function moodHistory(sinceMs: number): { at: number; score: number; level: string }[] {
  return db.prepare("SELECT at, score, level FROM mood_history WHERE at > ? ORDER BY at").all(sinceMs) as any[];
}
