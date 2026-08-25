// Company discovery by location + industry using free OpenStreetMap data.
//  - Nominatim: turn "Qatar" / "Dubai" into an OSM area or bounding box
//  - Overpass: find businesses of a category that expose a contact signal
//    (website, email or phone) so every result is actionable.
// Fully free, no API key. (OSM data is ODbL-licensed open data.)

// Every OSM key that can denote a business/organisation. Used by the umbrella
// category and by the "is this actually a company?" filter further down.
const BUSINESS_KEYS = ["office", "shop", "craft", "company", "amenity", "tourism", "healthcare", "leisure", "industrial"] as const;

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
    { k: "craft" }, // any craft = workshops, fabricators, manufacturers
  ],
  "Education & Training": [
    { k: "amenity", v: "school" }, { k: "amenity", v: "college" },
    { k: "office", v: "educational_institution" },
  ],
  "Trading & Retail": [
    { k: "shop" },                 // any retail/wholesale shop
    { k: "office", v: "company" },
  ],
  // Umbrella category: match ANY value of the core "business" keys so the whole
  // long tail of companies OSM knows about is captured — not a hand-picked few.
  // `office/shop/craft` alone is far too narrow: most real businesses in OSM are
  // tagged `amenity` (bank, restaurant, pharmacy, car_rental…), `tourism`
  // (hotel, guest_house), `healthcare` or `leisure` (gym, sports centre).
  // Measured on Jordan: office/shop/craft = 180 contactable, this set = 1,089.
  "Companies (general)": BUSINESS_KEYS.map((k) => ({ k })),
};

// Values that carry one of the business keys but are NOT a company anyone can
// sell to — street furniture, public infrastructure, landscape. Everything not
// listed here passes, so newly-invented tags keep flowing in (deny, not allow).
const NON_BUSINESS: Record<string, Set<string>> = {
  amenity: new Set([
    "embassy", // legacy tagging for a diplomatic mission — not a company
    "atm", "bench", "bicycle_parking", "bicycle_repair_station", "bbq", "clock",
    "charging_station", "drinking_water", "fountain", "grit_bin", "hunting_stand",
    "letter_box", "motorcycle_parking", "parking", "parking_entrance", "parking_space",
    "post_box", "public_bookcase", "recycling", "shelter", "telephone", "toilets",
    "vending_machine", "waste_basket", "waste_disposal", "water_point",
    "place_of_worship", "grave_yard", "police", "fire_station", "prison",
  ]),
  tourism: new Set(["viewpoint", "artwork", "picnic_site", "information", "board", "map", "wilderness_hut", "alpine_hut"]),
  leisure: new Set([
    "park", "garden", "playground", "pitch", "common", "nature_reserve", "picnic_table",
    "slipway", "swimming_area", "track", "dog_park", "firepit", "bleachers", "outdoor_seating",
  ]),
  shop: new Set(["vacant", "no"]),
  office: new Set(["vacant", "no", "diplomatic"]), // current tagging for embassies/consulates
  healthcare: new Set(["yes"]),
};

// Hosts that are somebody's *profile*, not a company's own site. Mappers often
// drop a Facebook page or a YouTube clip into `website`, and treating those as
// the business's domain poisons de-duplication (every such lead collapses onto
// "facebook.com") and wastes the email-finder crawling a platform that will
// never yield a company address.
const NOT_A_COMPANY_SITE = new Set([
  "youtube.com", "youtu.be", "facebook.com", "fb.com", "fb.me", "m.facebook.com",
  "instagram.com", "twitter.com", "x.com", "tiktok.com", "linkedin.com", "snapchat.com",
  "pinterest.com", "wa.me", "api.whatsapp.com", "chat.whatsapp.com", "t.me", "telegram.me",
  "maps.google.com", "goo.gl", "maps.app.goo.gl", "google.com", "bit.ly", "linktr.ee",
  "booking.com", "airbnb.com", "tripadvisor.com", "foursquare.com", "yelp.com",
  "wikipedia.org", "en.wikipedia.org", "wikidata.org",
]);
// Shared mailbox hosts. Thousands of unrelated businesses sit behind each, so
// one can never stand in for a company's identity or name. There used to be an
// identical private copy of this list here and in `discovery.ts`; both now read
// the canonical one, because three copies of a list is three chances to drift.
import { FREEMAIL_DOMAINS as FREEMAIL } from "./crawler/validate";

export function isCompanySite(domain: string): boolean {
  if (NOT_A_COMPANY_SITE.has(domain)) return false;
  // …and their country variants (tripadvisor.co.uk, facebook.com.eg, …).
  const base = domain.split(".")[0];
  return !["facebook", "youtube", "instagram", "tripadvisor", "wikipedia", "linkedin"].includes(base);
}

// Does this POI represent a real business? It matched one of our selectors, so
// it carries at least one business key — keep it unless EVERY business key it
// carries is on the deny list (a `shop=car_repair` + `amenity=fuel` stays).
function isBusinessPoi(t: Record<string, string>): boolean {
  // A `diplomatic` tag of any value settles it: embassy, consulate, permanent
  // mission, liaison office. None of them buy anything.
  if (t.diplomatic) return false;
  for (const k of BUSINESS_KEYS) {
    const v = t[k];
    if (!v || v === "no") continue;
    if (NON_BUSINESS[k]?.has(v)) continue;
    return true;
  }
  return false;
}

// Contact signals that make a result actionable. Collapsed into ONE key-regex
// rather than one query statement per key: 9 keys × 9 selectors would be 81
// statements per query, which Overpass times out on. Phone counts — a named
// company with a phone number is a real lead, and requiring website/email threw
// away ~80% of everything OSM knows (Jordan: 861 phones vs 391 emails).
const CONTACT_FILTER = `[~"^(website|contact:website|url|email|contact:email|phone|contact:phone|contact:mobile|contact:whatsapp)$"~"."]`;

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
const OVERPASS_TIMEOUT_MS = 90000; // abort a slow endpoint and fall through (broad "any business" queries need room)
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

// Turn a category's filters into Overpass selectors.
//  • value filters   → specific values of a key (office~"^(it|software)$")
//  • key-only filters → ANY value of a key (any office/shop/amenity…). This is
//    how umbrella categories capture the long tail of businesses OSM knows,
//    instead of a hand-picked handful of tag values.
// Grouping keeps each key to a single fast regex.
function selectorsFor(filters: { k: string; v?: string }[]): string[] {
  const groups = new Map<string, string[]>();
  const anyKey = new Set<string>();
  for (const f of filters) {
    if (f.v) {
      const arr = groups.get(f.k) || [];
      arr.push(f.v.replace(/[^a-z0-9_]/gi, ""));
      groups.set(f.k, arr);
    } else {
      anyKey.add(f.k);
    }
  }
  // A key matched "any value" is a superset of its own value list — drop the list.
  for (const k of anyKey) groups.delete(k);

  const selectors: string[] = [];
  for (const [k, vals] of groups) selectors.push(`["${k}"~"^(${[...new Set(vals)].join("|")})$"]`);
  for (const k of anyKey) selectors.push(`["${k}"]`);
  return selectors;
}

// `nw` (node+way) skips slow relation processing. One statement per selector —
// the contact requirement rides along as a single key-regex.
function statements(selectors: string[], scope: string): string {
  return selectors.map((sel) => `nw${sel}${CONTACT_FILTER}${scope};`).join("");
}

/* --------------------------- areas & tiling --------------------------- */

// A resolved search area: the Overpass prelude that defines it (if any), the
// filter clause that scopes a statement to it, and its bounding box so we can
// sweep it tile-by-tile.
export interface AreaRef {
  prelude: string;                                    // "area(3600184818)->.a;" | ""
  clause: string;                                     // "(area.a)" | "(s,w,n,e)"
  bbox: [number, number, number, number] | null;      // [south, west, north, east]
}

export type Tile = [number, number, number, number];  // [south, west, north, east]

export async function resolveArea(
  location: string,
  place?: { osm_type?: string; osm_id?: number; boundingbox?: string[] }
): Promise<AreaRef> {
  let geo: { osm_type: string; osm_id: number; boundingbox?: string[] } | null = null;
  if (place?.osm_type && place?.osm_id) {
    geo = { osm_type: place.osm_type, osm_id: place.osm_id, boundingbox: place.boundingbox };
  } else {
    geo = await geocode(location);
  }
  if (!geo) throw new Error("Could not find that location. Try a country or city name.");

  // Nominatim/Photon hand back [south, north, west, east]; Overpass wants
  // [south, west, north, east]. Re-order once, here, so nothing downstream has
  // to remember which convention it is holding.
  const bb = geo.boundingbox?.length === 4 ? geo.boundingbox.map(Number) : null;
  const bbox: Tile | null = bb && bb.every((n) => Number.isFinite(n)) ? [bb[0], bb[2], bb[1], bb[3]] : null;

  if (geo.osm_type === "relation") return { prelude: `area(${3600000000 + geo.osm_id})->.a;`, clause: "(area.a)", bbox };
  if (geo.osm_type === "way") return { prelude: `area(${2400000000 + geo.osm_id})->.a;`, clause: "(area.a)", bbox };
  if (bbox) return { prelude: "", clause: `(${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]})`, bbox };
  throw new Error("Could not resolve that area. Try a more specific city.");
}

// Split an area into a grid the worker can walk one slice at a time.
//
// Why tile at all: Overpass caps what a single query may return, and a whole
// country asked in one shot either truncates or times out — which is exactly
// why a country-wide scan used to plateau at a few hundred rows and never grow.
// Sweeping ~0.6° slices keeps every request small and fast, and gives the run a
// real, visible position ("tile 23 of 56") instead of an opaque re-scan.
const TILE_DEG = 0.6;
const TILES_PER_AXIS_MAX = 10;

export function tilesFor(bbox: [number, number, number, number] | null): Tile[] {
  if (!bbox) return [];
  const [s, w, n, e] = bbox;
  const dLat = Math.abs(n - s);
  const dLon = Math.abs(e - w);
  const rows = Math.max(1, Math.min(TILES_PER_AXIS_MAX, Math.ceil(dLat / TILE_DEG)));
  const cols = Math.max(1, Math.min(TILES_PER_AXIS_MAX, Math.ceil(dLon / TILE_DEG)));
  if (rows === 1 && cols === 1) return [[s, w, n, e]];
  const hLat = dLat / rows;
  const hLon = dLon / cols;
  const out: Tile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // A hair of overlap so a POI sitting exactly on a seam is never missed;
      // the caller de-dupes by domain/email anyway.
      out.push([s + r * hLat - 1e-6, w + c * hLon - 1e-6, s + (r + 1) * hLat + 1e-6, w + (c + 1) * hLon + 1e-6]);
    }
  }
  return out;
}

// How many contactable businesses OSM holds in this area, full stop. This is the
// hard ceiling of what a Map-area source can ever return, so we surface it in
// the UI rather than letting a source look "stuck" when it is simply finished.
export async function countAvailable(area: AreaRef, category: string): Promise<number> {
  const filters = LEAD_CATEGORIES[category] || LEAD_CATEGORIES["Companies (general)"];
  const query = `[out:json][timeout:180];${area.prelude}(${statements(selectorsFor(filters), area.clause)});out count;`;
  const data = await runOverpass(query);
  const total = Number(data?.elements?.[0]?.tags?.total);
  return Number.isFinite(total) ? total : 0;
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

// Harvest one already-resolved area, optionally narrowed to a single tile.
// This is what the always-on worker calls, once per tile, so a whole country
// arrives in small fast slices instead of one truncated mega-query.
export async function findLeadsIn(
  area: AreaRef,
  category: string,
  limit: number,
  tile?: Tile
): Promise<Company[]> {
  const filters = LEAD_CATEGORIES[category] || LEAD_CATEGORIES["Companies (general)"];
  const scope = area.clause + (tile ? `(${tile[0]},${tile[1]},${tile[2]},${tile[3]})` : "");
  // Room for the whole slice — we de-dupe hard afterwards, and truncating here
  // is precisely how leads used to go missing and never come back. `limit <= 0`
  // means "everything in this tile", which is what the always-on sweep asks for:
  // the tile already bounds the work geographically, so a row cap can only lose
  // businesses in the one place that matters most (the capital city).
  const cap = limit > 0 ? Math.min(Math.max(limit * 4, 2000), 20000) : 20000;
  const query = `[out:json][timeout:180];${area.prelude}(${statements(selectorsFor(filters), scope)});out tags center ${cap};`;
  const data = await runOverpass(query);

  const byDomain = new Map<string, Company>();
  const noSite: Company[] = [];
  const seenEmail = new Set<string>();
  const seenPhone = new Set<string>();

  for (const el of data.elements || []) {
    const t = el.tags || {};
    // Matched a business key, but is it a business? Drop cash machines, benches,
    // car parks and public toilets — they carry contact tags but sell nothing.
    if (!isBusinessPoi(t)) continue;

    const rawEmail = (t.email || t["contact:email"] || "").split(";")[0].trim().toLowerCase() || null;
    const phone = (t.phone || t["contact:phone"] || t["contact:mobile"] || t["contact:whatsapp"] || "").split(";")[0].trim() || null;
    let website: string | undefined = t.website || t["contact:website"] || t.url;
    const name = t.name || t["name:en"] || "";
    const city = t["addr:city"] || t["addr:town"] || t["addr:suburb"] || "";

    if (website) {
      if (!/^https?:\/\//i.test(website)) website = "https://" + website;
      let domain = "";
      try { domain = new URL(website).hostname.replace(/^www\./i, "").toLowerCase(); } catch { website = undefined; }
      // A social/profile link isn't the company's site. Forget it and let the
      // lead through on its email or phone instead of inventing a fake domain.
      if (domain && !isCompanySite(domain)) { domain = ""; website = undefined; }
      if (domain) {
        const existing = byDomain.get(domain);
        if (existing) {
          // Enrich a previously-seen domain with any missing details.
          if (!existing.email && rawEmail) existing.email = rawEmail;
          if (!existing.phone && phone) existing.phone = phone;
          if (existing.name === domain && name) existing.name = name;
          continue;
        }
        byDomain.set(domain, { name: name || domain, website, city, email: rawEmail, phone, hasWebsite: true });
        continue;
      }
    }

    // No usable website — still valuable if it exposes an email directly.
    if (rawEmail) {
      if (seenEmail.has(rawEmail)) continue;
      const mailDomain = rawEmail.split("@")[1] || "";
      // An unnamed pin has to borrow a name from its email domain. That's fine
      // for "acme.qa", but a free-mail host would file the lead as a company
      // literally called "gmail.com" — so an unnamed free-mail pin is dropped.
      if (!name && (!mailDomain || FREEMAIL.has(mailDomain))) continue;
      seenEmail.add(rawEmail);
      noSite.push({ name: name || mailDomain, website: "", city, email: rawEmail, phone, hasWebsite: false });
      continue;
    }

    // Named company with only a phone number. Still a real, reachable lead —
    // and dropping these was throwing away most of the map (Jordan: 861 phones
    // vs 391 emails). Nameless phone pins are noise, so they stay out.
    if (phone && name) {
      const key = phone.replace(/[^\d+]/g, "");
      if (!key || seenPhone.has(key)) continue;
      seenPhone.add(key);
      noSite.push({ name, website: "", city, email: null, phone, hasWebsite: false });
    }
  }

  // Websites first (crawlable into a real email), then direct contacts.
  const all = [...byDomain.values(), ...noSite];
  return limit > 0 ? all.slice(0, limit) : all;
}

// One-shot search for the manual "find companies" screen: resolve the place and
// harvest the whole area in a single call.
export async function findLeads(
  location: string,
  category: string,
  limit: number,
  place?: { osm_type?: string; osm_id?: number; boundingbox?: string[] }
): Promise<Company[]> {
  const area = await resolveArea(location, place);
  return findLeadsIn(area, category, limit);
}
