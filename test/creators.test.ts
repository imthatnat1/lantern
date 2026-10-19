import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { recordCreate, spoofWhy, localLaunches, serialCreatorWhy, createStats, SERIAL_LAUNCHES } = await import("../src/data/creators.js");
const { stalledHolders } = await import("../src/data/flow.js");
const { creatorLaunches } = await import("../src/data/rugcheck.js");
const { activity } = await import("../src/server.js");

const B = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const addr = (seed: number, len = 44) => Array.from({ length: len }, (_, i) => B[(seed * 7 + i * 13) % B.length]).join("");
const sig = (seed: number) => addr(seed + 9000, 88);
const NOW = Date.UTC(2026, 9, 19, 9, 0);

test("spoofed creates are refused and counted; real ones are kept", () => {
  const goku = addr(1);
  assert.equal(spoofWhy({ mint: addr(100), creator: goku, signature: sig(1), at: NOW }), null);
  assert.ok(recordCreate({ mint: addr(100), creator: goku, signature: sig(1), at: NOW }));
  assert.equal(recordCreate({ mint: addr(100), creator: goku, signature: sig(2), at: NOW }), false, "same mint created twice");
  assert.equal(recordCreate({ mint: "not-a-mint", creator: goku, signature: sig(3), at: NOW }), false, "malformed");
  assert.equal(recordCreate({ mint: addr(101), creator: addr(101), signature: sig(4), at: NOW }), false, "creator is the mint");
  assert.equal(recordCreate({ mint: addr(102), creator: goku, at: NOW }), false, "no signature");
  assert.equal(createStats(NOW).spoofedTotal, 4);
  assert.equal(localLaunches(goku, NOW), 1);
});

test("a creator with 10+ launches in 30 days is a serial creator, unless its launches don't exist on chain", async () => {
  const factory = addr(2), fake = addr(3), normal = addr(4);
  for (let i = 0; i < 12; i++) recordCreate({ mint: addr(200 + i), creator: factory, signature: sig(200 + i), at: NOW - i * 86_400_000 });
  for (let i = 0; i < 12; i++) recordCreate({ mint: addr(300 + i), creator: fake, signature: sig(300 + i), at: NOW - i * 3_600_000 });
  for (let i = 0; i < 3; i++) recordCreate({ mint: addr(400 + i), creator: normal, signature: sig(400 + i), at: NOW });
  recordCreate({ mint: addr(500), creator: normal, signature: sig(500), at: NOW - 40 * 86_400_000 });
  const real = async () => true, missing = async () => false, unknown = async () => null;
  assert.match((await serialCreatorWhy(factory, undefined, NOW, real)) ?? "", /serial creator: 12 launches in 30 days/);
  assert.equal(await serialCreatorWhy(fake, undefined, NOW, missing), null, "spoofed launches ignored");
  assert.equal(await serialCreatorWhy(normal, undefined, NOW, real), null, "3 recent launches is fine; 40 days ago doesn't count");
  assert.match((await serialCreatorWhy(normal, 33, NOW, unknown)) ?? "", /33 launches/, "RugCheck's count (GOKU had 33) is used when bigger");
  assert.equal(await serialCreatorWhy(undefined, undefined, NOW, real), null);
  assert.equal(SERIAL_LAUNCHES, 10);
});

test("RugCheck's creator token list counts the last 30 days", () => {
  assert.equal(creatorLaunches(undefined, NOW), undefined);
  assert.equal(creatorLaunches([], NOW), undefined);
  assert.equal(creatorLaunches([{ createdAt: NOW - 86_400_000 }, { createdAt: new Date(NOW - 60 * 86_400_000).toISOString() }, { createdAt: Math.floor((NOW - 3_600_000) / 1000) }, {}], NOW), 3);
});

test("stalled holders: RUGRIOT shape is stopped, a growing crowd or an old coin is not", () => {
  const young = { createdAt: NOW - 5 * 3_600_000 };
  // RUGRIOT: 484 holders at $88k, flat.
  assert.match(stalledHolders({ ...young, mcapUsd: 88_000, change1h: 4 }, 484, 0.005, NOW) ?? "", /484 holders at \$88k/);
  // Price up 60% in the hour with no new holders, even with a decent crowd.
  assert.match(stalledHolders({ ...young, mcapUsd: 400_000, change1h: 60 }, 3_000, 0, NOW) ?? "", /price up 60% in the hour but no new holders/);
  assert.equal(stalledHolders({ ...young, mcapUsd: 88_000, change1h: 4 }, 484, 0.08, NOW), null, "holders growing");
  assert.equal(stalledHolders({ ...young, mcapUsd: 88_000, change1h: 4 }, 900, 0.0, NOW), null, "flat but a healthy crowd for its size");
  assert.equal(stalledHolders({ createdAt: NOW - 30 * 3_600_000, mcapUsd: 88_000, change1h: 40 }, 484, 0, NOW), null, "older than a day");
  assert.equal(stalledHolders({ ...young, mcapUsd: 88_000, change1h: 40 }, 484, null, NOW), null, "no hour of history yet");
  assert.equal(stalledHolders({ ...young, mcapUsd: 30_000, change1h: 40 }, 100, 0, NOW), null, "too small to judge");
});

test("the Last hour strip names the new rejections", async () => {
  const { db } = await import("../src/db.js");
  const cols = (db.prepare("PRAGMA table_info(signals_log)").all() as { name: string }[]).map(c => c.name);
  const now = Date.now();
  const row = (mint: string, reason: string) => {
    const v: Record<string, unknown> = { mode: "launch", mint, symbol: "X", score: 0, reason, at: now, taken: 0, price: 1, mcap: 50_000, size_usd: 0 };
    const keys = Object.keys(v).filter(k => cols.includes(k));
    db.prepare(`INSERT INTO signals_log(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map(k => v[k] as any));
  };
  row("S1", "rejected: serial creator: 33 launches in 30 days");
  row("S2", "rejected: stalled holders: 484 holders at $88k and no new holders in the hour");
  const a = activity(now) as any;
  assert.equal(a.rejectedBy["serial creator"], 1, JSON.stringify(a.rejectedBy));
  assert.equal(a.rejectedBy["stalled holders"], 1);
});
