// Campaigns API (v2 workstream C — the AI lead engine).
// BINDING CONTRACT: backend/src/v2/campaigns/** must return exactly these
// shapes, and screens/Campaigns.tsx consumes only this file. Spec and rules:
// .same/campaigns-spec.md. Change a shape here first, then on both sides.
import { req } from "../api";
import { del, j, put, type AgentEvent, type VerifyResult } from "./core";
import type { TargetMarket } from "./targeting";

/* ------------------------------- enums -------------------------------- */

export type CampaignKind = "customer" | "partner";
export type CampaignStatus = "draft" | "active" | "paused" | "archived";

/** Pipeline order, then outcomes, then exits. */
export type ProspectStage =
  | "found" // company found, nothing else yet
  | "researched" // company researched
  | "contact_found" // decision maker + candidate address
  | "verified" // address checked and allowed by the sending policy
  | "written" // emails written (waiting for review when reviewFirst is on)
  | "approved" // approved, waiting to be pushed to Instantly
  | "queued" // in the Instantly campaign, first email not sent yet
  | "sent" // first email sent
  | "replied"
  | "interested"
  | "meeting"
  | "won"
  | "lost"
  | "unsubscribed"
  | "bounced"
  | "skipped" // dropped on purpose (fit, policy, suppression, by hand) — stage_reason says why
  | "failed"; // gave up after retries — last_error says why

export const PIPELINE_STAGES: ProspectStage[] = ["found", "researched", "contact_found", "verified", "written", "approved", "queued", "sent"];
export const OUTCOME_STAGES: ProspectStage[] = ["replied", "interested", "meeting", "won"];
export const EXIT_STAGES: ProspectStage[] = ["lost", "unsubscribed", "bounced", "skipped", "failed"];

/** Filter groups accepted by `stage=` on the prospects list, besides a single stage. */
export type StageGroup = "all" | "review" | "pipeline" | "outreach" | "replies" | "excluded";
//   review    = written (only meaningful when reviewFirst is on)
//   pipeline  = found, researched, contact_found, verified
//   outreach  = approved, queued, sent
//   replies   = replied, interested, meeting, won
//   excluded  = lost, unsubscribed, bounced, skipped, failed

export type Funnel = Record<ProspectStage, number> & { total: number };

/* ------------------------------- offer -------------------------------- */

export interface Offer {
  product: string; // "DNA ERP"
  oneLiner: string; // one sentence: what it is and for whom
  valueProps: string[]; // outcomes the buyer gets
  proof: string[]; // facts that back it up (never invented)
  differentiators: string[];
  pricing: string; // only what the site / knowledge base says, else ""
  regions: string[]; // where it is sold / supported
  idealCustomers: string[]; // who it is for, in plain words
  competitors: string[];
  source: "ai" | "manual" | "fallback"; // fallback = built from the agent knowledge base (no AI key)
  learnedAt: string | null;
  pages: string[]; // URLs read while learning
}

/* ------------------------------ settings ------------------------------ */

export interface CampaignSettings {
  /** Written emails wait in the review queue until approved. Default true. */
  reviewFirst: boolean;
  /** Max NEW leads pushed to Instantly per day (also capped by mailbox capacity). Default 30. */
  dailyNewLeads: number;
  /** Follow-ups after the first email, 0-2. Default 2. */
  followUps: number;
  /** Days to wait before follow-up 1 and follow-up 2. Default [3, 4]. */
  followUpDelays: [number, number];
  /** auto = English first touch unless the company's site is Arabic-only. Default "auto". */
  language: "auto" | "en" | "ar";
  /** Sending window in the leads' timezone, HH:MM 24h. Default 09:00-17:00. */
  sendWindow: { from: string; to: string };
  /** Never contact these domains (customers, partners, competitors). Registrable domains, lower-case. */
  excludeDomains: string[];
  /** Max companies researched per day for this campaign (AI budget). Default 60. */
  researchPerDay: number;
  /** Overrides the agent's sending.minFitScore when set (0-100). Default null. */
  minFitScore: number | null;
}

export const DEFAULT_CAMPAIGN_SETTINGS: CampaignSettings = {
  reviewFirst: true,
  dailyNewLeads: 30,
  followUps: 2,
  followUpDelays: [3, 4],
  language: "auto",
  sendWindow: { from: "09:00", to: "17:00" },
  excludeDomains: [],
  researchPerDay: 60,
  minFitScore: null,
};

/* ------------------------------ segments ------------------------------ */

export type SegmentStatus = "active" | "working" | "scaling" | "paused";

export interface Segment {
  id: string;
  campaignId: string;
  name: string; // "Trading and distribution companies in Saudi Arabia"
  description: string;
  industries: string[];
  countries: string[];
  companySize: string; // "10-200 employees"
  titles: string[]; // decision-maker titles, in priority order
  queries: string[]; // web-search queries used to find companies
  fitScore: number | null; // 0-100, how well it fits the offer
  why: string; // one or two sentences
  enabled: boolean;
  status: SegmentStatus;
  exhausted: boolean; // every query has been searched
  found: number;
  sent: number;
  replies: number;
  positive: number;
  createdAt: string;
  // Structured targeting (Phase 5, plan §8.4.2) — narrows the campaign's market.
  industryIds: string[]; // taxonomy ids (lib/v2/targeting.ts)
  cities: Record<string, string[]>; // country -> cities; {} = the market's
  sizeBands: string[] | null; // null = the market's size
  minBranches: number | null;
  titlesOverride: boolean; // false = the market's ranked titles
  signals: { must: string[]; mustNot: string[] };
  queriesAuto: boolean; // searches generated from the fields (false = written by hand)
  searchesDone: number;
  searchesTotal: number;
}

export type SegmentInput = Partial<
  Pick<
    Segment,
    | "name"
    | "description"
    | "industries"
    | "countries"
    | "companySize"
    | "titles"
    | "queries"
    | "fitScore"
    | "why"
    | "enabled"
    | "industryIds"
    | "cities"
    | "sizeBands"
    | "minBranches"
    | "titlesOverride"
    | "signals"
    | "queriesAuto"
  >
>;

/* ------------------------------ campaigns ----------------------------- */

export interface CampaignReadiness {
  ai: boolean; // any AI key
  aiSearch: boolean; // Gemini key (Google Search grounding)
  instantly: boolean;
  mailboxes: { total: number; sending: number; dailyCapacity: number };
  reacher: boolean; // SMTP verification available
  budgetRemaining: number; // AI calls left today
}

export interface CampaignStats {
  sent: number;
  opened: number | null;
  replies: number;
  positive: number;
  bounced: number;
  updatedAt: string | null;
}

export interface CampaignSummary {
  id: string;
  name: string;
  kind: CampaignKind;
  status: CampaignStatus;
  website: string;
  segments: number; // enabled segments
  funnel: Funnel;
  instantly: { id: string | null; status: number | null };
  stats: CampaignStats | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignToday {
  discovered: number;
  researched: number;
  written: number;
  queued: number;
  queueLimit: number; // min(dailyNewLeads, mailbox capacity)
}

export interface CampaignDetail extends CampaignSummary {
  offer: Offer | null;
  settings: CampaignSettings;
  /** The target market (Phase 5). Edit it through targetingApi.saveMarket. */
  market: TargetMarket;
  segmentList: Segment[];
  readiness: CampaignReadiness;
  /** Plain-English reasons a stage is waiting, e.g. "Waiting for an AI key to write the emails." */
  blockers: string[];
  today: CampaignToday;
  working: boolean; // the worker is processing this campaign right now
  reviewCount: number; // written emails waiting for approval
}

/* ------------------------------ prospects ----------------------------- */

export interface ProspectRow {
  id: string;
  campaignId: string;
  segmentId: string | null;
  segmentName: string | null;
  companyId: string | null;
  company: string | null;
  domain: string | null;
  website: string | null;
  country: string | null;
  city: string | null;
  industry: string | null;
  fullName: string | null;
  title: string | null;
  linkedinUrl: string | null;
  email: string | null;
  emailStatus: VerifyResult["status"] | null;
  emailSource: "published" | "pattern" | "role" | "manual" | "import" | null;
  fitScore: number | null;
  fitReason: string | null;
  stage: ProspectStage;
  stageReason: string | null;
  /** Which targeting rule skipped it (country, city, industry, size, keyword, language). */
  skipRule: string | null;
  /** "Prefer" rules it missed, which lowered its fit score. */
  targetNotes: string | null;
  subject: string | null; // first email subject once written
  mailboxEmail: string | null;
  interest: string | null;
  lastError: string | null;
  sentAt: string | null;
  repliedAt: string | null;
  createdAt: string;
  updatedAt: string;
  campaignName: string | null;
  /** How the agent found it: gemini / search / manual / import. */
  leadSource: "gemini" | "search" | "manual" | "import" | null;
  /** Steps Instantly has sent (1 = the first email), when it executed the last one, and the step replied to. */
  lastStep: number | null;
  lastStepAt: string | null;
  repliedStep: number | null;
  totalSteps: number;
}

export interface EmailStep {
  subject: string; // "" on follow-ups keeps the thread ("Re: ...")
  body: string; // plain text, \n line breaks
  delayDays: number; // 0 for the first email
}

export interface ProspectEmails {
  steps: EmailStep[];
  language: "en" | "ar";
  source: "ai" | "edited";
  writtenAt: string;
  warnings: string[]; // guardrail notes, e.g. "Email 1 had a link; removed."
}

export interface CompanyResearch {
  description: string | null;
  sizeHint: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  hooks: string[]; // specific, recent, usable observations
  people: { name: string; title: string; linkedin?: string | null; email?: string | null }[];
  emailsOnSite: string[];
  researchedAt: string | null;
  researchStatus: "ok" | "partial" | "blocked" | "failed" | null;
  sources: string[]; // pages read
}

export interface ProspectDetail extends ProspectRow {
  research: CompanyResearch;
  verify: VerifyResult | null;
  emails: ProspectEmails | null;
  events: AgentEvent[];
}

export interface RunResult {
  discovered: number;
  researched: number;
  contacted: number;
  verified: number;
  scored: number;
  written: number;
  queued: number;
  notes: string[]; // what happened / why something waited, plain English
}

/* -------------------------------- client ------------------------------ */

const B = "/api/v2/campaigns";

export const campaignsApi = {
  list: () => req<{ campaigns: CampaignSummary[]; readiness: CampaignReadiness }>(B),
  create: (body: { name: string; kind: CampaignKind; website?: string }) => req<{ campaign: CampaignDetail }>(B, j(body)),
  get: (id: string) => req<{ campaign: CampaignDetail }>(`${B}/${id}`),
  update: (id: string, body: { name?: string; kind?: CampaignKind; website?: string; offer?: Offer; settings?: Partial<CampaignSettings> }) =>
    req<{ campaign: CampaignDetail }>(`${B}/${id}`, put(body)),
  /** Drafts are deleted; anything else is archived (and paused in Instantly). */
  remove: (id: string) => req<{ ok: true; deleted: boolean }>(`${B}/${id}`, del),

  learnOffer: (id: string, website?: string) => req<{ campaign: CampaignDetail; warning?: string }>(`${B}/${id}/offer/learn`, j({ website })),
  proposeSegments: (id: string, count = 4) => req<{ segments: Segment[]; warning?: string }>(`${B}/${id}/segments/propose`, j({ count })),
  addSegment: (id: string, body: SegmentInput) => req<{ segment: Segment }>(`${B}/${id}/segments`, j(body)),
  updateSegment: (id: string, sid: string, body: SegmentInput) => req<{ segment: Segment }>(`${B}/${id}/segments/${sid}`, put(body)),
  deleteSegment: (id: string, sid: string) => req<{ ok: true }>(`${B}/${id}/segments/${sid}`, del),

  /** 400 with { error } listing what is missing (offer, an enabled segment). */
  start: (id: string) => req<{ campaign: CampaignDetail }>(`${B}/${id}/start`, j({})),
  pause: (id: string) => req<{ campaign: CampaignDetail }>(`${B}/${id}/pause`, j({})),
  /** One pipeline pass now (time-boxed, small batches). Works on drafts too (no pushing to Instantly). */
  run: (id: string) => req<{ campaign: CampaignDetail; ran: RunResult }>(`${B}/${id}/run`, j({})),

  prospects: (id: string, params: { stage?: ProspectStage | StageGroup; segment?: string; q?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    return req<{ prospects: ProspectRow[]; total: number; funnel: Funnel }>(`${B}/${id}/prospects${qs.toString() ? `?${qs}` : ""}`);
  },
  prospect: (id: string, pid: string) => req<{ prospect: ProspectDetail }>(`${B}/${id}/prospects/${pid}`),
  /** Edit the copy (source becomes "edited") and/or fix the person / address (re-verified). */
  updateProspect: (id: string, pid: string, body: { steps?: { subject: string; body: string }[]; fullName?: string; title?: string; email?: string }) =>
    req<{ prospect: ProspectDetail }>(`${B}/${id}/prospects/${pid}`, put(body)),
  rewrite: (id: string, pid: string, instruction?: string) => req<{ prospect: ProspectDetail }>(`${B}/${id}/prospects/${pid}/rewrite`, j({ instruction })),
  approve: (id: string, body: { ids?: string[]; all?: boolean }) => req<{ approved: number }>(`${B}/${id}/prospects/approve`, j(body)),
  skip: (id: string, body: { ids: string[]; reason?: string }) => req<{ skipped: number }>(`${B}/${id}/prospects/skip`, j(body)),
  /** Put skipped / failed prospects back into the pipeline at the step they left. */
  restore: (id: string, body: { ids: string[] }) => req<{ restored: number }>(`${B}/${id}/prospects/restore`, j(body)),
  /** Add companies by hand: websites or domains, one per line. */
  addCompanies: (id: string, body: { segmentId?: string; domains: string[] }) =>
    req<{ added: number; skipped: { domain: string; reason: string }[] }>(`${B}/${id}/companies`, j(body)),
};

/* ------------------------------- labels ------------------------------- */

export const STAGE_LABEL: Record<ProspectStage, string> = {
  found: "Found",
  researched: "Researched",
  contact_found: "Contact found",
  verified: "Verified",
  written: "Written",
  approved: "Approved",
  queued: "Queued",
  sent: "Sent",
  replied: "Replied",
  interested: "Interested",
  meeting: "Meeting",
  won: "Won",
  lost: "Lost",
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
  skipped: "Skipped",
  failed: "Failed",
};
