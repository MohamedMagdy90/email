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
import { crawlDirectory, type DirectoryOptions } from "./crawler/directory";
import { registrableDomain, hostOf } from "./crawler/urls";
import { getReaderStats } from "./crawler/fetcher";
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

/* ------------------------------- logging ------------------------------- */
// Verbose, greppable worker logs so Railway shows exactly what the bot is doing:
// which source it's searching, every company it finds, and why anything stalls.
// Filter in Railway with "[discovery" (all), "[discovery:dir]" (directories),
// "[discovery:osm]" (map areas), or "[discovery:enrich]" (email finding).
function dlog(scope: string, msg: string) { console.log(`[discovery${scope ? ":" + scope : ""}] ${msg}`); }
function dwarn(scope: string, msg: string) { console.warn(`[discovery${scope ? ":" + scope : ""}] ${msg}`); }
function derr(scope: string, msg: string) { console.error(`[discovery${scope ? ":" + scope : ""}] ${msg}`); }

// host + path (+ query) — compact URL for logs, drops the noisy protocol/www.
function shortUrl(u?: string | null): string {
  if (!u) return "";
  try { const x = new URL(u); return x.host.replace(/^www\./, "") + x.pathname + (x.search || ""); } catch { return String(u); }
}
function srcLabel(src: any): string {
  if (src?.type === "directory") return shortUrl(src.base_url) || "directory";
  return `${src?.location || "?"} · ${src?.category || "?"}`;
}
// One-line "what we found": name · email · phone (email/phone omitted if absent).
function leadLine(name?: string | null, email?: string | null, phone?: string | null): string {
  const bits = [String(name || "(unnamed)").slice(0, 60)];
  bits.push(email ? email : "no-email");
  if (phone) bits.push(phone);
  return bits.join("  ·  ");
}

// One source (or one enrichment) per tick keeps us gentle on the free OSM
// mirrors and on the sites we crawl — no bans, no hammering.
const DISCOVERY_TICK_MS = 45_000;
const ENRICH_TICK_MS = 15_000;
// Directory sources walk continuously: pages per batch, and a short delay before
// the next batch so a big directory streams in quickly without hammering.
const DIRECTORY_PAGES_PER_RUN = 4;
const DIRECTORY_CONTINUE_MS = 1_500;
// Consecutive empty batches to tolerate before a directory is "finished".
const EMPTY_STREAK_LIMIT = 3;
// Enrichment retry policy: a BLOCKED / errored crawl is transient (Cloudflare
// wall, reader rate-limit, timeout) — retry with growing backoff instead of
// discarding the lead. Only give up after this many tries.
const ENRICH_MAX_RETRIES = 6;
const ENRICH_BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000, 72 * 3_600_000];
function fmtBackoff(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ~${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `in ~${h}h` : `in ~${Math.round(h / 24)}d`;
}

let discovering = false;
let enriching = false;
let started = false;

/* --------------------------- global switches --------------------------- */

export async function isBotEnabled(): Promise<boolean> {
  return (await getSetting("discovery_enabled")) === "1";
}
export async function setBotEnabled(on: boolean): Promise<void> {
  await setSetting("discovery_enabled", on ? "1" : "0");
  dlog("", `bot switched ${on ? "ON — will start scanning enabled sources" : "OFF — scanning paused"}`);
}
async function autoEnrichOn(): Promise<boolean> {
  return (await getSetting("discovery_auto_enrich")) !== "0"; // default ON
}
export async function setAutoEnrich(on: boolean): Promise<void> {
  await setSetting("discovery_auto_enrich", on ? "1" : "0");
  dlog("", `auto-find-emails switched ${on ? "ON" : "OFF"}`);
}

/* ------------------------------- status -------------------------------- */

export interface DiscoveryStatus {
  enabled: boolean;
  autoEnrich: boolean;
  sources: number;
  activeSources: number;
  leads: { pending: number; approved: number; rejected: number; withEmail: number; total: number };
  pendingEnrich: number;
  // Pending, email-less leads whose last crawl was BLOCKED/errored (Cloudflare,
  // rate-limit, timeout) — recoverable, either automatically (retry backoff) or
  // via "Re-check blocked" once a Jina key / scraping proxy is added.
  blocked: number;
  // Whether a scalable Cloudflare bypass is configured, + how often the free
  // reader has been rate-limited — drives the "add a key/proxy" nudge in the UI.
  bypass: { readerKeyed: boolean; proxy: boolean; readerRateLimited: number };
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
  // Leads whose enrichment was blocked/errored (either still retrying, or given
  // up on after the retry cap) — the pool that "Re-check blocked" can recover.
  const blocked = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads
      WHERE status='pending' AND (email IS NULL OR email='')
        AND website IS NOT NULL AND website<>''
        AND (enrich_status IN ('blocked','error') OR retry_count > 0)`
  ))[0]?.n ?? 0;
  const nextRunAt = (await q(`SELECT min(next_run_at) AS t FROM discovery_sources WHERE enabled=1`))[0]?.t ?? null;
  const lastLeadAt = (await q(`SELECT max(created_at) AS t FROM discovered_leads`))[0]?.t ?? null;

  const map: Record<string, number> = {};
  for (const r of statusRows) map[String(r.status)] = Number(r.n);

  const [proxy, readerKey] = await Promise.all([getProxyConfig(), getReaderKey()]);
  const rstats = getReaderStats();

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
    blocked,
    bypass: { readerKeyed: !!readerKey, proxy: !!proxy, readerRateLimited: rstats.rateLimited },
    nextRunAt,
    lastLeadAt,
  };
}

/* ---------------------------- discovery run ---------------------------- */

const onlyDigits = (s?: string | null) => (s || "").replace(/\D/g, "");

// Free-mail providers are NOT a company's own domain — dozens of unrelated
// businesses share gmail.com/hotmail.com, so we never dedupe or classify by them.
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com",
  "msn.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "icloud.com", "me.com", "aol.com",
  "protonmail.com", "proton.me", "gmx.com", "gmx.net", "mail.com", "zoho.com",
  "qq.com", "163.com", "126.com", "yandex.com", "yandex.ru",
]);
const isFreeMail = (domain?: string | null) => FREEMAIL.has((domain || "").toLowerCase());

// Stable key so the same company is never added twice (across ticks / sources).
// Email first (most specific), so many different companies sharing gmail.com are
// each kept — only an identical email/domain/phone is treated as a duplicate.
function dedupKey(c: { domain?: string | null; email?: string | null; phone?: string | null; name?: string | null; city?: string | null }): string {
  const email = (c.email || "").toLowerCase();
  if (email) return "e:" + email;
  const domain = (c.domain || "").toLowerCase();
  if (domain) return "d:" + domain;
  const phone = onlyDigits(c.phone);
  if (phone.length >= 7) return "p:" + phone.slice(-9);
  return "n:" + String(c.name || "").toLowerCase().trim() + "|" + String(c.city || "").toLowerCase().trim();
}

// Contact emails/domains we already hold — so discovery never re-surfaces them.
// Free-mail domains are excluded (they'd wrongly block every gmail-based lead).
async function loadContactDedup(): Promise<{ emails: Set<string>; domains: Set<string> }> {
  const emails = new Set(await getContactEmails());
  const domains = new Set<string>();
  for (const e of emails) {
    const d = registrableDomain((e.split("@")[1] || ""));
    if (d && !isFreeMail(d)) domains.add(d);
  }
  return { emails, domains };
}

interface LeadRow {
  name: string; website: string | null; domain: string | null; email: string | null;
  phone: string | null; city: string | null; country: string; category: string;
  sourceId: string; label: string; enriched: number; confidence: string | null;
}

// Insert one lead if it's genuinely new (not an existing contact, not already in
// the pool). Returns true when a row was added.
async function insertDiscovered(row: LeadRow, dedup: { emails: Set<string>; domains: Set<string> }): Promise<boolean> {
  const email = (row.email || "").trim().toLowerCase();
  const domain = (row.domain || "").trim().toLowerCase();
  if (email && dedup.emails.has(email)) return false;   // already a saved Contact
  if (domain && dedup.domains.has(domain)) return false; // already a Contact's domain
  // Never allow the same email twice in the pool. The dedup_key ("e:<email>")
  // already blocks two directly-listed emails, but a lead that was ENRICHED to
  // this email carries a domain/phone key — so check the email column too.
  if (email) {
    const dupe = (await q(`SELECT 1 FROM discovered_leads WHERE email=? LIMIT 1`, [email]))[0];
    if (dupe) return false;
  }
  const key = dedupKey({ domain, email, phone: row.phone, name: row.name, city: row.city });
  const rows = await q(
    `INSERT INTO discovered_leads
      (id,dedup_key,name,website,domain,email,phone,city,country,category,source_id,source_label,status,enriched,confidence,via,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?, NULL, ?)
     ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
    [
      uid(), key,
      row.name || domain || email || "Unknown",
      row.website, domain || null, email || null,
      row.phone, row.city, row.country, row.category,
      row.sourceId, row.label, row.enriched, row.confidence, nowIso(),
    ]
  );
  return rows.length > 0;
}

// Set/replace the page number in a directory URL so we can walk it continuously
// across separate runs. Handles ?page=N, /page/N, and a trailing bare number
// (e.g. /listings/31 → /listings/32); otherwise appends ?page=N as a fallback.
function withPage(base: string, page: number): string {
  try {
    const u = new URL(/^https?:\/\//i.test(base) ? base : "https://" + base);
    for (const k of ["page", "paged", "pg", "p", "start", "offset"]) {
      if (u.searchParams.has(k)) { u.searchParams.set(k, String(page)); return u.toString(); }
    }
    if (/\/(?:page|p)[-/]\d+\/?$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/((?:page|p)[-/])\d+(\/?)$/i, `$1${page}$2`);
      return u.toString();
    }
    // Trailing number segment = the page number (common: /listings/31, /dir/5).
    if (/\/\d+\/?$/.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\d+(\/?)$/, `${page}$1`);
      return u.toString();
    }
    if (page > 1) u.searchParams.set("page", String(page)); // leave page 1 as the clean base
    return u.toString();
  } catch { return base; }
}

// Strip any page marker from a URL so it can serve as a clean paging base
// (?page=N, /page/N, and trailing /N are all removed).
function stripPage(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url);
    for (const k of ["page", "paged", "pg", "p", "start", "offset"]) u.searchParams.delete(k);
    u.pathname = u.pathname.replace(/\/(?:page|p)[-/]\d+\/?$/i, "");
    return u.toString();
  } catch { return url; }
}

// The page number already present in a directory URL, so a source can start
// walking from wherever the user pasted (defaults to 1).
export function initialCursor(base: string): number {
  try {
    const u = new URL(/^https?:\/\//i.test(base) ? base : "https://" + base);
    for (const k of ["page", "paged", "pg", "p", "start", "offset"]) {
      const v = u.searchParams.get(k);
      if (v && /^\d+$/.test(v)) return Math.max(1, Number(v));
    }
    let m = u.pathname.match(/\/(?:page|p)[-/](\d+)\/?$/i);
    if (m) return Math.max(1, Number(m[1]));
    m = u.pathname.match(/\/(\d+)\/?$/);
    if (m) return Math.max(1, Number(m[1]));
    return 1;
  } catch { return 1; }
}

/* --------------------------- OSM area source --------------------------- */

// Run one OSM source: discover companies, dedupe, insert new. Returns count.
async function runSource(src: any): Promise<{ found: number; error?: string }> {
  const place = safeParse(src.place_json);
  const limit = clamp(src.limit_n, 5, 500);
  dlog("osm", `searching "${src.location}" · ${src.category} (up to ${limit}) via OpenStreetMap`);
  const companies: Company[] = await findLeads(src.location, src.category, limit, place);
  dlog("osm", `OpenStreetMap returned ${companies.length} candidate(s) for "${src.location}"`);
  const dedup = await loadContactDedup();
  const label = `${src.location} · ${src.category}`;
  let found = 0, skipped = 0;
  for (const co of companies) {
    const domain = co.website ? (registrableDomain(hostOf(co.website)) || "") : "";
    const email = (co.email || "").toLowerCase();
    const added = await insertDiscovered({
      name: co.name, website: co.website || null, domain: domain || null, email: email || null,
      phone: co.phone || null, city: co.city || null, country: src.location, category: src.category,
      sourceId: src.id, label,
      enriched: email ? 1 : 0,          // listed email → no enrichment needed
      confidence: email ? "listed" : null,
    }, dedup);
    if (added) { found++; dlog("osm", `  + ${leadLine(co.name, email, co.phone)}`); }
    else skipped++;
  }
  dlog("osm", `"${src.location}" done: +${found} new, ${skipped} already-known/duplicate`);
  // When OSM returned rows but they're ALL already in the pool/contacts, the area
  // is fully harvested — re-scanning can't surface more. Say so, and point at the
  // one thing that actually scales beyond OSM's tagged set: a Directory source.
  if (found === 0 && companies.length > 0) {
    dlog("osm", `↳ "${src.location}" · ${src.category} is fully harvested from OpenStreetMap (all ${companies.length} known already). OSM is a map, not a company registry — add a Directory (bulk) source to go beyond it.`);
  } else if (companies.length === 0) {
    dlog("osm", `↳ OpenStreetMap has no ${src.category} tagged with a website/email in "${src.location}". Try a broader Industry, a bigger area, or a Directory (bulk) source.`);
  }
  return { found };
}

/* -------------------------- Directory source -------------------------- */

interface DirRunResult {
  found: number;       // NEW leads inserted into the pool this batch
  extracted: number;   // listings actually read this batch (new OR already-known)
  detailPages: number; // detail/card pages opened this batch
  error?: string; okish: boolean; nextCursor: number; pages: number;
}

// Walk ONE batch of a business directory (a few pages), starting at the saved
// page cursor, and insert every new company. This is what scales to tens of
// thousands: a directory lists every business, and we page through it forever.
async function runDirectorySource(src: any): Promise<DirRunResult> {
  const base = String(src.base_url || "").trim();
  const cursor = Math.max(1, Number(src.cursor) || 1);
  if (!base) { derr("dir", "source has no directory URL set — skipping"); return { found: 0, extracted: 0, detailPages: 0, error: "No directory URL set", okish: false, nextCursor: cursor, pages: 0 }; }

  const proxy = await getProxyConfig();
  const readerKey = await getReaderKey();
  const seed = withPage(base, cursor);
  const opts: DirectoryOptions = {
    maxPages: DIRECTORY_PAGES_PER_RUN,
    // Open EVERY listing on the pages we walk — the cursor advances by whole
    // pages, so a maxDetails smaller than (pages × listings-per-page) would
    // silently skip listings. 40/page is a generous ceiling for dense directories.
    maxDetails: Math.max(clamp(src.limit_n, 20, 300), DIRECTORY_PAGES_PER_RUN * 40),
    concurrency: proxy ? 3 : 5,
    respectRobots: true,
    checkMx: true,
    defaultCountry: String(src.location || "").trim() || undefined,
    proxy,
    readerKey,
  };

  const how = proxy ? `scraping proxy (${proxy.provider})` : readerKey ? "free reader (keyed)" : "direct fetch + free reader fallback";
  dlog("dir", `crawling ${shortUrl(seed)} — page ${cursor}, up to ${DIRECTORY_PAGES_PER_RUN} listing page(s) · ${how}`);

  // Stream the crawler's own progress into the log: each listing page it opens,
  // its detail-page progress, and any phase note (e.g. auto-switching to /listings).
  const result = await crawlDirectory(seed, opts, (p) => {
    if (p.type === "phase" && p.msg) dlog("dir", `  · ${p.msg}`);
    else if (p.type === "page" && p.msg) dlog("dir", `  · ${p.msg}${p.url ? ` [${shortUrl(p.url)}]` : ""}`);
    else if (p.type === "detail" && p.detailTotal && ((p.detailPages || 0) % 10 === 0 || p.detailPages === p.detailTotal)) {
      dlog("dir", `  · opened ${p.detailPages}/${p.detailTotal} listing page(s) · ${p.contacts} with contact info`);
    }
  });

  // The crawler auto-found the real listings index (the URL you pasted had no
  // companies). Persist it so we page the correct URL from here on, and restart
  // the walk at page 1 of that index so nothing is skipped.
  let resolvedFromCursor = cursor;
  if (result.resolvedSeed) {
    const resolvedBase = stripPage(result.resolvedSeed);
    if (resolvedBase && resolvedBase !== base) {
      await q(`UPDATE discovery_sources SET base_url=? WHERE id=?`, [resolvedBase, src.id]);
      resolvedFromCursor = 1;
      dlog("dir", `auto-detected the real listings index → ${shortUrl(resolvedBase)} (saved · walking from page 1)`);
    }
  }

  dlog("dir", `batch result: ${result.status.toUpperCase()} · ${result.listingPages} page(s) walked · ${result.detailPages} listing(s) opened · ${result.contacts.length} contact(s) extracted`);
  if (result.note && (result.status === "blocked" || result.status === "empty" || result.status === "error")) {
    dwarn("dir", `↳ ${result.note}`);
  }

  const dedup = await loadContactDedup();
  const label = src.category && src.category !== "Companies (general)"
    ? `${src.location || hostOf(base)} · ${src.category}`
    : (src.location || hostOf(base));

  let found = 0, skipped = 0;
  for (const co of result.contacts) {
    const email = (co.email || "").toLowerCase();
    const emailDomain = email ? (registrableDomain(email.split("@")[1] || "") || "") : "";
    const website = (co.website || "").trim();
    const websiteDomain = website ? (registrableDomain(hostOf(website)) || "") : "";
    // Only treat a real company domain as the domain — never a free-mail host.
    const domain = (emailDomain && !isFreeMail(emailDomain) ? emailDomain : "") || websiteDomain;
    const added = await insertDiscovered({
      name: co.name, website: website || null, domain: domain || null, email: email || null,
      phone: co.phone || null, city: null, country: String(src.location || ""), category: src.category || "",
      sourceId: src.id, label,
      // A listing with an inline email is complete. One that only exposes a
      // WEBSITE still needs a crawl to find the email — leave it un-enriched so
      // enrichTick picks it up (previously these were lost: website=null, enriched=1).
      enriched: email ? 1 : (website ? 0 : 1),
      confidence: email ? "listed" : null,
    }, dedup);
    if (added) { found++; dlog("dir", `  + ${leadLine(co.name, email, co.phone)}${!email && website ? ` · site ${shortUrl(website)} → will find email` : ""}`); }
    else skipped++;
  }
  dlog("dir", `${shortUrl(base)}: +${found} new into pool, ${skipped} duplicate/already-known`);

  const pages = result.listingPages || 0;
  const okish = result.status === "ok" || result.status === "empty";
  const blocked = result.status === "blocked" || result.status === "error";
  // Advance from wherever this batch actually started (page 1 when we just
  // switched to a freshly-resolved index), never past a block.
  const nextCursor = okish ? resolvedFromCursor + Math.max(1, pages) : resolvedFromCursor;
  const error = blocked ? (result.note || result.status) : undefined;
  return { found, extracted: result.contacts.length, detailPages: result.detailPages, error, okish, nextCursor, pages };
}

/* ------------------------------ scheduling ---------------------------- */

// Run + persist the outcome for a single source. `continue` = run again on the
// very next tick (directory sources stream continuously until exhausted).
async function executeSource(src: any): Promise<{ found: number; error?: string; continue: boolean }> {
  await q(`UPDATE discovery_sources SET last_status='running' WHERE id=?`, [src.id]);
  const interval = clamp(src.interval_minutes, 15, 100000);
  dlog("", `▶ running ${src.type} source: ${srcLabel(src)}`);

  if (src.type === "directory") {
    let r: DirRunResult;
    try {
      r = await runDirectorySource(src);
    } catch (e: any) {
      r = { found: 0, extracted: 0, detailPages: 0, error: String(e?.message || e), okish: false, nextCursor: Number(src.cursor) || 1, pages: 0 };
    }

    // Decide "end of directory" by whether this batch actually READ listing cards,
    // NOT by whether they were new. A page full of businesses we already have
    // (found=0 but extracted>0) is NOT the end — otherwise re-scanning a directory
    // we've already harvested would die after 3 duplicate pages and never re-walk
    // the whole thing. Only a batch that opened no detail pages and pulled nothing
    // real (a lone footer email leaks 1) counts toward the empty streak.
    const productive = r.detailPages > 0 || r.extracted >= 2;
    let streak = Number(src.empty_streak) || 0;
    let exhausted = false;
    let cursor = Number(src.cursor) || 1;
    if (!r.error && r.okish) {
      cursor = r.nextCursor;                       // move on, even through thin pages
      streak = productive ? 0 : streak + 1;
      exhausted = streak >= EMPTY_STREAK_LIMIT;    // genuinely off the end of the list
    }
    const cont = !r.error && !exhausted;           // keep streaming while there's more
    const next = cont ? nowIso() : new Date(Date.now() + interval * 60000).toISOString();
    const status = r.error ? "error" : exhausted ? "done" : "ok";
    await q(
      `UPDATE discovery_sources
         SET last_run_at=?, next_run_at=?, last_status=?, last_error=?, runs=runs+1,
             total_found=total_found+?, cursor=?, exhausted=?, empty_streak=?
       WHERE id=?`,
      [nowIso(), next, status, r.error || null, r.found, cursor, exhausted ? 1 : 0, exhausted ? 0 : streak, src.id]
    );
    if (r.error) derr("dir", `${srcLabel(src)}: ERROR — ${r.error} (will retry in ${interval}m)`);
    else if (exhausted) dlog("dir", `${srcLabel(src)}: FINISHED — walked to the end of the directory (${EMPTY_STREAK_LIMIT} pages with no more listings); re-checking in ${interval}m. Click "Run now" to re-scan for new listings.`);
    else if (cont) dlog("dir", `${srcLabel(src)}: continuing to page ${cursor} in ${Math.round(DIRECTORY_CONTINUE_MS / 1000)}s${r.extracted > 0 && r.found === 0 ? ` (page's ${r.extracted} listing(s) already known — still walking to the end)` : ""}`);
    return { found: r.found, error: r.error, continue: cont };
  }

  // OSM area source.
  let result: { found: number; error?: string };
  try {
    result = await runSource(src);
  } catch (e: any) {
    result = { found: 0, error: String(e?.message || e) };
  }
  const next = new Date(Date.now() + interval * 60000).toISOString();
  await q(
    `UPDATE discovery_sources
       SET last_run_at=?, next_run_at=?, last_status=?, last_error=?, runs=runs+1, total_found=total_found+?
     WHERE id=?`,
    [nowIso(), next, result.error ? "error" : "ok", result.error || null, result.found, src.id]
  );
  if (result.error) derr("osm", `${srcLabel(src)}: ERROR — ${result.error} (next scan in ${interval}m)`);
  else dlog("osm", `${srcLabel(src)}: +${result.found} new · next scan in ${interval}m`);
  return { found: result.found, error: result.error, continue: false };
}

// Manual "run now" from the UI. Works even when the global bot is paused so you
// can test a source in isolation. Clears `exhausted` so a directory resumes.
export async function runSourceNow(id: string): Promise<{ found: number; error?: string }> {
  const src = (await q(`SELECT * FROM discovery_sources WHERE id=?`, [id]))[0];
  if (!src) { dwarn("", `manual "run now": source ${id} not found`); return { found: 0, error: "Source not found" }; }
  dlog("", `manual "run now" requested for ${srcLabel(src)}`);
  if (src.type === "directory") {
    // A kick on a FINISHED directory re-scans it from the top, so listings added
    // anywhere in it get picked up (dedup skips the ones we already hold). A kick
    // on a mid-walk directory just resumes from where it left off.
    const restart = Number(src.exhausted) === 1;
    const cursor = restart ? initialCursor(String(src.base_url || "")) : (Number(src.cursor) || 1);
    await q(`UPDATE discovery_sources SET exhausted=0, empty_streak=0, cursor=? WHERE id=?`, [cursor, id]);
    src.exhausted = 0; src.empty_streak = 0; src.cursor = cursor;
    if (restart) dlog("dir", `re-scanning ${srcLabel(src)} from page ${cursor} — re-checking every listing for anything new`);
  }
  const r = await executeSource(src);
  // Keep streaming a directory in the background after a manual kick.
  if (r.continue) setTimeout(() => discoveryTick().catch(() => {}), DIRECTORY_CONTINUE_MS);
  return { found: r.found, error: r.error };
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
  let keepStreaming = false;
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
    const r = await executeSource(src);
    keepStreaming = r.continue;
  } finally {
    discovering = false;
  }
  // Directory sources stream continuously: chain the next batch quickly instead
  // of waiting the full tick, so a big directory pours in fast (but politely).
  if (keepStreaming) setTimeout(() => discoveryTick().catch((e) => derr("", `discovery tick failed: ${String(e?.message || e)}`)), DIRECTORY_CONTINUE_MS);
}

async function enrichTick(): Promise<void> {
  if (enriching) return;
  if (!(await isBotEnabled())) return;
  if (!(await autoEnrichOn())) return;
  enriching = true;
  try {
    // Next due lead with a site but no email. Fresh leads (next_enrich_at NULL)
    // go first; retried ones only once their backoff has elapsed — so a wall of
    // blocked leads never starves newly-discovered ones.
    const now = nowIso();
    const lead = (await q(
      `SELECT * FROM discovered_leads
        WHERE status='pending' AND enriched=0 AND (email IS NULL OR email='')
          AND website IS NOT NULL AND website<>''
          AND (next_enrich_at IS NULL OR next_enrich_at <= ?)
        ORDER BY (next_enrich_at IS NULL) DESC, next_enrich_at ASC, created_at ASC
        LIMIT 1`,
      [now]
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

    const attempt = (Number(lead.retry_count) || 0) + 1;
    dlog("enrich", `crawling ${shortUrl(lead.website)} for an email — "${lead.name || lead.domain}"${attempt > 1 ? ` (try ${attempt})` : ""}`);
    let email: string | null = null;
    let phone: string | null = lead.phone || null;
    let confidence: string | null = null;
    // Why the crawl ended, so we can tell a recoverable block from a real miss:
    //   found  → got an email
    //   empty  → site loaded fine but exposes no email (permanent)
    //   blocked→ bot-wall / rate-limit (transient — retry)
    //   error  → fetch failure / exception (transient — retry)
    let outcome: "found" | "empty" | "blocked" | "error" = "error";
    let note = "";
    try {
      const site = await crawlSite(lead.website, opts);
      if (site.phone && !phone) phone = site.phone;
      const best = pickSiteEmail(site.emails, lead.domain);
      if (best) { email = best.email.trim().toLowerCase(); confidence = "likely"; outcome = "found"; }
      else if (site.status === "blocked") { outcome = "blocked"; note = site.note || "blocked"; }
      else if (site.status === "error") { outcome = "error"; note = site.note || "could not open site"; }
      else { outcome = "empty"; } // site loaded, genuinely no email present
    } catch (e: any) {
      outcome = "error";
      note = String(e?.message || e);
      dwarn("enrich", `  crawl failed for ${shortUrl(lead.website)}: ${note}`);
    }

    if (email) {
      // Guard against duplicates: if this email is already a saved Contact, or
      // already sits on another pool row, this lead is now redundant — remove it
      // so the same email is never listed twice.
      const asContact = (await q(`SELECT 1 FROM contacts WHERE email=? LIMIT 1`, [email]))[0];
      const inPool = (await q(`SELECT id FROM discovered_leads WHERE email=? AND id<>? LIMIT 1`, [email, lead.id]))[0];
      if (asContact || inPool) {
        await q(`DELETE FROM discovered_leads WHERE id=?`, [lead.id]);
        dlog("enrich", `  ✓ ${email} already known — removed duplicate "${lead.name || lead.domain}"`);
        return;
      }
      // Promote the dedup_key to the email so any FUTURE lead carrying it collides
      // on the unique key and is skipped. enriched=1 so we never re-crawl it.
      await q(
        `UPDATE discovered_leads
            SET enriched=1, email=?, phone=?, confidence=?, dedup_key=?, enrich_status='found', next_enrich_at=NULL
          WHERE id=?`,
        [email, phone, confidence, "e:" + email, lead.id]
      );
      dlog("enrich", `  ✓ found ${email} for "${lead.name || lead.domain}"`);
      return;
    }

    // No email. The old code marked EVERY miss enriched=1 — so a Cloudflare wall
    // or a reader rate-limit permanently buried a recoverable lead. Now we only
    // "give up" when the site actually loaded and simply has no email.
    if (outcome === "empty") {
      await q(
        `UPDATE discovered_leads SET enriched=1, phone=?, confidence=NULL, enrich_status='empty', next_enrich_at=NULL WHERE id=?`,
        [phone, lead.id]
      );
      dlog("enrich", `  ✗ no email on ${shortUrl(lead.website)} (site loaded fine) — "${lead.name || lead.domain}"`);
      return;
    }

    // Blocked / errored → transient. Back off and retry later, up to the cap.
    if (attempt >= ENRICH_MAX_RETRIES) {
      // Give up for now, but record WHY (enrich_status) so "Re-check blocked"
      // (or adding a Jina key / proxy later) can resurrect exactly these.
      await q(
        `UPDATE discovered_leads SET enriched=1, phone=?, retry_count=?, enrich_status=?, next_enrich_at=NULL WHERE id=?`,
        [phone, attempt, outcome, lead.id]
      );
      dwarn("enrich", `  ⚠ giving up on "${lead.name || lead.domain}" after ${attempt} tries — ${note || outcome}. Add a free Jina key or a scraping proxy in Settings, then click "Re-check blocked".`);
      return;
    }
    const backoffMs = ENRICH_BACKOFF_MS[Math.min(attempt - 1, ENRICH_BACKOFF_MS.length - 1)];
    const nextAt = new Date(Date.now() + backoffMs).toISOString();
    await q(
      `UPDATE discovered_leads SET enriched=0, phone=?, retry_count=?, enrich_status=?, next_enrich_at=? WHERE id=?`,
      [phone, attempt, outcome, nextAt, lead.id]
    );
    dlog("enrich", `  ↻ ${outcome} on "${lead.name || lead.domain}" (try ${attempt}/${ENRICH_MAX_RETRIES}) — retrying ${fmtBackoff(backoffMs)}${note ? ` · ${note}` : ""}`);
  } finally {
    enriching = false;
  }
}

/* ---------------------------- bulk recovery ---------------------------- */

// One-click recovery for the historical "no email" pool. Resets pending,
// email-less leads that have a website so enrichTick re-attempts them. Targets
// the ones that were BLOCKED/errored or predate retry-tracking (enrich_status
// NULL); leaves genuinely-empty sites (enrich_status='empty') alone so we don't
// pointlessly re-crawl sites we already confirmed have no email.
export async function reEnrichBlocked(): Promise<{ reset: number }> {
  const rows = await q(
    `UPDATE discovered_leads
        SET enriched=0, retry_count=0, next_enrich_at=NULL, enrich_status=NULL
      WHERE status='pending'
        AND (email IS NULL OR email='')
        AND website IS NOT NULL AND website<>''
        AND enriched=1
        AND (enrich_status IS NULL OR enrich_status IN ('blocked','error'))
      RETURNING id`
  );
  const reset = rows.length;
  dlog("enrich", `re-check requested → re-queued ${reset} blocked/untried lead(s) to find emails again`);
  // Nudge the enrich loop so recovery starts immediately (respecting the bot's
  // on/off + auto-enrich switches inside the tick).
  if (reset > 0) setTimeout(() => { enrichTick().catch(() => {}); }, 500);
  return { reset };
}

/* --------------------------------- boot -------------------------------- */

export function startDiscoveryWorker(): void {
  if (started) return;
  started = true;
  setInterval(() => { discoveryTick().catch((e) => derr("", `discovery tick failed: ${String(e?.message || e)}`)); }, DISCOVERY_TICK_MS);
  setInterval(() => { enrichTick().catch((e) => derr("", `enrich tick failed: ${String(e?.message || e)}`)); }, ENRICH_TICK_MS);
  // Kick once shortly after boot so a due source runs promptly.
  setTimeout(() => { discoveryTick().catch((e) => derr("", `discovery tick failed: ${String(e?.message || e)}`)); }, 4000);
  dlog("", `worker started · discovery loop every ${DISCOVERY_TICK_MS / 1000}s · enrichment loop every ${ENRICH_TICK_MS / 1000}s`);

  // Report the live state on boot so the logs immediately explain whether the
  // bot will actually do anything (the #1 support question).
  (async () => {
    try {
      const on = await isBotEnabled();
      const active = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovery_sources WHERE enabled=1`))[0]?.n ?? 0;
      const auto = await autoEnrichOn();
      dlog("", `state → bot ${on ? "ON" : "OFF"} · ${active} enabled source(s) · auto-find-emails ${auto ? "ON" : "OFF"}`);
      if (!on) dwarn("", "bot is OFF — turn it on in the Discovery screen to start scanning.");
      else if (!active) dwarn("", "bot is ON but no sources are enabled — enable a source in the Discovery screen.");
    } catch { /* ignore */ }
  })();
}
