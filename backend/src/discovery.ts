// Always-on, server-side company discovery bot.
//
// Runs independently of any browser session: while the server process is up, it
// cycles through your "sources" (location + industry), finds NEW companies via
// free OpenStreetMap data, optionally crawls each one for a real email, and
// drops them into a reviewable pool (discovered_leads). You approve → they
// become Contacts. All state lives in the DB, so it survives restarts.

import { q, nowIso, getSetting, setSetting, getContactEmails } from "./db";
import { findLeads, type Company } from "./leads";
import { crawlSite, type CrawlOptions, type FoundEmail } from "./crawler";
import { registrableDomain, hostOf } from "./crawler/urls";
import { getProxyConfig, getReaderKey } from "./config";

const uid = () => crypto.randomUUID();
function clamp(n: number, lo: number, hi: number) {
  const x = Number(n);
  return Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
}
function safeParse(s?: string | null): any {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

// One source (or one enrichment) per tick keeps us gentle on the free OSM
// mirrors and on the sites we crawl — no bans, no hammering.
const DISCOVERY_TICK_MS = 45_000;
const ENRICH_TICK_MS = 15_000;

let discovering = false;
let enriching = false;
let started = false;

/* --------------------------- global switches --------------------------- */

export async function isBotEnabled(): Promise<boolean> {
  return (await getSetting("discovery_enabled")) === "1";
}
export async function setBotEnabled(on: boolean): Promise<void> {
  await setSetting("discovery_enabled", on ? "1" : "0");
}
async function autoEnrichOn(): Promise<boolean> {
  return (await getSetting("discovery_auto_enrich")) !== "0"; // default ON
}
export async function setAutoEnrich(on: boolean): Promise<void> {
  await setSetting("discovery_auto_enrich", on ? "1" : "0");
}

/* ------------------------------- status -------------------------------- */

export interface DiscoveryStatus {
  enabled: boolean;
  autoEnrich: boolean;
  sources: number;
  activeSources: number;
  leads: { pending: number; approved: number; rejected: number; withEmail: number; total: number };
  pendingEnrich: number;
  nextRunAt: string | null;
  lastLeadAt: string | null;
}

export async function getDiscoveryStatus(): Promise<DiscoveryStatus> {
  const srcCount = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovery_sources`))[0]?.n ?? 0;
  const activeCount = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovery_sources WHERE enabled=1`))[0]?.n ?? 0;
  const statusRows = await q(`SELECT status, CAST(count(*) AS INTEGER) AS n FROM discovered_leads GROUP BY status`);
  const withEmail = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE status='pending' AND email IS NOT NULL AND email <> ''`
  ))[0]?.n ?? 0;
  const total = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads`))[0]?.n ?? 0;
  const pendingEnrich = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads
      WHERE status='pending' AND enriched=0 AND (email IS NULL OR email='')
        AND website IS NOT NULL AND website<>''`
  ))[0]?.n ?? 0;
  const nextRunAt = (await q(`SELECT min(next_run_at) AS t FROM discovery_sources WHERE enabled=1`))[0]?.t ?? null;
  const lastLeadAt = (await q(`SELECT max(created_at) AS t FROM discovered_leads`))[0]?.t ?? null;

  const map: Record<string, number> = {};
  for (const r of statusRows) map[String(r.status)] = Number(r.n);

  return {
    enabled: await isBotEnabled(),
    autoEnrich: await autoEnrichOn(),
    sources: srcCount,
    activeSources: activeCount,
    leads: {
      pending: map.pending || 0,
      approved: map.approved || 0,
      rejected: map.rejected || 0,
      withEmail,
      total,
    },
    pendingEnrich,
    nextRunAt,
    lastLeadAt,
  };
}

/* ---------------------------- discovery run ---------------------------- */

// Stable key so the same company is never added twice (across ticks / sources).
function dedupKey(c: { domain?: string | null; email?: string | null; name?: string | null; city?: string | null }): string {
  const domain = (c.domain || "").toLowerCase();
  if (domain) return "d:" + domain;
  const email = (c.email || "").toLowerCase();
  if (email) return "e:" + email;
  return "n:" + String(c.name || "").toLowerCase().trim() + "|" + String(c.city || "").toLowerCase().trim();
}

// Run one source: discover companies, dedupe against contacts + the pool, and
// insert whatever is genuinely new. Returns how many NEW leads were added.
async function runSource(src: any): Promise<{ found: number; error?: string }> {
  const place = safeParse(src.place_json);
  const companies: Company[] = await findLeads(
    src.location,
    src.category,
    clamp(src.limit_n, 5, 120),
    place
  );

  // Skip anything we already hold as a contact (by exact email or by domain).
  const contactEmails = new Set(await getContactEmails());
  const contactDomains = new Set<string>();
  for (const e of contactEmails) {
    const d = registrableDomain((e.split("@")[1] || ""));
    if (d) contactDomains.add(d);
  }

  const label = `${src.location} · ${src.category}`;
  let found = 0;

  for (const co of companies) {
    const domain = co.website ? (registrableDomain(hostOf(co.website)) || "") : "";
    const email = (co.email || "").toLowerCase();
    if (email && contactEmails.has(email)) continue;
    if (domain && contactDomains.has(domain)) continue;

    const key = dedupKey({ domain, email, name: co.name, city: co.city });
    const rows = await q(
      `INSERT INTO discovered_leads
        (id,dedup_key,name,website,domain,email,phone,city,country,category,source_id,source_label,status,enriched,confidence,via,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?, NULL, ?)
       ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
      [
        uid(), key,
        co.name || domain || email || "Unknown",
        co.website || null, domain || null, email || null,
        co.phone || null, co.city || null, src.location, src.category,
        src.id, label,
        email ? 1 : 0,          // already has a listed email → no enrichment needed
        email ? "listed" : null,
        nowIso(),
      ]
    );
    if (rows.length) found++;
  }

  return { found };
}

// Run + persist the outcome for a single source row.
async function executeSource(src: any): Promise<{ found: number; error?: string }> {
  await q(`UPDATE discovery_sources SET last_status='running' WHERE id=?`, [src.id]);
  let result: { found: number; error?: string };
  try {
    result = await runSource(src);
  } catch (e: any) {
    result = { found: 0, error: String(e?.message || e) };
  }
  const next = new Date(Date.now() + clamp(src.interval_minutes, 15, 100000) * 60000).toISOString();
  await q(
    `UPDATE discovery_sources
       SET last_run_at=?, next_run_at=?, last_status=?, last_error=?, runs=runs+1, total_found=total_found+?
     WHERE id=?`,
    [nowIso(), next, result.error ? "error" : "ok", result.error || null, result.found, src.id]
  );
  return result;
}

// Manual "run now" from the UI. Works even when the global bot is paused so you
// can test a source in isolation.
export async function runSourceNow(id: string): Promise<{ found: number; error?: string }> {
  const src = (await q(`SELECT * FROM discovery_sources WHERE id=?`, [id]))[0];
  if (!src) return { found: 0, error: "Source not found" };
  return executeSource(src);
}

/* ------------------------------ enrichment ----------------------------- */

// Best deliverable email from a crawled site: prefer an address on the site's
// own domain, and a personal mailbox over a role inbox.
function pickSiteEmail(emails: FoundEmail[], siteDomain?: string | null): { email: string; role_based: boolean } | null {
  if (!emails?.length) return null;
  const dom = (siteDomain || "").toLowerCase();
  const onDomain = dom ? emails.filter((e) => (e.domain || "").toLowerCase() === dom) : [];
  const pool = onDomain.length ? onDomain : emails;
  pool.sort((a, b) => Number(a.role_based) - Number(b.role_based));
  return { email: pool[0].email, role_based: pool[0].role_based };
}

/* -------------------------------- ticks -------------------------------- */

async function discoveryTick(): Promise<void> {
  if (discovering) return;
  if (!(await isBotEnabled())) return;
  discovering = true;
  try {
    const now = nowIso();
    // Most-overdue enabled source (a null next_run_at = never run = due now).
    const src = (await q(
      `SELECT * FROM discovery_sources
        WHERE enabled=1 AND (next_run_at IS NULL OR next_run_at <= ?)
        ORDER BY (next_run_at IS NULL) DESC, next_run_at ASC
        LIMIT 1`,
      [now]
    ))[0];
    if (!src) return;
    await executeSource(src);
  } finally {
    discovering = false;
  }
}

async function enrichTick(): Promise<void> {
  if (enriching) return;
  if (!(await isBotEnabled())) return;
  if (!(await autoEnrichOn())) return;
  enriching = true;
  try {
    // Oldest pending lead that has a site but no email and hasn't been tried.
    const lead = (await q(
      `SELECT * FROM discovered_leads
        WHERE status='pending' AND enriched=0 AND (email IS NULL OR email='')
          AND website IS NOT NULL AND website<>''
        ORDER BY created_at ASC
        LIMIT 1`
    ))[0];
    if (!lead) return;

    const proxy = await getProxyConfig();
    const readerKey = await getReaderKey();
    const opts: CrawlOptions = {
      maxPages: 6,
      maxDepth: 1,
      respectRobots: true,
      checkMx: true,
      guessInbox: false,
      useSitemap: true,
      defaultCountry: lead.country || undefined,
      concurrency: 1,
      proxy,
      readerKey,
    };

    let email: string | null = null;
    let phone: string | null = lead.phone || null;
    let confidence: string | null = null;
    try {
      const site = await crawlSite(lead.website, opts);
      if (site.phone && !phone) phone = site.phone;
      const best = pickSiteEmail(site.emails, lead.domain);
      if (best) { email = best.email; confidence = "likely"; }
    } catch { /* leave email null — we still mark it tried below */ }

    // enriched=1 always, so we never spin on the same lead twice.
    await q(
      `UPDATE discovered_leads SET enriched=1, email=?, phone=?, confidence=? WHERE id=?`,
      [email, phone, email ? confidence : null, lead.id]
    );
  } finally {
    enriching = false;
  }
}

/* --------------------------------- boot -------------------------------- */

export function startDiscoveryWorker(): void {
  if (started) return;
  started = true;
  setInterval(() => { discoveryTick().catch(() => {}); }, DISCOVERY_TICK_MS);
  setInterval(() => { enrichTick().catch(() => {}); }, ENRICH_TICK_MS);
  // Kick once shortly after boot so a due source runs promptly.
  setTimeout(() => { discoveryTick().catch(() => {}); }, 4000);
  console.log("[discovery] worker started");
}
