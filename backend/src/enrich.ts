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
import { fetchPage, fetchViaProxy, type ProxyConfig } from "./crawler/fetcher";
import { extractContactFromProfile } from "./crawler/profiles";
import { cleanEmail, isValidEmail, isJunk, isRole, hasMx } from "./crawler/validate";
import { registrableDomain, hostOf } from "./crawler/urls";

// Legal suffixes / generic words that shouldn't count toward a name match.
const STOP = new Set([
  "the", "and", "for", "co", "company", "trading", "group", "est", "establishment",
  "llc", "wll", "w", "l", "ll", "ltd", "limited", "inc", "corporation", "corp",
  "services", "service", "international", "intl", "general", "contracting",
  "trad", "ind", "industries", "industrial", "enterprises", "enterprise",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

export interface ResolvedSite {
  website: string; // full URL (https://…/)
  domain: string; // registrable domain
}

// Score a search hit against the company name. Domain-word matches are the
// strongest signal, then title-word matches.
function scoreHit(nameToks: string[], hit: RawHit): number {
  const domCore = hit.domain.replace(/\.[a-z.]+$/i, "").toLowerCase();
  const titleToks = tokens(hit.title || "");
  let score = 0;
  for (const t of nameToks) {
    if (domCore.includes(t)) score += 3;
    if (titleToks.includes(t)) score += 2;
  }
  return score;
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
  if (!candidates.length) return null;

  const nameToks = tokens(name);
  let best: ResolvedSite | null = null;
  let bestScore = -1;

  for (const cnd of candidates) {
    if (!cnd.website) continue;
    const domain = registrableDomain(hostOf(cnd.website)) || "";
    if (!domain) continue;
    const domCore = domain.replace(/\.[a-z.]+$/i, "").toLowerCase();
    const titleToks = tokens(cnd.name || "");

    let score = 0;
    for (const t of nameToks) {
      if (domCore.includes(t)) score += 3; // domain match is the strongest signal
      if (titleToks.includes(t)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = { website: cnd.website, domain };
    }
  }

  // Require at least one shared, meaningful token — otherwise it's a guess.
  if (!best || bestScore <= 0) return null;
  return best;
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
    if (e && isValidEmail(e) && !isJunk(e)) good.push(e);
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

async function fetchProfileHtml(url: string, proxy?: ProxyConfig): Promise<string | null> {
  // Facebook/Instagram need JS + antibot, so prefer the scraping proxy.
  if (proxy) {
    const r = await fetchViaProxy(url, proxy).catch(() => null);
    if (r?.ok && r.html) return r.html;
  }
  const d = await fetchPage(url, 15000).catch(() => null);
  return d?.ok && d.html ? d.html : null;
}

// Rank candidate real sites by name match; only keep ones sharing a token.
function rankSites(company: string, sites: RawHit[]): RawHit[] {
  const nameToks = tokens(company);
  return sites
    .map((s) => ({ s, score: scoreHit(nameToks, s) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
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
  async function crawlForEmail(website: string, source: EnrichSource, via: string | null): Promise<boolean> {
    const site = await crawlSite(website, cfg.crawlOpts).catch(() => null);
    if (!site) return false;
    if (!out.website) { out.website = website; out.domain = registrableDomain(hostOf(website)) || out.domain; }
    if (!out.phone && site.phone) { out.phone = site.phone; out.phoneMobile = !!site.phoneMobile; }
    if (input.phone && site.phone && phonesMatch(input.phone, site.phone)) phoneVerified = true;
    if (site.emails.length && !out.email) {
      const best = site.emails[0];
      out.email = best.email;
      out.role_based = best.role_based;
      out.domain = best.domain || out.domain;
      out.source = source;
      out.via = via;
      return true;
    }
    return false;
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

  // 2) Try the best-matching real sites.
  if (!out.email) {
    const ranked = rankSites(input.company, res.sites);
    for (const s of ranked.slice(0, 2)) {
      const hit = await crawlForEmail(s.url, "site", null);
      if (!out.website) { out.website = s.url; out.domain = s.domain; }
      if (hit) break;
    }
  }
  if (out.email) return finalize(out, phoneVerified);

  // 3) Profile fallback — recover the real website + email from a Facebook /
  //    Instagram / directory page (exactly like looking it up by hand).
  if (cfg.useProfiles !== false) {
    for (const p of res.profiles.slice(0, 2)) {
      const html = await fetchProfileHtml(p.url, cfg.proxy);
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

  // 4) Domain guessing (verified by MX), then crawl it for an email.
  if (cfg.guessDomains !== false && !out.website) {
    for (const domain of guessCandidates(input.company, country)) {
      if (!(await hasMx(domain))) continue;
      const w = "https://" + domain;
      out.website = w; out.domain = domain; out.source = "guess";
      await crawlForEmail(w, "guess", null);
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
