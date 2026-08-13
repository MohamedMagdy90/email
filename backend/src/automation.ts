// Outreach automation — "fill the pool, and it handles the rest".
//
// Watches the discovery review pool. The moment it holds N leads that have a
// real email (default 100), it approves that batch into Contacts and emails
// them with the template(s) you picked — no clicking Approve, no picking
// recipients, no hitting Send.
//
// Everything is guarded so it can never run away:
//   · a batch is exactly N — leftovers wait for the next batch
//   · a cooldown between runs
//   · a daily ceiling on how many emails the automation may send
//   · it refuses to run without a Resend key (so it can't silently "dry-run"
//     through your whole pool and mark everyone as sent)
// Every run — including the ones it decides to skip — is written to
// automation_runs, which is what the Settings screen reads back to you.

import { q, nowIso, getSetting, setSetting } from "./db";
import { createJob, getJob, log, type Job } from "./jobs";
import { approveLeads, countApprovableLeads } from "./pool";
import { runSendJob } from "./send";
import { getResendKey } from "./resend";

const uid = () => crypto.randomUUID();

function alog(msg: string) { console.log(`[automation] ${msg}`); }
function awarn(msg: string) { console.warn(`[automation] ${msg}`); }
function aerr(msg: string) { console.error(`[automation] ${msg}`); }

function clamp(n: number, lo: number, hi: number) {
  const x = Number(n);
  return Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
}

// How often the watcher checks the pool. Cheap (one COUNT), so it can be brisk —
// the real spacing between runs is the cooldown.
const AUTOMATION_TICK_MS = 60_000;

let running = false;
let started = false;

/* ------------------------------- config -------------------------------- */

export interface AutomationConfig {
  enabled: boolean;
  /** Trigger point AND batch size: approve + email this many at a time. */
  threshold: number;
  /** Template(s) the automation sends. Several = they rotate. */
  templateIds: string[];
  /** rotate = one template per run · split = rotate per recipient inside a run. */
  templateMode: "rotate" | "split";
  /** Contact category applied to everything the automation approves. */
  category: string;
  /** Country override for approved contacts (blank = keep each lead's own). */
  country: string;
  perMinute: number;
  /** Max emails the automation may send per day. 0 = no ceiling. */
  dailyLimit: number;
  /** Minimum gap between two automated runs. */
  cooldownMinutes: number;
  /** Refuse to run without a Resend key (never auto-"dry-run" a real pool). */
  requireResend: boolean;
}

export const AUTOMATION_DEFAULTS: AutomationConfig = {
  enabled: false,
  threshold: 100,
  templateIds: [],
  templateMode: "rotate",
  category: "",
  country: "",
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

export async function getAutomationConfig(): Promise<AutomationConfig> {
  const [enabled, threshold, ids, mode, category, country, perMinute, dailyLimit, cooldown, requireResend] =
    await Promise.all([
      getSetting("automation_enabled"),
      getSetting("automation_threshold"),
      getSetting("automation_template_ids"),
      getSetting("automation_template_mode"),
      getSetting("automation_category"),
      getSetting("automation_country"),
      getSetting("automation_per_minute"),
      getSetting("automation_daily_limit"),
      getSetting("automation_cooldown_minutes"),
      getSetting("automation_require_resend"),
    ]);
  return {
    enabled: enabled === "1",
    threshold: clamp(Number(threshold) || AUTOMATION_DEFAULTS.threshold, 1, 5000),
    templateIds: parseIds(ids),
    templateMode: mode === "split" ? "split" : "rotate",
    category: category || "",
    country: country || "",
    perMinute: clamp(Number(perMinute) || AUTOMATION_DEFAULTS.perMinute, 1, 120),
    dailyLimit: clamp(Number(dailyLimit ?? AUTOMATION_DEFAULTS.dailyLimit), 0, 100000),
    cooldownMinutes: clamp(Number(cooldown ?? AUTOMATION_DEFAULTS.cooldownMinutes), 0, 100000),
    requireResend: requireResend !== "0",
  };
}

export async function setAutomationConfig(patch: Partial<AutomationConfig>): Promise<AutomationConfig> {
  if (typeof patch.enabled === "boolean") await setSetting("automation_enabled", patch.enabled ? "1" : "0");
  if (patch.threshold != null) await setSetting("automation_threshold", String(clamp(Number(patch.threshold), 1, 5000)));
  if (Array.isArray(patch.templateIds)) {
    const clean = [...new Set(patch.templateIds.map((x) => String(x)).filter(Boolean))].slice(0, 20);
    await setSetting("automation_template_ids", JSON.stringify(clean));
  }
  if (patch.templateMode) await setSetting("automation_template_mode", patch.templateMode === "split" ? "split" : "rotate");
  if (patch.category != null) await setSetting("automation_category", String(patch.category).trim());
  if (patch.country != null) await setSetting("automation_country", String(patch.country).trim());
  if (patch.perMinute != null) await setSetting("automation_per_minute", String(clamp(Number(patch.perMinute), 1, 120)));
  if (patch.dailyLimit != null) await setSetting("automation_daily_limit", String(clamp(Number(patch.dailyLimit), 0, 100000)));
  if (patch.cooldownMinutes != null) await setSetting("automation_cooldown_minutes", String(clamp(Number(patch.cooldownMinutes), 0, 100000)));
  if (typeof patch.requireResend === "boolean") await setSetting("automation_require_resend", patch.requireResend ? "1" : "0");
  const cfg = await getAutomationConfig();
  if (typeof patch.enabled === "boolean") {
    alog(patch.enabled
      ? `switched ON — will approve + email every ${cfg.threshold} lead(s) that have an email`
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

async function recentRuns(limit = 8): Promise<AutomationRun[]> {
  return (await q(
    `SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT ?`,
    [limit]
  )) as unknown as AutomationRun[];
}

// Midnight UTC — the boundary the daily ceiling resets on (same convention as
// the per-domain daily caps).
function startOfDayIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

async function sentToday(): Promise<number> {
  const r = await q(
    `SELECT CAST(COALESCE(SUM(sent),0) AS INTEGER) AS n FROM automation_runs WHERE started_at >= ?`,
    [startOfDayIso()]
  );
  return Number(r[0]?.n ?? 0);
}

async function lastRealRun(): Promise<AutomationRun | null> {
  // "Skipped" checks aren't runs — the cooldown only counts runs that did work.
  const r = await q(
    `SELECT * FROM automation_runs WHERE status <> 'skipped' ORDER BY started_at DESC LIMIT 1`
  );
  return (r[0] as unknown as AutomationRun) || null;
}

/* ------------------------------- status -------------------------------- */

export interface AutomationStatus {
  config: AutomationConfig;
  /** Pending leads that already have an email — what counts toward the trigger. */
  ready: number;
  remaining: number;
  running: boolean;
  sentToday: number;
  dailyRemaining: number | null; // null = no ceiling
  nextEligibleAt: string | null; // cooldown end
  lastRun: AutomationRun | null;
  runs: AutomationRun[];
  /** Templates that are actually selected AND still exist. */
  templates: { id: string; name: string; type: string }[];
  /** Everything standing between "on" and "will fire" — shown in the UI. */
  blockers: string[];
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
  const [ready, today, last, runs, templates, resendKey] = await Promise.all([
    countApprovableLeads(),
    sentToday(),
    lastRealRun(),
    recentRuns(),
    selectedTemplates(config.templateIds),
    getResendKey(),
  ]);

  const dailyRemaining = config.dailyLimit > 0 ? Math.max(0, config.dailyLimit - today) : null;
  const nextEligibleAt =
    last && config.cooldownMinutes > 0
      ? new Date(new Date(last.started_at).getTime() + config.cooldownMinutes * 60000).toISOString()
      : null;

  const blockers: string[] = [];
  if (!templates.length) blockers.push("No template chosen — pick the email the automation should send.");
  if (config.requireResend && !resendKey) blockers.push("No Resend API key — add one above so real emails can go out.");
  if (dailyRemaining === 0) blockers.push(`Daily ceiling reached (${config.dailyLimit} sent today) — it resumes tomorrow.`);

  return {
    config,
    ready,
    remaining: Math.max(0, config.threshold - ready),
    running,
    sentToday: today,
    dailyRemaining,
    nextEligibleAt,
    lastRun: last,
    runs,
    templates,
    blockers,
  };
}

/* ----------------------------- run executor ---------------------------- */

async function recordSkip(trigger: string, threshold: number, poolCount: number, note: string) {
  const now = nowIso();
  await q(
    `INSERT INTO automation_runs (id,started_at,finished_at,trigger,status,threshold,pool_count,note)
     VALUES (?,?,?,?,'skipped',?,?,?)`,
    [uid(), now, now, trigger, threshold, poolCount, note]
  );
}

export interface StartRunResult {
  started: boolean;
  runId?: string;
  jobId?: string;
  approved?: number;
  error?: string;
  note?: string;
}

// Approve the next batch and start emailing it. Returns as soon as the batch is
// created — the send itself streams in the background (a 100-email batch at 20
// per minute takes 5 minutes), and the run row is finalised when it finishes.
export async function startAutomationRun(trigger: "auto" | "manual" = "auto"): Promise<StartRunResult> {
  if (running) return { started: false, error: "An automation run is already in progress." };

  const config = await getAutomationConfig();
  const pool = await countApprovableLeads();

  // ---- Safety checks -----------------------------------------------------
  const templates = await selectedTemplates(config.templateIds);
  if (!templates.length) {
    const note = "No usable template selected — nothing was sent.";
    await recordSkip(trigger, config.threshold, pool, note);
    awarn(note);
    return { started: false, error: note };
  }
  if (config.requireResend && !(await getResendKey())) {
    const note = "No Resend API key — automation paused so nothing is marked as sent by a dry run.";
    await recordSkip(trigger, config.threshold, pool, note);
    awarn(note);
    return { started: false, error: note };
  }

  const today = await sentToday();
  const dailyRoom = config.dailyLimit > 0 ? config.dailyLimit - today : Number.MAX_SAFE_INTEGER;
  if (dailyRoom <= 0) {
    const note = `Daily ceiling reached (${today}/${config.dailyLimit} sent today).`;
    await recordSkip(trigger, config.threshold, pool, note);
    alog(note);
    return { started: false, error: note };
  }

  if (!pool) {
    const note = "No leads with an email are waiting.";
    if (trigger === "manual") return { started: false, error: note };
    return { started: false, note };
  }

  // A batch never exceeds the trigger size, nor what's left of today's ceiling.
  const batchSize = Math.max(1, Math.min(config.threshold, pool, dailyRoom));

  running = true;
  const runId = uid();
  const startedAt = nowIso();
  const templateNames = templates.map((t) => t.name).join(", ");
  await q(
    `INSERT INTO automation_runs (id,started_at,trigger,status,threshold,pool_count,template_names)
     VALUES (?,?,?,'running',?,?,?)`,
    [runId, startedAt, trigger, config.threshold, pool, templateNames]
  );
  alog(`▶ ${trigger} run — pool holds ${pool} emailable lead(s), taking ${batchSize} · template(s): ${templateNames}`);

  let approve;
  try {
    approve = await approveLeads({
      all: true,
      limit: batchSize,
      oldestFirst: true,
      category: config.category || null,
      country: config.country || null,
    });
  } catch (e: any) {
    running = false;
    const msg = String(e?.message || e);
    await q(`UPDATE automation_runs SET status='error', finished_at=?, error=? WHERE id=?`, [nowIso(), msg, runId]);
    aerr(`approval failed: ${msg}`);
    return { started: false, error: msg };
  }

  alog(`approved ${approve.approvedIds.length} lead(s) → ${approve.added} new contact(s)${approve.skipped ? ` · ${approve.skipped} already known` : ""}`);

  if (!approve.contactIds.length) {
    running = false;
    const note = "Every lead in that batch was already a contact — nothing to email.";
    await q(
      `UPDATE automation_runs SET status='done', finished_at=?, approved=?, contacts_added=0, note=? WHERE id=?`,
      [nowIso(), approve.approvedIds.length, note, runId]
    );
    alog(note);
    return { started: true, runId, approved: approve.approvedIds.length, note };
  }

  // Which template(s) this run uses: "rotate" walks the list one per run,
  // "split" hands the whole list to the sender so it alternates per recipient.
  let sendTemplateIds: string[];
  if (config.templateMode === "split" || templates.length === 1) {
    sendTemplateIds = templates.map((t) => t.id);
  } else {
    const idx = Number((await getSetting("automation_template_index")) || 0) % templates.length;
    sendTemplateIds = [templates[idx].id];
    await setSetting("automation_template_index", String((idx + 1) % templates.length));
  }
  const usedNames = templates.filter((t) => sendTemplateIds.includes(t.id)).map((t) => t.name).join(", ");

  const job: Job = createJob("send", approve.contactIds.length);
  job.result = { sent: 0, failed: 0, skipped: 0 };
  log(job, { level: "info", msg: `Automation: emailing ${approve.contactIds.length} newly-approved contact(s) with "${usedNames}".` });
  await q(`UPDATE automation_runs SET approved=?, contacts_added=?, job_id=?, template_names=? WHERE id=?`, [
    approve.approvedIds.length, approve.added, job.id, usedNames, runId,
  ]);

  // Fire-and-forget: the caller (HTTP request or the tick) mustn't wait minutes.
  (async () => {
    try {
      await runSendJob(job, sendTemplateIds, approve.contactIds, config.perMinute);
      if (job.status === "running") { job.status = "done"; job.progress = 1; }
    } catch (e: any) {
      job.status = "error";
      job.error = String(e?.message || e);
    } finally {
      const r = job.result || {};
      const failed = Number(r.failed || 0);
      await q(
        `UPDATE automation_runs
            SET status=?, finished_at=?, sent=?, failed=?, skipped=?, error=?, note=?
          WHERE id=?`,
        [
          job.status === "error" ? "error" : "done",
          nowIso(),
          Number(r.sent || 0),
          failed,
          Number(r.skipped || 0),
          job.error || null,
          `Approved ${approve.added} contact(s) from the pool and emailed them with "${usedNames}".`,
          runId,
        ]
      ).catch(() => {});
      await setSetting("automation_last_run_at", nowIso()).catch(() => {});
      running = false;
      if (job.status === "error") aerr(`run finished with an error: ${job.error}`);
      else alog(`✓ run complete — sent ${r.sent || 0}, failed ${failed}, skipped ${r.skipped || 0}`);
    }
  })();

  return { started: true, runId, jobId: job.id, approved: approve.added };
}

/* -------------------------------- ticks -------------------------------- */

async function automationTick(): Promise<void> {
  if (running) return;
  const config = await getAutomationConfig();
  if (!config.enabled) return;

  // Cooldown — a run only starts once the gap since the last one has elapsed.
  if (config.cooldownMinutes > 0) {
    const last = await lastRealRun();
    if (last) {
      const due = new Date(last.started_at).getTime() + config.cooldownMinutes * 60000;
      if (Date.now() < due) return;
    }
  }

  const ready = await countApprovableLeads();
  if (ready < config.threshold) return;

  alog(`pool reached ${ready}/${config.threshold} lead(s) with an email — starting an automated run`);
  await startAutomationRun("auto");
}

export function startAutomationWorker(): void {
  if (started) return;
  started = true;
  setInterval(() => { automationTick().catch((e) => aerr(`tick failed: ${String(e?.message || e)}`)); }, AUTOMATION_TICK_MS);
  setTimeout(() => { automationTick().catch(() => {}); }, 9000);

  (async () => {
    try {
      const c = await getAutomationConfig();
      const ready = await countApprovableLeads();
      alog(
        c.enabled
          ? `state → ON · trigger at ${c.threshold} · ${ready} lead(s) ready · ${c.templateIds.length} template(s) · ${c.perMinute}/min · daily cap ${c.dailyLimit || "none"}`
          : "state → OFF (turn it on in Settings → Automation)"
      );
    } catch { /* ignore */ }
  })();
}

// The live send job behind a run, so the UI can show progress while it streams.
export function getRunJob(jobId: string) { return getJob(jobId); }
