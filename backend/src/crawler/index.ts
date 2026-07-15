import { fetchWithRetry } from "./fetcher";
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
import { cleanEmail, isValidEmail, isJunk, isRole, hasMx } from "./validate";

export interface CrawlOptions {
  maxPages?: number; // per site
  maxDepth?: number;
  respectRobots?: boolean;
  checkMx?: boolean;
  timeoutMs?: number;
  politenessMs?: number;
  concurrency?: number; // sites in parallel
}

export interface FoundEmail {
  email: string;
  role_based: boolean;
  method: string;
  source: string; // page URL where found
  domain: string; // site registrable domain
  mx?: boolean;
}

export interface SiteResult {
  seed: string;
  site: string;
  status: "ok" | "blocked" | "error" | "empty";
  pagesCrawled: number;
  emails: FoundEmail[];
  note?: string;
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
    timeoutMs = 15000,
    politenessMs = 250,
  } = opts;

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

    const res = await fetchWithRetry(norm, 2, timeoutMs);
    pagesCrawled++;

    if (!res.ok) {
      if (res.status === 403 || res.status === 429) blockedHits++;
      onPage?.({ url: norm, found: 0, status: res.status });
      await sleep(politenessMs);
      continue;
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

  // Deliverability: keep only domains that can actually receive mail.
  if (checkMx && emails.length) {
    const domains = [...new Set(emails.map((e) => e.email.split("@")[1]))];
    const mxMap = new Map<string, boolean>();
    await Promise.all(domains.map(async (d) => mxMap.set(d, await hasMx(d))));
    emails = emails
      .map((e) => ({ ...e, mx: mxMap.get(e.email.split("@")[1]) }))
      .filter((e) => e.mx !== false);
  }

  // Order: role inboxes first (best for outreach), then by extraction reliability.
  const rank: Record<string, number> = { mailto: 0, cloudflare: 1, text: 2, deobfuscated: 3 };
  emails.sort(
    (a, b) =>
      Number(b.role_based) - Number(a.role_based) ||
      (rank[a.method] ?? 9) - (rank[b.method] ?? 9) ||
      a.email.localeCompare(b.email)
  );

  let status: SiteResult["status"] = "ok";
  if (pagesCrawled === 0) status = "error";
  else if (emails.length === 0) status = blockedHits > 0 ? "blocked" : "empty";

  return { seed, site: siteHost, status, pagesCrawled, emails };
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
