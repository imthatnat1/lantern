export type Mode = "ultra" | "bounce" | "pullback" | "trusted" | "dip" | "ride";

export interface Candle {
  t: number;      // unix ms, candle open
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;      // USD volume
}

export interface TokenSnapshot {
  mint: string;
  symbol: string;
  name: string;
  pairAddress?: string;
  quoteSymbol?: string;
  priceUsd: number;
  liquidityUsd: number;
  mcapUsd: number;
  volume24h: number;
  volume1h: number;
  volume5m: number;
  buys5m: number;
  sells5m: number;
  /** Last hour's transaction counts. Optional: older recorded snapshots don't have them. */
  buys1h?: number;
  sells1h?: number;
  change5m: number;   // percent
  change1h: number;
  change6h: number;
  change24h: number;
  createdAt: number;  // unix ms
  holders?: number;
  migratedAt?: number;
  onCurve: boolean;
  website?: string;
  twitter?: string;
  imageUrl?: string;
  fetchedAt: number;
}

export interface SafetyResult {
  ok: boolean;
  reasons: string[];
  top10Pct?: number;
  insiders?: number;
  holders?: number;
  lpLockedPct?: number;
  creator?: string;
  /** Share held by wallets RugCheck labels as snipers, bundles or fresh. Strategies take up to 20 points off. */
  sniperPct?: number;
}

export interface ExitPlan {
  /** Hard stop on any tick. Only fires on a sanity-confirmed price. Fraction of entry (0.45 = -55%). */
  hardFloorPct: number;
  /** Close-based stop: absolute price. Judged on 15m candle closes. */
  closeStopPrice: number;
  /** Take profit ladder: gain fraction -> sell fraction. */
  takeProfits: { gain: number; sell: number }[];
  /** Trailing stop as fraction below peak close, activates after `trailAfterGain`. */
  trailPct: number;
  trailAfterGain: number;
  /** Progressive trail tightening by peak gain, optional. */
  trailLadder?: { peakGain: number; trailPct: number }[];
  /** Soft time exit in ms, with condition checked by the strategy. 0 = none. */
  maxHoldMs: number;
}

export interface Position {
  id: number;
  mode: Mode;
  mint: string;
  symbol: string;
  entryPrice: number;
  entryAt: number;
  qty: number;           // tokens
  remainingQty: number;
  costUsd: number;
  peakPrice: number;
  peakClose: number;
  lastGoodPrice: number;
  lastGoodAt: number;
  atr15: number;
  liquidityAtEntry: number;
  plan: ExitPlan;
  tpTaken: number[];     // indexes of takeProfits already filled
  realizedUsd: number;
  status: "open" | "closed";
  closedAt?: number;
  closeReason?: string;
  meta: Record<string, unknown>;
}

export interface Fill {
  side: "buy" | "sell";
  mint: string;
  mode: Mode;
  qty: number;
  priceUsd: number;    // effective price after slippage
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
  reason: string;
  at: number;
}

export interface Signal {
  mode: Mode;
  mint: string;
  symbol: string;
  sizeUsd: number;
  score: number;
  reason: string;
  snapshot: TokenSnapshot;
  candles15: Candle[];
  plan: (entryPrice: number, atr15: number) => ExitPlan;
  meta?: Record<string, unknown>;
}
