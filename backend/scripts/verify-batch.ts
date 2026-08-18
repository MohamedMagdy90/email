// VERIFICATION — one REAL batch of a web-search source, end to end, scratch DB.
// SQLITE_PATH is set on the command line (static imports are hoisted).
import { ensureSchema, q, nowIso } from "../src/db";
import { runSourceNow } from "../src/discovery";
import { ccPageCount, ccHostsForPattern } from "../src/crawler/archives";

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

console.log("\n=== the country index, if it is answering ===");
const pages = await ccPageCount("*.qa");
if (!pages) {
  console.log("     ⚠ index.commoncrawl.org still refusing this IP — sweep not exercised this run.");
} else {
  // Informational only. A single direct call to a free public index is allowed
  // to be refused at any instant; what has to be true is that a BATCH gets
  // leads out of it, which is asserted below.
  const p = await ccHostsForPattern("*.qa", 0);
  console.log(`     direct probe: ${p.hosts.length} hosts from ${p.records} records${p.ok ? "" : " (declined right now)"}`);

  // Drive a REAL batch through an index step. The sweep steps are interleaved,
  // so the cursor has to be parked just before the first one — an assertion
  // about a code path nothing executes is worth nothing (the lesson from bug 31).
  const { buildSearchStepsForTest } = await import("../src/discovery");
  const plan = await buildSearchStepsForTest({ id: "b1", category: "Companies (general)", keywords: null, sweep_country: 1 }, "Qatar");
  const firstSweep = plan.findIndex((s: any) => s.kind === "sweep");
  ok("the plan really contains an index step", firstSweep >= 0, `at step ${firstSweep + 1} of ${plan.length}`);

  const before = Number(((await q(`SELECT count(*) AS n FROM discovered_leads`))[0] as any).n);
  await q(`UPDATE discovery_sources SET cursor=?, exhausted=0 WHERE id='b1'`, [firstSweep + 1]);
  console.log(`\n=== a batch STARTING on index page 1 (step ${firstSweep + 1}) ===`);
  const t1 = Date.now();
  await runSourceNow("b1");
  const after = Number(((await q(`SELECT count(*) AS n FROM discovered_leads`))[0] as any).n);
  console.log(`     ${Math.round((Date.now() - t1) / 1000)}s · pool ${before} → ${after}`);
  ok("the index step put real leads in the pool", after - before > 20, `+${after - before} from one sweep batch`);

  const swept = await q(`SELECT domain FROM discovered_leads ORDER BY id DESC LIMIT 12`);
  console.log(`     newest: ${swept.map((r: any) => r.domain).join(", ")}`);
  const src2 = (await q(`SELECT last_status, last_error FROM discovery_sources WHERE id='b1'`))[0] as any;
  ok("the sweep batch did not error", src2.last_status !== "error", src2.last_error || "clean");
}

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
