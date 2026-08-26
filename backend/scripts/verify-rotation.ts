// Verifies the three properties of the sending-domain rotation:
//
//   1. Daily usage is DERIVED from the sends ledger, so it rolls over at
//      midnight UTC by itself (the old `sent_today` counter never reset, which
//      turned every daily cap into a lifetime cap).
//   2. The rotation cursor is PERSISTED, so consecutive jobs keep going round
//      instead of restarting at domain #1 every time.
//   3. Pacing is PER DOMAIN, so N domains drain a batch ~N times faster.
//
// Run with:  bun run verify:rotation      (always against a scratch database)

import { q, ensureSchema, nowIso, setSetting, startOfDayIso } from "../src/db";
import { createJob } from "../src/jobs";
import { runSendPlan, domainUsageToday, resetDomainUsage, type SendPlanItem } from "../src/send";

if (!process.env.SQLITE_PATH) {
  console.error("Refusing to run without SQLITE_PATH — this script writes test rows.");
  process.exit(1);
}

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

const uid = () => crypto.randomUUID();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

async function reset() {
  await q(`DELETE FROM sends`);
  await q(`DELETE FROM contacts`);
  await q(`DELETE FROM templates`);
  await q(`DELETE FROM domains`);
  await q(`DELETE FROM settings WHERE key IN ('domain_cap_epoch','send_rotation_last_domain')`);
}

/** Three domains, created in a known order so rotation order is predictable. */
async function seedDomains(caps: number[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < caps.length; i++) {
    const id = `dom-${i + 1}`;
    // created_at drives the rotation order, so keep it strictly increasing.
    await q(
      `INSERT INTO domains (id,domain,from_name,from_email,daily_cap,sent_today,active,created_at) VALUES (?,?,?,?,?,?,1,?)`,
      [id, `d${i + 1}.test`, "Tester", `hi@d${i + 1}.test`, caps[i], 0, `2020-01-0${i + 1}T00:00:00.000Z`]
    );
    ids.push(id);
  }
  return ids;
}

async function seedTemplate(): Promise<string> {
  const id = "tpl-1";
  await q(`INSERT INTO templates (id,type,name,subject,body,created_at) VALUES (?,?,?,?,?,?)`,
    [id, "customer", "T", "Hello {{company}}", "<p>Hi</p>", nowIso()]);
  return id;
}

async function seedContacts(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `c-${i + 1}`;
    await q(`INSERT INTO contacts (id,email,company,status,created_at) VALUES (?,?,?,?,?)`,
      [id, `p${i + 1}@example.com`, `Co ${i + 1}`, "new", nowIso()]);
    ids.push(id);
  }
  return ids;
}

async function runPlan(contactIds: string[], templateId: string, perMinute = 500) {
  const plan: SendPlanItem[] = contactIds.map((contactId) => ({ contactId, templateId }));
  const job = createJob("send", plan.length);
  job.result = { sent: 0, failed: 0, skipped: 0 };
  await runSendPlan(job, plan, perMinute);
  return job;
}

/** The domain each send went out on, in the order they were sent. */
async function sendOrder(): Promise<string[]> {
  const rows = await q(`SELECT domain_id FROM sends ORDER BY created_at, rowid`);
  return rows.map((r) => String(r.domain_id));
}

async function main() {
  await ensureSchema();

  /* ---------------------------------------------------------------- 1 */
  console.log("\n1. Daily usage is derived from the sends ledger");
  await reset();
  const [d1, d2, d3] = await seedDomains([40, 40, 40]);

  // Two delivered today, one delivered yesterday, plus a failure and a dry run.
  // Only the two real deliveries from today may count.
  const ledger: [string, string, string][] = [
    [d1, "sent", nowIso()],
    [d1, "sent", hoursAgo(1)],
    [d1, "sent", new Date(Date.parse(startOfDayIso()) - 3600_000).toISOString()], // yesterday
    [d1, "failed", nowIso()],
    [d1, "sent (dry-run)", nowIso()],
    [d2, "sent", nowIso()],
  ];
  for (const [domainId, status, sentAt] of ledger) {
    await q(`INSERT INTO sends (id,contact_id,contact_email,template_id,domain_id,subject,status,sent_at,created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
      [uid(), null, "x@example.com", null, domainId, "s", status, sentAt, sentAt]);
  }

  let usage = await domainUsageToday();
  check("counts today's delivered mail", usage.get(d1) === 2, `got ${usage.get(d1)}, expected 2`);
  check("ignores yesterday (rolls over at midnight UTC)", usage.get(d1) === 2);
  check("ignores failures and dry runs", usage.get(d1) === 2);
  check("counts each domain separately", usage.get(d2) === 1, `got ${usage.get(d2)}, expected 1`);
  check("a domain that hasn't sent reports nothing", usage.get(d3) === undefined);

  // The manual "Reset daily counts" moves the window rather than zeroing a column.
  await resetDomainUsage();
  usage = await domainUsageToday();
  check("manual reset clears the counts", (usage.get(d1) ?? 0) === 0 && (usage.get(d2) ?? 0) === 0);

  /* ---------------------------------------------------------------- 2 */
  console.log("\n2. Rotation is round-robin and survives job boundaries");
  await reset();
  await seedDomains([40, 40, 40]);
  const tpl = await seedTemplate();
  const contacts = await seedContacts(7);

  await runPlan(contacts.slice(0, 4), tpl);
  const first = await sendOrder();
  check("interleaves within one job", first.join(",") === "dom-1,dom-2,dom-3,dom-1", first.join(","));

  await runPlan(contacts.slice(4, 7), tpl);
  const all = await sendOrder();
  const second = all.slice(4);
  check(
    "the next job resumes where the last stopped",
    second.join(",") === "dom-2,dom-3,dom-1",
    `${second.join(",")} (whole sequence: ${all.join(",")})`
  );

  const cursor = (await q(`SELECT value FROM settings WHERE key='send_rotation_last_domain'`))[0]?.value;
  check("the cursor is persisted", cursor === "dom-1", `got ${cursor}`);

  // Every domain should have carried a fair share of the seven emails.
  const spread = await q(`SELECT domain_id, COUNT(*) AS n FROM sends GROUP BY domain_id ORDER BY domain_id`);
  check("load is spread evenly", spread.every((r) => Number(r.n) >= 2),
    spread.map((r) => `${r.domain_id}=${r.n}`).join(" "));

  /* ---------------------------------------------------------------- 3 */
  console.log("\n3. A capped domain is skipped, not fatal");
  await reset();
  const caps = await seedDomains([40, 1, 40]);
  const tpl3 = await seedTemplate();
  const c3 = await seedContacts(4);
  // Domain 2 has already used its single slot today.
  await q(`INSERT INTO sends (id,contact_email,domain_id,subject,status,sent_at,created_at)
           VALUES (?,?,?,?,?,?,?)`,
    [uid(), "x@example.com", caps[1], "s", "sent", nowIso(), nowIso()]);

  await runPlan(c3, tpl3);
  const afterCap = (await sendOrder()).slice(1); // drop the pre-seeded row
  check("routes around the full domain", !afterCap.includes("dom-2"), afterCap.join(","));
  check("still sends the whole batch", afterCap.length === 4, `${afterCap.length} of 4`);

  /* ---------------------------------------------------------------- 4 */
  console.log("\n4. Pacing is per domain, so domains add throughput");
  // Dry-run spacing is a fixed 120ms per domain. Six emails down one domain must
  // therefore serialise (~720ms), while six across three domains overlap (~120ms:
  // three go out at once, the rest one spacing later).
  const EMAILS = 6;
  const SPACING = 120;

  await reset();
  await seedDomains([40]);
  const tplA = await seedTemplate();
  const cA = await seedContacts(EMAILS);
  const soloStart = Date.now();
  await runPlan(cA, tplA);
  const solo = Date.now() - soloStart;

  await reset();
  await seedDomains([40, 40, 40]);
  const tplB = await seedTemplate();
  const cB = await seedContacts(EMAILS);
  const trioStart = Date.now();
  await runPlan(cB, tplB);
  const trio = Date.now() - trioStart;

  // On a filesystem where each fsync costs more than a pacing interval, the disk
  // is what's being timed, not the scheduler. Say so rather than failing — point
  // SQLITE_PATH at /dev/shm (as `bun run verify:rotation` does) for a real read.
  if (solo > EMAILS * SPACING * 1.5) {
    console.log(`  skip  timing is inconclusive here — ${Math.round(solo / EMAILS)}ms/email of disk overhead swamps the ${SPACING}ms pacing`);
    console.log(`        (1 domain ${solo}ms · 3 domains ${trio}ms · re-run with SQLITE_PATH on a tmpfs)`);
  } else {
    check("three domains beat one on the same batch", trio < solo * 0.7, `1 domain ${solo}ms · 3 domains ${trio}ms`);
    console.log(`       (speed-up: ${(solo / Math.max(1, trio)).toFixed(1)}x)`);
  }

  console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nAll checks passed.\n");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
