// One canonical country per lead.
//
// A lead's country arrives from three very different places — what you typed on
// the source ("Qatar", "Amman, Jordan", or nothing at all), the domain it was
// found on (.jo), and its phone number (+962) — so it has to be normalised to a
// single spelling before it can be shown in a column, filtered on, or carried
// into Contacts. Everything here is deliberately dependency-light and shared by
// the worker (at insert time) and the API (for filtering and back-filling).

import { getCountryCallingCode, type CountryCode } from "libphonenumber-js";

// ISO2 → the one spelling we store. Anything the user types is mapped onto one
// of these so "UAE", "united arab emirates" and "Dubai, UAE" all agree.
export const COUNTRY_NAME: Record<string, string> = {
  QA: "Qatar", AE: "United Arab Emirates", SA: "Saudi Arabia", KW: "Kuwait",
  BH: "Bahrain", OM: "Oman", JO: "Jordan", LB: "Lebanon", SY: "Syria",
  EG: "Egypt", MA: "Morocco", TN: "Tunisia", DZ: "Algeria", LY: "Libya",
  IQ: "Iraq", PS: "Palestine", YE: "Yemen", SD: "Sudan",
  GB: "United Kingdom", IE: "Ireland", DE: "Germany", FR: "France",
  ES: "Spain", IT: "Italy", NL: "Netherlands", BE: "Belgium", CH: "Switzerland",
  AT: "Austria", SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland",
  PL: "Poland", PT: "Portugal", GR: "Greece", CZ: "Czechia", RO: "Romania",
  TR: "Türkiye", RU: "Russia", UA: "Ukraine", CY: "Cyprus", MT: "Malta",
  US: "United States", CA: "Canada", MX: "Mexico", BR: "Brazil",
  AR: "Argentina", CL: "Chile", CO: "Colombia",
  IN: "India", PK: "Pakistan", BD: "Bangladesh", LK: "Sri Lanka", NP: "Nepal",
  CN: "China", JP: "Japan", KR: "South Korea", SG: "Singapore", MY: "Malaysia",
  ID: "Indonesia", TH: "Thailand", PH: "Philippines", VN: "Vietnam",
  HK: "Hong Kong", TW: "Taiwan", AU: "Australia", NZ: "New Zealand",
  ZA: "South Africa", NG: "Nigeria", KE: "Kenya", GH: "Ghana", TZ: "Tanzania",
  UG: "Uganda", ET: "Ethiopia",
};

// Everything a human might type (or a geocoder might return) → ISO2.
const ALIAS: Record<string, string> = {
  uae: "AE", "u.a.e": "AE", emirates: "AE", "united arab emirates": "AE",
  ksa: "SA", "kingdom of saudi arabia": "SA", "saudi": "SA",
  uk: "GB", "great britain": "GB", britain: "GB", england: "GB",
  scotland: "GB", wales: "GB", "northern ireland": "GB",
  usa: "US", "u.s.a": "US", "u.s": "US", america: "US",
  "united states of america": "US", turkey: "TR", türkiye: "TR", turkiye: "TR",
  "czech republic": "CZ", holland: "NL", "the netherlands": "NL",
  "republic of ireland": "IE", "south korea": "KR", "republic of korea": "KR",
  "hong kong sar": "HK", "state of qatar": "QA",
  "hashemite kingdom of jordan": "JO", "arab republic of egypt": "EG",
};

// Build the lookup once: canonical names + aliases, all lower-cased.
const NAME_TO_ISO = new Map<string, string>();
for (const [iso, name] of Object.entries(COUNTRY_NAME)) {
  NAME_TO_ISO.set(name.toLowerCase(), iso);
  NAME_TO_ISO.set(iso.toLowerCase(), iso);
}
for (const [alias, iso] of Object.entries(ALIAS)) NAME_TO_ISO.set(alias, iso);

// Country-code TLD → ISO2. Only ccTLDs that reliably mean "based there".
export const TLD_ISO: Record<string, string> = {
  qa: "QA", ae: "AE", sa: "SA", kw: "KW", bh: "BH", om: "OM", jo: "JO",
  lb: "LB", sy: "SY", eg: "EG", ma: "MA", tn: "TN", dz: "DZ", ly: "LY",
  iq: "IQ", ps: "PS", ye: "YE", sd: "SD", uk: "GB", ie: "IE", de: "DE",
  fr: "FR", es: "ES", it: "IT", nl: "NL", be: "BE", ch: "CH", at: "AT",
  se: "SE", no: "NO", dk: "DK", fi: "FI", pl: "PL", pt: "PT", gr: "GR",
  cz: "CZ", ro: "RO", tr: "TR", ru: "RU", ua: "UA", cy: "CY", mt: "MT",
  ca: "CA", mx: "MX", br: "BR", ar: "AR", cl: "CL", in: "IN",
  pk: "PK", bd: "BD", lk: "LK", np: "NP", cn: "CN", jp: "JP", kr: "KR",
  sg: "SG", my: "MY", id: "ID", th: "TH", ph: "PH", vn: "VN", hk: "HK",
  tw: "TW", au: "AU", nz: "NZ", za: "ZA", ng: "NG", ke: "KE", gh: "GH",
  tz: "TZ", ug: "UG", et: "ET",
};

// "+962" → "JO". Longest prefix wins so +1 (US) never shadows +1868.
const DIAL_ISO: [string, string][] = (() => {
  const out: [string, string][] = [];
  for (const iso of Object.keys(COUNTRY_NAME)) {
    try { out.push(["+" + getCountryCalling(iso), iso]); } catch { /* skip */ }
  }
  return out.filter(([d]) => d.length > 1).sort((a, b) => b[0].length - a[0].length);
})();
function getCountryCalling(iso: string): string {
  return getCountryCallingCode(iso as CountryCode);
}

/** The canonical name for an ISO2 code, or null. */
export function nameOfIso(iso?: string | null): string | null {
  if (!iso) return null;
  return COUNTRY_NAME[iso.toUpperCase()] || null;
}

/**
 * Turn anything a human (or a geocoder) wrote into one canonical country name.
 * Handles "jordan", "JO", "Amman, Amman Governorate, Jordan" and "Dubai, UAE"
 * by trying each comma-separated part from the right — the country is
 * conventionally last in an address.
 */
export function normalizeCountry(input?: string | null): string | null {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean).reverse();
  for (const part of [...parts, raw]) {
    const iso = NAME_TO_ISO.get(part.toLowerCase());
    if (iso) return COUNTRY_NAME[iso];
  }
  return null;
}

/** Country implied by a domain's ccTLD (".com.jo" and ".jo" both → Jordan). */
export function countryFromDomain(domain?: string | null): string | null {
  const host = String(domain || "").trim().toLowerCase();
  if (!host) return null;
  const tld = host.split(".").pop() || "";
  return nameOfIso(TLD_ISO[tld]);
}

/** Country implied by an international dialling code (+962… → Jordan). */
export function countryFromPhone(phone?: string | null): string | null {
  const raw = String(phone || "").replace(/[^\d+]/g, "");
  if (!raw.startsWith("+")) return null;
  for (const [dial, iso] of DIAL_ISO) if (raw.startsWith(dial)) return nameOfIso(iso);
  return null;
}

/**
 * The country to file a lead under, best evidence first:
 *   1. what the source says (you told us where you were looking)
 *   2. the domain's ccTLD
 *   3. the phone's dialling code
 * Returns null only when nothing at all points to a country.
 */
export function resolveLeadCountry(opts: {
  sourceCountry?: string | null;
  domain?: string | null;
  website?: string | null;
  phone?: string | null;
}): string | null {
  return (
    normalizeCountry(opts.sourceCountry) ||
    countryFromDomain(opts.domain || hostOfUrl(opts.website)) ||
    countryFromPhone(opts.phone) ||
    // Nothing canonical matched, but the source said *something* — keep it
    // rather than losing the only hint we have (e.g. a country we don't list).
    (String(opts.sourceCountry || "").trim() || null)
  );
}

function hostOfUrl(url?: string | null): string | null {
  const u = String(url || "").trim();
  if (!u) return null;
  try { return new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).hostname; } catch { return null; }
}
