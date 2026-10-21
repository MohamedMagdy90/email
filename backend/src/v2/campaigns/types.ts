// Campaigns (v2 workstream C) — types, defaults, sanitizers and row -> view
// mappers. Mirrors frontend/src/lib/v2/campaigns.ts (the binding contract).
import { parseJson } from "../events";

export type Row = Record<string, any>;
export type CampaignKind = "customer" | "partner";
export type CampaignStatus = "draft" | "active" | "paused" | "archived";

export type ProspectStage =
  | "found"
  | "researched"
  | "contact_found"
  | "verified"
  | "written"
  | "approved"
  | "queued"
  | "sent"
  | "replied"
  | "interested"
  | "meeting"
  | "won"
  | "lost"
  | "unsubscribed"
  | "bounced"
  | "skipped"
  | "failed";

export const STAGES: ProspectStage[] = [
  "found", "researched", "contact_found", "verified", "written", "approved", "queued", "sent",
  "replied", "interested", "meeting", "won", "lost", "unsubscribed", "bounced", "skipped", "failed",
];

export const STAGE_GROUPS: Record<string, ProspectStage[]> = {
  review: ["written"],
  pipeline: ["found", "researched", "contact_found", "verified"],
  outreach: ["approved", "queued", "sent"],
  replies: ["replied", "interested", "meeting", "won"],
  excluded: ["lost", "unsubscribed", "bounced", "skipped", "failed"],
};

/** Stages that mean "this person has been emailed by a campaign". */
export const CONTACTED_STAGES: ProspectStage[] = ["queued", "sent", "replied", "interested", "meeting", "won", "lost"];

export type Funnel = Record<ProspectStage, number> & { total: number };

export function emptyFunnel(): Funnel {
  const f = { total: 0 } as Funnel;
  for (const s of STAGES) f[s] = 0;
  return f;
}

export class CampaignError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "CampaignError";
  }
}

/* ------------------------------ helpers ------------------------------- */

export function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "";
}

export function strList(v: unknown, maxItems = 12, maxLen = 200): string[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\n|,(?=\s*[^\s])/) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    const s = str(x, maxLen);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/* ------------------------------- offer -------------------------------- */

export interface Offer {
  product: string;
  oneLiner: string;
  valueProps: string[];
  proof: string[];
  differentiators: string[];
  pricing: string;
  regions: string[];
  idealCustomers: string[];
  competitors: string[];
  source: "ai" | "manual" | "fallback";
  learnedAt: string | null;
  pages: string[];
}

export function sanitizeOffer(raw: any, source?: Offer["source"]): Offer {
  const o = raw && typeof raw === "object" ? raw : {};
  const src = source || (["ai", "manual", "fallback"].includes(o.source) ? o.source : "manual");
  return {
    product: str(o.product, 120),
    oneLiner: str(o.oneLiner, 400),
    valueProps: strList(o.valueProps, 8, 240),
    proof: strList(o.proof, 8, 240),
    differentiators: strList(o.differentiators, 8, 240),
    pricing: str(o.pricing, 400),
    regions: strList(o.regions, 12, 60),
    idealCustomers: strList(o.idealCustomers, 8, 200),
    competitors: strList(o.competitors, 10, 80),
    source: src,
    learnedAt: typeof o.learnedAt === "string" ? o.learnedAt : null,
    pages: strList(o.pages, 10, 300),
  };
}

/** One compact block for prompts. */
export function offerText(o: Offer | null): string {
  if (!o) return "";
  return [
    o.product && `Product: ${o.product}`,
    o.oneLiner && `What it is: ${o.oneLiner}`,
    o.valueProps.length && `Outcomes: ${o.valueProps.join("; ")}`,
    o.proof.length && `Proof (facts you may use): ${o.proof.join("; ")}`,
    o.differentiators.length && `Differentiators: ${o.differentiators.join("; ")}`,
    o.pricing && `Pricing: ${o.pricing}`,
    o.regions.length && `Regions: ${o.regions.join(", ")}`,
    o.idealCustomers.length && `Ideal customers: ${o.idealCustomers.join("; ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/* ------------------------------ settings ------------------------------ */

export interface CampaignSettings {
  reviewFirst: boolean;
  dailyNewLeads: number;
  followUps: number;
  followUpDelays: [number, number];
  language: "auto" | "en" | "ar";
  sendWindow: { from: string; to: string };
  excludeDomains: string[];
  researchPerDay: number;
  minFitScore: number | null;
}

export const DEFAULT_SETTINGS: CampaignSettings = {
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

export function sanitizeSettings(raw: any, base: CampaignSettings = DEFAULT_SETTINGS): CampaignSettings {
  const s = raw && typeof raw === "object" ? raw : {};
  const d = Array.isArray(s.followUpDelays) ? s.followUpDelays : base.followUpDelays;
  const from = HHMM.test(String(s.sendWindow?.from)) ? String(s.sendWindow.from) : base.sendWindow.from;
  let to = HHMM.test(String(s.sendWindow?.to)) ? String(s.sendWindow.to) : base.sendWindow.to;
  if (to <= from) to = base.sendWindow.to > from ? base.sendWindow.to : "17:00";
  const exclude = strList(s.excludeDomains ?? base.excludeDomains, 500, 120)
    .map((x) => x.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, ""))
    .filter((x) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x));
  const minFit = s.minFitScore === null || s.minFitScore === "" ? null : s.minFitScore === undefined ? base.minFitScore : clampInt(s.minFitScore, 0, 100, 60);
  return {
    reviewFirst: typeof s.reviewFirst === "boolean" ? s.reviewFirst : base.reviewFirst,
    dailyNewLeads: clampInt(s.dailyNewLeads, 1, 500, base.dailyNewLeads),
    followUps: clampInt(s.followUps, 0, 2, base.followUps),
    followUpDelays: [clampInt(d[0], 1, 30, base.followUpDelays[0]), clampInt(d[1], 1, 30, base.followUpDelays[1])],
    language: ["auto", "en", "ar"].includes(s.language) ? s.language : base.language,
    sendWindow: { from, to },
    excludeDomains: [...new Set(exclude)],
    researchPerDay: clampInt(s.researchPerDay, 1, 500, base.researchPerDay),
    minFitScore: minFit,
  };
}

export interface CampaignStatsT {
  sent: number;
  opened: number | null;
  replies: number;
  positive: number;
  bounced: number;
  updatedAt: string | null;
}

/* ------------------------------ segments ------------------------------ */

export interface Segment {
  id: string;
  campaignId: string;
  name: string;
  description: string;
  industries: string[];
  countries: string[];
  companySize: string;
  titles: string[];
  queries: string[];
  fitScore: number | null;
  why: string;
  enabled: boolean;
  status: "active" | "working" | "scaling" | "paused";
  exhausted: boolean;
  found: number;
  sent: number;
  replies: number;
  positive: number;
  createdAt: string;
}

export interface SegmentInput {
  name?: string;
  description?: string;
  industries?: string[];
  countries?: string[];
  companySize?: string;
  titles?: string[];
  queries?: string[];
  fitScore?: number | null;
  why?: string;
  enabled?: boolean;
}

export function sanitizeSegmentInput(raw: any): SegmentInput {
  const s = raw && typeof raw === "object" ? raw : {};
  const out: SegmentInput = {};
  if (s.name !== undefined) out.name = str(s.name, 140);
  if (s.description !== undefined) out.description = str(s.description, 600);
  if (s.industries !== undefined) out.industries = strList(s.industries, 10, 80);
  if (s.countries !== undefined) out.countries = strList(s.countries, 12, 60);
  if (s.companySize !== undefined) out.companySize = str(s.companySize, 80);
  if (s.titles !== undefined) out.titles = strList(s.titles, 12, 80);
  if (s.queries !== undefined) out.queries = strList(s.queries, 20, 160);
  if (s.fitScore !== undefined) out.fitScore = s.fitScore === null ? null : clampInt(s.fitScore, 0, 100, 70);
  if (s.why !== undefined) out.why = str(s.why, 600);
  if (s.enabled !== undefined) out.enabled = !!s.enabled;
  return out;
}

export function segmentView(r: Row): Segment {
  const enabled = Number(r.enabled) === 1;
  return {
    id: String(r.id),
    campaignId: String(r.campaign_id),
    name: String(r.name || ""),
    description: String(r.description || ""),
    industries: parseJson<string[]>(r.industries_json, []),
    countries: parseJson<string[]>(r.countries_json, []),
    companySize: String(r.company_size || ""),
    titles: parseJson<string[]>(r.titles_json, []),
    queries: parseJson<string[]>(r.queries_json, []),
    fitScore: r.fit_score == null ? null : Number(r.fit_score),
    why: String(r.why || ""),
    enabled,
    status: !enabled ? "paused" : ["active", "working", "scaling", "paused"].includes(r.status) ? r.status : "active",
    exhausted: Number(r.exhausted) === 1,
    found: Number(r.found) || 0,
    sent: Number(r.sent) || 0,
    replies: Number(r.replies) || 0,
    positive: Number(r.positive) || 0,
    createdAt: String(r.created_at),
  };
}

/* ------------------------------ prospects ----------------------------- */

export interface EmailStep {
  subject: string;
  body: string;
  delayDays: number;
}

export interface ProspectEmails {
  steps: EmailStep[];
  language: "en" | "ar";
  source: "ai" | "edited";
  writtenAt: string;
  warnings: string[];
}

/** SELECT used by every prospect list/detail: prospect + company + segment name. */
export const PROSPECT_SELECT = `
  SELECT p.*, s.name AS segment_name,
         co.name AS co_name, co.domain AS co_domain, co.website AS co_website, co.country AS co_country,
         co.city AS co_city, co.industry AS co_industry, co.description AS co_description,
         co.size_hint AS co_size_hint, co.phone AS co_phone, co.linkedin_url AS co_linkedin_url,
         co.research_json AS co_research_json, co.researched_at AS co_researched_at,
         co.research_status AS co_research_status, co.language AS co_language
    FROM prospects p
    LEFT JOIN segments s ON s.id = p.segment_id
    LEFT JOIN companies co ON co.id = p.company_id`;

const EMAIL_SOURCES = ["published", "pattern", "role", "manual"];
const VERIFY_STATUSES = ["valid", "invalid", "risky", "catch_all", "unknown"];

export function prospectRowView(r: Row) {
  const emails = parseJson<ProspectEmails | null>(r.email_json, null);
  return {
    id: String(r.id),
    campaignId: String(r.campaign_id),
    segmentId: r.segment_id ? String(r.segment_id) : null,
    segmentName: r.segment_name ? String(r.segment_name) : null,
    companyId: r.company_id ? String(r.company_id) : null,
    company: r.co_name ? String(r.co_name) : r.co_domain ? String(r.co_domain) : null,
    domain: r.co_domain ? String(r.co_domain) : null,
    website: r.co_website ? String(r.co_website) : r.co_domain ? `https://${r.co_domain}` : null,
    country: r.co_country ? String(r.co_country) : null,
    city: r.co_city ? String(r.co_city) : null,
    industry: r.co_industry ? String(r.co_industry) : null,
    fullName: r.full_name ? String(r.full_name) : null,
    title: r.title ? String(r.title) : null,
    linkedinUrl: r.linkedin_url ? String(r.linkedin_url) : null,
    email: r.email ? String(r.email) : null,
    emailStatus: VERIFY_STATUSES.includes(r.email_status) ? r.email_status : null,
    emailSource: EMAIL_SOURCES.includes(r.email_source) ? r.email_source : null,
    fitScore: r.fit_score == null ? null : Number(r.fit_score),
    fitReason: r.fit_reason ? String(r.fit_reason) : null,
    stage: (STAGES.includes(r.stage) ? r.stage : "found") as ProspectStage,
    stageReason: r.stage_reason ? String(r.stage_reason) : null,
    subject: emails?.steps?.[0]?.subject || null,
    mailboxEmail: r.mailbox_email ? String(r.mailbox_email) : null,
    interest: r.interest ? String(r.interest) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    sentAt: r.sent_at || null,
    repliedAt: r.replied_at || null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export interface ResearchJson {
  hooks: string[];
  people: { name: string; title: string; linkedin?: string | null; email?: string | null }[];
  emailsOnSite: string[];
  sources: string[];
  summary?: string;
}

export function researchJson(raw: unknown): ResearchJson {
  const r = parseJson<any>(raw, {}) || {};
  return {
    hooks: strList(r.hooks, 6, 300),
    people: Array.isArray(r.people)
      ? r.people
          .filter((p: any) => p && typeof p.name === "string" && p.name.trim())
          .slice(0, 15)
          .map((p: any) => ({ name: str(p.name, 100), title: str(p.title, 120), linkedin: p.linkedin ? str(p.linkedin, 300) : null, email: p.email ? str(p.email, 200) : null }))
      : [],
    emailsOnSite: strList(r.emailsOnSite, 20, 200),
    sources: strList(r.sources, 10, 300),
    summary: typeof r.summary === "string" ? r.summary : undefined,
  };
}
