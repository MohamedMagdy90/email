// Generic business-directory harvester.
// Paste ONE listing URL (e.g. a "companies in Qatar" directory) and this:
//   1. walks the pagination (?page=N, /page/N, rel=next, …)
//   2. reads the repeating "cards" straight off the listing page when they
//      already carry the contact details; otherwise auto-detects the card link
//      pattern and opens each detail page
//   3. pulls company name + email + phone (mobile preferred) + website using the
//      same extractors the normal crawler uses
//   4. drops "site chrome" — an email/phone that appears on most pages is the
//      DIRECTORY's own contact, not a listing's, so it's filtered out
// Nothing is hardcoded to any specific site.

import { fetchWithRetry, type FetchResult, type BlockReason, type ProxyConfig } from "./fetcher";
import { extractEmails, decodeEntities } from "./extract";
import { extractPhones, bestPhone, regionFromCountryName, type PhoneHit } from "./phones";
import { cleanEmail, isValidEmail, isJunk, isRole, hasMx } from "./validate";
import { normalizeSeed, hostOf, registrableDomain } from "./urls";
import { extractContactFromProfile } from "./profiles";
import { loadRobots } from "./robots";

export interface DirectoryContact {
  name: string;
  email: string | null;
  phone: string | null;
  phoneMobile?: boolean;
  role_based: boolean;
  detailUrl: string;
  domain: string;
  // The company's OWN website, recovered from the listing's outbound link. Lets
  // a listing with no inline email still be crawled for one during enrichment.
  website?: string | null;
  mx?: boolean;
}

export interface DirectoryResult {
  seed: string;
  site: string;
  status: "ok" | "error" | "empty" | "blocked";
  listingPages: number;
  // Listing pages read successfully and CONTIGUOUSLY from the seed. A page cursor
  // may only advance by this much: `listingPages` also counts pages a bot wall
  // refused, and advancing past those would skip their companies for good.
  pagesRead: number;
  // Detail/profile pages actually opened. Stays 0 when the cards were read
  // straight off the listing — callers use it to tell "this directory has
  // listings we walked into" from "there was nothing here".
  detailPages: number;
  // Listings read in total, however they were read (detail pages + inline cards).
  listingsRead: number;
  contacts: DirectoryContact[];
  note?: string;
  // Set when the crawler auto-switched to a better listings/index URL because the
  // URL you gave (e.g. a homepage) had no companies. The worker persists this so
  // the source pages the correct URL from then on.
  resolvedSeed?: string;
}

export interface DirectoryOptions {
  maxPages?: number; // listing/index pages to walk
  maxDetails?: number; // listings to capture (detail pages opened, or cards read)
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

// Language/locale path prefixes: /en/…, /ar-QA/…, /fr_FR/…, /pt-br/…
// They're site chrome, not taxonomy, and leaving them in poisons link analysis:
// "en" is a NAV_STOP word, so on a multilingual site EVERY listing link looks
// like navigation and the crawler finds no companies at all.
const LANG_CODES = new Set([
  "en", "ar", "fr", "de", "es", "it", "pt", "nl", "ru", "tr", "zh", "ja", "ko",
  "hi", "ur", "fa", "he", "pl", "sv", "no", "da", "fi", "cs", "el", "ro", "hu",
  "th", "vi", "id", "ms", "bn", "ta", "uk", "sr", "hr", "bg", "sk", "sl", "lt",
  "lv", "et", "ca", "eu", "gl", "af", "sw", "az", "kk", "uz", "hy", "ka",
]);
function isLocaleSeg(seg: string): boolean {
  const s = decode(seg).toLowerCase();
  if (!/^[a-z]{2}(?:[-_][a-z0-9]{2,4})?$/.test(s)) return false;
  return LANG_CODES.has(s.split(/[-_]/)[0]);
}
// Path segments with a leading locale removed.
function pathSegs(pathname: string): string[] {
  const segs = pathname.split("/").filter(Boolean).map(decode);
  return segs.length && isLocaleSeg(segs[0]) ? segs.slice(1) : segs;
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

// The numeric page a URL represents (?page=N or /page/N), or 0 when it carries
// no numeric page marker (a clean first page, or a token/rel=next pager).
function pageNumberOf(u: URL): number {
  const k = pageParamOf(u);
  if (k) { const n = Number(u.searchParams.get(k)); if (Number.isInteger(n) && n > 0) return n; }
  const pm = u.pathname.match(PATH_PAGE_RE);
  if (pm) { const n = Number(pm[2]); if (Number.isInteger(n) && n > 0) return n; }
  return 0;
}

// Reduce a path to a template where slug/id segments become "*".
// A leading locale ("/en", "/ar-QA") is dropped first so the same listing
// template is recognised whatever language prefix the site uses.
function pathTemplate(pathname: string): { key: string; placeholders: number; literals: string[] } {
  const segs = pathSegs(pathname);
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
  const seedSegs = new Set(pathSegs(s.pathname).map((x) => x.toLowerCase()));
  const navBlocks = (l: string) => NAV_STOP.has(l) && !seedSegs.has(l);

  const byTpl = new Map<string, Set<string>>();
  const byParent = new Map<string, Set<string>>();

  for (const href of links) {
    let u: URL;
    try { u = new URL(href); } catch { continue; }
    if (registrableDomain(u.hostname) !== sReg) continue;
    if (isPaginationUrl(u)) continue;
    const segs = pathSegs(u.pathname);
    if (!segs.length) continue;

    const { key, placeholders, literals } = pathTemplate(u.pathname);
    const full = u.origin + u.pathname + u.search;

    if (placeholders > 0 && !literals.some(navBlocks) && key !== seedKey) {
      let set = byTpl.get(key); if (!set) { set = new Set(); byTpl.set(key, set); }
      set.add(full);
    }
    // Fallback grouping by the link's PARENT path (everything but the last
    // segment). It catches clean one-word slugs that produce no wildcard
    // (/listing/shark) and — unlike grouping by the FIRST segment — it stays
    // precise on deep paths, where the first segment is a generic word shared
    // with the whole navigation menu (/en/Services/… on a government site).
    const parentSegs = segs.slice(0, -1).map((x) => x.toLowerCase());
    if (parentSegs.length && !parentSegs.some(navBlocks)) {
      const pKey = "/" + parentSegs.join("/");
      let set = byParent.get(pKey); if (!set) { set = new Set(); byParent.set(pKey, set); }
      set.add(full);
    }
  }

  // Winning wildcard template (e.g. "/listing/*").
  let bestTpl: Set<string> | null = null;
  for (const [, set] of byTpl) if (!bestTpl || set.size > bestTpl.size) bestTpl = set;

  // Winning parent-path bucket (e.g. every child of "/listing").
  let bestParent: Set<string> | null = null;
  for (const [, set] of byParent) if (!bestParent || set.size > bestParent.size) bestParent = set;

  // When the two agree on the same bucket, union them: the wildcard template
  // alone skips clean one-word slugs like /listing/shark or /listing/kreston-svp
  // (no digit, <2 hyphens), so those listings would be silently lost.
  if (bestTpl && bestParent) {
    let overlap = 0;
    for (const u of bestParent) if (bestTpl.has(u)) overlap++;
    if (overlap >= Math.max(1, Math.min(bestTpl.size, bestParent.size) * 0.5)) {
      return [...new Set([...bestTpl, ...bestParent])];
    }
  }
  if (bestTpl && bestTpl.size >= 2) return [...bestTpl];
  if (bestParent && bestParent.size >= 3) return [...bestParent];
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
    // Keep the locale prefix in the URL we build (dropping it would 404 on sites
    // that require it) but ignore it when judging how deep the path is.
    const segs = u.pathname.split("/").filter(Boolean).map((x) => decode(x).toLowerCase());
    if (!segs.length) continue;
    const off = isLocaleSeg(segs[0]) ? 1 : 0;
    const idx = segs.findIndex((x, i) => i >= off && INDEX_WORDS.has(x));
    if (idx < 0) continue;
    // Truncate the path at the index word: /a/listings/102 → /a/listings.
    const norm = u.origin + "/" + segs.slice(0, idx + 1).join("/");
    popularity.set(norm, (popularity.get(norm) || 0) + 1);
    if (score.has(norm)) continue;
    const depth = idx - off; // how deep the index word sits, locale ignored
    let sc = 0;
    if (depth === 0 && segs.length === off + 1) sc += 6;            // exactly /listings
    if (idx === segs.length - 1) sc += 3;                           // index word ends the path
    if (["listings", "directory", "companies", "businesses", "listing"].includes(segs[idx])) sc += 3;
    sc += Math.max(0, 4 - (depth + 1));                             // shallower = better
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

// Labels that live inside a listing card but are never the company's name.
const NAME_STOP = new Set([
  "read more", "view more", "more", "more info", "details", "view details",
  "show more", "see more", "learn more", "full profile", "view profile", "profile",
  "contact", "contact us", "get in touch", "email", "e-mail", "mail", "send email",
  "phone", "telephone", "tel", "mobile", "fax", "website", "web", "visit website",
  "address", "location", "map", "view on map", "directions", "call", "call us",
  "whatsapp", "home", "back", "next", "previous", "prev", "first", "last",
  "search", "filter", "filters", "reset", "clear", "close", "menu", "share",
  "login", "log in", "sign in", "sign up", "register", "subscribe", "print",
  "download", "export", "export to excel", "apply", "apply now", "submit",
  "commercial registration", "commercial permit", "registration", "permit",
  "company", "companies", "category", "categories", "services", "products",
  "about", "about us", "description", "overview", "summary", "n/a", "na", "-",
]);

// Is this text plausibly a COMPANY NAME? Everything the old harvester happily
// stored as a name — a phone number, an email, a URL, a registration number, a
// "Read more" link label — is rejected here.
export function looksLikeName(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 2 || t.length > 140) return false;
  if (!/\p{L}/u.test(t)) return false;                                  // no letters → a number
  if (/^[\d\s()+.\-/]+$/.test(t)) return false;                         // pure phone / id
  if (t.includes("@")) return false;                                    // an email address
  if (/^(https?:\/\/|www\.)/i.test(t)) return false;                    // a URL
  if (/^[a-z0-9-]+\.[a-z]{2,6}(\.[a-z]{2,4})?$/i.test(t)) return false; // a bare domain
  if (/\d{6,}/.test(t) && !/\p{L}{3,}/u.test(t)) return false;          // "66828808 x"
  if (NAME_STOP.has(t.toLowerCase().replace(/\s+/g, " "))) return false;
  return true;
}

// The company name inside ONE listing card, plus the card's own link.
// Scans every heading / bold / anchor in the fragment and keeps the LAST one
// that actually reads like a name, preferring real headings. Anchors whose href
// is tel:/mailto: are skipped outright — mistaking that anchor for the heading
// is exactly why phone numbers used to end up stored as company names.
function pickCardName(fragment: string): { name: string; href: string | null } {
  const RE = /<(h[1-6]|strong|b|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let best: { name: string; href: string | null; heading: boolean } | null = null;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(fragment))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || "";
    const inner = m[3] || "";
    if (tag === "a" && /href\s*=\s*["']?\s*(?:tel:|mailto:|javascript:|whatsapp:|#)/i.test(attrs)) continue;
    const name = finalizeName(stripTags(inner));
    if (!looksLikeName(name)) continue;
    const heading = /^h[1-6]$/.test(tag);
    const hrefMatch = tag === "a"
      ? attrs.match(/href\s*=\s*["']([^"']+)["']/i)
      : inner.match(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/i);
    const href = hrefMatch ? hrefMatch[1] : null;
    // Later beats earlier, but a heading always beats a non-heading.
    if (!best || heading || !best.heading) best = { name, href, heading };
  }
  return best ? { name: best.name, href: best.href } : { name: "", href: null };
}

interface Record {
  url: string;
  name: string;
  emails: { email: string; role: boolean }[];
  phones: PhoneHit[];
  website?: string | null;
  // Listing page this record came from (inline harvest only). Used to spot
  // header/footer contacts, which repeat on every page of the directory.
  page?: string;
}

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
  if (!seed) return { seed: seedInput, site: seedInput, status: "error", listingPages: 0, pagesRead: 0, detailPages: 0, listingsRead: 0, contacts: [], note: "invalid URL" };

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

  /* Pass 1 — walk listing pages: read their cards inline, or queue detail links. */
  const pageQueue: string[] = [seed];
  const pagesSeen = new Set<string>();
  const detailUrls: string[] = [];
  const detailSeen = new Set<string>();
  let listingPages = 0;
  let pagesRead = 0;      // contiguous successful reads from the seed (cursor step)
  let chainBroken = false; // a page in the sequence was refused → cursor must stop
  let inlineListings = 0; // cards read straight off a listing page
  let harvested = 0;      // listings captured so far, inline OR queued
  let blocked = 0;
  let blockReason: BlockReason | undefined;
  // Some directories (government registers especially) throw a captcha wall once
  // you ask for a few pages too quickly. Back off and retry before abandoning the
  // walk, so a burst limit doesn't end the harvest early. The cooldown is never
  // reset: once a site has shown it rate-limits, we stay slow for the whole run.
  const RETRIES_PER_PAGE = 2;
  const retries = new Map<string, number>();
  let cooldownMs = 0;

  while (pageQueue.length && listingPages < maxPages && harvested < maxDetails) {
    const pageUrl = pageQueue.shift()!.split("#")[0];
    if (pagesSeen.has(pageUrl)) continue;
    pagesSeen.add(pageUrl);

    let path = "/"; try { path = new URL(pageUrl).pathname; } catch { /* ignore */ }
    if (respectRobots && !robots.allow(path)) continue;

    if (cooldownMs) await sleep(cooldownMs);
    const res = await fetchWithRetry(pageUrl, 2, timeoutMs, proxy, readerKey);
    if (!res.ok) {
      if (res.blocked) { blocked++; if (!blockReason) blockReason = res.blockReason; }
      const why = describeBlock(res);
      // Rate-limit walls clear on their own: wait longer, then try this page again.
      const used = retries.get(pageUrl) || 0;
      if (res.blocked && used < RETRIES_PER_PAGE) {
        retries.set(pageUrl, used + 1);
        pagesSeen.delete(pageUrl);
        pageQueue.unshift(pageUrl);
        cooldownMs = Math.min(30000, (cooldownMs || 2000) * 2);
        onProgress?.({ type: "page", url: pageUrl, listingPages, msg: `page ${res.status || "error"}${why ? ` — ${why}` : ""} · waiting ${Math.round(cooldownMs / 1000)}s and retrying` });
        continue; // NOT counted as a walked page — it hasn't been decided yet
      }
      listingPages++;
      chainBroken = true; // never let the cursor advance past a page we couldn't read
      onProgress?.({ type: "page", url: pageUrl, listingPages, msg: `page ${res.status || "error"}${why ? ` — ${why}` : ""}` });
      await sleep(politenessMs);
      continue;
    }
    listingPages++;
    if (!chainBroken) pagesRead++;
    const viaProxy = res.via === "proxy";

    const links = collectLinks(res.html, res.url || pageUrl);
    // Hand the first successfully-loaded page's links to the wrapper so it can
    // auto-retarget to the real listings index if this page has no companies.
    if (onFirstPageLinks) { onFirstPageLinks(links); onFirstPageLinks = undefined; }
    const details = findDetailLinks(seed, links);

    // Read the cards on THIS page before deciding to open anything. When the
    // listing already prints a distinct contact per card it IS the best source:
    // one fetch instead of N, and no dependency on the per-company page being
    // well-formed — some registers ship an empty <title> and the SAME
    // placeholder tel: link on every profile, which would poison every name and
    // phone we store.
    const inline = harvestInline(res.html, res.url || pageUrl, region);
    const distinct = new Set(
      inline.map((r) => r.emails[0]?.email || r.phones[0]?.number || "").filter(Boolean)
    ).size;
    // Require real per-card variety, so a page that merely repeats the site's
    // own switchboard number still falls through to the detail pages.
    const useInline = distinct >= 3 && (details.length === 0 || distinct >= details.length * 0.6);

    let added = 0;
    if (useInline) {
      for (const rec of inline) {
        if (harvested >= maxDetails) break;
        records.push(rec);
        added++; harvested++; inlineListings++;
      }
    } else {
      for (const d of details) {
        const dn = d.split("#")[0];
        if (detailSeen.has(dn)) continue;
        detailSeen.add(dn);
        detailUrls.push(dn);
        added++; harvested++;
        if (harvested >= maxDetails) break;
      }
      // No detail links either → keep whatever little the page exposed inline.
      if (!details.length) {
        for (const rec of inline) {
          if (harvested >= maxDetails) break;
          records.push(rec);
          added++; harvested++; inlineListings++;
        }
      }
    }

    // Walk pages STRICTLY FORWARD (only when this page yielded new listings, so
    // the walk stops cleanly at the end of the list). Prefer incrementing the
    // numeric page (?page=N → N+1 / /page/N → N+1): it guarantees we cover every
    // consecutive page and never waste fetches re-crawling the low pages that a
    // pager always links ("1 2 3 …") or the previous page. Only when the URL has
    // NO numeric page pattern do we fall back to discovering pagination links.
    if (added > 0) {
      let advanced = false;
      try {
        const np = nextPageUrl(new URL(pageUrl));
        if (np) {
          const nn = np.split("#")[0];
          if (!pagesSeen.has(nn) && !pageQueue.includes(nn)) pageQueue.push(nn);
          advanced = true;
        }
      } catch { /* ignore */ }
      if (!advanced) {
        // No numeric page to increment — discover pagination links from the page
        // (rel=next / listed page URLs) for pagers without a numeric pattern.
        // Enqueue numeric pages FORWARD-ONLY, smallest first, so we never jump
        // to page 1 or a far page; keep non-numeric (token/rel=next) links too.
        const cur = pageNumberOf(new URL(pageUrl)) || 1;
        const numeric: { url: string; n: number }[] = [];
        const other: string[] = [];
        for (const pl of findPageLinks(seed, links, res.html, res.url || pageUrl)) {
          const url = pl.split("#")[0];
          let n = 0; try { n = pageNumberOf(new URL(pl)); } catch { /* ignore */ }
          if (n > 0) { if (n > cur) numeric.push({ url, n }); }
          else other.push(url);
        }
        numeric.sort((a, b) => a.n - b.n);
        for (const { url } of numeric) if (!pagesSeen.has(url) && !pageQueue.includes(url)) pageQueue.push(url);
        for (const url of other) if (!pagesSeen.has(url) && !pageQueue.includes(url)) pageQueue.push(url);
      }
    }
    onProgress?.({
      type: "page", url: pageUrl, listingPages, detailTotal: detailUrls.length,
      msg: `page ${listingPages}: +${added} listings${useInline ? " · read from the listing itself" : ""}${viaProxy ? " · via proxy" : ""}`,
    });
    await sleep(politenessMs);
  }

  /* Pass 2 — open each detail page (skipped entirely when we read inline). */
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
        // The listing's outbound "Website" link = the company's own site. It's on
        // a different domain than this directory, so it survives enrichment's
        // company-vs-platform email filter.
        const site = extractContactFromProfile(res.html, res.url || url).website;
        records.push({
          url: res.url || url,
          name: extractName(res.html),
          emails: pickEmails(res.html),
          phones: extractPhones(res.html, { defaultCountry: region, hostname: hostOf(url) }),
          website: site || null,
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
  if (detailUrls.length) {
    onProgress?.({ type: "phase", msg: `Opening ${detailUrls.length} listing page(s)…` });
    await Promise.all(Array.from({ length: Math.min(concurrency, detailUrls.length) }, worker));
  } else if (inlineListings) {
    onProgress?.({ type: "phase", msg: `Read ${inlineListings} listing(s) straight off the directory pages — no extra page loads needed.` });
  }

  /* Pass 3 — drop site chrome, then assemble one contact per record. */
  const N = records.length;
  const emailFreq = new Map<string, number>();
  const phoneFreq = new Map<string, number>();
  const emailPages = new Map<string, Set<string>>();
  const phonePages = new Map<string, Set<string>>();
  const sourcePages = new Set<string>();
  const track = (map: Map<string, Set<string>>, key: string, page: string) => {
    let s = map.get(key); if (!s) { s = new Set(); map.set(key, s); }
    s.add(page);
  };
  for (const r of records) {
    const page = r.page || r.url;
    sourcePages.add(page);
    for (const e of new Set(r.emails.map((x) => x.email))) {
      emailFreq.set(e, (emailFreq.get(e) || 0) + 1);
      track(emailPages, e, page);
    }
    for (const p of new Set(r.phones.map((x) => x.number))) {
      phoneFreq.set(p, (phoneFreq.get(p) || 0) + 1);
      track(phonePages, p, page);
    }
  }
  const chromeMin = Math.max(3, Math.ceil(N * 0.35));
  const chromeApplies = N >= 4;
  // Header/footer contacts repeat on EVERY listing page. Reading cards inline
  // yields dozens of records per page, so the "35% of all records" rule alone
  // never trips — count the distinct pages a value showed up on as well. In
  // detail-page mode every record has its own URL, so this rule is a no-op.
  const nPages = sourcePages.size;
  const pageChromeMin = Math.max(2, Math.ceil(nPages * 0.6));
  const onMostPages = (m: Map<string, Set<string>>, k: string) =>
    nPages >= 2 && (m.get(k)?.size || 0) >= pageChromeMin;
  const isChromeEmail = (e: string) =>
    chromeApplies && ((emailFreq.get(e) || 0) >= chromeMin || onMostPages(emailPages, e));
  const isChromePhone = (p: string) =>
    chromeApplies && ((phoneFreq.get(p) || 0) >= chromeMin || onMostPages(phonePages, p));

  const contacts: DirectoryContact[] = [];
  const seenKey = new Set<string>();
  for (const r of records) {
    const emails = r.emails.filter((e) => !isChromeEmail(e.email)).sort((a, b) => Number(b.role) - Number(a.role));
    const phones = r.phones.filter((p) => !isChromePhone(p.number));
    const emailPick = emails[0];
    const phonePick = bestPhone(phones, region);
    // Keep a listing even with no inline email/phone as long as it exposes a
    // website — enrichment can then crawl that site for the email.
    if (!emailPick && !phonePick && !r.website) continue;

    const email = emailPick?.email || null;
    const phone = phonePick?.formatted || null;
    const key = email || phone || r.website || r.url;
    if (seenKey.has(key)) continue;
    seenKey.add(key);

    const domain = email
      ? registrableDomain(email.split("@")[1] || "")
      : r.website ? registrableDomain(hostOf(r.website)) : registrableDomain(hostOf(r.url));
    contacts.push({
      name: r.name || (email ? email.split("@")[1] : r.website ? hostOf(r.website) : hostOf(r.url)),
      email,
      phone,
      phoneMobile: phonePick ? phonePick.type === "mobile" : undefined,
      role_based: emailPick?.role || false,
      detailUrl: r.url,
      domain,
      website: r.website || null,
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
  const finalContacts = contacts.filter((c) => c.email || c.phone || c.website);

  let status: DirectoryResult["status"] = "ok";
  let note: string | undefined;
  if (listingPages === 0) { status = "error"; note = "Could not open the URL."; }
  else if (finalContacts.length === 0) {
    if (blocked > 0) { status = "blocked"; note = blockNote(blockReason, !!proxy); }
    else { status = "empty"; note = "No listings or contact details were found on the pages that loaded."; }
  } else if (blocked > 0) {
    // We got results, but the walk was cut short — say so, otherwise a partial
    // harvest looks like the whole directory.
    note = `Harvest stopped early: ${blockNote(blockReason, !!proxy)} Re-run to continue from the next page.`;
  }

  return { seed, site: siteHost, status, listingPages, pagesRead, detailPages, listingsRead: detailPages + inlineListings, contacts: finalContacts, note };
}

// Read the listing page itself. Plenty of directories (government registers,
// chamber lists, association member pages…) print name + phone + email + website
// right on the card, and their per-company page is a thinner — sometimes broken
// — copy of it. This splits a page into cards and reads one contact per card.
//
// How a card is found, without knowing anything about the site:
//   1. every mailto:/tel: link and every bare email is a "contact mark"
//      (marks inside <header>/<footer>/<nav> are the directory's own, ignored)
//   2. marks that sit close together belong to the same card
//   3. a card's slice runs from the END of the previous card to the START of the
//      next one, so a card can never borrow its neighbour's name or website
function harvestInline(html: string, pageUrl: string, region: ReturnType<typeof regionFromCountryName>): Record[] {
  // Collapse indentation first. Card markup is mostly whitespace, so a fixed
  // look-back window has to reach the card's heading, not 900 spaces.
  const doc = decodeEntities(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/[ \t\r\n\f]+/g, " ");

  // Site chrome: a header/footer contact belongs to the directory, not to any
  // listing, so anything inside <header>/<footer>/<nav> is skipped.
  const chrome: [number, number][] = [];
  let c: RegExpExecArray | null;
  const CHROME_RE = /<(header|footer|nav)\b[\s\S]*?<\/\1>/gi;
  while ((c = CHROME_RE.exec(doc))) chrome.push([c.index, c.index + c[0].length]);
  const inChrome = (i: number) => chrome.some(([a, b]) => i >= a && i < b);

  interface Mark { start: number; end: number }
  const marks: Mark[] = [];
  let m: RegExpExecArray | null;
  const CONTACT_A = /<a\b[^>]*href\s*=\s*["']?\s*(?:mailto:|tel:)[^>]*>[\s\S]*?<\/a>/gi;
  while ((m = CONTACT_A.exec(doc))) marks.push({ start: m.index, end: m.index + m[0].length });
  const BARE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  while ((m = BARE_EMAIL.exec(doc))) marks.push({ start: m.index, end: m.index + m[0].length });
  const usable = marks.filter((k) => !inChrome(k.start)).sort((a, b) => a.start - b.start);
  if (!usable.length) return [];

  // Merge marks that sit close together — one card's website + phone + email.
  const cards: Mark[] = [];
  for (const k of usable) {
    const last = cards[cards.length - 1];
    if (last && k.start - last.end <= 600) { last.end = Math.max(last.end, k.end); continue; }
    cards.push({ start: k.start, end: k.end });
  }

  const pageDomain = registrableDomain(hostOf(pageUrl));
  const out: Record[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const prevEnd = i > 0 ? cards[i - 1].end : 0;
    const nextStart = i + 1 < cards.length ? cards[i + 1].start : doc.length;
    const from = Math.max(prevEnd, card.start - 2200);
    const to = Math.min(nextStart, card.end + 400);
    const body = doc.slice(from, to);

    // The directory's own address (info@thisdirectory.com) is never a listing's.
    const emails = pickEmails(body).filter(
      (e) => registrableDomain(e.email.split("@")[1] || "") !== pageDomain
    );
    const phones = extractPhones(body, { defaultCountry: region, hostname: hostOf(pageUrl) });
    if (!emails.length && !phones.length) continue;

    const key = emails[0]?.email || phones[0]?.number || "";
    if (!key || seen.has(key)) continue;
    seen.add(key);

    // The name sits above the contact block; fall back to the whole card.
    let picked = pickCardName(doc.slice(from, card.start));
    if (!picked.name) picked = pickCardName(body);

    // Point the lead at the card's own page when the heading links to one.
    let url = pageUrl;
    if (picked.href) { try { url = new URL(picked.href, pageUrl).toString(); } catch { /* keep page URL */ } }
    const website = extractContactFromProfile(body, pageUrl).website;

    out.push({ url, name: picked.name, emails, phones, website: website || null, page: pageUrl });
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
      results.push({ seed, site: seed, status: "error", listingPages: 0, pagesRead: 0, detailPages: 0, listingsRead: 0, contacts: [], note: String(e?.message || e) });
    }
  }
  return results;
}
