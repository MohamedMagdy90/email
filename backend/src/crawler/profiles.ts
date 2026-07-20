// Social / directory "profile" pages (Facebook, Instagram, LinkedIn, Talabat,
// local directories …). These are NOT a company's own website, but they very
// often list the company's real website AND email in a "Links" / "Contact info"
// block. When a business has no site of its own, this is where the contact
// actually lives — so instead of discarding these results we read them.

import { extractEmails } from "./extract";
import { extractLinks, hostOf, registrableDomain } from "./urls";

// Hosts that are social profiles or business directories worth reading for
// contact info (they frequently expose an outbound website + email).
export const PROFILE_HOST_RE =
  /(^|\.)(facebook|fb|instagram|linkedin|twitter|x|talabat|snoonu|rafeeq|deliveroo|zomato|tripadvisor|foursquare|yelp|justdial|yellowpages|yalwa|yello|bayt|gulftalent|qatarliving|marhaba|companiesqatar|qatar-companies|daleeli|connectqatar|qatardirectory|hukoomi|qbdc)\.[a-z.]+$/i;

// Hosts that are pure noise — search infra, marketplaces, encyclopaediae, link
// shorteners — never the company and never a useful contact source.
export const JUNK_HOST_RE =
  /(^|\.)(google|goo\.gl|bing|duckduckgo|yahoo|baidu|youtube|pinterest|tiktok|snapchat|whatsapp|telegram|t\.co|bit\.ly|tinyurl|wikipedia|wikimedia|amazon|ebay|aliexpress|alibaba|made-in-china|indiamart|exportersindia|tradeindia|indeed|glassdoor|naukri|apple|microsoft|reddit|quora|medium|blogspot|wordpress|wixsite|weebly|godaddy|booking|expedia|craigslist|dnb|zoominfo|crunchbase|opencorporates|bloomberg)\.[a-z.]+$/i;

export function isProfileHost(host: string): boolean {
  return PROFILE_HOST_RE.test(host);
}
export function isJunkHost(host: string): boolean {
  return JUNK_HOST_RE.test(host);
}

// A host we consider a *real* company website: not a profile, not junk.
function isRealSiteHost(host: string): boolean {
  if (!host) return false;
  return !PROFILE_HOST_RE.test(host) && !JUNK_HOST_RE.test(host);
}

// Facebook wraps every outbound link in l.facebook.com/l.php?u=<encoded-url>.
// Decode it back to the destination.
function decodeFbRedirect(href: string): string | null {
  const m = href.match(/[?&]u=([^&"]+)/);
  if (!m) return null;
  try {
    const u = decodeURIComponent(m[1]);
    return /^https?:\/\//i.test(u) ? u : null;
  } catch {
    return null;
  }
}

export interface ProfileContact {
  website: string | null; // best outbound company website found on the profile
  domain: string | null; // its registrable domain
  emails: string[]; // any emails found on the profile page
}

// Read a fetched profile page and pull out the company's real website + emails.
export function extractContactFromProfile(html: string, pageUrl: string): ProfileContact {
  const pageHost = hostOf(pageUrl);
  const websiteVotes = new Map<string, number>(); // full URL -> score

  const consider = (rawUrl: string | null, weight: number) => {
    if (!rawUrl) return;
    let host = "";
    try { host = hostOf(rawUrl); } catch { return; }
    if (!isRealSiteHost(host)) return;
    // Ignore links back to the same directory/profile domain.
    if (registrableDomain(host) === registrableDomain(pageHost)) return;
    let normalized = rawUrl;
    try { const u = new URL(rawUrl); normalized = `${u.protocol}//${u.host}/`; } catch {}
    websiteVotes.set(normalized, (websiteVotes.get(normalized) || 0) + weight);
  };

  // 1) Facebook outbound redirects — the strongest signal ("Website" link).
  let m: RegExpExecArray | null;
  const FB_L = /l\.facebook\.com\/l\.php\?u=[^"'\\ ]+/gi;
  while ((m = FB_L.exec(html))) consider(decodeFbRedirect(m[0]), 5);

  // 2) Structured "website" / "external_url" fields (Instagram, JSON blobs).
  const FIELD = /"(?:website|external_url|url)"\s*:\s*"([^"]+)"/gi;
  while ((m = FIELD.exec(html))) {
    let v = m[1].replace(/\\\//g, "/");
    consider(v, 4);
  }

  // 3) Any plain outbound anchor that points to a real (non-profile) host.
  for (const link of extractLinks(html, pageUrl)) consider(link, 1);

  // Pick the highest-voted website.
  let website: string | null = null;
  let bestScore = 0;
  for (const [url, score] of websiteVotes) {
    if (score > bestScore) { bestScore = score; website = url; }
  }
  const domain = website ? registrableDomain(hostOf(website)) : null;

  // Emails present directly on the profile page (mailto / text / obfuscated).
  const emails = [...new Set(extractEmails(html).map((h) => h.email))];

  return { website, domain, emails };
}
