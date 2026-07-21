// Turn a company NAME (from a parsed PDF row) into its official WEBSITE + EMAIL.
//
// Strategy (each step is a fallback for the previous one):
//   1. Use the website/email already present on the PDF row.
//   2. Web-search "<name> <country>" and crawl the best-matching real website.
//   3. If the company only has a social/directory presence (Facebook, Talabat,
//      Instagram …), read that profile page to recover the real website + email.
//   4. As a last resort, guess the domain from the name and verify it has MX.
//
// A phone number from the PDF (when present) is used to VERIFY a match: if the
// crawled site shows the same phone, we mark the result "verified".

import { searchCompanies, searchRaw, type RawHit } from "./search";
import { crawlSite, type CrawlOptions } from "./crawler";
import { fetchPage, fetchViaProxy, fetchViaReader, type ProxyConfig } from "./crawler/fetcher";
import { extractContactFromProfile, isProfileHost, isJunkHost } from "./crawler/profiles";
import { cleanEmail, isValidEmail, isJunk, isRole, hasMx } from "./crawler/validate";
import { registrableDomain, hostOf } from "./crawler/urls";

// An email that belongs to the COMPANY, not to a platform it's listed on. A
// directory's / social network's own inbox (info@oilandgasdirectory.qa,
// info@yellowpages.qa, …) must never be attributed to a company we found there.
function isCompanyEmail(email: string): boolean {
  const domain = registrableDomain((email.split("@")[1] || ""));
  if (!domain) return false;
  return !isProfileHost(domain) && !isJunkHost(domain);
}

// Legal suffixes / generic words that shouldn't count toward a name match.
const STOP = new Set([
  "the", "and", "for", "co", "company", "trading", "group", "est", "establishment",
  "llc", "wll", "w", "l", "ll", "ltd", "limited", "inc", "corporation", "corp",
  "services", "service", "international", "intl", "general", "contracting",
  "trad", "ind", "industries", "industrial", "enterprises", "enterprise",
]);

// A token is meaningful if it's not a generic/legal word AND is either 3+ chars
// or a short token carrying a digit ("3m", "4k", "21", "974"). Those short
// alphanumerics are usually the most DISTINCTIVE part of a company name, so we
// must keep them — dropping them was why "3m Gulf" matched gulf.com.
function isMeaningful(t: string): boolean {
  if (!t || STOP.has(t)) return false;
  return t.length >= 3 || (t.length >= 2 && /\d/.test(t));
}

// Normalize ordinals so "49th"→"49", "21st"→"21", "3rd"→"3": the digit is the
// distinctive part and domains drop the suffix ("49th Street Customs" →
// 49customs.com).
function normalizeOrdinals(s: string): string {
  return s.replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1");
}

function tokens(s: string): string[] {
  return normalizeOrdinals(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(isMeaningful);
}

// The country is appended to EVERY search query, so it must never count as a
// matching token — otherwise "4k -Qatar" matches qatar.net. Build the set of
// words (+ a few synonyms) to strip from the company's tokens/slug.
function countryTokenSet(country: string): Set<string> {
  const s = new Set<string>();
  const key = (country || "").trim().toLowerCase();
  for (const w of key.replace(/[^a-z\s]/g, " ").split(/\s+/)) if (w.length >= 2) s.add(w);
  const syn: Record<string, string[]> = {
    qatar: ["qa"], "united arab emirates": ["uae", "emirates", "arab"], uae: ["emirates", "arab"],
    "saudi arabia": ["ksa", "saudi"], ksa: ["saudi"], bahrain: ["bh"], kuwait: ["kw"],
    oman: ["om"], egypt: ["eg"],
  };
  for (const k of Object.keys(syn)) if (key.includes(k)) syn[k].forEach((x) => s.add(x));
  return s;
}

// Distinctive company tokens = meaningful tokens with the country removed.
function distinctiveTokens(name: string, country: string): string[] {
  const drop = countryTokenSet(country);
  return tokens(name).filter((t) => !drop.has(t));
}

// The compact company "slug": the name with legal suffixes, connectors and the
// country removed, then all letters/digits joined. Used for prefix matching
// against a domain core (the strongest "the domain IS the company" signal).
const SLUG_DROP = new Set([
  "llc", "wll", "w", "l", "ll", "ltd", "limited", "inc", "corp", "corporation",
  "est", "establishment", "co", "company", "and", "the", "for", "of",
]);
function nameSlug(name: string, country: string): string {
  const drop = new Set([...SLUG_DROP, ...countryTokenSet(country)]);
  return normalizeOrdinals(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !drop.has(t))
    .join("");
}

// The "core" of a registrable domain = its first label, letters/digits only
// ("century21.com" → "century21", "almeera.com.qa" → "almeera").
function domainCore(domain: string): string {
  return (domain.split(".")[0] || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function lcpLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// ccTLD suffixes to prefer for a given country (e.g. Qatar → com.qa, qa).
function countryTlds(country: string): string[] {
  return COUNTRY_TLDS[(country || "").trim().toLowerCase()] || [];
}

export interface ResolvedSite {
  website: string; // full URL (https://…/)
  domain: string; // registrable domain
}

// After a brand-prefix match, what's LEFT in the domain core must be trivial —
// a country word, a common corporate suffix, or ≤3 chars (e.g. a plural "s").
// Otherwise the "prefix" is just a short word sitting inside a different brand
// ("fresh" inside "freshthyme"), which we must reject.
const GENERIC_REMAINDER = new Set([
  "group", "holding", "intl", "international", "company", "est", "establishment",
  "trading", "trad", "co", "llc", "wll", "ltd", "grp",
]);
function acceptableRemainder(rem: string, ccWords: Set<string>): boolean {
  if (rem.length <= 3) return true;
  if (ccWords.has(rem)) return true;
  return GENERIC_REMAINDER.has(rem);
}

// Decide whether a search hit is a TRUSTWORTHY match for the company, and score
// it. `strong` is the gate: we only ever attach a website that is `strong`
// (or later phone-verified) — otherwise we return nothing rather than a guess.
function analyzeCandidate(
  nameToks: string[],
  firstTok: string | undefined,
  slug: string,
  ccTlds: string[],
  ccWords: Set<string>,
  hit: RawHit
): { score: number; strong: boolean } {
  const domCore = domainCore(hit.domain);
  if (!domCore) return { score: 0, strong: false };

  const matched = nameToks.filter((t) => domCore.includes(t));
  const firstMatched = !!firstTok && domCore.includes(firstTok);
  const ccMatch = ccTlds.some((t) => hit.domain.toLowerCase().endsWith("." + t));

  let score = 0;
  let strong = false;

  if (slug.length >= 3 && domCore === slug) {
    score = 100; // the domain IS the company name
    strong = true;
  } else {
    const lcp = slug.length >= 5 ? lcpLen(slug, domCore) : 0;
    if (lcp >= 5 && acceptableRemainder(domCore.slice(lcp), ccWords)) {
      score = 50 + lcp; // domain starts with the company name (brand prefix)
      strong = true;
    } else {
      // Fall back to token overlap, but require the FIRST (most distinctive)
      // token AND at least two tokens — a single generic word ("gulf",
      // "garage", "print") is never enough on its own.
      score = matched.length * 3 + (firstMatched ? 2 : 0) + (ccMatch ? 2 : 0);
      strong = matched.length >= 2 && firstMatched;
    }
  }
  if (ccMatch) score += 1; // tiny tiebreak toward the country's own ccTLD
  return { score, strong };
}

export async function resolveWebsite(company: string, country: string): Promise<ResolvedSite | null> {
  const name = company.trim();
  if (!name) return null;

  let candidates;
  try {
    candidates = await searchCompanies(name, country || "", 5);
  } catch {
    return null; // search rate-limited / unavailable — treat as "not found"
  }
  const hits: RawHit[] = candidates
    .filter((c) => c.website)
    .map((c) => {
      const host = hostOf(c.website!);
      return { url: c.website!, title: c.name || "", host, domain: registrableDomain(host) || "" };
    })
    .filter((h) => h.domain);

  const ranked = rankSites(name, country || "", hits);
  if (!ranked.length) return null; // no strong match → return nothing, not a guess
  return { website: ranked[0].url, domain: ranked[0].domain };
}

/* ========================================================================== *
 *  Full company enrichment: name → website → email (with social + guess).    *
 * ========================================================================== */

export type EnrichSource = "pdf" | "site" | "social" | "guess";
export type EnrichConfidence = "verified" | "likely" | "guess";

export interface EnrichInput {
  company: string;
  category?: string;
  phone?: string;
  phoneMobile?: boolean;
  email?: string;
  website?: string;
}

export interface EnrichOutput {
  website: string | null;
  domain: string | null;
  email: string | null;
  role_based: boolean;
  phone: string | null;
  phoneMobile: boolean;
  source: EnrichSource | null;
  confidence: EnrichConfidence | null;
  via: string | null; // profile host the contact was recovered through, e.g. "facebook.com"
}

export interface EnrichConfig {
  crawlOpts: CrawlOptions;
  proxy?: ProxyConfig;
  readerKey?: string; // optional (free) Jina Reader key for higher rate limits
  useProfiles?: boolean; // read Facebook/Instagram/directory pages (default true)
  guessDomains?: boolean; // guess the domain from the name (default true)
}

const normUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : "https://" + u);
const onlyDigits = (s?: string | null) => (s || "").replace(/\D/g, "");

// Two phone numbers "match" if their last 7 digits line up (ignoring country
// prefix / formatting differences between the PDF and the website).
function phonesMatch(a?: string | null, b?: string | null): boolean {
  const x = onlyDigits(a);
  const y = onlyDigits(b);
  if (x.length < 7 || y.length < 7) return false;
  return x.endsWith(y.slice(-7)) || y.endsWith(x.slice(-7));
}

// Best deliverable-looking email from a list (role inboxes preferred).
function pickEmail(emails: string[]): { email: string; role: boolean } | null {
  const good: string[] = [];
  for (const raw of emails) {
    const e = cleanEmail(raw);
    if (e && isValidEmail(e) && !isJunk(e) && isCompanyEmail(e)) good.push(e);
  }
  if (!good.length) return null;
  good.sort((a, b) => Number(isRole(b)) - Number(isRole(a)) || a.localeCompare(b));
  return { email: good[0], role: isRole(good[0]) };
}

// Country name → ccTLDs to try when guessing a domain.
const COUNTRY_TLDS: Record<string, string[]> = {
  qatar: ["com.qa", "qa"], "united arab emirates": ["ae", "com"], uae: ["ae", "com"],
  "saudi arabia": ["com.sa", "sa"], ksa: ["com.sa", "sa"], kuwait: ["com.kw"],
  bahrain: ["com.bh", "bh"], oman: ["com.om", "om"], egypt: ["com.eg"],
};

function guessCandidates(company: string, country: string): string[] {
  const toks = tokens(company);
  if (!toks.length) return [];
  const slugs = new Set<string>();
  slugs.add(toks.join("")); // e.g. "7legendboutique"
  if (toks.length >= 2) slugs.add(toks.slice(0, 2).join(""));
  if (toks[0].length >= 4) slugs.add(toks[0]);
  const tlds = [...(COUNTRY_TLDS[country.trim().toLowerCase()] || []), "com", "net"];
  const out: string[] = [];
  for (const s of slugs) for (const t of tlds) out.push(`${s}.${t}`);
  return [...new Set(out)].slice(0, 10);
}

async function fetchProfileHtml(url: string, proxy?: ProxyConfig, readerKey?: string): Promise<string | null> {
  // 1) Plain direct fetch — free, works for most directory pages.
  const d = await fetchPage(url, 15000).catch(() => null);
  if (d?.ok && d.html && !d.blocked) return d.html;
  // 2) FREE reader (renders JS) — good for JS-heavy directories/listings.
  const rd = await fetchViaReader(url, undefined, readerKey).catch(() => null);
  if (rd?.ok && rd.html) return rd.html;
  // 3) Paid scraping proxy, only if the user configured one.
  if (proxy) {
    const p = await fetchViaProxy(url, proxy).catch(() => null);
    if (p?.ok && p.html) return p.html;
  }
  return d?.ok && d.html ? d.html : null;
}

// Rank candidate real sites by name match; ONLY keep trustworthy ("strong")
// matches, best score first, with the country's ccTLD winning close ties.
export function rankSites(company: string, country: string, sites: RawHit[]): RawHit[] {
  const nameToks = distinctiveTokens(company, country);
  const firstTok = nameToks[0];
  const slug = nameSlug(company, country);
  const ccTlds = countryTlds(country);
  const ccWords = countryTokenSet(country);
  return sites
    .map((s) => ({ s, a: analyzeCandidate(nameToks, firstTok, slug, ccTlds, ccWords, s) }))
    .filter((x) => x.a.strong)
    .sort((a, b) => b.a.score - a.a.score)
    .map((x) => x.s);
}

export async function enrichCompany(
  input: EnrichInput,
  country: string,
  cfg: EnrichConfig
): Promise<EnrichOutput> {
  const out: EnrichOutput = {
    website: null, domain: null, email: null, role_based: false,
    phone: input.phone || null, phoneMobile: !!input.phoneMobile,
    source: null, confidence: null, via: null,
  };
  let phoneVerified = false;

  // Crawl a real website for an email (+ phone), filling `out`. Returns whether
  // an email was found.
  async function crawlForEmail(
    website: string,
    source: EnrichSource,
    via: string | null,
    commitWebsite = true
  ): Promise<boolean> {
    const site = await crawlSite(website, cfg.crawlOpts).catch(() => null);
    if (!site) return false;
    if (!out.phone && site.phone) { out.phone = site.phone; out.phoneMobile = !!site.phoneMobile; }
    if (input.phone && site.phone && phonesMatch(input.phone, site.phone)) phoneVerified = true;

    let found = false;
    if (site.emails.length && !out.email) {
      // Take the first address that actually belongs to the company (skip a
      // directory/platform's own inbox that may have been crawled).
      const best = site.emails.find((e) => isCompanyEmail(e.email));
      if (best) {
        out.email = best.email;
        out.role_based = best.role_based;
        out.domain = best.domain || registrableDomain(hostOf(website)) || out.domain;
        out.source = source;
        out.via = via;
        found = true;
      }
    }
    // Only record the website when it's a trustworthy match (commitWebsite) or
    // we actually found the company's email there — never for a blind guess.
    if ((commitWebsite || found) && !out.website) {
      out.website = website;
      out.domain = out.domain || registrableDomain(hostOf(website));
    }
    return found;
  }

  // 0) Contact already on the PDF row.
  if (input.email) {
    const e = pickEmail([input.email]);
    if (e) { out.email = e.email; out.role_based = e.role; out.source = "pdf"; }
  }
  if (input.website) {
    out.website = normUrl(input.website);
    out.domain = registrableDomain(hostOf(out.website)) || null;
    if (!out.email) await crawlForEmail(out.website, "pdf", null);
  }
  if (out.email && out.website) return finalize(out, phoneVerified);

  // 1) Search "<name> <country>" and split into real sites vs profile pages.
  let res: { sites: RawHit[]; profiles: RawHit[] } = { sites: [], profiles: [] };
  try { res = await searchRaw(input.company, country, 8); } catch { /* rate-limited */ }

  // 2) Try the best-matching real sites — but only STRONG matches. If none is
  //    strong we set no website here and fall through (better nothing than a
  //    wrong guess like gulf.com / garage.com).
  {
    const ranked = rankSites(input.company, country, res.sites);
    for (const s of ranked.slice(0, 2)) {
      const found = await crawlForEmail(s.url, "site", null, true);
      if (found) break;
    }
  }
  if (out.email) return finalize(out, phoneVerified);

  // 3) Profile fallback — recover the real website + email from a Facebook /
  //    Instagram / directory page (exactly like looking it up by hand).
  if (cfg.useProfiles !== false) {
    for (const p of res.profiles.slice(0, 2)) {
      const html = await fetchProfileHtml(p.url, cfg.proxy, cfg.readerKey);
      if (!html) continue;
      const contact = extractContactFromProfile(html, p.url);
      if (contact.website) {
        const w = normUrl(contact.website);
        if (!out.website) { out.website = w; out.domain = contact.domain; out.source = "social"; out.via = p.host; }
        await crawlForEmail(w, "social", p.host); // crawl the discovered site for the email
      }
      if (!out.email) {
        const e = pickEmail(contact.emails);
        if (e) {
          out.email = e.email;
          out.role_based = e.role;
          out.domain = out.domain || (e.email.split("@")[1] || null);
          out.source = "social";
          out.via = p.host;
        }
      }
      if (out.email) break;
    }
  }
  if (out.email) return finalize(out, phoneVerified);

  // 4) Domain guessing (verified by MX): crawl the guessed domain, but only keep
  //    it if we actually recover the company's email there (or the phone
  //    matches) — an MX record alone is not proof it's the right company.
  if (cfg.guessDomains !== false && !out.website) {
    for (const domain of guessCandidates(input.company, country)) {
      if (!(await hasMx(domain))) continue;
      const w = "https://" + domain;
      const found = await crawlForEmail(w, "guess", null, false);
      if (found || phoneVerified) {
        if (!out.website) { out.website = w; out.domain = domain; }
        if (!out.source) out.source = "guess";
      }
      break;
    }
  }

  return finalize(out, phoneVerified);
}

function finalize(out: EnrichOutput, phoneVerified: boolean): EnrichOutput {
  if (out.email || out.website) {
    if (out.source === "pdf") out.confidence = "verified";
    else if (phoneVerified) out.confidence = "verified";
    else if (out.source === "guess") out.confidence = "guess";
    else out.confidence = "likely";
  }
  return out;
}
