// Targeting API (Phase 5, plan §8.4). BINDING CONTRACT: backend/src/v2/targeting/**
// returns exactly these shapes; the Targeting screens consume only this file
// (+ campaigns.ts for segments). Change a shape here first, then on both sides.
import { getToken, req } from "../api";
import { del, j, put } from "./core";
import type { Offer, ProspectRow, Segment, SegmentInput } from "./campaigns";

export type SizeBand = "1-10" | "11-50" | "51-200" | "201-500" | "500+";
export type SkipRule = "country" | "city" | "industry" | "size" | "keyword" | "language";
export type CampaignKind = "customer" | "partner";

/** The boundaries every segment of a campaign stays inside (campaigns.targeting_json). */
export interface TargetMarket {
  countries: string[];
  /** country -> allowed cities; missing / [] = the whole country */
  cities: Record<string, string[]>;
  excludeCities: string[];
  sizeBands: SizeBand[];
  minBranches: number | null;
  /** prefer = outside the band lowers the fit score; strict = skipped */
  sizeMode: "prefer" | "strict";
  sizeUnknown: "allow" | "skip";
  /** taxonomy ids */
  excludeIndustries: string[];
  mustKeywords: string[];
  mustNotKeywords: string[];
  mustMode: "prefer" | "strict";
  language: "any" | "ar" | "en";
  /** ranked, best first */
  titles: string[];
  excludeTitles: string[];
  seniority: "any" | "manager";
  roleAddresses: "inherit" | "allow" | "never";
  /** null = the agent's sending rule */
  minFitScore: number | null;
}

export interface Industry {
  id: string;
  label: string;
  kind: "customer" | "partner" | "exclude";
  example: string | null;
}

export interface TaxCountry {
  name: string;
  ar: string;
  gulf: boolean;
  cities: { name: string; ar: string }[];
}

export interface Taxonomy {
  industries: Industry[];
  countries: TaxCountry[];
  gulf: string[];
  sizeBands: SizeBand[];
  titlePresets: Record<CampaignKind, string[]>;
  excludedTitles: string[];
  excludedIndustries: Record<CampaignKind, string[]>;
  skipRules: Record<SkipRule, string>;
  defaults: Record<CampaignKind, TargetMarket>;
}

export interface MarketView {
  campaignId: string;
  kind: CampaignKind;
  market: TargetMarket;
  defaults: TargetMarket;
  /** Set when the market mixes time zones / work weeks (Instantly has one schedule per campaign). */
  scheduleNote: string | null;
  agent: { allowRoleAddresses: boolean; minFitScore: number };
  /** Leads skipped by a targeting rule so far. */
  skipped: Partial<Record<SkipRule, number>>;
  /** After a save: segments whose automatic searches changed. */
  regenerated?: number;
}

export interface RecheckResult {
  checked: number;
  wouldSkip: number;
  wouldRestore: number;
  byRule: Partial<Record<SkipRule, number>>;
  samples: { prospectId: string; company: string; domain: string; action: "skip" | "restore"; reason: string }[];
  applied: boolean;
}

export interface QueryPreview {
  queries: string[];
  /** (query, country) steps discovery will walk */
  searches: number;
  countries: string[];
  cities: Record<string, string[]>;
}

export interface PreviewCompany {
  name: string | null;
  domain: string | null;
  website: string;
  city: string | null;
  country: string | null;
  ok: boolean;
  already: boolean;
  reason: string | null;
  rule: SkipRule | null;
}

export interface SegmentPreview {
  searches: { query: string; country: string; results: number; via: "gemini" | "search"; error?: string }[];
  companies: PreviewCompany[];
  passed: number;
  total: number;
  planSize: number;
  notes: string[];
  checkedLater: string;
}

export interface Exclusion {
  id: string;
  kind: "domain" | "email";
  value: string;
  reason: string | null;
  source: string;
  createdAt: string;
}

export interface ExclusionList {
  items: Exclusion[];
  total: number;
  auto: { unsubscribed: number; bounced: number; complaints: number; inbox: number; oldConsole: number };
  autoRecent: { value: string; reason: string; at: string }[];
}

/* ------------------------- results (Phase 9, §8.4.5) ------------------------- */

/** The learning loop's view of a segment. Exhausted is a flag on the segment, not a status. */
export type LoopStatus = "testing" | "working" | "scaling" | "paused";

/** backend/src/v2/targeting/learning.ts SegmentRules — one set for every campaign. */
export interface SegmentRules {
  /** Testing until this many leads were emailed. */
  testUntil: number;
  /** Scaling at this positive-reply rate (%)… */
  scalePositiveRate: number;
  /** …or this reply rate (%). */
  scaleReplyRate: number;
  /** Paused with no hot lead after this many emailed. */
  pauseAfter: number;
  /** Paused when bounces go above this (%). */
  pauseBounceRate: number;
  /** suggest = changes wait for Apply; auto = the loop applies them. */
  mode: "suggest" | "auto";
  /** Share of each day's new leads by status; sums to 100. */
  quota: { scaling: number; working: number; testing: number };
}

export interface SegmentStats {
  found: number;
  researched: number;
  /** skipped by a targeting rule */
  offTarget: number;
  inTargetPct: number | null;
  contacted: number;
  replies: number;
  positive: number;
  bounced: number;
  replyRate: number | null;
  positiveRate: number | null;
  bounceRate: number | null;
  foundToday: number;
}

export interface LoopSuggestion {
  status: LoopStatus;
  /** the rule that fired, with the numbers behind it */
  reason: string;
  at?: string;
}

export interface ResultSegment extends Segment {
  campaignName: string;
  campaignKind: CampaignKind;
  loopStatus: LoopStatus;
  /** why it has its current status (set by hand, or by the loop) */
  statusReason: string | null;
  suggestion: LoopSuggestion | null;
  /** what the rules say right now, in words */
  verdict: string;
  stats: SegmentStats & {
    /** % of the campaign's daily new leads this segment gets (0 when off) */
    quotaShare: number;
    searchesLeft: number;
  };
}

export interface OfferCard {
  campaignId: string;
  campaignName: string;
  kind: CampaignKind;
  website: string | null;
  offer: Offer | null;
}

export interface TargetingResults {
  rules: SegmentRules;
  offers: OfferCard[];
  segments: ResultSegment[];
}

export interface SearchLogEntry {
  id: string;
  query: string;
  country: string | null;
  via: "gemini" | "search";
  ranAt: string;
  results: number;
  added: number;
  /** rule = a SkipRule, or duplicate | excluded | junk */
  rejected: { rule: string; label: string; count: number }[];
  examples: { domain: string | null; reason: string }[];
}

export interface SegmentDetail {
  segment: Segment & { loopStatus: LoopStatus; statusReason: string | null; suggestion: LoopSuggestion | null };
  campaign: { id: string; name: string; kind: CampaignKind };
  stats: SegmentStats;
  verdict: string;
  /** newest first, last 100 */
  searches: SearchLogEntry[];
  /** newest first, last 100 */
  companies: ProspectRow[];
}

/* ---------------------------- steer by chat (§8.4.7) ---------------------------- */

export type SteerOp = "add" | "remove" | "set";
export type SteerChange =
  | { id: string; kind: "market"; field: string; op: SteerOp; value: unknown; label: string }
  | { id: string; kind: "segment"; segmentId: string; segmentName: string; field: string; op: SteerOp; value: unknown; label: string }
  | { id: string; kind: "exclusion"; value: string[]; label: string }
  | { id: string; kind: "new_segment"; value: { name: string; industryIds: string[]; why: string }; label: string };

export interface SteerProposal {
  summary: string;
  /** already validated: unknown fields, industries and segments are dropped */
  changes: SteerChange[];
}

export interface SteerApplied {
  applied: number;
  notes: string[];
  /** dry run of the leads already found, against the new targeting */
  recheck: RecheckResult;
}

const C = (id: string) => `/api/v2/campaigns/${id}`;
const T = "/api/v2/targeting";

export const targetingApi = {
  taxonomy: () => req<Taxonomy>(`${T}/taxonomy`),
  market: (id: string) => req<MarketView>(`${C(id)}/targeting`),
  /** Saves and regenerates the automatic searches of every segment. */
  saveMarket: (id: string, market: TargetMarket) => req<MarketView>(`${C(id)}/targeting`, put({ market })),
  /** Dry run unless apply. `market` = test an unsaved draft. */
  recheck: (id: string, body: { market?: Partial<TargetMarket>; apply: boolean }) => req<RecheckResult>(`${C(id)}/targeting/recheck`, j(body)),
  /** The searches a draft segment would run (nothing saved). */
  queries: (id: string, segment: SegmentInput) => req<QueryPreview>(`${C(id)}/targeting/queries`, j({ segment })),
  regenerate: (id: string, sid: string) => req<{ segment: Segment }>(`${C(id)}/segments/${sid}/queries/regenerate`, j({})),
  /** 1-2 live searches, screened. Nothing saved, no searches used up. */
  preview: (id: string, sid: string) => req<SegmentPreview>(`${C(id)}/segments/${sid}/preview`, j({})),

  /** Offers + every segment with numbers and loop status. No campaign = every campaign that isn't archived. */
  results: (campaign?: string) => req<TargetingResults>(`${T}${campaign ? `?campaign=${encodeURIComponent(campaign)}` : ""}`),
  rules: () => req<SegmentRules>(`${T}/rules`),
  /** Merged onto the current rules and sanitized (quota re-balanced to 100). */
  saveRules: (rules: Partial<SegmentRules>) => req<SegmentRules>(`${T}/rules`, put(rules)),
  applySuggestions: (ids: string[], dismiss = false) => req<{ applied: number; dismissed: number }>(`${T}/suggestions/apply`, j({ ids, dismiss })),
  segment: (sid: string) => req<SegmentDetail>(`${T}/segments/${sid}`),
  /** Same campaign = "(copy)". Searches start from the beginning. */
  duplicate: (sid: string, campaignId: string) => req<{ segment: Segment; campaignId: string }>(`${T}/segments/${sid}/duplicate`, j({ campaignId })),
  setStatus: (sid: string, status: LoopStatus, reason?: string) => req<{ ok: true }>(`${T}/segments/${sid}/status`, j({ status, reason })),
  steer: (campaignId: string, message: string) => req<SteerProposal>(`${T}/steer`, j({ campaignId, message })),
  applySteer: (campaignId: string, changes: SteerChange[]) => req<SteerApplied>(`${T}/steer/apply`, j({ campaignId, changes })),

  exclusions: (params: { q?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    return req<ExclusionList>(`${T}/exclusions${qs.toString() ? `?${qs}` : ""}`);
  },
  addExclusions: (body: { entries: string; reason?: string }) => req<{ added: number; skipped: { value: string; reason: string }[] }>(`${T}/exclusions`, j(body)),
  removeExclusion: (eid: string) => req<{ ok: true }>(`${T}/exclusions/${eid}`, del),
  /** Downloads do-not-contact.csv (needs the auth header, so not a plain link). */
  exportExclusions: async () => {
    const base = (import.meta as any).env?.VITE_API_URL || "";
    const res = await fetch(`${base}${T}/exclusions/export`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error(`Export failed (HTTP ${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = "do-not-contact.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

export const SIZE_LABEL: Record<SizeBand, string> = {
  "1-10": "1-10",
  "11-50": "11-50",
  "51-200": "51-200",
  "201-500": "201-500",
  "500+": "500+",
};

export const LOOP_LABEL: Record<LoopStatus, string> = { scaling: "Scaling", working: "Working", testing: "Testing", paused: "Paused" };
/** fg + bg, like every status chip in the console */
export const LOOP_TONE: Record<LoopStatus, string> = {
  scaling: "bg-okb text-good",
  working: "bg-tlb text-accent",
  testing: "bg-ink/[0.06] text-ink-soft",
  paused: "bg-wnb text-warn",
};

export function sizeSummary(bands: SizeBand[], minBranches: number | null): string {
  const all = bands.length === 0 || bands.length === 5;
  const b = all ? "Any size" : `${bands.join(", ")} staff`;
  return minBranches ? `${b} · ${minBranches}+ branches` : b;
}
