// The target check. Runs twice:
//   1. at discovery, on what the search result already says (domain ccTLD, city)
//   2. right after research, on the facts (country, city, industry, size,
//      keywords, language) — BEFORE the person search, scoring and writing
// A fail returns the rule that failed, so the Leads screen can group skips by
// rule ("38 outside the target country · 12 too small").
import { countryFromDomain, countryFromPhone, normalizeCity, normalizeCountry, cityInText } from "../../country";
import { classifyIndustry, INDUSTRY_BY_ID, isSenior, sizeFromText } from "./taxonomy";
import { sizeLabel, type EffectiveTargeting } from "./market";

type Row = Record<string, any>;

export type SkipRule = "country" | "city" | "industry" | "size" | "keyword" | "language";

export const SKIP_RULE_LABEL: Record<SkipRule, string> = {
  country: "Outside the target countries",
  city: "Outside the target cities",
  industry: "Excluded industry",
  size: "Wrong company size",
  keyword: "Website keywords",
  language: "Website language",
};

/** ok = in target. A fail carries the rule and the reason; a pass may carry a fit penalty + notes. */
export interface CheckResult {
  ok: boolean;
  penalty: number;
  notes: string[];
  rule?: SkipRule;
  reason?: string;
}

const pass = (penalty = 0, notes: string[] = []): CheckResult => ({ ok: true, penalty, notes });
const fail = (rule: SkipRule, reason: string): CheckResult => ({ ok: false, penalty: 0, notes: [], rule, reason: `Outside the target: ${reason}` });

function plain(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "");
}

function keywordIn(hay: string, kw: string): boolean {
  const k = plain(kw).trim();
  if (!k) return false;
  if (/^[\x00-\x7f]+$/.test(k)) return new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(hay);
  return hay.includes(k);
}

function placeCheck(country: string | null, city: string | null, eff: EffectiveTargeting, evidence: string): CheckResult | null {
  if (country && !eff.countries.includes(country)) return fail("country", `based in ${city ? `${city}, ` : ""}${country}${evidence}`);
  if (city && eff.excludeCities.includes(city)) return fail("city", `based in ${city}, which is excluded`);
  if (country && city) {
    const allowed = eff.cities[country];
    if (allowed?.length && !allowed.includes(city)) return fail("city", `based in ${city}, not in ${allowed.join(", ")}`);
  }
  return null;
}

/** Discovery: only what the search result tells us. Unknown is fine here — research decides. */
export function checkCandidate(cand: { domain: string; city?: string | null; country?: string | null }, eff: EffectiveTargeting): CheckResult {
  const tldCountry = countryFromDomain(cand.domain);
  const hinted = cand.city ? cityInText(cand.city) : null;
  const city = hinted?.city || null;
  const country = hinted?.country || tldCountry;
  const evidence = !hinted && tldCountry ? ` (its website ends in .${cand.domain.split(".").pop()})` : "";
  return placeCheck(country, city, eff, evidence) || pass();
}

export interface CompanyFacts {
  country: string | null;
  city: string | null;
  industryId: string | null;
  sizeBand: string | null;
  employees: number | null;
  branches: number | null;
}

/** Facts the check uses, from the company row (research columns + site text). */
export function companyFacts(co: Row): CompanyFacts {
  const text = `${co.description || ""}\n${co.site_text || ""}`;
  const country =
    normalizeCountry(co.country) ||
    countryFromDomain(co.domain) ||
    countryFromPhone(co.phone) ||
    (co.city ? cityInText(co.city)?.country || null : null);
  const city = co.city ? normalizeCity(co.city, country) : null;
  const size = sizeFromText(co.size_hint, text);
  const industryId =
    co.industry_id && INDUSTRY_BY_ID.has(co.industry_id)
      ? co.industry_id
      : classifyIndustry({ aiIndustry: co.industry, name: co.name, description: co.description, text: co.site_text }).id;
  return { country, city, industryId, sizeBand: co.size_band || size.band, employees: size.employees, branches: size.branches };
}

/** After research: the full check. `penalty` lowers the fit score for "prefer" rules. */
export function checkCompany(co: Row, eff: EffectiveTargeting): CheckResult {
  const f = companyFacts(co);
  const place = placeCheck(f.country, f.city, eff, "");
  if (place) return place;
  const notes: string[] = [];
  let penalty = 0;
  if (!f.country) notes.push("Country unknown");

  // Industry: the classification, plus the AI's own label against excluded industries.
  if (f.industryId && eff.excludeIndustries.includes(f.industryId)) {
    return fail("industry", `${INDUSTRY_BY_ID.get(f.industryId)?.label || f.industryId}${co.industry ? ` ("${String(co.industry).slice(0, 60)}")` : ""}`);
  }
  if (/\.gov(\.[a-z]{2})?$/.test(String(co.domain || "")) && eff.excludeIndustries.includes("government")) return fail("industry", "a government website");

  // Size.
  const bandOk = !f.sizeBand || !eff.sizeBands.length || eff.sizeBands.includes(f.sizeBand as never);
  const branchesOk = !eff.minBranches || f.branches == null || f.branches >= eff.minBranches;
  const sizeKnown = !!f.sizeBand || (eff.minBranches != null && f.branches != null);
  if (!bandOk || !branchesOk) {
    const what = !bandOk ? `about ${f.employees} staff` : `${f.branches} branch${f.branches === 1 ? "" : "es"}`;
    if (eff.sizeMode === "strict") return fail("size", `${what}, the target is ${sizeLabel(eff.sizeBands, eff.minBranches)}`);
    penalty += 15;
    notes.push(`Size ${what} is outside ${sizeLabel(eff.sizeBands, eff.minBranches)} (−15)`);
  } else if (!sizeKnown && eff.sizeUnknown === "skip") {
    return fail("size", "its size couldn't be worked out, and unknown sizes are set to be skipped");
  }

  // Keywords on the website.
  const hay = plain(`${co.name || ""} ${co.description || ""} ${co.industry || ""} ${co.site_text || ""}`);
  const bad = eff.mustNot.find((k) => keywordIn(hay, k));
  if (bad) return fail("keyword", `the website mentions "${bad}"`);
  if (eff.must.length && !eff.must.some((k) => keywordIn(hay, k))) {
    if (eff.mustMode === "strict") return fail("keyword", `the website doesn't mention ${eff.must.map((k) => `"${k}"`).join(" or ")}`);
    penalty += 10;
    notes.push(`Doesn't mention ${eff.must.join(" / ")} (−10)`);
  }

  // Website language.
  const lang = String(co.language || "");
  if (eff.language === "ar" && lang === "en") return fail("language", "the website is English only");
  if (eff.language === "en" && lang === "ar") return fail("language", "the website is Arabic only");

  return pass(penalty, notes);
}

/** Can this person be contacted under the targeting? */
export function personAllowed(title: string | null | undefined, eff: EffectiveTargeting): { ok: boolean; reason?: string } {
  const t = String(title || "");
  const lower = plain(t);
  const banned = eff.excludeTitles.find((x) => {
    const k = plain(x).trim();
    return k && (/^[\x00-\x7f]+$/.test(k) ? new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z])`).test(lower) : lower.includes(k));
  });
  if (banned) return { ok: false, reason: `"${t}" is on the never-contact titles (${banned})` };
  if (eff.seniority === "manager" && t && !isSenior(t)) return { ok: false, reason: `"${t}" is below manager level` };
  return { ok: true };
}
