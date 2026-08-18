import { fetchWithRetry, archivedPagesFor, type ProxyConfig, type BlockReason } from "./fetcher";
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
  readerKey?: string; // optional (free) Jina Reader API key for higher rate limits
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
  // WHY the crawl was blocked, machine-readable. The caller needs to tell a
  // permanent wall (Cloudflare / 403) from a transient one (429 / timeout):
  // retrying the former six times is six guaranteed-wasted crawls.
  blockReason?: BlockReason;
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
    readerKey,
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

  // robots.txt and sitemap.xml used to be fetched BEFORE the first page. On a
  // Cloudflare-walled site that is six guaranteed-challenged requests (one for
  // robots, five sitemap candidates) spent to learn what the homepage alone
  // tells us. Both are now deferred until the seed actually answers.
  //
  // The trade-off: the homepage is fetched before robots.txt is read. A root
  // page is essentially never disallowed, and robots is still enforced for
  // every subsequent page — so politeness is preserved where it matters.
  let robots: { allow: (path: string) => boolean } = { allow: () => true };
  let expanded = false;

  const visited = new Set<string>();
  const queue: { url: string; depth: number }[] = [{ url: seed, depth: 0 }];

  // Queue the contact-page guesses + anything the sitemap knows about. Called
  // once, only after we know the site is reachable.
  const expandQueue = async (withSitemap: boolean): Promise<void> => {
    if (expanded) return;
    expanded = true;
    if (respectRobots) {
      try { robots = await loadRobots(origin); } catch { /* keep allow-all */ }
    }
    for (const p of SEED_PATHS) {
      try { queue.push({ url: new URL(p, origin).toString(), depth: 1 }); } catch {}
    }
    if (withSitemap && useSitemap) {
      try {
        const smUrls = await discoverFromSitemap(origin, seed, 8, Math.min(timeoutMs, 8000));
        for (const u of smUrls) queue.push({ url: u, depth: 1 });
      } catch {}
    }
  };

  const emailMap = new Map<string, FoundEmail>();
  let pagesCrawled = 0;
  let blockedHits = 0;
  let lastBlockReason: BlockReason | undefined;
  // The reader COSTS MONEY per page, so it gets the tightest budget of the lot:
  // one page per site, spent on the single most promising one. The free archives
  // are what should be doing this work, and they are tried first.
  let readerBudget = 1;
  let archiveBudget = 3;
  // Set when an address had to come out of an archive rather than the live site
  // — worth saying out loud, because a snapshot can be out of date.
  let archivedFrom: "commoncrawl" | "archive" | null = null;

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

    // Only spend a (scarce) free-reader escalation on high-value pages: the seed
    // (depth 0 — footer emails) and contact/about-style pages (scoreLink flags
    // those). This keeps the shared reader budget flowing across many sites
    // instead of one Cloudflare site burning it on every sub-page.
    const contactLike = depth === 0 || scoreLink(norm) >= 6;
    const allowReader = readerBudget > 0 && contactLike;
    // Wayback is the last free resort and costs ~10s a call, so it gets the
    // same treatment as the reader: only high-value pages, only a couple per
    // site. Unbudgeted, a six-page crawl of a walled site would sit there for a
    // minute re-fetching snapshots of pages that hold no address anyway.
    const allowArchive = archiveBudget > 0 && contactLike;
    const res = await fetchWithRetry(norm, 2, timeoutMs, proxy, readerKey, allowReader, allowArchive);
    if (allowReader && (res.via === "reader" || (!res.ok && res.blocked))) readerBudget--;
    if (allowArchive && (res.via === "archive" || (!res.ok && res.blocked))) archiveBudget--;
    pagesCrawled++;

    if (!res.ok) {
      if (res.blocked || res.status === 403 || res.status === 429) { blockedHits++; if (res.blockReason) lastBlockReason = res.blockReason; }
      onPage?.({ url: norm, found: 0, status: res.status });
      // The seed failed. A BLOCK means the whole origin is walled — every
      // contact-page guess and every sitemap URL behind it would be refused the
      // same way, so stop here instead of burning nine more challenged
      // requests. A plain error (404 / timeout) might just be a missing root
      // page, so still try the cheap contact paths — but never the sitemap.
      if (!expanded) {
        if (res.blocked) break;
        await expandQueue(false);
      }
      await sleep(politenessMs);
      continue;
    }

    // The site answered: now it is worth paying for robots + the sitemap.
    // But sitemap discovery uses PLAIN fetches only — so if this page reached
    // us through the reader, an archive snapshot or the proxy, direct requests
    // to that origin are walled and all five sitemap probes would be refused.
    // Skip them and rely on the contact-path guesses instead.
    if (!expanded) await expandQueue(res.via === "direct");

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

  /* ---------------------- last free resort: the archives ------------------
   * The live crawl came back with nothing AND we were walled. No amount of
   * re-asking changes that — the refusal is about our IP, not the page. But
   * Common Crawl or the Wayback Machine has very likely already stored this
   * company's contact page, and reading their copy needs no key, costs no
   * tokens and answers exactly the same question.
   *
   * This is also the only path that can reach a page we were never able to
   * LINK to: the archives are indexes, so they can hand us /contact directly
   * without the walled homepage ever telling us it exists.
   */
  if (!emailMap.size && (blockedHits > 0 || pagesCrawled === 0) && siteDomain) {
    const archived = await archivedPagesFor(siteDomain, 4).catch(() => []);
    let read = 0;
    for (const page of archived) {
      if (read >= 3 || emailMap.size) break;
      const res = await page.fetch().catch(() => null);
      if (!res?.ok || !res.html) continue;
      read++;
      pagesCrawled++;

      for (const ph of extractPhones(res.html, { defaultCountry: region, hostname: siteHost })) {
        const prev = sitePhones.get(ph.number);
        if (!prev || (ph.isMobile && !prev.isMobile)) sitePhones.set(ph.number, ph);
      }

      let found = 0;
      for (const h of extractEmails(res.html)) {
        const c = cleanEmail(h.email);
        if (!c || !isValidEmail(c) || isJunk(c) || emailMap.has(c)) continue;
        emailMap.set(c, {
          email: c,
          role_based: isRole(c),
          method: h.method,
          confidence: METHOD_CONFIDENCE[h.method] ?? "low",
          source: page.url,
          domain: siteDomain,
        });
        found++;
      }
      if (found) archivedFrom = page.source;
      onPage?.({ url: page.url, found, status: 200 });
    }
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

  // A short reason, so the caller can tell a recoverable block (retry later, or
  // add a key/proxy) from a site that simply lists no email.
  let note: string | undefined;
  if (archivedFrom && emails.length) {
    // Say it plainly. The site never answered us — this address came out of a
    // stored copy, so it is real but it can be out of date.
    note = `site blocked the crawler — address recovered from ${archivedFrom === "commoncrawl" ? "Common Crawl" : "the Wayback Machine"}`;
  } else if (status === "blocked") {
    // Only suggest a key when there isn't one. Advising "try a Jina key" to
    // someone who already added one reads like the key isn't working, when in
    // fact this site simply blocks the reader too.
    const advice = readerKey || proxy ? "" : " (a scraping proxy is the only thing that opens these)";
    note =
      lastBlockReason === "cloudflare" ? `Cloudflare challenge blocked the crawler, and no archive holds the page${advice}` :
      lastBlockReason === "rate-limited" ? "site rate-limited the crawler (HTTP 429)" :
      lastBlockReason === "forbidden" ? "site refused the crawler (HTTP 403 bot protection)" :
      "blocked by bot protection";
  }

  return {
    seed, site: siteHost, status, pagesCrawled, emails, matchedKeywords, note,
    phone: sitePhone?.formatted, phoneMobile: sitePhone ? sitePhone.type === "mobile" : undefined,
    blockReason: lastBlockReason,
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
