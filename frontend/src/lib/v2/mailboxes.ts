// Mailboxes API (v2 workstream A). Mirrors backend/src/v2/mailboxes/{policy,view,service}.ts.
import { req } from "../api";
import { del, j, patch, put, type AgentEvent } from "./core";

export type Stage = "warming" | "ready" | "ramping" | "active" | "paused";
export const STAGES: Stage[] = ["warming", "ready", "ramping", "active", "paused"];

export type CheckKey = "connection" | "warmup" | "dns" | "age" | "inbox";
export interface Check {
  key: CheckKey;
  label: string;
  state: "pass" | "fail" | "pending";
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
  bounceRate7: number | null;
  bounceSent: number;
  bounceBounced: number;
  bounceFrom: string;
}

export interface Mailbox {
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
  spark: (number | null)[];
  sentToday: number;
  notes: string;
  lastSyncedAt: string | null;
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

export interface DomainInfo {
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

export interface MailboxPolicy {
  minWarmDays: number;
  minWarmDaysPreWarmed: number;
  minInboxRate: number;
  minWarmupSample: number;
  pauseInboxRate: number;
  maxBounceRate: number;
  minSendsForBounce: number;
  rampStart: number;
  rampStep: number;
  targetLimit: number;
  autoStart: boolean;
  keepWarmupOn: boolean;
}

export interface HealthDay {
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

export interface LastSync {
  at: string;
  ok: boolean;
  synced: number;
  errors: string[];
  ms: number;
}

export interface MailboxDetail {
  mailbox: Mailbox;
  health: HealthDay[];
  events: AgentEvent[];
}

export interface PoolResponse {
  example: boolean;
  connected: boolean;
  syncing: boolean;
  lastSync: LastSync | null;
  policy: MailboxPolicy;
  mailboxes: Mailbox[];
  domains: DomainInfo[];
  summary: Summary;
  /** Example mode only. */
  events?: AgentEvent[];
  details?: Record<string, MailboxDetail>;
}

export interface MailboxPatch {
  vendor?: string;
  preWarmed?: boolean;
  manualHold?: boolean;
  targetLimit?: number | null;
  notes?: string;
}

type ActionResult = { ok: true; warning: string | null; detail: MailboxDetail };

export const mailboxesApi = {
  list: () => req<PoolResponse>("/api/v2/mailboxes"),
  example: () => req<PoolResponse>("/api/v2/mailboxes/example"),
  detail: (id: string) => req<MailboxDetail>(`/api/v2/mailboxes/${encodeURIComponent(id)}`),
  sync: () => req<{ result: { synced: number; errors: string[] }; view: PoolResponse }>("/api/v2/mailboxes/sync", { method: "POST" }),
  savePolicy: (p: Partial<MailboxPolicy>) =>
    req<{ policy: MailboxPolicy; warning: string | null; view: PoolResponse }>("/api/v2/mailboxes/policy", put(p)),
  update: (id: string, p: MailboxPatch) => req<ActionResult>(`/api/v2/mailboxes/${encodeURIComponent(id)}`, patch(p)),
  pause: (id: string, reason?: string) => req<ActionResult>(`/api/v2/mailboxes/${encodeURIComponent(id)}/pause`, j({ reason })),
  resume: (id: string) => req<ActionResult>(`/api/v2/mailboxes/${encodeURIComponent(id)}/resume`, j({})),
  start: (id: string) => req<ActionResult>(`/api/v2/mailboxes/${encodeURIComponent(id)}/start`, j({})),
  warmup: (id: string, on: boolean) => req<ActionResult>(`/api/v2/mailboxes/${encodeURIComponent(id)}/warmup`, j({ on })),
  forget: (id: string) => req<{ ok: true }>(`/api/v2/mailboxes/${encodeURIComponent(id)}`, del),
};

/** "23 Oct" from YYYY-MM-DD or ISO. */
export function fmtDay(day: string | null | undefined): string {
  if (!day) return "—";
  const t = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** The ramp as a list of daily limits from day 1 to the full limit. */
export function rampSteps(start: number, step: number, target: number): number[] {
  const out: number[] = [];
  let v = Math.min(start, target);
  for (let i = 0; i < 60; i++) {
    out.push(v);
    if (v >= target) break;
    v = Math.min(target, v + Math.max(1, step));
  }
  return out;
}

export const VENDOR_LABEL: Record<string, string> = { zapmail: "Zapmail", mailforge: "Mailforge", other: "Other" };
