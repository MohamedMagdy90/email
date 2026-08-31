// Outreach automation — "fill the pool, and it handles the rest".
//
// Watches the discovery review pool. The moment it holds N leads that have a
// real email (default 100), it approves that batch into Contacts and emails
// them with the template(s) you picked — no clicking Approve, no picking
// recipients, no hitting Send.
//
// TWO LANES. A discovery source is tagged customer or partner, and that tag
// rides the lead all the way here — so the automation runs as two independent
// pipelines that never mix: the customer lane approves and emails customer
// leads with the customer pitch, the partner lane does the same for partners.
// Each lane has its own switch, trigger count, templates and cooldown; the
// guard rails (send rate, daily ceiling, the Resend requirement) are shared,
// because they protect the sending domains, which both lanes share.
//
// Everything is guarded so it can never run away:
//   · a batch is exactly N — leftovers wait for the next batch
//   · a cooldown between runs, counted per lane
//   · a daily ceiling across BOTH lanes
//   · it refuses to run without a Resend key (so it can't silently "dry-run"
//     through your whole pool and mark everyone as sent)
//   · it never approves more leads than the sending domains can still deliver,
//     and hands back the ones a batch didn't reach
// Every run — including the ones it decides to skip — is written to
// automation_runs with the lane it belongs to, which is what the Settings
// screen reads back to you.
//
// APPROVING IS DESTRUCTIVE, AND THAT IS THE WHOLE DIFFICULTY HERE. A lead
// leaves the pool the moment it is approved, whether or not an email ever
// follows it, and the lanes only ever count leads that are still 'pending' — so
// anything approved into a send that doesn't happen is gone for good. That is
// not hypothetical: with the per-domain daily caps full, this ran for hours
// approving 150 leads at a time into a sender that could not deliver one of
// them, and recorded every one of those runs as "done · sent 0". Two rules fell
// out of it, and both are load-bearing:
//   1. ask the sender what it can deliver BEFORE approving anything, and size
//      the batch to that (`domainCapacity`)
//   2. whatever the batch didn't reach goes straight back to 'pending'
//      (`requeueLeads`), and a run that sent nothing is never "done"

import { q, nowIso, getSetting, setSetting, startOfDayIso } from "./db";
import { createJob, getJob, log, type Job } from "./jobs";
import { approveLeads, countApprovableLeads, approvableByCountry, normalizeAudience, requeueLeads, type Audience } from "./pool";
import { runSendJob, domainCapacity, type SendPlanOutcome } from "./send";
import { getResendKey } from "./resend";
import {
  getSchedule,
  describeWindow,
  windowFor,
  timezoneFor,
  localClock,
  isOpen,
  isPaused,
  nextOpenAt,
  keyOf,
  NO_COUNTRY,
  type ScheduleConfig,
} from "./schedule";

const uid = () => crypto.randomUUID();

function alog(msg: string) { console.log(`[automation] ${msg}`); }
function awarn(msg: string) { console.warn(`[automation] ${msg}`); }
function aerr(msg: string) { console.error(`[automation] ${msg}`); }

function clamp(n: number, lo: number, hi: number) {
  const x = Number(n);
  return Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
}

// How often the watcher checks the pool. Cheap (one COUNT per lane), so it can
// be brisk — the real spacing between runs is the cooldown.
const AUTOMATION_TICK_MS = 60_000;

/** The two pipelines, in the order the tick tries them. */
export const AUDIENCES: Audience[] = ["customer", "partner"];
const laneLabel = (a: Audience) => (a === "partner" ? "partner" : "customer");

let running = false;
let runningLane: Audience | null = null;
let started = false;

/* ------------------------------- config -------------------------------- */

/** Everything that is decided per audience. */
export interface AutomationLaneConfig {
  /** This lane on its own. The master switch above still has to be on. */
  enabled: boolean;
  /** Trigger point AND batch size: approve + email this many at a time. */
  threshold: number;
  /** Template(s) this lane sends. Several = they rotate. */
  templateIds: string[];
  /** rotate = one template per run · split = rotate per recipient inside a run. */
  templateMode: "rotate" | "split";
  /** Contact category applied to everything this lane approves. */
  category: string;
  /** Country override for approved contacts (blank = keep each lead's own). */
  country: string;
}

export interface AutomationConfig {
  /** Master switch. Off = neither lane runs, whatever their own switch says. */
  enabled: boolean;
  customer: AutomationLaneConfig;
  partner: AutomationLaneConfig;
  perMinute: number;
  /** Max emails the automation may send per day, across both lanes. 0 = none. */
  dailyLimit: number;
  /** Minimum gap between two runs OF THE SAME LANE. */
  cooldownMinutes: number;
  /** Refuse to run without a Resend key (never auto-"dry-run" a real pool). */
  requireResend: boolean;
}

// The partner lane starts OFF with a smaller batch: partner prospects (firms,
// VARs, consultancies) are a much shorter list than customers, so waiting for
// 100 of them would mean the lane never fires.
export const LANE_DEFAULTS: Record<Audience, AutomationLaneConfig> = {
  customer: { enabled: true, threshold: 100, templateIds: [], templateMode: "rotate", category: "", country: "" },
  partner: { enabled: false, threshold: 50, templateIds: [], templateMode: "rotate", category: "", country: "" },
};

export const AUTOMATION_DEFAULTS: AutomationConfig = {
  enabled: false,
  customer: LANE_DEFAULTS.customer,
  partner: LANE_DEFAULTS.partner,
  perMinute: 20,
  dailyLimit: 300,
  cooldownMinutes: 60,
  requireResend: true,
};

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((x) => String(x)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const laneKey = (a: Audience, field: string) => `automation_${a}_${field}`;

// Before the two lanes existed there was one set of settings. They belonged to
// what is now the customer lane, so the customer lane reads them as its
// fallback: an existing install keeps its threshold, templates, category and
// rotation position without anyone having to re-enter them.
const LEGACY_KEY: Record<string, string> = {
  threshold: "automation_threshold",
  template_ids: "automation_template_ids",
  template_mode: "automation_template_mode",
  category: "automation_category",
  country: "automation_country",
  template_index: "automation_template_index",
};

async function laneSetting(a: Audience, field: string): Promise<string | null> {
  const v = await getSetting(laneKey(a, field));
  if (v != null) return v;
  if (a === "customer" && LEGACY_KEY[field]) return await getSetting(LEGACY_KEY[field]);
  return null;
}

async function getLaneConfig(a: Audience): Promise<AutomationLaneConfig> {
  const d = LANE_DEFAULTS[a];
  const [enabled, threshold, ids, mode, category, country] = await Promise.all([
    laneSetting(a, "enabled"),
    laneSetting(a, "threshold"),
    laneSetting(a, "template_ids"),
    laneSetting(a, "template_mode"),
    laneSetting(a, "category"),
    laneSetting(a, "country"),
  ]);
  return {
    enabled: enabled == null ? d.enabled : enabled === "1",
    threshold: clamp(Number(threshold) || d.threshold, 1, 5000),
    templateIds: parseIds(ids),
    templateMode: mode === "split" ? "split" : "rotate",
    category: category || "",
    country: country || "",
  };
}

export async function getAutomationConfig(): Promise<AutomationConfig> {
  const [enabled, perMinute, dailyLimit, cooldown, requireResend, customer, partner] = await Promise.all([
    getSetting("automation_enabled"),
    getSetting("automation_per_minute"),
    getSetting("automation_daily_limit"),
    getSetting("automation_cooldown_minutes"),
    getSetting("automation_require_resend"),
    getLaneConfig("customer"),
    getLaneConfig("partner"),
  ]);
  return {
    enabled: enabled === "1",
    customer,
    partner,
    perMinute: clamp(Number(perMinute) || AUTOMATION_DEFAULTS.perMinute, 1, 120),
    dailyLimit: clamp(Number(dailyLimit ?? AUTOMATION_DEFAULTS.dailyLimit), 0, 100000),
    cooldownMinutes: clamp(Number(cooldown ?? AUTOMATION_DEFAULTS.cooldownMinutes), 0, 100000),
    requireResend: requireResend !== "0",
  };
}

async function setLaneConfig(a: Audience, patch: Partial<AutomationLaneConfig>): Promise<void> {
  if (typeof patch.enabled === "boolean") await setSetting(laneKey(a, "enabled"), patch.enabled ? "1" : "0");
  if (patch.threshold != null) await setSetting(laneKey(a, "threshold"), String(clamp(Number(patch.threshold), 1, 5000)));
  if (Array.isArray(patch.templateIds)) {
    const clean = [...new Set(patch.templateIds.map((x) => String(x)).filter(Boolean))].slice(0, 20);
    await setSetting(laneKey(a, "template_ids"), JSON.stringify(clean));
  }
  if (patch.templateMode) await setSetting(laneKey(a, "template_mode"), patch.templateMode === "split" ? "split" : "rotate");
  if (patch.category != null) await setSetting(laneKey(a, "category"), String(patch.category).trim());
  if (patch.country != null) await setSetting(laneKey(a, "country"), String(patch.country).trim());
}

export interface AutomationConfigPatch extends Partial<Omit<AutomationConfig, "customer" | "partner">> {
  customer?: Partial<AutomationLaneConfig>;
  partner?: Partial<AutomationLaneConfig>;
}

export async function setAutomationConfig(patch: AutomationConfigPatch): Promise<AutomationConfig> {
  if (typeof patch.enabled === "boolean") await setSetting("automation_enabled", patch.enabled ? "1" : "0");
  if (patch.perMinute != null) await setSetting("automation_per_minute", String(clamp(Number(patch.perMinute), 1, 120)));
  if (patch.dailyLimit != null) await setSetting("automation_daily_limit", String(clamp(Number(patch.dailyLimit), 0, 100000)));
  if (patch.cooldownMinutes != null) await setSetting("automation_cooldown_minutes", String(clamp(Number(patch.cooldownMinutes), 0, 100000)));
  if (typeof patch.requireResend === "boolean") await setSetting("automation_require_resend", patch.requireResend ? "1" : "0");
  if (patch.customer) await setLaneConfig("customer", patch.customer);
  if (patch.partner) await setLaneConfig("partner", patch.partner);

  const cfg = await getAutomationConfig();
  if (typeof patch.enabled === "boolean") {
    const live = AUDIENCES.filter((a) => cfg[a].enabled);
    alog(patch.enabled
      ? `switched ON — lanes: ${live.length ? live.map((a) => `${a} at ${cfg[a].threshold}`).join(" · ") : "none enabled"}`
      : "switched OFF — nothing will be approved or sent automatically");
    // Turning it on shouldn't wait a whole tick to notice a pool that's already full.
    if (patch.enabled) setTimeout(() => { automationTick().catch(() => {}); }, 1500);
  }
  return cfg;
}

/* -------------------------------- runs --------------------------------- */

export interface AutomationRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: string;              // auto | manual
  status: string;               // running | done | error | skipped
  audience: string;             // customer | partner
  threshold: number;
  pool_count: number;
  approved: number;
  contacts_added: number;
  sent: number;
  failed: number;
  skipped: number;
  template_names: string | null;
  job_id: string | null;
  note: string | null;
  error: string | null;
}

async function recentRuns(limit = 10): Promise<AutomationRun[]> {
  return (await q(
    `SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT ?`,
    [limit]
  )) as unknown as AutomationRun[];
}

// The daily ceiling resets at midnight UTC — the same boundary the per-domain
// sending caps roll over on. `startOfDayIso` lives in ./db so there is exactly
// one definition of "today" and the two ceilings can never disagree.

// The ceiling is shared, so with no audience this counts BOTH lanes.
async function sentToday(audience?: Audience): Promise<number> {
  const where = audience ? ` AND COALESCE(audience,'customer') = ?` : "";
  const params: any[] = [startOfDayIso()];
  if (audience) params.push(audience);
  const r = await q(
    `SELECT CAST(COALESCE(SUM(sent),0) AS INTEGER) AS n FROM automation_runs WHERE started_at >= ?${where}`,
    params
  );
  return Number(r[0]?.n ?? 0);
}

async function lastRealRun(audience?: Audience): Promise<AutomationRun | null> {
  // "Skipped" checks aren't runs — the cooldown only counts runs that did work.
  const where = audience ? ` AND COALESCE(audience,'customer') = ?` : "";
  const r = await q(
    `SELECT * FROM automation_runs WHERE status <> 'skipped'${where} ORDER BY started_at DESC LIMIT 1`,
    audience ? [audience] : []
  );
  return (r[0] as unknown as AutomationRun) || null;
}

/* ------------------------- send windows (per country) ------------------ */

// Which countries may be emailed RIGHT NOW. The pool spans several countries at
// once, so this is a set, not a flag: a batch goes out to every country whose
// local window is open and leaves the rest for their own morning.
async function openCountriesFor(cfg: ScheduleConfig, audience: Audience): Promise<string[] | null> {
  if (!cfg.enabled) return null; // null = no country restriction at all
  const rows = await approvableByCountry(audience);
  return rows.map((r) => keyOf(r.country)).filter((c) => isOpen(cfg, c));
}

export interface ScheduleCountryStatus {
  /** Canonical country name, or `__none__` for leads with no country. */
  country: string;
  timezone: string;
  /** Local time there right now, "14:05". */
  localTime: string;
  localDay: number;
  open: boolean;
  paused: boolean;
  /** When it next opens (null = open now, or never). */
  nextOpenAt: string | null;
  window: { start: number; end: number; days: number[] };
  /** True when this country has its own rule rather than the default. */
  custom: boolean;
  ready: number;
  customerReady: number;
  partnerReady: number;
}

export interface ScheduleStatus {
  config: ScheduleConfig;
  /** Every country the pool currently holds emailable leads for. */
  countries: ScheduleCountryStatus[];
  /** Leads sitting in a country whose window is shut. */
  holding: number;
  /** Leads that could go out right now. */
  sendable: number;
  /** The default window in words, for the UI's summary line. */
  summary: string;
}

export async function getScheduleStatus(): Promise<ScheduleStatus> {
  const config = await getSchedule();
  const [customer, partner] = await Promise.all([
    approvableByCountry("customer"),
    approvableByCountry("partner"),
  ]);
  const counts = new Map<string, { customer: number; partner: number }>();
  for (const r of customer) {
    const k = keyOf(r.country);
    counts.set(k, { customer: (counts.get(k)?.customer || 0) + r.n, partner: counts.get(k)?.partner || 0 });
  }
  for (const r of partner) {
    const k = keyOf(r.country);
    counts.set(k, { customer: counts.get(k)?.customer || 0, partner: (counts.get(k)?.partner || 0) + r.n });
  }

  const now = new Date();
  const countries: ScheduleCountryStatus[] = [];
  let holding = 0;
  let sendable = 0;
  for (const [country, n] of counts) {
    const tz = timezoneFor(config, country);
    const clock = localClock(tz, now);
    const open = isOpen(config, country, now);
    const ready = n.customer + n.partner;
    if (open) sendable += ready; else holding += ready;
    countries.push({
      country,
      timezone: tz,
      localTime: clock.hhmm,
      localDay: clock.day,
      open,
      paused: isPaused(config, country),
      nextOpenAt: nextOpenAt(config, country, now),
      window: windowFor(config, country),
      custom: !!config.countries[country],
      ready,
      customerReady: n.customer,
      partnerReady: n.partner,
    });
  }
  // Biggest pools first — that's the one whose window you care about.
  countries.sort((a, b) => b.ready - a.ready || a.country.localeCompare(b.country));

  return { config, countries, holding, sendable, summary: describeWindow(config.window) };
}

/* ------------------------------- status -------------------------------- */

export interface AutomationLaneStatus {
  audience: Audience;
  config: AutomationLaneConfig;
  /** Pending leads of THIS audience that already have an email. */
  ready: number;
  /** Of those, the ones whose country is inside its sending window now. */
  readyNow: number;
  remaining: number;
  /** True while this lane is the one mid-run. */
  running: boolean;
  sentToday: number;
  nextEligibleAt: string | null; // this lane's cooldown end
  /** Earliest moment a held-back country opens (null = nothing is held). */
  windowOpensAt: string | null;
  lastRun: AutomationRun | null;
  /** Templates this lane has selected AND that still exist. */
  templates: { id: string; name: string; type: string }[];
  /** What stands between this lane and firing. */
  blockers: string[];
}

export interface AutomationStatus {
  config: AutomationConfig;
  lanes: AutomationLaneStatus[]; // [customer, partner]
  /** Both lanes' emailable leads combined — the whole pool, ready to go. */
  ready: number;
  running: boolean;
  sentToday: number;
  dailyRemaining: number | null; // null = no ceiling
  /**
   * What the SENDING DOMAINS can still deliver today — a different ceiling from
   * `dailyRemaining`, and in practice the one that runs out first. Surfaced
   * because a day of "done · sent 0" runs was completely unreadable without it.
   */
  capacityRemaining: number | null; // null = no cap on any sender
  lastRun: AutomationRun | null;
  runs: AutomationRun[];
  /** Blockers that stop BOTH lanes (no key, ceiling reached, domains spent). */
  blockers: string[];
  /** Per-country sending windows and the local clock in each. */
  schedule: ScheduleStatus;
}

async function selectedTemplates(ids: string[]): Promise<{ id: string; name: string; type: string }[]> {
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  const rows = await q(`SELECT id, name, type FROM templates WHERE id IN (${ph})`, ids);
  // Preserve the saved order (that's the rotation order).
  const byId = new Map(rows.map((r) => [String(r.id), { id: String(r.id), name: String(r.name), type: String(r.type) }]));
  return ids.map((id) => byId.get(id)).filter(Boolean) as { id: string; name: string; type: string }[];
}

export async function getAutomationStatus(): Promise<AutomationStatus> {
  const config = await getAutomationConfig();
  const [today, last, runs, resendKey, schedule, capacity] = await Promise.all([
    sentToday(),
    lastRealRun(),
    recentRuns(),
    getResendKey(),
    getScheduleStatus(),
    domainCapacity(),
  ]);

  const dailyRemaining = config.dailyLimit > 0 ? Math.max(0, config.dailyLimit - today) : null;

  const shared: string[] = [];
  if (config.requireResend && !resendKey) shared.push("No Resend API key — add one above so real emails can go out.");
  if (dailyRemaining === 0) shared.push(`Daily ceiling reached (${config.dailyLimit} sent today) — it resumes tomorrow.`);
  // The blocker that used to be invisible: every lane read as perfectly healthy
  // while the domains had nothing left, so the only symptom was runs quietly
  // sending zero.
  if (capacity.remaining <= 0 && capacity.reason) shared.push(capacity.reason);

  const open = schedule.config.enabled ? schedule.countries.filter((c) => c.open).map((c) => c.country) : null;

  const lanes: AutomationLaneStatus[] = [];
  for (const audience of AUDIENCES) {
    const lane = config[audience];
    const [ready, readyNow, templates, laneSent, laneLast] = await Promise.all([
      countApprovableLeads(null, null, audience),
      open ? countApprovableLeads(null, null, audience, open) : countApprovableLeads(null, null, audience),
      selectedTemplates(lane.templateIds),
      sentToday(audience),
      lastRealRun(audience),
    ]);
    const blockers: string[] = [];
    if (!templates.length) {
      blockers.push(`No ${laneLabel(audience)} template chosen — pick the email this lane should send.`);
    }
    // The soonest a country holding this lane's leads opens up.
    const held = schedule.countries
      .filter((c) => !c.open && (audience === "partner" ? c.partnerReady : c.customerReady) > 0 && c.nextOpenAt)
      .map((c) => c.nextOpenAt as string)
      .sort();
    lanes.push({
      audience,
      config: lane,
      ready,
      readyNow,
      remaining: Math.max(0, lane.threshold - readyNow),
      running: running && runningLane === audience,
      sentToday: laneSent,
      nextEligibleAt:
        laneLast && config.cooldownMinutes > 0
          ? new Date(new Date(laneLast.started_at).getTime() + config.cooldownMinutes * 60000).toISOString()
          : null,
      windowOpensAt: held[0] || null,
      lastRun: laneLast,
      templates,
      blockers,
    });
  }

  return {
    config,
    lanes,
    ready: lanes.reduce((n, l) => n + l.ready, 0),
    running,
    sentToday: today,
    dailyRemaining,
    capacityRemaining: Number.isFinite(capacity.remaining) ? capacity.remaining : null,
    lastRun: last,
    runs,
    blockers: shared,
    schedule,
  };
}

/* ----------------------------- run executor ---------------------------- */

async function recordSkip(trigger: string, audience: Audience, threshold: number, poolCount: number, note: string) {
  const now = nowIso();
  await q(
    `INSERT INTO automation_runs (id,started_at,finished_at,trigger,audience,status,threshold,pool_count,note)
     VALUES (?,?,?,?,?,'skipped',?,?,?)`,
    [uid(), now, now, trigger, audience, threshold, poolCount, note]
  );
}

export interface StartRunResult {
  started: boolean;
  audience?: Audience;
  runId?: string;
  jobId?: string;
  approved?: number;
  error?: string;
  note?: string;
}

// Approve the next batch of ONE audience and start emailing it. Returns as soon
// as the batch is created — the send itself streams in the background (a
// 100-email batch at 20 per minute takes 5 minutes), and the run row is
// finalised when it finishes.
export async function startAutomationRun(
  trigger: "auto" | "manual" = "auto",
  audienceIn: Audience | string = "customer"
): Promise<StartRunResult> {
  if (running) return { started: false, error: "An automation run is already in progress." };
  const audience = normalizeAudience(audienceIn);
  const who = laneLabel(audience);

  const config = await getAutomationConfig();
  const lane = config[audience];

  // Only countries whose local window is open may be emailed. A MANUAL run is
  // you deciding to send now, so it ignores the window entirely — same as it
  // already ignores the trigger count and the cooldown.
  const schedule = await getSchedule();
  const openList = trigger === "manual" ? null : await openCountriesFor(schedule, audience);
  const pool = await countApprovableLeads(null, null, audience, openList);

  if (openList && !openList.length) {
    const waiting = await countApprovableLeads(null, null, audience);
    const note = waiting
      ? `Outside the sending window everywhere — ${waiting.toLocaleString()} ${who} lead(s) are waiting for their country's local morning.`
      : `No ${who} leads with an email are waiting.`;
    if (trigger === "manual") return { started: false, audience, error: note };
    return { started: false, audience, note };
  }

  // ---- Safety checks -----------------------------------------------------
  const templates = await selectedTemplates(lane.templateIds);
  if (!templates.length) {
    const note = `No usable ${who} template selected — nothing was sent.`;
    await recordSkip(trigger, audience, lane.threshold, pool, note);
    awarn(note);
    return { started: false, audience, error: note };
  }
  if (config.requireResend && !(await getResendKey())) {
    const note = "No Resend API key — automation paused so nothing is marked as sent by a dry run.";
    await recordSkip(trigger, audience, lane.threshold, pool, note);
    awarn(note);
    return { started: false, audience, error: note };
  }

  const today = await sentToday();
  const dailyRoom = config.dailyLimit > 0 ? config.dailyLimit - today : Number.MAX_SAFE_INTEGER;
  if (dailyRoom <= 0) {
    const note = `Daily ceiling reached (${today}/${config.dailyLimit} sent today).`;
    await recordSkip(trigger, audience, lane.threshold, pool, note);
    alog(note);
    return { started: false, audience, error: note };
  }

  // CAN THE SENDER ACTUALLY DELIVER ANY OF THIS?
  //
  // Asked here, before a single lead is approved, because approving is the one
  // step that cannot be taken back by simply trying again later. Leaving this
  // out is what let a set of capped-out domains turn into an afternoon of
  // "done · sent 0" runs, each quietly swallowing another 150 leads.
  const capacity = await domainCapacity();
  if (capacity.remaining <= 0) {
    const note = capacity.reason || "No sending capacity left today.";
    // Only the manual path writes a row. The tick refuses to get this far while
    // the domains are spent (see `automationTick`), so an auto run arriving here
    // is a rare race — and a skip row every minute for hours helps nobody.
    if (trigger === "manual") {
      await recordSkip(trigger, audience, lane.threshold, pool, note);
      awarn(note);
      return { started: false, audience, error: note };
    }
    return { started: false, audience, note };
  }

  if (!pool) {
    const note = `No ${who} leads with an email are waiting.`;
    if (trigger === "manual") return { started: false, audience, error: note };
    return { started: false, audience, note };
  }

  // A batch never exceeds the trigger size, what's left of today's ceiling, nor
  // what the domains can still physically deliver. That last term is the point
  // of all this: with 20 sends left in the caps, approve 20 leads and email 20
  // leads, rather than approving 150 and stranding 130 of them.
  const batchSize = Math.max(1, Math.min(lane.threshold, pool, dailyRoom, capacity.remaining));

  running = true;
  runningLane = audience;
  const runId = uid();
  const startedAt = nowIso();
  const templateNames = templates.map((t) => t.name).join(", ");
  await q(
    `INSERT INTO automation_runs (id,started_at,trigger,audience,status,threshold,pool_count,template_names)
     VALUES (?,?,?,?,'running',?,?,?)`,
    [runId, startedAt, trigger, audience, lane.threshold, pool, templateNames]
  );
  const whereNote = openList ? ` · inside the window in ${openList.map((c) => (c === NO_COUNTRY ? "no-country" : c)).join(", ")}` : "";
  const capNote = Number.isFinite(capacity.remaining) ? ` · ${capacity.remaining} left in today's domain caps` : "";
  alog(`▶ ${trigger} ${who} run — pool holds ${pool} emailable ${who} lead(s)${whereNote}, taking ${batchSize}${capNote} · template(s): ${templateNames}`);

  const finishRun = (patchSql: string, params: any[]) =>
    q(patchSql, params).catch(() => {});

  let approve;
  try {
    approve = await approveLeads({
      all: true,
      limit: batchSize,
      oldestFirst: true,
      filterAudience: audience,
      filterCountries: openList,
      category: lane.category || null,
      country: lane.country || null,
    });
  } catch (e: any) {
    running = false; runningLane = null;
    const msg = String(e?.message || e);
    await finishRun(`UPDATE automation_runs SET status='error', finished_at=?, error=? WHERE id=?`, [nowIso(), msg, runId]);
    aerr(`${who} approval failed: ${msg}`);
    return { started: false, audience, error: msg };
  }

  // `adopted` are people already in Contacts who had never actually been
  // emailed — imported before the import-to-pool route existed, most commonly.
  // They cost no new contact row but they DO get the email, so they have to be
  // counted here or a batch made entirely of backfill would read as
  // "approved 0" and look like it had done nothing.
  const recipients = approve.added + approve.adopted;
  alog(
    `approved ${approve.approvedIds.length} ${who} lead(s) → ${approve.added} new contact(s)` +
    (approve.adopted ? ` · ${approve.adopted} already on file, never emailed` : "") +
    (approve.skipped ? ` · ${approve.skipped} already known` : "")
  );

  if (!approve.contactIds.length) {
    running = false; runningLane = null;
    const note = "Every lead in that batch was already a contact that has been emailed before — nothing to send.";
    await finishRun(
      `UPDATE automation_runs SET status='done', finished_at=?, approved=?, contacts_added=0, note=? WHERE id=?`,
      [nowIso(), approve.approvedIds.length, note, runId]
    );
    alog(note);
    return { started: true, audience, runId, approved: approve.approvedIds.length, note };
  }

  // Which template(s) this run uses: "rotate" walks the list one per run,
  // "split" hands the whole list to the sender so it alternates per recipient.
  // The rotation position is per lane — the two pipelines must not share a
  // cursor, or the partner lane would skip a template every time the customer
  // lane fired.
  let sendTemplateIds: string[];
  if (lane.templateMode === "split" || templates.length === 1) {
    sendTemplateIds = templates.map((t) => t.id);
  } else {
    const idx = Number((await laneSetting(audience, "template_index")) || 0) % templates.length;
    sendTemplateIds = [templates[idx].id];
    await setSetting(laneKey(audience, "template_index"), String((idx + 1) % templates.length));
  }
  const usedNames = templates.filter((t) => sendTemplateIds.includes(t.id)).map((t) => t.name).join(", ");

  const job: Job = createJob("send", approve.contactIds.length);
  job.result = { sent: 0, failed: 0, skipped: 0 };
  log(job, { level: "info", msg: `Automation (${who}): emailing ${approve.contactIds.length} newly-approved contact(s) with "${usedNames}".` });
  await q(`UPDATE automation_runs SET approved=?, contacts_added=?, job_id=?, template_names=? WHERE id=?`, [
    approve.approvedIds.length, recipients, job.id, usedNames, runId,
  ]);

  // Fire-and-forget: the caller (HTTP request or the tick) mustn't wait minutes.
  (async () => {
    let outcome: SendPlanOutcome | null = null;
    try {
      outcome = await runSendJob(job, sendTemplateIds, approve.contactIds, config.perMinute);
      if (job.status === "running") { job.status = "done"; job.progress = 1; }
    } catch (e: any) {
      job.status = "error";
      job.error = String(e?.message || e);
    } finally {
      const r = job.result || {};
      const sent = Number(r.sent || 0);
      const failed = Number(r.failed || 0);
      const skipped = Number(r.skipped || 0);

      // ---- Hand back what the batch never reached -------------------------
      //
      // These leads were marked 'approved' before the first email was even
      // attempted. If the sender stopped early — every domain capped, the
      // template deleted underneath it — everyone past that point would
      // otherwise be stranded for good: out of the pool, in Contacts, never
      // emailed, and invisible to a lane that only counts 'pending'.
      //
      // `outcome` names them exactly. If the job threw instead, the plan runs in
      // the same order as `contactIds`, so everything past `job.processed` is by
      // definition untouched.
      const unattempted = outcome ? outcome.unattempted : approve.contactIds.slice(job.processed);
      let requeued = 0;
      if (unattempted.length) {
        const leadIds = unattempted.map((cid) => approve.leadByContact[cid]).filter(Boolean);
        requeued = await requeueLeads(leadIds).catch(() => 0);
        if (requeued) alog(`↩ returned ${requeued} un-emailed ${who} lead(s) to the pool`);
      }

      // ---- Say what actually happened -------------------------------------
      //
      // A run that queued recipients and attempted NONE of them is not "done".
      // It used to be recorded that way — green badge, "approved 150 · sent 0" —
      // which is precisely how a whole day of delivering nothing managed to look
      // healthy on the Settings screen.
      const attempted = sent + failed + skipped;
      const stalled = attempted === 0 && approve.contactIds.length > 0;
      const status = job.status === "error" || stalled ? "error" : "done";
      const reason = job.error || outcome?.stopped || null;

      const note = stalled
        ? `Nothing could be sent — ${reason || "the sender stopped before the first email."}` +
          (requeued ? ` ${requeued} lead(s) returned to the pool.` : "")
        : `Approved ${recipients} ${who} contact(s) from the pool` +
          (approve.adopted ? ` (${approve.adopted} already on file, never emailed)` : "") +
          ` and emailed them with "${usedNames}".` +
          (requeued ? ` Stopped early — ${requeued} lead(s) returned to the pool.` : "");

      await finishRun(
        `UPDATE automation_runs
            SET status=?, finished_at=?, sent=?, failed=?, skipped=?, error=?, note=?
          WHERE id=?`,
        [status, nowIso(), sent, failed, skipped, stalled ? reason : job.error || null, note, runId]
      );
      await setSetting("automation_last_run_at", nowIso()).catch(() => {});
      running = false; runningLane = null;
      if (status === "error") aerr(`${who} run finished without sending: ${reason || "unknown reason"}`);
      else alog(`✓ ${who} run complete — sent ${sent}, failed ${failed}, skipped ${skipped}`);
    }
  })();

  return { started: true, audience, runId, jobId: job.id, approved: recipients };
}

/* -------------------------------- ticks -------------------------------- */

// Logged on the way in and the way out only. The tick runs every minute, and a
// capped-out afternoon should not put four hundred identical lines in the log.
let capacityBlocked = false;

async function automationTick(): Promise<void> {
  if (running) return;
  const config = await getAutomationConfig();
  if (!config.enabled) return;
  const schedule = await getSchedule();

  // Settled once, up here, because the ceiling is shared by both lanes.
  //
  // Nothing may be approved while the domains have nothing left to give. The
  // pool is the asset this whole system exists to build, and spending it on
  // emails that cannot be sent is the one mistake that waiting will not fix.
  const capacity = await domainCapacity();
  if (capacity.remaining <= 0) {
    if (!capacityBlocked) {
      capacityBlocked = true;
      awarn(`holding — ${capacity.reason} Nothing will be approved until there is room again.`);
    }
    return;
  }
  if (capacityBlocked) {
    capacityBlocked = false;
    alog(`resuming — ${Number.isFinite(capacity.remaining) ? `${capacity.remaining} email(s)` : "capacity"} available again`);
  }

  // Both lanes are checked every tick, customer first. Only one may run at a
  // time (they share the sending domains), so the second one goes on the next
  // tick — a minute later at most.
  for (const audience of AUDIENCES) {
    const lane = config[audience];
    if (!lane.enabled) continue;
    // A lane with no template can't send. That's a configuration gap, not an
    // event: it's reported as a blocker in the UI rather than filling the
    // ledger with a skip row every single minute.
    if (!lane.templateIds.length) continue;

    // Cooldown — a run only starts once the gap since this lane's last one has
    // elapsed. The other lane's runs don't count.
    if (config.cooldownMinutes > 0) {
      const last = await lastRealRun(audience);
      if (last && Date.now() < new Date(last.started_at).getTime() + config.cooldownMinutes * 60000) continue;
    }

    // Only the countries that are inside their own working hours count toward
    // the trigger — otherwise a pool full of sleeping countries would fire a
    // batch at 3am local time, which is the whole problem this solves.
    const openList = await openCountriesFor(schedule, audience);
    if (openList && !openList.length) continue;
    const ready = await countApprovableLeads(null, null, audience, openList);
    if (ready < lane.threshold) continue;

    const where = openList ? ` in ${openList.map((c) => (c === NO_COUNTRY ? "no-country" : c)).join(", ")}` : "";
    alog(`${laneLabel(audience)} pool reached ${ready}/${lane.threshold} lead(s) with an email${where} — starting an automated run`);
    await startAutomationRun("auto", audience);
    return; // one at a time; the next tick picks up the other lane
  }
}

export function startAutomationWorker(): void {
  if (started) return;
  started = true;
  setInterval(() => { automationTick().catch((e) => aerr(`tick failed: ${String(e?.message || e)}`)); }, AUTOMATION_TICK_MS);
  setTimeout(() => { automationTick().catch(() => {}); }, 9000);

  (async () => {
    try {
      const c = await getAutomationConfig();
      const s = await getSchedule();
      alog(
        s.enabled
          ? `sending window → ${describeWindow(s.window)} in each country's OWN time zone`
          : "sending window → OFF (batches go out the moment a lane's pool is full, whatever the local clock says)"
      );
      if (!c.enabled) { alog("state → OFF (turn it on in Settings → Automation)"); return; }
      const parts: string[] = [];
      for (const a of AUDIENCES) {
        const lane = c[a];
        const ready = await countApprovableLeads(null, null, a);
        parts.push(
          lane.enabled
            ? `${a}: trigger at ${lane.threshold} · ${ready} ready · ${lane.templateIds.length} template(s)`
            : `${a}: off`
        );
      }
      alog(`state → ON · ${parts.join(" | ")} · ${c.perMinute}/min · daily cap ${c.dailyLimit || "none"} (shared)`);
    } catch { /* ignore */ }
  })();
}

// The live send job behind a run, so the UI can show progress while it streams.
export function getRunJob(jobId: string) { return getJob(jobId); }
