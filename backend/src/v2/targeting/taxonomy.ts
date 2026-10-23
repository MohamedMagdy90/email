// Targeting vocabulary: the industries an SME ERP sells to in the Gulf, the
// partner types for partner campaigns, the industries we exclude by default,
// size bands, and the title presets. Each industry carries the phrases used to
// GENERATE searches (English + Arabic) and the words used to CLASSIFY a
// researched company (so "excluded industry" is a rule, not a hope).

export type IndustryKind = "customer" | "partner" | "exclude";

export interface Industry {
  id: string;
  label: string;
  kind: IndustryKind;
  /** Search phrases, best first; combined with a city or country. */
  en: string[];
  ar: string[];
  /** Lower-case words / stems that classify a company into this industry (English + Arabic). */
  match: string[];
}

export const INDUSTRIES: Industry[] = [
  /* ------------------------------ customers ----------------------------- */
  { id: "wholesale_distribution", label: "Wholesale & distribution", kind: "customer", en: ["wholesale distributor", "distribution company"], ar: ["شركة توزيع"], match: ["wholesale", "distributor", "distribution", "توزيع", "جملة"] },
  { id: "food_distribution", label: "Food & FMCG distribution", kind: "customer", en: ["food distributor", "FMCG distribution company"], ar: ["موزع مواد غذائية"], match: ["food distribut", "fmcg", "foodstuff", "food trading", "مواد غذائية"] },
  { id: "trading", label: "Import / export trading", kind: "customer", en: ["trading company", "import export company"], ar: ["شركة تجارية", "شركة استيراد وتصدير"], match: ["trading", "import", "export", "تجارة", "تجارية", "استيراد"] },
  { id: "manufacturing", label: "Manufacturing (general)", kind: "customer", en: ["manufacturing company", "factory"], ar: ["مصنع"], match: ["manufactur", "factory", "factories", "industrial", "مصنع", "تصنيع"] },
  { id: "food_manufacturing", label: "Food & beverage manufacturing", kind: "customer", en: ["food factory", "food manufacturing company"], ar: ["مصنع أغذية"], match: ["food manufactur", "food processing", "bakery", "dairy", "beverage", "bottling", "مصنع أغذية", "ألبان", "مخابز"] },
  { id: "plastics_packaging", label: "Plastics & packaging", kind: "customer", en: ["plastic products manufacturer", "packaging company"], ar: ["مصنع بلاستيك", "مصنع تغليف"], match: ["plastic", "packaging", "carton", "بلاستيك", "تغليف"] },
  { id: "metal_fabrication", label: "Metal & steel fabrication", kind: "customer", en: ["steel fabrication company", "metal works company"], ar: ["مصنع حديد", "ورشة حدادة"], match: ["steel", "metal", "fabricat", "aluminium", "aluminum", "حديد", "معادن", "ألمنيوم"] },
  { id: "furniture", label: "Furniture & woodwork", kind: "customer", en: ["furniture manufacturer", "furniture company"], ar: ["مصنع أثاث"], match: ["furniture", "joinery", "woodwork", "أثاث", "نجارة"] },
  { id: "chemicals", label: "Chemicals & paints", kind: "customer", en: ["chemical company", "paints manufacturer"], ar: ["شركة كيماويات", "مصنع دهانات"], match: ["chemical", "paint", "coating", "كيماويات", "دهانات"] },
  { id: "building_materials", label: "Building materials", kind: "customer", en: ["building materials supplier", "building materials trading company"], ar: ["مواد بناء"], match: ["building material", "construction material", "cement", "tiles", "sanitary ware", "مواد بناء", "مواد البناء"] },
  { id: "retail_chain", label: "Retail chains", kind: "customer", en: ["retail chain", "retail stores"], ar: ["سلسلة متاجر"], match: ["retail", "stores", "supermarket", "hypermarket", "showroom", "متاجر", "تجزئة"] },
  { id: "restaurants", label: "Restaurants & F&B groups", kind: "customer", en: ["restaurant group", "catering company"], ar: ["مجموعة مطاعم", "شركة تموين"], match: ["restaurant", "cafe", "catering", "f&b", "food and beverage", "مطاعم", "مطعم", "تموين"] },
  { id: "pharma_medical", label: "Pharmacies & medical supplies", kind: "customer", en: ["pharmacy chain", "medical supplies company"], ar: ["شركة مستلزمات طبية", "صيدليات"], match: ["pharmac", "medical suppl", "medical equipment", "medical devices", "صيدلي", "صيدليات", "مستلزمات طبية"] },
  { id: "clinics", label: "Clinics & healthcare", kind: "customer", en: ["medical center", "polyclinic"], ar: ["مجمع طبي"], match: ["clinic", "medical center", "medical centre", "hospital", "dental", "عيادة", "عيادات", "مستشفى", "مجمع طبي"] },
  { id: "contracting", label: "Contracting & construction", kind: "customer", en: ["contracting company", "construction company"], ar: ["شركة مقاولات"], match: ["contracting", "construction", "contractor", "civil works", "مقاولات", "إنشاءات"] },
  { id: "mep_fm", label: "MEP & facility management", kind: "customer", en: ["MEP contractor", "facility management company"], ar: ["شركة صيانة", "شركة إدارة مرافق"], match: ["mep", "hvac", "electromechanical", "facility management", "facilities management", "maintenance", "صيانة", "مرافق", "تكييف"] },
  { id: "logistics", label: "Logistics & freight", kind: "customer", en: ["logistics company", "freight forwarder"], ar: ["شركة شحن", "شركة خدمات لوجستية"], match: ["logistic", "freight", "shipping", "cargo", "warehousing", "transport", "شحن", "لوجستي", "نقل"] },
  { id: "auto_parts", label: "Auto parts & workshops", kind: "customer", en: ["auto spare parts dealer", "car service center"], ar: ["قطع غيار سيارات"], match: ["spare part", "auto part", "automotive", "car service", "tyres", "tires", "قطع غيار", "سيارات"] },
  { id: "electronics", label: "Electronics & IT retail", kind: "customer", en: ["electronics store", "computer store"], ar: ["متجر إلكترونيات"], match: ["electronics", "mobile phones", "computers", "gadgets", "إلكترونيات", "جوالات"] },
  { id: "fashion", label: "Fashion & textiles", kind: "customer", en: ["clothing company", "textile company"], ar: ["شركة ملابس", "شركة أقمشة"], match: ["fashion", "clothing", "apparel", "textile", "garment", "abaya", "ملابس", "أقمشة", "عبايات"] },
  { id: "cosmetics", label: "Cosmetics & perfumes", kind: "customer", en: ["perfume company", "cosmetics distributor"], ar: ["شركة عطور"], match: ["cosmetic", "perfume", "fragrance", "oud", "beauty products", "عطور", "تجميل"] },
  { id: "printing", label: "Printing & signage", kind: "customer", en: ["printing press", "printing company"], ar: ["مطبعة"], match: ["printing", "print shop", "signage", "مطبعة", "طباعة"] },
  { id: "agriculture", label: "Agriculture & food production", kind: "customer", en: ["agricultural company", "poultry farm"], ar: ["شركة زراعية"], match: ["agricultur", "farm", "poultry", "dates", "livestock", "زراعي", "زراعية", "مزارع", "دواجن", "تمور"] },
  { id: "hospitality", label: "Hotels & hospitality", kind: "customer", en: ["hotel apartments", "hospitality company"], ar: ["شقق فندقية"], match: ["hotel", "resort", "hospitality", "فندق", "فندقية"] },
  { id: "training_centres", label: "Private training centres", kind: "customer", en: ["training center", "training institute"], ar: ["مركز تدريب"], match: ["training center", "training centre", "training institute", "مركز تدريب", "معهد تدريب"] },
  { id: "professional_services", label: "Professional services", kind: "customer", en: ["consulting firm", "engineering consultancy"], ar: ["مكتب استشارات"], match: ["consultancy", "consulting", "consultants", "engineering office", "استشارات", "استشارية"] },

  /* ------------------------------- partners ----------------------------- */
  { id: "accounting_audit", label: "Accounting & audit firms", kind: "partner", en: ["accounting firm", "audit firm", "chartered accountants"], ar: ["مكتب محاسبة", "مكتب تدقيق حسابات"], match: ["accounting", "accountants", "audit", "bookkeeping", "محاسب", "محاسبة", "تدقيق", "مراجعة حسابات"] },
  { id: "tax_vat", label: "Tax / VAT consultants", kind: "partner", en: ["VAT consultants", "tax consultancy"], ar: ["استشارات ضريبية"], match: ["vat", "tax", "zakat", "ضريب", "زكاة"] },
  { id: "it_services", label: "IT services & integrators", kind: "partner", en: ["IT solutions company", "system integrator"], ar: ["شركة حلول تقنية"], match: ["it solutions", "it services", "system integrat", "managed services", "تقنية المعلومات", "حلول تقنية"] },
  { id: "pos_resellers", label: "POS & hardware resellers", kind: "partner", en: ["POS solutions provider", "POS systems dealer"], ar: ["أنظمة نقاط البيع"], match: ["point of sale", "pos system", "pos solution", "barcode", "cash register", "نقاط البيع", "كاشير"] },
  { id: "erp_consultancy", label: "ERP consultancies", kind: "partner", en: ["ERP consultancy", "ERP implementation partner"], ar: ["شركة استشارات أنظمة ERP"], match: ["erp consult", "erp implementation", "odoo", "sap partner", "implementation partner", "تخطيط موارد المؤسسات"] },
  { id: "software_distributor", label: "Software distributors & resellers", kind: "partner", en: ["software reseller", "software distributor"], ar: ["موزع برمجيات"], match: ["software reseller", "software distribut", "licensing", "موزع برمجيات"] },

  /* ---------------------------- exclude only ---------------------------- */
  { id: "government", label: "Government & public sector", kind: "exclude", en: [], ar: [], match: ["ministry", "municipality", "government", "royal commission", "public authority", "وزارة", "بلدية", "حكومي", "حكومية", "أمانة منطقة"] },
  { id: "education", label: "Schools & universities", kind: "exclude", en: [], ar: [], match: ["school", "university", "college", "kindergarten", "مدرسة", "مدارس", "جامعة", "كلية", "روضة"] },
  { id: "ngo", label: "Charities & non-profits", kind: "exclude", en: [], ar: [], match: ["charity", "charitable", "non-profit", "nonprofit", "ngo", "جمعية خيرية", "مؤسسة خيرية", "غير ربحية"] },
  { id: "software_vendor", label: "Software & ERP vendors", kind: "exclude", en: [], ar: [], match: ["erp software", "erp system", "erp solution", "software company", "saas", "accounting software", "cloud software", "برنامج محاسبة", "نظام محاسبي", "برمجيات"] },
];

export const INDUSTRY_BY_ID = new Map(INDUSTRIES.map((i) => [i.id, i]));

/** Excluded by default: government, schools, charities; customer campaigns also skip software / ERP vendors (competitors). */
export function defaultExcludedIndustries(kind: "customer" | "partner"): string[] {
  return kind === "partner" ? ["government", "education", "ngo"] : ["government", "education", "ngo", "software_vendor"];
}

/* --------------------------- classification --------------------------- */

function plain(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "");
}

function hits(hay: string, term: string): number {
  if (!hay || !term) return 0;
  // Latin terms match at a word start ("distribut" -> "distribution"); Arabic as substrings.
  if (/^[\x00-\x7f]+$/.test(term)) {
    const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
    return (hay.match(re) || []).length;
  }
  return hay.split(term).length - 1;
}

export interface Classification {
  id: string | null;
  score: number;
  ranked: { id: string; score: number }[];
}

/**
 * Best industry for a company. The AI's industry label counts most, then the
 * name and description, then the site text (capped so a long page can't win on volume).
 */
export function classifyIndustry(input: { aiIndustry?: string | null; name?: string | null; description?: string | null; text?: string | null }): Classification {
  const ai = plain(input.aiIndustry || "");
  const head = plain(`${input.name || ""} ${input.description || ""}`);
  const body = plain(String(input.text || "").slice(0, 6000));
  const ranked: { id: string; score: number }[] = [];
  for (const ind of INDUSTRIES) {
    let score = 0;
    let bodyHits = 0;
    for (const t of ind.match) {
      const term = plain(t);
      // Specific phrases beat single words: "food distribut" outranks "distribution".
      const weight = term.split(/\s+/).length;
      score += (hits(ai, term) * 4 + hits(head, term) * 2) * weight;
      bodyHits += hits(body, term);
    }
    score += Math.min(4, bodyHits);
    if (score > 0) ranked.push({ id: ind.id, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return { id: ranked[0]?.score >= 2 ? ranked[0].id : null, score: ranked[0]?.score || 0, ranked: ranked.slice(0, 5) };
}

/* -------------------------------- size -------------------------------- */

export const SIZE_BANDS = ["1-10", "11-50", "51-200", "201-500", "500+"] as const;
export type SizeBand = (typeof SIZE_BANDS)[number];

export function bandForEmployees(n: number): SizeBand {
  if (n <= 10) return "1-10";
  if (n <= 50) return "11-50";
  if (n <= 200) return "51-200";
  if (n <= 500) return "201-500";
  return "500+";
}

const toAsciiDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));

/**
 * Employees and branches from a size hint ("about 50 staff", "3 branches",
 * "200-500 employees") and, failing that, the site text. Null when unknown.
 */
export function sizeFromText(hint?: string | null, text?: string | null): { band: SizeBand | null; employees: number | null; branches: number | null } {
  const sources = [hint || "", String(text || "").slice(0, 8000)].map((s) => toAsciiDigits(s).replace(/(\d),(\d{3})/g, "$1$2"));
  let employees: number | null = null;
  let branches: number | null = null;
  for (const s of sources) {
    if (employees == null) {
      const range = s.match(/(\d{1,6})\s*(?:-|–|to)\s*(\d{1,6})\s*\+?\s*(?:employees|staff|people|workers|team members|موظف|موظفا|عامل)/i);
      const single =
        s.match(/(\d{1,6})\s*\+?\s*(?:full[- ]time\s+)?(?:employees|staff|people|workers|team members|professionals|engineers|technicians|موظف|موظفا|موظفين|عامل|عاملا)/i) ||
        s.match(/(?:team|workforce|staff)\s+of\s+(?:over\s+|more than\s+|about\s+)?(\d{1,6})/i);
      if (range) employees = Math.round((Number(range[1]) + Number(range[2])) / 2);
      else if (single) employees = Number(single[1]);
      if (employees != null && (employees < 1 || employees > 500000)) employees = null;
    }
    if (branches == null) {
      const b = s.match(/(\d{1,4})\s*\+?\s*(?:branches|outlets|stores|showrooms|locations|restaurants|pharmacies|فرع|فروع|فرعا)/i);
      if (b && Number(b[1]) > 0 && Number(b[1]) < 5000) branches = Number(b[1]);
    }
    if (employees != null && branches != null) break;
  }
  return { band: employees != null ? bandForEmployees(employees) : null, employees, branches };
}

/* ------------------------------- titles ------------------------------- */

export const TITLE_PRESETS = {
  customer: ["Owner", "CEO", "General Manager", "Managing Director", "CFO", "Finance Manager", "Operations Manager"],
  partner: ["Managing Partner", "Founder", "CEO", "Partner", "Sales Director", "Business Development Manager"],
};

export const DEFAULT_EXCLUDED_TITLES = ["HR", "Human Resources", "Recruitment", "Talent", "Marketing", "Intern", "Assistant", "Receptionist", "Secretary"];

const SENIOR_RE =
  /\b(owner|founder|co-?founder|chairman|president|partner|principal|chief|ceo|cfo|coo|cto|cio|cco|gm|vp|vice president|director|head|manager|lead)\b|مدير|رئيس|مالك|مؤسس|شريك/i;

export function isSenior(title: string): boolean {
  return SENIOR_RE.test(String(title || ""));
}
