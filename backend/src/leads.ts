// Company discovery by location + industry using free OpenStreetMap data.
//  - Nominatim: turn "Qatar" / "Dubai" into an OSM area or bounding box
//  - Overpass: find businesses of a category that expose a contact signal
//    (website, email, or contact:email) so every result is actionable.
// Fully free, no API key. (OSM data is ODbL-licensed open data.)

export const LEAD_CATEGORIES: Record<string, { k: string; v?: string }[]> = {
  "Accounting & Tax": [
    { k: "office", v: "accountant" }, { k: "office", v: "tax_advisor" },
    { k: "office", v: "financial" }, { k: "office", v: "financial_advisor" },
    { k: "office", v: "bookkeeper" },
  ],
  "IT & Software": [
    { k: "office", v: "it" }, { k: "office", v: "telecommunication" },
    { k: "office", v: "software" }, { k: "shop", v: "computer" },
    { k: "craft", v: "electronics_repair" },
  ],
  "Construction & Contracting": [
    { k: "office", v: "construction_company" }, { k: "craft", v: "builder" },
    { k: "craft", v: "contractor" }, { k: "craft", v: "carpenter" },
    { k: "craft", v: "plumber" }, { k: "craft", v: "painter" },
    { k: "craft", v: "roofer" }, { k: "craft", v: "plasterer" },
  ],
  "Consulting": [
    { k: "office", v: "consulting" }, { k: "office", v: "management" },
    { k: "office", v: "quango" },
  ],
  "Engineering": [
    { k: "office", v: "engineer" }, { k: "office", v: "engineering" },
    { k: "craft", v: "electrician" }, { k: "craft", v: "hvac" },
    { k: "craft", v: "metal_construction" },
  ],
  "Real Estate": [
    { k: "office", v: "estate_agent" }, { k: "office", v: "property_management" },
  ],
  "Legal": [
    { k: "office", v: "lawyer" }, { k: "office", v: "notary" },
    { k: "office", v: "law_firm" },
  ],
  "Logistics & Transport": [
    { k: "office", v: "logistics" }, { k: "office", v: "transport" },
    { k: "office", v: "moving_company" }, { k: "office", v: "courier" },
  ],
  "Advertising & Marketing": [
    { k: "office", v: "advertising_agency" }, { k: "office", v: "marketing" },
    { k: "office", v: "graphic_design" }, { k: "shop", v: "printer" },
  ],
  "Insurance": [
    { k: "office", v: "insurance" },
  ],
  "Healthcare & Clinics": [
    { k: "amenity", v: "clinic" }, { k: "amenity", v: "doctors" },
    { k: "amenity", v: "dentist" }, { k: "amenity", v: "pharmacy" },
    { k: "office", v: "physician" },
  ],
  "Hospitality & Food": [
    { k: "tourism", v: "hotel" }, { k: "amenity", v: "restaurant" },
    { k: "amenity", v: "cafe" }, { k: "office", v: "travel_agent" },
  ],
  "Manufacturing & Industrial": [
    { k: "office", v: "company" }, { k: "man_made", v: "works" },
  ],
  "Education & Training": [
    { k: "amenity", v: "school" }, { k: "amenity", v: "college" },
    { k: "office", v: "educational_institution" },
  ],
  "Trading & Retail": [
    { k: "shop", v: "trade" }, { k: "shop", v: "wholesale" },
    { k: "shop", v: "car" }, { k: "office", v: "company" },
  ],
  "Companies (general)": [
    { k: "office", v: "company" }, { k: "office", v: "consulting" },
    { k: "office", v: "it" }, { k: "office", v: "financial" },
    { k: "shop", v: "trade" }, { k: "shop", v: "wholesale" },
  ],
};

// Contact signals we query for. A result needs at least one of these to be useful.
// Explicit keys are far faster in Overpass than a key-regex, so we list them.
const CONTACT_KEYS = ["website", "email", "contact:email"];

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
// Multiple public Overpass mirrors with independent rate limits. We race them
// all and retry, so one mirror returning 504/429 never sinks the whole search.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
];
const UA = "DNA-Outreach/1.0 (dna.systems outreach tool)";
const OVERPASS_TIMEOUT_MS = 30000; // abort a slow endpoint and fall through
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Company {
  name: string;
  website: string;
  city: string;
  email: string | null;
  phone: string | null;
  hasWebsite: boolean;
}

// A resolved place from the location autocomplete — lets us skip re-geocoding
// and target the exact OSM area the user picked (no ambiguity).
export interface Place {
  display_name: string;
  short_name: string;
  osm_type: string;
  osm_id: number;
  type?: string;
  boundingbox?: string[];
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

// How much to float each kind of place up the list (countries first, then
// regions, then cities). Photon already ranks well; this is a gentle nudge.
const PLACE_BOOST: Record<string, number> = {
  country: 0.6, state: 0.35, region: 0.3, province: 0.28, county: 0.18, district: 0.16,
  city: 0.22, town: 0.12, municipality: 0.12, village: 0.03, suburb: 0.03,
  island: 0.1, archipelago: 0.1,
};
const OSM_TYPE = { R: "relation", W: "way", N: "node" } as const;
const PHOTON = "https://photon.komoot.io/api/";

// Location autocomplete. Photon (komoot) is a free OSM geocoder purpose-built
// for typeahead, so "qat" → Qatar works as you'd expect. Nominatim is a fallback.
export async function geocodeSuggest(qStr: string, limit = 6): Promise<Place[]> {
  const q = qStr.trim();
  if (q.length < 2) return [];

  try {
    const url = `${PHOTON}?q=${encodeURIComponent(q)}&limit=12&lang=en&osm_tag=place&osm_tag=boundary`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) {
      const data: any = await res.json().catch(() => ({}));
      const scored: { place: Place; score: number }[] = [];
      const seen = new Set<string>();
      for (const f of data.features || []) {
        const p = f.properties || {};
        const kind = String(p.osm_value || p.type || "");
        if (!(kind in PLACE_BOOST)) continue; // places only, not streets/POIs
        const otype = (OSM_TYPE as any)[p.osm_type] || "relation";
        const key = `${otype}/${p.osm_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const parts = [p.name, kind === "country" ? null : p.state, p.country]
          .filter(Boolean)
          .filter((v: string, i: number, arr: string[]) => arr.indexOf(v) === i)
          .slice(0, 3);
        // Photon extent = [minLon, maxLat, maxLon, minLat] → Nominatim [S,N,W,E]
        const ex = p.extent;
        const bbox = Array.isArray(ex) && ex.length === 4
          ? [String(ex[3]), String(ex[1]), String(ex[0]), String(ex[2])]
          : undefined;
        scored.push({
          place: {
            display_name: parts.join(", "),
            short_name: parts.join(", ") || p.name,
            osm_type: otype,
            osm_id: Number(p.osm_id),
            type: kind,
            boundingbox: bbox,
          },
          score: (PLACE_BOOST[kind] || 0),
        });
      }
      if (scored.length) {
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map((s) => s.place);
      }
    }
  } catch { /* fall through to Nominatim */ }

  // Fallback: Nominatim (less typeahead-friendly but reliable for full names).
  const url = `${NOMINATIM}?format=jsonv2&addressdetails=1&limit=12&dedupe=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } }).catch(() => null);
  if (!res || !res.ok) return [];
  const data: any[] = await res.json().catch(() => []);
  const scored: { place: Place; score: number }[] = [];
  for (const it of data || []) {
    const at = String(it.addresstype || it.type || "");
    if (!(at in PLACE_BOOST) && it.class !== "boundary" && at !== "administrative") continue;
    const a = it.address || {};
    const primary = at === "country" ? (a.country || it.name) : (it.name || (it.display_name || "").split(",")[0]);
    const parts = [primary, at === "country" ? null : a.state, a.country].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 3);
    scored.push({
      place: { display_name: it.display_name, short_name: parts.join(", ") || primary, osm_type: it.osm_type, osm_id: Number(it.osm_id), type: at, boundingbox: it.boundingbox },
      score: Number(it.importance || 0) + (PLACE_BOOST[at] || 0),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.place);
}

function buildQuery(filters: { k: string; v?: string }[], areaClause: string, limit: number) {
  // Group category values by their OSM key so we can match them with a single
  // fast value-regex (e.g. office~"^(it|software|telecommunication)$") instead
  // of one statement per value. `nw` (node+way) skips slow relation processing.
  const groups = new Map<string, string[]>();
  for (const f of filters) {
    if (!f.v) continue;
    const arr = groups.get(f.k) || [];
    arr.push(f.v.replace(/[^a-z0-9_]/gi, ""));
    groups.set(f.k, arr);
  }

  const parts: string[] = [];
  for (const [k, vals] of groups) {
    const vre = `^(${[...new Set(vals)].join("|")})$`;
    for (const ck of CONTACT_KEYS) {
      parts.push(`nw["${k}"~"${vre}"]["${ck}"]${areaClause};`);
    }
  }
  // Ask for a healthy multiple of `limit` since we de-dupe aggressively after.
  return `[out:json][timeout:25];(${parts.join("")});out tags center ${limit * 3};`;
}

async function fetchOverpass(endpoint: string, query: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: "data=" + encodeURIComponent(query),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    return await res.json().catch(() => ({ elements: [] }));
  } finally {
    clearTimeout(timer);
  }
}

// Race every mirror and take whichever answers first, then retry the whole
// race a couple of times with backoff. With 5 independent mirrors × 3 rounds,
// a transient 504/429 from any single server can't fail the search.
async function runOverpass(query: string): Promise<any> {
  const rounds = 3;
  let lastErr: any = null;
  for (let i = 0; i < rounds; i++) {
    try {
      return await Promise.any(OVERPASS_ENDPOINTS.map((e) => fetchOverpass(e, query)));
    } catch (agg: any) {
      lastErr = agg?.errors?.[0];
      if (i < rounds - 1) await sleep(900 * (i + 1));
    }
  }
  const msg = lastErr?.name === "AbortError" ? "timed out" : String(lastErr?.message || "unavailable");
  throw new Error(`Discovery service busy (${msg}). Try again in a moment or narrow the area.`);
}

export async function findLeads(
  location: string,
  category: string,
  limit: number,
  place?: { osm_type?: string; osm_id?: number; boundingbox?: string[] }
): Promise<Company[]> {
  const filters = LEAD_CATEGORIES[category] || LEAD_CATEGORIES["Companies (general)"];

  // Use the exact place picked from autocomplete when available; else geocode.
  let geo: { osm_type: string; osm_id: number; boundingbox?: string[] } | null = null;
  if (place?.osm_type && place?.osm_id) {
    geo = { osm_type: place.osm_type, osm_id: place.osm_id, boundingbox: place.boundingbox };
  } else {
    geo = await geocode(location);
  }
  if (!geo) throw new Error("Could not find that location. Try a country or city name.");

  let areaClause: string;
  if (geo.osm_type === "relation") {
    areaClause = `(area:${3600000000 + geo.osm_id})`;
  } else if (geo.osm_type === "way") {
    areaClause = `(area:${2400000000 + geo.osm_id})`;
  } else if (geo.boundingbox?.length === 4) {
    const [s, n, w, e] = geo.boundingbox.map(Number);
    areaClause = `(${s},${w},${n},${e})`;
  } else {
    throw new Error("Could not resolve that area. Try a more specific city.");
  }

  const query = buildQuery(filters, areaClause, limit);
  const data = await runOverpass(query);

  const byDomain = new Map<string, Company>();
  const noSite: Company[] = [];
  const seenEmail = new Set<string>();

  for (const el of data.elements || []) {
    const t = el.tags || {};
    const rawEmail = (t.email || t["contact:email"] || "").split(";")[0].trim().toLowerCase() || null;
    const phone = (t.phone || t["contact:phone"] || t["contact:mobile"] || "").split(";")[0].trim() || null;
    let website: string | undefined = t.website || t["contact:website"] || t.url;
    const name = t.name || t["name:en"] || "";
    const city = t["addr:city"] || t["addr:town"] || t["addr:suburb"] || "";

    if (website) {
      if (!/^https?:\/\//i.test(website)) website = "https://" + website;
      let domain = "";
      try { domain = new URL(website).hostname.replace(/^www\./i, "").toLowerCase(); } catch { website = undefined; }
      if (domain) {
        const existing = byDomain.get(domain);
        if (existing) {
          // Enrich a previously-seen domain with any missing details.
          if (!existing.email && rawEmail) existing.email = rawEmail;
          if (!existing.phone && phone) existing.phone = phone;
          if (existing.name === domain && name) existing.name = name;
          continue;
        }
        byDomain.set(domain, {
          name: name || domain,
          website,
          city,
          email: rawEmail,
          phone,
          hasWebsite: true,
        });
        continue;
      }
    }

    // No usable website — still valuable if it exposes an email directly.
    if (rawEmail && !seenEmail.has(rawEmail)) {
      seenEmail.add(rawEmail);
      noSite.push({ name: name || rawEmail.split("@")[1], website: "", city, email: rawEmail, phone, hasWebsite: false });
    }
  }

  // Websites first (crawlable), then direct-email-only leads.
  return [...byDomain.values(), ...noSite].slice(0, limit);
}
