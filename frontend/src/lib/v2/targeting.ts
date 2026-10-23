// Targeting API (Phase 5, plan §8.4). BINDING CONTRACT: backend/src/v2/targeting/**
// returns exactly these shapes; the Targeting screens consume only this file
// (+ campaigns.ts for segments). Change a shape here first, then on both sides.
import { getToken, req } from "../api";
import { del, j, put } from "./core";
import type { Segment, SegmentInput } from "./campaigns";

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

export function sizeSummary(bands: SizeBand[], minBranches: number | null): string {
  const all = bands.length === 0 || bands.length === 5;
  const b = all ? "Any size" : `${bands.join(", ")} staff`;
  return minBranches ? `${b} · ${minBranches}+ branches` : b;
}
