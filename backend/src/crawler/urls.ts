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

// Common multi-part TLDs so "company.com.sa" resolves correctly.
const MULTI_TLD = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk",
  "com.au", "net.au", "org.au", "gov.au",
  "co.nz", "co.za", "co.in", "co.jp", "co.kr",
  "com.sa", "com.qa", "com.kw", "com.bh", "com.om", "com.eg", "com.jo", "com.lb",
  "com.sg", "com.my", "com.tr", "com.br", "com.mx", "com.ar", "com.hk", "com.tw",
]);

export function registrableDomain(host: string): string {
  const parts = (host || "").replace(/^www\./i, "").toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  const lastThree = parts.slice(-3).join(".");
  if (MULTI_TLD.has(lastTwo)) return lastThree;
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
