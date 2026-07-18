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
