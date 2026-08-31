// VERIFICATION — one REAL batch of a web-search source, end to end, scratch DB.
// SQLITE_PATH is set on the command line (static imports are hoisted).
import { ensureSchema, q, nowIso } from "../src/db";
import { runSourceNow } from "../src/discovery";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${note ? ` — ${note}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${note ? ` — ${note}` : ""}`); }
};

await ensureSchema();
await q(`DELETE FROM discovered_leads`);
await q(`DELETE FROM discovery_sources`);
await q(
  `INSERT INTO discovery_sources (id,type,location,category,audience,limit_n,interval_minutes,enabled,cursor,created_at)
   VALUES ('b1','search','Qatar','Companies (general)','customer',100,360,1,1,?)`,
  [nowIso()]
);

console.log("\n=== one real batch ===");
const t0 = Date.now();
const r = await runSourceNow("b1");
console.log(`     ${Math.round((Date.now() - t0) / 1000)}s · found=${r.found}${r.error ? ` · error=${r.error}` : ""}`);

const leads = await q(`SELECT name, domain, website, country, enriched FROM discovered_leads ORDER BY domain`);
ok("the batch inserted leads", leads.length > 0, `${leads.length} in the pool`);
ok("every lead has a domain", leads.every((l: any) => !!l.domain));
ok("every lead is queued for enrichment", leads.every((l: any) => Number(l.enriched) === 0));
ok("country resolved for most leads", leads.filter((l: any) => l.country).length > leads.length * 0.5,
   `${leads.filter((l: any) => l.country).length}/${leads.length}`);
ok("no duplicate domains", new Set(leads.map((l: any) => l.domain)).size === leads.length);
console.log(`     sample: ${leads.slice(0, 8).map((l: any) => `${l.domain}`).join(", ")}`);

const src = (await q(`SELECT cursor, last_status, last_error, total_found, block_streak FROM discovery_sources WHERE id='b1'`))[0] as any;
console.log(`     source now: cursor=${src.cursor} status=${src.last_status} total_found=${src.total_found} block_streak=${src.block_streak}${src.last_error ? ` err="${src.last_error}"` : ""}`);
ok("the cursor advanced past the steps it covered", Number(src.cursor) > 1, `step ${src.cursor}`);
ok("a healthy batch did not record a rate limit", src.last_status !== "error");

console.log("\n=== the country sweep stays out of a real batch ===");
// It used to run here: index pages interleaved into the plan, driven for real
// against index.commoncrawl.org. Retired — a ccTLD lists every host in a
// country, not every business, so those steps filed portals and parked domains
// as companies. The check that matters now is that a source can no longer walk
// one, even when its row still carries the old flag.
await q(`UPDATE discovery_sources SET sweep_country=1 WHERE id='b1'`);
const { buildSearchStepsForTest } = await import("../src/discovery");
const flagged = (await q(`SELECT * FROM discovery_sources WHERE id='b1'`))[0] as any;
const plan = await buildSearchStepsForTest(flagged, "Qatar");
ok("the plan is all queries, no index pages", plan.every((s: any) => s.kind === "query"), `${plan.length} steps`);

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
