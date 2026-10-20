import { test } from "node:test";
import assert from "node:assert/strict";
const { pruneCache, _cacheSize, _cacheSet } = await import("../src/data/http.js");

test("response cache stays bounded: expired entries go first, then the oldest", () => {
  for (let i = 0; i < 2500; i++) _cacheSet(`https://x/old${i}`, 0, 1000);        // long expired
  for (let i = 0; i < 1000; i++) _cacheSet(`https://x/fresh${i}`, 10_000, 60_000);
  pruneCache(20_000);
  assert.equal(_cacheSize(), 1000);
  for (let i = 0; i < 4000; i++) _cacheSet(`https://x/new${i}`, 20_000, 60_000);  // all fresh, over the cap
  pruneCache(21_000);
  assert.ok(_cacheSize() <= 2400);
});
