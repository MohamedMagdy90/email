// Company discovery by location + industry using free OpenStreetMap data.
//  - Nominatim: turn "Qatar" / "Dubai" into an OSM area or bounding box
//  - Overpass: find businesses of a category that have a website
// Fully free, no API key. (OSM data is ODbL-licensed open data.)

export const LEAD_CATEGORIES: Record<string, { k: string; v?: string }[]> = {
  "Accounting & Tax": [{ k: "office", v: "accountant" }, { k: "office", v: "tax_advisor" }, { k: "office", v: "financial" }],
  "IT & Software": [{ k: "office", v: "it" }, { k: "office", v: "telecommunication" }],
  "Construction & Contracting": [{ k: "office", v: "construction_company" }, { k: "craft", v: "builder" }, { k: "craft", v: "contractor" }],
  "Consulting": [{ k: "office", v: "consulting" }],
  "Engineering": [{ k: "office", v: "engineer" }, { k: "craft", v: "electrician" }, { k: "craft", v: "hvac" }],
  "Real Estate": [{ k: "office", v: "estate_agent" }],
  "Legal": [{ k: "office", v: "lawyer" }, { k: "office", v: "notary" }],
  "Logistics & Transport": [{ k: "office", v: "logistics" }],
  "Advertising & Marketing": [{ k: "office", v: "advertising_agency" }],
  "Insurance": [{ k: "office", v: "insurance" }],
  "Trading & Retail": [{ k: "shop", v: "trade" }, { k: "shop", v: "wholesale" }, { k: "office", v: "company" }],
  "Companies (general)": [{ k: "office", v: "company" }],
};

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const UA = "DNA-Outreach/1.0 (dna.systems outreach tool)";

export interface Company {
  name: string;
  website: string;
  city: string;
  email: string | null;
}

async function geocode(location: string) {
  const url = `${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(location)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
  if (!res.ok) return null;
  const data: any[] = await res.json().catch(() => []);
  if (!data?.length) return null;
  const it = data[0];
  return { osm_type: it.osm_type as string, osm_id: Number(it.osm_id), boundingbox: it.boundingbox as string[] };
}

function buildQuery(filters: { k: string; v?: string }[], areaClause: string, limit: number) {
  const parts: string[] = [];
  for (const f of filters) {
    const tag = f.v ? `["${f.k}"="${f.v}"]` : `["${f.k}"]`;
    parts.push(`node${tag}["website"]${areaClause};`);
    parts.push(`way${tag}["website"]${areaClause};`);
  }
  return `[out:json][timeout:40];(${parts.join("")});out tags center ${limit};`;
}

export async function findLeads(location: string, category: string, limit: number): Promise<Company[]> {
  const filters = LEAD_CATEGORIES[category] || LEAD_CATEGORIES["Companies (general)"];
  const geo = await geocode(location);
  if (!geo) throw new Error("Could not find that location. Try a country or city name.");

  let areaClause: string;
  if (geo.osm_type === "relation") {
    areaClause = `(area:${3600000000 + geo.osm_id})`;
  } else if (geo.boundingbox?.length === 4) {
    const [s, n, w, e] = geo.boundingbox.map(Number);
    areaClause = `(${s},${w},${n},${e})`;
  } else {
    throw new Error("Could not resolve that area. Try a more specific city.");
  }

  const query = buildQuery(filters, areaClause, limit);
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Discovery service busy (Overpass ${res.status}). Try again or narrow the area.`);
  const data: any = await res.json().catch(() => ({ elements: [] }));

  const seen = new Set<string>();
  const companies: Company[] = [];
  for (const el of data.elements || []) {
    const t = el.tags || {};
    let website: string | undefined = t.website || t["contact:website"] || t.url;
    if (!website) continue;
    if (!/^https?:\/\//i.test(website)) website = "https://" + website;
    let domain = "";
    try { domain = new URL(website).hostname.replace(/^www\./i, "").toLowerCase(); } catch { continue; }
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    companies.push({
      name: t.name || t["name:en"] || domain,
      website,
      city: t["addr:city"] || t["addr:town"] || t["addr:suburb"] || "",
      email: t.email || t["contact:email"] || null,
    });
  }
  return companies;
}
