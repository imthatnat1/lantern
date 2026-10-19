/**
 * One-time data repairs, run at startup. Each is keyed in kv so it runs once, and does nothing if its data isn't there.
 */
import { db, kv } from "./db.js";
import { config } from "./config.js";
import { log } from "./log.js";

const ALLINU = "4MMQY9bwkxxTtsK3W227Q5ABT6yFY8Pmn9Ze7wmAXKY8";

/**
 * 19 Oct 16:56: the exit loop priced the ALLINU dip position from a pool where ALLINU is the pairing token ($19.17
 * instead of $0.0048) and booked a fake "TP +40%" sale of $7,684. Undo every sale of that position at an impossible
 * price: give back the cash and vault, restore the quantity, reset its peak and last good price, delete the fake fills
 * and the fake equity history, and put peak equity back so the drawdown halt doesn't fire on the correction.
 */
export function repairAllinu19Oct(): void {
  const flag = "repair:allinu-19oct";
  if (kv.get(flag, false)) return;
  const pos = db.prepare("SELECT * FROM positions WHERE mint=? ORDER BY id DESC LIMIT 1").get(ALLINU) as any;
  if (!pos) { kv.set(flag, true); return; }
  // The wrong pool's prices were also recorded as ALLINU ticks; the lab would replay the same fake 3,900x.
  db.prepare("DELETE FROM ticks WHERE mint=? AND price > ?").run(ALLINU, pos.entry_price * 50);
  const bad = db.prepare("SELECT * FROM fills WHERE position_id=? AND side='sell' AND price_usd > ?").all(pos.id, pos.entry_price * 50) as any[];
  if (bad.length) {
    const a = kv.get<{ cash: number; vault: number; peakEquity: number }>("account", { cash: config.startingCapital, vault: 0, peakEquity: config.startingCapital });
    let qtyBack = 0, pnlBack = 0;
    for (const f of bad) {
      const pnl = f.net_usd - pos.cost_usd * (f.qty / pos.qty);
      const toVault = pnl > 0 ? pnl * config.risk.vaultShare : 0;
      a.cash -= f.net_usd - toVault;
      a.vault -= toVault;
      qtyBack += f.qty; pnlBack += pnl;
    }
    const plan = JSON.parse(pos.plan);
    if (plan.closeStopPrice > pos.entry_price) plan.closeStopPrice = pos.entry_price * 0.75;
    db.prepare(`UPDATE positions SET remaining_qty = remaining_qty + ?, realized_usd = realized_usd - ?, tp_taken='[]', status='open',
        closed_at=NULL, close_reason=NULL, peak_price=entry_price, peak_close=entry_price, last_good_price=entry_price, plan=? WHERE id=?`)
      .run(qtyBack, pnlBack, JSON.stringify(plan), pos.id);
    db.prepare(`DELETE FROM fills WHERE id IN (${bad.map(() => "?").join(",")})`).run(...bad.map(f => f.id));
    db.prepare("DELETE FROM equity_history WHERE at > ? AND equity > ?").run(pos.entry_at, config.startingCapital * 5);
    const peak = (db.prepare("SELECT MAX(equity) AS m FROM equity_history").get() as any)?.m ?? config.startingCapital;
    a.peakEquity = Math.min(a.peakEquity, Math.max(peak, config.startingCapital));
    kv.set("account", a);
    log.warn({ fills: bad.length, qtyBack, pnlBack: pnlBack.toFixed(2), cash: a.cash.toFixed(2), vault: a.vault.toFixed(2), peak: a.peakEquity.toFixed(2) }, "repaired the fake ALLINU sale");
  }
  kv.set(flag, true);
}
