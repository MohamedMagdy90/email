// "Repair company names" had the same shape of bug as "Re-check emails":
// `countBadNames()` counted EVERY unusable name, but the repair can only fix the
// ones it can look up in a directory or derive from a domain. The rest stayed
// bad, stayed counted, and every press re-walked all directory sources from
// page 1 (up to 80 pages / 5,000 listings each) to rebuild an identical index.
//
// It also derived a company name from the contact's email domain without
// excluding shared mailboxes, so a lead on gmail was filed as "Gmail".
//
//   bun run scripts/verify-names.ts
process.env.SQLITE_PATH = "/tmp/names-verify.sqlite";
import { unlinkSync, existsSync } from "node:fs";
for (const s of ["", "-wal", "-shm"]) {
  const f = process.env.SQLITE_PATH + s;
  if (existsSync(f)) unlinkSync(f);
}

const { q, ensureSchema, nowIso } = await import("../src/db");
const { repairLeadNames, countBadNames, nameFromDomain, clearFreemailCompanyNames } = await import("../src/repair");

await ensureSchema();

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `  -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const uid = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

async function lead(name: string, o: { website?: string | null; domain?: string | null; email?: string | null; phone?: string | null } = {}) {
  const id = uid();
  await q(
    `INSERT INTO discovered_leads (id,dedup_key,name,website,domain,email,phone,status,enriched,created_at)
     VALUES (?,?,?,?,?,?,?,'pending',1,?)`,
    [id, "d:" + id, name, o.website ?? null, o.domain ?? null, o.email ?? null, o.phone ?? null, nowIso()]
  );
  return id;
}
async function contact(company: string, email: string) {
  const id = uid();
  await q(`INSERT INTO contacts (id,email,company,status,created_at) VALUES (?,?,?,'new',?)`, [id, email, company, nowIso()]);
  return id;
}
const nameOf = async (id: string) =>
  String((await q(`SELECT name FROM discovered_leads WHERE id=?`, [id]))[0]?.name ?? "");
const companyOf = async (id: string) =>
  (await q(`SELECT company FROM contacts WHERE id=?`, [id]))[0]?.company ?? null;

console.log("\n-- the free-mail guard, on its own --");
check("gmail.com yields no name", nameFromDomain(null, "gmail.com"), "");
check("hotmail.co.uk yields no name", nameFromDomain(null, "hotmail.co.uk"), "");
check("proton.me yields no name", nameFromDomain(null, "proton.me"), "");
check("a real domain still works", nameFromDomain(null, "al-mashreq-qatar.com"), "AL Mashreq Qatar");
check("a real domain via website", nameFromDomain("https://www.gulf-steel.qa/contact", null), "Gulf Steel");

/* Rows the repair genuinely CANNOT name: no directory to learn from, and no
   domain worth deriving from. */
const phoneOnly = await lead("+974 4444 5555", { phone: "+97444445555" });
const shortDomain = await lead("66828808", { domain: "a.qa", website: "https://a.qa/" });
const noDomain = await lead("www.example-site.qa");
/* One it CAN name, from its own domain. */
const fixable = await lead("44112233", { domain: "al-mashreq-qatar.com", website: "https://al-mashreq-qatar.com/" });
/* A contact with a junk name on a shared mailbox — the "Gmail" case. */
const gmailContact = await contact("55667788", "someone@gmail.com");
/* …and one on a real company domain, which must still be repaired. */
const realContact = await contact("33445566", "info@gulf-steel.qa");

console.log("\n-- before any press --");
let c = await countBadNames();
check("4 bad lead names offered", c.leads, 4);
check("2 bad contact names offered", c.contacts, 2);
check("nothing parked yet", c.stuckLeads + c.stuckContacts, 0);

console.log("\n-- press 1 --");
let r = await repairLeadNames(() => {});
check("fixes the 1 lead it can name", r.fixedLeads, 1);
check("fixes the 1 contact it can name", r.fixedContacts, 1);
check("reports 4 it cannot", r.stillBad, 4);
check("the nameable lead got its name", await nameOf(fixable), "AL Mashreq Qatar");
check("the real-domain contact got its name", await companyOf(realContact), "Gulf Steel");
check("the gmail contact was NOT renamed to 'Gmail'", await companyOf(gmailContact), "55667788");

c = await countBadNames();
check("offered drops to 0   <- used to stay at 4", c.leads + c.contacts, 0);
check("and 4 are reported parked", c.stuckLeads + c.stuckContacts, 4);

console.log("\n-- press 2: nothing left to do, and no directory is re-walked --");
r = await repairLeadNames(() => {});
check("scans nothing as fixable", r.badLeads + r.badContacts, 0);
check("fixes nothing", r.fixedLeads + r.fixedContacts, 0);
check("walked 0 pages   <- the expensive half of the loop", r.pagesWalked, 0);
check("says why", r.notes.length > 0, true);

console.log("\n-- press 3 --");
r = await repairLeadNames(() => {});
check("still 0 pages walked", r.pagesWalked, 0);
check("counts unchanged", await countBadNames().then((x) => x.stuckLeads + x.stuckContacts), 4);
check("parked rows were not corrupted", await nameOf(phoneOnly), "+974 4444 5555");

console.log("\n-- adding a directory source re-arms every parked name --");
await q(
  `INSERT INTO discovery_sources (id,type,base_url,location,category,limit_n,interval_minutes,enabled,created_at)
   VALUES (?,'directory',?,?,?,?,?,0,?)`,
  [uid(), "https://example-directory.qa/listings", "Qatar", "Companies (general)", 100, 360, nowIso()]
);
c = await countBadNames();
check("all 4 offered again", c.leads + c.contacts, 4);
check("none parked", c.stuckLeads + c.stuckContacts, 0);

console.log("\n-- the one-time 'Gmail' cleanup --");
await q(`UPDATE contacts SET company='Gmail' WHERE id=?`, [gmailContact]);
check("cleared exactly 1", await clearFreemailCompanyNames(), 1);
check("company is now blank, not a lie", await companyOf(gmailContact), null);
check("the real company was left alone", await companyOf(realContact), "Gulf Steel");
check("it only ever runs once", await clearFreemailCompanyNames(), 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
