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
import { Lab, modesFor, summarize, type Experiment, type LabTrade, type ModeSummary } from "./entries.js";
import type { Mode } from "../types.js";

export interface ExperimentResult {
  name: string; why?: string; modes: Mode[];
  result: Partial<Record<Mode, ModeSummary>>;
  baseline: Partial<Record<Mode, ModeSummary>>;
  totals: { trades: number; wins: number; pnl: number; baseTrades: number; baseWins: number; basePnl: number };
  /** Trades this experiment took that the live rules didn't, and the other way round. */
  added: LabTrade[]; dropped: LabTrade[];
  error?: string;
}

export interface LabReport {
  ranAt: number; from: number; to: number; hours: number; coins: number; secs: number;
  baseline: { summary: Partial<Record<Mode, ModeSummary>>; trades: LabTrade[] };
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
        name: exp.name, why: exp.why, modes, result: summary, baseline: Object.fromEntries(modes.map(m => [m, baseSummary[m]]).filter(([, v]) => v)),
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
