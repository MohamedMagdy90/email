// Follow-up ladder — "one email and silence" is not an outreach strategy.
//
// Every email the app sends (campaign OR automation) starts a sequence. What
// the recipient DID with it decides what happens next:
//
//   didn't open   → after N hours, send the "no open" retry
//                   still no open? → after M hours, send the second one
//   opened, no click → after N hours, send the "opened, no click" retry
//                      still no click? → after M hours, the second one
//   clicked       → done. They engaged; chasing them now only costs goodwill.
//
// Hard ceiling of `maxEmails` per sequence (3 by default: the original + two
// retries), so nobody can ever be walked round the ladder twice.
//
// TWO LADDERS. Customers and partners get completely different pitches, so they
// get completely different retries: each audience has its own no-open and
// no-click rungs, and a contact walks the ladder of the audience they were
// tagged with. (They used to share one set of settings, which meant saving the
// partner retries silently overwrote the customer ones.)
//
// The state is DERIVED from the sends table on every pass rather than stored in
// a queue. That matters: an open that lands late, a bounce, an unsubscribe, a
// template you delete, a run that crashes half way — all of it is simply the
// next scan's input. There is no schedule to fall out of sync with reality.
//
// The one thing that is NOT derived from the ledger is WHEN: a retry that comes
// due at 02:00 in the recipient's country waits for that country's sending
// window (see ./schedule).

import { q, nowIso, getSetting, setSetting } from "./db";
import { createJob, getJob, log, type Job } from "./jobs";
import { runSendPlan, type SendPlanItem, type SendPlanOutcome } from "./send";
import { getResendKey } from "./resend";
import { normalizeAudience, type Audience } from "./pool";
import { getSchedule, isOpen, nextOpenAt, keyOf } from "./schedule";

const uid = () => crypto.randomUUID();

function flog(msg: string) { console.log(`[followup] ${msg}`); }
function fwarn(msg: string) { console.warn(`[followup] ${msg}`); }
function ferr(msg: string) { console.error(`[followup] ${msg}`); }

function clamp(n: number, lo: number, hi: number) {
  const x = Number(n);
  return Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
}

// The ladder is measured in hours, so a 5-minute heartbeat is plenty and keeps
// the aggregate scan off the hot path.
const FOLLOWUP_TICK_MS = 5 * 60_000;

// How many sequences one scan will look at. The scan reads the newest-idle
// sequences first, so this is a cost ceiling, not a correctness limit.
const SCAN_CAP = 4000;

// The status endpoint is polled by the Settings screen; the scan behind it is a
// GROUP BY over the whole sends table, so its result is reused briefly.
const SCAN_CACHE_MS = 12_000;

let running = false;
let started = false;

export type Branch = "no_open" | "no_click";
export const MAX_STEPS = 2; // retries per sequence — the ladder has two rungs
/** The two ladders, in the order everything iterates them. */
export const AUDIENCES: Audience[] = ["customer", "partner"];

/* ------------------------------- config -------------------------------- */

export interface FollowUpStepConfig {
  /** Template sent at this rung. Blank = the rung is off. */
  templateId: string;
  /** Hours to wait after the PREVIOUS email before this one goes out. */
  delayHours: number;
}

/**
 * One audience's ladder.
 *
 * These used to be a single shared pair of rungs, which meant saving the
 * partner retries overwrote the customer ones and vice versa — the two pitches
 * were fighting over one set of settings. A contact's audience is decided by
 * the source that found them, so the ladder they walk has to be too.
 */
export interface FollowUpLadder {
  /** They never opened. [first retry, second retry] */
  noOpen: FollowUpStepConfig[];
  /** They opened but never clicked. [first retry, second retry] */
  noClick: FollowUpStepConfig[];
}

export interface FollowUpConfig {
  enabled: boolean;
  /** Ceiling per sequence, including the original email. 2 or 3. */
  maxEmails: number;
  customer: FollowUpLadder;
  partner: FollowUpLadder;
  perMinute: number;
  /** Max follow-ups per day. 0 = no ceiling. */
  dailyLimit: number;
  /** Max follow-ups in a single pass, so one sweep can't empty the backlog. */
  batchSize: number;
  /**
   * Ignore sequences whose last email is older than this. Without it, switching
   * the ladder on would blast every contact ever emailed and never opened.
   */
  lookbackDays: number;
  /** Refuse to run without a Resend key (never auto-"dry-run" a real list). */
  requireResend: boolean;
  /**
   * Mirror of the customer ladder, purely so an older frontend (or an
   * integration written against the single-ladder API) keeps working.
   * Writes to these are applied to the customer lane.
   */
  noOpen: FollowUpStepConfig[];
  noClick: FollowUpStepConfig[];
}

const DEFAULT_LADDER = (): FollowUpLadder => ({
  noOpen: [{ templateId: "", delayHours: 48 }, { templateId: "", delayHours: 96 }],
  noClick: [{ templateId: "", delayHours: 48 }, { templateId: "", delayHours: 96 }],
});

export const FOLLOWUP_DEFAULTS: FollowUpConfig = {
  enabled: false,
  maxEmails: 3,
  customer: DEFAULT_LADDER(),
  partner: DEFAULT_LADDER(),
  perMinute: 20,
  dailyLimit: 200,
  batchSize: 100,
  lookbackDays: 30,
  requireResend: true,
  noOpen: DEFAULT_LADDER().noOpen,
  noClick: DEFAULT_LADDER().noClick,
};

// Always returns exactly MAX_STEPS rungs, whatever is in storage — the UI and
// the engine both index into this blindly.
function parseSteps(raw: string | null, fallback: FollowUpStepConfig[]): FollowUpStepConfig[] {
  let arr: any[] = [];
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) arr = parsed;
  } catch { /* fall through to defaults */ }
  return cleanSteps(arr, fallback);
}

function cleanSteps(input: any, fallback: FollowUpStepConfig[]): FollowUpStepConfig[] {
  const arr = Array.isArray(input) ? input : [];
  const out: FollowUpStepConfig[] = [];
  for (let i = 0; i < MAX_STEPS; i++) {
    const src = arr[i] || {};
    out.push({
      templateId: String(src.templateId || "").trim(),
      delayHours: clamp(Number(src.delayHours) || fallback[i].delayHours, 1, 24 * 90),
    });
  }
  return out;
}

const ladderKey = (a: Audience, branch: "no_open" | "no_click") => `followup_${a}_${branch}`;

// Before the two ladders existed there was one, and it belonged to what is now
// the customer lane — so the customer lane reads the old keys as its fallback.
// An existing install keeps its templates and waits without re-entering them.
const LEGACY_KEY: Record<string, string> = {
  no_open: "followup_no_open",
  no_click: "followup_no_click",
};

async function ladderSetting(a: Audience, branch: "no_open" | "no_click"): Promise<string | null> {
  const v = await getSetting(ladderKey(a, branch));
  if (v != null) return v;
  if (a === "customer") return await getSetting(LEGACY_KEY[branch]);
  return null;
}

async function getLadder(a: Audience): Promise<FollowUpLadder> {
  const d = DEFAULT_LADDER();
  const [noOpen, noClick] = await Promise.all([
    ladderSetting(a, "no_open"),
    ladderSetting(a, "no_click"),
  ]);
  return { noOpen: parseSteps(noOpen, d.noOpen), noClick: parseSteps(noClick, d.noClick) };
}

export async function getFollowUpConfig(): Promise<FollowUpConfig> {
  const [enabled, maxEmails, perMinute, dailyLimit, batchSize, lookback, requireResend, customer, partner] =
    await Promise.all([
      getSetting("followup_enabled"),
      getSetting("followup_max_emails"),
      getSetting("followup_per_minute"),
      getSetting("followup_daily_limit"),
      getSetting("followup_batch_size"),
      getSetting("followup_lookback_days"),
      getSetting("followup_require_resend"),
      getLadder("customer"),
      getLadder("partner"),
    ]);
  return {
    enabled: enabled === "1",
    maxEmails: clamp(Number(maxEmails) || FOLLOWUP_DEFAULTS.maxEmails, 2, MAX_STEPS + 1),
    customer,
    partner,
    perMinute: clamp(Number(perMinute) || FOLLOWUP_DEFAULTS.perMinute, 1, 120),
    dailyLimit: clamp(Number(dailyLimit ?? FOLLOWUP_DEFAULTS.dailyLimit), 0, 100000),
    batchSize: clamp(Number(batchSize) || FOLLOWUP_DEFAULTS.batchSize, 1, 2000),
    lookbackDays: clamp(Number(lookback) || FOLLOWUP_DEFAULTS.lookbackDays, 1, 365),
    requireResend: requireResend !== "0",
    noOpen: customer.noOpen,
    noClick: customer.noClick,
  };
}

/** The ladder a contact of this audience walks. */
export function ladderOf(cfg: FollowUpConfig, audience: Audience): FollowUpLadder {
  return audience === "partner" ? cfg.partner : cfg.customer;
}

export interface FollowUpConfigPatch
  extends Partial<Omit<FollowUpConfig, "customer" | "partner" | "noOpen" | "noClick">> {
  customer?: Partial<FollowUpLadder>;
  partner?: Partial<FollowUpLadder>;
  /** Legacy single-ladder fields — applied to the customer lane. */
  noOpen?: FollowUpStepConfig[];
  noClick?: FollowUpStepConfig[];
}

async function setLadder(a: Audience, patch: Partial<FollowUpLadder>): Promise<void> {
  const d = DEFAULT_LADDER();
  if (patch.noOpen) await setSetting(ladderKey(a, "no_open"), JSON.stringify(cleanSteps(patch.noOpen, d.noOpen)));
  if (patch.noClick) await setSetting(ladderKey(a, "no_click"), JSON.stringify(cleanSteps(patch.noClick, d.noClick)));
}

export async function setFollowUpConfig(patch: FollowUpConfigPatch): Promise<FollowUpConfig> {
  if (typeof patch.enabled === "boolean") await setSetting("followup_enabled", patch.enabled ? "1" : "0");
  if (patch.maxEmails != null) await setSetting("followup_max_emails", String(clamp(Number(patch.maxEmails), 2, MAX_STEPS + 1)));
  if (patch.perMinute != null) await setSetting("followup_per_minute", String(clamp(Number(patch.perMinute), 1, 120)));
  if (patch.dailyLimit != null) await setSetting("followup_daily_limit", String(clamp(Number(patch.dailyLimit), 0, 100000)));
  if (patch.batchSize != null) await setSetting("followup_batch_size", String(clamp(Number(patch.batchSize), 1, 2000)));
  if (patch.lookbackDays != null) await setSetting("followup_lookback_days", String(clamp(Number(patch.lookbackDays), 1, 365)));
  if (typeof patch.requireResend === "boolean") await setSetting("followup_require_resend", patch.requireResend ? "1" : "0");
  // Lanes are written independently — that's the whole fix. Saving one never
  // touches the other, and a legacy flat payload only ever writes the customer.
  if (patch.customer) await setLadder("customer", patch.customer);
  if (patch.partner) await setLadder("partner", patch.partner);
  if (!patch.customer && (patch.noOpen || patch.noClick)) {
    await setLadder("customer", { noOpen: patch.noOpen, noClick: patch.noClick });
  }

  scanCache = null; // config drives the scan — never answer from a stale one
  const cfg = await getFollowUpConfig();
  if (typeof patch.enabled === "boolean") {
    flog(patch.enabled
      ? `switched ON — up to ${cfg.maxEmails} emails per contact, customer retries ${cfg.customer.noOpen[0].delayHours}h / ${cfg.customer.noOpen[1].delayHours}h`
      : "switched OFF — no retries will be sent");
    if (patch.enabled) setTimeout(() => { followUpTick().catch(() => {}); }, 1500);
  }
  return cfg;
}

/* -------------------------------- runs --------------------------------- */

export interface FollowUpRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: string;   // auto | manual
  status: string;    // running | done | error | skipped
  due_count: number;
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  no_open: number;
  no_click: number;
  retry1: number;
  retry2: number;
  template_names: string | null;
  job_id: string | null;
  note: string | null;
  error: string | null;
}

async function recentRuns(limit = 8): Promise<FollowUpRun[]> {
  return (await q(
    `SELECT * FROM followup_runs ORDER BY started_at DESC LIMIT ?`,
    [limit]
  )) as unknown as FollowUpRun[];
}

function startOfDayIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

async function sentToday(): Promise<number> {
  const r = await q(
    `SELECT CAST(COALESCE(SUM(sent),0) AS INTEGER) AS n FROM followup_runs WHERE started_at >= ?`,
    [startOfDayIso()]
  );
  return Number(r[0]?.n ?? 0);
}

async function lastRealRun(): Promise<FollowUpRun | null> {
  const r = await q(`SELECT * FROM followup_runs WHERE status <> 'skipped' ORDER BY started_at DESC LIMIT 1`);
  return (r[0] as unknown as FollowUpRun) || null;
}

async function recordSkip(trigger: string, dueCount: number, note: string) {
  const now = nowIso();
  await q(
    `INSERT INTO followup_runs (id,started_at,finished_at,trigger,status,due_count,note)
     VALUES (?,?,?,?,'skipped',?,?)`,
    [uid(), now, now, trigger, dueCount, note]
  );
}

/* -------------------------------- scan --------------------------------- */

export interface DueFollowUp {
  contactId: string;
  email: string;
  /** Which ladder this contact walks — decided by the contact's own tag. */
  audience: Audience;
  country: string;
  branch: Branch;
  step: number;          // 1 = first retry, 2 = second
  templateId: string;
  lastSentAt: string;
  dueAt: string;
}

export interface ScanResult {
  due: DueFollowUp[];
  /** In a sequence, eligible, but the clock hasn't run out yet. */
  waiting: number;
  /** Eligible but the rung they'd take has no template — nothing will happen. */
  unconfigured: number;
  /** Due, but their country is outside its sending window right now. */
  holding: number;
  /** The soonest a held-back contact's country opens. */
  holdingUntil: string | null;
  /** Per rung (audience:branch:step): how many are due now and how many wait. */
  rungs: Record<string, { due: number; waiting: number; next: string | null }>;
  /** Sequences considered (capped at SCAN_CAP). */
  scanned: boolean;
}

const rungKey = (audience: Audience, branch: Branch, step: number) => `${audience}:${branch}:${step}`;

let scanCache: { at: number; result: ScanResult } | null = null;

/** Config changed under us — the next read must not answer from the old scan. */
export function invalidateFollowUpScan() { scanCache = null; }

/**
 * Read every live sequence back out of the sends ledger.
 *
 * A "sequence" starts at the contact's most recent ORIGINAL email
 * (followup_step = 0) and covers everything sent after it. Counting from there
 * (rather than counting all sends ever) is what lets a contact who was mailed
 * in a campaign months ago still be followed up today.
 *
 * The contact's AUDIENCE and COUNTRY come back with the row: the first decides
 * which ladder they walk, the second whether their country is awake yet.
 */
export async function scanSequences(cfg: FollowUpConfig, force = false): Promise<ScanResult> {
  if (!force && scanCache && Date.now() - scanCache.at < SCAN_CACHE_MS) return scanCache.result;

  const cutoff = new Date(Date.now() - cfg.lookbackDays * 86_400_000).toISOString();
  const rows = await q(
    `SELECT s.contact_id AS contact_id,
            MAX(s.contact_email) AS email,
            MAX(COALESCE(c.audience,'customer')) AS audience,
            MAX(COALESCE(c.country,'')) AS country,
            CAST(count(*) AS INTEGER) AS emails,
            CAST(COALESCE(SUM(s.open_count),0) AS INTEGER) AS opens,
            CAST(COALESCE(SUM(s.click_count),0) AS INTEGER) AS clicks,
            MAX(s.sent_at) AS last_sent_at
       FROM sends s
       JOIN contacts c ON c.id = s.contact_id
       JOIN (SELECT contact_id, MAX(sent_at) AS origin_at
               FROM sends
              WHERE status LIKE 'sent%' AND sent_at IS NOT NULL AND COALESCE(followup_step,0) = 0
              GROUP BY contact_id) o ON o.contact_id = s.contact_id
      WHERE s.status LIKE 'sent%'
        AND s.sent_at IS NOT NULL
        AND s.sent_at >= o.origin_at
        AND c.status <> 'unsubscribed'
        AND c.status <> 'bounced'
      GROUP BY s.contact_id, o.origin_at
     HAVING count(*) < ?
        AND COALESCE(SUM(s.click_count),0) = 0
        AND MAX(s.sent_at) >= ?
      ORDER BY MAX(s.sent_at) ASC
      LIMIT ?`,
    [cfg.maxEmails, cutoff, SCAN_CAP]
  );

  const schedule = await getSchedule();
  const now = Date.now();
  const at = new Date(now);
  const due: DueFollowUp[] = [];
  const rungs: Record<string, { due: number; waiting: number; next: string | null }> = {};
  for (const a of AUDIENCES) {
    for (const b of ["no_open", "no_click"] as Branch[]) {
      for (let s = 1; s <= MAX_STEPS; s++) rungs[rungKey(a, b, s)] = { due: 0, waiting: 0, next: null };
    }
  }
  let waiting = 0;
  let unconfigured = 0;
  let holding = 0;
  let holdingUntil: string | null = null;
  // One decision per country, not per contact — a 4,000-row scan would
  // otherwise format the same time zone thousands of times.
  const openByCountry = new Map<string, { open: boolean; next: string | null }>();
  const countryState = (raw: string) => {
    const key = keyOf(raw);
    let v = openByCountry.get(key);
    if (!v) {
      v = { open: isOpen(schedule, key, at), next: nextOpenAt(schedule, key, at) };
      openByCountry.set(key, v);
    }
    return v;
  };

  for (const r of rows) {
    const emails = Number(r.emails) || 0;
    const step = emails;                      // 1 email out ⇒ the 1st retry is next
    if (step < 1 || step > MAX_STEPS) continue;
    // Re-decided every pass: someone who ignored email 1 but opened the first
    // retry has moved from the "no open" branch to the "opened, no click" one.
    const branch: Branch = Number(r.opens) > 0 ? "no_click" : "no_open";
    const audience = normalizeAudience(r.audience);
    const ladder = ladderOf(cfg, audience);
    const rung = (branch === "no_open" ? ladder.noOpen : ladder.noClick)[step - 1];
    if (!rung || !rung.templateId) { unconfigured++; continue; }

    const lastSentAt = String(r.last_sent_at);
    const dueAtMs = new Date(lastSentAt).getTime() + rung.delayHours * 3_600_000;
    const key = rungKey(audience, branch, step);
    if (dueAtMs <= now) {
      // The wait is over, but a retry at 3am is still a retry at 3am.
      const state = countryState(String(r.country || ""));
      if (!state.open) {
        holding++;
        if (state.next && (!holdingUntil || state.next < holdingUntil)) holdingUntil = state.next;
        continue;
      }
      rungs[key].due++;
      due.push({
        contactId: String(r.contact_id),
        email: String(r.email || ""),
        audience,
        country: String(r.country || ""),
        branch,
        step,
        templateId: rung.templateId,
        lastSentAt,
        dueAt: new Date(dueAtMs).toISOString(),
      });
    } else {
      waiting++;
      rungs[key].waiting++;
      const iso = new Date(dueAtMs).toISOString();
      if (!rungs[key].next || iso < (rungs[key].next as string)) rungs[key].next = iso;
    }
  }

  // Oldest overdue first — a contact who has been waiting since yesterday goes
  // out before one that came due a minute ago.
  due.sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0));

  const result: ScanResult = {
    due, waiting, unconfigured, holding, holdingUntil, rungs, scanned: rows.length >= SCAN_CAP,
  };
  scanCache = { at: Date.now(), result };
  return result;
}

/* ------------------------------- status -------------------------------- */

export interface FollowUpRungStatus {
  audience: Audience;
  branch: Branch;
  step: number;
  templateId: string;
  templateName: string | null;
  delayHours: number;
  due: number;
  waiting: number;
  nextDueAt: string | null;
  /** Sends already made at this rung (all time) — proof the ladder is working. */
  sent: number;
  opened: number;
  clicked: number;
}

export interface FollowUpStatus {
  config: FollowUpConfig;
  running: boolean;
  dueNow: number;
  waiting: number;
  unconfigured: number;
  /** Due, but held until their country's sending window opens. */
  holding: number;
  holdingUntil: string | null;
  sentToday: number;
  dailyRemaining: number | null;
  trackingReady: boolean;
  lastRun: FollowUpRun | null;
  runs: FollowUpRun[];
  rungs: FollowUpRungStatus[];
  /** What the ladder has produced so far, over the whole ledger. */
  totals: { retries: number; opened: number; clicked: number };
  templates: { id: string; name: string; type: string }[];
  blockers: string[];
  /** Per lane: is anything actually configured on it? */
  laneBlockers: { audience: Audience; blockers: string[] }[];
  /** A handful of the contacts that would go out next — trust, but verify. */
  dueSample: { email: string; audience: Audience; branch: Branch; step: number; dueAt: string }[];
}

// Per-rung outcome of everything the ladder has ever sent, split by the
// contact's audience so each lane's numbers are its own.
async function rungPerformance(): Promise<Map<string, { sent: number; opened: number; clicked: number }>> {
  const rows = await q(
    `SELECT s.followup_step AS step, s.followup_branch AS branch,
            COALESCE(c.audience,'customer') AS audience,
            CAST(count(*) AS INTEGER) AS sent,
            CAST(SUM(CASE WHEN s.open_count > 0 THEN 1 ELSE 0 END) AS INTEGER) AS opened,
            CAST(SUM(CASE WHEN s.click_count > 0 THEN 1 ELSE 0 END) AS INTEGER) AS clicked
       FROM sends s
       LEFT JOIN contacts c ON c.id = s.contact_id
      WHERE s.status LIKE 'sent%' AND COALESCE(s.followup_step,0) > 0
      GROUP BY s.followup_step, s.followup_branch, COALESCE(c.audience,'customer')`
  );
  const m = new Map<string, { sent: number; opened: number; clicked: number }>();
  for (const r of rows) {
    const key = `${normalizeAudience(r.audience)}:${String(r.branch || "no_open")}:${Number(r.step)}`;
    const cur = m.get(key) || { sent: 0, opened: 0, clicked: 0 };
    m.set(key, {
      sent: cur.sent + (Number(r.sent) || 0),
      opened: cur.opened + (Number(r.opened) || 0),
      clicked: cur.clicked + (Number(r.clicked) || 0),
    });
  }
  return m;
}

export async function getFollowUpStatus(): Promise<FollowUpStatus> {
  const config = await getFollowUpConfig();
  const [scan, today, last, runs, perf, resendKey, appUrl, templateRows] = await Promise.all([
    scanSequences(config),
    sentToday(),
    lastRealRun(),
    recentRuns(),
    rungPerformance(),
    getResendKey(),
    getSetting("app_url"),
    q(`SELECT id, name, type FROM templates ORDER BY created_at DESC`),
  ]);

  const byId = new Map(templateRows.map((t) => [String(t.id), { id: String(t.id), name: String(t.name), type: String(t.type) }]));
  const dailyRemaining = config.dailyLimit > 0 ? Math.max(0, config.dailyLimit - today) : null;
  const trackingReady = !!String(appUrl || process.env.APP_URL || "").trim();

  const rungs: FollowUpRungStatus[] = [];
  for (const audience of AUDIENCES) {
    const ladder = ladderOf(config, audience);
    for (const branch of ["no_open", "no_click"] as Branch[]) {
      const steps = branch === "no_open" ? ladder.noOpen : ladder.noClick;
      for (let step = 1; step <= MAX_STEPS; step++) {
        const cfgStep = steps[step - 1];
        const live = scan.rungs[rungKey(audience, branch, step)] || { due: 0, waiting: 0, next: null };
        const p = perf.get(`${audience}:${branch}:${step}`) || { sent: 0, opened: 0, clicked: 0 };
        rungs.push({
          audience,
          branch,
          step,
          templateId: cfgStep.templateId,
          templateName: byId.get(cfgStep.templateId)?.name ?? null,
          delayHours: cfgStep.delayHours,
          due: live.due,
          waiting: live.waiting,
          nextDueAt: live.next,
          sent: p.sent,
          opened: p.opened,
          clicked: p.clicked,
        });
      }
    }
  }

  // A rung whose template was deleted is configured-but-broken: say so loudly,
  // otherwise the ladder silently stops one rung in.
  const usable = (r: FollowUpRungStatus) => r.step < config.maxEmails;
  const missing = rungs.filter((r) => r.templateId && !r.templateName && usable(r));
  const active = rungs.filter((r) => r.templateId && r.templateName && usable(r));

  const blockers: string[] = [];
  if (!active.length) blockers.push("No retry template chosen — pick what each rung of the ladder should send.");
  if (missing.length) blockers.push(`${missing.length} rung(s) point at a template that no longer exists — pick a new one.`);
  if (!trackingReady) blockers.push("App URL isn't set (Settings → Resend) — without it opens and clicks can't be tracked, so every contact would look like a non-opener.");
  if (config.requireResend && !resendKey) blockers.push("No Resend API key — add one above so real retries can go out.");
  if (dailyRemaining === 0) blockers.push(`Daily ceiling reached (${config.dailyLimit} retries sent today) — it resumes tomorrow.`);

  // Per lane, so "the partner ladder is empty" can't hide behind a configured
  // customer ladder — the exact confusion that made these two share settings.
  const laneBlockers = AUDIENCES.map((audience) => {
    const mine = rungs.filter((r) => r.audience === audience && usable(r));
    const list: string[] = [];
    if (!mine.some((r) => r.templateId)) {
      list.push(`No ${audience} retry chosen — contacts tagged ${audience} get one email and silence.`);
    }
    const gone = mine.filter((r) => r.templateId && !r.templateName);
    if (gone.length) list.push(`${gone.length} rung(s) point at a deleted template.`);
    return { audience, blockers: list };
  });

  const totals = rungs.reduce(
    (acc, r) => ({ retries: acc.retries + r.sent, opened: acc.opened + r.opened, clicked: acc.clicked + r.clicked }),
    { retries: 0, opened: 0, clicked: 0 }
  );

  return {
    config,
    running,
    dueNow: scan.due.length,
    waiting: scan.waiting,
    unconfigured: scan.unconfigured,
    holding: scan.holding,
    holdingUntil: scan.holdingUntil,
    sentToday: today,
    dailyRemaining,
    trackingReady,
    lastRun: last,
    runs,
    rungs,
    totals,
    templates: [...byId.values()],
    blockers,
    laneBlockers,
    dueSample: scan.due.slice(0, 6).map((d) => ({ email: d.email, audience: d.audience, branch: d.branch, step: d.step, dueAt: d.dueAt })),
  };
}

/* ----------------------------- run executor ---------------------------- */

export interface StartFollowUpResult {
  started: boolean;
  runId?: string;
  jobId?: string;
  queued?: number;
  error?: string;
  note?: string;
}

// Send everything that is due right now. Returns as soon as the batch is queued
// — the send itself streams in the background and finalises the ledger row.
export async function startFollowUpRun(trigger: "auto" | "manual" = "auto"): Promise<StartFollowUpResult> {
  if (running) return { started: false, error: "A follow-up pass is already running." };

  const config = await getFollowUpConfig();

  // ---- Safety checks -----------------------------------------------------
  const configured = AUDIENCES.some((a) => {
    const l = ladderOf(config, a);
    return (
      l.noOpen.some((s, i) => s.templateId && i + 1 < config.maxEmails) ||
      l.noClick.some((s, i) => s.templateId && i + 1 < config.maxEmails)
    );
  });
  if (!configured) {
    const note = "No retry template selected — nothing was sent.";
    await recordSkip(trigger, 0, note);
    fwarn(note);
    return { started: false, error: note };
  }
  if (config.requireResend && !(await getResendKey())) {
    const note = "No Resend API key — follow-ups paused so nothing is marked as sent by a dry run.";
    await recordSkip(trigger, 0, note);
    fwarn(note);
    return { started: false, error: note };
  }
  const appUrl = String((await getSetting("app_url")) || process.env.APP_URL || "").trim();
  if (!appUrl) {
    const note = "App URL isn't set, so opens and clicks aren't tracked — every contact would look like a non-opener. Follow-ups are paused until it's set.";
    await recordSkip(trigger, 0, note);
    fwarn(note);
    return { started: false, error: note };
  }

  const today = await sentToday();
  const dailyRoom = config.dailyLimit > 0 ? config.dailyLimit - today : Number.MAX_SAFE_INTEGER;
  if (dailyRoom <= 0) {
    const note = `Daily ceiling reached (${today}/${config.dailyLimit} retries sent today).`;
    await recordSkip(trigger, 0, note);
    flog(note);
    return { started: false, error: note };
  }

  // Always a fresh scan — a cached one could re-queue a contact the previous
  // pass has already emailed.
  const scan = await scanSequences(config, true);
  if (!scan.due.length) {
    const note = scan.holding
      ? `${scan.holding.toLocaleString()} retry(ies) are ready but their country is outside its sending window — they go out when it opens.`
      : scan.waiting
      ? `Nothing is due yet — ${scan.waiting.toLocaleString()} contact(s) are still inside their wait.`
      : "No contact is waiting on a follow-up.";
    if (trigger === "manual") return { started: false, error: note };
    return { started: false, note };
  }

  const take = Math.max(1, Math.min(config.batchSize, dailyRoom, scan.due.length));
  const batch = scan.due.slice(0, take);

  running = true;
  const runId = uid();
  const startedAt = nowIso();

  const counts = { no_open: 0, no_click: 0, retry1: 0, retry2: 0, customer: 0, partner: 0 };
  for (const d of batch) {
    if (d.branch === "no_open") counts.no_open++; else counts.no_click++;
    if (d.step === 1) counts.retry1++; else counts.retry2++;
    if (d.audience === "partner") counts.partner++; else counts.customer++;
  }

  const names = await templateNames([...new Set(batch.map((b) => b.templateId))]);
  await q(
    `INSERT INTO followup_runs (id,started_at,trigger,status,due_count,queued,no_open,no_click,retry1,retry2,template_names)
     VALUES (?,?,?,'running',?,?,?,?,?,?,?)`,
    [runId, startedAt, trigger, scan.due.length, batch.length, counts.no_open, counts.no_click, counts.retry1, counts.retry2, names]
  );
  flog(
    `▶ ${trigger} pass — ${scan.due.length} due, sending ${batch.length} ` +
    `(${counts.customer} customer · ${counts.partner} partner · ${counts.no_open} no-open · ` +
    `${counts.no_click} opened-no-click · ${counts.retry1} first retry · ${counts.retry2} second)` +
    (scan.holding ? ` · ${scan.holding} held outside their window` : "")
  );

  const plan: SendPlanItem[] = batch.map((d) => ({
    contactId: d.contactId,
    templateId: d.templateId,
    followupStep: d.step,
    followupBranch: d.branch,
  }));

  const job: Job = createJob("send", plan.length);
  job.result = { sent: 0, failed: 0, skipped: 0 };
  log(job, { level: "info", msg: `Follow-up pass: ${plan.length} retry email(s) — ${counts.no_open} to non-openers, ${counts.no_click} to openers who didn't click.` });
  await q(`UPDATE followup_runs SET job_id=? WHERE id=?`, [job.id, runId]);

  // Fire-and-forget: pacing a batch takes minutes, the caller must not wait.
  (async () => {
    let outcome: SendPlanOutcome | null = null;
    try {
      outcome = await runSendPlan(job, plan, config.perMinute);
      if (job.status === "running") { job.status = "done"; job.progress = 1; }
    } catch (e: any) {
      job.status = "error";
      job.error = String(e?.message || e);
    } finally {
      const r = job.result || {};
      const sent = Number(r.sent || 0);
      const failed = Number(r.failed || 0);
      const skipped = Number(r.skipped || 0);

      // A pass that queued retries and attempted none of them is not "done".
      // Nothing is stranded here — a follow-up works from contacts that already
      // exist, so there is no pool row to hand back — but recording it as
      // success would hide a capped-out sender exactly the way the automation
      // used to. The ladder simply picks these contacts up again next pass.
      const stalled = sent + failed + skipped === 0 && plan.length > 0;
      const status = job.status === "error" || stalled ? "error" : "done";
      const reason = job.error || outcome?.stopped || null;

      await q(
        `UPDATE followup_runs
            SET status=?, finished_at=?, sent=?, failed=?, skipped=?, error=?, note=?
          WHERE id=?`,
        [
          status,
          nowIso(),
          sent,
          failed,
          skipped,
          stalled ? reason : job.error || null,
          stalled
            ? `Nothing could be sent — ${reason || "the sender stopped before the first email."} The ${plan.length} due retry(s) stay due.`
            : `${counts.customer} customer · ${counts.partner} partner · ${counts.retry1} first retry · ${counts.retry2} second retry · ${counts.no_open} never opened · ${counts.no_click} opened but never clicked.`,
          runId,
        ]
      ).catch(() => {});
      await setSetting("followup_last_run_at", nowIso()).catch(() => {});
      scanCache = null; // the sends we just made change every sequence in the batch
      running = false;
      if (status === "error") ferr(`pass finished without sending: ${reason || "unknown reason"}`);
      else flog(`✓ pass complete — sent ${sent}, failed ${failed}, skipped ${skipped}`);
    }
  })();

  return { started: true, runId, jobId: job.id, queued: plan.length };
}

async function templateNames(ids: string[]): Promise<string> {
  if (!ids.length) return "";
  const ph = ids.map(() => "?").join(",");
  const rows = await q(`SELECT name FROM templates WHERE id IN (${ph})`, ids);
  return rows.map((r) => String(r.name)).join(", ");
}

/* -------------------------------- ticks -------------------------------- */

async function followUpTick(): Promise<void> {
  if (running) return;
  const config = await getFollowUpConfig();
  if (!config.enabled) return;
  const scan = await scanSequences(config, true);
  if (!scan.due.length) return;
  flog(`${scan.due.length} follow-up(s) are due — starting a pass`);
  await startFollowUpRun("auto");
}

export function startFollowUpWorker(): void {
  if (started) return;
  started = true;
  setInterval(() => { followUpTick().catch((e) => ferr(`tick failed: ${String(e?.message || e)}`)); }, FOLLOWUP_TICK_MS);
  setTimeout(() => { followUpTick().catch(() => {}); }, 20_000);

  (async () => {
    try {
      const c = await getFollowUpConfig();
      if (!c.enabled) { flog("state → OFF (set the ladder up in Settings → Follow-up)"); return; }
      const scan = await scanSequences(c, true);
      flog(
        `state → ON · up to ${c.maxEmails} emails per contact · ${scan.due.length} due, ` +
        `${scan.waiting} waiting${scan.holding ? `, ${scan.holding} outside their window` : ""} · ` +
        `${c.perMinute}/min · daily cap ${c.dailyLimit || "none"}`
      );
    } catch { /* ignore */ }
  })();
}

// The live send job behind a pass, so the UI can show progress while it streams.
export function getFollowUpJob(jobId: string) { return getJob(jobId); }
