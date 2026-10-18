/**
 * Runs the lab in a separate, low-priority process so a long replay never stalls trading.
 * Every 6 hours, 10 minutes after a new build starts, or on demand from the dashboard.
 * The latest report is kept in kv "lab:report" and served at GET /api/lab.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { kv } from "../db.js";
import { log } from "../log.js";

const EVERY_MS = 6 * 3_600_000;
let running = false;

export function labStatus() {
  return { running, lastRunAt: kv.get("lab:lastRunAt", 0), lastError: kv.get<string | null>("lab:lastError", null), build: kv.get("lab:build", "") };
}

export function runLabNow(reason: string): boolean {
  if (running) return false;
  running = true;
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = import.meta.url.endsWith(".js");
  const script = join(here, compiled ? "run.js" : "run.ts");
  const [cmd, args] = compiled
    ? ["nice", ["-n", "15", process.execPath, "--max-old-space-size=768", script, "--json"]]
    : ["npx", ["tsx", script, "--json"]];
  const t0 = Date.now();
  log.info({ reason }, "lab run starting");
  execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60_000, env: process.env }, (err, stdout, stderr) => {
    running = false;
    kv.set("lab:lastRunAt", Date.now());
    if (err) {
      const msg = `${String(err.message).slice(0, 200)} ${String(stderr).slice(-300)}`.trim();
      kv.set("lab:lastError", msg);
      log.warn({ err: msg }, "lab run failed");
      return;
    }
    try {
      const rep = JSON.parse(stdout);
      kv.set("lab:report", rep);
      kv.set("lab:lastError", null);
      kv.set("lab:build", kv.get("build", ""));
      log.info({ secs: Math.round((Date.now() - t0) / 1000), coins: rep.coins, experiments: rep.experiments?.length }, "lab run done");
    } catch (e) {
      kv.set("lab:lastError", `bad output: ${String(e).slice(0, 120)}`);
    }
  });
  return true;
}

export function startLab() {
  // A new build usually means new experiments or new rules: run once it has settled in.
  const fresh = kv.get("lab:build", "") !== kv.get("build", "");
  const due = Date.now() - kv.get("lab:lastRunAt", 0) > EVERY_MS;
  if (fresh || due) setTimeout(() => runLabNow(fresh ? "new build" : "due"), 10 * 60_000);
  setInterval(() => { if (Date.now() - kv.get("lab:lastRunAt", 0) > EVERY_MS) runLabNow("schedule"); }, 15 * 60_000);
}
