/**
 * Regression test for the "web search returns rubbish" incident.
 *
 * Every case below is a REAL result captured from the live engines while
 * diagnosing it — the encyclopedia pages, the US contractors returned for a
 * `site:.sa` query, the Qatari hosts that must survive, and the non-companies
 * the country sweep was filing. Offline and deterministic: it makes no network
 * calls, so it runs in CI and cannot be flaky.
 */
import { intentFor, hitSatisfies, companyNameFromTitle } from "../src/search";
import { sweepHostMatchesForTest, sweepTokensForTest } from "../src/discovery";
import { placeTermsFor, tldFor } from "../src/places";

let failures = 0;
function check(ok: boolean, what: string, detail = "") {
  if (ok) return;
  failures++;
  console.log(`  ✗ ${what}${detail ? ` — ${detail}` : ""}`);
}
function section(title: string) {
  console.log(`\n${title}`);
}

/* ─────────────────── 1. the engine that ignores the query ─────────────────── */
section("1. results that do not answer the query are rejected");

const qaIntent = intentFor("steel fabrication site:.qa", "Qatar");
check(qaIntent.site === "qa", "site: operator is parsed", JSON.stringify(qaIntent.site));

// Verbatim from a live `steel fabrication site:.qa` — Bing dropped the operator.
const bingLies = [
  { url: "https://en.m.wikipedia.org/wiki/Steel", title: "Steel - Wikipedia" },
  { url: "https://www.britannica.com/technology/steel", title: "Steel | Composition, Properties, Types, Grades, & Facts" },
  { url: "https://www.metalsdepot.com/", title: "Metals Depot - Buy Metal Online! Steel, Aluminum, Stainless, Brass" },
  { url: "https://www.merriam-webster.com/dictionary/steel", title: "STEEL Definition & Meaning - Merriam-Webster" },
  { url: "https://worldsteel.org/about-steel/", title: "What is steel? - worldsteel.org" },
  { url: "https://www.xometry.com/resources/materials/steel/", title: "Steel: Definition, Composition, Types, Properties, and Applications" },
  { url: "https://www.steel.org/", title: "The Voice of the American Steel Industry | American Iron and Steel" },
];
for (const h of bingLies) {
  check(!hitSatisfies(h, qaIntent), `rejected off-target result`, h.url);
}

// Verbatim from a live `construction company site:.sa` — eight US contractors.
const saIntent = intentFor("construction company site:.sa", "Saudi Arabia");
for (const u of ["https://schimenti.com/", "https://www.sundt.com/", "https://plantconstruction.com/", "https://swinerton.com/", "https://jedunn.com/"]) {
  check(!hitSatisfies({ url: u, title: "Construction Company" }, saIntent), "rejected US contractor on a .sa query", u);
}

// The genuine Qatari results from the same query set MUST still pass.
const realQa = [
  "https://wadux.com.qa/services/mep-works/",
  "https://cetc.qa/mep-contracting/",
  "https://www.qatcon.qa/popular-category/mep-_-contractors-in-qatar",
  "https://zayfa.qa/mep-works/",
  "https://www.debaj.com.qa/",
  "https://eaglestarcontracting.qa/",
];
for (const u of realQa) {
  check(hitSatisfies({ url: u, title: "MEP Works" }, qaIntent), "kept a genuine .qa company", u);
}

/* ───────────── 2. locality without a site: operator (Gulf .com firms) ───────────── */
section("2. a Gulf company on a .com is kept when it says where it is");

const plain = intentFor("MEP contractor Qatar", "Qatar");
check(!plain.site, "no site: operator on a plain query");
check(
  hitSatisfies({ url: "https://aljaber-group.com/", title: "Al Jaber Group", snippet: "A leading contracting group in Doha, Qatar since 1978." }, plain),
  "kept a .com firm whose snippet names the country"
);
check(
  hitSatisfies({ url: "https://dohasteel.com/", title: "Doha Steel" }, plain),
  "kept a .com firm whose domain names the city"
);
check(
  !hitSatisfies({ url: "https://mepacademy.com/", title: "MEP Academy", snippet: "Learn MEP design and estimating." }, plain),
  "rejected the US site Bing returned for the same query"
);
check(
  !hitSatisfies({ url: "https://samyangamerica.com/", title: "SAMYANG AMERICA" }, plain),
  "rejected samyangamerica.com"
);

// The homonym trap the place list must not fall into.
check(
  !hitSatisfies({ url: "https://hailrepairtexas.com/", title: "Hail Damage Repair — free quote" }, intentFor("steel fabrication Hail Saudi Arabia", "Saudi Arabia")),
  "‘hail damage’ is not evidence of Hail, Saudi Arabia"
);
check(
  !hitSatisfies({ url: "https://insurance-brokers.co.uk/", title: "Insurance brokers" }, intentFor("trading company Sur Oman", "Oman")),
  "‘insurance’ is not evidence of Sur, Oman"
);

/* ─────────────────────── 3. titles that are not names ─────────────────────── */
section("3. encyclopedia and truncated titles never become company names");

const badNames: [string, string][] = [
  ["Steel: Definition, Composition, Types, Properties, and Applications", "xometry.com"],
  ["Solution: Definition, Components, Types, and Examples", "chemistrylearner.com"],
  ["STEEL Definition & Meaning - Merriam-Webster", "merriam-webster.com"],
  ["What is steel? - worldsteel.org", "worldsteel.org"],
];
for (const [title, domain] of badNames) {
  check(companyNameFromTitle(title, domain) === null, "refused a reference-page title", title.slice(0, 45));
}

const truncated = companyNameFromTitle('Commercial Mechanical, March Electrical and Plumbing 2026 (“MEP', "currentcap.com");
check(!!truncated && !truncated.includes("(“"), "repaired a title cut mid-bracket", String(truncated));

// Real names must survive untouched.
const goodNames: [string, string, string][] = [
  ["MEP Works – Wadux Trading & Contracting", "wadux.com.qa", "Wadux Trading & Contracting"],
  ["DEBAJ Industrial Services W.L.L.", "debaj.com.qa", "DEBAJ Industrial Services W.L.L."],
];
for (const [title, domain, want] of goodNames) {
  const got = companyNameFromTitle(title, domain);
  check(got === want, "kept a real company name", `${JSON.stringify(got)} != ${JSON.stringify(want)}`);
}

/* ──────────────────── 4. the country sweep stops filing non-companies ──────────────────── */
section("4. the country sweep keeps businesses and drops the rest");

const generalTokens = sweepTokensForTest("Companies (general)", null);
check(generalTokens.length > 0, "the general category has real tokens now (it used to keep everything)");

const sweepReject = [
  ["alabama.qa", ["https://alabama.qa/"]],
  ["agdoha2030.qa", ["https://agdoha2030.qa/about"]],
  ["akhlaquna.qa", ["https://akhlaquna.qa/volunteer"]],
  ["mofa.gov.qa", ["https://mofa.gov.qa/en/home"]],
  ["blog.someone.qa", ["https://blog.someone.qa/posts/1"]],
] as [string, string[]][];
for (const [host, urls] of sweepReject) {
  check(!sweepHostMatchesForTest(urls, host, generalTokens), "sweep rejected a non-company", host);
}

const sweepKeep = [
  ["alhussainialuminium.qa", ["https://alhussainialuminium.qa/products"]],
  ["wadux.com.qa", ["https://wadux.com.qa/services/mep-works/"]],
  ["almanhalwaters.qa", ["https://almanhalwaters.qa/products/water"]],
] as [string, string[]][];
for (const [host, urls] of sweepKeep) {
  check(sweepHostMatchesForTest(urls, host, generalTokens), "sweep kept a real business", host);
}

// The `.com` in every URL must not be what makes a host match.
check(
  !sweepHostMatchesForTest(["https://randomblogsite.com.qa/2019/07/hello-world"], "randomblogsite.com.qa", generalTokens),
  "a bare .com.qa address is not itself evidence of a business"
);

/* ────────────────────────── 5. the shared place table ────────────────────────── */
section("5. places resolve the same way for the planner and the verifier");

check(tldFor("Qatar") === "qa", "Qatar → qa");
check(tldFor("KSA") === "sa", "KSA → sa");
check(tldFor("Doha") === "qa", "a bare city resolves to its country's ccTLD");
check(placeTermsFor("Qatar").includes("doha"), "Qatar's place terms include its cities");
check(placeTermsFor("UAE").includes("dubai"), "UAE resolves through its alias");

console.log(
  failures === 0
    ? "\n✅ all checks passed\n"
    : `\n❌ ${failures} check(s) failed\n`
);
process.exit(failures === 0 ? 0 : 1);
