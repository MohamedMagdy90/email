// Dashboard API (backend/src/v2/dashboard/). One call returns everything the
// home screen shows; the server caches it for 60 s.
import { req } from "../api";
import type { AgentEvent } from "./core";
import { j, put } from "./core";
import type { CampaignEngine, CampaignKind, CampaignStatus, Funnel } from "./campaigns";

export type Range = 7 | 30 | 90;
export type Tone = "warn" | "bad" | "info" | "good";

export interface NeedsYou {
  id: string;
  tone: Tone;
  title: string;
  body: string;
  /** tab = a shell tab id; leadsView = a Leads built-in view or a stage */
  action: { label: string; tab: string; leadsView?: string; campaignId?: string } | null;
  count?: number;
}

export interface Kpi {
  value: number | null;
  prev: number | null;
  /** last 14 days, oldest first; null = nothing to divide by that day */
  series: (number | null)[];
}

export type KpiKey = "sent" | "replyRate" | "hot" | "meetings" | "bounceRate" | "newLeads" | "costPerHot";

export interface TrendDay {
  day: string;
  sent: number;
  replies: number;
  hot: number;
  bounced: number;
}

export interface DashCampaign {
  id: string;
  name: string;
  kind: CampaignKind;
  status: CampaignStatus;
  engine: CampaignEngine;
  sent: number;
  contacted: number;
  replyRate: number | null;
  hot: number;
  bounceRate: number | null;
  review: number;
  approved: number;
  queuedToday: number;
  queueLimit: number;
  lastError: string | null;
}

export type LoopStatus = "scaling" | "working" | "testing" | "paused";

export interface DashSegment {
  id: string;
  name: string;
  campaignId: string;
  campaignName: string;
  status: LoopStatus;
  exhausted: boolean;
  suggested: { status: string; reason: string } | null;
  found: number;
  contacted: number;
  replies: number;
  positive: number;
  replyRate: number | null;
  positiveRate: number | null;
  verdict: string;
}

export interface EnginePool {
  total: number;
  sending: number;
  dailyCapacity: number;
}

export interface DashCapacity {
  mailboxes: {
    total: number;
    sending: number;
    warming: number;
    ready: number;
    paused: number;
    failing: number;
    nextReady: { email: string; day: string } | null;
    own: EnginePool;
    instantly: EnginePool;
  };
  /** engines the campaigns in view send through */
  engines: CampaignEngine[];
  /** sending mailboxes + emails per day the campaigns in view can use */
  sending: number;
  dailyCapacity: number;
  /** the whole pool, both engines */
  poolCapacity: number;
  /** first emails queued today */
  usedToday: number;
}

export interface Dashboard {
  range: Range;
  campaign: string | null;
  generatedAt: string;
  needsYou: NeedsYou[];
  kpis: Record<KpiKey, Kpi>;
  funnel: Funnel;
  trend: TrendDay[];
  campaigns: DashCampaign[];
  segments: DashSegment[];
  capacity: DashCapacity;
  ai: { configured: boolean; canSearch: boolean; callsToday: number; budgetLeft: number };
  events: AgentEvent[];
  firstSendNote: string | null;
  hasData: boolean;
  pause: { active: number; pausedByAll: number };
  monthlyCost: number;
}

const B = "/api/v2/dashboard";

export const dashboardApi = {
  get: (range: Range, campaign?: string) => req<Dashboard>(`${B}?range=${range}${campaign ? `&campaign=${encodeURIComponent(campaign)}` : ""}`),
  pauseAll: () => req<{ paused: number }>(`${B}/pause-all`, j({})),
  resumeAll: () => req<{ resumed: number; failed: string[] }>(`${B}/resume-all`, j({})),
  setMonthlyCost: (monthlyCost: number) => req<{ monthlyCost: number }>(`${B}/cost`, put({ monthlyCost })),
};
