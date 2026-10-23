// Leads API (Phase 6, plan §8.3) — every person the agent found, across campaigns.
// BINDING CONTRACT with backend/src/v2/leads/**.
import { API_BASE, getToken, req } from "../api";
import { j, put, type AgentEvent } from "./core";
import type { ProspectDetail, ProspectRow, ProspectStage } from "./campaigns";

export type LeadView = "people" | "companies" | "pipeline";

/** Every filter the list accepts. "__none__" = the value is empty (no country, not checked…). */
export interface LeadFilters {
  campaign?: string;
  segment?: string;
  /** a built-in view id (review, ready, progress, sequence, replied, hot, bounced, skipped) or one stage */
  stage?: string;
  /** a targeting rule, or "__other__" = skipped for fit / policy / no contact / by hand */
  skipRule?: string;
  country?: string;
  industry?: string;
  fitMin?: number;
  fitMax?: number;
  emailStatus?: string;
  source?: string;
  replied?: "yes" | "no";
  interest?: string;
  mailbox?: string;
  foundFrom?: string; // YYYY-MM-DD
  foundTo?: string;
  sentFrom?: string;
  sentTo?: string;
  q?: string;
}
export type FilterKey = keyof LeadFilters;

export interface NextStep {
  step: number | null;
  at: string | null;
  label: string; // "Follow-up 2 on 28 Oct"
}

export interface AlsoIn {
  campaignId: string;
  campaignName: string;
  stage: string;
}

export interface LeadRow extends ProspectRow {
  nextStep: NextStep | null;
  alsoIn: AlsoIn[];
  notes: string | null;
}

export interface CompanyRow {
  id: string;
  domain: string | null;
  name: string | null;
  country: string | null;
  city: string | null;
  industry: string | null;
  size: string | null;
  researchStatus: string | null;
  researchedAt: string | null;
  description: string | null;
  people: number;
  campaigns: { id: string; name: string }[];
  furthestStage: ProspectStage;
  bestFit: number | null;
  lastActivity: string | null;
}

export interface FacetValue {
  value: string;
  label: string;
  count: number;
}
export type Facets = Partial<Record<"campaign" | "stage" | "segment" | "country" | "industry" | "emailStatus" | "source" | "skipRule" | "interest" | "mailbox", FacetValue[]>>;

export type LeadList =
  | { view: "people"; rows: LeadRow[]; total: number; facets: Facets | null }
  | { view: "companies"; rows: CompanyRow[]; total: number; facets: Facets | null };

export interface ThreadMessage {
  id: string;
  direction: "in" | "out";
  from: string | null;
  subject: string | null;
  body: string;
  sentAt: string | null;
  autoReply: boolean;
  classification: string | null;
  sentBy: string | null;
  step: string | null;
}

export interface LeadThread {
  id: string;
  subject: string | null;
  status: string;
  classification: string | null;
  unread: boolean;
  lastMessageAt: string | null;
  messages: ThreadMessage[];
}

export interface LeadDetail extends ProspectDetail {
  notes: string | null;
  nextStep: NextStep | null;
  alsoIn: AlsoIn[];
  campaign: { id: string; name: string; status: string };
  thread: LeadThread | null;
  ai: boolean;
  events: AgentEvent[];
}

export interface CompanyDetail {
  id: string;
  domain: string | null;
  name: string | null;
  website: string | null;
  country: string | null;
  city: string | null;
  industry: string | null;
  size: string | null;
  description: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  hooks: string[];
  peopleOnSite: { name: string; title: string }[];
  researchStatus: string | null;
  researchedAt: string | null;
  people: LeadRow[];
}

export type BulkAction = "approve" | "skip" | "restore" | "reresearch" | "reverify" | "move" | "dnc_domain" | "dnc_email";
export interface BulkResult {
  action: BulkAction;
  selected: number;
  done: number;
  skipped: number;
  notes: string[];
}

export type PipelineStage = "replied" | "interested" | "meeting" | "won" | "lost";
export const PIPELINE_COLUMNS: { id: PipelineStage; label: string; hint: string }[] = [
  { id: "replied", label: "Replied", hint: "A human answer, not sorted yet" },
  { id: "interested", label: "Interested", hint: "Wants to hear more" },
  { id: "meeting", label: "Meeting", hint: "Call or demo booked" },
  { id: "won", label: "Won", hint: "Became a customer or partner" },
  { id: "lost", label: "Lost", hint: "Said no" },
];

export interface SavedView {
  id: string;
  name: string;
  view: LeadView;
  filters: Record<string, string>;
}
export interface BuiltInView {
  id: string;
  label: string;
  stages: string[];
}

export type ImportField = "email" | "firstName" | "lastName" | "fullName" | "title" | "company" | "website" | "country" | "city" | "linkedin";
export const IMPORT_FIELD_LABEL: Record<ImportField, string> = {
  email: "Email",
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name",
  title: "Job title",
  company: "Company",
  website: "Website",
  country: "Country",
  city: "City",
  linkedin: "LinkedIn",
};
export interface ImportPreview {
  headers: string[];
  sample: string[][];
  total: number;
  mapping: Partial<Record<ImportField, number>>;
  max: number;
  fields: ImportField[];
}
export interface ImportJob {
  id: string;
  campaignId: string;
  segmentId: string | null;
  fileName: string | null;
  enterAt: "research" | "verify";
  status: "running" | "done" | "failed";
  total: number;
  processed: number;
  imported: number;
  duplicate: number;
  suppressed: number;
  invalid: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  sample: { row: number; email: string; company: string; outcome: string; reason: string }[];
}

/* -------------------------------- client ------------------------------ */

const B = "/api/v2/leads";

export function leadQuery(f: object): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : "";
}

async function download(path: string, name: string) {
  const r = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `Download failed (${r.status})`);
  }
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export const leadsApi = {
  list: (f: LeadFilters & { view?: "people" | "companies"; sort?: string; dir?: "asc" | "desc"; limit?: number; offset?: number; facets?: "0" | "1" }) => req<LeadList>(`${B}${leadQuery(f)}`),
  counts: () => req<{ review: number; ready: number; hot: number }>(`${B}/counts`),
  get: (pid: string) => req<{ lead: LeadDetail }>(`${B}/${pid}`),
  company: (coid: string) => req<CompanyDetail>(`${B}/companies/${coid}`),
  bulk: (body: { action: BulkAction; ids?: string[]; filter?: LeadFilters; reason?: string; campaignId?: string; segmentId?: string }) => req<BulkResult>(`${B}/bulk`, j(body)),
  setStage: (pid: string, stage: PipelineStage, note?: string) => req<{ ok: true; instantly: "updated" | "skipped" | "failed" | "unchanged" }>(`${B}/${pid}/stage`, put({ stage, note })),
  setNotes: (pid: string, notes: string) => req<{ ok: true }>(`${B}/${pid}/notes`, put({ notes })),
  views: () => req<{ views: SavedView[]; builtIn: BuiltInView[] }>(`${B}/views`),
  saveViews: (views: SavedView[]) => req<{ views: SavedView[]; builtIn: BuiltInView[] }>(`${B}/views`, put({ views })),
  exportCsv: (f: LeadFilters & { ids?: string; sort?: string; dir?: string }) => download(`${B}/export${leadQuery(f)}`, `leads-${new Date().toISOString().slice(0, 10)}.csv`),
  importPreview: (csv: string) => req<ImportPreview>(`${B}/import/preview`, j({ csv })),
  importStart: (body: { csv: string; mapping: Partial<Record<ImportField, number>>; campaignId: string; segmentId?: string; enterAt: "research" | "verify"; fileName?: string }) => req<{ import: ImportJob }>(`${B}/import`, j(body)),
  importGet: (id: string) => req<{ import: ImportJob }>(`${B}/import/${id}`),
  importResults: (id: string) => download(`${B}/import/${id}/results`, `import-results-${id.slice(0, 8)}.csv`),
};
