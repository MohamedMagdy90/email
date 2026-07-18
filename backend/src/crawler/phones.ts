// Phone-number extraction from raw HTML, with mobile-vs-fixed classification.
// Sources (in order of reliability):
//   1. tel: links (with anchor label → detect "fax")
//   2. WhatsApp links (wa.me / api.whatsapp / web.whatsapp)  → always mobile
//   3. JSON-LD "telephone" fields
//   4. Visible text near a phone label (mobile / tel / call / whatsapp / fax …)
// Every candidate is parsed with libphonenumber-js so we get a clean E.164
// number and a real "type" (mobile / fixed line) across all countries — not a
// brittle per-country regex. Mobile is preferred, fax is dropped.

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { decodeEntities } from "./extract";

export interface PhoneHit {
  number: string; // E.164, e.g. +97444324853
  formatted: string; // pretty international format
  type: "mobile" | "fixed" | "unknown";
  isMobile: boolean;
  source: "whatsapp" | "tel" | "jsonld" | "text";
  country?: string; // ISO2 region the number belongs to
}

// Country TLD → default region, so local-format numbers (no +CC) still parse.
const TLD_REGION: Record<string, CountryCode> = {
  qa: "QA", ae: "AE", sa: "SA", kw: "KW", bh: "BH", om: "OM", jo: "JO", lb: "LB",
  eg: "EG", ma: "MA", tn: "TN", dz: "DZ", ly: "LY", iq: "IQ", ps: "PS", ye: "YE",
  uk: "GB", gb: "GB", ie: "IE", de: "DE", fr: "FR", es: "ES", it: "IT", nl: "NL",
  be: "BE", ch: "CH", at: "AT", se: "SE", no: "NO", dk: "DK", fi: "FI", pl: "PL",
  pt: "PT", gr: "GR", cz: "CZ", ro: "RO", tr: "TR", ru: "RU", ua: "UA",
  us: "US", ca: "CA", mx: "MX", br: "BR", ar: "AR", cl: "CL", co: "CO",
  in: "IN", pk: "PK", bd: "BD", lk: "LK", np: "NP", cn: "CN", jp: "JP", kr: "KR",
  sg: "SG", my: "MY", id: "ID", th: "TH", ph: "PH", vn: "VN", hk: "HK", tw: "TW",
  au: "AU", nz: "NZ", za: "ZA", ng: "NG", ke: "KE", gh: "GH", tz: "TZ", ug: "UG",
};

// Common country names → region, for the optional user-supplied "country" hint.
const NAME_REGION: Record<string, CountryCode> = {
  qatar: "QA", "united arab emirates": "AE", uae: "AE", "saudi arabia": "SA",
  ksa: "SA", kuwait: "KW", bahrain: "BH", oman: "OM", jordan: "JO", lebanon: "LB",
  egypt: "EG", morocco: "MA", tunisia: "TN", algeria: "DZ", libya: "LY", iraq: "IQ",
  "united kingdom": "GB", uk: "GB", "great britain": "GB", ireland: "IE",
  germany: "DE", france: "FR", spain: "ES", italy: "IT", netherlands: "NL",
  belgium: "BE", switzerland: "CH", austria: "AT", sweden: "SE", norway: "NO",
  denmark: "DK", finland: "FI", poland: "PL", portugal: "PT", greece: "GR",
  turkey: "TR", "türkiye": "TR", russia: "RU", ukraine: "UA",
  "united states": "US", usa: "US", "united states of america": "US",
  canada: "CA", mexico: "MX", brazil: "BR", argentina: "AR", chile: "CL", colombia: "CO",
  india: "IN", pakistan: "PK", bangladesh: "BD", "sri lanka": "LK", nepal: "NP",
  china: "CN", japan: "JP", "south korea": "KR", singapore: "SG", malaysia: "MY",
  indonesia: "ID", thailand: "TH", philippines: "PH", vietnam: "VN",
  "hong kong": "HK", taiwan: "TW", australia: "AU", "new zealand": "NZ",
  "south africa": "ZA", nigeria: "NG", kenya: "KE", ghana: "GH",
};

export function regionFromCountryName(name?: string): CountryCode | undefined {
  if (!name) return undefined;
  return NAME_REGION[name.trim().toLowerCase()];
}

export function regionFromHostname(hostname?: string): CountryCode | undefined {
  if (!hostname) return undefined;
  const tld = hostname.toLowerCase().split(".").pop() || "";
  return TLD_REGION[tld];
}

// Words that mark a phone as a fax line (so we never store it as a phone).
const FAX_RE = /\bfax\b|télécopie|telefax/i;
// Words near a number that indicate it's a mobile/cell.
const MOBILE_LABEL_RE = /\b(mobile|mob|cell|cellular|whats\s?app|gsm|handy|portable|movil|móvil|جوال|موبايل|واتساب)\b/i;
// Words that mark a nearby number as a phone at all (used to gate noisy text).
const PHONE_LABEL_RE = /\b(mobile|mob|cell|cellular|whats\s?app|gsm|tel|telephone|téléphone|telefon|phone|call|contact|hotline|fax|هاتف|جوال|موبايل|تليفون|اتصل)\b|[☎📞📱]/i;

const rankType = (t: PhoneHit["type"]) => (t === "mobile" ? 0 : t === "unknown" ? 1 : 2);
const rankSource = (s: PhoneHit["source"]) => ({ whatsapp: 0, tel: 1, jsonld: 2, text: 3 }[s]);

function parse(raw: string, region: CountryCode | undefined) {
  try {
    const p = parsePhoneNumberFromString(raw, region);
    if (!p || !p.isValid()) return null;
    return p;
  } catch {
    return null;
  }
}

function classify(rawType: string | undefined): PhoneHit["type"] {
  if (rawType === "MOBILE") return "mobile";
  if (rawType === "FIXED_LINE") return "fixed";
  // FIXED_LINE_OR_MOBILE, VOIP, PERSONAL_NUMBER, or undefined → unknown (mobile-capable)
  return "unknown";
}

export function extractPhones(
  rawHtml: string,
  opts: { defaultCountry?: CountryCode; hostname?: string } = {}
): PhoneHit[] {
  const region = opts.defaultCountry || regionFromHostname(opts.hostname);
  const byNumber = new Map<string, PhoneHit>();

  const add = (raw: string, source: PhoneHit["source"], forceMobile: boolean) => {
    const p = parse(raw, region);
    if (!p) return;
    const number = p.number; // E.164
    let type = forceMobile ? "mobile" : classify(p.getType());
    if (forceMobile) type = "mobile";
    const isMobile = forceMobile || type === "mobile" || type === "unknown";
    const hit: PhoneHit = { number, formatted: p.formatInternational(), type, isMobile, source, country: p.country };
    const existing = byNumber.get(number);
    if (!existing) { byNumber.set(number, hit); return; }
    // Keep the most informative record for a number seen multiple ways.
    if (forceMobile && !existing.isMobile) { existing.type = "mobile"; existing.isMobile = true; }
    if (rankSource(source) < rankSource(existing.source)) existing.source = source;
    if (type === "mobile") { existing.type = "mobile"; existing.isMobile = true; }
  };

  const html = decodeEntities(rawHtml);

  // 1 + 2) Anchors with tel:/WhatsApp hrefs (label lets us skip fax lines).
  const A_RE = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let a: RegExpExecArray | null;
  while ((a = A_RE.exec(html))) {
    const href = a[1].trim();
    const label = a[2].replace(/<[^>]+>/g, " ").trim();
    const wa = href.match(/(?:wa\.me\/|whatsapp\.com\/send\?phone=|api\.whatsapp\.com\/send\?phone=|web\.whatsapp\.com\/send\?phone=)\+?([0-9]{6,15})/i);
    if (wa) { add("+" + wa[1], "whatsapp", true); continue; }
    const tel = href.match(/^tel:\s*(\+?[0-9().\-\s]{6,})/i);
    if (tel) {
      if (FAX_RE.test(label)) continue; // it's a fax link
      add(tel[1], "tel", MOBILE_LABEL_RE.test(label));
    }
  }

  // Bare tel:/WhatsApp not wrapped in a parseable anchor.
  let m: RegExpExecArray | null;
  const TEL_RE = /tel:\s*(\+?[0-9().\-\s]{6,})/gi;
  while ((m = TEL_RE.exec(html))) add(m[1], "tel", false);
  const WA_RE = /(?:wa\.me\/|whatsapp\.com\/send\?phone=|api\.whatsapp\.com\/send\?phone=)\+?([0-9]{6,15})/gi;
  while ((m = WA_RE.exec(html))) add("+" + m[1], "whatsapp", true);

  // 3) JSON-LD "telephone"
  const TEL_LD = /"(?:telephone|telePhone|phone)"\s*:\s*"([^"]+)"/gi;
  while ((m = TEL_LD.exec(html))) add(m[1], "jsonld", false);

  // 4) Visible text: strip tags, then scan for phone-like sequences that are
  //    either international (+…) or sit next to a phone label — keeps noise low.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ");
  const NUM_RE = /(\+?\d[\d().\-\s]{6,}\d)/g;
  while ((m = NUM_RE.exec(text))) {
    const raw = m[1];
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) continue;
    const ctx = text.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const isIntl = raw.trim().startsWith("+");
    if (!isIntl && !PHONE_LABEL_RE.test(ctx)) continue; // avoid prices/ids
    if (FAX_RE.test(ctx)) continue;
    add(raw, "text", MOBILE_LABEL_RE.test(ctx));
  }

  // Best first: mobile > unknown > fixed, then by source reliability.
  return [...byNumber.values()].sort(
    (x, y) => rankType(x.type) - rankType(y.type) || rankSource(x.source) - rankSource(y.source)
  );
}

// Pick the single best number for a contact: mobile if available, else any phone.
// Sorts a copy so it's safe on hits merged across several pages. When a
// `preferRegion` is given (e.g. the directory's country), numbers from that
// country win — this keeps a directory's own foreign support line from
// masquerading as the listing's local number.
export function bestPhone(hits: PhoneHit[], preferRegion?: CountryCode): PhoneHit | null {
  if (!hits.length) return null;
  const regionRank = (h: PhoneHit) => (preferRegion && h.country === preferRegion ? 0 : 1);
  return [...hits].sort(
    (x, y) =>
      regionRank(x) - regionRank(y) ||
      rankType(x.type) - rankType(y.type) ||
      rankSource(x.source) - rankSource(y.source)
  )[0];
}
