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
// The state is DERIVED from the sends table on every pass rather than stored in
// a queue. That matters: an open that lands late, a bounce, an unsubscribe, a
// template you delete, a run that crashes half way — all of it is simply the
// next scan's input. There is no schedule to fall out of sync with reality.

import { q, nowIso, getSetting, setSetting } from "./db";
import { createJob, getJob, log, type Job } from "./jobs";
import { runSendPlan, type SendPlanItem } from "./send";
import { getResendKey } from "./resend";

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

/* ------------------------------- config -------------------------------- */

export interface FollowUpStepConfig {
  /** Template sent at this rung. Blank = the rung is off. */
  templateId: string;
  /** Hours to wait after the PREVIOUS email before this one goes out. */
  delayHours: number;
}

export interface FollowUpConfig {
  enabled: boolean;
  /** Ceiling per sequence, including the original email. 2 or 3. */
  maxEmails: number;
  /** They never opened. [first retry, second retry] */
  noOpen: FollowUpStepConfig[];
  /** They opened but never clicked. [first retry, second retry] */
  noClick: FollowUpStepConfig[];
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
}

export const FOLLOWUP_DEFAULTS: FollowUpConfig = {
  enabled: false,
  maxEmails: 3,
  noOpen: [{ templateId: "", delayHours: 48 }, { templateId: "", delayHours: 96 }],
  noClick: [{ templateId: "", delayHours: 48 }, { templateId: "", delayHours: 96 }],
  perMinute: 20,
  dailyLimit: 200,
  batchSize: 100,
  lookbackDays: 30,
  requireResend: true,
};

// Always returns exactly MAX_STEPS rungs, whatever is in storage — the UI and
// the engine both index into this blindly.
function parseSteps(raw: string | null, fallback: FollowUpStepConfig[]): FollowUpStepConfig[] {
  let arr: any[] = [];
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) arr = parsed;
  } catch { /* fall through to defaults */ }
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

export async function getFollowUpConfig(): Promise<FollowUpConfig> {
  const [enabled, maxEmails, noOpen, noClick, perMinute, dailyLimit, batchSize, lookback, requireResend] =
    await Promise.all([
      getSetting("followup_enabled"),
      getSetting("followup_max_emails"),
      getSetting("followup_no_open"),
      getSetting("followup_no_click"),
      getSetting("followup_per_minute"),
      getSetting("followup_daily_limit"),
      getSetting("followup_batch_size"),
      getSetting("followup_lookback_days"),
      getSetting("followup_require_resend"),
    ]);
  return {
    enabled: enabled === "1",
    maxEmails: clamp(Number(maxEmails) || FOLLOWUP_DEFAULTS.maxEmails, 2, MAX_STEPS + 1),
    noOpen: parseSteps(noOpen, FOLLOWUP_DEFAULTS.noOpen),
    noClick: parseSteps(noClick, FOLLOWUP_DEFAULTS.noClick),
    perMinute: clamp(Number(perMinute) || FOLLOWUP_DEFAULTS.perMinute, 1, 120),
    dailyLimit: clamp(Number(dailyLimit ?? FOLLOWUP_DEFAULTS.dailyLimit), 0, 100000),
    batchSize: clamp(Number(batchSize) || FOLLOWUP_DEFAULTS.batchSize, 1, 2000),
    lookbackDays: clamp(Number(lookback) || FOLLOWUP_DEFAULTS.lookbackDays, 1, 365),
    requireResend: requireResend !== "0",
  };
}

export async function setFollowUpConfig(patch: Partial<FollowUpConfig>): Promise<FollowUpConfig> {
  if (typeof patch.enabled === "boolean") await setSetting("followup_enabled", patch.enabled ? "1" : "0");
  if (patch.maxEmails != null) await setSetting("followup_max_emails", String(clamp(Number(patch.maxEmails), 2, MAX_STEPS + 1)));
  if (patch.noOpen) await setSetting("followup_no_open", JSON.stringify(cleanSteps(patch.noOpen, FOLLOWUP_DEFAULTS.noOpen)));
  if (patch.noClick) await setSetting("followup_no_click", JSON.stringify(cleanSteps(patch.noClick, FOLLOWUP_DEFAULTS.noClick)));
  if (patch.perMinute != null) await setSetting("followup_per_minute", String(clamp(Number(patch.perMinute), 1, 120)));
  if (patch.dailyLimit != null) await setSetting("followup_daily_limit", String(clamp(Number(patch.dailyLimit), 0, 100000)));
  if (patch.batchSize != null) await setSetting("followup_batch_size", String(clamp(Number(patch.batchSize), 1, 2000)));
  if (patch.lookbackDays != null) await setSetting("followup_lookback_days", String(clamp(Number(patch.lookbackDays), 1, 365)));
  if (typeof patch.requireResend === "boolean") await setSetting("followup_require_resend", patch.requireResend ? "1" : "0");

  scanCache = null; // config drives the scan — never answer from a stale one
  const cfg = await getFollowUpConfig();
  if (typeof patch.enabled === "boolean") {
    flog(patch.enabled
      ? `switched ON — up to ${cfg.maxEmails} emails per contact, retries ${cfg.noOpen[0].delayHours}h / ${cfg.noOpen[1].delayHours}h`
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
  /** Per rung: how many are due now and how many are still waiting. */
  rungs: Record<string, { due: number; waiting: number; next: string | null }>;
  /** Sequences considered (capped at SCAN_CAP). */
  scanned: boolean;
}

const rungKey = (branch: Branch, step: number) => `${branch}:${step}`;

let scanCache: { at: number; result: ScanResult } | null = null;

/**
 * Read every live sequence back out of the sends ledger.
 *
 * A "sequence" starts at the contact's most recent ORIGINAL email
 * (followup_step = 0) and covers everything sent after it. Counting from there
 * (rather than counting all sends ever) is what lets a contact who was mailed
 * in a campaign months ago still be followed up today.
 */
export async function scanSequences(cfg: FollowUpConfig, force = false): Promise<ScanResult> {
  if (!force && scanCache && Date.now() - scanCache.at < SCAN_CACHE_MS) return scanCache.result;

  const cutoff = new Date(Date.now() - cfg.lookbackDays * 86_400_000).toISOString();
  const rows = await q(
    `SELECT s.contact_id AS contact_id,
            MAX(s.contact_email) AS email,
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

  const now = Date.now();
  const due: DueFollowUp[] = [];
  const rungs: Record<string, { due: number; waiting: number; next: string | null }> = {};
  for (const b of ["no_open", "no_click"] as Branch[]) {
    for (let s = 1; s <= MAX_STEPS; s++) rungs[rungKey(b, s)] = { due: 0, waiting: 0, next: null };
  }
  let waiting = 0;
  let unconfigured = 0;

  for (const r of rows) {
    const emails = Number(r.emails) || 0;
    const step = emails;                      // 1 email out ⇒ the 1st retry is next
    if (step < 1 || step > MAX_STEPS) continue;
    // Re-decided every pass: someone who ignored email 1 but opened the first
    // retry has moved from the "no open" branch to the "opened, no click" one.
    const branch: Branch = Number(r.opens) > 0 ? "no_click" : "no_open";
    const rung = (branch === "no_open" ? cfg.noOpen : cfg.noClick)[step - 1];
    if (!rung || !rung.templateId) { unconfigured++; continue; }

    const lastSentAt = String(r.last_sent_at);
    const dueAtMs = new Date(lastSentAt).getTime() + rung.delayHours * 3_600_000;
    const key = rungKey(branch, step);
    if (dueAtMs <= now) {
      rungs[key].due++;
      due.push({
        contactId: String(r.contact_id),
        email: String(r.email || ""),
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

  const result: ScanResult = { due, waiting, unconfigured, rungs, scanned: rows.length >= SCAN_CAP };
  scanCache = { at: Date.now(), result };
  return result;
}

/* ------------------------------- status -------------------------------- */

export interface FollowUpRungStatus {
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
  /** A handful of the contacts that would go out next — trust, but verify. */
  dueSample: { email: string; branch: Branch; step: number; dueAt: string }[];
}

// Per-rung outcome of everything the ladder has ever sent.
async function rungPerformance(): Promise<Map<string, { sent: number; opened: number; clicked: number }>> {
  const rows = await q(
    `SELECT followup_step AS step, followup_branch AS branch,
            CAST(count(*) AS INTEGER) AS sent,
            CAST(SUM(CASE WHEN open_count > 0 THEN 1 ELSE 0 END) AS INTEGER) AS opened,
            CAST(SUM(CASE WHEN click_count > 0 THEN 1 ELSE 0 END) AS INTEGER) AS clicked
       FROM sends
      WHERE status LIKE 'sent%' AND COALESCE(followup_step,0) > 0
      GROUP BY followup_step, followup_branch`
  );
  const m = new Map<string, { sent: number; opened: number; clicked: number }>();
  for (const r of rows) {
    m.set(`${String(r.branch || "no_open")}:${Number(r.step)}`, {
      sent: Number(r.sent) || 0,
      opened: Number(r.opened) || 0,
      clicked: Number(r.clicked) || 0,
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
  for (const branch of ["no_open", "no_click"] as Branch[]) {
    const ladder = branch === "no_open" ? config.noOpen : config.noClick;
    for (let step = 1; step <= MAX_STEPS; step++) {
      const cfgStep = ladder[step - 1];
      const live = scan.rungs[rungKey(branch, step)] || { due: 0, waiting: 0, next: null };
      const p = perf.get(`${branch}:${step}`) || { sent: 0, opened: 0, clicked: 0 };
      rungs.push({
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

  // A rung whose template was deleted is configured-but-broken: say so loudly,
  // otherwise the ladder silently stops one rung in.
  const missing = rungs.filter((r) => r.templateId && !r.templateName && r.step < config.maxEmails);
  const active = rungs.filter((r) => r.templateId && r.templateName && r.step < config.maxEmails);

  const blockers: string[] = [];
  if (!active.length) blockers.push("No retry template chosen — pick what each rung of the ladder should send.");
  if (missing.length) blockers.push(`${missing.length} rung(s) point at a template that no longer exists — pick a new one.`);
  if (!trackingReady) blockers.push("App URL isn't set (Settings → Resend) — without it opens and clicks can't be tracked, so every contact would look like a non-opener.");
  if (config.requireResend && !resendKey) blockers.push("No Resend API key — add one above so real retries can go out.");
  if (dailyRemaining === 0) blockers.push(`Daily ceiling reached (${config.dailyLimit} retries sent today) — it resumes tomorrow.`);

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
    sentToday: today,
    dailyRemaining,
    trackingReady,
    lastRun: last,
    runs,
    rungs,
    totals,
    templates: [...byId.values()],
    blockers,
    dueSample: scan.due.slice(0, 6).map((d) => ({ email: d.email, branch: d.branch, step: d.step, dueAt: d.dueAt })),
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
  const configured =
    config.noOpen.some((s, i) => s.templateId && i + 1 < config.maxEmails) ||
    config.noClick.some((s, i) => s.templateId && i + 1 < config.maxEmails);
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
    const note = scan.waiting
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

  const counts = { no_open: 0, no_click: 0, retry1: 0, retry2: 0 };
  for (const d of batch) {
    if (d.branch === "no_open") counts.no_open++; else counts.no_click++;
    if (d.step === 1) counts.retry1++; else counts.retry2++;
  }

  const names = await templateNames([...new Set(batch.map((b) => b.templateId))]);
  await q(
    `INSERT INTO followup_runs (id,started_at,trigger,status,due_count,queued,no_open,no_click,retry1,retry2,template_names)
     VALUES (?,?,?,'running',?,?,?,?,?,?,?)`,
    [runId, startedAt, trigger, scan.due.length, batch.length, counts.no_open, counts.no_click, counts.retry1, counts.retry2, names]
  );
  flog(
    `▶ ${trigger} pass — ${scan.due.length} due, sending ${batch.length} ` +
    `(${counts.no_open} no-open · ${counts.no_click} opened-no-click · ${counts.retry1} first retry · ${counts.retry2} second)`
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
    try {
      await runSendPlan(job, plan, config.perMinute);
      if (job.status === "running") { job.status = "done"; job.progress = 1; }
    } catch (e: any) {
      job.status = "error";
      job.error = String(e?.message || e);
    } finally {
      const r = job.result || {};
      await q(
        `UPDATE followup_runs
            SET status=?, finished_at=?, sent=?, failed=?, skipped=?, error=?, note=?
          WHERE id=?`,
        [
          job.status === "error" ? "error" : "done",
          nowIso(),
          Number(r.sent || 0),
          Number(r.failed || 0),
          Number(r.skipped || 0),
          job.error || null,
          `${counts.retry1} first retry · ${counts.retry2} second retry · ${counts.no_open} never opened · ${counts.no_click} opened but never clicked.`,
          runId,
        ]
      ).catch(() => {});
      await setSetting("followup_last_run_at", nowIso()).catch(() => {});
      scanCache = null; // the sends we just made change every sequence in the batch
      running = false;
      if (job.status === "error") ferr(`pass finished with an error: ${job.error}`);
      else flog(`✓ pass complete — sent ${r.sent || 0}, failed ${r.failed || 0}, skipped ${r.skipped || 0}`);
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
        `${scan.waiting} waiting · ${c.perMinute}/min · daily cap ${c.dailyLimit || "none"}`
      );
    } catch { /* ignore */ }
  })();
}

// The live send job behind a pass, so the UI can show progress while it streams.
export function getFollowUpJob(jobId: string) { return getJob(jobId); }
