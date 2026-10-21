// Step 2 — ideal customers. The AI proposes segments (industry x country x
// size, the people to reach, the searches that find them). Without AI, solid
// defaults per campaign kind so the engine can still start.
import { aiStatus, llm, LlmBudgetExceeded, LlmUnavailable } from "../llm";
import { offerText, sanitizeSegmentInput, type CampaignKind, type Offer, type SegmentInput } from "./types";

const OWNER_TITLES = ["Owner", "Founder", "CEO", "Managing Director", "General Manager"];

const CUSTOMER_DEFAULTS: SegmentInput[] = [
  {
    name: "Trading and distribution companies in Saudi Arabia",
    description: "Importers, wholesalers and distributors juggling stock across branches and warehouses.",
    industries: ["Wholesale trading", "Distribution", "Import and export"],
    countries: ["Saudi Arabia"],
    companySize: "20-300 employees",
    titles: ["CFO", "Finance Manager", ...OWNER_TITLES, "Operations Manager"],
    queries: ["food distribution company Riyadh", "building materials trading company Jeddah", "wholesale distributor Dammam", "import export trading company Saudi Arabia", "spare parts distributor Riyadh", "medical supplies distributor Saudi Arabia"],
    fitScore: 85,
    why: "Inventory, multi-branch sales and ZATCA e-invoicing are daily pain for distributors, and that's exactly what the ERP covers.",
  },
  {
    name: "Manufacturers in the UAE",
    description: "Small and mid-size factories that need production, stock and costing in one system.",
    industries: ["Manufacturing", "Food processing", "Plastics", "Metal fabrication"],
    countries: ["United Arab Emirates"],
    companySize: "20-250 employees",
    titles: ["Plant Manager", "Operations Director", "CFO", ...OWNER_TITLES],
    queries: ["manufacturing company Sharjah industrial area", "food factory Dubai", "plastic products manufacturer UAE", "metal fabrication company Abu Dhabi", "furniture manufacturer Dubai"],
    fitScore: 78,
    why: "Manufacturers outgrow spreadsheets and basic accounting first; production and costing modules are a clear upgrade.",
  },
  {
    name: "Retail and multi-branch businesses in Qatar and Kuwait",
    description: "Chains with several outlets that need POS, stock and accounting connected.",
    industries: ["Retail", "Restaurants", "Pharmacies"],
    countries: ["Qatar", "Kuwait"],
    companySize: "3+ branches",
    titles: ["Operations Manager", "Finance Manager", ...OWNER_TITLES],
    queries: ["retail chain Doha", "pharmacy group Kuwait", "restaurant group Doha", "electronics retailer Kuwait City"],
    fitScore: 72,
    why: "Multi-branch retailers need POS tied to stock and accounts in Arabic and English.",
  },
  {
    name: "Contracting and services companies in the Gulf",
    description: "Contractors and service firms running projects, purchasing and payroll.",
    industries: ["Contracting", "Facility management", "Engineering services"],
    countries: ["Saudi Arabia", "United Arab Emirates", "Qatar"],
    companySize: "50-500 employees",
    titles: ["CFO", "Finance Director", "General Manager", "Projects Director"],
    queries: ["MEP contracting company Riyadh", "facility management company Dubai", "civil contracting company Doha", "engineering services company Jeddah"],
    fitScore: 66,
    why: "Project costing, purchasing and payroll for large crews are hard to run without an ERP.",
  },
];

const PARTNER_DEFAULTS: SegmentInput[] = [
  {
    name: "Accounting and audit firms",
    description: "Firms whose clients need bookkeeping software, VAT and e-invoicing compliance.",
    industries: ["Accounting", "Audit", "Tax advisory"],
    countries: ["Saudi Arabia", "United Arab Emirates", "Qatar"],
    companySize: "5-100 employees",
    titles: ["Managing Partner", "Partner", "Founder", "Director"],
    queries: ["accounting firm Riyadh", "audit firm Dubai", "VAT consultants Saudi Arabia", "bookkeeping services Doha", "chartered accountants Jeddah"],
    fitScore: 86,
    why: "They advise exactly the companies that need an ERP and can earn the 15% referral or 35% reseller commission.",
  },
  {
    name: "IT resellers and system integrators",
    description: "Companies that already sell software, hardware or IT services to SMEs.",
    industries: ["IT services", "System integration", "Software reseller"],
    countries: ["Saudi Arabia", "United Arab Emirates", "Kuwait", "Bahrain"],
    companySize: "5-200 employees",
    titles: ["Founder", "CEO", "Sales Director", "Business Development Manager"],
    queries: ["IT solutions company Riyadh", "system integrator Dubai", "software reseller Kuwait", "IT services company Bahrain", "POS solutions provider Jeddah"],
    fitScore: 80,
    why: "An ERP adds recurring revenue to their existing SME customer base.",
  },
  {
    name: "ERP and business consultancies",
    description: "Consultants who implement or recommend business software.",
    industries: ["ERP consulting", "Management consulting"],
    countries: ["Saudi Arabia", "United Arab Emirates", "Qatar", "Oman"],
    companySize: "2-80 employees",
    titles: ["Founder", "Managing Director", "Principal Consultant"],
    queries: ["ERP consultancy Dubai", "ERP implementation partner Riyadh", "business process consulting Doha", "Odoo partner Saudi Arabia"],
    fitScore: 74,
    why: "They already sell implementation work and can resell a lighter, Arabic-first ERP.",
  },
];

export function defaultSegments(kind: CampaignKind, count: number, existing: string[]): SegmentInput[] {
  const pool = kind === "partner" ? PARTNER_DEFAULTS : CUSTOMER_DEFAULTS;
  const have = new Set(existing.map((n) => n.toLowerCase()));
  return pool.filter((s) => !have.has(String(s.name).toLowerCase())).slice(0, count);
}

export async function proposeSegments(input: { kind: CampaignKind; offer: Offer | null; count: number; existing: string[] }): Promise<{ segments: SegmentInput[]; warning?: string }> {
  const count = Math.max(1, Math.min(6, input.count || 4));
  const status = await aiStatus();
  const fallback = (warning: string) => {
    const segments = defaultSegments(input.kind, count, input.existing);
    return { segments, warning: segments.length ? warning : "Every default segment is already in this campaign. Add one by hand, or connect an AI key for new suggestions." };
  };
  if (!status.configured) return fallback("No AI key yet, so these are the standard segments for this kind of campaign. Edit them, or connect an AI key in the Agent tab for tailored suggestions.");
  try {
    const r = await llm<any>({
      tier: "smart",
      json: true,
      task: "campaign:segments",
      temperature: 0.4,
      system: "You are a B2B outbound strategist for the Gulf and MENA. You define precise, reachable target segments and the web searches that find real companies in them.",
      prompt: [
        `Campaign type: ${input.kind === "partner" ? "recruit partners / resellers / referral partners" : "sell to end customers"}.`,
        "Offer:",
        offerText(input.offer) || "(no offer yet — assume a cloud ERP for SMEs in the Gulf)",
        input.existing.length ? `Already have these segments (propose different ones): ${input.existing.join("; ")}` : "",
        "",
        `Propose ${count} segments. Each must be narrow enough to search for (industry + country + size), and list the decision-maker titles to contact in priority order, and 6-10 concrete web-search queries that return individual company websites (e.g. "food distribution company Riyadh"), not directories or news. Countries default to the Gulf (Saudi Arabia, United Arab Emirates, Qatar, Kuwait, Bahrain, Oman) unless the offer says otherwise.`,
        'Return JSON: {"segments":[{"name": string, "description": string, "industries": string[], "countries": string[], "companySize": string, "titles": string[], "queries": string[], "fitScore": number 0-100, "why": string (1-2 sentences)}]}',
      ]
        .filter(Boolean)
        .join("\n"),
    });
    const list = Array.isArray(r.data?.segments) ? r.data.segments : Array.isArray(r.data) ? r.data : [];
    const have = new Set(input.existing.map((n) => n.toLowerCase()));
    const segments = list
      .map((s: any) => sanitizeSegmentInput(s))
      .filter((s: SegmentInput) => s.name && (s.queries?.length || 0) > 0 && !have.has(s.name.toLowerCase()))
      .slice(0, count);
    if (!segments.length) return fallback("The AI didn't return usable segments, so these are the standard ones. Try again or edit them.");
    return { segments };
  } catch (e: any) {
    const why = e instanceof LlmBudgetExceeded ? "today's AI budget is used up" : e instanceof LlmUnavailable ? "no AI provider answered" : String(e?.message || e);
    return fallback(`Couldn't get suggestions from the AI (${why}), so these are the standard segments.`);
  }
}
