// Offline checks for the two things this session changed underneath the UI:
//   1. per-country sending windows (schedule.ts)
//   2. per-audience follow-up ladders (followup.ts)
//
// ALWAYS runs against a scratch DB — never point it at data.sqlite while the
// dev server holds the file.
//   SQLITE_PATH=/tmp/dna-verify-schedule.sqlite bun run scripts/verify-schedule.ts

process.env.SQLITE_PATH ||= "/tmp/dna-verify-schedule.sqlite";

import { ensureSchema, q, setSetting } from "../src/db";
import {
  getSchedule, setSchedule, isOpen, minutesUntilOpen, windowFor, timezoneFor,
  localClock, describeWindow, keyOf, WEEK_SUN_THU, WEEK_MON_FRI,
} from "../src/schedule";
import { getFollowUpConfig, setFollowUpConfig, ladderOf } from "../src/followup";
import { discoveredWhere, countApprovableLeads, approvableByCountry, approveLeads } from "../src/pool";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

await ensureSchema();
await q(`DELETE FROM settings`);

console.log("\n— time zones —");
const cfg0 = await getSchedule();
check("defaults are on, 09:00–17:00", cfg0.enabled && cfg0.window.start === 540 && cfg0.window.end === 1020, describeWindow(cfg0.window));
check("Qatar resolves to Asia/Qatar", timezoneFor(cfg0, "Qatar") === "Asia/Qatar", timezoneFor(cfg0, "Qatar"));
check("an alias resolves too (UAE)", timezoneFor(cfg0, "UAE") === "Asia/Dubai", timezoneFor(cfg0, "UAE"));
check("unknown country falls back", timezoneFor(cfg0, "Atlantis") === cfg0.fallbackTimezone);
check("no country → the fallback zone", timezoneFor(cfg0, "") === cfg0.fallbackTimezone);
check("Gulf working week is Sun–Thu", JSON.stringify(windowFor(cfg0, "Saudi Arabia").days) === JSON.stringify(WEEK_SUN_THU));
check("UAE moved to Mon–Fri", JSON.stringify(windowFor(cfg0, "United Arab Emirates").days) === JSON.stringify(WEEK_MON_FRI));
check("UK is Mon–Fri", JSON.stringify(windowFor(cfg0, "United Kingdom").days) === JSON.stringify(WEEK_MON_FRI));

console.log("\n— open / closed —");
// A Wednesday, so every working week is live. 06:00 UTC = 09:00 Qatar.
const wedMorning = new Date("2026-08-26T06:30:00Z");
check("Qatar open at 09:30 local", isOpen(cfg0, "Qatar", wedMorning), localClock("Asia/Qatar", wedMorning).hhmm);
check("UK still shut at 07:30 local", !isOpen(cfg0, "United Kingdom", wedMorning), localClock("Europe/London", wedMorning).hhmm);
check("Singapore already shut at 14:30… no, open", isOpen(cfg0, "Singapore", wedMorning), localClock("Asia/Singapore", wedMorning).hhmm);
const wedNight = new Date("2026-08-26T22:30:00Z"); // 01:30 in Doha
check("Qatar shut at 01:30 local", !isOpen(cfg0, "Qatar", wedNight), localClock("Asia/Qatar", wedNight).hhmm);
check("New York open at 18:30 local? no", !isOpen(cfg0, "United States", wedNight), localClock("America/New_York", wedNight).hhmm);

const untilQatar = minutesUntilOpen(cfg0, "Qatar", wedNight);
check("Qatar opens in ~7.5h", untilQatar !== null && Math.abs(untilQatar - 450) <= 5, String(untilQatar));

// Friday night in Doha: the next Qatari window is Sunday morning.
const friNight = new Date("2026-08-28T21:00:00Z"); // Sat 00:00 in Doha
const untilWeekend = minutesUntilOpen(cfg0, "Qatar", friNight);
check("Saturday in Doha waits for Sunday 09:00", untilWeekend !== null && Math.abs(untilWeekend - (33 * 60)) <= 5, String(untilWeekend));

console.log("\n— overrides —");
await setSchedule({ countries: { qatar: { start: 8 * 60, end: 12 * 60, days: [0, 1, 2, 3, 4] } } });
let cfg = await getSchedule();
check("a country override is stored canonically", !!cfg.countries["Qatar"], JSON.stringify(Object.keys(cfg.countries)));
check("the override applies", windowFor(cfg, "Qatar").end === 720, String(windowFor(cfg, "Qatar").end));
check("other countries keep the default", windowFor(cfg, "Jordan").end === 1020);
check("Qatar shut at 12:30 local now", !isOpen(cfg, "Qatar", new Date("2026-08-26T09:30:00Z")));

await setSchedule({ countries: { Qatar: { end: 60, start: 600 } } });
cfg = await getSchedule();
check("an end before the start is repaired, not disabled", windowFor(cfg, "Qatar").end === 660, JSON.stringify(windowFor(cfg, "Qatar")));

await setSchedule({ countries: { Qatar: null } });
cfg = await getSchedule();
check("null clears the override", !cfg.countries["Qatar"] && windowFor(cfg, "Qatar").end === 1020);

await setSchedule({ countries: { Jordan: { paused: true } } });
cfg = await getSchedule();
check("a paused country never opens", minutesUntilOpen(cfg, "Jordan", wedMorning) === null);
await setSchedule({ countries: { Jordan: null } });

await setSchedule({ sendUnknown: false });
cfg = await getSchedule();
check("no-country leads can be held", minutesUntilOpen(cfg, "", wedMorning) === null);
await setSchedule({ sendUnknown: true });

await setSchedule({ enabled: false });
cfg = await getSchedule();
check("switched off, everywhere is open", isOpen(cfg, "Qatar", wedNight) && isOpen(cfg, "United Kingdom", wedNight));
await setSchedule({ enabled: true });

await setSchedule({ fallbackTimezone: "Not/AZone" });
cfg = await getSchedule();
check("an invalid zone is rejected", cfg.fallbackTimezone === "Asia/Qatar", cfg.fallbackTimezone);

console.log("\n— the pool's country filter —");
const w1 = discoveredWhere({ status: "pending", hasEmail: true, countries: ["Qatar", "__none__"] });
check("a country list becomes one OR group", /lower\(country\) IN \(\?\)/.test(w1.clause) && /country IS NULL/.test(w1.clause), w1.clause);
check("its params are lower-cased", w1.params.includes("qatar"), JSON.stringify(w1.params));
const w2 = discoveredWhere({ status: "pending", hasEmail: true, countries: [] });
check("an empty list matches NOTHING", /1 = 0/.test(w2.clause), w2.clause);
const w3 = discoveredWhere({ status: "pending", hasEmail: true });
check("no list = no country clause", !/lower\(country\)/.test(w3.clause), w3.clause);

console.log("\n— follow-up: two independent ladders —");
await setFollowUpConfig({ customer: { noOpen: [{ templateId: "cust-1", delayHours: 24 }, { templateId: "cust-2", delayHours: 72 }] } });
await setFollowUpConfig({ partner: { noOpen: [{ templateId: "part-1", delayHours: 12 }, { templateId: "part-2", delayHours: 48 }] } });
let fu = await getFollowUpConfig();
check("customer keeps its template after partner is saved", fu.customer.noOpen[0].templateId === "cust-1", fu.customer.noOpen[0].templateId);
check("partner has its own", fu.partner.noOpen[0].templateId === "part-1", fu.partner.noOpen[0].templateId);
check("waits are independent", fu.customer.noOpen[0].delayHours === 24 && fu.partner.noOpen[0].delayHours === 12);
check("ladderOf picks the right one", ladderOf(fu, "partner").noOpen[0].templateId === "part-1");

await setFollowUpConfig({ customer: { noClick: [{ templateId: "cust-c1", delayHours: 36 }, { templateId: "", delayHours: 96 }] } });
fu = await getFollowUpConfig();
check("saving one BRANCH leaves the other alone", fu.customer.noOpen[0].templateId === "cust-1" && fu.customer.noClick[0].templateId === "cust-c1");
check("and leaves the partner lane alone", fu.partner.noOpen[0].templateId === "part-1");

check("the legacy flat mirror shows the customer lane", fu.noOpen[0].templateId === "cust-1");
await setFollowUpConfig({ noOpen: [{ templateId: "legacy-1", delayHours: 10 }, { templateId: "legacy-2", delayHours: 20 }] });
fu = await getFollowUpConfig();
check("a legacy flat write lands on the customer lane only", fu.customer.noOpen[0].templateId === "legacy-1" && fu.partner.noOpen[0].templateId === "part-1");

console.log("\n— legacy install migrates without losing anything —");
await q(`DELETE FROM settings`);
await setSetting("followup_no_open", JSON.stringify([{ templateId: "old-1", delayHours: 30 }, { templateId: "old-2", delayHours: 60 }]));
await setSetting("followup_no_click", JSON.stringify([{ templateId: "old-c1", delayHours: 40 }, { templateId: "", delayHours: 96 }]));
fu = await getFollowUpConfig();
check("the old single ladder becomes the customer ladder", fu.customer.noOpen[0].templateId === "old-1" && fu.customer.noClick[0].templateId === "old-c1");
check("the partner ladder starts empty, not a copy", fu.partner.noOpen[0].templateId === "" && fu.partner.noClick[0].templateId === "");
await setFollowUpConfig({ partner: { noOpen: [{ templateId: "new-p", delayHours: 24 }, { templateId: "", delayHours: 96 }] } });
fu = await getFollowUpConfig();
check("adding the partner ladder does not disturb the migrated one", fu.customer.noOpen[0].templateId === "old-1" && fu.partner.noOpen[0].templateId === "new-p");

console.log("\n— the gate, against real pool rows —");
await q(`DELETE FROM settings`);
await q(`DELETE FROM discovered_leads`);
const mk = (id: string, country: string | null, audience: string) =>
  q(
    `INSERT INTO discovered_leads (id,dedup_key,name,domain,email,country,audience,status,created_at)
     VALUES (?,?,?,?,?,?,?,'pending',?)`,
    [id, `e:${id}@x.com`, `Co ${id}`, `${id}.com`, `${id}@x.com`, country, audience, new Date().toISOString()]
  );
await mk("qa1", "Qatar", "customer");
await mk("qa2", "Qatar", "customer");
await mk("uk1", "United Kingdom", "customer");
await mk("sg1", "Singapore", "partner");
await mk("none1", null, "customer");

check("every customer lead counts with no gate", (await countApprovableLeads(null, null, "customer")) === 4);
check("Qatar alone counts 2", (await countApprovableLeads(null, null, "customer", ["Qatar"])) === 2);
check("Qatar + no-country counts 3", (await countApprovableLeads(null, null, "customer", ["Qatar", "__none__"])) === 3);
check("nowhere open counts 0", (await countApprovableLeads(null, null, "customer", [])) === 0);
check("the partner lane sees only its own", (await countApprovableLeads(null, null, "partner")) === 1);

const byCountry = await approvableByCountry("customer");
const qa = byCountry.find((r) => r.country === "Qatar");
check("grouped by country", qa?.n === 2, JSON.stringify(byCountry));
check("no-country is its own bucket", byCountry.some((r) => r.country === "__none__"));

// Approving with the gate on must take ONLY the open countries, and must leave
// the closed ones pending rather than marking them handled.
const approved = await approveLeads({ all: true, limit: 50, oldestFirst: true, filterAudience: "customer", filterCountries: ["Qatar"] });
check("approve honours the open-country list", approved.approvedIds.length === 2, String(approved.approvedIds.length));
const stillPending = await q(`SELECT id FROM discovered_leads WHERE status='pending'`);
check("closed countries are untouched", stillPending.length === 3, JSON.stringify(stillPending.map((r) => r.id)));

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}\n`);
process.exit(fail ? 1 : 0);
