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
export const CONTENT_BLOCK =
  /(^|\.)(aeroleads|rocketreach|lusha|leadiq|apollo|signalhire|zoominfo|clearbit|owler|ambitionbox|comparably|f6s|ensun|getmanufacturers|saudifactories|rasmal|manta|bizapedia|tuugo|cybo|hotfrog|brownbook|cylex|wlw|dnb|dun|bloomberg|scribd|slideshare|issuu|academia|researchgate|clutch|goodfirms|designrush|sortlist|trustpilot|sitejabber|expatriates|expat|ksaexpats|blackridgeresearch|reportlinker|statista|ibisworld|mordorintelligence|globaldata|marketresearch|constructionweekonline|constructionweeksaudi|meed|zawya|argaam|mubasher|wikipedia|wikimedia|britannica|quora|reddit|medium|substack|pinterest|toplinehub|arabiantalks|gludo|atninfo|eyeofriyadh|saudiayp|chamberofcommerce|infobel|infobelpro|myhomepro|micompanyregistry|companyregistry|poidata|qatarsale|callroofingnow|bizmideast|linktr|linktree|opencorporates|yellowpages|yellowpages-uae|yalwa|opendi|fyple|storeboard|callupcontact|businesslist|bizdirlib|dubaiyellowpagesonline|qataryellowpages|justdial|indiamart|tradeindia|europages|kompass|thomasnet|superpages|whitepages|citysearch|bbb|glassdoor|crunchbase|pitchbook|zaubacorp|tofler|jooble|indeed|bayt|gulftalent|naukrigulf|monstergulf|laimoon|dubizzle|olx|propertyfinder|bproperty|craigslist|alibaba|aliexpress|made-in-china|ec21|exportersindia)\.[a-z.]+$/i;

// The company-FORMATION industry. These agencies exist to rank for "company
// formation Qatar" / "establishment Qatar", so a generic company search returns
// a page of them instead of companies — they filled most of the pool in
// production. Blocked as hosts because their page titles vary too much to catch.
export const SETUP_BLOCK =
  /(^|\.)(qshield|qcfglobal|agentsgrp|emerhub|qatarcompanyformation|generisonline|companyformation\w*|businesssetup\w*|setupinqatar|startanybusiness|commitbiz|shuraatax|aurionbs|creationbc|adamglobal|jitendra\w*|riz\w*consult|bizfiling|incorporations?|formationhub|klgates|dlapiper|cliffordchance|bakermckenzie|lexology|mondaq|iprocure|volza|eximnext|exporthub|importgenius|panjiva|tradeatlas|companiesmarketcap|forbesmiddleeast|arabianlocal|naviqatar|qhelp|companiesinqatar|companydata|qatarcontact)\.[a-z.]+$/i;

// Government, regulators and exchanges — real organisations, but not prospects.
export const OFFICIAL_BLOCK =
  /(^|\.)(qfc|qe|qatarchamber|moci|mofa|mol|gov|edu|ministry\w*|chamber\w*|customs|centralbank|\w*stockexchange|\w*bourse)\.[a-z.]*$|\.(gov|gov\.[a-z]{2}|edu|edu\.[a-z]{2}|mil)$/i;

/* ------------------------ result title → company ------------------------ */
// A search result's <title> is a page headline, not a company name. Saved
// verbatim it produced leads called "MEP Contractor in Mecca, Saudi Arabia -
// Wafaiyah Contractors", "FCCSA - Home" and "Hail Damage Repair Dallesport, WA
// | Call 844-633-0805" — nothing you could ever address an email to.
const TITLE_SPLIT = /\s+[|｜·•‣—–]\s+|\s+-\s+|\s*::\s*/;
const TITLE_BOILERPLATE =
  /^(home|homepage|home page|welcome|official (web)?site|website|contact( us)?|about( us)?|index|services|products|our services|main page|landing page)$/i;
// Words that mark a fragment as the legal/trading name of a business.
const COMPANY_SUFFIX =
  /\b(llc|l\.l\.c|ltd|limited|inc|co|company|corp|corporation|group|holdings?|est|establishment|wll|w\.l\.l|plc|gmbh|sarl|srl|bv|nv|pte|pty|trading|contractors?|contracting|industries|enterprises?|solutions|systems|technologies|engineering|consultancy|consultants?|factory|works)\b|شركة|مؤسسة|مجموعة|مصنع/i;
// Titles that describe a PAGE — a question, a directory search, a classified —
// rather than a business. The whole result is dropped.
const JUNK_TITLE =
  /^(how|what|where|why|which|when|who)\b|\b(find any business|company search|business directory|company directory|for rent|for sale|jobs? in|job vacanc|vacancies|classifieds?|price list|listings? in|search results)\b/i;

// Content that ranks for "companies <country>" but is never itself a company.
// Three families, all straight out of the production log:
//
//   guides/explainers  "A Comprehensive Guide to Company Formation in Qatar",
//                      "Establishment Card in Qatar: Meaning & Apply"
//   rankings/lists     "List of 15,506 Registered Companies in Doha",
//                      "The 30 Most Valuable Companies In Qatar",
//                      "Largest companies of Qatar by market capitalization"
//   directories        "Qatar's leading online B2B listing & directory",
//                      "ExportHub: Qatar B2B Marketplace & … Directory"
const CONTENT_TITLE =
  /\b(?:a\s+)?(?:comprehensive\s+|complete\s+|ultimate\s+|step[- ]by[- ]step\s+)?guide\s+(?:to|for)\b|\b(?:company|business)\s+(?:formation|setup|registration|incorporation)\b|\bset\s?up\s+a\s+(?:company|business)\b|\b(?:establishment|trade|commercial)\s+(?:card|licen[cs]e)\b|:\s*meaning\b|\blist\s+of\s+[\d,]*\s*\w|\baccess\s+list\b|\b(?:the\s+)?\d+\s+most\s+\w+\s+compan/i;
const RANKING_TITLE =
  /\blargest\s+compan|\bby\s+market\s+capitali|\bmarket\s+cap\b|\brichest\b|\branking\s+of\b/i;
// News headlines about a company — "Construction company cited $157,500
// following a fatal trench collapse" is a story, and the email on that page
// belongs to the newsroom.
const NEWS_TITLE =
  /\b(?:cited|fined|charged|indicted|sentenced|convicted|sued|arrested|acquires|acquired|merges|files for bankruptcy|lays off|announces)\b.*\$|\$[\d,.]+\s*(?:million|billion|m\b|bn\b)|\b(?:lawsuit|osha|investigation|probe|scandal|verdict|settlement)\b/i;
const DIRECTORY_TITLE =
  /\bb2b\s+(?:marketplace|portal|listing)|\b(?:business|company|online|trade)\s+(?:directory|listings?)\b|\bdirectory\s+of\b|\byellow\s?pages\b|\bsupplier\s+discovery\b|\brfqs?\b/i;
// A category phrase pointing at a place — "Companies in Qatar", "Construction
// companies in Mecca". The PLURAL category is what gives a directory away; a
// real firm writes "Company" singular ("Al Jaleel Trading Company"), so
// "Spieker General Contractors" and "…Company in Qatar" both survive.
const CATEGORY_PHRASE =
  /^(?:the\s+)?(?:top\s+|best\s+|leading\s+|all\s+)?(?:\w+\s+){0,2}(?:companies|suppliers|manufacturers|traders|contractors|distributors|factories|businesses|firms|agencies|providers|vendors|exporters|importers)\s+(?:in|of|near|from)\b/i;

/* ------------------------- foreign-result guard ------------------------- */
// Even with the country in the query, a US result slips through on a homonym:
// Medina (Saudi Arabia / Ohio), Hail (Saudi Arabia / hail damage), Lusail,
// Tripoli, Alexandria. These markers are unambiguous — a comma before a US
// state, a ZIP code, or a toll-free number — so a non-US search can drop them.
const US_STATE =
  "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming";
const US_ABBR =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
const US_MARKERS: RegExp[] = [
  new RegExp(`,\\s*(?:${US_STATE})\\b`, "i"),        // "Medina, Ohio"
  new RegExp(`,\\s*(?:${US_ABBR})\\b`),               // "Lampasas, TX" (case-sensitive)
  new RegExp(`\\b(?:${US_ABBR})\\s+\\d{5}\\b`),       // "TX 76550"
  new RegExp(`\\b(?:district|state|county)\\s+of\\s+(?:${US_STATE})\\b`, "i"),
  /\b1?[\s-]?\(?8(?:00|33|44|55|66|77|88)\)?[\s-]?\d{3}[\s-]?\d{4}\b/, // toll-free
];
const US_COUNTRY = /^(usa?|united states( of america)?|u\.s\.a?\.?|america|canada)$/i;

/** True when a result is plainly in the US and the search wasn't. */
export function looksForeign(title: string, expectCountry: string): boolean {
  const want = (expectCountry || "").trim();
  if (!want || US_COUNTRY.test(want)) return false; // searching the US — allow it
  const t = (title || "").replace(INVISIBLE, "").trim();
  if (!t) return false;
  return US_MARKERS.some((re) => re.test(t));
}

/** True when a result title is content ABOUT companies rather than a company. */
export function isContentTitle(title: string): boolean {
  const t = (title || "").replace(INVISIBLE, "").trim();
  if (!t) return false;
  return (
    CONTENT_TITLE.test(t) ||
    RANKING_TITLE.test(t) ||
    DIRECTORY_TITLE.test(t) ||
    NEWS_TITLE.test(t) ||
    CATEGORY_PHRASE.test(t)
  );
}
// Bidi/zero-width marks wrap Arabic phone numbers and break plain matching.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

// A tail like ", 712 County Road 4026, Lampasas, TX 76550" or ", Taif, Masarah
// 1" is a postal address the site printed after its name, not part of it.
// The space after the comma is required: "15,506 Registered Companies" and
// "$157,500 following" are thousands separators, not addresses, and cutting
// there produced leads called "List of 15" and "Construction company cited $157".
const ADDRESS_TAIL =
  /,\s+(?:p\.?o\.?\s*box\b|\d+[\w-]*\s+\w|[\w\s.'-]+,\s+(?:[A-Z]{2}\s*\d|\d{4,}))/i;
// A comma-separated tail that just re-states the category or the SEO phrase —
// ", construction company, Taif" / ", construction companies near me".
const DESCRIPTOR_TAIL =
  /,\s+(?:the\s+)?(?:best|top|leading|professional|licensed)?\s*(?:general\s+)?(?:construction|contracting|contractor|building|engineering|manufacturing|trading|maintenance|cleaning|transport|logistics|catering)\s+(?:company|companies|contractors?|services?|firm)\b/i;
// Trailing filler a site appends to its own name in the <title>.
const NAME_TAIL_NOISE = /\s*[-–—|]?\s*(official\s+)?(web\s?site|homepage|home\s?page|online)\s*$/i;
// A fragment that is really just the site's URL ("FMCKSA.COM", "gsconstmena.com").
const BARE_DOMAIN = /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/?$/i;
// The letters of a name, for comparing a title fragment against its domain.
const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The business name inside a page title, or null when the title isn't one. */
export function companyNameFromTitle(rawTitle: string, domain: string): string | null {
  const t = (rawTitle || "").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (!t) return domain;
  if (JUNK_TITLE.test(t)) return null; // not a company page at all
  if (isContentTitle(t)) return null; // an article/ranking/directory about companies

  const parts = t
    .split(TITLE_SPLIT)
    .map((s) => s.trim().replace(/\.{2,}$/, "").trim())
    .filter(Boolean)
    .filter((s) => !TITLE_BOILERPLATE.test(s))
    .filter((s) => !/^\+?[\d\s()+-]{6,}$/.test(s)) // a bare phone number
    .filter((s) => !/^call\s/i.test(s));
  if (!parts.length) return domain;

  // 1. The fragment that matches the domain is the site's own name — the single
  //    most reliable signal there is. Without this, "Construction | Home page -
  //    Camso" on camso.com became "Construction", and "BLACK CAT GC | Discover
  //    the Leading Construction Company in Jubail" became the marketing
  //    tagline, because it was the fragment carrying the word "Company".
  //    A fragment that is literally the URL ("FMCKSA.COM") is skipped — it
  //    matches the domain perfectly but is the one thing worse than a headline.
  const root = letters((domain || "").replace(/^www\./i, "").split(".")[0] || "");
  const onDomain =
    root.length >= 4
      ? parts.find((p) => { const l = letters(p); return l && !BARE_DOMAIN.test(p) && (root.includes(l) || l.includes(root)); })
      : undefined;

  // 2. Otherwise a fragment naming a legal entity, and among several the
  //    tightest. Capped at six words so a sentence that merely CONTAINS
  //    "Company"/"Group" can't outrank the actual name beside it.
  const named = parts.filter((p) => COMPANY_SUFFIX.test(p) && p.split(/\s+/).length <= 6);

  // 3. Failing both, the first fragment — titles conventionally lead with the
  //    site's name, and "shortest" would happily pick the city out of an
  //    Arabic title.
  const best = onDomain || (named.length ? named.sort((a, b) => a.length - b.length)[0] : parts[0]);

  let out = best.replace(/[|\-–—\s]+$/, "").trim();
  // Drop a postal address, or a re-statement of the category, that the title
  // tacked on after the name.
  for (const tail of [ADDRESS_TAIL, DESCRIPTOR_TAIL]) {
    const at = out.search(tail);
    if (at > 1) out = out.slice(0, at).trim();
  }
  // Drop trailing "Website" / "Official Site" ("Imalco Website" → "Imalco").
  const trimmed = out.replace(NAME_TAIL_NOISE, "").trim();
  if (trimmed.length >= 2) out = trimmed;
  out = out.replace(/[,;:\s]+$/, "").trim();
  return out.length >= 2 ? out.slice(0, 90) : domain;
}

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
  readerKey?: string,
  expectCountry?: string
): Promise<{ companies: Company[]; blocked: boolean }> {
  const { html, blocked } = await fetchSearchPage(query, offset, readerKey);
  if (blocked) return { companies: [], blocked: true };

  const byDomain = new Map<string, Company>();
  for (const h of parseHits(html)) {
    let host = "";
    try { host = hostOf(h.url); } catch { continue; }
    if (!host || BLOCK.test(host) || CONTENT_BLOCK.test(host) || isProfileHost(host)) continue;
    if (SETUP_BLOCK.test(host) || OFFICIAL_BLOCK.test(host)) continue; // formation agencies, regulators
    if (LISTICLE_TITLE.test(h.title || "")) continue; // "Top 20 …", "Best …", "10 Leading …"
    if (looksForeign(h.title || "", expectCountry || "")) continue; // "Medina, Ohio"
    let path = "/";
    try { path = new URL(h.url).pathname.toLowerCase(); } catch { /* ignore */ }
    if (LISTICLE_PATH.test(path)) continue;
    const domain = registrableDomain(host);
    if (!domain || byDomain.has(domain)) continue;
    // The title has to yield a usable business name, or this isn't a company page.
    const name = companyNameFromTitle(h.title || "", domain);
    if (!name) continue;
    let website = h.url;
    try { const u = new URL(h.url); website = `${u.protocol}//${u.host}/`; } catch { /* keep */ }
    byDomain.set(domain, {
      name,
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
