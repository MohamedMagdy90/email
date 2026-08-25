// Always-on, server-side company discovery bot.
//
// Runs independently of any browser session: while the server process is up, it
// cycles through your "sources" (location + industry), finds NEW companies via
// free OpenStreetMap data, optionally crawls each one for a real email, and
// drops them into a reviewable pool (discovered_leads). You approve → they
// become Contacts. All state lives in the DB, so it survives restarts.

import {
  q, nowIso, getSetting, setSetting, getContactEmails,
  claimPoolDomain, closePoolDomain, backfillPoolDomains,
  loadSaturatedQueries, recordQueryYield,
} from "./db";
import { findLeadsIn, resolveArea, tilesFor, countAvailable, isCompanySite as isCompanySiteHost, type Company, type Tile } from "./leads";
import {
  searchCompaniesDeep,
  CONTENT_BLOCK,
  SETUP_BLOCK,
  OFFICIAL_BLOCK,
  isContentTitle,
  companyNameFromTitle,
  isNonProspectHost,
  domainLooksForeign,
} from "./search";
import { crawlSite, type CrawlOptions, type FoundEmail } from "./crawler";
import { ccHostsForPattern, ccPageCount } from "./crawler/archives";
import { crawlDirectory, looksLikeName, type DirectoryOptions } from "./crawler/directory";
import { isBadName, nameFromDomain } from "./repair";
import { resolveWebsite } from "./enrich";
import { registrableDomain, hostOf } from "./crawler/urls";
import { countryFromDomain, normalizeCountry, resolveLeadCountry } from "./country";
import { getReaderStats, parseReaderKeys } from "./crawler/fetcher";
import { getProxyConfig, getReaderKey } from "./config";
import { cleanEmail, isValidEmail, roleRank, isFreeMailDomain, FREEMAIL_DOMAINS } from "./crawler/validate";
import { citiesFor, COUNTRY_TLD, normCountry } from "./places";

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
  const who = audienceOf(src) === "partner" ? " [partner]" : "";
  if (src?.type === "directory") return (shortUrl(src.base_url) || "directory") + who;
  if (src?.type === "search") return `search · ${src?.location || "web"} · ${src?.category || "?"}${who}`;
  return `${src?.location || "?"} · ${src?.category || "?"}${who}`;
}

// Who this source is hunting. Sources created before the tag existed have no
// value stored, and the app has always been customer-first — so they stay
// customers rather than silently becoming partner prospects.
function audienceOf(src: any): "customer" | "partner" {
  return String(src?.audience || "").trim().toLowerCase() === "partner" ? "partner" : "customer";
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
// STALE: a source that has COMPLETED this many runs in a row without adding a
// single new lead has stopped paying for itself and wants replacing. Two is the
// threshold because one barren run is normal (a directory page of companies we
// already hold, a search step that only returned known sites) — twice running
// is a pattern.
export const STALE_AFTER_RUNS = 2;
// …and after this many it is switched OFF. Flagging a spent source but leaving
// it running means it keeps spending the crawl budget, the rate-limit headroom
// and the reader quota on ground it has already covered — every barren run is
// taken from a source that would have found someone. Two thresholds rather than
// one so there is a warning before the action: flagged at 2, off at 4.
export const STALE_OFF_AFTER_RUNS = 4;
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
// A plan entry is ONE QUERY, not one (query, page) pair. It used to be the
// latter, with pages [0, 30] — but measured against every engine in the pool,
// `&s=30` (DuckDuckGo) and `&first=31` (Bing) both return page ONE again, and
// Brave refused any offset in code. So half of every plan re-fetched results we
// already had, and when the two page-one engines were resting the whole pool
// declined and the batch recorded a rate limit for a page that never existed.
//
// Depth now lives inside `searchCompaniesDeep`, which pulls as many pages as
// the engine that actually answered will serve — four on Brave, measured at 69
// unique domains against 20 for its first page alone.
const SEARCH_QUERIES_PER_RUN = 5;
const SEARCH_MAX_PAGES = 4;
// Politeness is now measured PER ENGINE inside search.ts (Bing 1s, Brave 2.5s,
// DuckDuckGo 4s), so this is just breathing room between plan entries rather
// than the throttle it used to be. It was 4s for every engine, which made the
// one engine that never rate-limits us wait out the quota of the one that does.
const SEARCH_PACING_MS = 1_200;
const SEARCH_CONTINUE_MS = 4_000;
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
// A HARD wall is not transient. A Cloudflare managed challenge or a 403 WAF
// will refuse a plain datacenter fetch today, in five minutes and in three
// days — retrying it on the full ladder is six guaranteed-wasted multi-page
// crawls each. In one production hour that was the single largest consumer of
// the crawl budget. Two attempts is enough to rule out a blip; after that the
// lead is parked as 'blocked', which loses nothing: "Re-check" resurrects
// exactly these rows the moment a working key or a proxy is added.
const ENRICH_HARD_MAX_RETRIES = 2;
const ENRICH_HARD_BACKOFF_MS = [30 * 60_000, 6 * 3_600_000];
const HARD_BLOCK_REASONS = new Set(["cloudflare", "forbidden"]);
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
  // WHEN it was switched on, so the fill rate can measure over the time the bot
  // was actually allowed to fill. Without this, turning the bot on after a
  // weekend off reads as "zero leads in the last three hours" — a true
  // statement about a window that includes three hours of being switched off,
  // which would light the card red for the whole first window.
  if (on) await setSetting("discovery_enabled_at", nowIso());
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

/* --------------------------- manual recovery --------------------------- */

/**
 * "Re-check emails" — and the reason it used to be a loop.
 *
 * `enrichOne` parks a lead it has given up on as
 *   `enriched=1, enrich_status='blocked'|'error', next_enrich_at=NULL`
 * and that was ALSO exactly what the recovery tool selected on. The marker
 * meaning "we gave up" therefore doubled as "please try me again": a press
 * re-queued the same rows, spent up to six crawls each proving the same wall
 * was still there, parked them with an identical status, and left the badge
 * reading the number it started with. Nothing recorded that a pass had run.
 *
 * These three predicates are the fix, and they live together on purpose: the
 * COUNT on the badge and the UPDATE behind the button read the same text, so
 * the button can never again offer a number it cannot actually deliver.
 */
const PARKED_SQL = `status='pending' AND (email IS NULL OR email='')
        AND website IS NOT NULL AND website<>''
        AND enriched=1
        AND (enrich_status IS NULL OR enrich_status IN ('blocked','error'))`;

/** Of those, the ones a re-check could still plausibly change. Params: [maxPasses, fingerprint]. */
const RECHECKABLE_SQL = `${PARKED_SQL}
        AND (recheck_count < ? OR recheck_key IS NULL OR recheck_key <> ?)`;

/** …and the ones it demonstrably cannot, under the current setup. Params: [maxPasses, fingerprint]. */
const EXHAUSTED_SQL = `${PARKED_SQL}
        AND recheck_count >= ? AND recheck_key = ?`;

/**
 * Manual recovery passes a lead gets per bypass configuration.
 *
 * ONE, deliberately. By the time a lead is parked the automatic ladder has
 * already tried it 2 times (a hard Cloudflare/403 wall) or 6 times with backoff
 * out to 72 hours (a soft 429/timeout/5xx) — so the transient case has been
 * thoroughly ruled out before a human ever sees the button. A hand-pressed pass
 * adds one more attempt for luck; a second one from the same IP with the same
 * key is the definition of doing the same thing and expecting a different
 * result, and at 166 leads it costs several hundred crawls to learn nothing.
 *
 * The counter is not a life sentence: `bypassFingerprint()` re-arms every
 * parked lead the moment the operator changes something that could change the
 * answer.
 */
const RECHECK_MAX_PASSES = 1;

/**
 * A short digest of the crawler's bypass capability.
 *
 * Deliberately built from the CONFIGURATION (which keys are saved, which proxy)
 * rather than from live health. A key that has run out of tokens does not mean
 * re-crawling is worth another try — nothing the operator did changed — whereas
 * adding a key, removing one, or wiring up a proxy genuinely does. Hashed so a
 * lead row never carries a fragment of an API key.
 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
async function bypassFingerprint(): Promise<string> {
  const [proxy, readerKey] = await Promise.all([getProxyConfig(), getReaderKey()]);
  const keys = parseReaderKeys(readerKey).slice().sort().join(",");
  return fnv1a(`k:${keys}|p:${proxy ? `${proxy.provider}:${proxy.mode}:${proxy.premium ? 1 : 0}` : "none"}`);
}

/* ------------------------------- status -------------------------------- */

export interface DiscoveryStatus {
  enabled: boolean;
  autoEnrich: boolean;
  sources: number;
  activeSources: number;
  // Sources that have completed STALE_AFTER_RUNS runs in a row without adding a
  // single new lead — spent ground, worth replacing. Archived ones don't count:
  // they're already retired.
  staleSources: number;
  staleAfterRuns: number;
  staleOffAfterRuns: number;
  leads: { pending: number; approved: number; rejected: number; withEmail: number; total: number };
  pendingEnrich: number;
  // Pending, email-less leads whose last crawl was BLOCKED/errored (Cloudflare,
  // rate-limit, timeout) and are still auto-retrying.
  blocked: number;
  // Pending, email-less leads that HAVE a website but were given up on (or predate
  // retry-tracking), AND that a re-check could still plausibly change — exactly
  // what "Re-check" re-queues. Once a lead has been through a manual pass under
  // the current bypass setup it drops out of here and into `stuck`, which is
  // what stops the button re-arming its own queue for ever.
  recoverable: number;
  // Parked leads a re-check has already been spent on without the answer
  // changing. Not lost — adding a Jina key or a proxy re-arms every one of them
  // — but pressing the button again today cannot help, and saying so is the
  // whole point of counting them separately.
  stuck: number;
  // When the last manual recovery pass ran, so a disabled button can explain
  // itself rather than just going grey.
  lastRecheckAt: string | null;
  // Whether a scalable Cloudflare bypass is configured, + how often the free
  // reader has been rate-limited — drives the "add a key/proxy" nudge in the UI.
  bypass: {
    readerKeyed: boolean;
    proxy: boolean;
    readerRateLimited: number;
    // A key STRING in settings is not the same as a WORKING key. Production
    // ran for hours on the 15/min free tier while the header still read
    // "Jina key active · 120 pages/min", because the badge only tested whether
    // the setting was non-empty. These report what the fetcher actually knows.
    readerKeysConfigured: number;
    readerKeysLive: number;
    readerKeyRejected: boolean;
  };
  nextRunAt: string | null;
  lastLeadAt: string | null;
}

export async function getDiscoveryStatus(): Promise<DiscoveryStatus> {
  const srcCount = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovery_sources WHERE archived=0`))[0]?.n ?? 0;
  const activeCount = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovery_sources WHERE enabled=1 AND archived=0`))[0]?.n ?? 0;
  const staleCount = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM discovery_sources WHERE archived=0 AND barren_runs >= ?`,
    [STALE_AFTER_RUNS]
  ))[0]?.n ?? 0;
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
  // retry-tracking (enrich_status NULL = the historical ~1,000 "no email" pool)
  // — MINUS the ones a pass has already been spent on under this exact bypass
  // setup, which is what used to make this number immovable.
  const fp = await bypassFingerprint();
  const recoverable = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE ${RECHECKABLE_SQL}`,
    [RECHECK_MAX_PASSES, fp]
  ))[0]?.n ?? 0;
  const stuckRow = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS n, max(recheck_at) AS t
       FROM discovered_leads WHERE ${EXHAUSTED_SQL}`,
    [RECHECK_MAX_PASSES, fp]
  ))[0] || {};
  const nextRunAt = (await q(`SELECT min(next_run_at) AS t FROM discovery_sources WHERE enabled=1 AND archived=0`))[0]?.t ?? null;
  const lastLeadAt = (await q(`SELECT max(created_at) AS t FROM discovered_leads`))[0]?.t ?? null;

  const map: Record<string, number> = {};
  for (const r of statusRows) map[String(r.status)] = Number(r.n);

  const [proxy, readerKey] = await Promise.all([getProxyConfig(), getReaderKey()]);
  const rstats = getReaderStats(parseReaderKeys(readerKey));

  return {
    enabled: await isBotEnabled(),
    autoEnrich: await autoEnrichOn(),
    sources: srcCount,
    activeSources: activeCount,
    staleSources: staleCount,
    staleAfterRuns: STALE_AFTER_RUNS,
    staleOffAfterRuns: STALE_OFF_AFTER_RUNS,
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
    stuck: Number(stuckRow.n) || 0,
    lastRecheckAt: (stuckRow.t as string) ?? null,
    bypass: {
      readerKeyed: !!readerKey,
      proxy: !!proxy,
      readerRateLimited: rstats.rateLimited,
      // A key STRING in settings is not the same as a WORKING key. Production
      // ran for hours on the 15/min free tier while the header still read
      // "Jina key active · 120 pages/min", because the badge only tested whether
      // the setting was non-empty. These report what the fetcher actually knows.
      readerKeysConfigured: rstats.keysConfigured,
      readerKeysLive: rstats.keysLive,
      readerKeyRejected: rstats.keyRejected,
    },
    nextRunAt,
    lastLeadAt,
  };
}

/* ---------------------------- discovery run ---------------------------- */

const onlyDigits = (s?: string | null) => (s || "").replace(/\D/g, "");

// Free-mail providers are NOT a company's own domain — dozens of unrelated
// businesses share gmail.com/hotmail.com, so we never dedupe or classify by
// them. The list itself lives in `crawler/validate` (a leaf module) so this,
// `leads.ts` and `repair.ts` all read the same one.
const isFreeMail = isFreeMailDomain;
const FREEMAIL_HOSTS = FREEMAIL_DOMAINS;

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
  // 'customer' | 'partner' — copied from the source, so the lead already knows
  // which pitch it will get long before anybody approves it.
  audience: string;
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
  // A host that can never be a prospect (aggregator, job board, regulator,
  // data broker) must not enter the pool at all — it costs a full crawl plus
  // six retries to discover what this one regex already knows.
  if (row.website) {
    const host = hostOf(row.website).replace(/^www\./i, "");
    if (host && isNonProspectHost(host)) return false;
  }
  if (domain && domainLooksForeign(domain, String(row.country || ""))) return false;

  // CLAIM the domain permanently. dedup_key can't hold this line on its own:
  // once enrichment finds an address we promote the key to "e:<email>", which
  // frees "d:<domain>" and lets the very next search re-insert the same site.
  // That single gap made roughly one crawl in five a re-crawl of a domain we
  // had already resolved. The claim outlives the lead row, so approving or
  // retiring a lead can never make its domain crawlable again.
  if (domain && !(await claimPoolDomain(domain))) return false;

  const key = dedupKey({ domain, email, phone: row.phone, name: row.name, city: row.city });
  const now = nowIso();
  const rows = await q(
    `INSERT INTO discovered_leads
      (id,dedup_key,name,website,domain,email,phone,city,country,category,audience,source_id,source_label,status,enriched,confidence,via,created_at,email_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?, NULL, ?, ?)
     ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
    [
      uid(), key,
      row.name || domain || email || "Unknown",
      row.website, domain || null, email || null,
      row.phone, row.city, row.country, row.category, row.audience || "customer",
      row.sourceId, row.label, row.enriched, row.confidence, now,
      // A listing that already carries an address is emailable the instant it
      // lands, so it counts toward the fill rate NOW. One that doesn't is
      // stamped later, by the crawl that finds the address.
      email ? now : null,
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
        audience: audienceOf(src),
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
      audience: audienceOf(src),
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
//
// A NOTE ON SIZE. These lists are long on purpose. Every engine in the free
// pool returns 10-20 results for a query and only one of them paginates, so the
// number of DISTINCT queries is the ceiling on how much of a country a search
// source can ever see. Ten phrases against a country with tens of thousands of
// companies is not a rate problem that more patience fixes — it is a reach
// problem, and the only cure is more phrases, each naming a trade narrow enough
// that the firms doing it are what ranks.
const SEARCH_KEYWORDS: Record<string, string[]> = {
  // Deliberately NOT the word "companies". A general sweep is a portfolio of
  // specific trades — plus the Gulf legal suffixes ("W.L.L.", "Trading &
  // Contracting"), which appear in the <title> of real firms and almost nowhere
  // else.
  "Companies (general)": [
    "trading and contracting W.L.L.",
    "general trading est",
    "trading and services company",
    "MEP contractor",
    "electromechanical company",
    "steel fabrication",
    "aluminium and glass works",
    "civil construction company",
    "interior fit out contractor",
    "joinery and carpentry works",
    "facilities management company",
    "cleaning and maintenance services",
    "manpower supply company",
    "security services company",
    "industrial supplies",
    "safety equipment supplier",
    "building materials supplier",
    "hardware and tools trading",
    "electrical equipment supplier",
    "plumbing materials supplier",
    "HVAC contracting company",
    "fire fighting and alarm systems",
    "manufacturing factory",
    "plastic products factory",
    "furniture factory",
    "food processing company",
    "packaging materials company",
    "printing press company",
    "logistics and freight company",
    "shipping and clearing agents",
    "transport and heavy equipment rental",
    "car rental and leasing company",
    "IT solutions provider",
    "software development company",
    "medical equipment supplier",
    "laboratory equipment supplier",
    "chemicals and lubricants trading",
    "oilfield services company",
    "agriculture and landscaping company",
    "event management company",
  ],
  "Accounting & Tax": [
    "accounting firm", "audit firm", "tax consultants", "chartered accountants", "bookkeeping services",
    "auditors and accountants", "VAT consultants", "payroll services company", "financial advisory firm",
    "corporate tax advisors", "internal audit services", "accounting and auditing office",
  ],
  "IT & Software": [
    "IT company", "software company", "IT solutions", "technology company", "IT services provider",
    "software development company", "web design company", "mobile app development company",
    "ERP implementation partner", "IT infrastructure company", "network solutions provider",
    "cyber security company", "cloud services provider", "IT support and AMC services",
    "system integrator", "data center solutions",
  ],
  "Construction & Contracting": [
    "construction company", "contracting company", "building contractor", "civil contractor", "general contracting",
    "MEP contractor", "road construction company", "infrastructure contractor", "steel structure contractor",
    "interior fit out contractor", "landscaping contractor", "piling and foundation contractor",
    "waterproofing and insulation contractor", "demolition and excavation contractor",
    "painting and finishing contractor", "aluminium and glass contractor", "HVAC contracting company",
    "electrical contracting company", "plumbing contracting company", "turnkey projects contractor",
  ],
  "Consulting": [
    "consulting firm", "management consultants", "business consultants", "consultancy",
    "HR consultancy", "engineering consultancy office", "ISO certification consultants",
    "feasibility study consultants", "project management consultancy", "recruitment consultancy",
    "environmental consultants", "quality management consultants",
  ],
  "Engineering": [
    "engineering company", "engineering consultants", "MEP contractor", "electromechanical company",
    "mechanical engineering company", "electrical engineering company", "civil engineering consultants",
    "architectural and engineering consultants", "structural engineering consultants",
    "instrumentation and control company", "automation and control systems", "surveying company",
    "testing and inspection services", "calibration services company",
  ],
  "Real Estate": [
    "real estate company", "property management company", "real estate developers", "real estate agency",
    "property brokers", "facility and property services", "real estate investment company",
    "villa and apartment rentals company", "property valuation company", "owners association management",
  ],
  "Legal": [
    "law firm", "legal consultants", "advocates and legal consultants", "attorneys",
    "law office", "corporate law firm", "arbitration and litigation lawyers",
    "intellectual property law firm", "notary and legal translation office",
  ],
  "Logistics & Transport": [
    "logistics company", "freight forwarders", "shipping company", "transport company", "cargo services",
    "customs clearance company", "warehousing and distribution company", "sea freight and air freight company",
    "land transport company", "courier and delivery company", "cold chain logistics company",
    "heavy equipment transport company", "relocation and moving company", "supply chain solutions company",
  ],
  "Advertising & Marketing": [
    "advertising agency", "marketing agency", "digital marketing company", "branding agency",
    "signage and printing company", "media production company", "public relations agency",
    "exhibition stand contractor", "event management company", "social media marketing agency",
    "SEO agency", "creative design studio",
  ],
  "Insurance": [
    "insurance company", "insurance brokers", "takaful company", "insurance agency",
    "medical insurance brokers", "motor insurance company", "reinsurance company", "loss adjusters",
  ],
  "Healthcare & Clinics": [
    "medical clinic", "polyclinic", "medical center", "hospital", "pharmacy",
    "dental clinic", "diagnostic laboratory", "physiotherapy center", "dermatology and cosmetic clinic",
    "optical and eye care center", "home healthcare services", "veterinary clinic",
    "medical equipment supplier", "pharmaceutical distributor",
  ],
  "Hospitality & Food": [
    "catering company", "restaurant", "hotel", "hospitality company",
    "hotel apartments", "coffee shop and bakery", "food trading company", "foodstuff supplier",
    "kitchen equipment supplier", "cloud kitchen company", "banquet and event catering",
    "facilities catering and camp services",
  ],
  "Manufacturing & Industrial": [
    "manufacturing company", "factory", "industrial company", "manufacturer", "fabrication company",
    "steel fabrication factory", "plastic products factory", "cable manufacturing company",
    "cement and concrete products factory", "paint manufacturing company", "chemical manufacturing company",
    "furniture manufacturing factory", "packaging factory", "garment factory",
    "aluminium extrusion factory", "pipe and fittings factory", "electrical panel manufacturer",
  ],
  "Education & Training": [
    "training institute", "training center", "academy", "educational institute",
    "language institute", "vocational training center", "professional training provider",
    "driving school", "nursery and kindergarten", "private school", "tutoring center",
    "safety training institute",
  ],
  "Trading & Retail": [
    "trading company", "trading establishment", "distributors", "wholesale company",
    "general trading LLC", "import and export company", "authorised distributor",
    "spare parts trading company", "electronics trading company", "stationery and office supplies",
    "textile trading company", "food and beverage distributor", "auto parts supplier",
    "retail chain company",
  ],
};

/* ------------------------------------------------------------------------
 * Where a search is looking now lives in `places.ts`, because `search.ts`
 * needs the identical answer to decide whether a RESULT is in that place. Two
 * copies of this table is how a query says "Qatar" and the verifier disagrees.
 * ---------------------------------------------------------------------- */

function searchKeywordsFor(category: string, custom?: string | null): string[] {
  const typed = String(custom || "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (typed.length) return [...new Set(typed)].slice(0, 8);
  return SEARCH_KEYWORDS[category] || SEARCH_KEYWORDS["Companies (general)"];
}

/**
 * The ordered plan of QUERIES the cursor walks. Country-wide first (broad),
 * then each city (individual firms). De-duplicated and capped so a single walk
 * stays bounded.
 *
 * One entry is one query, not one (query, page) pair. Depth is pulled inside
 * the step by `searchCompaniesDeep`, because only the answering engine knows
 * how deep it can go — see SEARCH_MAX_PAGES.
 *
 * ⛔ WHAT IS DELIBERATELY NOT HERE: the `"<kw> <place> contact"` variant, which
 * used to be half of every plan. Measured against Bing's RSS endpoint — the one
 * engine that answers every time, so the one that serves most of a real pass —
 * `"MEP contractor" Qatar contact`, `… Qatar email`, `… Qatar W.L.L.` and
 * `… Qatar P.O. Box` each returned **zero domains that the plain query had not
 * already returned**. They are the same result set with a different string
 * attached. Only two things actually moved the results: a different CITY, and
 * the `site:` operator. So those are the two axes the plan varies.
 */
function buildSearchPlan(keywords: string[], location: string): string[] {
  const loc = (location || "").trim();
  const cities = citiesFor(loc);
  const seen = new Set<string>();
  const plan: string[] = [];
  const push = (v: string) => {
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    plan.push(v);
  };

  const tld = COUNTRY_TLD[normCountry(loc)];
  for (const kw of keywords) {
    if (!loc) { push(kw); continue; }

    // Country-wide.
    push(`${kw} ${loc}`);
    // The country's own TLD — every result is in-country by definition, and
    // measured to return domains the plain query does not.
    if (tld) push(`${kw} site:.${tld}`);

    // Per city. The city ALWAYS carries its country: half the Gulf's city names
    // are also American towns, so "MEP contractor Medina" returned contractors
    // in Medina, Ohio, and "steel fabrication Hail" returned hail-damage repair
    // firms in Texas. "… Medina Saudi Arabia" cannot be misread.
    for (const city of cities) {
      push(`${kw} ${city} ${loc}`);
      if (tld) push(`${kw} ${city} site:.${tld}`);
    }
  }
  return plan.slice(0, SEARCH_PLAN_CAP);
}

/* ------------------- the country sweep (Common Crawl) -------------------
 *
 * A keyword search has a ceiling that no amount of patience raises: the free
 * engines hand back 10-20 results per query, so a country sweep sees "the firms
 * that rank for the phrases we thought of". Common Crawl's index answers a
 * different question — "which hosts exist under .qa" — and that is the question
 * "how many companies are there in this country" actually needs.
 *
 * Measured: ~220 NEW hosts per index page, 23 pages for .qa, 161 for .ae, at
 * about 8 seconds a page, free and keyless. These run as extra steps on the
 * SAME cursor as the queries, so the existing resume/stop/exhaust machinery
 * covers them without a second state machine.
 */

/** A single step of a search source's walk: a query, or one page of the index. */
type SearchStep =
  | { kind: "query"; q: string }
  | { kind: "sweep"; pattern: string; page: number };

// Hard cap on index pages per pass. `*.ae` has 161; walking all of them in one
// pass would take an hour and starve the query half of the plan. The cursor
// resumes where it stopped, so a big country is covered across several passes.
const SWEEP_PAGES_PER_PASS = 40;
const SEARCH_PLAN_CAP = 4_000;

/**
 * Off-topic answers in a row before the batch gives up and waits.
 *
 * One is noise — a narrow trade phrase can genuinely rank nothing in-country.
 * Three in a row is a broken engine, and continuing past it is how a source
 * walks its whole plan, files nothing usable, and still reports a completed
 * pass.
 */
const OFFTOPIC_BATCH_LIMIT = 3;

/**
 * Which URL tokens make a swept host plausible for this category.
 *
 * The index gives URLs, never a category, so a "Qatar · Construction" source
 * sweeping `*.qa` would otherwise fill with dentists. The company's own URLs
 * are a real, free signal — `/contracting`, `/construction-services` — and the
 * CDX server cannot do this filtering for us (its `filter=` parameter 404s on
 * this endpoint), so it happens here.
 */
const CATEGORY_URL_TOKENS: Record<string, string[]> = {
  "Accounting & Tax": ["account", "audit", "tax", "bookkeep", "financ"],
  "IT & Software": ["it-", "tech", "soft", "digital", "web", "cyber", "cloud", "data", "system", "solution"],
  "Construction & Contracting": ["contract", "construc", "build", "civil", "engineer", "project", "infra"],
  "Consulting": ["consult", "advisor", "manage", "hr-", "recruit"],
  "Engineering": ["engineer", "mep", "electro", "mechanic", "electric", "technical", "industr"],
  "Real Estate": ["real-estate", "realestate", "propert", "estate", "aqar", "rent", "villa"],
  "Legal": ["law", "legal", "advocate", "attorney", "notary"],
  "Logistics & Transport": ["logistic", "freight", "cargo", "shipping", "transport", "clearance", "warehous", "courier"],
  "Advertising & Marketing": ["market", "advert", "media", "brand", "design", "print", "signage", "event", "agency"],
  "Insurance": ["insur", "takaful", "assur"],
  "Healthcare & Clinics": ["clinic", "medic", "health", "hospital", "pharm", "dental", "care", "lab"],
  "Hospitality & Food": ["cater", "restaurant", "hotel", "food", "kitchen", "cafe", "bakery", "hospitality"],
  "Manufacturing & Industrial": ["factor", "manufact", "industr", "steel", "plastic", "cement", "fabric", "product"],
  "Education & Training": ["train", "academy", "institute", "school", "educat", "learn", "college"],
  "Trading & Retail": ["trad", "import", "export", "supply", "supplier", "distribut", "store", "shop", "retail"],
};

/**
 * The general sweep's token list — and the reason it can no longer be empty.
 *
 * "Companies (general)" had no entry above, and `sweepHostMatches` read a
 * missing entry as "keep everything". Page one of `*.qa` therefore filed
 * `alabama.qa`, `agdoha2030.qa` (a national strategy site), `akhlaquna.qa` (a
 * volunteering campaign) and `abercrombie.qa` as company leads. A ccTLD is a
 * list of every host in a country, not a list of its businesses, so the sweep
 * has to say what a business looks like — even in the general case.
 */
const GENERAL_URL_TOKENS = [
  "compan", "corp", "group", "holding", "trading", "trade", "contract", "construc",
  "industr", "factor", "manufact", "engineer", "electro", "mechanic", "technical",
  "supply", "supplier", "distribut", "import", "export", "logistic", "freight",
  "transport", "service", "solution", "system", "consult", "agency", "enterprise",
  "establish", "invest", "product", "equipment", "material", "machinery", "steel",
  "aluminium", "aluminum", "plastic", "cement", "chemical", "medical", "clinic",
  "pharma", "food", "cater", "hotel", "restaurant", "retail", "store", "shop",
  "estate", "propert", "insur", "account", "audit", "legal", "clean",
  "maintenance", "security", "print", "media", "market", "design", "energy",
  "petro", "oilfield", "marine", "shipping", "travel", "tour", "auto", "motor",
  "rental", "international", "gulf", "arab", "tech", "electric", "furniture",
];

// Hosts a ccTLD sweep turns up that are plainly not businesses: government
// portals, campaigns, schools, personal pages and the country's own institutions.
const NON_BUSINESS_HOST =
  /(^|[.-])(gov|mil|edu|sch|ac|org|net|info|blog|news|forum|wiki|portal|ministry|municipality|embassy|consulate|charity|foundation|mosque|church|club|team|fans?|blogspot|wordpress|weebly|wixsite|github|gitlab|pages|cdn|static|assets|img|images|mail|smtp|webmail|ftp|vpn|test|dev|staging|demo|localhost)([.-]|$)/i;

// A campaign / event / vanity host: a bare year, "2030", "expo", "cup" …
const CAMPAIGN_HOST = /(?:^|[a-z])(?:19|20)\d{2}(?:$|[a-z])|(?:expo|worldcup|festival|summit|forum|award|campaign|vision)\d*$/i;

function sweepTokensFor(category: string, custom?: string | null): string[] {
  // Custom keywords are the user's own words for what they want — a better
  // signal than any table we could write.
  const typed = String(custom || "")
    .split(/[,\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 4)
    .flatMap((s) => s.split(/\s+/).filter((w) => w.length >= 4))
    .slice(0, 12);
  if (typed.length) return [...new Set(typed)];
  return CATEGORY_URL_TOKENS[category] || GENERAL_URL_TOKENS;
}

/**
 * True when at least one of the host's crawled URLs looks like this category.
 *
 * The haystack is the domain LABEL plus the URL PATHS — deliberately not the
 * whole URL. Matching the full string meant `"co"` hit the `.com` in every
 * address and `"est"` hit "latest", "request" and "investment", which is how a
 * token list that looks strict ends up keeping everything anyway. Same reason
 * every token here is at least four characters.
 */
function sweepHostMatches(urls: string[], host: string, tokens: string[]): boolean {
  const label = host.toLowerCase().replace(/^www\./, "");
  if (NON_BUSINESS_HOST.test(label) || CAMPAIGN_HOST.test(label.split(".")[0] || "")) return false;
  if (!tokens.length) return false; // never "keep everything" — see GENERAL_URL_TOKENS
  const paths = urls
    .map((u) => {
      try {
        const p = new URL(u);
        return p.pathname + p.search;
      } catch {
        return "";
      }
    })
    .join(" ");
  const hay = `${label.split(".")[0]} ${paths}`.toLowerCase();
  return tokens.some((t) => t.length >= 3 && hay.includes(t));
}

/**
 * A readable placeholder name for a swept host.
 *
 * The index knows the host and nothing else, and filing the literal string
 * "101domain.qa" as a company name is what made the pool look broken.
 * `nameFromDomain` is `repair.ts`'s existing "last resort" naming — reused
 * rather than reimplemented so a swept lead and a repaired one are named by the
 * same rule. Enrichment later overwrites it with the site's own <title>.
 */
function sweepNameFor(domain: string): string {
  return nameFromDomain(null, domain) || domain;
}

// Narrow seams for the verification script. Exported rather than re-implemented
// there, so the test can never pass against a copy of the logic that has since
// drifted from the one the bot runs.
export const buildSearchPlanForTest = buildSearchPlan;
export const sweepTokensForTest = sweepTokensFor;
export const sweepHostMatchesForTest = sweepHostMatches;
export const buildSearchStepsForTest = (src: any, location: string) => buildSearchSteps(src, location);

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

/**
 * The full ordered walk for a search source: every query, then the country
 * index pages.
 *
 * The two halves share one cursor on purpose. A search source already has
 * resume, stop-mid-batch, saturation, block-backoff and "a full pass finished"
 * logic that took several rounds of production bugs to get right; giving the
 * sweep its own state machine would mean writing all of it a second time, and
 * the second copy is the one that drifts.
 */
async function buildSearchSteps(src: any, location: string): Promise<SearchStep[]> {
  const keywords = searchKeywordsFor(src.category, src.keywords);
  const queries: SearchStep[] = buildSearchPlan(keywords, location).map((q) => ({ kind: "query" as const, q }));

  const tld = COUNTRY_TLD[normCountry(location)];
  if (!tld || Number(src.sweep_country ?? 0) !== 1) return queries;

  const pattern = `*.${tld}`;
  // One call, cached for 12h. When the index cannot be reached we add NO sweep
  // steps rather than guessing a length — a plan whose length changes under the
  // cursor is how a resume lands on the wrong step. The source then runs as a
  // pure keyword search for this pass and picks the sweep up on the next one.
  const pages = await ccPageCount(pattern).catch(() => 0);
  const sweeps: SearchStep[] = [];
  for (let p = 0; p < Math.min(pages, SWEEP_PAGES_PER_PASS); p++) {
    sweeps.push({ kind: "sweep", pattern, page: p });
  }
  if (!sweeps.length) return queries;
  if (!queries.length) return sweeps;

  // INTERLEAVE rather than append. Two reasons, and both were learned the hard
  // way while building this:
  //   1. An index page is a multi-megabyte response. Running a whole batch of
  //      them back to back got this container's IP refused by
  //      index.commoncrawl.org within about fifteen calls. Spread through the
  //      queries, a pass makes one heavy call every couple of minutes.
  //   2. Appending would mean every lead from the sweep arrives only after the
  //      entire keyword plan has been walked — hours in, on a big country — so
  //      the pool would look unchanged for most of a pass.
  const every = Math.max(1, Math.floor(queries.length / sweeps.length));
  const out: SearchStep[] = [];
  let s = 0;
  for (let i = 0; i < queries.length; i++) {
    out.push(queries[i]);
    if ((i + 1) % every === 0 && s < sweeps.length) out.push(sweeps[s++]);
  }
  while (s < sweeps.length) out.push(sweeps[s++]); // any remainder
  return out;
}

// Walk ONE batch of a web-search source: a few steps from the plan, inserting
// every new company site (email-less → enrichTick crawls it for the address).
async function runSearchSource(src: any): Promise<SearchRunResult> {
  const location = String(src.location || "").trim();
  const plan = await buildSearchSteps(src, location);
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
  // Queries that produced nothing new on their last two passes are cooling off.
  const saturated = await loadSaturatedQueries(src.id);
  const sweepTokens = sweepTokensFor(src.category, src.keywords);
  const queryCount = plan.filter((s) => s.kind === "query").length;
  const sweepCount = planLen - queryCount;
  const label = src.category && src.category !== "Companies (general)"
    ? `${location || "web"} · ${src.category}`
    : (location || "web search");
  // The engine pool is what serves these now; the reader is only reached when
  // every free engine is resting, so saying "free reader" up front was wrong.
  const how = `free engine pool${readerKey ? " → reader" : ""}${proxy ? " → proxy" : ""}`;
  dlog("search", `${label} — step ${cursor}/${planLen} (${queryCount} quer${queryCount === 1 ? "y" : "ies"}${sweepCount ? ` + ${sweepCount} country-index page${sweepCount === 1 ? "" : "s"}` : ""}) · ${batch.length} step${batch.length === 1 ? "" : "s"} this batch · ${how}`);

  let found = 0, extracted = 0, ok = 0, covered = 0, blocked = false, stopped = false, err: string | undefined;
  let offtopicRun = 0;
  for (const item of batch) {
    // Deleted / archived / switched off mid-batch? Stop, keeping the position.
    if (await shouldStop(src.id)) {
      dlog("search", `${label}: stopped at step ${cursor + covered} — the source was removed or switched off`);
      stopped = true; // not a rate limit — no backoff, and nothing to resume
      break;
    }

    /* ---------------------- one page of the country index ---------------- */
    if (item.kind === "sweep") {
      const page = await ccHostsForPattern(item.pattern, item.page).catch(() => null);
      covered++;
      if (!page || !page.ok) {
        dwarn("search", `  ✗ ${item.pattern} index page ${item.page + 1} — the archive did not answer; moving on`);
        continue;
      }
      ok++;
      let kept = 0, pageFound = 0;
      // One index page holds ~14,000 URL records over ~220 hosts, so this is
      // the one step that can insert hundreds of leads at once.
      const seenDomains = new Set<string>();
      for (const h of page.hosts) {
        if (isNonProspectHost(h.host)) continue;
        const domain = registrableDomain(h.host);
        if (!domain || seenDomains.has(domain)) continue; // api.x.qa and www.x.qa are one company
        seenDomains.add(domain);
        if (domainLooksForeign(domain, location)) continue;
        if (!sweepHostMatches(h.urls, h.host, sweepTokens)) continue;
        extracted++;
        kept++;
        const website = `https://${domain}/`;
        const added = await insertDiscovered({
          // The index knows the host, never the trading name. Enrichment reads
          // the site's own <title> and overwrites this, and `repair.ts` treats
          // a bare domain as a name that still needs fixing.
          name: sweepNameFor(domain), website, domain, email: null,
          phone: null, city: null,
          country: resolveLeadCountry({ sourceCountry: location, domain, website }),
          category: src.category || "",
          audience: audienceOf(src),
          sourceId: src.id, label,
          enriched: 0,
          confidence: null,
        }, dedup);
        if (added) { found++; pageFound++; }
      }
      dlog("search", `  · ${item.pattern} index page ${item.page + 1}/${planLen - queryCount} → ${page.hosts.length} host(s), ${kept} in scope, +${pageFound} new`);
      await sleep(SEARCH_PACING_MS);
      continue;
    }

    /* ------------------------------ one query ---------------------------- */
    // Saturated: this exact query has stopped producing anything new. Step over
    // it without spending a request — it comes back automatically once its
    // cool-off expires, because sites do get published.
    if (saturated.has(`${item.q}|0`)) {
      covered++;
      dlog("search", `  · "${item.q}" skipped — exhausted, will retry it later`);
      continue;
    }
    const r = await searchCompaniesDeep(item.q, {
      maxPages: SEARCH_MAX_PAGES,
      limit: 120,
      readerKey,
      expectCountry: location,
      proxy,
    }).catch(() => ({ companies: [], blocked: true, pages: 0, engines: [] as string[], offtopic: false }));
    if (r.blocked) {
      blocked = true;
      err = readerKey
        ? "the search engine rate-limited us — pausing, then resuming from this exact query"
        : "web search was blocked (add a free JINA key in Settings → Crawler to search at full speed)";
      dwarn("search", `  ✗ "${item.q}" — rate-limited, will resume here`);
      break;
    }
    // The engine answered, and every result was for a different question.
    //
    // Two things must NOT happen here. The query must not be charged a zero
    // yield — that is what `recordQueryYield` does below, and it would cool off
    // a perfectly good query because an engine misbehaved. And the pass must not
    // keep walking: a degraded engine returns off-query results for EVERY query
    // alike, so carrying on would march the cursor through the entire plan,
    // find nothing, and then report the source as a finished pass.
    //
    // So: step over the first couple (one odd query is not a diagnosis), then
    // stop and resume from this exact query once the pool has rested the engine.
    if (r.offtopic) {
      offtopicRun++;
      dwarn("search", `  ✗ "${item.q}" — the engine answered a different question (it dropped the country/site filter)`);
      if (offtopicRun >= OFFTOPIC_BATCH_LIMIT) {
        blocked = true;
        err =
          "the search engines are returning results for a different query (they are dropping the country and site: filters) — paused, and will resume from this exact query";
        dwarn("search", `${label}: pausing — ${offtopicRun} queries in a row came back off-topic`);
        break;
      }
      ok++;
      covered++;
      await sleep(SEARCH_PACING_MS);
      continue;
    }
    offtopicRun = 0;
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
        audience: audienceOf(src),
        sourceId: src.id, label,
        enriched: 0,            // web search gives the site, not the email → enrich it
        confidence: null,
      }, dedup);
      if (added) { found++; batchFound++; }
    }
    await recordQueryYield(src.id, item.q, 0, batchFound);
    const via = r.engines.length ? ` via ${[...new Set(r.engines)].join("+")}${r.pages > 1 ? ` ×${r.pages}p` : ""}` : "";
    dlog("search", `  · "${item.q}"${via} → ${r.companies.length} site(s), +${batchFound} new`);
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

/* ------------------------------- staleness ------------------------------ */

// The three numbers behind the "stale" flag, for one finished batch.
//
// `counted` must be FALSE for a run that errored, was rate-limited or was
// stopped mid-flight. Such a run says nothing about whether the source still
// has leads left in it, so it can neither raise the streak (that would libel a
// blocked source as spent) nor reset it (that would let a permanently blocked
// source hide behind its own failures).
function barrenState(src: any, found: number, counted: boolean) {
  const prev = Number(src.barren_runs) || 0;
  const wasOn = !!Number(src.enabled);
  const runs = !counted ? prev : found > 0 ? 0 : prev + 1;
  // Switch a spent source off instead of letting it keep drawing budget. Only a
  // run that COUNTED can do this, for the same reason it can't raise the streak:
  // a blocked source has not been shown to be empty. `wasOn` keeps this to a
  // real transition, so the log line fires once rather than on every later run.
  const off = counted && wasOn && runs >= STALE_OFF_AFTER_RUNS;
  return {
    runs,
    lastFound: counted ? found : Number(src.last_found) || 0,
    lastFoundAt: counted && found > 0 ? nowIso() : src.last_found_at || null,
    off,
    enabled: off ? 0 : wasOn ? 1 : 0,
    autoOff: off || Number(src.auto_off) ? 1 : 0,
  };
}

// Said the same way for all three source types, because the reason is the same.
function autoOffLog(src: any, runs: number) {
  dwarn(
    src.type === "directory" ? "dir" : src.type === "search" ? "search" : "osm",
    `${srcLabel(src)}: SWITCHED OFF — ${runs} runs in a row without a single new company. It was still spending crawl budget on ground it has already covered. Re-aim it (new area, keywords or directory) or archive it; switching it back on by hand gives it another ${STALE_OFF_AFTER_RUNS} runs.`
  );
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
    // A batch the site refused (`stalled`) is blocked, not spent — it doesn't
    // count toward the stale streak.
    const barren = barrenState(src, r.found, !r.error && r.okish && !stalled);
    // A source that just switched itself off must not keep streaming.
    const cont = !r.error && !exhausted && !stalled && !barren.off;
    const next = cont ? nowIso() : new Date(Date.now() + interval * 60000).toISOString();
    const status = r.error ? "error" : exhausted ? "done" : "ok";
    await q(
      `UPDATE discovery_sources
         SET last_run_at=?, next_run_at=?, last_status=?, last_error=?, runs=runs+1,
             total_found=total_found+?, cursor=?, exhausted=?, empty_streak=?, next_url=?,
             barren_runs=?, last_found=?, last_found_at=?, enabled=?, auto_off=?
       WHERE id=?`,
      [nowIso(), next, status, r.error || null, r.found, cursor, exhausted ? 1 : 0, exhausted ? 0 : streak, nextUrl,
       barren.runs, barren.lastFound, barren.lastFoundAt, barren.enabled, barren.autoOff, src.id]
    );
    if (barren.off) autoOffLog(src, barren.runs);
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
    // `okish` is already false when the engines rate-limited us or the source
    // was stopped, which is exactly when a barren batch means nothing.
    const barren = barrenState(src, r.found, !r.error && r.okish);
    const cont = !r.error && !exhausted && !barren.off;
    const next = cont ? nowIso() : new Date(Date.now() + (steppedOver ? SEARCH_BLOCK_BASE_MIN : pauseMin) * 60000).toISOString();
    const status = r.error ? "error" : exhausted ? "done" : "ok";
    await q(
      `UPDATE discovery_sources
         SET last_run_at=?, next_run_at=?, last_status=?, last_error=?, runs=runs+1,
             total_found=total_found+?, cursor=?, exhausted=?, empty_streak=?, block_streak=?,
             barren_runs=?, last_found=?, last_found_at=?, enabled=?, auto_off=?
       WHERE id=?`,
      [nowIso(), next, status, r.error || null, r.found, cursor, exhausted ? 1 : 0, exhausted ? 0 : streak, blockStreak,
       barren.runs, barren.lastFound, barren.lastFoundAt, barren.enabled, barren.autoOff, src.id]
    );
    if (barren.off) autoOffLog(src, barren.runs);
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
  // A sweep halted by hand covered only part of its tiles, so "found nothing"
  // isn't a verdict on the source.
  const barren = barrenState(src, r.found, !r.error && !r.stopped);
  const cont = !r.error && !r.exhausted && !r.stopped && !barren.off;
  const next = cont ? nowIso() : new Date(Date.now() + interval * 60000).toISOString();
  const status = r.error ? "error" : r.exhausted ? "done" : "ok";
  await q(
    `UPDATE discovery_sources
       SET last_run_at=?, next_run_at=?, last_status=?, last_error=?, runs=runs+1,
           total_found=total_found+?, cursor=?, exhausted=?, osm_tiles=?, osm_available=?,
           barren_runs=?, last_found=?, last_found_at=?, enabled=?, auto_off=?
     WHERE id=?`,
    [nowIso(), next, status, r.error || null, r.found, r.error ? (Number(src.cursor) || 1) : r.nextCursor,
     r.exhausted ? 1 : 0, r.tiles, r.available, barren.runs, barren.lastFound, barren.lastFoundAt,
     barren.enabled, barren.autoOff, src.id]
  );
  if (barren.off) autoOffLog(src, barren.runs);
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
  // Within the same domain tier, prefer the inbox most likely to be READ by
  // someone who can reply: a named individual first, then info/sales, then the
  // service desk, and administrative mailboxes last. The old tiebreak only
  // asked "is this a role address?", which is how "reportscam@fujairah
  // refinery.ae" and several "hr@" addresses became the saved contact for
  // companies that also published a person's address.
  ranked.sort((a, b) => a.rank - b.rank || roleRank(a.e.email) - roleRank(b.e.email) || a.e.email.localeCompare(b.e.email));
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

    const picked = [
      ...withSite.map((lead) => ({ lead, needsSite: false })),
      ...noSite.map((lead) => ({ lead, needsSite: true })),
    ];

    // One host per batch. The legacy pool still holds several rows pointing at
    // the same domain (they predate the pool-domain claim), and the workers run
    // four wide — so without this, two or three of them hammer the same server
    // at once. That is a rate-limit we inflict on ourselves, and the loser is
    // recorded as "blocked" for a site that was perfectly willing to answer.
    // The skipped rows aren't lost; they're simply picked up next tick.
    const seenHosts = new Set<string>();
    const batch = picked.filter(({ lead }) => {
      const host = registrableDomain(hostOf(String(lead.website || ""))) || "";
      if (!host) return true; // no site yet (tier 2) — nothing to collide with
      if (seenHosts.has(host)) return false;
      seenHosts.add(host);
      return true;
    });
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
    // Measured on what the DB HANDED US, not on the de-duplicated batch: rows
    // skipped for sharing a host are still queued work, so testing `batch`
    // here would stall the chain and leave them until the next timer tick.
    more = picked.length >= ENRICH_BATCH;
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

  // An aggregator / job board / data broker / regulator can never yield a
  // company address. These rows entered the pool under older, weaker rules and
  // are the most expensive thing in the queue: never a lead, and almost always
  // behind Cloudflare, so each burns a full crawl and six retries to learn
  // nothing. Retire on sight and close the domain so it can't come back.
  if (leadHost && isNonProspectHost(leadHost)) {
    await q(
      `UPDATE discovered_leads SET status='duplicate', enriched=1, enrich_status='junk', next_enrich_at=NULL WHERE id=?`,
      [lead.id]
    );
    if (lead.domain) await closePoolDomain(String(lead.domain), "junk");
    dlog("enrich", `  ~ retired ${leadHost} — a directory/aggregator, never a company we can email`);
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
  // Cloudflare/403 = the wall never moves; 429/timeout = come back later.
  let hardWall = false;
  try {
    const site = await crawlSite(lead.website, opts);
    if (site.phone && !phone) phone = site.phone;
    const best = pickSiteEmail(site.emails, lead.domain);
    if (best) { email = best.email.trim().toLowerCase(); confidence = "likely"; outcome = "found"; }
    else if (site.status === "blocked") {
      outcome = "blocked";
      note = site.note || "blocked";
      hardWall = !!site.blockReason && HARD_BLOCK_REASONS.has(site.blockReason);
    }
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
            SET enriched=1, email=?, phone=?, confidence=?, dedup_key=?, enrich_status='found', next_enrich_at=NULL,
                email_at=?
          WHERE id=?`,
        // NOW, not the lead's created_at: this is the moment it became
        // emailable, and it is the only honest input to the fill rate.
        [email, phone, confidence, "e:" + email, nowIso(), lead.id]
      );
    } catch {
      await retireDuplicate(lead, phone, email);
      return;
    }
    dlog("enrich", `  ✓ found ${email} for "${lead.name || lead.domain}"`);
    if (lead.domain) await closePoolDomain(String(lead.domain), "found");
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
    if (lead.domain) await closePoolDomain(String(lead.domain), "empty");
    dlog("enrich", `  ✗ no email on ${shortUrl(lead.website)} (site loaded fine) — "${lead.name || lead.domain}"`);
    return;
  }

  // Blocked / errored → back off and retry later. WHICH ladder depends on
  // whether the wall can realistically move:
  //   hard  (Cloudflare challenge, 403 WAF) → 2 tries. It refused a datacenter
  //         IP and will keep refusing one; more attempts buy nothing.
  //   soft  (429, timeout, DNS, 5xx)        → the full 6-try ladder, because
  //         these genuinely do clear on their own.
  const maxTries = hardWall ? ENRICH_HARD_MAX_RETRIES : ENRICH_MAX_RETRIES;
  const ladder = hardWall ? ENRICH_HARD_BACKOFF_MS : ENRICH_BACKOFF_MS;

  if (attempt >= maxTries) {
    // Give up for now, but record WHY (enrich_status) so "Re-check blocked"
    // (or adding a Jina key / proxy later) can resurrect exactly these.
    await q(
      `UPDATE discovered_leads SET enriched=1, phone=?, retry_count=?, enrich_status=?, next_enrich_at=NULL WHERE id=?`,
      [phone, attempt, outcome, lead.id]
    );
    if (lead.domain) await closePoolDomain(String(lead.domain), outcome);
    dwarn(
      "enrich",
      `  ⚠ parked "${lead.name || lead.domain}" after ${attempt} tr${attempt === 1 ? "y" : "ies"} — ${note || outcome}.` +
        (hardWall ? ` This wall won't open to a plain crawl.` : "") +
        ` Add a working Jina key or a scraping proxy in Settings, then click "Re-check blocked".`
    );
    return;
  }
  const backoffMs = ladder[Math.min(attempt - 1, ladder.length - 1)];
  const nextAt = new Date(Date.now() + backoffMs).toISOString();
  await q(
    `UPDATE discovered_leads SET enriched=0, phone=?, retry_count=?, enrich_status=?, next_enrich_at=? WHERE id=?`,
    [phone, attempt, outcome, nextAt, lead.id]
  );
  dlog("enrich", `  ↻ ${outcome} on "${lead.name || lead.domain}" (try ${attempt}/${maxTries}) — retrying ${fmtBackoff(backoffMs)}${note ? ` · ${note}` : ""}`);
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

/* ------------------------- legacy backlog sweep ------------------------ */

/**
 * Retire pool rows that could never have been prospects.
 *
 * The blocklists only ever ran when a SEARCH RESULT was inserted, so every row
 * discovered under an older, weaker rule set is still in the queue waiting to be
 * crawled. They are the most expensive rows we own: guaranteed not to yield an
 * address, and mostly behind Cloudflare, so each one costs a multi-page crawl
 * plus a retry ladder to prove it.
 *
 * Four rules, and every one of them has to be something we can be CERTAIN about
 * from what is already stored. A lead only has a name, a website and a country
 * here — no snippet — so this is deliberately narrower than the live verifier.
 * A Gulf firm on a neutral `.com` whose name happens not to mention its country
 * is left completely alone; the cost of wrongly deleting a real prospect is far
 * higher than the cost of crawling a doubtful one.
 *
 * Runs once per boot. Idempotent: a swept row is status='duplicate', which the
 * WHERE clause excludes next time.
 */
export async function sweepNonProspectLeads(): Promise<number> {
  const rows = (await q(
    `SELECT id, name, domain, website, country FROM discovered_leads
      WHERE status='pending' AND (email IS NULL OR email='')
        AND website IS NOT NULL AND website<>''`
  )) as any[];

  const byReason: Record<string, number> = {};
  let swept = 0;
  for (const r of rows) {
    const host = hostOf(String(r.website || "")).replace(/^www\./i, "");
    if (!host) continue;
    const domain = String(r.domain || "") || registrableDomain(host) || "";
    const want = String(r.country || "");

    let reason = "";
    if (isNonProspectHost(host)) {
      reason = "directories, brokers and job boards";
    } else if (domainLooksForeign(domain, want)) {
      reason = "US look-alikes";
    } else if (String(r.name || "").trim() && companyNameFromTitle(String(r.name), domain) === null) {
      // The stored name is a headline no rule can turn into a business name —
      // "Steel: Definition, Composition, Types, Properties, and Applications".
      // These arrived when a degraded engine answered a vocabulary question.
      reason = "reference pages, not companies";
    } else {
      // The domain's OWN ccTLD names a different country than the one this lead
      // is filed under. `.cn`, `.us`, `.in` under a Qatar source is not a
      // judgement call — it is the engine having dropped the country from the
      // query. Neutral TLDs (.com/.net/.org) resolve to null and are untouched.
      const onDomain = countryFromDomain(domain);
      const wanted = normalizeCountry(want);
      if (onDomain && wanted && onDomain !== wanted) reason = `wrong country (${onDomain})`;
    }
    if (!reason) continue;

    await q(
      `UPDATE discovered_leads SET status='duplicate', enriched=1, enrich_status='junk', next_enrich_at=NULL WHERE id=?`,
      [r.id]
    );
    if (domain) await closePoolDomain(domain, "junk");
    byReason[reason] = (byReason[reason] || 0) + 1;
    swept++;
  }
  if (swept) {
    const detail = Object.entries(byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n.toLocaleString()} ${k}`)
      .join(" · ");
    dlog("", `swept ${swept.toLocaleString()} lead(s) that can never yield an email — ${detail}. They will not be crawled again.`);
  }
  return swept;
}

/* ---------------------------- bulk recovery ---------------------------- */

// One-click recovery for the historical "no email" pool. Resets pending,
// email-less leads that have a website so enrichTick re-attempts them. Targets
// the ones that were BLOCKED/errored or predate retry-tracking (enrich_status
// NULL); leaves genuinely-empty sites (enrich_status='empty') alone so we don't
// pointlessly re-crawl sites we already confirmed have no email.
//
// Each row it touches is STAMPED with the pass — see RECHECK_MAX_PASSES and
// `bypassFingerprint`. Without that stamp this function selected on the exact
// state it left behind, so it re-queued the same leads on every press for ever:
// the count never moved, and each press cost a crawl per lead to re-prove a
// wall we had already proved. Now a lead is offered again only when the
// operator changes something that could change the answer.
export async function reEnrichBlocked(): Promise<{
  reset: number;
  stuck: number;
  /** Of `reset`, how many were re-armed purely because the bypass setup changed. */
  reArmed: number;
}> {
  const fp = await bypassFingerprint();
  // Counted BEFORE the update: parked leads that had already had a pass, but
  // under a different key/proxy. These are the ones a new key just unlocked,
  // and saying so is the difference between "it worked" and "it did nothing".
  const reArmed = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads
      WHERE ${PARKED_SQL} AND recheck_count > 0 AND (recheck_key IS NULL OR recheck_key <> ?)`,
    [fp]
  ))[0]?.n ?? 0;

  const rows = await q(
    `UPDATE discovered_leads
        SET enriched=0, retry_count=0, next_enrich_at=NULL, enrich_status=NULL,
            recheck_count=recheck_count+1, recheck_key=?, recheck_at=?
      WHERE ${RECHECKABLE_SQL}
      RETURNING id`,
    [fp, nowIso(), RECHECK_MAX_PASSES, fp]
  );
  const reset = rows.length;

  const stuck = (await q(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM discovered_leads WHERE ${EXHAUSTED_SQL}`,
    [RECHECK_MAX_PASSES, fp]
  ))[0]?.n ?? 0;

  if (reset) {
    dlog(
      "enrich",
      `re-check requested → re-queued ${reset} blocked/untried lead(s) to find emails again` +
        (reArmed ? ` (${reArmed} of them re-armed by the new key/proxy)` : "")
    );
  } else {
    dlog(
      "enrich",
      stuck
        ? `re-check requested → nothing to re-queue. All ${stuck} parked lead(s) have already had a pass on this exact setup and stayed blocked; add or change a Jina key / scraping proxy and they all become re-checkable again.`
        : `re-check requested → nothing to re-queue. Every lead with a website has been resolved one way or the other.`
    );
  }
  // Nudge the enrich loop so recovery starts immediately (respecting the bot's
  // on/off + auto-enrich switches inside the tick).
  if (reset > 0) setTimeout(() => { enrichTick().catch(() => {}); }, 500);
  return { reset, stuck, reArmed };
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
        // email_at goes with the address: this lead is not emailable, so it
        // must not sit in the fill rate as though it were.
        `UPDATE discovered_leads SET email=NULL, email_at=NULL, confidence=NULL, enriched=0,
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
      // Claim every domain the pool already holds, or the ledger would treat
      // thousands of known sites as brand new and re-crawl each one once.
      const claimed = await backfillPoolDomains();
      if (claimed) dlog("", `domain ledger → registered ${claimed.toLocaleString()} domain(s) already in the pool, so none of them can be re-discovered and re-crawled`);
      await sweepNonProspectLeads();

      const on = await isBotEnabled();
      const active = (await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM discovery_sources WHERE enabled=1 AND archived=0`))[0]?.n ?? 0;
      const auto = await autoEnrichOn();
      dlog("", `state → bot ${on ? "ON" : "OFF"} · ${active} enabled source(s) · auto-find-emails ${auto ? "ON" : "OFF"}`);
      // Say plainly what bypass capacity the crawler actually has. Without this
      // the only way to know a key took effect is to guess from block messages.
      const [key, prox] = await Promise.all([getReaderKey(), getProxyConfig()]);
      const keys = parseReaderKeys(key);
      const st = getReaderStats(keys);

      dlog(
        "",
        st.keysLive > 0
          ? `reader → ${st.keysLive}/${st.keysConfigured} Jina key(s) live (${READER_RPM_KEYED_HINT}/min). Only used when the free tiers can't serve a page.`
          : st.keysConfigured > 0
            ? `reader → all ${st.keysConfigured} Jina key(s) REJECTED (out of tokens). Crawling continues on the free tiers; the reader is only a fallback now.`
            : `reader → no Jina key. Not required — the free tiers below carry the crawl; a key only adds JS rendering for the pages they miss.`
      );
      dlog("", `bypass tiers → direct fetch · Common Crawl (free, unlimited) · Wayback archive (free) · Jina reader (metered)${prox ? ` · ${prox.provider} proxy` : " · no paid proxy"}`);
      if (!on) dwarn("", "bot is OFF — turn it on in the Discovery screen to start scanning.");
      else if (!active) dwarn("", "bot is ON but no sources are enabled — enable a source in the Discovery screen.");
    } catch { /* ignore */ }
  })();
}
