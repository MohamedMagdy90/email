import { fetchWithRetry, type ProxyConfig } from "./fetcher";
import {
  normalizeSeed,
  hostOf,
  registrableDomain,
  sameRegistrable,
  extractLinks,
  scoreLink,
} from "./urls";
import { loadRobots } from "./robots";
import { extractEmails } from "./extract";
import { extractPhones, bestPhone, regionFromCountryName, type PhoneHit } from "./phones";
import { discoverFromSitemap } from "./sitemap";
import { cleanEmail, isValidEmail, isJunk, isRole, hasMx } from "./validate";

export interface CrawlOptions {
  maxPages?: number; // per site
  maxDepth?: number;
  respectRobots?: boolean;
  checkMx?: boolean;
  guessInbox?: boolean; // synthesize info@domain when a site exposes no email
  useSitemap?: boolean; // discover pages via sitemap.xml
  keywords?: string[]; // only keep sites whose content mentions these
  requireKeyword?: boolean; // drop sites that mention none of the keywords
  defaultCountry?: string; // country hint for parsing local-format phone numbers
  timeoutMs?: number;
  politenessMs?: number;
  concurrency?: number; // sites in parallel
  proxy?: ProxyConfig; // optional scraping proxy for JS-rendered / Cloudflare sites
}

// How trustworthy an extracted address is. Drives sorting + UI badges.
export type Confidence = "high" | "medium" | "low" | "guessed";

const METHOD_CONFIDENCE: Record<string, Confidence> = {
  mailto: "high",
  jsonld: "high",
  cloudflare: "high",
  text: "medium",
  deobfuscated: "low",
  guessed: "guessed",
};

export interface FoundEmail {
  email: string;
  role_based: boolean;
  method: string;
  confidence: Confidence;
  source: string; // page URL where found
  domain: string; // site registrable domain
  mx?: boolean;
  keywordsMatched?: string[]; // site-level: which target keywords the site mentions
  phone?: string; // site-level best phone (mobile preferred), international format
  phoneMobile?: boolean; // whether that phone is a mobile/cell number
}

export interface SiteResult {
  seed: string;
  site: string;
  status: "ok" | "blocked" | "error" | "empty";
  pagesCrawled: number;
  emails: FoundEmail[];
  matchedKeywords?: string[];
  phone?: string; // site-level best phone (mobile preferred)
  phoneMobile?: boolean;
  note?: string;
}

// Strip tags to plain lowercase text and report which keywords appear in it.
function matchKeywords(html: string, keywords: string[]): string[] {
  if (!keywords.length) return [];
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const found: string[] = [];
  for (const kw of keywords) {
    const k = kw.trim().toLowerCase();
    if (k && text.includes(k)) found.push(kw);
  }
  return found;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SEED_PATHS = [
  "/contact", "/contact-us", "/contactus", "/about", "/about-us",
  "/team", "/support", "/imprint", "/impressum", "/get-in-touch",
];

export async function crawlSite(
  seedInput: string,
  opts: CrawlOptions,
  onPage?: (info: { url: string; found: number; status: number }) => void
): Promise<SiteResult> {
  const seed = normalizeSeed(seedInput);
  const {
    maxPages = 25,
    maxDepth = 2,
    respectRobots = true,
    checkMx = true,
    guessInbox = false,
    useSitemap = true,
    keywords = [],
    requireKeyword = false,
    defaultCountry,
    timeoutMs = 15000,
    politenessMs = 250,
    proxy,
  } = opts;
  const matchedKw = new Set<string>();
  const region = regionFromCountryName(defaultCountry);
  const sitePhones = new Map<string, PhoneHit>();

  if (!seed) {
    return { seed: seedInput, site: seedInput, status: "error", pagesCrawled: 0, emails: [], note: "invalid URL" };
  }

  const origin = new URL(seed).origin;
  const siteHost = hostOf(seed);
  const siteDomain = registrableDomain(siteHost);
  const robots = respectRobots ? await loadRobots(origin) : { allow: () => true };

  const visited = new Set<string>();
  const queue: { url: string; depth: number }[] = [{ url: seed, depth: 0 }];
  for (const p of SEED_PATHS) {
    try { queue.push({ url: new URL(p, origin).toString(), depth: 1 }); } catch {}
  }

  // Jump straight to contact-like pages listed in the sitemap (even unlinked ones).
  if (useSitemap) {
    try {
      const smUrls = await discoverFromSitemap(origin, seed, 8, Math.min(timeoutMs, 8000));
      for (const u of smUrls) queue.push({ url: u, depth: 1 });
    } catch {}
  }

  const emailMap = new Map<string, FoundEmail>();
  let pagesCrawled = 0;
  let blockedHits = 0;

  while (queue.length && pagesCrawled < maxPages) {
    // Crawl the most promising (contact-like, shallow) pages first.
    queue.sort((a, b) => scoreLink(b.url) - scoreLink(a.url));
    const { url, depth } = queue.shift()!;
    const norm = url.split("#")[0];
    if (visited.has(norm)) continue;
    visited.add(norm);
    if (!sameRegistrable(norm, seed)) continue;

    let path = "/";
    try { path = new URL(norm).pathname; } catch {}
    if (respectRobots && !robots.allow(path)) continue;

    const res = await fetchWithRetry(norm, 2, timeoutMs, proxy);
    pagesCrawled++;

    if (!res.ok) {
      if (res.blocked || res.status === 403 || res.status === 429) blockedHits++;
      onPage?.({ url: norm, found: 0, status: res.status });
      await sleep(politenessMs);
      continue;
    }

    if (keywords.length) for (const k of matchKeywords(res.html, keywords)) matchedKw.add(k);

    // Capture the company's phone number(s) from this page too (mobile preferred).
    for (const ph of extractPhones(res.html, { defaultCountry: region, hostname: siteHost })) {
      const prev = sitePhones.get(ph.number);
      if (!prev || (ph.isMobile && !prev.isMobile)) sitePhones.set(ph.number, ph);
    }

    const hits = extractEmails(res.html);
    let newlyFound = 0;
    for (const h of hits) {
      const c = cleanEmail(h.email);
      if (!c || !isValidEmail(c) || isJunk(c)) continue;
      if (!emailMap.has(c)) {
        emailMap.set(c, {
          email: c,
          role_based: isRole(c),
          method: h.method,
          confidence: METHOD_CONFIDENCE[h.method] ?? "low",
          source: res.url || norm,
          domain: siteDomain,
        });
        newlyFound++;
      }
    }
    onPage?.({ url: norm, found: newlyFound, status: res.status });

    if (depth < maxDepth) {
      for (const l of extractLinks(res.html, res.url || norm)) {
        const ln = l.split("#")[0];
        if (visited.has(ln)) continue;
        if (!sameRegistrable(ln, seed)) continue;
        queue.push({ url: ln, depth: depth + 1 });
      }
    }
    await sleep(politenessMs);
  }

  let emails = [...emailMap.values()];

  // Smart inbox inference: if the site exposed no address but its mail domain
  // can actually receive mail, synthesize the best-practice role inbox. Clearly
  // flagged as "guessed" so the operator knows it's lower confidence.
  if (guessInbox && emails.length === 0 && siteDomain) {
    if (await hasMx(siteDomain)) {
      emails.push({
        email: `info@${siteDomain}`,
        role_based: true,
        method: "guessed",
        confidence: "guessed",
        source: seed,
        domain: siteDomain,
        mx: true,
      });
    }
  }

  // Deliverability: keep only domains that can actually receive mail.
  if (checkMx && emails.length) {
    const domains = [...new Set(emails.map((e) => e.email.split("@")[1]))];
    const mxMap = new Map<string, boolean>();
    await Promise.all(domains.map(async (d) => mxMap.set(d, await hasMx(d))));
    emails = emails
      .map((e) => ({ ...e, mx: e.mx ?? mxMap.get(e.email.split("@")[1]) }))
      .filter((e) => e.mx !== false);
  }

  // Order: role inboxes first (best for outreach), then by extraction reliability.
  const rank: Record<string, number> = { mailto: 0, jsonld: 1, cloudflare: 2, text: 3, deobfuscated: 4, guessed: 9 };
  emails.sort(
    (a, b) =>
      Number(b.role_based) - Number(a.role_based) ||
      (rank[a.method] ?? 8) - (rank[b.method] ?? 8) ||
      a.email.localeCompare(b.email)
  );

  const matchedKeywords = [...matchedKw];

  // Keyword gate: if the caller requires a keyword match and this site mentions
  // none of them, discard its emails — it isn't the kind of company they want.
  if (requireKeyword && keywords.length && matchedKeywords.length === 0) {
    emails = [];
  } else if (matchedKeywords.length) {
    emails = emails.map((e) => ({ ...e, keywordsMatched: matchedKeywords }));
  }

  // Attach the best phone (mobile-first) to every email so it rides along into
  // contacts. If no phone was found the email is still returned — phone is
  // purely optional enrichment and never blocks a contact from being added.
  const sitePhone = bestPhone([...sitePhones.values()], region);
  if (sitePhone) {
    emails = emails.map((e) => ({ ...e, phone: sitePhone.formatted, phoneMobile: sitePhone.type === "mobile" }));
  }

  let status: SiteResult["status"] = "ok";
  if (pagesCrawled === 0) status = "error";
  else if (emails.length === 0) {
    status = requireKeyword && keywords.length && matchedKeywords.length === 0 ? "empty" : blockedHits > 0 ? "blocked" : "empty";
  }

  return {
    seed, site: siteHost, status, pagesCrawled, emails, matchedKeywords,
    phone: sitePhone?.formatted, phoneMobile: sitePhone ? sitePhone.type === "mobile" : undefined,
  };
}

export async function crawlMany(
  seeds: string[],
  opts: CrawlOptions,
  onProgress?: (p: any) => void
): Promise<SiteResult[]> {
  const results: SiteResult[] = [];
  const concurrency = Math.min(opts.concurrency ?? 3, Math.max(1, seeds.length));
  let idx = 0;

  async function worker() {
    while (idx < seeds.length) {
      const my = idx++;
      const seed = seeds[my];
      onProgress?.({ type: "site-start", seed, index: my, total: seeds.length });
      try {
        const r = await crawlSite(seed, opts, (info) =>
          onProgress?.({ type: "page", seed, ...info })
        );
        results.push(r);
        onProgress?.({ type: "site-done", seed, result: r, done: results.length, total: seeds.length });
      } catch (e: any) {
        const r: SiteResult = {
          seed,
          site: seed,
          status: "error",
          pagesCrawled: 0,
          emails: [],
          note: String(e?.message || e),
        };
        results.push(r);
        onProgress?.({ type: "site-done", seed, result: r, done: results.length, total: seeds.length });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
