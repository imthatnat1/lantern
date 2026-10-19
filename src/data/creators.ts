/**
 * SERIAL CREATORS and SPOOFED CREATES (19 Oct, from Blossom).
 *
 * Blossom blocked GOKU because its creator made 33 launches in 30 days: a launch factory, not a team. Lantern was
 * already subscribed to every pump.fun create on PumpPortal and ignored them. Now each create is recorded
 * (mint, creator, time) for 30 days, so we can count a creator's launches. RugCheck's report is read too in case it
 * lists the creator's other tokens (rugcheck.ts), and the larger of the two counts is used.
 *
 * Blossom also counted 351 fake "create" events. A create only counts here if it passes cheap checks at the door
 * (all fields present and well formed, creator isn't the mint, the mint hasn't been created before, and it isn't a
 * coin we already knew was older). Before a count blocks a coin, a sample of that creator's mints is checked on
 * chain (they must exist as token mints); if most don't, the count is treated as spoofed and ignored.
 *
 * Local counts start from 19 Oct, so for the first weeks they undercount. That only makes the rule softer.
 */
import { db, kv } from "../db.js";
import { config } from "../config.js";
import { log } from "../log.js";

export const SERIAL_LAUNCHES = 10;
export const CREATOR_WINDOW_MS = 30 * 86_400_000;

db.exec(`CREATE TABLE IF NOT EXISTS pump_creates (
  mint TEXT PRIMARY KEY, creator TEXT NOT NULL, at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS pump_creates_creator ON pump_creates(creator, at);
CREATE INDEX IF NOT EXISTS pump_creates_at ON pump_creates(at);`);

const ins = db.prepare("INSERT OR IGNORE INTO pump_creates(mint, creator, at) VALUES(?,?,?)");
const seen = db.prepare("SELECT 1 FROM pump_creates WHERE mint=?");
const knownAge = db.prepare("SELECT created_at FROM market WHERE mint=?");

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export interface CreateEvent { mint?: string; creator?: string; signature?: string; at: number }

/** Why a create event looks fake, or null if it passes the door checks. Pure apart from two lookups. */
export function spoofWhy(e: CreateEvent): string | null {
  if (!e.mint || !e.creator || !e.signature) return "missing mint, creator or signature";
  if (!B58.test(e.mint) || !B58.test(e.creator)) return "malformed address";
  if (!SIG.test(e.signature)) return "malformed signature";
  if (e.creator === e.mint) return "creator is the mint";
  if (seen.get(e.mint)) return "mint was already created";
  const m = knownAge.get(e.mint) as { created_at?: number } | undefined;
  if (m?.created_at && e.at - m.created_at > 30 * 60_000) return "coin already existed before this 'create'";
  return null;
}

type Spoof = { at: number; mint: string; why: string };
/** Record a pump.fun create from PumpPortal. Returns false (and counts it) when it looks spoofed. */
export function recordCreate(e: CreateEvent): boolean {
  const why = spoofWhy(e);
  if (why) {
    kv.set("creates:spoofed", kv.get("creates:spoofed", 0) + 1);
    const recent = kv.get<Spoof[]>("creates:spoofRecent", []);
    recent.unshift({ at: e.at, mint: e.mint ?? "", why });
    kv.set("creates:spoofRecent", recent.slice(0, 20));
    return false;
  }
  ins.run(e.mint, e.creator, e.at);
  return true;
}

/** Launches by `creator` in the last 30 days, from our own record. */
export function localLaunches(creator: string, now = Date.now()): number {
  return (db.prepare("SELECT count(*) AS n FROM pump_creates WHERE creator=? AND at >= ?").get(creator, now - CREATOR_WINDOW_MS) as { n: number }).n;
}

/** Are this creator's recorded mints real token mints? Samples 3 on chain, cached 6h. null = couldn't check. */
const verified = new Map<string, { at: number; ok: boolean | null }>();
export async function launchesLookReal(creator: string, check = mintExists): Promise<boolean | null> {
  const hit = verified.get(creator);
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.ok;
  const mints = (db.prepare("SELECT mint FROM pump_creates WHERE creator=? ORDER BY at DESC LIMIT 3").all(creator) as { mint: string }[]).map(r => r.mint);
  let ok: boolean | null = null;
  if (mints.length) {
    const res = await Promise.all(mints.map(m => check(m).catch(() => null)));
    const known = res.filter((r): r is boolean => r != null);
    ok = known.length ? known.filter(Boolean).length * 2 >= known.length : null;
  }
  verified.set(creator, { at: Date.now(), ok });
  if (verified.size > 2000) verified.clear();
  return ok;
}

/** One Helius RPC call: does this mint account exist and belong to a token program? */
export async function mintExists(mint: string): Promise<boolean | null> {
  if (!config.keys.helius) return null;
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${config.keys.helius}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed" }] }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await res.json() as any;
  if (j?.error) return null;
  const v = j?.result?.value;
  return !!v && v?.data?.parsed?.type === "mint";
}

/**
 * Why this creator looks like a launch factory, or null. `rcCount` = launches RugCheck lists for the creator, if any.
 * The local count is only trusted when a sample of its mints really exists on chain.
 */
export async function serialCreatorWhy(creator: string | undefined, rcCount: number | undefined, now = Date.now(), check = mintExists): Promise<string | null> {
  if (!creator) return null;
  let local = localLaunches(creator, now);
  if (local >= SERIAL_LAUNCHES && (await launchesLookReal(creator, check)) === false) {
    log.warn({ creator: creator.slice(0, 6), local }, "creator's recorded launches look spoofed, ignoring them");
    local = 0;
  }
  const n = Math.max(local, rcCount ?? 0);
  return n >= SERIAL_LAUNCHES ? `serial creator: ${n} launches in 30 days` : null;
}

/** For /api/state health. */
export function createStats(now = Date.now()) {
  return {
    recorded24h: (db.prepare("SELECT count(*) AS n FROM pump_creates WHERE at > ?").get(now - 86_400_000) as { n: number }).n,
    spoofedTotal: kv.get("creates:spoofed", 0),
    recentSpoofs: kv.get<Spoof[]>("creates:spoofRecent", []).slice(0, 10),
  };
}

export function pruneCreates(now = Date.now()) {
  db.prepare("DELETE FROM pump_creates WHERE at < ?").run(now - CREATOR_WINDOW_MS);
}
