// VERIFICATION — the new web-search pipeline, end to end, on a scratch DB.
// Deleted after the run. Never point this at data.sqlite: two processes on one
// WAL file is the documented way this project's local DB gets corrupted.
// SQLITE_PATH is set on the command line: static imports are hoisted above any
// assignment in this file, so db.ts would already have opened data.sqlite.

import { ensureSchema, q, nowIso } from "../src/db";
import { searchCompaniesDeep, MAX_RESULT_PAGE, searchEngineHealth, isNonProspectHost } from "../src/search";
import { ccPageCount, ccHostsForPattern } from "../src/crawler/archives";
import { registrableDomain } from "../src/crawler/urls";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, note = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${note ? ` — ${note}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${note ? ` — ${note}` : ""}`); }
};

console.log("\n=== A. schema + the new column ===");
await ensureSchema();
await q(`DELETE FROM discovery_sources WHERE id='v1'`); // re-runnable
await q(
  `INSERT INTO discovery_sources (id,type,location,category,audience,limit_n,interval_minutes,enabled,cursor,created_at)
   VALUES ('v1','search','Qatar','Companies (general)','customer',100,360,1,1,?)`,
  [nowIso()]
);
const row = (await q(`SELECT * FROM discovery_sources WHERE id='v1'`))[0] as any;
ok("sweep_country exists and defaults ON", Number(row.sweep_country) === 1, `= ${row.sweep_country}`);

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

console.log("\n=== E. Common Crawl country index ===");
const pages = await ccPageCount("*.qa");
const ccUp = pages > 0;
if (!ccUp) {
  console.log("     ⚠ index.commoncrawl.org is not answering this IP right now — checking DEGRADATION instead.");
} else {
  ok("page count for *.qa resolves", true, `${pages} index pages`);
  const t1 = Date.now();
  const p0 = await ccHostsForPattern("*.qa", 0);
  console.log(`     page 0: ${Date.now() - t1}ms · records=${p0.records} · hosts=${p0.hosts.length}`);
  ok("index page 0 returns hosts", p0.ok && p0.hosts.length > 50);
  const domains = new Set(p0.hosts.map((h) => registrableDomain(h.host)).filter(Boolean));
  ok("hosts collapse to distinct registrable domains", domains.size > 20, `${domains.size} domains`);
  const prospects = [...domains].filter((d) => !isNonProspectHost(d!));
  ok("most swept domains survive the non-prospect gate", prospects.length > domains.size * 0.5,
     `${prospects.length}/${domains.size} kept`);
  console.log(`     sample: ${prospects.slice(0, 10).join(", ")}`);

  const past = await ccHostsForPattern("*.qa", 9999);
  ok("a page past the end reports pastEnd, not a failure", past.ok === true && past.pastEnd === true);
}

console.log("\n=== E2. the plan shape, with and without the index ===");
const { buildSearchStepsForTest } = await import("../src/discovery");
const steps = await buildSearchStepsForTest({ id: "v1", category: "Companies (general)", keywords: null, sweep_country: 1 }, "Qatar");
const nQ = steps.filter((s: any) => s.kind === "query").length;
const nS = steps.filter((s: any) => s.kind === "sweep").length;
console.log(`     ${steps.length} steps = ${nQ} queries + ${nS} index pages`);
ok("the plan is built either way", nQ > 100, `${nQ} queries`);
if (ccUp) {
  ok("sweep steps are present", nS > 0);
  // Never two heavy index calls in a row.
  let adjacent = 0;
  for (let i = 1; i < steps.length; i++) if (steps[i].kind === "sweep" && steps[i - 1].kind === "sweep") adjacent++;
  ok("index pages are interleaved, never back to back", adjacent === 0, `${adjacent} adjacent pairs`);
  const firstSweep = steps.findIndex((s: any) => s.kind === "sweep");
  ok("the first index page comes early, not after every query", firstSweep < nQ / 2, `at step ${firstSweep + 1}`);
} else {
  ok("with the index unreachable the source degrades to queries only", nS === 0 && nQ > 100);
}
const offSteps = await buildSearchStepsForTest({ id: "v1", category: "Companies (general)", keywords: null, sweep_country: 0 }, "Qatar");
ok("sweep_country=0 adds no index pages", offSteps.every((s: any) => s.kind === "query"));

console.log("\n=== F. category token filter ===");
const { sweepTokensForTest, sweepHostMatchesForTest } = await import("../src/discovery");
const conTokens = sweepTokensForTest("Construction & Contracting", null);
ok("construction has URL tokens", conTokens.length > 0, conTokens.join(","));
ok("a contracting host matches", sweepHostMatchesForTest(["https://abhcontracting.com.qa/about"], "abhcontracting.com.qa", conTokens));
ok("a dental clinic does not", !sweepHostMatchesForTest(["https://smiledental.qa/offers"], "smiledental.qa", conTokens));
ok("a general sweep keeps everything", sweepHostMatchesForTest(["https://smiledental.qa/"], "smiledental.qa", sweepTokensForTest("Companies (general)", null)));
ok("custom keywords beat the table", sweepTokensForTest("Construction & Contracting", "marble, granite").includes("marble"));

console.log("\n=== G. engine health panel still reports ===");
const health = searchEngineHealth();
ok("health lists every engine", health.length === 4, health.map((h) => `${h.engine}${h.live ? "" : "(resting)"}`).join(" "));

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
