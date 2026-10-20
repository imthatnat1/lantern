import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { db, kv } = await import("../src/db.js");
const { repairDacityRide20Oct } = await import("../src/repair.js");
const { storedIsWhole } = await import("../src/data/livecandles.js");
const { notePairMint } = await import("../src/data/pairmint.js");

test("repair: the fake ride Dacity sale (20 Oct 15:03, -$8.10) is undone once and the position reopens", () => {
  const MINT = "nxPqZ4F7ux8Vph5NFu25rEP6Kx9Gr1U6Fmj36Rjpump", T = Date.now() - 3_600_000;
  const plan = { hardFloorPct: 0.45, closeStopPrice: 0.005, takeProfits: [], trailPct: 0.3, trailAfterGain: 0.6, maxHoldMs: 0 };
  db.prepare(`INSERT INTO positions(id,mode,mint,symbol,entry_price,entry_at,qty,remaining_qty,cost_usd,peak_price,peak_close,last_good_price,last_good_at,atr15,liquidity_at_entry,plan,tp_taken,realized_usd,status,closed_at,close_reason)
    VALUES(34,'ride',?,'Dacity',0.00701,?,1141,0,8,0.00701,0.00701,0.0000014,?,0,473000,?,'[]',-8.104,'closed',?,'hard floor -45%')`).run(MINT, T, T, JSON.stringify(plan), T + 18_000);
  db.prepare("INSERT INTO fills(position_id,side,mode,mint,qty,price_usd,gross_usd,fees_usd,net_usd,reason,at) VALUES(34,'buy','ride',?,1141,0.00701,8,0.2,8,'ride core',?)").run(MINT, T);
  db.prepare("INSERT INTO fills(position_id,side,mode,mint,qty,price_usd,gross_usd,fees_usd,net_usd,reason,at) VALUES(34,'sell','ride',?,1141,0.0000014,0.0016,0.1,-0.104,'hard floor -45%',?)").run(MINT, T + 18_000);
  kv.set("account", { cash: 198.21, vault: 6.2, peakEquity: 306.9 });

  repairDacityRide20Oct();
  const a = kv.get<any>("account", null);
  assert.equal(Math.round(a.cash * 100) / 100, Math.round((198.21 + 0.104) * 100) / 100);
  assert.equal(a.vault, 6.2);
  const p = db.prepare("SELECT * FROM positions WHERE id=34").get() as any;
  assert.equal(p.status, "open");
  assert.equal(p.remaining_qty, 1141);
  assert.ok(Math.abs(p.realized_usd) < 1e-6);
  assert.equal(p.last_good_price, 0.00701);
  assert.equal((db.prepare("SELECT count(*) AS n FROM fills WHERE position_id=34 AND side='sell'").get() as any).n, 0);

  kv.set("account", { cash: 1, vault: 1, peakEquity: 1 });
  repairDacityRide20Oct();
  assert.equal(kv.get<any>("account", null).cash, 1, "runs once only");
});

test("restart: a pair with a full stored day skips GeckoTerminal; a thin or stale record doesn't", () => {
  const M5 = 300_000, now = Math.floor(Date.now() / M5) * M5 + 60_000, bucket = Math.floor(now / M5) * M5;
  const ins = db.prepare("INSERT OR REPLACE INTO candles(pair,agg,t,o,h,l,c,v) VALUES(?,5,?,?,?,?,?,1)");
  notePairMint("FULL", "FULLMINT"); notePairMint("THIN", "THINMINT"); notePairMint("STALE", "STALEMINT");
  for (let i = 1; i <= 270; i++) ins.run("FULL", bucket - i * M5, 1, 1.01, 0.99, 1);
  for (let i = 1; i <= 100; i++) ins.run("THIN", bucket - i * M5, 1, 1.01, 0.99, 1);
  for (let i = 10; i <= 280; i++) ins.run("STALE", bucket - i * M5, 1, 1.01, 0.99, 1);
  assert.equal(storedIsWhole("FULL", now), true);
  assert.equal(storedIsWhole("THIN", now), false);
  assert.equal(storedIsWhole("STALE", now), false);
});
