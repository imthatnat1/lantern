import { createServer } from "node:http";
import { db, positions, kv } from "./db.js";
import * as broker from "./engine/broker.js";
import { config } from "./config.js";
import { ingest, scorecard, currentKols } from "./data/wallets.js";
import { log } from "./log.js";
import { labStatus, runLabNow } from "./lab/scheduler.js";

/**
 * JSON API for the dashboard. Bearer token from DASHBOARD_TOKEN.
 *   GET  /api/state                  everything the dashboard shows
 *   POST /api/control {action}       "stop" halts new buys (exits keep running), "resume" lifts it
 *   GET  /api/lab                    latest lab report (entry replay experiments) and run status
 *   POST /api/lab {action:"run"}     start a lab run now
 */
export function startServer(getMarks: () => Map<string, number>, getHealth: () => { feedDownS: number; dexStaleS: number }) {
  const token = process.env.DASHBOARD_TOKEN ?? "";
  const port = Number(process.env.DASHBOARD_PORT ?? 8787);
  if (!token) { log.warn("DASHBOARD_TOKEN not set, dashboard API disabled"); return; }

  const srv = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end('{"error":"unauthorized"}'); return; }
    if (req.method === "GET" && req.url === "/api/state") {
      try { res.end(JSON.stringify(state(getMarks(), getHealth()))); }
      catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
      return;
    }
    if (req.method === "GET" && req.url === "/api/lab") {
      res.end(JSON.stringify({ status: labStatus(), report: kv.get("lab:report", null) }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/lab") {
      const started = runLabNow("dashboard");
      res.end(JSON.stringify({ ok: true, started, status: labStatus() }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/wallet-events") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        try { const arr = JSON.parse(body || "[]"); let n = 0; for (const tx of Array.isArray(arr) ? arr : [arr]) n += ingest(tx); res.end(JSON.stringify({ ok: true, n })); }
        catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e) })); }
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/control") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        try {
          const { action } = JSON.parse(body || "{}");
          if (action === "stop") { kv.set("paused", true); log.warn("GLOBAL STOP from dashboard"); }
          else if (action === "resume") { kv.set("paused", false); log.info("resumed from dashboard"); }
          else { res.statusCode = 400; res.end('{"error":"action must be stop or resume"}'); return; }
          res.end(JSON.stringify({ ok: true, paused: kv.get("paused", false) }));
        } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e) })); }
      });
      return;
    }
    res.statusCode = 404; res.end('{"error":"not found"}');
  });
  srv.listen(port, "0.0.0.0", () => log.info({ port }, "dashboard api listening"));
}

export function snapshotEquity(marks: Map<string, number>) {
  const a = broker.account();
  db.prepare("INSERT OR REPLACE INTO equity_history(at, equity, cash, vault) VALUES(?,?,?,?)")
    .run(Date.now(), broker.equity(marks), a.cash, a.vault);
  db.prepare("DELETE FROM equity_history WHERE at < ?").run(Date.now() - 14 * 24 * 3_600_000);
}

const mk = db.prepare("SELECT * FROM market WHERE mint=?");
function mkt(mint: string) {
  const m = mk.get(mint) as any;
  if (!m) return null;
  return { ...m, labels: JSON.parse(m.labels || "[]") };
}

function state(marks: Map<string, number>, health: { feedDownS: number; dexStaleS: number }) {
  const a = broker.account();
  const now = Date.now();
  const dayStart = broker.brisbaneDayStart(now);

  const open = positions.open().map(p => {
    const price = marks.get(p.mint) ?? p.lastGoodPrice;
    return {
      mode: p.mode, symbol: p.symbol, mint: p.mint,
      entryPrice: p.entryPrice, price, gainPct: price / p.entryPrice - 1,
      pnlUsd: p.remainingQty * price - p.costUsd * (p.remainingQty / p.qty),
      valueUsd: p.remainingQty * price, costUsd: p.costUsd * (p.remainingQty / p.qty), sizeUsd: p.costUsd,
      realizedUsd: p.realizedUsd, openedAt: p.entryAt,
      closeStop: p.plan.closeStopPrice, stopPct: p.plan.closeStopPrice / p.entryPrice - 1,
      hardFloorPct: -p.plan.hardFloorPct, trailArmed: (p.peakClose / p.entryPrice - 1) >= p.plan.trailAfterGain,
      peakPct: p.peakPrice / p.entryPrice - 1, tpTaken: p.tpTaken, takeProfits: p.plan.takeProfits,
      reason: p.meta.reason, score: p.meta.score, mcapAtEntry: (p.meta.mcapAtEntry as number) ?? null, leg: (p.meta.leg as string) ?? null,
      market: mkt(p.mint),
    };
  });

  const closed = (db.prepare(`SELECT id, mode, symbol, mint, entry_price, entry_at, realized_usd, closed_at, close_reason, cost_usd
    FROM positions WHERE status='closed' ORDER BY closed_at DESC LIMIT 60`).all() as any[]).map(c => ({ ...c, market: mkt(c.mint) }));

  const fills = (db.prepare(`SELECT f.*, p.qty AS pos_qty, p.entry_price, p.symbol FROM fills f LEFT JOIN positions p ON p.id=f.position_id
    WHERE f.at >= ? ORDER BY f.at DESC`).all(dayStart) as any[]).map(f => ({
      side: f.side, mode: f.mode, symbol: f.symbol ?? null, mint: f.mint, at: f.at, usd: f.net_usd, fees: f.fees_usd, reason: f.reason,
      fraction: f.pos_qty ? f.qty / f.pos_qty : 1,
      pnlUsd: f.side === "sell" ? f.net_usd - (f.entry_price ? f.qty * f.entry_price : 0) : null,
      pnlPct: f.side === "sell" && f.entry_price ? f.price_usd / f.entry_price - 1 : null,
      market: mkt(f.mint),
    }));

  const equity = db.prepare("SELECT at, equity, cash, vault FROM equity_history WHERE at > ? ORDER BY at").all(now - 7 * 24 * 3_600_000) as any[];
  const rejected = db.prepare("SELECT count(*) AS n FROM rejected_ticks WHERE at > ?").get(now - 24 * 3_600_000) as { n: number };
  const rejectedRows = db.prepare("SELECT mint, price, last_good, at, note FROM rejected_ticks WHERE at > ? ORDER BY at DESC LIMIT 20").all(now - 24 * 3_600_000);

  const byMode = (db.prepare(`SELECT mode, count(*) AS n, sum(case when realized_usd>0 then 1 else 0 end) AS wins, sum(realized_usd) AS pnl
    FROM positions WHERE status='closed' GROUP BY mode`).all() as any[]);
  for (const m of Object.keys(config.allocation)) if (!byMode.find(x => x.mode === m)) byMode.push({ mode: m, n: 0, wins: 0, pnl: 0 });
  for (const m of byMode) m.open = open.filter(o => o.mode === m.mode).length;

  // Looks in the last 24h: latest per (mode, mint). Hot = highest score first.
  const looks = (db.prepare(`SELECT s.* FROM signals_log s JOIN (SELECT mode, mint, max(at) AS at FROM signals_log WHERE at > ? GROUP BY mode, mint) l
    ON l.mode=s.mode AND l.mint=s.mint AND l.at=s.at WHERE s.taken=0 ORDER BY s.at DESC LIMIT 80`).all(now - 24 * 3_600_000) as any[])
    .map(r => ({ mode: r.mode, mint: r.mint, symbol: r.symbol, score: r.score, reason: r.reason, at: r.at, priceThen: r.price, rejected: /^rejected/i.test(r.reason), setup: r.setup ? JSON.parse(r.setup) : null,
      watching: !/^rejected/i.test(r.reason) && !!r.setup && now - r.at < 3 * 3_600_000,
      watchedSince: (db.prepare("SELECT min(at) AS t FROM signals_log WHERE mode=? AND mint=? AND at > ?").get(r.mode, r.mint, now - 24 * 3_600_000) as any)?.t ?? r.at, market: mkt(r.mint) }));

  // Missed runners: anything we declined in 48h that then went 2x or more from the look price.
  const missed = (db.prepare(`SELECT mode, mint, symbol, reason, at, price, peak_price, last_price, mcap FROM signals_log
    WHERE taken=0 AND at > ? AND peak_price >= price * 2 ORDER BY peak_price / price DESC LIMIT 20`).all(now - 48 * 3_600_000) as any[])
    .map(r => ({ ...r, peakX: r.peak_price / r.price, nowX: r.last_price / r.price, market: mkt(r.mint) }));
  // Plus coins we were stopped out of that then ran.
  const stoppedThenRan = (db.prepare(`SELECT p.mode, p.mint, p.symbol, p.close_reason AS reason, p.closed_at AS at, p.entry_price AS price, m.price AS last_price
    FROM positions p JOIN market m ON m.mint=p.mint WHERE p.status='closed' AND p.closed_at > ? AND p.realized_usd < 0 AND m.price >= p.entry_price * 2`).all(now - 48 * 3_600_000) as any[])
    .map(r => ({ ...r, peakX: r.last_price / r.price, nowX: r.last_price / r.price, soldEarly: true, market: mkt(r.mint) }));

  const closedAll = db.prepare(`SELECT count(*) AS n, sum(case when realized_usd>0 then 1 else 0 end) AS wins, coalesce(sum(realized_usd),0) AS pnl FROM positions WHERE status='closed'`).get() as any;
  const eq = broker.equity(marks);
  const openPnl = open.reduce((s, o) => s + o.pnlUsd, 0);

  return {
    at: now, paused: kv.get("paused", false),
    account: {
      cash: a.cash, vault: a.vault, equity: eq, peakEquity: a.peakEquity, startingCapital: config.startingCapital,
      realizedToday: broker.realizedToday(), openPnl, closedCount: closedAll.n, closedWins: closedAll.wins, closedPnl: closedAll.pnl,
    },
    guardrails: { dailyLossStopUsd: config.risk.dailyLossStopUsd, drawdownHaltAt: a.peakEquity * (1 - config.risk.drawdownHaltPct), capitalAtRisk: broker.openValueUsd(marks), maxCapitalAtRisk: config.risk.maxCapitalAtRiskUsd },
    health: { ...health, rejectedTicks24h: rejected.n, rejected: rejectedRows, startedAt: kv.get("startedAt", now), uptimeMs: now - kv.get("startedAt", now),
      helius: { keyLooksValid: /^[0-9a-f-]{36}$/.test(config.keys.helius ?? ""), lastOkAt: kv.get("helius:lastOkAt", 0), lastErr: kv.get("helius:lastErr", "") }, rugcheck: { lastOkAt: kv.get("rugcheck:lastOkAt", 0), lastErr: kv.get("rugcheck:lastErr", "") }, walletEvents1h: (db.prepare("SELECT count(*) AS n FROM wallet_events WHERE at > ?").get(now - 3_600_000) as any).n, build: kv.get("build", "") },
    config: { modes: config.modes, allocation: config.allocation, risk: config.risk, fees: config.fees },
    open, closed, fills, equity, byMode, looks, missed: [...missed, ...stoppedThenRan],
    wallets: scorecard(7), kols: currentKols().map(k => k.name), trusted: config.trustedWallets.map(config.walletName),
  };
}
