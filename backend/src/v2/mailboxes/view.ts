// Turns stored mailbox rows into what the Mailboxes screen shows. Pure, so the
// live list and the example preview are built by exactly the same code.
import {
  addDays,
  dayDiff,
  fullRampDay,
  metrics,
  parseDns,
  rampParams,
  readinessChecks,
  type Check,
  type Dns,
  type HealthRow,
  type MailboxPolicy,
  type MailboxRow,
  type Metrics,
  type Stage,
} from "./policy";

export const STAGES: Stage[] = ["warming", "ready", "ramping", "active", "paused"];

const PROVIDERS: Record<string, string> = { "1": "IMAP/SMTP", "2": "Google", "3": "Microsoft", "4": "AWS" };

export interface MailboxView {
  id: string;
  email: string;
  domain: string;
  vendor: string;
  name: string;
  provider: string;
  stage: Stage;
  reason: string;
  stageChangedAt: string | null;
  sendable: boolean;
  dailyLimit: number;
  targetLimit: number;
  targetCustom: boolean;
  rampStart: number;
  rampStep: number;
  rampDay: number | null;
  fullRampOn: string | null;
  preWarmed: boolean;
  manualHold: boolean;
  instantlyStatus: number | null;
  warmupStatus: number | null;
  warmupScore: number | null;
  missing: boolean;
  checks: Check[];
  metrics: Metrics;
  /** Warmup inbox rate per day for the last 14 days, oldest first (null = no warmup mail). */
  spark: (number | null)[];
  sentToday: number;
  notes: string;
  lastSyncedAt: string | null;
}

export interface DomainView {
  domain: string;
  vendors: string[];
  count: number;
  dns: Dns | null;
}

export interface Summary {
  total: number;
  byStage: Record<Stage, number>;
  sendable: number;
  capacityToday: number;
  capacityFull: number;
  sentToday: number;
  inboxRate7: number | null;
  warmupVolume7: number;
  nextReady: { email: string; day: string } | null;
  attention: number;
}

export interface PoolView {
  mailboxes: MailboxView[];
  domains: DomainView[];
  summary: Summary;
}

const asStage = (s: string): Stage => (STAGES.includes(s as Stage) ? (s as Stage) : "warming");

export function viewMailbox(row: MailboxRow, health: HealthRow[], policy: MailboxPolicy, today: string): MailboxView {
  const m = metrics(row, health, policy, today);
  const stage = asStage(row.stage);
  const { target, start, step } = rampParams(row, policy);
  const byDay = new Map(health.map((h) => [h.day, h]));
  const spark: (number | null)[] = [];
  for (let i = 13; i >= 0; i--) {
    const h = byDay.get(addDays(today, -i));
    const vol = h ? (Number(h.warmup_inbox) || 0) + (Number(h.warmup_spam) || 0) : 0;
    spark.push(h && vol > 0 ? Math.round(((Number(h.warmup_inbox) || 0) / vol) * 1000) / 10 : null);
  }
  const sending = stage === "ramping" || stage === "active";
  return {
    id: row.id,
    email: row.email,
    domain: row.domain || row.email.split("@")[1] || "",
    vendor: row.vendor || "other",
    name: [row.first_name, row.last_name].filter(Boolean).join(" "),
    provider: PROVIDERS[String(row.provider_code)] || "Other",
    stage,
    reason: row.stage_reason || "",
    stageChangedAt: row.stage_changed_at,
    sendable: sending && !row.missing_since && row.instantly_status === 1,
    dailyLimit: Number(row.daily_limit) || 0,
    targetLimit: target,
    targetCustom: row.target_custom === 1,
    rampStart: start,
    rampStep: step,
    rampDay: stage === "ramping" && row.ramp_started_at ? dayDiff(row.ramp_started_at, today) + 1 : null,
    fullRampOn: stage === "ramping" ? fullRampDay(row, policy, today) : null,
    preWarmed: row.pre_warmed === 1,
    manualHold: row.manual_hold === 1,
    instantlyStatus: row.instantly_status,
    warmupStatus: row.warmup_status,
    warmupScore: row.warmup_score,
    missing: !!row.missing_since,
    checks: readinessChecks(row, m, policy),
    metrics: m,
    spark,
    sentToday: Number(byDay.get(today)?.campaign_sent) || 0,
    notes: row.notes || "",
    lastSyncedAt: row.last_synced_at,
  };
}

export function buildView(rows: MailboxRow[], health: Map<string, HealthRow[]>, policy: MailboxPolicy, today: string): PoolView {
  const mailboxes = rows.map((r) => viewMailbox(r, health.get(r.id) || [], policy, today));
  mailboxes.sort((a, b) => a.domain.localeCompare(b.domain) || a.email.localeCompare(b.email));

  const domainMap = new Map<string, DomainView>();
  for (const mb of mailboxes) {
    const d = domainMap.get(mb.domain) || { domain: mb.domain, vendors: [], count: 0, dns: null };
    d.count++;
    if (!d.vendors.includes(mb.vendor)) d.vendors.push(mb.vendor);
    const row = rows.find((r) => r.id === mb.id);
    const dns = row ? parseDns(row.dns_json) : null;
    if (dns && (!d.dns || dns.checkedAt > d.dns.checkedAt)) d.dns = dns;
    domainMap.set(mb.domain, d);
  }

  const live = mailboxes.filter((m) => !m.missing);
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const m of live) byStage[m.stage]++;
  let inbox = 0;
  let volume = 0;
  for (const r of rows) {
    if (r.missing_since) continue;
    const from = addDays(today, -6);
    for (const h of health.get(r.id) || []) {
      if (h.day < from || h.day > today) continue;
      inbox += Number(h.warmup_inbox) || 0;
      volume += (Number(h.warmup_inbox) || 0) + (Number(h.warmup_spam) || 0);
    }
  }
  const next = live
    .filter((m) => m.stage === "warming" && m.metrics.readyEta && m.metrics.readyEta >= today && !m.checks.some((c) => c.state === "fail"))
    .sort((a, b) => (a.metrics.readyEta as string).localeCompare(b.metrics.readyEta as string))[0];

  return {
    mailboxes,
    domains: [...domainMap.values()],
    summary: {
      total: live.length,
      byStage,
      sendable: live.filter((m) => m.sendable).length,
      capacityToday: live.filter((m) => m.sendable).reduce((a, m) => a + m.dailyLimit, 0),
      capacityFull: live.reduce((a, m) => a + m.targetLimit, 0),
      sentToday: live.reduce((a, m) => a + m.sentToday, 0),
      inboxRate7: volume > 0 ? Math.round((inbox / volume) * 1000) / 10 : null,
      warmupVolume7: volume,
      nextReady: next ? { email: next.email, day: next.metrics.readyEta as string } : null,
      attention: live.filter((m) => m.stage === "paused" || (m.stage === "warming" && m.checks.some((c) => c.state === "fail"))).length,
    },
  };
}
