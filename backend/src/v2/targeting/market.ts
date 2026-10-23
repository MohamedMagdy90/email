// Target market (one per campaign, campaigns.targeting_json) and the segment
// targeting fields that narrow it. `effectiveTargeting()` merges the two into
// the rules every pipeline step uses; `generateQueries()` turns them into the
// searches discovery walks.
import { parseJson } from "../events";
import { CITIES, COUNTRY_AR, GULF_COUNTRIES, cityInText, countryInText, normalizeCity, normalizeCountry } from "../../country";
import {
  DEFAULT_EXCLUDED_TITLES,
  INDUSTRY_BY_ID,
  SIZE_BANDS,
  TITLE_PRESETS,
  defaultExcludedIndustries,
  type SizeBand,
} from "./taxonomy";

type Row = Record<string, any>;
export type Kind = "customer" | "partner";

export interface TargetMarket {
  countries: string[];
  /** country -> allowed cities; missing or [] = the whole country */
  cities: Record<string, string[]>;
  excludeCities: string[];
  sizeBands: SizeBand[];
  minBranches: number | null;
  sizeMode: "prefer" | "strict";
  sizeUnknown: "allow" | "skip";
  excludeIndustries: string[];
  mustKeywords: string[];
  mustNotKeywords: string[];
  mustMode: "prefer" | "strict";
  language: "any" | "ar" | "en";
  titles: string[];
  excludeTitles: string[];
  seniority: "any" | "manager";
  roleAddresses: "inherit" | "allow" | "never";
  minFitScore: number | null;
}

export function defaultMarket(kind: Kind): TargetMarket {
  return {
    countries: [...GULF_COUNTRIES],
    cities: {},
    excludeCities: [],
    sizeBands: ["11-50", "51-200", "201-500"],
    minBranches: null,
    sizeMode: "prefer",
    sizeUnknown: "allow",
    excludeIndustries: defaultExcludedIndustries(kind),
    mustKeywords: [],
    mustNotKeywords: [],
    mustMode: "prefer",
    language: "any",
    titles: [...TITLE_PRESETS[kind]],
    excludeTitles: [...DEFAULT_EXCLUDED_TITLES],
    seniority: "manager",
    roleAddresses: "inherit",
    minFitScore: null,
  };
}

const strs = (v: unknown, max = 40, len = 80): string[] => {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\n|,/) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    const s = typeof x === "string" ? x.trim().slice(0, len) : "";
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
};

export function normCountries(v: unknown): string[] {
  const out: string[] = [];
  for (const c of strs(v, 30, 60)) {
    const n = normalizeCountry(c) || c;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function normCities(v: unknown, countries: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const src = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  for (const [k, list] of Object.entries(src)) {
    const country = normalizeCountry(k) || k;
    if (!countries.includes(country)) continue;
    const cities: string[] = [];
    for (const c of strs(list, 30, 60)) {
      const n = normalizeCity(c, country) || c;
      if (!cities.includes(n)) cities.push(n);
    }
    if (cities.length) out[country] = cities;
  }
  return out;
}

const bands = (v: unknown): SizeBand[] => (Array.isArray(v) ? SIZE_BANDS.filter((b) => v.includes(b)) : []);

export function sanitizeMarket(raw: any, base: TargetMarket): TargetMarket {
  const m = raw && typeof raw === "object" ? raw : {};
  const countries = m.countries !== undefined ? normCountries(m.countries) : base.countries;
  const minFit = m.minFitScore === undefined ? base.minFitScore : m.minFitScore === null || m.minFitScore === "" ? null : Math.max(0, Math.min(100, Math.round(Number(m.minFitScore)) || 0));
  const minBranches = m.minBranches === undefined ? base.minBranches : m.minBranches === null || m.minBranches === "" || !(Number(m.minBranches) > 0) ? null : Math.min(1000, Math.round(Number(m.minBranches)));
  return {
    countries: countries.length ? countries : base.countries.length ? base.countries : [...GULF_COUNTRIES],
    cities: m.cities !== undefined ? normCities(m.cities, countries) : normCities(base.cities, countries),
    excludeCities: m.excludeCities !== undefined ? strs(m.excludeCities, 40, 60).map((c) => normalizeCity(c) || c) : base.excludeCities,
    sizeBands: m.sizeBands !== undefined ? bands(m.sizeBands) : base.sizeBands,
    minBranches,
    sizeMode: m.sizeMode === "strict" || m.sizeMode === "prefer" ? m.sizeMode : base.sizeMode,
    sizeUnknown: m.sizeUnknown === "skip" || m.sizeUnknown === "allow" ? m.sizeUnknown : base.sizeUnknown,
    excludeIndustries: m.excludeIndustries !== undefined ? strs(m.excludeIndustries, 40, 60).filter((id) => INDUSTRY_BY_ID.has(id)) : base.excludeIndustries,
    mustKeywords: m.mustKeywords !== undefined ? strs(m.mustKeywords, 20, 60) : base.mustKeywords,
    mustNotKeywords: m.mustNotKeywords !== undefined ? strs(m.mustNotKeywords, 30, 60) : base.mustNotKeywords,
    mustMode: m.mustMode === "strict" || m.mustMode === "prefer" ? m.mustMode : base.mustMode,
    language: ["any", "ar", "en"].includes(m.language) ? m.language : base.language,
    titles: m.titles !== undefined ? strs(m.titles, 15, 80) : base.titles,
    excludeTitles: m.excludeTitles !== undefined ? strs(m.excludeTitles, 30, 60) : base.excludeTitles,
    seniority: m.seniority === "any" || m.seniority === "manager" ? m.seniority : base.seniority,
    roleAddresses: ["inherit", "allow", "never"].includes(m.roleAddresses) ? m.roleAddresses : base.roleAddresses,
    minFitScore: minFit,
  };
}

export function marketOf(c: Row): TargetMarket {
  const kind: Kind = c.kind === "partner" ? "partner" : "customer";
  const raw = parseJson<any>(c.targeting_json, null);
  return raw ? sanitizeMarket(raw, defaultMarket(kind)) : defaultMarket(kind);
}

/* ----------------------------- segment fields ---------------------------- */

export interface SegmentTargeting {
  industryIds: string[];
  /** narrow the market's countries; [] = all of them */
  countries: string[];
  /** country -> cities, narrows the market's cities */
  cities: Record<string, string[]>;
  /** null = the market's size */
  sizeBands: SizeBand[] | null;
  minBranches: number | null;
  titlesOverride: boolean;
  titles: string[];
  signals: { must: string[]; mustNot: string[] };
  queriesAuto: boolean;
}

export function segmentTargeting(r: Row): SegmentTargeting {
  const size = parseJson<any>(r.size_json, null);
  const signals = parseJson<any>(r.signals_json, {}) || {};
  return {
    industryIds: parseJson<string[]>(r.industry_ids_json, []).filter((id) => INDUSTRY_BY_ID.has(id)),
    countries: parseJson<string[]>(r.countries_json, []),
    cities: parseJson<Record<string, string[]>>(r.cities_json, {}) || {},
    sizeBands: size && Array.isArray(size.bands) ? bands(size.bands) : null,
    minBranches: size && Number(size.minBranches) > 0 ? Number(size.minBranches) : null,
    titlesOverride: Number(r.titles_override) === 1,
    titles: parseJson<string[]>(r.titles_json, []),
    signals: { must: strs(signals.must, 20, 60), mustNot: strs(signals.mustNot, 20, 60) },
    queriesAuto: Number(r.queries_auto) === 1,
  };
}

/** Sanitize the structured fields of a segment input (only those present). */
export function sanitizeSegmentTargeting(s: any): Partial<SegmentTargeting> {
  const out: Partial<SegmentTargeting> = {};
  if (!s || typeof s !== "object") return out;
  if (s.industryIds !== undefined) out.industryIds = strs(s.industryIds, 12, 60).filter((id) => INDUSTRY_BY_ID.has(id));
  if (s.cities !== undefined) {
    const countries = Object.keys(s.cities && typeof s.cities === "object" ? s.cities : {}).map((k) => normalizeCountry(k) || k);
    out.cities = normCities(s.cities, countries);
  }
  if (s.sizeBands !== undefined) out.sizeBands = s.sizeBands === null ? null : bands(s.sizeBands);
  if (s.minBranches !== undefined) out.minBranches = Number(s.minBranches) > 0 ? Math.min(1000, Math.round(Number(s.minBranches))) : null;
  if (s.titlesOverride !== undefined) out.titlesOverride = !!s.titlesOverride;
  if (s.signals !== undefined) out.signals = { must: strs(s.signals?.must, 20, 60), mustNot: strs(s.signals?.mustNot, 20, 60) };
  if (s.queriesAuto !== undefined) out.queriesAuto = !!s.queriesAuto;
  return out;
}

/* ------------------------------- effective ------------------------------ */

export interface EffectiveTargeting {
  kind: Kind;
  countries: string[];
  cities: Record<string, string[]>;
  excludeCities: string[];
  sizeBands: SizeBand[];
  minBranches: number | null;
  sizeMode: "prefer" | "strict";
  sizeUnknown: "allow" | "skip";
  excludeIndustries: string[];
  must: string[];
  mustNot: string[];
  mustMode: "prefer" | "strict";
  language: "any" | "ar" | "en";
  titles: string[];
  excludeTitles: string[];
  seniority: "any" | "manager";
  roleAddresses: "inherit" | "allow" | "never";
  minFitScore: number | null;
  industryIds: string[];
  customIndustries: string[];
}

/** The rules for one segment: the market, narrowed by the segment. `seg` may be null (manual adds without a segment). */
export function effectiveTargeting(market: TargetMarket, kind: Kind, seg: Row | null): EffectiveTargeting {
  const st = seg ? segmentTargeting(seg) : null;
  const segCountries = st ? normCountries(st.countries).filter((c) => market.countries.includes(c)) : [];
  const countries = segCountries.length ? segCountries : market.countries;
  const cities: Record<string, string[]> = {};
  for (const c of countries) {
    const narrowed = st?.cities?.[c]?.length ? st.cities[c] : null;
    const allowed = market.cities[c]?.length ? market.cities[c] : null;
    const list = narrowed && allowed ? narrowed.filter((x) => allowed.includes(x)) : narrowed || allowed;
    if (list?.length) cities[c] = list;
  }
  const industryIds = st?.industryIds || [];
  const customIndustries = seg ? parseJson<string[]>(seg.industries_json, []).filter((label) => !INDUSTRIES_LABELS.has(label.toLowerCase())) : [];
  return {
    kind,
    countries,
    cities,
    excludeCities: market.excludeCities,
    sizeBands: st?.sizeBands?.length ? st.sizeBands : market.sizeBands,
    minBranches: st?.minBranches ?? market.minBranches,
    sizeMode: market.sizeMode,
    sizeUnknown: market.sizeUnknown,
    excludeIndustries: market.excludeIndustries.filter((id) => !industryIds.includes(id)),
    must: [...new Set([...market.mustKeywords, ...(st?.signals.must || [])])],
    mustNot: [...new Set([...market.mustNotKeywords, ...(st?.signals.mustNot || [])])],
    mustMode: market.mustMode,
    language: market.language,
    titles: st?.titlesOverride && st.titles.length ? st.titles : market.titles,
    excludeTitles: market.excludeTitles,
    seniority: market.seniority,
    roleAddresses: market.roleAddresses,
    minFitScore: market.minFitScore,
    industryIds,
    customIndustries,
  };
}

const INDUSTRIES_LABELS = new Set([...INDUSTRY_BY_ID.values()].map((i) => i.label.toLowerCase()));

/* -------------------------------- queries ------------------------------- */

const MAX_QUERIES = 40;
/** When a country has no cities picked, search its biggest business cities. */
const CITIES_PER_COUNTRY = 3;

export function locationsFor(eff: EffectiveTargeting): { country: string; en: string; ar: string }[] {
  const out: { country: string; en: string; ar: string }[] = [];
  for (const country of eff.countries) {
    const known = CITIES[country] || [];
    const picked = eff.cities[country]?.length ? eff.cities[country] : known.slice(0, CITIES_PER_COUNTRY).map((c) => c.name);
    const usable = picked.filter((c) => !eff.excludeCities.includes(c));
    if (!usable.length) {
      out.push({ country, en: country, ar: COUNTRY_AR[country] || "" });
      continue;
    }
    for (const name of usable) {
      const city = known.find((c) => c.name === name);
      out.push({ country, en: name, ar: city?.ar || "" });
    }
  }
  return out;
}

/**
 * Searches for a segment: every industry phrase x every location, interleaved
 * so the first searches already cover different industries and cities. The
 * best English phrase comes first, then the Arabic one, then the second English one.
 */
export function generateQueries(eff: EffectiveTargeting): string[] {
  const phrases: { en: string[]; ar: string[] }[] = eff.industryIds
    .map((id) => INDUSTRY_BY_ID.get(id))
    .filter((i): i is NonNullable<typeof i> => !!i && i.en.length > 0)
    .map((i) => ({ en: i.en, ar: i.ar }));
  for (const label of eff.customIndustries) phrases.push({ en: [/company|firm|factory|store|group/i.test(label) ? label : `${label} company`], ar: [] });
  if (!phrases.length) return [];
  const locs = locationsFor(eff);
  const tiers: string[][] = [];
  const tier = (pick: (p: { en: string[]; ar: string[] }) => string | undefined, arabic: boolean) => {
    const list: string[] = [];
    for (const loc of locs) {
      for (const p of phrases) {
        const phrase = pick(p);
        const place = arabic ? loc.ar : loc.en;
        if (phrase && place) list.push(`${phrase} ${place}`);
      }
    }
    tiers.push(list);
  };
  tier((p) => p.en[0], false);
  tier((p) => p.ar[0], true);
  tier((p) => p.en[1], false);
  const out: string[] = [];
  for (const list of tiers) for (const q of list) if (!out.includes(q) && out.length < MAX_QUERIES) out.push(q);
  return out;
}

/**
 * The (query, country) steps discovery walks. A query that names a place
 * ("food distributor Riyadh", "... الدوحة") runs once, for that place's country;
 * one without a place runs once per target country.
 */
export function planFor(queries: string[], countries: string[]): { query: string; country: string }[] {
  const plan: { query: string; country: string }[] = [];
  for (const query of queries) {
    const named = countryInText(query) || cityInText(query)?.country || null;
    if (named || !countries.length) plan.push({ query, country: named || "" });
    else for (const country of countries) plan.push({ query, country });
  }
  return plan;
}

export const planKey = (p: { query: string; country: string }) => `${p.query}|${p.country}`;

/** "11-50 or 51-200 employees" for prompts and segment cards. */
export function sizeLabel(bandsList: SizeBand[], minBranches: number | null): string {
  const b = bandsList.length && bandsList.length < SIZE_BANDS.length ? `${bandsList.join(", ")} employees` : "any size";
  return minBranches ? `${b}, at least ${minBranches} branches` : b;
}

/** The targeting, in words, for the fit-score prompt. */
export function describeTargeting(eff: EffectiveTargeting): string {
  const where = eff.countries.map((c) => (eff.cities[c]?.length ? `${c} (${eff.cities[c].join(", ")})` : c)).join("; ");
  const inds = [...eff.industryIds.map((id) => INDUSTRY_BY_ID.get(id)?.label || id), ...eff.customIndustries];
  return [
    `Where: ${where}${eff.excludeCities.length ? `; not in ${eff.excludeCities.join(", ")}` : ""}.`,
    inds.length ? `Industries: ${inds.join(", ")}.` : "",
    `Size: ${sizeLabel(eff.sizeBands, eff.minBranches)}.`,
    eff.excludeIndustries.length ? `Never: ${eff.excludeIndustries.map((id) => INDUSTRY_BY_ID.get(id)?.label || id).join(", ")}.` : "",
    eff.must.length ? `Should mention: ${eff.must.join(", ")}.` : "",
    eff.mustNot.length ? `Must not be: ${eff.mustNot.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
