// Targeting service — the setup side of §8.4: the target market per campaign,
// re-checking leads after the market changes, previewing a segment's searches
// and sample companies, and the global do-not-contact list.
import { q, nowIso } from "../../db";
import { logEvent, parseJson, uid } from "../events";
import { aiStatus, budgetRemaining, LlmBudgetExceeded, LlmUnavailable } from "../llm";
import { getAgentSettings } from "../agent-settings";
import { timezoneForCountry, workDaysForCountry } from "../instantly";
import { CITIES, COUNTRY_AR, GULF_COUNTRIES } from "../../country";
import { cleanEmail, isValidEmail } from "../../crawler/validate";
import { CampaignError, DEFAULT_SETTINGS, sanitizeSegmentInput, sanitizeSettings, type Row } from "../campaigns/types";
import { domainOf } from "../campaigns/suppression";
import { screenCandidate, searchFree, searchWithGemini, type CandidateCompany } from "../campaigns/discover";
import { updateSegment } from "../campaigns/service";
import { DEFAULT_EXCLUDED_TITLES, INDUSTRIES, SIZE_BANDS, TITLE_PRESETS, defaultExcludedIndustries } from "./taxonomy";
import { defaultMarket, effectiveTargeting, generateQueries, marketOf, planFor, planKey, sanitizeMarket, type Kind, type TargetMarket } from "./market";
import { SKIP_RULE_LABEL, checkCompany, type SkipRule } from "./check";

async function campaignRow(id: string): Promise<Row> {
  const c = (await q(`SELECT * FROM campaigns WHERE id = ?`, [id]))[0];
  if (!c) throw new CampaignError("Campaign not found", 404);
  return c;
}
const kindOf = (c: Row): Kind => (c.kind === "partner" ? "partner" : "customer");

/* ------------------------------- taxonomy ------------------------------- */

export function taxonomyView() {
  const countries = Object.keys(CITIES).map((name) => ({
    name,
    ar: COUNTRY_AR[name] || "",
    gulf: GULF_COUNTRIES.includes(name),
    cities: CITIES[name].map((c) => ({ name: c.name, ar: c.ar })),
  }));
  return {
    industries: INDUSTRIES.map((i) => ({ id: i.id, label: i.label, kind: i.kind, example: i.en[0] || null })),
    countries,
    gulf: GULF_COUNTRIES,
    sizeBands: [...SIZE_BANDS],
    titlePresets: TITLE_PRESETS,
    excludedTitles: DEFAULT_EXCLUDED_TITLES,
    excludedIndustries: { customer: defaultExcludedIndustries("customer"), partner: defaultExcludedIndustries("partner") },
    skipRules: SKIP_RULE_LABEL,
    defaults: { customer: defaultMarket("customer"), partner: defaultMarket("partner") },
  };
}

/* -------------------------------- market -------------------------------- */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Instantly runs one schedule per campaign; say so when the market mixes time zones or weekends. */
export function scheduleNote(countries: string[]): string | null {
  const groups = new Map<string, string[]>();
  for (const c of countries) {
    const days = workDaysForCountry(c);
    const on = Object.keys(days).filter((d) => days[d]).map(Number);
    const key = `${timezoneForCountry(c)}|${on.join(",")}`;
    groups.set(key, [...(groups.get(key) || []), c]);
  }
  if (groups.size < 2) return null;
  const parts = [...groups.entries()].map(([key, list]) => {
    const on = key.split("|")[1].split(",").map(Number);
    return `${list.join(", ")} (${DAY_NAMES[on[0]]} to ${DAY_NAMES[on[on.length - 1]]}, ${key.split("|")[0]})`;
  });
  return `Instantly sends each campaign on one schedule, and this market mixes time zones or work weeks: ${parts.join("; ")}. Emails follow the schedule of the country with the most leads. Split the campaign by country if that matters.`;
}

export async function getMarket(id: string) {
  const c = await campaignRow(id);
  const market = marketOf(c);
  const agent = await getAgentSettings();
  const skippedRows = await q(`SELECT skip_rule, CAST(count(*) AS INTEGER) AS n FROM prospects WHERE campaign_id = ? AND stage = 'skipped' AND skip_rule IS NOT NULL GROUP BY skip_rule`, [id]);
  const skipped: Partial<Record<SkipRule, number>> = {};
  for (const r of skippedRows) skipped[r.skip_rule as SkipRule] = Number(r.n) || 0;
  return {
    campaignId: String(c.id),
    kind: kindOf(c),
    market,
    defaults: defaultMarket(kindOf(c)),
    scheduleNote: scheduleNote(market.countries),
    agent: { allowRoleAddresses: agent.sending.allowRoleAddresses, minFitScore: agent.sending.minFitScore },
    skipped,
  };
}

/** Regenerate the searches of every automatic segment (after the market changed). */
async function regenerateAuto(c: Row, market: TargetMarket): Promise<number> {
  let n = 0;
  for (const s of await q(`SELECT * FROM segments WHERE campaign_id = ? AND queries_auto = 1`, [c.id])) {
    const queries = JSON.stringify(generateQueries(effectiveTargeting(market, kindOf(c), s)));
    if (queries !== s.queries_json) {
      await q(`UPDATE segments SET queries_json = ?, exhausted = 0, updated_at = ? WHERE id = ?`, [queries, nowIso(), s.id]);
      n++;
    }
  }
  return n;
}

export async function saveMarket(id: string, body: any) {
  const c = await campaignRow(id);
  const prev = marketOf(c);
  const next = sanitizeMarket(body?.market ?? body, prev);
  await q(`UPDATE campaigns SET targeting_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(next), nowIso(), id]);
  const regenerated = await regenerateAuto({ ...c, targeting_json: JSON.stringify(next) }, next);
  await logEvent("campaign", `Updated the target market: ${next.countries.join(", ")}.${regenerated ? ` Searches regenerated for ${regenerated} segment${regenerated === 1 ? "" : "s"}.` : ""}`, { campaignId: id });
  return { ...(await getMarket(id)), regenerated };
}

/* -------------------------------- recheck ------------------------------- */

const OPEN_STAGES = ["researched", "contact_found", "verified", "written", "approved"];

/**
 * Check the leads already found against a market (the saved one, or a draft
 * passed in). Dry run unless `apply`: leads now outside the target are skipped
 * with the rule; leads a targeting rule skipped earlier that now pass come back.
 */
export async function recheck(id: string, body: any) {
  const c = await campaignRow(id);
  const market = body?.market ? sanitizeMarket(body.market, marketOf(c)) : marketOf(c);
  const apply = body?.apply === true;
  const kind = kindOf(c);
  const segs = new Map((await q(`SELECT * FROM segments WHERE campaign_id = ?`, [id])).map((s) => [String(s.id), s]));
  const rows = await q(
    `SELECT p.*, co.id AS co_id, co.name AS co_name, co.domain AS co_domain FROM prospects p JOIN companies co ON co.id = p.company_id
      WHERE p.campaign_id = ? AND co.researched_at IS NOT NULL
        AND (p.stage IN (${OPEN_STAGES.map(() => "?").join(",")}) OR (p.stage = 'skipped' AND p.skip_rule IS NOT NULL))`,
    [id, ...OPEN_STAGES]
  );
  const companies = new Map<string, Row>();
  const byRule: Partial<Record<SkipRule, number>> = {};
  const samples: { prospectId: string; company: string; domain: string; action: "skip" | "restore"; reason: string }[] = [];
  let wouldSkip = 0;
  let wouldRestore = 0;
  const now = nowIso();
  for (const p of rows) {
    let co = companies.get(p.co_id);
    if (!co) {
      co = (await q(`SELECT * FROM companies WHERE id = ?`, [p.co_id]))[0];
      if (!co) continue;
      companies.set(p.co_id, co);
    }
    const eff = effectiveTargeting(market, kind, p.segment_id ? segs.get(String(p.segment_id)) || null : null);
    const t = checkCompany(co, eff);
    const label = String(p.co_name || p.co_domain);
    if (p.stage === "skipped") {
      if (!t.ok) continue;
      wouldRestore++;
      if (samples.length < 12) samples.push({ prospectId: p.id, company: label, domain: p.co_domain, action: "restore", reason: "Back inside the target" });
      if (apply) {
        const back = OPEN_STAGES.includes(p.skipped_from) ? p.skipped_from : "researched";
        await q(`UPDATE prospects SET stage = ?, stage_reason = ?, skip_rule = NULL, skipped_from = NULL, target_penalty = ?, target_notes = ?, stage_changed_at = ?, updated_at = ? WHERE id = ?`, [
          back,
          "Back inside the target after the targeting changed",
          t.penalty,
          t.notes.join("; ") || null,
          now,
          now,
          p.id,
        ]);
      }
      continue;
    }
    if (t.ok) {
      if (apply && p.fit_score == null && (Number(p.target_penalty) !== t.penalty || (p.target_notes || null) !== (t.notes.join("; ") || null))) {
        await q(`UPDATE prospects SET target_penalty = ?, target_notes = ? WHERE id = ?`, [t.penalty, t.notes.join("; ") || null, p.id]);
      }
      continue;
    }
    wouldSkip++;
    byRule[t.rule!] = (byRule[t.rule!] || 0) + 1;
    if (samples.length < 12) samples.push({ prospectId: p.id, company: label, domain: p.co_domain, action: "skip", reason: t.reason || "" });
    if (apply) {
      await q(`UPDATE prospects SET stage = 'skipped', skipped_from = ?, skip_rule = ?, stage_reason = ?, next_action_at = NULL, stage_changed_at = ?, updated_at = ? WHERE id = ?`, [
        p.stage,
        t.rule,
        t.reason,
        now,
        now,
        p.id,
      ]);
    }
  }
  if (apply && (wouldSkip || wouldRestore)) {
    await logEvent("campaign", `Re-checked the leads against the target: ${wouldSkip} skipped, ${wouldRestore} brought back.`, { campaignId: id });
  }
  return { checked: rows.length, wouldSkip, wouldRestore, byRule, samples, applied: apply };
}

/* ------------------------------- searches ------------------------------- */

/** The searches a (draft) segment would run, without saving anything. */
export async function previewQueries(id: string, body: any) {
  const c = await campaignRow(id);
  const market = body?.market ? sanitizeMarket(body.market, marketOf(c)) : marketOf(c);
  const s = sanitizeSegmentInput(body?.segment || {});
  const pseudo: Row = {
    industry_ids_json: JSON.stringify(s.industryIds || []),
    industries_json: JSON.stringify(s.industries || []),
    countries_json: JSON.stringify(s.countries || []),
    cities_json: JSON.stringify(s.cities || {}),
    size_json: s.sizeBands || s.minBranches ? JSON.stringify({ bands: s.sizeBands || market.sizeBands, minBranches: s.minBranches ?? null }) : null,
    titles_override: s.titlesOverride ? 1 : 0,
    titles_json: JSON.stringify(s.titles || []),
    signals_json: JSON.stringify(s.signals || { must: [], mustNot: [] }),
  };
  const eff = effectiveTargeting(market, kindOf(c), pseudo);
  const queries = generateQueries(eff);
  return { queries, searches: planFor(queries, eff.countries).length, countries: eff.countries, cities: eff.cities };
}

export async function regenerateQueries(id: string, sid: string) {
  return updateSegment(id, sid, { queriesAuto: true });
}

/* -------------------------------- preview ------------------------------- */

export interface PreviewCompany {
  name: string | null;
  domain: string | null;
  website: string;
  city: string | null;
  country: string | null;
  ok: boolean;
  already: boolean;
  reason: string | null;
  rule: SkipRule | null;
}

/**
 * Run 1-2 of a segment's searches and screen what comes back — junk filters,
 * do-not-contact, and the place rules the result already reveals. Nothing is
 * saved and the segment's searches aren't used up. Size and industry are only
 * known after research, so the screen says so.
 */
export async function previewSegment(id: string, sid: string) {
  const c = await campaignRow(id);
  const seg = (await q(`SELECT * FROM segments WHERE id = ? AND campaign_id = ?`, [sid, id]))[0];
  if (!seg) throw new CampaignError("Segment not found", 404);
  const market = marketOf(c);
  const settings = sanitizeSettings(parseJson(c.settings_json, {}), DEFAULT_SETTINGS);
  const eff = effectiveTargeting(market, kindOf(c), seg);
  const plan = planFor(parseJson<string[]>(seg.queries_json, []), eff.countries);
  if (!plan.length) throw new CampaignError("This segment has no searches yet. Pick an industry, or add searches by hand.");
  const searched = new Set(parseJson<string[]>(seg.searched_json, []));
  const steps = [...plan.filter((p) => !searched.has(planKey(p))), ...plan.filter((p) => searched.has(planKey(p)))].slice(0, 2);
  const ai = await aiStatus();
  let useGemini = ai.canSearch && (await budgetRemaining()) > 0;
  const notes: string[] = [];
  const searches: { query: string; country: string; results: number; via: "gemini" | "search"; error?: string }[] = [];
  const seen = new Set<string>();
  const companies: PreviewCompany[] = [];
  const inCampaign = new Set(
    (await q(`SELECT co.domain FROM prospects p JOIN companies co ON co.id = p.company_id WHERE p.campaign_id = ?`, [id])).map((r) => String(r.domain))
  );
  for (const step of steps) {
    let found: CandidateCompany[] = [];
    let via: "gemini" | "search" = useGemini ? "gemini" : "search";
    try {
      found = useGemini ? await searchWithGemini(step.query, step.country) : await searchFree(step.query, step.country);
    } catch (e: any) {
      if (useGemini && (e instanceof LlmBudgetExceeded || e instanceof LlmUnavailable)) {
        useGemini = false;
        via = "search";
        notes.push("Gemini didn't answer, so the free search was used.");
        try {
          found = await searchFree(step.query, step.country);
        } catch (e2: any) {
          searches.push({ query: step.query, country: step.country, results: 0, via, error: String(e2?.message || e2).slice(0, 160) });
          continue;
        }
      } else {
        searches.push({ query: step.query, country: step.country, results: 0, via, error: String(e?.message || e).slice(0, 160) });
        continue;
      }
    }
    searches.push({ query: step.query, country: step.country, results: found.length, via });
    for (const cand of found) {
      if (companies.length >= 12) break;
      const s = await screenCandidate(cand, settings, eff);
      const key = s.domain || cand.website;
      if (seen.has(key)) continue;
      seen.add(key);
      const already = !!s.domain && inCampaign.has(s.domain);
      companies.push({
        name: cand.name || null,
        domain: s.domain,
        website: s.domain ? `https://${s.domain}` : cand.website,
        city: cand.city || null,
        country: cand.country || null,
        ok: s.ok && !already,
        already,
        reason: already ? "Already in this campaign" : s.reason || null,
        rule: s.rule || null,
      });
    }
  }
  if (!useGemini && !ai.canSearch) notes.push("Without a Gemini key this uses the free search, which is slow and often comes back thin.");
  if (searches.length && searches.every((s) => s.results === 0)) notes.push("The searches came back empty. Try again later, or connect a Gemini key for better results.");
  const passed = companies.filter((x) => x.ok).length;
  return {
    searches,
    companies,
    passed,
    total: companies.length,
    planSize: plan.length,
    notes,
    checkedLater: "Size, industry and website keywords are checked after each company is researched.",
  };
}

/* ----------------------------- do-not-contact ---------------------------- */

export async function listExclusions(params: { q?: string; limit?: number; offset?: number }) {
  const limit = Math.max(1, Math.min(500, Number(params.limit) || 100));
  const offset = Math.max(0, Number(params.offset) || 0);
  const search = String(params.q || "").trim().toLowerCase().replace(/[%_]/g, "");
  const where = search ? `WHERE value LIKE ? OR lower(COALESCE(reason, '')) LIKE ?` : "";
  const args = search ? [`%${search}%`, `%${search}%`] : [];
  const items = (await q(`SELECT * FROM exclusions ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, args)).map((r) => ({
    id: String(r.id),
    kind: r.kind === "email" ? "email" : "domain",
    value: String(r.value),
    reason: r.reason ? String(r.reason) : null,
    source: String(r.source || "manual"),
    createdAt: String(r.created_at),
  }));
  const total = Number((await q(`SELECT CAST(count(*) AS INTEGER) AS n FROM exclusions ${where}`, args))[0]?.n) || 0;

  // Automatic entries, read-only: everyone the engine already refuses to email.
  const count = async (sql: string, a: any[] = []) => {
    try {
      return Number((await q(sql, a))[0]?.n) || 0;
    } catch {
      return 0;
    }
  };
  const auto = {
    unsubscribed: await count(`SELECT CAST(count(DISTINCT lower(email)) AS INTEGER) AS n FROM prospects WHERE stage = 'unsubscribed' AND email IS NOT NULL`),
    bounced: await count(`SELECT CAST(count(DISTINCT lower(email)) AS INTEGER) AS n FROM prospects WHERE stage = 'bounced' AND email IS NOT NULL`),
    complaints: await count(`SELECT CAST(count(DISTINCT lower(email)) AS INTEGER) AS n FROM prospects WHERE interest IN ('complaint','legal','unsubscribe') AND email IS NOT NULL`),
    inbox: await count(`SELECT CAST(count(DISTINCT lower(lead_email)) AS INTEGER) AS n FROM threads WHERE classification IN ('unsubscribe','complaint','legal')`),
    oldConsole: await count(`SELECT CAST(count(*) AS INTEGER) AS n FROM contacts WHERE status IN ('unsubscribed','bounced')`),
  };
  let autoRecent: { value: string; reason: string; at: string }[] = [];
  try {
    autoRecent = (
      await q(
        `SELECT lower(email) AS value, stage, interest, updated_at FROM prospects
          WHERE email IS NOT NULL AND (stage IN ('unsubscribed','bounced') OR interest IN ('complaint','legal','unsubscribe'))
          ORDER BY updated_at DESC LIMIT 25`
      )
    ).map((r) => ({ value: String(r.value), reason: r.stage === "bounced" ? "Bounced" : r.stage === "unsubscribed" ? "Unsubscribed" : `Replied "${r.interest}"`, at: String(r.updated_at) }));
  } catch {
    autoRecent = [];
  }
  return { items, total, auto, autoRecent };
}

/** Paste one entry per line (or comma-separated): emails and domains / websites. */
export async function addExclusions(body: any) {
  const raw: string[] = Array.isArray(body?.entries) ? body.entries.map(String) : String(body?.entries || "").split(/[\n,;\s]+/);
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 200) || null : null;
  const source = body?.source === "import" ? "import" : "manual";
  const tokens = raw.map((t) => t.trim()).filter(Boolean).slice(0, 5000);
  if (!tokens.length) throw new CampaignError("Paste at least one email address or domain.");
  let added = 0;
  const skipped: { value: string; reason: string }[] = [];
  const now = nowIso();
  for (const t of tokens) {
    let kind: "email" | "domain";
    let value: string | null;
    if (t.includes("@") && !/^https?:/i.test(t)) {
      const e = cleanEmail(t.replace(/^mailto:/i, ""));
      value = e && isValidEmail(e) ? e.toLowerCase() : null;
      kind = "email";
    } else {
      value = domainOf(t);
      kind = "domain";
    }
    if (!value) {
      skipped.push({ value: t.slice(0, 120), reason: "Not an email address or a domain" });
      continue;
    }
    const exists = (await q(`SELECT id FROM exclusions WHERE kind = ? AND value = ?`, [kind, value]))[0];
    if (exists) {
      skipped.push({ value, reason: "Already on the list" });
      continue;
    }
    await q(`INSERT INTO exclusions (id, kind, value, reason, source, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT (kind, value) DO NOTHING`, [uid(), kind, value, reason, source, now]);
    added++;
  }
  if (added) await logEvent("campaign", `Added ${added} entr${added === 1 ? "y" : "ies"} to the do-not-contact list${reason ? ` (${reason})` : ""}.`);
  return { added, skipped };
}

export async function removeExclusion(eid: string) {
  const r = (await q(`SELECT id FROM exclusions WHERE id = ?`, [eid]))[0];
  if (!r) throw new CampaignError("Not on the list", 404);
  await q(`DELETE FROM exclusions WHERE id = ?`, [eid]);
  return { ok: true as const };
}

export async function exclusionsCsv(): Promise<string> {
  const rows = await q(`SELECT kind, value, reason, source, created_at FROM exclusions ORDER BY kind, value`);
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return ["kind,value,reason,source,added", ...rows.map((r) => [r.kind, r.value, r.reason, r.source, r.created_at].map(esc).join(","))].join("\n");
}
