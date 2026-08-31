// Offline proof for "imported contacts never joined the automation queue".
//
// The bug had two halves and BOTH have to be fixed for either to matter:
//   1. an import wrote `contacts`, which no automation lane ever reads
//   2. even with pool rows, `approveLeads` dropped any lead whose address was
//      already a contact — so a backfill would approve batches and email nobody
//
// Run: bun run scripts/verify-import-pool.ts
import { existsSync, rmSync } from "node:fs";

const DB = "/tmp/verify-import-pool.sqlite";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`, `${DB}-journal`]) if (existsSync(f)) rmSync(f);
process.env.SQLITE_PATH = DB;
process.env.DATABASE_URL = "";

const { q, ensureSchema, nowIso } = await import("../src/db");
const {
  importLeadsToPool,
  adoptContactsToPool,
  countAdoptableContacts,
  approveLeads,
  countApprovableLeads,
  IMPORT_SOURCE_ID,
} = await import("../src/pool");

await ensureSchema();

let pass = 0, fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
}

const uid = () => crypto.randomUUID();
async function addContact(email: string, opts: { source?: string; status?: string; audience?: string | null } = {}) {
  const id = uid();
  await q(
    `INSERT INTO contacts (id,email,company,country,category,source,audience,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, email, "Acme", "Qatar", null, opts.source ?? "import", opts.audience ?? null, opts.status ?? "new", nowIso()]
  );
  return id;
}
async function markSent(contactId: string, email: string) {
  await q(
    `INSERT INTO sends (id,contact_id,contact_email,status,sent_at,created_at) VALUES (?,?,?,'sent',?,?)`,
    [uid(), contactId, email, nowIso(), nowIso()]
  );
}

/* ---------------------------------------------------------------- 1 ---- */
console.log("\n1. The original bug: a bulk import is invisible to the automation");
const imported: { id: string; email: string }[] = [];
for (let i = 0; i < 30; i++) {
  const email = `buyer${i}@company${i}.com`;
  imported.push({ id: await addContact(email), email });
}
check("30 contacts exist", Number((await q(`SELECT count(*) AS n FROM contacts`))[0].n), 30);
check("the customer lane still counts ZERO — this is the reported bug", await countApprovableLeads(null, null, "customer"), 0);

/* ---------------------------------------------------------------- 2 ---- */
console.log("\n2. Backfill: queue the contacts that were never emailed");
// Three of them have already been emailed and must never be queued again.
for (let i = 0; i < 3; i++) await markSent(imported[i].id, imported[i].email);
// One unsubscribed, one bounced — never mail either, whatever the ledger says.
await q(`UPDATE contacts SET status='unsubscribed' WHERE email=?`, [imported[3].email]);
await q(`UPDATE contacts SET status='bounced' WHERE email=?`, [imported[4].email]);

const before = await countAdoptableContacts();
check("25 of the 30 are adoptable (3 emailed, 1 unsub, 1 bounced excluded)", before.adoptable, 25);
check("all 25 are recognised as imports", before.imported, 25);
check("3 contacts have been emailed before", before.alreadyEmailed, 3);

const run1 = await adoptContactsToPool({ importedOnly: true });
check("the backfill queued 25", run1.added, 25);
check("the customer lane can now SEE them", await countApprovableLeads(null, null, "customer"), 25);
check("they are tagged as imports, not discovery", Number((await q(`SELECT count(*) AS n FROM discovered_leads WHERE source_id=?`, [IMPORT_SOURCE_ID]))[0].n), 25);
check("nothing was written to contacts", Number((await q(`SELECT count(*) AS n FROM contacts`))[0].n), 30);

/* ---------------------------------------------------------------- 3 ---- */
console.log("\n3. Idempotent — pressing it twice must not queue anyone twice");
const run2 = await adoptContactsToPool({ importedOnly: true });
check("second pass scans nobody", run2.scanned, 0);
check("second pass queues nobody", run2.added, 0);
check("pool is still 25", await countApprovableLeads(null, null, "customer"), 25);

/* ---------------------------------------------------------------- 4 ---- */
console.log("\n4. THE KEY FIX — approving a backfilled lead must actually email someone");
const batch = await approveLeads({ all: true, limit: 10, oldestFirst: true, filterAudience: "customer" });
check("10 leads approved", batch.approvedIds.length, 10);
check("no NEW contact rows created (they already existed)", batch.added, 0);
check("…but 10 existing contacts were adopted into the batch", batch.adopted, 10);
check("so the send list is 10, NOT 0 — the old code returned 0 here", batch.contactIds.length, 10);
check("every id is a real contact", Number((await q(
  `SELECT count(*) AS n FROM contacts WHERE id IN (${batch.contactIds.map(() => "?").join(",")})`, batch.contactIds
))[0].n), 10);
check("the adopted contacts got an audience (import left it NULL)", Number((await q(
  `SELECT count(*) AS n FROM contacts WHERE id IN (${batch.contactIds.map(() => "?").join(",")}) AND audience='customer'`,
  batch.contactIds
))[0].n), 10);
check("pool drained by exactly the batch size", await countApprovableLeads(null, null, "customer"), 15);

/* ---------------------------------------------------------------- 5 ---- */
console.log("\n5. Someone already emailed is still refused");
const emailedEmail = imported[0].email;
await importLeadsToPool([{ email: emailedEmail }], { audience: "customer" });
const reBatch = await approveLeads({ ids: (await q(`SELECT id FROM discovered_leads WHERE email=?`, [emailedEmail])).map((r: any) => String(r.id)) });
check("an already-emailed contact is NOT adopted", reBatch.adopted, 0);
check("…and is not in the send list", reBatch.contactIds.length, 0);
check("it is counted as skipped", reBatch.skipped, 1);

/* ---------------------------------------------------------------- 6 ---- */
console.log("\n6. A genuinely new import still creates a contact normally");
await importLeadsToPool([{ email: "brand-new@newco.qa", company: "NewCo", country: "Qatar" }], { audience: "partner" });
const fresh = await approveLeads({ all: true, filterAudience: "partner" });
check("a new address creates a contact", fresh.added, 1);
check("nothing was adopted", fresh.adopted, 0);
check("it landed in the partner lane", String((await q(`SELECT audience FROM contacts WHERE email='brand-new@newco.qa'`))[0].audience), "partner");

/* ---------------------------------------------------------------- 7 ---- */
console.log("\n7. Import hygiene");
const dirty = await importLeadsToPool(
  [
    { email: "  Sales@Example.COM  " },      // normalised to lower case, trimmed
    { email: "sales@example.com" },          // same person, second time
    { email: "//info@broken.com" },          // markup glue — REPAIRED, not rejected
    { email: "not-an-email" },               // genuinely unmailable
    { email: "person@gmail.com" },           // free-mail: no domain claim
  ],
  { audience: "customer" }
);
// `cleanEmail` deliberately peels a malformed scheme rather than discarding the
// row — "//info@broken.com" is a real address behind an authoring slip, and
// throwing it away was a bug fixed earlier in this project's history.
check("three mailable addresses added (the glued one is repaired)", dirty.added, 3);
check("the repeat is a duplicate", dirty.duplicate, 1);
check("only the genuinely unmailable row is rejected", dirty.invalid, 1);
check("the repaired address is stored clean", (await q(`SELECT count(*) AS n FROM discovered_leads WHERE email='info@broken.com'`))[0].n, 1);
check("free-mail leads carry no domain", (await q(`SELECT domain FROM discovered_leads WHERE email='person@gmail.com'`))[0].domain, null);
check("a company address does carry one", (await q(`SELECT domain FROM discovered_leads WHERE email='sales@example.com'`))[0].domain, "example.com");
check("imported leads never enter the crawl queue", Number((await q(
  `SELECT count(*) AS n FROM discovered_leads WHERE source_id=? AND enriched=0`, [IMPORT_SOURCE_ID]
))[0].n), 0);

/* ---------------------------------------------------------------- 8 ---- */
console.log("\n8. The discovery health metric must ignore the import");
const { getFillRate } = await import("../src/fillrate");
const { setAutomationConfig } = await import("../src/automation");
// The lanes have to be LIVE or every lane reports found=0 regardless, and the
// check would pass without proving anything.
await setAutomationConfig({ enabled: true, customer: { enabled: true }, partner: { enabled: true } });

// `force` bypasses the 15s snapshot cache — two reads seconds apart would
// otherwise return the identical object and the second assertion would be
// measuring nothing.
const rate = await getFillRate(true);
const discovered = rate.lanes.reduce((n, l) => n + l.found, 0);
check("both lanes are live, so the metric is meaningful", rate.lanes.every((l) => l.live), true);
check("a pool built entirely from imports reports zero discovery inflow", discovered, 0);

// …and a genuine discovery lead IS still counted, so the filter is narrowing
// the metric rather than just switching it off.
await q(
  `INSERT INTO discovered_leads (id,dedup_key,name,email,status,audience,source_id,source_label,enriched,created_at,email_at)
   VALUES (?,?,?,?,'pending','customer',?,?,1,?,?)`,
  [uid(), "e:found@crawled.qa", "Crawled Co", "found@crawled.qa", "src-1", "Web search", nowIso(), nowIso()]
);
const rate2 = await getFillRate(true);
check("a real crawled lead still counts", rate2.lanes.reduce((n, l) => n + l.found, 0), 1);

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILURES"} — ${pass}/${pass + fail} checks passed\n`);
process.exit(fail === 0 ? 0 : 1);
