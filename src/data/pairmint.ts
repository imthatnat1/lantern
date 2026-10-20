/**
 * Which coin each pool prices (pair address -> our coin's mint), learned from DexScreener, whose base token is always
 * the coin we asked about. 21 Oct: GeckoTerminal lists many Stonk.fun pools the other way round (base = ZEC, quote =
 * ZCAT), so its charts and trade sides described ZEC/NEAR, not our coin. Every GeckoTerminal call now names the coin.
 */
const byPair = new Map<string, string>();
export function notePairMint(pair: string | undefined, mint: string | undefined): void {
  if (!pair || !mint) return;
  byPair.set(pair, mint);
  if (byPair.size > 20_000) byPair.clear();
}
export function mintForPair(pair: string): string | undefined { return byPair.get(pair); }
