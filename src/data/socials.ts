/**
 * Does the coin have a community anywhere? (Nat, 18 Oct: "a few tokens with no website, banner, social links,
 * telegram, twitter links. They dont look good from a confidence point of view. No lore or community forming.")
 *
 * Two free sources:
 *  - DexScreener's token info (only there when someone claimed or paid for the profile).
 *  - The launch metadata the dev wrote when creating the coin (pump.fun and LaunchLab put twitter, telegram and
 *    website in the JSON at the token's metadata URI). RugCheck's report gives us that URI.
 *
 * A coin needs at least one real link: its own website, an X account or community, or a Telegram group.
 * A link to someone else's tweet (x.com/<anyone>/status/...) is borrowed lore, not a community, so it doesn't count.
 */
import { getJson } from "./http.js";

export interface Links { website?: string; twitter?: string; telegram?: string }

/** Sites that are a launchpad, chart or explorer page, not the coin's own website. */
const NOT_A_WEBSITE = /(^|\.)(pump\.fun|dexscreener\.com|stonkfun\.xyz|raydium\.io|letsbonk\.fun|bonk\.fun|solscan\.io|birdeye\.so|gmgn\.ai|photon-sol\.tinyastro\.io|jup\.ag|x\.com|twitter\.com|t\.me|telegram\.me|ipfs\.io)$/i;

/** Link-in-bio and hosted-page services: anyone can make a page there in a minute, so it isn't the coin's own site. */
const LINK_HUB = /(^|\.)(usepaid\.app|linktr\.ee|beacons\.ai|bio\.link|lnk\.bio|link3\.to|taplink\.cc|campsite\.bio|solo\.to|linkin\.bio|hoo\.be|withkoji\.com)$/i;

function url(u: unknown): URL | null {
  if (typeof u !== "string" || !u.trim()) return null;
  try { return new URL(/^https?:\/\//i.test(u.trim()) ? u.trim() : `https://${u.trim()}`); } catch { return null; }
}

/** Judge a set of links. Null means the coin has a real one; otherwise the reason it doesn't. */
export function judge(l: Links): { real: string[]; why: string | null } {
  const real: string[] = [];
  let borrowed = false;
  const tw = url(l.twitter);
  if (tw && /(^|\.)(x|twitter)\.com$/i.test(tw.hostname)) {
    const path = tw.pathname.replace(/\/+$/, "");
    if (/\/status\//i.test(path) || /^\/search/i.test(path) || /^\/hashtag/i.test(path)) borrowed = true;
    else if (/^\/i\/communities\/\d+/i.test(path) || /^\/[A-Za-z0-9_]{1,15}$/.test(path)) real.push("x");
  }
  const tg = url(l.telegram);
  if (tg && /(^|\.)(t\.me|telegram\.me)$/i.test(tg.hostname) && tg.pathname.replace(/\/+$/, "").length > 1) real.push("telegram");
  const web = url(l.website);
  let hosted: string | null = null;
  if (web && !NOT_A_WEBSITE.test(web.hostname) && web.hostname.includes(".")) {
    // safufun (19 Oct): its "website" was usepaid.app/t/zbcjs6hc, a page on someone else's app. A coin's own site lives
    // at its own domain's root (or one page deep, like /home). Deeper paths and link-in-bio hubs are someone else's site.
    const depth = web.pathname.split("/").filter(Boolean).length;
    if (depth >= 2 || LINK_HUB.test(web.hostname)) hosted = web.hostname.replace(/^www\./, "");
    else real.push("website");
  }
  // A website field holding an X or Telegram link still counts as that link.
  if (web && !real.length) {
    const j = judge({ twitter: /(x|twitter)\.com$/i.test(web.hostname) ? l.website : undefined, telegram: /t\.me$/i.test(web.hostname) ? l.website : undefined });
    real.push(...j.real);
    if (j.why?.startsWith("no community")) borrowed = true;
  }
  if (real.length) return { real, why: null };
  if (hosted) return { real, why: `no website of its own, only a page on ${hosted}${borrowed ? " and a link to someone else's tweet" : ""}` };
  return { real, why: borrowed ? "no community, only a link to someone else's tweet" : "no website or socials" };
}

/** Pull links out of launch metadata JSON. pump.fun puts them at the top level; some launchpads use `extensions`. */
export function linksFromMeta(m: any): Links {
  if (!m || typeof m !== "object") return {};
  const pick = (k: string): string | undefined => {
    for (const o of [m, m.extensions, m.properties, m.links, m.socials]) if (o && typeof o[k] === "string" && o[k].trim()) return o[k];
    return undefined;
  };
  return { website: pick("website") ?? pick("external_url"), twitter: pick("twitter") ?? pick("x"), telegram: pick("telegram") };
}

/** The same IPFS file from a few gateways, in case one is slow or down. */
export function metaUrls(uri: string): string[] {
  const cid = uri.match(/\/ipfs\/([A-Za-z0-9]+)/)?.[1] ?? uri.match(/^ipfs:\/\/([A-Za-z0-9]+)/)?.[1];
  const out = /^https?:\/\//i.test(uri) ? [uri] : [];
  if (cid) for (const g of ["https://ipfs.io/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://dweb.link/ipfs/"]) out.push(g + cid);
  return [...new Set(out)];
}

const cache = new Map<string, { at: number; links: Links | null }>();
const OK_TTL = 6 * 3_600_000, FAIL_TTL = 10 * 60_000;

/** Launch metadata links for a coin, cached. Null when the metadata couldn't be read. */
export async function launchLinks(mint: string, uri: string | undefined): Promise<Links | null> {
  if (!uri) return null;
  const c = cache.get(mint);
  if (c && Date.now() - c.at < (c.links ? OK_TTL : FAIL_TTL)) return c.links;
  let links: Links | null = null;
  for (const u of metaUrls(uri)) {
    try { links = linksFromMeta(await getJson<unknown>(u, { timeoutMs: 5000 })); break; } catch { /* next gateway */ }
  }
  cache.set(mint, { at: Date.now(), links });
  if (cache.size > 5000) for (const [k] of [...cache].slice(0, 1000)) cache.delete(k);
  return links;
}

/**
 * Nat's test (18 Oct, 21:26, after TTP passed the launch-metadata check): the links have to show on DexScreener.
 * Anyone can type a link into pump.fun's launch form; a DexScreener profile (links, banner) is claimed and paid for
 * by the team. Null when DexScreener shows at least one real link.
 */
export function dexProfileWhy(dex: Links): string | null {
  const j = judge(dex);
  if (!j.why) return null;
  if (j.why.startsWith("no website of its own")) return `${j.why} (DexScreener)`;
  return j.why.startsWith("no community") ? "no community on DexScreener, only a link to someone else's tweet" : "no links on DexScreener (no website, X or Telegram)";
}

/**
 * The launch-metadata check, used for Stonk.fun-listed coins (their page on Stonk.fun stands in for a DexScreener profile). Merges DexScreener's links with the launch metadata's.
 * Returns null when the coin has a real link, otherwise a rejection reason.
 */
export async function socialsWhy(mint: string, dex: Links, metaUri: string | undefined, fetchLinks = launchLinks): Promise<string | null> {
  const first = judge(dex);
  if (!first.why) return null;
  const meta = await fetchLinks(mint, metaUri);
  if (!meta) return dex.twitter || dex.website || dex.telegram ? first.why : "couldn't read its socials";
  return judge({ website: dex.website ?? meta.website, twitter: meta.twitter ?? dex.twitter, telegram: dex.telegram ?? meta.telegram }).why
    // Either source alone may have the real link (e.g. DexScreener a status link, metadata the X account).
    && judge(meta).why;
}

export function _resetSocials() { cache.clear(); }
