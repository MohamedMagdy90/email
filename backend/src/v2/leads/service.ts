// Leads (Phase 6, plan §8.3) — every person the agent found, across campaigns.
// Read-mostly: lists, facets, the detail with its email thread, saved views,
// CSV in and out. Every WRITE to a lead goes through the campaign service, so
// the stage rules live in one place.
import { getSetting, nowIso, q, setSetting } from "../../db";
import { htmlToText, logEvent, parseJson, uid } from "../events";
import { aiStatus } from "../llm";
import { normalizeCountry } from "../../country";
import { cleanEmail, isValidEmail } from "../../crawler/validate";
import { isFreeMailDomain, splitName } from "../verify";
import { CampaignError, DEFAULT_SETTINGS, PROSPECT_SELECT, STAGES, prospectRowView, sanitizeSettings, type ProspectEmails, type Row } from "../campaigns/types";
import { domainBlockReason, domainOf, suppressionReason } from "../campaigns/suppression";
import * as cs from "../campaigns/service";
import { addExclusions } from "../targeting/service";
import { INDUSTRY_BY_ID } from "../targeting/taxonomy";
import { SKIP_RULE_LABEL, type SkipRule } from "../targeting/check";
import { guessMapping, IMPORT_FIELDS, parseCsv, toCsv, type ImportField } from "./csv";

/* -------------------------------- views -------------------------------- */

/** Built-in views: a name and the stages it shows. */
export const LEAD_VIEWS: Record<string, { label: string; stages: string[] }> = {
  all: { label: "All", stages: [] },
  review: { label: "To review", stages: ["written"] },
  ready: { label: "Ready to send", stages: ["approved"] },
  progress: { label: "In progress", stages: ["found", "researched", "contact_found", "verified"] },
  sequence: { label: "In sequence", stages: ["queued", "sent"] },
  replied: { label: "Replied", stages: ["replied", "interested", "meeting", "won", "lost"] },
  hot: { label: "Hot", stages: ["interested", "meeting", "won"] },
  bounced: { label: "Bounced or unsubscribed", stages: ["bounced", "unsubscribed"] },
  skipped: { label: "Skipped", stages: ["skipped", "failed"] },
};

/** Pipeline order, for "furthest stage" and sorting. Exits rank by how far the lead got first. */
const STAGE_RANK: Record<string, number> = {
  skipped: 1, failed: 1, found: 2, researched: 3, contact_found: 4, verified: 5, written: 6, approved: 7, queued: 8,
  bounced: 9, sent: 10, unsubscribed: 11, replied: 12, lost: 13, interested: 14, meeting: 15, won: 16,
};
const RANK_CASE = `CASE p.stage ${Object.entries(STAGE_RANK).map(([s, n]) => `WHEN '${s}' THEN ${n}`).join(" ")} ELSE 0 END`;
const rankToStage = (n: number) => Object.entries(STAGE_RANK).find(([, v]) => v === n)?.[0] || "found";

/* ------------------------------- filters ------------------------------- */

export interface LeadFilters {
  campaign?: string;
  segment?: string;
  stage?: string;
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
  foundFrom?: string;
  foundTo?: string;
  sentFrom?: string;
  sentTo?: string;
  q?: string;
}
type FilterKey = keyof LeadFilters;
const FILTER_KEYS: FilterKey[] = ["campaign", "segment", "stage", "skipRule", "country", "industry", "fitMin", "fitMax", "emailStatus", "source", "replied", "interest", "mailbox", "foundFrom", "foundTo", "sentFrom", "sentTo", "q"];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00.000Z`) + 86400000).toISOString();

export function filtersFrom(src: Record<string, any> = {}): LeadFilters {
  const f: LeadFilters = {};
  const s = (k: string, max = 200) => {
    const v = src[k];
    return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
  };
  for (const k of ["campaign", "segment", "stage", "skipRule", "country", "industry", "emailStatus", "source", "interest", "mailbox"] as const) {
    const v = s(k);
    if (v) f[k] = v;
  }
  const fitMin = Number(src.fitMin);
  const fitMax = Number(src.fitMax);
  if (src.fitMin !== undefined && src.fitMin !== "" && Number.isFinite(fitMin)) f.fitMin = Math.max(0, Math.min(100, Math.round(fitMin)));
  if (src.fitMax !== undefined && src.fitMax !== "" && Number.isFinite(fitMax)) f.fitMax = Math.max(0, Math.min(100, Math.round(fitMax)));
  if (src.replied === "yes" || src.replied === "no") f.replied = src.replied;
  for (const k of ["foundFrom", "foundTo", "sentFrom", "sentTo"] as const) {
    const v = s(k, 10);
    if (v && DAY.test(v)) f[k] = v;
  }
  const search = s("q", 120);
  if (search) f.q = search;
  return f;
}

const FROM = `FROM prospects p
  LEFT JOIN companies co ON co.id = p.company_id
  LEFT JOIN campaigns cp ON cp.id = p.campaign_id
  LEFT JOIN segments s ON s.id = p.segment_id`;

function buildWhere(f: LeadFilters, omit?: FilterKey): { sql: string; params: any[] } {
  const w: string[] = [];
  const params: any[] = [];
  const on = (k: FilterKey) => f[k] !== undefined && k !== omit;
  const eqOrNull = (col: string, v: string) => {
    if (v === "__none__") w.push(`${col} IS NULL`);
    else {
      w.push(`${col} = ?`);
      params.push(v);
    }
  };
  if (on("campaign")) {
    w.push("p.campaign_id = ?");
    params.push(f.campaign);
  } else w.push("(cp.status IS NULL OR cp.status <> 'archived')");
  if (on("segment")) eqOrNull("p.segment_id", f.segment!);
  if (on("stage")) {
    const view = LEAD_VIEWS[f.stage!];
    if (view && view.stages.length) {
      w.push(`p.stage IN (${view.stages.map(() => "?").join(",")})`);
      params.push(...view.stages);
    } else if ((STAGES as string[]).includes(f.stage!)) {
      w.push("p.stage = ?");
      params.push(f.stage);
    }
  }
  if (on("skipRule")) {
    if (f.skipRule === "__other__") w.push("p.stage = 'skipped' AND p.skip_rule IS NULL");
    else {
      w.push("p.skip_rule = ?");
      params.push(f.skipRule);
    }
  }
  if (on("country")) eqOrNull("co.country", f.country!);
  if (on("industry")) eqOrNull("co.industry_id", f.industry!);
  if (on("fitMin")) {
    w.push("p.fit_score >= ?");
    params.push(f.fitMin);
  }
  if (on("fitMax")) {
    w.push("p.fit_score <= ?");
    params.push(f.fitMax);
  }
  if (on("emailStatus")) eqOrNull("p.email_status", f.emailStatus!);
  if (on("source")) eqOrNull("COALESCE(p.lead_source, co.source)", f.source!);
  if (on("replied")) w.push(f.replied === "yes" ? "p.replied_at IS NOT NULL" : "p.replied_at IS NULL");
  if (on("interest")) eqOrNull("p.interest", f.interest!);
  if (on("mailbox")) eqOrNull("p.mailbox_email", f.mailbox!);
  if (on("foundFrom")) {
    w.push("p.created_at >= ?");
    params.push(`${f.foundFrom}T00:00:00.000Z`);
  }
  if (on("foundTo")) {
    w.push("p.created_at < ?");
    params.push(nextDay(f.foundTo!));
  }
  if (on("sentFrom")) {
    w.push("p.sent_at >= ?");
    params.push(`${f.sentFrom}T00:00:00.000Z`);
  }
  if (on("sentTo")) {
    w.push("p.sent_at < ?");
    params.push(nextDay(f.sentTo!));
  }
  if (on("q")) {
    const like = `%${f.q!.toLowerCase().replace(/[%_]/g, "")}%`;
    w.push("(lower(COALESCE(co.name, '')) LIKE ? OR lower(COALESCE(co.domain, '')) LIKE ? OR lower(COALESCE(p.full_name, '')) LIKE ? OR lower(COALESCE(p.email, '')) LIKE ? OR lower(COALESCE(p.title, '')) LIKE ?)");
    params.push(like, like, like, like, like);
  }
  return { sql: w.join(" AND ") || "1 = 1", params };
}

const SORTS: Record<string, string> = {
  updated: "p.updated_at",
  found: "p.created_at",
  fit: "p.fit_score",
  company: "lower(COALESCE(co.name, co.domain, ''))",
  person: "lower(COALESCE(p.full_name, p.email, ''))",
  stage: RANK_CASE,
  sent: "p.sent_at",
};

function orderBy(sort?: string, dir?: string): string {
  const key = SORTS[String(sort || "")] ? String(sort) : "updated";
  const d = dir === "asc" ? "ASC" : dir === "desc" ? "DESC" : key === "company" || key === "person" ? "ASC" : "DESC";
  const col = SORTS[key];
  // NULLs last either way (portable: a boolean sorts false first in both engines).
  const nullable = ["fit", "sent"].includes(key);
  return `${nullable ? `(${col} IS NULL), ` : ""}${col} ${d}, p.id ${d}`;
}

/* ------------------------------ row extras ----------------------------- */

export interface NextStep {
  step: number | null;
  at: string | null;
  label: string;
}

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** Where the lead is in its sequence: "Follow-up 2 on 28 Oct". */
export function nextStepOf(r: Row): NextStep | null {
  if (!["queued", "sent"].includes(r.stage)) return null;
  const emails = parseJson<ProspectEmails | null>(r.email_json, null);
  const total = emails?.steps?.length || 0;
  if (r.stage === "queued") return { step: 1, at: null, label: "First email, at its next send slot" };
  const last = Math.max(1, Number(r.last_step) || 1);
  if (!total || last >= total) return { step: null, at: null, label: "Every step sent" };
  const base = Date.parse(String(r.last_step_at || r.sent_at || ""));
  if (!Number.isFinite(base)) return { step: last + 1, at: null, label: `Follow-up ${last} next` };
  const at = new Date(base + (Number(emails!.steps[last]?.delayDays) || 3) * 86400000).toISOString();
  return { step: last + 1, at, label: `Follow-up ${last} on ${fmtDay(at)}` };
}

async function alsoInFor(rows: Row[]): Promise<Map<string, { campaignId: string; campaignName: string; stage: string }[]>> {
  const ids = [...new Set(rows.map((r) => r.company_id).filter(Boolean).map(String))];
  const out = new Map<string, { campaignId: string; campaignName: string; stage: string }[]>();
  if (!ids.length) return out;
  const all: Row[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    all.push(...(await q(`SELECT p.company_id, p.campaign_id, p.stage, cp.name AS campaign_name FROM prospects p LEFT JOIN campaigns cp ON cp.id = p.campaign_id WHERE p.company_id IN (${part.map(() => "?").join(",")})`, part)));
  }
  for (const r of rows) {
    const seen = new Set<string>();
    const list = all
      .filter((x) => x.company_id === r.company_id && x.campaign_id !== r.campaign_id)
      .filter((x) => !seen.has(x.campaign_id) && seen.add(x.campaign_id))
      .map((x) => ({ campaignId: String(x.campaign_id), campaignName: String(x.campaign_name || "Another campaign"), stage: String(x.stage) }));
    out.set(String(r.id), list);
  }
  return out;
}

export async function leadRows(rows: Row[]) {
  const also = await alsoInFor(rows);
  return rows.map((r) => ({ ...prospectRowView(r), nextStep: nextStepOf(r), alsoIn: also.get(String(r.id)) || [], notes: r.notes ? String(r.notes) : null }));
}

/* -------------------------------- facets ------------------------------- */

export interface FacetValue {
  value: string;
  label: string;
  count: number;
}

const FACETS: { key: string; omit: FilterKey; expr: string; extra?: string }[] = [
  { key: "campaign", omit: "campaign", expr: "p.campaign_id" },
  { key: "stage", omit: "stage", expr: "p.stage" },
  { key: "segment", omit: "segment", expr: "p.segment_id" },
  { key: "country", omit: "country", expr: "co.country" },
  { key: "industry", omit: "industry", expr: "co.industry_id" },
  { key: "emailStatus", omit: "emailStatus", expr: "p.email_status" },
  { key: "source", omit: "source", expr: "COALESCE(p.lead_source, co.source)" },
  { key: "skipRule", omit: "skipRule", expr: "p.skip_rule", extra: "p.stage = 'skipped'" },
  { key: "interest", omit: "interest", expr: "p.interest" },
  { key: "mailbox", omit: "mailbox", expr: "p.mailbox_email" },
];

const SOURCE_LABEL: Record<string, string> = { gemini: "Gemini search", search: "Web search", manual: "Added by hand", import: "Imported" };
const STATUS_LABEL: Record<string, string> = { valid: "Valid", catch_all: "Catch-all", unknown: "Unverified", risky: "Risky", invalid: "Invalid" };

async function facets(f: LeadFilters): Promise<Record<string, FacetValue[]>> {
  const out: Record<string, FacetValue[]> = {};
  const names = new Map<string, string>();
  for (const c of await q(`SELECT id, name, status FROM campaigns`)) names.set(`c:${c.id}`, `${c.name}${c.status === "archived" ? " (archived)" : ""}`);
  for (const s of await q(`SELECT id, name FROM segments`)) names.set(`s:${s.id}`, String(s.name));
  for (const fc of FACETS) {
    if (fc.key === "segment" && !f.campaign) continue;
    const w = buildWhere(f, fc.omit);
    const rows = await q(`SELECT ${fc.expr} AS v, CAST(count(*) AS INTEGER) AS n ${FROM} WHERE ${w.sql}${fc.extra ? ` AND ${fc.extra}` : ""} GROUP BY ${fc.expr} ORDER BY n DESC LIMIT 40`, w.params);
    out[fc.key] = rows.map((r) => {
      const v = r.v === null || r.v === undefined || r.v === "" ? null : String(r.v);
      let label = v || "";
      if (fc.key === "campaign") label = (v && names.get(`c:${v}`)) || "Unknown campaign";
      else if (fc.key === "segment") label = v ? names.get(`s:${v}`) || "Deleted segment" : "No segment";
      else if (fc.key === "industry") label = v ? INDUSTRY_BY_ID.get(v)?.label || v : "Not classified";
      else if (fc.key === "country") label = v || "Country unknown";
      else if (fc.key === "emailStatus") label = v ? STATUS_LABEL[v] || v : "Not checked";
      else if (fc.key === "source") label = v ? SOURCE_LABEL[v] || v : "Unknown";
      else if (fc.key === "skipRule") label = v ? SKIP_RULE_LABEL[v as SkipRule] || v : "Fit, policy, no contact or by hand";
      else if (fc.key === "interest") label = v ? v.replace(/_/g, " ") : "None";
      else if (fc.key === "mailbox") label = v || "No mailbox yet";
      return { value: v === null ? (fc.key === "skipRule" ? "__other__" : "__none__") : v, label, count: Number(r.n) || 0 };
    });
  }
  return out;
}

/* --------------------------------- list -------------------------------- */

export async function listLeads(params: Record<string, any>) {
  const f = filtersFrom(params);
  const limit = Math.max(1, Math.min(200, Number(params.limit) || 50));
  const offset = Math.max(0, Number(params.offset) || 0);
  const withFacets = params.facets !== "0";
  if (params.view === "companies") return listCompanies(f, params, limit, offset, withFacets);
  const w = buildWhere(f);
  const rows = await q(`${PROSPECT_SELECT} WHERE ${w.sql} ORDER BY ${orderBy(params.sort, params.dir)} LIMIT ${limit} OFFSET ${offset}`, w.params);
  const total = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n ${FROM} WHERE ${w.sql}`, w.params))[0]?.n) || 0;
  return { view: "people" as const, rows: await leadRows(rows), total, facets: withFacets ? await facets(f) : null };
}

async function listCompanies(f: LeadFilters, params: Record<string, any>, limit: number, offset: number, withFacets: boolean) {
  const w = buildWhere(f);
  const cols = "co.id, co.domain, co.name, co.country, co.city, co.industry, co.industry_id, co.size_band, co.size_hint, co.research_status, co.researched_at, co.description";
  const sort = params.sort === "company" ? "lower(COALESCE(co.name, co.domain, '')) ASC" : params.sort === "people" ? "people DESC, last_activity DESC" : params.sort === "stage" ? "furthest DESC, last_activity DESC" : "last_activity DESC";
  const rows = await q(
    `SELECT ${cols}, CAST(count(p.id) AS INTEGER) AS people, CAST(count(DISTINCT p.campaign_id) AS INTEGER) AS campaign_count,
            MAX(p.updated_at) AS last_activity, MAX(${RANK_CASE}) AS furthest, MAX(p.fit_score) AS best_fit
       ${FROM} WHERE ${w.sql} AND p.company_id IS NOT NULL
      GROUP BY ${cols} ORDER BY ${sort} LIMIT ${limit} OFFSET ${offset}`,
    w.params
  );
  const total = Number((await q(`SELECT CAST(count(DISTINCT p.company_id) AS INTEGER) AS n ${FROM} WHERE ${w.sql} AND p.company_id IS NOT NULL`, w.params))[0]?.n) || 0;
  const ids = rows.map((r) => String(r.id));
  const camp = ids.length
    ? await q(`SELECT DISTINCT p.company_id, p.campaign_id, cp.name AS campaign_name FROM prospects p LEFT JOIN campaigns cp ON cp.id = p.campaign_id WHERE p.company_id IN (${ids.map(() => "?").join(",")})`, ids)
    : [];
  return {
    view: "companies" as const,
    rows: rows.map((r) => ({
      id: String(r.id),
      domain: r.domain ? String(r.domain) : null,
      name: r.name ? String(r.name) : r.domain ? String(r.domain) : null,
      country: r.country || null,
      city: r.city || null,
      industry: r.industry_id ? INDUSTRY_BY_ID.get(r.industry_id)?.label || r.industry || null : r.industry || null,
      size: r.size_band || r.size_hint || null,
      researchStatus: r.research_status || null,
      researchedAt: r.researched_at || null,
      description: r.description ? String(r.description).slice(0, 300) : null,
      people: Number(r.people) || 0,
      campaigns: camp.filter((x) => x.company_id === r.id).map((x) => ({ id: String(x.campaign_id), name: String(x.campaign_name || "Campaign") })),
      furthestStage: rankToStage(Number(r.furthest) || 0),
      bestFit: r.best_fit == null ? null : Number(r.best_fit),
      lastActivity: r.last_activity || null,
    })),
    total,
    facets: withFacets ? await facets(f) : null,
  };
}

/* -------------------------------- detail ------------------------------- */

async function threadFor(p: Row) {
  let t = (await q(`SELECT * FROM threads WHERE prospect_id = ? ORDER BY last_message_at DESC LIMIT 1`, [p.id]))[0];
  if (!t && p.email) t = (await q(`SELECT * FROM threads WHERE lower(lead_email) = ? ORDER BY last_message_at DESC LIMIT 1`, [String(p.email).toLowerCase()]))[0];
  if (!t) return null;
  const msgs = await q(
    `SELECT id, direction, from_email, to_email, subject, body_text, body_html, sent_at, created_at, is_auto_reply, classification, ai_status, sent_by, step
       FROM messages WHERE thread_id = ? ORDER BY sent_at ASC, created_at ASC LIMIT 80`,
    [t.id]
  );
  return {
    id: String(t.id),
    subject: t.subject || null,
    status: String(t.status || "open"),
    classification: t.classification || null,
    unread: Number(t.unread) === 1,
    lastMessageAt: t.last_message_at || null,
    messages: msgs.map((m) => ({
      id: String(m.id),
      direction: (m.direction === "out" ? "out" : "in") as "in" | "out",
      from: m.from_email || null,
      subject: m.subject || null,
      body: String(m.body_text || htmlToText(m.body_html || "")).slice(0, 6000),
      sentAt: m.sent_at || m.created_at || null,
      autoReply: Number(m.is_auto_reply) === 1,
      classification: m.classification || null,
      sentBy: m.sent_by || null,
      step: m.step == null || m.step === "" ? null : String(m.step),
    })),
  };
}

export async function leadDetail(pid: string) {
  const base = (await q(`${PROSPECT_SELECT} WHERE p.id = ?`, [pid]))[0];
  if (!base) throw new CampaignError("Lead not found", 404);
  const d = await cs.prospectDetail(String(base.campaign_id), pid);
  const also = await alsoInFor([base]);
  return {
    ...d,
    notes: base.notes ? String(base.notes) : null,
    nextStep: nextStepOf(base),
    alsoIn: also.get(String(base.id)) || [],
    campaign: { id: String(base.campaign_id), name: String(base.campaign_name || "Campaign"), status: String(base.campaign_status || "draft") },
    thread: await threadFor(base),
    ai: (await aiStatus()).configured,
  };
}

export async function companyDetail(coid: string) {
  const co = (await q(`SELECT * FROM companies WHERE id = ?`, [coid]))[0];
  if (!co) throw new CampaignError("Company not found", 404);
  const rows = await q(`${PROSPECT_SELECT} WHERE p.company_id = ? ORDER BY p.updated_at DESC LIMIT 100`, [coid]);
  const rj = parseJson<any>(co.research_json, {}) || {};
  return {
    id: String(co.id),
    domain: co.domain || null,
    name: co.name || co.domain || null,
    website: co.website || (co.domain ? `https://${co.domain}` : null),
    country: co.country || null,
    city: co.city || null,
    industry: co.industry_id ? INDUSTRY_BY_ID.get(co.industry_id)?.label || co.industry || null : co.industry || null,
    size: co.size_band || co.size_hint || null,
    description: co.description || null,
    phone: co.phone || null,
    linkedinUrl: co.linkedin_url || null,
    hooks: Array.isArray(rj.hooks) ? rj.hooks.slice(0, 6).map(String) : [],
    peopleOnSite: Array.isArray(rj.people) ? rj.people.slice(0, 15).map((x: any) => ({ name: String(x?.name || ""), title: String(x?.title || "") })).filter((x: any) => x.name) : [],
    researchStatus: co.research_status || null,
    researchedAt: co.researched_at || null,
    people: await leadRows(rows),
  };
}

/* --------------------------------- bulk -------------------------------- */

export type BulkAction = "approve" | "skip" | "restore" | "reresearch" | "reverify" | "move" | "dnc_domain" | "dnc_email";
const BULK: BulkAction[] = ["approve", "skip", "restore", "reresearch", "reverify", "move", "dnc_domain", "dnc_email"];
const MAX_BULK = 5000;

async function selection(body: any): Promise<Row[]> {
  if (Array.isArray(body?.ids) && body.ids.length) {
    const ids = body.ids.map(String).slice(0, MAX_BULK);
    const out: Row[] = [];
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      out.push(...(await q(`SELECT p.id, p.campaign_id, p.email, p.stage, co.domain AS co_domain FROM prospects p LEFT JOIN companies co ON co.id = p.company_id WHERE p.id IN (${part.map(() => "?").join(",")})`, part)));
    }
    return out;
  }
  if (body?.filter && typeof body.filter === "object") {
    const w = buildWhere(filtersFrom(body.filter));
    return q(`SELECT p.id, p.campaign_id, p.email, p.stage, co.domain AS co_domain ${FROM} WHERE ${w.sql} ORDER BY p.created_at LIMIT ${MAX_BULK}`, w.params);
  }
  return [];
}

export async function bulk(body: any) {
  const action = String(body?.action || "") as BulkAction;
  if (!BULK.includes(action)) throw new CampaignError("Unknown action.");
  const rows = await selection(body);
  if (!rows.length) return { action, selected: 0, done: 0, skipped: 0, notes: ["Nothing selected."] };
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 200) : "";
  const notes: string[] = [];
  let done = 0;
  let skipped = 0;

  if (action === "dnc_domain" || action === "dnc_email") {
    const kind = action === "dnc_domain" ? "domain" : "email";
    const values = [...new Set(rows.map((r) => (kind === "domain" ? domainOf(r.co_domain || r.email) : r.email ? String(r.email).toLowerCase() : null)).filter(Boolean) as string[])];
    if (!values.length) return { action, selected: rows.length, done: 0, skipped: rows.length, notes: [kind === "email" ? "None of these leads has an address yet." : "None of these leads has a website."] };
    const r = await addExclusions({ entries: values, reason: reason || "Added from Leads", source: "manual" });
    const n = await cs.skipForExclusion(values.map((value) => ({ kind, value })), "On the do-not-contact list");
    done = r.added;
    skipped = values.length - r.added;
    notes.push(`${r.added} ${kind === "domain" ? "domain" : "address"}${r.added === 1 ? "" : "es"} added to do-not-contact${skipped ? ` (${skipped} already there)` : ""}; ${n} lead${n === 1 ? "" : "s"} not yet emailed were skipped.`);
    return { action, selected: rows.length, done, skipped, notes };
  }

  const byCampaign = new Map<string, string[]>();
  for (const r of rows) byCampaign.set(String(r.campaign_id), [...(byCampaign.get(String(r.campaign_id)) || []), String(r.id)]);
  if (action === "move") {
    const to = String(body?.campaignId || "");
    if (!to) throw new CampaignError("Pick the campaign to move them to.");
    const reasons = new Set<string>();
    for (const [cid, ids] of byCampaign) {
      const r = await cs.moveProspects(cid, ids, to, body?.segmentId ? String(body.segmentId) : null);
      done += r.done;
      skipped += r.skipped;
      for (const x of r.reasons) reasons.add(x);
    }
    if (reasons.size) notes.push(`Not moved: ${[...reasons].join("; ")}.`);
    return { action, selected: rows.length, done, skipped, notes };
  }
  for (const [cid, ids] of byCampaign) {
    if (action === "approve") {
      const r = await cs.approveProspects(cid, { ids });
      done += r.approved;
      skipped += ids.length - r.approved;
    } else if (action === "skip") {
      const r = await cs.skipProspects(cid, { ids, reason });
      done += r.skipped;
      skipped += ids.length - r.skipped;
    } else if (action === "restore") {
      const r = await cs.restoreProspects(cid, { ids });
      done += r.restored;
      skipped += ids.length - r.restored;
    } else if (action === "reresearch") {
      const r = await cs.reresearchProspects(cid, ids);
      done += r.done;
      skipped += r.skipped;
    } else if (action === "reverify") {
      const r = await cs.reverifyProspects(cid, ids);
      done += r.done;
      skipped += r.skipped;
    }
  }
  if (skipped) {
    const why: Record<string, string> = {
      approve: "only written emails can be approved",
      skip: "leads already emailed can't be skipped",
      restore: "only skipped or failed leads can be put back",
      reresearch: "leads already in Instantly keep their research",
      reverify: "leads already in Instantly, or without an address, weren't re-checked",
    };
    if (why[action]) notes.push(`${skipped} left as they were: ${why[action]}.`);
  }
  return { action, selected: rows.length, done, skipped, notes };
}

/* ---------------------------- stage + notes ---------------------------- */

export const setLeadStage = (pid: string, body: any) => cs.setStageByHand(pid, String(body?.stage || ""), typeof body?.note === "string" ? body.note : undefined);
export const setLeadNotes = (pid: string, body: any) => cs.setProspectNotes(pid, String(body?.notes ?? ""));

/* ------------------------------ saved views ---------------------------- */

const VIEWS_KEY = "lead_views";

export interface SavedView {
  id: string;
  name: string;
  view: "people" | "companies" | "pipeline";
  filters: Record<string, string>;
}

function sanitizeViews(raw: unknown): SavedView[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: SavedView[] = [];
  for (const v of list.slice(0, 30)) {
    if (!v || typeof v !== "object") continue;
    const name = String((v as any).name || "").trim().slice(0, 60);
    if (!name) continue;
    const filters: Record<string, string> = {};
    const src = (v as any).filters && typeof (v as any).filters === "object" ? (v as any).filters : {};
    for (const k of FILTER_KEYS) if (src[k] !== undefined && src[k] !== null && String(src[k]).trim() !== "") filters[k] = String(src[k]).slice(0, 200);
    const view = ["people", "companies", "pipeline"].includes((v as any).view) ? (v as any).view : "people";
    out.push({ id: typeof (v as any).id === "string" && (v as any).id ? String((v as any).id).slice(0, 60) : uid(), name, view, filters });
  }
  return out;
}

export async function getViews() {
  return { views: sanitizeViews(parseJson(await getSetting(VIEWS_KEY), [])), builtIn: Object.entries(LEAD_VIEWS).map(([id, v]) => ({ id, label: v.label, stages: v.stages })) };
}

export async function saveViews(body: any) {
  const views = sanitizeViews(body?.views);
  await setSetting(VIEWS_KEY, JSON.stringify(views));
  return getViews();
}

/* -------------------------------- counts ------------------------------- */

export async function leadCounts() {
  const n = async (stages: string[]) =>
    Number(
      (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM prospects p LEFT JOIN campaigns cp ON cp.id = p.campaign_id WHERE (cp.status IS NULL OR cp.status <> 'archived') AND p.stage IN (${stages.map(() => "?").join(",")})`, stages))[0]?.n
    ) || 0;
  return { review: await n(["written"]), ready: await n(["approved"]), hot: await n(["interested", "meeting", "won"]) };
}

/* -------------------------------- export ------------------------------- */

export async function exportCsv(params: Record<string, any>): Promise<string> {
  let rows: Row[];
  const ids = typeof params.ids === "string" && params.ids ? params.ids.split(",").map((x: string) => x.trim()).filter(Boolean).slice(0, MAX_BULK) : [];
  if (ids.length) {
    rows = [];
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      rows.push(...(await q(`${PROSPECT_SELECT} WHERE p.id IN (${part.map(() => "?").join(",")})`, part)));
    }
  } else {
    const w = buildWhere(filtersFrom(params));
    rows = await q(`${PROSPECT_SELECT} WHERE ${w.sql} ORDER BY ${orderBy(params.sort, params.dir)} LIMIT 20000`, w.params);
  }
  const header = ["Company", "Domain", "Country", "City", "Industry", "Person", "Title", "Email", "Email status", "Fit", "Stage", "Why", "Campaign", "Segment", "Source", "Mailbox", "Found", "Sent", "Replied", "LinkedIn"];
  return toCsv(
    header,
    rows.map((r) => {
      const v = prospectRowView(r);
      const industry = r.co_industry_id ? INDUSTRY_BY_ID.get(r.co_industry_id)?.label || v.industry : v.industry;
      return [v.company, v.domain, v.country, v.city, industry, v.fullName, v.title, v.email, v.emailStatus, v.fitScore, v.stage, v.stageReason, v.campaignName, v.segmentName, v.leadSource, v.mailboxEmail, v.createdAt.slice(0, 10), v.sentAt ? String(v.sentAt).slice(0, 10) : "", v.repliedAt ? String(v.repliedAt).slice(0, 10) : "", v.linkedinUrl];
    })
  );
}

/* -------------------------------- import ------------------------------- */

export const MAX_IMPORT_ROWS = 5000;

export async function ensureLeadTables() {
  await q(`CREATE TABLE IF NOT EXISTS lead_imports (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    segment_id TEXT,
    file_name TEXT,
    enter_at TEXT NOT NULL DEFAULT 'research',
    status TEXT NOT NULL DEFAULT 'running',
    total INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    imported INTEGER NOT NULL DEFAULT 0,
    duplicate INTEGER NOT NULL DEFAULT 0,
    suppressed INTEGER NOT NULL DEFAULT 0,
    invalid INTEGER NOT NULL DEFAULT 0,
    results_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  )`);
  // An import cut off by a restart never finishes on its own.
  await q(`UPDATE lead_imports SET status = 'failed', error = 'Stopped by a server restart; the rows before it were imported.', finished_at = ? WHERE status = 'running'`, [nowIso()]);
}

function readTable(csv: string): { headers: string[]; rows: string[][] } {
  const all = parseCsv(String(csv || ""), MAX_IMPORT_ROWS + 2);
  if (!all.length) throw new CampaignError("The file is empty.");
  const headers = all[0].map((h) => String(h || "").trim());
  return { headers, rows: all.slice(1) };
}

export function previewImport(body: any) {
  const csv = String(body?.csv || "");
  if (csv.length > 8_000_000) throw new CampaignError("The file is too big (8 MB at most).");
  const t = readTable(csv);
  const total = parseCsv(csv).length - 1;
  return { headers: t.headers, sample: t.rows.slice(0, 5), total: Math.max(0, total), mapping: guessMapping(t.headers), max: MAX_IMPORT_ROWS, fields: IMPORT_FIELDS };
}

type Outcome = "imported" | "duplicate" | "suppressed" | "invalid";
interface ImportResult {
  row: number;
  email: string;
  company: string;
  outcome: Outcome;
  reason: string;
}

const pending = new Map<string, { rows: string[][]; mapping: Partial<Record<ImportField, number>> }>();

function importView(r: Row) {
  return {
    id: String(r.id),
    campaignId: String(r.campaign_id),
    segmentId: r.segment_id || null,
    fileName: r.file_name || null,
    enterAt: (r.enter_at === "verify" ? "verify" : "research") as "research" | "verify",
    status: (["running", "done", "failed"].includes(r.status) ? r.status : "running") as "running" | "done" | "failed",
    total: Number(r.total) || 0,
    processed: Number(r.processed) || 0,
    imported: Number(r.imported) || 0,
    duplicate: Number(r.duplicate) || 0,
    suppressed: Number(r.suppressed) || 0,
    invalid: Number(r.invalid) || 0,
    error: r.error || null,
    createdAt: String(r.created_at),
    finishedAt: r.finished_at || null,
    sample: parseJson<ImportResult[]>(r.results_json, []).filter((x) => x.outcome !== "imported").slice(0, 8),
  };
}

export async function startImport(body: any) {
  const campaignId = String(body?.campaignId || "");
  const c = (await q(`SELECT id, status FROM campaigns WHERE id = ?`, [campaignId]))[0];
  if (!c) throw new CampaignError("Pick the campaign the leads go into.");
  if (c.status === "archived") throw new CampaignError("That campaign is archived.");
  const segmentId = body?.segmentId ? String(body.segmentId) : null;
  if (segmentId && !(await q(`SELECT id FROM segments WHERE id = ? AND campaign_id = ?`, [segmentId, campaignId]))[0]) throw new CampaignError("That segment isn't in the campaign.");
  const t = readTable(String(body?.csv || ""));
  if (t.rows.length > MAX_IMPORT_ROWS) throw new CampaignError(`The file has ${t.rows.length.toLocaleString()} rows; the limit is ${MAX_IMPORT_ROWS.toLocaleString()} per file. Split it and import the parts.`);
  if (!t.rows.length) throw new CampaignError("The file has a header but no rows.");
  const mapping: Partial<Record<ImportField, number>> = {};
  const src = body?.mapping && typeof body.mapping === "object" ? body.mapping : guessMapping(t.headers);
  for (const f of IMPORT_FIELDS) {
    const i = Number(src[f]);
    if (src[f] !== undefined && src[f] !== null && src[f] !== "" && Number.isInteger(i) && i >= 0 && i < t.headers.length) mapping[f] = i;
  }
  if (mapping.email === undefined) throw new CampaignError("Pick the column that holds the email address.");
  const id = uid();
  await q(`INSERT INTO lead_imports (id, campaign_id, segment_id, file_name, enter_at, status, total, created_at) VALUES (?,?,?,?,?, 'running', ?, ?)`, [
    id,
    campaignId,
    segmentId,
    typeof body?.fileName === "string" ? body.fileName.slice(0, 160) : null,
    body?.enterAt === "verify" ? "verify" : "research",
    t.rows.length,
    nowIso(),
  ]);
  pending.set(id, { rows: t.rows, mapping });
  // In the background; the screen polls GET /import/:id.
  const job = runImport(id);
  if (body?.wait === true) await job;
  else job.catch(() => {});
  return { import: importView((await q(`SELECT * FROM lead_imports WHERE id = ?`, [id]))[0]) };
}

export async function getImport(id: string) {
  const r = (await q(`SELECT * FROM lead_imports WHERE id = ?`, [id]))[0];
  if (!r) throw new CampaignError("Import not found", 404);
  return { import: importView(r) };
}

export async function importResultsCsv(id: string): Promise<string> {
  const r = (await q(`SELECT results_json FROM lead_imports WHERE id = ?`, [id]))[0];
  if (!r) throw new CampaignError("Import not found", 404);
  const list = parseJson<ImportResult[]>(r.results_json, []);
  return toCsv(["Row", "Email", "Company", "Result", "Why"], list.map((x) => [x.row, x.email, x.company, x.outcome, x.reason]));
}

async function runImport(id: string): Promise<void> {
  const job = pending.get(id);
  const meta = (await q(`SELECT * FROM lead_imports WHERE id = ?`, [id]))[0];
  if (!job || !meta) return;
  const campaign = (await q(`SELECT * FROM campaigns WHERE id = ?`, [meta.campaign_id]))[0];
  const settings = sanitizeSettings(parseJson(campaign?.settings_json, {}), DEFAULT_SETTINGS);
  const enterVerify = meta.enter_at === "verify";
  const results: ImportResult[] = [];
  const counts: Record<Outcome, number> = { imported: 0, duplicate: 0, suppressed: 0, invalid: 0 };
  const seenEmail = new Set<string>();
  const seenDomain = new Set<string>();
  const save = async (final: boolean, error?: string) => {
    await q(
      `UPDATE lead_imports SET processed = ?, imported = ?, duplicate = ?, suppressed = ?, invalid = ?, results_json = ?, status = ?, error = ?, finished_at = ? WHERE id = ?`,
      [results.length, counts.imported, counts.duplicate, counts.suppressed, counts.invalid, JSON.stringify(results), final ? (error ? "failed" : "done") : "running", error || null, final ? nowIso() : null, id]
    );
  };
  try {
    for (let i = 0; i < job.rows.length; i++) {
      const cells = job.rows[i];
      const get = (f: ImportField) => (job.mapping[f] !== undefined ? String(cells[job.mapping[f]!] ?? "").trim() : "");
      const res = await importRow(meta, settings, get, seenEmail, seenDomain, enterVerify);
      results.push({ row: i + 2, ...res });
      counts[res.outcome]++;
      if (i % 200 === 199) {
        await save(false);
        await new Promise((r) => setTimeout(r, 0)); // let requests in
      }
    }
    await save(true);
    if (counts.imported) {
      await logEvent("campaign", `Imported ${counts.imported} lead${counts.imported === 1 ? "" : "s"} from a file${counts.duplicate + counts.suppressed + counts.invalid ? ` (${counts.duplicate} duplicate, ${counts.suppressed} on a do-not-contact rule, ${counts.invalid} invalid)` : ""}.`, { campaignId: meta.campaign_id, level: "success" });
    }
  } catch (e: any) {
    await save(true, String(e?.message || e).slice(0, 300));
  } finally {
    pending.delete(id);
  }
}

async function importRow(
  meta: Row,
  settings: ReturnType<typeof sanitizeSettings>,
  get: (f: ImportField) => string,
  seenEmail: Set<string>,
  seenDomain: Set<string>,
  enterVerify: boolean
): Promise<{ email: string; company: string; outcome: Outcome; reason: string }> {
  const rawEmail = get("email");
  const companyName = get("company");
  const out = (outcome: Outcome, reason: string, email = rawEmail) => ({ email, company: companyName, outcome, reason });
  const email = cleanEmail(rawEmail.replace(/^mailto:/i, ""));
  if (!email || !isValidEmail(email)) return out("invalid", rawEmail ? "Not a valid email address" : "No email address");
  const e = email.toLowerCase();
  const domain = domainOf(get("website")) || (isFreeMailDomain(e.split("@")[1]) ? null : domainOf(e));
  if (!domain) return out("invalid", "No company website, and the address is a personal one (gmail, outlook…)", e);
  if (seenEmail.has(e)) return out("duplicate", "Twice in this file", e);
  if (seenDomain.has(domain)) return out("duplicate", "Another person at this company is earlier in the file", e);
  seenEmail.add(e);
  seenDomain.add(domain);
  if ((await q(`SELECT id FROM prospects WHERE campaign_id = ? AND lower(email) = ? LIMIT 1`, [meta.campaign_id, e]))[0]) return out("duplicate", "Already in this campaign", e);
  const blocked = await domainBlockReason(domain, settings);
  if (blocked) return out("suppressed", blocked, e);
  let company = (await q(`SELECT id FROM companies WHERE domain = ?`, [domain]))[0];
  if (company && (await q(`SELECT id FROM prospects WHERE campaign_id = ? AND company_id = ? LIMIT 1`, [meta.campaign_id, company.id]))[0]) {
    return out("duplicate", "This company is already in this campaign", e);
  }
  const sup = await suppressionReason(e, String(meta.campaign_id), undefined, company?.id || null);
  if (sup) return out("suppressed", sup, e);
  const now = nowIso();
  if (!company) {
    const country = normalizeCountry(get("country")) || null;
    await q(`INSERT INTO companies (id, domain, name, website, country, city, source, created_at, updated_at) VALUES (?,?,?,?,?,?, 'import', ?, ?) ON CONFLICT (domain) DO NOTHING`, [
      uid(),
      domain,
      companyName ? companyName.slice(0, 120) : null,
      `https://${domain}`,
      country,
      get("city") ? get("city").slice(0, 80) : null,
      now,
      now,
    ]);
    company = (await q(`SELECT id FROM companies WHERE domain = ?`, [domain]))[0];
    if (!company) return out("invalid", "Couldn't save the company", e);
  }
  let full = get("fullName");
  let first = get("firstName");
  let last = get("lastName");
  if (!full && (first || last)) full = [first, last].filter(Boolean).join(" ");
  if (full && !first) {
    const s = splitName(full);
    first = s.first;
    last = last || s.last;
  }
  const linkedin = /linkedin\.com\//i.test(get("linkedin")) ? get("linkedin").slice(0, 300) : null;
  await q(
    `INSERT INTO prospects (id, campaign_id, segment_id, company_id, first_name, last_name, full_name, title, linkedin_url, email, email_source, lead_source, stage, stage_reason, stage_changed_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'import', 'import', ?, ?, ?, ?, ?)`,
    [
      uid(),
      meta.campaign_id,
      meta.segment_id || null,
      company.id,
      first ? first.slice(0, 60) : null,
      last ? last.slice(0, 60) : null,
      full ? full.slice(0, 100) : null,
      get("title") ? get("title").slice(0, 120) : null,
      linkedin,
      e,
      enterVerify ? "contact_found" : "found",
      enterVerify ? "Imported from a file; checking the address" : "Imported from a file; researching the company first",
      now,
      now,
      now,
    ]
  );
  if (meta.segment_id) await q(`UPDATE segments SET found = found + 1 WHERE id = ?`, [meta.segment_id]);
  return out("imported", enterVerify ? "Goes to address check" : "Goes to research", e);
}
