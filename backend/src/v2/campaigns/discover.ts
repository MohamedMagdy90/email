// Step 3 — find companies for a segment. Gemini with Google Search grounding
// when a key exists, otherwise the free web search. Every company is reduced to
// its registrable domain; directories, social pages, our own domains, the
// do-not-contact lists and companies outside the target market are dropped;
// one prospect per company per campaign.
import { q, nowIso } from "../../db";
import { uid, parseJson } from "../events";
import { llm, LlmBudgetExceeded, LlmUnavailable } from "../llm";
import { CONTENT_BLOCK, OFFICIAL_BLOCK, SETUP_BLOCK, isContentTitle, searchRaw } from "../../search";
import { hostOf } from "../../crawler/urls";
import { isDirectoryHost, isJunkHost, isProfileHost } from "../../crawler/profiles";
import { normalizeCountry } from "../../country";
import { checkCandidate, type SkipRule } from "../targeting/check";
import { planFor, planKey, type EffectiveTargeting } from "../targeting/market";
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

export interface Screened {
  ok: boolean;
  domain: string | null;
  reason?: string;
  /** Set when a targeting rule (not a junk filter) dropped it. */
  rule?: SkipRule;
}

/** Would this search result be added? No writes. Shared by discovery and the targeting preview. */
export async function screenCandidate(cand: CandidateCompany, settings: CampaignSettings, eff: EffectiveTargeting | null): Promise<Screened> {
  const domain = domainOf(cand.website);
  if (!domain) return { ok: false, domain: null, reason: "Not a website address" };
  let host = domain;
  try {
    host = hostOf(/^https?:\/\//.test(cand.website) ? cand.website : `https://${cand.website}`);
  } catch {
    /* keep domain */
  }
  if (isJunkHost(host) || isProfileHost(host) || isDirectoryHost(host) || isJunkHost(domain) || isProfileHost(domain) || isDirectoryHost(domain)) {
    return { ok: false, domain, reason: "A directory, marketplace or social page, not a company site" };
  }
  if (CONTENT_BLOCK.test(domain) || SETUP_BLOCK.test(domain)) return { ok: false, domain, reason: "A lead database, listing site or company-setup agency, not a prospect" };
  if (OFFICIAL_BLOCK.test(domain)) return { ok: false, domain, reason: "A government body or regulator, not a prospect" };
  if (cand.title && isContentTitle(cand.title)) return { ok: false, domain, reason: `An article or list about companies ("${cand.title.slice(0, 60)}"), not a company` };
  const blocked = await domainBlockReason(domain, settings);
  if (blocked) return { ok: false, domain, reason: blocked };
  if (eff) {
    const t = checkCandidate({ domain, city: cand.city || null, country: cand.country || null }, eff);
    if (!t.ok) return { ok: false, domain, reason: t.reason, rule: t.rule };
  }
  return { ok: true, domain };
}

/** Add one company to a campaign. Returns null when added, else the reason it was skipped. */
export async function addCompany(
  campaignId: string,
  segmentId: string | null,
  cand: CandidateCompany,
  settings: CampaignSettings,
  source: "gemini" | "search" | "manual",
  why: string,
  eff: EffectiveTargeting | null = null
): Promise<{ added: boolean; domain: string | null; reason?: string; rule?: SkipRule }> {
  // Hand-added companies skip the place check here; research checks them fully.
  const s = await screenCandidate(cand, settings, source === "manual" ? null : eff);
  if (!s.ok || !s.domain) return { added: false, domain: s.domain, reason: s.reason, rule: s.rule };
  const domain = s.domain;

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
    `INSERT INTO prospects (id, campaign_id, segment_id, company_id, stage, stage_reason, lead_source, stage_changed_at, created_at, updated_at)
     VALUES (?,?,?,?, 'found', ?, ?, ?, ?, ?)`,
    [uid(), campaignId, segmentId, company.id, why.slice(0, 300), source, now, now, now]
  );
  if (segmentId) await q(`UPDATE segments SET found = found + 1, updated_at = ? WHERE id = ?`, [now, segmentId]);
  return { added: true, domain };
}

/** The (query, country) plan a segment walks. Countries come from the effective targeting when given. */
export function segmentPlan(seg: Row, eff?: EffectiveTargeting | null): { query: string; country: string }[] {
  const queries = parseJson<string[]>(seg.queries_json, []);
  const countries = eff?.countries?.length ? eff.countries : parseJson<string[]>(seg.countries_json, []);
  return planFor(queries, countries);
}

export async function searchWithGemini(query: string, country: string): Promise<CandidateCompany[]> {
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
      'Return JSON: {"companies":[{"name": string, "website": string (homepage URL), "city": string, "country": string}]}',
    ].join("\n"),
  });
  const list = Array.isArray(r.data?.companies) ? r.data.companies : Array.isArray(r.data) ? r.data : [];
  return list
    .filter((c: any) => c && typeof c.website === "string" && c.website.trim())
    .map((c: any) => ({
      name: typeof c.name === "string" ? c.name.trim() : undefined,
      website: c.website.trim(),
      city: typeof c.city === "string" ? c.city.trim() : undefined,
      country: (typeof c.country === "string" && normalizeCountry(c.country)) || country,
    }));
}

export async function searchFree(query: string, country: string): Promise<CandidateCompany[]> {
  const r = await searchRaw(query, country, 10);
  return r.sites.map((s) => ({ name: nameFromTitle(s.title || "", s.domain), website: s.url, country, title: s.title || "" }));
}

const MAX_SEARCHED = 600;

/**
 * Walk the segment's plan until `max` companies were added or `maxSearches`
 * searches ran. Steps already searched are remembered by (query, country) in
 * `segments.searched_json`, so regenerating the searches never repeats one, and
 * a rate-limited search is simply retried next pass.
 */
export async function discoverForSegment(
  campaignId: string,
  seg: Row,
  settings: CampaignSettings,
  opts: { max: number; maxSearches: number; canSearch: boolean; aiOk: boolean; eff?: EffectiveTargeting | null }
): Promise<{ added: number; searches: number; notes: string[]; aiStopped: boolean }> {
  const plan = segmentPlan(seg, opts.eff);
  const notes: string[] = [];
  const searched = parseJson<string[]>(seg.searched_json, []);
  const done = new Set(searched);
  let added = 0;
  let searches = 0;
  let aiStopped = false;
  if (!plan.length) {
    await q(`UPDATE segments SET exhausted = 1, updated_at = ? WHERE id = ?`, [nowIso(), seg.id]);
    return { added, searches, notes: [`"${seg.name}" has no searches. Pick an industry in Targeting, or add searches by hand.`], aiStopped };
  }
  for (const step of plan) {
    if (added >= opts.max || searches >= opts.maxSearches) break;
    const key = planKey(step);
    if (done.has(key)) continue;
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
      break; // not marked as searched, retried next pass
    }
    searches++;
    done.add(key);
    searched.push(key);
    let addedHere = 0;
    let offTarget = 0;
    const rejected: Record<string, number> = {};
    const examples: { domain: string | null; reason: string }[] = [];
    for (const cand of found) {
      if (added >= opts.max) break;
      const label = `${step.query}${step.country && !step.query.toLowerCase().includes(step.country.toLowerCase()) ? ` ${step.country}` : ""}`;
      const r = await addCompany(campaignId, String(seg.id), cand, settings, via, `Found by searching "${label}"`, opts.eff || null);
      if (r.added) {
        added++;
        addedHere++;
      } else {
        if (r.rule) offTarget++;
        const bucket = r.rule || (/Already in this campaign/.test(r.reason || "") ? "duplicate" : /do-not-contact|own domains/.test(r.reason || "") ? "excluded" : "junk");
        rejected[bucket] = (rejected[bucket] || 0) + 1;
        if (examples.length < 6) examples.push({ domain: r.domain, reason: String(r.reason || "").slice(0, 140) });
      }
    }
    // The search log (Targeting → segment detail).
    await q(`INSERT INTO segment_searches (id, segment_id, campaign_id, query, country, via, ran_at, results, added, rejected_json) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
      uid(),
      seg.id,
      campaignId,
      step.query.slice(0, 200),
      step.country || null,
      via,
      nowIso(),
      found.length,
      addedHere,
      JSON.stringify({ byRule: rejected, examples }),
    ]).catch(() => {});
    notes.push(`Searched "${step.query}"${step.country ? ` (${step.country})` : ""}: ${found.length} result(s), ${addedHere} new compan${addedHere === 1 ? "y" : "ies"}${offTarget ? `, ${offTarget} outside the target` : ""}.`);
  }
  const doneCount = plan.filter((p) => done.has(planKey(p))).length;
  const exhausted = doneCount >= plan.length ? 1 : 0;
  // (Status is the learning loop's business: Testing until enough leads are emailed.)
  await q(`UPDATE segments SET cursor = ?, exhausted = ?, searched_json = ?, updated_at = ? WHERE id = ?`, [
    doneCount,
    exhausted,
    JSON.stringify(searched.slice(-MAX_SEARCHED)),
    nowIso(),
    seg.id,
  ]);
  if (exhausted) notes.push(`"${seg.name}" has run all of its searches. Add cities or industries in Targeting, or suggest more segments, to keep finding companies.`);
  return { added, searches, notes, aiStopped };
}
