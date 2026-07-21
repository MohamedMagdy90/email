// Generic business-directory harvester.
// Paste ONE listing URL (e.g. a "companies in Qatar" directory) and this:
//   1. walks the pagination (?page=N, /page/N, rel=next, …)
//   2. auto-detects the repeating "card" link pattern → the detail pages
//   3. opens each detail page and pulls company name + email + phone (mobile
//      preferred) using the same extractors the normal crawler uses
//   4. drops "site chrome" — an email/phone that appears on most pages is the
//      DIRECTORY's own contact, not a listing's, so it's filtered out
// Nothing is hardcoded to any specific site.

import { fetchWithRetry, type FetchResult, type BlockReason, type ProxyConfig } from "./fetcher";
import { extractEmails, decodeEntities } from "./extract";
import { extractPhones, bestPhone, regionFromCountryName, type PhoneHit } from "./phones";
import { cleanEmail, isValidEmail, isJunk, isRole, hasMx } from "./validate";
import { normalizeSeed, hostOf, registrableDomain } from "./urls";
import { loadRobots } from "./robots";

export interface DirectoryContact {
  name: string;
  email: string | null;
  phone: string | null;
  phoneMobile?: boolean;
  role_based: boolean;
  detailUrl: string;
  domain: string;
  mx?: boolean;
}

export interface DirectoryResult {
  seed: string;
  site: string;
  status: "ok" | "error" | "empty" | "blocked";
  listingPages: number;
  detailPages: number;
  contacts: DirectoryContact[];
  note?: string;
  // Set when the crawler auto-switched to a better listings/index URL because the
  // URL you gave (e.g. a homepage) had no companies. The worker persists this so
  // the source pages the correct URL from then on.
  resolvedSeed?: string;
}

export interface DirectoryOptions {
  maxPages?: number; // listing/index pages to walk
  maxDetails?: number; // detail pages to open
  concurrency?: number; // detail fetches in parallel
  respectRobots?: boolean;
  checkMx?: boolean;
  defaultCountry?: string; // country hint (prefers local numbers, parses local formats)
  timeoutMs?: number;
  politenessMs?: number;
  proxy?: ProxyConfig; // optional scraping proxy for JS-rendered / Cloudflare sites
  readerKey?: string; // optional (free) Jina Reader key — renders JS / bypasses soft blocks for free
  startPage?: number; // page number the seed represents (for continuous cursor walking)
}

export interface DirectoryProgress {
  type: "page" | "detail" | "phase";
  msg?: string;
  url?: string;
  listingPages?: number;
  detailPages?: number;
  detailTotal?: number;
  contacts?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Plain-language reason for a refused request, shown live in the crawl log.
function describeBlock(res: FetchResult): string {
  switch (res.blockReason) {
    case "cloudflare": return "blocked by Cloudflare (JavaScript challenge)";
    case "rate-limited": return "rate limited (HTTP 429)";
    case "forbidden": return "access forbidden — bot protection";
    case "blocked": return "blocked — bot protection / captcha";
    default: return res.error === "non-html" ? "not an HTML page" : res.error === "timeout" ? "timed out" : "";
  }
}

// One-line summary attached to the result so the UI can explain an empty harvest.
// `hasProxy` = a scraping proxy was configured and attempted, which changes the
// advice from "connect a proxy" to "your proxy couldn't get through".
function blockNote(reason: BlockReason | undefined, hasProxy = false): string {
  switch (reason) {
    case "cloudflare":
      return hasProxy
        ? "This site is protected by Cloudflare's JavaScript challenge and your scraping proxy couldn't solve it. Turn on Premium/stealth mode in Settings → Crawler, or try another provider."
        : "This site is protected by Cloudflare's JavaScript challenge, so it can't be read directly. Connect a scraping proxy in Settings → Crawler — scraping proxy (ScrapingBee / ScraperAPI / ZenRows) to crawl it.";
    case "rate-limited":
      return "The site rate-limited the crawler (HTTP 429). Try again later or lower the concurrency.";
    case "forbidden":
      return hasProxy
        ? "The site refused the crawler (HTTP 403) even through the proxy. Enable Premium/stealth mode in Settings → Crawler, or try another provider."
        : "The site refused the crawler (HTTP 403 bot protection). Connect a scraping proxy in Settings → Crawler to get past it.";
    case "blocked":
      return hasProxy
        ? "The site served a block / captcha page even through the proxy. Enable Premium/stealth mode, or try another provider."
        : "The site served a block / captcha page. Connect a scraping proxy in Settings → Crawler to get past it.";
    default:
      return "The site blocked the crawler.";
  }
}

/* ----------------------------- link parsing ----------------------------- */

// Path segments that are navigation/taxonomy, never a business listing.
const NAV_STOP = new Set([
  "about", "about-us", "aboutus", "contact", "contact-us", "contactus", "contacts",
  "login", "log-in", "signin", "sign-in", "signup", "sign-up", "register", "auth",
  "category", "categories", "cat", "tag", "tags", "topic", "topics",
  "page", "pages", "blog", "blogs", "news", "article", "articles", "post", "posts",
  "privacy", "terms", "policy", "cookie", "cookies", "faq", "faqs", "help", "support",
  "search", "find", "filter", "sort", "browse", "explore",
  "country", "countries", "city", "cities", "region", "regions", "state", "states",
  "grade", "industry", "industries", "sector", "sectors", "service", "services",
  "profile", "profiles", "user", "users", "account", "accounts", "member", "members",
  "cart", "checkout", "wishlist", "compare", "feed", "rss", "sitemap",
  "author", "authors", "home", "index", "listings", "directory", "all",
  "en", "ar", "fr", "de", "es", "app", "apps", "shop", "store",
]);

const PAGE_PARAMS = ["page", "paged", "pg", "p", "start", "offset"];
const PATH_PAGE_RE = /^(.*?)\/(?:page|p)[-/](\d+)\/?$/i;

function decode(seg: string): string {
  try { return decodeURIComponent(seg); } catch { return seg; }
}

function pageParamOf(u: URL): string | null {
  for (const k of PAGE_PARAMS) {
    const v = u.searchParams.get(k);
    if (v != null && /^\d+$/.test(v)) return k;
  }
  return null;
}

function stripPageParams(u: URL): string {
  const c = new URL(u.toString());
  for (const k of PAGE_PARAMS) c.searchParams.delete(k);
  return c.search;
}

// The next sequential page URL (?page=N → ?page=N+1, or /page/N → /page/N+1).
// Used to keep walking deep directories whose pager only shows a small window
// ("1 2 3 … next") and never links the far pages directly.
function nextPageUrl(u: URL): string | null {
  const k = pageParamOf(u);
  if (k) {
    const n = Number(u.searchParams.get(k));
    if (Number.isInteger(n) && n > 0) {
      const c = new URL(u.toString());
      c.searchParams.set(k, String(n + 1));
      return c.toString();
    }
  }
  const pm = u.pathname.match(PATH_PAGE_RE);
  if (pm) {
    const n = Number(pm[2]);
    if (Number.isInteger(n) && n > 0) {
      const c = new URL(u.toString());
      c.pathname = u.pathname.replace(/(\d+)(\/?)$/, `${n + 1}$2`);
      return c.toString();
    }
  }
  // Trailing bare number segment (e.g. /listings/31 → /listings/32). Only called
  // on listing pages that yielded new cards, so it walks deep pagers that only
  // ever show "1 2 3 … next" and never link the far pages.
  const bm = u.pathname.match(/\/(\d+)(\/?)$/);
  if (bm) {
    const n = Number(bm[1]);
    if (Number.isInteger(n) && n > 0) {
      const c = new URL(u.toString());
      c.pathname = u.pathname.replace(/\d+(\/?)$/, `${n + 1}$1`);
      return c.toString();
    }
  }
  return null;
}

// Reduce a path to a template where slug/id segments become "*".
function pathTemplate(pathname: string): { key: string; placeholders: number; literals: string[] } {
  const segs = pathname.split("/").filter(Boolean).map(decode);
  const parts = segs.map((seg) => {
    const s = seg.toLowerCase();
    const hyphens = (s.match(/-/g) || []).length;
    if (/\d/.test(s) || s.length > 24 || hyphens >= 2) return "*";
    return s;
  });
  return {
    key: "/" + parts.join("/"),
    placeholders: parts.filter((p) => p === "*").length,
    literals: parts.filter((p) => p !== "*"),
  };
}

// Gather every candidate link on a page: <a href> plus data-route/href/url/link
// attributes (many directories put the card link in a data-* attribute).
function collectLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  const push = (raw: string) => {
    const href = (raw || "").trim();
    if (!href || /^(#|mailto:|tel:|javascript:|data:|whatsapp:)/i.test(href)) return;
    try {
      const abs = new URL(href, base);
      abs.hash = "";
      if (abs.protocol === "http:" || abs.protocol === "https:") out.add(abs.toString());
    } catch { /* ignore */ }
  };
  let m: RegExpExecArray | null;
  const A = /<a\b[^>]*?href\s*=\s*["']?([^"'\s>]+)["']?/gi;
  while ((m = A.exec(html))) push(m[1]);
  const D = /\bdata-(?:route|href|url|link|permalink)\s*=\s*["']([^"']+)["']/gi;
  while ((m = D.exec(html))) push(m[1]);
  return [...out];
}

function isPaginationUrl(u: URL): boolean {
  return !!pageParamOf(u) || PATH_PAGE_RE.test(u.pathname);
}

// Pagination links that point at another page of THIS same listing.
function findPageLinks(seed: string, links: string[], html: string, base: string): string[] {
  const s = new URL(seed);
  const sReg = registrableDomain(s.hostname);
  const sPath = s.pathname.replace(/\/+$/, "");
  const sQuery = stripPageParams(s);
  const out = new Set<string>();

  for (const href of links) {
    let u: URL;
    try { u = new URL(href); } catch { continue; }
    if (registrableDomain(u.hostname) !== sReg) continue;
    if (pageParamOf(u)) {
      if (u.pathname.replace(/\/+$/, "") === sPath && stripPageParams(u) === sQuery) out.add(u.toString());
      continue;
    }
    const pm = u.pathname.match(PATH_PAGE_RE);
    if (pm && pm[1].replace(/\/+$/, "") === sPath && u.search === sQuery) out.add(u.toString());
  }

  // rel="next" (link or a) as a fallback for "next"-only pagers.
  const rel = /<(?:a|link)\b[^>]*rel\s*=\s*["'][^"']*\bnext\b[^"']*["'][^>]*href\s*=\s*["']([^"']+)["']/gi;
  const rel2 = /<(?:a|link)\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["'][^"']*\bnext\b[^"']*["']/gi;
  for (const re of [rel, rel2]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      try { out.add(new URL(m[1], base).toString()); } catch { /* ignore */ }
    }
  }
  return [...out];
}

// The repeating "card" links = the detail pages. Chosen by finding the dominant
// non-navigation URL template on the page.
function findDetailLinks(seed: string, links: string[]): string[] {
  const s = new URL(seed);
  const sReg = registrableDomain(s.hostname);
  const seedKey = pathTemplate(s.pathname).key;

  // Segments in the seed's own path are the directory root, so their detail
  // children (e.g. seed /listings → /listings/acme) must NOT be dropped as
  // "navigation" even when they'd normally be a NAV_STOP word.
  const seedSegs = new Set(s.pathname.split("/").filter(Boolean).map((x) => decode(x).toLowerCase()));
  const navBlocks = (l: string) => NAV_STOP.has(l) && !seedSegs.has(l);

  const byTpl = new Map<string, Set<string>>();
  const bySeg = new Map<string, Set<string>>();

  for (const href of links) {
    let u: URL;
    try { u = new URL(href); } catch { continue; }
    if (registrableDomain(u.hostname) !== sReg) continue;
    if (isPaginationUrl(u)) continue;
    const segs = u.pathname.split("/").filter(Boolean);
    if (!segs.length) continue;

    const { key, placeholders, literals } = pathTemplate(u.pathname);
    const full = u.origin + u.pathname + u.search;
    const first = decode(segs[0]).toLowerCase();

    if (placeholders > 0 && !literals.some(navBlocks) && key !== seedKey) {
      let set = byTpl.get(key); if (!set) { set = new Set(); byTpl.set(key, set); }
      set.add(full);
    }
    // Fallback grouping by first path segment (for word-slug details with no id).
    if (segs.length >= 2 && !navBlocks(first)) {
      let set = bySeg.get(first); if (!set) { set = new Set(); bySeg.set(first, set); }
      set.add(full);
    }
  }

  // Winning wildcard template (e.g. "/listing/*").
  let bestTplKey = "";
  let bestTpl: Set<string> | null = null;
  for (const [key, set] of byTpl) if (!bestTpl || set.size > bestTpl.size) { bestTpl = set; bestTplKey = key; }

  // Winning first-path-segment bucket (e.g. every "/listing/…" link).
  let bestSegKey = "";
  let bestSeg: Set<string> | null = null;
  for (const [key, set] of bySeg) if (!bestSeg || set.size > bestSeg.size) { bestSeg = set; bestSegKey = key; }

  // Prefer the first-segment bucket when it shares the winning template's lead
  // segment and is at least as large. The wildcard template alone skips clean
  // one-word slugs like /listing/shark or /listing/kreston-svp (no digit, <2
  // hyphens), so those listings would be silently lost. Unioning by the shared
  // "/listing/" segment recovers every sibling detail page in the same bucket.
  const tplLead = bestTplKey.split("/").filter(Boolean)[0] || "";
  if (bestTpl && bestSeg && bestSegKey && bestSegKey === tplLead && bestSeg.size >= bestTpl.size) {
    return [...bestSeg];
  }
  if (bestTpl && bestTpl.size >= 2) return [...bestTpl];
  if (bestSeg && bestSeg.size >= 3) return [...bestSeg];
  return [];
}

// Path words that mark a directory's "index" page — where the real listings live.
const INDEX_WORDS = new Set([
  "listings", "listing", "directory", "directories", "companies", "company",
  "businesses", "business", "members", "member", "catalog", "catalogue",
  "browse", "firms", "organizations", "organisations", "vendors", "suppliers",
  "stores", "shops", "brands", "profiles", "results", "search",
]);

// When the pasted URL (often a homepage) has no usable companies, find the best
// internal link that looks like the directory's index page so the crawl can be
// retargeted there automatically. Returns candidate URLs, best-first.
function pickIndexCandidates(seed: string, links: string[]): string[] {
  let s: URL;
  try { s = new URL(seed); } catch { return []; }
  const sReg = registrableDomain(s.hostname);
  const score = new Map<string, number>();
  const popularity = new Map<string, number>();

  for (const href of links) {
    let u: URL;
    try { u = new URL(href); } catch { continue; }
    if (registrableDomain(u.hostname) !== sReg) continue;
    const segs = u.pathname.split("/").filter(Boolean).map((x) => decode(x).toLowerCase());
    if (!segs.length) continue;
    const idx = segs.findIndex((x) => INDEX_WORDS.has(x));
    if (idx < 0) continue;
    // Truncate the path at the index word: /a/listings/102 → /a/listings.
    const norm = u.origin + "/" + segs.slice(0, idx + 1).join("/");
    popularity.set(norm, (popularity.get(norm) || 0) + 1);
    if (score.has(norm)) continue;
    let sc = 0;
    if (idx === 0 && segs.length === 1) sc += 6;                    // exactly /listings
    if (idx === segs.length - 1) sc += 3;                          // index word ends the path
    if (["listings", "directory", "companies", "businesses", "listing"].includes(segs[idx])) sc += 3;
    sc += Math.max(0, 4 - (idx + 1));                              // shallower = better
    score.set(norm, sc);
  }

  const seedNorm = (s.origin + s.pathname).replace(/\/+$/, "");
  return [...score.keys()]
    .filter((u) => u.replace(/\/+$/, "") !== seedNorm)
    .sort((a, b) =>
      (score.get(b)! + Math.min(5, popularity.get(b) || 0)) -
      (score.get(a)! + Math.min(5, popularity.get(a) || 0))
    );
}

/* ----------------------------- extraction ------------------------------- */

const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// Strip a trailing "| Site", " – Category", " · X" style suffix directories add.
function stripSuffix(name: string): string {
  const first = name.split(/\s*[|·•]\s*|\s[–—]\s|\s-\s/)[0].trim();
  return first.length >= 2 ? first : name;
}
// decodeEntities twice to unwind double-encoded titles (&amp;amp; → &).
const finalizeName = (s: string) =>
  stripSuffix(decodeEntities(decodeEntities(s)).replace(/\s+/g, " ").trim()).slice(0, 140);

function extractName(html: string): string {
  let m =
    html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i) ||
    html.match(/<meta[^>]+name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i);
  if (m && m[1].trim()) return finalizeName(m[1]);
  m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (m) { const t = stripTags(m[1]); if (t) return finalizeName(t); }
  m = html.match(/"(?:legalName|name)"\s*:\s*"([^"]{2,120})"/i);
  if (m && m[1].trim()) return finalizeName(m[1]);
  m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) { const t = stripTags(m[1]); if (t) return finalizeName(t); }
  return "";
}

function pickEmails(html: string): { email: string; role: boolean }[] {
  const out: { email: string; role: boolean }[] = [];
  const seen = new Set<string>();
  for (const h of extractEmails(html)) {
    const c = cleanEmail(h.email);
    if (!c || !isValidEmail(c) || isJunk(c)) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push({ email: c, role: isRole(c) });
  }
  return out;
}

interface Record { url: string; name: string; emails: { email: string; role: boolean }[]; phones: PhoneHit[]; }

/* ------------------------------- crawl ---------------------------------- */

// Paste ONE URL and get back a corrected, fully-walked directory result. If the
// URL you gave has no companies (e.g. a homepage), it auto-retargets to the best
// "listings/directory/companies" link it can find on that page and tries again.
export async function crawlDirectory(
  seedInput: string,
  opts: DirectoryOptions = {},
  onProgress?: (p: DirectoryProgress) => void
): Promise<DirectoryResult> {
  const seed = normalizeSeed(seedInput);
  if (!seed) return { seed: seedInput, site: seedInput, status: "error", listingPages: 0, detailPages: 0, contacts: [], note: "invalid URL" };

  const firstLinks: string[] = [];
  const result = await crawlOnce(seed, opts, onProgress, (links) => {
    if (!firstLinks.length) firstLinks.push(...links);
  });

  // If we harvested nothing (and weren't hard-blocked), the URL probably isn't
  // the listings page. Follow the strongest "index" link on it and retry once.
  if (result.contacts.length === 0 && (result.status === "ok" || result.status === "empty")) {
    const candidates = pickIndexCandidates(seed, firstLinks).slice(0, 2);
    for (const cand of candidates) {
      onProgress?.({ type: "phase", msg: `No companies on that page — trying the directory index: ${cand}` });
      const retry = await crawlOnce(cand, opts, onProgress);
      if (retry.contacts.length > 0) { retry.resolvedSeed = cand; return retry; }
      if (retry.status === "blocked") return retry;
    }
  }
  return result;
}

async function crawlOnce(
  seed: string,
  opts: DirectoryOptions = {},
  onProgress?: (p: DirectoryProgress) => void,
  onFirstPageLinks?: (links: string[]) => void
): Promise<DirectoryResult> {
  const {
    maxPages = 20,
    maxDetails = 300,
    concurrency = 5,
    respectRobots = true,
    checkMx = true,
    defaultCountry,
    timeoutMs = 15000,
    politenessMs = 200,
    proxy,
    readerKey,
  } = opts;

  const origin = new URL(seed).origin;
  const siteHost = hostOf(seed);
  const region = regionFromCountryName(defaultCountry);
  const robots = respectRobots ? await loadRobots(origin) : { allow: () => true };

  const records: Record[] = [];

  /* Pass 1 — walk listing pages, collect detail links (+ inline fallback). */
  const pageQueue: string[] = [seed];
  const pagesSeen = new Set<string>();
  const detailUrls: string[] = [];
  const detailSeen = new Set<string>();
  let listingPages = 0;
  let blocked = 0;
  let blockReason: BlockReason | undefined;

  while (pageQueue.length && listingPages < maxPages && detailUrls.length < maxDetails) {
    const pageUrl = pageQueue.shift()!.split("#")[0];
    if (pagesSeen.has(pageUrl)) continue;
    pagesSeen.add(pageUrl);

    let path = "/"; try { path = new URL(pageUrl).pathname; } catch { /* ignore */ }
    if (respectRobots && !robots.allow(path)) continue;

    const res = await fetchWithRetry(pageUrl, 2, timeoutMs, proxy, readerKey);
    listingPages++;
    if (!res.ok) {
      if (res.blocked) { blocked++; if (!blockReason) blockReason = res.blockReason; }
      const why = describeBlock(res);
      onProgress?.({ type: "page", url: pageUrl, listingPages, msg: `page ${res.status || "error"}${why ? ` — ${why}` : ""}` });
      await sleep(politenessMs);
      continue;
    }
    const viaProxy = res.via === "proxy";

    const links = collectLinks(res.html, res.url || pageUrl);
    // Hand the first successfully-loaded page's links to the wrapper so it can
    // auto-retarget to the real listings index if this page has no companies.
    if (onFirstPageLinks) { onFirstPageLinks(links); onFirstPageLinks = undefined; }
    const details = findDetailLinks(seed, links);
    let added = 0;
    for (const d of details) {
      const dn = d.split("#")[0];
      if (detailSeen.has(dn)) continue;
      detailSeen.add(dn);
      detailUrls.push(dn);
      added++;
      if (detailUrls.length >= maxDetails) break;
    }

    // If this page has no detail links, treat it as an inline directory and
    // harvest cards straight off the page.
    if (details.length === 0) {
      for (const rec of harvestInline(res.html, res.url || pageUrl, region)) records.push(rec);
    }

    // Follow linked pagination…
    for (const pl of findPageLinks(seed, links, res.html, res.url || pageUrl)) {
      const pn = pl.split("#")[0];
      if (!pagesSeen.has(pn) && !pageQueue.includes(pn)) pageQueue.push(pn);
    }
    // …and, when this page yielded new listings, also probe the next sequential
    // page. Narrow pagers ("1 2 3 … next") never link the far pages, so
    // linked-only discovery stalls early on big directories. Gating on *new
    // detail links* (not inline footer emails) means the first empty page
    // enqueues nothing and the walk stops cleanly at the end of the list.
    if (added > 0) {
      try {
        const np = nextPageUrl(new URL(pageUrl));
        if (np) { const nn = np.split("#")[0]; if (!pagesSeen.has(nn) && !pageQueue.includes(nn)) pageQueue.push(nn); }
      } catch { /* ignore */ }
    }
    onProgress?.({ type: "page", url: pageUrl, listingPages, detailTotal: detailUrls.length, msg: `page ${listingPages}: +${added} listings${viaProxy ? " · via proxy" : ""}` });
    await sleep(politenessMs);
  }

  /* Pass 2 — open each detail page. */
  let detailPages = 0;
  let idx = 0;
  async function worker() {
    while (idx < detailUrls.length) {
      const my = idx++;
      const url = detailUrls[my];
      let path = "/"; try { path = new URL(url).pathname; } catch { /* ignore */ }
      if (respectRobots && !robots.allow(path)) continue;
      const res = await fetchWithRetry(url, 2, timeoutMs, proxy, readerKey);
      detailPages++;
      if (res.ok) {
        records.push({
          url: res.url || url,
          name: extractName(res.html),
          emails: pickEmails(res.html),
          phones: extractPhones(res.html, { defaultCountry: region, hostname: hostOf(url) }),
        });
      } else if (res.blocked) {
        blocked++;
        if (!blockReason) blockReason = res.blockReason;
      }
      if (detailPages % 5 === 0 || detailPages === detailUrls.length) {
        onProgress?.({ type: "detail", detailPages, detailTotal: detailUrls.length, contacts: records.length });
      }
      await sleep(politenessMs);
    }
  }
  onProgress?.({ type: "phase", msg: `Opening ${detailUrls.length} listing page(s)…` });
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, detailUrls.length)) }, worker));

  /* Pass 3 — drop site chrome, then assemble one contact per record. */
  const N = records.length;
  const emailFreq = new Map<string, number>();
  const phoneFreq = new Map<string, number>();
  for (const r of records) {
    for (const e of new Set(r.emails.map((x) => x.email))) emailFreq.set(e, (emailFreq.get(e) || 0) + 1);
    for (const p of new Set(r.phones.map((x) => x.number))) phoneFreq.set(p, (phoneFreq.get(p) || 0) + 1);
  }
  const chromeMin = Math.max(3, Math.ceil(N * 0.35));
  const chromeApplies = N >= 4;
  const isChromeEmail = (e: string) => chromeApplies && (emailFreq.get(e) || 0) >= chromeMin;
  const isChromePhone = (p: string) => chromeApplies && (phoneFreq.get(p) || 0) >= chromeMin;

  const contacts: DirectoryContact[] = [];
  const seenKey = new Set<string>();
  for (const r of records) {
    const emails = r.emails.filter((e) => !isChromeEmail(e.email)).sort((a, b) => Number(b.role) - Number(a.role));
    const phones = r.phones.filter((p) => !isChromePhone(p.number));
    const emailPick = emails[0];
    const phonePick = bestPhone(phones, region);
    if (!emailPick && !phonePick) continue;

    const email = emailPick?.email || null;
    const phone = phonePick?.formatted || null;
    const key = email || phone || r.url;
    if (seenKey.has(key)) continue;
    seenKey.add(key);

    const domain = email ? registrableDomain(email.split("@")[1] || "") : registrableDomain(hostOf(r.url));
    contacts.push({
      name: r.name || (email ? email.split("@")[1] : hostOf(r.url)),
      email,
      phone,
      phoneMobile: phonePick ? phonePick.type === "mobile" : undefined,
      role_based: emailPick?.role || false,
      detailUrl: r.url,
      domain,
    });
  }

  /* Deliverability: verify MX for the emails we're keeping. */
  if (checkMx && contacts.some((c) => c.email)) {
    const domains = [...new Set(contacts.filter((c) => c.email).map((c) => c.email!.split("@")[1]))];
    const mx = new Map<string, boolean>();
    await Promise.all(domains.map(async (d) => mx.set(d, await hasMx(d))));
    for (const c of contacts) {
      if (!c.email) continue;
      const ok = mx.get(c.email.split("@")[1]);
      c.mx = ok;
      if (ok === false) { c.email = null; c.role_based = false; }
    }
  }
  const finalContacts = contacts.filter((c) => c.email || c.phone);

  let status: DirectoryResult["status"] = "ok";
  let note: string | undefined;
  if (listingPages === 0) { status = "error"; note = "Could not open the URL."; }
  else if (finalContacts.length === 0) {
    if (blocked > 0) { status = "blocked"; note = blockNote(blockReason, !!proxy); }
    else { status = "empty"; note = "No listings or contact details were found on the pages that loaded."; }
  }

  return { seed, site: siteHost, status, listingPages, detailPages, contacts: finalContacts, note };
}

// Fallback when a directory shows contacts inline (no detail pages): anchor on
// each email and pair it with the nearest phone + a preceding heading as name.
function harvestInline(html: string, pageUrl: string, region: ReturnType<typeof regionFromCountryName>): Record[] {
  const decoded = decodeEntities(html);
  const emails = pickEmails(html);
  if (!emails.length) return [];
  const out: Record[] = [];
  const seen = new Set<string>();
  for (const { email, role } of emails) {
    const at = decoded.toLowerCase().indexOf(email.toLowerCase());
    if (at < 0 || seen.has(email)) continue;
    seen.add(email);
    const windowHtml = decoded.slice(Math.max(0, at - 900), at + 300);
    const phones = extractPhones(windowHtml, { defaultCountry: region, hostname: hostOf(pageUrl) });
    // Name = nearest heading/strong before the email.
    const before = decoded.slice(Math.max(0, at - 1400), at);
    const heads = [...before.matchAll(/<(?:h[1-4]|strong|b|a)[^>]*>([\s\S]*?)<\/(?:h[1-4]|strong|b|a)>/gi)];
    const name = heads.length ? finalizeName(stripTags(heads[heads.length - 1][1])) : "";
    out.push({ url: pageUrl, name, emails: [{ email, role }], phones });
  }
  return out;
}

export async function crawlDirectoryMany(
  seeds: string[],
  opts: DirectoryOptions,
  onProgress?: (p: DirectoryProgress & { seed: string }) => void
): Promise<DirectoryResult[]> {
  const results: DirectoryResult[] = [];
  for (const seed of seeds) {
    try {
      const r = await crawlDirectory(seed, opts, (p) => onProgress?.({ ...p, seed }));
      results.push(r);
    } catch (e: any) {
      results.push({ seed, site: seed, status: "error", listingPages: 0, detailPages: 0, contacts: [], note: String(e?.message || e) });
    }
  }
  return results;
}
