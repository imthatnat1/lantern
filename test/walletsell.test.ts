import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
process.env.HELIUS_API_KEY = "";   // no balance reads in tests: falls back to the recorded bag
const { judgeWalletSells, tightenTrail, walletSellCheck, walletSellLog, TIGHT_TRAIL } = await import("../src/engine/walletsell.js");
const { ingest } = await import("../src/data/wallets.js");
const { evaluate } = await import("../src/engine/exits.js");

const WIRELYSS = "AvGiSdrkwtGYhrrFXZPtdhNhV4pASUR67TmRjfaKGdMP";
const HEXI = "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm";
const T = Date.UTC(2026, 9, 19, 8, 0), M15 = 15 * 60_000;
let sigN = 0;
const swap = (wallet: string, mint: string, side: "buy" | "sell", amount: number, at: number) => ingest({
  type: "SWAP", signature: `sig${++sigN}`, timestamp: Math.floor(at / 1000), nativeTransfers: [],
  tokenTransfers: [side === "buy" ? { mint, toUserAccount: wallet, fromUserAccount: "pool", tokenAmount: amount } : { mint, fromUserAccount: wallet, toUserAccount: "pool", tokenAmount: amount }],
});
const pos = (mint: string, mode = "trusted", walletAddrs: string[] = []) => ({ id: ++sigN, mode, mint, symbol: mint, entryPrice: 1, entryAt: T, qty: 10, remainingQty: 10, costUsd: 10,
  peakPrice: 1.4, peakClose: 1.4, lastGoodPrice: 1.3, lastGoodAt: T, atr15: 0.05, liquidityAtEntry: 50_000,
  plan: { hardFloorPct: 0.45, closeStopPrice: 0.7, takeProfits: [{ gain: 1, sell: 0.5 }], trailPct: 0.3, trailAfterGain: 0.6, trailLadder: [{ peakGain: 2, trailPct: 0.25 }], maxHoldMs: 0 },
  tpTaken: [], realizedUsd: 0, status: "open", meta: { walletAddrs } } as any);
const s = (name: string, trigger: boolean, soldPct: number | null) => ({ wallet: name, name, trigger, soldPct, at: T });

test("the wallet we copied selling most of its bag means exit; a trim or someone else selling means tighten", () => {
  assert.equal(judgeWalletSells([s("wirelyss", true, 0.8)])?.kind, "exit");
  assert.equal(judgeWalletSells([s("wirelyss", true, 0.5)])?.kind, "exit", "half counts as most");
  assert.equal(judgeWalletSells([s("wirelyss", true, 0.3)])?.kind, "tighten", "a trim by the trigger wallet only tightens");
  assert.equal(judgeWalletSells([s("hexi", false, 0.9)])?.kind, "tighten", "a wallet we didn't copy never forces an exit");
  assert.equal(judgeWalletSells([s("hexi", false, 0.05)]), null, "dust sells are ignored");
  assert.equal(judgeWalletSells([s("wirelyss", true, null)])?.kind, "exit", "unknown size from the trigger wallet: the reason we bought is gone");
  assert.equal(judgeWalletSells([s("hexi", false, null)])?.kind, "tighten");
  assert.equal(judgeWalletSells([s("hexi", false, 0.9), s("wirelyss", true, 0.6)])?.kind, "exit", "exit beats tighten");
  assert.equal(judgeWalletSells([s("hexi", false, 0.2), s("sapphy", false, 0.7)])?.name, "sapphy", "biggest sell names the warning");
});

test("tightening arms a 15% trail under the peak close, caps the ladder, and never loosens a stop", () => {
  const p = pos("A");
  assert.ok(tightenTrail(p));
  assert.equal(p.plan.trailPct, TIGHT_TRAIL);
  assert.ok(p.plan.trailAfterGain <= -1, "armed at any gain");
  assert.equal(p.plan.trailLadder[0].trailPct, TIGHT_TRAIL);
  assert.ok(Math.abs(p.plan.closeStopPrice - 1.4 * 0.85) < 1e-9);
  assert.equal(tightenTrail(p), false, "idempotent");
  const q = pos("B"); q.plan.trailPct = 0.1; q.plan.closeStopPrice = 1.35;
  tightenTrail(q);
  assert.equal(q.plan.trailPct, 0.1, "an already tighter trail stays");
  assert.equal(q.plan.closeStopPrice, 1.35, "a higher stop stays");
  // And the exit engine acts on it at the next 15m close under the trail.
  const acts = evaluate(p, { price: 1.15, at: T + 2 * M15, confirmed: true, source: "t" } as any, { t: T + M15, o: 1.25, h: 1.25, l: 1.15, c: 1.15, v: 1 }, T + 2 * M15);
  assert.equal(acts[0]?.fraction, 1, "sold at the first 15m close under the tightened trail (labelled close stop or trail)");
});

test("end to end: wirelyss dumps 80% of her bag after we copied her, we exit", async () => {
  swap(WIRELYSS, "MINT1", "buy", 1000, T - 60_000);
  const p = pos("MINT1", "trusted", [WIRELYSS]);
  assert.equal(await walletSellCheck(p, T + 1), null, "no sells yet");
  swap(WIRELYSS, "MINT1", "sell", 50, T + 5 * 60_000);
  const trim = await walletSellCheck(p, T + 6 * 60_000);
  assert.equal(trim, null, "a 5% trim no longer dumps the position (the old mirror did)");
  swap(WIRELYSS, "MINT1", "sell", 750, T + 10 * 60_000);
  const a = await walletSellCheck(p, T + 11 * 60_000);
  assert.equal(a?.kind, "exit");
  assert.match(a!.reason, /wirelyss \(who we copied\) sold 80% of their bag/);
  assert.equal(walletSellLog(0).filter(e => e.mint === "MINT1" && e.action === "exit").length, 1);
});

test("end to end: hexi selling a coin launch bought tightens the trail and warns once", async () => {
  swap(HEXI, "MINT2", "buy", 400, T - 3_600_000);
  const p = pos("MINT2", "launch");
  swap(HEXI, "MINT2", "sell", 400, T + 5 * 60_000);
  assert.equal(await walletSellCheck(p, T + 6 * 60_000), null, "no exit: we didn't copy hexi");
  assert.equal(p.plan.trailPct, TIGHT_TRAIL);
  assert.match(p.meta.walletWarn, /hexi sold 100% of their bag: trail tightened to 15%/);
  await walletSellCheck(p, T + 7 * 60_000);
  assert.equal(walletSellLog(0).filter(e => e.mint === "MINT2").length, 1, "logged once, not every loop");
});

test("sells from before we entered don't count", async () => {
  swap(WIRELYSS, "MINT3", "buy", 1000, T - 7_200_000);
  swap(WIRELYSS, "MINT3", "sell", 900, T - 3_600_000);
  const p = pos("MINT3", "trusted", [WIRELYSS]);
  assert.equal(await walletSellCheck(p, T + 60_000), null);
});
