// Fill rate — offline proof that supply is measured against real demand.
//
// The headline claim being tested: "150 leads with an email every 3 hours keeps
// the automation running, so the target is 8.3 per 10 minutes". Everything else
// here is the ways that can be got wrong — crediting a lead to the day it was
// DISCOVERED rather than the day it became emailable, counting leads for a lane
// that is switched off, or lighting the card red for a window the bot spent
// switched off.
//
//   bun run scripts/verify-fillrate.ts
process.env.SQLITE_PATH = "/tmp/fillrate-verify.sqlite";
import { unlinkSync, existsSync } from "node:fs";
for (const s of ["", "-wal", "-shm"]) {
  const f = process.env.SQLITE_PATH + s;
  if (existsSync(f)) unlinkSync(f);
}

const { q, ensureSchema, nowIso, setSetting } = await import("../src/db");
const { getFillRate, resetFillRateCache, UNIT_MINUTES } = await import("../src/fillrate");

await ensureSchema();

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `  -> got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const uid = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const fill = () => { resetFillRateCache(); return getFillRate(true); };
const lane = (f: any, a: string) => f.lanes.find((l: any) => l.audience === a);

/** A lead, with the two timestamps kept deliberately separate. */
async function lead(o: {
  audience?: string;
  createdMinAgo: number;
  /** null = never got an address. */
  emailMinAgo?: number | null;
  status?: string;
}) {
  const id = uid();
  const emailed = o.emailMinAgo != null;
  await q(
    `INSERT INTO discovered_leads (id,dedup_key,name,website,domain,email,audience,status,enriched,created_at,email_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, "d:" + id, "Co " + id, `https://${id}.qa/`, `${id}.qa`,
      emailed ? `info@${id}.qa` : null,
      o.audience ?? "customer",
      o.status ?? "pending",
      emailed ? 1 : 0,
      ago(o.createdMinAgo),
      emailed ? ago(o.emailMinAgo as number) : null,
    ]
  );
  return id;
}

/**
 * The same thing n times, in one statement per chunk.
 *
 * `PRAGMA synchronous = FULL` means one fsync per statement, so seeding a few
 * thousand rows a row at a time turns a 5-second script into a 3-minute one.
 * `emailMinAgo(i)` lets a run be spread across the window instead of landing in
 * a single bucket.
 */
async function leads(n: number, o: {
  audience?: string;
  createdMinAgo: number;
  emailMinAgo?: ((i: number) => number) | number | null;
  status?: string;
}) {
  const rows: any[][] = [];
  for (let i = 0; i < n; i++) {
    const id = uid();
    const mins = typeof o.emailMinAgo === "function" ? o.emailMinAgo(i) : o.emailMinAgo;
    const emailed = mins != null;
    rows.push([
      id, "d:" + id, "Co " + id, `https://${id}.qa/`, `${id}.qa`,
      emailed ? `info@${id}.qa` : null,
      o.audience ?? "customer",
      o.status ?? "pending",
      emailed ? 1 : 0,
      ago(o.createdMinAgo),
      emailed ? ago(mins as number) : null,
    ]);
  }
  // 11 params a row, and SQLite stops at 999 per statement.
  for (let i = 0; i < rows.length; i += 80) {
    const chunk = rows.slice(i, i + 80);
    await q(
      `INSERT INTO discovered_leads (id,dedup_key,name,website,domain,email,audience,status,enriched,created_at,email_at)
       VALUES ${chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?)").join(",")}`,
      chunk.flat()
    );
  }
}

async function source(o: { enabled?: number; barren?: number } = {}) {
  await q(
    `INSERT INTO discovery_sources (id,type,location,category,limit_n,interval_minutes,enabled,barren_runs,created_at)
     VALUES (?,'search','Qatar','Companies (general)',100,60,?,?,?)`,
    [uid(), o.enabled ?? 1, o.barren ?? 0, nowIso()]
  );
}

/* The exact configuration from the brief: 150 per lane, one run every 3 hours. */
await setSetting("automation_enabled", "1");
await setSetting("automation_cooldown_minutes", "180");
await setSetting("automation_daily_limit", "0"); // no ceiling — tested on its own below
await setSetting("automation_customer_enabled", "1");
await setSetting("automation_customer_threshold", "150");
await setSetting("automation_partner_enabled", "0");
await setSetting("automation_partner_threshold", "50");
await setSetting("discovery_enabled", "1");
await source();

console.log("\n-- the target derives itself from the lane config --");
let f = await fill();
check("quoted per 10 minutes", f.unitMinutes, UNIT_MINUTES);
check("window is the cooldown", f.windowMinutes, 180);
check("150 every 3h  ->  8.3 per 10 min", f.required, 8.3);
check("the off partner lane adds no demand", lane(f, "partner").live, false);
check("…but still reports what it would need (50 per 3h)", lane(f, "partner").required, 2.8);

console.log("\n-- nothing measured yet --");
check("warming", f.warming, true);
check("no verdict while warming", f.status, "idle");

console.log("\n-- an established pool, filling at exactly the target rate --");
// 3 hours of history, and 150 leads that BECAME emailable inside it.
await lead({ createdMinAgo: 60 * 24 * 30, emailMinAgo: null });
await leads(150, { createdMinAgo: 200, emailMinAgo: (i) => (i % 170) + 5 });
f = await fill();
check("no longer warming", f.warming, false);
check("rate is 8.3 per 10 min", f.rate, 8.3);
check("keeping up", f.status, "ok");
check("no reason to give", f.reason, null);
check("ratio 1", f.ratio, 1);

console.log("\n-- a hair under target is noise, not an emergency --");
// The very first live reading was 8.0 against a target of 8.3 and turned the
// card red. One directory page landing a minute either side of the window
// boundary moves it further than that.
await q(`DELETE FROM discovered_leads WHERE email_at >= ?`, [ago(180)]);
await leads(144, { createdMinAgo: 175, emailMinAgo: (i) => (i % 170) + 5 });
f = await fill();
check("8.0 against a target of 8.3", f.rate, 8);
check("still keeping up", f.status, "ok");
check("and the ratio says how close, to 2dp", f.ratio, 0.96);
// …but a real shortfall still shows, even with leads banked.
await q(`DELETE FROM discovered_leads WHERE email_at >= ?`, [ago(180)]);
await leads(100, { createdMinAgo: 175, emailMinAgo: (i) => (i % 170) + 5 });
f = await fill();
check("5.6 against 8.3 is a shortfall", f.status, "slow");
await q(`DELETE FROM discovered_leads WHERE email_at >= ?`, [ago(180)]);
await leads(150, { createdMinAgo: 200, emailMinAgo: (i) => (i % 170) + 5 });

console.log("\n-- THE BUG THIS COLUMN EXISTS FOR --");
// 200 companies discovered a month ago whose emails were found a month ago too.
// On created_at they would count; on email_at they correctly do not.
await leads(200, { createdMinAgo: 60 * 24 * 30, emailMinAgo: 60 * 24 * 30 });
f = await fill();
check("old leads don't inflate today's rate", f.rate, 8.3);
// …and the opposite: discovered a month ago, email found ten minutes ago.
await leads(30, { createdMinAgo: 60 * 24 * 30, emailMinAgo: 6 });
f = await fill();
check("an email found TODAY counts today", f.rate, 10);
check("even though the lead is a month old", f.status, "ok");

console.log("\n-- falling behind, with a deep pool: a warning, not an alarm --");
await q(`DELETE FROM discovered_leads WHERE email_at >= ?`, [ago(180)]);
// 18 arrivals in 3 hours = 1 per 10 min, against a target of 8.3.
await leads(18, { createdMinAgo: 175, emailMinAgo: (i) => i * 10 + 1 });
// 4,000 emailable leads on hand — 13 batches, ~40 hours of cover.
await leads(400, { createdMinAgo: 60 * 24 * 10, emailMinAgo: 60 * 24 * 10 });
f = await fill();
check("rate is 1 per 10 min", f.rate, 1);
check("slow, not starved", f.status, "slow");
check("because the pool still covers half a day", lane(f, "customer").coverMinutes! >= 12 * 60, true);
check("and it says why", typeof f.reason === "string", true);

console.log("\n-- the buffer runs out: now it's red --");
await q(`UPDATE discovered_leads SET status='approved' WHERE status='pending' AND email_at < ?`, [ago(180)]);
f = await fill();
check("still 1 per 10 min", f.rate, 1);
check("starved", f.status, "starved");

console.log("\n-- and the reason names the cause --");
await setSetting("discovery_enabled", "0");
f = await fill();
check("bot off is the whole explanation", f.reason, "the discovery bot is switched off");
await setSetting("discovery_enabled", "1");
await q(`UPDATE discovery_sources SET enabled=0`);
f = await fill();
check("no sources on", f.reason, "no sources are switched on");
await q(`UPDATE discovery_sources SET enabled=1, barren_runs=5`);
f = await fill();
check("every source dry", f.reason, "its only live source has run dry");
await q(`UPDATE discovery_sources SET barren_runs=0`);

console.log("\n-- companies arriving, no emails coming out: a DIFFERENT fix --");
await q(`DELETE FROM discovered_leads WHERE email_at >= ?`, [ago(180)]);
await leads(40, { createdMinAgo: 30, emailMinAgo: null });
f = await fill();
check("rate is 0", f.rate, 0);
check("named as a crawler problem, not a discovery one", f.reason, "40 companies arrived, none with an email");

console.log("\n-- a lane that is switched off cannot feed one that isn't --");
await q(`DELETE FROM discovered_leads WHERE created_at >= ?`, [ago(200)]);
await leads(150, { audience: "partner", createdMinAgo: 175, emailMinAgo: (i) => (i % 170) + 5 });
f = await fill();
check("the partner haul doesn't count", f.rate, 0);
check("customer lane still starved", f.status, "starved");
check("but the partner lane's own rate is reported", lane(f, "partner").rate, 8.3);

console.log("\n-- switch the partner lane on and it counts --");
await setSetting("automation_partner_enabled", "1");
f = await fill();
check("both lanes' demand — 150/3h plus 50/3h", f.required, 11.1);
check("both lanes' supply", f.rate, 8.3);
check("partner lane keeping up on its own", lane(f, "partner").status, "ok");
await setSetting("automation_partner_enabled", "0");

console.log("\n-- rejected and duplicate leads never reached the automation --");
await q(`DELETE FROM discovered_leads`);
await leads(60, { createdMinAgo: 175, emailMinAgo: 30, status: "rejected" });
await leads(60, { createdMinAgo: 175, emailMinAgo: 30, status: "duplicate" });
await lead({ createdMinAgo: 60 * 24 * 30, emailMinAgo: null }); // history anchor
f = await fill();
check("neither is counted as filling the pool", f.rate, 0);

console.log("\n-- the daily ceiling caps what can possibly be needed --");
await q(`DELETE FROM discovered_leads`);
await lead({ createdMinAgo: 60 * 24 * 30, emailMinAgo: null });
await setSetting("automation_daily_limit", "300");
f = await fill();
// 300/day is 2.08 per 10 min — far below 150-per-3h, so THAT is the real target.
check("required falls to the ceiling", f.required, 2.1);
check("and says so", f.cappedByDaily, true);
await setSetting("automation_daily_limit", "0");
f = await fill();
check("lifting the ceiling restores it", f.required, 8.3);

console.log("\n-- turning the bot on doesn't light the card red for 3 hours --");
await q(`DELETE FROM discovered_leads`);
await lead({ createdMinAgo: 60 * 24 * 30, emailMinAgo: null }); // an old, established pool
await setSetting("discovery_enabled_at", ago(40));
f = await fill();
check("measures the 40 minutes it has been on, not 180", f.coveredMinutes, 40);
// 34 leads in 40 minutes = 8.5 per 10 min: keeping up, and provably so.
await leads(34, { createdMinAgo: 35, emailMinAgo: (i) => (i % 39) + 1 });
f = await fill();
check("rate over the real elapsed time", f.rate, 8.5);
check("green from the first window", f.status, "ok");
await setSetting("discovery_enabled_at", ago(60 * 24));

console.log("\n-- automation off: a number, but no verdict --");
await setSetting("automation_enabled", "0");
f = await fill();
check("nothing is consuming the pool", f.status, "idle");
check("no demand", f.required, 0);
check("the inflow is still reported", f.rate > 0, true);
await setSetting("automation_enabled", "1");

console.log("\n-- the sparkline --");
f = await fill();
check("one bucket per 10 minutes", f.bucketMinutes, 10);
check("18 buckets across 3 hours", lane(f, "customer").series.length, 18);
check("newest bucket last", lane(f, "customer").series.at(-1)! > 0, true);
check("the series sums to what was counted", lane(f, "customer").series.reduce((a: number, b: number) => a + b, 0), 34);

console.log("\n-- ETA to the next batch --");
await q(`DELETE FROM discovered_leads`);
await lead({ createdMinAgo: 60 * 24 * 30, emailMinAgo: null });
await leads(30, { createdMinAgo: 175, emailMinAgo: (i) => (i % 170) + 5 });
f = await fill();
// 30 waiting, 120 to go, arriving at 1.67/10min = 0.167/min -> ~720 min.
check("30 of 150 ready", lane(f, "customer").ready, 30);
check("~12 hours to a full batch at this rate", Math.round(lane(f, "customer").etaMinutes! / 60), 12);
await q(`DELETE FROM discovered_leads WHERE email_at IS NOT NULL`);
await leads(200, { createdMinAgo: 175, emailMinAgo: 60 });
f = await fill();
check("already full", lane(f, "customer").etaMinutes, 0);

console.log("\n-- the migration, against a database that already has leads --");
// Production is ~10k rows that predate the column. They must come out of the
// migration stamped, and rows with no address must NOT be — a NULL email_at on
// an emailable lead would silently drop it out of every window for ever.
await q(`DELETE FROM discovered_leads`);
await leads(20, { createdMinAgo: 60 * 24 * 4, emailMinAgo: 60 * 24 * 4 });
await leads(7, { createdMinAgo: 60 * 24 * 4, emailMinAgo: null });
await q(`UPDATE discovered_leads SET email_at=NULL`); // as they were before the column
await q(`DELETE FROM settings WHERE key='email_at_backfill_v1'`);
const { ensureSchema: reMigrate } = await import("../src/db");
await reMigrate();
const stamped = Number(
  (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE email_at IS NOT NULL`))[0].n
);
check("every lead that has an address is stamped", stamped, 20);
check("stamped with its discovery time — the best answer there is",
  Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE email_at = created_at`))[0].n), 20);
check("leads with no address are left alone",
  Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE email IS NULL AND email_at IS NULL`))[0].n), 7);
// Second boot: the flag stops it re-scanning, and nothing moves.
await q(`UPDATE discovered_leads SET email_at=NULL WHERE email IS NOT NULL`);
await reMigrate();
check("it doesn't re-scan on every boot",
  Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE email_at IS NOT NULL`))[0].n), 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
