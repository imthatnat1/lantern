import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
const { config } = await import("../src/config.js");
const { bounceFloor } = await import("../src/strategies/bounce.js");
const C = config.modes.bounce;

test("bounce floor: $45k and up enters as before", () => {
  assert.deepEqual(bounceFloor(60_000, 10_000, 200, C), { why: null, crowd: false });
});

test("bounce floor: the runners we missed on 18-19 Oct now get in, at the crowd size", () => {
  // PIERRE $32k/$84k pool/7,612 holders (ran 26x), mucron $43k/$34k/12,658 (18x), MEGA $43k/$34k/7,305 (10x), OPEQ $33k/$34k/2,336 (6.5x)
  for (const [mcap, liq, holders] of [[31_702, 84_000, 7_612], [43_500, 34_000, 12_658], [43_000, 34_000, 7_305], [33_000, 34_000, 2_336]])
    assert.deepEqual(bounceFloor(mcap, liq, holders, C), { why: null, crowd: true }, `${mcap}`);
  assert.equal(C.crowdSizeUsd, 2);
});

test("bounce floor: the rugs it caught stay out (thin pools, few holders)", () => {
  // PRIME/NVIDIA had ~$2k pools and 142 holders; GREEN $2k and 612 holders
  assert.match(bounceFloor(40_000, 2_000, 142, C).why!, /without a \$25k pool/);
  assert.match(bounceFloor(40_000, 30_000, 612, C).why!, /612 holders/);
  assert.match(bounceFloor(20_000, 80_000, 9_000, C).why!, /under the \$25k bounce floor/);
});

test("bounce floor: before holders are known, a big enough pool passes to the safety check", () => {
  assert.deepEqual(bounceFloor(30_000, 40_000, undefined, C), { why: null, crowd: true });
});
