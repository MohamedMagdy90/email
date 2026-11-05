// Paid email finder: Anymail Finder (api.anymailfinder.com, v5.1).
//
// The LAST step of finding an address, after the company website and our own
// name-pattern guess (+ No2Bounce) came up empty or unconfirmed:
//   person          name + company domain (+ LinkedIn URL when we have one)
//                   1 credit, charged only when a valid email is found
//   decision maker  company domain + role categories -> name, title, LinkedIn, email
//                   2 credits, charged only when a valid email is found
// Not found / blacklisted results are free, and Anymail doesn't charge a repeat
// search within 30 days. Since 5 Oct 2026 it only returns VALID emails (a risky
// one comes back as not_found), so a found address is trusted as verified and
// never spends a second (No2Bounce) credit.
//
// Key: Agent → Connections (setting anymail_api_key) or the ANYMAIL_API_KEY env var.
// Spending: a monthly credit cap (setting anymail_monthly_cap, default 400 =
// the $29 plan), counted locally per calendar month (UTC). Results are cached
// here too (found 90 days, not found 30 days) so a lead retried later costs nothing.
import { q, getSetting, nowIso } from "../db";
import { logEvent } from "./events";

const BASE = "https://api.anymailfinder.com/v5.1";
/** Anymail recommends 180 s (it verifies live); a pass shouldn't hang that long on one lead. */
const TIMEOUT_MS = 90_000;
const FOUND_TTL_DAYS = 90;
const MISS_TTL_DAYS = 30;
export const DEFAULT_MONTHLY_CAP = 400;
export const PERSON_COST = 1;
export const DECISION_MAKER_COST = 2;

export type FinderKind = "person" | "decision_maker";
export type FinderCategory = "ceo" | "engineering" | "finance" | "hr" | "it" | "logistics" | "marketing" | "operations" | "buyer" | "sales";

export type FinderOutcome =
  | {
      status: "found";
      email: string;
      fullName: string | null;
      firstName: string | null;
      lastName: string | null;
      title: string | null;
      linkedin: string | null;
      /** Which category matched (decision-maker lookups). */
      category: string | null;
      credits: number;
      cached: boolean;
    }
  | { status: "not_found"; cached: boolean }
  /** Not asked: no key, monthly cap reached, out of credits, key rejected, network. Retry later. */
  | { status: "unavailable"; reason: string };

/* ------------------------------- settings ------------------------------- */

export async function getAnymailKey(): Promise<string> {
  return ((await getSetting("anymail_api_key")) || process.env.ANYMAIL_API_KEY || "").trim();
}

export async function finderConfigured(): Promise<boolean> {
  return !!(await getAnymailKey());
}

export async function monthlyCap(): Promise<number> {
  const n = Math.floor(Number(await getSetting("anymail_monthly_cap")));
  return n > 0 ? n : DEFAULT_MONTHLY_CAP;
}

/* -------------------------------- schema -------------------------------- */

let ready: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await q(`CREATE TABLE IF NOT EXISTS finder_usage (
        month TEXT NOT NULL,
        kind TEXT NOT NULL,
        lookups INTEGER NOT NULL DEFAULT 0,
        found INTEGER NOT NULL DEFAULT 0,
        credits INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (month, kind)
      )`);
      await q(`CREATE TABLE IF NOT EXISTS finder_cache (
        cache_key TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        checked_at TEXT NOT NULL
      )`);
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

/* -------------------------------- usage --------------------------------- */

const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);

export interface FinderUsage {
  month: string;
  credits: number;
  lookups: number;
  found: number;
  cap: number;
  /** Credits still allowed this month under the cap. */
  left: number;
}

export async function usageThisMonth(): Promise<FinderUsage> {
  await ensureSchema();
  const month = monthOf();
  const rows = await q(`SELECT lookups, found, credits FROM finder_usage WHERE month = ?`, [month]);
  let credits = 0;
  let lookups = 0;
  let found = 0;
  for (const r of rows) {
    credits += Number(r.credits) || 0;
    lookups += Number(r.lookups) || 0;
    found += Number(r.found) || 0;
  }
  const cap = await monthlyCap();
  return { month, credits, lookups, found, cap, left: Math.max(0, cap - credits) };
}

async function recordUsage(kind: FinderKind, found: boolean, credits: number) {
  try {
    await q(
      `INSERT INTO finder_usage (month, kind, lookups, found, credits) VALUES (?,?,?,?,?)
       ON CONFLICT (month, kind) DO UPDATE SET lookups = finder_usage.lookups + ?, found = finder_usage.found + ?, credits = finder_usage.credits + ?`,
      [monthOf(), kind, 1, found ? 1 : 0, credits, 1, found ? 1 : 0, credits]
    );
  } catch {
    /* never block a lookup on accounting */
  }
}

/* -------------------------------- cache --------------------------------- */

const norm = (s: string) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

async function readCache(key: string): Promise<FinderOutcome | null> {
  const r = (await q(`SELECT result_json, checked_at FROM finder_cache WHERE cache_key = ?`, [key]))[0];
  if (!r) return null;
  try {
    const out = JSON.parse(String(r.result_json)) as FinderOutcome;
    const ttl = (out.status === "found" ? FOUND_TTL_DAYS : MISS_TTL_DAYS) * 86400_000;
    if (Date.now() - Date.parse(String(r.checked_at)) > ttl) return null;
    if (out.status === "found") return { ...out, credits: 0, cached: true };
    if (out.status === "not_found") return { status: "not_found", cached: true };
    return null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, out: FinderOutcome) {
  if (out.status === "unavailable") return; // never cache a failure to ask
  try {
    await q(
      `INSERT INTO finder_cache (cache_key, result_json, checked_at) VALUES (?,?,?)
       ON CONFLICT (cache_key) DO UPDATE SET result_json = ?, checked_at = ?`,
      [key, JSON.stringify(out), nowIso(), JSON.stringify(out), nowIso()]
    );
  } catch {
    /* best effort */
  }
}

/* --------------------------------- API ---------------------------------- */

/** Out of credits on the Anymail account: stop asking for an hour (in memory). */
let outOfCreditsUntil = 0;

async function call(path: string, key: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: key, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function errorText(status: number, data: any): string {
  const msg = String(data?.error_explained || data?.message || data?.error || "").slice(0, 200);
  if (status === 401) return `the API key was rejected${msg ? ` (${msg})` : ""}`;
  if (status === 402) return "the Anymail Finder account is out of credits";
  return `Anymail Finder answered ${status}${msg ? `: ${msg}` : ""}`;
}

async function lookup(kind: FinderKind, cacheKey: string, body: Record<string, unknown>, cost: number): Promise<FinderOutcome> {
  const key = await getAnymailKey();
  if (!key) return { status: "unavailable", reason: "Anymail Finder isn't connected" };
  await ensureSchema();
  const cached = await readCache(cacheKey);
  if (cached) return cached;
  if (Date.now() < outOfCreditsUntil) return { status: "unavailable", reason: "the Anymail Finder account is out of credits" };
  const usage = await usageThisMonth();
  if (usage.credits + cost > usage.cap) {
    return { status: "unavailable", reason: `this month's Anymail Finder cap is reached (${usage.credits} of ${usage.cap} credits)` };
  }
  let r: { status: number; data: any };
  try {
    r = await call(kind === "person" ? "/find-email/person" : "/find-email/decision-maker", key, body);
  } catch (e: any) {
    return { status: "unavailable", reason: `couldn't reach Anymail Finder (${String(e?.name === "TimeoutError" ? "timed out" : e?.message || e).slice(0, 120)})` };
  }
  if (r.status === 402) {
    outOfCreditsUntil = Date.now() + 3600_000;
    await logEvent("contact", "Anymail Finder is out of credits. Top up the account; lookups resume within the hour.", { level: "warn" });
  }
  if (r.status !== 200) return { status: "unavailable", reason: errorText(r.status, r.data) };
  const d = r.data || {};
  const credits = Math.max(0, Number(d.credits_charged) || 0);
  const email = typeof d.valid_email === "string" && d.valid_email.includes("@") ? d.valid_email.trim().toLowerCase() : null;
  const out: FinderOutcome =
    d.email_status === "valid" && email
      ? {
          status: "found",
          email,
          fullName: typeof d.person_full_name === "string" ? d.person_full_name.trim() || null : null,
          firstName: typeof d.person_first_name === "string" ? d.person_first_name.trim() || null : null,
          lastName: typeof d.person_last_name === "string" ? d.person_last_name.trim() || null : null,
          title: typeof d.person_job_title === "string" ? d.person_job_title.trim() || null : null,
          linkedin: typeof d.person_linkedin_url === "string" && /linkedin\.com\/in\//i.test(d.person_linkedin_url) ? d.person_linkedin_url.slice(0, 300) : null,
          category: typeof d.decision_maker_category === "string" ? d.decision_maker_category : null,
          credits,
          cached: false,
        }
      : { status: "not_found", cached: false };
  await recordUsage(kind, out.status === "found", credits);
  await writeCache(cacheKey, out);
  return out;
}

/** A named person's address at a company. */
export function findPersonEmail(input: { fullName: string; domain: string; linkedinUrl?: string | null }): Promise<FinderOutcome> {
  const domain = norm(input.domain);
  const name = String(input.fullName || "").trim();
  const body: Record<string, unknown> = { domain, full_name: name };
  // With a LinkedIn URL Anymail falls back to the profile, which may be at ANOTHER
  // company. We only send it when the name + company lookup can use it as a hint.
  if (input.linkedinUrl && /linkedin\.com\/in\//i.test(input.linkedinUrl)) body.linkedin_url = input.linkedinUrl;
  return lookup("person", `person|${domain}|${norm(name)}`, body, PERSON_COST);
}

/** The best decision maker for the given roles (in order) at a company. */
export function findDecisionMaker(input: { domain: string; categories: FinderCategory[] }): Promise<FinderOutcome> {
  const domain = norm(input.domain);
  const categories = input.categories.length ? input.categories : (["ceo"] as FinderCategory[]);
  return lookup("decision_maker", `dm|${domain}|${categories.join(",")}`, { domain, decision_maker_category: categories }, DECISION_MAKER_COST);
}

/**
 * Anymail role categories for the campaign's title list, in the campaign's
 * order (at most 3). The owner / CEO is added as the last fallback when the
 * list doesn't name it: in a small company they decide, and the site-people
 * ranking falls back to them too.
 */
export function categoriesForTitles(titles: string[]): FinderCategory[] {
  const rules: [RegExp, FinderCategory][] = [
    [/\b(ceo|owner|founder|co-founder|president|chairman|managing director|general manager|managing partner|partner|md|gm|chief executive)\b/i, "ceo"],
    [/\b(cfo|finance|financial|accountant|accounting|controller|treasur)/i, "finance"],
    [/\b(coo|operations?|admin|administration)\b/i, "operations"],
    [/\b(cto|cio|it|information technology|technology|digital|systems|erp)\b/i, "it"],
    [/\b(procurement|purchasing|buyer|supply chain)\b/i, "buyer"],
    [/\b(logistics|warehouse|fleet)\b/i, "logistics"],
    [/\b(sales|business development|commercial)\b/i, "sales"],
    [/\bmarketing\b/i, "marketing"],
    [/\bengineer(ing)?\b/i, "engineering"],
    [/\b(hr|human resources|people)\b/i, "hr"],
  ];
  const out: FinderCategory[] = [];
  for (const t of titles) {
    const hit = rules.find(([re]) => re.test(String(t || "")));
    if (hit && !out.includes(hit[1])) out.push(hit[1]);
  }
  const first = out.slice(0, 3);
  if (first.includes("ceo")) return first;
  return [...out.filter((c) => c !== "ceo").slice(0, 2), "ceo"];
}

/** Validate a key with the free account endpoint (no credit used). */
export async function testAnymail(keyOverride?: string): Promise<{ ok: boolean; error?: string; credits?: number; account?: string }> {
  const key = (keyOverride || "").trim() || (await getAnymailKey());
  if (!key) return { ok: false, error: "No API key saved" };
  try {
    const r = await call("/account", key);
    if (r.status !== 200) return { ok: false, error: r.status === 401 ? "Anymail Finder rejected this API key." : errorText(r.status, r.data) };
    outOfCreditsUntil = 0;
    return { ok: true, credits: Number(r.data?.credits_left) || 0, account: typeof r.data?.email === "string" ? r.data.email : undefined };
  } catch (e: any) {
    return { ok: false, error: `Could not reach Anymail Finder (${String(e?.message || e).slice(0, 120)})` };
  }
}
