import { createServer } from "node:http";
import { db, positions, kv } from "./db.js";
import * as broker from "./engine/broker.js";
import { log } from "./log.js";

/**
 * Read-only JSON API for the dashboard. Bearer token from DASHBOARD_TOKEN.
 * GET /api/state  -> account, open positions, recent closes, equity history, health
 */
export function startServer(getMarks: () => Map<string, number>, getHealth: () => { feedDownS: number; dexStaleS: number }) {
  const token = process.env.DASHBOARD_TOKEN ?? "";
  const port = Number(process.env.DASHBOARD_PORT ?? 8787);
  if (!token) { log.warn("DASHBOARD_TOKEN not set, dashboard API disabled"); return; }

  const srv = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end('{"error":"unauthorized"}'); return; }
    if (req.url !== "/api/state") { res.statusCode = 404; res.end('{"error":"not found"}'); return; }
    try { res.end(JSON.stringify(state(getMarks(), getHealth()))); }
    catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
  });
  srv.listen(port, "0.0.0.0", () => log.info({ port }, "dashboard api listening"));
}

export function snapshotEquity(marks: Map<string, number>) {
  const a = broker.account();
  db.prepare("INSERT INTO equity_history(at, equity, cash, vault) VALUES(?,?,?,?)")
    .run(Date.now(), broker.equity(marks), a.cash, a.vault);
  db.prepare("DELETE FROM equity_history WHERE at < ?").run(Date.now() - 14 * 24 * 3_600_000);
}

function state(marks: Map<string, number>, health: { feedDownS: number; dexStaleS: number }) {
  const a = broker.account();
  const now = Date.now();
  const open = positions.open().map(p => {
    const price = marks.get(p.mint) ?? p.lastGoodPrice;
    return {
      mode: p.mode, symbol: p.symbol, mint: p.mint,
      entryPrice: p.entryPrice, price, gainPct: price / p.entryPrice - 1,
      valueUsd: p.remainingQty * price, costUsd: p.costUsd * (p.remainingQty / p.qty),
      realizedUsd: p.realizedUsd, openedAt: p.entryAt, ageMin: Math.round((now - p.entryAt) / 60_000),
      closeStop: p.plan.closeStopPrice, stopPct: p.plan.closeStopPrice / p.entryPrice - 1,
      peakPct: p.peakPrice / p.entryPrice - 1, reason: p.meta.reason,
    };
  });
  const closed = db.prepare(`SELECT mode, symbol, mint, entry_price, entry_at, realized_usd, closed_at, close_reason, cost_usd
    FROM positions WHERE status='closed' ORDER BY closed_at DESC LIMIT 30`).all() as any[];
  const equity = db.prepare("SELECT at, equity, cash, vault FROM equity_history WHERE at > ? ORDER BY at").all(now - 48 * 3_600_000) as any[];
  const rejected = db.prepare("SELECT count(*) AS n FROM rejected_ticks WHERE at > ?").get(now - 24 * 3_600_000) as { n: number };
  const byMode = db.prepare(`SELECT mode, count(*) AS n, sum(case when realized_usd>0 then 1 else 0 end) AS wins, sum(realized_usd) AS pnl
    FROM positions WHERE status='closed' GROUP BY mode`).all() as any[];
  const eq = broker.equity(marks);
  return {
    at: now,
    account: { cash: a.cash, vault: a.vault, equity: eq, peakEquity: a.peakEquity, startingCapital: Number(process.env.STARTING_CAPITAL ?? 300), realizedToday: broker.realizedToday() },
    guardrails: { dailyLossStopUsd: 30, drawdownHaltAt: a.peakEquity * 0.8, capitalAtRisk: broker.openValueUsd(marks), maxCapitalAtRisk: 180 },
    health: { ...health, rejectedTicks24h: rejected.n, startedAt: kv.get("startedAt", now) },
    open, closed, equity, byMode,
  };
}
