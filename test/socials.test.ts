import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { judge, linksFromMeta, metaUrls, socialsWhy, dexProfileWhy, _resetSocials } = await import("../src/data/socials.js");
const { blockMint, burnedWhy, burnName, nameKey, _resetBlocks } = await import("../src/data/flow.js");

// --- socials ---

test("TrendTrader Pro (18 Oct): nothing on DexScreener, nothing in its launch metadata = rejected", async () => {
  _resetSocials();
  const why = await socialsWhy("TTP", {}, "https://ipfs.io/ipfs/QmTTP", async () => ({}));
  assert.equal(why, "no website or socials");
});

test("a coin whose dev set an X account at launch passes, even with no DexScreener profile", async () => {
  _resetSocials();
  const meta = linksFromMeta({ name: "Real", symbol: "REAL", description: "lore", twitter: "https://x.com/realcoin_sol" });
  assert.equal(await socialsWhy("REAL", {}, "uri", async () => meta), null);
});

test("an X community, a Telegram group, or the coin's own website each count", () => {
  assert.equal(judge({ twitter: "https://x.com/i/communities/1846000000000000000" }).why, null);
  assert.equal(judge({ telegram: "https://t.me/agenc_portal" }).why, null);
  assert.equal(judge({ website: "agenc.tech" }).why, null);
});

test("a link to someone else's tweet is borrowed lore, not a community", () => {
  assert.equal(judge({ twitter: "https://x.com/elonmusk/status/1846000000000000000" }).why, "no community, only a link to someone else's tweet");
});

test("launchpad, chart and explorer pages don't count as a website", () => {
  for (const w of ["https://pump.fun/coin/abc", "https://dexscreener.com/solana/abc", "https://www.stonkfun.xyz/token/abc", "https://solscan.io/token/abc"])
    assert.equal(judge({ website: w }).why, "no website or socials", w);
});

test("an X link typed into the website box still counts as the X link", () => {
  assert.equal(judge({ website: "https://x.com/realcoin_sol" }).why, null);
});

test("links under `extensions` (other launchpads) are read too", () => {
  assert.deepEqual(linksFromMeta({ extensions: { telegram: "https://t.me/x1", website: "https://x1.io" } }), { website: "https://x1.io", twitter: undefined, telegram: "https://t.me/x1" });
});

test("metadata unreadable and nothing on DexScreener: rejected, and says so plainly", async () => {
  assert.equal(await socialsWhy("M", {}, undefined, async () => null), "couldn't read its socials");
});

test("a real DexScreener profile is enough without reading the metadata", async () => {
  let called = false;
  assert.equal(await socialsWhy("M", { twitter: "https://x.com/coin" }, "uri", async () => { called = true; return null; }), null);
  assert.equal(called, false);
});

test("the same IPFS file is tried on more than one gateway", () => {
  assert.deepEqual(metaUrls("https://ipfs.io/ipfs/QmAbc123"), ["https://ipfs.io/ipfs/QmAbc123", "https://gateway.pinata.cloud/ipfs/QmAbc123", "https://dweb.link/ipfs/QmAbc123"]);
  assert.deepEqual(metaUrls("https://metadata.example.com/abc.json"), ["https://metadata.example.com/abc.json"]);
});

// --- burned names ---

test("GTA 6 Coin: the bot coin gets blocked, and a new mint with the same name is refused", () => {
  _resetBlocks();
  blockMint("GTA_FIRST", "bot volume: 600+ trades in an hour averaging $0.49", 24, "GTA 6 Coin");
  assert.match(burnedWhy("GTA 6 COIN", "GTA_SECOND")!, /scam relaunch: a coin called "GTA 6 Coin" was caught 1h ago \(bot volume/);
  assert.equal(burnedWhy("GTA 6 Coin", "GTA_FIRST"), null, "the original has its own block");
  assert.equal(burnedWhy("Grand Theft Coin", "OTHER"), null);
});

test("names compare without case, spaces or symbols; very short names aren't burned", () => {
  _resetBlocks();
  assert.equal(nameKey("GTA 6 Coin!"), "gta6coin");
  burnName("CAT", "A", "crashed 90% in an hour");
  assert.equal(burnedWhy("cat", "B"), null);
});

test("a block without a name (Stonk.fun listings, Nat's watch list) burns nothing", () => {
  _resetBlocks();
  blockMint("TSLAX_1", "crashed 85% in an hour", 24, undefined);
  assert.equal(burnedWhy("TSLAx", "TSLAX_2"), null);
});

// --- DexScreener profile (Nat's test) ---

test("TTP and GTA 6 Coin: nothing on DexScreener = refused, whatever the launch form says", () => {
  assert.equal(dexProfileWhy({}), "no links on DexScreener (no website, X or Telegram)");
});
test("a DexScreener profile with an X account, Telegram or website passes", () => {
  assert.equal(dexProfileWhy({ twitter: "https://x.com/agenc_ai" }), null);
  assert.equal(dexProfileWhy({ telegram: "https://t.me/tortue_sol" }), null);
  assert.equal(dexProfileWhy({ website: "https://tortue.fun" }), null);
});
test("a DexScreener profile that only links someone else's tweet is refused", () => {
  assert.match(dexProfileWhy({ twitter: "https://x.com/elonmusk/status/1846000000000000000" })!, /only a link to someone else's tweet/);
});

test("safufun (19 Oct): a page on someone else's app is not the coin's website", () => {
  // DexScreener showed Website = usepaid.app/t/zbcjs6hc and Twitter = a status link. It fell 40% in 5 minutes at 45 min old.
  const why = dexProfileWhy({ website: "https://usepaid.app/t/zbcjs6hc", twitter: "https://x.com/river100x/status/2111930895623983362" });
  assert.equal(why, "no website of its own, only a page on usepaid.app and a link to someone else's tweet (DexScreener)");
  assert.match(judge({ website: "https://linktr.ee/somecoin" }).why!, /only a page on linktr\.ee/);
  assert.match(judge({ website: "https://otcdesks.cash/coin/DFMt2FyLpB6ekPNAzVErLXgpSnJ9CRf1VnxBAkTLpump" }).why!, /only a page on otcdesks\.cash/);
});

test("a coin's own site still counts at its root or one page deep, and a real X account still carries a hosted page", () => {
  for (const w of ["https://agenc.tech/", "https://xcoinsol.lol", "https://bwigitte.fun/home", "minter.live"]) assert.equal(judge({ website: w }).why, null, w);
  // FTR: website is an otcdesks.cash page, but it has its own X account
  assert.equal(judge({ website: "https://otcdesks.cash/coin/DFMt", twitter: "https://x.com/FTRonPUMP" }).why, null);
});

test("churn warning: safufun's first 19 minutes get the chip, a buy-heavy launch doesn't", async () => {
  const { churnLabel } = await import("../src/strategies/base.js");
  const now = Date.now();
  const safufun = { createdAt: now - 19 * 60_000, mcapUsd: 83_000, volume1h: 345_000, buys1h: 3_545, sells1h: 3_418 };
  assert.match(churnLabel(safufun, now)[0], /^churn\? 4x/);
  assert.deepEqual(churnLabel({ ...safufun, buys1h: 5_000, sells1h: 2_500 }, now), [], "buyers outnumber sellers 2:1");
  assert.deepEqual(churnLabel({ ...safufun, createdAt: now - 2 * 3_600_000 }, now), [], "older than an hour");
});
