// Sitemap discovery: many sites list every URL in /sitemap.xml (or a sitemap
// index that points to child sitemaps). Reading it lets us jump straight to
// contact / about / team pages even when they aren't linked from the homepage.

import { fetchPage } from "./fetcher";
import { scoreLink, sameRegistrable } from "./urls";

const SITEMAP_CANDIDATES = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/sitemap.xml.gz", // fetched as text; may fail, that's fine
  "/wp-sitemap.xml",
];

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const u = m[1].replace(/&amp;/gi, "&").trim();
    if (u) out.push(u);
  }
  return out;
}

// Return up to `max` promising same-site URLs discovered via sitemap(s).
// Handles a single level of sitemap-index nesting.
export async function discoverFromSitemap(
  origin: string,
  seed: string,
  max = 8,
  timeoutMs = 8000
): Promise<string[]> {
  const pages = new Set<string>();
  const childSitemaps = new Set<string>();

  for (const path of SITEMAP_CANDIDATES) {
    if (pages.size >= max * 4) break;
    let url = "";
    try { url = new URL(path, origin).toString(); } catch { continue; }
    const res = await fetchPage(url, timeoutMs).catch(() => null);
    if (!res || !res.ok || !res.html) continue;

    const locs = extractLocs(res.html);
    const looksLikeIndex = /<sitemapindex[\s>]/i.test(res.html);
    if (looksLikeIndex) {
      for (const l of locs) if (childSitemaps.size < 5) childSitemaps.add(l);
    } else {
      for (const l of locs) pages.add(l);
    }
    if (pages.size > 0 && !looksLikeIndex) break; // found a real url set
  }

  // Pull URLs from up to 5 child sitemaps of an index.
  for (const sm of childSitemaps) {
    if (pages.size >= max * 6) break;
    const res = await fetchPage(sm, timeoutMs).catch(() => null);
    if (!res || !res.ok || !res.html) continue;
    for (const l of extractLocs(res.html)) pages.add(l);
  }

  // Keep only same-site pages, rank by contact-likelihood, take the best few.
  const ranked = [...pages]
    .filter((u) => sameRegistrable(u, seed))
    .sort((a, b) => scoreLink(b) - scoreLink(a))
    .slice(0, max);

  return ranked;
}
