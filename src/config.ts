import "dotenv/config";
import type { Mode } from "./types.js";

const env = (k: string, d = "") => process.env[k] ?? d;
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};

export const config = {
  keys: {
    helius: env("HELIUS_API_KEY"),
    rugcheck: env("RUGCHECK_API_KEY"),
    xBearer: env("X_BEARER_TOKEN"),
    anthropic: env("ANTHROPIC_API_KEY"),
  },
  trustedWallets: env("TRUSTED_WALLETS").split(",").map(s => s.trim()).filter(Boolean),
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
  },

  allocation: <Record<Mode, number>>{
    ultra: 0.40,
    bounce: 0.20,
    pullback: 0.25,
    trusted: 0.15,
  },

  minExitLiquidityUsd: <Record<Mode, number>>{
    ultra: 8_000,
    bounce: 8_000,
    pullback: 8_000,
    trusted: 8_000,
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
