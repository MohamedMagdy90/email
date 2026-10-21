// Step 1 — learn what we sell from the website (AI), or fall back to the
// agent's knowledge base so the user always gets an editable starting point.
import { getAgentSettings } from "../agent-settings";
import { aiStatus, llm, LlmBudgetExceeded, LlmUnavailable } from "../llm";
import { nowIso } from "../../db";
import { fetchPage, pickLinks, toUrl } from "./web";
import { sanitizeOffer, type CampaignKind, type Offer } from "./types";

const GULF = ["Saudi Arabia", "United Arab Emirates", "Qatar", "Kuwait", "Bahrain", "Oman"];

const PAGE_PATTERNS = [/about|who-we-are|our-story|company/, /product|solution|module|feature|platform/, /pricing|plans|price/, /industr|sector|customer|case|success/, /partner|reseller|makers/, /why/];

export async function fallbackOffer(kind: CampaignKind, website: string, pages: string[] = []): Promise<Offer> {
  const a = await getAgentSettings();
  const lines = a.knowledgeBase
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  return sanitizeOffer(
    {
      product: a.companyName,
      oneLiner: lines[0] || `${a.companyName} — ${website}`,
      valueProps: lines.slice(1, 4),
      proof: [],
      differentiators: lines.filter((l) => /arabic|zatca|vat|cloud|implementation|support/i.test(l)).slice(0, 3),
      pricing: lines.find((l) => /price|pricing|trial|commission|%/i.test(l)) || "",
      regions: GULF,
      idealCustomers:
        kind === "partner"
          ? ["Accounting and audit firms", "IT resellers and system integrators", "ERP consultancies", "Regional software distributors"]
          : ["Growing trading and distribution companies", "Manufacturers with stock and production", "Retail and multi-branch businesses", "Contracting and services companies"],
      competitors: [],
      learnedAt: nowIso(),
      pages,
    },
    "fallback"
  );
}

export async function learnOffer(kind: CampaignKind, websiteInput: string): Promise<{ offer: Offer; website: string; warning?: string }> {
  const a = await getAgentSettings();
  const website = toUrl(websiteInput || a.website || "https://dna.systems");
  const home = await fetchPage(website, 7000);
  const pages: { url: string; text: string }[] = [];
  if (home.ok) {
    pages.push({ url: home.url, text: home.text });
    for (const url of pickLinks(home.html, home.url, PAGE_PATTERNS, 4)) {
      const p = await fetchPage(url, 4000);
      if (p.ok && p.text.length > 200) pages.push({ url: p.url, text: p.text });
    }
  }
  const urls = pages.map((p) => p.url);
  const status = await aiStatus();
  if (!status.configured) {
    return { offer: await fallbackOffer(kind, website, urls), website, warning: "No AI key yet, so this was filled in from the agent's knowledge base. Edit it, or connect an AI key in the Agent tab and learn it again." };
  }
  if (!pages.length) {
    return { offer: await fallbackOffer(kind, website, []), website, warning: `Couldn't read ${website} (${home.error || "no content"}), so this was filled in from the agent's knowledge base. Check the address and try again.` };
  }
  const corpus = pages.map((p) => `### ${p.url}\n${p.text}`).join("\n\n").slice(0, 16000);
  try {
    const r = await llm<any>({
      tier: "smart",
      json: true,
      task: "campaign:offer",
      temperature: 0.2,
      system:
        "You are a B2B go-to-market analyst. You read a company's website and describe exactly what it sells, to whom, and why it matters, using only facts on the pages. Never invent customers, numbers, awards or prices.",
      prompt: [
        `Campaign type: ${kind === "partner" ? "recruit partners / resellers" : "sell to end customers"}.`,
        `Known facts from the team (trusted): ${a.knowledgeBase.replace(/\n+/g, " ")}`,
        "Website pages:",
        corpus,
        "",
        'Return JSON: {"product": string, "oneLiner": string (one sentence: what it is and for whom), "valueProps": string[] (3-6 concrete outcomes), "proof": string[] (facts stated on the site only; [] if none), "differentiators": string[], "pricing": string ("" if not stated), "regions": string[] (countries/regions served), "idealCustomers": string[] (3-5 plain-English descriptions of who should buy' +
          (kind === "partner" ? " or resell" : "") +
          '), "competitors": string[] (named on the site or obvious category alternatives; [] if unsure)}',
      ].join("\n"),
    });
    if (!r.data || typeof r.data !== "object") throw new Error("The AI answer wasn't valid JSON");
    const offer = sanitizeOffer({ ...r.data, learnedAt: nowIso(), pages: urls }, "ai");
    if (!offer.product) offer.product = a.companyName;
    if (!offer.regions.length) offer.regions = GULF;
    return { offer, website };
  } catch (e: any) {
    const why = e instanceof LlmBudgetExceeded ? "today's AI budget is used up" : e instanceof LlmUnavailable ? "no AI provider answered" : String(e?.message || e);
    return { offer: await fallbackOffer(kind, website, urls), website, warning: `Couldn't learn the offer with AI (${why}), so this was filled in from the agent's knowledge base.` };
  }
}
