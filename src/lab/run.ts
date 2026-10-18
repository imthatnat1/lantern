/**
 * Run the experiments in experiments.json against recorded history.
 *
 *   npm run lab                      # every experiment, last N hours (from the file, default 72)
 *   npm run lab -- --hours 24        # different window
 *   npm run lab -- --json            # machine-readable report (what the bot stores for the dashboard)
 *   npm run lab -- --only "Ride"     # experiments whose name contains "Ride"
 *
 * The bot runs this in a child process every 6 hours and after each new build, and the dashboard's
 * Lab tab shows the latest report. Editing experiments.json and pushing is how new tests get queued.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { db } from "../db.js";
import { config } from "../config.js";
import { Lab, modesFor, summarize, type Experiment, type LabTrade, type ModeSummary } from "./entries.js";
import type { Mode } from "../types.js";

export interface ExperimentResult {
  name: string; why?: string; modes: Mode[];
  /** Tests a safety-gate rule; those need recorded gate results, which start 18 Oct. */
  gate?: boolean;
  result: Partial<Record<Mode, ModeSummary>>;
  baseline: Partial<Record<Mode, ModeSummary>>;
  totals: { trades: number; wins: number; pnl: number; baseTrades: number; baseWins: number; basePnl: number };
  /** Trades this experiment took that the live rules didn't, and the other way round. */
  added: LabTrade[]; dropped: LabTrade[];
  error?: string;
}

/** How well the replay of the live rules matches what the live bot actually did in the same window. */
export interface LiveCheck {
  /** When recorded data actually starts; can be later than `from`. */
  dataFrom: number;
  live: Partial<Record<Mode, { trades: number; wins: number; pnl: number; open: number }>>;
  /** Live trades the replay also took (same coin and mode, within 30 minutes). */
  matched: number; liveTrades: number;
  missedByReplay: { mode: Mode; symbol: string; at: number; pnl: number | null }[];
  /** Replay trades the real bot didn't take, with what the real bot logged about that coin at the time. */
  extraByReplay: { mode: Mode; symbol: string; at: number; pnl: number; liveSaid: string }[];
  /** Baseline split by whether the entry saw real candles or ones rebuilt from ticks. */
  byCandles: { real: { trades: number; wins: number; pnl: number }; rebuilt: { trades: number; wins: number; pnl: number } };
}

export interface LabReport {
  /** Modes switched off in the live bot. The lab still replays them, but they don't count in the trust check. */
  paused?: string[];
  ranAt: number; from: number; to: number; hours: number; coins: number; secs: number;
  baseline: { summary: Partial<Record<Mode, ModeSummary>>; trades: LabTrade[] };
  check?: LiveCheck;
  experiments: ExperimentResult[];
}

const here = dirname(fileURLToPath(import.meta.url));
export function loadExperiments(): { hours: number; experiments: Experiment[] } {
  for (const p of [join(here, "../../experiments.json"), join(process.cwd(), "experiments.json")]) {
    try { const j = JSON.parse(readFileSync(p, "utf8")); return { hours: j.hours ?? 72, experiments: j.experiments ?? [] }; } catch { /* try next */ }
  }
  return { hours: 72, experiments: [] };
}

const key = (t: LabTrade) => `${t.mode}:${t.mint}:${t.leg ?? ""}:${Math.round(t.at / 600_000)}`;
const tot = (s: Partial<Record<Mode, ModeSummary>>, modes: Mode[]) => modes.reduce((a, m) => {
  const x = s[m]; if (x) { a.trades += x.trades; a.wins += x.wins; a.pnl += x.pnl; } return a;
}, { trades: 0, wins: 0, pnl: 0 });

export function liveCheck(from: number, to: number, base: LabTrade[]): LiveCheck {
  const firstTick = (db.prepare("SELECT MIN(at) AS t FROM ticks WHERE at BETWEEN ? AND ?").get(from, to) as { t: number | null }).t ?? to;
  const rows = db.prepare("SELECT mode, symbol, mint, entry_at, realized_usd, status FROM positions WHERE entry_at BETWEEN ? AND ? ORDER BY entry_at").all(Math.max(from, firstTick), to) as
    { mode: Mode; symbol: string; mint: string; entry_at: number; realized_usd: number; status: string }[];
  const live: LiveCheck["live"] = {};
  let matched = 0;
  const missed: LiveCheck["missedByReplay"] = [];
  for (const r of rows) {
    const l = live[r.mode] ?? { trades: 0, wins: 0, pnl: 0, open: 0 };
    l.trades++;
    if (r.status === "closed") { l.pnl += r.realized_usd; if (r.realized_usd > 0) l.wins++; } else l.open++;
    live[r.mode] = l;
    if (base.some(t => t.mode === r.mode && t.mint === r.mint && Math.abs(t.at - r.entry_at) <= 30 * 60_000)) matched++;
    else missed.push({ mode: r.mode, symbol: r.symbol, at: r.entry_at, pnl: r.status === "closed" ? r.realized_usd : null });
  }
  const said = db.prepare("SELECT reason FROM signals_log WHERE mint=? AND mode=? AND at BETWEEN ? AND ? ORDER BY ABS(at - ?) LIMIT 1");
  const extra = base.filter(t => !rows.some(r => r.mode === t.mode && r.mint === t.mint && Math.abs(t.at - r.entry_at) <= 30 * 60_000))
    .map(t => {
      const r = said.get(t.mint, t.mode, t.at - 30 * 60_000, t.at + 30 * 60_000, t.at) as { reason: string } | undefined;
      return { mode: t.mode, symbol: t.symbol, at: t.at, pnl: t.pnl, liveSaid: r?.reason ?? "didn't check this coin then" };
    }).sort((a, b) => a.pnl - b.pnl).slice(0, 15);
  const split = (f: (t: LabTrade) => boolean) => base.filter(f).reduce((a, t) => ({ trades: a.trades + 1, wins: a.wins + (t.pnl > 0 ? 1 : 0), pnl: a.pnl + t.pnl }), { trades: 0, wins: 0, pnl: 0 });
  return {
    dataFrom: firstTick, live, matched, liveTrades: rows.length, missedByReplay: missed.slice(-10), extraByReplay: extra,
    byCandles: { real: split(t => t.candles === "real"), rebuilt: split(t => t.candles !== "real") },
  };
}

export function runLab(hours: number, experiments: Experiment[], now = Date.now()): LabReport {
  const t0 = Date.now();
  const from = now - hours * 3_600_000;
  const lab = new Lab(from, now);
  const base = lab.run({ name: "Live rules" });
  const baseSummary = summarize(base.trades);
  const out: ExperimentResult[] = [];
  for (const exp of experiments) {
    const modes = modesFor(exp);
    try {
      const r = lab.run(exp);
      const summary = summarize(r.trades);
      const baseT = base.trades.filter(t => modes.includes(t.mode));
      const baseKeys = new Set(baseT.map(key)), expKeys = new Set(r.trades.map(key));
      const a = tot(summary, modes), b = tot(baseSummary, modes);
      out.push({
        name: exp.name, why: exp.why, modes, gate: !!exp.gate, result: summary, baseline: Object.fromEntries(modes.map(m => [m, baseSummary[m]]).filter(([, v]) => v)),
        totals: { trades: a.trades, wins: a.wins, pnl: a.pnl, baseTrades: b.trades, baseWins: b.wins, basePnl: b.pnl },
        added: r.trades.filter(t => !baseKeys.has(key(t))).sort((x, y) => y.pnl - x.pnl).slice(0, 15),
        dropped: baseT.filter(t => !expKeys.has(key(t))).sort((x, y) => y.pnl - x.pnl).slice(0, 15),
      });
    } catch (e) {
      out.push({ name: exp.name, why: exp.why, modes, result: {}, baseline: {}, totals: { trades: 0, wins: 0, pnl: 0, baseTrades: 0, baseWins: 0, basePnl: 0 }, added: [], dropped: [], error: String(e).slice(0, 200) });
    }
  }
  return {
    ranAt: now, from, to: now, hours, coins: lab.coins.size, secs: Math.round((Date.now() - t0) / 1000),
    baseline: { summary: baseSummary, trades: [...base.trades].sort((x, y) => y.at - x.at).slice(0, 60) },
    check: liveCheck(from, now, base.trades.filter(t => !config.pausedModes.includes(t.mode))),
    paused: config.pausedModes,
    experiments: out,
  };
}

function money(n: number) { return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`; }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const file = loadExperiments();
  const hours = Number(opt("hours") ?? file.hours);
  const only = opt("only");
  const exps = file.experiments.filter(e => !only || e.name.toLowerCase().includes(only.toLowerCase()));
  const rep = runLab(hours, exps);
  if (args.includes("--json")) { process.stdout.write(JSON.stringify(rep)); process.exit(0); }
  console.log(`Lab: ${rep.coins} coins, last ${hours}h, ${rep.secs}s\n`);
  const c = rep.check!;
  console.log(`Data from ${new Date(c.dataFrom).toISOString()}. Live bot: ${c.liveTrades} trades, replay matched ${c.matched}.`);
  console.log(`Replay entries on real candles: ${c.byCandles.real.trades} (${money(c.byCandles.real.pnl)}), rebuilt: ${c.byCandles.rebuilt.trades} (${money(c.byCandles.rebuilt.pnl)})\n`);
  console.log("Live rules:");
  for (const [m, s] of Object.entries(rep.baseline.summary)) console.log(`  ${m.padEnd(9)} ${String(s!.trades).padStart(3)} trades ${String(s!.wins).padStart(3)} wins  ${money(s!.pnl)}`);
  for (const e of rep.experiments) {
    const t = e.totals;
    console.log(`\n${e.name}${e.error ? `  ERROR ${e.error}` : ""}`);
    console.log(`  ${t.trades} trades, ${t.wins} wins, ${money(t.pnl)}   vs live ${t.baseTrades} trades, ${t.baseWins} wins, ${money(t.basePnl)}   (${money(t.pnl - t.basePnl)})`);
    for (const a of e.added.slice(0, 5)) console.log(`    + ${a.symbol.padEnd(12)} ${a.mode.padEnd(8)} ${money(a.pnl)}  ${a.exit}`);
    for (const d of e.dropped.slice(0, 5)) console.log(`    - ${d.symbol.padEnd(12)} ${d.mode.padEnd(8)} ${money(d.pnl)}  ${d.exit}`);
  }
}
