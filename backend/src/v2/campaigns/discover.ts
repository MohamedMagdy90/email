// Step 3 — find companies for a segment. Gemini with Google Search grounding
// when a key exists, otherwise the free web search. Every company is reduced to
// its registrable domain; directories, social pages, our own domains and the
// do-not-contact list are dropped; one prospect per company per campaign.
import { q, nowIso } from "../../db";
import { uid, parseJson } from "../events";
import { llm, LlmBudgetExceeded, LlmUnavailable } from "../llm";
import { CONTENT_BLOCK, OFFICIAL_BLOCK, SETUP_BLOCK, isContentTitle, searchRaw } from "../../search";
import { hostOf } from "../../crawler/urls";
import { isDirectoryHost, isJunkHost, isProfileHost } from "../../crawler/profiles";
import { normalizeCountry } from "../../country";
import { domainBlockReason, domainOf } from "./suppression";
import { nameFromTitle } from "./web";
import type { CampaignSettings, Row } from "./types";

export interface CandidateCompany {
  name?: string;
  website: string;
  city?: string;
  country?: string;
  /** Raw search-result title, used to drop listicles / directories / articles. */
  title?: string;
}

/** Add one company to a campaign. Returns null when added, else the reason it was skipped. */
export async function addCompany(
  campaignId: string,
  segmentId: string | null,
  cand: CandidateCompany,
  settings: CampaignSettings,
  source: "gemini" | "search" | "manual",
  why: string
): Promise<{ added: boolean; domain: string | null; reason?: string }> {
  const domain = domainOf(cand.website);
  if (!domain) return { added: false, domain: null, reason: "Not a website address" };
  let host = domain;
  try {
    host = hostOf(/^https?:\/\//.test(cand.website) ? cand.website : `https://${cand.website}`);
  } catch {
    /* keep domain */
  }
  if (isJunkHost(host) || isProfileHost(host) || isDirectoryHost(host) || isJunkHost(domain) || isProfileHost(domain) || isDirectoryHost(domain)) {
    return { added: false, domain, reason: "A directory, marketplace or social page, not a company site" };
  }
  if (CONTENT_BLOCK.test(domain) || SETUP_BLOCK.test(domain)) return { added: false, domain, reason: "A lead database, listing site or company-setup agency, not a prospect" };
  if (OFFICIAL_BLOCK.test(domain)) return { added: false, domain, reason: "A government body or regulator, not a prospect" };
  if (cand.title && isContentTitle(cand.title)) return { added: false, domain, reason: `An article or list about companies ("${cand.title.slice(0, 60)}"), not a company` };
  const blocked = await domainBlockReason(domain, settings);
  if (blocked) return { added: false, domain, reason: blocked };

  const now = nowIso();
  let company = (await q(`SELECT id FROM companies WHERE domain = ?`, [domain]))[0];
  if (!company) {
    const id = uid();
    const country = normalizeCountry(cand.country || "") || cand.country || null;
    await q(
      `INSERT INTO companies (id, domain, name, website, country, city, source, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (domain) DO NOTHING`,
      [id, domain, cand.name ? cand.name.slice(0, 120) : null, `https://${domain}`, country, cand.city ? cand.city.slice(0, 80) : null, source, now, now]
    );
    company = (await q(`SELECT id FROM companies WHERE domain = ?`, [domain]))[0];
  }
  if (!company) return { added: false, domain, reason: "Couldn't save the company" };
  const dup = (await q(`SELECT id FROM prospects WHERE campaign_id = ? AND company_id = ? LIMIT 1`, [campaignId, company.id]))[0];
  if (dup) return { added: false, domain, reason: "Already in this campaign" };
  await q(
    `INSERT INTO prospects (id, campaign_id, segment_id, company_id, stage, stage_reason, stage_changed_at, created_at, updated_at)
     VALUES (?,?,?,?, 'found', ?, ?, ?, ?)`,
    [uid(), campaignId, segmentId, company.id, why.slice(0, 300), now, now, now]
  );
  if (segmentId) await q(`UPDATE segments SET found = found + 1, updated_at = ? WHERE id = ?`, [now, segmentId]);
  return { added: true, domain };
}

/** The (query, country) plan a segment walks with its cursor. */
export function segmentPlan(seg: Row): { query: string; country: string }[] {
  const queries = parseJson<string[]>(seg.queries_json, []);
  const countries = parseJson<string[]>(seg.countries_json, []);
  const plan: { query: string; country: string }[] = [];
  for (const query of queries) {
    const mentions = countries.find((c) => query.toLowerCase().includes(c.toLowerCase()));
    if (mentions || !countries.length || /riyadh|jeddah|dammam|dubai|sharjah|abu dhabi|doha|kuwait|manama|muscat|cairo|amman/i.test(query)) {
      plan.push({ query, country: mentions || countries[0] || "" });
    } else {
      for (const country of countries) plan.push({ query, country });
    }
  }
  return plan;
}

async function searchWithGemini(query: string, country: string): Promise<CandidateCompany[]> {
  const r = await llm<any>({
    tier: "smart",
    search: true,
    json: true,
    task: `campaign:discover:${query.slice(0, 40)}`,
    temperature: 0.2,
    system: "You find real, currently operating companies using Google Search. You only return companies you found in the search results, each with its own official website.",
    prompt: [
      `Find up to 10 real companies matching: "${query}"${country ? ` in ${country}` : ""}.`,
      "Only companies with their own website (not directories, marketplaces, job boards, news sites, government portals or social media pages).",
      'Return JSON: {"companies":[{"name": string, "website": string (homepage URL), "city": string}]}',
    ].join("\n"),
  });
  const list = Array.isArray(r.data?.companies) ? r.data.companies : Array.isArray(r.data) ? r.data : [];
  return list
    .filter((c: any) => c && typeof c.website === "string" && c.website.trim())
    .map((c: any) => ({ name: typeof c.name === "string" ? c.name.trim() : undefined, website: c.website.trim(), city: typeof c.city === "string" ? c.city.trim() : undefined, country }));
}

async function searchFree(query: string, country: string): Promise<CandidateCompany[]> {
  const r = await searchRaw(query, country, 10);
  return r.sites.map((s) => ({ name: nameFromTitle(s.title || "", s.domain), website: s.url, country, title: s.title || "" }));
}

/**
 * Walk the segment's plan from its cursor until `max` companies were added or
 * `maxSearches` searches ran. Advances the cursor only for searches that
 * actually ran, so a rate-limited search is retried next pass.
 */
export async function discoverForSegment(
  campaignId: string,
  seg: Row,
  settings: CampaignSettings,
  opts: { max: number; maxSearches: number; canSearch: boolean; aiOk: boolean }
): Promise<{ added: number; searches: number; notes: string[]; aiStopped: boolean }> {
  const plan = segmentPlan(seg);
  const notes: string[] = [];
  let cursor = Number(seg.cursor) || 0;
  let added = 0;
  let searches = 0;
  let aiStopped = false;
  if (!plan.length) {
    await q(`UPDATE segments SET exhausted = 1, updated_at = ? WHERE id = ?`, [nowIso(), seg.id]);
    return { added, searches, notes: [`"${seg.name}" has no search queries. Add a few in Segments.`], aiStopped };
  }
  while (added < opts.max && searches < opts.maxSearches && cursor < plan.length) {
    const step = plan[cursor];
    let found: CandidateCompany[] = [];
    let via: "gemini" | "search" = "search";
    try {
      if (opts.canSearch && opts.aiOk) {
        via = "gemini";
        found = await searchWithGemini(step.query, step.country);
      } else {
        found = await searchFree(step.query, step.country);
      }
    } catch (e: any) {
      if (e instanceof LlmBudgetExceeded || e instanceof LlmUnavailable) {
        aiStopped = true;
        notes.push(`Search with Gemini stopped: ${e instanceof LlmBudgetExceeded ? "today's AI budget is used up" : "no AI provider answered"}.`);
      } else {
        notes.push(`Search for "${step.query}" didn't run: ${String(e?.message || e).slice(0, 160)}`);
      }
      break; // cursor stays, retried next pass
    }
    searches++;
    cursor++;
    let addedHere = 0;
    for (const cand of found) {
      if (added >= opts.max) break;
      const r = await addCompany(campaignId, String(seg.id), cand, settings, via, `Found by searching "${step.query}${step.country && !step.query.toLowerCase().includes(step.country.toLowerCase()) ? ` ${step.country}` : ""}"`);
      if (r.added) {
        added++;
        addedHere++;
      }
    }
    notes.push(`Searched "${step.query}"${step.country ? ` (${step.country})` : ""}: ${found.length} result(s), ${addedHere} new compan${addedHere === 1 ? "y" : "ies"}.`);
  }
  const exhausted = cursor >= plan.length ? 1 : 0;
  await q(`UPDATE segments SET cursor = ?, exhausted = ?, status = CASE WHEN enabled = 1 THEN 'working' ELSE status END, updated_at = ? WHERE id = ?`, [cursor, exhausted, nowIso(), seg.id]);
  if (exhausted) notes.push(`"${seg.name}" has searched all of its queries. Add new queries or suggest more segments to keep finding companies.`);
  return { added, searches, notes, aiStopped };
}
