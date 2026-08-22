// Where a search is looking — the one copy.
//
// Both halves of the pipeline need the same answer to "what counts as being in
// this country": `discovery.ts` to BUILD the queries (fan a country out into its
// cities, append `site:.qa`) and `search.ts` to CHECK them (does this result
// actually look like it is in the place we asked for?).
//
// They used to be one-directional — search knew nothing about places, and simply
// trusted whatever the engine returned. That is the bug this module exists to
// close, and putting the data here rather than in `discovery.ts` is what lets
// `search.ts` use it without importing the module that imports it.
/** Major cities per country, so a country-wide search fans out into local ones. */
export const COUNTRY_CITIES: Record<string, string[]> = {
  "saudi arabia": ["Riyadh", "Jeddah", "Dammam", "Mecca", "Medina", "Al Khobar", "Dhahran", "Jubail", "Yanbu", "Tabuk", "Abha", "Taif", "Buraidah", "Hail", "Najran", "Jizan"],
  "united arab emirates": ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Al Ain", "Ras Al Khaimah", "Fujairah", "Umm Al Quwain"],
  qatar: ["Doha", "Al Rayyan", "Al Wakrah", "Al Khor", "Lusail", "Umm Salal"],
  kuwait: ["Kuwait City", "Hawalli", "Salmiya", "Al Ahmadi", "Al Jahra", "Farwaniya"],
  bahrain: ["Manama", "Riffa", "Muharraq", "Hamad Town", "Isa Town", "Sitra"],
  oman: ["Muscat", "Salalah", "Sohar", "Sur", "Nizwa", "Seeb"],
  egypt: ["Cairo", "Alexandria", "Giza", "Port Said", "Suez", "Mansoura", "Tanta"],
  jordan: ["Amman", "Zarqa", "Irbid", "Aqaba", "Russeifa"],
  lebanon: ["Beirut", "Tripoli", "Sidon", "Tyre", "Zahle"],
  iraq: ["Baghdad", "Basra", "Erbil", "Mosul", "Najaf", "Karbala"],
  india: ["Mumbai", "Delhi", "Bangalore", "Chennai", "Hyderabad", "Pune", "Ahmedabad", "Kolkata"],
  pakistan: ["Karachi", "Lahore", "Islamabad", "Faisalabad", "Rawalpindi"],
  turkey: ["Istanbul", "Ankara", "Izmir", "Bursa", "Antalya"],
};
/** Country name synonyms so "KSA"/"UAE" map to the right city list. */
export const COUNTRY_ALIASES: Record<string, string> = {
  ksa: "saudi arabia",
  uae: "united arab emirates",
  emirates: "united arab emirates",
  "u.a.e": "united arab emirates",
  "u.a.e.": "united arab emirates",
  "kingdom of saudi arabia": "saudi arabia",
  saudi: "saudi arabia",
  "state of qatar": "qatar",
  türkiye: "turkey",
  turkiye: "turkey",
};
/**
 * Country-code top-level domains. A `site:.qa` query returns Qatari domains and
 * nothing else — the highest-precision slice of the web there is for a country,
 * and immune to the homonym problem entirely.
 */
export const COUNTRY_TLD: Record<string, string> = {
  "saudi arabia": "sa",
  "united arab emirates": "ae",
  qatar: "qa",
  kuwait: "kw",
  bahrain: "bh",
  oman: "om",
  egypt: "eg",
  jordan: "jo",
  lebanon: "lb",
  iraq: "iq",
  india: "in",
  pakistan: "pk",
  turkey: "tr",
};
/** Other words that mean "this page is about that country". */
const COUNTRY_ADJECTIVES: Record<string, string[]> = {
  "saudi arabia": ["saudi", "ksa", "saudia", "المملكة", "السعودية"],
  "united arab emirates": ["uae", "emirates", "emirati", "الإمارات"],
  qatar: ["qatari", "قطر"],
  kuwait: ["kuwaiti", "الكويت"],
  bahrain: ["bahraini", "البحرين"],
  oman: ["omani", "sultanate", "عمان"],
  egypt: ["egyptian", "مصر"],
  jordan: ["jordanian", "الأردن"],
  lebanon: ["lebanese", "لبنان"],
  iraq: ["iraqi", "العراق"],
  india: ["indian", "bharat"],
  pakistan: ["pakistani"],
  turkey: ["turkish", "türkiye", "turkiye"],
};
/** Lower-cased, alias-resolved country key ("KSA" → "saudi arabia"). */
export function normCountry(location: string): string {
  const k = (location || "").trim().toLowerCase().replace(/\.$/, "");
  return COUNTRY_ALIASES[k] || k;
}
/**
 * Cities to fan out into for a location. Only expand when the location is a
 * whole country we know; if the user gave a single city we search just that.
 */
export function citiesFor(location: string): string[] {
  const key = normCountry(location);
  const cities = COUNTRY_CITIES[key];
  if (!cities) return [];
  // If they typed one of the cities as the "country", don't fan out.
  if (cities.some((c) => c.toLowerCase() === (location || "").trim().toLowerCase())) return [];
  return cities;
}
/** The ccTLD for a location, or null. Also resolves a bare city to its country. */
export function tldFor(location: string): string | null {
  const key = normCountry(location);
  if (COUNTRY_TLD[key]) return COUNTRY_TLD[key];
  // "Doha" on its own still means Qatar.
  for (const [country, cities] of Object.entries(COUNTRY_CITIES)) {
    if (cities.some((c) => c.toLowerCase() === key)) return COUNTRY_TLD[country] || null;
  }
  return null;
}
/**
 * City names that are also ordinary English words, or well-known places
 * somewhere else. They are perfectly good in a QUERY — "steel fabrication Hail
 * Saudi Arabia" is unambiguous because the country rides along — but they are
 * useless as EVIDENCE, because a Texas roof repairer talking about hail damage,
 * a tyre dealer, and a contractor in Medina, Ohio would all read as Gulf firms.
 *
 * The country name and its adjectives still cover these cities: a real firm in
 * Hail says "Saudi Arabia" or sits on `.sa` somewhere in its title, snippet or
 * domain.
 */
const AMBIGUOUS_EVIDENCE = new Set(["hail", "sur", "medina", "mecca", "tyre", "tripoli", "alexandria"]);
/**
 * Every word that, appearing in a result, is evidence it belongs to this place:
 * the country, its aliases and adjectives, and all of its cities.
 *
 * Used as a *positive* signal only. A result missing all of them is not proven
 * foreign — but it is unproven, and after the Bing incident unproven is the
 * side of the line where "chemistrylearner.com" lives.
 */
export function placeTermsFor(location: string): string[] {
  const raw = (location || "").trim().toLowerCase();
  if (!raw) return [];
  const key = normCountry(raw);
  const terms = new Set<string>([raw, key]);
  // The country this location belongs to, whether they typed the country or a city.
  let country = COUNTRY_CITIES[key] ? key : "";
  if (!country) {
    for (const [c, cities] of Object.entries(COUNTRY_CITIES)) {
      if (cities.some((city) => city.toLowerCase() === key)) { country = c; break; }
    }
  }
  if (country) {
    terms.add(country);
    for (const city of COUNTRY_CITIES[country]) terms.add(city.toLowerCase());
    for (const adj of COUNTRY_ADJECTIVES[country] || []) terms.add(adj);
  }
  for (const [alias, target] of Object.entries(COUNTRY_ALIASES)) {
    if (target === country) terms.add(alias);
  }
  // The location the user actually typed always counts, even if it is on the
  // ambiguous list — if somebody explicitly targets "Hail", a page that says
  // "Hail" is the best signal available.
  const explicit = raw;
  return [...terms].filter((t) => t.length >= 3 && (t === explicit || !AMBIGUOUS_EVIDENCE.has(t)));
}
