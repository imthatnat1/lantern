import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import type { Fill, Mode, Position } from "./types.js";

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  entry_price REAL NOT NULL,
  entry_at INTEGER NOT NULL,
  qty REAL NOT NULL,
  remaining_qty REAL NOT NULL,
  cost_usd REAL NOT NULL,
  peak_price REAL NOT NULL,
  peak_close REAL NOT NULL,
  last_good_price REAL NOT NULL,
  last_good_at INTEGER NOT NULL,
  atr15 REAL NOT NULL,
  liquidity_at_entry REAL NOT NULL,
  plan TEXT NOT NULL,
  tp_taken TEXT NOT NULL DEFAULT '[]',
  realized_usd REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  closed_at INTEGER,
  close_reason TEXT,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS positions_status ON positions(status);

CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER,
  side TEXT NOT NULL,
  mode TEXT NOT NULL,
  mint TEXT NOT NULL,
  qty REAL NOT NULL,
  price_usd REAL NOT NULL,
  gross_usd REAL NOT NULL,
  fees_usd REAL NOT NULL,
  net_usd REAL NOT NULL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cooldowns (
  mode TEXT NOT NULL, mint TEXT NOT NULL, until INTEGER NOT NULL,
  PRIMARY KEY (mode, mint)
);

CREATE TABLE IF NOT EXISTS rejected_ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL, source TEXT NOT NULL,
  price REAL NOT NULL, last_good REAL NOT NULL, at INTEGER NOT NULL, note TEXT
);

CREATE TABLE IF NOT EXISTS equity_history (
  at INTEGER PRIMARY KEY, equity REAL NOT NULL, cash REAL NOT NULL, vault REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS signals_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL, mint TEXT NOT NULL, symbol TEXT NOT NULL,
  score REAL NOT NULL, taken INTEGER NOT NULL, reason TEXT NOT NULL,
  price REAL NOT NULL, at INTEGER NOT NULL
);
`);

export const kv = {
  get<T>(k: string, d: T): T {
    const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined;
    return r ? (JSON.parse(r.v) as T) : d;
  },
  set(k: string, v: unknown) {
    db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, JSON.stringify(v));
  },
};

function rowToPosition(r: any): Position {
  return {
    id: r.id, mode: r.mode, mint: r.mint, symbol: r.symbol,
    entryPrice: r.entry_price, entryAt: r.entry_at, qty: r.qty, remainingQty: r.remaining_qty,
    costUsd: r.cost_usd, peakPrice: r.peak_price, peakClose: r.peak_close,
    lastGoodPrice: r.last_good_price, lastGoodAt: r.last_good_at, atr15: r.atr15,
    liquidityAtEntry: r.liquidity_at_entry, plan: JSON.parse(r.plan), tpTaken: JSON.parse(r.tp_taken),
    realizedUsd: r.realized_usd, status: r.status, closedAt: r.closed_at ?? undefined,
    closeReason: r.close_reason ?? undefined, meta: JSON.parse(r.meta),
  };
}

export const positions = {
  open(): Position[] {
    return (db.prepare("SELECT * FROM positions WHERE status='open'").all() as any[]).map(rowToPosition);
  },
  openByMode(mode: Mode): Position[] {
    return (db.prepare("SELECT * FROM positions WHERE status='open' AND mode=?").all(mode) as any[]).map(rowToPosition);
  },
  isHeld(mint: string): boolean {
    return !!db.prepare("SELECT 1 FROM positions WHERE status='open' AND mint=?").get(mint);
  },
  insert(p: Omit<Position, "id">): Position {
    const r = db.prepare(`INSERT INTO positions
      (mode,mint,symbol,entry_price,entry_at,qty,remaining_qty,cost_usd,peak_price,peak_close,last_good_price,last_good_at,atr15,liquidity_at_entry,plan,tp_taken,realized_usd,status,meta)
      VALUES (@mode,@mint,@symbol,@entryPrice,@entryAt,@qty,@remainingQty,@costUsd,@peakPrice,@peakClose,@lastGoodPrice,@lastGoodAt,@atr15,@liquidityAtEntry,@plan,@tpTaken,@realizedUsd,@status,@meta)`)
      .run({ ...p, plan: JSON.stringify(p.plan), tpTaken: JSON.stringify(p.tpTaken), meta: JSON.stringify(p.meta) });
    return { ...p, id: Number(r.lastInsertRowid) };
  },
  update(p: Position) {
    db.prepare(`UPDATE positions SET remaining_qty=@remainingQty, peak_price=@peakPrice, peak_close=@peakClose,
      last_good_price=@lastGoodPrice, last_good_at=@lastGoodAt, plan=@plan, tp_taken=@tpTaken, realized_usd=@realizedUsd,
      status=@status, closed_at=@closedAt, close_reason=@closeReason, meta=@meta WHERE id=@id`)
      .run({ ...p, plan: JSON.stringify(p.plan), tpTaken: JSON.stringify(p.tpTaken), meta: JSON.stringify(p.meta),
        closedAt: p.closedAt ?? null, closeReason: p.closeReason ?? null });
  },
  realizedSince(sinceMs: number): number {
    const r = db.prepare("SELECT COALESCE(SUM(net_usd),0) AS s FROM fills WHERE side='sell' AND at>=?").get(sinceMs) as { s: number };
    const c = db.prepare("SELECT COALESCE(SUM(net_usd),0) AS s FROM fills WHERE side='buy' AND at>=? AND position_id IN (SELECT id FROM positions WHERE status='closed' AND closed_at>=?)").get(sinceMs, sinceMs) as { s: number };
    return r.s - c.s;
  },
};

export const fills = {
  insert(f: Fill, positionId: number) {
    db.prepare(`INSERT INTO fills (position_id,side,mode,mint,qty,price_usd,gross_usd,fees_usd,net_usd,reason,at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(positionId, f.side, f.mode, f.mint, f.qty, f.priceUsd, f.grossUsd, f.feesUsd, f.netUsd, f.reason, f.at);
  },
};

export const cooldowns = {
  active(mode: Mode, mint: string, now = Date.now()): boolean {
    const r = db.prepare("SELECT until FROM cooldowns WHERE mode=? AND mint=?").get(mode, mint) as { until: number } | undefined;
    return !!r && r.until > now;
  },
  set(mode: Mode, mint: string, until: number) {
    db.prepare("INSERT INTO cooldowns(mode,mint,until) VALUES(?,?,?) ON CONFLICT(mode,mint) DO UPDATE SET until=excluded.until").run(mode, mint, until);
  },
};

export const audit = {
  rejectedTick(mint: string, source: string, price: number, lastGood: number, note: string) {
    db.prepare("INSERT INTO rejected_ticks(mint,source,price,last_good,at,note) VALUES(?,?,?,?,?,?)").run(mint, source, price, lastGood, Date.now(), note);
  },
  signal(mode: Mode, mint: string, symbol: string, score: number, taken: boolean, reason: string, price: number) {
    db.prepare("INSERT INTO signals_log(mode,mint,symbol,score,taken,reason,price,at) VALUES(?,?,?,?,?,?,?,?)").run(mode, mint, symbol, score, taken ? 1 : 0, reason, price, Date.now());
  },
};
