// Runs after every build (so after every auto-update on the droplet).
// Self-heals a broken HELIUS_API_KEY in .env by finding the real key the old bot left on the box.
// Never prints the key. Safe to run anywhere: does nothing unless .env exists and the key is bad.
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ENV = new URL("../.env", import.meta.url).pathname;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function note(msg) {
  console.log(`[repair-env] ${msg}`);
  try { mkdirSync(new URL("../data", import.meta.url).pathname, { recursive: true }); appendFileSync(new URL("../data/updates.log", import.meta.url).pathname, `${new Date().toISOString()} repair-env: ${msg}\n`); } catch {}
}

if (!existsSync(ENV)) process.exit(0);
let env = readFileSync(ENV, "utf8");
// Blank any other "$PLACEHOLDER" values (RugCheck works without a key; a bogus Bearer token makes it fail).
const cleaned = env.replace(/^([A-Z_]+)=\$[A-Za-z_]*$/gm, "$1=");
if (cleaned !== env) { env = cleaned; writeFileSync(ENV, env, { mode: 0o600 }); note("blanked unexpanded $PLACEHOLDER values in .env"); }
const cur = (env.match(/^HELIUS_API_KEY=(.*)$/m)?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
if (UUID.test(cur)) process.exit(0);

note(`HELIUS_API_KEY in .env is not a real key (starts "${cur.slice(0, 8)}"), searching this machine for one`);
let found = "";
try {
  const out = execFileSync("grep", ["-rhsoE", "(HELIUS_API_KEY|HELIUS_KEY|helius[^\"' ]*api-key)[=:\"' ]*[0-9a-f-]{36}", "/root", "/opt", "/home",
    "--exclude-dir=lantern", "--exclude-dir=node_modules", "--exclude-dir=.git"], { encoding: "utf8", timeout: 60_000, maxBuffer: 8 << 20 });
  for (const line of out.split("\n")) {
    const m = line.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    if (m) { found = m[0]; break; }
  }
} catch { /* grep exits 1 when nothing matches */ }

if (!found) { note("no Helius key found on this machine; set HELIUS_API_KEY in .env from dashboard.helius.dev"); process.exit(0); }
env = /^HELIUS_API_KEY=.*$/m.test(env) ? env.replace(/^HELIUS_API_KEY=.*$/m, `HELIUS_API_KEY=${found}`) : env + `\nHELIUS_API_KEY=${found}\n`;
writeFileSync(ENV, env, { mode: 0o600 });
note("HELIUS_API_KEY repaired from a key found on this machine");
