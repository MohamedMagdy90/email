// URL normalization, same-site checks, link discovery, and contact-page scoring.

export function normalizeSeed(input: string): string | null {
  let s = (input || "").trim();
  if (!s) return null;
  // strip common copy/paste noise
  s = s.replace(/^[<"']+|[>"']+$/g, "");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

// Explicit multi-part TLDs that are NOT covered by the generic rule below.
const MULTI_TLD = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "gov.au", "edu.au", "asn.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
]);

// Second-level labels that act as a public suffix under a 2-letter ccTLD:
// "gov.qa", "com.sa", "org.eg", "ac.ae", "edu.pk", "co.in", "gob.mx", "or.jp"…
// Without this, "tdv.motc.gov.qa" collapsed to "gov.qa" — so EVERY Qatari
// government site looked like the same company, and a directory's own address
// could never be told apart from a listing's.
const SECOND_LEVEL = new Set([
  "com", "co", "net", "org", "edu", "gov", "govt", "gob", "gouv", "mil", "ac",
  "or", "ne", "go", "sch", "info", "biz", "int", "nom", "web", "res", "ind", "firm", "gen",
]);

export function registrableDomain(host: string): string {
  const parts = (host || "").replace(/^www\./i, "").toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  const lastTwo = `${sld}.${tld}`;
  const lastThree = parts.slice(-3).join(".");
  if (MULTI_TLD.has(lastTwo)) return lastThree;
  // Generic: a known second-level label directly under a 2-letter country TLD is
  // part of the suffix, so the registrable name is one label further left.
  if (tld.length === 2 && SECOND_LEVEL.has(sld)) return lastThree;
  return lastTwo;
}

export function sameRegistrable(a: string, b: string): boolean {
  const da = registrableDomain(hostOf(a));
  const db = registrableDomain(hostOf(b));
  return !!da && da === db;
}

const CONTACT_HINTS = [
  "contact", "contact-us", "contactus", "contacto",
  "about", "about-us", "aboutus", "who-we-are",
  "team", "our-team", "people", "staff", "management",
  "company", "support", "help", "helpdesk",
  "imprint", "impressum", "legal-notice",
  "get-in-touch", "getintouch", "reach-us", "reach",
  "enquiry", "enquiries", "inquiry", "inquiries",
  "connect", "offices", "office", "location", "locations", "find-us",
];

// Higher score = more likely to contain emails; crawled first.
export function scoreLink(url: string): number {
  let score = 0;
  let path = "";
  try { path = new URL(url).pathname.toLowerCase(); } catch { return -100; }
  for (const h of CONTACT_HINTS) {
    if (path.includes(h)) { score += 12; break; }
  }
  // Prefer shallow pages.
  const depth = path.split("/").filter(Boolean).length;
  score -= depth;
  // Penalize obvious non-contact content.
  if (/\/(blog|news|article|product|shop|cart|category|tag|wp-|\.pdf)/.test(path)) score -= 8;
  return score;
}

export function extractLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  const re = /<a\b[^>]*?href\s*=\s*["']?([^"'\s>]+)["']?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = (m[1] || "").trim();
    if (!href) continue;
    if (
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("javascript:") ||
      href.startsWith("data:")
    )
      continue;
    try {
      const abs = new URL(href, baseUrl);
      abs.hash = "";
      if (abs.protocol === "http:" || abs.protocol === "https:") {
        links.add(abs.toString());
      }
    } catch {
      /* ignore malformed */
    }
  }
  return [...links];
}
