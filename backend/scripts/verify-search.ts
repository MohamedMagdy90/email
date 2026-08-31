// VERIFICATION — the new web-search pipeline, end to end, on a scratch DB.
// Deleted after the run. Never point this at data.sqlite: two processes on one
// WAL file is the documented way this project's local DB gets corrupted.
// SQLITE_PATH is set on the command line: static imports are hoisted above any
// assignment in this file, so db.ts would already have opened data.sqlite.

import { ensureSchema, q, nowIso } from "../src/db";
import { searchCompaniesDeep, MAX_RESULT_PAGE, searchEngineHealth, isNonProspectHost } from "../src/search";
import { registrableDomain } from "../src/crawler/urls";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${note ? ` — ${note}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${note ? ` — ${note}` : ""}`); }
};

console.log("\n=== A. schema + the retired sweep column ===");
await ensureSchema();
await q(`DELETE FROM discovery_sources WHERE id='v1'`); // re-runnable
await q(
  `INSERT INTO discovery_sources (id,type,location,category,audience,limit_n,interval_minutes,enabled,cursor,created_at)
   VALUES ('v1','search','Qatar','Companies (general)','customer',100,360,1,1,?)`,
  [nowIso()]
);
const row = (await q(`SELECT * FROM discovery_sources WHERE id='v1'`))[0] as any;
// RETIRED, and the column is only still here so old rows read. A ccTLD index
// lists every host in a country, not every business, so it filed `alabama.qa`
// and `agdoha2030.qa` as companies. Nothing may write a 1 into it now.
ok("sweep_country exists and defaults OFF", Number(row.sweep_country) === 0, `= ${row.sweep_country}`);

console.log("\n=== B. the query plan ===");
const { buildSearchPlanForTest } = await import("../src/discovery");
const plan = buildSearchPlanForTest(["MEP contractor", "steel fabrication"], "Qatar");
ok("plan has no ' contact' variants", !plan.some((s) => / contact$/.test(s)), `${plan.length} queries`);
ok("plan carries site: variants", plan.some((s) => s.includes("site:.qa")));
ok("every city query names the country", plan.filter((s) => s.includes("Doha")).every((s) => /Qatar|site:\.qa/.test(s)));
ok("plan is deduped", new Set(plan.map((s) => s.toLowerCase())).size === plan.length);
console.log(`     sample: ${plan.slice(0, 6).map((s) => `"${s}"`).join("  ")}`);

const bigPlan = buildSearchPlanForTest(
  ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], "Saudi Arabia"
);
ok("a country with 16 cities fans out", bigPlan.length > 300, `${bigPlan.length} queries for 10 keywords`);

console.log("\n=== C. deep search against the live pool ===");
const t0 = Date.now();
const deep = await searchCompaniesDeep("MEP contractor Qatar", { maxPages: MAX_RESULT_PAGE + 1, limit: 120, expectCountry: "Qatar" });
console.log(`     ${Date.now() - t0}ms · pages=${deep.pages} · engines=${[...new Set(deep.engines)].join(",") || "none"} · companies=${deep.companies.length} · blocked=${deep.blocked}`);
// Not an assertion: the free pool is allowed to be resting, and a page where
// every result is filtered out is a legitimate outcome too. What MUST hold is
// that whatever does come back is clean — asserted below.
if (!deep.companies.length) {
  console.log(`     ⚠ nothing came back this run (${deep.blocked ? "pool is resting" : "everything was filtered"}) — filter checks skipped.`);
}
if (deep.companies.length) {
  ok("no aggregator/social host survived the filters", !deep.companies.some((c) => isNonProspectHost(new URL(c.website).host)));
  ok("every company has a resolvable domain", deep.companies.every((c) => !!registrableDomain(new URL(c.website).host)));
  console.log(`     sample: ${deep.companies.slice(0, 5).map((c) => `${c.name} <${new URL(c.website).host}>`).join(" | ")}`);
}

console.log("\n=== D. a page nobody serves must NOT read as a rate limit ===");
// Page 9 is past every engine's depth. The old code reported that as `blocked`
// and bought a 3-30 minute backoff for it.
const { searchCompaniesPaged } = await import("../src/search");
const deepPage = await searchCompaniesPaged("MEP contractor Qatar", 9, 40, undefined, "Qatar");
ok("page 9 is 'unsupported', not 'blocked'", deepPage.blocked === false && deepPage.unsupported === true,
   `blocked=${deepPage.blocked} unsupported=${deepPage.unsupported}`);

console.log("\n=== E. the country sweep is retired ===");
// The kill switch has to hold even for a row that still CARRIES the flag —
// checking it ahead of the column is the whole point. Offline on purpose: a
// retired path must never be able to fail a run because a free public index
// happened to be resting.
const { buildSearchStepsForTest } = await import("../src/discovery");
const steps = await buildSearchStepsForTest({ id: "v1", category: "Companies (general)", keywords: null, sweep_country: 1 }, "Qatar");
const nQ = steps.filter((s: any) => s.kind === "query").length;
const nS = steps.filter((s: any) => s.kind === "sweep").length;
console.log(`     ${steps.length} steps = ${nQ} queries + ${nS} index pages`);
ok("the query plan is still built", nQ > 100, `${nQ} queries`);
ok("a source still flagged sweep_country=1 plans NO index pages", nS === 0);
const offSteps = await buildSearchStepsForTest({ id: "v1", category: "Companies (general)", keywords: null, sweep_country: 0 }, "Qatar");
ok("and neither does an unflagged one", offSteps.every((s: any) => s.kind === "query"));

console.log("\n=== F. the dormant sweep filter (kept for the one-line reversal) ===");
const { sweepTokensForTest, sweepHostMatchesForTest } = await import("../src/discovery");
const conTokens = sweepTokensForTest("Construction & Contracting", null);
ok("construction has URL tokens", conTokens.length > 0, conTokens.join(","));
ok("a contracting host matches", sweepHostMatchesForTest(["https://abhcontracting.com.qa/about"], "abhcontracting.com.qa", conTokens));
ok("a dental clinic does not", !sweepHostMatchesForTest(["https://smiledental.qa/offers"], "smiledental.qa", conTokens));
// A general sweep no longer keeps everything — that is what put `alabama.qa`
// and `akhlaquna.qa` in the pool. It now asks the same question as a category
// sweep, just with a much wider list of what a business looks like.
const generalTokens = sweepTokensForTest("Companies (general)", null);
ok("a general sweep still keeps a plain business", sweepHostMatchesForTest(["https://alarabtrading.qa/products"], "alarabtrading.qa", generalTokens));
ok("a general sweep drops a non-business host", !sweepHostMatchesForTest(["https://akhlaquna.qa/volunteer"], "akhlaquna.qa", generalTokens));
ok("custom keywords beat the table", sweepTokensForTest("Construction & Contracting", "marble, granite").includes("marble"));

console.log("\n=== G. engine health panel still reports ===");
const health = searchEngineHealth();
ok("health lists every engine", health.length === 4, health.map((h) => `${h.engine}${h.live ? "" : "(resting)"}`).join(" "));

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
