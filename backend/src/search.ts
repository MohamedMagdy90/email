// Keyword-based company discovery.
//
// This is the "tier-one" search: instead of relying on OSM tags, we ask a real
// web search engine for companies matching free-text keywords (e.g. "auto
// partner", "spare parts distributor") in a location. Any business whose site
// mentions those words is fair game — exactly what OSM can't do.
//
// Source: DuckDuckGo HTML/Lite endpoints (no API key). To stay reliable we
// rotate user-agents, retry with backoff, fall back between endpoints, and
// cache results briefly so repeat searches don't re-hit the engine.

import { registrableDomain, hostOf } from "./crawler/urls";
import { isProfileHost, isJunkHost } from "./crawler/profiles";
import { fetchViaReader } from "./crawler/fetcher";
import type { Company } from "./leads";

const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
];
const pickUA = () => UAS[Math.floor(Math.random() * UAS.length)];

// Domains that are aggregators/social/marketplaces, not the company itself.
const BLOCK =
  /(^|\.)(facebook|instagram|twitter|x|linkedin|youtube|tiktok|pinterest|snapchat|whatsapp|telegram|wikipedia|wikimedia|yelp|tripadvisor|trustpilot|amazon|ebay|aliexpress|alibaba|made-in-china|indiamart|exportersindia|tradeindia|indeed|glassdoor|bayt|naukri|yellowpages|yello|yalwa|justdial|foursquare|google|goo\.gl|apple|microsoft|bing|duckduckgo|yahoo|baidu|reddit|quora|medium|blogspot|wordpress|wixsite|weebly|godaddy|t\.co|bit\.ly|tinyurl|booking|expedia|craigslist|dnb|zoominfo|crunchbase|opencorporates|bloomberg|gov|edu|int)\.[a-z.]+$/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Hit { url: string; title: string }

function decodeDdg(href: string): string | null {
  const m = href.match(/[?&]uddg=([^&"]+)/);
  const raw = m ? m[1] : href;
  try {
    let u = decodeURIComponent(raw);
    if (u.startsWith("//")) u = "https:" + u;
    if (!/^https?:\/\//i.test(u)) return null;
    return u;
  } catch {
    return null;
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

function parseHits(html: string): Hit[] {
  const hits: Hit[] = [];
  const re = /<a\b[^>]*class="[^"]*result(?:__a|-link)[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const url = decodeDdg(m[1]);
    if (url) hits.push({ url, title: stripTags(m[2]) });
  }
  if (!hits.length) {
    const re2 = /href="([^"]*uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m2: RegExpExecArray | null;
    while ((m2 = re2.exec(html))) {
      const url = decodeDdg(m2[1]);
      if (url) hits.push({ url, title: stripTags(m2[2]) });
    }
  }
  return hits;
}

const isBlocked = (html: string) => /anomaly|unusual traffic|are you a robot|captcha/i.test(html);

// Fetch one DDG results page, retrying across endpoints + UAs with backoff.
async function fetchResultsPage(q: string, offset: number): Promise<Hit[]> {
  const endpoints = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}${offset ? `&s=${offset}&dc=${offset + 1}` : ""}`,
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}${offset ? `&s=${offset}&dc=${offset + 1}` : ""}`,
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = endpoints[attempt % endpoints.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": pickUA(),
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/html,application/xhtml+xml",
          Referer: "https://duckduckgo.com/",
        },
        signal: controller.signal,
      });
      const html = await res.text();
      if (res.ok && !isBlocked(html)) {
        const hits = parseHits(html);
        if (hits.length) return hits;
      }
    } catch { /* retry */ } finally {
      clearTimeout(timer);
    }
    await sleep(1200 * (attempt + 1)); // backoff before next endpoint/UA
  }
  return [];
}

// Small in-memory cache so repeated identical searches don't re-hit the engine.
const cache = new Map<string, { at: number; data: Company[] }>();
const CACHE_MS = 10 * 60 * 1000;

export async function searchCompanies(keywords: string, location: string, limit: number): Promise<Company[]> {
  if (!keywords.trim()) throw new Error("Enter one or more keywords to search for.");

  const cacheKey = `${keywords.toLowerCase().trim()}|${location.toLowerCase().trim()}|${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;

  const base = location.trim() ? `${keywords.trim()} ${location.trim()}` : keywords.trim();
  const byDomain = new Map<string, Company>();
  let gotAnyPage = false;

  // One query, up to two pages — enough breadth while keeping requests low.
  for (const offset of [0, 30]) {
    const hits = await fetchResultsPage(base, offset);
    if (hits.length) gotAnyPage = true;
    for (const h of hits) {
      let host = "";
      try { host = hostOf(h.url); } catch { continue; }
      if (!host || BLOCK.test(host)) continue;
      const domain = registrableDomain(host);
      if (!domain || byDomain.has(domain)) continue;
      let website = h.url;
      try { const u = new URL(h.url); website = `${u.protocol}//${u.host}/`; } catch {}
      byDomain.set(domain, {
        name: h.title?.slice(0, 90) || domain,
        website,
        city: location || "",
        email: null,
        phone: null,
        hasWebsite: true,
      });
      if (byDomain.size >= limit) break;
    }
    if (byDomain.size >= limit) break;
    await sleep(700);
  }

  const results = [...byDomain.values()].slice(0, limit);
  if (!results.length && !gotAnyPage) {
    throw new Error("The web search is busy right now (rate-limited). Please try again in a minute.");
  }
  if (results.length) cache.set(cacheKey, { at: Date.now(), data: results });
  return results;
}

// A single search result, categorized. `sites` are candidate company websites;
// `profiles` are social/directory pages (Facebook, Talabat, …) that we keep as a
// fallback because they usually list the company's real website + email.
export interface RawHit {
  url: string; // homepage-normalized URL
  title: string;
  host: string;
  domain: string;
}

const rawCache = new Map<string, { at: number; data: { sites: RawHit[]; profiles: RawHit[] } }>();

// Like searchCompanies, but returns BOTH real sites and profile pages (instead
// of throwing profiles away). Used by the PDF enrichment pipeline so companies
// that only have a Facebook/Instagram/directory presence are still resolvable.
export async function searchRaw(
  keywords: string,
  location: string,
  limit = 8
): Promise<{ sites: RawHit[]; profiles: RawHit[] }> {
  const q = keywords.trim();
  if (!q) return { sites: [], profiles: [] };

  const cacheKey = `raw|${q.toLowerCase()}|${location.toLowerCase().trim()}|${limit}`;
  const cached = rawCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;

  const base = location.trim() ? `${q} ${location.trim()}` : q;
  const sites: RawHit[] = [];
  const profiles: RawHit[] = [];
  const seenSite = new Set<string>();
  const seenProfile = new Set<string>();

  for (const offset of [0, 30]) {
    const hits = await fetchResultsPage(base, offset);
    for (const h of hits) {
      let host = "";
      try { host = hostOf(h.url); } catch { continue; }
      if (!host || isJunkHost(host)) continue;
      const domain = registrableDomain(host);
      if (!domain) continue;
      let url = h.url;
      try { const u = new URL(h.url); url = `${u.protocol}//${u.host}${u.pathname}`; } catch {}
      const rec: RawHit = { url, title: (h.title || "").slice(0, 120), host, domain };

      if (isProfileHost(host)) {
        // Keep the full path for profiles (we need the exact page to scrape).
        if (!seenProfile.has(url)) { seenProfile.add(url); profiles.push(rec); }
      } else {
        if (!seenSite.has(domain)) {
          seenSite.add(domain);
          try { const u = new URL(h.url); rec.url = `${u.protocol}//${u.host}/`; } catch {}
          sites.push(rec);
        }
      }
    }
    if (sites.length >= limit && profiles.length >= 3) break;
    await sleep(700);
  }

  const data = { sites: sites.slice(0, limit), profiles: profiles.slice(0, 5) };
  if (data.sites.length || data.profiles.length) rawCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

/* ========================================================================== *
 *  Reader-backed, paginated search — for the always-on discovery bot.        *
 *                                                                            *
 *  A datacenter IP (Railway) is reliably served DuckDuckGo's "anomaly" bot   *
 *  wall on a plain fetch, so search returns nothing. The FREE Jina reader    *
 *  (r.jina.ai) renders the results page and returns the real HTML — verified *
 *  to bypass the wall — so the bot can search the web at scale. One page at a *
 *  time (the bot walks many queries × pages via a cursor).                    *
 * ========================================================================== */

// SEO/listicle/data-broker hosts that show up in company searches but are NOT
// the company — "top 10" articles, résumé/lead databases, slide hosts, etc.
// Kept separate from BLOCK (social/marketplaces) so both apply to the bot.
const CONTENT_BLOCK =
  /(^|\.)(aeroleads|rocketreach|lusha|leadiq|apollo|signalhire|zoominfo|clearbit|owler|ambitionbox|comparably|f6s|ensun|getmanufacturers|saudifactories|rasmal|manta|bizapedia|tuugo|cybo|hotfrog|brownbook|cylex|wlw|dnb|dun|bloomberg|scribd|slideshare|issuu|academia|researchgate|clutch|goodfirms|designrush|sortlist|trustpilot|sitejabber|expatriates|expat|ksaexpats|blackridgeresearch|reportlinker|statista|ibisworld|mordorintelligence|globaldata|marketresearch|constructionweekonline|constructionweeksaudi|meed|zawya|argaam|mubasher|wikipedia|wikimedia|britannica|quora|reddit|medium|substack|pinterest|toplinehub|arabiantalks|gludo|atninfo|eyeofriyadh|saudiayp)\.[a-z.]+$/i;

// Result URLs whose path screams "listicle / blog" rather than a company home.
const LISTICLE_PATH = /\/(?:top-|best-|list-of|list\/|guide\/|blog\/|news\/|article|companies-in-|directory\/)/i;

// Result TITLES that are clearly "top N" round-up articles, not a company.
const LISTICLE_TITLE = /^\s*(?:the\s+)?(?:top|best|leading|\d+\s+(?:top|best|leading|of the best))\b/i;

function ddgUrl(query: string, offset: number): string {
  const base = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  return offset ? `${base}&s=${offset}&dc=${offset + 1}` : base;
}

// Fetch ONE results page. Try a plain fetch first (free); if the engine blocks it
// (the "anomaly" wall on datacenter IPs) fall back to the reader, which renders
// the page and returns real HTML. `blocked` = we couldn't get a real page at all.
async function fetchSearchPage(query: string, offset: number, readerKey?: string): Promise<{ html: string; blocked: boolean }> {
  const url = ddgUrl(query, offset);

  // 1) Direct — cheap, and works when NOT on a flagged datacenter IP.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      headers: {
        "User-Agent": pickUA(),
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml",
        Referer: "https://duckduckgo.com/",
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    const html = await res.text();
    if (res.ok && !isBlocked(html) && /uddg=|result__a/.test(html)) return { html, blocked: false };
  } catch { /* fall through to reader */ }

  // 2) FREE reader — bypasses the anomaly wall (verified). Rate-limited, so it's
  //    serialized by the reader limiter; an optional JINA key raises the ceiling.
  const rd = await fetchViaReader(url, 45000, readerKey).catch(() => null);
  if (rd?.ok && rd.html && !isBlocked(rd.html) && /uddg=|result__a/.test(rd.html)) return { html: rd.html, blocked: false };

  return { html: "", blocked: true };
}

// One page of company results for a query. Filters out social/marketplaces
// (BLOCK), SEO/listicle/data-broker hosts (CONTENT_BLOCK), and obvious listicle
// URLs — leaving individual company websites. No email/phone (search only gives
// the site); the discovery bot then crawls each site to find the email.
export async function searchCompaniesPaged(
  query: string,
  offset: number,
  limit: number,
  readerKey?: string
): Promise<{ companies: Company[]; blocked: boolean }> {
  const { html, blocked } = await fetchSearchPage(query, offset, readerKey);
  if (blocked) return { companies: [], blocked: true };

  const byDomain = new Map<string, Company>();
  for (const h of parseHits(html)) {
    let host = "";
    try { host = hostOf(h.url); } catch { continue; }
    if (!host || BLOCK.test(host) || CONTENT_BLOCK.test(host) || isProfileHost(host)) continue;
    if (LISTICLE_TITLE.test(h.title || "")) continue; // "Top 20 …", "Best …", "10 Leading …"
    let path = "/";
    try { path = new URL(h.url).pathname.toLowerCase(); } catch { /* ignore */ }
    if (LISTICLE_PATH.test(path)) continue;
    const domain = registrableDomain(host);
    if (!domain || byDomain.has(domain)) continue;
    let website = h.url;
    try { const u = new URL(h.url); website = `${u.protocol}//${u.host}/`; } catch { /* keep */ }
    byDomain.set(domain, {
      name: h.title?.replace(/\s+/g, " ").trim().slice(0, 90) || domain,
      website,
      city: "",
      email: null,
      phone: null,
      hasWebsite: true,
    });
    if (byDomain.size >= limit) break;
  }
  return { companies: [...byDomain.values()], blocked: false };
}
