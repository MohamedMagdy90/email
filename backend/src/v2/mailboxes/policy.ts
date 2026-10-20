// Mailbox policy — the readiness gate, the daily ramp and the auto-pause rules.
// Pure functions only: no database, no network, and the clock is passed in, so
// the same code runs the live pool, the example preview and the tests.
//
// Stages (see v2/schema.ts):
//   warming -> ready -> ramping -> active      and      any -> paused
// A mailbox only sends campaign mail in `ramping` or `active`.

export type Stage = "warming" | "ready" | "ramping" | "active" | "paused";

export interface MailboxPolicy {
  /** Days of warmup before a fresh mailbox may send. */
  minWarmDays: number;
  /** Days for a mailbox the vendor sold as pre-warmed. */
  minWarmDaysPreWarmed: number;
  /** Warmup inbox rate (last 7 days, %) needed to pass the gate. */
  minInboxRate: number;
  /** Warmup emails needed in the 7-day window before the inbox rate counts. */
  minWarmupSample: number;
  /** A sending mailbox is paused when its warmup inbox rate drops below this (%). */
  pauseInboxRate: number;
  /** A sending mailbox is paused when its 7-day bounce rate goes above this (%). */
  maxBounceRate: number;
  /** Campaign sends needed in the 7-day window before the bounce rate counts. */
  minSendsForBounce: number;
  /** Daily limit on the first day of the ramp. */
  rampStart: number;
  /** Added to the daily limit each day of the ramp. */
  rampStep: number;
  /** Full daily limit per mailbox. */
  targetLimit: number;
  /** Start the ramp as soon as every check passes (off = wait for "Start sending"). */
  autoStart: boolean;
  /** Turn warmup back on whenever Instantly reports it off. Warmup runs for life. */
  keepWarmupOn: boolean;
}

export const DEFAULT_POLICY: MailboxPolicy = {
  minWarmDays: 14,
  minWarmDaysPreWarmed: 7,
  minInboxRate: 95,
  minWarmupSample: 20,
  pauseInboxRate: 90,
  maxBounceRate: 3,
  // One bounce in 20 sends is noise, not a signal. 50 is about the first four
  // days of a ramp, and needs at least two bounces to cross 3%.
  minSendsForBounce: 50,
  rampStart: 10,
  rampStep: 3,
  targetLimit: 30,
  autoStart: true,
  keepWarmupOn: true,
};

const LIMITS: Record<Exclude<keyof MailboxPolicy, "autoStart" | "keepWarmupOn">, [number, number]> = {
  minWarmDays: [0, 60],
  minWarmDaysPreWarmed: [0, 60],
  minInboxRate: [50, 100],
  minWarmupSample: [0, 1000],
  pauseInboxRate: [0, 100],
  maxBounceRate: [0.5, 20],
  minSendsForBounce: [1, 1000],
  rampStart: [1, 200],
  rampStep: [1, 100],
  targetLimit: [1, 200],
};

/** Merge a stored/posted policy onto the defaults and clamp every number. */
export function normalizePolicy(raw: unknown): MailboxPolicy {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: MailboxPolicy = { ...DEFAULT_POLICY };
  for (const [key, [lo, hi]] of Object.entries(LIMITS) as [keyof typeof LIMITS, [number, number]][]) {
    const n = Number(src[key]);
    if (src[key] !== undefined && src[key] !== "" && Number.isFinite(n)) out[key] = Math.min(hi, Math.max(lo, n));
  }
  if (typeof src.autoStart === "boolean") out.autoStart = src.autoStart;
  if (typeof src.keepWarmupOn === "boolean") out.keepWarmupOn = src.keepWarmupOn;
  for (const k of ["minWarmDays", "minWarmDaysPreWarmed", "minWarmupSample", "minSendsForBounce", "rampStart", "rampStep", "targetLimit"] as const) {
    out[k] = Math.round(out[k]);
  }
  // The pause line must sit below the pass line, or a mailbox could pass the
  // gate and be paused on the same day.
  if (out.pauseInboxRate >= out.minInboxRate) out.pauseInboxRate = Math.max(0, out.minInboxRate - 1);
  if (out.rampStart > out.targetLimit) out.rampStart = out.targetLimit;
  return out;
}

/* ------------------------------- rows ------------------------------- */

/** A `mailboxes` row, as stored. */
export interface MailboxRow {
  id: string;
  email: string;
  domain: string | null;
  vendor: string;
  first_name: string | null;
  last_name: string | null;
  provider_code: number | null;
  instantly_status: number | null;
  warmup_status: number | null;
  warmup_score: number | null;
  warmup_started_at: string | null;
  pre_warmed: number;
  stage: string;
  stage_reason: string | null;
  stage_changed_at: string | null;
  daily_limit: number;
  target_limit: number;
  ramp_start: number;
  ramp_step: number;
  ramp_started_at: string | null;
  dns_json: string | null;
  checks_json: string | null;
  last_vitals_at: string | null;
  last_synced_at: string | null;
  manual_hold: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  /** 1 = target_limit was set for this mailbox; 0 = follow the pool rule. */
  target_custom?: number | null;
  /** Set when the mailbox disappeared from Instantly. */
  missing_since?: string | null;
}

/** A `mailbox_health` row (one mailbox, one UTC day). */
export interface HealthRow {
  day: string;
  warmup_sent: number;
  warmup_inbox: number;
  warmup_spam: number;
  warmup_received: number;
  inbox_rate: number | null;
  health_score: number | null;
  campaign_sent: number;
  bounced: number;
  replies: number;
}

export interface Dns {
  mx: boolean;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  allPass: boolean;
  indeterminate: string[];
  checkedAt: string;
}

export type CheckKey = "connection" | "warmup" | "dns" | "age" | "inbox";
export type CheckState = "pass" | "fail" | "pending";
export interface Check {
  key: CheckKey;
  label: string;
  state: CheckState;
  detail: string;
}

export interface Metrics {
  warmDays: number | null;
  warmDaysNeeded: number;
  readyEta: string | null;
  inboxRate7: number | null;
  warmupVolume7: number;
  sent7: number;
  bounced7: number;
  replies7: number;
  /**
   * Bounce rate over the last 7 days, but never counting sends from before the
   * current ramp began — so a resumed mailbox starts with a clean slate.
   */
  bounceRate7: number | null;
  bounceSent: number;
  bounceBounced: number;
  /** First day counted in the bounce rate. */
  bounceFrom: string;
}

/* ------------------------------- dates ------------------------------ */

const DAY_MS = 86_400_000;

function dayStart(isoOrDay: string): number {
  return Date.parse(`${isoOrDay.slice(0, 10)}T00:00:00Z`);
}

/** Whole UTC days from `from` to `to` (both ISO timestamps or YYYY-MM-DD). */
export function dayDiff(from: string, to: string): number {
  const a = dayStart(from);
  const b = dayStart(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / DAY_MS);
}

export function addDays(day: string, n: number): string {
  return new Date(dayStart(day) + n * DAY_MS).toISOString().slice(0, 10);
}

/** "29 Oct" */
export function fmtDay(day: string): string {
  return new Date(dayStart(day)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function parseDns(raw: string | null): Dns | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return d && typeof d === "object" && "allPass" in d ? (d as Dns) : null;
  } catch {
    return null;
  }
}

/* ------------------------------ metrics ----------------------------- */

/** Numbers the gate and the screen both use. `health` may hold any days. */
export function metrics(row: MailboxRow, health: HealthRow[], policy: MailboxPolicy, today: string): Metrics {
  const from = addDays(today, -6); // the last 7 days, today included
  const rampFrom = row.ramp_started_at ? row.ramp_started_at.slice(0, 10) : null;
  const bounceFrom = rampFrom && rampFrom > from ? rampFrom : from;
  let inbox = 0;
  let spam = 0;
  let sent7 = 0;
  let bounced7 = 0;
  let replies7 = 0;
  let bounceSent = 0;
  let bounceBounced = 0;
  let firstWarm: string | null = null;
  for (const h of health) {
    if (h.warmup_sent > 0 && (!firstWarm || h.day < firstWarm)) firstWarm = h.day;
    if (h.day < from || h.day > today) continue;
    inbox += Number(h.warmup_inbox) || 0;
    spam += Number(h.warmup_spam) || 0;
    sent7 += Number(h.campaign_sent) || 0;
    bounced7 += Number(h.bounced) || 0;
    replies7 += Number(h.replies) || 0;
    if (h.day >= bounceFrom) {
      bounceSent += Number(h.campaign_sent) || 0;
      bounceBounced += Number(h.bounced) || 0;
    }
  }
  const volume = inbox + spam;
  const warmStart = row.warmup_started_at || firstWarm;
  const needed = row.pre_warmed ? policy.minWarmDaysPreWarmed : policy.minWarmDays;
  return {
    warmDays: warmStart ? Math.max(0, dayDiff(warmStart, today)) : null,
    warmDaysNeeded: needed,
    readyEta: warmStart ? addDays(warmStart, needed) : null,
    inboxRate7: volume > 0 ? round1((inbox / volume) * 100) : null,
    warmupVolume7: volume,
    sent7,
    bounced7,
    replies7,
    bounceRate7: bounceSent > 0 ? round1((bounceBounced / bounceSent) * 100) : null,
    bounceSent,
    bounceBounced,
    bounceFrom,
  };
}

/* --------------------------- readiness gate --------------------------- */

const CONNECTION_FAIL: Record<string, string> = {
  "2": "Paused in Instantly.",
  "3": "Instantly has this mailbox in maintenance.",
  "-1": "Instantly can't sign in to this mailbox. Reconnect it in Instantly.",
  "-2": "Instantly stopped it after soft bounces. Check the mailbox in Instantly.",
  "-3": "Instantly reports sending errors. Check the mailbox in Instantly.",
};

const WARMUP_FAIL: Record<string, string> = {
  "0": "Warmup is off. Turn it on and leave it on.",
  "-1": "Banned from Instantly's warmup network.",
  "-2": "Warmup can't see where mail lands (spam folder unknown in Instantly).",
  "-3": "Permanently suspended from warmup.",
};

export function missingDns(dns: Dns): string[] {
  const out: string[] = [];
  if (!dns.mx) out.push("MX");
  if (!dns.spf) out.push("SPF");
  if (!dns.dkim) out.push("DKIM");
  if (!dns.dmarc) out.push("DMARC");
  return out;
}

/** True when every failing record is one the DNS lookup could not reach. */
function dnsOnlyIndeterminate(dns: Dns): boolean {
  const miss = missingDns(dns);
  const unsure = new Set((dns.indeterminate || []).map((s) => String(s).toUpperCase()));
  return miss.length > 0 && miss.every((m) => unsure.has(m));
}

export function readinessChecks(row: MailboxRow, m: Metrics, policy: MailboxPolicy): Check[] {
  const checks: Check[] = [];

  // 1. The account itself is healthy in Instantly.
  const st = row.instantly_status;
  checks.push(
    st == null
      ? { key: "connection", label: "Connected", state: "pending", detail: "Not seen in Instantly yet." }
      : st === 1
        ? { key: "connection", label: "Connected", state: "pass", detail: "Connected to Instantly, no errors." }
        : { key: "connection", label: "Connected", state: "fail", detail: CONNECTION_FAIL[String(st)] || `Instantly status ${st}.` }
  );

  // 2. Warmup is running.
  const ws = row.warmup_status;
  checks.push(
    ws == null
      ? { key: "warmup", label: "Warmup on", state: "pending", detail: "Warmup status not known yet." }
      : ws === 1
        ? { key: "warmup", label: "Warmup on", state: "pass", detail: "Warmup is running." }
        : { key: "warmup", label: "Warmup on", state: "fail", detail: WARMUP_FAIL[String(ws)] || `Warmup status ${ws}.` }
  );

  // 3. The domain's DNS records (per domain, shared by its mailboxes).
  const dns = parseDns(row.dns_json);
  if (!dns) {
    checks.push({ key: "dns", label: "DNS records", state: "pending", detail: "Not checked yet. Checked on the next sync." });
  } else if (dns.allPass) {
    checks.push({ key: "dns", label: "DNS records", state: "pass", detail: "MX, SPF, DKIM and DMARC all found." });
  } else if (dnsOnlyIndeterminate(dns)) {
    checks.push({
      key: "dns",
      label: "DNS records",
      state: "pending",
      detail: `Couldn't look up ${missingDns(dns).join(", ")} (DNS timeout). Re-checked on the next sync.`,
    });
  } else {
    checks.push({
      key: "dns",
      label: "DNS records",
      state: "fail",
      detail: `Missing ${missingDns(dns).join(", ")}. Add the record at the domain's DNS provider (the mailbox vendor usually does this for you).`,
    });
  }

  // 4. Enough days of warmup.
  const need = m.warmDaysNeeded;
  const pre = row.pre_warmed ? ", pre-warmed" : "";
  checks.push(
    m.warmDays == null
      ? { key: "age", label: `${need} days warming`, state: "pending", detail: "Warmup hasn't started yet." }
      : m.warmDays >= need
        ? { key: "age", label: `${need} days warming`, state: "pass", detail: `Warmed for ${plural(m.warmDays, "day")} (needs ${need}${pre}).` }
        : {
            key: "age",
            label: `${need} days warming`,
            state: "pending",
            detail: `Day ${m.warmDays} of ${need}${pre}. Ready around ${fmtDay(m.readyEta as string)}.`,
          }
  );

  // 5. Warmup mail lands in the inbox.
  if (m.warmupVolume7 < Math.max(1, policy.minWarmupSample) || m.inboxRate7 == null) {
    checks.push({
      key: "inbox",
      label: `${policy.minInboxRate}% inbox rate`,
      state: "pending",
      detail: `Not enough warmup data yet: ${m.warmupVolume7} of ${policy.minWarmupSample} emails in the last 7 days.`,
    });
  } else if (m.inboxRate7 >= policy.minInboxRate) {
    checks.push({
      key: "inbox",
      label: `${policy.minInboxRate}% inbox rate`,
      state: "pass",
      detail: `${m.inboxRate7}% of ${m.warmupVolume7} warmup emails landed in the inbox this week.`,
    });
  } else {
    checks.push({
      key: "inbox",
      label: `${policy.minInboxRate}% inbox rate`,
      state: "fail",
      detail: `Only ${m.inboxRate7}% of ${m.warmupVolume7} warmup emails landed in the inbox this week (needs ${policy.minInboxRate}%).`,
    });
  }

  return checks;
}

/* ----------------------------- auto-pause ----------------------------- */

/** Why a SENDING mailbox must stop now, or null if it may keep sending. */
export function pauseTrigger(row: MailboxRow, m: Metrics, policy: MailboxPolicy): string | null {
  const st = row.instantly_status;
  if (st === 2) return "Paused in Instantly.";
  if (st != null && st < 0) return CONNECTION_FAIL[String(st)] || `Instantly status ${st}.`;
  const ws = row.warmup_status;
  if (ws != null && ws < 0) return WARMUP_FAIL[String(ws)] || `Warmup status ${ws}.`;
  const dns = parseDns(row.dns_json);
  if (dns && !dns.allPass && !dnsOnlyIndeterminate(dns)) return `DNS check failed: ${missingDns(dns).join(", ")} missing.`;
  if (m.inboxRate7 != null && m.warmupVolume7 >= policy.minWarmupSample && m.inboxRate7 < policy.pauseInboxRate) {
    return `Warmup inbox rate fell to ${m.inboxRate7}% this week (pauses below ${policy.pauseInboxRate}%).`;
  }
  if (m.bounceRate7 != null && m.bounceSent >= policy.minSendsForBounce && m.bounceRate7 > policy.maxBounceRate) {
    return `Bounce rate ${m.bounceRate7}%: ${m.bounceBounced} of ${m.bounceSent} emails bounced since ${fmtDay(m.bounceFrom)} (limit ${policy.maxBounceRate}%).`;
  }
  return null;
}

/* -------------------------------- ramp -------------------------------- */

/**
 * The ramp numbers for one mailbox. Start and step always follow the pool
 * rules; the full limit follows them too unless it was set for this mailbox.
 */
export function rampParams(row: MailboxRow, policy: MailboxPolicy) {
  const target = row.target_custom === 1 && row.target_limit > 0 ? row.target_limit : policy.targetLimit;
  const start = Math.min(target, policy.rampStart);
  const step = Math.max(1, policy.rampStep);
  return { target, start, step };
}

/** Today's daily limit for a sending mailbox. */
export function rampLimit(row: MailboxRow, policy: MailboxPolicy, today: string): number {
  const { target, start, step } = rampParams(row, policy);
  if (!row.ramp_started_at) return start;
  const days = Math.max(0, dayDiff(row.ramp_started_at, today));
  return Math.min(target, start + step * days);
}

/** The day a ramping mailbox reaches its full limit. */
export function fullRampDay(row: MailboxRow, policy: MailboxPolicy, today: string): string | null {
  const { target, start, step } = rampParams(row, policy);
  const from = row.ramp_started_at ? row.ramp_started_at.slice(0, 10) : today;
  return addDays(from, Math.max(0, Math.ceil((target - start) / step)));
}

/* ------------------------------ decision ------------------------------ */

export interface Decision {
  stage: Stage;
  reason: string;
  dailyLimit: number;
  rampStartedAt: string | null;
  checks: Check[];
  metrics: Metrics;
  /** Something worth a line in the activity feed. */
  event: { level: "info" | "success" | "warn"; message: string } | null;
}

function waitingOn(checks: Check[]): string {
  const open = checks.filter((c) => c.state !== "pass");
  const fail = open.find((c) => c.state === "fail");
  if (fail) return fail.detail;
  if (open.length === 1) return open[0].detail;
  return `Waiting on ${open.map((c) => c.label.toLowerCase()).join(", ")}.`;
}

/**
 * The next state of one mailbox. `held` = the user (or the policy) wants a
 * mailbox that passes every check to wait for a manual start.
 */
export function decide(row: MailboxRow, health: HealthRow[], policy: MailboxPolicy, today: string): Decision {
  const m = metrics(row, health, policy, today);
  const checks = readinessChecks(row, m, policy);
  const who = row.email;
  const base = { checks, metrics: m };

  if (row.stage === "paused") {
    return { ...base, stage: "paused", reason: row.stage_reason || "Paused.", dailyLimit: row.daily_limit, rampStartedAt: row.ramp_started_at, event: null };
  }

  if (row.stage === "ramping" || row.stage === "active") {
    const trigger = pauseTrigger(row, m, policy);
    if (trigger) {
      return {
        ...base,
        stage: "paused",
        reason: trigger,
        dailyLimit: row.daily_limit,
        rampStartedAt: row.ramp_started_at,
        event: { level: "warn", message: `Paused ${who}: ${trigger}` },
      };
    }
    const { target } = rampParams(row, policy);
    const limit = rampLimit(row, policy, today);
    if (limit >= target) {
      return {
        ...base,
        stage: "active",
        reason: `Sending at its full limit of ${target} a day.`,
        dailyLimit: target,
        rampStartedAt: row.ramp_started_at,
        event: row.stage !== "active" ? { level: "success", message: `${who} reached its full limit of ${target} emails a day.` } : null,
      };
    }
    const day = row.ramp_started_at ? dayDiff(row.ramp_started_at, today) + 1 : 1;
    const full = fullRampDay(row, policy, today);
    return {
      ...base,
      stage: "ramping",
      reason: `Ramp day ${day}: ${limit} a day, reaching ${target} on ${fmtDay(full as string)}.`,
      dailyLimit: limit,
      rampStartedAt: row.ramp_started_at,
      event: limit !== row.daily_limit && row.daily_limit > 0 ? { level: "info", message: `${who} ramped to ${limit} emails a day.` } : null,
    };
  }

  // warming / ready (and anything unknown) go through the gate.
  const allPass = checks.every((c) => c.state === "pass");
  if (!allPass) {
    return {
      ...base,
      stage: "warming",
      reason: waitingOn(checks),
      dailyLimit: 0,
      rampStartedAt: null,
      event:
        row.stage === "ready"
          ? { level: "warn", message: `${who} no longer passes every check and is back to warming: ${waitingOn(checks)}` }
          : null,
    };
  }

  const held = row.manual_hold === 1 || !policy.autoStart;
  if (held) {
    return {
      ...base,
      stage: "ready",
      reason: row.manual_hold === 1 ? "Passed every check. Held by you until you start sending." : "Passed every check. Waiting for you to start sending.",
      dailyLimit: 0,
      rampStartedAt: null,
      event: row.stage !== "ready" ? { level: "success", message: `${who} passed every readiness check and is ready to send.` } : null,
    };
  }

  const { target, start } = rampParams(row, policy);
  return {
    ...base,
    stage: start >= target ? "active" : "ramping",
    reason: start >= target ? `Sending at its full limit of ${target} a day.` : `Ramp day 1: ${start} a day.`,
    dailyLimit: start,
    rampStartedAt: today,
    event: { level: "success", message: `${who} passed every readiness check. Sending started at ${start} emails a day.` },
  };
}
