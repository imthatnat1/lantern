import "dotenv/config";
import type { Mode } from "./types.js";

// A value like "$HELIUS" is an unexpanded placeholder copied from the old bot's files, not a key. Treat it as unset.
const env = (k: string, d = "") => { const v = (process.env[k] ?? "").trim(); return !v || v.startsWith("$") ? d : v; };
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};

/** Coins Blossom Terminal (v1) treated as its quality universe on 17 Oct 2026. Always in scope. */
const DEFAULT_PINNED = [
  "HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR", // ZCAT (ZEC pair)
  "8RNUw4N655VSrZKuhGdywhbSMDTrheguFPfxbpE2NZHQ", // PURR (HYPE pair)
  "5tCju6YNxHq5zrA6tGndr6F7TK42mpUFmeE31cSFpump", // swordcat
  "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx", // STONK
  "9CPfv7rc6vxBd3jtovmZtf5Zy8bdvssv8c4BwzbGk147", // NINJACAT (INJ pair)
  "39HqgQ18g9R33sUfKq1TjX4sbKrgTb4YntnBCFhURJvy", // MONEROCHAN (wXMR pair)
  "DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP", // SI (NVDAx pair)
  "nxPqZ4F7ux8Vph5NFu25rEP6Kx9Gr1U6Fmj36Rjpump", // Dacity (TTWO pair)
  "6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr", // NEARKAT (NEAR pair)
  "AGi2s9zPRPHs3zEDPhPTroumTEXK5ufymYSfEFndCSSW", // LEVERCAT (xSOL pair)
  "HTmQz7My6MehV7bjhJ6jde8nDND1yvsz68d24LP7YgUQ", // GP (GLDx pair)
  "DFMt2FyLpB6ekPNAzVErLXgpSnJ9CRf1VnxBAkTLpump", // FTR
  "5yC9BM8KUsJTPbWPLfA2N8qH1s9V8DQ3Vcw1G6Jdpump", // AgenC (the real Tetsuo dev's coin; Nat, 18 Oct)
];

/** Trusted wallets Nat follows on pump.fun. Public addresses; TRUSTED_WALLETS in .env adds to these. */
export const DEFAULT_TRUSTED: { name: string; address: string }[] = [
  { name: "wirelyss", address: "AvGiSdrkwtGYhrrFXZPtdhNhV4pASUR67TmRjfaKGdMP" },
  { name: "hexi", address: "21rgbFW6sujQovCw3qt6R2EdE97Yzzvk8sSc37Bb72Cm" },
  { name: "sapphy", address: "B5TrL7PsRUwCTL5bVcueieht5QchTw4TWLQDKqEaxEzi" },
];

export const config = {
  keys: {
    helius: env("HELIUS_API_KEY"),
    rugcheck: env("RUGCHECK_API_KEY"),
    xBearer: env("X_BEARER_TOKEN"),
    anthropic: env("ANTHROPIC_API_KEY"),
  },
  trustedWallets: [...new Set([...DEFAULT_TRUSTED.map(w => w.address), ...env("TRUSTED_WALLETS").split(",").map(s => s.trim()).filter(Boolean)])],
  walletName: (address: string) => DEFAULT_TRUSTED.find(w => w.address === address)?.name ?? address.slice(0, 4) + "…" + address.slice(-4),
  /** Mints Nat likes. Always in scope for dip and ultra, exempt from the copycat filter. */
  /**
   * Modes switched off for new buys. Their scans don't run either, which frees GeckoTerminal
   * budget for the other modes. Open positions keep being managed. PAUSED_MODES in .env adds more.
   * dip (18 Oct): the lab replayed 12 dip trades, 2 winners, -$11.31; the live bot only avoided
   * them because it was rate-limited or not checking those coins.
   * ride (19 Oct): live 6 trades, -$8.67; lab 17 trades, 2 winners, -$17.88. Its coins ($1M+) never ran past 1.8x.
   * Paused modes still scan and log would-buys, so nothing it would have caught goes unseen.
   * 19 Oct 16:05 (Nat: yes): dip unpaused with the turn rule (lab +$3.37 over 9 trades; the old trigger -$17.43) at $4.
   * bounce paused: lab 10 trades, 0 wins, -$7.25. Launch now covers fresh migrations.
   */
  // 20 Oct, Nat: "i dont mind losing paper money ... what matters is we test all modes until they are valid and robust".
  // Nothing is paused by default now. Each mode has its own daily loss cap instead (risk.modeDailyLossUsd).
  pausedModes: [...env("PAUSED_MODES").split(",").map(s => s.trim()).filter(Boolean)] as string[],
  /**
   * Always checked, like pinned coins, but with every safety check still applied (pinned coins skip
   * RugCheck and the copycat filter). For coins Nat wants eyes on but hasn't vouched for.
   * WATCH_MINTS in .env adds more.
   */
  watch: [
    "AcV6CcpMGFrA1dhRFiCKNiVNje8QE6ZXR9ep9jh7pump", // TSI (Tetsuo Super Intelligence), the real one per Nat, SOL pair (18 Oct)
    ...env("WATCH_MINTS").split(",").map(s => s.trim()).filter(Boolean),
  ] as string[],
  /** Never trade or watch these. BLOCKED_MINTS in .env adds more. */
  blocked: [
    "3NxfWMHmfQg8NJFW5AG1ti2xACdczWz24e9SKyk1pump", // Minter: cent-sized bot buys, 2.3 buys per sell while price fell 25% (18 Oct)
    ...env("BLOCKED_MINTS").split(",").map(s => s.trim()).filter(Boolean),
  ],
  pinned: [...DEFAULT_PINNED, ...env("PINNED_MINTS").split(",").map(s => s.trim()).filter(Boolean)],
  startingCapital: num("STARTING_CAPITAL", 300),
  dbPath: env("DB_PATH", "./data/lantern.db"),
  logLevel: env("LOG_LEVEL", "info"),
  timezone: "Australia/Brisbane",

  /** Paper fill model. Mirrors v1 so results stay comparable. */
  fees: {
    baseSol: 0.000005,
    prioritySol: 0.0005,
    tipSol: 0.0005,
    curveFeePct: 0.01,       // pump.fun bonding curve
    poolFeePct: 0.0025,      // PumpSwap / Raydium
    baseSlippagePct: 0.005,
    maxImpactPct: 0.03,      // refuse entries above this
    exitImpactWarnPct: 0.15, // refuse entries if a test sell shows worse
  },

  risk: {
    // 20 Oct: $30 -> $60 with every mode live. Each mode stops itself at modeDailyLossUsd first, so this is the backstop.
    dailyLossStopUsd: 60,
    modeDailyLossUsd: 15,
    // 20 Oct: 20% -> 35% for paper testing. From a $300 peak the old halt was $240 and equity was $252: one rough day
    // with every mode live would have stopped all buying until reset. Put back to 20% before any real money.
    drawdownHaltPct: 0.35,      // halt when equity < 65% of peak
    maxCapitalAtRiskUsd: 180,
    maxSingleTradeUsd: 40,
    vaultShare: 0.5,            // of realized profit
    /** A scan can spend minutes waiting on GeckoTerminal; the DexScreener read that produced the signal is what matters. */
    feedStaleMs: 5 * 60_000,
    priceStaleMs: 20_000,
    /** Price sanity: a tick this far from last good price needs confirmation. */
    sanityJumpPct: 0.40,
    /** Confirmation window: second source must agree within this tolerance. */
    sanityAgreePct: 0.15,
    /** Pools under this get close-based stops only and half size. */
    thinPoolUsd: 50_000,
    /** Size each entry so that selling the whole position moves the pool by at most this much. */
    maxExitImpactPct: 0.02,
  },

  allocation: <Record<Mode, number>>{
    ultra: 0.20,
    bounce: 0.15,
    pullback: 0.20,
    trusted: 0.10,
    dip: 0.20,
    ride: 0.15,
    pick: 0.10,
    launch: 0.15,
  },

  minExitLiquidityUsd: <Record<Mode, number>>{
    ultra: 8_000,
    bounce: 8_000,
    pullback: 8_000,
    trusted: 8_000,
    dip: 20_000,
    ride: 50_000,
    pick: 10_000,
    launch: 20_000,
  },

  modes: {
    ultra: {
      scanEveryMs: 5 * 60_000,
      cooldownMs: 6 * 3_600_000,
      maxOpen: 3,
      sizePctEquity: 0.03,
      maxSizeUsd: 8,
      minAgeH: 2, maxAgeH: 12,
      longWindowMaxAgeH: 36,
      mcapMin: 60_000, mcapMax: 1_500_000,
      longWindowMcapMin: 500_000, longWindowMcapMax: 15_000_000,
      minLiquidity: 25_000, longWindowMinLiquidity: 75_000,
      minHolders: 300,
      recoverFromLowX: 1.8,
      higherLows: 3, lowTolerance: 0.03, lastLowOverDumpX: 1.25,
      minRangeVolPerHour: 3_000,
      breakoutVolX: 1.3,
      buySellMin: 1.0, buySellMax: 3.0,
      maxAboveRangeTop: 0.25, maxAboveRangeTopHot: 0.60, hotVolX: 5, hotMinLiq: 50_000,
      addAtGains: [0.5, 1.2], addFraction: 0.5,   // adding to winners (19 Oct)
      /**
       * 20 Oct: the second-leg rule (dump, 1.8x recovery, 3 higher lows, then a breakout) never fired in 3 days, live
       * or in the lab. Blossom's ultra, its one steady earner, buys a plain breakout: PIERRE 2.3h old on 4.5x volume,
       * startupSI 19h old on 1.4x. false = breakout rule (a 5m close above the 2h range on 1.3x volume, not in a 6h
       * downtrend). true = the old second-leg rule, kept for the lab comparison.
       */
      secondLeg: false,
    },
    bounce: {
      scanEveryMs: 3 * 60_000,
      cooldownMs: 60 * 60_000,
      maxOpen: 4,
      // 20 Oct: $4 -> $8 (and the early crowd $2 -> $5) now bounce is live again. Nat: "2 dollar test sizes is kind of pointless".
      sizeUsd: 8,
      maxSinceMigrationH: 6,
      drawdownMin: 0.35, drawdownMax: 0.70, deadBelow: 0.80,
      baseHoldCandles5m: 3,
      reclaimVolX: 1.5,
      minLiquidity: 8_000, minHolders: 50, maxHolderDrop: 0.25,
      maxAboveLowX: 1.6,
      // Nat, 18 Oct: no bounce entries under $45k. Fresh graduations start ~$60k; well under that it has already dumped.
      mcapMin: 45_000,
      // 19 Oct: the floor cost us PIERRE (26x from $32k), mucron (18x from $43k), MEGA (10x), OPEQ (6.5x). Each had
      // thousands of holders and $34k+ of liquidity; the rugs it caught (PRIME, NVIDIA, GREEN) had ~$2k. So a coin
      // with a real crowd can enter from $25k, at half size.
      crowdMcapMin: 25_000, crowdHolders: 1_000, crowdLiquidity: 25_000, crowdSizeUsd: 5,
      /** Only bounce coins a trusted wallet bought in the last 6 hours. Off live; the lab tests it. */
      trustedOnly: false,
    },
    // 19 Oct: buy the first leg of a fresh migration (strategies/launch.ts). Nat: "we need to try everything".
    launch: {
      scanEveryMs: 60_000,
      cooldownMs: 2 * 3_600_000,
      maxOpen: 3,
      sizeUsd: 12,   // 19 Oct 16:12: was $3; thin pools (<$50k) halve it to $6. Fees ate launch's lab edge at $1.50-$3.
      checksPerScan: 15,
      maxSinceMigrationMin: 60,
      // 19 Oct: Blossom's best trade was PIERRE, an "ultra breakout" 2.3h old on 4.5x volume ($3 -> +$9.28).
      // From 1h to 6h after migration launch buys a breakout: a 5m close at a new high on a volume spike.
      breakoutMaxAgeH: 6, breakoutVolX: 3,
      // 20 Oct: first-leg buys (under 1h after migration) went 11 trades, 1 win, -$28.62 overnight; 8 were dumped to
      // ~$2k within 30 minutes. Blossom never buys a coin under an hour old. Launch now only buys breakouts from 1h on.
      // 20 Oct (later): back on so every mode is tested live, but stricter than the overnight version. A first leg also
      // needs the top 10 under firstLegMaxTop10% and holders up firstLegMinHolderGrowth in 10 minutes (the rugs had
      // concentrated holders and a flat crowd). Breakouts keep the normal rules.
      firstLeg: true, firstLegMaxTop10: 20, firstLegMinHolderGrowth: 0.10,
      // 19 Oct 11:30: pump.fun coins migrate at ~$27-38k with a $12-15k pool (UBI $27k/$12k, then 6.7x; WAND $31k/$13.5k).
      // The first numbers ($25k pool, $60k cap) meant waiting until a coin had already doubled.
      minLiquidity: 10_000, mcapMin: 25_000, mcapMax: 3_000_000,
      // 19 Oct 16:05: 40 buys in 5m refused the real pools (KAHO 36, UHI 36, HOOT 29). 20 still needs a crowd.
      minBuys5m: 20, minBuySell: 1.3,
      minHolders: 500, maxTop10: 35,
      maxOffHigh: 0.15, minGain15m: 0.10, maxCandleX: 1.6, minVolX: 1.0,
      // 35% (was 25%): the lab's "wider stop" row lost less (-$0.54 vs -$1.14 over 3 days). First legs shake hard.
      stopPct: 0.35, hardFloorPct: 0.40,
      // Adding to winners (19 Oct): half the first bid at +60% and again at +150% from the first entry.
      addAtGains: [0.6, 1.5], addFraction: 0.5,
    },
    pullback: {
      scanEveryMs: 2 * 60_000,
      cooldownMs: 2 * 3_600_000,
      maxOpen: 3,
      sizeUsd: 5,
      /** Qualify: up at least this much in the last hour (the old 3x hard skip). */
      minHourGainX: 2.0,
      maxAgeH: 24,
      minLiquidity: 20_000, minHolders: 150,
      retraceMin: 0.20, retraceMax: 0.40,
      holdCandles5m: 3,
      reclaimVolX: 1.3,
      maxAboveLowX: 1.25,
      addAtGains: [0.5, 1.2], addFraction: 0.5,   // adding to winners (19 Oct)
    },
    dip: {
      scanEveryMs: 5 * 60_000,
      cooldownMs: 12 * 3_600_000,
      // 21 Oct: 5 -> 8. All 5 slots were held by 19 Oct buys still under water, so at 06:40 dip saw AgenC (a Stonk.fun
      // flagship) and logged "mode full". Nat: "when you turn strategies off no bids get placed". Capital at risk is
      // still capped bot-wide (risk.maxCapitalAtRiskUsd).
      maxOpen: 8,
      // 19 Oct 16:12 (Nat): bigger bids. A fixed ~$0.25 round-trip network fee is ~6% of a $4 trade, 2.5% of $10.
      sizeUsd: 10,
      /** Pullback depth from the 24h high, judged on 5m candles. */
      dipMin: 0.06, dipMax: 0.30,
      /** Skip if the 24h move is still > +150% (overheated). */
      overheated24h: 150,
      minScore: 55,
      /** Reclaim candle: close at least this far above the dip low, on this multiple of average volume. */
      reclaimAboveLow: 1.01, reclaimVolX: 1.0,
      /** Skip a falling knife: down more than this % in the last hour (-100 = off). */
      maxDrop1h: -100,
      /**
       * 19 Oct: the entry trigger. "reclaim" = the first green 5m candle over the dip low (lost in every lab run: it buys
       * pauses in downtrends). "turn" = wait for the hourly chart to turn: a higher low, then an hourly close above the
       * last lower high. Nat: Stonk.fun coins look due for a bounce, "it might be a little early".
       */
      trigger: "turn" as "turn" | "reclaim",
      /** Turn rule only on flagships (pinned + Stonk.fun's biggest) and pinned coins. */
      flagshipsOnly: true,
      turnMaxDepth: 0.70, turnMaxAboveLow: 1.40,
      // Adding to winners (19 Oct): half the first bid at +25% and at +60%.
      addAtGains: [0.25, 0.6], addFraction: 0.5,
    },
    ride: {
      scanEveryMs: 3 * 60_000,
      maxLeaders: 2,
      /** Leader qualification. */
      minVol24h: 2_000_000, minLiquidity: 100_000,
      /** Core position: wide trail, meant to sit through the whole run. */
      coreSizeUsd: 8, coreTrailPct: 0.35, coreTrailAfterGain: 0.25, coreMaxLoss: 0.30,
      /** Trading sleeve: works the swings around the core. */
      sleeveSizeUsd: 8, sleeveTrailPct: 0.12, sleeveMaxLoss: 0.15,
      pullbackMin: 0.08, pullbackMax: 0.35,
      maxSleeveTradesPerDay: 6, reenterAfterWinMs: 30 * 60_000, reenterAfterLossMs: 2 * 3_600_000,
      /** Drop the leader when 1h volume falls under this fraction of its average, or it prints a 1h lower low. */
      fadeVolX: 0.3,
      /** Only ride Stonk.fun flagships and pinned coins. Off live; the lab tests it. */
      flagshipsOnly: false,
    },
    /** Nat's picks: the Buy button on Watching. No entry pattern needed; every safety check and guardrail still runs. */
    pick: {
      maxOpen: 3,
      sizeUsd: 4,
      minLiquidity: 10_000, minHolders: 100,
      backstopMs: 24 * 3_600_000,
    },
    trusted: {
      /** How often pushed webhook events are processed. */
      pollEveryMs: 60_000,
      /** Fallback Helius polling cadence when the webhook isn't delivering. 3 wallets x 96 polls x 100 credits ~ 29k/day. */
      heliusPollEveryMs: 15 * 60_000,
      maxOpen: 4,
      sizeUsd: 4, sizeUsdTwoWallets: 8, twoWalletWindowMs: 30 * 60_000,
      minScore: 50,
      /** Two+ trusted wallets within twoWalletWindowMs (20 Oct). */
      minScoreCluster: 40,
      mcapMax: 150_000,
      maxPump5m: 0.40,
      minLiquidity: 10_000, minHolders: 30,
      minHoldersAtMcap: { mcap: 80_000, holders: 500 },
      backstopMs: 24 * 3_600_000,
      heliusDailyCredits: 30_000,   // Helius free tier is ~1M credits/month
    },
  },
} as const;

export type Config = typeof config;

/** A mode's settings with literal types widened, so replay variants can override any number. */
type Widen<T> = { -readonly [K in keyof T]: T[K] extends number ? number : T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? Widen<T[K]> : T[K] };
export type ModeCfg<M extends keyof Config["modes"]> = Widen<Config["modes"][M]>;
