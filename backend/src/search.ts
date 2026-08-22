// Keyword-based company discovery.
//
// This is the "tier-one" search: instead of relying on OSM tags, we ask a real
// web search engine for companies matching free-text keywords (e.g. "auto
// partner", "spare parts distributor") in a location. Any business whose site
// mentions those words is fair game — exactly what OSM can't do.
//
// Sources: a POOL of keyless engines (DuckDuckGo html + lite, Brave, Bing's RSS
// endpoint). Each walls a datacenter IP after a few queries, so we rotate
// between them and rest whichever one refuses us; only when all four are
// resting do we spend a metered reader call.

import { registrableDomain, hostOf } from "./crawler/urls";
import { isProfileHost, isJunkHost } from "./crawler/profiles";
import { fetchViaReader, fetchViaProxy, type ProxyConfig } from "./crawler/fetcher";
import { placeTermsFor, tldFor } from "./places";
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
  /(^|\.)(facebook|instagram|twitter|x|linkedin|youtube|tiktok|pinterest|snapchat|whatsapp|telegram|wikipedia|wikimedia|yelp|tripadvisor|trustpilot|amazon|ebay|aliexpress|alibaba|made-in-china|indiamart|exportersindia|tradeindia|indeed|glassdoor|bayt|naukri|yellowpages|yello|yalwa|justdial|foursquare|google|goo\.gl|apple|microsoft|bing|duckduckgo|yahoo|baidu|yandex|naver|seznam|ecosia|brave|startpage|qwant|reddit|quora|medium|blogspot|wordpress|wixsite|weebly|godaddy|t\.co|bit\.ly|tinyurl|booking|expedia|craigslist|dnb|zoominfo|crunchbase|opencorporates|bloomberg|gov|edu|int)\.[a-z.]+$/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Hit {
  url: string;
  title: string;
  /**
   * The engine's own description of the page.
   *
   * Carried because it is the cheapest locality evidence there is: a Qatari
   * firm on a `.com` says "…across Qatar" in its meta description, and a US
   * contractor that Bing returned for a Qatar query does not. Before this the
   * only thing a result was judged on was its title, which is why
   * `mepacademy.com` and `samyangamerica.com` looked exactly like leads.
   */
  snippet?: string;
}

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

// DuckDuckGo's two keyless endpoints put the snippet in different furniture —
// `result__snippet` (an <a>) on html.duckduckgo.com, `result-snippet` (a <td>)
// on the lite table — but in BOTH it sits between this result's link and the
// next one, so one window scan covers the pair.
const DDG_SNIPPET = /class=["'][^"']*result(?:__|-)snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|td)>/i;

function snippetAfter(html: string, from: number, to: number): string {
  const window = html.slice(from, to);
  const m = window.match(DDG_SNIPPET);
  const text = m ? stripTags(m[1]) : stripTags(window);
  return text.slice(0, 400);
}

function parseHits(html: string): Hit[] {
  const hits: Hit[] = [];
  const re = /<a\b[^>]*class="[^"]*result(?:__a|-link)[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const found: { url: string; title: string; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const url = decodeDdg(m[1]);
    if (url) found.push({ url, title: stripTags(m[2]), end: re.lastIndex });
  }
  if (!found.length) {
    const re2 = /href="([^"]*uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m2: RegExpExecArray | null;
    while ((m2 = re2.exec(html))) {
      const url = decodeDdg(m2[1]);
      if (url) found.push({ url, title: stripTags(m2[2]), end: re2.lastIndex });
    }
  }
  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    hits.push({ url: f.url, title: f.title, snippet: snippetAfter(html, f.end, found[i + 1]?.end ?? f.end + 1200) });
  }
  return hits;
}

const isBlocked = (html: string) => /anomaly|unusual traffic|are you a robot|captcha/i.test(html);

/* ─────────────────────────── free engine pool ───────────────────────────
 * Every free search engine walls a datacenter IP eventually — DuckDuckGo after
 * a handful of queries, Brave much the same. That USED to mean every walled
 * results page went straight to the Jina reader, which is metered, and is what
 * kept running the keys out of tokens: a search pass is thousands of pages.
 *
 * The fix isn't finding a better engine, it's using more of them. Each engine
 * has its own independent quota, so rotating across four multiplies the free
 * budget and thins the load enough that any one of them sees a query only every
 * fourth request. A walled engine is RESTED, not retried, and the paid reader
 * is what happens when all four are resting at once.
 *
 * Measured from a datacenter IP: Bing's RSS endpoint answered 10/10 queries
 * while DuckDuckGo and Brave were both walled — but its results skew
 * encyclopedic, so it is ranked last and used as the safety net rather than
 * the workhorse.
 */

interface Engine {
  id: string;
  /** null = this engine cannot serve a result page that deep. */
  build: (q: string, page: number) => string | null;
  parse: (body: string) => Hit[];
  referer?: string;
  /**
   * Deepest 0-based page this engine returns DIFFERENT results for.
   *
   * Measured, not assumed — and only one of the four is above zero. Both
   * DuckDuckGo's `&s=30&dc=31` and Bing's `&first=31` look like pagination and
   * are not: each returns page one again, verbatim. Asking for them spent half
   * of every query plan re-fetching results we already had, and taught the
   * saturation table to cool the query off for being "unproductive".
   */
  maxPage: number;
  /**
   * Minimum gap between two calls to THIS engine. One global pacer was wrong:
   * Bing's RSS endpoint answered ~40 probe calls at 140ms without a single
   * limit, while Brave walls at about five. Pacing them together means the
   * engine that always answers waits for the quota of the one that doesn't.
   */
  gapMs: number;
}

// Brave renders results into `.snippet` blocks; the outbound link is the anchor
// carrying the `l1` class, and the headline is that anchor's text once the
// favicon / site-name furniture is stripped out.
function parseBrave(html: string): Hit[] {
  const hits: Hit[] = [];
  for (const block of html.split(/<div class="snippet\b/).slice(1)) {
    const url = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*\bl1\b/)?.[1];
    if (!url) continue;
    const anchor = block.match(/<a[^>]+class="[^"]*\bl1\b[^"]*"[\s\S]*?<\/a>/)?.[0] || "";
    const title = stripTags(anchor.replace(/<div class="site-name-wrapper[\s\S]*?<\/div>\s*<\/div>/, ""));
    // Brave's description markup moves around; the block's own text is stable
    // and is all the locality check needs.
    hits.push({ url, title: title.slice(0, 160), snippet: stripTags(block).slice(0, 400) });
  }
  return hits;
}

// Bing will hand its result list back as RSS, which needs no HTML parsing and
// is a twentieth of the bytes of the real results page.
function parseBingRss(xml: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const url = (m[1].match(/<link>([\s\S]*?)<\/link>/)?.[1] || "").trim();
    const title = stripTags(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] || "");
    const snippet = stripTags(m[1].match(/<description>([\s\S]*?)<\/description>/)?.[1] || "").slice(0, 400);
    if (/^https?:\/\//i.test(url)) hits.push({ url, title, snippet });
  }
  return hits;
}

const ENGINES: Engine[] = [
  {
    // The ONLY engine in the pool that genuinely paginates. Measured against a
    // datacenter IP: `&offset=1/2/3` returned 20 / 19 / 20 / 19 hosts and
    // **69 unique domains across four pages against 20 for page one alone**.
    //
    // It also has the smallest quota (~5 requests before a 429), and that is
    // precisely why DEPTH beats breadth here: four pages of one query cost the
    // same five-request quota as four separate queries and return 3.4x the
    // domains. The old code hard-capped it at page one.
    id: "brave",
    build: (q, p) =>
      p > 3 ? null : `https://search.brave.com/search?q=${encodeURIComponent(q)}${p ? `&offset=${p}` : ""}`,
    parse: parseBrave,
    maxPage: 3,
    gapMs: 2_500,
  },
  {
    // The workhorse: never rate-limited across ~40 probe calls at ~140ms each,
    // and a twentieth of the bytes of a real results page. It ignores `count`
    // and `first` entirely — always ~10 results, always page one.
    id: "bing-rss",
    build: (q, p) => (p ? null : `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&count=30`),
    parse: parseBingRss,
    maxPage: 0,
    gapMs: 1_000,
  },
  {
    id: "duckduckgo",
    build: (q, p) => (p ? null : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`),
    parse: parseHits,
    referer: "https://duckduckgo.com/",
    maxPage: 0,
    gapMs: 4_000,
  },
  {
    id: "duckduckgo-lite",
    build: (q, p) => (p ? null : `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`),
    parse: parseHits,
    referer: "https://duckduckgo.com/",
    maxPage: 0,
    gapMs: 4_000,
  },
];

/** The deepest page ANY engine in the pool can serve. */
export const MAX_RESULT_PAGE = ENGINES.reduce((m, e) => Math.max(m, e.maxPage), 0);

/* ----------------------------- per-engine pacing -----------------------------
 * A serialised, spaced queue per engine. Politeness is what keeps a free engine
 * answering us, but it has to be measured per engine or the fast one inherits
 * the slow one's problem.
 */
const engineChain = new Map<string, Promise<void>>();
const engineNextAt = new Map<string, number>();

async function pacedEngine<T>(id: string, gapMs: number, fn: () => Promise<T>): Promise<T> {
  const prev = engineChain.get(id) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  engineChain.set(id, prev.then(() => gate));
  await prev.catch(() => {});
  const now = Date.now();
  const at = Math.max(now, engineNextAt.get(id) || 0);
  engineNextAt.set(id, at + gapMs);
  if (at > now) await sleep(at - now);
  try {
    return await fn();
  } finally {
    release();
  }
}

const ENGINE_BACKOFF_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
const engineHealth = new Map<string, { fails: number; until: number }>();
/**
 * Consecutive pages an engine has returned that answered a DIFFERENT question.
 *
 * Counted separately from `fails` and required to reach three before it costs
 * anything, because a single all-rejected page is genuinely ambiguous: a narrow
 * trade phrase in a small country really can have no in-country results. Three
 * in a row is not ambiguous — that is an engine that has stopped reading the
 * query.
 */
const engineOffTopicRun = new Map<string, number>();
const OFFTOPIC_LIMIT = 3;
/** Last thing each engine was caught doing, for the health panel. */
const engineNote = new Map<string, string>();
let engineCursor = 0;

function engineUsable(id: string): boolean {
  const h = engineHealth.get(id);
  return !h || Date.now() >= h.until;
}
function engineOk(id: string): void {
  engineHealth.delete(id);
  engineOffTopicRun.delete(id);
  engineNote.delete(id);
}
function engineRest(id: string, note: string): void {
  const h = engineHealth.get(id) || { fails: 0, until: 0 };
  h.fails++;
  h.until = Date.now() + ENGINE_BACKOFF_MS[Math.min(h.fails - 1, ENGINE_BACKOFF_MS.length - 1)];
  engineHealth.set(id, h);
  engineNote.set(id, note);
}
function engineWalled(id: string): void {
  engineRest(id, "rate-limited");
}
/**
 * The engine answered, and every single result was for something else.
 *
 * Resting it is the whole point: left alone it keeps answering instantly and
 * confidently, so it wins the rotation every time and floods the pool with
 * results for a query nobody asked. A wall costs us nothing but time; this costs
 * us the credibility of the data.
 */
function engineOffTopic(id: string, q: string): void {
  const run = (engineOffTopicRun.get(id) || 0) + 1;
  engineOffTopicRun.set(id, run);
  if (run < OFFTOPIC_LIMIT) {
    engineNote.set(id, `ignored the query (${run}/${OFFTOPIC_LIMIT})`);
    return;
  }
  engineOffTopicRun.set(id, 0);
  engineRest(id, `ignoring the query — last: "${q.slice(0, 60)}"`);
}

/** Which engines are answering and which are resting — for the health panel. */
export function searchEngineHealth(): { engine: string; live: boolean; restingForMs: number; note?: string }[] {
  const now = Date.now();
  return ENGINES.map((e) => {
    const h = engineHealth.get(e.id);
    return {
      engine: e.id,
      live: !h || now >= h.until,
      restingForMs: h ? Math.max(0, h.until - now) : 0,
      note: engineNote.get(e.id),
    };
  });
}

async function askEngine(engine: Engine, q: string, page: number): Promise<Hit[] | null> {
  const url = engine.build(q, page);
  if (!url) return null;
  return pacedEngine(engine.id, engine.gapMs, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": pickUA(),
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...(engine.referer ? { Referer: engine.referer } : {}),
        },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = await res.text();
      if (isBlocked(body)) return null;
      const hits = engine.parse(body);
      return hits.length ? hits : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}

/* ══════════════ did the engine actually answer the question we asked? ══════════════
 *
 * THE BUG THIS EXISTS TO CLOSE, measured from this container's IP:
 *
 *   query                                    what came back
 *   ───────────────────────────────────────  ──────────────────────────────────────
 *   steel fabrication Qatar                  wikipedia, britannica, metalsdepot.com
 *   steel fabrication site:.qa               ← byte-identical to the line above
 *   construction company site:.sa            8 US general contractors
 *   IT solutions provider Doha Qatar         chemistrylearner.com, chem.libretexts.org
 *
 * Bing answers HTTP 200, with ten plausible-looking results, having discarded the
 * `site:` operator, the city and the country and searched only the head noun. Its
 * `&first=11/21/31/41` pages are the same ten results over and over. DuckDuckGo
 * and Brave hard-wall a datacenter IP outright, so Bing serves essentially every
 * query in production — which is exactly how a Qatar source filled up with
 * encyclopedia pages and Chinese head-term manufacturers.
 *
 * The lesson is not "pick a better engine". It is that **a search engine's
 * response is untrusted input**. A wall is honest and the old code handled it; a
 * silent degradation is a lie, arrives as a 200, and nothing here could tell the
 * difference — because nothing ever checked a result against the query that
 * produced it. That check is what follows.
 */

/** What a query demands of its results, in a form we can actually verify. */
export interface QueryIntent {
  /** Host suffix demanded by a `site:` operator — a hard, provable constraint. */
  site?: string;
  /** The country's ccTLD (".qa"), which by itself proves membership. */
  tld?: string;
  /** Words whose presence is evidence a result belongs to the place searched. */
  places: string[];
}

const SITE_OP = /\bsite:\s*\.?([a-z0-9][a-z0-9.-]*)/i;

/** Read the constraints back out of the query string we are about to send. */
export function intentFor(query: string, expectCountry?: string): QueryIntent {
  const site = query.match(SITE_OP)?.[1]?.toLowerCase().replace(/^\.+|\.+$/g, "");
  const country = (expectCountry || "").trim();
  const tld = country ? tldFor(country) : null;
  return {
    site: site || undefined,
    tld: tld ? `.${tld}` : undefined,
    places: country ? placeTermsFor(country) : [],
  };
}

const hasSuffix = (host: string, suffix: string) => host === suffix || host.endsWith("." + suffix);

// Whole-word matching, or "Sur" (Oman) matches "insurance" and "Hail" (Saudi)
// matches "hail damage repair" — the exact false positives this file already
// carries a US-state guard for.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, (m) => "\\" + m);
const wordRe = new Map<string, RegExp>();
function saysWord(hay: string, term: string): boolean {
  let re = wordRe.get(term);
  if (!re) {
    re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(term)}(?:[^a-z0-9]|$)`, "i");
    wordRe.set(term, re);
  }
  return re.test(hay);
}

/** True when this one result satisfies what the query actually asked for. */
export function hitSatisfies(hit: Hit, intent: QueryIntent): boolean {
  let host = "";
  let path = "";
  try {
    const u = new URL(hit.url);
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    path = u.pathname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;

  // A `site:` operator is checkable with certainty, so it is checked absolutely.
  // This is the single assertion that catches a degraded engine.
  if (intent.site) return hasSuffix(host, intent.site);

  if (!intent.places.length) return true; // no place was asked for
  if (intent.tld && hasSuffix(host, intent.tld.slice(1))) return true;

  // A Gulf firm on a `.com` is normal, so the country may instead show up in the
  // domain, the path, the headline or the engine's own description.
  const hay = `${host} ${path} ${hit.title || ""} ${hit.snippet || ""}`;
  return intent.places.some((p) => saysWord(hay, p));
}

/**
 * Why this is five outcomes and not "hits or null".
 *
 * `null` used to mean three different things at once, and the caller could only
 * read it as "rate-limited". The expensive case was a deep page: only Brave
 * serves one, so asking for page 2 while Brave rested made every engine decline
 * — and that was reported as a block, buying a 3-30 MINUTE backoff for a page
 * that does not exist in this pool. Half of every query plan was such a page.
 *
 * `offtopic` is the new one, and it is the important one: the engine answered,
 * in full, and not one result was for the query we sent.
 */
type SerpOutcome =
  | { kind: "hits"; hits: Hit[]; engine: string }
  | { kind: "unsupported" } // no engine in the pool serves a page this deep
  | { kind: "resting" } // the engines that could are backing off right now
  | { kind: "walled" } // engines were asked and every one refused
  | { kind: "offtopic" }; // engines answered, but not our question

/**
 * Ask the free engines, rotating so no single one carries the whole load, and
 * keep only the results that answer the query.
 *
 * An engine whose whole page fails the check is NOT walled — it is lying, which
 * is worse, because it will happily go on lying at full speed. Three such pages
 * in a row and it is rested on the same backoff ladder as a 429: from here a
 * degradation and a rate limit are the same event wearing different clothes.
 */
async function freeSerp(q: string, page: number, intent?: QueryIntent): Promise<SerpOutcome> {
  const order = ENGINES.map((_, i) => ENGINES[(engineCursor + i) % ENGINES.length]);
  engineCursor = (engineCursor + 1) % ENGINES.length;
  let capable = 0;
  let asked = 0;
  let lied = 0;
  for (const engine of order) {
    if (!engine.build(q, page)) continue; // no such page here — not a failure
    capable++;
    if (!engineUsable(engine.id)) continue; // resting off an earlier wall
    asked++;
    const hits = await askEngine(engine, q, page);
    if (!hits) {
      engineWalled(engine.id);
      continue;
    }
    const kept = intent ? hits.filter((h) => hitSatisfies(h, intent)) : hits;
    if (kept.length) {
      engineOk(engine.id);
      return { kind: "hits", hits: kept, engine: engine.id };
    }
    lied++;
    engineOffTopic(engine.id, q);
  }
  if (!capable) return { kind: "unsupported" };
  if (!asked) return { kind: "resting" };
  if (lied) return { kind: "offtopic" };
  return { kind: "walled" };
}

// Fetch one results page for the interactive search, across the free pool.
async function fetchResultsPage(q: string, page: number, intent?: QueryIntent): Promise<Hit[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await freeSerp(q, page, intent);
    if (r.kind === "hits") return r.hits;
    if (r.kind === "unsupported") return []; // retrying cannot conjure the page
    if (r.kind === "offtopic") return []; // asking a lying engine twice gets two lies
    await sleep(1200 * (attempt + 1)); // let a just-walled engine settle
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
  // The same verification the bot uses. Somebody typing "Qatar" into the search
  // box has exactly the same right not to be handed Ohio.
  const intent = intentFor(base, location);
  const byDomain = new Map<string, Company>();
  let gotAnyPage = false;

  // One query, up to two pages — enough breadth while keeping requests low.
  // Page 1 only exists on Brave; on the other engines it resolves to
  // "unsupported" and costs nothing at all.
  for (const page of [0, 1]) {
    const hits = await fetchResultsPage(base, page, intent);
    if (hits.length) gotAnyPage = true;
    for (const h of hits) {
      let host = "";
      try {
        host = hostOf(h.url);
      } catch {
        continue;
      }
      if (!host || BLOCK.test(host)) continue;
      const domain = registrableDomain(host);
      if (!domain || byDomain.has(domain)) continue;
      let website = h.url;
      try {
        const u = new URL(h.url);
        website = `${u.protocol}//${u.host}/`;
      } catch {}
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
  const intent = intentFor(base, location);
  const sites: RawHit[] = [];
  const profiles: RawHit[] = [];
  const seenSite = new Set<string>();
  const seenProfile = new Set<string>();

  for (const page of [0, 1]) {
    const hits = await fetchResultsPage(base, page, intent);
    for (const h of hits) {
      let host = "";
      try {
        host = hostOf(h.url);
      } catch {
        continue;
      }
      if (!host || isJunkHost(host)) continue;
      const domain = registrableDomain(host);
      if (!domain) continue;
      let url = h.url;
      try {
        const u = new URL(h.url);
        url = `${u.protocol}//${u.host}${u.pathname}`;
      } catch {}
      const rec: RawHit = { url, title: (h.title || "").slice(0, 120), host, domain };

      if (isProfileHost(host)) {
        // Keep the full path for profiles (we need the exact page to scrape).
        if (!seenProfile.has(url)) {
          seenProfile.add(url);
          profiles.push(rec);
        }
      } else {
        if (!seenSite.has(domain)) {
          seenSite.add(domain);
          try {
            const u = new URL(h.url);
            rec.url = `${u.protocol}//${u.host}/`;
          } catch {}
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
 *  Paginated search — for the always-on discovery bot.                       *
 *                                                                            *
 *  A datacenter IP (Railway) is reliably served DuckDuckGo's "anomaly" bot    *
 *  wall on a plain fetch. The engine POOL above is the answer: three other    *
 *  engines with their own quotas, rotated, so a walled DuckDuckGo costs       *
 *  nothing. Only when the whole pool is resting do we spend a metered reader  *
 *  call, and only then a proxy credit.                                       *
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

// Dictionaries, encyclopedias and reference sites.
//
// These never appeared while DuckDuckGo was the only engine, because DuckDuckGo
// reads "electromechanical company Riyadh" as a business intent. Bing's RSS
// endpoint — the one engine that never rate-limits us, so the one we lean on
// when the others are resting — reads the same query as a vocabulary question
// and returns Merriam-Webster, Cambridge and The Free Dictionary. They are
// obviously not prospects, and each one costs a full crawl to prove it.
const REFERENCE_BLOCK =
  /(^|\.)(merriam-webster|dictionary|thefreedictionary|collinsdictionary|oxfordlearnersdictionaries|vocabulary|wordnik|thesaurus|yourdictionary|definitions|wiktionary|investopedia|howstuffworks|study|coursera|udemy|khanacademy|byjus|geeksforgeeks|tutorialspoint|w3schools|stackexchange|stackoverflow|answers|wikihow|sciencedirect|springer|nature|jstor|arxiv|nist|bls|census|worldbank|imf|oecd|un|who)\.[a-z.]+$/i;

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
  new RegExp(`,\\s*(?:${US_STATE})\\b`, "i"),
  new RegExp(`,\\s*(?:${US_ABBR})\\b`),
  new RegExp(`\\b(?:${US_ABBR})\\s+\\d{5}\\b`),
  new RegExp(`\\b(?:district|state|county)\\s+of\\s+(?:${US_STATE})\\b`, "i"),
  /\b1?[\s-]?\(?8(?:00|33|44|55|66|77|88)\)?[\s-]?\d{3}[\s-]?\d{4}\b/,
];
const US_COUNTRY = /^(usa?|united states( of america)?|u\.s\.a?\.?|america|canada)$/i;

// A US state or state-abbreviation baked into the DOMAIN itself
// ("blackoakconstructionohio.com", "texassteelworks.com"). The title guard
// below only sees the page headline, and a site whose headline is
// "General Contractor Medina, OH" is caught — but one that simply says
// "Black Oak Construction" is not, even though its domain says Ohio.
const US_IN_DOMAIN = new RegExp(`(?:${US_STATE})(?:[a-z]*)?$|^(?:${US_STATE})`, "i");

/**
 * True when a registrable DOMAIN is plainly American and the search wasn't.
 * Deliberately domain-only (never the full host) so "ohio.ae" style false
 * positives on a ccTLD can't happen — we check the domain's first label.
 */
export function domainLooksForeign(domain: string, expectCountry: string): boolean {
  const want = (expectCountry || "").trim();
  if (!want || US_COUNTRY.test(want)) return false;
  const core = (domain || "").toLowerCase().split(".")[0] || "";
  if (core.length < 8) return false;
  return US_IN_DOMAIN.test(core);
}

// Aggregators, data brokers, map-scrapers, job boards and B2B lead sites that
// the existing lists miss. Every host named here appeared in a production log
// being crawled as if it were a lead — each one is a guaranteed dead end AND
// sits behind Cloudflare, so it costs a full six-page crawl plus six retries to
// learn nothing at all.
export const AGGREGATOR_BLOCK =
  /(^|\.)(datanyze|salaryexpert|payscale|glassdoor|levels\.fyi|mapcarta|vymaps|wikimapia|openstreetmap|mapquest|waze|foursquare|tradeford|exporthub|projectsuppliers|go4worldbusiness|b2brazil|tradewheel|muqawil|everlist|emaratfinder|arablocal|yoys|epageuae|herecareers|consultancy-me|jusmundi|lawyers?\w*directory|hailspectrum|weather\w*|nascar|espn)\.[a-z.]+$/i;

// A whole TLD that only ever hosts listings/blogs, never a trading company.
// "emarat.directory" slipped past DIRECTORY_HOST_RE because that pattern looks
// for "directory" in a LABEL, and here it is the top-level domain itself.
const LISTING_TLD = /\.(?:directory|wiki|blog|news|review|reviews|guide|info)$/i;

/* ---------------------- the "trading" collision ------------------------- */
// In the Gulf a "trading company" sells goods; on the open web "trading" means
// FOREX. A live Qatar pass on "trading and contracting W.L.L." returned
// trading212.com, etrade.com, metatrader5.com, olymptrade.com, wrtrading.com
// and simul8or.com — global brokerages and demo-account platforms that rank for
// the word everywhere on earth, and each one costs a full crawl to disprove.
//
// Two guards, because neither catches all of them: the well-known platforms are
// caught by HOST (their titles are just a brand name — "E*TRADE", "Trading
// 212"), and the long tail is caught by TITLE ("Free Trading Simulator").
export const FINANCE_BLOCK =
  /(^|\.)(trading212|etrade|e-trade|olymptrade|olymp|iqoption|iqbroker|expertoption|pocketoption|quotex|binomo|deriv|metatrader\d*|metaquotes|mt4|mt5|ctrader|tradingview|investing|fxpro|fxtm|fxcm|forex\w*|\w*forex|oanda|avatrade|axitrader|pepperstone|icmarkets|exness|xm|xtb|plus500|etoro|markets|cmcmarkets|ig|saxobank|interactivebrokers|thinkorswim|webull|robinhood|coinbase|binance|kraken|bybit|okx|kucoin|bitget|simul8or|wrtrading|tradestation|ninjatrader|tradeciety|babypips|dailyfx|myfxbook|fxblue)\.[a-z.]+$/i;

// Titles that describe a trading/brokerage PRODUCT rather than a local firm.
const PLATFORM_TITLE =
  /\b(?:forex|cfds?|spread bett\w*|binary options?|demo account|trading (?:platform|simulator|account|app|bot|signals?|academy|courses?)|online broker\w*|brokerage account|metatrader|mt[45]\b|copy trading|crypto (?:exchange|wallet|trading)|day trading|stock (?:market|broker)|invest(?:ing|ment) (?:platform|app))\b/i;

/**
 * The single "this host can NEVER be a prospect" gate.
 *
 * Every blocklist in this file already runs when a search result is inserted —
 * but they only ran at INSERT time, so the thousands of rows discovered under
 * older, weaker rules were never re-examined and kept getting crawled. Those
 * legacy rows are the worst possible work: aggregators, job boards, hotel
 * chains and news sites are never leads AND carry the heaviest bot protection,
 * so each one burns a full multi-page crawl and six retries to learn nothing.
 *
 * Exported so enrichment and the boot sweep apply exactly the same rules the
 * search inserter does — one definition, no drift.
 */
export function isNonProspectHost(host: string): boolean {
  const h = (host || "").trim().toLowerCase().replace(/^www\./, "");
  if (!h) return true;
  return (
    BLOCK.test(h) ||
    CONTENT_BLOCK.test(h) ||
    SETUP_BLOCK.test(h) ||
    OFFICIAL_BLOCK.test(h) ||
    AGGREGATOR_BLOCK.test(h) ||
    REFERENCE_BLOCK.test(h) ||
    FINANCE_BLOCK.test(h) ||
    LISTING_TLD.test(h) ||
    isProfileHost(h) ||
    isJunkHost(h)
  );
}

/** True when a result is plainly in the US and the search wasn't. */
export function looksForeign(title: string, expectCountry: string): boolean {
  const want = (expectCountry || "").trim();
  if (!want || US_COUNTRY.test(want)) return false;
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

/* --------------------- the dictionary-answer problem ---------------------
 * A degraded engine reads "steel fabrication Qatar" as a vocabulary question
 * and answers with reference pages. Their titles are not company names and
 * never split into one — "Steel: Definition, Composition, Types, Properties,
 * and Applications" was saved verbatim as a lead, as was "Solution: Definition,
 * Components, Types, and Examples".
 *
 * These are caught HERE rather than by host, because the hosts are a long tail
 * (xometry, engineeringchoice, chemistrylearner, worldsteel, cgaa …) while the
 * title shape is always the same handful of words.
 */
const ENCYCLOPEDIC_TITLE =
  /\b(?:definitions?|synonyms?|antonyms?|pronunciation|etymology|encyclopedia|thesaurus)\b|:\s*(?:definition|meaning|overview|composition|types|examples|uses|history|properties)\b|^\s*(?:what|how|why|when|which)\s+(?:is|are|to|do|does|did|can|should|was|were)\b/i;

/**
 * A title cut mid-way by the engine, repaired.
 *
 * RSS and snippet titles arrive truncated, leaving a dangling bracket or quote:
 * `Commercial Mechanical, March Electrical and Plumbing 2026 ("MEP` became a
 * lead name exactly as written. Cutting at the unmatched opener is the only
 * honest thing to do — the rest of the name is not in the string.
 */
function trimUnbalanced(s: string): string {
  let out = s;
  const opens = (out.match(/\(/g) || []).length;
  const closes = (out.match(/\)/g) || []).length;
  if (opens > closes) out = out.slice(0, out.lastIndexOf("(")).trim();
  const quoted = (out.match(/[“"«]/g) || []).length;
  const unquoted = (out.match(/[”»]/g) || []).length;
  if (quoted > unquoted) {
    const at = out.search(/[“"«][^”»]*$/);
    if (at > 0) out = out.slice(0, at).trim();
  }
  return out.replace(/[,;:–—-]+$/, "").trim();
}

/** The business name inside a page title, or null when the title isn't one. */
export function companyNameFromTitle(rawTitle: string, domain: string): string | null {
  const t = (rawTitle || "").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (!t) return domain;
  if (JUNK_TITLE.test(t)) return null; // not a company page at all
  if (isContentTitle(t)) return null; // an article/ranking/directory about companies
  if (ENCYCLOPEDIC_TITLE.test(t)) return null; // a dictionary/encyclopedia answer

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
      ? parts.find((p) => {
          const l = letters(p);
          return l && !BARE_DOMAIN.test(p) && (root.includes(l) || l.includes(root));
        })
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
  out = trimUnbalanced(out).replace(/[,;:\s]+$/, "").trim();
  // A dozen words is a sentence, not a trading name. Better to fall back to the
  // domain — which enrichment will replace with the site's own <title> — than to
  // file a headline as if somebody could be addressed by it.
  if (out.split(/\s+/).length > 9) return domain;
  return out.length >= 2 ? out.slice(0, 90) : domain;
}

// Result URLs whose path screams "listicle / blog" rather than a company home.
const LISTICLE_PATH = /\/(?:top-|best-|list-of|list\/|guide\/|blog\/|news\/|article|companies-in-|directory\/)/i;

// Result TITLES that are clearly "top N" round-up articles, not a company.
const LISTICLE_TITLE = /^\s*(?:the\s+)?(?:top|best|leading|\d+\s+(?:top|best|leading|of the best))\b/i;

const ddgUrl = (query: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

// Fetch ONE results page for the bot, cheapest source first.
//   1. the free engine pool (rotated, and rested when walled OR when caught
//      answering a different question)
//   2. the Jina reader on DuckDuckGo — metered, so only when the pool is spent
//   3. the scraping proxy — costs credits, so last
//
// Every tier's results go through the SAME verification, because the reader and
// the proxy are rendering the same public search pages and inherit exactly the
// same failure mode. A metered call that returns off-query results is worse than
// a free one: it costs money to be misled.
//
// `blocked`    = we couldn't get a real page from ANY of them.
// `unsupported`= no engine serves a page that deep. NOT a block: there is
//                nothing to back off from and nothing to retry.
// `offtopic`   = a page came back and none of it was for this query. Also not a
//                block — retrying gets the same wrong answer — but it must never
//                be reported as "no results", or a query that the engine simply
//                refuses to read gets cooled off as if it were exhausted.
async function fetchSearchPage(
  query: string,
  page: number,
  readerKey?: string,
  proxy?: ProxyConfig,
  intent?: QueryIntent
): Promise<{ hits: Hit[]; blocked: boolean; unsupported: boolean; offtopic: boolean; engine: string }> {
  const miss = (k: "blocked" | "unsupported" | "offtopic") => ({
    hits: [] as Hit[],
    blocked: k === "blocked",
    unsupported: k === "unsupported",
    offtopic: k === "offtopic",
    engine: "none",
  });
  const keep = (hits: Hit[]) => (intent ? hits.filter((h) => hitSatisfies(h, intent)) : hits);

  // 1) The free pool. This is what keeps the reader bill near zero.
  const free = await freeSerp(query, page, intent);
  if (free.kind === "hits") {
    return { hits: free.hits, blocked: false, unsupported: false, offtopic: false, engine: free.engine };
  }
  if (free.kind === "unsupported") return miss("unsupported");

  // The paid tiers below render DuckDuckGo's FIRST results page. There is no
  // deep page for them to render, so spending a token on one is pure waste.
  if (page > 0) return miss("unsupported");

  const url = ddgUrl(query);

  // 2) The reader renders the results page and returns real HTML — verified to
  //    bypass the anomaly wall. It costs tokens, hence its position here.
  const rd = await fetchViaReader(url, 45000, readerKey).catch(() => null);
  if (rd?.ok && rd.html && !isBlocked(rd.html)) {
    const hits = keep(parseHits(rd.html));
    if (hits.length) return { hits, blocked: false, unsupported: false, offtopic: false, engine: "reader" };
  }

  // 3) Scraping proxy — last, because it costs credits. The results page is
  //    plain server-rendered HTML: it needs a different IP, NOT JS rendering or
  //    a stealth proxy. Asking for those costs ~75 credits a call on
  //    ScrapingBee instead of ~1, so the cheap tier goes first and stealth is
  //    only tried if the cheap one is walled too.
  if (proxy) {
    const cheap = keep((await proxyHits(url, { ...proxy, renderJs: false, premium: false })) || []);
    if (cheap.length) return { hits: cheap, blocked: false, unsupported: false, offtopic: false, engine: "proxy" };
    // Only worth the stealth surcharge if the plain IP swap was walled too.
    if (proxy.premium !== false) {
      const stealth = keep((await proxyHits(url, { ...proxy, renderJs: false, premium: true })) || []);
      if (stealth.length) return { hits: stealth, blocked: false, unsupported: false, offtopic: false, engine: "proxy" };
    }
  }

  // The pool answered but said nothing on-topic, and the paid tiers added
  // nothing usable. That is a bad ANSWER, not a missing one.
  if (free.kind === "offtopic") return miss("offtopic");
  return miss("blocked");
}

// One proxy attempt: parsed results, or null if it was walled.
async function proxyHits(url: string, cfg: ProxyConfig): Promise<Hit[] | null> {
  const r = await fetchViaProxy(url, cfg).catch(() => null);
  if (!r?.ok || !r.html || isBlocked(r.html)) return null;
  const hits = parseHits(r.html);
  return hits.length ? hits : null;
}

/**
 * Turn raw result hits into company records, INTO a shared map.
 *
 * Filters out social/marketplaces (BLOCK), SEO/listicle/data-broker hosts
 * (CONTENT_BLOCK) and obvious listicle URLs — leaving individual company
 * websites. No email/phone (search only gives the site); the discovery bot then
 * crawls each site to find the address.
 *
 * The map is passed IN rather than returned so that several result pages of the
 * same query dedupe against each other — which is the whole point of paging: a
 * deep page that repeats page one must be visible as "added nothing".
 */
function collectCompanies(
  hits: Hit[],
  byDomain: Map<string, Company>,
  limit: number,
  expectCountry?: string
): number {
  let added = 0;
  for (const h of hits) {
    if (byDomain.size >= limit) break;
    let host = "";
    try {
      host = hostOf(h.url);
    } catch {
      continue;
    }
    if (!host || isNonProspectHost(host)) continue; // social, brokers, directories, regulators
    if (LISTICLE_TITLE.test(h.title || "")) continue; // "Top 20 …", "Best …", "10 Leading …"
    if (PLATFORM_TITLE.test(h.title || "")) continue; // "Free Trading Simulator" — forex, not a trader
    if (looksForeign(h.title || "", expectCountry || "")) continue; // "Medina, Ohio"
    let path = "/";
    try {
      path = new URL(h.url).pathname.toLowerCase();
    } catch {
      /* ignore */
    }
    if (LISTICLE_PATH.test(path)) continue;
    const domain = registrableDomain(host);
    if (!domain || byDomain.has(domain)) continue;
    // "blackoakconstructionohio.com" — the headline said nothing American, but
    // the domain plainly does.
    if (domainLooksForeign(domain, expectCountry || "")) continue;
    // The title has to yield a usable business name, or this isn't a company page.
    const name = companyNameFromTitle(h.title || "", domain);
    if (!name) continue;
    let website = h.url;
    try {
      const u = new URL(h.url);
      website = `${u.protocol}//${u.host}/`;
    } catch {
      /* keep */
    }
    byDomain.set(domain, { name, website, city: "", email: null, phone: null, hasWebsite: true });
    added++;
  }
  return added;
}

// One page of company results for a query. Kept as the single-page primitive.
export async function searchCompaniesPaged(
  query: string,
  page: number,
  limit: number,
  readerKey?: string,
  expectCountry?: string,
  proxy?: ProxyConfig
): Promise<{ companies: Company[]; blocked: boolean; unsupported?: boolean; offtopic?: boolean; engine?: string }> {
  const intent = intentFor(query, expectCountry);
  const { hits, blocked, unsupported, offtopic, engine } = await fetchSearchPage(query, page, readerKey, proxy, intent);
  if (blocked) return { companies: [], blocked: true };
  const byDomain = new Map<string, Company>();
  collectCompanies(hits, byDomain, limit, expectCountry);
  return { companies: [...byDomain.values()], blocked: false, unsupported, offtopic, engine };
}

export interface DeepSearchResult {
  companies: Company[];
  blocked: boolean;
  pages: number; // result pages actually fetched
  engines: string[]; // which engines served them
  /**
   * True when an engine answered in full and none of it was for this query.
   *
   * The caller MUST NOT treat this as "this query is exhausted". A degraded
   * engine produces zero usable results for every query alike, and recording
   * that as a zero yield would cool off the entire plan — quietly turning one
   * bad engine into a source that has stopped searching.
   */
  offtopic: boolean;
}

/**
 * Every result page one query will give us, merged and deduped.
 *
 * This is the unit the discovery bot walks now, and the reason is arithmetic.
 * Brave is the only engine that paginates, and it is also the one with the
 * tightest quota (~5 requests before a 429). Four pages of ONE query cost the
 * same five-request quota as four separate queries — and measured, they return
 * 69 unique domains against the 20 a single page gives. So depth is free
 * breadth, and it is only reachable per-query, never per-plan-entry.
 *
 * Stops at the first page that adds nothing new, because that is exactly what
 * an engine repeating page one looks like from here.
 */
export async function searchCompaniesDeep(
  query: string,
  opts: {
    maxPages?: number;
    limit?: number;
    readerKey?: string;
    expectCountry?: string;
    proxy?: ProxyConfig;
  } = {}
): Promise<DeepSearchResult> {
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? MAX_RESULT_PAGE + 1, MAX_RESULT_PAGE + 1));
  const limit = opts.limit ?? 120;
  const intent = intentFor(query, opts.expectCountry);
  const byDomain = new Map<string, Company>();
  const engines: string[] = [];
  let pages = 0;
  let offtopic = false;

  for (let page = 0; page < maxPages; page++) {
    const r = await fetchSearchPage(query, page, opts.readerKey, opts.proxy, intent);
    // Only page ZERO can declare the source rate-limited. A deep page that
    // nobody can serve is a fact about the pool, not about us being throttled,
    // and reporting it as a block used to buy a 3-30 minute backoff for nothing.
    if (r.blocked) {
      if (page === 0) return { companies: [], blocked: true, pages: 0, engines: [], offtopic: false };
      break;
    }
    if (r.offtopic) {
      if (page === 0) offtopic = true;
      break;
    }
    if (r.unsupported || !r.hits.length) break;
    pages++;
    if (r.engine) engines.push(r.engine);
    const added = collectCompanies(r.hits, byDomain, limit, opts.expectCountry);
    // The engine handed back a page it had already given us. Going deeper on a
    // repeating engine only burns its quota.
    if (!added) break;
    if (byDomain.size >= limit) break;
  }

  return { companies: [...byDomain.values()], blocked: false, pages, engines, offtopic };
}
