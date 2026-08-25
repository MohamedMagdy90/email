// Offline proof that "Re-check emails" no longer re-arms its own queue.
//
// The bug it guards: enrichOne() parked a lead it had given up on as
// `enriched=1, enrich_status='blocked'`, and that was ALSO the exact predicate
// the recovery tool selected on — so every press re-queued the rows it had just
// parked, burned a crawl each re-proving the same wall, and left the badge
// reading the number it started with.
//
//   bun run scripts/verify-recheck.ts
process.env.SQLITE_PATH = "/tmp/recheck-verify.sqlite";
import { unlinkSync, existsSync } from "node:fs";
for (const s of ["", "-wal", "-shm"]) {
  const f = process.env.SQLITE_PATH + s;
  if (existsSync(f)) unlinkSync(f);
}

const { q, ensureSchema, nowIso, setSetting } = await import("../src/db");
const { getDiscoveryStatus, reEnrichBlocked } = await import("../src/discovery");

await ensureSchema();

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `  -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const uid = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

async function seedLead(o: {
  status?: string;
  email?: string | null;
  website?: string | null;
  enriched?: number;
  enrich_status?: string | null;
} = {}) {
  const id = uid();
  await q(
    `INSERT INTO discovered_leads (id,dedup_key,name,website,domain,email,status,enriched,enrich_status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id, "d:" + id, "Co " + id,
      o.website === undefined ? `https://${id}.qa/` : o.website,
      `${id}.qa`,
      o.email ?? null,
      o.status ?? "pending",
      o.enriched ?? 1,
      o.enrich_status === undefined ? "blocked" : o.enrich_status,
      nowIso(),
    ]
  );
  return id;
}

// Exactly what enrichOne does when the retry ladder runs out.
function park(ids: string[]) {
  return q(
    `UPDATE discovered_leads SET enriched=1, retry_count=2, enrich_status='blocked', next_enrich_at=NULL
      WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids
  );
}
const enrichingNow = async () =>
  Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE enriched=0`))[0].n);

/* --- 166 parked leads: the exact pool the report was about --- */
const parked: string[] = [];
for (let i = 0; i < 166; i++) parked.push(await seedLead());

// Controls. None of these may ever be touched by the recovery tool.
await seedLead({ enrich_status: "empty" });                  // site loaded, publishes no email
await seedLead({ enrich_status: "found", email: "a@b.qa" }); // resolved
await seedLead({ website: null, enrich_status: null });      // nothing to crawl
await seedLead({ status: "approved" });                      // already out of the pool

console.log("\n-- pass 1: the button is armed --");
let s = await getDiscoveryStatus();
check("recoverable = 166", s.recoverable, 166);
check("stuck = 0", s.stuck, 0);

let r = await reEnrichBlocked();
check("re-check re-queues 166", r.reset, 166);
check("nothing re-armed by a config change", r.reArmed, 0);
check("only those 166 were reset", await enrichingNow(), 166);

console.log("\n-- the crawls fail again, exactly as before --");
await park(parked);
s = await getDiscoveryStatus();
check("recoverable = 0   <- used to be 166, for ever", s.recoverable, 0);
check("stuck = 166", s.stuck, 166);
check("lastRecheckAt recorded", typeof s.lastRecheckAt === "string", true);

console.log("\n-- pass 2: pressing again cannot loop --");
r = await reEnrichBlocked();
check("re-check re-queues 0", r.reset, 0);
check("reports 166 stuck", r.stuck, 166);
check("not one lead was re-crawled", await enrichingNow(), 0);

console.log("\n-- a NEWLY parked lead is still offered, alongside the stuck ones --");
const fresh = await seedLead();
s = await getDiscoveryStatus();
check("recoverable = 1", s.recoverable, 1);
check("stuck still 166", s.stuck, 166);
r = await reEnrichBlocked();
check("re-queues just the new one", r.reset, 1);
await park([fresh]);
check("then it joins them", (await getDiscoveryStatus()).stuck, 167);

console.log("\n-- the operator adds a Jina key: everything is re-armed --");
await setSetting("jina_api_key", "jina_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
s = await getDiscoveryStatus();
check("recoverable = 167", s.recoverable, 167);
check("stuck = 0", s.stuck, 0);
r = await reEnrichBlocked();
check("re-queues 167", r.reset, 167);
check("all 167 reported as re-armed by the change", r.reArmed, 167);

console.log("\n-- they fail again under the new key --");
await park([...parked, fresh]);
s = await getDiscoveryStatus();
check("recoverable back to 0", s.recoverable, 0);
check("stuck = 167", s.stuck, 167);

console.log("\n-- removing a key is a change too, so it re-arms --");
await setSetting("jina_api_key", "");
check("recoverable = 167", (await getDiscoveryStatus()).recoverable, 167);
await setSetting("jina_api_key", "jina_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
check("restoring it puts them back to stuck", (await getDiscoveryStatus()).recoverable, 0);

console.log("\n-- a scraping proxy re-arms them on its own --");
await setSetting("scrape_provider", "scrapingbee");
await setSetting("scrape_api_key", "sb_test_key");
check("recoverable = 167", (await getDiscoveryStatus()).recoverable, 167);

console.log("\n-- the controls survived all of it --");
check("'empty' never re-queued",
  Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE enrich_status='empty' AND enriched=1`))[0].n), 1);
check("resolved lead untouched",
  Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE email='a@b.qa' AND enriched=1 AND recheck_count=0`))[0].n), 1);
check("site-less lead untouched",
  Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE website IS NULL AND recheck_count=0`))[0].n), 1);
check("approved lead untouched",
  Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE status='approved' AND recheck_count=0`))[0].n), 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
