// Instantly API v2 client — the sending engine (mailboxes, warmup, campaigns,
// Unibox replies). Shapes verified against api_v2.json; condensed reference in
// .same/ref/instantly-api-notes.md. Everything is HTTPS, so it works on Railway
// Hobby (which blocks outbound SMTP).
import { getSetting } from "../db";
import { sleep } from "./events";

const BASE = "https://api.instantly.ai";

export class InstantlyError extends Error {
  status: number;
  body: any;
  constructor(msg: string, status: number, body?: any) {
    super(msg);
    this.name = "InstantlyError";
    this.status = status;
    this.body = body;
  }
}

export async function getInstantlyKey(): Promise<string> {
  return ((await getSetting("instantly_api_key")) || process.env.INSTANTLY_API_KEY || "").trim();
}

export async function instantlyConfigured(): Promise<boolean> {
  return !!(await getInstantlyKey());
}

// GET /api/v2/emails is limited to 20 req/min; keep every call politely paced.
let chain: Promise<void> = Promise.resolve();
let nextSlot = 0;
async function pace(path: string) {
  const gap = path.startsWith("/api/v2/emails") ? 3200 : 250;
  const mine = chain.then(async () => {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + gap;
    if (at > now) await sleep(at - now);
  });
  chain = mine.catch(() => {});
  return mine;
}

/**
 * Low-level call. Modules may use this for endpoints not wrapped below.
 * `query` values that are arrays are sent as repeated params.
 */
export async function instantlyCall<T = any>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: { body?: any; query?: Record<string, any>; key?: string } = {}
): Promise<T> {
  const key = opts.key || (await getInstantlyKey());
  if (!key) throw new InstantlyError("Instantly is not connected — add your API key in Agent → Integrations.", 0);
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await pace(path);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e: any) {
      if (attempt < 2) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new InstantlyError(`Instantly network error: ${String(e?.message || e)}`, 0);
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.status === 429 && attempt < 2) {
      await sleep(Number(res.headers.get("retry-after")) * 1000 || 6000 * (attempt + 1));
      continue;
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || res.statusText || "request failed";
      throw new InstantlyError(`Instantly ${method} ${path} → ${res.status}: ${msg}`, res.status, data);
    }
    return data as T;
  }
  throw new InstantlyError(`Instantly ${method} ${path} failed after retries`, 0);
}

/* ------------------------------- types -------------------------------- */

export interface InstantlyAccount {
  email: string;
  first_name: string;
  last_name: string;
  status?: number; // 1 active, 2 paused, -1/-2/-3 errors
  warmup_status: number; // 1 active, 0 paused, negatives = problems
  stat_warmup_score?: number | null;
  daily_limit?: number | null;
  provider_code: number; // 1 custom IMAP/SMTP, 2 Google, 3 Microsoft, 4 AWS
  timestamp_created: string;
  timestamp_warmup_start?: string | null;
  setup_pending?: boolean;
  status_message?: { code?: string; e_message?: string; response?: string } | null;
  warmup?: { limit?: number; increment?: string; reply_rate?: number };
  tracking_domain_name?: string | null;
  tracking_domain_status?: string | null;
}

export interface WarmupDay {
  sent: number;
  landed_inbox: number;
  landed_spam: number;
  received: number;
}
export interface WarmupAggregate extends WarmupDay {
  health_score?: number;
  health_score_label?: string;
}

export interface VitalsResult {
  domain: string;
  allPass: boolean;
  mx: boolean;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  indeterminate?: string[];
}

export interface InstantlyEmail {
  id: string;
  timestamp_created: string;
  timestamp_email: string;
  message_id: string;
  subject: string;
  from_address_email?: string | null;
  to_address_email_list: string;
  body: { text?: string; html?: string };
  campaign_id?: string | null;
  lead?: string | null;
  lead_id?: string | null;
  eaccount: string;
  ue_type?: number | null; // 1 sent from campaign, 2 received, 3 sent manually, 4 scheduled
  step?: string | null;
  is_unread?: number | null;
  is_auto_reply?: number | null;
  i_status?: number | null;
  thread_id?: string | null;
  content_preview?: string | null;
}

export interface NewLead {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  job_title?: string;
  website?: string;
  phone?: string;
  personalization?: string;
  custom_variables?: Record<string, string | number | boolean | null>;
}

/* ------------------------------ accounts ------------------------------ */

export async function testConnection(key?: string): Promise<{ ok: boolean; accounts?: number; error?: string }> {
  try {
    const r = await instantlyCall<{ items: InstantlyAccount[] }>("GET", "/api/v2/accounts", { query: { limit: 100 }, key });
    return { ok: true, accounts: r.items?.length || 0 };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function listAccounts(): Promise<InstantlyAccount[]> {
  const out: InstantlyAccount[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await instantlyCall<{ items: InstantlyAccount[]; next_starting_after?: string }>("GET", "/api/v2/accounts", {
      query: { limit: 100, starting_after: after },
    });
    out.push(...(r.items || []));
    if (!r.next_starting_after || !r.items?.length) break;
    after = r.next_starting_after;
  }
  return out;
}

export const getAccount = (email: string) =>
  instantlyCall<InstantlyAccount>("GET", `/api/v2/accounts/${encodeURIComponent(email)}`);

export interface CreateAccountInput {
  email: string;
  first_name: string;
  last_name: string;
  provider_code: number;
  imap_username: string;
  imap_password: string;
  imap_host: string;
  imap_port: number;
  smtp_username: string;
  smtp_password: string;
  smtp_host: string;
  smtp_port: number;
  daily_limit?: number;
  warmup?: { limit?: number; increment?: string; reply_rate?: number };
}
export const createAccount = (input: CreateAccountInput) => instantlyCall<InstantlyAccount>("POST", "/api/v2/accounts", { body: input });

export const patchAccount = (email: string, patch: Partial<{ daily_limit: number; first_name: string; last_name: string; signature: string; warmup: any; sending_gap: number; enable_slow_ramp: boolean }>) =>
  instantlyCall<InstantlyAccount>("PATCH", `/api/v2/accounts/${encodeURIComponent(email)}`, { body: patch });

export const enableWarmup = (emails: string[]) => instantlyCall("POST", "/api/v2/accounts/warmup/enable", { body: { emails } });
export const disableWarmup = (emails: string[]) => instantlyCall("POST", "/api/v2/accounts/warmup/disable", { body: { emails } });
export const pauseAccount = (email: string) => instantlyCall("POST", `/api/v2/accounts/${encodeURIComponent(email)}/pause`);
export const resumeAccount = (email: string) => instantlyCall("POST", `/api/v2/accounts/${encodeURIComponent(email)}/resume`);

export async function warmupAnalytics(emails: string[]): Promise<{
  aggregate: Record<string, WarmupAggregate>;
  byDate: Record<string, Record<string, WarmupDay>>;
}> {
  if (!emails.length) return { aggregate: {}, byDate: {} };
  const r = await instantlyCall<any>("POST", "/api/v2/accounts/warmup-analytics", { body: { emails } });
  return { aggregate: r?.aggregate_data || {}, byDate: r?.email_date_data || {} };
}

export async function testVitals(emails: string[]): Promise<VitalsResult[]> {
  if (!emails.length) return [];
  const r = await instantlyCall<any>("POST", "/api/v2/accounts/test/vitals", { body: { accounts: emails } });
  return [...(r?.success_list || []), ...(r?.failure_list || [])];
}

export interface DailyAccountStat {
  date: string;
  email_account: string;
  sent: number;
  bounced: number;
  contacted: number;
  replies: number;
  unique_replies: number;
  replies_automatic: number;
}
export async function dailyAccountAnalytics(emails: string[], startDate?: string, endDate?: string): Promise<DailyAccountStat[]> {
  if (!emails.length) return [];
  const r = await instantlyCall<any>("GET", "/api/v2/accounts/analytics/daily", {
    query: { emails, start_date: startDate, end_date: endDate },
  });
  return Array.isArray(r) ? r : r?.items || [];
}

/* ------------------------------ campaigns ----------------------------- */

export interface CampaignSchedule {
  name: string;
  timing: { from: string; to: string };
  days: Record<string, boolean>;
  timezone: string;
}
export interface CreateCampaignInput {
  name: string;
  campaign_schedule: { schedules: CampaignSchedule[]; start_date?: string | null };
  sequences: { steps: { type: "email"; delay: number; delay_unit?: "days" | "hours" | "minutes"; variants: { subject: string; body: string }[] }[] }[];
  email_list?: string[];
  daily_limit?: number;
  daily_max_leads?: number;
  text_only?: boolean;
  first_email_text_only?: boolean;
  link_tracking?: boolean;
  open_tracking?: boolean;
  stop_on_reply?: boolean;
  stop_on_auto_reply?: boolean;
  stop_for_company?: boolean;
  insert_unsubscribe_header?: boolean;
  prioritize_new_leads?: boolean;
  email_gap?: number;
  random_wait_max?: number;
  match_lead_esp?: boolean;
  allow_risky_contacts?: boolean;
}
export const createCampaign = (input: CreateCampaignInput) => instantlyCall<{ id: string; status: number }>("POST", "/api/v2/campaigns", { body: input });
export const getCampaign = (id: string) => instantlyCall<any>("GET", `/api/v2/campaigns/${id}`);
export const patchCampaign = (id: string, patch: Partial<CreateCampaignInput>) => instantlyCall<any>("PATCH", `/api/v2/campaigns/${id}`, { body: patch });
export const activateCampaign = (id: string) => instantlyCall<any>("POST", `/api/v2/campaigns/${id}/activate`);
export const pauseCampaign = (id: string) => instantlyCall<any>("POST", `/api/v2/campaigns/${id}/pause`);
export async function campaignAnalytics(id: string): Promise<any | null> {
  const r = await instantlyCall<any>("GET", "/api/v2/campaigns/analytics", { query: { id } });
  return Array.isArray(r) ? r[0] || null : r;
}
/** One row per day: date, sent, contacted, new_leads_contacted, replies, unique_replies, replies_automatic, opportunities … (max 31 days). */
export interface DailyCampaignStat {
  date: string;
  sent?: number;
  contacted?: number;
  new_leads_contacted?: number;
  replies?: number;
  unique_replies?: number;
  replies_automatic?: number;
  unique_replies_automatic?: number;
  opportunities?: number;
  unique_opportunities?: number;
}
export async function campaignDailyAnalytics(id: string, startDate: string, endDate: string): Promise<DailyCampaignStat[]> {
  const r = await instantlyCall<any>("GET", "/api/v2/campaigns/analytics/daily", { query: { campaign_id: id, start_date: startDate, end_date: endDate } });
  return Array.isArray(r) ? r : [];
}
/** One row per step (and variant). `step` is ZERO-based, as a string (Instantly: "0" = the first email). */
export interface StepAnalytics {
  step: string | null;
  variant: string | null;
  sent?: number;
  replies?: number;
  unique_replies?: number;
  replies_automatic?: number;
  opportunities?: number;
  meetings_booked?: number;
}
export async function campaignStepAnalytics(id: string): Promise<StepAnalytics[]> {
  const r = await instantlyCall<any>("GET", "/api/v2/campaigns/analytics/steps", { query: { campaign_id: id, include_opportunities_count: "true" } });
  return Array.isArray(r) ? r : [];
}

/* -------------------------------- leads ------------------------------- */

export interface AddLeadsResult {
  status: string;
  total_sent: number;
  leads_uploaded: number;
  in_blocklist: number;
  duplicated_leads: number;
  skipped_count: number;
  invalid_email_count: number;
  created_leads: { index: number; id: string; email?: string | null }[];
}
/** Up to 1000 leads per call. AI copy goes in custom_variables. */
export const addLeads = (campaignId: string, leads: NewLead[], opts: { skipIfInWorkspace?: boolean } = {}) =>
  instantlyCall<AddLeadsResult>("POST", "/api/v2/leads/add", {
    body: { campaign_id: campaignId, leads, skip_if_in_workspace: opts.skipIfInWorkspace ?? true },
  });

export async function listCampaignLeads(campaignId: string, startingAfter?: string, limit = 100) {
  return instantlyCall<{ items: any[]; next_starting_after?: string }>("POST", "/api/v2/leads/list", {
    body: { campaign: campaignId, limit, starting_after: startingAfter },
  });
}

/** 1 Interested · 2 Meeting booked · 3 Meeting completed · 4 Won · 0 OOO · -1 Not interested · -2 Wrong person · -3 Lost */
export const updateInterest = (leadEmail: string, value: number | null, campaignId?: string) =>
  instantlyCall("POST", "/api/v2/leads/update-interest-status", {
    body: { lead_email: leadEmail, interest_value: value, campaign_id: campaignId },
  });

export const blockEntry = (value: string) => instantlyCall("POST", "/api/v2/block-lists-entries", { body: { bl_value: value } });

/* ------------------------------- Unibox ------------------------------- */

export interface ListEmailsQuery {
  limit?: number;
  starting_after?: string;
  email_type?: "received" | "sent" | "manual";
  campaign_id?: string;
  lead?: string;
  eaccount?: string;
  is_unread?: boolean;
  search?: string; // an email address, or "thread:<thread_id>"
  sort_order?: "asc" | "desc";
  min_timestamp_created?: string;
  mode?: "emode_focused" | "emode_others" | "emode_all";
  latest_of_thread?: boolean;
}
export const listEmails = (query: ListEmailsQuery) =>
  instantlyCall<{ items: InstantlyEmail[]; next_starting_after?: string }>("GET", "/api/v2/emails", { query: query as any });

export const getEmail = (id: string) => instantlyCall<InstantlyEmail>("GET", `/api/v2/emails/${id}`);

export const replyToEmail = (input: { eaccount: string; reply_to_uuid: string; subject: string; body: { text?: string; html?: string } }) =>
  instantlyCall<InstantlyEmail>("POST", "/api/v2/emails/reply", { body: input });

export const markThreadRead = (threadId: string) => instantlyCall("POST", `/api/v2/emails/threads/${encodeURIComponent(threadId)}/mark-as-read`);

export async function unreadCount(): Promise<number> {
  const r = await instantlyCall<{ count?: number }>("GET", "/api/v2/emails/unread/count");
  return Number(r?.count || 0);
}

/* ------------------------------- helpers ------------------------------ */

/** Map a country to one of Instantly's allowed schedule timezones. */
export function timezoneForCountry(country?: string | null): string {
  const c = String(country || "").toLowerCase();
  if (/(emirates|uae|dubai|abu dhabi|oman)/.test(c)) return "Asia/Dubai";
  if (/(saudi|ksa|qatar|kuwait|bahrain|iraq)/.test(c)) return "Asia/Baghdad";
  if (/yemen/.test(c)) return "Asia/Aden";
  if (/jordan/.test(c)) return "Asia/Amman";
  if (/egypt/.test(c)) return "Africa/Cairo";
  if (/lebanon/.test(c)) return "Asia/Beirut";
  if (/pakistan/.test(c)) return "Asia/Karachi";
  if (/india/.test(c)) return "Asia/Kolkata";
  // Only values from Instantly's 102-entry enum are allowed (no Asia/Riyadh,
  // no Europe/London). Default: UTC+3, which covers KSA/Qatar/Kuwait/Bahrain.
  return "Asia/Baghdad";
}

/**
 * Sun–Thu where the weekend is Fri–Sat (Saudi, Qatar, Kuwait, Bahrain, Oman,
 * Iraq, Yemen, Jordan, Egypt); Mon–Fri elsewhere — including the UAE, which
 * moved to a Sat–Sun weekend in 2022. 0 = Sunday.
 */
export function workDaysForCountry(country?: string | null): Record<string, boolean> {
  const c = String(country || "").toLowerCase();
  const gulf = /(saudi|ksa|qatar|kuwait|bahrain|oman|iraq|yemen|jordan|egypt)/.test(c) && !/(emirates|uae)/.test(c);
  return gulf
    ? { "0": true, "1": true, "2": true, "3": true, "4": true, "5": false, "6": false }
    : { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false };
}
