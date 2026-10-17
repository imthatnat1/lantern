import type { TokenSnapshot } from "../types.js";

const STOCKS = new Set(["TSLA","NVDA","AAPL","GME","AMC","MSFT","AMZN","GOOG","GOOGL","META","NFLX","AMD","COIN","MSTR","PLTR","HOOD","INTC","BABA","DIS","BA"]);
const ETFS = new Set(["SPY","QQQ","GLD","SLV","IWM","DIA","VTI","ARKK","TLT","USO"]);
const MAJORS = new Set(["BTC","ETH","SOL","XRP","BNB","DOGE","ADA","AVAX","LINK","DOT","TRX","TON","SUI","HYPE","ZEC","XMR","LTC","BCH","USDT","USDC"]);
const BRANDS = /\b(openai|chatgpt|claude|anthropic|grok|xai|tesla|spacex|nvidia|apple|google|microsoft|amazon|meta|netflix|disney|pepsi|coca.?cola|mcdonald|nike|adidas|starbucks|walmart)\b/i;

/** Copycat filter: stocks, ETFs, majors (incl. xStock-style suffixes), and brand clones. */
export function isCopycat(s: TokenSnapshot): string | null {
  const sym = s.symbol.toUpperCase().replace(/^\$/, "");
  const base = sym.replace(/X$/, "");
  if (STOCKS.has(sym) || STOCKS.has(base)) return "stock ticker";
  if (ETFS.has(sym) || ETFS.has(base)) return "etf ticker";
  if (MAJORS.has(sym) || MAJORS.has(base)) return "major ticker";
  if (BRANDS.test(s.name) || BRANDS.test(s.symbol)) return "brand clone";
  return null;
}

/** Slop filter from the 16 Oct lessons. Cheap signals that a launch is a template. */
export function isSlop(s: TokenSnapshot, holders: number | undefined): string | null {
  if (s.website) {
    try {
      const u = new URL(s.website);
      if (/\.(com\.co|xyz|top|icu|click|buzz|rest|monster)$/i.test(u.hostname)) return `cheap domain ${u.hostname}`;
      if (/x\.com\/i\/communities|twitter\.com\/i\/communities|facebook\.com/i.test(s.website)) return "social link as website";
    } catch { /* ignore bad urls */ }
  }
  if (holders !== undefined && s.mcapUsd > 80_000 && holders < 500) return `${holders} holders at $${(s.mcapUsd / 1000).toFixed(0)}k`;
  if (/^[A-Z]{3,6}\d{1,3}$/.test(s.symbol)) return "generated ticker";
  return null;
}

export function ageHours(s: TokenSnapshot, now = Date.now()): number {
  return (now - s.createdAt) / 3_600_000;
}
