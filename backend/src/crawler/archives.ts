// Free page sources that don't cost a token.
//
// WHY THIS EXISTS
// A Cloudflare challenge is not a property of the page — it is a property of
// *us asking for it from a datacenter IP*. Somebody else already asked for that
// page from an IP nobody minds, and wrote the answer down. Reading their copy
// is free, unlimited and needs no key, which makes it strictly better than
// paying a reader service to re-solve the same wall on every request.
//
// Two independent corpora, because their coverage barely overlaps:
//   • Common Crawl — a quarterly public crawl of billions of pages. Served as
//     byte ranges of gzipped WARC files on S3; no rate limit worth the name.
//   • Wayback (archive.org) — deeper history and far better coverage of small
//     sites, but it rate-limits hard, so every call is paced and backed off.
//
// Both are ALSO indexes, not just fetchers: they can tell us which pages of a
// domain exist. That is what cracks a fully-walled site — we can go straight to
// the archived /contact page without ever getting a link from the live site.

import { gunzipSync, constants as zlibConstants } from "node:zlib";
import { rawFetch, rawBytes, browserHeaders, sleep, type FetchResult } from "./http";
import { hostOf, registrableDomain, scoreLink } from "./urls";

const log = (msg: string) => console.log(`[archive] ${msg}`);
const warn = (msg: string) => console.warn(`[archive] ${msg}`);

/* ---------------------------- source health ---------------------------- */

// A free service that starts refusing us must not be hammered — that is how a
// soft rate limit turns into a hard ban. Each source backs off on consecutive
// failures and recovers on the first success.
//
// Tolerance matters here. These are big distributed systems: an individual
// shard 502s, one crawl of four has no captures for a domain, a range request
// times out. None of that means the SOURCE is down, and an eager backoff turns
// a single hiccup into "Common Crawl found nothing" for every domain that
// follows — which is exactly what happened the first time this shipped. Only a
// run of failures with no success in between counts.
interface Health { fails: number; until: number }
const health = new Map<string, Health>();
const FAILS_BEFORE_BACKOFF = 4;
const BACKOFF_MS = [0, 60_000, 5 * 60_000, 20 * 60_000, 60 * 60_000];

function usable(source: string): boolean {
  const h = health.get(source);
  return !h || Date.now() >= h.until;
}
function noteOk(source: string): void {
  health.delete(source);
}
function noteFail(source: string, why: string): void {
  const h = health.get(source) || { fails: 0, until: 0 };
  h.fails++;
  if (h.fails >= FAILS_BEFORE_BACKOFF) {
    const step = Math.min(h.fails - FAILS_BEFORE_BACKOFF + 1, BACKOFF_MS.length - 1);
    h.until = Date.now() + BACKOFF_MS[step];
    warn(`${source} keeps refusing us (${why}, ${h.fails} in a row) — resting ${Math.round(BACKOFF_MS[step] / 60000)}m`);
  }
  health.set(source, h);
}

/** Per-source health, for the Settings/Discovery panels. */
export function archiveHealth(): { source: string; fails: number; downForMs: number }[] {
  const now = Date.now();
  return [...health.entries()].map(([source, h]) => ({
    source,
    fails: h.fails,
    downForMs: Math.max(0, h.until - now),
  }));
}

/* ------------------------------- pacing -------------------------------- */

// One in-flight request per source at a time, spaced. These are free public
// services; being a good citizen is also what keeps them answering us.
const chains = new Map<string, Promise<void>>();
const nextAt = new Map<string, number>();

async function paced<T>(source: string, minGapMs: number, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(source) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  chains.set(source, prev.then(() => gate));
  await prev.catch(() => {});
  const now = Date.now();
  const at = Math.max(now, nextAt.get(source) || 0);
  nextAt.set(source, at + minGapMs);
  if (at > now) await sleep(at - now);
  try {
    return await fn();
  } finally {
    release();
  }
}

/* ---------------------------- shared helpers --------------------------- */

/** One archived page we know exists, and how to read it. */
export interface ArchivedPage {
  url: string;                       // the ORIGINAL url, as the site served it
  source: "commoncrawl" | "archive";
  fetch: () => Promise<FetchResult>;
}

const CACHE_MS = 6 * 60 * 60 * 1000;      // an index doesn't change hour to hour
const NEG_CACHE_MS = 60 * 60 * 1000;      // "not archived" is worth remembering too

interface Cached<T> { at: number; data: T }
function fresh<T>(c: Cached<T> | undefined, ttl: number): T | undefined {
  return c && Date.now() - c.at < ttl ? c.data : undefined;
}

/** Normalise a URL for comparing an archived record against a wanted page. */
function pathKey(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname.replace(/\/+$/, "") || "/").toLowerCase() + (u.search || "");
  } catch {
    return url.toLowerCase();
  }
}

/* ============================ Common Crawl ============================= */

const CC_COLLINFO = "https://index.commoncrawl.org/collinfo.json";
const CC_DATA = "https://data.commoncrawl.org/";
// Coverage of any one crawl is patchy — measured on kon-uae.com the four newest
// indexes held 0, 1, 6 and 40 pages. Asking one index is how you conclude a
// site "isn't in Common Crawl" when it has forty pages sitting in the next one.
const CC_INDEXES_TO_TRY = 4;
const CC_ROWS = 60;
const CC_INDEX_GAP_MS = 900;
const CC_DATA_GAP_MS = 350;
const CC_ENABLED = process.env.DISABLE_COMMONCRAWL !== "1";

interface CcRecord {
  url: string;
  filename: string;
  offset: number;
  length: number;
  timestamp: string;
}

let ccIndexCache: Cached<string[]> | undefined;

async function ccIndexes(): Promise<string[]> {
  const hit = fresh(ccIndexCache, 12 * 60 * 60 * 1000);
  if (hit) return hit;
  const r = await paced("commoncrawl-index", CC_INDEX_GAP_MS, () =>
    rawFetch(CC_COLLINFO, { timeoutMs: 20_000, headers: browserHeaders(), via: "commoncrawl", trustBody: true, anyContentType: true })
  );
  if (!r.ok) { noteFail("commoncrawl", `collinfo ${r.status}`); return ccIndexCache?.data || []; }
  try {
    const list = JSON.parse(r.html) as { id: string; "cdx-api": string }[];
    const apis = list.slice(0, CC_INDEXES_TO_TRY).map((x) => x["cdx-api"]).filter(Boolean);
    ccIndexCache = { at: Date.now(), data: apis };
    return apis;
  } catch {
    noteFail("commoncrawl", "collinfo parse");
    return ccIndexCache?.data || [];
  }
}

const ccDomainCache = new Map<string, Cached<CcRecord[]>>();

/** Every HTML page Common Crawl holds for a domain, newest crawls first. */
async function ccRecords(domain: string): Promise<CcRecord[]> {
  const key = domain.toLowerCase();
  const cached = ccDomainCache.get(key);
  const hit = fresh(cached, cached?.data.length ? CACHE_MS : NEG_CACHE_MS);
  if (hit) return hit;
  if (!usable("commoncrawl")) return cached?.data || [];

  const out: CcRecord[] = [];
  const seen = new Set<string>();
  // Coverage is wildly uneven between crawls, so every index gets asked even if
  // an earlier one erred. `answered` tracks whether the SOURCE responded at all
  // — one shard 502-ing while another serves 40 rows is a healthy lookup.
  let answered = false;
  for (const api of await ccIndexes()) {
    const url = `${api}?url=${encodeURIComponent(key)}&matchType=domain&output=json&limit=${CC_ROWS}`;
    const r = await paced("commoncrawl-index", CC_INDEX_GAP_MS, () =>
      rawFetch(url, { timeoutMs: 30_000, headers: browserHeaders(), via: "commoncrawl", trustBody: true, anyContentType: true })
    );
    // 404 = this crawl simply has no captures for the domain. That is an answer,
    // not a failure, and must not count towards the backoff.
    if (r.status === 404) { answered = true; continue; }
    if (!r.ok) continue;
    answered = true;
    for (const line of r.html.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const rec = JSON.parse(t);
        if (rec.status !== "200" || !/html/i.test(rec.mime || rec["mime-detected"] || "")) continue;
        const u = String(rec.url || "");
        if (!u || seen.has(pathKey(u))) continue;
        seen.add(pathKey(u));
        out.push({
          url: u,
          filename: String(rec.filename || ""),
          offset: Number(rec.offset),
          length: Number(rec.length),
          timestamp: String(rec.timestamp || ""),
        });
      } catch { /* a malformed row is not worth failing the lookup over */ }
    }
    if (out.length >= 25) break; // plenty to pick a contact page from
  }

  if (answered) noteOk("commoncrawl");
  else noteFail("commoncrawl", "no index answered");
  ccDomainCache.set(key, { at: Date.now(), data: out });
  return out;
}

/** Inflate one WARC range and peel off the WARC + HTTP header blocks. */
function warcBody(bytes: Uint8Array): string {
  let raw: string;
  try {
    raw = gunzipSync(bytes).toString("utf8");
  } catch {
    // A truncated member still holds the head of the document, which is where
    // the contact details usually are — take what inflated rather than nothing.
    try {
      raw = gunzipSync(bytes, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString("utf8");
    } catch {
      return "";
    }
  }
  // WARC headers, blank line, HTTP response headers, blank line, then the body.
  const first = raw.indexOf("\r\n\r\n");
  if (first < 0) return raw;
  const second = raw.indexOf("\r\n\r\n", first + 4);
  return second > 0 ? raw.slice(second + 4) : raw.slice(first + 4);
}

async function ccFetchRecord(rec: CcRecord): Promise<FetchResult> {
  if (!rec.filename || !Number.isFinite(rec.offset) || !Number.isFinite(rec.length)) {
    return { ok: false, status: 0, url: rec.url, html: "", contentType: "", error: "bad record", via: "commoncrawl" };
  }
  const end = rec.offset + rec.length - 1;
  const r = await paced("commoncrawl-data", CC_DATA_GAP_MS, () =>
    rawBytes(CC_DATA + rec.filename, {
      timeoutMs: 40_000,
      headers: { ...browserHeaders(), Range: `bytes=${rec.offset}-${end}` },
    })
  );
  if (!r.ok) {
    noteFail("commoncrawl", `data ${r.status}`);
    return { ok: false, status: r.status, url: rec.url, html: "", contentType: "", error: r.error, via: "commoncrawl" };
  }
  const html = warcBody(r.bytes);
  if (!html.trim()) {
    return { ok: false, status: 0, url: rec.url, html: "", contentType: "", error: "empty WARC body", via: "commoncrawl" };
  }
  noteOk("commoncrawl");
  return { ok: true, status: 200, url: rec.url, html, contentType: "text/html", via: "commoncrawl" };
}

/** Read one specific page out of Common Crawl. */
export async function fetchViaCommonCrawl(target: string): Promise<FetchResult> {
  const miss = (error: string): FetchResult =>
    ({ ok: false, status: 404, url: target, html: "", contentType: "", error, via: "commoncrawl" });
  if (!CC_ENABLED || !usable("commoncrawl")) return miss("common crawl unavailable");
  const domain = registrableDomain(hostOf(target)) || hostOf(target);
  if (!domain) return miss("no domain");
  const records = await ccRecords(domain);
  if (!records.length) return miss("not in common crawl");
  const want = pathKey(target);
  const exact = records.find((r) => pathKey(r.url) === want);
  if (!exact) return miss("page not in common crawl");
  return ccFetchRecord(exact);
}

/* ============================== Wayback ================================ */

const WB_CDX = "https://web.archive.org/cdx/search/cdx";
const WB_GAP_MS = 2_000; // archive.org 429s quickly; this is the price of using it
const WB_ENABLED = process.env.DISABLE_WAYBACK !== "1";

interface WbRecord { url: string; timestamp: string }

const wbDomainCache = new Map<string, Cached<WbRecord[]>>();

/** Which pages of a domain archive.org holds (one CDX call per domain). */
async function wbRecords(domain: string): Promise<WbRecord[]> {
  const key = domain.toLowerCase();
  const cached = wbDomainCache.get(key);
  const hit = fresh(cached, cached?.data.length ? CACHE_MS : NEG_CACHE_MS);
  if (hit) return hit;
  if (!usable("archive")) return cached?.data || [];

  // collapse=urlkey → one row per page (the newest), not one per snapshot.
  const url =
    `${WB_CDX}?url=${encodeURIComponent(key)}&matchType=domain&output=json` +
    `&fl=timestamp,original&filter=statuscode:200&filter=mimetype:text/html` +
    `&collapse=urlkey&limit=-200`;
  const r = await paced("archive-cdx", WB_GAP_MS, () =>
    rawFetch(url, { timeoutMs: 30_000, headers: browserHeaders(), via: "archive", trustBody: true, anyContentType: true })
  );
  if (!r.ok) {
    noteFail("archive", `cdx ${r.status}`);
    return cached?.data || [];
  }
  noteOk("archive");
  const out: WbRecord[] = [];
  const seen = new Set<string>();
  try {
    const rows = JSON.parse(r.html) as string[][];
    for (const row of rows.slice(1)) {
      const [timestamp, original] = row;
      if (!original || seen.has(pathKey(original))) continue;
      seen.add(pathKey(original));
      out.push({ url: original, timestamp });
    }
  } catch { /* CDX occasionally answers with an HTML error page */ }
  wbDomainCache.set(key, { at: Date.now(), data: out });
  return out;
}

/**
 * Read one page from the Wayback Machine.
 *
 * "id_" is the raw-content modifier: it returns the ORIGINAL html exactly as
 * archived, without the Wayback toolbar/banner injected. That matters because
 * the toolbar carries archive.org's own addresses, which would otherwise be
 * extracted as if they belonged to the company.
 *
 * The default timestamp is deliberately far in the future. Wayback returns the
 * snapshot NEAREST the timestamp you ask for, so the old `2id_` was asking for
 * the year 2 — i.e. the OLDEST capture on file. For an email address that is
 * precisely the wrong end of the history; `3000` asks for the newest.
 */
export async function fetchViaWayback(target: string, timestamp = "3000"): Promise<FetchResult> {
  const clean = target.replace(/^https?:\/\//i, "");
  const once = () =>
    paced("archive-web", WB_GAP_MS, () =>
      rawFetch(`https://web.archive.org/web/${timestamp}id_/https://${clean}`, {
        timeoutMs: 25_000,
        headers: browserHeaders(),
        reportUrl: target,
        via: "archive",
      })
    );

  let r = await once();
  // archive.org throttles in short bursts rather than sustained bans, so one
  // patient retry converts a good share of 429s into the page we came for.
  // Only while it still looks like a blip, though: once it has refused us
  // repeatedly, waiting another 4s per page is just slowing the crawl down.
  if (!r.ok && r.status === 429 && !(health.get("archive")?.fails)) {
    await sleep(4_000);
    r = await once();
  }

  // Archive.org having no snapshot (404) or throttling us (429) is not a
  // property of the TARGET site, so it must never be reported as a site block.
  if (!r.ok) {
    r.blocked = false;
    r.blockReason = undefined;
    r.error = r.status === 404 ? "no archived snapshot" : `archive ${r.status}`;
    if (r.status === 429 || r.status === 0 || r.status >= 500) noteFail("archive", `web ${r.status}`);
  } else {
    noteOk("archive");
  }
  return r;
}

/* ========================= combined page finder ======================== */

// Deliberately generous: these are the paths that actually carry an address,
// and an archive lookup is free, so casting wider costs nothing but a sort.
const WANTED = /(contact|about|impressum|imprint|kontakt|reach-?us|get-?in-?touch|team|support|enquir|inquir|locations?|offices?)/i;

function rankArchived(url: string): number {
  let score = scoreLink(url);
  if (WANTED.test(url)) score += 6;
  try {
    if ((new URL(url).pathname.replace(/\/+$/, "") || "/") === "/") score += 4; // the homepage footer
  } catch { /* ignore */ }
  return score;
}

/**
 * The archived pages of a domain most likely to carry an email address.
 *
 * This is the part that cracks a site we can never open: we don't need a link
 * from the live site to know its /contact page exists, because the archive's
 * index already told us. Common Crawl is listed first — it is faster and has no
 * meaningful rate limit — with Wayback filling the (many) gaps.
 */
export async function archivedPagesFor(domain: string, max = 4): Promise<ArchivedPage[]> {
  const d = registrableDomain(domain) || domain;
  if (!d) return [];

  const [cc, wb] = await Promise.all([
    CC_ENABLED && usable("commoncrawl") ? ccRecords(d).catch(() => [] as CcRecord[]) : Promise.resolve([] as CcRecord[]),
    WB_ENABLED && usable("archive") ? wbRecords(d).catch(() => [] as WbRecord[]) : Promise.resolve([] as WbRecord[]),
  ]);

  const pages: { page: ArchivedPage; score: number }[] = [];
  const seen = new Set<string>();

  for (const rec of cc) {
    const k = pathKey(rec.url);
    if (seen.has(k)) continue;
    seen.add(k);
    pages.push({
      score: rankArchived(rec.url) + 1, // tie-break towards the cheaper source
      page: { url: rec.url, source: "commoncrawl", fetch: () => ccFetchRecord(rec) },
    });
  }
  for (const rec of wb) {
    const k = pathKey(rec.url);
    if (seen.has(k)) continue;
    seen.add(k);
    pages.push({
      score: rankArchived(rec.url),
      page: { url: rec.url, source: "archive", fetch: () => fetchViaWayback(rec.url, rec.timestamp) },
    });
  }

  pages.sort((a, b) => b.score - a.score);

  // Nothing indexed. That is often the CDX API throttling us rather than the
  // archive genuinely being empty — and `/web/` is a separate bucket that
  // frequently still answers. Guessing the two paths that actually carry an
  // address is cheap insurance against losing the whole domain to a 429.
  if (!pages.length && WB_ENABLED && usable("archive")) {
    for (const path of ["/", "/contact"]) {
      const url = `https://${d}${path}`;
      pages.push({ score: 0, page: { url, source: "archive", fetch: () => fetchViaWayback(url) } });
    }
    log(`${d}: nothing in either index — trying the archive's homepage + /contact directly`);
  }

  const picked = pages.slice(0, max).map((p) => p.page);
  if (picked.length && (cc.length || wb.length)) {
    log(`${d}: ${cc.length} page(s) in Common Crawl · ${wb.length} in the Wayback Machine → reading ${picked.length}`);
  }
  return picked;
}

/**
 * Best-effort read of one page from ANY free archive.
 *
 * Used as a fetch tier: try the exact page in Common Crawl (fast, unlimited),
 * then the Wayback snapshot of the same URL.
 */
export async function fetchViaArchives(target: string): Promise<FetchResult> {
  if (CC_ENABLED && usable("commoncrawl")) {
    const cc = await fetchViaCommonCrawl(target).catch(() => null);
    if (cc?.ok && cc.html) return cc;
  }
  if (WB_ENABLED && usable("archive")) {
    const wb = await fetchViaWayback(target).catch(() => null);
    if (wb?.ok && wb.html) return wb;
  }
  return { ok: false, status: 404, url: target, html: "", contentType: "", error: "not archived", via: "archive" };
}

/* ==================== Common Crawl as a COUNTRY INDEX ====================
 *
 * Everything above treats Common Crawl as a way to read ONE page we already
 * know about. It is also the opposite thing: a list of every page it has ever
 * crawled, queryable by URL pattern — and `*.qa` is "the Qatari web".
 *
 * That matters because a keyword search has a hard ceiling. Measured from this
 * container, the free engines return 10-20 results per query and only one of
 * them paginates at all, so a country sweep tops out in the low thousands of
 * results however many queries you write. The index has no such ceiling:
 *
 *     *.qa   23 index pages · ~13,800 records/page · ~220 NEW hosts per page
 *     *.sa   73 pages        *.ae  161 pages        *.jo  24 pages
 *
 * — about 8 seconds per page, free, keyless, and with no rate limit worth the
 * name. That is the difference between "some of the companies that rank for a
 * phrase" and "the companies that have a website in this country".
 *
 * A `*.qa` query returns `foo.com.qa` as well as `foo.qa` (the index is sorted
 * by reversed domain, so the second-level suffixes simply appear on later
 * pages) — so one pattern per country is enough.
 *
 * WARNING: the CDX server's `filter=` parameter 404s on this endpoint (measured
 * with `~url:contract`), so any narrowing has to happen on our side, on the
 * URLs the index hands back. That is why this returns the URLs it saw per host
 * rather than just the hostnames.
 */

// A sweep page is a MULTI-MEGABYTE response (~12,000 index rows), not the
// 60-row lookup the rest of this file makes. Fifteen of them in quick
// succession was enough to make index.commoncrawl.org close the connection on
// this IP for several minutes while building the feature — so the sweep gets
// its own, much slower pacer, and the plan interleaves sweep steps between
// queries rather than running them back to back.
const CC_SWEEP_GAP_MS = 6_000;

// Used only when collinfo.json cannot be reached. Everything in the sweep
// depends on knowing ONE valid index id, and collinfo is a single point of
// failure for that — it refuses a hot IP exactly when a sweep has been busy,
// which is the moment the sweep still has pages to walk. These ids either
// answer or they do not; a stale one costs a single 404 and the next is tried.
const CC_FALLBACK_INDEXES = [
  "CC-MAIN-2026-30", "CC-MAIN-2026-22", "CC-MAIN-2026-13", "CC-MAIN-2026-05",
  "CC-MAIN-2025-38", "CC-MAIN-2025-30", "CC-MAIN-2025-21", "CC-MAIN-2025-13", "CC-MAIN-2025-05",
];
const ccFallbackApis = () => CC_FALLBACK_INDEXES.map((id) => `https://index.commoncrawl.org/${id}-index`);

/** One host the country index knows about, and the URLs it was seen at. */
export interface CcHost {
  host: string;
  urls: string[];
}

export interface CcHostPage {
  hosts: CcHost[];
  /** The index answered — distinguishes "no hosts here" from "we never asked". */
  ok: boolean;
  /** True when the page index is past the end of this pattern's results. */
  pastEnd: boolean;
  records: number;
}

/** The live index list, or the static fallback when collinfo is refusing us. */
async function ccSweepApis(): Promise<string[]> {
  const live = await ccIndexes().catch(() => []);
  return live.length ? live : ccFallbackApis();
}

const ccPageCountCache = new Map<string, Cached<number>>();

/**
 * How many index pages this pattern has. Cached for half a day: a Common Crawl
 * index is immutable once published, and the count only moves when a new crawl
 * is released.
 *
 * Returns 0 when the index cannot be reached, which callers must read as "no
 * sweep this pass" rather than "no pages" — a sweep that silently became empty
 * is exactly the kind of thing that looks like it is working.
 */
export async function ccPageCount(pattern: string): Promise<number> {
  if (!CC_ENABLED) return 0;
  const key = pattern.toLowerCase();
  const hit = fresh(ccPageCountCache.get(key), 12 * 60 * 60 * 1000);
  if (hit !== undefined) return hit;
  const apis = await ccSweepApis();
  if (!apis.length) return 0;
  const url = `${apis[0]}?url=${encodeURIComponent(pattern)}&output=json&showNumPages=true`;
  const r = await paced("commoncrawl-index", CC_SWEEP_GAP_MS, () =>
    rawFetch(url, { timeoutMs: 30_000, headers: browserHeaders(), via: "commoncrawl", trustBody: true, anyContentType: true })
  );
  if (!r.ok) { noteFail("commoncrawl", `numpages ${r.status}`); return 0; }
  try {
    const n = Number(JSON.parse(r.html.trim()).pages) || 0;
    noteOk("commoncrawl");
    ccPageCountCache.set(key, { at: Date.now(), data: n });
    return n;
  } catch {
    noteFail("commoncrawl", "numpages parse");
    return 0;
  }
}

/**
 * One page of the country index, collapsed to hosts.
 *
 * A page is ~14,000 URL records covering ~220 distinct hosts, so the collapse
 * happens here — handing 14,000 rows back to the caller would make every
 * consumer re-do the same grouping.
 */
export async function ccHostsForPattern(pattern: string, page: number): Promise<CcHostPage> {
  const empty: CcHostPage = { hosts: [], ok: false, pastEnd: false, records: 0 };
  if (!CC_ENABLED || !usable("commoncrawl")) return empty;
  const apis = await ccSweepApis();
  if (!apis.length) return empty;

  const url = `${apis[0]}?url=${encodeURIComponent(pattern)}&output=json&page=${page}`;
  const r = await paced("commoncrawl-index", CC_SWEEP_GAP_MS, () =>
    rawFetch(url, { timeoutMs: 60_000, headers: browserHeaders(), via: "commoncrawl", trustBody: true, anyContentType: true })
  );
  // Past the last page the server answers **400**, not 404, with a body of
  //   {"message": "Page 17 invalid: First Page is 0, Last Page is 16"}
  // That is an ANSWER — it is how a sweep learns it has finished — and it must
  // not count towards the backoff. Getting this wrong would be expensive well
  // beyond the sweep: four of them in a row trips `noteFail`, which rests
  // Common Crawl for EVERY caller, including the archive fetch tier the crawler
  // leans on to crack walled sites. That is the same shape as the bug an
  // earlier wave already fixed once ("a single 502 from one shard disabled
  // Common Crawl for every domain that followed").
  // (The body would say so in words, but `rawFetch` deliberately discards the
  // body on a non-OK status, so the code is all we get. We build this query
  // ourselves and it is always well formed, so a 400 can only mean the page
  // index is out of range.)
  if (r.status === 404 || r.status === 400) {
    noteOk("commoncrawl");
    return { hosts: [], ok: true, pastEnd: true, records: 0 };
  }
  if (!r.ok) { noteFail("commoncrawl", `sweep ${r.status}`); return empty; }

  const byHost = new Map<string, string[]>();
  let records = 0;
  for (const line of r.html.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let rec: any;
    try { rec = JSON.parse(t); } catch { continue; }
    if (rec.status && rec.status !== "200") continue;
    const mime = String(rec.mime || rec["mime-detected"] || "");
    if (mime && !/html/i.test(mime)) continue;
    const u = String(rec.url || "");
    if (!u) continue;
    records++;
    let host = "";
    try { host = hostOf(u); } catch { continue; }
    if (!host) continue;
    const list = byHost.get(host);
    // A handful of sample URLs per host is enough for a caller to decide
    // whether it looks relevant; a busy host can hold thousands of rows on a
    // single index page and keeping them all would balloon the memory for
    // nothing.
    if (list) { if (list.length < 8) list.push(u); }
    else byHost.set(host, [u]);
  }

  noteOk("commoncrawl");
  return {
    hosts: [...byHost.entries()].map(([host, urls]) => ({ host, urls })),
    ok: true,
    pastEnd: records === 0,
    records,
  };
}
