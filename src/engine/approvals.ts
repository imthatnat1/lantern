/**
 * APPROVAL QUEUE (19 Oct, from Blossom; plumbing for real money, OFF while on paper).
 *
 * When on, any new bet above `aboveUsd` waits for Nat's tap instead of buying straight away. The signal is held in
 * memory with its exit plan; the dashboard shows it (state.approvals.pending) and POST /api/approve { id, yes }
 * decides. On a yes, the next scan tick re-runs every guardrail (canOpen) and checks the price hasn't run more than
 * `maxDriftPct` since it was queued, then buys. No answer within `ttlMs` = expired. A restart drops held signals
 * (their exit plans can't be rebuilt from the database), so anything pending at a restart is marked expired.
 * Nat's own Buy-button picks never wait: her tap already is the approval. Adds to winners don't wait either
 * (half the first bid, always under the line while bids are $4-$12).
 *
 * Turn on with APPROVALS=on in /opt/lantern/.env (and APPROVE_ABOVE_USD to move the line, default $20).
 */
import { db } from "../db.js";
import { log } from "../log.js";
import type { Signal } from "../types.js";

export interface ApprovalCfg { enabled: boolean; aboveUsd: number; ttlMs: number; maxDriftPct: number }
const num = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
export const APPROVALS: ApprovalCfg = {
  enabled: (process.env.APPROVALS ?? "").trim().toLowerCase() === "on",
  aboveUsd: num("APPROVE_ABOVE_USD", 20),
  ttlMs: 10 * 60_000,
  maxDriftPct: 0.15,
};

db.exec(`CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, mode TEXT, mint TEXT, symbol TEXT, size_usd REAL, price REAL,
  reason TEXT, status TEXT NOT NULL, decided_at INTEGER, note TEXT
)`);
// Held signals die with the process: whatever was pending at the last shutdown can't be bought now.
db.prepare("UPDATE approvals SET status='expired', decided_at=?, note='bot restarted' WHERE status IN ('pending','approved')").run(Date.now());

const held = new Map<number, Signal>();

export function needsApproval(sig: Signal, cfg = APPROVALS): boolean {
  return cfg.enabled && sig.mode !== "pick" && sig.sizeUsd > cfg.aboveUsd;
}

/** Hold a signal for Nat. One pending request per coin and mode. Returns the request id. */
export function queue(sig: Signal, now = Date.now()): number {
  const dup = db.prepare("SELECT id FROM approvals WHERE status='pending' AND mint=? AND mode=?").get(sig.mint, sig.mode) as { id: number } | undefined;
  if (dup) return dup.id;
  const r = db.prepare("INSERT INTO approvals(at, mode, mint, symbol, size_usd, price, reason, status) VALUES(?,?,?,?,?,?,?, 'pending')")
    .run(now, sig.mode, sig.mint, sig.symbol, sig.sizeUsd, sig.snapshot.priceUsd, sig.reason);
  const id = Number(r.lastInsertRowid);
  held.set(id, sig);
  log.info({ id, sym: sig.symbol, usd: sig.sizeUsd }, "buy waiting for approval");
  return id;
}

/** Nat's answer from the dashboard. */
export function decide(id: number, yes: boolean, now = Date.now()): { ok: boolean; why?: string } {
  const row = db.prepare("SELECT status FROM approvals WHERE id=?").get(id) as { status: string } | undefined;
  if (!row) return { ok: false, why: "no such request" };
  if (row.status !== "pending") return { ok: false, why: `already ${row.status}` };
  if (!held.has(id)) { finish(id, "expired", now, "bot restarted"); return { ok: false, why: "expired: the bot restarted" }; }
  if (!yes) { held.delete(id); finish(id, "declined", now); return { ok: true }; }
  db.prepare("UPDATE approvals SET status='approved', decided_at=? WHERE id=?").run(now, id);
  return { ok: true };
}

function finish(id: number, status: string, now: number, note?: string) {
  db.prepare("UPDATE approvals SET status=?, decided_at=coalesce(decided_at, ?), note=? WHERE id=?").run(status, now, note ?? null, id);
}

/**
 * Called each scan tick. Expires old requests and hands back approved signals for the caller to re-check and buy.
 * `done(id, bought, note)` records the outcome.
 */
export function takeApproved(now = Date.now(), cfg = APPROVALS): { id: number; sig: Signal }[] {
  for (const r of db.prepare("SELECT id FROM approvals WHERE status='pending' AND at < ?").all(now - cfg.ttlMs) as { id: number }[]) {
    held.delete(r.id); finish(r.id, "expired", now, "no answer in 10 minutes");
  }
  const out: { id: number; sig: Signal }[] = [];
  for (const r of db.prepare("SELECT id FROM approvals WHERE status='approved'").all() as { id: number }[]) {
    const sig = held.get(r.id);
    if (!sig) { finish(r.id, "expired", now, "bot restarted"); continue; }
    out.push({ id: r.id, sig });
  }
  return out;
}

/** Price check before an approved buy: the coin mustn't have run off while it waited. */
export function driftWhy(queuedPrice: number, nowPrice: number, cfg = APPROVALS): string | null {
  if (!queuedPrice || !nowPrice) return null;
  const d = nowPrice / queuedPrice - 1;
  return Math.abs(d) > cfg.maxDriftPct ? `price moved ${d > 0 ? "+" : ""}${Math.round(d * 100)}% while it waited` : null;
}

export function done(id: number, bought: boolean, note: string, now = Date.now()) {
  held.delete(id);
  finish(id, bought ? "bought" : "not bought", now, note);
}

/** For /api/state. */
export function approvalsState(now = Date.now(), cfg = APPROVALS) {
  const pending = db.prepare("SELECT id, at, mode, mint, symbol, size_usd AS sizeUsd, price, reason FROM approvals WHERE status='pending' ORDER BY at DESC").all() as any[];
  const recent = db.prepare("SELECT id, at, mode, symbol, size_usd AS sizeUsd, status, decided_at AS decidedAt, note FROM approvals WHERE status<>'pending' AND at > ? ORDER BY at DESC LIMIT 20").all(now - 48 * 3_600_000);
  return { enabled: cfg.enabled, aboveUsd: cfg.aboveUsd, ttlMs: cfg.ttlMs, pending: pending.map(p => ({ ...p, expiresAt: p.at + cfg.ttlMs })), recent };
}
