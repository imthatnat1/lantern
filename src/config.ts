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
    dailyLossStopUsd: 30,
    drawdownHaltPct: 0.20,      // halt when equity < 80% of peak
    maxCapitalAtRiskUsd: 180,
    maxSingleTradeUsd: 40,
    vaultShare: 0.5,            // of realized profit
    feedStaleMs: 60_000,
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
  },

  minExitLiquidityUsd: <Record<Mode, number>>{
    ultra: 8_000,
    bounce: 8_000,
    pullback: 8_000,
    trusted: 8_000,
    dip: 20_000,
    ride: 50_000,
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
    },
    bounce: {
      scanEveryMs: 3 * 60_000,
      cooldownMs: 60 * 60_000,
      maxOpen: 4,
      sizeUsd: 4,
      maxSinceMigrationH: 6,
      drawdownMin: 0.35, drawdownMax: 0.70, deadBelow: 0.80,
      baseHoldCandles5m: 3,
      reclaimVolX: 1.5,
      minLiquidity: 8_000, minHolders: 50, maxHolderDrop: 0.25,
      maxAboveLowX: 1.6,
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
    },
    dip: {
      scanEveryMs: 5 * 60_000,
      cooldownMs: 12 * 3_600_000,
      maxOpen: 5,
      sizeUsd: 8,
      /** Pullback depth from the 24h high, judged on 5m candles. */
      dipMin: 0.06, dipMax: 0.30,
      /** Skip if the 24h move is still > +150% (overheated). */
      overheated24h: 150,
      minScore: 55,
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
    },
    trusted: {
      pollEveryMs: 100_000,
      maxOpen: 4,
      sizeUsd: 4, sizeUsdTwoWallets: 8, twoWalletWindowMs: 30 * 60_000,
      minScore: 50,
      mcapMax: 150_000,
      maxPump5m: 0.40,
      minLiquidity: 10_000, minHolders: 30,
      minHoldersAtMcap: { mcap: 80_000, holders: 500 },
      backstopMs: 24 * 3_600_000,
      heliusDailyCredits: 4_500,
    },
  },
} as const;

export type Config = typeof config;
