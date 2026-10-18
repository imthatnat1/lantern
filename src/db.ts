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
  price REAL NOT NULL, at INTEGER NOT NULL,
  mcap REAL NOT NULL DEFAULT 0, liquidity REAL NOT NULL DEFAULT 0,
  peak_price REAL NOT NULL DEFAULT 0, last_price REAL NOT NULL DEFAULT 0, peak_checked_at INTEGER NOT NULL DEFAULT 0,
  setup TEXT
);
CREATE INDEX IF NOT EXISTS signals_at ON signals_log(at);

-- Recording for replay. Every snapshot and every candle batch the bot sees. 14-day retention.
CREATE TABLE IF NOT EXISTS ticks (
  mint TEXT NOT NULL, at INTEGER NOT NULL, price REAL NOT NULL, liquidity REAL, mcap REAL,
  vol5m REAL, buys5m INTEGER, sells5m INTEGER, PRIMARY KEY (mint, at)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS candles (
  pair TEXT NOT NULL, agg INTEGER NOT NULL, t INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
  PRIMARY KEY (pair, agg, t)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS holders_history (
  mint TEXT NOT NULL, at INTEGER NOT NULL, holders INTEGER NOT NULL, PRIMARY KEY (mint, at)
) WITHOUT ROWID;

-- Dev history: creators of anything RugCheck flagged as rugged. Blocks their next launch.
CREATE TABLE IF NOT EXISTS rugged_creators (creator TEXT PRIMARY KEY, mint TEXT NOT NULL, at INTEGER NOT NULL);

-- Latest market snapshot per mint we care about (open positions, recent looks). Refreshed by the loops.
CREATE TABLE IF NOT EXISTS market (
  mint TEXT PRIMARY KEY, symbol TEXT, name TEXT, pair TEXT, quote TEXT,
  price REAL, mcap REAL, liquidity REAL, vol24h REAL, vol1h REAL, vol5m REAL,
  buys5m INTEGER, sells5m INTEGER, ch5m REAL, ch1h REAL, ch6h REAL, ch24h REAL,
  created_at INTEGER, holders INTEGER, on_curve INTEGER, website TEXT, twitter TEXT,
  labels TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
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

// Migration for databases created before the setup column existed.
try { db.exec("ALTER TABLE signals_log ADD COLUMN setup TEXT"); } catch { /* already there */ }
try { db.exec("ALTER TABLE signals_log ADD COLUMN pair TEXT"); } catch { /* already there */ }
// Recorded for the replay lab: which pair a tick came from (dust pools can be filtered out), when coins
// migrated (bounce needs it), and what the safety gate saw (so gate rules can be replayed later).
try { db.exec("ALTER TABLE ticks ADD COLUMN pair TEXT"); } catch { /* already there */ }
// DexScreener's own % changes, so the lab sees the same "up 215% in 24h" the bot saw.
for (const c of ["ch1h", "ch6h", "ch24h"]) { try { db.exec(`ALTER TABLE ticks ADD COLUMN ${c} REAL`); } catch { /* already there */ } }
db.exec(`CREATE TABLE IF NOT EXISTS migrations (mint TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS safety_history (
  mint TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL, top10 REAL, holders INTEGER, sniper REAL, reasons TEXT,
  PRIMARY KEY (mint, at)
) WITHOUT ROWID;`);
try { db.exec("ALTER TABLE market ADD COLUMN image TEXT"); } catch { /* already there */ }

// Hot list (18 Oct): every coin that passed the safety prefilter, per mode, with the latest verdict the mode gave
// it. Watching shows these as "On its way" (clean, not in a setup yet) next to "In a setup", and scans re-check them first.
db.exec(`CREATE TABLE IF NOT EXISTS clean_seen (
  mode TEXT NOT NULL, mint TEXT NOT NULL, symbol TEXT NOT NULL, at INTEGER NOT NULL, first_at INTEGER NOT NULL,
  price REAL, status TEXT, status_at INTEGER, PRIMARY KEY (mode, mint)
) WITHOUT ROWID;`);
const upClean = db.prepare(`INSERT INTO clean_seen(mode,mint,symbol,at,first_at,price,status,status_at) VALUES(?,?,?,?,?,?,NULL,NULL)
  ON CONFLICT(mode,mint) DO UPDATE SET symbol=excluded.symbol, at=excluded.at, price=excluded.price,
    first_at=CASE WHEN clean_seen.at < excluded.at - 3600000 THEN excluded.at ELSE clean_seen.first_at END,
    status=CASE WHEN clean_seen.status LIKE 'rejected%' THEN NULL ELSE clean_seen.status END`);
const setStatus = db.prepare("UPDATE clean_seen SET status=?, status_at=? WHERE mode=? AND mint=?");
export const hot = {
  /** A coin passed the safety prefilter for this mode just now. */
  clean(mode: Mode, mint: string, symbol: string, price: number, at = Date.now()) { upClean.run(mode, mint, symbol, at, at, price); },
  /** The mode's latest verdict on a coin (setup progress, "waiting for...", or a rejection). Unthrottled. */
  status(mode: Mode, mint: string, why: string, at = Date.now()) { setStatus.run(why, at, mode, mint); },
  prune(now = Date.now()) { db.prepare("DELETE FROM clean_seen WHERE at < ?").run(now - 24 * 3_600_000); },
};

export interface Setup {
  /** What has to happen, in plain words. */
  need: string;
  /** Price level the trigger sits at, if there is one. */
  level?: number;
  /** How far price is from the level, as a fraction (0.08 = 8% away). 0 means "at it". */
  distance?: number;
  /** Progress through a count-based wait, e.g. candles held. */
  progress?: { done: number; of: number };
}

export const audit = {
  rejectedTick(mint: string, source: string, price: number, lastGood: number, note: string) {
    db.prepare("INSERT INTO rejected_ticks(mint,source,price,last_good,at,note) VALUES(?,?,?,?,?,?)").run(mint, source, price, lastGood, Date.now(), note);
  },
  signal(mode: Mode, mint: string, symbol: string, score: number, taken: boolean, reason: string, price: number, mcap = 0, liquidity = 0, setup?: Setup, pair?: string) {
    db.prepare("INSERT INTO signals_log(mode,mint,symbol,score,taken,reason,price,at,mcap,liquidity,peak_price,last_price,setup,pair) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(mode, mint, symbol, score, taken ? 1 : 0, reason, price, Date.now(), mcap, liquidity, price, price, setup ? JSON.stringify(setup) : null, pair ?? null);
  },
};

export const market = {
  upsert(s: import("./types.js").TokenSnapshot, holders?: number, labels?: string[]) {
    db.prepare(`INSERT INTO market(mint,symbol,name,pair,quote,price,mcap,liquidity,vol24h,vol1h,vol5m,buys5m,sells5m,ch5m,ch1h,ch6h,ch24h,created_at,holders,on_curve,website,twitter,labels,updated_at,image)
      VALUES(@mint,@symbol,@name,@pair,@quote,@price,@mcap,@liquidity,@vol24h,@vol1h,@vol5m,@buys5m,@sells5m,@ch5m,@ch1h,@ch6h,@ch24h,@created_at,@holders,@on_curve,@website,@twitter,@labels,@updated_at,@image)
      ON CONFLICT(mint) DO UPDATE SET symbol=excluded.symbol,name=excluded.name,pair=excluded.pair,quote=excluded.quote,price=excluded.price,mcap=excluded.mcap,liquidity=excluded.liquidity,
        vol24h=excluded.vol24h,vol1h=excluded.vol1h,vol5m=excluded.vol5m,buys5m=excluded.buys5m,sells5m=excluded.sells5m,ch5m=excluded.ch5m,ch1h=excluded.ch1h,ch6h=excluded.ch6h,ch24h=excluded.ch24h,
        created_at=excluded.created_at,holders=COALESCE(excluded.holders,market.holders),on_curve=excluded.on_curve,website=excluded.website,twitter=excluded.twitter,
        labels=CASE WHEN excluded.labels='[]' THEN market.labels ELSE excluded.labels END,updated_at=excluded.updated_at,image=COALESCE(excluded.image,market.image)`)
      .run({
        mint: s.mint, symbol: s.symbol, name: s.name, pair: s.pairAddress ?? null, quote: s.quoteSymbol ?? null,
        price: s.priceUsd, mcap: s.mcapUsd, liquidity: s.liquidityUsd, vol24h: s.volume24h, vol1h: s.volume1h, vol5m: s.volume5m,
        buys5m: s.buys5m, sells5m: s.sells5m, ch5m: s.change5m, ch1h: s.change1h, ch6h: s.change6h, ch24h: s.change24h,
        created_at: s.createdAt, holders: holders ?? s.holders ?? null, on_curve: s.onCurve ? 1 : 0, website: s.website ?? null, twitter: s.twitter ?? null,
        labels: JSON.stringify(labels ?? []), updated_at: Date.now(), image: s.imageUrl ?? null,
      });
  },
};

const insTick = db.prepare("INSERT OR IGNORE INTO ticks(mint,at,price,liquidity,mcap,vol5m,buys5m,sells5m,pair,ch1h,ch6h,ch24h) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
const insMigration = db.prepare("INSERT OR IGNORE INTO migrations(mint,at) VALUES(?,?)");
const insSafety = db.prepare("INSERT OR IGNORE INTO safety_history(mint,at,ok,top10,holders,sniper,reasons) VALUES(?,?,?,?,?,?,?)");
const lastSafetyAt = new Map<string, number>();
const insCandle = db.prepare("INSERT OR REPLACE INTO candles(pair,agg,t,o,h,l,c,v) VALUES(?,?,?,?,?,?,?,?)");
const insHolders = db.prepare("INSERT OR IGNORE INTO holders_history(mint,at,holders) VALUES(?,?,?)");
const updMarketHolders = db.prepare("UPDATE market SET holders=? WHERE mint=?");

export const recorder = {
  tick(s: import("./types.js").TokenSnapshot) {
    insTick.run(s.mint, s.fetchedAt, s.priceUsd, s.liquidityUsd, s.mcapUsd, s.volume5m, s.buys5m, s.sells5m, s.pairAddress ?? null, s.change1h, s.change6h, s.change24h);
  },
  candles(pair: string, agg: number, cs: import("./types.js").Candle[]) {
    const tx = db.transaction((rows: import("./types.js").Candle[]) => { for (const k of rows) insCandle.run(pair, agg, k.t, k.o, k.h, k.l, k.c, k.v); });
    tx(cs);
  },
  migration(mint: string, at: number) { insMigration.run(mint, at); },
  /** What the safety gate saw, at most once per coin per 10 minutes. */
  safety(mint: string, r: { ok: boolean; top10Pct?: number; holders?: number; sniperPct?: number; reasons: string[] }) {
    const now = Date.now();
    if (now - (lastSafetyAt.get(mint) ?? 0) < 10 * 60_000) return;
    lastSafetyAt.set(mint, now);
    if (lastSafetyAt.size > 20_000) lastSafetyAt.clear();
    insSafety.run(mint, now, r.ok ? 1 : 0, r.top10Pct ?? null, r.holders ?? null, r.sniperPct ?? null, r.reasons.join("; ") || null);
  },
  holders(mint: string, holders: number, at = Date.now()) { insHolders.run(mint, at, holders); updMarketHolders.run(holders, mint); },
  /** Holder growth over `windowMs`, as a fraction. null when we have fewer than two readings. */
  holderVelocity(mint: string, windowMs = 10 * 60_000, now = Date.now()): number | null {
    const latest = db.prepare("SELECT at, holders FROM holders_history WHERE mint=? ORDER BY at DESC LIMIT 1").get(mint) as { at: number; holders: number } | undefined;
    const earlier = db.prepare("SELECT holders FROM holders_history WHERE mint=? AND at<=? ORDER BY at DESC LIMIT 1").get(mint, now - windowMs) as { holders: number } | undefined;
    if (!latest || !earlier || !earlier.holders) return null;
    return latest.holders / earlier.holders - 1;
  },
  prune(days = 14) {
    const cut = Date.now() - days * 86_400_000;
    db.prepare("DELETE FROM ticks WHERE at < ?").run(cut);
    db.prepare("DELETE FROM candles WHERE t < ?").run(cut);
    db.prepare("DELETE FROM holders_history WHERE at < ?").run(cut);
    db.prepare("DELETE FROM safety_history WHERE at < ?").run(cut);
    try { db.prepare("DELETE FROM flow_history WHERE at < ?").run(cut); } catch { /* table made by data/flow.ts */ }
  },
};

export const creators = {
  markRugged(creator: string, mint: string) {
    db.prepare("INSERT OR IGNORE INTO rugged_creators(creator,mint,at) VALUES(?,?,?)").run(creator, mint, Date.now());
  },
  isRugger(creator: string): boolean {
    return !!db.prepare("SELECT 1 FROM rugged_creators WHERE creator=?").get(creator);
  },
};

export const ride = {
  /** Sleeve trades closed today on a mint, and when/how the last one ended. */
  sleeveHistory(mint: string, dayStart: number) {
    const n = (db.prepare("SELECT count(*) AS n FROM positions WHERE mode='ride' AND mint=? AND json_extract(meta,'$.leg')='sleeve' AND entry_at>=?").get(mint, dayStart) as any).n as number;
    const last = db.prepare("SELECT closed_at, realized_usd FROM positions WHERE mode='ride' AND mint=? AND json_extract(meta,'$.leg')='sleeve' AND status='closed' ORDER BY closed_at DESC LIMIT 1").get(mint) as { closed_at: number; realized_usd: number } | undefined;
    return { tradesToday: n, lastClosedAt: last?.closed_at, lastWon: last ? last.realized_usd > 0 : undefined };
  },
  hasCore(mint: string): boolean {
    return !!db.prepare("SELECT 1 FROM positions WHERE mode='ride' AND mint=? AND status='open' AND json_extract(meta,'$.leg')='core'").get(mint);
  },
  hasSleeve(mint: string): boolean {
    return !!db.prepare("SELECT 1 FROM positions WHERE mode='ride' AND mint=? AND status='open' AND json_extract(meta,'$.leg')='sleeve'").get(mint);
  },
  leaders(): string[] { return kv.get<string[]>("ride:leaders", []); },
  setLeaders(m: string[]) { kv.set("ride:leaders", m); },
};

// One-time cleanup (18 Oct): missed-runner peaks before this date were priced off whichever pair claimed the most
// liquidity, including dust pools (wibet "783x", ApeMaxxing "25x"). Reset them; the tracker rebuilds from live pairs.
if (!kv.get("fix:dustPeaks", false)) {
  db.prepare("UPDATE signals_log SET peak_price=price, last_price=price, peak_checked_at=0 WHERE taken=0 AND peak_price >= price * 2").run();
  kv.set("fix:dustPeaks", true);
}
