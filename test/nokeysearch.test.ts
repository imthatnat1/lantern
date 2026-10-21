import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// 21 Oct (Grok's review): three scripts searched /root, /opt and /home for another bot's keys and copied them into
// Lantern. Nothing in this repo may look outside Lantern's own folder for secrets. This fails if one comes back.
test("no file in the repo searches the server for keys", () => {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n")
    .filter(f => f && !f.startsWith("test/") && !f.endsWith(".md") && !f.endsWith(".json") && !f.endsWith(".lock"));
  const bad: string[] = [];
  for (const f of files) {
    let src = "";
    try { src = readFileSync(f, "utf8"); } catch { continue; }
    for (const line of src.split("\n")) {
      if (/^\s*(#|\/\/|\*)/.test(line)) continue;   // comments may describe the old mistake
      if (/(grep|rg|find|execFileSync|readdir)/.test(line) && /\/root|\/home|["' ]\/opt["' ]/.test(line)) bad.push(`${f}: ${line.trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(bad, []);
});
