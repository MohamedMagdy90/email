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

/* ------------------------------ cities ------------------------------ */
// Cities the targeting screen offers, per canonical country, with the Arabic
// spelling used in generated searches. Aliases catch common transliterations.

export interface City {
  name: string;
  ar: string;
  aliases?: string[];
}

export const GULF_COUNTRIES = ["Saudi Arabia", "United Arab Emirates", "Qatar", "Kuwait", "Bahrain", "Oman"];

/** Arabic country names for generated searches ("سلطنة عمان", never bare "عمان" — that's also Amman). */
export const COUNTRY_AR: Record<string, string> = {
  "Saudi Arabia": "السعودية",
  "United Arab Emirates": "الإمارات",
  Qatar: "قطر",
  Kuwait: "الكويت",
  Bahrain: "البحرين",
  Oman: "سلطنة عمان",
  Egypt: "مصر",
  Jordan: "الأردن",
  Iraq: "العراق",
  Lebanon: "لبنان",
};

export const CITIES: Record<string, City[]> = {
  "Saudi Arabia": [
    { name: "Riyadh", ar: "الرياض", aliases: ["ar riyadh", "al riyadh"] },
    { name: "Jeddah", ar: "جدة", aliases: ["jiddah", "jedda"] },
    { name: "Dammam", ar: "الدمام", aliases: ["ad dammam"] },
    { name: "Khobar", ar: "الخبر", aliases: ["al khobar", "al-khobar"] },
    { name: "Dhahran", ar: "الظهران" },
    { name: "Jubail", ar: "الجبيل", aliases: ["al jubail"] },
    { name: "Makkah", ar: "مكة", aliases: ["mecca", "makkah al mukarramah"] },
    { name: "Madinah", ar: "المدينة المنورة", aliases: ["medina", "al madinah"] },
    { name: "Taif", ar: "الطائف" },
    { name: "Al Ahsa", ar: "الأحساء", aliases: ["al hasa", "hofuf", "al hofuf"] },
    { name: "Buraidah", ar: "بريدة", aliases: ["qassim", "al qassim", "buraydah"] },
    { name: "Tabuk", ar: "تبوك" },
    { name: "Abha", ar: "أبها" },
    { name: "Khamis Mushait", ar: "خميس مشيط" },
    { name: "Hail", ar: "حائل", aliases: ["ha'il"] },
    { name: "Yanbu", ar: "ينبع" },
    { name: "Jazan", ar: "جازان", aliases: ["jizan"] },
    { name: "Najran", ar: "نجران" },
  ],
  "United Arab Emirates": [
    { name: "Dubai", ar: "دبي" },
    { name: "Abu Dhabi", ar: "أبوظبي", aliases: ["abudhabi"] },
    { name: "Sharjah", ar: "الشارقة" },
    { name: "Ajman", ar: "عجمان" },
    { name: "Ras Al Khaimah", ar: "رأس الخيمة", aliases: ["rak", "ras al-khaimah"] },
    { name: "Fujairah", ar: "الفجيرة" },
    { name: "Umm Al Quwain", ar: "أم القيوين" },
    { name: "Al Ain", ar: "العين" },
  ],
  Qatar: [
    { name: "Doha", ar: "الدوحة" },
    { name: "Al Rayyan", ar: "الريان", aliases: ["rayyan"] },
    { name: "Al Wakrah", ar: "الوكرة", aliases: ["wakrah"] },
    { name: "Lusail", ar: "لوسيل" },
    { name: "Al Khor", ar: "الخور" },
    { name: "Mesaieed", ar: "مسيعيد", aliases: ["mesaieed industrial city"] },
  ],
  Kuwait: [
    { name: "Kuwait City", ar: "مدينة الكويت" },
    { name: "Hawalli", ar: "حولي" },
    { name: "Salmiya", ar: "السالمية", aliases: ["salmiyah"] },
    { name: "Farwaniya", ar: "الفروانية", aliases: ["farwaniyah"] },
    { name: "Shuwaikh", ar: "الشويخ", aliases: ["shuwaikh industrial"] },
    { name: "Ahmadi", ar: "الأحمدي" },
    { name: "Jahra", ar: "الجهراء" },
  ],
  Bahrain: [
    { name: "Manama", ar: "المنامة" },
    { name: "Muharraq", ar: "المحرق" },
    { name: "Riffa", ar: "الرفاع" },
    { name: "Sitra", ar: "سترة" },
    { name: "Isa Town", ar: "مدينة عيسى" },
    { name: "Hamad Town", ar: "مدينة حمد" },
  ],
  Oman: [
    { name: "Muscat", ar: "مسقط" },
    { name: "Sohar", ar: "صحار" },
    { name: "Salalah", ar: "صلالة" },
    { name: "Nizwa", ar: "نزوى" },
    { name: "Duqm", ar: "الدقم" },
  ],
  Egypt: [
    { name: "Cairo", ar: "القاهرة" },
    { name: "Giza", ar: "الجيزة" },
    { name: "Alexandria", ar: "الإسكندرية" },
    { name: "New Cairo", ar: "القاهرة الجديدة" },
    { name: "6th of October", ar: "السادس من أكتوبر", aliases: ["6th october", "october city"] },
    { name: "10th of Ramadan", ar: "العاشر من رمضان", aliases: ["10th ramadan"] },
    { name: "Port Said", ar: "بورسعيد" },
    { name: "Mansoura", ar: "المنصورة" },
  ],
  Jordan: [
    { name: "Amman", ar: "عمّان" },
    { name: "Zarqa", ar: "الزرقاء" },
    { name: "Irbid", ar: "إربد" },
    { name: "Aqaba", ar: "العقبة" },
  ],
  Iraq: [
    { name: "Baghdad", ar: "بغداد" },
    { name: "Erbil", ar: "أربيل" },
    { name: "Basra", ar: "البصرة" },
  ],
  Lebanon: [{ name: "Beirut", ar: "بيروت" }],
};

/** Drop Arabic diacritics and tatweel so "عمّان" and "عمان" compare equal. */
function plainAr(s: string): string {
  return s.replace(/[\u064B-\u065F\u0670\u0640]/g, "");
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CITY_INDEX: { needle: string; latin: boolean; country: string; city: string }[] = (() => {
  const out: { needle: string; latin: boolean; country: string; city: string }[] = [];
  for (const [country, list] of Object.entries(CITIES)) {
    for (const c of list) {
      for (const n of [c.name, ...(c.aliases || [])]) out.push({ needle: n.toLowerCase(), latin: true, country, city: c.name });
      out.push({ needle: plainAr(c.ar), latin: false, country, city: c.name });
    }
  }
  return out.sort((a, b) => b.needle.length - a.needle.length); // "new cairo" before "cairo"
})();

function hasNeedle(hay: string, needle: string, latin: boolean): boolean {
  if (!latin) return hay.includes(needle);
  return new RegExp(`(^|[^a-z0-9])${escapeRe(needle)}($|[^a-z0-9])`).test(hay);
}

/** A country named in free text (English or Arabic), or null. */
export function countryInText(text: string): string | null {
  const lower = String(text || "").toLowerCase();
  const ar = plainAr(String(text || ""));
  for (const [name, arName] of Object.entries(COUNTRY_AR)) {
    if (ar.includes(plainAr(arName))) return name;
  }
  for (const [needle, iso] of NAME_TO_ISO) {
    if (needle.length < 3) continue; // "qa", "ae"… are too short to search text for
    if (hasNeedle(lower, needle, true)) return COUNTRY_NAME[iso];
  }
  return null;
}

/** The first known city named in free text, with its country. */
export function cityInText(text: string): { city: string; country: string } | null {
  const lower = String(text || "").toLowerCase();
  const ar = plainAr(String(text || ""));
  for (const e of CITY_INDEX) {
    if (hasNeedle(e.latin ? lower : ar, e.needle, e.latin)) return { city: e.city, country: e.country };
  }
  return null;
}

/** Canonical city name for what research or a search result says ("Al Khobar" -> "Khobar"). */
export function normalizeCity(input?: string | null, country?: string | null): string | null {
  const hit = cityInText(String(input || ""));
  if (!hit) return null;
  if (country && normalizeCountry(country) && normalizeCountry(country) !== hit.country) return null;
  return hit.city;
}

function hostOfUrl(url?: string | null): string | null {
  const u = String(url || "").trim();
  if (!u) return null;
  try { return new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).hostname; } catch { return null; }
}
