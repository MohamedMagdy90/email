// Step 2 — ideal customers. The AI proposes segments INSIDE the campaign's
// target market, in structured fields (industries from the list, cities, size,
// people, signals); the searches are then generated from those fields.
// Without AI, solid defaults per campaign kind so the engine can still start.
import { aiStatus, llm, LlmBudgetExceeded, LlmUnavailable } from "../llm";
import { CITIES } from "../../country";
import { INDUSTRIES, INDUSTRY_BY_ID, SIZE_BANDS } from "../targeting/taxonomy";
import type { TargetMarket } from "../targeting/market";
import { offerText, sanitizeSegmentInput, type CampaignKind, type Offer, type SegmentInput } from "./types";

const OWNER_TITLES = ["Owner", "Founder", "CEO", "Managing Director", "General Manager"];

const labels = (ids: string[]) => ids.map((id) => INDUSTRY_BY_ID.get(id)?.label || id);

const CUSTOMER_DEFAULTS: SegmentInput[] = [
  {
    name: "Trading and distribution companies in Saudi Arabia",
    description: "Importers, wholesalers and distributors juggling stock across branches and warehouses.",
    industryIds: ["wholesale_distribution", "food_distribution", "trading"],
    countries: ["Saudi Arabia"],
    cities: { "Saudi Arabia": ["Riyadh", "Jeddah", "Dammam"] },
    sizeBands: ["11-50", "51-200", "201-500"],
    titlesOverride: true,
    titles: ["CFO", "Finance Manager", ...OWNER_TITLES, "Operations Manager"],
    fitScore: 85,
    why: "Inventory, multi-branch sales and ZATCA e-invoicing are daily pain for distributors, and that's exactly what the ERP covers.",
  },
  {
    name: "Manufacturers in the UAE",
    description: "Small and mid-size factories that need production, stock and costing in one system.",
    industryIds: ["manufacturing", "food_manufacturing", "plastics_packaging"],
    countries: ["United Arab Emirates"],
    cities: { "United Arab Emirates": ["Sharjah", "Dubai", "Ajman"] },
    sizeBands: ["11-50", "51-200", "201-500"],
    titlesOverride: true,
    titles: ["Plant Manager", "Operations Director", "CFO", ...OWNER_TITLES],
    fitScore: 78,
    why: "Manufacturers outgrow spreadsheets and basic accounting first; production and costing modules are a clear upgrade.",
  },
  {
    name: "Retail and multi-branch businesses in Qatar and Kuwait",
    description: "Chains with several outlets that need POS, stock and accounting connected.",
    industryIds: ["retail_chain", "restaurants", "pharma_medical"],
    countries: ["Qatar", "Kuwait"],
    minBranches: 3,
    titlesOverride: true,
    titles: ["Operations Manager", "Finance Manager", ...OWNER_TITLES],
    fitScore: 72,
    why: "Multi-branch retailers need POS tied to stock and accounts in Arabic and English.",
  },
  {
    name: "Contracting and services companies in the Gulf",
    description: "Contractors and service firms running projects, purchasing and payroll.",
    industryIds: ["contracting", "mep_fm"],
    countries: ["Saudi Arabia", "United Arab Emirates", "Qatar"],
    sizeBands: ["51-200", "201-500", "500+"],
    titlesOverride: true,
    titles: ["CFO", "Finance Director", "General Manager", "Projects Director"],
    fitScore: 66,
    why: "Project costing, purchasing and payroll for large crews are hard to run without an ERP.",
  },
];

const PARTNER_DEFAULTS: SegmentInput[] = [
  {
    name: "Accounting and audit firms",
    description: "Firms whose clients need bookkeeping software, VAT and e-invoicing compliance.",
    industryIds: ["accounting_audit", "tax_vat"],
    countries: ["Saudi Arabia", "United Arab Emirates", "Qatar"],
    sizeBands: ["1-10", "11-50", "51-200"],
    titlesOverride: true,
    titles: ["Managing Partner", "Partner", "Founder", "Director"],
    fitScore: 86,
    why: "They advise exactly the companies that need an ERP and can earn the 15% referral or 35% reseller commission.",
  },
  {
    name: "IT resellers and system integrators",
    description: "Companies that already sell software, hardware or IT services to SMEs.",
    industryIds: ["it_services", "pos_resellers"],
    countries: ["Saudi Arabia", "United Arab Emirates", "Kuwait", "Bahrain"],
    sizeBands: ["1-10", "11-50", "51-200"],
    titlesOverride: true,
    titles: ["Founder", "CEO", "Sales Director", "Business Development Manager"],
    fitScore: 80,
    why: "An ERP adds recurring revenue to their existing SME customer base.",
  },
  {
    name: "ERP and business consultancies",
    description: "Consultants who implement or recommend business software.",
    industryIds: ["erp_consultancy", "software_distributor"],
    countries: ["Saudi Arabia", "United Arab Emirates", "Qatar", "Oman"],
    sizeBands: ["1-10", "11-50", "51-200"],
    titlesOverride: true,
    titles: ["Founder", "Managing Director", "Principal Consultant"],
    fitScore: 74,
    why: "They already sell implementation work and can resell a lighter, Arabic-first ERP.",
  },
];

/** Keep a proposal inside the market: its countries and cities must be ones the market allows. */
function fitToMarket(s: SegmentInput, market: TargetMarket | null): SegmentInput {
  const out: SegmentInput = { ...s, industries: labels(s.industryIds || []), queriesAuto: (s.industryIds?.length || 0) > 0 };
  if (!market) return out;
  const countries = (s.countries || []).filter((c) => market.countries.includes(c));
  out.countries = countries;
  if (s.cities) {
    const cities: Record<string, string[]> = {};
    for (const [country, list] of Object.entries(s.cities)) {
      if (!(countries.length ? countries : market.countries).includes(country)) continue;
      const allowed = market.cities[country];
      const kept = allowed?.length ? list.filter((c) => allowed.includes(c)) : list;
      if (kept.length) cities[country] = kept;
    }
    out.cities = cities;
  }
  return out;
}

export function defaultSegments(kind: CampaignKind, count: number, existing: string[], market: TargetMarket | null = null): SegmentInput[] {
  const pool = kind === "partner" ? PARTNER_DEFAULTS : CUSTOMER_DEFAULTS;
  const have = new Set(existing.map((n) => n.toLowerCase()));
  return pool
    .filter((s) => !have.has(String(s.name).toLowerCase()))
    .map((s) => fitToMarket(s, market))
    // A default whose countries are all outside the market would target nothing.
    .filter((s) => !market || !(s.countries && s.countries.length === 0 && (pool.find((p) => p.name === s.name)?.countries?.length || 0) > 0))
    .slice(0, count);
}

export async function proposeSegments(input: {
  kind: CampaignKind;
  offer: Offer | null;
  count: number;
  existing: string[];
  market?: TargetMarket | null;
}): Promise<{ segments: SegmentInput[]; warning?: string }> {
  const count = Math.max(1, Math.min(6, input.count || 4));
  const market = input.market || null;
  const status = await aiStatus();
  const fallback = (warning: string) => {
    const segments = defaultSegments(input.kind, count, input.existing, market);
    return { segments, warning: segments.length ? warning : "Every default segment is already in this campaign (or outside its target market). Add one by hand, or connect an AI key for new suggestions." };
  };
  if (!status.configured) return fallback("No AI key yet, so these are the standard segments for this kind of campaign. Edit them, or connect an AI key in the Agent tab for tailored suggestions.");
  const pool = INDUSTRIES.filter((i) => i.kind === input.kind);
  const countries = market?.countries.length ? market.countries : ["Saudi Arabia", "United Arab Emirates", "Qatar", "Kuwait", "Bahrain", "Oman"];
  const cityList = countries.map((c) => `${c}: ${(CITIES[c] || []).map((x) => x.name).join(", ") || "(any)"}`).join("\n");
  try {
    const r = await llm<any>({
      tier: "smart",
      json: true,
      task: "campaign:segments",
      temperature: 0.4,
      system: "You are a B2B outbound strategist for the Gulf and MENA. You define precise, reachable target segments in structured fields.",
      prompt: [
        `Campaign type: ${input.kind === "partner" ? "recruit partners / resellers / referral partners" : "sell to end customers"}.`,
        "Offer:",
        offerText(input.offer) || "(no offer yet — assume a cloud ERP for SMEs in the Gulf)",
        input.existing.length ? `Already have these segments (propose different ones): ${input.existing.join("; ")}` : "",
        `Target market (stay inside it): ${countries.join(", ")}.`,
        market?.excludeIndustries.length ? `Never propose: ${market.excludeIndustries.map((id) => INDUSTRY_BY_ID.get(id)?.label || id).join(", ")}.` : "",
        "Industry ids you may use (pick 1-3 per segment):",
        pool.map((i) => `${i.id} = ${i.label}`).join("\n"),
        "Cities you may use (optional, to narrow a segment):",
        cityList,
        `Size bands: ${SIZE_BANDS.join(", ")}.`,
        "",
        `Propose ${count} segments, each narrow enough to search for, with the decision-maker titles to contact in priority order.`,
        'Return JSON: {"segments":[{"name": string, "description": string, "industryIds": string[], "countries": string[], "cities": {"<country>": string[]}, "sizeBands": string[], "minBranches": number|null, "titles": string[], "signals": {"must": string[], "mustNot": string[]}, "fitScore": number 0-100, "why": string (1-2 sentences)}]}',
      ]
        .filter(Boolean)
        .join("\n"),
    });
    const list = Array.isArray(r.data?.segments) ? r.data.segments : Array.isArray(r.data) ? r.data : [];
    const have = new Set(input.existing.map((n) => n.toLowerCase()));
    const segments = list
      .map((raw: any) => {
        const s = sanitizeSegmentInput(raw);
        if (s.titles?.length) s.titlesOverride = true;
        // No industry from the list: keep the AI's own searches, written by hand.
        if (!s.industryIds?.length && !s.queries?.length) return null;
        const fitted = s.industryIds?.length ? fitToMarket(s, market) : { ...s, queriesAuto: false };
        return fitted;
      })
      .filter((s: SegmentInput | null): s is SegmentInput => !!s && !!s.name && !have.has(s.name.toLowerCase()))
      .slice(0, count);
    if (!segments.length) return fallback("The AI didn't return usable segments, so these are the standard ones. Try again or edit them.");
    return { segments };
  } catch (e: any) {
    const why = e instanceof LlmBudgetExceeded ? "today's AI budget is used up" : e instanceof LlmUnavailable ? "no AI provider answered" : String(e?.message || e);
    return fallback(`Couldn't get suggestions from the AI (${why}), so these are the standard segments.`);
  }
}
