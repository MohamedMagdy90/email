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
// Every run — including the ones it decides to skip — is written to
// automation_runs with the lane it belongs to, which is what the Settings
// screen reads back to you.

import { q, nowIso, getSetting, setSetting } from "./db";
import { createJob, getJob, log, type Job } from "./jobs";
import { approveLeads, countApprovableLeads, normalizeAudience, type Audience } from "./pool";
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

// Midnight UTC — the boundary the daily ceiling resets on (same convention as
// the per-domain daily caps).
function startOfDayIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

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

/* ------------------------------- status -------------------------------- */

export interface AutomationLaneStatus {
  audience: Audience;
  config: AutomationLaneConfig;
  /** Pending leads of THIS audience that already have an email. */
  ready: number;
  remaining: number;
  /** True while this lane is the one mid-run. */
  running: boolean;
  sentToday: number;
  nextEligibleAt: string | null; // this lane's cooldown end
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
  lastRun: AutomationRun | null;
  runs: AutomationRun[];
  /** Blockers that stop BOTH lanes (no key, ceiling reached). */
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
  const [today, last, runs, resendKey] = await Promise.all([
    sentToday(),
    lastRealRun(),
    recentRuns(),
    getResendKey(),
  ]);

  const dailyRemaining = config.dailyLimit > 0 ? Math.max(0, config.dailyLimit - today) : null;

  const shared: string[] = [];
  if (config.requireResend && !resendKey) shared.push("No Resend API key — add one above so real emails can go out.");
  if (dailyRemaining === 0) shared.push(`Daily ceiling reached (${config.dailyLimit} sent today) — it resumes tomorrow.`);

  const lanes: AutomationLaneStatus[] = [];
  for (const audience of AUDIENCES) {
    const lane = config[audience];
    const [ready, templates, laneSent, laneLast] = await Promise.all([
      countApprovableLeads(null, null, audience),
      selectedTemplates(lane.templateIds),
      sentToday(audience),
      lastRealRun(audience),
    ]);
    const blockers: string[] = [];
    if (!templates.length) {
      blockers.push(`No ${laneLabel(audience)} template chosen — pick the email this lane should send.`);
    }
    lanes.push({
      audience,
      config: lane,
      ready,
      remaining: Math.max(0, lane.threshold - ready),
      running: running && runningLane === audience,
      sentToday: laneSent,
      nextEligibleAt:
        laneLast && config.cooldownMinutes > 0
          ? new Date(new Date(laneLast.started_at).getTime() + config.cooldownMinutes * 60000).toISOString()
          : null,
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
    lastRun: last,
    runs,
    blockers: shared,
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
  const pool = await countApprovableLeads(null, null, audience);

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

  if (!pool) {
    const note = `No ${who} leads with an email are waiting.`;
    if (trigger === "manual") return { started: false, audience, error: note };
    return { started: false, audience, note };
  }

  // A batch never exceeds the trigger size, nor what's left of today's ceiling.
  const batchSize = Math.max(1, Math.min(lane.threshold, pool, dailyRoom));

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
  alog(`▶ ${trigger} ${who} run — pool holds ${pool} emailable ${who} lead(s), taking ${batchSize} · template(s): ${templateNames}`);

  const finishRun = (patchSql: string, params: any[]) =>
    q(patchSql, params).catch(() => {});

  let approve;
  try {
    approve = await approveLeads({
      all: true,
      limit: batchSize,
      oldestFirst: true,
      filterAudience: audience,
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

  alog(`approved ${approve.approvedIds.length} ${who} lead(s) → ${approve.added} new contact(s)${approve.skipped ? ` · ${approve.skipped} already known` : ""}`);

  if (!approve.contactIds.length) {
    running = false; runningLane = null;
    const note = "Every lead in that batch was already a contact — nothing to email.";
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
      await finishRun(
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
          `Approved ${approve.added} ${who} contact(s) from the pool and emailed them with "${usedNames}".`,
          runId,
        ]
      );
      await setSetting("automation_last_run_at", nowIso()).catch(() => {});
      running = false; runningLane = null;
      if (job.status === "error") aerr(`${who} run finished with an error: ${job.error}`);
      else alog(`✓ ${who} run complete — sent ${r.sent || 0}, failed ${failed}, skipped ${r.skipped || 0}`);
    }
  })();

  return { started: true, audience, runId, jobId: job.id, approved: approve.added };
}

/* -------------------------------- ticks -------------------------------- */

async function automationTick(): Promise<void> {
  if (running) return;
  const config = await getAutomationConfig();
  if (!config.enabled) return;

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

    const ready = await countApprovableLeads(null, null, audience);
    if (ready < lane.threshold) continue;

    alog(`${laneLabel(audience)} pool reached ${ready}/${lane.threshold} lead(s) with an email — starting an automated run`);
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
