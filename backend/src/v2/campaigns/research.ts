// Step 4 — research a company once and share it across campaigns (reused for
// 90 days). AI turns the site into facts, people and specific hooks; without
// AI a heuristic pass still keeps the name, description, emails and phone.
import { q, nowIso } from "../../db";
import { llm } from "../llm";
import { extractEmails } from "../../crawler/extract";
import { cleanEmail, isValidEmail } from "../../crawler/validate";
import { normalizeCountry } from "../../country";
import { detectLanguage, fetchPage, metaDescription, nameFromTitle, phoneFrom, pickLinks, titleOf } from "./web";
import { researchJson, str, strList, type ResearchJson, type Row } from "./types";
import { classifyIndustry, sizeFromText } from "../targeting/taxonomy";

export const RESEARCH_TTL_DAYS = 90;
const SITE_TEXT_MAX = 8000;

const PEOPLE_PAGES = [
  /team|leadership|management|board|founder|our-people|executive|directors/,
  /about|who-we-are|our-story|company|profile/,
  /contact|get-in-touch|reach-us/,
  /من-نحن|فريق|الإدارة|تواصل|اتصل/,
];

export function researchIsFresh(co: Row, aiAvailable: boolean): boolean {
  if (!co.researched_at) return false;
  const age = Date.now() - Date.parse(String(co.researched_at));
  if (!(age < RESEARCH_TTL_DAYS * 86400000)) return false;
  // A heuristic-only pass is redone once AI is available.
  if (co.research_status === "partial" && aiAvailable) return false;
  return co.research_status === "ok" || co.research_status === "partial" || co.research_status === "blocked";
}

/** Thrown AI errors (budget / unavailable) propagate so the pass can stop AI work. */
export async function researchCompany(co: Row, opts: { ai: boolean }): Promise<{ status: "ok" | "partial" | "blocked"; note: string }> {
  const domain = String(co.domain);
  const home = await fetchPage(co.website || `https://${domain}`, 6000);
  const now = nowIso();
  if (!home.ok) {
    const rj: ResearchJson = { ...researchJson(co.research_json), sources: [] };
    await q(`UPDATE companies SET research_status = 'blocked', researched_at = ?, research_json = ?, updated_at = ? WHERE id = ?`, [now, JSON.stringify(rj), now, co.id]);
    return { status: "blocked", note: `Couldn't read ${domain} (${home.blocked ? "the site blocks automated visits" : home.error || "no content"}).` };
  }
  const pages = [home];
  for (const url of pickLinks(home.html, home.url, PEOPLE_PAGES, 4)) {
    const p = await fetchPage(url, 4000);
    if (p.ok && p.text.length > 120) pages.push(p);
  }
  const allHtml = pages.map((p) => p.html).join("\n");
  const emails: string[] = [];
  for (const hit of extractEmails(allHtml)) {
    const e = cleanEmail(hit.email);
    if (e && isValidEmail(e) && !emails.includes(e)) emails.push(e);
  }
  const onDomain = emails.filter((e) => e.endsWith(`@${domain}`) || e.endsWith(`.${domain}`));
  const emailsOnSite = [...onDomain, ...emails.filter((e) => !onDomain.includes(e))].slice(0, 15);
  const phone = pages.map((p) => phoneFrom(p.html)).find(Boolean) || co.phone || null;
  const language = detectLanguage(home.text);
  const title = titleOf(home.html);
  const heuristicName = co.name || nameFromTitle(title, domain);
  const heuristicDesc = metaDescription(home.html) || home.text.split("\n").find((l) => l.length > 60 && l.length < 300) || null;
  const sources = pages.map((p) => p.url);
  // Kept for the target check (keywords, size, industry): the visible text of the pages read.
  const siteText = pages.map((p) => p.text).join("\n").slice(0, SITE_TEXT_MAX);

  if (!opts.ai) {
    const rj: ResearchJson = { hooks: [], people: [], emailsOnSite, sources };
    const size = sizeFromText(null, siteText);
    const industry = classifyIndustry({ name: heuristicName, description: heuristicDesc, text: siteText });
    await q(
      `UPDATE companies SET name = ?, description = COALESCE(description, ?), phone = ?, emails_json = ?, research_json = ?, language = ?,
              site_text = ?, size_band = ?, industry_id = ?, research_status = 'partial', researched_at = ?, updated_at = ? WHERE id = ?`,
      [heuristicName, heuristicDesc, phone, JSON.stringify(emailsOnSite), JSON.stringify(rj), language, siteText, size.band, industry.id, now, now, co.id]
    );
    return { status: "partial", note: `Read ${pages.length} page(s) of ${domain} without AI: ${emailsOnSite.length} address(es) found, no people yet.` };
  }

  const corpus = pages.map((p) => `### ${p.url}\n${p.text}`).join("\n\n").slice(0, 14000);
  const r = await llm<any>({
    tier: "smart",
    json: true,
    task: `campaign:research:${domain}`,
    temperature: 0.1,
    system:
      "You research companies for B2B sales. Extract only facts present on the pages. Hooks must be specific and checkable (a project, a branch opening, a product line, a certification, hiring, a client sector) — never generic praise. People must be named on the pages with their role.",
    prompt: [
      `Company website: ${domain}`,
      emailsOnSite.length ? `Email addresses found on the site: ${emailsOnSite.join(", ")}` : "",
      "Pages:",
      corpus,
      "",
      'Return JSON: {"name": string, "description": string (1-2 factual sentences: what they do, for whom), "industry": string, "sizeHint": string (e.g. "about 50 staff", "3 branches", "" if unknown), "city": string, "country": string, "people": [{"name": string, "title": string, "email": string|null}], "hooks": string[] (2-4), "linkedinUrl": string|null (company page only, if linked on the site), "language": "en"|"ar"|"mixed"}',
    ]
      .filter(Boolean)
      .join("\n"),
  });
  const d = r.data && typeof r.data === "object" ? r.data : {};
  const people = (Array.isArray(d.people) ? d.people : [])
    .filter((p: any) => p && typeof p.name === "string" && p.name.trim().length >= 3 && !/^(our|the) team$/i.test(p.name))
    .slice(0, 15)
    .map((p: any) => {
      const e = p.email ? cleanEmail(String(p.email)) : null;
      return { name: str(p.name, 100), title: str(p.title, 120), email: e && isValidEmail(e) ? e : null };
    });
  const rj: ResearchJson = { hooks: strList(d.hooks, 4, 300), people, emailsOnSite, sources, summary: str(d.description, 500) || undefined };
  const linkedin = typeof d.linkedinUrl === "string" && /linkedin\.com\/company\//i.test(d.linkedinUrl) ? d.linkedinUrl.slice(0, 300) : co.linkedin_url || null;
  const country = normalizeCountry(str(d.country, 60)) || str(d.country, 60) || co.country || null;
  const name = str(d.name, 120) || heuristicName;
  const description = str(d.description, 500) || heuristicDesc;
  const aiIndustry = str(d.industry, 80) || co.industry || null;
  const sizeHint = str(d.sizeHint, 80) || null;
  const size = sizeFromText(sizeHint, siteText);
  const industry = classifyIndustry({ aiIndustry, name, description, text: siteText });
  await q(
    `UPDATE companies SET name = ?, description = ?, industry = ?, size_hint = ?, city = ?, country = ?, phone = ?, linkedin_url = ?,
            emails_json = ?, people_json = ?, research_json = ?, language = ?, site_text = ?, size_band = ?, industry_id = ?,
            research_status = 'ok', researched_at = ?, updated_at = ? WHERE id = ?`,
    [
      name,
      description,
      aiIndustry,
      sizeHint,
      str(d.city, 80) || co.city || null,
      country,
      phone,
      linkedin,
      JSON.stringify(emailsOnSite),
      JSON.stringify(people),
      JSON.stringify(rj),
      ["en", "ar", "mixed"].includes(d.language) ? d.language : language,
      siteText,
      size.band,
      industry.id,
      now,
      now,
      co.id,
    ]
  );
  return { status: "ok", note: `Researched ${domain}: ${people.length} named people, ${rj.hooks.length} hook(s), ${emailsOnSite.length} address(es).` };
}
