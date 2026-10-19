import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { readPrice, _resetPending } = await import("../src/engine/price.js");
const { db, kv } = await import("../src/db.js");
const { repairAllinu19Oct } = await import("../src/repair.js");

test("ALLINU (19 Oct): a 3,900x jump from the wrong pool never confirms, however many ticks agree", async () => {
  _resetPending();
  const wrongPool = { primary: async () => 19.17, secondary: async () => 0.0048 };
  for (const t of [1000, 7000, 13000, 19000]) {
    const r = await readPrice("ALLINU", 0.0049, wrongPool, t);
    assert.equal(r!.confirmed, false, `tick at ${t}`);
  }
  const noJup = { primary: async () => 19.17, secondary: async () => null };
  for (const t of [30000, 36000]) assert.equal((await readPrice("ALLINU", 0.0049, noJup, t))!.confirmed, false);
});

test("a real 5x pump still confirms when Jupiter agrees", async () => {
  _resetPending();
  const r = await readPrice("RUNNER", 1.0, { primary: async () => 6, secondary: async () => 5.9 }, 1000);
  assert.ok(r!.confirmed);
});

test("the single-coin lookup only uses pools where the coin is the base token", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../src/data/dexscreener.ts", import.meta.url), "utf8");
  assert.match(src, /p\.chainId === "solana" && p\.baseToken\?\.address === mint/);
});

test("repair: the fake ALLINU sale is undone once, cash and vault given back, peak equity restored", () => {
  const MINT = "4MMQY9bwkxxTtsK3W227Q5ABT6yFY8Pmn9Ze7wmAXKY8", T = Date.now() - 3_600_000;
  const plan = { hardFloorPct: 0.4, closeStopPrice: 0.0031, takeProfits: [{ gain: 0.4, sell: 0.33 }], trailPct: 0.2, trailAfterGain: 0.2, maxHoldMs: 0 };
  db.prepare(`INSERT INTO positions(id,mode,mint,symbol,entry_price,entry_at,qty,remaining_qty,cost_usd,peak_price,peak_close,last_good_price,last_good_at,atr15,liquidity_at_entry,plan,tp_taken,realized_usd,status)
    VALUES(7,'dip',?,'ALLINU',0.004867,?,1200,804,6.6667,19.17,0.0049,19.17,?,0,156000,?,'[0]',?,'open')`).run(MINT, T, T, JSON.stringify(plan), 7684.35 - 6.6667 * 396 / 1200);
  db.prepare("INSERT INTO fills(position_id,side,mode,mint,qty,price_usd,gross_usd,fees_usd,net_usd,reason,at) VALUES(7,'buy','dip',?,1200,0.004867,6.6667,0.2,6.6667,'dip',?)").run(MINT, T);
  db.prepare("INSERT INTO fills(position_id,side,mode,mint,qty,price_usd,gross_usd,fees_usd,net_usd,reason,at) VALUES(7,'sell','dip',?,396,19.4,7684.5,0.15,7684.35,'TP +40%',?)").run(MINT, T + 60_000);
  db.prepare("INSERT INTO equity_history(at,equity,cash,vault) VALUES(?,?,?,?)").run(T - 60_000, 307.2, 300, 1.48);
  db.prepare("INSERT INTO equity_history(at,equity,cash,vault) VALUES(?,?,?,?)").run(T + 120_000, 21390, 4110, 3842);
  const pnl = 7684.35 - 6.6667 * 396 / 1200;
  kv.set("account", { cash: 280 + (7684.35 - pnl / 2), vault: 1.48 + pnl / 2, peakEquity: 21390 });

  repairAllinu19Oct();
  const a = kv.get<any>("account", null);
  assert.equal(Math.round(a.cash * 100) / 100, 280);
  assert.equal(Math.round(a.vault * 100) / 100, 1.48);
  assert.equal(a.peakEquity, 307.2, "drawdown halt won't fire on the correction");
  const p = db.prepare("SELECT * FROM positions WHERE id=7").get() as any;
  assert.equal(p.remaining_qty, 1200);
  assert.ok(Math.abs(p.realized_usd) < 1e-6);
  assert.equal(p.last_good_price, 0.004867);
  assert.equal(p.tp_taken, "[]");
  assert.equal((db.prepare("SELECT count(*) AS n FROM fills WHERE position_id=7 AND side='sell'").get() as any).n, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM equity_history WHERE equity > 1500").get() as any).n, 0);

  // Runs once only.
  kv.set("account", { cash: 1, vault: 1, peakEquity: 1 });
  repairAllinu19Oct();
  assert.equal(kv.get<any>("account", null).cash, 1);
});
