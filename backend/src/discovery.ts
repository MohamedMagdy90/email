// Always-on, server-side company discovery bot.
//
// Runs independently of any browser session: while the server process is up, it
// cycles through your "sources" (location + industry), finds NEW companies via
// free OpenStreetMap data, optionally crawls each one for a real email, and
// drops them into a reviewable pool (discovered_leads). You approve → they
// become Contacts. All state lives in the DB, so it survives restarts.

import { q, nowIso, getSetting, setSetting, getContactEmails } from "./db";
import { findLeadsIn, resolveArea, tilesFor, countAvailable, isCompanySite as isCompanySiteHost, type Company, type Tile } from "./leads";
import {
  searchCompaniesPaged,
  CONTENT_BLOCK,
  SETUP_BLOCK,
  OFFICIAL_BLOCK,
  isContentTitle,
  companyNameFromTitle,
} from "./search";
import { crawlSite, type CrawlOptions, type FoundEmail } from "./crawler";
import { crawlDirectory, looksLikeName, type DirectoryOptions } from "./crawler/directory";
import { isBadName } from "./repair";
import { resolveWebsite } from "./enrich";
import { registrableDomain, hostOf } from "./crawler/urls";
import { resolveLeadCountry } from "./country";
import { getReaderStats } from "./crawler/fetcher";
import { getProxyConfig, getReaderKey } from "./config";
import { cleanEmail, isValidEmail } from "./crawler/validate";

const uid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  if (src?.type === "search") return `search · ${src?.location || "web"} · ${src?.category || "?"}`;
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
// How the enrichment loop is fed. It used to take ONE lead per tick and then
// sleep out the rest of the 15s — measured on production logs, a lead needs
// 1-3s of actual work, so ~85% of the loop was idle and the pool drained at
// ~4 leads/min however many were waiting.
//
// Now a pass claims a batch, works several at a time (a lead is almost entirely
// waiting on someone else's server, so running a few fills that dead air rather
// than adding load), and chains straight into the next pass while work remains.
// The reader's own global pacer — 500ms/call with a key — stays the real
// throttle, so this can't outrun the rate limit no matter how it's tuned.
const ENRICH_BATCH = 12;
const ENRICH_CONCURRENCY = 4;
const ENRICH_CHAIN_MS = 750;
// Directory sources walk continuously: how far a single batch may go, and a
// short delay before the next batch so a big directory streams in quickly
// without hammering. The batch stops at whichever budget is hit FIRST — a page
// cap alone is wrong for the two shapes directories come in: one lists 40
// companies a page (4 pages is plenty), another lists 3 (an infinite-scroll
// Drupal view), and a 4-page batch there would need 110 batches to finish.
const DIRECTORY_PAGES_PER_RUN = 25;
const DIRECTORY_LISTINGS_PER_RUN = 40;
const DIRECTORY_CONTINUE_MS = 1_500;
// Consecutive empty batches to tolerate before a directory is "finished".
const EMPTY_STREAK_LIMIT = 3;
// Web-search sources: how many search queries to run per batch (kept small so
// the shared free-reader budget isn't starved), which result pages to pull per
// query, spacing between queries, and how many all-duplicate batches to tolerate
// before a full re-walk is considered "done" for this interval.
// Map-area sources sweep their country as a grid of tiles: how many tiles one
// batch covers, and the pause between them so the free Overpass mirrors stay
// happy. A batch chains straight into the next until the grid is fully swept.
// Mirrors READER_RPM_KEYED in the fetcher — for the startup log line only.
const READER_RPM_KEYED_HINT = 120;
const OSM_TILES_PER_RUN = 6;
const OSM_TILE_PACING_MS = 1_200;
const SEARCH_QUERIES_PER_RUN = 3;
const SEARCH_PAGES = [0, 30];
// The search engine walls a datacenter IP after a couple of quick requests, so
// throughput is capped by politeness, not by our loop speed. Pacing requests
// ~4s apart (and batches ~8s apart) keeps a pass moving instead of spending it
// in backoff. Both were 1.2s/1.5s, which tripped the limiter every third query.
const SEARCH_PACING_MS = 4_000;
const SEARCH_CONTINUE_MS = 8_000;
const SEARCH_EMPTY_STREAK_LIMIT = 6;
// Rate-limit backoff for a search source. The engine's ceiling is per-minute,
// so a blocked query recovers in minutes — sleeping for the source's full
// interval (often 60m) wastes most of the day. Escalate only on repeats.
const SEARCH_BLOCK_BASE_MIN = 3;
const SEARCH_BLOCK_MAX_MIN = 30;
// If a single plan entry blocks this many times in a row without ANY of the
// batch getting through, step over it. A pass must never be held hostage by one
// query the engine refuses to serve.
const SEARCH_BLOCK_SKIP_AFTER = 5;
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

/* ---------------------------- cancellation ----------------------------- */

// A batch is long-lived: a country sweep is dozens of Overpass calls, a
// directory batch is minutes of crawling. Delete / archive / switch-off all
// used to change a DB row and nothing else, so the batch already in flight kept
// running and kept filing leads under a source that no longer existed — the bot
// looked "still active" after you deleted it. Every loop now asks between units
// of work and stops cleanly on the spot.
const stopping = new Set<string>();

// Ask an in-flight batch for this source to stop at its next checkpoint.
export function stopSource(id: string): void {
  if (!id) return;
  stopping.add(id);
}
// Switching the whole bot off stops whatever is mid-flight too.
export function stopAllSources(): void {
  stopping.add("*");
}

// Should the batch for this source stop now? In-memory flag first (instant, and
// covers "deleted a moment ago"), then the DB as the authority — that also
// catches a source removed by another process or before this one restarted.
async function shouldStop(id: string): Promise<boolean> {
  if (stopping.has("*") || stopping.has(id)) return true;
  const row = (await q(`SELECT archived FROM discovery_sources WHERE id=?`, [id]))[0];
  if (!row) return true;                        // deleted
  return Number(row.archived) === 1;            // archived
}
// Called when a batch finishes so the flag doesn't leak into the next run. The
// global "*" flag is deliberately left alone — only switching the bot back on
// lifts that.
function clearStop(id: string): void {
  stopping.delete(id);
}

/* --------------------------- global switches --------------------------- */

export async function isBotEnabled(): Promise<boolean> {
  return (await getSetting("discovery_enabled")) === "1";
}
export async function setBotEnabled(on: boolean): Promise<void> {
  await setSetting("discovery_enabled", on ? "1" : "0");
  // Switching off must also halt whatever batch is already running, or the bot
  // keeps working for minutes after you told it to stop. Switching on lifts it.
  if (on) stopping.delete("*"); else stopAllSources();
  dlog("", `bot switched ${on ? "ON — will start scanning enabled sources" : "OFF — scanning paused (any running batch stops at its next step)"}`);
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
  // rate-limit, timeout) and are still auto-retrying.
  blocked: number;
  // Pending, email-less leads that HAVE a website but were given up on (or predate
  // retry-tracking) — exactly what "Re-check" re-queues. This is the count that
  // makes the recovery button appear, so the historical "no email" pool is
  // actionable even before anything is freshly marked blocked.
  recoverable: number;
  // Whether a scalable Cloudflare bypass is configured, + how often the free
  // reader has been rate-limited — drives the "add a key/proxy" nudge in the UI.
  bypass: { readerKeyed: boolean; proxy: boolean; readerRateLimited: number };
  nextRunAt: string | null;
  lastLeadAt: string | null;
}

export async function getDiscoveryStatus(): Promise<DiscoveryStatus> {
  const srcCount = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovery_sources WHERE archived=0`))[0]?.n ?? 0;
  const activeCount = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovery_sources WHERE enabled=1 AND archived=0`))[0]?.n ?? 0;
  const statusRows = await q(`SELECT status, CAST(count(*) AS INTEGER) AS n FROM discovered_leads GROUP BY status`);
  const withEmail = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE status='pending' AND email IS NOT NULL AND email <> ''`
  ))[0]?.n ?? 0;
  // 'duplicate' rows are bookkeeping — retired markers that stop an already-known
  // company being re-discovered for ever. They are not leads, so they don't count.
  const total = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE status<>'duplicate'`))[0]?.n ?? 0;
  const pendingEnrich = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads
      WHERE status='pending' AND enriched=0 AND (email IS NULL OR email='')
        AND website IS NOT NULL AND website<>''`
  ))[0]?.n ?? 0;
  // Leads still auto-retrying after a block/error (enriched=0 with retry state).
  const blocked = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads
      WHERE status='pending' AND (email IS NULL OR email='')
        AND website IS NOT NULL AND website<>''
        AND enriched=0 AND (enrich_status IN ('blocked','error') OR retry_count > 0)`
  ))[0]?.n ?? 0;
  // Everything "Re-check" would revive: pending, has a website, no email, marked
  // done (enriched=1) either because it was blocked/errored OR because it predates
  // retry-tracking (enrich_status NULL = the historical ~1,000 "no email" pool).
  const recoverable = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads
      WHERE status='pending' AND (email IS NULL OR email='')
        AND website IS NOT NULL AND website<>''
        AND enriched=1
        AND (enrich_status IS NULL OR enrich_status IN ('blocked','error'))`
  ))[0]?.n ?? 0;
  const nextRunAt = (await q(`SELECT min(next_run_at) AS t FROM discovery_sources WHERE enabled=1 AND archived=0`))[0]?.t ?? null;
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
    recoverable,
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
const FREEMAIL_HOSTS = FREEMAIL;

// Embassies, consulates and missions are not companies — nobody is selling to
// them, and they were arriving from every source type. Caught by name here so
// one rule covers map pins, directories and web search alike. "Embassy Suites"
// is a hotel chain, so a hospitality word vetoes the match.
const DIPLOMATIC_EN = /\b(embassy|embassies|consulate|consular|high\s+commission|permanent\s+mission|chancery|ambassade|embajada)\b/i;
const DIPLOMATIC_AR = /سفارة|قنصلية/;
const DIPLOMATIC_FALSE_FRIEND = /\b(suites?|hotel|inn|resort|apartments?|residences?|tower|gardens?|restaurant|caf[eé]|coffee|mall|spa|salon|laundry|bakery)\b/i;
export function isDiplomatic(name?: string | null): boolean {
  const n = String(name || "").trim();
  if (!n) return false;
  if (!DIPLOMATIC_EN.test(n) && !DIPLOMATIC_AR.test(n)) return false;
  return !DIPLOMATIC_FALSE_FRIEND.test(n);
}

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
  phone: string | null; city: string | null; country: string | null; category: string;
  sourceId: string; label: string; enriched: number; confidence: string | null;
}

// Insert one lead if it's genuinely new (not an existing contact, not already in
// the pool). Returns true when a row was added.
async function insertDiscovered(row: LeadRow, dedup: { emails: Set<string>; domains: Set<string> }): Promise<boolean> {
  // Not a company — never worth a pool row, and never worth a crawl.
  if (isDiplomatic(row.name)) return false;
  const email = (row.email || "").trim().toLowerCase();
  const domain = (row.domain || "").trim().toLowerCase();
  if (email && dedup.emails.has(email)) return false;   // already a saved Contact
  if (domain && dedup.domains.has(domain)) return false; // already a Contact's domain
  // Never allow the same email twice in the pool. The dedup_key ("e:<email>")
  // already blocks two directly-listed emails, but a lead that was ENRICHED to
  // this email carries a domain/phone key — so check the email column too.
  if (email) {
    const dupe = (await q(`SELECT id, name FROM discovered_leads WHERE email=? LIMIT 1`, [email]))[0] as any;
    if (dupe) {
      // Self-healing: an older harvest may have stored a phone number (or other
      // junk) where the company name belongs. If we now have a real name for the
      // same lead, upgrade it in place rather than silently keeping the bad one.
      const incoming = String(row.name || "").trim();
      if (incoming && looksLikeName(incoming) && isBadName(dupe.name)) {
        await q(`UPDATE discovered_leads SET name=? WHERE id=?`, [incoming, dupe.id]);
        dlog("dir", `  ~ fixed company name: ${String(dupe.name).trim()} → ${incoming}`);
      }
      return false;
    }
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
// across separate runs. Handles ?page=N, Drupal's multi-pager ?page=0,N,
// /page/N, and a trailing bare number (e.g. /listings/31 → /listings/32);
// otherwise appends ?page=N as a fallback.
function withPage(base: string, page: number): string {
  try {
    const u = new URL(/^https?:\/\//i.test(base) ? base : "https://" + base);
    for (const k of PAGE_KEYS) {
      const v = u.searchParams.get(k);
      if (v == null) continue;
      if (/^\d+$/.test(v)) { u.searchParams.set(k, String(page)); return u.toString(); }
      // Multi-pager: only the slot that actually moves may be written.
      if (/^\d+(?:,\d+)+$/.test(v)) {
        const slots = v.split(",").map(Number);
        slots[activePagerSlot(slots)] = page;
        u.searchParams.set(k, slots.join(","));
        return u.toString();
      }
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

// Query params that carry a page number, and — for Drupal's "?page=0,7" style —
// which slot of a multi-pager is the one that actually moves (see directory.ts).
const PAGE_KEYS = ["page", "paged", "pg", "p", "start", "offset"];
function activePagerSlot(slots: number[]): number {
  for (let i = slots.length - 1; i >= 0; i--) if (slots[i] > 0) return i;
  return slots.length - 1;
}

// Strip any page marker from a URL so it can serve as a clean paging base
// (?page=N, /page/N, and trailing /N are all removed).
function stripPage(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url);
    for (const k of PAGE_KEYS) u.searchParams.delete(k);
    u.pathname = u.pathname.replace(/\/(?:page|p)[-/]\d+\/?$/i, "");
    return u.toString();
  } catch { return url; }
}

// The page number already present in a directory URL, so a source can start
// walking from wherever the user pasted (defaults to 1).
export function initialCursor(base: string): number {
  try {
    const u = new URL(/^https?:\/\//i.test(base) ? base : "https://" + base);
    for (const k of PAGE_KEYS) {
      const v = u.searchParams.get(k);
      if (!v) continue;
      if (/^\d+$/.test(v)) return Math.max(1, Number(v));
      if (/^\d+(?:,\d+)+$/.test(v)) {
        const slots = v.split(",").map(Number);
        return Math.max(1, slots[activePagerSlot(slots)]);
      }
    }
    let m = u.pathname.match(/\/(?:page|p)[-/](\d+)\/?$/i);
    if (m) return Math.max(1, Number(m[1]));
    m = u.pathname.match(/\/(\d+)\/?$/);
    if (m) return Math.max(1, Number(m[1]));
    return 1;
  } catch { return 1; }
}

/* --------------------------- OSM area source --------------------------- */

interface OsmRunResult {
  found: number;      // NEW leads inserted this batch
  seen: number;       // businesses read this batch (new OR already-known)
  error?: string;
  nextCursor: number; // next tile to sweep
  tiles: number;      // tiles in the grid
  available: number;  // contactable businesses OSM holds in the whole area (0 = unknown)
  exhausted: boolean; // the whole grid has been swept
  stopped?: boolean;  // cut short: the source was deleted / archived / switched off
}

// Run one Map-area source. The area is split into a grid and swept a few tiles
// per batch, chaining until the whole country is covered — a single country-wide
// query hits Overpass' output cap and silently truncates, which is why these
// sources used to plateau at a few hundred rows and never grow again.
async function runOsmSource(src: any): Promise<OsmRunResult> {
  const place = safeParse(src.place_json);
  // Take everything the tile holds. A per-tile row cap silently truncated the
  // densest tile — Doha came back at exactly 500, the cap, which is why Qatar
  // reported 54% coverage of a 759-business area. The tile bounds the work; a
  // row limit only ever throws away the capital city.
  const area = await resolveArea(src.location, place);
  const grid = tilesFor(area.bbox);
  const tiles: (Tile | undefined)[] = grid.length ? grid : [undefined]; // no bbox → one whole-area sweep
  const total = tiles.length;

  let cursor = Math.max(1, Number(src.cursor) || 1);
  if (cursor > total) cursor = 1;                       // grid resized, or a fresh pass

  // Once per pass, ask OSM how much it actually has here. This is the number
  // that answers "why isn't it finding more?" — it's a map, and the answer is
  // usually "because that is everything it knows".
  let available = Number(src.osm_available) || 0;
  if (cursor === 1) {
    try {
      available = await countAvailable(area, src.category);
      dlog("osm", `${src.location} · ${src.category}: OpenStreetMap holds ${available.toLocaleString()} contactable business(es) here — that is the ceiling for this source.`);
    } catch { /* coverage is nice-to-have, never fatal */ }
  }

  const dedup = await loadContactDedup();
  const label = `${src.location} · ${src.category}`;
  const end = Math.min(total, cursor + OSM_TILES_PER_RUN - 1);
  let found = 0, seen = 0, err: string | undefined;

  let stoppedAt = 0;
  for (let i = cursor; i <= end; i++) {
    // Deleted / archived / switched off mid-sweep? Stop here, keep the position.
    if (await shouldStop(src.id)) {
      dlog("osm", `${label}: stopped at tile ${i}/${total} — the source was removed or switched off`);
      stoppedAt = i;
      break;
    }
    const tile = tiles[i - 1];
    let companies: Company[] = [];
    try {
      companies = await findLeadsIn(area, src.category, 0, tile);
    } catch (e: any) {
      // One bad tile must not sink the sweep — note it and keep walking.
      err = String(e?.message || e);
      dwarn("osm", `${label}: tile ${i}/${total} failed (${err}) — continuing`);
      continue;
    }
    seen += companies.length;
    let tileNew = 0;
    for (const co of companies) {
      const domain = co.website ? (registrableDomain(hostOf(co.website)) || "") : "";
      const email = (co.email || "").toLowerCase();
      const added = await insertDiscovered({
        name: co.name, website: co.website || null, domain: domain || null, email: email || null,
        phone: co.phone || null, city: co.city || null,
        country: resolveLeadCountry({ sourceCountry: src.location, domain, website: co.website, phone: co.phone }),
        category: src.category,
        sourceId: src.id, label,
        enriched: email ? 1 : 0,          // listed email → no enrichment needed
        confidence: email ? "listed" : null,
      }, dedup);
      if (added) { found++; tileNew++; dlog("osm", `  + ${leadLine(co.name, email, co.phone)}`); }
    }
    dlog("osm", `${label}: tile ${i}/${total} — ${companies.length} business(es) on the map, +${tileNew} new`);
    if (i < end) await sleep(OSM_TILE_PACING_MS);
  }

  // A sweep cut short resumes from the tile it never reached — nothing skipped.
  const nextCursor = stoppedAt || end + 1;
  const exhausted = !stoppedAt && nextCursor > total;
  return {
    found, seen,
    error: err && seen === 0 && found === 0 ? err : undefined,
    nextCursor: exhausted ? 1 : nextCursor,
    tiles: total, available, exhausted,
    stopped: stoppedAt > 0,
  };
}

/* -------------------------- Directory source -------------------------- */

interface DirRunResult {
  found: number;       // NEW leads inserted into the pool this batch
  extracted: number;   // listings actually read this batch (new OR already-known)
  detailPages: number;  // detail/profile pages opened this batch (0 when read inline)
  listingsRead: number; // listings read this batch, inline or via detail pages
  error?: string; okish: boolean; nextCursor: number; pages: number;
  // Did this batch read at least one page? A batch whose very first page was
  // refused made no progress at all, and must not chain straight into another
  // attempt against the same wall.
  progressed: boolean;
  // The EXACT URL the next batch must start from — undefined when the crawler
  // couldn't tell us, null when we walked off the end of the directory.
  nextUrl?: string | null;
}

// Walk ONE batch of a business directory (a few pages), starting where the last
// batch stopped, and insert every new company. This is what scales to tens of
// thousands: a directory lists every business, and we page through it forever.
async function runDirectorySource(src: any): Promise<DirRunResult> {
  const base = String(src.base_url || "").trim();
  const cursor = Math.max(1, Number(src.cursor) || 1);
  if (!base) { derr("dir", "source has no directory URL set — skipping"); return { found: 0, extracted: 0, detailPages: 0, listingsRead: 0, error: "No directory URL set", okish: false, nextCursor: cursor, pages: 0, progressed: false }; }

  const proxy = await getProxyConfig();
  const readerKey = await getReaderKey();
  // Resume from the exact URL the last batch handed back. A page NUMBER can't
  // address every pager: an infinite-scroll Drupal view pages with "?page=0,7"
  // and silently ignores "?page=7", so a number-only cursor re-read page 1 on
  // every batch and the source declared itself finished after 3 duplicate runs.
  const resume = String(src.next_url || "").trim();
  const seed = resume || withPage(base, cursor);
  // Keep the displayed page honest: when we resume by URL, the page number the
  // site itself uses is in that URL — trust it over the counter we carried.
  const startCursor = resume ? Math.max(cursor, initialCursor(resume)) : cursor;

  const opts: DirectoryOptions = {
    maxPages: DIRECTORY_PAGES_PER_RUN,
    // Stop between pages once the batch has captured enough listings…
    maxListings: DIRECTORY_LISTINGS_PER_RUN,
    // …but never truncate a page half-read: the resume point is a whole page, so
    // a hard cap below (pages × listings-per-page) would skip the remainder.
    maxDetails: Math.max(clamp(src.limit_n, 20, 300), DIRECTORY_PAGES_PER_RUN * 40),
    concurrency: proxy ? 3 : 5,
    respectRobots: true,
    checkMx: true,
    defaultCountry: String(src.location || "").trim() || undefined,
    proxy,
    readerKey,
    // Abandon the walk the moment this source is deleted / archived / paused,
    // instead of crawling on for minutes under a source that no longer exists.
    shouldStop: () => shouldStop(src.id),
  };

  const how = proxy ? `scraping proxy (${proxy.provider})` : readerKey ? "free reader (keyed)" : "direct fetch + free reader fallback";
  dlog("dir", `crawling ${shortUrl(seed)} — page ${startCursor}, up to ${DIRECTORY_PAGES_PER_RUN} page(s) / ${DIRECTORY_LISTINGS_PER_RUN} listing(s) · ${how}`);

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
  let resolvedFromCursor = startCursor;
  if (result.resolvedSeed) {
    const resolvedBase = stripPage(result.resolvedSeed);
    if (resolvedBase && resolvedBase !== base) {
      await q(`UPDATE discovery_sources SET base_url=? WHERE id=?`, [resolvedBase, src.id]);
      resolvedFromCursor = 1;
      dlog("dir", `auto-detected the real listings index → ${shortUrl(resolvedBase)} (saved · walking from page 1)`);
    }
  }

  dlog("dir", `batch result: ${result.status.toUpperCase()} · ${result.listingPages} page(s) walked · ${result.listingsRead} listing(s) read · ${result.contacts.length} contact(s) extracted`);
  // A note can also arrive on an "ok" run — e.g. the walk was cut short by a
  // rate-limit wall — so surface it whenever the crawler bothered to write one.
  if (result.note) {
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
      phone: co.phone || null, city: null,
      country: resolveLeadCountry({ sourceCountry: src.location, domain, website, phone: co.phone }),
      category: src.category || "",
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
  // switched to a freshly-resolved index) by the number of pages we actually
  // READ — not the number we attempted. A page a bot wall refused must be tried
  // again next batch, otherwise its companies are skipped for good and the
  // directory can never be walked to completion.
  const read = Math.max(0, result.pagesRead || 0);
  const nextCursor = okish ? resolvedFromCursor + read : resolvedFromCursor;
  if (okish && read < pages) {
    dwarn("dir", `↳ ${pages - read} page(s) were refused — resuming from page ${nextCursor} next batch so nothing is skipped.`);
  }
  // A freshly-resolved index invalidates any resume URL we were carrying.
  const nextUrl = result.resolvedSeed && resolvedFromCursor === 1 ? undefined : result.nextUrl;
  const error = blocked ? (result.note || result.status) : undefined;
  const progressed = okish && read > 0;
  return { found, extracted: result.contacts.length, detailPages: result.detailPages, listingsRead: result.listingsRead, error, okish, nextCursor, pages, nextUrl, progressed };
}

/* --------------------------- Web-search source ------------------------- */
// The scalable, "works like a Google search" source. OpenStreetMap is a map
// (a few hundred tagged businesses per country); a web search sees the whole
// web. We generate many targeted queries (industry phrasings × the country and
// its major cities), page through each, and stream every real company site into
// the pool for the email-finder to enrich. Runs entirely on the free reader.

// Industry → the search phrases that actually surface individual company sites.
//
// The rule every entry here obeys: a phrase must be one that ONLY AN OPERATING
// COMPANY can rank for. Head terms like "companies", "suppliers" or
// "establishment" fail that test — nobody optimises their own homepage for
// "companies Qatar", so page one is wall-to-wall directories, "top 30" listicles
// and company-formation agencies. That single mistake is what filled the pool
// with entries like "A Comprehensive Guide to Company Formation in Qatar".
// Long-tail trade phrases ("MEP contractor", "steel fabrication") are the
// opposite: the only pages that rank are the firms that do the work.
const SEARCH_KEYWORDS: Record<string, string[]> = {
  // Deliberately NOT the word "companies". A general sweep is a portfolio of
  // specific trades — plus the Gulf legal suffixes ("W.L.L.", "Trading &
  // Contracting"), which appear in the <title> of real firms and almost nowhere
  // else.
  "Companies (general)": [
    "trading and contracting W.L.L.",
    "general trading est",
    "MEP contractor",
    "electromechanical company",
    "steel fabrication",
    "facilities management company",
    "industrial supplies",
    "manufacturing factory",
    "logistics and freight company",
    "IT solutions provider",
  ],
  "Accounting & Tax": ["accounting firm", "audit firm", "tax consultants", "chartered accountants", "bookkeeping services"],
  "IT & Software": ["IT company", "software company", "IT solutions", "technology company", "IT services provider"],
  "Construction & Contracting": ["construction company", "contracting company", "building contractor", "civil contractor", "general contracting"],
  "Consulting": ["consulting firm", "management consultants", "business consultants", "consultancy"],
  "Engineering": ["engineering company", "engineering consultants", "MEP contractor", "electromechanical company"],
  "Real Estate": ["real estate company", "property management company", "real estate developers", "real estate agency"],
  "Legal": ["law firm", "legal consultants", "advocates and legal consultants", "attorneys"],
  "Logistics & Transport": ["logistics company", "freight forwarders", "shipping company", "transport company", "cargo services"],
  "Advertising & Marketing": ["advertising agency", "marketing agency", "digital marketing company", "branding agency"],
  "Insurance": ["insurance company", "insurance brokers", "takaful company"],
  "Healthcare & Clinics": ["medical clinic", "polyclinic", "medical center", "hospital", "pharmacy"],
  "Hospitality & Food": ["catering company", "restaurant", "hotel", "hospitality company"],
  "Manufacturing & Industrial": ["manufacturing company", "factory", "industrial company", "manufacturer", "fabrication company"],
  "Education & Training": ["training institute", "training center", "academy", "educational institute"],
  "Trading & Retail": ["trading company", "trading establishment", "distributors", "wholesale company"],
};

// Major cities per country, so a country-wide search fans out into local ones —
// where individual company sites (not "top 10" articles) actually rank.
const COUNTRY_CITIES: Record<string, string[]> = {
  "saudi arabia": ["Riyadh", "Jeddah", "Dammam", "Mecca", "Medina", "Al Khobar", "Dhahran", "Jubail", "Yanbu", "Tabuk", "Abha", "Taif", "Buraidah", "Hail", "Najran", "Jizan"],
  "united arab emirates": ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Al Ain", "Ras Al Khaimah", "Fujairah", "Umm Al Quwain"],
  "qatar": ["Doha", "Al Rayyan", "Al Wakrah", "Al Khor", "Lusail", "Umm Salal"],
  "kuwait": ["Kuwait City", "Hawalli", "Salmiya", "Al Ahmadi", "Al Jahra", "Farwaniya"],
  "bahrain": ["Manama", "Riffa", "Muharraq", "Hamad Town", "Isa Town", "Sitra"],
  "oman": ["Muscat", "Salalah", "Sohar", "Sur", "Nizwa", "Seeb"],
  "egypt": ["Cairo", "Alexandria", "Giza", "Port Said", "Suez", "Mansoura", "Tanta"],
  "jordan": ["Amman", "Zarqa", "Irbid", "Aqaba", "Russeifa"],
  "lebanon": ["Beirut", "Tripoli", "Sidon", "Tyre", "Zahle"],
  "iraq": ["Baghdad", "Basra", "Erbil", "Mosul", "Najaf", "Karbala"],
  "india": ["Mumbai", "Delhi", "Bangalore", "Chennai", "Hyderabad", "Pune", "Ahmedabad", "Kolkata"],
  "pakistan": ["Karachi", "Lahore", "Islamabad", "Faisalabad", "Rawalpindi"],
  "turkey": ["Istanbul", "Ankara", "Izmir", "Bursa", "Antalya"],
};

// Country name synonyms so "KSA"/"UAE" map to the right city list.
const COUNTRY_ALIASES: Record<string, string> = {
  ksa: "saudi arabia", uae: "united arab emirates", emirates: "united arab emirates",
};

// Country-code top-level domains. A "site:.qa" query returns Qatari domains and
// nothing else — the highest-precision slice of the web there is for a country,
// and immune to the homonym problem entirely.
const COUNTRY_TLD: Record<string, string> = {
  "saudi arabia": "sa", "united arab emirates": "ae", qatar: "qa", kuwait: "kw",
  bahrain: "bh", oman: "om", egypt: "eg", jordan: "jo", lebanon: "lb", iraq: "iq",
  india: "in", pakistan: "pk", turkey: "tr",
};

function normCountry(location: string): string {
  const k = (location || "").trim().toLowerCase();
  return COUNTRY_ALIASES[k] || k;
}

function searchKeywordsFor(category: string, custom?: string | null): string[] {
  const typed = String(custom || "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (typed.length) return [...new Set(typed)].slice(0, 8);
  return SEARCH_KEYWORDS[category] || SEARCH_KEYWORDS["Companies (general)"];
}

// Cities to fan out into for a location. Only expand when the location is a
// whole country we know; if the user gave a single city we search just that.
function citiesFor(location: string): string[] {
  const key = normCountry(location);
  const cities = COUNTRY_CITIES[key];
  if (!cities) return [];
  // If they typed one of the cities as the "country", don't fan out.
  if (cities.some((c) => c.toLowerCase() === (location || "").trim().toLowerCase())) return [];
  return cities;
}

// The ordered (query, page) plan the cursor walks. Country-wide queries first
// (broad), then each city (individual firms), each across a couple of result
// pages. De-duplicated and capped so a single walk stays bounded.
function buildSearchPlan(keywords: string[], location: string): { q: string; offset: number }[] {
  const loc = (location || "").trim();
  const cities = citiesFor(loc);
  const seen = new Set<string>();
  const plan: { q: string; offset: number }[] = [];
  const push = (v: string) => {
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    for (const offset of SEARCH_PAGES) plan.push({ q: v, offset });
  };

  const tld = COUNTRY_TLD[normCountry(loc)];
  for (const kw of keywords) {
    if (!loc) { push(kw); push(`${kw} contact`); continue; }

    // Country-wide. "<trade> <place>" finds the firms; "… contact" pushes the
    // engine towards their contact page, which is where the address lives.
    push(`${kw} ${loc}`);
    push(`${kw} ${loc} contact`);
    // The country's own TLD — every result is in-country by definition.
    if (tld) push(`${kw} site:.${tld}`);

    // Per city. The city ALWAYS carries its country: half the Gulf's city names
    // are also American towns, so "MEP contractor Medina" returned contractors
    // in Medina, Ohio, and "steel fabrication Hail" returned hail-damage repair
    // firms in Texas. "… Medina Saudi Arabia" cannot be misread.
    for (const city of cities) {
      push(`${kw} ${city} ${loc}`);
      push(`${kw} ${city} ${loc} contact`);
    }
  }
  return plan.slice(0, 800);
}

interface SearchRunResult {
  found: number;      // NEW company leads inserted this batch
  extracted: number;  // company sites seen this batch (new OR already-known)
  searches: number;   // result pages actually fetched this batch
  covered: number;    // plan entries consumed (fetched OR deliberately skipped)
  error?: string;
  okish: boolean;     // the search engine responded (not blocked)
  blocked: boolean;   // stopped on a rate limit, not a real failure
  nextCursor: number; // where to resume in the plan
  exhausted: boolean; // walked to the end of the plan (a full pass finished)
  planLen: number;
}

// Walk ONE batch of a web-search source: a few queries from the plan, insert
// every new company site (email-less → enrichTick crawls it for the address).
async function runSearchSource(src: any): Promise<SearchRunResult> {
  const location = String(src.location || "").trim();
  const keywords = searchKeywordsFor(src.category, src.keywords);
  const plan = buildSearchPlan(keywords, location);
  const planLen = plan.length;
  if (!planLen) {
    return { found: 0, extracted: 0, searches: 0, covered: 0, error: "Add a country/city or some keywords", okish: false, blocked: false, nextCursor: 1, exhausted: true, planLen: 0 };
  }

  // Resume from the cursor; when a previous pass finished (or the plan shrank),
  // start a fresh pass so an hourly source keeps finding newly-published sites.
  let cursor = Math.max(1, Number(src.cursor) || 1);
  if (Number(src.exhausted) === 1 || cursor > planLen) cursor = 1;
  const start = cursor - 1;
  const batch = plan.slice(start, start + SEARCH_QUERIES_PER_RUN);

  const readerKey = await getReaderKey();
  // Routed to only when the direct fetch AND the reader are both walled — the
  // proxy rotates IPs, so it turns a dead pass into a moving one.
  const proxy = await getProxyConfig();
  const dedup = await loadContactDedup();
  const label = src.category && src.category !== "Companies (general)"
    ? `${location || "web"} · ${src.category}`
    : (location || "web search");
  const how = readerKey ? "web search (reader, keyed)" : "web search (free reader)";
  dlog("search", `${label} — step ${cursor}/${planLen} · ${batch.length} quer${batch.length === 1 ? "y" : "ies"} · ${how}`);

  let found = 0, extracted = 0, ok = 0, covered = 0, blocked = false, stopped = false, err: string | undefined;
  // Page 2 of a query whose page 1 was entirely already-known sites is almost
  // always more of the same. Skipping it halves the request rate — which is what
  // trips the search engine's limiter in the first place.
  let prevQuery = "", prevNew = 0, prevRan = false;
  for (const item of batch) {
    // Deleted / archived / switched off mid-batch? Stop, keeping the position.
    if (await shouldStop(src.id)) {
      dlog("search", `${label}: stopped at step ${cursor + covered} — the source was removed or switched off`);
      stopped = true; // not a rate limit — no backoff, and nothing to resume
      break;
    }
    if (item.offset > 0 && prevRan && item.q === prevQuery && prevNew === 0) {
      covered++;
      dlog("search", `  · "${item.q}" p${item.offset / 30 + 1} skipped — page 1 was all sites we already have`);
      continue;
    }
    const r = await searchCompaniesPaged(item.q, item.offset, 40, readerKey, location, proxy).catch(() => ({ companies: [], blocked: true }));
    if (r.blocked) {
      blocked = true;
      err = readerKey
        ? "the search engine rate-limited us — pausing, then resuming from this exact query"
        : "web search was blocked (add a free JINA key in Settings → Crawler to search at full speed)";
      dwarn("search", `  ✗ "${item.q}"${item.offset ? ` p${item.offset / 30 + 1}` : ""} — rate-limited, will resume here`);
      break;
    }
    ok++;
    covered++;
    let batchFound = 0;
    for (const co of r.companies) {
      const website = (co.website || "").trim();
      const domain = website ? (registrableDomain(hostOf(website)) || "") : "";
      if (!domain) continue;
      extracted++;
      const added = await insertDiscovered({
        name: co.name, website, domain, email: null,
        phone: null, city: null,
        country: resolveLeadCountry({ sourceCountry: location, domain, website }),
        category: src.category || "",
        sourceId: src.id, label,
        enriched: 0,            // web search gives the site, not the email → enrich it
        confidence: null,
      }, dedup);
      if (added) { found++; batchFound++; }
    }
    prevQuery = item.q; prevNew = batchFound; prevRan = true;
    dlog("search", `  · "${item.q}"${item.offset ? ` p${item.offset / 30 + 1}` : ""} → ${r.companies.length} site(s), +${batchFound} new`);
    await sleep(SEARCH_PACING_MS);
  }

  const nextCursor = cursor + covered;
  const exhausted = !blocked && !stopped && covered > 0 && nextCursor > planLen;
  return { found, extracted, searches: ok, covered, error: err, okish: !blocked && !stopped, blocked, nextCursor, exhausted, planLen };
}

/* ------------------------------ scheduling ---------------------------- */

// Run + persist the outcome for a single source. `continue` = run again on the
// very next tick (directory sources stream continuously until exhausted).
async function executeSource(src: any): Promise<{ found: number; error?: string; continue: boolean; continueMs?: number }> {
  try {
    return await runBatch(src);
  } finally {
    // Whatever happened, this source's stop request has been honoured — drop it
    // so a later run (or a restored source) isn't blocked by a stale flag.
    clearStop(src.id);
  }
}

async function runBatch(src: any): Promise<{ found: number; error?: string; continue: boolean; continueMs?: number }> {
  // Never start a batch for a source that's already gone. Between the tick's
  // SELECT and here, it may have been deleted, archived or switched off.
  if (await shouldStop(src.id)) {
    dlog("", `skipping ${srcLabel(src)} — it was removed or switched off`);
    return { found: 0, continue: false };
  }
  await q(`UPDATE discovery_sources SET last_status='running' WHERE id=?`, [src.id]);
  const interval = clamp(src.interval_minutes, 15, 100000);
  dlog("", `▶ running ${src.type} source: ${srcLabel(src)}`);

  if (src.type === "directory") {
    let r: DirRunResult;
    try {
      r = await runDirectorySource(src);
    } catch (e: any) {
      r = { found: 0, extracted: 0, detailPages: 0, listingsRead: 0, error: String(e?.message || e), okish: false, nextCursor: Number(src.cursor) || 1, pages: 0, progressed: false };
    }

    // Decide "end of directory" by whether this batch actually READ listing cards,
    // NOT by whether they were new. A page full of businesses we already have
    // (found=0 but extracted>0) is NOT the end — otherwise re-scanning a directory
    // we've already harvested would die after 3 duplicate pages and never re-walk
    // the whole thing. Only a batch that opened no detail pages and pulled nothing
    // real (a lone footer email leaks 1) counts toward the empty streak.
    // "Productive" = this batch actually produced companies. Past the end of a
    // directory, paging usually keeps returning a valid-looking shell (the same
    // handful of cards on every page), which the chrome filter correctly strips
    // to nothing — so listings-read must NOT count as progress, only real
    // contacts can. Otherwise the walk never terminates.
    const productive = r.extracted >= 2;
    let streak = Number(src.empty_streak) || 0;
    let exhausted = false;
    let cursor = Number(src.cursor) || 1;
    // The exact page the next batch resumes from. `null` from the crawler means
    // the last page it read advertised no successor — that IS the end of the
    // list, and it's a far more reliable signal than counting thin pages.
    let nextUrl: string | null = r.nextUrl === undefined ? String(src.next_url || "") || null : r.nextUrl;
    const walkedOff = !r.error && r.okish && r.nextUrl === null;
    // No page was read at all = the very first page of the batch was refused.
    // Chaining straight into another attempt would just hammer the wall, so fall
    // back to the normal interval and let the block expire.
    const stalled = !r.error && r.okish && !r.progressed;
    if (!r.error && r.okish) {
      cursor = r.nextCursor;                       // move on, even through thin pages
      // A batch that was blocked told us nothing about the end of the list.
      if (!stalled) {
        streak = productive ? 0 : streak + 1;
        exhausted = walkedOff || streak >= EMPTY_STREAK_LIMIT; // genuinely off the end
      }
    }
    // A finished walk starts over from the top next time it's kicked.
    if (exhausted) nextUrl = null;
    const cont = !r.error && !exhausted && !stalled; // keep streaming while there's more
    const next = cont ? nowIso() : new Date(Date.now() + interval * 60000).toISOString();
    const status = r.error ? "error" : exhausted ? "done" : "ok";
    await q(
      `UPDATE discovery_sources
         SET last_run_at=?, next_run_at=?, last_status=?, last_error=?, runs=runs+1,
             total_found=total_found+?, cursor=?, exhausted=?, empty_streak=?, next_url=?
       WHERE id=?`,
      [nowIso(), next, status, r.error || null, r.found, cursor, exhausted ? 1 : 0, exhausted ? 0 : streak, nextUrl, src.id]
    );
    if (r.error) derr("dir", `${srcLabel(src)}: ERROR — ${r.error} (will retry in ${interval}m)`);
    else if (exhausted) dlog("dir", `${srcLabel(src)}: FINISHED — walked to the end of the directory (${walkedOff ? "the last page had no next page" : `${EMPTY_STREAK_LIMIT} pages with no more listings`}); re-checking in ${interval}m. Click "Run now" to re-scan for new listings.`);
    else if (stalled) dwarn("dir", `${srcLabel(src)}: the site refused page ${cursor} — pausing ${interval}m so the block clears, then resuming from that exact page (nothing skipped).`);
    else if (cont) dlog("dir", `${srcLabel(src)}: continuing to page ${cursor} in ${Math.round(DIRECTORY_CONTINUE_MS / 1000)}s${r.extracted > 0 && r.found === 0 ? ` (page's ${r.extracted} listing(s) already known — still walking to the end)` : ""}`);
    return { found: r.found, error: r.error, continue: cont };
  }

  // Web-search source (keywords × cities). Streams like a directory: walk a few
  // queries per batch, chain the next batch quickly, until a full pass finishes.
  if (src.type === "search") {
    let r: SearchRunResult;
    try {
      r = await runSearchSource(src);
    } catch (e: any) {
      r = { found: 0, extracted: 0, searches: 0, covered: 0, error: String(e?.message || e), okish: false, blocked: false, nextCursor: Number(src.cursor) || 1, exhausted: false, planLen: 0 };
    }
    const productive = r.found > 0;
    let streak = Number(src.empty_streak) || 0;
    let cursor = Number(src.cursor) || 1;
    let exhausted = false;
    // KEEP THE GROUND THIS BATCH COVERED, even if it ended on a rate limit.
    // runSearchSource only advances past queries that actually ran, so the
    // blocked query is still next up. Discarding the cursor here meant a source
    // re-ran the two queries that had already succeeded, hit the same limit on
    // the third, and never moved — it sat on one step for 16 hours.
    if (r.covered > 0) cursor = r.nextCursor;
    if (!r.error && r.okish) {
      streak = productive ? 0 : streak + 1;
      exhausted = r.exhausted || streak >= SEARCH_EMPTY_STREAK_LIMIT; // full pass, or all-dupes
    }
    // A rate limit clears in minutes, so back off in minutes and escalate only
    // if it keeps happening. Any progress at all resets the escalation.
    let blockStreak = Number(src.block_streak) || 0;
    let steppedOver = false;
    if (r.blocked) {
      blockStreak = r.covered > 0 ? 1 : blockStreak + 1;
      if (r.covered === 0 && blockStreak >= SEARCH_BLOCK_SKIP_AFTER) {
        cursor = r.nextCursor + 1; // r.nextCursor == the query that keeps failing
        blockStreak = 0;
        steppedOver = true;
      }
    } else if (!r.error) blockStreak = 0;
    const pauseMin = r.blocked && !steppedOver
      ? Math.min(SEARCH_BLOCK_MAX_MIN, SEARCH_BLOCK_BASE_MIN * 2 ** Math.max(0, blockStreak - 1))
      : interval;
    const cont = !r.error && !exhausted;
    const next = cont ? nowIso() : new Date(Date.now() + (steppedOver ? SEARCH_BLOCK_BASE_MIN : pauseMin) * 60000).toISOString();
    const status = r.error ? "error" : exhausted ? "done" : "ok";
    await q(
      `UPDATE discovery_sources
         SET last_run_at=?, next_run_at=?, last_status=?, last_error=?, runs=runs+1,
             total_found=total_found+?, cursor=?, exhausted=?, empty_streak=?, block_streak=?
       WHERE id=?`,
      [nowIso(), next, status, r.error || null, r.found, cursor, exhausted ? 1 : 0, exhausted ? 0 : streak, blockStreak, src.id]
    );
    if (steppedOver) dwarn("search", `${srcLabel(src)}: step ${r.nextCursor} was refused ${SEARCH_BLOCK_SKIP_AFTER} times running — skipping it and resuming at step ${cursor}${r.planLen ? `/${r.planLen}` : ""} in ${SEARCH_BLOCK_BASE_MIN}m`);
    else if (r.blocked) dwarn("search", `${srcLabel(src)}: ${r.error}${r.covered ? ` — kept the ${r.covered} quer${r.covered === 1 ? "y" : "ies"} it did cover (now at step ${cursor}${r.planLen ? `/${r.planLen}` : ""})` : ""} · resuming in ${pauseMin}m`);
    else if (r.error) derr("search", `${srcLabel(src)}: ${r.error} (retry in ${interval}m)`);
    else if (exhausted) dlog("search", `${srcLabel(src)}: FINISHED a full pass${r.planLen ? ` (${r.planLen} queries)` : ""} — re-searching in ${interval}m for newly-published sites. Click "Run now" to re-search now.`);
    else if (cont) dlog("search", `${srcLabel(src)}: +${r.found} new · continuing (step ${cursor}${r.planLen ? `/${r.planLen}` : ""}) in ${Math.round(SEARCH_CONTINUE_MS / 1000)}s`);
    return { found: r.found, error: r.error, continue: cont, continueMs: SEARCH_CONTINUE_MS };
  }

  // Map-area (OSM) source — sweeps its grid a few tiles per batch, chaining
  // until the whole area is covered, then rests until the next interval.
  let r: OsmRunResult;
  try {
    r = await runOsmSource(src);
  } catch (e: any) {
    r = { found: 0, seen: 0, error: String(e?.message || e), nextCursor: Number(src.cursor) || 1, tiles: Number(src.osm_tiles) || 0, available: Number(src.osm_available) || 0, exhausted: false };
  }
  const cont = !r.error && !r.exhausted && !r.stopped;
  const next = cont ? nowIso() : new Date(Date.now() + interval * 60000).toISOString();
  const status = r.error ? "error" : r.exhausted ? "done" : "ok";
  await q(
    `UPDATE discovery_sources
       SET last_run_at=?, next_run_at=?, last_status=?, last_error=?, runs=runs+1,
           total_found=total_found+?, cursor=?, exhausted=?, osm_tiles=?, osm_available=?
     WHERE id=?`,
    [nowIso(), next, status, r.error || null, r.found, r.error ? (Number(src.cursor) || 1) : r.nextCursor,
     r.exhausted ? 1 : 0, r.tiles, r.available, src.id]
  );
  if (r.error) derr("osm", `${srcLabel(src)}: ERROR — ${r.error} (next scan in ${interval}m)`);
  else if (r.exhausted) {
    // A finished sweep is the normal, healthy end state — not a stall. Say how
    // complete it is so "it only found 60" is never a mystery again.
    const have = await osmHarvested(src.id);
    const pct = r.available > 0 ? Math.min(100, Math.round((have / r.available) * 100)) : null;
    dlog("osm", `${srcLabel(src)}: SWEPT the whole area (${r.tiles} tile${r.tiles === 1 ? "" : "s"}) — ${have.toLocaleString()}${r.available ? ` of the ${r.available.toLocaleString()} businesses OpenStreetMap has here${pct !== null ? ` (${pct}%)` : ""}` : ""}. Re-checking in ${interval}m for newly-mapped ones. For more volume than the map holds, add a Web search or Directory source.`);
  } else if (r.stopped) dlog("osm", `${srcLabel(src)}: stopped · +${r.found} new before it halted`);
  else dlog("osm", `${srcLabel(src)}: +${r.found} new · continuing at tile ${r.nextCursor}/${r.tiles} in ${Math.round(DIRECTORY_CONTINUE_MS / 1000)}s`);
  return { found: r.found, error: r.error, continue: cont };
}

// How many leads this Map-area source has actually put in the pool (lifetime),
// used to report coverage against what OSM holds.
async function osmHarvested(sourceId: string): Promise<number> {
  const row = (await q(`SELECT COUNT(*) AS n FROM discovered_leads WHERE source_id=?`, [sourceId]))[0] as any;
  return Number(row?.n) || 0;
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
    if (restart) {
      await q(`UPDATE discovery_sources SET exhausted=0, empty_streak=0, cursor=?, next_url=NULL WHERE id=?`, [cursor, id]);
      src.next_url = null;
    } else {
      await q(`UPDATE discovery_sources SET exhausted=0, empty_streak=0, cursor=? WHERE id=?`, [cursor, id]);
    }
    src.exhausted = 0; src.empty_streak = 0; src.cursor = cursor;
    if (restart) dlog("dir", `re-scanning ${srcLabel(src)} from page ${cursor} — re-checking every listing for anything new`);
  } else if (src.type === "search") {
    // A kick on a finished search re-runs the whole query plan from the top so
    // any newly-published sites get picked up; mid-walk just resumes.
    const restart = Number(src.exhausted) === 1;
    const cursor = restart ? 1 : (Number(src.cursor) || 1);
    await q(`UPDATE discovery_sources SET exhausted=0, empty_streak=0, cursor=? WHERE id=?`, [cursor, id]);
    src.exhausted = 0; src.empty_streak = 0; src.cursor = cursor;
    if (restart) dlog("search", `re-searching ${srcLabel(src)} from the top — checking every query again for new sites`);
  } else {
    // Map area: a kick on a finished sweep starts the grid again from tile 1 so
    // anything newly mapped is picked up; mid-sweep it just resumes.
    const restart = Number(src.exhausted) === 1;
    const cursor = restart ? 1 : (Number(src.cursor) || 1);
    await q(`UPDATE discovery_sources SET exhausted=0, cursor=? WHERE id=?`, [cursor, id]);
    src.exhausted = 0; src.cursor = cursor;
    if (restart) dlog("osm", `re-sweeping ${srcLabel(src)} from tile 1 — re-checking the whole area for newly-mapped businesses`);
  }
  const r = await executeSource(src);
  // Keep streaming a directory in the background after a manual kick.
  if (r.continue) setTimeout(() => discoveryTick().catch(() => {}), r.continueMs ?? DIRECTORY_CONTINUE_MS);
  return { found: r.found, error: r.error };
}

/* ------------------------------ enrichment ----------------------------- */

// Best deliverable email from a crawled site: prefer an address on the site's
// own domain, and a personal mailbox over a role inbox.
// The brand part of a domain — "k108hotel.com" → "k108hotel" — with punctuation
// stripped so "retaj-realestate" and "retajrealestate" compare equal.
function brandLabel(domain: string): string {
  return (domain || "").toLowerCase().split(".")[0].replace(/[^a-z0-9]/g, "");
}
// Same company, different domain? Covers a brand's other TLD (k108hotel.com →
// k108hotel.qa) and a sister domain (retaj-realestate.com → retaj.com).
function sameBrand(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.includes(a)) return true;
  if (b.length >= 4 && a.includes(b)) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 6; // a long shared prefix — "alsamriyaestate" / "alsamriyariding"
}

/**
 * Pick the address that actually belongs to the company whose site we crawled.
 *
 * This used to take ANY address on the page when it found none on the site's own
 * domain, which is how a McDonald's branch ended up filed as
 * `than@restaurants.delivery` and Nobu Doha as an address in Cape Town: a
 * delivery widget, a partner or an agency credit sitting in the footer. Worse,
 * the "own domain" test compared FoundEmail.domain — which holds the SITE's
 * domain, identical on every hit — so it never actually filtered anything.
 *
 * Now the email's own domain decides, and a third party's domain is refused
 * outright. No email is far better than the wrong company's email, because the
 * wrong one gets written to.
 */
export function pickSiteEmail(emails: FoundEmail[], siteDomain?: string | null): { email: string; role_based: boolean } | null {
  if (!emails?.length) return null;
  const site = registrableDomain((siteDomain || "").toLowerCase()) || (siteDomain || "").toLowerCase();
  const siteBrand = brandLabel(site);

  const ranked: { e: FoundEmail; rank: number }[] = [];
  for (const e of emails) {
    const mailDomain = registrableDomain((e.email.split("@")[1] || "").toLowerCase()) || "";
    if (!mailDomain) continue;
    let rank: number;
    if (site && mailDomain === site) rank = 0;                              // the company's own address
    else if (sameBrand(siteBrand, brandLabel(mailDomain))) rank = 1;        // same brand, other domain
    else if (FREEMAIL_HOSTS.has(mailDomain)) rank = 2;                      // small firm on gmail — plausible
    else continue;                                                          // someone else's domain — refuse
    ranked.push({ e, rank });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => a.rank - b.rank || Number(a.e.role_based) - Number(b.e.role_based));
  return { email: ranked[0].e.email, role_based: ranked[0].e.role_based };
}

/* -------------------------------- ticks -------------------------------- */

async function discoveryTick(): Promise<void> {
  if (discovering) return;
  if (!(await isBotEnabled())) return;
  discovering = true;
  let keepStreaming = false;
  let chainMs = DIRECTORY_CONTINUE_MS;
  try {
    const now = nowIso();
    // Most-overdue enabled source (a null next_run_at = never run = due now).
    // Archived sources are invisible to the bot — that's what archiving means.
    const src = (await q(
      `SELECT * FROM discovery_sources
        WHERE enabled=1 AND archived=0 AND (next_run_at IS NULL OR next_run_at <= ?)
        ORDER BY (next_run_at IS NULL) DESC, next_run_at ASC
        LIMIT 1`,
      [now]
    ))[0];
    if (!src) return;
    const r = await executeSource(src);
    keepStreaming = r.continue;
    chainMs = r.continueMs ?? DIRECTORY_CONTINUE_MS;
  } finally {
    discovering = false;
  }
  // Directory sources stream continuously: chain the next batch quickly instead
  // of waiting the full tick, so a big directory pours in fast (but politely).
  // Search sources chain slower — the engine's limiter, not our loop, is the cap.
  if (keepStreaming) setTimeout(() => discoveryTick().catch((e) => derr("", `discovery tick failed: ${String(e?.message || e)}`)), chainMs);
}

async function enrichTick(): Promise<void> {
  if (enriching) return;
  if (!(await isBotEnabled())) return;
  if (!(await autoEnrichOn())) return;
  enriching = true;
  let more = false;
  try {
    const now = nowIso();

    // Tier 1 — leads that already have a site. Cheapest work and by far the
    // likeliest to yield an address, so they always fill the batch first.
    // Fresh leads (next_enrich_at NULL) go before retried ones, so a wall of
    // blocked leads never starves newly-discovered ones.
    const withSite = (await q(
      `SELECT * FROM discovered_leads
        WHERE status='pending' AND enriched=0 AND (email IS NULL OR email='')
          AND website IS NOT NULL AND website<>''
          AND (next_enrich_at IS NULL OR next_enrich_at <= ?)
        ORDER BY (next_enrich_at IS NULL) DESC, next_enrich_at ASC, created_at ASC
        LIMIT ?`,
      [now, ENRICH_BATCH]
    )) as any[];

    // Tier 2 — a NAME and a phone but no website at all. OpenStreetMap and
    // directories list a phone for many more businesses than they list a site,
    // so these are the majority of any real pool — and with nothing to crawl
    // they'd sit there for ever, permanently un-emailable. Find their site by
    // searching the web, then crawl that. Only tops up whatever tier 1 left
    // free, so a huge no-site tail can never starve a crawlable lead.
    const room = ENRICH_BATCH - withSite.length;
    const noSite =
      room > 0
        ? ((await q(
            `SELECT * FROM discovered_leads
              WHERE status='pending' AND enriched=0 AND (email IS NULL OR email='')
                AND (website IS NULL OR website='')
                AND name IS NOT NULL AND name<>''
                AND (enrich_status IS NULL OR enrich_status<>'no-site')
                AND (next_enrich_at IS NULL OR next_enrich_at <= ?)
              ORDER BY (next_enrich_at IS NULL) DESC, next_enrich_at ASC, created_at ASC
              LIMIT ?`,
            [now, room]
          )) as any[])
        : [];

    const batch = [
      ...withSite.map((lead) => ({ lead, needsSite: false })),
      ...noSite.map((lead) => ({ lead, needsSite: true })),
    ];
    if (!batch.length) return;

    // Read the shared settings once per batch, not once per lead.
    const proxy = await getProxyConfig();
    const readerKey = await getReaderKey();

    // Work the batch a few at a time. Nearly all of a lead's wall-clock time is
    // waiting on a remote server, so running several fills that dead air rather
    // than adding load — and the reader has its own global pacer (500ms/call
    // with a key), which stays the real throttle no matter how many run here.
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < batch.length) {
        const item = batch[cursor++];
        try {
          await enrichOne(item.lead, item.needsSite, proxy, readerKey);
        } catch (e: any) {
          derr("enrich", `"${item.lead.name || item.lead.domain}" failed: ${String(e?.message || e)}`);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(ENRICH_CONCURRENCY, batch.length) }, () => worker())
    );
    more = batch.length >= ENRICH_BATCH;
  } finally {
    enriching = false;
  }
  // Still work queued? Go straight on instead of idling until the next tick.
  // One-lead-per-tick spent ~85% of its time waiting rather than crawling.
  if (more) setTimeout(() => { enrichTick().catch(() => {}); }, ENRICH_CHAIN_MS);
}

/** Find the email for one lead. Every exit path settles the row's enrich state. */
async function enrichOne(
  lead: any,
  needsSite: boolean,
  proxy: Awaited<ReturnType<typeof getProxyConfig>>,
  readerKey: Awaited<ReturnType<typeof getReaderKey>>
): Promise<void> {
  if (needsSite) {
    const company = String(lead.name || "").trim();
    // Only search for something that reads like a company. A phone number or
    // a bare domain that slipped into the name column would just burn search
    // budget on nonsense.
    if (!looksLikeName(company) || isBadName(company) || /^[\d\s+()-]+$/.test(company)) {
      await q(`UPDATE discovered_leads SET enriched=1, enrich_status='no-site', next_enrich_at=NULL WHERE id=?`, [lead.id]);
      return;
    }
    dlog("enrich", `no website on file for "${company}" — searching the web for its site`);
    const hit = await resolveWebsite(company, String(lead.country || "")).catch(() => null);
    if (!hit) {
      await q(`UPDATE discovered_leads SET enriched=1, enrich_status='no-site', next_enrich_at=NULL WHERE id=?`, [lead.id]);
      dlog("enrich", `  ✗ no website found for "${company}" — it stays a phone-only lead`);
      return;
    }
    await q(`UPDATE discovered_leads SET website=?, domain=? WHERE id=?`, [hit.website, hit.domain, lead.id]);
    lead.website = hit.website;
    lead.domain = hit.domain;
    dlog("enrich", `  → ${shortUrl(hit.website)} — crawling it for an email`);
  }

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

  // A social/profile page is not the company's site. Crawling one never yields
  // a company address, and because Facebook blocks bots it would burn all six
  // retries doing it. Retire the lead's URL instead of chasing it.
  const leadHost = hostOf(String(lead.website || "")).replace(/^www\./i, "");
  if (leadHost && !isCompanySiteHost(leadHost)) {
    await q(
      `UPDATE discovered_leads SET website=NULL, domain=NULL, enriched=0, retry_count=0,
           enrich_status=NULL, next_enrich_at=NULL WHERE id=?`,
      [lead.id]
    );
    dlog("enrich", `  ~ ${leadHost} is a social page, not a company site — cleared it; the web search will look for the real one`);
    return;
  }

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
    // Guard against duplicates: this address is already a saved Contact, or
    // already sits on another pool row, so this lead is redundant.
    const asContact = (await q(`SELECT 1 FROM contacts WHERE email=? LIMIT 1`, [email]))[0];
    const inPool = (await q(`SELECT id FROM discovered_leads WHERE email=? AND id<>? LIMIT 1`, [email, lead.id]))[0];
    if (asContact || inPool) {
      await retireDuplicate(lead, phone, email);
      return;
    }
    // Promote the dedup_key to the email so any FUTURE lead carrying it collides
    // on the unique key and is skipped. enriched=1 so we never re-crawl it.
    //
    // Two leads in the same batch can land on the same address at the same
    // moment, and dedup_key is UNIQUE — so a conflict here is a duplicate that
    // the SELECT above simply couldn't see yet. Retire it like any other.
    try {
      await q(
        `UPDATE discovered_leads
            SET enriched=1, email=?, phone=?, confidence=?, dedup_key=?, enrich_status='found', next_enrich_at=NULL
          WHERE id=?`,
        [email, phone, confidence, "e:" + email, lead.id]
      );
    } catch {
      await retireDuplicate(lead, phone, email);
      return;
    }
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
}

// DON'T delete a duplicate. Deleting frees the dedup_key, so the source that
// found this company simply finds it again on its next pass, we crawl it again,
// and delete it again — a loop that consumed the entire enrichment budget
// re-discovering companies we already had.
//
// Retire the row in place instead. `status='duplicate'` keeps it out of every
// tab and out of the enrichment queue, while its dedup_key stays put and blocks
// the re-insert for good. The email column stays empty so the pool's
// one-row-per-address rule still holds.
async function retireDuplicate(lead: any, phone: string | null, email: string): Promise<void> {
  await q(
    `UPDATE discovered_leads
        SET status='duplicate', enriched=1, enrich_status='duplicate',
            next_enrich_at=NULL, phone=?
      WHERE id=?`,
    [phone, lead.id]
  );
  dlog("enrich", `  = ${email} already in your list — retired "${lead.name || lead.domain}" so it stops being re-found`);
}

/* --------------------------- one-off cleanups -------------------------- */

// Retire embassies and consulates already sitting in the pool from before they
// were excluded. Rejected rather than deleted: they leave Pending but stay in
// the Rejected tab, so nothing is destroyed and the call can be undone.
export async function rejectDiplomaticLeads(): Promise<number> {
  const rows = await q(
    `SELECT id, name FROM discovered_leads
      WHERE status='pending' AND name IS NOT NULL AND name <> ''
        AND (lower(name) LIKE '%embassy%' OR lower(name) LIKE '%consulate%'
          OR lower(name) LIKE '%high commission%' OR lower(name) LIKE '%ambassade%'
          OR name LIKE '%سفارة%' OR name LIKE '%قنصلية%')`
  );
  const ids = rows.filter((r: any) => isDiplomatic(r.name)).map((r: any) => r.id);
  if (!ids.length) return 0;
  // Chunked so a big pool never builds an oversized statement.
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    await q(`UPDATE discovered_leads SET status='rejected' WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk);
  }
  dlog("", `retired ${ids.length} embassy/consulate lead(s) into Rejected — they are not companies`);
  return ids.length;
}

// Retire leads that are directories, job boards, classifieds and data brokers
// rather than companies — chamberofcommerce.com, jooble.org, micompanyregistry
// .com and friends. They can never be a prospect, and because they all sit
// behind Cloudflare they were re-queued for ever, consuming crawl slots that
// real companies needed. Rejected, not deleted, so the call is reversible.
export async function rejectAggregatorLeads(): Promise<number> {
  const rows = await q(
    `SELECT id, domain, website FROM discovered_leads
      WHERE status='pending' AND (domain IS NOT NULL OR website IS NOT NULL)`
  );
  const ids: string[] = [];
  for (const r of rows as any[]) {
    const host = String(r.domain || hostOf(String(r.website || "")) || "").toLowerCase();
    if (host && CONTENT_BLOCK.test(host)) ids.push(r.id);
  }
  if (!ids.length) return 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    await q(`UPDATE discovered_leads SET status='rejected' WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk);
  }
  dlog("", `retired ${ids.length} directory/job-board/classified lead(s) into Rejected — they are not companies`);
  return ids.length;
}

// Retire what the old generic queries dragged in: company-formation agencies,
// regulators, and pages that are ARTICLES about companies ("Company Setup in
// Qatar", "The 30 Most Valuable Companies In Qatar"). Rejected, not deleted —
// they stay reviewable in the Rejected tab and nothing is destroyed.
export async function rejectContentLeads(): Promise<number> {
  const rows = await q(
    `SELECT id, name, domain, website FROM discovered_leads WHERE status='pending'`
  );
  const ids: string[] = [];
  for (const r of rows as any[]) {
    const host = String(r.domain || hostOf(String(r.website || "")) || "").toLowerCase();
    if ((host && (SETUP_BLOCK.test(host) || OFFICIAL_BLOCK.test(host))) || isContentTitle(String(r.name || ""))) {
      ids.push(r.id);
    }
  }
  if (!ids.length) return 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    await q(`UPDATE discovered_leads SET status='rejected' WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk);
  }
  dlog("", `retired ${ids.length} lead(s) that were articles, directories, formation agencies or regulators — not companies`);
  return ids.length;
}

// Addresses that picked up the markup they were scraped from and are therefore
// unmailable. RFC 5321 allows "/" and "%" in a local part, so these all passed
// the old syntax check and were filed as real contacts:
//   mailto://info@x.com    → "//info@x.com"
//   mailto:%20info@x.com   → "%20info@x.com"
//   \u003einfo@x.com       → "u003einfo@x.com"
// cleanEmail() now strips the glue at extraction time; this un-mangles the rows
// that were saved before it did. Anything that cannot be salvaged is retired
// rather than left in the pool pretending to be a contact.
export async function repairEscapedEmails(): Promise<number> {
  const rows = await q(
    `SELECT id, email FROM discovered_leads
      WHERE email IS NOT NULL AND email <> ''
        AND (email LIKE '%/%'
          OR email LIKE '%$\\%' ESCAPE '$'
          OR email LIKE '%$%%' ESCAPE '$'
          OR email LIKE '% %'
          OR email LIKE '%<%'
          OR email LIKE '%>%'
          OR email LIKE '%"%'
          OR email LIKE '%=%'
          OR email LIKE '%:%'
          OR email LIKE '.%'
          OR email LIKE '-%'
          OR email LIKE 'u003e%'
          OR email LIKE 'u0026%'
          OR email LIKE 'x3e%')`
  );
  let fixed = 0;
  let dropped = 0;
  for (const r of rows as any[]) {
    const original = String(r.email || "");
    const cleaned = cleanEmail(original);
    if (cleaned && cleaned === original) continue; // already fine
    if (!cleaned || !isValidEmail(cleaned)) {
      // Nothing mailable in there — clear the address and send the lead back
      // through enrichment instead of keeping a dead contact.
      await q(
        `UPDATE discovered_leads SET email=NULL, confidence=NULL, enriched=0,
             retry_count=0, enrich_status=NULL, next_enrich_at=NULL,
             status=CASE WHEN status='found' THEN 'pending' ELSE status END
           WHERE id=?`,
        [r.id]
      );
      dropped++;
      dlog("", `  email: "${original}" is unsalvageable — cleared, lead re-queued`);
      continue;
    }
    // The cleaned address may already be on another row; drop this one if so.
    const clash = (await q(`SELECT id FROM discovered_leads WHERE email=? AND id<>? LIMIT 1`, [cleaned, r.id]))[0];
    if (clash) { await q(`UPDATE discovered_leads SET status='duplicate' WHERE id=?`, [r.id]); continue; }
    await q(`UPDATE discovered_leads SET email=?, dedup_key=? WHERE id=?`, [cleaned, "e:" + cleaned, r.id]);
    fixed++;
    dlog("", `  email: "${original}" → "${cleaned}"`);
  }
  if (fixed) dlog("", `repaired ${fixed} email(s) that had markup glued to the address`);
  if (dropped) dlog("", `cleared ${dropped} unsalvageable address(es)`);
  return fixed + dropped;
}

// Leads saved before result titles were parsed still carry the raw page
// headline as their company name — "FCCSA - Home", "Homepage - Anmatt Al-Amar
// Construction Co Ltd. | Construction and ...". Rewrite only the ones that are
// demonstrably a page title, so a real name containing a dash is never touched.
const LOOKS_LIKE_PAGE_TITLE =
  /(^|\s[|\-–—]\s)(home|homepage|home page|welcome|official (web)?site|website|contact us|about us|index)(\s[|\-–—]\s|$)/i;
// A name still carrying the street address or the SEO category phrase the title
// printed after it — "… Inc, 712 County Road 4026, Lampasas, TX 76550".
const LOOKS_LIKE_TITLE_TAIL = /,\s*(?:p\.?o\.?\s*box|\d+\s+\w)|,\s*[\w\s]+,\s*(?:[A-Z]{2}\s*\d|\d{4,})|,\s*[\w\s]*\b(?:company|companies|contractors?)\b/i;
export async function repairPageTitleNames(): Promise<number> {
  const rows = await q(
    `SELECT id, name, domain FROM discovered_leads
      WHERE status='pending' AND name IS NOT NULL AND name <> ''
        AND (name LIKE '%|%' OR name LIKE '% - %' OR name LIKE '%...' OR name LIKE '%,%')`
  );
  let fixed = 0;
  for (const r of rows as any[]) {
    const current = String(r.name || "");
    // Only obvious page titles: a boilerplate segment, a truncated headline, or
    // a name with an address / category phrase still hanging off the end.
    if (
      !LOOKS_LIKE_PAGE_TITLE.test(current) &&
      !LOOKS_LIKE_TITLE_TAIL.test(current) &&
      !current.trimEnd().endsWith("...")
    ) continue;
    const better = companyNameFromTitle(current, String(r.domain || ""));
    if (!better || better === current || better.length < 2) continue;
    await q(`UPDATE discovered_leads SET name=? WHERE id=?`, [better, r.id]);
    fixed++;
    dlog("", `  name: "${current.slice(0, 60)}" → "${better}"`);
  }
  if (fixed) dlog("", `cleaned ${fixed} company name(s) that were page titles`);
  return fixed;
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
      const active = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovery_sources WHERE enabled=1 AND archived=0`))[0]?.n ?? 0;
      const auto = await autoEnrichOn();
      dlog("", `state → bot ${on ? "ON" : "OFF"} · ${active} enabled source(s) · auto-find-emails ${auto ? "ON" : "OFF"}`);
      // Say plainly whether the reader is keyed. Without this line the only way
      // to know whether a Jina key took effect is to guess from block messages.
      const [key, prox] = await Promise.all([getReaderKey(), getProxyConfig()]);
      dlog(
        "",
        key
          ? `reader → Jina key ACTIVE (${READER_RPM_KEYED_HINT}/min, 25x the free tier)${prox ? ` · scraping proxy: ${prox.provider}` : ""}`
          : `reader → free tier, NO Jina key (20/min). Add one free at jina.ai/api-dashboard → Settings → Crawler.${prox ? ` Scraping proxy: ${prox.provider}` : ""}`
      );
      if (!on) dwarn("", "bot is OFF — turn it on in the Discovery screen to start scanning.");
      else if (!active) dwarn("", "bot is ON but no sources are enabled — enable a source in the Discovery screen.");
    } catch { /* ignore */ }
  })();
}
